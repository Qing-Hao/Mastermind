from datetime import date

import pytest

from app.validation import (
    DEFAULT_SETTINGS,
    check_effort_duration_mismatch,
    check_phase_within_project,
    check_project_dependency_order,
    effective_velocity,
    find_dependency_cycle,
    implied_weeks,
    next_milestone,
    phase_end_date,
    project_effort_points,
    project_progress,
    project_span,
    validate_plan,
    validate_portfolio,
)

PROJECT = {
    "id": 1,
    "name": "Payments",
    "start_date": "2026-01-05",
    "velocity_override": None,
}

LEDGER = {
    "id": 2,
    "name": "Ledger",
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


# --- project span -----------------------------------------------------------


def test_span_runs_from_the_earliest_start_to_the_latest_end():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4),   # ends 2026-02-02
        make_phase(2, "Build", start="2026-02-02", weeks=6),    # ends 2026-03-16
    ]
    assert project_span(PROJECT, phases) == (date(2026, 1, 5), date(2026, 3, 16))


def test_span_start_can_precede_the_project_start_date():
    """A phase dated before its project still counts -- V4 reports that, and V2
    needs to see where the work really begins."""
    phases = [make_phase(1, "Design", start="2025-12-01", weeks=4)]
    start, _ = project_span(PROJECT, phases)
    assert start == date(2025, 12, 1)


def test_span_of_a_project_with_no_phases_has_no_end():
    assert project_span(PROJECT, []) == (date(2026, 1, 5), None)


def test_span_is_empty_when_nothing_is_scheduled():
    unscheduled = {**PROJECT, "start_date": ""}
    phases = [make_phase(1, "Design", start=""), make_phase(2, "Build", start="")]
    assert project_span(unscheduled, phases) == (None, None)


def test_span_ignores_unscheduled_phases_among_dated_ones():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4),
        make_phase(2, "Build", start=""),
    ]
    assert project_span(PROJECT, phases) == (date(2026, 1, 5), date(2026, 2, 2))


# --- V2 ---------------------------------------------------------------------


def test_v2_fires_when_successor_starts_before_predecessor_ends():
    predecessor_phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    successor_phases = [make_phase(2, "Build", start="2026-01-19", weeks=4)]
    successor = {**LEDGER, "start_date": "2026-01-19"}
    warning = check_project_dependency_order(
        PROJECT, predecessor_phases, successor, successor_phases
    )
    assert warning is not None
    assert warning.rule == "V2"
    assert warning.project_id == 2
    assert warning.related_project_id == 1
    assert warning.phase_id is None


def test_v2_silent_when_successor_starts_exactly_at_handoff():
    predecessor_phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    successor_phases = [make_phase(2, "Build", start="2026-02-02", weeks=4)]
    successor = {**LEDGER, "start_date": "2026-02-02"}
    assert phase_end_date(predecessor_phases[0]) == date(2026, 2, 2)
    assert check_project_dependency_order(
        PROJECT, predecessor_phases, successor, successor_phases
    ) is None


def test_v2_skipped_when_the_predecessor_has_no_scheduled_phases():
    """No phases means no derived end, so there is no handoff to be early for."""
    successor = {**LEDGER, "start_date": "2026-01-05"}
    assert check_project_dependency_order(
        PROJECT, [], successor, [make_phase(2, "Build", start="2026-01-05")]
    ) is None


def test_v2_skipped_while_the_successor_is_unscheduled():
    predecessor_phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    successor = {**LEDGER, "start_date": ""}
    assert check_project_dependency_order(
        PROJECT, predecessor_phases, successor, [make_phase(2, "Build", start="")]
    ) is None


# --- V3 ---------------------------------------------------------------------


def test_v3_returns_none_for_an_acyclic_graph():
    deps = [
        {"predecessor_project_id": 1, "successor_project_id": 2},
        {"predecessor_project_id": 2, "successor_project_id": 3},
        {"predecessor_project_id": 1, "successor_project_id": 3},
    ]
    assert find_dependency_cycle(deps) is None


def test_v3_detects_a_simple_cycle():
    deps = [
        {"predecessor_project_id": 1, "successor_project_id": 2},
        {"predecessor_project_id": 2, "successor_project_id": 1},
    ]
    cycle = find_dependency_cycle(deps)
    assert cycle is not None
    assert cycle[0] == cycle[-1]
    assert set(cycle) == {1, 2}


def test_v3_detects_a_longer_cycle():
    deps = [
        {"predecessor_project_id": 1, "successor_project_id": 2},
        {"predecessor_project_id": 2, "successor_project_id": 3},
        {"predecessor_project_id": 3, "successor_project_id": 1},
    ]
    cycle = find_dependency_cycle(deps)
    assert cycle is not None
    assert set(cycle) == {1, 2, 3}


def test_v3_detects_a_project_depending_on_itself():
    deps = [{"predecessor_project_id": 4, "successor_project_id": 4}]
    assert find_dependency_cycle(deps) == [4, 4]


# --- V4 ---------------------------------------------------------------------


def test_v4_fires_when_phase_precedes_its_project():
    phase = make_phase(start="2025-12-01")
    warning = check_phase_within_project(phase, PROJECT)
    assert warning is not None
    assert warning.rule == "V4"


def test_v4_silent_when_phase_starts_on_project_start():
    assert check_phase_within_project(make_phase(start="2026-01-05"), PROJECT) is None


# --- whole plan -------------------------------------------------------------


def test_validate_plan_collects_warnings_from_every_rule_it_owns():
    # Design sits before the project start (V4); Build has effort implying
    # 5.5w against 6w entered (V1).
    phases = [
        make_phase(1, "Design", start="2025-12-01", weeks=4, points=40),
        make_phase(2, "Build", start="2026-01-05", weeks=6, points=55),
    ]
    warnings = validate_plan(PROJECT, phases)
    assert {w.rule for w in warnings} == {"V1", "V4"}


def test_validate_plan_is_clean_for_a_consistent_plan():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4, points=40),
        make_phase(2, "Build", start="2026-02-02", weeks=6, points=60),
    ]
    assert validate_plan(PROJECT, phases) == []


def test_validate_plan_never_reports_v2():
    """Phase order inside a project is the user's business -- no rule reads it."""
    phases = [
        make_phase(1, "Design", start="2026-02-02", weeks=4, points=40),
        make_phase(2, "Build", start="2026-01-05", weeks=6, points=60),
    ]
    assert [w.rule for w in validate_plan(PROJECT, phases)] == []


# --- whole portfolio --------------------------------------------------------


def test_validate_portfolio_reports_v2_across_two_projects():
    phases = {
        1: [make_phase(1, "Design", start="2026-01-05", weeks=4, points=40)],
        2: [make_phase(2, "Build", start="2026-01-19", weeks=4, points=40)],
    }
    deps = [{"predecessor_project_id": 1, "successor_project_id": 2}]
    warnings = validate_portfolio(
        [PROJECT, {**LEDGER, "start_date": "2026-01-19"}], phases, deps
    )
    assert [w.rule for w in warnings] == ["V2"]
    assert warnings[0].project_id == 2


def test_validate_portfolio_is_clean_when_the_handoff_holds():
    phases = {
        1: [make_phase(1, "Design", start="2026-01-05", weeks=4, points=40)],
        2: [make_phase(2, "Build", start="2026-02-02", weeks=4, points=40)],
    }
    deps = [{"predecessor_project_id": 1, "successor_project_id": 2}]
    assert validate_portfolio(
        [PROJECT, {**LEDGER, "start_date": "2026-02-02"}], phases, deps
    ) == []


def test_validate_portfolio_ignores_dependencies_on_missing_projects():
    phases = {1: [make_phase(1, "Design", start="2026-01-05", weeks=4, points=40)]}
    deps = [{"predecessor_project_id": 1, "successor_project_id": 99}]
    assert validate_portfolio([PROJECT], phases, deps) == []


def test_validate_portfolio_handles_a_project_with_no_phases():
    deps = [{"predecessor_project_id": 1, "successor_project_id": 2}]
    assert validate_portfolio([PROJECT, LEDGER], {}, deps) == []


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
