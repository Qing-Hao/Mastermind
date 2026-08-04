# Roadmap Planner

Single-user internal tool for planning software delivery from roadmap → phases →
deliverables. Localhost only. All data in one SQLite file.

**This file is the summary. Read it instead of re-reading `PROMPT.md` (the brief)
and `STATUS.md` (my working notes) unless you need their detail.**

## Stack & commands

FastAPI + SQLite (stdlib `sqlite3`) + vanilla JS. No build step, no ORM, no
migration framework, no auth.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000   # http://127.0.0.1:8000
.\.venv\Scripts\python.exe -m pytest -q                                   # 104 tests, ~2.1s
```

Type checking is pyright, `basic` mode, config in `pyrightconfig.json`.
`conftest.py` exists only to put the repo root on `sys.path`.

## Layout

| Path | What lives there |
|---|---|
| `app/validation.py` | Rules V1–V4 + project summaries. **Pure functions, no I/O.** The heart of the tool. |
| `app/db.py` | Schema, CRUD, `migrate`, export/import. Rows in/out as plain dicts. |
| `app/main.py` | FastAPI routes. Thin — no business logic beyond the V3 block. |
| `app/static/{index.html,app.js,style.css}` | Frontend. Three tabs: Project / Portfolio / Map. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `data/roadmap.db` | The dataset. Gitignored. `.bak` is the pre-migration copy. |

Keep this shape. Extend an existing module rather than adding a file; propose a
structure change before adding anything top-level.

## Data model

`settings` (singleton row) — `default_velocity_points_per_sprint` (20),
`sprint_length_days` (14), `v1_tolerance_pct` (5.0), `department_name`.

`project` — name, description, `goal` (free text, never parsed), `start_date`,
`velocity_override` (nullable), `stage` ∈ `idea|active|done`, `track` (free text),
timestamps.

`phase` — `project_id`, name, description, `start_date`, `duration_weeks` (REAL),
`effort_points` (INT), `status` ∈ `planned|in_progress|done`, `sort_order`.

`deliverable` — `phase_id`, name, description, `done` (0/1), `sort_order`.

`project_dependency` — `predecessor_project_id`, `successor_project_id`.
Finish-to-start only; no lag or lead. **Dependencies link projects, not phases.**
Order inside a project is the user's to arrange and no rule checks it — the phase
table has `sort_order` and dates, nothing more.

**`end_date` is always derived** (`start_date + duration_weeks × 7`) and never
stored — see `validation.phase_end_date` and `main.with_end_date`. A project has
no end column either: `validation.project_span` derives the pair of dates a
project occupies, its end being the latest phase end inside it.

## Rules that must not be broken

1. **The timeline never auto-reschedules.** Dates belong to the user. Every rule
   reports; nothing repairs. A plan may sit in a warning state forever.
2. **V3 (dependency cycle) is the one exception** — malformed data, not a
   scheduling opinion. `POST /api/dependencies` returns **409** naming the cycle
   and writes nothing.
3. **Weeks and points are entered independently.** Neither derives the other; V1
   only cross-checks them.
4. **Deliverables are planning units, not tasks.** Name + description + a `done`
   tick. No estimate, no assignee, no dates, no history. The tick fires no rule,
   never sets `phase.status`, never moves a date. If asked for an intermediate
   state, push back — an enum is where this becomes the tracker the brief forbids.
5. **V5 is deleted, not dormant.** Deliverables lost their estimates, so the
   rollup had no input. `v5_tolerance_pct` went with it. `PROMPT.md` still carries
   the original V5 prose as the record of what was first asked; its **Amendments**
   section overrides the body text.
6. **Dependencies are project-to-project, and phase order is unvalidated.** They
   linked phases until export v6. Losing the intra-project check was accepted
   deliberately, not overlooked: the requester wanted links between whole pieces
   of work. Don't reintroduce phase links without asking.

## Validation rules

| ID | Fires when | Behaviour |
|---|---|---|
| ID | Scope | Fires when | Behaviour |
|---|---|---|---|
| V1 | phase | `abs(duration_weeks − implied_weeks) > v1_tolerance_pct%` of `duration_weeks`, where `implied_weeks = (effort_points / velocity) × (sprint_length_days / 7)` | Warn |
| V2 | project pair | Successor project's span start < predecessor project's span end | Warn |
| V3 | project pair | Dependency cycle | **Block, 409** |
| V4 | phase | Phase starts before its project's `start_date` | Warn |

Velocity = `project.velocity_override` or the global default. Tolerance defaults
to **5%** deliberately: the canonical 6w / 55pts @ velocity 20 case is off by
8.3%, so 20% would never fire.

`validate_plan()` runs V1 and V4 on one project. **V2 lives in
`validate_portfolio()`** — it compares two projects, so it needs every project,
its phases and every dependency. V3 is in neither: it is checked at write time.
`GET /api/projects/{id}` merges the V2 warnings naming that project into its own
list, so both ends of a link see it.

## Unscheduled is a first-class state

An empty `start_date` is stored as `""` (not NULL) so it round-trips through an
HTML `<input type="date">` untouched. Estimate first, commit dates later.

- Reads are **lenient** (`as_optional_date` swallows bad values) so one bad row
  cannot break a whole project view.
- Writes are **strict** (`main.clean_date` → 422) so bad values never get stored.
- V4 skips unscheduled records, and V2 skips a project with nothing scheduled on
  the side it needs (no start, or no phase end). V1 does not care about dates.
- Portfolio omits unscheduled phases and reports `unscheduled_count`.
- The project timeline's **Weeks** mode draws undated phases as `W1, W2, …`, so
  a plan with no dates at all still has a readable shape to arrange.
- `POST /api/projects/{id}/layout` places undated phases back to back from the
  project start. **User-triggered only** — it is not auto-scheduling.

## API surface

`/api/settings` GET PUT · `/api/projects` GET POST · `/api/projects/{id}` GET PUT
DELETE · `/api/projects/{id}/layout` POST · `/api/projects/{id}/phases` POST ·
`/api/phases/{id}` PUT DELETE · `/api/phases/{id}/deliverables` GET POST ·
`/api/deliverables/{id}` PUT DELETE · `/api/dependencies` POST ·
`/api/dependencies/{id}` DELETE · `/api/portfolio` GET · `/api/graph` GET ·
`/api/export` GET · `/api/import` POST.

`GET /api/projects/{id}` returns the whole plan in one payload: project, phases
(with derived dates, `offset_weeks` + deliverables), dependencies, warnings,
settings. Its
`dependencies` are every link the project sits at **either** end of, each
carrying `predecessor_name` and `successor_name` so the view needs no second
fetch. `GET /api/portfolio` carries the same list for the whole dataset plus
every V2 warning.

## Schema changes and export versions

No migration framework. `db.migrate()` runs on every `init_db()`:
`ADDED_COLUMNS` first, then `DROPPED_COLUMNS`, each guarded by
`PRAGMA table_info`, then `migrate_dependencies_to_projects()`. Additions before
removals so a file that skipped releases converges on the same shape. Dropping
needs SQLite ≥ 3.35.

The dependency step is the one table-level migration: if the old phase-level
`dependency` table is still there, its rows are lifted to the projects they
linked, links that collapse onto one project are discarded, and the table is
dropped. **Irreversible** — back the file up first.

Export `version` is currently **6**. Bump it when the shape changes and keep
imports tolerant of older files — v2–v5 exports must still import, with absent
fields falling back to defaults and phase-level dependencies translated by
`project_dependencies_from()`. `import_all` is destructive by design and
preserves ids so links survive the round trip; a translated pre-v6 file is the
one case where dependency ids are renumbered, since several phase links can fold
into one project link.

## Views

- **Project** — goal, fields, warnings, unscheduled list, timeline, phase table
  with expandable deliverables (`3/5` tally on the phase row), dependencies. The
  dependency panel lists both directions (`← waits on X`, `→ Y waits on this`)
  and links by picking another project plus a direction.
  The timeline has two modes, switched by `Dates | Weeks`:
  - **Dates** — the calendar grid. Only phases with a start date appear.
  - **Weeks** — `W1, W2, …` counted from the start of the project, no calendar.
    Every phase appears, stacked back to back in `sort_order`; dates on phases
    are ignored, so this view and the calendar can legitimately disagree.
    Offsets come from `validation.relative_layout` as `phase.offset_weeks` on
    the plan payload — derived, never stored, and the pre-image of
    `sequential_layout`: arrange here, then set the project start and lay out.
    Dragging a bar re-sequences phases (writes `sort_order` only, never a date).
  The switch is unpinned per project and defaults to Weeks when nothing in the
  project is scheduled; clicking either button pins it until you change project.
- **Portfolio** — every scheduled phase of `active`/`done` projects on one axis,
  one swimlane per project. Drag a bar to move **only** that phase; snaps to a
  week, `Alt` for single days. No resize. Below the chart, every cross-project
  link as a **list**, V2-marked where violated — not arrows between swimlanes,
  because a link can point at an idea, which has no bar to draw to.
- **Map** — hand-rolled radial SVG, deterministic layout. Department hub → track
  ring → project ring, ideas outermost and dashed. Node radius `sqrt(points)`,
  clamped 16–38px.

Both charts share one week grid: Monday-based columns under a month/week ruler,
window capped at 26 weeks, column width fitted to the container and clamped
22–64px. A week belongs to the month of its Monday.

## Out of scope

Phase 2 (**documented in `PROMPT.md`, do not build**): sprint generation,
`sprint_goal`, allocating deliverables into sprints, capacity adjustments,
delivery forecast. The only concessions already present are `sprint_length_days`
and velocity in settings.

Non-goals (never build): ticket tracking, comments, activity feeds,
notifications, accounts/roles/permissions, external integrations, BI dashboards,
mobile layouts.

## Working style here

- **Usable before pretty.** The UI has had zero design attention on purpose. If
  choosing between a working feature and a better-looking one, ship the working
  one.
- Python is `snake_case`; the JS follows JS convention (camelCase).
- Answer questions before changing code — ask for confirmation before editing.
- Surface architecture tradeoffs as 2–4 named options with one-line pro/con, then
  a recommendation.
- Commit locally as work lands. **Never push or open a PR without approval.**
- Record decisions and open items in `STATUS.md` (gitignored, personal). Requester
  feedback arrives in `comments.md`.
