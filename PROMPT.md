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
- Notifications or email
- User accounts, roles, or permissions
- Integrations with any external system
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

   So `project.kind`: `new`, `enhancement`, `feature`, `fix`, or `''` for
   unclassified, which is what every project written before the field arrives as.
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

   Five values and no `CHECK` on the column, deliberately: this vocabulary is
   likelier to gain a word than `stage` or `tier`, and changing a `CHECK` means
   rebuilding the project table — which has cost the real dataset once. `db.KINDS`
   is the list and `main.clean_kind` is the boundary.

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
