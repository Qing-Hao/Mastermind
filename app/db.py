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
    v1_tolerance_pct                  REAL    NOT NULL DEFAULT 5.0,
    -- The hub of the map view. Free text: whatever the team is called.
    department_name                   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS project (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    goal              TEXT NOT NULL DEFAULT '',
    start_date        TEXT NOT NULL,
    velocity_override INTEGER,
    -- 'idea' is a future direction: something worth doing that nobody has
    -- committed to yet. It is a project row so promoting it keeps the id and
    -- anything already written against it -- no copy, nothing lost.
    stage             TEXT NOT NULL DEFAULT 'active'
                      CHECK (stage IN ('idea', 'active', 'done')),
    -- Free-text grouping for the map view, e.g. 'Developer experience'.
    track             TEXT NOT NULL DEFAULT '',
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

-- Dependencies link projects, not phases: the useful question across a roadmap
-- is which piece of committed work has to land before another can start.
-- Ordering inside a project stays the user's business -- phases have a sort
-- order and dates, and no rule cross-checks them.
--
-- Replaces the old phase-level `dependency` table, which `migrate` translates
-- and drops. Finish-to-start only: no lag, no lead.
CREATE TABLE IF NOT EXISTS project_dependency (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    predecessor_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    successor_project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    UNIQUE (predecessor_project_id, successor_project_id)
);

-- Deliverables are planning units, not tasks: no assignee, no comments, no
-- dates. They become tasks in a downstream system once the plan is agreed.
-- They carry no estimate either: naming what a phase produces is the point, and
-- the phase itself holds the weeks and points.
--
-- `done` is the one exception to "not tasks", and it is deliberately a tick and
-- not an enum: it records whether the thing is finished or still ongoing, which
-- the planner needs to read a phase at a glance. Anything finer -- who has it,
-- when it moved, what is blocking it -- belongs in the downstream tracker.
CREATE TABLE IF NOT EXISTS deliverable (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phase_id    INTEGER NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    done        INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_phase_project ON phase(project_id);
CREATE INDEX IF NOT EXISTS idx_deliverable_phase ON deliverable(phase_id);
"""

# Phase-level dependency rows, translated up to the projects they belonged to.
# Links that collapse onto one project are dropped -- they said "this phase
# before that phase inside one project", which is no longer a thing the tool
# records. Duplicates collapse via the UNIQUE constraint.
TRANSLATE_DEPENDENCIES = """
INSERT OR IGNORE INTO project_dependency (predecessor_project_id, successor_project_id)
SELECT p.project_id, s.project_id
  FROM dependency d
  JOIN phase p ON p.id = d.predecessor_phase_id
  JOIN phase s ON s.id = d.successor_phase_id
 WHERE p.project_id <> s.project_id
"""

# Columns added after the first release. SQLite has no "ADD COLUMN IF NOT
# EXISTS", so `migrate` checks PRAGMA table_info before each ALTER.
ADDED_COLUMNS = [
    ("project", "goal", "TEXT NOT NULL DEFAULT ''"),
    ("project", "stage", "TEXT NOT NULL DEFAULT 'active' "
                         "CHECK (stage IN ('idea', 'active', 'done'))"),
    ("project", "track", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "department_name", "TEXT NOT NULL DEFAULT ''"),
    # Existing deliverables predate the tick, so they default to not done --
    # the safe read, since nothing recorded that they were finished.
    ("deliverable", "done", "INTEGER NOT NULL DEFAULT 0"),
]

# Columns retired after the first release. Deliverables stopped carrying their
# own estimate, which left the V5 rollup rule -- and its tolerance setting --
# with nothing to compare. Dropping the column discards whatever was estimated
# against it, so back the file up before upgrading.
DROPPED_COLUMNS = [
    ("deliverable", "duration_weeks"),
    ("deliverable", "effort_points"),
    ("settings", "v5_tolerance_pct"),
]

STAGES = ("idea", "active", "done")

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
        migrate(connection)


def columns_of(connection, table):
    return {row["name"] for row in
            connection.execute(f"PRAGMA table_info({table})").fetchall()}


def table_exists(connection, table):
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def migrate(connection):
    """Bring an existing file up to the current schema.

    Additions run before removals so a file that skipped several releases still
    ends up in the same shape as one created from `SCHEMA` today. The dependency
    table is handled last, once `phase` is guaranteed to be current -- the
    translation reads it.
    """
    for table, column, definition in ADDED_COLUMNS:
        if column not in columns_of(connection, table):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    for table, column in DROPPED_COLUMNS:
        if column in columns_of(connection, table):
            connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")

    migrate_dependencies_to_projects(connection)


def migrate_dependencies_to_projects(connection):
    """Lift phase-level dependencies to the projects they linked, then drop them.

    Irreversible: intra-project links are discarded outright, so back the file up
    before upgrading. A pathological old file could translate into a cycle, which
    nothing repairs -- V3 is a write-time rule. The next dependency the user adds
    would then be rejected with a 409 naming that cycle, which is the prompt to
    unlink it.
    """
    if not table_exists(connection, "dependency"):
        return
    connection.execute(TRANSLATE_DEPENDENCIES)
    connection.execute("DROP TABLE dependency")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


def as_flag(value):
    """Normalise a tick to the 0/1 SQLite actually stores.

    JSON gives us ``true``/``false``, an older export may give 0/1, and a hand-
    edited file may give neither. All of them collapse to an integer here so the
    column never holds a third thing.
    """
    return 1 if value else 0


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
        "department_name",
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


def list_projects(stages=None):
    """Every project, or only those in `stages`.

    Ideas sort last: they have no start date, so ordering by date alone would
    scatter them through the committed work.
    """
    query = ("SELECT * FROM project ORDER BY stage = 'idea', start_date = '', "
             "start_date, id")
    with connect() as connection:
        rows = connection.execute(query).fetchall()
    projects = rows_to_dicts(rows)
    if stages is None:
        return projects
    wanted = set(stages)
    return [project for project in projects if project["stage"] in wanted]


def get_project(project_id):
    with connect() as connection:
        row = connection.execute("SELECT * FROM project WHERE id = ?", (project_id,)).fetchone()
    return dict(row) if row else None


def create_project(name, start_date, description="", goal="", velocity_override=None,
                   stage="active", track=""):
    timestamp = now_iso()
    with connect() as connection:
        cursor = connection.execute(
            """INSERT INTO project (name, description, goal, start_date,
                                    velocity_override, stage, track,
                                    created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, description, goal, start_date, velocity_override, stage, track,
             timestamp, timestamp),
        )
        project_id = cursor.lastrowid
    return get_project(project_id)


def update_project(project_id, fields):
    allowed = {"name", "description", "goal", "start_date", "velocity_override",
               "stage", "track"}
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


def list_all_phases():
    """Every phase across every project, for the portfolio view."""
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM phase ORDER BY project_id, sort_order, start_date, id"
        ).fetchall()
    return rows_to_dicts(rows)


def phases_by_project():
    """Every phase grouped by project id, for the map view."""
    grouped = {}
    for phase in list_all_phases():
        grouped.setdefault(phase["project_id"], []).append(phase)
    return grouped


# --- deliverables -----------------------------------------------------------


def list_deliverables(phase_id):
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM deliverable WHERE phase_id = ? ORDER BY sort_order, id",
            (phase_id,),
        ).fetchall()
    return rows_to_dicts(rows)


def deliverables_by_phase(project_id):
    """Every deliverable in a project, grouped by phase id."""
    with connect() as connection:
        rows = connection.execute(
            """SELECT d.* FROM deliverable d
               JOIN phase p ON p.id = d.phase_id
               WHERE p.project_id = ?
               ORDER BY d.sort_order, d.id""",
            (project_id,),
        ).fetchall()
    grouped = {}
    for row in rows_to_dicts(rows):
        grouped.setdefault(row["phase_id"], []).append(row)
    return grouped


def get_deliverable(deliverable_id):
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM deliverable WHERE id = ?", (deliverable_id,)
        ).fetchone()
    return dict(row) if row else None


def create_deliverable(phase_id, name, description="", done=False):
    with connect() as connection:
        next_order = connection.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM deliverable WHERE phase_id = ?",
            (phase_id,),
        ).fetchone()[0]
        cursor = connection.execute(
            """INSERT INTO deliverable (phase_id, name, description, done, sort_order)
               VALUES (?, ?, ?, ?, ?)""",
            (phase_id, name, description, as_flag(done), next_order),
        )
        deliverable_id = cursor.lastrowid
    return get_deliverable(deliverable_id)


def update_deliverable(deliverable_id, fields):
    allowed = {"name", "description", "done", "sort_order"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if "done" in updates:
        updates["done"] = as_flag(updates["done"])
    if updates:
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as connection:
            connection.execute(
                f"UPDATE deliverable SET {assignments} WHERE id = ?",
                list(updates.values()) + [deliverable_id],
            )
    return get_deliverable(deliverable_id)


def delete_deliverable(deliverable_id):
    with connect() as connection:
        connection.execute("DELETE FROM deliverable WHERE id = ?", (deliverable_id,))


# --- dependencies -----------------------------------------------------------


def list_dependencies(project_id):
    """Every dependency the project is an end of, in either direction.

    The project view needs both: what has to land before this can start, and
    what is waiting on it. Each row carries the *other* project's name so the
    view can label the link without a second fetch.
    """
    with connect() as connection:
        rows = connection.execute(
            """SELECT d.*, p.name AS predecessor_name, s.name AS successor_name
                 FROM project_dependency d
                 JOIN project p ON p.id = d.predecessor_project_id
                 JOIN project s ON s.id = d.successor_project_id
                WHERE d.predecessor_project_id = ? OR d.successor_project_id = ?
                ORDER BY d.id""",
            (project_id, project_id),
        ).fetchall()
    return rows_to_dicts(rows)


def list_all_dependencies(with_names=False):
    """Every dependency in the dataset. Names are for display only."""
    columns = (", p.name AS predecessor_name, s.name AS successor_name"
               if with_names else "")
    joins = ("""JOIN project p ON p.id = d.predecessor_project_id
                JOIN project s ON s.id = d.successor_project_id"""
             if with_names else "")
    with connect() as connection:
        rows = connection.execute(
            f"SELECT d.*{columns} FROM project_dependency d {joins} ORDER BY d.id"
        ).fetchall()
    return rows_to_dicts(rows)


def create_dependency(predecessor_project_id, successor_project_id):
    with connect() as connection:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO project_dependency
                   (predecessor_project_id, successor_project_id)
               VALUES (?, ?)""",
            (predecessor_project_id, successor_project_id),
        )
        dependency_id = cursor.lastrowid
    return {
        "id": dependency_id,
        "predecessor_project_id": predecessor_project_id,
        "successor_project_id": successor_project_id,
    }


def delete_dependency(dependency_id):
    with connect() as connection:
        connection.execute(
            "DELETE FROM project_dependency WHERE id = ?", (dependency_id,)
        )


# --- export / import --------------------------------------------------------


def export_all():
    """Whole dataset as plain JSON-ready dicts."""
    with connect() as connection:
        projects = rows_to_dicts(connection.execute("SELECT * FROM project").fetchall())
        phases = rows_to_dicts(connection.execute("SELECT * FROM phase").fetchall())
        deliverables = rows_to_dicts(connection.execute("SELECT * FROM deliverable").fetchall())
        dependencies = rows_to_dicts(
            connection.execute("SELECT * FROM project_dependency").fetchall()
        )
    return {
        # 3 added project.stage/track and settings.department_name; 4 dropped
        # the deliverable estimate and the V5 tolerance; 5 added deliverable.done;
        # 6 moved dependencies from phases up to projects.
        # Reads stay tolerant of older files, so a version-2 through -5 export
        # still imports -- fields that no longer exist are ignored, ones that did
        # not exist yet fall back to their default, and phase-level dependencies
        # are translated on the way in.
        "version": 6,
        "exported_at": now_iso(),
        "settings": get_settings(),
        "projects": projects,
        "phases": phases,
        "deliverables": deliverables,
        "dependencies": dependencies,
    }


def project_dependencies_from(payload):
    """The payload's dependencies as project links, whatever version wrote it.

    A version-6 file already stores project ids. Anything older stored phase
    ids, so those are looked up through the payload's own phases and lifted to
    the projects they belonged to -- same as `migrate_dependencies_to_projects`,
    including dropping links that collapse onto a single project. Ids are not
    preserved when translating: several phase links can fold into one project
    link, so they are renumbered from scratch.
    """
    rows = payload.get("dependencies", [])
    if any("predecessor_project_id" in row for row in rows):
        return [
            {
                "id": row["id"],
                "predecessor_project_id": row["predecessor_project_id"],
                "successor_project_id": row["successor_project_id"],
            }
            for row in rows
        ]

    project_of = {phase["id"]: phase["project_id"]
                  for phase in payload.get("phases", [])}
    seen = []
    for row in rows:
        predecessor = project_of.get(row.get("predecessor_phase_id"))
        successor = project_of.get(row.get("successor_phase_id"))
        if predecessor is None or successor is None or predecessor == successor:
            continue
        pair = (predecessor, successor)
        if pair not in seen:
            seen.append(pair)

    return [
        {"id": index, "predecessor_project_id": predecessor,
         "successor_project_id": successor}
        for index, (predecessor, successor) in enumerate(seen, start=1)
    ]


def import_all(payload):
    """Replace the entire dataset with `payload`. Destructive by design.

    Ids are preserved so dependency links survive the round trip -- except when
    a pre-version-6 file has to have its phase links translated, which cannot
    keep them.
    """
    with connect() as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("DELETE FROM project_dependency")
        connection.execute("DELETE FROM deliverable")
        connection.execute("DELETE FROM phase")
        connection.execute("DELETE FROM project")

        settings = payload.get("settings") or {}
        if settings:
            connection.execute(
                """UPDATE settings SET default_velocity_points_per_sprint = ?,
                                       sprint_length_days = ?, v1_tolerance_pct = ?,
                                       department_name = ?
                   WHERE id = 1""",
                (
                    settings.get("default_velocity_points_per_sprint", 20),
                    settings.get("sprint_length_days", 14),
                    settings.get("v1_tolerance_pct", 5.0),
                    settings.get("department_name", ""),
                ),
            )

        for project in payload.get("projects", []):
            connection.execute(
                """INSERT INTO project (id, name, description, goal, start_date,
                                        velocity_override, stage, track,
                                        created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project["id"], project["name"], project.get("description", ""),
                    project.get("goal", ""),
                    project["start_date"], project.get("velocity_override"),
                    # A version-2 file has neither: everything in it was a
                    # committed project, so 'active' with no track is right.
                    project.get("stage") or "active",
                    project.get("track", ""),
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

        for deliverable in payload.get("deliverables", []):
            # A version-3 file still carries duration_weeks and effort_points.
            # Nothing reads them any more, so they are dropped on the way in.
            # A file older than version 5 has no tick, which reads as not done.
            connection.execute(
                """INSERT INTO deliverable (id, phase_id, name, description,
                                            done, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    deliverable["id"], deliverable["phase_id"], deliverable["name"],
                    deliverable.get("description", ""),
                    as_flag(deliverable.get("done", 0)),
                    deliverable.get("sort_order", 0),
                ),
            )

        for dependency in project_dependencies_from(payload):
            connection.execute(
                """INSERT OR IGNORE INTO project_dependency
                       (id, predecessor_project_id, successor_project_id)
                   VALUES (?, ?, ?)""",
                (
                    dependency["id"], dependency["predecessor_project_id"],
                    dependency["successor_project_id"],
                ),
            )
        connection.execute("PRAGMA foreign_keys = ON")
