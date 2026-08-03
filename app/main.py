"""FastAPI app: JSON API plus the static single-page frontend.

Routes stay thin -- storage lives in `app.db`, rules live in `app.validation`.
The only rule enforced at write time is V3 (dependency cycles), which returns
409 instead of a warning. Everything else is reported, never corrected.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import db
from app.validation import find_dependency_cycle, phase_end_date, validate_plan

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


class ProjectIn(BaseModel):
    name: str
    start_date: str
    description: str = ""
    velocity_override: int | None = None


class ProjectPatch(BaseModel):
    name: str | None = None
    start_date: str | None = None
    description: str | None = None
    velocity_override: int | None = None


class PhaseIn(BaseModel):
    name: str
    start_date: str
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


class DependencyIn(BaseModel):
    predecessor_phase_id: int
    successor_phase_id: int


# --- helpers ----------------------------------------------------------------


def with_end_date(phase):
    """Attach the derived end date the timeline needs. Never persisted."""
    return {**phase, "end_date": phase_end_date(phase).isoformat()}


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
        start_date=body.start_date,
        description=body.description,
        velocity_override=body.velocity_override,
    )


@app.get("/api/projects/{project_id}")
def read_project_plan(project_id: int):
    """Project, phases with derived end dates, dependencies, and all warnings."""
    project = require_project(project_id)
    phases = db.list_phases(project_id)
    dependencies = db.list_dependencies(project_id)
    settings = db.get_settings()
    warnings = validate_plan(project, phases, dependencies, settings)
    return {
        "project": project,
        "phases": [with_end_date(phase) for phase in phases],
        "dependencies": dependencies,
        "warnings": [warning.as_dict() for warning in warnings],
        "settings": settings,
    }


@app.put("/api/projects/{project_id}")
def edit_project(project_id: int, body: ProjectPatch):
    require_project(project_id)
    return db.update_project(project_id, body.model_dump(exclude_unset=True))


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
        start_date=body.start_date,
        duration_weeks=body.duration_weeks,
        effort_points=body.effort_points,
        description=body.description,
        status=body.status,
    )
    return with_end_date(phase)


@app.put("/api/phases/{phase_id}")
def edit_phase(phase_id: int, body: PhasePatch):
    require_phase(phase_id)
    return with_end_date(db.update_phase(phase_id, body.model_dump(exclude_unset=True)))


@app.delete("/api/phases/{phase_id}", status_code=204)
def remove_phase(phase_id: int):
    require_phase(phase_id)
    db.delete_phase(phase_id)


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
