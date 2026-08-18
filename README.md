# Mastermind

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
or use **Export** at the foot of the sidebar. **Import** replaces the entire
dataset.

## Layout

| Path | Purpose |
|------|---------|
| `app/validation.py` | Rules V1–V4, V6, V7 and the derived project status. Pure functions, no I/O. The heart of the tool. |
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

## Project status

A project's status is **worked out, not typed in**. There are only three things
you set; everything else is derived from the plan and today's date, and is
recalculated every time the project is read. Nothing is stored and nothing is
repaired.

The three you set:

| You set | Where | What it means |
|---|---|---|
| Idea | Stage field | Nobody has committed to this yet |
| Closed | Stage field | Finished with — including cancelled or descoped |
| Checkpoints | Milestone list | What the project is aiming at |

### An idea stays an idea until you promote it

**Dates do not move an idea.** Neither do phases, deliverables or ticked
checkpoints. An idea with a full plan and every checkpoint reached still reads
as an idea, because committing to a direction is a decision rather than
something the tool can infer.

The only way out is the **Promote to plan** button on the project. It stays
disabled until the project has **at least one checkpoint** — a plan with nothing
to aim at is not yet a plan. Promoting is what puts the project on the Portfolio
and makes it schedulable.

### After promotion, the ladder takes over

First match wins, top to bottom:

| Status | When |
|---|---|
| ✅ **Done** | Every checkpoint reached (and there is at least one) — or you closed it by hand |
| 🔴 **Overdue** | Every phase dated, the last phase end has passed, phases still open |
| 🟢 **Active** | Every phase dated, today falls inside the project |
| 🔵 **Dated** | Every phase dated, not started yet |
| ⚪ **Planning** | No phases, nothing named under them, or no checkpoint yet |
| 🟡 **Planned** | Work named and at least one checkpoint set, waiting only for dates |

Two things about the order are worth knowing:

- **Dates outrank the checkpoint gate.** Once every phase has a date, the
  calendar speaks for the project and it reads Dated / Active / Overdue even
  with no checkpoints on it. Checkpoint presence only ever decides between
  Planning and Planned.
- **Closing by hand beats everything.** That is the hatch for work that is
  cancelled or descoped, which never reaches every checkpoint and would
  otherwise sit Overdue forever.

### Why checkpoints and not something else

A checkpoint is the only thing here designed to carry the completion decision.
Deriving "done" from **dates** would silence the overdue warnings, which are what
actually find late work. Deriving it from **deliverable ticks** would make those
ticks load-bearing, and they are meant to stay casual — no estimate, no dates, no
history.

So finishing a project means reaching what it set out to reach, and you say so by
ticking checkpoints. The Map colours a project **green** only when every
checkpoint is reached; a project you closed by hand with checkpoints outstanding
stays grey, because painting cancelled work as a success is worse than leaving it
uncoloured.

**On an existing file, nothing has checkpoints yet, so every committed project
reads Planning until you add some.** That is the gate working, not a fault.

## Views

**Project** — goal, phases, deliverables, warnings, a timeline for that one
project, the checkpoints it is aiming at, and the projects it waits on or is
waited on by.

**Portfolio** — every project's phases on one shared time axis with a month
ruler, one swimlane per project. Drag a bar sideways to move that phase; it snaps
to whole days and moves nothing else. Every cross-project link is listed below
the chart, marked where V2 fires.
