"""Plan validation rules V1-V4.

Pure functions only: no database, no framework, no I/O. Every rule reports a
problem and never repairs it -- the timeline must never auto-reschedule, so a
plan is allowed to sit in a warning state indefinitely. V3 (dependency cycles)
is the sole exception: a cycle is malformed data rather than a scheduling
opinion, so callers are expected to reject the edit outright.

Inputs are plain mappings so this module stays decoupled from storage:

    settings:    default_velocity_points_per_sprint, sprint_length_days,
                 v1_tolerance_pct, v5_tolerance_pct
    project:     id, name, goal, start_date, velocity_override
    phase:       id, project_id, name, start_date, duration_weeks, effort_points
    deliverable: id, phase_id, name, duration_weeks, effort_points, sort_order
    dependency:  predecessor_phase_id, successor_phase_id

Dates may be ``datetime.date`` objects or ISO-8601 strings; both are accepted.
"""

from dataclasses import dataclass
from datetime import date, timedelta

DAYS_PER_WEEK = 7

DEFAULT_SETTINGS = {
    "default_velocity_points_per_sprint": 20,
    "sprint_length_days": 14,
    # Percent of duration_weeks that effort may disagree by before V1 fires.
    # 5% makes the canonical 6w / 55pts @ velocity 20 case warn, as intended.
    "v1_tolerance_pct": 5.0,
    # Percent the bottom-up deliverable rollup may disagree with the phase's
    # top-down estimate before V5 fires.
    "v5_tolerance_pct": 5.0,
}


@dataclass(frozen=True)
class PlanWarning:
    """A single detected problem. `rule` is one of V1, V2, V3, V4."""

    rule: str
    message: str
    phase_id: int | None = None
    related_phase_id: int | None = None

    def as_dict(self):
        return {
            "rule": self.rule,
            "message": self.message,
            "phase_id": self.phase_id,
            "related_phase_id": self.related_phase_id,
        }


def as_date(value):
    """Accept a date or an ISO-8601 string and return a date."""
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def phase_end_date(phase):
    """Derived end date. Never stored -- always computed from start + duration."""
    start = as_date(phase["start_date"])
    return start + timedelta(days=float(phase["duration_weeks"]) * DAYS_PER_WEEK)


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


def check_dependency_order(predecessor, successor):
    """V2: successor starts before its predecessor finishes."""
    successor_start = as_date(successor["start_date"])
    predecessor_end = phase_end_date(predecessor)
    if successor_start >= predecessor_end:
        return None

    return PlanWarning(
        rule="V2",
        phase_id=successor["id"],
        related_phase_id=predecessor["id"],
        message=(
            f"'{successor['name']}' starts {successor_start.isoformat()}, before "
            f"'{predecessor['name']}' finishes {predecessor_end.isoformat()}."
        ),
    )


def find_dependency_cycle(dependencies):
    """V3: return the phase ids forming a cycle, or None if acyclic.

    The returned path starts and ends on the same phase so it can be printed
    directly, e.g. [3, 7, 9, 3].
    """
    adjacency = {}
    for dep in dependencies:
        adjacency.setdefault(dep["predecessor_phase_id"], []).append(
            dep["successor_phase_id"]
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


def rollup_deliverables(deliverables):
    """Bottom-up totals for one phase, or None when there is nothing to roll up.

    Deliverables inside a phase are treated as sequential, so durations sum.
    Work that genuinely runs in parallel belongs in separate phases.
    """
    if not deliverables:
        return None
    return {
        "duration_weeks": round(sum(float(d["duration_weeks"]) for d in deliverables), 4),
        "effort_points": sum(int(d["effort_points"]) for d in deliverables),
        "count": len(deliverables),
    }


def beyond_tolerance(entered, rolled_up, tolerance_fraction):
    """A zero top-down estimate makes any non-zero rollup a mismatch."""
    if entered <= 0:
        return rolled_up > 0
    return abs(entered - rolled_up) > entered * tolerance_fraction


def check_rollup_mismatch(phase, deliverables, settings):
    """V5: the bottom-up rollup disagrees with the phase's top-down estimate.

    Neither number wins -- the phase keeps what was entered and the rollup is
    reported alongside it, the same way V1 treats weeks against points.
    """
    rollup = rollup_deliverables(deliverables)
    if not rollup:
        return None

    tolerance = float(settings["v5_tolerance_pct"]) / 100.0
    entered_weeks = float(phase["duration_weeks"])
    entered_points = float(phase["effort_points"])
    problems = []

    if beyond_tolerance(entered_weeks, rollup["duration_weeks"], tolerance):
        problems.append(
            f"duration rolls up to {rollup['duration_weeks']:g} weeks "
            f"against {entered_weeks:g} entered"
        )
    if beyond_tolerance(entered_points, rollup["effort_points"], tolerance):
        problems.append(
            f"points roll up to {rollup['effort_points']:g} "
            f"against {entered_points:g} entered"
        )

    if not problems:
        return None

    return PlanWarning(
        rule="V5",
        phase_id=phase["id"],
        message=(
            f"'{phase['name']}': {rollup['count']} deliverable(s) disagree with the "
            f"phase estimate -- " + "; ".join(problems) + "."
        ),
    )


def check_phase_within_project(phase, project):
    """V4: phase starts before the project it belongs to."""
    phase_start = as_date(phase["start_date"])
    project_start = as_date(project["start_date"])
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


# --- Whole-plan entry point -------------------------------------------------


def validate_plan(project, phases, dependencies, settings=None, deliverables_by_phase=None):
    """Run V1, V2, V4 and V5 across a project and return every warning found.

    V3 is deliberately excluded: a cycle blocks the edit that would create it,
    so it is checked by `find_dependency_cycle` at write time rather than being
    reported as an ignorable warning here.
    """
    settings = {**DEFAULT_SETTINGS, **(settings or {})}
    velocity = effective_velocity(project, settings)
    deliverables_by_phase = deliverables_by_phase or {}
    by_id = {phase["id"]: phase for phase in phases}
    warnings = []

    for phase in phases:
        mismatch = check_effort_duration_mismatch(phase, velocity, settings)
        if mismatch:
            warnings.append(mismatch)

        outside = check_phase_within_project(phase, project)
        if outside:
            warnings.append(outside)

        drift = check_rollup_mismatch(
            phase, deliverables_by_phase.get(phase["id"], []), settings
        )
        if drift:
            warnings.append(drift)

    for dep in dependencies:
        predecessor = by_id.get(dep["predecessor_phase_id"])
        successor = by_id.get(dep["successor_phase_id"])
        if not predecessor or not successor:
            continue
        violation = check_dependency_order(predecessor, successor)
        if violation:
            warnings.append(violation)

    return warnings
