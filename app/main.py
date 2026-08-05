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
    STAGE_DONE,
    STAGE_IDEA,
    UNSCHEDULED,
    as_optional_date,
    find_dependency_cycle,
    is_scheduled,
    next_milestone,
    phase_end_date,
    project_effort_points,
    project_progress,
    project_stage,
    relative_layout,
    sequential_layout,
    validate_plan,
    validate_portfolio,
)

# Projects that occupy real time. An idea has not been committed to, so it is
# kept off the portfolio timeline.
#
# This is every **stored** stage except 'idea', which is the point: committed is
# committed, whether the ladder then derives it as planned, dated, active,
# overdue or done. Work with no dates draws no bar and reaches the staging tray
# instead; work with dates draws one. Neither needs a stage of its own here.
SCHEDULABLE_STAGES = ("planned", "active", "done")

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
    # 0 is untiered: a new project is unranked until someone ranks it.
    tier: int = 0
    # A new plan is being drafted by definition -- nobody has written it yet.
    draft_complete: int = 0


class ProjectPatch(BaseModel):
    name: str | None = None
    start_date: str | None = None
    description: str | None = None
    goal: str | None = None
    velocity_override: int | None = None
    stage: str | None = None
    track: str | None = None
    tier: int | None = None
    draft_complete: int | None = None


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
    # Project to project: which piece of work has to land before another starts.
    predecessor_project_id: int
    successor_project_id: int


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


def clean_tier(value):
    """Same boundary check as `clean_stage`, for priority.

    Tier ranks a project against the others so the map can be thinned down to
    what matters. It is a label and nothing else: no rule reads it, no date
    moves because of it, and 0 means nobody has ranked this yet.
    """
    if value not in db.TIERS:
        raise HTTPException(
            status_code=422,
            detail=f"'{value}' is not a valid tier. Use 1-3, or 0 for untiered.",
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


def portfolio_warnings():
    """Every V2 warning in the dataset.

    V2 compares two projects, so it cannot be answered from one project's rows --
    it always reads the whole set. Cheap enough at this scale to recompute per
    request rather than cache.
    """
    return validate_portfolio(
        db.list_projects(), db.phases_by_project(), db.list_all_dependencies()
    )


def warnings_touching(project_id, cross_project):
    """The subset of `cross_project` warnings with this project at either end."""
    return [warning for warning in cross_project
            if project_id in (warning.project_id, warning.related_project_id)]


def unplaced_work(projects, phases):
    """Per project, the phases still waiting for a date -- the staging tray.

    The portfolio chart can only draw dated work, so estimated-but-undated
    phases used to be a count and nothing more. They travel in full here instead
    so the view can offer them as something to place onto the grid.

    Only projects that actually have undated phases appear: the tray is for
    placing work, and a project with nothing in it has no work to place. Ideas
    are already absent because `projects` is the schedulable set -- committing
    to a direction is a decision for the project view, not a side effect of a
    drag.
    """
    pending = {}
    for phase in phases:
        if not is_scheduled(phase):
            pending.setdefault(phase["project_id"], []).append(phase)

    tray = []
    for project in projects:
        waiting = pending.get(project["id"])
        if not waiting:
            continue
        tray.append({
            "project_id": project["id"],
            "project_name": project["name"],
            # The project's own date, which placing overwrites. A project can be
            # half placed: dated phases keep their dates and push the rest later.
            "start_date": project["start_date"],
            "phases": [{
                "id": phase["id"],
                "name": phase["name"],
                "duration_weeks": phase["duration_weeks"],
                "effort_points": phase["effort_points"],
                "status": phase["status"],
            } for phase in waiting],
            "total_weeks": sum(float(phase["duration_weeks"] or 0) for phase in waiting),
            "total_points": sum(int(phase["effort_points"] or 0) for phase in waiting),
            "scheduled_count": sum(
                1 for phase in phases
                if phase["project_id"] == project["id"] and is_scheduled(phase)),
        })
    return tray


# --- settings ---------------------------------------------------------------


@app.get("/api/settings")
def read_settings():
    return db.get_settings()


@app.put("/api/settings")
def write_settings(body: SettingsIn):
    return db.update_settings(body.model_dump(exclude_unset=True, exclude_none=True))


# --- projects ---------------------------------------------------------------


def with_derived_stage(projects, phases, deliverables, today):
    """Tag each project with `derived_stage`, leaving the stored one alone.

    Both travel: `stage` stays the commitment the user recorded, which is what
    the portfolio filters on and what any write echoes back, while
    `derived_stage` is where the project actually stands. Overwriting `stage`
    here would have been tidier and quietly wrong -- a round trip through the
    project form would then write a derived value back into the column.
    """
    for project in projects:
        project["derived_stage"] = project_stage(
            project,
            phases.get(project["id"], []),
            deliverables.get(project["id"], []),
            today,
        )
    return projects


@app.get("/api/projects")
def read_projects():
    """Every project, each carrying its `derived_stage`.

    It rides on the list rather than the single-project payload because the
    point of it is comparing projects before opening one.

    Finished work is re-sorted to the bottom here rather than in `db`, because
    only the ladder knows a project is finished: `db.list_projects` can sort on
    the stored stage, which now says 'done' only for a manual close. A project
    whose every phase is done is done too, and it should not sit in the middle
    of the picker among work in flight.
    """
    phases = db.phases_by_project()
    deliverables = db.deliverables_by_project()
    today = date.today()
    projects = with_derived_stage(
        db.list_projects(), phases, deliverables, today)
    # Stable, so the db ordering survives inside each of the three groups.
    rank = {STAGE_DONE: 2, STAGE_IDEA: 1}
    projects.sort(key=lambda project: rank.get(project["derived_stage"], 0))
    return projects


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
        tier=clean_tier(body.tier),
        draft_complete=1 if body.draft_complete else 0,
    )


@app.get("/api/projects/{project_id}")
def read_project_plan(project_id: int):
    """Project, phases with derived dates and deliverables, dependencies, warnings.

    `dependencies` are the project-to-project links this project sits at either
    end of, so the view can show both what blocks it and what it blocks. The
    warning list merges its own V1/V4 findings with the V2 findings that name it.

    Each phase also carries `offset_weeks`, its place in the plan measured in
    weeks from the start rather than on a calendar. That is what lets the
    timeline draw a project nobody has dated yet; it is derived here and never
    stored, the same as `end_date`.
    """
    project = require_project(project_id)
    phases = db.list_phases(project_id)
    dependencies = db.list_dependencies(project_id)
    grouped = db.deliverables_by_phase(project_id)
    settings = db.get_settings()
    today = date.today()
    warnings = validate_plan(project, phases, settings, grouped, today)
    warnings += warnings_touching(project_id, portfolio_warnings())
    offsets = relative_layout(phases)
    # The ladder does ride on this payload, unlike the readiness it replaced:
    # the drafting toggle lives in this view, and a switch you cannot see the
    # effect of is a switch you have to guess at.
    project["derived_stage"] = project_stage(
        project, phases,
        [item for items in grouped.values() for item in items],
        today,
    )

    enriched = []
    for phase in phases:
        enriched.append({
            **with_end_date(phase),
            "offset_weeks": offsets[phase["id"]],
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

    Unscheduled phases are omitted from `phases`: there is nowhere honest to
    draw them on a calendar. They come back grouped by project in `unscheduled`,
    which is what the view stages them from, with `unscheduled_count` still
    giving the flat total.

    Future directions are omitted too -- an idea nobody has committed to does
    not belong on a delivery timeline. It shows on the map view instead.

    Dependencies and their V2 warnings come along in full, ideas included: a
    project waiting on something uncommitted is worth seeing here even though the
    idea itself has no bar to draw.
    """
    projects = db.list_projects(stages=SCHEDULABLE_STAGES)
    committed = {project["id"] for project in projects}
    phases = [phase for phase in db.list_all_phases()
              if phase["project_id"] in committed]
    scheduled = [with_end_date(phase) for phase in phases if is_scheduled(phase)]
    return {
        "projects": projects,
        "phases": scheduled,
        "unscheduled": unplaced_work(projects, phases),
        "unscheduled_count": len(phases) - len(scheduled),
        "dependencies": db.list_all_dependencies(with_names=True),
        "warnings": [warning.as_dict() for warning in portfolio_warnings()],
    }


@app.get("/api/graph")
def read_graph():
    """The map view: the department at the centre, every project around it.

    One payload so the page renders from a single fetch. Numbers here answer
    "how is this going?" -- progress, size and what lands next -- rather than
    "is this wrong?", which is what the warning list is for.

    Dependencies ride along for the hover highlight. They are not drawn on every
    render -- a dozen projects on a radial layout turns into spaghetti -- so the
    map holds them until you point at one end.
    """
    settings = db.get_settings()
    grouped = db.phases_by_project()
    deliverables = db.deliverables_by_project()
    today = date.today()

    nodes = []
    for project in with_derived_stage(
            db.list_projects(), grouped, deliverables, today):
        phases = grouped.get(project["id"], [])
        progress = project_progress(phases)
        nodes.append({
            "id": project["id"],
            "name": project["name"],
            "stage": project["stage"],
            # What the node is actually drawn from. The map used to style off
            # the stored stage, which meant a project looked committed-not-
            # started until someone remembered to change it by hand.
            "derived_stage": project["derived_stage"],
            "track": project["track"],
            # The map filters and ranks on this; 0 means untiered.
            "tier": project["tier"],
            "goal": project["goal"],
            "phases_done": progress["done"],
            "phases_total": progress["total"],
            "effort_points": project_effort_points(phases),
            "next_date": next_milestone(phases, today),
        })

    return {
        "department_name": settings["department_name"],
        "projects": nodes,
        "dependencies": db.list_all_dependencies(with_names=True),
    }


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
    # Promoting a future direction is this same edit with stage='planned': the
    # row keeps its id, goal and anything else already written against it.
    if "stage" in fields:
        fields["stage"] = clean_stage(fields["stage"])
    if "tier" in fields:
        fields["tier"] = clean_tier(fields["tier"])
    if "draft_complete" in fields:
        fields["draft_complete"] = 1 if fields["draft_complete"] else 0
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
    """Link two projects finish-to-start.

    V3 is enforced here: a cycle is rejected rather than warned about. A project
    depending on itself is a cycle of length one, so it is rejected by the same
    check rather than needing its own guard.
    """
    require_project(body.predecessor_project_id)
    require_project(body.successor_project_id)

    proposed = db.list_all_dependencies() + [
        {
            "predecessor_project_id": body.predecessor_project_id,
            "successor_project_id": body.successor_project_id,
        }
    ]
    cycle = find_dependency_cycle(proposed)
    if cycle:
        names = {project["id"]: project["name"] for project in db.list_projects()}
        readable = " -> ".join(names.get(project_id, f"#{project_id}")
                               for project_id in cycle)
        raise HTTPException(
            status_code=409,
            detail=f"That dependency would create a cycle: {readable}",
        )

    return db.create_dependency(body.predecessor_project_id,
                                body.successor_project_id)


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
