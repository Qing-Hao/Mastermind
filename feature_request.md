# Feature requests

Gaps found by walking the tool end to end as a product owner would: capture an
idea, cost it, put it on a calendar, run a fortnight against it, come back and
update it. Opened 2026-08-06.

This file is the **backlog of things the tool does not do yet**, with the reason
each one matters and the reason it might not be worth building. It is not a
plan. `comments.md` is requester feedback, `STATUS.md` is the decision log,
`PLAN-*.md` are the working plans behind one feature each.

Every item below is written against the invariants in `CLAUDE.md`. Where a
request has an obvious bad version that would break one, the bad version is
named — that is the part worth keeping.

---

## Priority

| # | Request | Cost | When |
|---|---|---|---|
| FR-1 | Say that sprint task points and phase `effort_points` are one currency | Prose only | **Now** |
| FR-2 | Portfolio-wide warnings, not just V2 | Small | **Now** |
| FR-3 | Overlap check across projects (**not** a points sum) | Small–medium | Sprint 4 |
| FR-4 | Capacity roster — people and their available days | Medium (new table) | Sprint 4, paper until then |
| FR-5 | Velocity learns from delivered history | Medium | After 3 real baselines |
| FR-6 | Slippage memory — has this date moved before? | Large | Deferred |
| FR-7 | Owners at roadmap level | Small | **Recommend not building** |
| FR-8 | A "this fortnight" view | ~600 lines | Already designed — see `PLAN-sprint-view.md` |

---

## FR-1 · One point currency, stated out loud

**What:** Write down, in `templates/sprint.md` and `CLAUDE.md`, that a point on
a sprint task line and a point in `phase.effort_points` are the same unit.

**Why it matters.** Nothing currently says this, and three separate mechanisms
quietly assume it:

- `settings.default_velocity_points_per_sprint` (20) drives every V1 check
  (`app/validation.py:225`).
- The sprint template's baseline row reads *"last 3 sprints — **roadmap** points
  delivered"* (`templates/sprint.md:42`) and divides by person-days.
- The sprint file puts points on task lines under a deliverable heading
  (`templates/sprint.md:65-69`), invented fresh at planning time.

V5 was deleted, so there is no rollup from deliverables to phases and nothing
reconciles the two. If the currencies drift, the baseline is meaningless, V1 is
meaningless, and neither will announce itself — they will just both be quietly
wrong in the same direction.

**The bad version:** re-introducing V5, or putting an estimate field on
deliverables. Rule 4 forbids it and the deletion was right. The fix here is a
stated invariant, not a check.

**Verdict: do it now.** It is the cheapest item on this list and it is the
precondition for FR-3, FR-4 and FR-5 all meaning anything.

---

## FR-2 · Portfolio-wide warnings

**What:** Surface V1/V4/V6/V7 across every project on the Portfolio tab.
`GET /api/portfolio` currently carries only V2.

**Why it matters.** `validate_plan` runs V1, V4, V6 and V7 for **one project**
(`app/validation.py:524`); `validate_portfolio` runs **only V2**
(`app/validation.py:567`). So V6 — described in its own docstring as the rule
that finds late work early, the one that catches a phase a month past its end
inside a project with months still to run (`app/validation.py:334-345`) — can
only be seen by opening each project one at a time.

"What is late across everything" is the first question of the week and the tool
already computes the answer. It just never shows it in one place.

**Cost:** small. The rules exist and are pure; this is an assembly loop in
`main.read_portfolio` plus a list in the view. No schema change, no export bump.

**Note for FR-8:** `PLAN-sprint-view.md` §4.3 deliberately bounds overdue lanes
in the fortnight drawer to projects with work in that window, on the grounds
that *"V6 on the Project tab already does the latter, globally and better."*
That is only true once this item is built. Right now V6 is global in nothing.

**Verdict: do it now.** Highest value per line on the list.

---

## FR-3 · An overlap check across projects

**What:** A rule that reports how much work is running concurrently — *"in the
week of 14 Sep, six phases across five projects are all open."*

**Why it matters.** Portfolio is the step where work is committed to a calendar,
and it is the only step with no reality check in it. You can drop six projects
into the same six weeks and nothing says anything. Sprint planning has a capacity
conversation; roadmap planning has none.

**This corrects an earlier suggestion of mine.** I first framed this as *"sum
`effort_points` per fortnight across projects and compare to velocity."* That is
wrong, and `PLAN-sprint-view.md` invariant 2 already says why: a 55-point
six-week phase does not deliver 18 points in a fortnight, so summing points
across a time window is a points-per-day constant in disguise — the exact
constant the whole capacity design exists to avoid.

**The version that survives the invariant counts phases, not points.** Overlap
is a fact derived from dates already stored; no rate is invented. Whether six at
once is too many is the user's judgement, which is the house style — report,
never repair, never invent a number.

Fits the existing architecture exactly: a pure function beside V2 in
`validate_portfolio`, reported as a warning, repairing nothing.

**Open:** what unit the warning fires on — a threshold in `settings`, or no
threshold at all and just a rendered concurrency count on the Portfolio ruler.
Leaning toward the count with no threshold, because a threshold is a number
nobody has evidence for yet. Decide with FR-4.

**Verdict: sprint 4.** It wants the roster (FR-4) to be worth a threshold.

---

## FR-4 · Capacity config — the roster of people and their available time

**What:** A place in the app to record who is on the team and how much time each
of them has, instead of retyping it into every sprint file.

**Shape:** a `person` table — handle, `days_per_sprint`, active flag — plus a
config surface beside Settings. Not part of any sprint table; this is reference
data about the team, not about a sprint.

**What it feeds:**

1. **The declared table** (`templates/sprint.md:28-32`) — the Person and Days
   available columns are the same rows every fortnight and are currently typed
   fresh each time.
2. **`Person-days normal`** (`templates/sprint.md:44`) — presently a hand-typed
   `20`. With a roster it is derived: the sum of active people's days. Today it
   is a constant that nobody revisits when the team changes size, sitting in the
   denominator of the baseline.
3. **`this sprint`** — the same sum minus leave, once leave is recorded.

**Why it matters beyond convenience.** `default_velocity_points_per_sprint` is a
team-level constant driving V1 across the entire roadmap. When the team changes
size, that constant is wrong and nothing anywhere prompts you to look at it. A
roster makes a team-size change a visible event rather than an invisible one.

### The lines this must not cross

These are the reason to write the request down rather than just build it. Each
has an obvious, tempting, wrong version.

| Do not add | Why |
|---|---|
| `points_per_day`, or points anywhere on a person | The whole capacity design rests on declared points being a **judgement** with coding-days as *evidence, not a multiplier* (`templates/sprint.md:34-36`). A per-person rate is the focus factor coming back in through the roster. |
| `phase.owner_id`, `deliverable.assignee`, any link from a person to work | The moment a person links to a work item this is a tracker, and tracking is a stated non-goal. The roster exists for arithmetic only — see FR-7. |
| Logins, roles, permissions | Non-goal, and pointless: single user, localhost, no auth anywhere in the app. A person is a name string in a table. |
| Deriving velocity from the roster | Velocity comes from **delivered history**, never from headcount. The roster explains why a baseline moved; it does not compute one. See FR-5. |

### Scope trap: holidays and leave

The worked example names them inline — *"Merdeka Mon 31/8; @a on leave 2d"*
(`templates/sprint.md:137`). That is the right amount of structure for now. A
holiday calendar is region-specific, annual, needs maintaining, and interacts
with `sprint_length_days`; it is a table that grows forever to save a sentence.
**Recommend leaving leave and holidays as prose in the sprint file** and letting
the roster carry only steady-state availability.

### Where it lives — options

| Option | Pro | Con |
|---|---|---|
| **A.** Extend the `settings` singleton | No new table | `settings` is one row; people are a list. Does not fit. |
| **B.** New `person` table + config section | Proper home; exports with everything else | Schema change, `migrate()` step, export bump to v10 |
| **C.** Stay on paper, roster block at the top of the sprint template | Free; keeps the paper-first staging decision intact | Retyped each fortnight; `person-days normal` stays hand-typed |
| **D.** A JSON file beside the db | No migration, no export bump | Second storage mechanism; `/api/export` would not carry it |

**Recommendation: C now, B at sprint 4.**

The honest reason is the one this project already committed to: the schema would
be designed against guesses about which columns get filled in. It is not yet
known whether the right field is `days_per_sprint`, an FTE fraction, or days per
week — and for a team of two to four, retyping the roster is under a minute a
fortnight. Running it on paper answers the column question for free, which is
exactly the argument `CLAUDE.md` makes for deferring sprints themselves. Building
a table and an export bump now, to feed a markdown file you fill in by hand,
would abandon that reasoning for the one case where it is most obviously right.

**Worth doing immediately and for free:** add a roster block to the top of
`templates/sprint.md` so `Person-days normal` is arithmetic you can see rather
than a constant you inherited. When B is built, it fills that block in.

Note B is a **table addition**, which is the safe half of `migrate()` — the
guarded `ADDED_COLUMNS` path, nowhere near `migrate_stage_check`. Still back the
data file up under a fresh name first, and not over `data/roadmap.db.bak`.

---

## FR-5 · Velocity learns from delivered history

**What:** Let the sprint baseline inform `default_velocity_points_per_sprint`
instead of the two numbers living separate lives.

**Why it matters.** The setting is 20. In the template's own worked example the
baseline is 11 and the sprint closes at 5 (`templates/sprint.md:136-171`). From
sprint 4 you will have hard evidence that the number driving every V1 check on
the roadmap is optimistic, and `scripts/sprint_review.py` will have computed it
— while the roadmap goes on never learning it.

**The bad version:** writing it back automatically. That crosses the line the
sprint template draws in its own header — *"Nothing here writes back to the
roadmap"* — and it feeds a number back before you trust the number.

**The version worth building:** show the two side by side wherever velocity is
edited, and let the user change it deliberately. The tool points out the
disagreement; the user resolves it. Same shape as V1 itself, which cross-checks
weeks against points and repairs neither.

**Verdict: after three real baselines exist.** Depends on FR-1.

---

## FR-6 · Slippage memory

**What:** Record that a date moved, so "has this slipped before?" is answerable.

**Why it matters.** The tool can tell you a phase is late (V6). It cannot tell
you it is late *for the third time*, because dates are overwritten in place and
nothing remembers. Whether a plan is drifting — and how fast — is the question a
roadmap is supposed to answer and this one currently cannot.

**Cost:** large, and it is a genuine architecture change: a change-log table, a
write path on every date edit, an export bump, and a view. It also brushes up
against "no activity feeds" in the non-goals, though a date-change log is
narrower than a feed.

**Verdict: deferred, and named here so it is deferred deliberately.** This is
the item that would move the tool from *recording a plan* to *telling you
something you did not already know*. Worth revisiting once FR-2 makes late work
visible at all — you may find that seeing it is enough.

---

## FR-7 · Owners at roadmap level

**What:** A name on a phase or project, so Portfolio knows that two projects
scheduled in the same weeks are really one person.

**Verdict: recommend not building.** Listed because it is the obvious next
thought after FR-4 and should be argued with rather than drifted into.

Velocity is a team-level number by design, and the sprint file is where `@owner`
already lives (`templates/sprint.md:69`) — at the task level, for one fortnight,
where an owner is a real commitment rather than a guess months out. An owner on
a phase is a guess months out that then looks authoritative.

It is also the single change that would turn the roster (FR-4) from reference
data into assignment, and the tool into the tracker the brief forbids. If the
overlap problem is real, FR-3 addresses it without naming anybody.

---

## FR-8 · A "this fortnight" view

Already designed in detail — see `PLAN-sprint-view.md` (gitignored). Recorded
here only so the backlog is complete.

The gap it fills: Project is one project, Portfolio is 26 weeks, Map is the whole
department, and nothing answers *"what is in flight right now."* Phases 1–4 of
that plan (~600 lines, read-only) are ungated; the editor is gated at sprint 4.

Two interactions with this file: it assumes FR-2 exists (see the note there), and
its capacity meter is deferred to the editor pane, which is where FR-4 would
surface if B is ever built.

---

## Tab order

Separate from the above and not a gap: the tab bar is
`Project | Portfolio | Map` (`app/static/index.html:13-15`), which runs backwards
along the commitment ladder the tool is actually built on
(`validation.project_stage`). `Map → Project → Portfolio → Sprint` matches it —
ideas are captured on the Map, costed on Project, dated on Portfolio, executed in
a sprint.

Reordering is three lines: tab handling is keyed off element ids, not order
(`app/static/app.js:417-419`, `2466-2474`). Landing tab is a separate decision
and should probably stay on Project.

One thing it exposes: the project `<select>`, `New project` and `Delete` sit in
the global header but only mean anything in Project view. Land on Map first and
that is the first thing you see.
