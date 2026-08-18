# Mastermind

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
.\.venv\Scripts\python.exe -m pytest -q                                   # 342 tests, ~7s

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
| `app/static/{index.html,app.js,style.css}` | Frontend. A sidebar + top bar shell around four views: Project / Portfolio / Map / Sprint. |
| `app/static/vendor/mermaid.min.js` | The one vendored file. Pinned 11.16.1, loaded on demand by the Sprint tab. Nothing else in the repo is third-party JS. |
| `app/static/editor.js` | The Sprint tab's block editor. Its own file because `app.js` is already 2,800 lines; it reads `state`, `api`, `$` and `element` from there. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_markdown.py` | The block model, mirroring `app/markdown.py`. The round trip is the gate. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `tests/test_sprint_review.py` | Sprint script — pure helpers + one `TestModel` run. Offline. |
| `templates/sprint.md` | The sprint template. Copied to `sprints/NN.md` (gitignored), and editable in the Sprint tab like a sprint file. |
| `scripts/sprint_review.py` | Post-sprint LLM review. Optional dep, lazy import, CLI only. |
| `scripts/map_sweep.js` | The map's collision sweep and tree dump. Node, no deps — loads the real `app.js` behind a stub DOM and measures the SVG `renderMap()` emits. **The map has no test suite; this is its verification.** |
| `scripts/wire_check.js` | Runs `bindEvents()` behind a stub DOM and names every id the frontend asks for that `index.html` does not define. Node, no deps. **The frontend has no test suite either; this is the part of it a machine can check.** |
| `.design/*.dc.html` | The UI as artboards — `Current`, `Option 1 — Reskin`, `Option 2 — Reskin + shell rebuild` — plus `canvas.json`, which holds their layout and the notes arguing each one. What shipped is Option 2; see **The look**. Source only: the 2.2MB published canvas beside them is gitignored. |
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

**That `sort_order` is now shared with `phase.sort_order`** — one number line, so
the project view can draw the two interleaved and you can put a checkpoint where
it belongs between two phases. `db.next_plan_sort_order` is the only thing here
that knows: it reads the `MAX` across both tables so a created row of either kind
lands last in the sequence. Nothing **validates** the line — no rule reads the
order, so ties and gaps are well-formed — and there is still no `phase_id` on a
milestone, which is the whole reason a checkpoint spanning several phases is
sayable. See the Project view under "Views".

**`achieved` is the only stored tick a derived status reads, and that is the
entire reason milestones exist.** The `done` rung used to derive from every phase
carrying `status='done'` — unreachable in practice, since `in_progress` had never
been used once on the real file and 29 of 30 phases sat at the untouched default,
so nothing could finish itself and the only exit was the manual close, a hatch
built for *cancelled* work. (That measurement was 2026-08-14 and the first half
of it has since expired: one phase now carries `in_progress`. The second half
holds — 32 of 39 at the default on 2026-08-17 — so the conclusion stands, but
**do not re-quote "never used once"**; FR-21 carries both readings.) The two obvious alternatives were both worse:
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
   **Two charts now read the tick, and both read it to *draw*, never to derive**
   — the portfolio's collapsed swimlane fills a bar with it and a map node fills
   from the bottom with it (`validation.completion_fraction`, and see the two
   views below). That is the standing `fortnight_lane`'s `done` has always had —
   "so it can be shown, never so anything can be derived from it" — and the line
   the rule draws is unchanged: no rule reads it, no stage reads it, nothing is
   written back. The honest cost, stated rather than discovered later: a field
   built to stay casual is now visible on two charts at once, which is pressure
   on it even though nothing depends on it.
   **The tick is the detail inside a frame the phases set**, not the measure on
   its own — a phase owns an equal share of its project and its deliverables
   fill that share. A first cut read the ticks flat and was wrong in a way the
   real file demonstrated: `Transaction Graph Fix` had 2 of 2 deliverables ticked
   under 1 of its 3 phases, so a flat read called it two-thirds done. See
   `completion_fraction` for the full argument and the three rules it needs.
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
`/api/sprints/split` POST · `/api/sprints/table` POST · `/api/template` GET PUT ·
`/api/graph` GET ·
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
and `POST /api/sprints` is the only thing that makes a file. `GET`/`PUT
/api/template` are the sixth and seventh, and the same two verbs on the one file
that is not a sprint — see below.

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
dependencies, warnings, settings.
The project also carries **its own derived facts** — `span_start`, `span_end`,
`phase_count`, `total_points`, `phases_done`, the two deliverable tallies and
`completion` — from the **same `with_project_span`** the portfolio route uses, so
the two routes cannot disagree about one project. The top bar prints the span, and
it is here rather than derived in the frontend because
`validation.project_span` owns that arithmetic. The flat deliverable list is read
once and used twice on this route — for the ladder and for the span — the same
shape the portfolio route has; those rows are `deliverable.*` off a join, so they
carry `phase_id` and `completion_fraction` can regroup them.
Its
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
`span_end`, `phase_count`, `total_points`, `deliverables_done`,
`deliverables_total` (`main.with_project_span`) plus
`derived_stage` — because the chart draws phases, so the project's own dates were
the one thing on that tab readable nowhere. The span is derived from **every**
phase, dated or not, never from the bars on screen.

Beside them rides **`completion`**, and that is what a collapsed swimlane fills
its bar with and prints: one fraction from `validation.completion_fraction`,
phases as the frame and each phase's share filled by the deliverables named
under it. The tallies travel too, because the bar prints them — the fraction says
how far, the tallies say what it was read off.
**The identical field is on `GET /api/graph`**, so the map node and the swimlane
cannot disagree about one project. It is **`None`, never 0, for a project with no
phases** — no frame, no fraction — and both charts draw nothing at all for that,
the same 0-of-0 refusal `deliverable_progress` makes.
`completion_fraction` needs deliverables keyed by *phase*, so both routes run
`main.deliverables_by_phase_id` over the project-keyed read they already hold —
those rows are `deliverable.*` off a join and carry `phase_id`, so it is a
regroup rather than a query. The portfolio route reads
`db.deliverables_by_project()` **once** into a local and hands it to both
`with_project_span` and `with_derived_stage`, the same shape the milestone read
above has.

It also returns **`milestones`**: every *dated* checkpoint on a committed
project, flat and carrying `project_id`, so a swimlane can draw the same
diamonds the project timeline does (`main.drawable_milestones`). Same rule as
`phases` — undated is omitted, because there is nowhere honest to draw it — but
unlike a phase it gets no tray: a checkpoint has no work to place, and an
undated one is chased up in the project view. The dict `db.milestones_by_project`
returns is read **once** and used twice on this route, since the derived stage
needs every checkpoint and the chart needs only the dated ones.

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

`GET`/`PUT /api/template` are that template, read and written **exactly as a
sprint file is** — same payload shape, same mtime guard, same atomic write —
because the editor opens it with the same code. Its own pair of routes rather
than a number: it lives outside `sprints/`, `sprint_files` cannot see it, and
giving it a number would put a name into a sequence `next_sprint_number` would
then have to skip. Editing it changes what the **next** `POST /api/sprints`
copies and touches no file already on disk. It is a **tracked** file, unlike
every other file the editor opens, so a save here shows up in `git status`.

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

- **Shell** — a sidebar and a top bar, wrapping all four views. The sidebar
  (`--sidebar-w`, 240px) holds navigation *and* the project list, sticky at full
  height with its own scroller; the top bar names what you are looking at and
  carries what you can do to it. It replaced a single row holding a strong, four
  tabs, the picker, New project, Delete and Export/Import — eight controls of
  which two were navigation, one was a picker, one was destructive and two were
  file I/O at navigation weight.
  The four nav buttons keep the **`tab-*` ids the tab strip carried**, so
  `refreshView` still toggles `active` on them and nothing else in `app.js` knows
  the shape changed. `--topbar-h` is **68px** now, not 52: the bar is two lines, a
  title over a meta line. `.sprint-scope` is still the one thing reading it.
  **`display: flex` is on the shell and never on a view.** `#workspace`,
  `#portfolio-view`, `#map-view` and `#sprint-view` are toggled with the `hidden`
  attribute, and a class setting `display` outranks the UA sheet's `[hidden]` —
  the trap this file counts. The gap-and-flex the artboard draws round the cards
  lives on wrappers (`.project-top`, `.app`) for exactly that reason.
  **The sidebar folds to a 56px icon rail**, from `#sidebar-toggle` at the left of
  the top bar — there rather than in the sidebar, because folded there is no
  sidebar to put it back from. **Folded is narrower, not absent:** hiding it
  outright would take the navigation with it and leave the four views reachable
  only by putting it back, so the icons stay and the *project list* is what goes,
  which is where the 240px was being spent. It exists because the fold was
  measured: the Sprint tab's table columns go 92px → 112px at a 1440px window, and
  that tab's own width cap was removed precisely because its tables want every
  column visible.
  It is the **second thing in this app kept in `localStorage`**, beside the sprint
  editor's column widths, and for the same reason: `mapTiers` and `timelineMode`
  are pinned for the plan in front of you and are meant to go on a reload, while a
  folded sidebar is a working width you want back next time. Both directions are
  guarded — `localStorage` throws when disabled rather than returning nothing, and
  failing means it is not remembered, never that the app does not start.
  `applySidebar` calls `redraw`, because folding changes the container width and
  `weekGrid` fits its columns to that; the Sprint tab needs no branch there, its
  tables being auto-layout HTML that re-fits itself.
  The top bar's meta line prints `track · span · N phases · M pts`, and **the span
  is read off the payload rather than derived in the frontend**:
  `validation.project_span` owns a project's dates and `main.with_project_span` is
  what puts them on both the portfolio and the project's own payload, so the
  swimlane title and this line cannot disagree. A `max` over the phases sitting
  right there in `state.plan` would be a second copy of that arithmetic, which is
  the mistake `laneSummary`'s comment documents not making. An undated project says
  `no dates yet` rather than printing half a range, the swimlane's own rule.
- **Picker** — the project list in the sidebar, one row per project:
  `dot Name tier`. It **replaced a native `<select>` whose only possible badge was
  an emoji in the option's text** — an `<option>` holds no markup, so a coloured
  glyph was the only mark it could carry, and this file used to add that a real
  pill would mean hand-rolling a dropdown. A sidebar list is not a dropdown, so
  that cost is not paid: the three things the select could not do are the three
  this needed — a status dot, a tier digit, and a filter.
  - The dot's colours are the **map's**, lifted into `--stage-*` custom properties
    that both surfaces read. The map draws a rung as a circle and the list draws
    it as a dot; the shapes differ and the colours must not. Only the *shape* of a
    rung is left in the map's own rules — the stroke widths, and the dash on an
    idea, neither of which 9px can carry. An idea instead sits back by having its
    name greyed, which is what `.project-row.is-idea` is for.
  - **The list is one step less precise than the map, deliberately.** The map
    splits `done` into delivered (green, every checkpoint reached) and closed
    (grey) off the milestone tally on `GET /api/graph`; `/api/projects` carries no
    tally, so a finished project is grey here. That is *less* detail, not
    different detail — the two never disagree about a project, one of them simply
    says more — and deriving the split in the frontend would be a second copy of a
    rule that lives in `validation`.
  - The tier digit is the map's pip (`--tier-pip`), one indigo for all three ranks
    because the digit is the cue; untiered wears `?` in the quiet greys, since the
    absence of a decision is not a fourth rank.
  - **The filter narrows and nothing else.** `state.projectFilter` is a way of
    looking, like `mapTiers` — no fetch, nothing stored, and the open project
    stays open while filtered out of view.
  - The words the marks stand for are on each **row's** tooltip (`name`, rung,
    tier), which is where the legend went: the select carried one legend for the
    whole control in its `title`, and a dot cannot say "planned, needs dates".
  - `loadPlan` re-reads `/api/projects` after every edit so naming a deliverable
    or ticking the last milestone retags the row immediately; that costs one
    localhost query and keeps the ladder out of the frontend.
  - **`STAGE_BADGE` is still there and still used.** The dependency and
    Future-directions pickers are native `<select>`s and still mark ideas with
    💡 (`IDEA_BADGE`, its alias) — they list projects rather than states, so
    committed-versus-idea is the only distinction worth drawing there, and the
    "an `<option>` can only carry a glyph" argument holds for them unchanged. The
    portfolio lane tooltip prints the badge too. The ramp is not decoration: the
    cool marks are plan-building, colour warms once the calendar takes over, and
    **red appears exactly once in the vocabulary**, which is what keeps it worth
    noticing.
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
- **Project** — **warnings**, then goal and fields side by side (including
  **Tier**, the only place it is set), unscheduled list, timeline, **the plan
  sequence** — phases and
  checkpoints in one table, with expandable deliverables (`3/5` tally on the phase
  row) — then dependencies. The
  dependency panel lists both directions (`← waits on X`, `→ Y waits on this`)
  and links by picking another project plus a direction.
  Four things about that order and shape are decisions rather than layout:
  - **Warnings are first**, where they were third, and are a **banner rather than
    a card**: what the plan is telling you comes before what you can change about
    it. It goes *quiet* rather than away when there is nothing to report —
    `renderWarnings` sets `is-clear`, which drops the amber, the border, the icon
    and the aside and turns the count into the sentence. It keeps its slot, so the
    page does not jump the moment the last warning clears. Neither state uses
    `hidden`, so none of it is the `[hidden]` trap.
  - **Goal and Details sit side by side** (`.project-top`), because both are short
    and stacked they pushed the timeline off the first screen. Details is a
    **grid**, not a wrapping `.row`: a row re-flowed into ragged lines as the
    window moved, which is fine for a toolbar and wrong for a form read down.
  - **The two adder rows fold behind `+ Phase` and `+ Checkpoint`.** Nine fields
    and two buttons sat open under the table permanently, on a tab that is mostly
    for reading a plan back. The rows are unchanged, ids and all. The top bar's
    primary `Add phase` is a third caller and **only ever opens** — a primary
    button that sometimes closes the thing it names is a toggle wearing the wrong
    label — and it scrolls the row into view, since the bar is sticky.
    `.row[hidden]` in the CSS is what makes any of this work, and it is written at
    the class rather than at these two call sites so the next folded `.row` is
    covered before it exists.
  - **Name, the three global settings and Delete live behind the `⋯` menu** in the
    top bar. Renaming and three global numbers were more controls in a row of
    eight; Delete looked exactly like New project, which is the one pair in this
    app that must not look alike. The `<details>Settings</details>` disclosure is
    gone with it. `aria-expanded` follows the panel's own `hidden` rather than
    being tracked in `state`, because a second copy of that truth could disagree.
    `Lay out sequentially` moved to the bar as well, out of a `<label>&nbsp;</label>`
    it was wearing to line up with the fields beside it.
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
  **Checkpoints are rows in the phase table, not a section of their own**, and
  that is the point: a checkpoint sits *between* two phases, so where it falls in
  the sequence is the thing worth arranging — and two tables, each ordered only
  among themselves, could hold no opinion about it at all. `Phases, checkpoints &
  deliverables`, one ordered list, a `⠿` grip on both row kinds. A checkpoint row
  carries a ◆, a reached tick, a name, a target date and a muted `checkpoint`
  spanning the four columns a phase spends on weeks, points, status and its
  derived end — it is a point with no work of its own, which is the distinction.
  The `2/3 reached` tally sits beside the heading. Nothing about it is hidden: it
  decides the stage while a plan is being drafted, and it is the record of what
  the project is for once it is running.
  It borrows the
  deliverable list's row furniture deliberately — same grip in its own column,
  same tick, same struck-through name — because it is the same gesture on a
  different record and two spellings of one row would drift; reordering writes
  `sort_order` and nothing else, `DRAG_ARM_PX` and all.
  **The sequence costs no schema change: the two tables share one `sort_order`
  number line.** `orderedPlanRows` reads them as one list and `savePlanOrder`
  renumbers it from zero across both kinds, each row written to its own endpoint.
  `list_phases` and `list_milestones` only ever use `sort_order` relatively, so
  gaps in either table's numbers are harmless.
  **Creation appends to the shared sequence**, which is the one place the server
  knows about it: `db.next_plan_sort_order` reads the `MAX` across both tables for
  the project, and `create_phase` and `create_milestone` share it. Each table's
  own `MAX+1` would put a new phase and a new checkpoint on the same number.
  Ties are still possible and still handled — **a file written before the merge
  has its phases at 0..n-1 and its checkpoints at 0..m-1, so almost every row
  collides until the first drag renumbers them.** Ties break phases-first and the
  sort is stable, so rows of one kind keep the order the server sent. Nothing
  *validates* the line and nothing repairs it: no rule reads the order, so a file
  with ties or gaps is a well-formed file.
  Two more consequences worth knowing. **`saveOrder`, the
  Weeks-timeline bar drag, had to learn about it**: renumbering the phases 0..n-1
  on their own would walk them straight through the checkpoints between them, so
  the new phase order is written back into the merged sequence with the
  checkpoints keeping the slots they occupy. Phases also gained a grip of their
  own here, which they never had — a bar on the Weeks timeline was the only way to
  reorder one.
  **The drag cannot use the deliverable list's step-per-row arithmetic**, because
  rows here are not uniform height: an expanded phase carries its deliverable row
  under it, and that row travels with the phase when it moves. The drop slot is
  the number of other rows whose midpoint the cursor has passed, and those
  midpoints are **frozen at mousedown** — reading the live boxes would feed the
  preview back into the decision and oscillate on a boundary.
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
  as diamonds in both** — hollow until reached, filled once it is, the same
  vocabulary the map uses on a project node. A milestone is
  a point rather than a span, so it cannot be a `.bar`: those are block elements
  owning a row, and several points share one line. The two modes measure from
  different origins, which is the subtlety — Dates counts days from the window
  origin, Weeks has no calendar and so measures a stored date against the
  *project's* start, and without one there is no origin at all. That is the
  common case in Weeks mode, since it is what an undated project opens on, so
  those are counted as undated and reported rather than dropped. Two counts, kept
  apart because they are two problems: no date, versus scrolled off screen.
  **The chart is one row per plan row, in the shared `sort_order`** — a bar for a
  phase, a one-diamond lane for a checkpoint, interleaved. Every checkpoint in a
  single lane pinned above all the bars was the first shape and it made the
  sequence unreadable: a checkpoint belonging between phases 3 and 4 drew above
  phase 1, while the table directly below the chart interleaved them properly, so
  one number line had two pictures. **The portfolio's swimlanes do the same thing
  with the same components** — `mergePlanRows` is shared, since a lane there
  stacks one bar row per phase too, and two copies of the arithmetic would drift. **Row position is the sequence; a mark's x is
  still its own date** — the two are independent and neither is snapped to the
  other, so a checkpoint dated in the middle of a phase draws in the middle of
  that phase while sitting on its own row between the phases it falls between.
  Nothing here is derived and nothing is repaired: a diamond left of the bar above
  it is a plan saying something worth seeing.
  A knock-on the drag had to learn: `makeResequenceable` previews a re-order by
  re-appending rows, so it now re-appends **the merged sequence** — checkpoint
  rows keeping their slots, exactly the merge `saveOrder` writes on the drop.
  Re-appending the bars alone swept every one of them past every checkpoint, which
  previewed an order the drop would not have produced. It also no longer indexes
  the body's children positionally, since the body holds rows that are not bars.
  **Colliding labels stack.** Two checkpoints a few days apart used to print one
  name over the other, with the `title` as the consolation; `stackMilestoneLanes`
  measures the labels and drops each mark into the first row that has cleared
  it, growing the lane's height with the rows — the bars below are block elements,
  so a second row has to push them down rather than paint across them. It is a
  **sweep over the finished chart**, not a step inside `milestoneLane`, and that
  is forced: a detached element has no layout, so `offsetWidth` in the builder is
  0 and neither the grid body nor a portfolio swimlane is in the document when its
  lane is built. All three charts call it, so the vocabulary cannot drift; failing
  to call it costs only the overlap it fixes.
  **Both mechanisms went input-less and then got their input back**, which is
  the whole argument for having kept them. Interleaving *dissolved* the problem
  the sweep was written for — one mark per row cannot collide with anything — and
  this paragraph used to say so, adding that a shared strip stayed a thing the
  code could draw and was "the cheap way back if a compact all-checkpoints strip
  is ever wanted". The portfolio's **folded lane** is that strip: every
  checkpoint on one line under a single summary bar, and on the real file two
  lanes stack to a second row. The project timeline still hands `milestoneLane`
  exactly one mark per row, so nothing here changed for it.
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
  **A lane is folded by default, and opens on a `▸` beside its name.** A lane is
  one row per phase plus one per dated checkpoint, which is the right shape for
  reading one project and the wrong one for reading a dozen: on the real file the
  chart was 938px of rows before the ruler, and this tab exists to show the whole
  department at once. Folded, a project is **one bar over its own span, filled to
  and labelled with its `completion`** (`67% · 2/3 phases · 4/6 delivered`) —
  564px for nine lanes, 41px each.
  `state.laneOpen` holds what is **open** rather than what is closed, so a project
  created while the tab is open lands folded like every other one; same lifetime
  as `state.mapTiers`, gone on a reload. One `Expand all` / `Collapse all` sits
  above the chart, labelled with what it will do next and counting only the lanes
  actually drawn.
  **The summary bar does not drag**, and its tooltip says so. A drag here moves
  one phase to a date; there is nothing honest for a drop on a whole project to
  write, so opening the lane is what gets you a bar you can move. Its span is
  read off the payload and placed by `placeBar`, so it keeps the dotted clip edge
  every other bar has and paging the window cannot change what a project claims
  its dates are. **A project with no phases draws no fill and no percentage** —
  the payload says `null` rather than 0, because with no frame there is no
  fraction to draw.
  The folded lane's checkpoints go on **one shared strip** below the bar, which
  is the shape `milestoneLane` and `stackMilestoneLanes` were kept alive for when
  interleaving left them one mark per row and nothing to stack — "the cheap way
  back if a compact all-checkpoints strip is ever wanted". The sweep has a real
  input again: two lanes on the real file grow their strip to a second row.
  **The project name has a column of its own, left of the calendar**, and it is
  the only grid gutter in the app: `LANE_NAME_PX` (160) is set as `view.gutterPx`
  by `renderPortfolio` alone, and a lane is two cells — `.lane-name`, then
  `.lane-rows` holding the bars and diamonds. It was a row *above* each lane's
  bars, which put every name on the gridlines and under the today line — 2px of
  near-black ink through whichever name it landed on — and left the names at a
  dozen different heights to scan down. Nothing is drawn across a column.
  **The gutter is paid for in `weekGrid`, not in the lane**, because three things
  have to agree about where the calendar starts: it comes off the width before
  the columns are fitted (26 weeks at the 1100px cap → 34px, well clear of the
  22px floor), each ruler row gets a leading `.ruler-gutter` spacer, and the grid
  body holds it open as `padding-left` with `background-origin`/`background-clip`
  at `content-box` so the gridline gradient starts on the calendar's own edge
  instead of tiling back under the names. The name cell is then pulled into that
  padding by a negative margin, which is what leaves `.lane-rows` exactly the
  calendar's width so a bar's `margin-left` still measures from day 0. Everything
  that draws against the grid steps over the gutter — the today line, and the
  tray drag turning a cursor into a day. `--lane-name-px` is 0 everywhere else,
  so the project timeline is untouched by every one of those declarations.
  A free consequence worth knowing: the gradient's first stripe lands on the
  content edge, so the divider between the two columns is drawn for the whole
  height of the chart by the gridlines themselves, and the ruler's first week
  cell — no longer `:first-child`, so it keeps its left border — lines up with it.
  **A lane's title carries the project's own span**, which its bars cannot say
  between them — each bar is one phase, and the project's dates are the question
  this tab exists to answer. `Name / 2026-09-01 → 2026-12-12 · 6 phases · 55 pts
  / 🟢 active`, every number read off the payload. **Never measured from the bars
  on screen**: a lane only draws the phases inside the current window, so
  measuring those would make one project report different dates depending on
  where the chart is scrolled. An undated project says `no dates yet` rather than
  printing blanks. The title is the **heaviest thing in the lane** — bold,
  underlined, a size up — because it is what you scan a dozen swimlanes for and
  every bar beside it carries the same weight. **Clicking it opens that
  project**, which is what the underline is for: the way from a bar you are
  reading to the plan behind it. Same affordance as the ruler's week cells — a
  `tabIndex`'d div, keyboard-reachable, `width: fit-content` so the hit area is
  the name and not the empty half of the column beside it. A name too long for
  160px is clipped with an ellipsis rather than wrapping the lane taller, and the
  whole name is on the tooltip that already carries the span. It shares
  `openProject` with the
  map's nodes and the Future-directions rows, so all three agree about what
  opening clears (`expandedPhases`, `timelineMode`, and the picker's own value).
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
  **The ghost lane the drag draws lands on the first row, not the last.** It was
  appended, which put the one thing the gesture is aimed at below however many
  lanes the chart already had — off the bottom of the screen on a real dataset,
  which is exactly when a chip is being placed. At the top it sits directly under
  the tray the chip came from whatever the chart has grown to; the lanes below
  shift down a row while the drag is live, which a horizontal placement can
  afford. The today line is positioned, so DOM order costs it nothing.
  The grid is drawn even when nothing is scheduled at all — it is the drop
  target, and that is exactly the case where the tray matters most.
  A press only becomes a drag after 4px (`DRAG_ARM_PX`), so hand shake during a
  click cannot file a project at the window origin. Bars need no such guard —
  their snap is relative to where they already are, so a twitch is a zero-day
  move. After a drop, an **Undo** bar offers the exact inverse: the layout call
  reports which phases it dated, so undo blanks those and only those, then puts
  the project's own start date back. It lives in `state.lastPlacement`, so it
  survives re-renders and tab switches but not a page reload — the offer says so.
  **Each lane draws its project's checkpoints** as diamonds, the
  same `milestoneLane` the project timeline uses — one component, so the
  hollow-until-reached vocabulary cannot drift between the two charts.
  **An open lane is the plan sequence too**, by the same `mergePlanRows`: a bar
  for a
  phase, a one-diamond row for a checkpoint, interleaved on the shared
  `sort_order`. A lane's bars have always been in that order
  (`db.list_all_phases` orders by it), so the sequence was already what the rows
  said — while every checkpoint sat in one strip above them, reading as "these
  come first". The strip was fixed on the project timeline first and looked
  finished there; the tab that shows a dozen projects at once still had the
  original confusion, which is what got it reported a second time. The lane grows
  by a row per dated checkpoint, and on the real dataset the whole chart grew by
  one row net — four lanes each lost a strip, five checkpoints each gained a row.
  **Bars
  still decide which lanes exist**: a project whose work is all off-window keeps
  its checkpoints off-window with it, rather than opening a lane holding nothing
  but a diamond. So a lane is the sequence **restricted to what it draws** — an
  off-window phase leaves a hole, exactly as it does on the project timeline.
  Below the chart, every cross-project
  link as a **list**, V2-marked where violated — not arrows between swimlanes,
  because a link can point at an idea, which has no bar to draw to.
- **Fortnight drawer** — clicking a week number on the portfolio ruler opens
  the fortnight starting that Monday, under the chart, and marks the two weeks
  it covers.
  **Hovering a week column reveals its seven days**, and picking one opens the
  fortnight *containing* that day. The column prints its Monday and nothing
  else, so until this existed a fortnight could only be started from a Monday —
  while the cadence is the team's own and planning happens on a Wednesday here.
  Weekends are shaded rather than disabled: a sprint occasionally starts on one.
  The picked day is `state.fortnight.planFrom`, and **it never moves
  `state.fortnight.start`** — that is read back off the payload, because the
  server snaps the window and marking a Wednesday on the ruler would mark
  nothing. Mouse only, deliberately: making 182 chips focusable would put that
  many stops in the tab order on the way to the chart, so `Enter` on the column
  still opens the Monday. `.week` clips its own text, so hovering unclips the
  column to let the strip escape it, and the last few columns open leftwards so
  it never hangs off the end of the chart. The ruler variant (`portfolioRuler`) is **passed into `weekGrid`
  rather than flagged on**, so the project timeline's ruler is untouched and
  nothing there knows the drawer exists. `state.fortnight` survives re-renders
  and tab switches but not a reload, like `timelineMode` and `state.mapTiers`.
  `Esc` closes. `.fortnight-drawer[hidden]` is load-bearing — the fourth time
  that trap has come up.
  It draws `renderSprintSlice`, the **shared** component: a day-resolution
  strip of 21 columns (the fortnight, then the lead-out week greyed behind a
  divider), weekends shaded, a today line that is simply **absent** when today
  is off the strip, over a list of the deliverables the phases name — **each with
  its `done` tick as a disabled checkbox**, struck through when it is set, the
  deliverable list's own vocabulary. `fortnight_lane` has always carried `done`
  "so it can be shown, never so anything can be derived from it"; this is the
  showing. Both surfaces get it because they are one component. Divs on a
  CSS grid, not SVG — the charts either side of it are divs on a week grid, and
  the map is the one hand-rolled SVG here. `compact` is the drawer's density:
  same DOM, tighter metrics, so the drawer and the Sprint tab cannot drift into
  two pictures of one fortnight.
  **Today is a shaded column as well as a line**: the line marks the day
  exactly, the shading is what you find without looking for it. Amber, because
  every other meaning here is spoken for — red is late, blue is planned, green
  is in progress, grey is done or next fortnight's problem — and it is last in
  the cascade, so today falling on a Saturday is still today.
  **Each project row takes a colour, and it is identity rather than meaning.**
  One hue per project on the row's rail, its name and a faint wash; the bar fill
  still says status and the one red still says overdue, which is why no colour
  goes on the bar. Assigned by **order of first appearance** rather than by id,
  so adjacent rows differ — `TRACK_HUES` is sequenced for neighbouring pairs and
  the lanes sort by band then project. The cost is that a project can take a
  different colour in a different fortnight; accepted, because this panel is one
  fortnight read on its own, and a stable hash lets two adjacent rows collide,
  which is the thing being fixed. The eight are the map's, reused rather than a
  second palette invented — they are already colour-blindness checked — and the
  collision with *track* is a non-collision: this panel draws no tracks. The
  wash carries an alpha rather than being mixed towards white, so the weekend
  and lead-out shading behind the row still reads through it. The rail rides on
  the **lane title**, never on `.slice-lane`: the lane is a grid of day columns,
  so a border on it would take its width out of the columns and walk every bar
  off the ruler above.
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
  **What it posts is `plannedFrom` — the day picked off the ruler, not the
  Monday the strip is framed on.** This is what the day chips are for, and it is
  exactly the distinction `fortnight_window` and `sprint_window` exist
  separately to keep: the strip is a chart window and snaps, the heading is a
  file's dates and does not. So a Wednesday cadence can now be started from this
  tab rather than only from the Sprint tab's date box. The footer says
  `planning from Wed 19 Aug` when the two differ, and `plannedSprints` is keyed
  on what was posted, so the second-press guard still guards the right thing.
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
  - **The roadmap sits down the right, read-only** — `Deliverables in scope`,
    the phases touching this file's fortnight and the deliverables they name.
    The tab had no roadmap in it at all until this: the fortnight drawer on
    Portfolio was where the two met, which is the wrong tab to fill a capacity
    table from.
    It costs **no endpoint and no server code**. The file's fortnight is already
    on `GET /api/sprints` (`sprint_window_from_heading`, read off the first line
    and lenient — no dates means no window, and the panel says so rather than
    guessing), and `GET /api/fortnight` already answers what is in a fortnight.
    `renderSprintScope` in **app.js**, not `editor.js`, and that is the gate
    holding: the editor still knows nothing about a roadmap or a sprint. It
    draws `sliceDeliverables`, the drawer's own component, so the two pictures of
    one fortnight cannot drift.
    **It writes nothing and offers no insert**, which was offered and declined:
    a click that puts a deliverable into the file is one step from allocating
    deliverables into sprints, which `PROMPT.md` lists as do-not-build. You read
    it and type what you decide. **The `done` tick is drawn as a disabled
    checkbox and is the one thing this rule now has to say twice**: showing which
    deliverables are already finished is the first question asked of a
    fortnight's scope, so it is shown — but ticking one is roadmap state and the
    project view keeps that gesture. A read-only box in a panel that reads.
    Two honest details. The heading's dates are the sprint's own and are **never
    snapped**, while the chart window is Monday-based and is — so when they
    differ the panel names the week it read from rather than quietly showing two
    days the sprint does not cover, the same distinction `sprint_window` and
    `fortnight_window` exist separately to keep. And **the panel is a fifth of
    the tab, the file is the rest** — `minmax(0, 4fr) minmax(260px, 1fr)`, with
    no cap on either. There was one: 1220px on the view with the document fixed
    at 860 of that, on the reading-width argument that prose at chart width is a
    worse editor than prose in a column. Measured on a 1778px screen that left
    the file on **48% of the page** and 543px of nothing beside the panel, and
    the argument was answering for the wrong content — what fills a sprint file
    is the capacity and unplanned-work **tables**, which want every column
    visible far more than a paragraph wants a short line. The panel keeps a
    260px floor so it stays readable on the way down to the 1180px stack.
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
    and `Tab` off the last one grows a row — **except on a list line, where it
    indents instead**, see the keyboard entry below; `Ctrl`+arrow walks from
    anywhere and does everything `Tab` does, growing a row included, which is
    what a list line has instead. `+ Row` `+ Column` sit under it on
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
    **The click that opens a cell is the `<td>`'s, not either state's**, and that
    follows from the swap rather than being a second decision: the host is what
    survives it. It also has to be, because a `<td>` is `vertical-align: middle`,
    so a one-line cell in a row made tall by the cell beside it drew its view 30px
    high inside 263px and the other 234px did nothing — measured, `elementFromPoint`
    returned the bare `TD` there. Binding on the host makes that margin live in
    both states, so a press beside an open textarea puts the caret in it.
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
  - **A cell line can be a bullet, and a cell can be highlighted — both are
    characters in the file.** The checkbox above is the precedent and the
    argument is identical each time: *the file holds text and the grid draws an
    affordance over it*, because `- x` in a cell is literal text to GFM. So a
    line starting `- `, `* ` or `+ ` draws as **• ◦ ▪ by depth** (the ramp
    repeats rather than running out), and a cell whose first characters are
    🟨🟥🟩🟦 draws **tinted**, its marker consumed the way `- [ ]` is. Both are
    set from the `/` cell menu; outside this grid they read as a hyphen and a
    coloured square, which is what they are.
    Two mechanical facts worth knowing. The tint rides on the **`<td>`**, not on
    either state inside it, so it survives the view/textarea swap and fills the
    cell when a taller cell beside it sets the row's height. And **a nested
    bullet cannot be a cell's first line**: `_split_row` strips each cell, so a
    leading indent on line one is gone by the next save. That is the file's rule
    rather than the editor's, and a list starts at the left anyway.
    **What was rejected, and why it matters:** a sidecar file holding colours and
    widths per cell. It is the precise thing this feature exists not to be — the
    markdown file is the one record, and a second store beside it is how that
    stops being true. Column widths went to `localStorage` instead (below);
    colour went into the text, where every other tool can see it.
  - **`Enter` continues a list**, in whichever spelling the line already uses —
    `☑` carries on as `☐`, `- [x]` as an unticked `- [ ] `, `*` as `*`. The
    marker belongs to the line, the same stance `flipCellTodo` takes about
    ticking one. On an **empty** item it takes the marker away rather than laying
    out a third, and that half is not a nicety: it is the only way out of a list
    that continues itself.
  - **`Tab` indents a list line and walks the grid everywhere else.** Read per
    line, not per cell, like the `/` menu — and the split is the whole design.
    Taking `Tab` outright was built first and was wrong: indenting a paragraph
    inside a table cell means nothing, and a cell holding one word is the common
    case, so it would have cost the gesture that fills a table in. `Shift+Tab`
    outdents. `Esc` blurs a cell back to its view, which nothing did before —
    with `Tab` sometimes staying put, a keyboard needed a way out of the grid.
  - **A column can be resized, and the width is not in the file.** Markdown has
    no column width, so it lives in `localStorage` — a way of looking, like
    `state.mapTiers`, except that unlike those it is worth keeping across a
    reload. Keyed on the **header row's text**, so it survives a block reorder;
    renaming a header loses that table's widths and two identically-headed tables
    share them, both accepted. A table is **auto-sized until the first drag**,
    which seeds every column from what it was already occupying and switches to
    `table-layout: fixed` — under auto layout a width is a suggestion the browser
    re-fits, so a drag would not land where it was let go. Double-click resets
    the **table**, not the column: one auto column among fixed ones has no width
    to fall back to. The handle sits in the grip strip above the header rather
    than in the header cell, whose whole area is "click here to type".
    Inserting, deleting and moving a column carries the width along **exactly as
    it already carries `align`** — and reads it *before* the move, because the
    key is the header row the move is about to change.
  - **The view renders four inline constructs, and it is the second thing drawn in
    the browser rather than in Python.** Bold, italic, code and a link — *exactly*
    what `CELL_MENU` can insert, and nothing else. (The checkbox, the bullet and
    the tint are not on that list and are not exceptions to it: they are line and
    cell affordances over literal text, not inline markdown being rendered.) The
    discipline is the point:
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
    put roadmap knowledge in a control that needs none. That is now a statement
    about *this button* rather than about the tab, which has the scope panel
    below — the button still asks for a date and nothing else. The number is still the
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
  - **`Edit template` opens `templates/sprint.md` in this same editor**, beside
    the picker and as the picker's last row. It is the one openable file that is
    not a sprint, and the point of it is that the format is now yours to change
    without leaving the app — a new sprint copies whatever is in it at the moment
    `New sprint` is pressed, and no file already on disk is touched.
    It costs no second editor: the template is a **key** where a number goes
    (`TEMPLATE_KEY`, the string `"template"`), `sprintEndpoint` turns that key
    into `/api/template` instead of `/api/sprints/NN`, and everything else —
    blocks, grids, autosave, the mtime guard, `Raw file` — is the code that was
    already there. A string cannot collide with a number, which is what makes the
    sentinel safe in `select.value`, in the width store and in the mid-flight
    `sprint.number !== number` guards.
    **It is not in `state.sprint.files`**, deliberately: that list is the picker's
    order, the overlap check and `latestSprintHandover`, and a template has no
    fortnight to offer any of them. Two consequences follow. `loadSprints` has to
    ask `isTemplate` as well as searching the list, or a tab switch would decide
    nothing was open and pull a sprint file over the top of it. And the scope
    panel says the template covers no fortnight rather than reading its heading
    as broken — the placeholder dates in line 1 are what the server *fills in* on
    create, so having no window is the correct state rather than a bad edit.
    **The file is tracked by git**, unlike `sprints/` and `data/`, so an edit here
    is the one thing the editor does that shows up in `git status`.
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
    come up. (**The running total is nine.** The three that took it there had all
    been wrong from the start and were invisible until a check went looking:
    `.window-bar`, so the date controls never hid in Weeks mode; `.undo-bar`, so an
    empty ruled strip sat on Portfolio permanently; and `.mode-switch`, so the
    Rendered|Raw switch never hid with no sprint file open. `.row[hidden]`,
    `.menu-panel[hidden]`, `.topbar-actions[hidden]`, `.stage-badge[hidden]` and
    `.topbar-meta[hidden]` were written correctly the first time. Each count above
    is right for when it was written; do not renumber them.)
    Clicking a diagram opens its fence like any other block; the rail
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
  **Those colours are now `--stage-*` tokens rather than hex in these rules**, and
  the sidebar's project dots read the same eight. The map draws a rung as a circle
  and the list draws it as a dot; the shapes differ and the colours must not, so
  the palette has one definition and each surface adds only its own shape. What is
  still only here: the stroke widths, and the dash on an idea — a 9px dot can carry
  neither. See the Picker under "Views" for what the list deliberately leaves out.
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
  checkpoint yet.
  **A node fills from the bottom and prints its percentage in the middle** —
  `completion` off `GET /api/graph`, the identical field the portfolio's folded
  lane fills a bar with, so the two charts cannot disagree. **The wedge says
  roughly and the number says exactly**, which is the pair a chart usually gets
  wrong by drawing only one of them.
  The **font scales with the radius** (`max(9, min(r × 0.45, 13))`), because the
  clamp is 16–38px and no fixed size serves both ends; `dominant-baseline:
  central` keeps it centred as it scales, rather than an offset that would only
  be right at one size. `paint-order: stroke` puts a white halo *behind* the
  glyphs, which is what keeps them legible where the top edge of the fill runs
  straight through the text — at 50% it always does. Measured at the worst case
  the real file cannot show: `100%` at r=16 is 23.6px in a 32px circle, 4.2px
  clear each side.
  The fill is a **`<rect>` clipped to the node's own circle, never a second
  circle**, and that is mechanical rather than stylistic: every stage rule is
  `.map-node circle:not(.map-pip)`, which outranks anything a class on a
  `<circle>` could say, so a circle drawn for this would be painted whatever
  colour the stage is. No selector here matches a rect. The clip is a circle a
  hair inside the rim, so the stroke — half the stage vocabulary — keeps its own
  colour all the way round.
  It sits **over** the stage fill rather than replacing it: hollow is still
  undated, pale still dated, solid still running, green still delivered, and
  progress is depth of colour *inside* that instead of a fifth body colour.
  Translucent for the same reason — the green of a delivered project has to read
  through a full one. A project with **no phases gets neither wedge nor number**,
  since `completion` is `null` and there is nothing to draw a fraction of.
  The tallies go on the tooltip and not the label: the map's label clearances are
  sized against the height of the label block, so a fourth line would move every
  one of them. It reads the tick to *draw* and nothing more — rule 4.
  **`map_sweep.js` needed two things from this.** It skips `<clipPath>` and
  `<defs>` — geometry that is never ink cannot collide with anything, and without
  it the clip circle, which sits exactly on its own node, reported as a collision
  once per project. And `.map-percent` joins `.map-pip-text` and `.map-hub` as a
  label **meant** to sit on a circle, excluded from the label list and from
  `circleName`, which would otherwise name every measured project `67%`.
  **Both colour vocabularies are spelt out in a legend under the canvas**
  (`renderMapLegend`, `#map-legend`): the stage ramp, in the ladder's order and
  with `done` listed twice because the map draws it as two things, then one dot
  per track hue. Below the canvas rather than inside the SVG, which is
  width-fitted and collision-swept — a block in there spends layout budget the
  rings need. **Every swatch is a real `.map-node` or `.map-group` circle**, so
  the rules that draw the picture draw the key with it and the two cannot drift;
  the only thing the legend's own CSS adds is `cursor: default`, since a swatch
  opens nothing. The track half is built from `trackPalette` over the **whole
  dataset**, exactly as the map is, so filtering a tier never empties the key,
  and the greys are claimed only when something wears them: a ninth track past
  the end of the palette, and untracked projects if any exist.
  A fourth ring for
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
  On the node itself, **tier is a number: every ranked project wears its own
  digit** on a pip on its upper-right shoulder, and untiered wears nothing —
  the absence of a decision is not a fourth rank, and `T?` on the label is where
  that is said. One indigo for all three, because the digit is the cue and a
  paler pip could not carry white 10px text.
  **It was visual weight and that was reported as not reading.** Tier 1 had the
  pip, tier 3 receded at half opacity and tier 2 was the plain node. Two things
  were wrong with the fade beyond being missable: it sat *on top of* the stage
  fill, so a faded `dated` node and a faded `idea` came out as the same wash —
  a second axis quietly spending the one vocabulary the circle has — and it
  needed a hover-restore to stop being a handicap, which is a rule you have to
  find by pointing at things. Both are deleted, not hidden.
  A halo ring was the first attempt and **failed at the bottom of the radius
  clamp** — at 16px the gap between node and ring is narrower than the stroke,
  so the two merge, and on a dashed idea it just doubled the dashes. The pip is
  a fixed `TIER_PIP_R` whatever the node does, which is the point: a mark that
  scales with the node fails wherever the node is smallest. It is pinned to a
  fixed angle rather than dodging the label, because a mark that moves stops
  being scannable, and it is drawn at `0.707r` so it never reaches past the
  label gap. **Three times as many pips moved no label**, and that is arithmetic
  rather than luck: the pip's far edge is `0.707r + 8` against a label starting
  at `r + LABEL_GAP`, clear at every radius in the 16–38 clamp. The sweep agrees
  — 134 collisions across 1000–1530px before and after, the same pre-existing
  count at this dataset size (STATUS item 47).
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
  **Hovering a track or subtrack dims the map to that branch** — the level, every
  level under it, the projects hanging off any of them and the spokes joining the
  lot (`wireTrackFocus`, `.map-branched`). "What is actually in here" was a
  question you answered by following spokes with your eye: the hue says which
  *root* a node belongs to, never which subtree, and at 28 projects across
  nineteen levels that is not a picture you can read a branch out of.
  **A second focus mode rather than a reuse of the dependency one**, because the
  two want opposite things from the spokes. Dependency focus dims every edge to
  .12 — the arrows it draws are what it has to say — while a branch *is* its
  edges: lit, they make one shape running out from the hub, dimmed it is a scatter
  of circles that happen to be bright. Everything outside the branch goes further
  down than a dependency hover takes it (.1 node, .2 group, .08 edge), since this
  mode is answering what is *in* the branch and the rest of the map is context.
  It costs a `data-track` attribute on every level node, project node and spoke,
  and membership is a **prefix test** on it (`trackKey`) rather than a second walk
  of the tree. Two details follow from that being the *drawn* path: a project past
  the ring ceiling lights with the folded node it was drawn under, since that is
  where the picture put it, and an untracked project belongs to no branch and is
  dimmed by every one of these hovers.
  **Mouse only, deliberately.** Project nodes get the dependency highlight from
  the keyboard for free because they are already focusable for click-to-open; a
  level node is not, and making it so would add a tab stop per track on the way to
  the chart — the same trade the fortnight drawer's day chips declined.
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

`weekGrid` also knows about **one gutter, and only the portfolio asks for it** —
`view.gutterPx`, the width of the swimlane name column. It is spent before the
columns are fitted, opens a spacer in each ruler row and is held clear in the grid
body as padding the gridlines are clipped out of; everything drawn against the
grid afterwards steps over it. With no gutter every one of those is a no-op, which
is why the project timeline is unaffected. See the Portfolio view below.

**The grid is shared; the viewport is not.** `state.windows` holds one per chart
(`activeWindow()` picks by `state.view`), because the two tabs answer different
questions and want different framings — and one viewport meant opening a project
re-framed the portfolio you had just been reading. Each opens on its own default
(`defaultOrigin`), and `Today` restores that default rather than writing a date,
so the button and the way the tab opens cannot say different things about where
"now" is:

- **Portfolio** — this week with `PORTFOLIO_LOOKBACK_WEEKS` (2) of run-up behind
  it. Where the work has just come from is part of "where are we".
- **Project** — fitted to the open plan by `fitProjectWindow`, as a *custom*
  range rather than a week count, since a span is whatever it is and the preset
  list holds five numbers. `planDateRange` is deliberately **not**
  `validation.project_span` and is not named after it: this is a viewport, so it
  also counts a checkpoint dated past the last phase — a window that opened with
  the thing the plan is aiming at off its right edge would be framing the work
  and hiding the target. Over 26 weeks it caps, with the existing note.
  Fitting happens **once per project selection**, not per load: every edit calls
  `loadPlan`, and refitting there would drag the viewport back while you were
  paging it (`state.windowFittedTo`). `Fit` in the window bar is how you ask
  again after moving dates; it appears in the project view only, and only when
  there is a range to fit to. An undated plan has nothing to fit and opens on
  this week — and on the Weeks timeline anyway, which has no window at all.

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
On the portfolio it now starts at the gutter rather than at the body's own edge:
an absolutely positioned child measures from the padding box, so the line has to
be offset by `view.gutterPx` to stay on the calendar. That is the point of the
name column — the one marker on the chart deliberately drawn in near-black ink
used to run through the project names.

**Weeks mode has no today line**, and that falls out of the structure rather than
being special-cased: it counts weeks from the project start, so it has no
calendar to place a date on, and it swaps in `relativeRuler`.

## The look

Written down because it is the kind of thing a later change undoes by accident.
The design was drawn as artboards first — `.design/` holds them, and the published
canvas is `.design/mastermind-ui-options.html`: `Current`, `Option 1 — Reskin`,
`Option 2 — Reskin + shell rebuild`. **Option 2 is what shipped.** Option 3, the
one that restyles the charts, was left undecided and is not started.

**The constraint that shaped all of it: the colour budget was already spent on
data.** Eight track hues, a seven-step stage ramp with exactly one red, blue for a
planned phase, green for delivered, grey for done, purple for a checkpoint, amber
for today. So the chrome takes **one accent** — indigo `--accent`, deliberately in
none of those vocabularies — and spends the rest on material, space and type.

- **Everything above the first chart rule in `style.css` is designed; everything
  from `.bar` down is not.** That split is the file's own comment at the top and it
  is the line to keep: a phase bar's blue is a value, not a decision about looks,
  and every chart colour has an argument written against it elsewhere in this file.
- **Tokens, not hex.** `--accent*`, four weights of ink, `--page` / `--surface` /
  `--line` / `--line-soft` / `--field` / `--hover`, two radii, `--sidebar-w`,
  `--topbar-h`, and `--control-h`. The last is **not applied as a `height`
  anywhere**: a global one makes a checkbox 33px. It is there for the few glyph
  buttons that must match a row of real ones, and for the arithmetic behind
  `--topbar-h`.
- **The control rules exclude a checkbox by type**
  (`input:not([type="checkbox"]):not([type="radio"])`). A bare `input` rule reaches
  the deliverable tick, the checkpoint tick, the read-only tick in the fortnight
  panel and the one inside a sprint table cell — and two of those reset only
  `min-width`. Solved once here instead of at each call site.
- **`.sprint-table th` undoes every one of the app's `th` declarations**, and that
  one is a correctness rule rather than a style: a sprint table's header row is
  *content*, the words are in the file in the case they were typed, so uppercasing
  it would have the grid showing `PERSON` while the file said `Person`.
- **Three button weights** — plain, `.btn-primary`, `.btn-ghost` — because there
  were none, and `Delete` looked exactly like `New project`.
- **Sections are cards.** They used to be separated by a hairline under each
  uppercase grey heading, which did the card's job in the middle of the content
  rather than around it. Headings are sentence case with no rule under them, which
  is what let `.section-head` stop being an absolutely-positioned aside.
- **No webfont, no `@import`, no off-machine `url()`.** The app works offline and
  `test_the_frontend_loads_nothing_from_off_this_machine` is what holds that.
- **`display` is never set on an element some code toggles with the `hidden`
  attribute** unless a `[hidden]` guard sits beside it. Nine features have been
  broken invisibly by that; see the mermaid note under the Sprint view for the
  count and the list.

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
reach the real `sprints/`**, which holds work actually done, **or the real
`templates/sprint.md`**, which is now written to as well as read.

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

**One exception, added when the template became editable: `editor.js` names the
*path* `templates/sprint.md`, in the picker's last row.** That is a location, not
a sprint concept — the editor still does not know what a capacity table is, what
a category list is, or that §3 holds points. The gate is about the second kind of
knowledge, and the whole template being replaceable from the UI without a line of
code changing is the demonstration that it holds.

What is still deferred to that decision: a sprint table, a `sprint_goal` column,
export v10, and anything that allocates deliverables into sprints.

**The template was replaced wholesale on 2026-08-18**, at the requester's
direction, with the six-section format they wrote: Sprint Goal · Capacity &
Constraints · Product Work · Enablement / Platform Work · Unplanned / Interrupt
Work · Sprint Summary, then Status and Definition of Done as reference. Line 1 is
still the heading placeholder the server fills in, and nothing else in the app
reads a byte of it.

Two designs the previous template carried went with it, and both were dropped
knowingly rather than lost:

- **Capacity was two independent numbers that never corrected each other** —
  declared (bottom-up, per person, a *judgement*, with coding days as evidence
  and never a multiplier) cross-checked against baseline (top-down, the last
  three sprints' delivered points scaled by person-days), taking the lower unless
  you wrote down why not. §2 is now availability and a velocity reference line.
  **The rule the design existed to protect still stands**: there is no
  points-per-day constant anywhere in this repo and there must not be one, and
  there is no focus factor — a lead who codes 35% of the time already shows up in
  what the team delivered.
- **Unplanned work had a fixed eight-value category list**, because the whole
  payoff of writing interruptions down is counting them across sprints and a
  category invented once counts for nothing. §5 has a free-text **Purpose**
  column instead. `scripts/sprint_review.py` reads across files looking for the
  same thing showing up sprint after sprint, so free text is what it now has to
  find a pattern in; if that stops working, a fixed list under §5 is the cheap
  fix and this paragraph is the argument for it.

Both are recoverable from `git log` — the old template is one `git show` away.

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

- **Usable before pretty**, still — but "the UI has had zero design attention on
  purpose", which is what this line used to say, expired on 2026-08-18. It has had
  one deliberate pass: see **The look** above for what was decided and why. The
  rule the sentence was protecting is unchanged: if choosing between a working
  feature and a better-looking one, ship the working one, and **the charts are
  still untouched** because their colours are data.
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
