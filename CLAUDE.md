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
.\.venv\Scripts\python.exe -m pytest -q                                   # 217 tests, ~9s

.\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt          # optional, sprint review only
.\.venv\Scripts\python.exe scripts\sprint_review.py --history 3
```

> **`--reload` runs `init_db()` — and therefore `db.migrate()` — against
> `data/roadmap.db` every time a source file is saved.** A half-finished edit is
> executed the moment it hits disk; it does not need to be run deliberately, or
> even to be finished. Before touching anything under "Schema changes" below:
> stop the server, or point it at a copy. This has already cost the real dataset
> once — 24 phases and 33 deliverables, recovered from a backup. See STATUS.md
> item 50.

Type checking is pyright, `basic` mode, config in `pyrightconfig.json`.
`conftest.py` exists only to put the repo root on `sys.path`.

## Layout

| Path | What lives there |
|---|---|
| `app/validation.py` | Rules V1–V4 + project summaries + the fortnight slice. **Pure functions, no I/O.** The heart of the tool. |
| `app/db.py` | Schema, CRUD, `migrate`, export/import. Rows in/out as plain dicts. |
| `app/main.py` | FastAPI routes. Thin — no business logic beyond the V3 block. |
| `app/static/{index.html,app.js,style.css}` | Frontend. Three tabs: Project / Portfolio / Map. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `tests/test_sprint_review.py` | Sprint script — pure helpers + one `TestModel` run. Offline. |
| `templates/sprint.md` | The sprint template. Copied to `sprints/NN.md` (gitignored). |
| `scripts/sprint_review.py` | Post-sprint LLM review. Optional dep, lazy import, CLI only. |
| `data/roadmap.db` | The dataset. Gitignored. `.bak` is the pre-migration copy. |

Keep this shape. Extend an existing module rather than adding a file; propose a
structure change before adding anything top-level.

## Data model

`settings` (singleton row) — `default_velocity_points_per_sprint` (20),
`sprint_length_days` (14), `v1_tolerance_pct` (5.0), `department_name`.

`project` — name, description, `goal` (free text, never parsed), `start_date`,
`velocity_override` (nullable), `stage` ∈ `idea|planned|active|done`,
`draft_complete` (0/1), `track` (free text), `tier` ∈ `0|1|2|3`, timestamps.

`stage` still holds four values but now carries only **three meanings**, because
`validation.project_stage` derives the rest from the plan and the clock:

- `idea` — nobody has committed. Keeps the project off the portfolio.
- `planned` / `active` — **the same thing: committed.** They are no longer
  distinguished anywhere. `planned` is what the UI writes; `active` is what older
  rows carry and reads identically. The ladder works out whether committed work
  is drafted, dated, running or late.
- `done` — the **manual close**, and it beats the ladder outright. Not
  "delivered" but *closed without finishing*: cancelled or descoped work never
  reaches every-phase-done, and without this hatch it would sit `overdue`
  forever until the colour stopped meaning anything.

The CHECK deliberately keeps all four values. Narrowing it would mean rebuilding
the `project` table through `migrate_stage_check`, which has cost a real dataset
once, to buy nothing a reader of this section does not already know.

`draft_complete` is **"I am done drafting this plan"** — the one thing about a
plan's shape that cannot be derived, because only the user knows whether a phase
with nothing under it is an omission or a deliberately thin one. It decides
`planning` vs `planned` and nothing else; once the work is dated the ladder
ignores it entirely. It can go stale, and that was accepted: latching it shut on
structural change would be the tool silently undoing something you set, and
deriving it outright would take away the judgement call it exists for. It sits
beside the phase list it describes, so the evidence is on screen with the flag.

`tier` is priority, 1 highest, and **0 is untiered — the absence of a decision,
not a fourth tier**. It sorts last everywhere, is spelt out rather than numbered
in the UI, and existing rows migrate to it rather than to a middle tier: ranking
work nobody ranked would be the tool having an opinion. Nothing derives from
tier and no rule reads it. It exists so the Map can be thinned to what matters —
that is its whole job, and the reason it is a small integer and not a table.

`track` is one column and stays one column. The Map splits it on the **first
slash** — `Source expansion / Metrics` — to draw a subtrack ring. That is a
frontend convention (`splitTrack` in `app.js`), not schema: nothing validates it,
a name with no slash is simply a track, and a name with nothing before the slash
is treated as a plain track rather than half a hierarchy. Two levels is the
ceiling; a third would want a real column or a track table.

Because the grouping key is the **raw string**, `Source expansion` and
`Source Expansion` are two rings. Nothing normalises stored values — the Track
field is where drift is headed off instead, by offering what has already been
typed and canonicalising the spacing around the slash on the way in.

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
   V7 and the ladder read deliverable **presence**, which is a planning fact;
   neither reads the tick. Deriving project `done` from ticks was asked for and
   declined: 0-of-0 phases make "all delivered" vacuously true, and a field
   designed to be casual stops being casual the moment state depends on it.
5. **V5 is deleted, not dormant.** Deliverables lost their estimates, so the
   rollup had no input. `v5_tolerance_pct` went with it. `PROMPT.md` still carries
   the original V5 prose as the record of what was first asked; its **Amendments**
   section overrides the body text. **The numbering skips it** — the rules added
   after are V6 and V7, so nothing ever reuses V5.
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
| V6 | phase | Derived phase end has passed and `status != done` | Warn |
| V7 | phase | `status == done` but the phase names no deliverables | Warn |

Velocity = `project.velocity_override` or the global default. Tolerance defaults
to **5%** deliberately: the canonical 6w / 55pts @ velocity 20 case is off by
8.3%, so 20% would never fire.

**V6 is the rule that actually finds late work.** The `overdue` rung only fires
once a project's *last* phase end has passed, which found nothing on the real
dataset; V6 found a discussion phase a month past its end inside a project with
weeks still to run. **V7** is the counterweight to deriving `done` from phase
status: closing a phase is what completes a project, so a phase closed with
nothing named under it records no outcome at all. It reads presence, never the
tick — see rule 4.

`validate_plan()` runs V1, V4, V6 and V7 on one project. **V2 lives in
`validate_portfolio()`** — it compares two projects, so it needs every project,
its phases and every dependency. V3 is in neither: it is checked at write time.
`GET /api/projects/{id}` merges the V2 warnings naming that project into its own
list, so both ends of a link see it.

`validate_plan`'s `today` and `deliverables_by_phase` arguments both default to
`None`, which **skips** V6 and V7 rather than inventing the input. The module is
pure: reading the clock inside it would make every test of it depend on the day
it runs, so the caller passes the date — the same contract `next_milestone` has
always had.

## Unscheduled is a first-class state

An empty `start_date` is stored as `""` (not NULL) so it round-trips through an
HTML `<input type="date">` untouched. Estimate first, commit dates later.

- Reads are **lenient** (`as_optional_date` swallows bad values) so one bad row
  cannot break a whole project view.
- Writes are **strict** (`main.clean_date` → 422) so bad values never get stored.
- V4 skips unscheduled records, and V2 skips a project with nothing scheduled on
  the side it needs (no start, or no phase end). V1 does not care about dates.
- Portfolio keeps unscheduled phases off the chart, but returns them grouped by
  project in `unscheduled` (plus the flat `unscheduled_count`) so the view can
  stage them for placing.
- The project timeline's **Weeks** mode draws undated phases as `W1, W2, …`, so
  a plan with no dates at all still has a readable shape to arrange.
- `POST /api/projects/{id}/layout` places undated phases back to back from the
  project start. **User-triggered only** — it is not auto-scheduling. The
  portfolio tray is the same operation driven by a drag: the drop is what
  supplies the start date, so no date is ever invented.

## The stage ladder is derived

`validation.project_stage` returns one rung of
`idea | planning | planned | dated | active | overdue | done`, first match wins.
It **replaced `project_readiness`**, which was a second axis running alongside
`stage`: two values that disagreed about the same project turned out to be one
question asked badly. On the real dataset the old one answered `planning` for
six of the seven projects it rendered on — including all three that were
actually running, because one phase with nothing named under it outranked every
date on the plan — while its single `ready` was the only project with no dates
at all.

Only three inputs are yours: `stage='idea'`, `stage='done'` (the manual close),
and `draft_complete`. Everything else is worked out.

- `idea` — stored. Beats every rung below, so an idea that somehow acquired
  dates still reads as an idea; the portfolio filters on the stored value and
  the two must never disagree.
- `done` — stored close, **or** every phase at `status='done'`. Deriving it is
  what puts the weight on closing phases: finishing a project means finishing
  the work inside it, not ticking one box at the top.
- `overdue` — fully dated, last phase end passed, phases still open.
- `active` — fully dated, today inside the span.
- `dated` — fully dated, not started.
- `planning` — no phases, nothing named under any of them, or still drafting.
- `planned` — named and drafted, waiting only for dates.

**Dates outrank `draft_complete`, and the order is load-bearing.** Checking the
flag first reads a project that is dated and running as `planning` merely
because nobody flipped a switch — the exact inversion this replaced. Once work
is on the calendar the calendar speaks for it; the flag only ever decides
between `planning` and `planned`.

A deliverable's `done` tick is **not** read here, only its presence — see rule 4.
Nothing is stored and nothing is repaired.

`db.list_projects` sorts done last and ideas just above, so the middle of the
list is work in flight. That ordering is shared, so the portfolio swimlanes and
the map's slot order follow it too. **`GET /api/projects` re-sorts on top of it**,
because `db` can only see the stored stage, which now says `done` for a manual
close alone: a project finished by its phases would otherwise sit in the middle
of the picker among work in flight.

## API surface

`/api/settings` GET PUT · `/api/projects` GET POST · `/api/projects/{id}` GET PUT
DELETE · `/api/projects/{id}/layout` POST · `/api/projects/{id}/phases` POST ·
`/api/phases/{id}` PUT DELETE · `/api/phases/{id}/deliverables` GET POST ·
`/api/deliverables/{id}` PUT DELETE · `/api/dependencies` POST ·
`/api/dependencies/{id}` DELETE · `/api/portfolio` GET · `/api/fortnight` GET ·
`/api/sprints` POST · `/api/graph` GET · `/api/export` GET · `/api/import` POST.

`GET /api/projects` returns each project with a derived **`derived_stage`** (see
above), alongside the stored `stage` and never overwriting it — the stored value
is what the portfolio filters on and what a form round trip echoes back, so
collapsing the two would let a derived value be written into the column.
`main.with_derived_stage` tags a list; `/api/projects` and `/api/graph` both use
it.

`GET /api/projects/{id}` returns the whole plan in one payload: project (also
carrying `derived_stage`, unlike the readiness it replaced — the drafting toggle
lives in this view and a switch whose effect you cannot see is a switch you have
to guess at), phases
(with derived dates, `offset_weeks` + deliverables), dependencies, warnings,
settings. Its
`dependencies` are every link the project sits at **either** end of, each
carrying `predecessor_name` and `successor_name` so the view needs no second
fetch. `GET /api/portfolio` carries the same list for the whole dataset plus
every V2 warning, and `GET /api/graph` carries it too — for the map's hover
highlight, not for a permanent edge.

`GET /api/portfolio` also returns `unscheduled`: per project, the phases still
waiting for a date, with `total_weeks`, `total_points` and `scheduled_count`.
Built by `main.unplaced_work`; it is what the staging tray is drawn from.

`GET /api/fortnight?start=` returns **one fortnight, flattened**: a `window`
and a lane per phase touching it. `start` is optional and snaps back to its
Monday, both dates reported. The bands, the clip flags and the order are all
`validation.fortnight_slice`; the route is assembly and passes `today` in.
**Nothing in the payload sums points** — see the section below.

`POST /api/sprints` copies `templates/sprint.md` to the next `sprints/NN.md`
and fills in the heading. The one write in the fortnight feature, and it writes
a file rather than a row.

## Schema changes and export versions

No migration framework. `db.migrate()` runs on every `init_db()`:
`migrate_stage_check()` first, then `ADDED_COLUMNS`, then `DROPPED_COLUMNS`,
each guarded by `PRAGMA table_info`, then `migrate_dependencies_to_projects()`.
Additions before removals so a file that skipped releases converges on the same
shape. Dropping needs SQLite ≥ 3.35.

The `project` table is assembled from `PROJECT_TABLE`, parameterised by name,
because `migrate_stage_check` has to build an identical table under a temporary
one. `SCHEMA` is `SETTINGS_TABLE + PROJECT_TABLE + REST_OF_SCHEMA` — one
definition, no drift.

**`migrate_stage_check` is the dangerous one, and it cost a real dataset once.**
SQLite cannot alter a CHECK in place, so accepting `planned` meant rebuilding
`project`. Two things about it are load-bearing:

- **It creates the replacement alongside and renames it in last** — create
  `project_rebuilt`, copy, drop `project`, rename. The obvious order, renaming
  the old table out of the way first, **silently rewrites every `REFERENCES`
  clause pointing at `project` to name the renamed table**, with or without
  foreign keys on. That leaves `phase` pointing at a table the migration then
  drops.
- **Foreign keys must be OFF**, and `PRAGMA foreign_keys` is *silently ignored
  inside a transaction* — which `init_db` always has open. So it commits first,
  sets the pragma, then **reads it back and raises if it did not take**. With
  keys on, `DROP TABLE` runs an implicit DELETE and `phase.project_id` is
  `ON DELETE CASCADE`: the drop takes every phase and deliverable in the file.
  That is exactly what happened while this was being written, against a live
  `--reload` server that picked up a half-finished edit.

Never edit a destructive migration with `uvicorn --reload` pointed at
`data/roadmap.db`. Stop the server, or work against a copy.

The dependency step is the one table-level migration: if the old phase-level
`dependency` table is still there, its rows are lifted to the projects they
linked, links that collapse onto one project are discarded, and the table is
dropped. **Irreversible** — back the file up first.

Export `version` is currently **9**. Bump it when the shape changes and keep
imports tolerant of older files — v2–v8 exports must still import, with absent
fields falling back to defaults and phase-level dependencies translated by
`project_dependencies_from()`. Nothing in a pre-v9 file is drafted, which reads
as still-drafting: the quieter default of the two, since it understates a
finished plan rather than declaring every half-written one done.
`import_all` is destructive by design and
preserves ids so links survive the round trip; a translated pre-v6 file is the
one case where dependency ids are renumbered, since several phase links can fold
into one project link.

## Views

- **Picker** — the project `<select>` above the tabs. Each option is
  `badge Name` — **one mark per row**, so the badges form a single column you
  scan. The mark comes straight off `derived_stage` via `STAGE_BADGE`
  (💡 idea, ⚪ planning, 🟡 planned, 🔵 dated, 🟢 active, 🔴 overdue, ✅ done),
  so 💡 is simply the ladder's first rung rather than a separate rule — the old
  `IDEA_BADGE`/`READINESS_BADGE` split is gone. The ramp is not decoration: the
  cool marks are plan-building, colour warms once the calendar takes over, and
  **red appears exactly once in the vocabulary**, which is what keeps it worth
  noticing. The dependency and Future-directions pickers still mark ideas with
  the same 💡 (`IDEA_BADGE`, now an alias) — they list projects rather than
  states, so committed-versus-idea is the only distinction worth drawing there.
  They are
  **emoji, not CSS** — an `<option>` holds no markup
  and cannot be styled portably, so a coloured glyph is the only badge a native
  `<select>` can carry; a real pill would mean hand-rolling a dropdown. The
  legend lives in the select's `title`. `loadPlan` re-reads `/api/projects`
  after every edit so naming a deliverable or flipping the drafting switch
  retags the option immediately; that costs one localhost query and keeps the
  ladder out of the frontend.
- **Track picker** — the Track field on Project, and the one on the Map's
  Future directions row, share `trackPicker` in `app.js`. It is the **one
  hand-rolled control in the codebase**, and the exception is deliberate: a
  `<datalist>` cannot nest, count or offer a create row, and the nesting is the
  point, since the map draws the same two levels. Built from `state.projects`
  and refilled by `refreshTrackPickers` inside `loadProjectList`, so a track
  invented in one field is offerable in the other — nothing is stored, and the
  list is exactly the tracks in use.
  - Tracks as parents, subtracks indented under them, counts being projects on
    that **exact** value. Typing filters both levels, and a track stays visible
    when only its subtracks match.
  - `/` on a highlighted track drills into it and the panel shows that track's
    subtracks; `Backspace` off a trailing slash pops back out. Anywhere else a
    slash is just a slash, and inside a track a further one is part of the
    subtrack's name — the picker will not imply a third level `splitTrack`
    cannot read.
  - Opening a field that already holds a track browses the **whole** tree with
    that row highlighted rather than filtering to the one value already in the
    box. Typing turns it back into a filter.
  - **It still writes nothing.** The create row fills the field; the track
    starts existing when the project is saved and stops when the last project
    leaves it. Text matching an existing value in a different case offers the
    existing spelling instead of a create row, which is the whole point of the
    control. Renaming a track is still per-project by hand.
  - Committing dispatches `change` itself rather than waiting for blur, because
    the field's existing `onchange` is what saves the project.
- **Project** — goal, fields (including **Tier**, the only place it is set),
  warnings, unscheduled list, timeline, phase table
  with expandable deliverables (`3/5` tally on the phase row), dependencies. The
  dependency panel lists both directions (`← waits on X`, `→ Y waits on this`)
  and links by picking another project plus a direction.
  The **Stage** field offers three choices — `idea | committed | closed` —
  because those are the only three the ladder does not derive. "Committed"
  writes `planned`; a legacy `active` row reads back as committed, since they
  are the same thing.
  The **drafting switch** sits beside the *Phases & deliverables* heading, on
  the section it describes. It is `hidden` wherever it decides nothing — on an
  idea, on a closed project, and once the work is dated — which needs
  `.draft-toggle[hidden]` in the CSS, the same trap `.track-crumb[hidden]` and
  `.direction-link-form[hidden]` document. `renderDraftToggle` sets the
  checkbox **before** its early return: `saveProject` reads that checkbox on
  every project edit, so leaving it holding the previous project's value would
  quietly write that value onto this one.
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
- **Portfolio** — every scheduled phase of every **non-idea** project on one
  axis, one swimlane per project (`SCHEDULABLE_STAGES`, which is every stored
  stage but `idea`; committed is committed, whatever rung the ladder then puts
  it on). Drag a bar to move **only** that phase; snaps to a
  week, `Alt` for single days. No resize.
  Above the chart, a **staging tray**: one chip per project that still has
  undated phases. Drag a chip onto a week and the project is placed there —
  `PUT` its `start_date`, then the existing layout endpoint stacks its undated
  phases from it. Two existing calls, no new endpoint, and the same snapping as
  a bar drag. Ideas never reach the tray (committing to a direction is a
  project-view decision) and neither do projects with no phases, since the tray
  places work. A half-placed project stays in the tray until every phase has a
  date; its dated phases keep them and only push the placed run later.
  The grid is drawn even when nothing is scheduled at all — it is the drop
  target, and that is exactly the case where the tray matters most.
  A press only becomes a drag after 4px (`DRAG_ARM_PX`), so hand shake during a
  click cannot file a project at the window origin. Bars need no such guard —
  their snap is relative to where they already are, so a twitch is a zero-day
  move. After a drop, an **Undo** bar offers the exact inverse: the layout call
  reports which phases it dated, so undo blanks those and only those, then puts
  the project's own start date back. It lives in `state.lastPlacement`, so it
  survives re-renders and tab switches but not a page reload — the offer says so.
  Below the chart, every cross-project
  link as a **list**, V2-marked where violated — not arrows between swimlanes,
  because a link can point at an idea, which has no bar to draw to.
- **Fortnight drawer** — clicking a week number on the portfolio ruler opens
  the fortnight starting that Monday, under the chart, and marks the two weeks
  it covers. The ruler variant (`portfolioRuler`) is **passed into `weekGrid`
  rather than flagged on**, so the project timeline's ruler is untouched and
  nothing there knows the drawer exists. `state.fortnight` survives re-renders
  and tab switches but not a reload, like `timelineMode` and `state.mapTiers`.
  `Esc` closes. `.fortnight-drawer[hidden]` is load-bearing — the fourth time
  that trap has come up.
  It draws `renderSprintSlice`, the **shared** component: a day-resolution
  strip of 21 columns (the fortnight, then the lead-out week greyed behind a
  divider), weekends shaded, a today line that is simply **absent** when today
  is off the strip, over a list of the deliverables the phases name. Divs on a
  CSS grid, not SVG — the charts either side of it are divs on a week grid, and
  the map is the one hand-rolled SVG here. `compact` is the drawer's density:
  same DOM, tighter metrics, so the drawer and the eventual sprint tab cannot
  drift into two pictures of one fortnight.
  **Points are drawn whole, on the bar**, and the share of a phase inside the
  fortnight is the bar's width and nothing else. A clipped edge gets a solid
  tab and a chevron rather than the portfolio's dotted edge, because at day
  resolution 3px of dotting is most of a column.
  The drawer **reads**, with one exception it owns: `Plan this fortnight →`
  posts to `/api/sprints`, reports the path and stops. It leaves itself
  disabled on success — a second press would be sprint N+1 for the same
  fortnight.
- **Map** — hand-rolled radial SVG, deterministic layout. Department hub → track
  ring → subtrack ring → project ring, ideas outermost and dashed. Nodes are
  styled off **`derived_stage`**, so the picture ages by itself: a project that
  starts next week stops looking un-started on the day it starts, with nobody
  editing a field. Stage reads as one vocabulary on the node — **idea** hollow
  and dashed, **planning** hollow with a light outline, **planned** hollow with
  a solid one (shaped and committed to, nothing slotted), **dated** pale-filled
  (on the calendar, not begun), **active** filled, **overdue** filled with a
  heavy warning outline, **done** filled grey. Overdue keeps a live project's
  filled body and spends its difference on the stroke, rather than inventing a
  fifth fill. A fourth ring for
  `planned` was the alternative and was rejected on cost — ring gaps are the
  tightest budget on the map and `MAX_RING_ASPECT` would have needed re-fitting. Node radius
  `sqrt(points)`, clamped 16–38px. A track's wedge is sized by how many projects
  it holds; inside it every project gets one slot, unsubtracked ones first, and
  each subtrack node sits at the middle of the contiguous run of slots its
  projects occupy. Projects with no subtrack hang straight off the track,
  exactly as before.
  Slots are spaced by **arc length, not angle** (`arcRuler`). The rings are
  ellipses roughly 1.4:1, so an evenly-divided angle packs the left and right
  flanks at half the spacing of 12 and 6 o'clock — and that is where labels are
  widest relative to their gap. The ruler samples the project ring once per
  render and inverts distance → angle by lookup; a wedge's share is therefore a
  length of ring, and the inner rings only follow the angles it hands out. A
  subtrack's midpoint is averaged in *distance* too, which also sidesteps the
  wrap at 12 o'clock.
  Labels are placed by `labelPlace` off the ellipse rather than the screen.
  "Below the circle" is only away from the hub on the bottom half, so a fixed
  screen direction put half of every ring's labels on the ring inside it. A
  project leans **across** the ring, straight out past the outermost one; a
  track or subtrack leans **along** it, following the arc, because the gap
  between two rings (40–55px) is far narrower than a label is wide (up to
  140px) while the arc beside an inner-ring node is empty. The larger component
  of that direction picks the axis and its sign picks the side, giving
  `text-anchor` `start`/`end` on the flanks and `middle` at top and bottom.
  Label geometry is the reason for the constants: `MAP_MARGIN_X` clears most of
  a sideways label rather than half a centred one, `MIN_MAP_HEIGHT` buys back
  the ring gap that is thinnest on the short vertical axis, `TRACK_RING` sits at
  0.36 to open the track→subtrack gap, and `SUBTRACK_RING` at 0.48 keeps the
  subtrack clear of a 38px node on the ring outside it.
  **The Map is the one view not capped at 1100px** — it is a single picture of
  the whole department, so it takes the window up to 1530px while Project and
  Portfolio keep the cap (the cap moved off `main` onto the views to allow it).
  The height therefore follows the width: `mapHeight` grows the canvas just
  enough to hold the rings under `MAX_RING_ASPECT` (1.8), clamped 680–860, so a
  wide monitor does not stretch the ellipse flat and push every node out to the
  far left and right. At the width the old cap allowed, the floor wins and
  nothing moves. Verified by collision sweep over the real dataset: clean from
  1000px to 1530px; below ~900px twelve projects genuinely do not fit and
  labels touch again.
  **Tier is the crowd control.** Above the canvas, one toggle per tier —
  `T1 T2 T3 untiered`, counted off the whole dataset so a chip still says what
  is behind it while it is off, and all on by default because a filter that
  hides work by default loses it. Filtering happens **before `mapGroups`**, so a
  wedge is sized by what is actually drawn and a track with nothing left in it
  leaves the map entirely — hiding the noise is what widens the room around
  what remains. Turning every tier off is allowed and says so on the canvas.
  Lives in `state.mapTiers`: it survives re-renders and tab switches but not a
  reload, like `timelineMode`, because it is a way of looking rather than a
  setting. A dependency pointing at a filtered-out project simply is not drawn —
  `wireMapFocus` already skipped links whose ends it has no centre for.
  On the node itself, tier is **visual weight**: tier 1 wears a numbered pip on
  its upper-right shoulder, tier 3 fades (returning to full strength on hover,
  so the fade is a resting state and not a handicap), tier 2 is the plain node.
  A halo ring was the first attempt and **failed at the bottom of the radius
  clamp** — at 16px the gap between node and ring is narrower than the stroke,
  so the two merge, and on a dashed idea it just doubled the dashes. The pip is
  a fixed `TIER_PIP_R` whatever the node does, which is the point: a mark that
  scales with the node fails wherever the node is smallest. It is pinned to a
  fixed angle rather than dodging the label, because a mark that moves stops
  being scannable, and it is drawn at `0.707r` so it never reaches past the
  label gap — verified clean against every label from 1200px up; at 1000px it
  touches one, which is already below the width where labels collide anyway.
  Every `.map-node circle` rule carries `:not(.map-pip)`, so the stage colours
  never reach the pip and a tier-1 idea wears the same mark as a tier-1 active
  project. Within a wedge, projects sort by
  tier then id, applied **inside `group.direct` and inside each subtrack's
  list** rather than across the wedge: a subtrack owns a contiguous run of slots
  and sits at the middle of it, so sorting across would interleave subtracks and
  leave their nodes pointing at nothing.
  Tier is also **marked on the label's first meta line** (`T1 · 3/5 phases`,
  `T? · no phases yet`) rather than given a shade of its own, because tier 2 and
  untiered are both the plain node and the circle cannot carry the difference.
  It rides on the existing meta line instead of a new one: the map's label
  clearances are sized against the height of the label block, which a fourth
  line would change.
  Untiered is `T?` on the node but **the word "untiered" everywhere it has
  room** — the filter chip and the tooltip — and those are what make `T?` read
  as "no tier yet". Two markers deliberately (`TIER_LABEL` and `TIER_MARK`):
  spelt out on the node it is the longest marker on the map, it lands on every
  node at once before anything is ranked, and it measured one more overlapping
  label pair than the map already had. See STATUS.md item 47 — the map is not
  collision-clean at this dataset size regardless, and tier did not cause that.
  Dependencies are **not drawn on every render** — a dozen projects on a radial
  layout becomes spaghetti. Instead `GET /api/graph` carries them and hovering
  (or keyboard-focusing) a project dims the map to that project and the ones it
  links to, drawing arrows predecessor → successor. Hovering a project with no
  links is a no-op. Tracks fade less than unrelated projects so the lit circles
  keep their bearings.
- **Future directions** — the idea list under the map, and the second place
  dependencies can be written. Capturing takes name, track and an **optional**
  link (`No link` by default, direction disabled until a project is picked), so
  an idea can be born linked; each row then shows the links it already has as
  chips (`← waits on X`, `→ Y waits on this`) with an ✕, and a `Link…` button
  folding out the same project + direction pair. Both directions are offered,
  the Project tab's wording and orientation exactly — the Map holds no opinion
  the panel doesn't, and what it writes is the ordinary project-to-project
  dependency, not a second kind of link. **No new endpoint**: the chips are read
  off the `dependencies` already on `GET /api/graph` for the hover highlight,
  and writes are the existing `POST`/`DELETE /api/dependencies`. Capture is two
  calls, so it reports a link that failed after the idea was already created.
  The form is `hidden` until asked for, which needs
  `.direction-link-form[hidden]` in the CSS — a class setting `display`
  outranks the UA sheet's `[hidden]`, the same trap `.track-crumb[hidden]`
  documents.

Both charts share one week grid: Monday-based columns under a month/week ruler,
window capped at 26 weeks, column width fitted to the container and clamped
22–64px. A week belongs to the month of its Monday.

## Sprint planning lives on paper, outside the app

Third step after Project and Portfolio, and **still on paper**.
`templates/sprint.md` is copied to `sprints/NN.md`, one file per fortnight;
`sprints/` is gitignored, like `data/`. There is **no sprint table, no sprint
column and no export bump** — nothing for `migrate()` to do.

What the app now does is start the file and nothing else. `POST /api/sprints`
copies the template to the next `sprints/NN.md` and replaces the first line
with `# Sprint N · YYYY-MM-DD → YYYY-MM-DD`. It parses nothing, reads nothing
back, and never lists or edits a sprint. `SPRINTS_DIR` and `SPRINT_TEMPLATE`
are module level in `main.py` so a test can point them at `tmp_path`, the same
shape as `db.set_db_path` — the real `sprints/` holds work actually done.

- **Numbering is next after the highest leading number on disk**, never
  lowest-unused: a gap is a sprint that was skipped or a file that was deleted,
  and neither is an invitation to reuse the number. Same reading as
  `sprint_review.sprint_sort_key`, so the script and the button agree about
  which file is sprint 4.
- **The number never comes from the request** — the body carries a date, so
  nothing outside can name a path.
- The file is created with mode `"x"`, so the existence guard and the write are
  one operation. An existing target is a **409**, never an overwrite.

That is still a staging decision. The schema was going to be designed against
guesses about which columns get filled in; running real sprints on paper first
answers that for free. **Revisit at sprint 4**, when there is history to design
against — that is when the editor, the sprint tab and any storage shape get
decided, and the copy button exists to make sure four real files are there by
then.

**Capacity is two independent numbers that never correct each other**, the same
shape as V1 cross-checking weeks against points:

- **Declared** — bottom-up, per person, a *judgement*. The coding-days column
  beside it is evidence for the judgement, not a multiplier. There is no
  points-per-day constant anywhere and there must not be one.
- **Baseline** — top-down, the last three sprints' delivered points scaled by
  available person-days.

Take the lower unless you write down why not. **There is no focus factor**, and
that is the point: a lead who codes 35% of the time already shows up in what the
team delivered, so declaring a fraction would be inventing a number the history
already contains. Sprints 1–3 have no history and say so in the file.

The **unplanned work** table carries review and management alongside customer
requests, ops and deployment. Categories are a fixed eight-value list because
they are counted across sprints, and a category invented once counts for
nothing. Work that recurs but needs a human (review) is a reason to declare
fewer coding days; work that recurs and is automatable (deploys) is the thing
the table exists to find.

`scripts/sprint_review.py` reads the last few sprint files and asks a model to
read them — structured output (`SprintReview`), not prose, with
`questions_for_next_planning` as the field that makes it teach rather than
summarise. **History is the feature**: one manual deploy is noise, four is a
pattern. Default model `openai:gpt-5.2`, overridden by `$env:SPRINT_MODEL` —
Pydantic AI takes the provider as a string prefix, so switching to Anthropic or
Google is config, not code.

- `pydantic-ai` is in `requirements-ai.txt`, **not** `requirements.txt`, and is
  imported lazily. The app installs, serves and passes its tests without it.
- **The key is read from the environment and nowhere else.** Not the database:
  `/api/export` writes the whole file to JSON and would carry it back out.
- Tests never reach the network — `TestModel` passed straight to `build_agent`,
  because building from a model *string* resolves the provider eagerly and fails
  without a key before there is anything to override.

## Out of scope

Phase 2 (**documented in `PROMPT.md` as do-not-build**) is now **partly open**,
deliberately: sprint planning and post-sprint analysis exist as the paper
template and script above, the fortnight drawer reads a fortnight of the
roadmap, and one button starts a sprint file. Still not built, and still not to
be built without asking: sprint generation from a project's date range,
`sprint_goal` as a column, allocating deliverables into sprints against
velocity, and the delivery forecast. The concessions in the app itself remain
`sprint_length_days` and velocity in settings, plus the drawer and the copy
button — which between them hold no sprint data at all.

**The fortnight drawer never sums points across its window**, and neither does
the endpoint behind it. A 55-point six-week phase does not deliver 18 points in
a fortnight; the whole estimate rides on the bar and the overlap is the bar's
width. A windowed total would be a points-per-day constant in disguise, which
the capacity design forbids outright. Any capacity number belongs in the sprint
file, beside where the judgement is written down.

An LLM call is an **external integration**, which the non-goals below list as
never-build. Opened knowingly for this one script; it is not a precedent for the
app talking to anything.

Non-goals (never build): ticket tracking, comments, activity feeds,
notifications, accounts/roles/permissions, external integrations, BI dashboards,
mobile layouts.

## Working style here

- **Usable before pretty.** The UI has had zero design attention on purpose. If
  choosing between a working feature and a better-looking one, ship the working
  one.
- Python is `snake_case`; the JS follows JS convention (camelCase).
- Answer questions before changing code — ask for confirmation before editing.
- **Verify a destructive operation before it reaches the disk, not after.** The
  dev server watches these files, so saving is running. Prove out anything that
  drops, renames or rebuilds a table in a scratch database first — an in-memory
  SQLite script is thirty seconds — then write it. Being right two minutes late
  is indistinguishable from being wrong.
- **Back the data file up before schema work**, under a name that does not
  overwrite an existing backup. `data/roadmap.db.bak` is an old one and is not
  a scratch slot.
- Surface architecture tradeoffs as 2–4 named options with one-line pro/con, then
  a recommendation.
- Commit locally as work lands. **Never push or open a PR without approval.**
- Record decisions and open items in `STATUS.md` (gitignored, personal). Requester
  feedback arrives in `comments.md`.
