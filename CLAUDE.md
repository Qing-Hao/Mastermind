# Roadmap Planner

Single-user internal tool for planning software delivery from roadmap → phases →
deliverables. Localhost only. All data in one SQLite file.

**This file is the summary. Read it instead of re-reading `PROMPT.md` (the brief)
and `STATUS.md` (my working notes) unless you need their detail.**

## Stack & commands

FastAPI + SQLite (stdlib `sqlite3`) + vanilla JS. No build step, no ORM, no
migration framework, no auth.

`requirements.txt` carries **one runtime parsing dependency**: `markdown-it-py`
(4.2.0) with `mdit-py-plugins` (0.6.1), for the sprint editor. Not optional and
not lazily imported — the Sprint tab cannot draw a file without them. Both are
pure Python, so there is still no build step. linkify is deliberately **off**:
the `gfm-like` preset enables it and it needs a *third* package (`linkify-it-py`)
that raises at render time when absent.

The frontend has **one dependency and it is vendored, not installed**:
`app/static/vendor/mermaid.min.js` (11.16.1), which draws a ` ```mermaid ` fence
in a sprint file. Committed rather than fetched because the app works offline,
and lazy-loaded because it is 3.4MB — see the Sprint view below. Still no build
step: it is a prebuilt bundle served as a static file.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000   # http://127.0.0.1:8000
.\.venv\Scripts\python.exe -m pytest -q                                   # 315 tests, ~11s

node scripts\map_sweep.js            # map: label/circle collisions, 1000-1530px
node scripts\map_sweep.js --tree     # map: the track hierarchy as drawn

node scripts\wire_check.js           # frontend: ids the JS asks for, index.html lacks

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
| `app/markdown.py` | Splits a markdown file into blocks, renders one to HTML, serialises a table back. **Pure functions, no I/O** — the `validation.py` genre. Knows nothing about sprints. |
| `app/main.py` | FastAPI routes. Thin — no business logic beyond the V3 block. |
| `app/static/{index.html,app.js,style.css}` | Frontend. Four tabs: Project / Portfolio / Map / Sprint. |
| `app/static/vendor/mermaid.min.js` | The one vendored file. Pinned 11.16.1, loaded on demand by the Sprint tab. Nothing else in the repo is third-party JS. |
| `app/static/editor.js` | The Sprint tab's block editor. Its own file because `app.js` is already 2,800 lines; it reads `state`, `api`, `$` and `element` from there. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_markdown.py` | The block model, mirroring `app/markdown.py`. The round trip is the gate. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `tests/test_sprint_review.py` | Sprint script — pure helpers + one `TestModel` run. Offline. |
| `templates/sprint.md` | The sprint template. Copied to `sprints/NN.md` (gitignored). |
| `scripts/sprint_review.py` | Post-sprint LLM review. Optional dep, lazy import, CLI only. |
| `scripts/map_sweep.js` | The map's collision sweep and tree dump. Node, no deps — loads the real `app.js` behind a stub DOM and measures the SVG `renderMap()` emits. **The map has no test suite; this is its verification.** |
| `scripts/wire_check.js` | Runs `bindEvents()` behind a stub DOM and names every id the frontend asks for that `index.html` does not define. Node, no deps. **The frontend has no test suite either; this is the part of it a machine can check.** |
| `data/roadmap.db` | The dataset. Gitignored. `.bak` is the pre-migration copy. |

Keep this shape. Extend an existing module rather than adding a file; propose a
structure change before adding anything top-level.

## Data model

`settings` (singleton row) — `default_velocity_points_per_sprint` (20),
`sprint_length_days` (14), `v1_tolerance_pct` (5.0), `department_name`.

`project` — name, description, `goal` (free text, never parsed), `start_date`,
`velocity_override` (nullable), `stage` ∈ `idea|planned|active|done`,
`track` (free text), `tier` ∈ `0|1|2|3`, timestamps.

`stage` still holds four values but now carries only **three meanings**, because
`validation.project_stage` derives the rest from the plan and the clock:

- `idea` — nobody has committed. Keeps the project off the portfolio.
- `planned` / `active` — **the same thing: committed.** They are no longer
  distinguished anywhere. `planned` is what the UI writes; `active` is what older
  rows carry and reads identically. The ladder works out whether committed work
  is shaped, dated, running or late.
- `done` — the **manual close**, and it beats the ladder outright. Not
  "delivered" but *closed without finishing*: cancelled or descoped work never
  reaches every checkpoint, and without this hatch it would sit `overdue`
  forever until the colour stopped meaning anything.

The CHECK deliberately keeps all four values. Narrowing it would mean rebuilding
the `project` table through `migrate_stage_check`, which has cost a real dataset
once, to buy nothing a reader of this section does not already know.

**`draft_complete` is gone** — dropped at export v10, replaced by the milestone
table below. It was a switch saying "I am done drafting this plan", and it asked
the same question twice: shape the plan, then flip a toggle claiming you had. It
could then go stale, which was documented and accepted rather than fixed. A
checkpoint answers the question with evidence instead of a promise, and unlike
the flag it is worth writing down for its own sake. Its `ADDED_COLUMNS` entry
stays so a file that skipped v9 still converges — see "Schema changes".

`tier` is priority, 1 highest, and **0 is untiered — the absence of a decision,
not a fourth tier**. It sorts last everywhere, is spelt out rather than numbered
in the UI, and existing rows migrate to it rather than to a middle tier: ranking
work nobody ranked would be the tool having an opinion. Nothing derives from
tier and no rule reads it. It exists so the Map can be thinned to what matters —
that is its whole job, and the reason it is a small integer and not a table.

`track` is one column and stays one column. The Map splits it on **every
slash** — `Source Expansion / New Metrics / Network` — and nests to any depth.
That is a frontend convention (`trackPath` in `app.js`), not schema: nothing
validates it, a name with no slash is simply a track, and empty segments are
dropped, so a name with nothing before the slash is a plain track rather than
half a hierarchy.

**The ceiling is the renderer's, not the model's**, and it used to be the other
way round. `splitTrack` cut on the *first* slash and returned `{track, sub}`, so
a third level became part of the second one's *name*: the value above drew a
subtrack labelled `New Metrics / Network` sitting as a **sibling of the
`New Metrics` it belongs inside**. The field is free text and nothing validates
it, so the hierarchy was already stored and already drawn wrongly. Now the model
nests without limit and only the drawing stops — at `MAX_DRAWN_DEPTH` (4),
because ring gaps are the tightest budget on the map and a fifth ring leaves
22px between levels, where labels touch and nothing at runtime can detect it.

A path past the ceiling is **truncated, never folded into a name**. Joining the
tail is the obvious fold and it recreates the exact bug above — a node called
`D / E` sitting beside the `D` it belongs inside, which is what the first
attempt here did and what a synthetic six-deep track caught. So a level that
will not fit is **omitted from the picture rather than misstated**: the node
takes a dashed rim and its tooltip names every stored value folded into it.
None of this needed a column or a track table, which is what the sentence that
used to end this paragraph claimed. Managing a hierarchy still would — renaming
a track is per-project by hand, STATUS item 42 — but storing one never did.

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

`milestone` — `project_id`, name, description, `target_date`, `achieved` (0/1),
`sort_order`. **A checkpoint between phases: what the plan is aiming at, rather
than a piece of work someone does.**

It belongs to the *project*, not to a phase, because a checkpoint routinely sits
between two of them or spans several — hanging it off one phase would make that
unsayable. `target_date` follows the unscheduled convention (`""`, not NULL), so
naming a checkpoint before committing to a date is a real state and simply draws
no diamond. Ordered by `sort_order` like phases and deliverables: order is
arrangement, and an undated milestone has no date to sort on.

**`achieved` is the only stored tick a derived status reads, and that is the
entire reason milestones exist.** The `done` rung used to derive from every phase
carrying `status='done'` — unreachable in practice, since `in_progress` had never
been used once on the real file and 29 of 30 phases sat at the untouched default,
so nothing could finish itself and the only exit was the manual close, a hatch
built for *cancelled* work. The two obvious alternatives were both worse:
deriving from dates silences **V6**, the only rule that has found real late work,
and deriving from deliverable ticks breaks **rule 4**, which keeps those casual on
purpose. A milestone is the one object here designed to carry the decision.

`validation.milestones_all_achieved` guards the count before the ticks, because
`all([])` is True and a project with no checkpoints would otherwise be vacuously
complete — the same 0-of-0 trap that ruled out deriving `done` from deliverables.
The guard interlocks with the promotion gate below: ≥1 checkpoint is what makes a
plan a plan, and that is also what makes "all reached" mean anything.

## Rules that must not be broken

1. **The timeline never auto-reschedules.** Dates belong to the user. Every rule
   reports; nothing repairs. A plan may sit in a warning state forever.
2. **V3 (dependency cycle) is the one exception among the rules** — malformed
   data, not a scheduling opinion. `POST /api/dependencies` returns **409**
   naming the cycle and writes nothing.
   There is now a **second write-time refusal, and it is not a rule**:
   `POST /api/sprints` 409s on a fortnight overlapping a sprint already on disk
   (**a shared handover day is not an overlap** — see the sprint section for why).
   Same reasoning — one team cannot run two sprints at once, so an overlap is
   malformed rather than an opinion — but it guards a *file*, not the plan, so it
   gets no V number and `validate_*` never sees it. Refusing to write a bad file
   is not repairing a good one: no date in any existing file is ever touched.
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
   **This rule survived the milestone work intact, and that was the point of
   milestones**: the completion question got its own object rather than being
   loaded onto a field built to stay casual.
5. **V5 is deleted, not dormant.** Deliverables lost their estimates, so the
   rollup had no input. `v5_tolerance_pct` went with it. `PROMPT.md` still carries
   the original V5 prose as the record of what was first asked; its **Amendments**
   section overrides the body text. **The numbering skips it** — the rules added
   after are V6 and V7, so nothing ever reuses V5.
6. **Dependencies are project-to-project, and phase order is unvalidated.** They
   linked phases until export v6. Losing the intra-project check was accepted
   deliberately, not overlooked: the requester wanted links between whole pieces
   of work. Don't reintroduce phase links without asking.
7. **Promotion is a write, never an inference.** *"An idea is just an idea until
   it is planned."* `stage='idea'` beats every derived rung, so an idea holding
   phases, deliverables and checkpoints still reads `idea` until you press
   **Promote to plan**. The stored value is what the portfolio and map filter on,
   so deriving the promotion would put a `planned` badge on a project absent from
   both. The ≥1-checkpoint gate is enforced by **disabling the button, not by the
   server refusing the write** — the two write-time refusals both guard malformed
   data, and refusing to let you set your own project's stage would be a
   scheduling opinion, which rule 1 forbids. A hand-rolled `PUT` therefore still
   promotes an idea with nothing to aim at, and that is allowed.

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

**The merge runs one way only, and that is now a decision rather than an
oversight.** V2 reaches the project view; V1/V4/V6/V7 do not reach the portfolio.
Running them across every project was built and removed on the requester's call —
FR-2, kept as won't-build. A rule about one project's estimate belongs where that
project is being read.

`validate_plan`'s `today` and `deliverables_by_phase` arguments both default to
`None`, which **skips** V6 and V7 rather than inventing the input. The module is
pure: reading the clock inside it would make every test of it depend on the day
it runs, so the caller passes the date — the same contract `next_phase_boundary`
has always had.

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
and the **milestone list**. Everything else is worked out.

- `idea` — stored. Beats every rung below, so an idea that somehow acquired
  dates still reads as an idea; the portfolio filters on the stored value and
  the two must never disagree. Leaving it is a deliberate press — see rule 7.
- `done` — stored close, **or** every milestone achieved with at least one of
  them. Deriving it is what puts the weight on the checkpoints: finishing a
  project means reaching what it was aiming at.
- `overdue` — fully dated, last phase end passed, phases still open.
- `active` — fully dated, today inside the span.
- `dated` — fully dated, not started.
- `planning` — no phases, nothing named under any of them, or no checkpoint to
  aim at.
- `planned` — work named, at least one checkpoint set, waiting only for dates.

**`phase.status` is no longer read here at all.** It used to derive `done`; that
route was unreachable and the reasoning is under `milestone` in the data model
above. The field now has exactly one job — feeding **V6** and **V7** — which is
worth knowing before changing either, since V6 is the only rule that has found
real late work.

**Dates outrank the planning gate, and the order is load-bearing.** Checking for
checkpoints first reads a project that is dated and running as `planning` merely
because nobody wrote one down — the exact inversion the `draft_complete`
ordering existed to prevent, inherited deliberately by putting the new gate in
the same slot. Once work is on the calendar the calendar speaks for it.

A deliverable's `done` tick is **not** read here, only its presence — see rule 4.
Nothing is stored and nothing is repaired.

A consequence to expect on upgrade: **nothing in an existing file has a
checkpoint, so every committed project reads `planning` until milestones are
added.** That is the gate working, not a regression.

`db.list_projects` sorts done last and ideas just above, so the middle of the
list is work in flight. That ordering is shared, so the portfolio swimlanes and
the map's slot order follow it too. **`GET /api/projects` re-sorts on top of it**,
because `db` can only see the stored stage, which now says `done` for a manual
close alone: a project finished by its checkpoints would otherwise sit in the
middle of the picker among work in flight.

## API surface

`/api/settings` GET PUT · `/api/projects` GET POST · `/api/projects/{id}` GET PUT
DELETE · `/api/projects/{id}/layout` POST · `/api/projects/{id}/phases` POST ·
`/api/phases/{id}` PUT DELETE · `/api/phases/{id}/deliverables` GET POST ·
`/api/deliverables/{id}` PUT DELETE · `/api/projects/{id}/milestones` GET POST ·
`/api/milestones/{id}` PUT DELETE · `/api/dependencies` POST ·
`/api/dependencies/{id}` DELETE · `/api/portfolio` GET · `/api/fortnight` GET ·
`/api/sprints` GET POST · `/api/sprints/{number}` GET PUT ·
`/api/sprints/split` POST · `/api/sprints/table` POST · `/api/graph` GET ·
`/api/export` GET · `/api/import` POST.

The five sprint routes are the sprint editor; see "Sprint planning lives in
markdown files" below for what they may and may not do. `GET /api/sprints` lists
the files for the picker (number, name, mtime, first line, plus the `window` read
back off that line and the `overlaps` it genuinely runs alongside — a shared
handover day is not one); `GET`/`PUT
/api/sprints/{number}` read and write one whole file, the `PUT` mtime-guarded;
`/split` re-splits one edited block, which may have become several or changed
type; `/table` turns an edited grid back into aligned markdown, which is why the
frontend never writes a pipe. `PUT` never creates — a missing number is a 404,
and `POST /api/sprints` is the only thing that makes a file.

`GET /api/projects` returns each project with a derived **`derived_stage`** (see
above), alongside the stored `stage` and never overwriting it — the stored value
is what the portfolio filters on and what a form round trip echoes back, so
collapsing the two would let a derived value be written into the column.
`main.with_derived_stage` tags a list; `/api/projects` and `/api/graph` both use
it.

`GET /api/projects/{id}` returns the whole plan in one payload: project (also
carrying `derived_stage`, unlike the readiness it replaced — the milestone list
lives in this view, and a checkpoint whose effect on the stage you cannot see is
a checkpoint you have to guess at), phases
(with derived dates, `offset_weeks` + deliverables), **milestones**,
dependencies, warnings, settings. Its
`dependencies` are every link the project sits at **either** end of, each
carrying `predecessor_name` and `successor_name` so the view needs no second
fetch. `GET /api/portfolio` carries the same list for the whole dataset plus
every V2 warning, and `GET /api/graph` carries it too — for the map's hover
highlight, not for a permanent edge.

**`warnings` on that route is V2 and nothing else, deliberately.** Surfacing
V1/V4/V6/V7 across the portfolio was built and then removed on the requester's
call — see FR-2 in `feature_request.md`, which is kept as a won't-build entry
because the argument is the only record of the decision. Plan rules belong to the
project view.

`GET /api/portfolio` also returns `unscheduled`: per project, the phases still
waiting for a date, with `total_weeks`, `total_points` and `scheduled_count`.
Built by `main.unplaced_work`; it is what the staging tray is drawn from. And
each project in `projects` carries its own derived facts — `span_start`,
`span_end`, `phase_count`, `total_points` (`main.with_project_span`) plus
`derived_stage` — because the chart draws phases, so the project's own dates were
the one thing on that tab readable nowhere. The span is derived from **every**
phase, dated or not, never from the bars on screen.

`GET /api/fortnight?start=` returns **one fortnight, flattened**: a `window`
and a lane per phase touching it. `start` is optional and snaps back to its
Monday, both dates reported. The bands, the clip flags and the order are all
`validation.fortnight_slice`; the route is assembly and passes `today` in.
**Nothing in the payload sums points** — see the section below.

`POST /api/sprints` copies `templates/sprint.md` to the next `sprints/NN.md`
and fills in the heading. It writes a file rather than a row, and it has **two
callers**: the drawer's `Plan this fortnight →` and the Sprint tab's `New
sprint`. They share `state.plannedSprints`, so one fortnight does not get two
files from one session.

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

Export `version` is currently **10** — it added `milestones[]` and dropped
`draft_complete` from `projects[]`. Bump it when the shape changes and keep
imports tolerant of older files — v2–v9 exports must still import, with absent
fields falling back to defaults and phase-level dependencies translated by
`project_dependencies_from()`. A pre-v10 file has no `milestones` key, so `.get`
returning an empty list is the whole compatibility story, and its projects read
as still drafting — the honest default, since a file written before checkpoints
existed cannot say what it was aiming at. **A v9 file's `draft_complete` is read
and discarded rather than translated**: inventing a checkpoint to carry the flag
across would be making up a target the file never named.
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
  after every edit so naming a deliverable or ticking the last milestone
  retags the option immediately; that costs one localhost query and keeps the
  ladder out of the frontend.
- **Track picker** — the Track field on Project, and the one on the Map's
  Future directions row, share `trackPicker` in `app.js`. It is the **one
  hand-rolled control in the codebase**, and the exception is deliberate: a
  `<datalist>` cannot nest, count or offer a create row, and the nesting is the
  point, since the map draws the same tree. Built from `state.projects`
  and refilled by `refreshTrackPickers` inside `loadProjectList`, so a track
  invented in one field is offerable in the other — nothing is stored, and the
  list is exactly the tracks in use.
  - Levels indented under their parents to any depth, counts being projects on
    that **exact** value. Typing filters every level, and a level stays visible
    when only something below it matches.
  - `/` on a highlighted level drills into it and the panel shows what is under
    it; `Backspace` off a trailing slash pops out one level. Anywhere else a
    slash is just a slash — which is now how a deeper level gets *created*,
    since the model has no ceiling. **`trackTree` deliberately does not fold at
    `MAX_DRAWN_DEPTH`**: the ceiling belongs to the renderer, and a field that
    refused to offer back a value already in the dataset would be the picker
    inventing a rule the data does not have.
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
  warnings, unscheduled list, timeline, **milestone list**, phase table
  with expandable deliverables (`3/5` tally on the phase row), dependencies. The
  dependency panel lists both directions (`← waits on X`, `→ Y waits on this`)
  and links by picking another project plus a direction.
  The **deliverable list is typed straight through**: adding one keeps the
  cursor in the adder, and Enter on a name already in the list lands there too.
  Adding reloads the whole plan — that is what retags the picker badge — so the
  box is rebuilt underneath you and `state.focusAdder` is what puts the cursor
  back; `renderPhases` consumes it after appending, since an input out of the
  document cannot take focus.
  Rows **reorder by dragging a `⠿` grip**, which is its own column because the
  rest of the row is a checkbox and a text field, and a drag surface over either
  would cost click-to-place-cursor inside the name. It writes `sort_order` and
  nothing else — not the tick, not the phase, no date anywhere — the same
  contract as the timeline's phase drag, reusing its `DRAG_ARM_PX` guard and
  renumbering from zero with only the moved rows written
  (`saveDeliverableOrder`, the twin of `saveOrder`). Ordering deliverables is
  arrangement, not state: no rule reads it, so nothing fires.
  The **Stage** field offers three choices — `idea | committed | closed` —
  because those are the only three the ladder does not derive. "Committed"
  writes `planned`; a legacy `active` row reads back as committed, since they
  are the same thing.
  The **milestone list** sits between the timeline and the phases, above the
  work because it is what the work is aiming at. Name, target date, a reached
  tick, a `⠿` grip, and a `2/3 reached` tally beside the heading. It borrows the
  deliverable list's row furniture deliberately — same grip in its own column,
  same tick, same struck-through name — because it is the same gesture on a
  different record and two spellings of one row would drift; reordering writes
  `sort_order` and nothing else, `DRAG_ARM_PX` and all. Nothing about it is
  hidden: it decides the stage while a plan is being drafted, and it is the
  record of what the project is for once it is running.
  **It replaced the drafting switch, which is deleted rather than hidden** — the
  switch asked the same question twice and could go stale afterwards. Two knock-on
  facts worth knowing: `.draft-toggle[hidden]` was cited in three other CSS
  comments as the precedent for the `[hidden]`-versus-`display` trap, and those
  now point at `.direction-link-form[hidden]` and `.track-crumb[hidden]`; and the
  **Promote to plan** button sits in this section head on an idea, *disabled*
  until there is at least one checkpoint, because the gate is the thing worth
  teaching and a button that is not there teaches nothing. See rule 7 for why the
  gate is not a server-side refusal.
  The timeline has two modes, switched by `Dates | Weeks`, and **milestones draw
  as diamonds in a lane above the bars in both** — hollow until reached, filled
  once it is, the same vocabulary the map uses on a project node. A milestone is
  a point rather than a span, so it cannot be a `.bar`: those are block elements
  owning a row, and several points share one line. The two modes measure from
  different origins, which is the subtlety — Dates counts days from the window
  origin, Weeks has no calendar and so measures a stored date against the
  *project's* start, and without one there is no origin at all. That is the
  common case in Weeks mode, since it is what an undated project opens on, so
  those are counted as undated and reported rather than dropped. Two counts, kept
  apart because they are two problems: no date, versus scrolled off screen. Two
  checkpoints a few days apart **will overlap their labels**; the `title` carries
  the full text and thinning them would need measurement this view does not do.
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
  **A lane's title carries the project's own span**, which its bars cannot say
  between them — each bar is one phase, and the project's dates are the question
  this tab exists to answer. `Name / 2026-09-01 → 2026-12-12 · 6 phases · 55 pts
  / 🟢 active`, every number read off the payload. **Never measured from the bars
  on screen**: a lane only draws the phases inside the current window, so
  measuring those would make one project report different dates depending on
  where the chart is scrolled. An undated project says `no dates yet` rather than
  printing blanks.
  **There is no warnings panel here, and that is a decision.** One was built —
  every rule for every project, grouped in swimlane order — and removed on the
  requester's call the same day: warnings stay in the project view. The argument
  is kept as FR-2 in `feature_request.md` rather than lost with the code. What it
  measured on the way through is worth keeping though, and is now FR-19: **V1
  fires on all 30 phases of the real dataset**, so any future surface that lists
  every rule at once has that to solve first.
  **The date you are about to drop on follows the cursor** (`.drag-pill`), with
  the weekday added while `Alt` is held, since coming off a Monday deliberately
  is the only reason to hold it. Both drags already wrote that date into the
  thing being dragged and that is where it failed: a bar is exactly as wide as
  its phase, so at the 22px/week floor a two-week bar is 44px and the text
  clipped to nothing — in precisely the case that needed it. `position: fixed`,
  because the chart sits in a scroll container and `clientX/clientY` are viewport
  coordinates; `pointer-events: none`, because it sits under the cursor mid-drag.
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
  same DOM, tighter metrics, so the drawer and the Sprint tab cannot drift into
  two pictures of one fortnight.
  **Points are drawn whole, on the bar**, and the share of a phase inside the
  fortnight is the bar's width and nothing else. A clipped edge gets a solid
  tab and a chevron rather than the portfolio's dotted edge, because at day
  resolution 3px of dotting is most of a column.
  The drawer **reads the roadmap**, with one exception it owns:
  `Plan this fortnight →` posts to `/api/sprints`, then **closes the drawer and
  hands you to the Sprint tab with the new file open** (`revealSprintFile`).
  What it writes is a markdown file, never a plan. A second press for the same
  fortnight is the thing to guard against — the number comes off the directory,
  so it would make sprint N+1 with the same heading — so once a file exists for
  that window the button reads `Open NN.md →` and opens it instead of posting.
  That lives in `state.plannedSprints`, in memory: after a reload the offer comes
  back, and the file on disk is the real record.
- **Sprint** — the fourth tab: `sprints/NN.md` edited as a **block document**,
  not a textarea. A picker lists the files newest first; each block of the file
  renders as formatted HTML, clicking one swaps in a `<textarea>` holding its own
  raw markdown, and blurring re-renders and saves it. **Autosave on blur**,
  debounced 600ms, whole file per `PUT`, with a three-state indicator —
  saved / saving / **failed** — because a silently failed autosave loses a retro.
  A 409 stops autosaving, says the file changed on disk and offers Reload; it
  **never merges and never overwrites**, and deliberately does not adopt the disk
  mtime, which would arm the next save to overwrite the change it just refused.
  `.sprint-view[hidden]` is load-bearing in the CSS — the **fifth** time that
  trap has come up.
  - **A landed save re-reads the picker** (`refreshSprintFiles`). The File list
    names each file by its *first line*, so renaming a heading left the old name
    showing until you left the tab and came back — `loadSprints` was the only
    thing that re-read it. One localhost query per landed save, the same trade
    `loadPlan` makes to retag a project badge. **Only the picker and the overlap
    line are redrawn**: re-rendering the document would rebuild a block you may
    still be typing in, which is the Chrome blur trap above. It also does not
    adopt the listing's mtime — the save guard is the value the `PUT` quoted back.
  - **An overlap is reported here, never repaired.** Two files covering one day
    cannot both be run by one team; creating that is refused server-side, so what
    this catches is dates edited by hand in a heading. The pair is named once,
    from the lower number, and the editor prints the numbers `GET /api/sprints`
    handed it — it reads no dates itself. `.sprint-overlap` deliberately sets no
    `display`, so the element's `[hidden]` still wins.
  - **A table is a grid of cells, and a cell has two states.** Every other block
    type swaps between rendered HTML and its markdown; a table swaps to cells, so
    raw pipes have nowhere to appear. `Tab`/`Shift+Tab` walk cells
    and `Tab` off the last one grows a row; `+ Row` `+ Column` sit under it on
    hover; and **pasting a spreadsheet range fills from the anchor cell
    outwards**, growing the table to fit. That paste is the feature the editor
    was built for. Editing a table's alignment markers, or turning one back into
    prose, is the raw file view's job.
    Until the checkbox below, this section said a table **"has no reveal gesture
    at all"** — the cells *were* the editor, in one state. That is no longer true
    and the sentence is replaced rather than qualified: an unfocused cell is a
    `.sprint-cell-view`, focusing it swaps in the `.sprint-cell` textarea, and
    blurring swaps back. The forcing reason is mechanical — **a `<textarea>` has
    no insides to click**, its content being plain text with no child elements, so
    a control drawn in one cannot be hit. A cell that can hold a control has to be
    something other than a textarea while you are not typing in it.
    One property keeps the cost contained: the swap is **local** — the `<td>`
    exchanges its one child, never a document re-render, because `Tab` walks cells
    and rebuilding 200-odd of them per keypress is not affordable.
    The two states now mean what they mean everywhere else in the editor —
    **rendered when you are not in it, source when you are** — which is what makes
    the reveal earn itself rather than merely cost something. An earlier draft of
    this feature drew the view as plain source; that was inconsistent the moment
    the cell menu could insert `**bold**` into a surface that then showed
    `**bold**`, and it was replaced rather than defended.
  - **A cell holds more than one line, and the file holds `<br>`.** `Enter` in a
    cell is a line break within it — which is why a cell is a textarea and not an
    `<input>` — and the height follows the text. A real newline cannot reach the
    file: a newline inside a pipe row **is** a new row, so it would split the
    table silently, and GFM has no block content in a cell to put there instead.
    `markdown.CELL_BREAK` is the whole contract, the same shape `MERMAID_CLASS`
    has: `_escape_cell` writes it, `cellText` reads it back, and a cell already
    holding one survives untouched so an unedited table stays byte-stable. Read
    leniently — `<br/>`, `<br />`, any case, because a file you hand-edit holds
    whichever you typed — and written in exactly one spelling. Pasting is
    deliberately unchanged: a one-column range is still rows, and `Enter` is how a
    second line goes into a single cell.
    A consequence to expect: a `<br>` typed by hand into an older file now shows
    as a line break in the grid. That was accepted as being what it says.
  - **A cell line can be ticked, and the tick lives in the cell's text.** Two
    spellings are drawn as a checkbox and **`- [ ]` is the one that gets written**;
    `☐`/`☑` are read only, and a tick on one keeps it a glyph — the spelling
    belongs to the line, not to the editor. One written spelling was the
    requester's call, on the ground that both draw the same box. Worth knowing
    rather than arguing with: `- [ ]` **inside a cell is literal text to GFM** (a
    cell is inline content and the tasklists plugin only rewrites list items), so
    GitHub, an IDE preview and `sprint_review.py`'s model all see the characters
    rather than a box. The box is this grid's affordance over ordinary text, which
    is exactly why it costs the file nothing: `- [x] schema` is a string.
    Ticking rewrites that line of the **cell**, never `block.raw`: `raw` is
    regenerated from the grid by `serialise_table` on every save, so a tick
    written there would be gone by the next debounce. `toggleSprintTask`, which
    does write a line of `raw`, is therefore for task-list *blocks* only and the
    two do not share a path. Nothing derives from either — a sprint file's ticks
    are not roadmap state.
    `Ctrl+Enter` in a cell is the same flip from the keyboard, and on a line with
    no marker it **adds** one, so it starts a checklist as well as maintaining
    one. A mouse-only control in a surface you type into would be the gap.
    **What stays refused is emitting `<li>` or `<input type="checkbox">` into the
    file.** It would render, because `html=True`, and then the tick would have no
    persistence path at all, the grid would have to parse HTML back out to stay
    editable, and the file would stop being markdown a person can hand-edit.
  - **The view renders four inline constructs, and it is the second thing drawn in
    the browser rather than in Python.** Bold, italic, code and a link — *exactly*
    what `CELL_MENU` can insert, and nothing else. The discipline is the point:
    this is not a markdown renderer and must not grow into one. `markdown.py`
    renders the file.
    The reason it is client-side has the same shape as mermaid's without being the
    same reason: **the grid is live.** `block.table` is the client's copy and a
    keystroke changes it, so anything drawn from it must be drawn locally or it is
    stale the moment you type; asking the server would be a request per cell blur
    to redraw text the client already holds. Nodes are built with `textContent`,
    never `innerHTML`, so a cell holding `<script>` holds the characters.
    Three deliberate omissions, each a decision rather than a gap: **no underscore
    emphasis**, because `sprint_length_days` and
    `default_velocity_points_per_sprint` are words this project's own files are
    full of and CommonMark's intraword rule is subtle enough that getting it
    slightly wrong mangles them; **raw HTML stays text**, so `<u>` in a cell shows
    as `<u>` even though the file renders it, because a grid that executes markup
    out of a cell is a worse thing than one that under-renders; and **no
    linkify**, which the app turns off everywhere. A URL scheme other than
    `http`/`https`/`mailto` is left as text rather than made a link.
    Where the grid and the file disagree, **the file is right and `Raw file` is
    how you see it.** That is this feature's cost, stated rather than buried.
  - **`/` in a cell opens a second, inline-only menu.** It cannot be the block
    menu: six of those nine entries are block constructs, and `pickSprintMenuItem`
    inserts one by replacing the whole block and re-splitting it — fired from a
    cell, that replaces the table itself with `- [ ] `. So `CELL_MENU` carries only
    what a GFM cell can hold — checkbox, line break, bold, italic, code, link —
    and its pick inserts text at the caret. `sprintMenu.pick` is what makes one
    menu serve both: same rendering, same filtering, same keyboard, two meanings
    of "insert".
    The trigger is read **per line**, not per box, because a cell holds several
    lines: `/` at the start of the caret's line with nothing but the filter after
    it. That matters more here than in a block — `1/2`, `n/a` and
    `Source expansion / Metrics` are all ordinary cell values.
  - **Rows and columns are inserted, deleted and moved where they are**, from a
    `⠿` grip beside every row and above every column: drag it to move that one,
    click it for `Insert before` / `Insert after` / `Delete`. It replaced
    `− Row` / `− Column`, which popped the end — so a row that belonged third
    cost a retype of everything below it, in the one table the editor exists to
    make easy to fill in. The drag is armed from the grip alone (and disarmed
    again by the click that opens the menu, or a press in a cell would drag the
    row), and every table event **stops propagating**, because the grid sits
    inside a `.sprint-row` whose own handlers would otherwise reorder the whole
    block. Deleting the last column stays forbidden; the header row has no grip
    at all, since GFM has no table without one.
    **A column is its cells *and* its `align[]` marker** — the one correctness
    trap here, because a marker left behind silently right-aligns a different
    column and the file still round-trips perfectly. A ragged table is squared
    up before any structural edit, which writes nothing `serialise_table` would
    not have padded anyway and is what makes "column 3" the same cell on every
    row. Still no endpoint and no file-format change: these rearrange the grid,
    and the file has always been written from the grid.
  - **`New sprint` lives here too**, beside the picker: a date, `POST
    /api/sprints`, then `revealSprintFile`. The tab that owns sprints could not
    make one — the only path was a week number on the Portfolio ruler that
    nothing marks as clickable, and that path does not exist at all for a
    fortnight outside the chart's window. It is **dates only and reads no
    roadmap**: the drawer is the roadmap-aware path, and duplicating it would
    put roadmap knowledge in a tab that has none. The number is still the
    server's, off the directory, and a 409 re-reads the picker and says which
    file it refused to overwrite — or which sprint's days the fortnight you asked
    for would have overlapped, since both refusals arrive as a 409 and the
    server's message is what distinguishes them. It shares `state.plannedSprints`
    with the
    drawer, so pressing both for one fortnight opens the file instead of making
    a second one — in memory, which is why the 409 still has to be handled.
    **The date box prefills with the latest sprint's end date** — its handover
    day, which is the next sprint's start — so continuing the cadence is one
    press. `latestSprintHandover` reads it off `state.sprint.files[0]`, newest
    first, the same "highest number on disk" reading `next_sprint_number` uses.
    That is the *file listing*, already loaded for the picker, not the roadmap,
    so "reads no roadmap" above still holds. A heading with no readable window
    has no cadence to continue, so it falls back to today rather than guessing —
    `sprint_window_from_heading`'s stance. `createSprintFile` empties the box on
    a landed create, which is what re-offers the new handover day; only an empty
    box is ever prefilled, since this runs on every render and would otherwise
    undo a date you had just picked.
  - **Grids become markdown inside the save, not on cell blur.** Blur would leave
    a window where the autosave fires first and writes a stale table; as the
    save's first step it cannot be written stale, and it costs one request per
    debounce instead of per keystroke. `block.table` stays the client's live copy,
    so a cell being typed into is never overwritten under the cursor.
  - Two frontend traps worth knowing, both found in a browser. Chrome fires
    `blur` when a focused element is **removed** from the document, so a
    re-render while a block was open committed the box it was about to destroy,
    over what the render was drawing — `renderSprintDocument` detaches the
    handler before wiping. And `state.sprint` is **mutated, never replaced**: a
    commit in flight holds a reference to it, so swapping in a fresh object left
    the splice landing nowhere with nothing reporting it.
  - `Esc` **commits** rather than cancels. With the file as the record and the
    save automatic there is no cancel story to tell, and undo is typing it back
    — so there is one way out of a block, not two.
  - **`/` on an empty block opens an insert menu** — nine block types, filtered
    as you type, arrows and `Enter` to pick, `Esc` to close without inserting.
    (Inside a table cell the same key opens the inline menu described above
    instead, because none of these nine can live in a cell.)
    Every entry is a **markdown snippet** put through the same `/split` any other
    edit uses, so nothing builds a block by hand, and **not one of the nine is a
    sprint concept**: the table is an empty two-by-two, not a capacity table.
    `Enter` at the end of a block opens an empty one below it and `Backspace` in
    an emptied block removes it — those two exist because without a way to *make*
    an empty block the menu has no path to it.
  - **The foot of the document is always a place to start a block**, not only when
    the file is empty. It used to appear at `blocks.length === 0` alone, which left
    **a file ending in a table with no gesture anywhere that added a block after
    it**: a table has no textarea, so the `Enter` above cannot happen, and `Tab`
    off the last cell grows a row instead of leaving. Fixing the class rather than
    the instance — the target knows nothing about tables, so it cannot rot.
    The gaps are `removeSprintBlock`'s rule in reverse: **the last block owns the
    file's trailing newline**, so an appended block inherits it and what used to be
    last is given a blank line, which a single newline cannot substitute for — two
    paragraphs joined by one re-read as one paragraph. An empty block committed
    empty is taken back out and the newline handed back, so clicking the target and
    changing your mind writes nothing. Only these gestures make an empty block; the
    splitter never returns one.
  - **A gutter rail** carries what the block is and a `⠿` grip that reorders it.
    `draggable` is armed from the grip alone, so a press anywhere else still
    places a cursor — the same conclusion the deliverable list reached, by a
    different route: there the drag is hand-rolled because the row had to stay
    clickable, here HTML5 drag-and-drop is free because only the handle is ever
    draggable.
  - **Reordering reasons about `gap`s rather than carrying them along.** A gap
    separates a block from the *next* one, so moving a block moves the wrong
    separator with it — and two paragraphs joined by a single newline re-read as
    **one** paragraph, which would merge two blocks while claiming to move one.
    Only the adjacencies a move actually changed are given a blank line, every
    other separator is left exactly as it was (invariant 2), and whichever block
    ends up last inherits what used to end the file.
  - **`Rendered | Raw file`** switches between the document and the whole file in
    one textarea. Blurring the textarea re-splits the document from it — safe
    because `/split` is the same splitter that read the file. `Esc` leaves the box
    *before* the view, since the blur is what re-splits and switching away first
    would drop the edit. It is also the only way to edit a table's alignment
    markers or turn a table back into prose, which is why a table needs no reveal
    gesture of its own.
  - **Ticking a `- [ ]`** rewrites that line in the block's own markdown and
    saves. It needed `enabled=True` on the tasklists plugin, whose default is a
    `disabled` checkbox. Nothing derives from a tick — a sprint file's ticks are
    not roadmap state, and no rule reads them.
  - **A ` ```mermaid ` fence is drawn as a diagram**, one of the **two things the
    app renders in the browser rather than in Python** (a table cell's inline
    markup is the other, for a different reason — see the grid above) — drawing
    needs a DOM
    and text measurement, so `markdown.py` stops at
    `<pre class="mermaid-source">` holding the escaped source and `editor.js`
    turns it into an SVG. The class name is the whole contract between them.
    The library is **vendored, not fetched**: `app/static/vendor/mermaid.min.js`,
    pinned, 3.4MB, the first vendored file in the repo. A localhost tool that
    works offline is the premise, and a CDN tag would quietly end it — hence the
    test that no frontend file names an external origin. It is injected **once
    per page life and only when a diagram is on screen**, so a sprint file
    without one costs nothing.
    **A diagram that will not parse keeps its source**, dashed, with one amber
    line under it — the same state the tab was in before this existed, which is
    also where a missing bundle lands. Results are cached by the fence's own
    text, successes and failures alike, so re-rendering the document redraws
    nothing: a fixed diagram is a different key, and nothing needs invalidating.
    The `<pre>` is **replaced, never `[hidden]`** — the sixth time that trap has
    come up. Clicking a diagram opens its fence like any other block; the rail
    reads `mmd`, because the server types every fence `code` and `mermaid`
    measures wider than the 46px gutter.
- **Map** — hand-rolled radial SVG, deterministic layout. Department hub → one
  ring per level of the track hierarchy → project ring, ideas outermost and
  dashed. The levels are a table (`RING_FRACTIONS`) keyed on how deep the map
  actually goes, shared by the whole picture rather than fitted per track —
  different tracks placing their levels at different radii would stop the rings
  being rings. Depth 2 is the 0.36/0.48 the two hard-coded constants used to
  carry, so a map with no third level anywhere draws exactly as it did before.
  Nodes are
  styled off **`derived_stage`**, so the picture ages by itself: a project that
  starts next week stops looking un-started on the day it starts, with nobody
  editing a field. Stage reads as one vocabulary on the node — **idea** hollow
  and dashed, **planning** hollow with a light outline, **planned** hollow with
  a solid one (shaped and committed to, nothing slotted), **dated** pale-filled
  (on the calendar, not begun), **active** filled, **overdue** filled with a
  heavy warning outline, **done** filled — **green where every checkpoint is
  reached, grey where it is not**. Overdue keeps a live project's
  filled body and spends its difference on the stroke, rather than inventing a
  fifth fill.
  **Green is the one place the map splits a rung in two.** `done` is reached
  two ways — every milestone achieved, or the manual close — and the data model
  is explicit that the stored close is *"not delivered but closed without
  finishing"*, as often cancelled or descoped as done. So the green is derived
  the same way the ladder derives the rung, off the **milestone** tally
  (`milestones_reached` / `milestones_total` on `GET /api/graph`), and only
  all-reached earns it; a close with checkpoints outstanding keeps the grey it
  always had. Painting a cancelled project as a success is worse than leaving
  it uncoloured.
  **This read the phase tally until the ladder moved onto checkpoints**, and
  leaving it there would have been wrong in both directions: a project that
  reached every checkpoint with phases still open would have been painted grey,
  and a cancelled one whose phases happened to be ticked would have been painted
  green — exactly the case the split exists to prevent. The phase tally stays on
  the label and in the tooltip, because how much of the *work* is finished is a
  different question from whether the project arrived.
  On the real dataset this currently colours **nothing**, since nothing has a
  checkpoint yet. A fourth ring for
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
  the ring gap that is thinnest on the short vertical axis, every row of
  `RING_FRACTIONS` starts at 0.36 to open the first gap, and none reaches past
  0.625, which is where a 38px node on the project ring starts reaching back.
  That band is what runs out at five levels: it holds four with 29px between
  them and five with 22px, and a level needs its dot plus `LABEL_GAP` plus
  `LABEL_LINE` — about 25px.
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
  **Track is a hue, and it stops at the inner rings.** Every level of the
  hierarchy, its label and the spokes between them carry one colour per track,
  keyed off the **root** of the path — so nesting spends nothing from the eight,
  and depth is a *tone* of the root's hue rather than a hue of its own. That is
  what keeps a dataset already holding eight top-level tracks from running out
  of colours the moment one nests deeper.
  `LEVEL_TONES` is a **fixed** ramp — `0, 0.45, 0.62, 0.72` mixed towards white,
  level 2 being the 0.45 the subtrack ring always used — rather than one spread
  over whatever depth a track happens to reach. An allocated ramp would shift
  every tone above a node the moment somebody added a child, which is the
  "adding data moves a colour" complaint `trackPalette` is keyed off the whole
  dataset specifically to avoid. Running out at four is a feature: the tone
  ceiling and the ring ceiling become one number to explain instead of two.
  **Only the dot takes a tone; labels keep the full hue at every depth.** That
  is what leaves `TRACK_HUES`' 3:1-on-white floor untouched by nesting —
  measured, the ramp runs 3.06 → 1.78 → 1.47 → 1.33 on the palette's weakest
  entry, so a lightened *label* would have walked through the floor by level
  two. A level-4 dot at 0.72 is faint (1.33:1) and accepted: dot radius and font
  size carry the hierarchy alongside the tone, and nothing in the dataset is
  four deep.
  The spokes out to the projects stay grey and **no hue reaches a project node** —
  `derived_stage` owns the fill and stroke out there, and a second colour axis
  on the same circles would not add a vocabulary, it would destroy the one
  there is. Colour arrives as `--track-dot` / `--track-text` / `--track-edge`,
  set inline because a track is free text and the hue is a value rather than
  one of a fixed set of classes; it has to be `style` and not a `fill`
  attribute, since the CSS rule outranks the attribute. Every variable falls
  back to the grey it used to be hard-coded to.
  `TRACK_HUES` is **eight and bounded** — distinguishable colours are, and
  free-text tracks are not — so a ninth track takes the grey rather than a hue
  nobody could tell from another. The eight were picked by maximising the worst
  pair under protanopia, deuteranopia and tritanopia with a 3:1 floor on white,
  hue being the only cue carrying track identity and the ring labels being
  drawn in it. **The order is load-bearing**: wedges lay out in sorted track
  order, so slots N and N+1 land side by side, and sequencing for the weakest
  *neighbouring* pair lifts it from 17 to 36. One green only, because two were
  the weakest pair and green now means delivered on a project node.
  `trackPalette` keys off **every track in the dataset, not the tracks drawn** —
  the tier filter runs before `mapGroups`, so a track can leave the map
  entirely, and keying off what is drawn moves twelve colours the moment you
  hide a tier. Counting off the whole dataset is what the tier chips already
  do, for the same reason. Adding a project never moves a colour; adding a new
  track only moves the tracks after it alphabetically.
  **Tier is the crowd control.** Above the canvas, `renderMapFilters` draws
  **two captioned groups** — `Tier` (`T1 T2 T3 untiered`) and `Status` (`done`)
  — kept apart because they answer different questions: how much of the ranking
  to draw, and whether finished work is on the picture at all. In one row the
  status chip read as a stray fifth tier.
  Every chip is counted off the whole dataset so it still says what is behind it
  while it is off. Tiers are all on by default because a filter that hides work
  by default loses it. **`done` is the one that starts off**, and the exception
  rests on a different fact rather than overriding that rule: a hidden tier is
  live work you have stopped looking at, while a hidden `done` project is work
  there is nothing left to do about. The map answers "where is the team
  pointed", and finished work has no bearing on the answer. It is not lost —
  the chip counts it while it is off, so the map says how much it is not
  showing. It hides the **whole rung**, the green and the grey alike: the nodes
  tell delivered from closed, the filter has no reason to.
  A consequence to expect: a track whose only projects are finished leaves the
  map by default, the same way an emptied tier does. On the real dataset that
  is `UX`.
  Filtering happens **before `mapGroups`**, so a
  wedge is sized by what is actually drawn and a track with nothing left in it
  leaves the map entirely — hiding the noise is what widens the room around
  what remains. It does **not** reach `trackPalette`, which is keyed off the
  whole dataset, so hiding finished work never moves a colour.
  Turning every tier off is allowed and says so on the canvas.
  Lives in `state.mapTiers` and `state.mapDone`: both survive re-renders and tab
  switches but not a
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

**Today is marked on the grid**, in the project timeline's Dates mode and on the
portfolio: a 2px line in the grid body plus the current week's ruler cell drawn
in ink rather than grey. It is the **third view of one marker** — the drawer's
strip has had `.slice-today` all along — so it inherits that component's rules
rather than inventing a second vocabulary: grey and not red, since red means
*late* in these charts and today is not a problem, and **absent rather than
clamped when today is outside the window**, because a line at an edge reads as
"today is here". The one difference is that this line takes **no pointer
events**, so it loses the strip's tooltip: it lies over bars whose whole gesture
is dragging, and a 2px column that swallows a `mousedown` costs more than a
tooltip buys. The ruler cell does the naming instead, and is the bigger target
anyway. It is appended **before** the milestone lane — both are positioned, so
DOM order is what stops a diamond's label being cut — and `.week-now` is weight
and ink with no background, because on the portfolio ruler the same cell can also
be `.week-open`, which owns the indigo wash there.

**Weeks mode has no today line**, and that falls out of the structure rather than
being special-cased: it counts weeks from the project start, so it has no
calendar to place a date on, and it swaps in `relativeRuler`.

## Sprint planning lives in markdown files, not in the schema

Third step after Project and Portfolio. `templates/sprint.md` is copied to
`sprints/NN.md`, one file per fortnight; `sprints/` is gitignored, like `data/`.
There is **no sprint table, no sprint column and no export bump** — nothing for
`migrate()` to do, and nothing in this feature touches `db.py` at all.

**The app now edits those files.** It did not until 2026-08-13, and an earlier
version of this section said the sprint endpoint "parses nothing, reads nothing
back, and never lists or edits a sprint" — that is no longer true of any of the
three clauses. What is still true, and is the whole point, is that **the markdown
file is the one record**: the editor is a view over the file, not a second store.

`POST /api/sprints` still only copies the template to the next `sprints/NN.md`
and replaces the first line with `# Sprint N · YYYY-MM-DD → YYYY-MM-DD`.
`SPRINTS_DIR` and `SPRINT_TEMPLATE` are module level in `main.py` so a test can
point them at `tmp_path`, the same shape as `db.set_db_path` — **no test may
reach the real `sprints/`**, which holds work actually done.

- **The window is the date you asked for, and it ends on the handover day.**
  `sprint_window` in `main.py` — **nothing snaps.** The cadence is the team's own
  (planning happens on the sync day, a Wednesday here), so a Wednesday start stays
  a Wednesday. `validation.fortnight_window` still snaps to a Monday and must:
  that one frames the **drawer's strip**, which is drawn on Monday-based week
  columns. A chart window and a file heading are different things, and this is
  why the two functions exist separately.
  `end` is `FORTNIGHT_DAYS` past the start rather than one day short of it, so it
  lands on the day the next sprint begins — the `17 Jun → 01 Jul`, `01 Jul →
  15 Jul` convention. Continuing a cadence therefore means asking for a fortnight
  starting on the previous sprint's end date, which the boundary allowance below
  is what permits.
  The cost, accepted: the drawer and the Sprint tab both post here, so a
  drawer-created sprint also ends a day past the strip it was planned from — the
  strip's last column is the last *working* day, the heading's end is the
  *handover* day. One convention reading a day long on a chart beats two
  conventions in one app.

- **One team runs one sprint at a time, so overlapping windows are refused.**
  `POST /api/sprints` reads each file's window back off its first line and 409s,
  writing nothing, if the requested fortnight shares **more than a boundary day**
  with one. Back to back is fine both ways: one ending the day before the next
  begins, and one ending **on** the day the next begins. The shared handover day
  is the convention the sprints are actually written in (`17 Jun → 01 Jul`, then
  `01 Jul → 15 Jul`) and it is a planning-and-retro day, not two sprints running
  at once. `windows_overlap` is therefore `<` on both sides rather than `<=` —
  comparing an inclusive end strictly is the same test as a half-open interval,
  so a single touching endpoint falls through while a nested one-day window does
  not. **Every window this app generates now lands exactly on that boundary**, so
  the allowance is what makes a second sprint creatable at all rather than a
  concession to headings edited by hand — see `sprint_window` below. The
  strictly-back-to-back case (ending the day *before*) is the one that now only
  arrives by hand. `GET /api/sprints` also
  reports `overlaps` per file, because refusing creation leaves exactly one way
  in: dates edited by hand afterwards, which the app does not own and will not
  rewrite. `sprint_window_from_heading` is **the only thing in the app that reads
  a sprint file for meaning**, and it lives in `main.py` because `main.py` is what
  writes that line — `markdown.py` and `editor.js` still know nothing about
  sprints, so the gate condition is untouched. Reading is lenient like
  `as_optional_date`: one date, no dates or a backwards pair is **no window**, and
  a file with no window blocks nothing and overlaps nothing. Guessing would refuse
  a real sprint on the strength of an invented fortnight.
- **Numbering is next after the highest leading number on disk**, never
  lowest-unused: a gap is a sprint that was skipped or a file that was deleted,
  and neither is an invitation to reuse the number. Same reading as
  `sprint_review.sprint_sort_key`, so the script, the button and the editor agree
  about which file is sprint 4. `sprint_path` resolves a number **against the
  directory** rather than formatting a filename, so `04-retro.md` is reachable as
  sprint 4 and no request string ever becomes a path.
- **The number never comes from the request body** — it comes from the directory
  on create and from the path on read and write.
- The file is created with mode `"x"`, so the existence guard and the write are
  one operation. An existing target is a **409**, never an overwrite.
- **A save never overwrites a file that changed on disk.** `PUT` quotes back the
  `mtime` it was given and a stale one is a **409** carrying the disk value —
  never a merge. `sprint_review.py` reads these files and you will edit them by
  hand, so the app is not entitled to decide whose version wins.
- Writes are **atomic**: a temp file beside the target, then `os.replace`. Both
  ends open with `newline=""`, because on Windows the default would translate
  every `\n` to `\r\n` and rewrite the whole file the editor promised not to
  touch.

### The block model — `app/markdown.py`

A file is a list of blocks, each carrying **its own raw markdown** plus the
`gap` that separated it from the next one. So there is **no round-trip parser**:
`join_blocks(split_blocks(text)) == text` byte for byte, and the serialiser for
prose is the identity function. That guarantee is tested against
`templates/sprint.md` and **every** `sprints/*.md` on disk, so a new sprint file
is covered the day it exists.

- `gap` is what makes the round trip exact rather than nearly exact. Joining with
  `\n\n` unconditionally fails on the template itself, which writes
  `**<u>Deliverable</u>**` directly above its task list; every line of the input
  belongs to exactly one block's `raw` or one block's `gap`, and CRLF rides along
  for free.
- `html` is **display only**. Nothing is ever parsed back out of it.
- **Tables are the one deliberate exception to "prose is never rewritten"**, and
  the reformatting is the feature: a table's grid is authoritative and `raw` is
  regenerated by `serialise_table`, which pads every column to its widest cell
  and pads a cell to its column's **side**, so a right-aligned column's numbers
  line up in the file as well as on screen. A save only rewrites the tables that
  were actually edited.
- A pipe row is a table only when the delimiter row **matches the header's column
  count** (GFM's rule). Being lenient would mean `serialise_table` rewriting rows
  nobody touched — and the template's baseline table has an empty header row.
- `html=True` is on, for the `<u>` and `<details>` the template relies on. This
  is your own file on localhost with no untrusted input; revisit only if a sprint
  file ever holds content from outside.
- **It knows nothing about sprints.** No section is recognised, no point counted,
  no category validated — any pipe table in any markdown file gets the same
  treatment. That is deliberate and load-bearing: see the gate below.

### Why the sprint-4 gate was overridden

The staging decision was **revisit at sprint 4**, on the grounds that *"the
schema and the editor get designed against what the columns actually turn out to
hold."* `sprints/` held one file when the editor was built, so the gate was
overridden rather than met — knowingly, on one condition.

The schema half of that risk is **absent from this feature entirely**: no table,
no column, no `migrate()` step, no export bump. The half that could still trip
the gate is an editor that knows what a capacity table is, so **it must not**.
The test a future reader can run: no string from `templates/sprint.md` appears in
`app/markdown.py` or `editor.js`. Under that condition it is a markdown editor
that happens to open sprint files, and **sprint 4 still decides the storage
question with nothing committed to it**.

What is still deferred to that decision: a sprint table, a `sprint_goal` column,
export v10, and anything that allocates deliverables into sprints.

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
deliberately: sprint planning and post-sprint analysis exist as the markdown
template, the review script and the Sprint tab above, and the fortnight drawer
reads a fortnight of the roadmap. Still not built, and still not to be built
without asking: sprint generation from a project's date range, `sprint_goal` as a
column, allocating deliverables into sprints against velocity, and the delivery
forecast. The concessions in the app itself remain `sprint_length_days` and
velocity in settings, plus the drawer and the editor — **and the editor holds no
sprint data**, because it holds no data at all: every byte of it lives in a file
you could edit in Notepad instead.

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
- **Deleting an element from `index.html` is a frontend migration**, and nothing
  fails loudly when you get it wrong. `bindEvents()` addresses about a hundred
  ids; a `$()` that finds nothing returns **null**, the next property access
  throws, and every handler wired after that line silently never happens —
  including the boot call, which is the last statement in `app.js`. Run
  `node scripts\wire_check.js`. The tests are API-level and never load the page,
  and `map_sweep.js` cannot see a null by construction.
- **Back the data file up before schema work**, under a name that does not
  overwrite an existing backup. `data/roadmap.db.bak` is an old one and is not
  a scratch slot.
- Surface architecture tradeoffs as 2–4 named options with one-line pro/con, then
  a recommendation.
- Commit locally as work lands. **Never push or open a PR without approval.**
- Record decisions and open items in `STATUS.md` (gitignored, personal). Requester
  feedback arrives in `comments.md`.
- **A built feature request is deleted from `feature_request.md`, not marked
  built.** The commits and `STATUS.md` are already the record of what shipped and
  why; a backlog that also carries it stops being a list of what is left and
  becomes a second, staler history of what is done — and the two drift. Keep only
  what still needs developing. **The FR numbers are never reused**, so a gap in
  the sequence means built: find it in `git log` and `STATUS.md`.
  Two things stay in the file: **won't-build** entries, because no commit records
  a decision *not* to build and the argument is the whole artefact, and anything
  still open about a built feature — a follow-up, a deferred half, an unmet gate
  — reopened under its own number rather than left inside the closed entry.
