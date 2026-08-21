"""Every plan validation rule, plus the derived views the frontend reads.

The rules, in one place, because a V-number on screen says nothing by itself:

    V1  effort points and duration weeks disagree, given velocity
    V2  a project starts before the one it depends on finishes
    V4  a phase starts before its own project does
    V6  a phase's derived end has passed and it is not done
    V7  a phase is closed but names nothing it delivered
    V8  a checkpoint is past its target date and is not ticked

`RULE_SUMMARY` below carries the same list as one-line sentences, because the
frontend needs to say this in a tooltip and a second copy of it there would
drift. **Both are the same six.**

Two numbers are missing and neither is dormant -- numbering is never reused, so
a gap means look in `git log`:

- **V3 is not a warning.** It is `find_dependency_cycle`, and it refuses the
  write that would create the cycle (409). A cycle is malformed data rather than
  a scheduling opinion, which is the whole distinction: everything above reports
  something bad about a good plan, V3 refuses to store a broken one.
- **V5 is deleted.** It cross-checked a bottom-up deliverable rollup against the
  phase estimate; a deliverable now only names something the phase produces, so
  there is nothing to roll up and the phase estimate stands alone.

Pure functions only: no database, no framework, no I/O. Every rule reports a
problem and never repairs it -- the timeline must never auto-reschedule, so a
plan is allowed to sit in a warning state indefinitely.

Dependencies link **projects**, not phases: the question this tool answers is
which piece of committed work has to land before another can begin. Ordering
inside a project is left to the user -- phases carry a sort order and dates, and
no rule checks them against each other.

Inputs are plain mappings so this module stays decoupled from storage:

    settings:    default_velocity_points_per_sprint, sprint_length_days,
                 v1_tolerance_pct
    project:     id, name, goal, start_date, velocity_override
    phase:       id, project_id, name, start_date, duration_weeks, effort_points
    deliverable: id, phase_id, name, sort_order
    dependency:  predecessor_project_id, successor_project_id

Dates may be ``datetime.date`` objects or ISO-8601 strings; both are accepted.

A start date may also be **empty**, which means "not scheduled yet". Planning
starts with week and point estimates only; dates get committed once the shape of
the work is settled. Empty is stored as ``""`` rather than NULL so it round-trips
through an HTML ``<input type="date">`` untouched. Rules that need a date (V2,
V4) skip unscheduled records; the estimate rule (V1) does not care about dates
and keeps working throughout.

The last section builds the **fortnight slice**: one fortnight of the roadmap
cut out and flattened for reading, as a lane per scheduled phase with the
deliverables each phase names underneath. Two things about it are load-bearing.
Nothing in it writes a date -- a slice is derived and thrown away, so a sprint
that overruns is recorded in the sprint file and never pushed back onto the
plan. And nothing in it pro-rates points: a lane carries its phase's whole
estimate and the overlap with the window is the bar's width, because summing
points across a window is a points-per-day constant in disguise.
"""

from dataclasses import dataclass
from datetime import date, timedelta

DAYS_PER_WEEK = 7
UNSCHEDULED = ""

DEFAULT_SETTINGS = {
    "default_velocity_points_per_sprint": 20,
    "sprint_length_days": 14,
    # Percent of duration_weeks that effort may disagree by before V1 fires.
    # 5% makes the canonical 6w / 55pts @ velocity 20 case warn, as intended.
    "v1_tolerance_pct": 5.0,
}

# What each rule checks, in one sentence, for the chip that carries its number.
# A `.rule` chip is bare text on screen and a V-number explains nothing on its
# own, so this is what the tooltip says. It lives here rather than in `app.js`
# because the rules do: a copy in the frontend would drift the first time one of
# these changed wording. Served by `GET /api/rules`.
#
# V3 is absent deliberately -- it refuses a write and never reaches a chip. See
# the module docstring.
RULE_SUMMARY = {
    "V1": "The effort points and the duration in weeks disagree, given velocity.",
    "V2": "This project starts before the one it depends on finishes.",
    "V4": "The phase starts before its own project does.",
    "V6": "The phase's end date has passed and it is not done.",
    "V7": "The phase is closed but names nothing it delivered.",
    "V8": "The checkpoint is past its target date and is not ticked.",
}


@dataclass(frozen=True)
class PlanWarning:
    """A single detected problem. `rule` is one of the numbers in `RULE_SUMMARY`.

    A warning names whatever it is about: V1, V4, V6 and V7 point at a phase, V2
    points at the two projects either side of a dependency, and V8 points at a
    checkpoint, which belongs to a project and to no phase at all. Every id field
    is always present in `as_dict`, whichever rule filled it in, so the frontend
    reads one shape and asks which fields are set rather than which rule it is.
    """

    rule: str
    message: str
    phase_id: int | None = None
    related_phase_id: int | None = None
    project_id: int | None = None
    related_project_id: int | None = None
    milestone_id: int | None = None

    def as_dict(self):
        return {
            "rule": self.rule,
            "message": self.message,
            "phase_id": self.phase_id,
            "related_phase_id": self.related_phase_id,
            "project_id": self.project_id,
            "related_project_id": self.related_project_id,
            "milestone_id": self.milestone_id,
        }


def as_date(value):
    """Accept a date or an ISO-8601 string and return a date. Strict."""
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def as_optional_date(value):
    """Like `as_date`, but an unset or unreadable date means "unscheduled".

    Unscheduled is a first-class state: a phase can be fully estimated in weeks
    and points long before anyone commits to a date. Reads are deliberately
    lenient -- a single bad value must never take down the whole project view.
    Writes are validated strictly at the API boundary instead.
    """
    if value is None:
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def is_scheduled(record):
    return as_optional_date(record.get("start_date")) is not None


def same_stored_value(stored, expected):
    """Is a value from the row the same as the one a writer expected?

    JSON and SQLite do not agree on shape: a tick is `true` on the wire and 1 in
    the column, and `duration_weeks` comes back 4.0 where it was sent 4. Neither
    difference is a change anyone made, so both are normalised before comparing.
    Everything else -- names, dates, empty strings, NULL velocity -- compares as
    it stands.
    """
    if isinstance(stored, bool) or isinstance(expected, bool):
        return bool(stored) == bool(expected)
    if (isinstance(stored, (int, float)) and isinstance(expected, (int, float))):
        return float(stored) == float(expected)
    return stored == expected


def stale_expectations(row, expected):
    """Which fields the writer was wrong about. Empty means the write is safe.

    The guard against two people overwriting each other: a write states what it
    believed was stored, and anything that has moved since is named back. Fields
    the row does not have are ignored rather than reported -- a caller cannot be
    stale about something that was never there.
    """
    return sorted(name for name, value in expected.items()
                  if name in row and not same_stored_value(row[name], value))


def phase_end_date(phase):
    """Derived end date, or None while the phase is unscheduled.

    Never stored -- always computed from start + duration.
    """
    start = as_optional_date(phase.get("start_date"))
    if start is None:
        return None
    return start + timedelta(days=float(phase["duration_weeks"]) * DAYS_PER_WEEK)


def project_span(project, phases):
    """The earliest and latest dates a project touches, as a `(start, end)` pair.

    Derived, never stored -- the same principle as `phase_end_date`. A project
    has a start date of its own but no duration, so its end can only come from
    the phases inside it.

    The start is the earliest of the project's own date and its earliest
    scheduled phase, because a phase may legitimately be dated before the
    project start (V4 warns about that separately, and V2 should still see the
    real beginning of the work). Either half is None when nothing is scheduled
    yet, which makes the project invisible to V2 on that side.
    """
    boundaries = [as_optional_date(project.get("start_date"))]
    ends = []

    for phase in phases:
        start = as_optional_date(phase.get("start_date"))
        if start is None:
            continue
        boundaries.append(start)
        ends.append(phase_end_date(phase))

    starts = [value for value in boundaries if value is not None]
    finals = [value for value in ends if value is not None]
    return (min(starts) if starts else None, max(finals) if finals else None)


def sequential_layout(phases, project_start):
    """Place unscheduled phases back to back from `project_start`, in order.

    Phases that already have a date are left exactly where they are; they only
    push the cursor forward so newly-placed work lands after them. Returns
    {phase_id: iso_date} for the phases that should be given a date.
    """
    cursor = as_optional_date(project_start)
    if cursor is None:
        return {}
    placements = {}

    for phase in phases:
        start = as_optional_date(phase.get("start_date"))
        if start is not None:
            end = phase_end_date(phase)
            if end and end > cursor:
                cursor = end
            continue
        placements[phase["id"]] = cursor.isoformat()
        cursor = cursor + timedelta(
            days=float(phase["duration_weeks"]) * DAYS_PER_WEEK
        )

    return placements


def relative_layout(phases):
    """Week offsets for phases laid back to back from week zero, in order.

    The calendar stripped out of `sequential_layout`: phases stack in the order
    given, each starting where the last one ended, measured in weeks from the
    beginning of the project rather than from a date. Dates on the phases are
    ignored entirely -- this is the shape of the plan before anyone commits to
    a calendar, which is exactly what makes it useful for arranging.

    Returns {phase_id: offset_weeks} as floats, so half-week durations land
    where they should. Feed the same phases in the same order to
    `sequential_layout` with a project start and the two agree day for day.
    """
    cursor = 0.0
    offsets = {}

    for phase in phases:
        offsets[phase["id"]] = cursor
        cursor += float(phase["duration_weeks"])

    return offsets


def effective_velocity(project, settings):
    """A project's velocity override, falling back to the global default."""
    override = project.get("velocity_override")
    if override:
        return int(override)
    return int(settings["default_velocity_points_per_sprint"])


def implied_weeks(effort_points, velocity, sprint_length_days):
    """Weeks that `effort_points` implies at the given velocity.

    Zero velocity would be a divide-by-zero; treat it as "cannot infer".
    """
    if not velocity:
        return None
    sprints = float(effort_points) / float(velocity)
    return sprints * (float(sprint_length_days) / DAYS_PER_WEEK)


# --- Individual rules -------------------------------------------------------


def check_effort_duration_mismatch(phase, velocity, settings):
    """V1: entered duration and entered effort disagree beyond tolerance."""
    duration = float(phase["duration_weeks"])
    inferred = implied_weeks(phase["effort_points"], velocity, settings["sprint_length_days"])
    if inferred is None or duration <= 0:
        return None

    tolerance_weeks = duration * (float(settings["v1_tolerance_pct"]) / 100.0)
    delta = abs(duration - inferred)
    if delta <= tolerance_weeks:
        return None

    return PlanWarning(
        rule="V1",
        phase_id=phase["id"],
        message=(
            f"'{phase['name']}': {phase['effort_points']} pts at velocity {velocity} "
            f"implies {inferred:g} weeks, but duration is set to {duration:g} weeks "
            f"(off by {delta:g} weeks)."
        ),
    )


def check_project_dependency_order(predecessor, predecessor_phases,
                                   successor, successor_phases):
    """V2: a project begins before the project it depends on has finished.

    Both ends are spans derived by `project_span`, so this compares the last day
    of work in the predecessor against the first day of work in the successor.
    Skipped while either side has nothing scheduled -- work with no date yet
    cannot be in the wrong order.
    """
    successor_start, _ = project_span(successor, successor_phases)
    _, predecessor_end = project_span(predecessor, predecessor_phases)
    if successor_start is None or predecessor_end is None:
        return None
    if successor_start >= predecessor_end:
        return None

    return PlanWarning(
        rule="V2",
        project_id=successor["id"],
        related_project_id=predecessor["id"],
        message=(
            f"'{successor['name']}' starts {successor_start.isoformat()}, before "
            f"'{predecessor['name']}' finishes {predecessor_end.isoformat()}."
        ),
    )


def find_dependency_cycle(dependencies):
    """V3: return the project ids forming a cycle, or None if acyclic.

    The returned path starts and ends on the same project so it can be printed
    directly, e.g. [3, 7, 9, 3]. A project depending on itself is a cycle of
    length one and is caught here too.
    """
    adjacency = {}
    for dep in dependencies:
        adjacency.setdefault(dep["predecessor_project_id"], []).append(
            dep["successor_project_id"]
        )

    WHITE, GREY, BLACK = 0, 1, 2
    color = {}
    path = []

    def visit(node):
        color[node] = GREY
        path.append(node)
        for next_node in adjacency.get(node, ()):
            state = color.get(next_node, WHITE)
            if state == GREY:
                return path[path.index(next_node):] + [next_node]
            if state == WHITE:
                found = visit(next_node)
                if found:
                    return found
        path.pop()
        color[node] = BLACK
        return None

    for node in list(adjacency):
        if color.get(node, WHITE) == WHITE:
            found = visit(node)
            if found:
                return found
    return None


def check_phase_within_project(phase, project):
    """V4: phase starts before the project it belongs to.

    Skipped while either the phase or the project is still undated.
    """
    phase_start = as_optional_date(phase.get("start_date"))
    project_start = as_optional_date(project.get("start_date"))
    if phase_start is None or project_start is None:
        return None
    if phase_start >= project_start:
        return None

    return PlanWarning(
        rule="V4",
        phase_id=phase["id"],
        message=(
            f"'{phase['name']}' starts {phase_start.isoformat()}, before the project "
            f"start {project_start.isoformat()}."
        ),
    )


def check_phase_overdue(phase, today):
    """V6: the phase's derived end has passed and it is not done.

    The counterpart to the derived `overdue` stage, one level down. A project
    only reads overdue once its *last* phase end has passed, which is too coarse
    to find anything early: a phase can sit a month past its end inside a project
    that still has months to run. This is the rule that actually finds it.

    Reports and repairs nothing, like every rule here -- a date that has slipped
    is the user's to move. Skipped while the phase is unscheduled, and skipped
    once it is done, because a phase that finished late is not a problem to fix.
    """
    if phase.get("status") == "done":
        return None
    end = phase_end_date(phase)
    if end is None or end >= as_date(today):
        return None

    return PlanWarning(
        rule="V6",
        phase_id=phase["id"],
        project_id=phase.get("project_id"),
        message=(
            f"'{phase['name']}' ended {end.isoformat()} but is still "
            f"'{phase.get('status')}'."
        ),
    )


def check_milestone_overdue(milestone, today):
    """V8: the checkpoint's target date has passed and it is not ticked.

    V6's counterpart for the other dated thing on a plan. Nothing found a late
    checkpoint before this, which mattered more once the ladder started deriving
    `done` from checkpoints rather than phases: the one object designed to carry
    the decision that a project is finished could sit weeks past its date without
    a word being said about it.

    Skipped while undated -- `target_date` follows the same `""` convention every
    other date here does -- and skipped once achieved, because a checkpoint
    reached late is not a problem to fix. Both are V6's rules, for V6's reasons.
    """
    if milestone.get("achieved"):
        return None
    due = as_optional_date(milestone.get("target_date"))
    if due is None or due >= as_date(today):
        return None

    return PlanWarning(
        rule="V8",
        project_id=milestone.get("project_id"),
        milestone_id=milestone["id"],
        message=(
            f"'{milestone['name']}' was due {due.isoformat()} and is not ticked."
        ),
    )


def check_phase_done_without_deliverables(phase, deliverables):
    """V7: the phase is done but never named what it delivered.

    Closing a phase is what completes a project now that `done` is derived, so
    this is the nudge that keeps the plan worth reading: a phase closed with
    nothing under it records no outcome at all.

    It reads deliverable **presence** and deliberately not the `done` tick.
    Presence is a planning fact -- the same fact `project_stage` reads -- while
    the tick is progress, and rule 4 keeps the tick from firing any rule. A
    phase closed with everything under it still unticked is fine here.
    """
    if phase.get("status") != "done":
        return None
    if deliverables:
        return None

    return PlanWarning(
        rule="V7",
        phase_id=phase["id"],
        message=(
            f"'{phase['name']}' is marked done but names no deliverables."
        ),
    )


# --- Project-level summaries ------------------------------------------------

# These answer "how is this going?" rather than "is this wrong?", so they are
# not rules and never produce a PlanWarning. The map view reads them.


def project_progress(phases):
    """Finished phases against the total. A project with no phases is 0 of 0."""
    return {
        "done": sum(1 for phase in phases if phase.get("status") == "done"),
        "total": len(phases),
    }


def deliverable_progress(deliverables):
    """Ticked deliverables against the total. A project naming none is 0 of 0.

    Display only, and that is the whole contract: the tick fires no rule, never
    sets `phase.status` and never moves a date (rule 4). This reads it so a chart
    can *show* how much of a project is finished, the same way `fortnight_lane`
    carries `done` -- so it can be shown, never so anything can be derived from
    it. Nothing in this module calls it, and the stage ladder still does not.

    0 of 0 is returned as it is rather than as a fraction, because there is no
    honest one: a project naming no deliverables is neither started nor complete.
    Every caller has to decide what to draw for it, which is the same 0-of-0 trap
    `milestones_all_achieved` guards and the reason deriving `done` from these
    ticks was declined.
    """
    return {
        "done": sum(1 for item in deliverables if item.get("done")),
        "total": len(deliverables),
    }


def completion_fraction(phases, deliverables_by_phase):
    """How far through a project is: phases are the 100%, deliverables split their own.

    **The plan is the frame and the ticks are the detail inside it.** Every phase
    owns an equal share of the project, and a phase's share is filled by the
    deliverables named *under that phase*. So a project is 1/3 done when one of
    its three phases is delivered, however many deliverables anybody wrote.

    Two flatter models were measured against the real file first and both were
    worse. Averaging the two ratios, or pooling every phase and deliverable into
    one bucket, let **granularity become weight**: a phase carrying 11
    deliverables outvoted a phase carrying 2, which is a fact about who wrote a
    longer checklist rather than about the project. Worse, on `Transaction Graph
    Fix` -- 2 of 2 deliverables ticked, but they sat under 1 of its 3 phases --
    both read about 60-67%, because "everything written down is ticked" was being
    read as "the project is nearly done". This reads 33%, which is what is true.

    Three rules, each a decision rather than an accident:

    - **A phase marked `done` counts as complete, whatever its ticks say.**
      Closing a phase is an explicit act, and it is the only way a phase whose
      deliverables went stale can ever finish. Checked first for that reason.
    - **A phase naming no deliverables falls back to its status**, so it is
      0 or 1 and nothing in between. 17 of the real file's 39 phases are in this
      state, which is the honest cost of the model: those phases carry no
      evidence, so a project made of them cannot climb until somebody either
      names work under them or closes them.
    - **`in_progress` counts 0**, like `planned`. It says work has started, not
      how much is finished, and turning "started" into a half would be the tool
      inventing a number. (It is no longer the unused value the notes once
      recorded -- one phase on the real file carries it.)

    Returns `None` for a project with no phases: with no frame there is no
    fraction, the same 0-of-0 refusal `deliverable_progress` makes. Every caller
    decides what to draw for that; nothing may treat it as zero.

    Shares are equal per phase rather than weighted by `effort_points`. V1 fires
    on every phase in the real file (FR-19), so the points and the durations
    already disagree everywhere -- weighting the one number read at a glance by
    the field the rules distrust would import that argument into it.
    """
    if not phases:
        return None

    shares = []
    for phase in phases:
        if phase.get("status") == "done":
            shares.append(1.0)
            continue
        named = deliverables_by_phase.get(phase["id"], [])
        shares.append(
            sum(1 for item in named if item.get("done")) / len(named)
            if named else 0.0)
    return sum(shares) / len(shares)


def project_effort_points(phases):
    """Top-down points across a project. The phase estimate is the only estimate
    there is -- deliverables carry no points of their own."""
    return sum(int(phase.get("effort_points") or 0) for phase in phases)


STAGE_IDEA = "idea"
STAGE_PLANNING = "planning"
STAGE_PLANNED = "planned"
STAGE_DATED = "dated"
STAGE_ACTIVE = "active"
STAGE_OVERDUE = "overdue"
STAGE_DONE = "done"

# The order the ladder climbs, for anything that wants to sort or compare.
STAGE_LADDER = (
    STAGE_IDEA, STAGE_PLANNING, STAGE_PLANNED, STAGE_DATED,
    STAGE_ACTIVE, STAGE_OVERDUE, STAGE_DONE,
)


def milestones_all_achieved(milestones):
    """True when a project has checkpoints and every one of them is ticked.

    The `and milestones` is the whole guard: `all()` over an empty list is True,
    so a project with no checkpoints would otherwise be vacuously complete -- the
    same 0-of-0 trap that ruled out deriving `done` from deliverable ticks.

    Nothing else in the module reads `achieved`, and nothing repairs it.
    """
    return bool(milestones) and all(
        milestone.get("achieved") for milestone in milestones)


def project_stage(project, phases, deliverables, milestones, today):
    """Where a project stands, derived from its own plan and the calendar.

    This replaced `project_readiness` and the four-step ladder behind it. That
    one measured plan completeness in absolute terms and, on a real dataset,
    answered `planning` for six of the seven projects it rendered on -- including
    every project that was actually running, because one phase with nothing named
    under it outranked every date on the plan. Two axes that disagreed about the
    same project turned out to be one axis asked badly.

    What the stored `project['stage']` column still decides, and all it decides:

    - `idea`   -- nobody has committed. Beats everything below it, so an idea
                  that somehow acquired dates still reads as an idea; the
                  portfolio filters on the stored value and the two must agree.
    - `done`   -- the manual close, and it wins outright. Not "delivered" but
                  "closed without finishing": work that is cancelled or descoped
                  never reaches every-phase-done, and without this hatch it would
                  sit overdue forever until the colour stopped meaning anything.

    Everything else is derived here, first match wins:

    - `done`     -- every milestone achieved, and there is at least one. See
                    `milestones_all_achieved` for why the count matters.
    - `overdue`  -- fully dated, the last phase end has passed, phases still
                    open. The one alarm in the vocabulary. `check_phase_overdue`
                    finds the same problem a level down and much earlier.
    - `active`   -- fully dated and today falls inside the span.
    - `dated`    -- fully dated, not started yet.
    - `planning` -- no phases, nothing named under any of them, or no checkpoint
                    to aim at.
    - `planned`  -- work named and at least one checkpoint set, waiting only for
                    dates.

    **`done` derives from milestones, and it used to derive from every phase
    carrying `status='done'`.** That route was unreachable in practice: on the
    real file `in_progress` had never been used once and 29 of 30 phases sat at
    the untouched default, so no project could finish itself and the only exit
    was the manual close -- a hatch built for *cancelled* work. Deriving from
    dates instead would have silenced V6, the only rule that has found real late
    work, and deriving from deliverable ticks would have broken rule 4, which
    keeps those casual on purpose. A milestone is the one object here designed to
    carry the decision, so it is the one that carries it.

    `phase.status` is therefore no longer read here at all. It keeps exactly one
    job -- feeding V6 and V7 -- which is worth knowing before changing either.

    **Dates outrank the planning gate deliberately.** Checking for checkpoints
    first reads a project that is dated and running as `planning` merely because
    nobody wrote one down, which is the exact inversion the `draft_complete`
    ordering existed to prevent. Once work is on the calendar the calendar speaks
    for it; checkpoint presence only ever decides between `planning` and
    `planned`, where the distinction is the whole question.

    A deliverable's `done` tick is not read here, only its presence -- see rule 4
    and `check_phase_done_without_deliverables`. `deliverables` is a flat list of
    the project's own; only `phase_id` is used. `milestones` is a flat list too.
    Nothing is stored, nothing is repaired.
    """
    stored = project.get("stage")
    if stored == "done":
        return STAGE_DONE
    if stored == "idea":
        return STAGE_IDEA

    if milestones_all_achieved(milestones):
        return STAGE_DONE

    if phases and is_scheduled(project) and all(is_scheduled(p) for p in phases):
        start, end = project_span(project, phases)
        if start is not None and end is not None:
            today = as_date(today)
            if end < today:
                return STAGE_OVERDUE
            if start <= today:
                return STAGE_ACTIVE
            return STAGE_DATED

    if not phases:
        return STAGE_PLANNING

    covered = {deliverable["phase_id"] for deliverable in deliverables}
    if not any(phase["id"] in covered for phase in phases):
        return STAGE_PLANNING

    # A plan with nothing to aim at is still being drafted. This replaced the
    # `draft_complete` switch, which asked the same question and had to be
    # answered twice: once by shaping the plan and again by flipping a toggle
    # that could then go stale. A checkpoint is evidence rather than a promise.
    if not milestones:
        return STAGE_PLANNING
    return STAGE_PLANNED


def next_phase_boundary(phases, today):
    """The next phase boundary falling on or after `today`, or None.

    Starts and ends both count: the next thing to happen to a project is either
    work beginning or work landing. Unscheduled phases have no boundary at all
    and are skipped, so a fully unscheduled project returns None.

    Named `next_milestone` until milestones became a real entity with a table of
    their own. This never was one: it derives a date off the phases and nothing
    stores it, where a milestone is a checkpoint you write down and tick.
    """
    today = as_date(today)
    upcoming = []

    for phase in phases:
        start = as_optional_date(phase.get("start_date"))
        if start is None:
            continue
        for boundary in (start, phase_end_date(phase)):
            if boundary is not None and boundary >= today:
                upcoming.append(boundary)

    return min(upcoming).isoformat() if upcoming else None


# --- Whole-plan entry point -------------------------------------------------


def validate_plan(project, phases, settings=None, deliverables_by_phase=None,
                  today=None, milestones=None):
    """Run V1, V4, V6, V7 and V8 across one project and return every warning.

    V2 is not here: it compares two projects, so it needs the whole portfolio
    and lives in `validate_portfolio`. V3 is excluded too -- a cycle blocks the
    edit that would create it, so it is checked by `find_dependency_cycle` at
    write time rather than being reported as an ignorable warning.

    `today`, `deliverables_by_phase` and `milestones` are the inputs the three
    newer rules need, and each defaults to None, which **skips that rule** rather
    than inventing the input. This module stays pure: reading the clock here
    would make every test of it depend on the day it runs, so the caller supplies
    the date the same way `next_phase_boundary` has always required it.

    V8 runs outside the phase loop because a checkpoint hangs off the project and
    not off a phase -- which is also why its warning names `milestone_id` and
    leaves `phase_id` empty.
    """
    settings = {**DEFAULT_SETTINGS, **(settings or {})}
    velocity = effective_velocity(project, settings)
    warnings = []

    for phase in phases:
        mismatch = check_effort_duration_mismatch(phase, velocity, settings)
        if mismatch:
            warnings.append(mismatch)

        outside = check_phase_within_project(phase, project)
        if outside:
            warnings.append(outside)

        if today is not None:
            late = check_phase_overdue(phase, today)
            if late:
                warnings.append(late)

        if deliverables_by_phase is not None:
            empty = check_phase_done_without_deliverables(
                phase, deliverables_by_phase.get(phase["id"], [])
            )
            if empty:
                warnings.append(empty)

    if milestones is not None and today is not None:
        for milestone in milestones:
            late = check_milestone_overdue(milestone, today)
            if late:
                warnings.append(late)

    return warnings


def validate_portfolio(projects, phases_by_project, dependencies):
    """Run V2 across every project dependency and return the warnings found.

    `phases_by_project` maps a project id to its phases; a project with none is
    allowed and simply has no derived end. Dependencies naming a project that no
    longer exists are skipped rather than raising -- the same leniency reads
    apply everywhere else.
    """
    by_id = {project["id"]: project for project in projects}
    warnings = []

    for dep in dependencies:
        predecessor = by_id.get(dep["predecessor_project_id"])
        successor = by_id.get(dep["successor_project_id"])
        if not predecessor or not successor:
            continue
        violation = check_project_dependency_order(
            predecessor, phases_by_project.get(predecessor["id"], []),
            successor, phases_by_project.get(successor["id"], []),
        )
        if violation:
            warnings.append(violation)

    return warnings


def days_late(due, today):
    """Whole days since `due` passed. Zero while it is today or still ahead.

    Derived here rather than in the browser for the reason every other derived
    date is: two implementations of "how late" would be free to disagree, and
    this one is read next to the message the rule already wrote.
    """
    if due is None:
        return 0
    return max((as_date(today) - as_date(due)).days, 0)


def overdue_items(projects, phases_by_project, milestones_by_project, today):
    """Everything past its date across the whole dataset, grouped by project.

    **V6 and V8 only.** This is not a portfolio-wide warning list -- that was
    built, removed at the requester's instruction, and is FR-2. It answers one
    question, *what is past its date*, which is the question a rule about whether
    an estimate hangs together cannot help with and would only bury: V1 fires on
    every phase in the real dataset (FR-19).

    It **calls the two rules rather than re-deriving them**, so there is exactly
    one definition of late and the boundary cases -- a done phase, a ticked or
    undated checkpoint, something due today -- are answered once.

    Reads whatever it is given: `projects` decides what is looked at at all, so
    handing it the schedulable set is what keeps ideas out. Groups with nothing
    late are dropped rather than sent empty.

    Worst first, within a group and between them, because the panel is read from
    the top and the oldest slip is the one to open. Nothing is stored, nothing is
    repaired, and nothing here knows who is reading it.
    """
    groups = []
    for project in projects:
        items = []

        for phase in phases_by_project.get(project["id"], []):
            late = check_phase_overdue(phase, today)
            if late:
                items.append({**late.as_dict(),
                              "days_late": days_late(phase_end_date(phase), today)})

        for milestone in milestones_by_project.get(project["id"], []):
            late = check_milestone_overdue(milestone, today)
            if late:
                due = as_optional_date(milestone.get("target_date"))
                items.append({**late.as_dict(),
                              "days_late": days_late(due, today)})

        if not items:
            continue
        items.sort(key=lambda item: -item["days_late"])
        groups.append({
            "project_id": project["id"],
            "name": project["name"],
            # Whatever the caller derived, if it derived one. The panel draws the
            # project's dot beside its name and this is the same rung the sidebar
            # shows; absent, the dot is simply not drawn.
            "derived_stage": project.get("derived_stage", ""),
            "items": items,
        })

    groups.sort(key=lambda group: -group["items"][0]["days_late"])
    return groups


# --- The fortnight slice ----------------------------------------------------

# A *slice* is one fortnight of the roadmap, cut out and flattened for reading:
# every scheduled phase touching a 14-day window, one lane each, with the
# following week carried along as a greyed lead-out so you can see what lands
# next. Deliverables ride under their phase by name, because they carry no
# dates and cannot be placed on a time axis at all.
#
# Two invariants live here specifically:
#
#   1. Nothing in this section writes a date, and nothing derived here is
#      stored -- the slice is rebuilt on every read.
#   2. No pro-rated points, anywhere. A lane carries `effort_points` whole; the
#      part of it that falls inside the window is the bar's width and nothing
#      else. A windowed points sum would be a points-per-day constant in
#      disguise, which the capacity design forbids outright.
#
# The functions are pure like the rest of the module: `today` arrives as an
# argument, and it is the caller that decides which projects to hand over.

FORTNIGHT_DAYS = 14
LEAD_OUT_DAYS = 7

BAND_OVERDUE = "overdue"
BAND_WINDOW = "window"
BAND_LEAD_OUT = "lead_out"

# Left to right on the strip: what has already slipped, what is in hand, what
# is coming. Lanes sort in this order.
BAND_ORDER = (BAND_OVERDUE, BAND_WINDOW, BAND_LEAD_OUT)


def fortnight_window(start, days=FORTNIGHT_DAYS, lead_out=LEAD_OUT_DAYS,
                     today=None):
    """The fortnight a slice covers, snapped back to the Monday of its week.

    `end` is **inclusive** -- the last day of the fortnight, not the day after
    it. The lead-out is the week that follows, drawn greyed, so the strip is
    `days + lead_out` columns wide even though the fortnight is `days` long.

    The requested start is echoed alongside the snapped one so the view can say
    that it snapped rather than silently moving what you clicked. Reading is
    strict here, unlike `as_optional_date`: a window is the frame everything
    else is measured against, and a frame that quietly failed to parse would
    hand back a slice of the wrong fortnight instead of an error.

    `today` is echoed back only when it falls **inside the drawn strip**, which
    includes the lead-out: the marker exists so the view can draw a today line,
    and a line that vanished as today crossed into the greyed week would leave
    the strip showing today with nothing on it. Outside the strip it is None
    and no line is drawn. Passing no `today` at all is the same thing -- the
    module never reads the clock itself.
    """
    requested = as_date(start)
    monday = requested - timedelta(days=requested.weekday())
    end = monday + timedelta(days=days - 1)
    marker = as_optional_date(today)
    lead_out_end = end + timedelta(days=lead_out)

    if marker is not None and not monday <= marker <= lead_out_end:
        marker = None

    return {
        "requested_start": requested.isoformat(),
        "start": monday.isoformat(),
        "end": end.isoformat(),
        "lead_out_start": (end + timedelta(days=1)).isoformat(),
        "lead_out_end": lead_out_end.isoformat(),
        "days": days,
        "today": marker.isoformat() if marker else None,
    }


def window_bounds(window):
    """A window's four dates as `date` objects, in strip order.

    `(start, end, lead_out_start, lead_out_end)`. The window travels as ISO
    strings because it is part of an API payload; everything that measures
    against it wants dates.
    """
    return (
        as_date(window["start"]),
        as_date(window["end"]),
        as_date(window["lead_out_start"]),
        as_date(window["lead_out_end"]),
    )


def phase_band(phase, window):
    """Which band of the slice a phase belongs to, or None if it is not in it.

    - `overdue`   -- ended before the window opened and is not done. This is
                     **window-relative, not clock-relative**, so it needs no
                     `today` and the function stays pure. `fortnight_slice`
                     bounds it further; see there.
    - `window`    -- overlaps the fortnight at all, inclusive of both edges.
    - `lead_out`  -- begins in the week after the fortnight.

    An unscheduled phase is in no band: it has no position on a time axis, and
    inventing one is what the staging tray exists to avoid.

    A phase end is the day work stops rather than the last day of work, so a
    phase ending exactly on `window.start` is neither overdue nor absent -- it
    lands in `window` and draws at the very left edge. Following the band rules
    literally is deliberate: the two tests either side of that boundary are
    `end < start` and `start <= end`, which between them leave no phase without
    a band.
    """
    start = as_optional_date(phase.get("start_date"))
    if start is None:
        return None

    window_start, window_end, lead_out_start, lead_out_end = window_bounds(window)
    end = phase_end_date(phase)

    if end is not None and end < window_start:
        if phase.get("status") == "done":
            return None
        return BAND_OVERDUE
    if start <= window_end:
        return BAND_WINDOW
    if lead_out_start <= start <= lead_out_end:
        return BAND_LEAD_OUT
    return None


def fortnight_lane(project, phase, band, deliverables, window):
    """One phase, flattened into everything the strip needs to draw it.

    Both clip flags are measured against the **drawn strip**, which runs from
    the window start to the end of the lead-out: they tell the renderer that a
    bar runs off an edge and needs a marker, and the edges it can run off are
    the ones on screen. A phase that merely crosses from the fortnight into the
    lead-out is not clipped -- both parts of it are drawn.

    `effort_points` and `duration_weeks` come through whole and unscaled, per
    invariant 2. Deliverables come through as name and tick only; the tick is
    carried so it can be shown, never so anything can be derived from it.
    """
    strip_start, _, _, strip_end = window_bounds(window)
    start = as_optional_date(phase.get("start_date"))
    end = phase_end_date(phase)

    return {
        "project_id": project["id"],
        "project_name": project.get("name"),
        "track": project.get("track"),
        "phase_id": phase["id"],
        "phase_name": phase.get("name"),
        "start_date": start.isoformat() if start else UNSCHEDULED,
        "end_date": end.isoformat() if end else UNSCHEDULED,
        "effort_points": phase.get("effort_points"),
        "duration_weeks": phase.get("duration_weeks"),
        "status": phase.get("status"),
        "band": band,
        "clipped_start": start is not None and start < strip_start,
        "clipped_end": end is not None and end > strip_end,
        "deliverables": [
            {
                "id": deliverable["id"],
                "name": deliverable.get("name"),
                "done": deliverable.get("done", 0),
            }
            for deliverable in deliverables
        ],
    }


def fortnight_slice(projects, phases_by_project, deliverables_by_phase, window):
    """Every phase in the window, as lanes, in the order the strip draws them.

    Lanes sort by band first, then by the order `projects` arrives in, then by
    the order each project's phases arrive in. Both orders are the caller's --
    `db.list_projects` and `db.list_phases` already impose the ones the
    portfolio swimlanes and the map slots share, and re-deriving them here
    would give the fortnight a fourth opinion about project order.

    Ideas are skipped. They are every stored stage `SCHEDULABLE_STAGES` leaves
    out, and the same reasoning applies twice over: nobody has committed, and
    the drawer opens off a portfolio chart that never drew them.

    **An overdue phase only appears if its project has other work in this
    window or lead-out.** Without that bound a phase that ended two years ago
    would surface in every fortnight forever. The slice answers "is this
    fortnight's work ok", not "what is late across the dataset" -- V6 already
    answers the second, globally and much earlier.
    """
    lanes = []

    for project in projects:
        if project.get("stage") == STAGE_IDEA:
            continue

        banded = []
        for phase in phases_by_project.get(project["id"], []):
            band = phase_band(phase, window)
            if band is not None:
                banded.append((band, phase))

        if not any(band != BAND_OVERDUE for band, _ in banded):
            continue

        for band, phase in banded:
            lanes.append(fortnight_lane(
                project, phase, band,
                deliverables_by_phase.get(phase["id"], []), window,
            ))

    # Stable, so project and phase order survive inside each band.
    lanes.sort(key=lambda lane: BAND_ORDER.index(lane["band"]))
    return lanes
