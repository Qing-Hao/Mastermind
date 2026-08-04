"""Plan validation rules V1-V4.

Pure functions only: no database, no framework, no I/O. Every rule reports a
problem and never repairs it -- the timeline must never auto-reschedule, so a
plan is allowed to sit in a warning state indefinitely. V3 (dependency cycles)
is the sole exception: a cycle is malformed data rather than a scheduling
opinion, so callers are expected to reject the edit outright.

V5 cross-checked a bottom-up deliverable rollup against the phase estimate. It
is gone: a deliverable now only names something the phase produces, so there is
nothing to roll up and the phase estimate stands alone.

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


@dataclass(frozen=True)
class PlanWarning:
    """A single detected problem. `rule` is one of V1, V2, V3, V4.

    A warning names whatever it is about: V1 and V4 point at a phase, V2 points
    at the two projects either side of a dependency. Both pairs of fields are
    always present in `as_dict` so the frontend can read one shape.
    """

    rule: str
    message: str
    phase_id: int | None = None
    related_phase_id: int | None = None
    project_id: int | None = None
    related_project_id: int | None = None

    def as_dict(self):
        return {
            "rule": self.rule,
            "message": self.message,
            "phase_id": self.phase_id,
            "related_phase_id": self.related_phase_id,
            "project_id": self.project_id,
            "related_project_id": self.related_project_id,
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


# --- Project-level summaries ------------------------------------------------

# These answer "how is this going?" rather than "is this wrong?", so they are
# not rules and never produce a PlanWarning. The map view reads them.


def project_progress(phases):
    """Finished phases against the total. A project with no phases is 0 of 0."""
    return {
        "done": sum(1 for phase in phases if phase.get("status") == "done"),
        "total": len(phases),
    }


def project_effort_points(phases):
    """Top-down points across a project. The phase estimate is the only estimate
    there is -- deliverables carry no points of their own."""
    return sum(int(phase.get("effort_points") or 0) for phase in phases)


def next_milestone(phases, today):
    """The next phase boundary falling on or after `today`, or None.

    Starts and ends both count: the next thing to happen to a project is either
    work beginning or work landing. Unscheduled phases have no boundary at all
    and are skipped, so a fully unscheduled project returns None.
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


def validate_plan(project, phases, settings=None):
    """Run V1 and V4 across a single project and return every warning found.

    V2 is not here: it compares two projects, so it needs the whole portfolio
    and lives in `validate_portfolio`. V3 is excluded too -- a cycle blocks the
    edit that would create it, so it is checked by `find_dependency_cycle` at
    write time rather than being reported as an ignorable warning.
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
