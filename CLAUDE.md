# Mastermind

Internal tool for planning software delivery from roadmap → phases →
deliverables. All data in one SQLite file.

**It was single-user and localhost-only, and as of 2026-08-21 it is neither.** A
small team plans out of one instance, served from a container; two people editing
one thing is a 409 naming the field, never a silent overwrite, and who is in
which cell is drawn as a badge. Sign-in is Keycloak's over OIDC — **a gate, not
an account model**: nothing about a person is stored. See non-negotiable 7.

**This file is routing, not a record.** It says where things live, how to run
them, and how to work here. It deliberately does not describe what is already
built — the code, `git log` and `STATUS.md` are that record, and a second copy of
it here would drift. For the detail:

| Question | Read |
|---|---|
| What was asked for | `PROMPT.md` (the brief; its **Amendments** override its body) |
| What was decided and why | `git log`, then `STATUS.md` (gitignored, personal) |
| What is still open | `feature_request.md` (open + won't-build only; FR numbers never reused) |
| What the requester said | `comments.md` |
| How a feature actually behaves | the code — it is small and there is no framework in the way |

**What belongs in here:** working style, and the folder map that routes a change
to the right file — nothing else. A shipped feature is not written up here; it is
already in the code and `git log`, so adding it only creates a second copy to keep
in step. Before adding a section, ask which of those two jobs it does.

## Stack & commands

FastAPI + SQLite (stdlib `sqlite3`) + vanilla JS. No build step, no ORM, no
migration framework. Sign-in is one OIDC redirect and a signed cookie — no auth
framework and no session store, and `MASTERMIND_SSO=off` removes it entirely.

- `requirements.txt` — one runtime parsing dependency: `markdown-it-py` (4.2.0) +
  `mdit-py-plugins` (0.6.1), for the sprint editor. Not optional, not lazily
  imported. Pure Python, so still no build step. linkify stays **off** (it needs a
  third package and raises at render time without it). Also `python-dotenv`,
  which `uvicorn[standard]` already installs — named explicitly because
  `app/config.py` imports it, and a transitive dependency is not a promise.
  **Pinned exactly (`==`), because the Dockerfile installs this file** and a
  rebuild months later must be the application that was tested. Bump a line on
  purpose, then run the suite.
- `requirements-dev.txt` — `-r requirements.txt` plus `pytest`. Runtime and test
  are split so the image carries no test runner; `httpx` stays on the runtime
  side, because `app/auth.py` imports it for the OIDC code exchange and
  `TestClient` only happens to share it.
- `requirements-ai.txt` — `pydantic-ai`, for `scripts/sprint_review.py` only.
  Lazily imported; the app installs, serves and passes its tests without it. The
  model key is read from the environment and **never** the database.
- `app/static/vendor/mermaid.min.js` — the one vendored frontend file, pinned
  11.16.1, 3.4MB, lazy-loaded. Vendored rather than fetched because the app works
  offline; a test enforces that no frontend file names an external origin.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt   # runtime + pytest
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000   # http://127.0.0.1:8000
.\.venv\Scripts\python.exe -m pytest -q

node scripts\map_sweep.js            # map: label/circle collisions, 1000-1530px
node scripts\map_sweep.js --tree     # map: the track hierarchy as drawn
node scripts\map_sweep.js --stages all            # ...with every rung switched on
node scripts\map_sweep.js --tracks "AI Agent"     # ...focused, as the legend filters

node scripts\wire_check.js           # frontend: ids the JS asks for, index.html lacks
node scripts\css_check.js            # frontend: the [hidden] trap, dead tokens, dead ids
node scripts\lock_check.js           # frontend: holds, locked nodes, cell writes, undo

.\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt          # optional, sprint review only
.\.venv\Scripts\python.exe scripts\sprint_review.py --history 3

docker compose up -d --build        # serve it to the team; http://127.0.0.1:8000
docker compose logs -f              # one worker, so this is the whole story
docker compose down
```

**Serving it to other people.** `compose.yaml` publishes to `127.0.0.1` until
sign-in is armed at `/auth/settings`, and opening that line to `8000:8000` is the
deliberate act of letting the office in. With the gate off, anyone who can reach
the port can read the roadmap and `POST /api/import` over it — that route is
destructive by design. Secrets come from `.env` (copy `.env.example`); the rest
of the sign-in configuration is in the database and edited on the page.

> **Run it with one worker.** `/ws` keeps its connection registry in process
> memory, so a second worker would announce a write to half the open pages and
> leave the rest silently stale. The command above is single-worker already; the
> point is not to add `--workers` to it.

> **`--reload` runs `init_db()` — and therefore `db.migrate()` — against
> `data/roadmap.db` every time a source file is saved.** A half-finished edit is
> executed the moment it hits disk; it does not need to be run deliberately, or
> even to be finished. Before touching schema, migrations or anything destructive:
> stop the server, or point it at a copy. This has already cost the real dataset
> once — 24 phases and 33 deliverables, recovered from a backup.
>
> **Check for one before you start.** Two were found running in August, and a
> reload server left open is the likeliest explanation for a dataset that changed
> when nobody was using it:
> `Get-CimInstance Win32_Process -Filter "Name like '%python%'" | Where-Object { $_.CommandLine -like '*uvicorn*' }`
>
> `init_db()` now copies the file to `data/backups/roadmap-<stamp>.db` first,
> keeping the last ten. That makes the hazard recoverable; it does not make it
> safe, because the copy is only as old as the last start.

Type checking is pyright, `basic` mode, config in `pyrightconfig.json`.
`conftest.py` exists only to put the repo root on `sys.path`.

## Layout — where work goes

| Path | What lives there |
|---|---|
| `app/validation.py` | Every rule, derived date, derived stage and summary. **Pure functions, no I/O.** The heart of the tool — business logic belongs here, not in a route. |
| `app/db.py` | Schema, CRUD, `migrate`, export/import. Rows in/out as plain dicts. The only module that touches SQLite. |
| `app/markdown.py` | Splits a markdown file into blocks, renders one to HTML, serialises a table back. **Pure functions, no I/O** — the `validation.py` genre. **Knows nothing about sprints, and must not.** |
| `app/auth.py` | The OIDC sign-in flow and its pure predicates — `is_allowed`, the claim checks, the signed cookie. The `validation.py` genre, different subject: scheduling rules do not live here and OIDC does not live there. **A gate, not an account model.** |
| `app/config.py` | Reads `.env` into `os.environ` at import of `app.main`, via `python-dotenv` with `override=False`. Environment beats file; does nothing under pytest, because the real `.env` holds the client secret and often `MASTERMIND_SSO=off`. |
| `app/main.py` | FastAPI routes. Thin — assembly and HTTP only, no business logic. |
| `app/static/index.html` | The shell. Deleting an element here is a migration — see Working style. |
| `app/static/signin.html`, `sso.html` | The gate's own two documents: the sign-in page and the Sign-in configuration page. Separate from the shell **so they work when the shell cannot** — no project, gate never armed, or gate armed and broken. |
| `app/static/app.js` | Frontend: shell, four views (Project / Portfolio / Map / Sprint), all charts. ~2,800 lines. |
| `app/static/editor.js` | The Sprint tab's block editor. Its own file because `app.js` is already large; it reads `state`, `api`, `$` and `element` from there. **Knows nothing about sprints as a concept** — see the gate below. |
| `app/static/style.css` | One theme. Designed above the first chart rule, data-driven below it — see Working style. |
| `app/static/vendor/` | Third-party JS. Currently one file. Nothing else in the repo is vendored. |
| `tests/test_validation.py` | Rules, pure. |
| `tests/test_markdown.py` | The block model, mirroring `app/markdown.py`. The round trip is the gate. |
| `tests/test_api.py` | Acceptance criteria, via `TestClient` + `tmp_path` db. |
| `tests/test_sprint_review.py` | Sprint script — pure helpers + one `TestModel` run. Offline. |
| `templates/sprint.md` | The sprint template. **Tracked by git**, unlike `sprints/`. Copied to `sprints/NN.md` on create, and editable in the Sprint tab like a sprint file. |
| `sprints/NN.md` | One markdown file per fortnight. Gitignored. **The markdown file is the one record** — there is no sprint table and no sidecar store. |
| `scripts/sprint_review.py` | Post-sprint LLM review. Optional dep, lazy import, CLI only. |
| `scripts/map_sweep.js` | The map's collision sweep and tree dump. Node, no deps — loads the real `app.js` behind a stub DOM. **The map has no test suite; this is its verification.** It drives the real filters rather than reimplementing them. |
| `scripts/wire_check.js` | Runs `bindEvents()` behind a stub DOM and names every id the frontend asks for that `index.html` does not define. Node, no deps. |
| `scripts/css_check.js` | The `[hidden]`-versus-`display` trap, a `var()` with neither definition nor fallback, a rule for an id nothing creates, brace balance. Node, no deps. |
| `scripts/lock_check.js` | Two people in one sprint file: which node a hold names, what a locked one refuses, what a save owes as cells rather than blocks, a remote cell write merging into a grid being typed in, and which edits `Ctrl+Z` can take back without writing over somebody else's. Loads both frontend files in one scope behind a stub DOM. Node, no deps. |
| `Dockerfile`, `compose.yaml`, `.env.example` | How it is served to the team. One worker — the connection registry is process memory. Three mounts: `data/`, `sprints/`, `templates/sprint.md`, each irreplaceable for its own reason. |
| `.design/*.dc.html` | The UI as artboards, plus `canvas.json`. Source only; the published canvas beside them is gitignored. |
| `data/roadmap.db` | The dataset. Gitignored. `.bak` is an **old** backup, not a scratch slot. |

**Keep this shape.** Extend an existing module rather than adding a file; propose
a structure change before adding anything top-level. Test files mirror the module
they cover — a new rule is tested in `test_validation.py`, not a new file.

Two placement rules that are easy to get wrong:

- **A rule, a derived date or a summary goes in `validation.py`**, as a pure
  function taking `today` and its inputs as arguments. Reading the clock or the
  database inside it makes every test of it depend on the day it runs.
- **`markdown.py` and `editor.js` must stay ignorant of sprints.** The test a
  future reader can run: no string from `templates/sprint.md` appears in either.
  (`editor.js` names the *path* `templates/sprint.md` in the picker — a location,
  not a sprint concept.) Under that condition it is a markdown editor that happens
  to open sprint files, and the storage question stays uncommitted.

## Non-negotiables

Short list, because no commit records a decision *not* to build something. Detail
and argument are in `PROMPT.md`, `feature_request.md` and `git log`.

1. **The timeline never auto-reschedules.** Dates belong to the user. Every rule
   reports; nothing repairs. A plan may sit in a warning state forever. Layout and
   placement are user-triggered — a drop supplies the date, nothing is invented.
2. **Write-time refusals are for malformed data only, never for scheduling
   opinions.** There are exactly two: a dependency cycle (409) and a sprint file
   overlapping one on disk (409). Both refuse to *write* something bad; neither
   repairs something good.
3. **Weeks and points are entered independently.** Neither derives the other.
4. **Deliverables are planning units, not tasks.** Name + description + a `done`
   tick. No estimate, no assignee, no dates, no history. Charts may *draw* the
   tick; no rule, stage or stored value may *derive* from it. If asked for an
   intermediate state, push back — an enum is where this becomes the tracker the
   brief forbids.
5. **Promotion is a write, never an inference.** An idea stays an idea until
   someone presses the button.

   **`kind` is a label of the same family as `tier`** *(added 2026-09-03)* —
   `research`, `new`, `enhancement`, `feature`, `fix`, `migration`, `''`. The
   list may gain a word (`db.KINDS`, no `CHECK`); it is not meant to grow into a
   status enum.
   Nothing derives from it: no
   rule, no stage, no date, no default. Nothing sums points across it — that is
   the points-per-day constant the capacity design forbids. And it describes the
   work, never a person: `feature` means asked for from outside, and recording
   *who* asked makes it a row keyed by a person. PROMPT.md amendment 5 carries
   the argument.
6. **Rule numbering is never reused** (V5 is deleted, not dormant; FR numbers gap
   where things shipped). A gap means "look in `git log`".
7. **Never build:** ticket tracking, comments, activity feeds, notifications,
   accounts/roles/permissions, external integrations, BI dashboards, mobile
   layouts. The one LLM script is a knowing exception, not a precedent.

   **Narrowed 2026-08-21, not dropped.** Keycloak over OIDC is now built, and it
   is *a gate, not an account model*: the app asks the realm "is this you" and
   stores nothing about the answer. Still never built, and each is the line where
   the gate would become the tracker the brief forbids — a `user` table or any row
   keyed by a person, roles, permissions, per-user views, `created_by`, an
   assignee, an audit log, per-user preferences. Presence shows a name it was
   handed; it does not record one.

   **A readout is not a notification, and the difference is memory.** The overdue
   bell (`GET /api/late`) counts what is past its date, derived on read from the
   rows and today. Everyone sees the same list and nothing about it is stored, so
   it is the same genus as the offline badge beside it. It becomes the forbidden
   thing the moment it remembers: a dismissal, a snooze, a "new since you last
   looked", a per-person mute — each is a row keyed by a person. Push, email and
   a history of what was late last week are out for their own reasons (external
   integration; FR-6 needs a store). **The test before adding to it: does this
   need to remember who is looking?**

   **The gate is configured on its own page, secrets included** *(changed
   2026-08-21 — it was environment-only before, and PROMPT.md amendment 4 carries
   the argument).* Client secret, session key, redirect URI override and the
   plain-http flag are `sso_` columns in the settings row; the matching
   environment variables are a fallback, read only where a column is empty.
   `db.settings_without_sso` strips the whole `sso_` prefix from `/api/export`,
   which is the one line keeping a secret out of the JSON — **a sign-in column
   added without that prefix walks straight into the file.**

   **`data/roadmap.db` is therefore a secret-bearing file**, along with every copy
   in `data/backups/` and any `.bak`. Clear the secret on the page before handing
   one to anybody.

   **Two are not columns and must not become columns.** `MASTERMIND_SSO=off` is
   the recovery hatch, unreachable from inside a gate that is broken;
   `MASTERMIND_PUBLIC` decides whether the Sign-in page is itself gated, and as a
   column it could lock away the page that edits it. The AI provider key stays
   environment-only too — it belongs to a CLI script with no page.
8. **Still not to be built without asking** (PROMPT.md Phase 2): sprint generation
   from a project's date range, `sprint_goal` as a column, allocating deliverables
   into sprints against velocity, the delivery forecast. And **nothing sums points
   across a window** — that is a points-per-day constant in disguise, which the
   capacity design forbids outright.

## Working style here

- **Usable before pretty.** Given a working feature and a better-looking one, ship
  the working one. The chrome has had one deliberate design pass; **the charts are
  untouched, because their colours are data** — the split is marked in
  `style.css` and the test is whether a colour *means* something about the data.
- Python is `snake_case`; the JS follows JS convention (camelCase).
- **Answer questions before changing code — ask for confirmation before editing.**
- Surface architecture tradeoffs as 2–4 named options with one-line pro/con, then
  a recommendation.
- **Verify a destructive operation before it reaches the disk, not after.** The
  dev server watches these files, so saving is running. Prove out anything that
  drops, renames or rebuilds a table in a scratch database first — an in-memory
  SQLite script is thirty seconds — then write it. Being right two minutes late is
  indistinguishable from being wrong.
- **Back the data file up before schema work**, under a name that does not
  overwrite an existing backup.
- **Deleting an element from `index.html` is a frontend migration**, and nothing
  fails loudly when you get it wrong. `bindEvents()` addresses about a hundred ids;
  a `$()` that finds nothing returns **null**, the next property access throws, and
  every handler wired after that line silently never happens — including the boot
  call, the last statement in `app.js`. Run `node scripts\wire_check.js`. The tests
  are API-level and never load the page.
- **Editing `style.css` is the same kind of migration**, and quieter still. Chief
  trap: **`display` is never set on an element some code toggles with the `hidden`
  attribute** unless a `[hidden]` guard sits beside it — a class setting `display`
  outranks the UA sheet's `[hidden]`. Nine features have been broken invisibly by
  it. Run `node scripts\css_check.js`.
- Those two scripts plus `lock_check.js` and `map_sweep.js` are the **only**
  automated reading of the frontend there is. After them, look at the page.
- **No test may reach the real `sprints/`, `templates/sprint.md` or
  `data/roadmap.db`.** Point the module-level paths at `tmp_path`.
- Commit locally as work lands. **Never push or open a PR without approval.**
- Record decisions and open items in `STATUS.md` (gitignored, personal).
- **A built feature request is deleted from `feature_request.md`, not marked
  built** — the commits and `STATUS.md` are already that record, and a backlog
  carrying it too becomes a second, staler history. Keep only what still needs
  developing, plus won't-build entries and any half of a shipped feature still
  open, reopened under its own number.
