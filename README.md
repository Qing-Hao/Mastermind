# Mastermind

Mastermind is a lightweight internal planning tool. It takes a piece of work
from a one-line idea, through phases and deliverables, onto a dated timeline
that several people can read at once — and stops there, deliberately. It is not
a ticket tracker and does not try to become one.

Everything lives in one SQLite file. There is no build step, no ORM and no
framework in the way: FastAPI, `sqlite3` and vanilla JavaScript.

## What it is for

Planning happens before anyone commits to a date, and most tools make you commit
first. Mastermind is built around the opposite order:

- **Capture an idea** without pretending it is scheduled.
- **Estimate it** in weeks and in story points, entered independently so the two
  numbers can be compared instead of one deriving the other.
- **Name what it produces** — deliverables are planning units, not tasks.
- **Decide what it is aiming at** — checkpoints are what finish a project.
- **Place it on a timeline** only when you are ready, and see it beside every
  other project on one shared time axis.
- **Be told when the plan disagrees with itself**, and fix it yourself.

The single rule the whole tool is built on: **the timeline never
auto-reschedules**. Dates belong to the person planning. Every rule reports a
problem; nothing repairs one. A plan is allowed to sit in a warning state
forever.

### What it deliberately is not

No tickets, no comments, no activity feed, no notifications, no assignees, no
accounts or roles, no external integrations, no BI dashboards. Sign-in exists,
but it is a gate rather than an account model — the app asks Keycloak "is this
you" and stores nothing about the answer.

Sprint generation from a project's date range, allocating deliverables into
sprints against velocity, and a delivery forecast are **not built** (they are
Phase 2 in [PROMPT.md](PROMPT.md)).

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000>. The database is created on first start at
`data/roadmap.db`.

Tests (`requirements-dev.txt` adds pytest on top of the runtime install above —
the served image carries only the runtime file):

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

To serve it to a team instead of to one machine, use Docker Compose and arm
sign-in before you open the port — see [docs/admin.md](docs/admin.md).

## The four views

| View | What it answers |
|---|---|
| **Map** | Where is the team pointed? Department at the centre, tracks around it, projects on the outside, sized by effort. |
| **Project** | What is this one project, in detail? Goal, phases, checkpoints, deliverables, warnings, dependencies. |
| **Portfolio** | When does everything land? Every project's phases on one shared week ruler; drag a bar to move a phase. |
| **Sprint** | What are we doing this fortnight? One markdown file per sprint, edited in place. |

## Basic workflows

**Plan a new piece of work, from nothing to a date**

1. **Map → Future directions** — capture the idea with a name and a track.
   Nothing is scheduled yet, and ideas stay off the portfolio.
2. **Project** — open it, write the **goal**, then add **phases**: a name, a
   duration in weeks and an effort in story points. Weeks and points are entered
   independently; V1 warns if they disagree at your velocity.
3. Expand a phase and list its **deliverables** — what the phase produces. They
   carry no estimate and no dates, just a name and a `done` tick.
4. Add at least one **checkpoint** (a ◆ row between phases) — what the plan is
   aiming at.
5. Press **Promote to plan**. That button is disabled until a checkpoint exists,
   and promotion is a deliberate write: an idea never becomes a plan by itself.
6. Set the project **start date**, then either date each phase by hand or press
   **Lay out sequentially** to place every undated phase back to back.
7. **Portfolio** — see it beside everything else. Drag a phase bar to move that
   one phase; nothing else moves in response.

**Say that one project waits on another**

On the **Project** tab, under Dependencies, pick the other project and a
direction. Links run project to project. If the later project already starts
before the earlier one finishes, V2 warns on both — it does not move anything. A
link that would create a cycle is refused outright with a `409` naming the
cycle.

**Check what is slipping**

The bell in the top bar counts two things across every committed project: what
is past its date, and what is finished but still open. It is derived on every
read and nothing about it is stored — no dismissals, no "new since you looked".

**Run a fortnight**

On **Portfolio**, click a week number on the ruler to read that fortnight day by
day, then press *Plan this fortnight →*. That copies `templates/sprint.md` to
the next `sprints/NN.md` and opens it on the **Sprint** tab, where the file is
edited in place as a document. The markdown file is the only record — there is
no sprint table. Nothing in the Sprint tab writes back to the roadmap.

**Back up, or move the data somewhere else**

**Export** at the foot of the sidebar writes the whole dataset to JSON;
**Import** replaces it. Sign-in configuration is stripped from the export. Every
start also copies the database to `data/backups/`, keeping the last ten.

## Documentation

| Read | For |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Install, first project, the 15-minute path |
| [docs/concepts.md](docs/concepts.md) | Projects, phases, deliverables, checkpoints, dependencies, and how project status is derived |
| [docs/rules.md](docs/rules.md) | The validation rules V1–V8, and what refuses a write |
| [docs/views.md](docs/views.md) | Map, Project, Portfolio and Sprint, screen by screen |
| [docs/admin.md](docs/admin.md) | Docker, the Keycloak gate, backup, export/import, recovery |
| [PROMPT.md](PROMPT.md) | The original brief and its amendments — what was asked for |
| [CLAUDE.md](CLAUDE.md) | Where code goes and how to work in this repo |
