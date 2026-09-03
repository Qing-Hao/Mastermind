"""SQLite storage. Single-user, single file, no migrations framework.

The whole dataset lives in one file (``data/roadmap.db`` by default) so it can be
copied for backup and opened with any SQLite browser. Rows come back as plain
dicts, which is exactly what `app.validation` expects.
"""

import os
import sqlite3
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "roadmap.db")

SETTINGS_TABLE = """
CREATE TABLE IF NOT EXISTS settings (
    id                                INTEGER PRIMARY KEY CHECK (id = 1),
    default_velocity_points_per_sprint INTEGER NOT NULL DEFAULT 20,
    sprint_length_days                INTEGER NOT NULL DEFAULT 14,
    v1_tolerance_pct                  REAL    NOT NULL DEFAULT 5.0,
    -- The hub of the map view. Free text: whatever the team is called.
    department_name                   TEXT    NOT NULL DEFAULT '',
    -- Sign-in configuration, secrets included, all of it editable from the
    -- Sign-in page. `export_all` writes this row out, so every `sso_` column is
    -- stripped from the export by `settings_without_sso` -- that strip is what
    -- keeps a secret out of the JSON, and it is a prefix test, so a sign-in
    -- column added without the prefix would walk straight into the file.
    --
    -- The file itself is therefore secret-bearing: `data/roadmap.db`, every copy
    -- under `data/backups/`, and any `.bak` beside them. Clear the two secret
    -- columns before handing the file to anybody.
    --
    -- `sso_enabled` is not a preference: only a completed round trip that
    -- satisfied `auth.is_allowed` sets it. See `main.finish_sign_in`.
    sso_issuer                        TEXT    NOT NULL DEFAULT '',
    sso_client_id                     TEXT    NOT NULL DEFAULT '',
    sso_identity_claim                TEXT    NOT NULL DEFAULT 'preferred_username',
    sso_allowlist                     TEXT    NOT NULL DEFAULT '',
    sso_mode                          TEXT    NOT NULL DEFAULT 'allowlist'
                                      CHECK (sso_mode IN ('allowlist', 'any')),
    sso_enabled                       INTEGER NOT NULL DEFAULT 0
                                      CHECK (sso_enabled IN (0, 1)),
    -- Empty means "fall back to the environment variable", which is how a
    -- deployment configured before these columns existed keeps working.
    sso_client_secret                 TEXT    NOT NULL DEFAULT '',
    sso_session_key                   TEXT    NOT NULL DEFAULT '',
    sso_redirect_uri                  TEXT    NOT NULL DEFAULT '',
    sso_allow_http                    INTEGER NOT NULL DEFAULT 0
                                      CHECK (sso_allow_http IN (0, 1))
);
"""

# Kept apart from the rest of the schema, and parameterised by name, because
# `migrate_stage_check` has to build an identical table under a temporary name.
# Two spellings of this table would drift the moment one of them was edited.
PROJECT_TABLE = """
CREATE TABLE IF NOT EXISTS {name} (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    goal              TEXT NOT NULL DEFAULT '',
    start_date        TEXT NOT NULL,
    velocity_override INTEGER,
    -- Only three of these four values still decide anything, because
    -- `validation.project_stage` derives the rest from the plan and the clock:
    --
    --   'idea'             nobody has committed. Keeps work off the portfolio.
    --   'planned'/'active' both mean simply "committed" and are not
    --                      distinguished any more -- the ladder works out
    --                      whether committed work is drafted, dated, running or
    --                      late. 'planned' is what the UI writes; 'active' is
    --                      what older rows carry and reads identically.
    --   'done'             the manual close, and it beats the ladder outright.
    --                      Not "delivered" but "closed without finishing":
    --                      cancelled work never reaches every-phase-done and
    --                      would otherwise sit overdue forever.
    --
    -- The CHECK keeps all four: narrowing it would mean rebuilding this table
    -- (see `migrate_stage_check`), which has cost a real dataset once, to buy
    -- nothing a reader of this comment does not already know.
    stage             TEXT NOT NULL DEFAULT 'active'
                      CHECK (stage IN ('idea', 'planned', 'active', 'done')),
    -- `draft_complete` lived here between export versions 9 and 10. It said "I
    -- am done drafting this plan" and decided `planning` vs `planned`; the
    -- milestone table answers the same question with evidence instead of a
    -- promise, so the switch went rather than sitting beside it disagreeing.
    --
    -- Free-text grouping for the map view, e.g. 'Developer experience'.
    track             TEXT NOT NULL DEFAULT '',
    -- Priority, 1 highest. 0 is untiered and is a state of its own, not a
    -- fourth tier: it means nobody has ranked this yet. Nothing derives from
    -- it and no rule reads it -- it exists so the map can be filtered down to
    -- what matters when the roadmap gets crowded.
    tier              INTEGER NOT NULL DEFAULT 0
                      CHECK (tier IN (0, 1, 2, 3)),
    -- What sort of work this is: a new build, a change to something already
    -- live, something asked for from outside, a fix, or a move from one place
    -- to another. '' means nobody has said yet, and is a state of its own
    -- rather than one more sort -- the same shape as tier 0, and the reason
    -- this list can grow without that changing. **Nothing derives from it**:
    -- no rule reads it, no date moves because of it, and nothing sums against
    -- it. It exists so the map
    -- can be filtered and the portfolio can say what kind of work is running,
    -- which is a question a roadmap gets asked by people who do not read it
    -- daily.
    --
    -- No CHECK, deliberately, where `stage` and `tier` both have one: the
    -- vocabulary here is likelier to gain a word than either of those, and
    -- narrowing or widening a CHECK means rebuilding this table -- see
    -- `migrate_stage_check`, which has cost a real dataset once. `KINDS` below
    -- is the list, and `main.clean_kind` is the boundary that enforces it.
    -- **That decision has already paid for itself**: `migration` was added the
    -- day after the field shipped, and it cost one tuple and no migration at
    -- all.
    kind              TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
"""

REST_OF_SCHEMA = """
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

-- A milestone is a checkpoint between phases: the thing the plan is aiming at,
-- rather than a piece of work someone does. It belongs to the project and not to
-- a phase, because a checkpoint routinely sits between two of them or spans
-- several, and hanging it off one phase would make that unsayable.
--
-- `achieved` is the only stored state in the model that a derived project status
-- reads. That is deliberate and it is why milestones exist: `done` used to derive
-- from every phase being closed, which nobody maintained, and the alternatives
-- were deriving it from dates (which silences V6, the rule that finds late work)
-- or from deliverable ticks (which rule 4 keeps casual on purpose). A milestone
-- is the one object here designed to carry the decision.
--
-- `target_date` follows the unscheduled convention: '' rather than NULL, so it
-- round-trips an <input type="date"> untouched. An undated milestone is a real
-- state -- name the checkpoint now, date it when you commit -- and simply draws
-- no diamond on the timeline.
CREATE TABLE IF NOT EXISTS milestone (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_date TEXT NOT NULL DEFAULT '',
    achieved    INTEGER NOT NULL DEFAULT 0 CHECK (achieved IN (0, 1)),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- What a quarter is for, in the team's own words. The one thing on the roadmap
-- view that is stored rather than derived: everything else there -- which
-- quarter a project lands in, what checkpoints fall inside it, how many of them
-- are reached -- is read off the phases and milestones that already exist.
--
-- `period` is '2026-Q3' and it is the whole key. **There is deliberately no
-- project_id and no join table.** A row saying "this project belongs to Q3"
-- would be a second answer to when the work lands, competing with the dates on
-- its phases, and the two would drift the first time somebody moved a date. The
-- goal is a statement about a period; the work under it is derived from the
-- calendar and joins to nothing.
--
-- `achieved` is a tick for the same reason `milestone.achieved` is one: it
-- records a decision somebody made, and nothing derives it from the work below.
-- A quarter can close with its goal unmet, which is a real and useful state.
-- Nothing about a person is stored here -- see non-negotiable 7. The row belongs
-- to the department, not to whoever typed it.
CREATE TABLE IF NOT EXISTS quarter_goal (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    period   TEXT NOT NULL UNIQUE,
    goal     TEXT NOT NULL DEFAULT '',
    target   TEXT NOT NULL DEFAULT '',
    achieved INTEGER NOT NULL DEFAULT 0 CHECK (achieved IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_phase_project ON phase(project_id);
CREATE INDEX IF NOT EXISTS idx_deliverable_phase ON deliverable(phase_id);
CREATE INDEX IF NOT EXISTS idx_milestone_project ON milestone(project_id);
"""

# What `init_db` runs. Assembled rather than written out so the project table
# has exactly one definition -- see PROJECT_TABLE.
SCHEMA = SETTINGS_TABLE + PROJECT_TABLE.format(name="project") + REST_OF_SCHEMA

# The columns the current project table has. Used by the stage rebuild to copy
# across only what both the old file and this build know about, so a column
# retired in some earlier release is left behind rather than failing the copy.
PROJECT_COLUMNS = (
    "id", "name", "description", "goal", "start_date", "velocity_override",
    "stage", "track", "tier", "kind", "created_at", "updated_at",
)

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
                         "CHECK (stage IN ('idea', 'planned', 'active', 'done'))"),
    ("project", "track", "TEXT NOT NULL DEFAULT ''"),
    # Existing projects arrive untiered rather than at some middle tier:
    # inventing a rank for work nobody ranked would be a scheduling opinion.
    ("project", "tier", "INTEGER NOT NULL DEFAULT 0 CHECK (tier IN (0, 1, 2, 3))"),
    # Existing projects arrive unclassified rather than guessed at. A roadmap
    # written before the field existed cannot say which of its projects were new
    # builds, and calling them all one thing would be inventing the answer.
    ("project", "kind", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "department_name", "TEXT NOT NULL DEFAULT ''"),
    # Existing deliverables predate the tick, so they default to not done --
    # the safe read, since nothing recorded that they were finished.
    ("deliverable", "done", "INTEGER NOT NULL DEFAULT 0"),
    # Existing projects arrive still-drafting rather than drafted. It is the
    # quieter default of the two: it reads `planning`, which understates a plan
    # that is in fact finished, where the opposite would call every half-written
    # plan in the file done. Undoing it is one click per project, and only for
    # projects that have no dates -- once work is dated the flag is ignored.
    ("project", "draft_complete", "INTEGER NOT NULL DEFAULT 0 "
                                  "CHECK (draft_complete IN (0, 1))"),
    # Sign-in configuration, added when the app stopped being localhost-only.
    # Additions only -- no table rebuild, so `migrate_stage_check` is nowhere
    # near this. An existing file arrives with the gate off and no issuer, which
    # is exactly how a file that has never seen SSO should read.
    ("settings", "sso_issuer", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_client_id", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_identity_claim", "TEXT NOT NULL DEFAULT 'preferred_username'"),
    ("settings", "sso_allowlist", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_mode", "TEXT NOT NULL DEFAULT 'allowlist' "
                             "CHECK (sso_mode IN ('allowlist', 'any'))"),
    ("settings", "sso_enabled", "INTEGER NOT NULL DEFAULT 0 "
                                "CHECK (sso_enabled IN (0, 1))"),
    # The secrets and the two deployment overrides, moved out of the environment
    # so the whole gate is configured on its own page. Empty means "read the
    # environment variable instead", so a file that arrives from the previous
    # arrangement gains four empty columns and behaves exactly as it did.
    ("settings", "sso_client_secret", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_session_key", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_redirect_uri", "TEXT NOT NULL DEFAULT ''"),
    ("settings", "sso_allow_http", "INTEGER NOT NULL DEFAULT 0 "
                                   "CHECK (sso_allow_http IN (0, 1))"),
]

# Columns retired after the first release. Deliverables stopped carrying their
# own estimate, which left the V5 rollup rule -- and its tolerance setting --
# with nothing to compare. Dropping the column discards whatever was estimated
# against it, so back the file up before upgrading.
DROPPED_COLUMNS = [
    ("deliverable", "duration_weeks"),
    ("deliverable", "effort_points"),
    ("settings", "v5_tolerance_pct"),
    # The drafting switch, replaced by the milestone table at export version 10.
    # It asked whether a plan was shaped; a checkpoint answers that with
    # evidence rather than a promise, and could not go stale the way the flag
    # could. Dropping discards whatever was set -- back the file up first.
    #
    # ADDED_COLUMNS still carries its `ALTER TABLE ADD`, deliberately: additions
    # run before removals, so a file that skipped version 9 entirely gains the
    # column and loses it again in one pass rather than diverging.
    ("project", "draft_complete"),
]

STAGES = ("idea", "planned", "active", "done")
# 0 is "untiered", not a fourth tier -- see the column comment.
TIERS = (0, 1, 2, 3)
# '' is "unclassified", not a fifth kind -- see the column comment. This order is
# the order the map's chips and the portfolio's readout draw in, and '' sits last
# for the reason tier 0 does: the absence of a decision sorts after every
# decision.
KINDS = ("new", "enhancement", "feature", "fix", "migration", "")

# How long a writer waits for another writer's lock before giving up. Named
# rather than left to `sqlite3.connect`'s own five-second default, because that
# default is invisible at the call site and this is now a decision.
BUSY_TIMEOUT_MS = 5000

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
    # A reader no longer blocks behind a writer, and a writer no longer fails
    # outright while another holds the lock -- it waits. `journal_mode` is a
    # property of the file and persists, so re-asserting it costs nothing after
    # the first connection; `busy_timeout` is per connection and must be set
    # every time. WAL leaves `-wal` and `-shm` beside the file, and does not
    # work over a network share -- keep `data/` on a local disk or a container
    # volume, never a mapped drive.
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


# How many startup backups to keep beside the dataset. Ten is a fortnight of
# ordinary restarts and a few megabytes.
BACKUP_KEEP = 10
BACKUP_DIR_NAME = "backups"


def backup_before_migrate():
    """Copy the dataset aside before `migrate` runs. Never raises.

    `init_db()` runs on every start -- and, under `--reload`, every time a source
    file is saved. `migrate` can drop a column, and that has cost the real dataset
    once. This turns a documented hazard into a recoverable one for the price of a
    file copy.

    The SQLite backup API rather than `shutil.copy`, because the file is in WAL
    mode: a plain copy can miss whatever is still in `-wal`.
    """
    if not os.path.exists(_db_path) or os.path.getsize(_db_path) == 0:
        return None
    directory = os.path.join(os.path.dirname(_db_path) or ".", BACKUP_DIR_NAME)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(directory, f"roadmap-{stamp}.db")
    try:
        os.makedirs(directory, exist_ok=True)
        source = sqlite3.connect(_db_path)
        destination = sqlite3.connect(target)
        with source, destination:
            source.backup(destination)
        destination.close()
        source.close()
        prune_backups(directory)
        return target
    except (sqlite3.Error, OSError):
        # A backup that cannot be written is not a reason to refuse to start --
        # a read-only volume would otherwise take the whole app down.
        return None


def prune_backups(directory, keep=BACKUP_KEEP):
    """Keep the newest `keep` startup backups and delete the rest."""
    try:
        existing = sorted(name for name in os.listdir(directory)
                          if name.startswith("roadmap-") and name.endswith(".db"))
    except OSError:
        return
    # Named by timestamp, so alphabetical order is oldest first.
    for name in existing[:-keep] if keep else existing:
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass


def init_db():
    backup_before_migrate()
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

    The stage rebuild runs before both: it replaces the whole `project` table,
    so anything that ALTERs it has to see the new one.
    """
    migrate_stage_check(connection)

    for table, column, definition in ADDED_COLUMNS:
        if column not in columns_of(connection, table):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    for table, column in DROPPED_COLUMNS:
        if column in columns_of(connection, table):
            connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")

    migrate_dependencies_to_projects(connection)


def migrate_stage_check(connection):
    """Widen the `stage` CHECK so it accepts 'planned'.

    SQLite cannot alter a CHECK in place, and the old constraint was baked into
    the column by the ALTER that first added `stage`, so the only way through is
    to rebuild the table: create, copy, drop, rename. Irreversible -- back the
    file up first.

    The constraint is kept rather than dropped in favour of `main.clean_stage`,
    because `import_all` writes stage straight in without passing the API
    boundary. The CHECK is the only thing guarding that path.

    Detected by reading the stored SQL rather than by a version number, since
    there is no migration table: a file whose project table already names
    'planned' is current, and one with no project table at all is brand new and
    was just built from SCHEMA.
    """
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project'"
    ).fetchone()
    if row is None or "'planned'" in row[0]:
        return

    # Only the columns this build knows about survive; a column retired in some
    # earlier release is left behind rather than failing the copy.
    kept = [column for column in columns_of(connection, "project")
            if column in PROJECT_COLUMNS]
    names = ", ".join(kept)

    # Foreign keys MUST be off for this. With them on, DROP TABLE runs an
    # implicit DELETE, and phase.project_id is ON DELETE CASCADE -- dropping the
    # old table would take every phase and deliverable in the file with it.
    # PRAGMA foreign_keys is silently ignored inside a transaction, and `migrate`
    # is called from `init_db` with one already open, so commit first and then
    # check the pragma actually took rather than trusting it.
    connection.commit()
    connection.execute("PRAGMA foreign_keys = OFF")
    if connection.execute("PRAGMA foreign_keys").fetchone()[0]:
        raise RuntimeError(
            "Refusing to rebuild the project table with foreign keys enabled: "
            "the drop would cascade into phase and deliverable.")

    # SQLite's own recommended order: build the replacement alongside, copy,
    # drop, then rename into place. The obvious alternative -- renaming the old
    # table out of the way first -- silently rewrites every REFERENCES clause
    # pointing at `project` to point at the renamed table, with or without
    # foreign keys enabled, which would leave phase and project_dependency
    # referring to a table this function then drops.
    try:
        connection.execute(PROJECT_TABLE.format(name="project_rebuilt"))
        connection.execute(
            f"INSERT INTO project_rebuilt ({names}) SELECT {names} FROM project")
        connection.execute("DROP TABLE project")
        connection.execute("ALTER TABLE project_rebuilt RENAME TO project")
        connection.commit()
    finally:
        connection.execute("PRAGMA foreign_keys = ON")


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


def next_plan_sort_order(connection, project_id):
    """Where a new phase or checkpoint goes: last in one shared sequence.

    `phase.sort_order` and `milestone.sort_order` are one number line, because the
    project view draws the two interleaved and a checkpoint's place between two
    phases is the thing worth arranging. Taking each table's own MAX would put a
    new phase and a new checkpoint on the same number, which reads as a tie until
    the first drag renumbers the sequence -- so the MAX is read across both.

    Only *creation* shares this. Reordering renumbers the whole sequence from
    zero client-side, and nothing here validates the line: no rule reads the
    order, so a file with ties or gaps is still a well-formed file.
    """
    return connection.execute(
        """SELECT COALESCE(MAX(sort_order), -1) + 1 FROM (
               SELECT sort_order FROM phase WHERE project_id = ?
               UNION ALL
               SELECT sort_order FROM milestone WHERE project_id = ?
           )""",
        (project_id, project_id),
    ).fetchone()[0]


# --- settings ---------------------------------------------------------------


def get_settings():
    with connect() as connection:
        row = connection.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return dict(row)


def settings_without_sso(settings):
    """The settings row minus sign-in configuration. See `export_all`.

    A prefix test, and the reason every sign-in column is named `sso_`: two of
    them hold secrets, and this is the single line standing between them and the
    JSON that gets emailed.
    """
    return {key: value for key, value in settings.items() if not key.startswith("sso_")}


def update_settings(fields):
    allowed = {
        "default_velocity_points_per_sprint",
        "sprint_length_days",
        "v1_tolerance_pct",
        "department_name",
        # Sign-in configuration. `sso_enabled` is writable here because arming
        # goes through this one door, but the only caller that passes it is the
        # callback of a real sign-in -- never the settings page.
        "sso_issuer",
        "sso_client_id",
        "sso_identity_claim",
        "sso_allowlist",
        "sso_mode",
        "sso_enabled",
        # Secrets and deployment overrides. Absent from the caller's dict means
        # "leave the stored value alone" -- the page shows a mask, and a save
        # that echoed the mask back would store the dots. Present and empty is
        # the deliberate clear. `main.write_sso_config` decides which it is.
        "sso_client_secret",
        "sso_session_key",
        "sso_redirect_uri",
        "sso_allow_http",
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

    Finished work sorts to the very bottom and ideas just above it, so the
    middle of the list is the work actually in flight. Both have to be pushed
    explicitly: a done project keeps its dates and would otherwise sort by
    them, and an idea has none at all, so date order alone would scatter the
    two through the live projects from opposite ends.
    """
    query = ("SELECT * FROM project ORDER BY stage = 'done', stage = 'idea', "
             "stage = 'planned', start_date = '', start_date, id")
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
                   stage="active", track="", tier=0, kind=""):
    timestamp = now_iso()
    with connect() as connection:
        cursor = connection.execute(
            """INSERT INTO project (name, description, goal, start_date,
                                    velocity_override, stage, track, tier, kind,
                                    created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, description, goal, start_date, velocity_override, stage, track,
             tier, kind, timestamp, timestamp),
        )
        project_id = cursor.lastrowid
    return get_project(project_id)


def update_project(project_id, fields):
    allowed = {"name", "description", "goal", "start_date", "velocity_override",
               "stage", "track", "tier", "kind"}
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


def retrack_projects(changes):
    """Rewrite `track` on many projects at once. `changes` is (id, track) pairs.

    One statement in one transaction, because a track level is only the strings
    the rows spell: half a rewrite is a level that exists under two names, which
    the map would draw as two rings. Row by row through `update_project` could
    leave exactly that behind.
    """
    pairs = list(changes)
    if not pairs:
        return 0
    timestamp = now_iso()
    with connect() as connection:
        connection.executemany(
            "UPDATE project SET track = ?, updated_at = ? WHERE id = ?",
            [(track, timestamp, project_id) for project_id, track in pairs],
        )
    return len(pairs)


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
        next_order = next_plan_sort_order(connection, project_id)
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


def deliverables_by_project():
    """Every deliverable grouped by the project it belongs to.

    The project list needs deliverable coverage for all projects at once, and
    `deliverables_by_phase` would be one query each.
    """
    with connect() as connection:
        rows = connection.execute(
            """SELECT d.*, p.project_id FROM deliverable d
               JOIN phase p ON p.id = d.phase_id
               ORDER BY d.sort_order, d.id"""
        ).fetchall()
    grouped = {}
    for row in rows_to_dicts(rows):
        grouped.setdefault(row["project_id"], []).append(row)
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


# --- milestones -------------------------------------------------------------


def list_milestones(project_id):
    """A project's checkpoints, in the order they were arranged.

    Sorted by `sort_order` and not by date, like phases and deliverables: order
    is the user's arrangement, and an undated milestone has no date to sort on.
    """
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM milestone WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,),
        ).fetchall()
    return rows_to_dicts(rows)


def milestones_by_project():
    """Every milestone grouped by project id.

    The project list and the map need milestone coverage for every project at
    once -- the stage ladder now reads it -- and `list_milestones` would be one
    query each. The twin of `deliverables_by_project`.
    """
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM milestone ORDER BY sort_order, id"
        ).fetchall()
    grouped = {}
    for row in rows_to_dicts(rows):
        grouped.setdefault(row["project_id"], []).append(row)
    return grouped


def get_milestone(milestone_id):
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM milestone WHERE id = ?", (milestone_id,)
        ).fetchone()
    return dict(row) if row else None


def create_milestone(project_id, name, description="", target_date="",
                     achieved=False):
    with connect() as connection:
        next_order = next_plan_sort_order(connection, project_id)
        cursor = connection.execute(
            """INSERT INTO milestone (project_id, name, description, target_date,
                                      achieved, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (project_id, name, description, target_date, as_flag(achieved),
             next_order),
        )
        milestone_id = cursor.lastrowid
    return get_milestone(milestone_id)


def update_milestone(milestone_id, fields):
    allowed = {"name", "description", "target_date", "achieved", "sort_order"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if "achieved" in updates:
        updates["achieved"] = as_flag(updates["achieved"])
    if updates:
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as connection:
            connection.execute(
                f"UPDATE milestone SET {assignments} WHERE id = ?",
                list(updates.values()) + [milestone_id],
            )
    return get_milestone(milestone_id)


def delete_milestone(milestone_id):
    with connect() as connection:
        connection.execute("DELETE FROM milestone WHERE id = ?", (milestone_id,))


# --- quarter goals ----------------------------------------------------------
#
# Keyed by period, so there is no create-then-edit dance: the roadmap draws a
# column for a quarter whether or not a row exists for it, and writing one is an
# upsert. A goal nobody has written is an absent row, not a blank one.


def quarter_goals_by_period():
    """Every quarter goal, keyed by its period. The shape the roadmap reads.

    A dict rather than a list because the caller has a column per period and
    wants to ask for one; the twin of `deliverables_by_project` in intent.
    """
    with connect() as connection:
        rows = connection.execute("SELECT * FROM quarter_goal ORDER BY period").fetchall()
    return {row["period"]: row for row in rows_to_dicts(rows)}


def get_quarter_goal(period):
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM quarter_goal WHERE period = ?", (period,)
        ).fetchone()
    return dict(row) if row else None


def set_quarter_goal(period, fields):
    """Write one period's goal, creating the row if it is the first write.

    Only the named fields move: a PUT carrying just `achieved` ticks the quarter
    without touching what was written in it, which is what the tick on the
    column header sends.
    """
    allowed = {"goal", "target", "achieved"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if "achieved" in updates:
        updates["achieved"] = as_flag(updates["achieved"])

    with connect() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO quarter_goal (period) VALUES (?)", (period,)
        )
        if updates:
            assignments = ", ".join(f"{key} = ?" for key in updates)
            connection.execute(
                f"UPDATE quarter_goal SET {assignments} WHERE period = ?",
                list(updates.values()) + [period],
            )
    return get_quarter_goal(period)


def delete_quarter_goal(period):
    """Clear a period back to having no goal at all.

    Deleting rather than blanking, so "nobody has written one" stays one state
    instead of two that look the same on screen.
    """
    with connect() as connection:
        connection.execute("DELETE FROM quarter_goal WHERE period = ?", (period,))


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
        milestones = rows_to_dicts(connection.execute("SELECT * FROM milestone").fetchall())
        quarter_goals = rows_to_dicts(
            connection.execute("SELECT * FROM quarter_goal").fetchall()
        )
    return {
        # 3 added project.stage/track and settings.department_name; 4 dropped
        # the deliverable estimate and the V5 tolerance; 5 added deliverable.done;
        # 6 moved dependencies from phases up to projects; 7 added project.tier;
        # 8 added the 'planned' stage; 9 added project.draft_complete; 10 added
        # the milestone table and dropped draft_complete again.
        # Reads stay tolerant of older files, so a version-2 through -9 export
        # still imports -- fields that no longer exist are ignored, ones that did
        # not exist yet fall back to their default, and phase-level dependencies
        # are translated on the way in. Nothing in an older file is ever
        # 'planned', so no translation is needed for version 8. A pre-10 file has
        # no milestones, which reads as a plan still being drafted -- the same
        # quiet default `draft_complete` arrived with, and the honest one: a file
        # written before checkpoints existed cannot say what it was aiming at.
        # 11 added quarter goals -- a pre-11 file simply has none, which reads
        # as a roadmap nobody has written a goal on yet. 12 added project.kind,
        # and a pre-12 file arrives unclassified, which is the honest reading: it
        # was written by a tool that could not say what sort of work a project
        # was.
        "version": 12,
        "exported_at": now_iso(),
        # Sign-in configuration is stripped rather than exported. It describes
        # this deployment's gate, not the dataset -- an issuer and an allowlist
        # mean nothing on the machine an export is carried to, and an export is
        # the file that gets emailed. `import_all` names its four settings
        # columns explicitly, so a restore leaves the gate exactly as it found
        # it. The version does not move: what a consumer reads is unchanged.
        "settings": settings_without_sso(get_settings()),
        "projects": projects,
        "phases": phases,
        "deliverables": deliverables,
        "dependencies": dependencies,
        "milestones": milestones,
        "quarter_goals": quarter_goals,
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
        connection.execute("DELETE FROM quarter_goal")
        connection.execute("DELETE FROM milestone")
        connection.execute("DELETE FROM deliverable")
        connection.execute("DELETE FROM phase")
        connection.execute("DELETE FROM project")

        # The four dataset settings, named one by one. The `sso_*` columns are
        # deliberately absent: importing somebody's plan must not reconfigure --
        # or disarm -- the gate on this machine.
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
                                        velocity_override, stage, track, tier,
                                        kind, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project["id"], project["name"], project.get("description", ""),
                    project.get("goal", ""),
                    project["start_date"], project.get("velocity_override"),
                    # A version-2 file has neither: everything in it was a
                    # committed project, so 'active' with no track is right.
                    project.get("stage") or "active",
                    project.get("track", ""),
                    # Anything before 7 predates tiers: untiered is the honest
                    # read, since nothing in the file ranked it.
                    project.get("tier") or 0,
                    # Anything before 12 predates kinds, and the same argument
                    # applies: a file that could not say what sort of work this
                    # was arrives unclassified rather than guessed at.
                    project.get("kind") or "",
                    # A version-9 file carries `draft_complete`. It is read and
                    # discarded rather than translated: the milestone list is
                    # what answers that question now, and inventing a checkpoint
                    # to carry a flag across would be making up a target the
                    # file never named.
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

        # Absent from anything before version 10, where `.get` returning an empty
        # list is the whole compatibility story -- a file written before
        # checkpoints existed simply has none.
        for milestone in payload.get("milestones", []):
            connection.execute(
                """INSERT INTO milestone (id, project_id, name, description,
                                          target_date, achieved, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    milestone["id"], milestone["project_id"], milestone["name"],
                    milestone.get("description", ""),
                    milestone.get("target_date", ""),
                    as_flag(milestone.get("achieved", 0)),
                    milestone.get("sort_order", 0),
                ),
            )

        # Absent before version 11, and `.get` covers it the same way. Keyed by
        # period rather than by id, so a row whose period the file repeats is
        # ignored rather than failing the whole import on the UNIQUE constraint.
        for quarter_goal in payload.get("quarter_goals", []):
            connection.execute(
                """INSERT OR IGNORE INTO quarter_goal (period, goal, target, achieved)
                   VALUES (?, ?, ?, ?)""",
                (
                    quarter_goal["period"], quarter_goal.get("goal", ""),
                    quarter_goal.get("target", ""),
                    as_flag(quarter_goal.get("achieved", 0)),
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
