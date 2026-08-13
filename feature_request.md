# Feature requests

Gaps found by walking the tool end to end as a product owner would: capture an
idea, cost it, put it on a calendar, run a fortnight against it, come back and
update it. Opened 2026-08-06.

**FR-9 to FR-14 are the requester's own, from `comments.md` on 2026-08-13** —
six items written after using the tool rather than after reading it, which is
why every one of them is about a gesture rather than a rule. Each names the
comment it came from.

This file is the **backlog of things the tool does not do yet**, with the reason
each one matters and the reason it might not be worth building. It is not a
plan. `comments.md` is requester feedback, `STATUS.md` is the decision log,
`PLAN-*.md` are the working plans behind one feature each.

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
not on effort · **Built** · **Won't build**.

Frequency does most of the ranking. A one-line tooltip on a control you hover
forty times a week outranks a rule you would read once a sprint, and that is
why FR-13 sits above FR-12.

| # | Request | Complexity | Frequency | Impact | Priority |
|---|---|---|---|---|---|
| FR-9 | Insert, delete and reorder a table's rows and columns | Medium | High | High | **P1** |
| FR-10 | Create a sprint from the Sprint tab | Small | Fortnightly | High | **P1** |
| FR-13 | Project span on the portfolio swimlane title | Tiny | High | Medium | **P1** |
| FR-1 | Say that sprint task points and phase `effort_points` are one currency | Prose only | — | High | **P1** |
| FR-2 | Portfolio-wide warnings, not just V2 | Small | High | High | **P1** |
| FR-11 | Project picker belongs to the Project tab | Medium | High | Medium | **P2** |
| FR-12 | Show the date you are dropping on, while dragging | Small | High | Medium | **P2** |
| FR-14 | Colour the map by track, tone by subtrack | Medium | Medium | High | **P3** — pick an option first |
| FR-3 | Overlap check across projects (**not** a points sum) | Small–medium | Low | Medium | **P3** — sprint 4 |
| FR-4 | Capacity roster — people and their available days | Medium (new table) | Fortnightly | Medium | **P3** — paper until sprint 4 |
| FR-5 | Velocity learns from delivered history | Medium | Rare | Medium | **P3** — needs 3 baselines |
| FR-6 | Slippage memory — has this date moved before? | Large | Low | High | **P3** — deferred deliberately |
| FR-7 | Owners at roadmap level | Small | — | Negative | **Won't build** |
| FR-8 | A "this fortnight" view | ~600 lines | High | High | **Built** 2026-08-13 |

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

**Note for FR-8:** `validation.fortnight_slice` deliberately bounds overdue lanes
in the fortnight drawer to projects with work in that window, on the grounds
that *"V6 on the Project tab already does the latter, globally and better."*
That is only true once this item is built. Right now V6 is global in nothing.

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
thought after FR-4 and should be argued with rather than drifted into.

Velocity is a team-level number by design, and the sprint file is where `@owner`
already lives (`templates/sprint.md:69`) — at the task level, for one fortnight,
where an owner is a real commitment rather than a guess months out. An owner on
a phase is a guess months out that then looks authoritative.

It is also the single change that would turn the roster (FR-4) from reference
data into assignment, and the tool into the tracker the brief forbids. If the
overlap problem is real, FR-3 addresses it without naming anybody.

---

## FR-8 · A "this fortnight" view — **Built**

**Built** — the read half on 2026-08-06, the Sprint tab and its editor on
2026-08-13. See the *fortnight drawer* and *Sprint* entries in `CLAUDE.md`.
Recorded here only so the backlog is complete.

The gap it fills: Project is one project, Portfolio is 26 weeks, Map is the whole
department, and nothing answers *"what is in flight right now."* The read half
(~600 lines) was never gated; the editor was gated at sprint 4 and that gate was
**overridden** with one file on disk — see *"Why the sprint-4 gate was
overridden"* in `CLAUDE.md` for the condition it rests on.

Two interactions with this file: it assumes FR-2 exists (see the note there), and
its capacity meter is deferred to the editor pane, which is where FR-4 would
surface if B is ever built.

---

## FR-9 · Insert, delete and reorder a table's rows and columns — **P1**

*From `comments.md` #1.*

**What:** delete *this* column rather than the last one; insert a row after *this*
row; move a row or a column to where it belongs.

**Why it matters.** The grid grows and shrinks from the end only. `+ Row` and
`+ Column` append, `− Row` and `− Column` pop (`app/static/editor.js:796-808`),
and `Tab` off the last cell grows a row (`editor.js:735`). So a row that turns
out to belong third, or a column typed in the wrong order, costs a retype of
every cell below or to the right of it — in the one table the tool exists to make
easy to fill in.

It bites hardest on the feature the editor was built for. Pasting a spreadsheet
range fills from the anchor cell outwards (`editor.js:762`), so the columns have
to already be in the source's order before the paste, and today the only way to
get them there is to retype them.

Frequency is what puts this at the top: the capacity and unplanned-work tables
are refilled every fortnight, by hand, and this is the part of that job the
editor currently does not help with.

**The bad version — two of them.**

- **A control that knows what a capacity table is.** "Add a person row", or a
  fixed column order, would put a sprint concept in `editor.js` and break the
  condition the sprint-4 gate override rests on: *no string from
  `templates/sprint.md` appears in `app/markdown.py` or `editor.js`*
  (`CLAUDE.md`). Every control here is generic or it is not built.
- **Dragging a row by its cells.** HTML5 drag on the cells themselves costs
  click-to-place-cursor inside a cell. Arm the drag from a grip alone — the
  conclusion the deliverable list and the block gutter both already reached, by
  two different routes.

**The one correctness trap:** a column carries `align[]` as well as its cells.
Moving or deleting a column has to move or delete its alignment marker with it,
or the file's right-aligned numbers silently move to a different column. That is
what the round-trip test is for. Deleting the last column stays forbidden, as it
is now — a table with no columns is not a table.

**Cost:** frontend only. `serialise_table` regenerates `raw` from
`head`/`align`/`rows` server-side, so nothing about the file format changes and
no new endpoint is needed. Roughly 120–180 lines in `editor.js` plus CSS.

**Shape to build:** hover-revealed grips — one per row in a leading gutter, one
per column in the header — matching how `.sprint-table-tools` already appears on
hover. Permanent chrome would roughly double the height of a small table.
Alignment markers stay the raw file view's job; this adds no reveal gesture.

---

## FR-10 · Create a sprint from the Sprint tab — **P1**

*From `comments.md` #2.*

**What:** a `New sprint` control on the Sprint tab.

**Why it matters.** The only way to make a sprint file is Portfolio → click a
week number on the ruler → the fortnight drawer → `Plan this fortnight →`
(`app/static/app.js:1732-1746`). The Sprint tab lists files and opens them and
cannot make one. So the tab that owns sprints is the one place you cannot start
a sprint, and the path that works runs through a drawer on another tab that has
to be discovered by clicking a week number nothing marks as clickable.

It also fails outright for a fortnight outside the current portfolio window: you
have to scroll the chart to the right weeks before the button you want exists.

**The server already does this.** `SprintIn.start` defaults to `""`, meaning the
fortnight containing today (`app/main.py:150-154`); the number comes from the
directory, never the body; an existing target is a 409, never an overwrite. This
is a button, a date input and one call to an endpoint that is already built and
already tested.

**The bad version:** a create control that picks the number, or that decides for
itself what to do about a fortnight that already has a file. The number stays the
server's, and the 409 gets surfaced as "sprint N already exists — open it"
rather than turned into an overwrite.

**Keep it dates-only.** Do not prefill it from the roadmap — the drawer is the
roadmap-aware path and it already exists. Duplicating it would put roadmap
knowledge in the Sprint tab, which currently has none, and that is worth more
than the convenience.

**Cost:** small, ~40–60 lines: a date input defaulting to the Monday of the
current fortnight, `POST /api/sprints`, then the existing `revealSprintFile`.

---

## FR-11 · The project picker belongs to the Project tab — **P2**

*From `comments.md` #3. It confirms the **Tab order** note at the foot of this
file, which called this out as an observation; it is now a request.*

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

*From `comments.md` #4.*

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

*From `comments.md` #5.*

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

## FR-14 · Colour the map by track, tone by subtrack — **P3, pick an option first**

*From `comments.md` #6.*

**What:** make a track identifiable at a glance, with hue for the track and a
tone of it for the subtrack.

**The problem is real.** Track and subtrack are currently greys —
`.map-track circle { fill: #9e9e9e }`, `.map-subtrack circle { fill: #c4c4c4 }`
(`app/static/style.css:796-802`) — so the only thing telling you which projects
belong together is which wedge they sit in, on a radial layout where wedges have
no borders.

**The conflict, stated plainly: colour on the map is already spent.**
`derived_stage` owns the project node's fill and stroke in a deliberate ramp —
cool while planning, warm once dated, and red appearing exactly once in the whole
vocabulary (`CLAUDE.md`, *Map*; `style.css:823-856`). A second colour axis on the
same circles does not add a vocabulary, it destroys the one there is.

| Option | Pro | Con |
|---|---|---|
| **A.** Hue on the track ring, subtrack ring and the spokes between them; project circles keep the stage ramp | No clash at all; the spoke into a project names its track | The node itself stays neutral, so reading a track means following a line inward |
| **B.** Hue on the project node's **stroke**, stage keeps the fill | Track readable on the node itself | Stroke already carries meaning — weight for overdue, dash for idea. Needs a third property and muddies the dashed ring |
| **C.** A faint coloured sector behind each track's wedge | Strongest grouping cue; colour never touches a node | Hand-rolled sector maths against `arcRuler`; risks washing out the labels sitting over it |
| **D.** Colour only the track/subtrack labels, plus a small coloured tick beside each project label | Cheapest, zero clash | Weakest at a glance — which is the actual complaint |

**Recommendation: A plus D's tick.** The ring, its spokes and its label carry the
hue; every project label gets a small mark in its track colour so you never have
to trace a line; the node keeps the stage ramp intact. C stays on the table if
that turns out not to be enough — it is the strongest and it is also the one that
can go wrong quietly.

**Constraints any option has to meet.** These are why this is P3: they are
decisions, not work.

1. Colour assigned **deterministically** from the sorted track name, so adding a
   project never reshuffles the map's colours.
2. Tracks are free text and therefore unbounded, while distinguishable hues are
   not — a bounded palette (~8–10) with a defined overflow, probably grey.
3. Colourblind-safe, since hue would be the only cue carrying track identity.
4. A subtrack's tone must stay distinct from its parent's across a 40–55px ring
   gap.
5. Tier 3 already renders at `fill-opacity: .5` (`style.css:874`). The track hue
   has to survive that fade and still be the same colour as its ring.

**Cost:** medium, frontend only — the map render in `app.js` and `style.css`, no
schema, no endpoint. The palette assignment is ~30 lines; the risk is entirely in
whether the result reads better, which can only be judged against the real
dataset. **Decide the option before writing any of it.**

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
