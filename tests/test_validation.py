from datetime import date

import pytest

from app.validation import (
    DEFAULT_SETTINGS,
    check_dependency_order,
    check_effort_duration_mismatch,
    check_phase_within_project,
    check_rollup_mismatch,
    effective_velocity,
    find_dependency_cycle,
    implied_weeks,
    next_milestone,
    phase_end_date,
    project_effort_points,
    project_progress,
    rollup_deliverables,
    validate_plan,
)

PROJECT = {
    "id": 1,
    "name": "Payments",
    "start_date": "2026-01-05",
    "velocity_override": None,
}


# At the default velocity of 20 over a 14-day sprint, a consistent phase has
# points == weeks * 10. Fixtures below stick to that unless testing V1.
def make_phase(phase_id=1, name="Phase", start="2026-01-05", weeks: float = 6, points=60):
    return {
        "id": phase_id,
        "project_id": 1,
        "name": name,
        "start_date": start,
        "duration_weeks": weeks,
        "effort_points": points,
    }


# --- derived values ---------------------------------------------------------


def test_end_date_is_derived_from_start_plus_duration():
    phase = make_phase(start="2026-01-05", weeks=6)
    assert phase_end_date(phase) == date(2026, 2, 16)


def test_fractional_duration_rounds_down_to_whole_days():
    phase = make_phase(start="2026-01-05", weeks=1.5)
    assert phase_end_date(phase) == date(2026, 1, 15)


def test_project_override_beats_global_velocity():
    assert effective_velocity(PROJECT, DEFAULT_SETTINGS) == 20
    overridden = {**PROJECT, "velocity_override": 35}
    assert effective_velocity(overridden, DEFAULT_SETTINGS) == 35


def test_implied_weeks_matches_the_worked_example():
    assert implied_weeks(55, 20, 14) == pytest.approx(5.5)


def test_implied_weeks_is_none_when_velocity_is_zero():
    assert implied_weeks(55, 0, 14) is None


# --- V1 ---------------------------------------------------------------------


def test_v1_fires_on_the_acceptance_criterion_example():
    """6 weeks entered against 55 pts at velocity 20 implies 5.5 weeks."""
    phase = make_phase(weeks=6, points=55)
    warning = check_effort_duration_mismatch(phase, 20, DEFAULT_SETTINGS)
    assert warning is not None
    assert warning.rule == "V1"
    assert "5.5 weeks" in warning.message
    assert "6 weeks" in warning.message


def test_v1_silent_when_duration_matches_effort_exactly():
    phase = make_phase(weeks=6, points=60)
    assert check_effort_duration_mismatch(phase, 20, DEFAULT_SETTINGS) is None


def test_v1_respects_a_widened_tolerance():
    phase = make_phase(weeks=6, points=55)
    relaxed = {**DEFAULT_SETTINGS, "v1_tolerance_pct": 20.0}
    assert check_effort_duration_mismatch(phase, 20, relaxed) is None


def test_v1_skipped_for_zero_duration():
    phase = make_phase(weeks=0, points=55)
    assert check_effort_duration_mismatch(phase, 20, DEFAULT_SETTINGS) is None


# --- V2 ---------------------------------------------------------------------


def test_v2_fires_when_successor_starts_before_predecessor_ends():
    predecessor = make_phase(1, "Design", start="2026-01-05", weeks=4)
    successor = make_phase(2, "Build", start="2026-01-19", weeks=4)
    warning = check_dependency_order(predecessor, successor)
    assert warning is not None
    assert warning.rule == "V2"
    assert warning.phase_id == 2
    assert warning.related_phase_id == 1


def test_v2_silent_when_successor_starts_exactly_at_handoff():
    predecessor = make_phase(1, "Design", start="2026-01-05", weeks=4)
    successor = make_phase(2, "Build", start="2026-02-02", weeks=4)
    assert phase_end_date(predecessor) == date(2026, 2, 2)
    assert check_dependency_order(predecessor, successor) is None


# --- V3 ---------------------------------------------------------------------


def test_v3_returns_none_for_an_acyclic_graph():
    deps = [
        {"predecessor_phase_id": 1, "successor_phase_id": 2},
        {"predecessor_phase_id": 2, "successor_phase_id": 3},
        {"predecessor_phase_id": 1, "successor_phase_id": 3},
    ]
    assert find_dependency_cycle(deps) is None


def test_v3_detects_a_simple_cycle():
    deps = [
        {"predecessor_phase_id": 1, "successor_phase_id": 2},
        {"predecessor_phase_id": 2, "successor_phase_id": 1},
    ]
    cycle = find_dependency_cycle(deps)
    assert cycle is not None
    assert cycle[0] == cycle[-1]
    assert set(cycle) == {1, 2}


def test_v3_detects_a_longer_cycle():
    deps = [
        {"predecessor_phase_id": 1, "successor_phase_id": 2},
        {"predecessor_phase_id": 2, "successor_phase_id": 3},
        {"predecessor_phase_id": 3, "successor_phase_id": 1},
    ]
    cycle = find_dependency_cycle(deps)
    assert cycle is not None
    assert set(cycle) == {1, 2, 3}


def test_v3_detects_a_self_dependency():
    deps = [{"predecessor_phase_id": 4, "successor_phase_id": 4}]
    assert find_dependency_cycle(deps) == [4, 4]


# --- V4 ---------------------------------------------------------------------


def test_v4_fires_when_phase_precedes_its_project():
    phase = make_phase(start="2025-12-01")
    warning = check_phase_within_project(phase, PROJECT)
    assert warning is not None
    assert warning.rule == "V4"


def test_v4_silent_when_phase_starts_on_project_start():
    assert check_phase_within_project(make_phase(start="2026-01-05"), PROJECT) is None


# --- V5: bottom-up rollup ---------------------------------------------------


def make_deliverable(deliverable_id, name, weeks, points):
    return {
        "id": deliverable_id,
        "phase_id": 1,
        "name": name,
        "duration_weeks": weeks,
        "effort_points": points,
        "sort_order": deliverable_id,
    }


def test_rollup_is_none_without_deliverables():
    assert rollup_deliverables([]) is None


def test_rollup_sums_sequential_deliverables():
    """Deliverables inside a phase are sequential, so weeks add up."""
    rollup = rollup_deliverables([
        make_deliverable(1, "Payment intent API", 2.0, 20),
        make_deliverable(2, "Webhook receiver", 1.5, 15),
        make_deliverable(3, "Refund flow", 2.0, 20),
    ])
    assert rollup == {"duration_weeks": 5.5, "effort_points": 55, "count": 3}


def test_v5_silent_when_rollup_matches_the_phase():
    phase = make_phase(weeks=5.5, points=55)
    deliverables = [
        make_deliverable(1, "A", 2.0, 20),
        make_deliverable(2, "B", 1.5, 15),
        make_deliverable(3, "C", 2.0, 20),
    ]
    assert check_rollup_mismatch(phase, deliverables, DEFAULT_SETTINGS) is None


def test_v5_fires_when_points_roll_up_higher():
    phase = make_phase(weeks=6, points=55)
    deliverables = [
        make_deliverable(1, "A", 3.0, 40),
        make_deliverable(2, "B", 3.0, 30),
    ]
    warning = check_rollup_mismatch(phase, deliverables, DEFAULT_SETTINGS)
    assert warning is not None
    assert warning.rule == "V5"
    assert "points roll up to 70" in warning.message
    assert "against 55 entered" in warning.message


def test_v5_reports_duration_and_points_together():
    phase = make_phase(weeks=6, points=55)
    deliverables = [make_deliverable(1, "A", 2.0, 20)]
    warning = check_rollup_mismatch(phase, deliverables, DEFAULT_SETTINGS)
    assert warning is not None
    assert "duration rolls up to 2 weeks" in warning.message
    assert "points roll up to 20" in warning.message


def test_v5_treats_any_rollup_against_a_zero_estimate_as_a_mismatch():
    phase = make_phase(weeks=0, points=0)
    deliverables = [make_deliverable(1, "A", 1.0, 10)]
    assert check_rollup_mismatch(phase, deliverables, DEFAULT_SETTINGS) is not None


def test_v5_is_silent_with_no_deliverables_at_all():
    assert check_rollup_mismatch(make_phase(), [], DEFAULT_SETTINGS) is None


def test_v5_respects_a_widened_tolerance():
    phase = make_phase(weeks=6, points=60)
    deliverables = [make_deliverable(1, "A", 5.5, 55)]
    relaxed = {**DEFAULT_SETTINGS, "v5_tolerance_pct": 20.0}
    assert check_rollup_mismatch(phase, deliverables, relaxed) is None


def test_v5_never_alters_the_phase_estimate():
    """The rollup is reported beside the phase, it does not overwrite it."""
    phase = make_phase(weeks=6, points=55)
    deliverables = [make_deliverable(1, "A", 2.0, 20)]
    check_rollup_mismatch(phase, deliverables, DEFAULT_SETTINGS)
    assert phase["duration_weeks"] == 6
    assert phase["effort_points"] == 55


# --- whole plan -------------------------------------------------------------


def test_validate_plan_collects_warnings_from_every_rule():
    # Design sits before the project start (V4) and ends 2025-12-29; Build
    # starts before that handoff (V2) with effort that implies 5.5w not 6w (V1).
    phases = [
        make_phase(1, "Design", start="2025-12-01", weeks=4, points=40),
        make_phase(2, "Build", start="2025-12-20", weeks=6, points=55),
    ]
    deps = [{"predecessor_phase_id": 1, "successor_phase_id": 2}]
    warnings = validate_plan(PROJECT, phases, deps)
    assert {w.rule for w in warnings} == {"V1", "V2", "V4"}


def test_validate_plan_is_clean_for_a_consistent_plan():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4, points=40),
        make_phase(2, "Build", start="2026-02-02", weeks=6, points=60),
    ]
    deps = [{"predecessor_phase_id": 1, "successor_phase_id": 2}]
    assert validate_plan(PROJECT, phases, deps) == []


def test_validate_plan_includes_v5_for_phases_with_deliverables():
    phases = [make_phase(1, "Build", start="2026-01-05", weeks=6, points=60)]
    grouped = {1: [make_deliverable(1, "A", 2.0, 20)]}
    warnings = validate_plan(PROJECT, phases, [], None, grouped)
    assert [w.rule for w in warnings] == ["V5"]


def test_validate_plan_ignores_dependencies_pointing_at_missing_phases():
    phases = [make_phase(1, "Design", start="2026-01-05", weeks=4, points=40)]
    deps = [{"predecessor_phase_id": 1, "successor_phase_id": 99}]
    assert validate_plan(PROJECT, phases, deps) == []


# --- project summaries (map view) -------------------------------------------


def test_progress_counts_only_done_phases():
    phases = [
        {**make_phase(1), "status": "done"},
        {**make_phase(2), "status": "in_progress"},
        {**make_phase(3), "status": "planned"},
    ]
    assert project_progress(phases) == {"done": 1, "total": 3}


def test_progress_of_a_project_with_no_phases_is_zero_of_zero():
    assert project_progress([]) == {"done": 0, "total": 0}


def test_effort_points_sum_the_phases_own_estimates():
    phases = [make_phase(1, points=40), make_phase(2, points=15)]
    assert project_effort_points(phases) == 55


def test_effort_points_of_a_project_with_no_phases_is_zero():
    assert project_effort_points([]) == 0


def test_next_milestone_picks_the_soonest_boundary_ahead():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4),   # ends 2026-02-02
        make_phase(2, "Build", start="2026-03-02", weeks=2),
    ]
    # The Design end date beats the Build start date.
    assert next_milestone(phases, date(2026, 1, 10)) == "2026-02-02"


def test_next_milestone_ignores_boundaries_already_passed():
    phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    assert next_milestone(phases, date(2026, 3, 1)) is None


def test_next_milestone_counts_a_boundary_falling_today():
    phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    assert next_milestone(phases, date(2026, 1, 5)) == "2026-01-05"


def test_next_milestone_is_none_while_everything_is_unscheduled():
    phases = [make_phase(1, "Design", start=""), make_phase(2, "Build", start="")]
    assert next_milestone(phases, date(2026, 1, 5)) is None
