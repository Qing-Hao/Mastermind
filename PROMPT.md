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
- `duration_weeks` — decimal, user-entered
- `effort_points` — integer, user-entered
- `sort_order`

Deliverables are **planning units, not tasks**: no assignee, no status, no comments,
no dates of their own. They are what gets converted into tasks in a downstream
system once the plan is agreed. Adding a status field to this table turns the tool
into the task tracker it is explicitly not.

Deliverables inside a phase are treated as **sequential**, so durations sum. Work
that genuinely runs in parallel belongs in separate phases.

**Dependency**
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
