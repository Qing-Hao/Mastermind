"""FastAPI app: JSON API plus the static single-page frontend.

Routes stay thin -- storage lives in `app.db`, rules live in `app.validation`.
The only rule enforced at write time is V3 (dependency cycles), which returns
409 instead of a warning. Everything else is reported, never corrected.
"""

import os
from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import db
from app.validation import (
    UNSCHEDULED,
    as_optional_date,
    find_dependency_cycle,
    is_scheduled,
    next_milestone,
    phase_end_date,
    project_effort_points,
    project_progress,
    sequential_layout,
    validate_plan,
)

# Projects that occupy real time. An idea has not been committed to, so it is
# kept off the portfolio timeline.
SCHEDULABLE_STAGES = ("active", "done")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def lifespan(_app):
    db.init_db()
    yield


app = FastAPI(title="Roadmap Planner", lifespan=lifespan)


# --- request bodies ---------------------------------------------------------


class SettingsIn(BaseModel):
    default_velocity_points_per_sprint: int | None = None
    sprint_length_days: int | None = None
    v1_tolerance_pct: float | None = None
    department_name: str | None = None


class ProjectIn(BaseModel):
    # Empty means unscheduled: estimate first, commit dates once the shape settles.
    name: str
    start_date: str = ""
    description: str = ""
    goal: str = ""
    velocity_override: int | None = None
    # 'idea' captures a future direction before anyone commits to it.
    stage: str = "active"
    track: str = ""


class ProjectPatch(BaseModel):
    name: str | None = None
    start_date: str | None = None
    description: str | None = None
    goal: str | None = None
    velocity_override: int | None = None
    stage: str | None = None
    track: str | None = None


class PhaseIn(BaseModel):
    name: str
    start_date: str = ""
    duration_weeks: float = 1
    effort_points: int = 0
    description: str = ""
    status: str = "planned"


class PhasePatch(BaseModel):
    name: str | None = None
    start_date: str | None = None
    duration_weeks: float | None = None
    effort_points: int | None = None
    description: str | None = None
    status: str | None = None
    sort_order: int | None = None


class DeliverableIn(BaseModel):
    # No estimate: a deliverable names what a phase produces, and the phase
    # holds the weeks and points for all of it. `done` is a tick, not a status:
    # finished, or still ongoing.
    name: str
    description: str = ""
    done: bool = False


class DeliverablePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    done: bool | None = None
    sort_order: int | None = None


class DependencyIn(BaseModel):
    predecessor_phase_id: int
    successor_phase_id: int


# --- helpers ----------------------------------------------------------------


def with_end_date(phase):
    """Attach the derived end date the timeline needs. Never persisted.

    Both dates come back as "" while the phase is unscheduled, which is what an
    empty <input type="date"> produces and accepts.
    """
    end = phase_end_date(phase)
    return {
        **phase,
        "start_date": phase.get("start_date") or UNSCHEDULED,
        "end_date": end.isoformat() if end else UNSCHEDULED,
        "scheduled": end is not None,
    }


def clean_date(value):
    """Normalise a submitted date to an ISO string or the unscheduled marker.

    Reads are lenient so one bad value cannot break a whole project view; writes
    are strict here so bad values never get stored in the first place.
    """
    if value is None or str(value).strip() == "":
        return UNSCHEDULED
    parsed = as_optional_date(value)
    if parsed is None:
        raise HTTPException(
            status_code=422,
            detail=f"'{value}' is not a valid date. Use YYYY-MM-DD, or leave it "
                   f"empty to keep the item unscheduled.",
        )
    return parsed.isoformat()


def clean_stage(value):
    """Reject an unknown stage at the boundary rather than at the CHECK.

    The column has the same constraint, but SQLite would surface it as a 500
    with an opaque message; this names the valid values instead.
    """
    if value not in db.STAGES:
        raise HTTPException(
            status_code=422,
            detail=f"'{value}' is not a valid stage. Use one of: "
                   f"{', '.join(db.STAGES)}.",
        )
    return value


def require_project(project_id):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def require_phase(phase_id):
    phase = db.get_phase(phase_id)
    if not phase:
        raise HTTPException(status_code=404, detail="Phase not found")
    return phase


# --- settings ---------------------------------------------------------------


@app.get("/api/settings")
def read_settings():
    return db.get_settings()


@app.put("/api/settings")
def write_settings(body: SettingsIn):
    return db.update_settings(body.model_dump(exclude_unset=True, exclude_none=True))


# --- projects ---------------------------------------------------------------


@app.get("/api/projects")
def read_projects():
    return db.list_projects()


@app.post("/api/projects", status_code=201)
def add_project(body: ProjectIn):
    return db.create_project(
        name=body.name,
        start_date=clean_date(body.start_date),
        description=body.description,
        goal=body.goal,
        velocity_override=body.velocity_override,
        stage=clean_stage(body.stage),
        track=body.track,
    )


@app.get("/api/projects/{project_id}")
def read_project_plan(project_id: int):
    """Project, phases with derived dates and deliverables, dependencies, warnings."""
    project = require_project(project_id)
    phases = db.list_phases(project_id)
    dependencies = db.list_dependencies(project_id)
    grouped = db.deliverables_by_phase(project_id)
    settings = db.get_settings()
    warnings = validate_plan(project, phases, dependencies, settings)

    enriched = []
    for phase in phases:
        enriched.append({
            **with_end_date(phase),
            "deliverables": grouped.get(phase["id"], []),
        })

    return {
        "project": project,
        "phases": enriched,
        "dependencies": dependencies,
        "warnings": [warning.as_dict() for warning in warnings],
        "settings": settings,
    }


@app.get("/api/portfolio")
def read_portfolio():
    """Every scheduled phase on one timeline, for the cross-project Gantt.

    Unscheduled phases are omitted: there is nowhere honest to draw them.
    `unscheduled_count` lets the view say how much is still unplaced.

    Future directions are omitted too -- an idea nobody has committed to does
    not belong on a delivery timeline. It shows on the map view instead.
    """
    projects = db.list_projects(stages=SCHEDULABLE_STAGES)
    committed = {project["id"] for project in projects}
    phases = [phase for phase in db.list_all_phases()
              if phase["project_id"] in committed]
    scheduled = [with_end_date(phase) for phase in phases if is_scheduled(phase)]
    return {
        "projects": projects,
        "phases": scheduled,
        "unscheduled_count": len(phases) - len(scheduled),
    }


@app.get("/api/graph")
def read_graph():
    """The map view: the department at the centre, every project around it.

    One payload so the page renders from a single fetch. Numbers here answer
    "how is this going?" -- progress, size and what lands next -- rather than
    "is this wrong?", which is what the warning list is for.
    """
    settings = db.get_settings()
    grouped = db.phases_by_project()
    today = date.today()

    nodes = []
    for project in db.list_projects():
        phases = grouped.get(project["id"], [])
        progress = project_progress(phases)
        nodes.append({
            "id": project["id"],
            "name": project["name"],
            "stage": project["stage"],
            "track": project["track"],
            "goal": project["goal"],
            "phases_done": progress["done"],
            "phases_total": progress["total"],
            "effort_points": project_effort_points(phases),
            "next_date": next_milestone(phases, today),
        })

    return {"department_name": settings["department_name"], "projects": nodes}


@app.post("/api/projects/{project_id}/layout")
def layout_project(project_id: int):
    """Place every unscheduled phase back to back from the project start date.

    Explicitly user-triggered -- this is not auto-scheduling. Phases that already
    have dates keep them and only push the cursor forward so nothing overlaps.
    """
    project = require_project(project_id)
    if not is_scheduled(project):
        raise HTTPException(
            status_code=400,
            detail="Set the project start date before laying out phases.",
        )

    phases = db.list_phases(project_id)
    placements = sequential_layout(phases, project["start_date"])
    for phase_id, start_date in placements.items():
        db.update_phase(phase_id, {"start_date": start_date})

    return {"placed": len(placements), "placements": placements}


@app.put("/api/projects/{project_id}")
def edit_project(project_id: int, body: ProjectPatch):
    require_project(project_id)
    fields = body.model_dump(exclude_unset=True)
    if "start_date" in fields:
        fields["start_date"] = clean_date(fields["start_date"])
    # Promoting a future direction is this same edit with stage='active': the
    # row keeps its id, goal and anything else already written against it.
    if "stage" in fields:
        fields["stage"] = clean_stage(fields["stage"])
    return db.update_project(project_id, fields)


@app.delete("/api/projects/{project_id}", status_code=204)
def remove_project(project_id: int):
    require_project(project_id)
    db.delete_project(project_id)


# --- phases -----------------------------------------------------------------


@app.post("/api/projects/{project_id}/phases", status_code=201)
def add_phase(project_id: int, body: PhaseIn):
    require_project(project_id)
    phase = db.create_phase(
        project_id=project_id,
        name=body.name,
        start_date=clean_date(body.start_date),
        duration_weeks=body.duration_weeks,
        effort_points=body.effort_points,
        description=body.description,
        status=body.status,
    )
    return with_end_date(phase)


@app.put("/api/phases/{phase_id}")
def edit_phase(phase_id: int, body: PhasePatch):
    require_phase(phase_id)
    fields = body.model_dump(exclude_unset=True)
    if "start_date" in fields:
        fields["start_date"] = clean_date(fields["start_date"])
    return with_end_date(db.update_phase(phase_id, fields))


@app.delete("/api/phases/{phase_id}", status_code=204)
def remove_phase(phase_id: int):
    require_phase(phase_id)
    db.delete_phase(phase_id)


# --- deliverables -----------------------------------------------------------


def require_deliverable(deliverable_id):
    deliverable = db.get_deliverable(deliverable_id)
    if not deliverable:
        raise HTTPException(status_code=404, detail="Deliverable not found")
    return deliverable


@app.get("/api/phases/{phase_id}/deliverables")
def read_deliverables(phase_id: int):
    require_phase(phase_id)
    return db.list_deliverables(phase_id)


@app.post("/api/phases/{phase_id}/deliverables", status_code=201)
def add_deliverable(phase_id: int, body: DeliverableIn):
    require_phase(phase_id)
    return db.create_deliverable(
        phase_id=phase_id,
        name=body.name,
        description=body.description,
        done=body.done,
    )


@app.put("/api/deliverables/{deliverable_id}")
def edit_deliverable(deliverable_id: int, body: DeliverablePatch):
    require_deliverable(deliverable_id)
    return db.update_deliverable(deliverable_id, body.model_dump(exclude_unset=True))


@app.delete("/api/deliverables/{deliverable_id}", status_code=204)
def remove_deliverable(deliverable_id: int):
    require_deliverable(deliverable_id)
    db.delete_deliverable(deliverable_id)


# --- dependencies -----------------------------------------------------------


@app.post("/api/dependencies", status_code=201)
def add_dependency(body: DependencyIn):
    """V3 is enforced here: a cycle is rejected rather than warned about."""
    predecessor = require_phase(body.predecessor_phase_id)
    successor = require_phase(body.successor_phase_id)

    proposed = db.list_all_dependencies() + [
        {
            "predecessor_phase_id": body.predecessor_phase_id,
            "successor_phase_id": body.successor_phase_id,
        }
    ]
    cycle = find_dependency_cycle(proposed)
    if cycle:
        names = {phase["id"]: phase["name"] for phase in
                 db.list_phases(predecessor["project_id"]) + db.list_phases(successor["project_id"])}
        readable = " -> ".join(names.get(phase_id, f"#{phase_id}") for phase_id in cycle)
        raise HTTPException(
            status_code=409,
            detail=f"That dependency would create a cycle: {readable}",
        )

    return db.create_dependency(body.predecessor_phase_id, body.successor_phase_id)


@app.delete("/api/dependencies/{dependency_id}", status_code=204)
def remove_dependency(dependency_id: int):
    db.delete_dependency(dependency_id)


# --- export / import --------------------------------------------------------


@app.get("/api/export")
def export_dataset():
    return db.export_all()


@app.post("/api/import")
def import_dataset(payload: dict):
    db.import_all(payload)
    return {"ok": True, "projects": len(payload.get("projects", []))}


# --- frontend ---------------------------------------------------------------


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
