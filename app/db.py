"""SQLite storage. Single-user, single file, no migrations framework.

The whole dataset lives in one file (``data/roadmap.db`` by default) so it can be
copied for backup and opened with any SQLite browser. Rows come back as plain
dicts, which is exactly what `app.validation` expects.
"""

import os
import sqlite3
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "roadmap.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    id                                INTEGER PRIMARY KEY CHECK (id = 1),
    default_velocity_points_per_sprint INTEGER NOT NULL DEFAULT 20,
    sprint_length_days                INTEGER NOT NULL DEFAULT 14,
    v1_tolerance_pct                  REAL    NOT NULL DEFAULT 5.0
);

CREATE TABLE IF NOT EXISTS project (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    start_date        TEXT NOT NULL,
    velocity_override INTEGER,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phase (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    start_date     TEXT NOT NULL,
    duration_weeks REAL NOT NULL DEFAULT 1,
    effort_points  INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned', 'in_progress', 'done')),
    sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dependency (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    predecessor_phase_id INTEGER NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
    successor_phase_id   INTEGER NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
    UNIQUE (predecessor_phase_id, successor_phase_id)
);

CREATE INDEX IF NOT EXISTS idx_phase_project ON phase(project_id);
"""

_db_path = DEFAULT_DB_PATH


def set_db_path(path):
    """Point storage at a different file. Used by tests."""
    global _db_path
    _db_path = path


def connect():
    directory = os.path.dirname(_db_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(_db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db():
    with connect() as connection:
        connection.executescript(SCHEMA)
        connection.execute("INSERT OR IGNORE INTO settings (id) VALUES (1)")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


# --- settings ---------------------------------------------------------------


def get_settings():
    with connect() as connection:
        row = connection.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return dict(row)


def update_settings(fields):
    allowed = {
        "default_velocity_points_per_sprint",
        "sprint_length_days",
        "v1_tolerance_pct",
    }
    updates = {key: value for key, value in fields.items() if key in allowed}
    if updates:
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as connection:
            connection.execute(
                f"UPDATE settings SET {assignments} WHERE id = 1", list(updates.values())
            )
    return get_settings()


# --- projects ---------------------------------------------------------------


def list_projects():
    with connect() as connection:
        rows = connection.execute("SELECT * FROM project ORDER BY start_date, id").fetchall()
    return rows_to_dicts(rows)


def get_project(project_id):
    with connect() as connection:
        row = connection.execute("SELECT * FROM project WHERE id = ?", (project_id,)).fetchone()
    return dict(row) if row else None


def create_project(name, start_date, description="", velocity_override=None):
    timestamp = now_iso()
    with connect() as connection:
        cursor = connection.execute(
            """INSERT INTO project (name, description, start_date, velocity_override,
                                    created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (name, description, start_date, velocity_override, timestamp, timestamp),
        )
        project_id = cursor.lastrowid
    return get_project(project_id)


def update_project(project_id, fields):
    allowed = {"name", "description", "start_date", "velocity_override"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if updates:
        updates["updated_at"] = now_iso()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as connection:
            connection.execute(
                f"UPDATE project SET {assignments} WHERE id = ?",
                list(updates.values()) + [project_id],
            )
    return get_project(project_id)


def delete_project(project_id):
    with connect() as connection:
        connection.execute("DELETE FROM project WHERE id = ?", (project_id,))


# --- phases -----------------------------------------------------------------


def list_phases(project_id):
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM phase WHERE project_id = ? ORDER BY sort_order, start_date, id",
            (project_id,),
        ).fetchall()
    return rows_to_dicts(rows)


def get_phase(phase_id):
    with connect() as connection:
        row = connection.execute("SELECT * FROM phase WHERE id = ?", (phase_id,)).fetchone()
    return dict(row) if row else None


def create_phase(project_id, name, start_date, duration_weeks, effort_points,
                 description="", status="planned"):
    with connect() as connection:
        next_order = connection.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM phase WHERE project_id = ?",
            (project_id,),
        ).fetchone()[0]
        cursor = connection.execute(
            """INSERT INTO phase (project_id, name, description, start_date,
                                  duration_weeks, effort_points, status, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (project_id, name, description, start_date, duration_weeks,
             effort_points, status, next_order),
        )
        phase_id = cursor.lastrowid
    return get_phase(phase_id)


def update_phase(phase_id, fields):
    allowed = {"name", "description", "start_date", "duration_weeks",
               "effort_points", "status", "sort_order"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if updates:
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as connection:
            connection.execute(
                f"UPDATE phase SET {assignments} WHERE id = ?",
                list(updates.values()) + [phase_id],
            )
    return get_phase(phase_id)


def delete_phase(phase_id):
    with connect() as connection:
        connection.execute("DELETE FROM phase WHERE id = ?", (phase_id,))


# --- dependencies -----------------------------------------------------------


def list_dependencies(project_id):
    """Dependencies where both ends belong to the given project."""
    with connect() as connection:
        rows = connection.execute(
            """SELECT d.* FROM dependency d
               JOIN phase p ON p.id = d.predecessor_phase_id
               JOIN phase s ON s.id = d.successor_phase_id
               WHERE p.project_id = ? AND s.project_id = ?""",
            (project_id, project_id),
        ).fetchall()
    return rows_to_dicts(rows)


def list_all_dependencies():
    with connect() as connection:
        rows = connection.execute("SELECT * FROM dependency").fetchall()
    return rows_to_dicts(rows)


def create_dependency(predecessor_phase_id, successor_phase_id):
    with connect() as connection:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO dependency (predecessor_phase_id, successor_phase_id)
               VALUES (?, ?)""",
            (predecessor_phase_id, successor_phase_id),
        )
        dependency_id = cursor.lastrowid
    return {
        "id": dependency_id,
        "predecessor_phase_id": predecessor_phase_id,
        "successor_phase_id": successor_phase_id,
    }


def delete_dependency(dependency_id):
    with connect() as connection:
        connection.execute("DELETE FROM dependency WHERE id = ?", (dependency_id,))


# --- export / import --------------------------------------------------------


def export_all():
    """Whole dataset as plain JSON-ready dicts."""
    with connect() as connection:
        projects = rows_to_dicts(connection.execute("SELECT * FROM project").fetchall())
        phases = rows_to_dicts(connection.execute("SELECT * FROM phase").fetchall())
        dependencies = rows_to_dicts(connection.execute("SELECT * FROM dependency").fetchall())
    return {
        "version": 1,
        "exported_at": now_iso(),
        "settings": get_settings(),
        "projects": projects,
        "phases": phases,
        "dependencies": dependencies,
    }


def import_all(payload):
    """Replace the entire dataset with `payload`. Destructive by design.

    Ids are preserved so dependency links survive the round trip.
    """
    with connect() as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("DELETE FROM dependency")
        connection.execute("DELETE FROM phase")
        connection.execute("DELETE FROM project")

        settings = payload.get("settings") or {}
        if settings:
            connection.execute(
                """UPDATE settings SET default_velocity_points_per_sprint = ?,
                                       sprint_length_days = ?, v1_tolerance_pct = ?
                   WHERE id = 1""",
                (
                    settings.get("default_velocity_points_per_sprint", 20),
                    settings.get("sprint_length_days", 14),
                    settings.get("v1_tolerance_pct", 5.0),
                ),
            )

        for project in payload.get("projects", []):
            connection.execute(
                """INSERT INTO project (id, name, description, start_date,
                                        velocity_override, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    project["id"], project["name"], project.get("description", ""),
                    project["start_date"], project.get("velocity_override"),
                    project.get("created_at") or now_iso(),
                    project.get("updated_at") or now_iso(),
                ),
            )

        for phase in payload.get("phases", []):
            connection.execute(
                """INSERT INTO phase (id, project_id, name, description, start_date,
                                      duration_weeks, effort_points, status, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    phase["id"], phase["project_id"], phase["name"],
                    phase.get("description", ""), phase["start_date"],
                    phase.get("duration_weeks", 1), phase.get("effort_points", 0),
                    phase.get("status", "planned"), phase.get("sort_order", 0),
                ),
            )

        for dependency in payload.get("dependencies", []):
            connection.execute(
                """INSERT INTO dependency (id, predecessor_phase_id, successor_phase_id)
                   VALUES (?, ?, ?)""",
                (
                    dependency["id"], dependency["predecessor_phase_id"],
                    dependency["successor_phase_id"],
                ),
            )
        connection.execute("PRAGMA foreign_keys = ON")
