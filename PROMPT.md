# Build a Lightweight Internal Roadmap Planning Tool

## Objective

Build a lightweight internal web application that helps a product/engineering lead plan
software delivery from high-level roadmap down to sprint execution.

The long-term purpose is:

1. Plan projects and phases before committing dates
2. Estimate delivery duration based on weeks and effort
3. Visually arrange phases on a timeline
4. Manage dependencies between phases
5. Convert planned work into sprints *(Phase 2 — do not build yet)*
6. Calculate story point capacity and delivery forecast *(Phase 2 — do not build yet)*

**Build items 1–4 only.** Items 5 and 6 are documented here so the data model stays
forward-compatible, but they are explicitly out of scope for this build.

## Build priority

**Usable before pretty.** Correct data model and correct calculations first. Use plain,
unstyled or minimally-styled components. Do not invest effort in visual design, animation,
theming, or polish — the UI will be reworked once the tool is proven useful. If you find
yourself choosing between a working feature and a better-looking one, ship the working one.

## Non-goals

This is NOT a replacement for Jira, Linear, or a full project management system. Do not build:

- Ticket/issue tracking, comments, mentions, or activity feeds
  *(mentions narrowed by amendment 6 — `@handle` is text in a sprint file, and
  the readout of it remembers nothing; issues narrowed by amendment 7 — the app
  reads somebody else's tracker and links out to it, stores no issue and writes
  nothing back)*
- Notifications or email
  *(narrowed by amendment 6 — a bell derived on read is a readout; email and
  anything with unread state are still out)*
- User accounts, roles, or permissions
  *(narrowed by amendments 4 and 6 — a gate, and a directory of who exists. No
  roles, no permissions.)*
- Integrations with any external system
  *(narrowed by amendment 7 — one read-only reader of repository issues, off
  unless `MASTERMIND_ISSUES` says otherwise. Nothing else reaches out.)*
- Reporting/BI dashboards
- Mobile-specific layouts

## Technical constraints

- **Single user, local.** Runs on localhost. No authentication, no multi-user concurrency.
- **File-backed persistence.** SQLite file, or a single JSON file, in a known location.
  The data file must be trivially backup-able and human-inspectable.
- **JSON export/import** of the entire dataset is required (guards against the tool being
  a dead end, and doubles as backup).
- Pick a boring, mainstream stack; state your choice and why in one line before coding.

### Conventions

- Function naming: `snake_case` where idiomatic to the language (Python, Rust, SQL);
  follow the ecosystem standard where it is camelCase (JS/TS, Go, Java). Do not fight
  the linter.
- Keep the file structure organized. Extend existing modules rather than creating a new
  file per feature. Propose a structure change before adding new top-level files.

---

## Core User Workflow

> ⚠️ **VERIFY THIS SECTION** — reconstructed from the six objectives; the original was
> truncated. Correct or replace before handing this prompt to a builder.

The user should be able to:

1. Create a **project** with a name, description, a target start date, and a **goal** —
   free text they write themselves to stay on track.
2. Add **phases** to a project. Each phase has a name, description, a duration in weeks,
   an effort estimate in story points, and a status. This is the *top-down* estimate.
3. Break a phase into **deliverables**, each with its own week and point estimate entered
   by the user. This is the *bottom-up* estimate, and it is what later converts into tasks.
4. See the rollup of those deliverables **beside** the phase's own numbers, with a warning
   when they disagree (V5). Neither number wins automatically.
5. See all phases of a project laid out on a **horizontal timeline**, positioned by start
   date and sized by duration.
6. Switch to a **portfolio view** showing every project's phases on one shared time axis,
   to spot collisions across projects.
7. **Reposition a phase** by dragging its bar in the portfolio view, or by editing its
   start date in the phase table. Dragging snaps to whole days and moves only that phase.
8. Declare that phase B **depends on** phase A, and see a visual link between them.
9. See **warnings** when the plan is internally inconsistent (see Validation rules below).
10. **Export** the whole dataset to JSON and **import** it back.

---

## Data model

Design to this shape. Names are indicative, not mandatory.

**Settings** (single row / singleton)
- `default_velocity_points_per_sprint` — integer, default 20
- `sprint_length_days` — integer, default 14 *(configurable now, used in Phase 2)*
- `v1_tolerance_pct` — float, default 5.0 — how far effort and duration may disagree
  before V1 fires
- `v5_tolerance_pct` — float, default 5.0 — how far the bottom-up rollup may disagree
  with a phase's top-down estimate before V5 fires

**Project**
- `id`, `name`, `description`
- `goal` — free text. The user's own north star for the project, re-read when the
  plan starts drifting. Never parsed or validated.
- `start_date`
- `velocity_override` — nullable; when set, overrides the global default for this project
- `created_at`, `updated_at`

**Phase**
- `id`, `project_id`
- `name`, `description`
- `start_date`
- `duration_weeks` — decimal, user-entered
- `effort_points` — integer, user-entered
- `status` — enum: `planned` | `in_progress` | `done`
- `sort_order`

`end_date` is **derived** (`start_date + duration_weeks`), never stored.

**Deliverable**
- `id`, `phase_id`
- `name`, `description`
- ~~`duration_weeks`~~, ~~`effort_points`~~ — **removed, amendment 1** (see below)
- `done` — boolean, default false — **added, amendment 2** (see below)
- `sort_order`

Deliverables are **planning units, not tasks**: no assignee, no comments, no dates
of their own. They are what gets converted into tasks in a downstream system once
the plan is agreed.

### Amendments from the requester

The rules below were changed after the brief was written. Where they conflict with
the text above, **the amendment wins** — the code follows the amendments.

1. **Deliverables carry no estimate.** `duration_weeks` and `effort_points` were
   dropped from the table. Naming what a phase produces is the point; the phase
   holds the weeks and the points. This also retires **V5** and its
   `v5_tolerance_pct` setting: with no bottom-up numbers there is nothing to roll
   up, so acceptance criterion 10 no longer applies.
2. **Deliverables carry a `done` tick.** The original text said no status, on the
   grounds that it turns the tool into a task tracker. The requester wants to
   record finished vs. still ongoing, so the table gains one boolean and nothing
   else — no owner, no timestamps, no workflow. It is deliberately a tick rather
   than an enum: the moment it grows intermediate states it has become the status
   field this section warned about. It is recorded and displayed only — it fires
   no validation rule, does not set `phase.status`, and never moves a date.
3. **Dependencies link projects, not phases.** The requester does not want links
   inside a project — the useful question across a roadmap is which whole piece of
   work has to land before another can start. `predecessor_phase_id` /
   `successor_phase_id` became `predecessor_project_id` /
   `successor_project_id`, and the table is now `project_dependency`.

   This **removes** the only check on phase order inside a project, and that was
   accepted knowingly: phases keep `sort_order` and their dates, and nothing
   cross-checks them. Requirement 4 and acceptance criteria 3 and 4 above are to
   be read as being about projects.

   **V2** now compares derived project spans: a project's start is the earliest of
   its own `start_date` and its earliest scheduled phase, its end is the latest
   phase end inside it. Neither is stored. **V3** is unchanged except that it
   walks projects, which also makes a project depending on itself a cycle of
   length one. Existing phase-level links are lifted to the projects they linked
   when a pre-version-6 file is opened or imported; links that collapse onto a
   single project are discarded.

4. **The tool is used by a team, and sign-in is Keycloak's job.** The brief says
   single user, localhost only, no auth. Two of those are now over: several people
   plan out of one instance, and it is served to them rather than to one machine.

   What was built is **a gate, not an account model**. Keycloak answers "is this
   you" over OIDC; Mastermind stores nothing about the answer — no `user` table,
   no roles, no permissions, no `created_by`, no assignee, no audit log, no
   per-user preferences. The non-goal in **Non-goals** is narrowed to exactly
   that, not dropped: the moment a row is keyed by a person, this is the tracker
   the brief forbids.

   The whole gate is configured on its own page, secrets included: the client
   secret, the cookie signing key, the redirect URI override and the plain-http
   flag are columns in the settings row, and the environment variables that used
   to hold them are read only where a column is empty. **Amended 2026-08-21** —
   they were environment-only until then, on the argument that `/api/export`
   writes the settings row to JSON. That argument was answered rather than
   abandoned: every sign-in column is named `sso_` and the whole prefix is
   stripped from the export, so the JSON carries none of it. The cost, accepted
   deliberately, is that `data/roadmap.db` and its backups are now
   secret-bearing files — clear the secret before sharing one.

   Two stay in the environment and are not columns. `MASTERMIND_SSO=off` is the
   recovery hatch, and a hatch stored inside the thing it rescues is no hatch.
   `MASTERMIND_PUBLIC` describes the socket and decides whether the Sign-in page
   itself is gated; as a column it could lock away the page that edits it.

   The AI provider key is unchanged and still environment-only — it belongs to a
   CLI script with no page to configure it on.

5. **A project says what sort of work it is.** *(Added 2026-09-03.)* The brief
   describes one shape of work — a project with phases and deliverables — and the
   roadmap drew a greenfield build and a tweak to something already live
   identically. That is fine for the team, who know which is which, and useless
   for anyone being shown the roadmap: "here is what we are working on" cannot be
   answered by a picture that says only how much there is and how late it is.

   So `project.kind`: `research`, `new`, `enhancement`, `feature`, `fix`,
   `migration`, or `''` for unclassified, which is what every project written
   before the field arrives as. *(`migration` — the same capability, somewhere
   else — and `research` — finding out whether it can be done at all — were both
   added within a day of the rest.)*
   **It is `tier`'s twin, and the reason it is safe is that it is nothing more
   than that** — a label the map filters on, the roadmap chip and the swimlane
   gutter tag, and the portfolio counts.

   The lines it must not cross, all three of which would turn a label into the
   tracker **Non-goals** forbids:

   - **Nothing derives from it.** No rule reads it, no stage or date moves
     because of it, no default is chosen by it. "Enhancements need no
     checkpoint", "a new build gets contingency" — each is the scheduling
     opinion non-negotiable 1 rules out, wearing a new field's clothes.
   - **Nothing sums points across it.** The work mix counts *projects*. A points
     total per kind is a points-per-day constant in disguise, which the capacity
     design rules out outright, and it would make one large project look like the
     whole department.
   - **It is a property of the work, never of a person.** No "who asked for it",
     no requester, no owner. `feature` means asked for from outside the team; the
     moment it records *who* asked, it is a row keyed by a person.

   No `CHECK` on the column, deliberately: this vocabulary is likelier to gain a
   word than `stage` or `tier`, and changing a `CHECK` means rebuilding the
   project table — which has cost the real dataset once. `db.KINDS` is the list
   and `main.clean_kind` is the boundary. **That call paid for itself within a
   day**, when `migration` was added: one tuple, no migration.

   The list is closed at any moment and not fixed forever, so **a word is added
   deliberately, not casually** — seven buckets a roadmap can be read through is
   useful, and twenty is a tracker's status enum with extra steps. The test is
   whether somebody being shown the roadmap would ask about the difference.

6. **The gate keeps a directory of who exists.** *(Added 2026-09-08. Narrows
   amendment 4; it does not reverse it.)* Amendment 4 said the app stores nothing
   about the answer Keycloak gives, and named a `user` table as the line. One row
   per person now exists, and this is the argument for why that row is a
   directory rather than the account model amendment 4 refused.

   **The use case is specific and the design is deliberately not general.** The
   team writes `@QingHao` into a sprint file's **PIC** and **Reviewer** columns
   already — that convention predates this and is in `templates/sprint.md`. Three
   things were wanted from it: a picker so the name is spelled the way everyone
   else spells it, a way to see the rows that name you without reading four files,
   and a page showing what everyone is carrying. All three need one thing the app
   did not have: **a list of who exists**. Nothing more.

   So `person`: `sub`, `handle`, `display_name`. Populated by upsert at sign-in
   and seeded from `sso_allowlist`, which already names everyone permitted. It
   carries no role, no permissions, no preferences, and **no timestamps** — a
   `last_seen` would be the app remembering when it saw you, which is the first
   step back toward the thing this amendment is narrowing. It is excluded from
   `/api/export` for the reason the `sso_` columns are: an export is a file handed
   to somebody, and the directory rebuilds itself from the allowlist and the next
   sign-in.

   The lines this must not cross, each of which turns a directory into the tracker
   **Non-goals** forbids:

   - **Assignment is markdown, never a column.** A `PIC` cell naming you is text
     in a file the team edits, and `deliverable` gains no `assignee`. Amendment 2's
     reasoning holds unchanged: the moment assignment is a foreign key, the
     deliverable is a ticket.
   - **Nothing remembers who looked.** `GET /api/mine` scans the sprint files and
     derives its answer from them and the handle asked about, exactly as
     `/api/late` derives from the rows and today. The bell rings while a row
     naming you is not `Done` and stops when it is. **No dismissal, no snooze, no
     "new since you last looked", no per-person mute** — each of those is a row
     keyed by a person, and each is still refused.
   - **The dashboard is not gated and there is no root user.** "What is everyone
     carrying" is one page everyone can open, grouped by person, derived from the
     same scan. A viewer who sees more than another viewer is a permission, and a
     permission is the whole of what amendment 4 refused.
   - **The directory describes people, never their work.** It answers "who can be
     named"; it never accumulates what they were named in.

   **Deliberately specific, and generalisable later.** A directory keyed to one
   realm, matched against handles typed in one team's markdown convention, is not
   a user model and should not be mistaken for the beginning of one. If this is
   ever wanted generally, the work is a fresh decision recorded here — not an
   extra column added to `person` on the grounds that the table already exists.

7. **Issues are read from where the engineers already file them.** *(Added
   2026-09-09. Narrows the "Integrations with any external system" non-goal. The
   ticket-tracking non-goal is untouched — see the lines below.)* The engineers
   log issues in their repositories. Planning happens here. The two are read at
   different times by different people, so an issue that should have shaped a
   fortnight's plan is routinely not seen until after it was needed.

   What is built is **a reader, not a tracker**. An Issues page lists what is open
   across the configured repositories, and the Sprint tab carries a panel of
   repository names and open counts so the question is in front of whoever is
   planning. Every issue on both is **a link to the host's own page** — that is
   where an issue is read properly and where it is answered. Mastermind does not
   answer it.

   **Nothing is stored.** The server asks each host at request time, normalises
   the reply and renders it; there is no issue table, no comment body, no cached
   state, no sync job. It is the genus of `/api/late` and `/api/mine`: derived on
   read, remembering nothing, identical for everyone who opens it. A stored issue
   would drift from the host silently, and a drifting copy of somebody else's
   tracker is worse than no copy.

   **Off unless the deployment asks for it.** `MASTERMIND_ISSUES` is
   environment-only and is not a column, for a reason particular to it: the
   settings row travels in `/api/export`, so a column would carry the feature
   into an environment that was never meant to reach the internet. The flag
   describes the deployment, as `MASTERMIND_SSO` and `MASTERMIND_PUBLIC` do. With
   it off the routes are absent and the frontend shows neither the tab nor the
   panel.

   **The repositories are configured on the page**, in one `issues_repos` JSON
   column: provider, base URL, owner, repository, and a **per-repo token**,
   because a self-hosted Forgejo and github.com will never share a credential.
   Read-only scope is sufficient and is what should be issued. Every column is
   named `issues_` and the whole prefix is stripped from `/api/export`, exactly
   as `sso_` is — and for the same reason, with the same trap: **a column added
   without that prefix walks its token straight into the JSON.**

   Hosts are an **adapter registry in `app/issues.py`** — GitHub, GitLab and
   Forgejo to start. A fourth host is thirty lines of code in that file, and
   deliberately not a URL-template language in a settings dialog: authentication
   and pagination differ per host, so the configurable version would not have
   covered the fourth one anyway.

   The lines this must not cross:

   - **No issue is stored, and no issue is linked to a deliverable.** `deliverable`
     gains no `issue_id`, no `issue_url`, no external key of any kind. Amendment
     2's reasoning is unchanged and is the whole point: the moment a planning unit
     points at a ticket, it is one.
   - **No write-back.** No comment, no close, no label, no assignment. The link
     out is the feature. *(Write-back was asked for on 2026-09-09 and withdrawn in
     the same conversation in favour of the link — recorded because the reason was
     cost, not principle, and a later ask should be argued fresh rather than
     treated as settled.)*
   - **Nothing per-person.** No "issues assigned to me", no dismissal, no snooze,
     no unread count, no "new since you last looked". Each is a row keyed by a
     person, and amendment 6 refuses each already.
   - **Nothing derives from an issue.** No rule reads one, no date moves because of
     one, no count feeds a stage or a warning. The panel is a readout beside the
     plan, not an input to it.

   **The one place this crosses the brief rather than narrowing it: a change log.**
   `issues_audit` records changes to the Issues configuration — when a repository
   was added, removed or edited, and which field moved. **Non-goals** and
   amendment 4 both refuse an audit log, and this is one. It is allowed here on a
   bounded argument, and the bounds are the argument:

   - It logs **configuration of an external connection only** — never a project,
     phase, deliverable, sprint file or any planning data. An audit log over the
     plan is still refused outright.
   - It records **no person**. `at`, the repository it concerns, the field, and
     the old and new values. Not who. Recording the handle was offered on
     2026-09-09 and declined: it would be the second row keyed by a person that
     amendment 6 exists to prevent, and the precedent, not the column, is the
     cost.
   - It **never records a token value.** A changed token is logged as the fact
     that it changed. The `issues_` strip keeps the settings row out of the
     export; a log of old and new values would be a second copy of the secret with
     nothing protecting it.
   - It is excluded from `/api/export`, for the reason `person` and the `sso_`
     columns are: it describes this deployment's connections, not the dataset.

   The failure it exists to catch is "a repository stopped appearing and nobody
   knows when". If it is ever asked to answer "who changed this", that is a fresh
   decision argued here — not a column added because the table already exists.

8. **A roadmap row records who last changed each of its fields.** *(Added
   2026-09-17. This is the fresh decision the last line of amendment 7 asked for,
   and it **overturns two sentences written eight days earlier**: "an audit log
   over the plan is still refused outright", and the declining of a person on
   `issues_audit`. Both stood on the reasoning below being absent. It does not
   reopen roles, permissions, per-user views or an assignee column, each of which
   amendment 6 still refuses.)*

   The request, in the requester's words on 2026-08-24 and again on 2026-09-09:
   *"versioning history, so that I know who did the last changes for the items,
   it is easier for me to follow up."* Not an activity feed and not an approval
   trail — the ordinary question of who to go and ask when a date moved.

   **Why the plan gets a person when the connection log did not.** The two look
   alike and are not. `issues_audit` answers *"a repository stopped appearing and
   nobody knows when"* — a question about the deployment, which a timestamp alone
   settles; a handle there would have bought nothing and cost the precedent. The
   plan's question is *"this phase slipped a fortnight, who moved it"*, and the
   person **is the answer**. Declining it does not narrow the feature, it deletes
   it. That is the whole of the difference, and it is why this is argued here
   rather than added to the table that already exists.

   So `item_version`: `entity`, `entity_id`, `field`, `old_value`, `new_value`,
   `author`, `at` — deliberately the shape `issues_audit` already settled on, plus
   the author. One row per field changed, every row of one write sharing a stamp,
   append-only. `author` is the handle the gate hands over, stored as a **string
   copy and never a foreign key**: `person` gains no column, no row and no
   timestamp, and a handle that leaves the directory leaves a name behind in the
   log rather than a dangling link.

   **Bounded on a knob, and the default is generous.** The newest row for a field
   is kept permanently — it is what the hover tip reads, and a field untouched
   since January must still say who set it. The history behind it expires after
   `MASTERMIND_VERSION_KEEP_DAYS`, default **1825 days, about five years**. Said
   plainly: **at that default the prune will not fire for years**, so this is a
   mechanism that exists and is provable rather than a bound that currently bites.
   `0` switches it off. Environment-only and not a column, for amendment 7's
   reason: it governs how long rows naming people are kept, and a column would
   carry one deployment's retention decision into another through `/api/export`.

   The lines this must not cross:

   - **It is read, never derived from.** No rule, stage, date, warning or chart
     may read a version row. Non-negotiable 1 is untouched: nothing reschedules
     because of who typed something, and a field's history moves no date.
   - **Planning rows only** — project, phase, deliverable, milestone, quarter
     goal. **Not sprint files**, which are markdown the team edits and whose one
     record is the file; `Ctrl+Z` already answers "take that back" there.
   - **No second person-keyed row beyond this one.** No per-person filter of the
     log, no "changes since you last looked", no notification, no digest. Each is
     the thing amendment 6 refuses, and a log of writes is not a licence for them.
   - **A revert writes its own row**, naming whoever pressed it. An untraceable
     revert would be a hole in the one thing this table exists to be.
   - **Out of `/api/export`, and cleared by `/api/import`**, for the reason
     `person` is out: an export is a file that gets emailed, and this one names
     people. Import preserves ids, so a log carried onto another dataset would
     attach real names to rows that now mean something else — which is worse than
     no history at all.
   - **A failed log never fails a write.** With the gate off the author is empty
     and reads as unknown. The record is a record, not a gate.

   **`issues_audit` keeps its own bounds.** It is still connection settings only
   and still records no person; what changes is that its comment no longer claims
   the plan can never have a log. Two tables, two arguments, neither generalising
   to the other.

9. **A sprint file keeps its older selves, and a log of who saved it.** *(Added
   2026-09-17. Widens amendment 8, which said "planning rows only — not sprint
   files". That line was written the same day and was right about the mechanism
   and wrong about the want: the question it excluded — "what did this file look
   like on Tuesday" — was the original half of FR-23 and never went away.)*

   **Why amendment 8's table cannot simply be pointed at these files.**
   `item_version` is keyed `entity / entity_id / field`, and that works because a
   phase has a stable id and named columns. A sprint file has neither. Its unit of
   editing is a **block addressed by its index**, and the index shifts the moment
   anybody inserts a block above it; table cells are `row:col` and move the same
   way. Blame against a block index a week later would be confidently wrong rather
   than politely absent, which is worse than having none. **So there is no
   per-block blame here, and that is a limit, not an oversight.**

   What is built instead is two halves that answer the question between them:

   - **The file's older selves, anonymously.** `write_sprint_file` copies the
     current text aside before it overwrites, into `sprints/.history/`. Markdown
     stays markdown: **no sprint content enters the database**, which is the whole
     of the sprint design and the reason these are files and not rows. They are
     readable and restorable by hand with the app stopped, they ride the `sprints/`
     mount that already exists, and `sprint_files()` scans for `*.md` and never
     descends, so the app cannot mistake one for a sprint.
   - **Who saved it, in `sprint_edit`.** File, when, the handle, what the save
     replaced, and the snapshot it produced. This is the half that names a person,
     and it names one for amendment 8's reason: "who do I go and ask" is the
     question, and a save with no name answers half of it.

   **Coalesced on purpose.** The editor autosaves, so one snapshot per write would
   give forty copies of one afternoon — a history nobody can read through is not a
   history. One snapshot per file per ten minutes per author, and the most recent
   is always kept. Capped at `MASTERMIND_SPRINT_KEEP` per file (default 50, `0`
   for unlimited), environment-only for the reason
   `MASTERMIND_VERSION_KEEP_DAYS` is.

   The lines this must not cross:

   - **No per-block or per-cell blame**, for the reason above. If it is ever
     wanted, the work is stable identity inside the markdown — a change to the
     file format, and a fresh decision here.
   - **`templates/sprint.md` is not snapshotted.** It is tracked by git, which is
     already a better history than this one.
   - **Restoring is a write and logs itself**, through the same path as any other
     save. A restore that left no trace would be a hole in the only thing this
     exists to be.
   - **Nothing is listed across files.** A panel of everything that changed today
     is the activity feed **Non-goals** still refuses; you ask a file about
     itself, the way you ask a field about itself.
   - **Nothing derives from it.** No rule, no date, no warning reads a snapshot or
     an edit row, and no sprint content is parsed out of one.
   - **Out of `/api/export`**, like `item_version` and for the same reason — and
     the snapshots are not in it either, because sprint files never were.

Deliverables inside a phase are treated as **sequential**, so durations sum. Work
that genuinely runs in parallel belongs in separate phases.

**Dependency** *(superseded by amendment 3 — projects, not phases)*
- `id`
- `predecessor_phase_id`, `successor_phase_id`
- Finish-to-start only in v1. Do not model lag, lead, or other dependency types.

### Estimation model

Duration in weeks and effort in points are **entered independently** by the user. The tool
does not derive one from the other — it cross-checks them and warns on disagreement.

Effective velocity for a phase = its project's `velocity_override`, falling back to
`Settings.default_velocity_points_per_sprint`.

---

## Validation rules

These are the heart of the tool. Get them exactly right.

| ID | Rule | Behavior |
|----|------|----------|
| **V1** | Effort/duration mismatch: `implied_weeks = (effort_points / velocity) × (sprint_length_days / 7)`. Flag if `abs(duration_weeks − implied_weeks) > v1_tolerance_pct%` of `duration_weeks`. Default tolerance **5%** — chosen so the acceptance-criteria example below actually fires (a 20% tolerance would not). | **Warn.** Show both numbers and the delta. Never auto-correct. |
| **V2** | Dependency violation: successor's `start_date` is earlier than predecessor's derived `end_date`. | **Warn.** Highlight both phases and the link. Never auto-move anything. |
| **V3** | Dependency cycle. | **Block.** Reject the edit with a clear error naming the cycle. This is the one case that is not a warning. |
| **V4** | Phase starts before its project's `start_date`. | **Warn.** |
| **V5** | Bottom-up rollup disagrees with the phase's top-down estimate: `sum(deliverable.duration_weeks)` or `sum(deliverable.effort_points)` differs from the phase's own by more than `v5_tolerance_pct%`. A zero phase estimate against a non-zero rollup always counts as a mismatch. | **Warn.** Show both totals. The phase estimate is **never** overwritten by the rollup — same philosophy as V1. |

**Critical scheduling behavior:** the timeline **never auto-reschedules**. The user is
always in control of dates. Dependencies produce warnings, not movement. A plan is allowed
to be in a warning state — the tool shows problems, it does not fix them.

Warnings must be visible in two places: inline on the affected phase, and in a
project-level list so the user can see every problem at once.

---

## Acceptance criteria

The build is done when all of the following are true:

1. A user can enter a roadmap of ~5 phases across 2 projects, from empty state, in under
   15 minutes, without reading documentation.
2. Every phase appears on the timeline in the correct position and at the correct width.
3. Creating a dependency that violates V2 produces a visible warning on both phases and in
   the project warning list.
4. Attempting to create a dependency cycle is rejected with a message naming the cycle.
5. Entering `duration_weeks = 6` and `effort_points = 55` at velocity 20 produces a V1
   warning stating the implied duration is 5.5 weeks.
6. Closing and reopening the app preserves all data.
7. Export → wipe the data file → import restores the identical dataset.
8. No feature from the Non-goals list has been built.
9. A project's `goal` persists and survives an export/import round trip.
10. A phase with deliverables totalling 5.5w / 55pts against an entered 6w / 55pts
    raises V5 on duration only, and the phase's own 6w is left untouched.
11. The portfolio view shows every project's phases on one shared time axis, and
    dragging a bar changes only that phase's `start_date`.

---

## Phase 2 — documented, DO NOT BUILD

Recorded so the data model does not need reworking later:

- Generate sprints of `sprint_length_days` across a project's date range
- **Every sprint carries a `sprint_goal`** — free text, the same role `project.goal`
  plays at roadmap altitude: one sentence on what this sprint is actually for, so
  the sprint can be judged against intent rather than just ticket count. Entered by
  the user, never derived, never validated.
- Allocate deliverables into sprints against velocity — deliverables are the unit
  that becomes tasks, so this is the natural handoff point
- Per-sprint capacity adjustments for holidays, leave, and partial team availability
- Delivery forecast date derived from allocated vs. remaining points

Do not create tables, endpoints, or UI for these. The only concessions to Phase 2 in
this build are that `sprint_length_days` and velocity already exist in Settings, and
that deliverables are modelled as convertible-to-task planning units.

---

## Open questions for the requester

Answer before or during the build; do not guess silently:

1. Is drag-to-reposition on the timeline required for v1, or is editing a date field enough?
2. What is the expected scale — tens of phases, or hundreds? Affects whether the timeline
   needs virtualization.
3. Should phase `status` drive anything (filtering, timeline colour), or is it metadata only?
