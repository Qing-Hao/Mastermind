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
.\.venv\Scripts\python.exe -m pytest -q                                   # 144 tests, ~3s
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
| `app/validation.py` | Rules V1–V4 + project summaries. **Pure functions, no I/O.** The heart of the tool. |
| `app/db.py` | Schema, CRUD, `migrate`, export/import. Rows in/out as plain dicts. |
| `app/main.py` | FastAPI routes. Thin — no business logic beyond the V3 block. |
| `app/static/{index.html,app.js,style.css}` | Frontend. Three tabs: Project / Portfolio / Map. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `data/roadmap.db` | The dataset. Gitignored. `.bak` is the pre-migration copy. |

Keep this shape. Extend an existing module rather than adding a file; propose a
structure change before adding anything top-level.

## Data model

`settings` (singleton row) — `default_velocity_points_per_sprint` (20),
`sprint_length_days` (14), `v1_tolerance_pct` (5.0), `department_name`.

`project` — name, description, `goal` (free text, never parsed), `start_date`,
`velocity_override` (nullable), `stage` ∈ `idea|planned|active|done`, `track`
(free text), `tier` ∈ `0|1|2|3`, timestamps.

`stage` is **commitment**, and `planned` is the step between an idea and live
work: the plan is written, nothing is slotted. It reaches the portfolio staging
tray — that is the whole point of it — but earns a swimlane only once its phases
have dates, exactly like an undated `active` project. Do not confuse it with
readiness `scheduled`, which is derived and means the opposite (fully dated);
the readiness value was renamed off `planned` precisely so the two cannot be.

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
5. **V5 is deleted, not dormant.** Deliverables lost their estimates, so the
   rollup had no input. `v5_tolerance_pct` went with it. `PROMPT.md` still carries
   the original V5 prose as the record of what was first asked; its **Amendments**
   section overrides the body text.
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

Velocity = `project.velocity_override` or the global default. Tolerance defaults
to **5%** deliberately: the canonical 6w / 55pts @ velocity 20 case is off by
8.3%, so 20% would never fire.

`validate_plan()` runs V1 and V4 on one project. **V2 lives in
`validate_portfolio()`** — it compares two projects, so it needs every project,
its phases and every dependency. V3 is in neither: it is checked at write time.
`GET /api/projects/{id}` merges the V2 warnings naming that project into its own
list, so both ends of a link see it.

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

## Readiness is derived, and is not `stage`

`validation.project_readiness` returns one of `planning | ready | scheduled |
done`. Two axes, deliberately: **`stage` is commitment** (has anyone decided to
do this), **readiness is how much of the plan exists**. The project picker shows
both — `◌` for an idea, the readiness as a word.

- `planning` — no phases, or a phase with no deliverables under it.
- `ready` — every phase names its deliverables, but the work is not fully dated.
  Same population as the staging tray: a half-placed project stays here.
- `scheduled` — project start date set and no phase missing one. Called
  `scheduled` and not `planned` because `stage` owns that word, where it means
  a plan with no dates — the exact opposite of this value.
- `done` — **taken from `stage`, never inferred**, and it wins over everything
  else. Every phase finished is not the same as the user calling it done.

A deliverable's `done` tick is **not** read here. Presence is a planning fact;
ticking is progress, and reading the tick would make this the tracker rule 4
forbids. Nothing is stored and nothing is repaired — it is a summary like
`project_progress`, not a rule.

`db.list_projects` sorts done last and ideas just above, so the middle of the
list is work in flight. That ordering is shared, so the portfolio swimlanes and
the map's slot order follow it too.

## API surface

`/api/settings` GET PUT · `/api/projects` GET POST · `/api/projects/{id}` GET PUT
DELETE · `/api/projects/{id}/layout` POST · `/api/projects/{id}/phases` POST ·
`/api/phases/{id}` PUT DELETE · `/api/phases/{id}/deliverables` GET POST ·
`/api/deliverables/{id}` PUT DELETE · `/api/dependencies` POST ·
`/api/dependencies/{id}` DELETE · `/api/portfolio` GET · `/api/graph` GET ·
`/api/export` GET · `/api/import` POST.

`GET /api/projects` returns each project with a derived **`readiness`** (see
below). Not stored, and not on the single-project payload — the point of it is
comparing projects before opening one.

`GET /api/projects/{id}` returns the whole plan in one payload: project, phases
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

Export `version` is currently **8**. Bump it when the shape changes and keep
imports tolerant of older files — v2–v7 exports must still import, with absent
fields falling back to defaults and phase-level dependencies translated by
`project_dependencies_from()`. `import_all` is destructive by design and
preserves ids so links survive the round trip; a translated pre-v6 file is the
one case where dependency ids are renumbered, since several phase links can fold
into one project link.

## Views

- **Picker** — the project `<select>` above the tabs. Each option is
  `badge ◌ Name`: `READINESS_BADGE` first (⚪ planning, 🟠 ready, 🟢 scheduled,
  ✅ done), then the ring on ideas only. The badge leads because it is the
  column you scan. They are **emoji, not CSS** — an `<option>` holds no markup
  and cannot be styled portably, so a coloured glyph is the only badge a native
  `<select>` can carry; a real pill would mean hand-rolling a dropdown. The
  legend lives in the select's `title`. `loadPlan` re-reads `/api/projects`
  after every edit so naming the last deliverable retags the option
  immediately; that costs one localhost query and keeps the rule out of the
  frontend.
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
- **Portfolio** — every scheduled phase of `active`/`done` projects on one axis,
  one swimlane per project. Drag a bar to move **only** that phase; snaps to a
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
- **Map** — hand-rolled radial SVG, deterministic layout. Department hub → track
  ring → subtrack ring → project ring, ideas outermost and dashed. Stage reads
  as one vocabulary in three steps on the node itself: an **idea** is hollow and
  dashed, **planned** is hollow with a solid outline (shaped and committed to,
  nothing slotted), **active** is filled. Done is filled grey. A fourth ring for
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

Both charts share one week grid: Monday-based columns under a month/week ruler,
window capped at 26 weeks, column width fitted to the container and clamped
22–64px. A week belongs to the month of its Monday.

## Out of scope

Phase 2 (**documented in `PROMPT.md`, do not build**): sprint generation,
`sprint_goal`, allocating deliverables into sprints, capacity adjustments,
delivery forecast. The only concessions already present are `sprint_length_days`
and velocity in settings.

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
