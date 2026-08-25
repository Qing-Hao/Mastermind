# Validation rules

Mastermind's rules are the heart of the tool, and they all share one property:
**every rule reports a problem and none of them repairs it.** The timeline never
auto-reschedules, so a plan is allowed to sit in a warning state indefinitely.

Warnings appear in two places: inline on the thing they are about, and in the
warnings banner at the top of the Project tab so you can see every problem at
once. `GET /api/rules` serves the one-line summaries the frontend shows in
tooltips, so there is only ever one copy of this wording.

## The warnings

| Rule | Fires when | Points at |
|---|---|---|
| **V1** | Entered duration and entered effort disagree by more than the tolerance, at the effective velocity | A phase |
| **V2** | A project starts before the project it depends on finishes | Both projects |
| **V4** | A phase starts before its own project does | A phase |
| **V6** | A phase's derived end date has passed and it is not done | A phase |
| **V7** | A phase is closed but names no deliverables | A phase |
| **V8** | A checkpoint is past its target date and is not ticked | A checkpoint |

### V1 — effort and duration disagree

```
implied_weeks   = (effort_points / velocity) * (sprint_length_days / 7)
tolerance_weeks = duration_weeks * (v1_tolerance_pct / 100)
fires when      abs(duration_weeks - implied_weeks) > tolerance_weeks
```

Velocity is the project's override if set, otherwise the global default.
Tolerance defaults to **5%**.

The warning states both numbers and the delta — for example, 55 points at
velocity 20 implies 5.5 weeks against an entered 6 weeks. Neither number is
corrected: they are entered independently on purpose, and the disagreement is
the information.

Skipped when duration is zero or effort implies nothing.

### V2 — dependency order

Compares **derived spans**, not stored dates: the last day of work in the
predecessor against the first day of work in the successor. A project's span
starts at the earliest of its own start date and its earliest scheduled phase,
and ends at the latest phase end inside it.

Skipped while either side has nothing scheduled — work with no date yet cannot be
in the wrong order.

Nothing moves in response. A project that depends on late work starts warning; it
does not slide.

### V4 — phase outside its project

A phase that starts before its project's start date. Skipped while either is
undated.

### V6 — phase overdue

The phase's derived end (`start_date + duration_weeks`) has passed and its status
is not `done`.

This is the rule that finds late work early. The project-level *Overdue* status
only appears once the **last** phase end has passed, which is far too coarse — a
phase can sit a month past its end inside a project that still has months to run.

Skipped while the phase is unscheduled, and skipped once it is done: a phase that
finished late is not a problem to fix.

### V7 — closed with nothing delivered

A phase marked `done` that names no deliverables at all. Closing a phase without
recording what it produced leaves nothing worth reading later.

It checks deliverable **presence**, deliberately not the `done` tick. A phase
closed with every deliverable under it still unticked passes this rule.

### V8 — checkpoint overdue

A checkpoint past its target date and not ticked. V6's counterpart for the other
dated thing on a plan, and it matters because checkpoints are what finish a
project — the one object carrying that decision should not sit weeks past its
date in silence.

Skipped while undated, and skipped once achieved.

The project-level *Overdue* status reads this rule too, on a project whose phases
are all dated — so a blown checkpoint colours the project even while its phases
have weeks left to run. On a project still waiting for dates the rung does not
move; the warning and `/api/late` are where that one shows up.

## The gaps: V3 and V5

Rule numbers are **never reused**. A gap means the rule was deleted or moved, not
that it is dormant — look in `git log`.

- **V3 is not a warning.** It is a dependency cycle, and it refuses the write
  that would create one. See below.
- **V5 is deleted.** It cross-checked a bottom-up rollup of deliverable estimates
  against the phase's own estimate. Deliverables no longer carry estimates, so
  there is nothing to roll up and the phase estimate stands alone.

## What refuses a write

Everything above reports something bad about a good plan. These refuse to store a
broken one — a different thing, and the reason they are allowed to exist at all.
Write-time refusals are for **malformed data only, never for scheduling
opinions**.

### V3 — dependency cycle (`409`)

Creating a dependency that would close a cycle is rejected, with an error naming
the cycle, and nothing is written. A project depending on itself is a cycle of
length one.

### A sprint overlapping one already on disk (`409`)

One team runs one sprint at a time, so a fortnight overlapping an existing sprint
file is malformed rather than a scheduling opinion. Nothing is created.

Two related refusals guard the files themselves:

- A sprint file that already exists is never overwritten (`409`).
- Saving a sprint whose file changed on disk since you opened it is refused with
  the disk's timestamp (`409`), never merged. `scripts/sprint_review.py` reads
  these files and people edit them by hand, so the app is not entitled to decide
  whose version wins.

## Two people editing one thing

Not a rule, but the same philosophy. A row edit carries what the writer believed
was stored. If any of those fields moved in the meantime, the write is refused
with a `409` **naming the field that changed**, and nothing is saved. There is no
silent overwrite and no merge.

Separately, while somebody is typing in a field, the other open pages draw a
badge showing who. That is presence, not a lock: nothing on the write path
consults it, and anybody can still type and still save.

## Readouts are not notifications

The bell in the top bar counts what is past its date and what is finished but
still open, across every committed project. Both lists are derived on read from
rows already on the plan.

Nothing about it is stored — no dismissal, no snooze, no "new since you last
looked", no per-person mute. Everyone sees the same list. The test before adding
anything to it: **does this need to remember who is looking?** If yes, it does
not belong here.
