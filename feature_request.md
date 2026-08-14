# Feature requests

Gaps found by walking the tool end to end as a product owner would: capture an
idea, cost it, put it on a calendar, run a fortnight against it, come back and
update it. Opened 2026-08-06.

**FR-9 to FR-14 were the requester's own, from `comments.md` on 2026-08-13** —
six items written after using the tool rather than after reading it, which is
why every one of them is about a gesture rather than a rule. FR-16 to FR-18
arrived the same way on 2026-08-14. Each names the comment it came from.

This file is the **backlog of things the tool does not do yet**, with the reason
each one matters and the reason it might not be worth building. It is not a
plan. `comments.md` is requester feedback, `STATUS.md` is the decision log,
`PLAN-*.md` are the working plans behind one feature each.

**A built item is deleted from this file, not marked built.** The commits and
`STATUS.md` are the record of what shipped and why; a backlog that also carries
it stops being a list of what is left and becomes a second, staler history. The
numbers are never reused, so a gap in the sequence means built — look for it in
`git log` and `STATUS.md`. **Won't-build items stay**, because nothing was
committed for them: the argument against building is the whole artefact, and
deleting it invites the idea back in six months. Built so far and gone from
here: FR-8, FR-9, FR-10, FR-14, FR-15, FR-17.

Every item below is written against the invariants in `CLAUDE.md`. Where a
request has an obvious bad version that would break one, the bad version is
named — that is the part worth keeping.

---

## Priority

Priority is one letter on the end of every heading below, worked out from three
things and nothing else:

- **Complexity** — what it costs to build, including the risk it carries.
- **Frequency** — how often the thing it fixes is actually touched.
- **Impact** — how much worse the tool is without it.

**P1** next up · **P2** soon after · **P3** blocked on evidence or a decision,
not on effort · **Won't build**.

Frequency does most of the ranking. A one-line tooltip on a control you hover
forty times a week outranks a rule you would read once a sprint, and that is
why FR-13 sits above FR-12.

| # | Request | Complexity | Frequency | Impact | Priority |
|---|---|---|---|---|---|
| FR-16 | Phase status never updates itself | Medium | High | High | **P1** — one decision first |
| FR-18 | A table cell is one line, and a trailing table is a dead end | Small | High | High | **P1** |
| FR-13 | Project span on the portfolio swimlane title | Tiny | High | Medium | **P1** |
| FR-1 | Say that sprint task points and phase `effort_points` are one currency | Prose only | — | High | **P1** |
| FR-2 | Portfolio-wide warnings, not just V2 | Small | High | High | **P1** |
| FR-11 | Project picker belongs to the Project tab | Medium | High | Medium | **P2** |
| FR-12 | Show the date you are dropping on, while dragging | Small | High | Medium | **P2** |
| FR-3 | Overlap check across projects (**not** a points sum) | Small–medium | Low | Medium | **P3** — sprint 4 |
| FR-4 | Capacity roster — people and their available days | Medium (new table) | Fortnightly | Medium | **P3** — paper until sprint 4 |
| FR-5 | Velocity learns from delivered history | Medium | Rare | Medium | **P3** — needs 3 baselines |
| FR-6 | Slippage memory — has this date moved before? | Large | Low | High | **P3** — deferred deliberately |
| FR-7 | Owners at roadmap level | Small | — | Negative | **Won't build** |

FR-16 is **P1 with a block on it**, which the letters above would normally call
P3. The difference is that its block is a single question put to the requester
in the same pass that raised it, not a wait on evidence that does not exist yet
— the shape FR-14 had, which went from blocked to built the day an option was
picked. FR-17 had the same kind of block and went the same way: bounded depth
or unbounded rings was a question, it was answered, and it shipped the same day.

---

## Dependencies, and what can run in parallel

Written so several of these can be developed at once in separate worktrees.
**No item below needs a schema change** — no table, no column, no `migrate()`
step, no export bump — so the usual `--reload` migration hazard does not apply
to any of this work. FR-4's option B is the one exception, and it is deferred.

### What actually blocks what

Only two real dependencies exist among the near-term items. Everything else is
independent.

```
FR-13 ──> FR-2        both edit main.read_portfolio; do FR-13 first, it is smaller
FR-11 ──> tab reorder same change, same files, one commit
FR-16 ──> a decision  option A/B/C/D, not code
```

- **FR-13 before FR-2.** `read_portfolio` returns `projects` straight from
  `db.list_projects` with no span, so FR-13 has to attach one. FR-2's
  portfolio-wide warnings assemble in the same function. Two branches editing
  that return dict is the one merge conflict worth avoiding — keep them in one
  worktree, in that order.
- **FR-12 and FR-16 depend on nothing.** Both can start today, FR-16 once its
  option is picked.
- **FR-11 depends on nothing either, but it moves DOM other branches render
  into** — see the merge order below.
- **FR-18 depends on nothing.** It is the only item left that touches
  `markdown.py` or `editor.js`, so it is safe to run alongside B and E.
- **FR-17 is built** (tree F), and its one merge-relevant leftover is that it
  rewrote the map block of `app.js` — roughly 1830–2330 — and replaced
  `.map-track`/`.map-subtrack` with `.map-group.level-N` in `style.css`. Nothing
  else on this list touches either region.

### Where each one lands

| FR | Python | `app.js` | `index.html` | `style.css` | Tests |
|---|---|---|---|---|---|
| FR-11 | — | 463–473, 2933–2947 | **header, 10–26** | header | — |
| FR-12 | — | 1270–1470 (drags) | — | new pill class | — |
| FR-13 | `main.read_portfolio` | 1202–1216 (lanes) | — | — | `test_api.py` |
| FR-16 | `validation`, `main` | ~890–935 (phase row) | phase table head | phase status | both suites |
| FR-18 | `markdown.py:363–365` | — | — | `.sprint-cell` | `test_markdown.py` |

FR-18's frontend is `editor.js`, not `app.js` — 940 (`cellText`), 992–1038
(`sprintCell`), 442–452 (the `Enter` that opens the next block). It is the only
item on this list that lands there, which is why the column above says nothing.

One property worth noticing: **`style.css` gets touched by most of these, in
disjoint regions.** Git merges that fine as long as nobody reflows the file. Do
not reorder or reformat blocks you are not changing. The `[hidden]` trap — a
class setting `display` outranks the UA sheet — has now cost five separate
features; check it before adding any new hideable element.

### Suggested worktrees

| Tree | Items, in order | Why they belong together |
|---|---|---|
| **B · portfolio** | FR-13, then FR-12, then FR-2 | All in the portfolio view; FR-13 and FR-2 share `read_portfolio`. The only tree that runs the test suite. |
| **E · status** | FR-16 | `validation.py` + the phase row. Touches the same payload FR-13 does but a different function, and it is the only live item with a rule-shaped decision in it. |
| **F · map** | ~~FR-17~~ | **Built.** Left `scripts/map_sweep.js` behind — the map has no test suite, and that is now its verification. |
| **G · editor** | FR-18 | `markdown.py` + `editor.js`. Disjoint from everything: no other live item touches either file. Runs the `test_markdown.py` round trip. |
| **D · shell** | FR-11 + tab reorder | Held back — see below. |

B, E and G are near-disjoint and can all run at the same time. G shares no file
with any other tree — it is not in `app.js` at all.

**A map tree needs the real database, and more than the others do.** Its whole
verification is what the map looks like at this dataset's shape — 8 tracks, one
already three deep — so a fresh worktree's empty `data/` makes the work
unverifiable rather than merely dull. Copy the file in first, then point
`scripts/map_sweep.js` at the server in front of it.

**D goes last, alone.** Not because it conflicts textually — the header is its
own region — but because it moves the project picker out of the global header
into the Project view and reorders the tabs. Every other branch renders into a
page whose shape it changes, and `#empty-state`, `loadProjectList` and the badge
refresh in `loadPlan` all get touched. Rebasing several branches onto a moved
header is worse than rebasing one moved header onto merged branches.

### Running several worktrees at once — two practical traps

- **`data/` and `sprints/` are gitignored, so a fresh worktree has neither.**
  A new tree comes up with an empty database and no sprint files, which makes
  the map, the portfolio and the Sprint tab all look broken when they are not.
  Copy `data/roadmap.db` and `sprints/` into each tree. Copy — do not point two
  servers at the one file.
- **One port per tree.** `--port 8000`, `8001`, `8002`. Two `--reload` servers on
  one port fail in a way that looks like a code error.

---

## FR-1 · One point currency, stated out loud — **P1**

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

## FR-2 · Portfolio-wide warnings — **P1**

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

**Interaction with the fortnight drawer:** `validation.fortnight_slice`
deliberately bounds overdue lanes to projects with work in that window, on the
grounds that *"V6 on the Project tab already does the latter, globally and
better."* That is only true once this item is built. Right now V6 is global in
nothing.

**Interaction with FR-16:** the two are the same complaint from opposite ends.
FR-16 makes a phase say where it stands; this makes the whole portfolio say it
at once. Neither needs the other, and doing FR-16 first would make this list
read against a status people actually maintain.

**Verdict: do it now.** Highest value per line on the list.

---

## FR-3 · An overlap check across projects — **P3**

**What:** A rule that reports how much work is running concurrently — *"in the
week of 14 Sep, six phases across five projects are all open."*

**Why it matters.** Portfolio is the step where work is committed to a calendar,
and it is the only step with no reality check in it. You can drop six projects
into the same six weeks and nothing says anything. Sprint planning has a capacity
conversation; roadmap planning has none.

**This corrects an earlier suggestion of mine.** I first framed this as *"sum
`effort_points` per fortnight across projects and compare to velocity."* That is
wrong, and the fortnight view's invariant 2 already says why — it is now in
`CLAUDE.md` as *"the fortnight drawer never sums points across its window"*: a 55-point
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

## FR-4 · Capacity config — the roster of people and their available time — **P3**

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

## FR-5 · Velocity learns from delivered history — **P3**

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

## FR-6 · Slippage memory — **P3**

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

## FR-7 · Owners at roadmap level — **Won't build**

**What:** A name on a phase or project, so Portfolio knows that two projects
scheduled in the same weeks are really one person.

**Verdict: recommend not building.** Listed because it is the obvious next
thought after FR-4 and should be argued with rather than drifted into. It stays
in this file for exactly that reason: no commit records a decision not to build,
so this entry is the only record there is.

Velocity is a team-level number by design, and the sprint file is where `@owner`
already lives (`templates/sprint.md:69`) — at the task level, for one fortnight,
where an owner is a real commitment rather than a guess months out. An owner on
a phase is a guess months out that then looks authoritative.

It is also the single change that would turn the roster (FR-4) from reference
data into assignment, and the tool into the tracker the brief forbids. If the
overlap problem is real, FR-3 addresses it without naming anybody.

---

## FR-11 · The project picker belongs to the Project tab — **P2**

*From `comments.md` #3 on 2026-08-13. It confirms the **Tab order** note at the
foot of this file, which called this out as an observation; it is now a request.*

**What:** move the project `<select>` (and `Delete`) out of the global header
into the Project view. `New project` stays where it is, but clicking it switches
to the Project tab and lands on the project it just made.

**Why it matters.** Three of the four tabs ignore the picker. On Portfolio, Map
and Sprint it is a control that changes nothing you can see — and on Map and
Sprint it actively misleads, because both of those look like views that *should*
be scopeable to a project and neither is.

**Careful bits, none of them hard but all of them easy to miss:**

- `loadPlan` re-reads `/api/projects` after every edit so the option's badge
  retags immediately (`CLAUDE.md`, *Picker*). Moving the element must not break
  that refresh, and `refreshTrackPickers` runs inside `loadProjectList` too.
- `#empty-state` is currently the top-level stand-in for "no project selected".
  Once the picker lives inside the Project view, that message belongs inside it.
- `Delete` is destructive and currently sits beside `Export`/`Import`, which is
  the wrong neighbourhood for it anyway. **Recommend it moves with the picker** —
  it deletes the project the picker names, so it belongs beside it.

**Do it in the same pass as the tab reorder** (`Map → Project → Portfolio →
Sprint`, see below). Both edit the header, both are small, and the reorder is the
thing that makes the picker's placement obviously wrong — land on Map first and
a project selector is the first thing you see.

**Cost:** medium-small. `index.html` markup, the tab-switch wiring in `app.js`
(keyed off element ids, not order), and CSS for the relocated row.

---

## FR-12 · Show the date you are dropping on, while dragging — **P2**

*From `comments.md` #4 on 2026-08-13.*

**What:** a date readout that is legible during the drag, not just present in
the DOM.

**The precise complaint, because the feature half-exists.** A dragged bar's own
label becomes `Discovery → 2026-09-14` (`app/static/app.js:1451-1453`) and the
tray ghost does the same (`app.js:1306`). But the readout lives *inside the bar*,
and a bar is exactly as wide as its phase: at the 22px/week floor a two-week bar
is 44px, so the text is clipped to nothing in precisely the case where you need
it. Alt-drag then moves the thing by one day — a few pixels — so the visual
feedback for the gesture that most needs a date is the smallest.

**What to build:** a floating pill pinned to the cursor carrying the new start
date, updated in the two `onMove` handlers that already compute it. Show the
day-of-week too when `Alt` is held, since landing off a Monday is the entire
reason to hold it.

**The bad version:** widening or restyling the in-bar label — still clipped — or
a `title` tooltip, which never fires during a drag.

**A second option worth naming:** highlight the target column on the ruler and
put the date there. The ruler already draws per-week cells with titles
(`app.js:290`) and the fortnight slice already draws day columns (`app.js:1565`),
so the idiom exists. It reads better for week snaps and worse for Alt days, where
the column is one day wide. **Recommend the cursor pill**, optionally with the
column highlight alongside it.

**Cost:** small — one absolutely-positioned element and two existing handlers.

---

## FR-13 · Project span on the portfolio swimlane title — **P1**

*From `comments.md` #5 on 2026-08-13.*

**What:** hovering a swimlane's project name says when that project starts and
ends, the way hovering its bars already says when each phase does.

**Why it matters.** `lane-title` is plain text (`app/static/app.js:1207`) sitting
directly beside bars that each carry a full `title` (`app.js:1211`). So the
per-phase dates are one hover away and the project's own dates — the question the
Portfolio tab exists to answer — are not available anywhere on the chart.

**The one trap:** a lane only draws the phases visible in the current window
(`app.js:1195`). The tooltip must report the project's **real** span, not the
window's slice, or the same lane will claim different dates depending on where
the chart is scrolled.

**The bad version:** deriving the span in the frontend from the visible bars —
which is exactly how you would fall into that trap. `validation.project_span`
already derives it, and derivation lives in `validation.py`.

**Content:** `Name — 2026-09-01 → 2026-12-12 · 6 phases · 55 pts`, plus the
derived stage, matching the tray chip's existing multi-line `title`
(`app.js:1249`).

**Cost:** tiny if `GET /api/portfolio` already carries enough per project; small
if `read_portfolio` needs to attach a span from the existing pure function. No
schema change, no export bump. **The cheapest item on this list with daily
value**, which is what puts it in P1 ahead of FR-12.

---

## FR-16 · Phase status never updates itself — **P1, one decision first**

*From `comments.md` #1 on 2026-08-14: "it seems like the current status of
project is not automatic update yet. Previously i already give you how it should
behave, there should be a gap to implement that."*

**What is already automatic, so that the gap can be stated precisely.**
`validation.project_stage` derives the whole ladder on every read, and the picker
badge, the map node styling and the portfolio ordering all follow it
(`STATUS.md` item 54). A project that starts next Monday reads `dated` today and
`active` on the day, with nobody editing a field. That half is built and it
works.

**What is not automatic is one rung below: `phase.status`.** It is a stored
three-value enum (`planned | in_progress | done`) edited by hand from a `<select>`
on the phase row (`app/static/app.js:921-931`), and **nothing anywhere derives,
ages or prompts for it.** Measured against `data/roadmap.db` on 2026-08-14:

| | |
|---|---|
| phases at `planned` | **29 of 30** |
| phases at `done` | 1 |
| phases at `in_progress` | **0** |
| dated phases whose window contains today, still `planned` | 6 |
| dated phases past their end and not `done` | 2 |

`in_progress` has never been used once, on any phase, ever. Six phases are
running right now and all six of them say `planned`.

**Why that reads as "the project status does not update".** The ladder's `done`
rung derives from `all(phase.status == 'done')` — chosen deliberately over
deriving from deliverable ticks (`STATUS.md` item 54) precisely so that closing
phases is what completes a project. With phase status unmaintained that rung is
**unreachable**: no project can ever finish itself, and every dated project
walks `dated → active → overdue` and stops there. **The only exit is the manual
close**, which the data model defines as *"not delivered but closed without
finishing"* — so the one way to finish a project today is through the hatch
built for cancelled work. That is the gap, and it is a real one.

### The trap that decides the shape

**Deriving `done` from dates kills V6.** V6 fires when a phase's derived end has
passed and `status != done`; `CLAUDE.md` calls it *the rule that actually finds
late work*, and it is the only rule that found anything on the real file. If a
phase past its end auto-reads `done`, V6 can never fire again and the roadmap
becomes a document in which everything delivered on time. V7 goes the same way,
and the `done` rung of the ladder stops meaning anything either.

So **`done` stays a human fact.** What *can* be derived is where a phase sits
against the calendar, which is a calendar fact — the same line the project
ladder already draws between what you say and what is worked out.

### Options

| Option | Pro | Con |
|---|---|---|
| **A.** Derive the phase's calendar position (`upcoming / running / overdue`), keep `done` stored and manual. The row's only editable status control becomes a done tick. | One vocabulary with the project ladder; nothing new stored; V6, V7 and the `done` rung untouched; `planned`/`in_progress` stop being fields nobody maintains | Loses "should have started, has not" — the calendar reads a dated phase as running whether or not anyone began it |
| **B.** Keep the select, print the derived position beside it | Cheapest; no field changes meaning | Two axes disagreeing about one phase — exactly the `project_readiness` mistake item 54 removed. Do not repeat it |
| **C.** Derive only when the stored value is the untouched default `planned`; a stored `in_progress` or `done` wins | No signal lost; a deliberate edit is honoured | `planned` silently comes to mean "unset", a hidden convention; and it becomes unsayable for a phase deliberately not started |
| **D.** Derive nothing. Make closing a phase cheap where you already are — a done tick on the phase row, and an action on the V6 warning that already names it | No new derivation, no invariant anywhere near it; attacks the actual cause, which is that 29 of 30 at the default is a bookkeeping-cost problem | Still manual; a phase nobody visits still never closes |

**Recommendation: A for the calendar half, with D alongside it.** A is a pure
function next to `project_stage`, surfaced as `derived_status` on the phase
payload the way `with_derived_stage` already tags projects — never stored, never
written back. The phase row's editable control shrinks to a single `done` tick,
which is the one fact only you hold and the fact V6, V7 and the `done` rung all
read. D is what makes that tick actually get used.

**Take C instead if `in_progress` is worth keeping as a deliberate signal** —
that is the one thing A gives up, and it is your call, not mine. **B is the one
to avoid**: it re-creates the two-axis disagreement this project already removed
once, at the cost of a week of confusion.

### If the request is instead about the Stage field

If what "not automatic" means is that the Project tab's **Stage** dropdown
should change by itself — start saying `active`, then `overdue` — that is a
deliberate refusal and stays one. `main.with_derived_stage` tags projects with
`derived_stage` *alongside* the stored `stage` and never overwrites it, because
the portfolio filters on the stored value and a form round trip echoes it back;
writing a derived value into the column would let today's date silently edit your
data. The derived rung is already on screen as the picker badge. What the Project
tab does not do is say it **in words, in the view that owns the project** — that
is four lines beside the Stage field and worth taking whichever option wins
above.

**Cost:** ~25 lines of pure function in `validation.py`, a tag on the phase
payload in `main.py`, the phase row and the fortnight lane in the frontend, plus
tests in both suites. **No schema change and no export bump** — `phase.status`
keeps its column and its CHECK, and no stored value changes, so nothing in
`data/roadmap.db` needs migrating.

**One thing to check rather than assume:** the fortnight lane already carries
`status` (`validation.py:755`) and bands an overdue lane off `status == 'done'`
(`validation.py:717-720`). Under A both keep reading the stored `done` and the
drawer is untouched — verify that before writing the frontend, not after.

---

## FR-18 · A table cell is one line, and a trailing table is a dead end — **P1**

*From `comments.md` #3 on 2026-08-14: "Table cannot go next line, and i cant
implement list or todo list renderer (- or []). It will be helpful to have that."*

Three separate things, and separating them is most of the value here: one is a
**dead end**, one is a **limitation**, and one is **forbidden by GFM itself**.

### 1 · A cell cannot hold a second line — a limitation

`sprintCell` builds an `<input type="text">` (`app/static/editor.js:992-996`),
which has no newline to give. And `_escape_cell` **replaces `\n` and `\r` with a
space** on the way to the file (`app/markdown.py:363-365`, docstring: *"One
line"*), so even a pasted multi-line value flattens rather than erroring.

### 2 · A table cannot open the block after it — a dead end

`insertSprintBlockAfter` is reachable from exactly one place: the raw textarea's
`Enter` handler (`editor.js:442-452`), whose own comment says *"this is what
makes the insert menu reachable at all — nothing else in the editor makes one."*
A table has no textarea — *"the cells are the editor"* (`editor.js:355-357`) — so
`Enter` in a cell does nothing at all and `Tab` off the last cell **grows a row**
rather than leaving the table. The empty-file placeholder only appears at
`blocks.length === 0` (`editor.js:369`).

**So a sprint file that ends with a table has no gesture anywhere that adds a
block after it.** The only way out is `Raw file` and typing below it. This is the
most literal reading of "cannot go next line", it affects the block type the
editor was built for, and it is a dead end rather than a rough edge — which is
what puts this item in P1 next to FR-16.

### 3 · A list or a checkbox inside a cell is not markdown

GFM has no block content in a table cell — a cell is inline only — so `- item`
and `- [ ]` inside a cell are literal text in **every** renderer, not just this
one; markdown-it's tasklists plugin only ever rewrites list items.

Worth being precise, because the request reads as if the editor lacks lists and
it does not: the insert menu carries both `Task list` and `Bullet list`
(`editor.js:752-753`), and ticking a `- [ ]` is wired through
`toggleSprintTask`. What cannot be done is putting either **inside a table**.

### Options for 1

| Option | Pro | Con |
|---|---|---|
| **A.** `\n` ↔ `<br>`, symmetric with the pipe: `_escape_cell` writes `<br>`, `cellText` reads it back; cell becomes a `<textarea>` | One line changed in each direction, in the two places that already do exactly this for `\|`; `html=True` is on and the template already leans on `<u>` and `<details>`, so `<br>` is in keeping; `autosizeSprintArea` already exists | A hand-typed `<br>` in an existing file starts showing as a line break in the grid — arguably correct, but it does change how existing files read |
| **B.** Keep one line, wrap or widen the cell visually | Trivial | Does not answer it — the file still holds one line, and the next save flattens what you typed |
| **C.** Put real newlines in the cell value | Obvious | **Corrupts the file.** The grid is posted to `/api/sprints/table` and a newline inside a pipe row *is* a new row. Named because it is the implementation you reach for first and it destroys a table silently |

**Recommend A.** It is the standard GFM idiom for this and it lands in the two
functions that already own the cell↔file translation.

### Options for 2

| Option | Pro | Con |
|---|---|---|
| **A.** `Enter` in the last cell of the last row inserts a block after the table | No new furniture | Undiscoverable — nothing indicates it, which is why nobody found the gap either |
| **B.** A `+ Block` control beside `+ Row` / `+ Column` in `sprintTableTools` | Visible, and sits where the table's other structural gestures already live | One more hover control, and it is table-specific machinery for a general problem |
| **D.** Make the foot-of-document click target always present, not only when the file is empty | Fixes the **class** rather than the instance; generalises a placeholder that already exists; needs no table knowledge at all | A permanent click target under the document, which is a visual change to every file |

**Recommend D**, optionally with A alongside. The bug is that a trailing table
has no successor; the cause is that "start a block at the end" only exists for an
empty file. Extending that one affordance is smaller than B and it cannot rot,
because it never learns what a table is.

### For 3, the answer is A and a decline

With multi-line cells, a cell holding `- design<br>- build` renders as two lines
reading `- design` / `- build`: **visually a list, semantically text**, honest
when you open the file in Notepad, and the round trip stays exact. That is the
version worth shipping.

**The bad version is emitting `<ul><li>` or `<input type="checkbox">` into
cells.** It would render, because `html=True` — and then: the grid has to parse
HTML back out to stay editable, a tick has **no persistence path** at all
(`toggleSprintTask` rewrites a `- [ ]` *line*, and there is no line), and the
file stops being markdown a human would hand-edit, which `sprint_review.py` and
you both do. If a genuinely tickable list is the need, it belongs in a task-list
block **under** the table — which the editor already does, and where the tick
already works.

**Cost:** small. One line in `_escape_cell`, one in `cellText`, `sprintCell`'s
input → textarea plus autosize, the `Tab` handler unchanged, one foot-of-document
click target, `.sprint-cell` CSS. Tests in `test_markdown.py`, where **the round
trip is the gate**: a `<br>` cell has to survive `join_blocks(split_blocks(t)) ==
t`, and that test already runs against `templates/sprint.md` and every
`sprints/*.md` on disk.

No schema change, no export bump, nothing near `migrate()`. **The sprint-4 gate
is untouched** — the condition is that no string from `templates/sprint.md`
appears in `app/markdown.py` or `editor.js`, and multi-line cells add no string
at all: any pipe table in any markdown file gets the same grid it does today,
one line taller.

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
that is the first thing you see. **That is now FR-11**, raised independently by
the requester — so the two should be done together.
