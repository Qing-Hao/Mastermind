# Getting started

This page takes you from a clean checkout to a roadmap you can read. It assumes
nothing about the tool; if you only want to run it, stop after *Install*.

## Install

Python 3.12 is what the container runs; anything from 3.11 up works locally.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000>.

There is nothing else to configure. The database is created at
`data/roadmap.db` on first start, sign-in is off until somebody arms it, and no
`.env` is needed to run on your own machine. The `.env` file only matters when
you serve the tool to other people — see [admin.md](admin.md).

Confirm the install with the test suite. `requirements-dev.txt` pulls in the
runtime file and adds pytest, which the served image deliberately does not carry:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

> **One warning worth reading before you edit code.** `--reload` restarts the
> app whenever a source file is saved, and every start runs the schema
> migration against `data/roadmap.db`. A half-finished edit to `app/db.py` runs
> the moment it hits disk. Stop the server before touching schema, or point it
> at a copy.

## Your first project, in about fifteen minutes

### 1. Capture the idea

Open the **Map** tab. Under *Future directions*, type a name, optionally a
track (`Source expansion / Metrics` splits into a track and a subtrack), and
press **Capture idea**.

An idea is a real state, not a draft. It stays off the Portfolio, draws as a
dashed circle on the Map, and nothing about it is scheduled. Ideas exist so that
"we might do this" does not have to be written down as a plan.

### 2. Write the goal

Click the project to open the **Project** tab. Fill in **Goal** — free text, your
own north star, never parsed or validated. It is there to be re-read when the
plan starts drifting.

### 3. Add phases

Press **+ Phase** under *Phases, checkpoints & deliverables* and give each phase:

- a **name**,
- a **duration in weeks**,
- an **effort in story points**.

Leave the date empty for now. Weeks and points are entered independently — the
tool never derives one from the other, it compares them. If they disagree by
more than the tolerance (5% by default) at your velocity, **V1** appears in the
warnings banner with both numbers and the delta. It will not correct either one.

### 4. Name the deliverables

Expand a phase with the ▸ beside it and list what that phase produces. A
deliverable is a **planning unit, not a task**: a name, a description and a
`done` tick. No estimate, no dates, no assignee, no history. The phase row shows
the tally (`3/5`) so a folded phase still says how far along it is.

### 5. Add a checkpoint

Press **+ Checkpoint**. A checkpoint (drawn as a ◆ row) is what the plan is
aiming at, and it sits *between* phases rather than inside one. Give it a name
now; the target date is optional and can wait until you commit.

Checkpoints matter more than they look: **reaching every checkpoint is what
finishes a project.** Closing phases does not.

### 6. Promote it

Press **Promote to plan**. The button is disabled until the project has at least
one checkpoint — a direction with nothing to aim at is not yet a plan.

Promotion is a write, never an inference. An idea with a full plan, every phase
dated and every checkpoint ticked still reads as an idea until somebody presses
this button.

### 7. Give it dates

Set the project **Start date** in *Details*, then either type a start date on
each phase or press **Lay out sequentially** in the top bar, which places every
*undated* phase back to back from the project start, in the order you arranged
them. Phases that already have dates keep them.

Nothing invents a date on its own. Layout is user-triggered, and so is every
other placement in the app.

### 8. Read it on the Portfolio

Open **Portfolio**. Every project is one folded bar over its own dates, filled to
how far through it is. Open one with the ▸ beside its name to see its phases and
checkpoints. Drag a phase bar sideways to move that phase — it snaps to a week
column, and <kbd>Alt</kbd> nudges it by single days.

Moving a phase moves *only* that phase. A project that waits on this one starts
warning; it does not shift.

### 9. Link what waits on what

Back on **Project**, under *Dependencies*, pick another project and a direction.
Links run project to project — which whole piece of work has to land before
another can start. Ordering phases inside a project is yours to arrange and
nothing checks it.

Two things can happen:

- The later project already begins before the earlier one finishes → **V2**
  warns on both, and nothing moves.
- The link would close a cycle → the write is **refused** with a `409` naming
  the cycle. This is one of only two refusals in the whole app.

### 10. Export it

**Export** at the foot of the sidebar writes the entire dataset to JSON;
**Import** replaces it. Sign-in configuration is stripped from the export, so an
export is safe to email; the database file is not.

## Where to go next

- [concepts.md](concepts.md) — what each object means, and how a project's
  status is worked out rather than typed in.
- [rules.md](rules.md) — every validation rule, and the two write-time refusals.
- [views.md](views.md) — the four tabs, screen by screen.
- [admin.md](admin.md) — serving it to a team, sign-in, and backups.
