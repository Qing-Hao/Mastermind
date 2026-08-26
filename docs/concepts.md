# Concepts

Six objects, and one derived status. Everything else in Mastermind is a view
over these.

## The objects

| Object | Belongs to | Carries | Deliberately does not carry |
|---|---|---|---|
| **Project** | — | Name, description, goal, start date, stage, track, tier, velocity override | Owner, budget, status you type in |
| **Phase** | A project | Name, description, start date, duration in weeks, effort in points, status, order | An end date (it is derived) |
| **Deliverable** | A phase | Name, description, a `done` tick, order | Estimate, dates, assignee, history |
| **Checkpoint** (milestone) | A project | Name, description, optional target date, an `achieved` tick, order | A parent phase |
| **Dependency** | Two projects | Predecessor, successor | Lag, lead, anything but finish-to-start |
| **Settings** | — (one row) | Global velocity, sprint length, V1 tolerance, department name, sign-in configuration | Anything per-person |

### Project

A project is the unit a dependency links and the unit the Portfolio draws as a
swimlane.

- **Goal** — free text, your own north star. Never parsed, never validated,
  never derived from. It exists to be re-read when the plan drifts.
- **Track** — free-text grouping used to cluster the Map. A slash splits it:
  `Source expansion / Metrics` is a track and a subtrack.
- **Tier** — priority, 1 highest. *Untiered* is a state of its own, not a fourth
  tier: it means nobody has ranked this yet. No rule reads it; it exists so the
  Map can be filtered when the roadmap gets crowded.
- **Velocity override** — this project's points-per-sprint, falling back to the
  global setting when empty. Only V1 reads it.

### Phase

A phase is the work, and **the only thing that carries an estimate**.

`end_date` is derived (`start_date + duration_weeks`) and never stored, so a
duration edit cannot leave a stale end date behind.

`phase.status` (`planned` / `in_progress` / `done`) has exactly one job: it feeds
V6 and V7. It does not decide a project's status and never moves a date.

A phase with no start date is **unscheduled** — a real state, not an error. It is
estimated but not yet placed, and it appears in the *Unscheduled* section of the
Project tab and in the Portfolio's *Not placed yet* tray.

### Deliverable

A deliverable names what a phase produces. It is a **planning unit, not a task**:
it is what converts into a ticket in a downstream system once the plan is agreed.

It carries one tick, `done`, meaning finished rather than still ongoing. That
tick is deliberately a boolean and not an enum — the moment it grows intermediate
states, this has become the tracker the tool exists not to be.

The tick is recorded and displayed only. Charts may *draw* it: the phase row
shows `3/5`, and Portfolio and Map fills read it. Nothing *derives* from it — it
fires no rule, never sets `phase.status`, and never moves a date.

### Checkpoint

A checkpoint is what the plan is aiming at, rather than a piece of work somebody
does. It belongs to the project and not to a phase, because a checkpoint
routinely sits between two phases or spans several.

Its `achieved` tick is **the only stored state a derived project status reads**,
and that is the whole reason checkpoints exist. The alternatives were worse:

- Deriving "done" from **dates** would silence V6 — the rule that actually finds
  late work.
- Deriving it from **deliverable ticks** would make those ticks load-bearing,
  and they are meant to stay casual.

An undated checkpoint is normal: name it now, date it when you commit. It simply
draws no diamond on the timeline.

### Dependency

Dependencies link **projects, not phases** — the useful question across a roadmap
is which whole piece of work has to land before another can start. Finish to
start only; no lag, no lead.

This means nothing cross-checks the order of phases *inside* a project. Phases
have a sort order and their own dates, and arranging them is yours to do.

## Estimation

Two numbers per phase, and **neither derives the other**:

```
implied_weeks = (effort_points / velocity) * (sprint_length_days / 7)
```

Velocity is the project's override if set, otherwise the global default. V1
warns when the entered duration and the implied duration disagree by more than
`v1_tolerance_pct` (5% by default).

The tool cross-checks; it does not convert. A points figure never rewrites a
weeks figure, and nothing anywhere sums points across a window — that would be a
points-per-day constant in disguise.

## Project status is worked out, not typed in

There are only **three things you set**. Everything between them is derived from
the plan and today's date, recalculated on every read. Nothing is stored and
nothing is repaired.

| You set | Where | Means |
|---|---|---|
| **Idea** | Stage field | Nobody has committed to this yet |
| **Closed** | Stage field | Finished with — including cancelled or descoped |
| **Checkpoints** | The ◆ rows in the plan | What the project is aiming at |

### An idea stays an idea until you promote it

Dates do not move an idea. Neither do phases, deliverables, or ticked
checkpoints. An idea with a full plan and every checkpoint reached still reads as
an idea, because committing to a direction is a decision the tool cannot infer.

The only way out is **Promote to plan**, which stays disabled until the project
has at least one checkpoint. Promoting is what puts a project on the Portfolio
and makes it schedulable.

### After promotion, the ladder takes over

First match wins, top to bottom:

| Status | When |
|---|---|
| ✅ **Done** | Every checkpoint reached (and there is at least one) — or you closed it by hand |
| 🔴 **Overdue** | Every phase dated, and either the runway has run out with phases still open, or a checkpoint is past its target date and not ticked |
| 🟢 **Active** | Every phase dated, today falls inside the runway |
| 🔵 **Dated** | Every phase dated, not started yet |
| ⚪ **Planning** | No phases, or nothing named under any of them, or no checkpoint yet |
| 🟡 **Planned** | Work named and at least one checkpoint set, waiting only for dates |

**Runway** is the project's span stretched to the last checkpoint it is still
aiming at — unticked and dated. A checkpoint ahead of the last phase end is work
outstanding, so the project stays Active until that date passes; a ticked or
undated one adds nothing.

Four things about that order are worth knowing:

- **Dates outrank the checkpoint gate.** Once every phase has a date, the
  calendar speaks for the project and it reads Dated / Active / Overdue even with
  no checkpoints on it. Checkpoint presence only ever decides between Planning
  and Planned.
- **A late checkpoint needs the project on the calendar first.** It turns a Dated
  or Active project Overdue, but it will not pull a plan still waiting for dates
  out of Planning or Planned — otherwise one date typed early would put the alarm
  on a plan nobody has scheduled. That checkpoint is still reported by V8 and
  still listed on the overdue panel.
- **Closing by hand beats everything.** That is the hatch for cancelled or
  descoped work, which never reaches every checkpoint and would otherwise sit
  Overdue forever.
- **Runway only moves the far end.** A checkpoint months out does not make a
  project that has not started read Active — it stays Dated until its own start
  date arrives.

A project's derived span is not stored either: it starts at the earliest of its
own start date and its earliest scheduled phase, and ends at the latest phase end
inside it. Only the status ladder stretches that end to the runway; the span
itself is what V2 compares and what the timeline draws.

> On a file that predates checkpoints, nothing has any, so every committed
> project reads **Planning** until you add some. That is the gate working, not a
> fault.

## Scheduling behaviour

**The timeline never auto-reschedules.** It is the rule the rest of the design
hangs off:

- Dependencies produce warnings, not movement.
- A drag moves one phase and nothing else.
- **Lay out sequentially** and dropping a project onto the Portfolio are
  user-triggered placements — the action supplies the date; nothing is invented.
- A plan may sit in a warning state indefinitely.

The two exceptions are refusals rather than repairs, and both guard malformed
data instead of expressing a scheduling opinion — see [rules.md](rules.md).

## Sprints

A sprint is one markdown file in `sprints/NN.md`, one per fortnight, copied from
`templates/sprint.md`. **The file is the whole record**: there is no sprint
table, no sidecar store and no roadmap link stored anywhere.

Nothing in the Sprint tab writes to the roadmap. A sprint that overruns is
recorded in the file's Reflection section; phase dates change by hand on the
Project tab or not at all.

Generating sprints from a date range, allocating deliverables into them against
velocity, and forecasting a delivery date are **Phase 2 and not built**.
