# Roadmap Planner

Lightweight internal tool for planning software delivery from roadmap to phases.
Single user, runs on localhost, all data in one SQLite file.

Scope and rules are specified in [PROMPT.md](PROMPT.md). Sprint generation and
capacity forecasting are deliberately **not** built yet (Phase 2).

## Run

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## Data

Everything lives in `data/roadmap.db` (gitignored). To back up, copy that file,
or use **Export JSON** in the header. **Import JSON** replaces the entire dataset.

## Layout

| Path | Purpose |
|------|---------|
| `app/validation.py` | Rules V1–V4. Pure functions, no I/O. The heart of the tool. |
| `app/db.py` | SQLite schema and CRUD. Rows in and out as plain dicts. |
| `app/main.py` | FastAPI routes. Thin — no business logic. |
| `app/static/` | Vanilla JS frontend, no build step. |
| `tests/` | `test_validation.py` (rules), `test_api.py` (acceptance criteria). |

## Scheduling behaviour

The timeline **never auto-reschedules**. Dates are always the user's to set.
Dependencies produce warnings, not movement, and a plan may sit in a warning
state indefinitely.

The one exception is a dependency **cycle**: that is malformed data rather than
a scheduling opinion, so the API rejects the edit with `409` and writes nothing.

Dependencies run **project to project** — which whole piece of work has to land
before another can start. V2 warns when the later project already begins before
the earlier one finishes, comparing derived spans: a project starts at the
earliest of its own start date and its earliest scheduled phase, and ends at the
latest phase end inside it. Ordering phases within a project is yours to arrange;
nothing checks it.

## Estimation

Two numbers exist per phase and neither derives the other:

| Level | Entered where | Cross-check |
|---|---|---|
| Duration (weeks) | Phase | V1, against points |
| Effort (points) | Phase | V1, against duration |

The phase is the only thing that carries an estimate. A **deliverable** is just a
named entry under a phase — no weeks, no points, no assignee. It says what the
phase produces, and is what converts into a task downstream.

It does carry one tick: **done**, meaning finished rather than still ongoing.
That is the whole of it — no owner, no dates, no history. The phase row shows the
tally (`3/5`) so a collapsed phase still says how far along it is. The tick is
display and record only: it never fires a warning, never sets `phase.status`, and
never moves a date.

Duration (weeks) and effort (points) are entered independently. The tool
cross-checks them rather than deriving one from the other:

```
implied_weeks = (effort_points / velocity) * (sprint_length_days / 7)
```

Velocity is the project's `velocity_override` if set, otherwise the global
setting. V1 warns when entered duration and implied duration disagree by more
than `v1_tolerance_pct` (default 5%).

## Views

**Project** — goal, phases, deliverables, warnings, a timeline for that one
project, and the projects it waits on or is waited on by.

**Portfolio** — every project's phases on one shared time axis with a month
ruler, one swimlane per project. Drag a bar sideways to move that phase; it snaps
to whole days and moves nothing else. Every cross-project link is listed below
the chart, marked where V2 fires.
