from datetime import date, timedelta

import pytest

from app.validation import (
    DEFAULT_SETTINGS,
    check_effort_duration_mismatch,
    check_phase_within_project,
    check_project_dependency_order,
    effective_velocity,
    find_dependency_cycle,
    fortnight_milestones,
    fortnight_slice,
    fortnight_window,
    milestone_band,
    phase_band,
    implied_weeks,
    next_phase_boundary,
    phase_end_date,
    check_milestone_overdue,
    check_phase_done_without_deliverables,
    check_phase_overdue,
    days_late,
    overdue_items,
    phases_ready_to_close,
    project_effort_points,
    completion_fraction,
    deliverable_progress,
    project_progress,
    project_span,
    project_stage,
    relative_layout,
    retrack,
    same_stored_value,
    sequential_layout,
    stale_expectations,
    track_path,
    track_value,
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


# --- what a writer expected --------------------------------------------------


def test_a_tick_is_the_same_value_in_either_shape():
    assert same_stored_value(1, True)
    assert same_stored_value(0, False)
    assert not same_stored_value(1, False)


def test_a_whole_number_of_weeks_is_the_same_value_as_its_float():
    assert same_stored_value(4.0, 4)
    assert not same_stored_value(4.0, 4.5)


def test_text_and_empty_and_null_compare_as_they_stand():
    assert same_stored_value("", "")
    assert same_stored_value(None, None)
    assert not same_stored_value("", None)
    assert not same_stored_value("Design", "design")


def test_only_the_fields_that_moved_come_back():
    row = {"name": "Design", "effort_points": 55, "done": 1}
    assert stale_expectations(row, {"name": "Design", "done": True}) == []
    assert stale_expectations(row, {"name": "Discovery", "effort_points": 40}) == [
        "effort_points", "name"]


def test_a_field_the_row_does_not_have_is_not_stale():
    assert stale_expectations({"name": "Design"}, {"invented": "whatever"}) == []


def test_no_expectation_is_never_stale():
    assert stale_expectations({"name": "Design"}, {}) == []


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


# --- relative layout (the W1/W2 timeline) -----------------------------------


def test_relative_layout_stacks_phases_back_to_back_from_week_zero():
    phases = [
        make_phase(1, "Design", start="", weeks=2),
        make_phase(2, "Build", start="", weeks=4),
        make_phase(3, "QA", start="", weeks=1),
    ]
    assert relative_layout(phases) == {1: 0.0, 2: 2.0, 3: 6.0}


def test_relative_layout_of_no_phases_is_empty():
    assert relative_layout([]) == {}


def test_relative_layout_starts_a_single_phase_at_week_zero():
    assert relative_layout([make_phase(1, "Design", start="", weeks=3)]) == {1: 0.0}


def test_relative_layout_carries_half_weeks():
    phases = [
        make_phase(1, "Spike", start="", weeks=0.5),
        make_phase(2, "Build", start="", weeks=1.5),
        make_phase(3, "QA", start="", weeks=0.5),
    ]
    assert relative_layout(phases) == {1: 0.0, 2: 0.5, 3: 2.0}


def test_relative_layout_ignores_dates_already_on_the_phases():
    """Arranging is not scheduling: a dated phase stacks like any other, which
    is why the W-grid and the calendar can legitimately disagree."""
    phases = [
        make_phase(1, "Design", start="2026-06-01", weeks=2),
        make_phase(2, "Build", start="", weeks=4),
    ]
    assert relative_layout(phases) == {1: 0.0, 2: 2.0}


def test_relative_layout_agrees_with_sequential_layout():
    """The W-grid is the pre-image of 'Lay out sequentially': same order, same
    widths, so laying out later produces exactly the shape that was arranged."""
    phases = [
        make_phase(1, "Design", start="", weeks=2),
        make_phase(2, "Build", start="", weeks=4),
        make_phase(3, "QA", start="", weeks=1),
    ]
    project_start = date(2026, 1, 5)
    placements = sequential_layout(phases, project_start.isoformat())

    for phase_id, offset in relative_layout(phases).items():
        expected = project_start + timedelta(days=offset * 7)
        assert placements[phase_id] == expected.isoformat()


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


def test_deliverable_progress_counts_the_ticks():
    items = [{"done": 1}, {"done": 0}, {"done": 1}, {"done": 0}]
    assert deliverable_progress(items) == {"done": 2, "total": 4}


def test_deliverable_progress_of_a_project_naming_none_is_zero_of_zero():
    """Not 0% and not complete: there is no honest fraction of nothing.

    The same 0-of-0 trap that ruled out deriving a project's `done` rung from
    these ticks. Every caller decides what to draw for it; none may divide.
    """
    assert deliverable_progress([]) == {"done": 0, "total": 0}


# --- completion: phases are the frame, deliverables fill their own share -----


def tick(done):
    return {"done": 1 if done else 0}


def test_completion_gives_every_phase_an_equal_share():
    """Three phases, one delivered: a third, however many rows were written.

    The flat models this replaced would have read 100% here -- every deliverable
    in the project is ticked, but they all sit under one of the three phases.
    """
    phases = [make_phase(1), make_phase(2), make_phase(3)]
    assert completion_fraction(phases, {1: [tick(True), tick(True)]}) == 1 / 3


def test_a_phases_share_is_filled_by_the_deliverables_under_it():
    phases = [make_phase(1), make_phase(2)]
    named = {1: [tick(True), tick(True), tick(True), tick(False)], 2: [tick(False)]}
    # 3/4 of one phase and none of the other, halved.
    assert completion_fraction(phases, named) == 0.375


def test_granularity_does_not_become_weight():
    """One phase with 20 deliverables cannot outvote one with 2."""
    long_list = [tick(False)] * 20
    phases = [make_phase(1), make_phase(2)]
    assert completion_fraction(
        phases, {1: long_list, 2: [tick(True), tick(True)]}) == 0.5


def test_a_closed_phase_counts_whole_whatever_its_ticks_say():
    """Closing a phase is a decision, and the only exit for stale deliverables."""
    phases = [{**make_phase(1), "status": "done"}]
    assert completion_fraction(phases, {1: [tick(True), tick(False)]}) == 1.0


def test_a_phase_naming_nothing_falls_back_to_its_status():
    phases = [{**make_phase(1), "status": "done"}, make_phase(2)]
    assert completion_fraction(phases, {}) == 0.5


def test_in_progress_counts_as_nothing_finished():
    """It says work started, not how much is done. A half would be invented."""
    phases = [{**make_phase(1), "status": "in_progress"}]
    assert completion_fraction(phases, {}) == 0.0


def test_a_project_with_no_phases_has_no_completion_at_all():
    """No frame, no fraction -- and `None` is not zero. Callers draw nothing."""
    assert completion_fraction([], {}) is None


def test_effort_points_sum_the_phases_own_estimates():
    phases = [make_phase(1, points=40), make_phase(2, points=15)]
    assert project_effort_points(phases) == 55


def test_effort_points_of_a_project_with_no_phases_is_zero():
    assert project_effort_points([]) == 0


def test_next_phase_boundary_picks_the_soonest_boundary_ahead():
    phases = [
        make_phase(1, "Design", start="2026-01-05", weeks=4),   # ends 2026-02-02
        make_phase(2, "Build", start="2026-03-02", weeks=2),
    ]
    # The Design end date beats the Build start date.
    assert next_phase_boundary(phases, date(2026, 1, 10)) == "2026-02-02"


def test_next_phase_boundary_ignores_boundaries_already_passed():
    phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    assert next_phase_boundary(phases, date(2026, 3, 1)) is None


def test_next_phase_boundary_counts_a_boundary_falling_today():
    phases = [make_phase(1, "Design", start="2026-01-05", weeks=4)]
    assert next_phase_boundary(phases, date(2026, 1, 5)) == "2026-01-05"


def test_next_phase_boundary_is_none_while_everything_is_unscheduled():
    phases = [make_phase(1, "Design", start=""), make_phase(2, "Build", start="")]
    assert next_phase_boundary(phases, date(2026, 1, 5)) is None


# --- the derived stage ladder -----------------------------------------------


def deliverable(deliverable_id, phase_id, name="Wireframes"):
    return {"id": deliverable_id, "phase_id": phase_id, "name": name, "sort_order": 0}


def milestone(milestone_id, name="Private beta", achieved=0, target_date=""):
    return {"id": milestone_id, "name": name, "achieved": achieved,
            "target_date": target_date, "sort_order": 0}


# Committed work. 'planned' and 'active' are the same thing to the ladder, so
# these two fixtures differ only in their dates.
COMMITTED = {**PROJECT, "stage": "planned"}
UNDATED = {**PROJECT, "start_date": "", "stage": "planned"}

# One checkpoint, not yet reached: what a shaped-but-undelivered plan looks like.
OPEN = [milestone(1)]
REACHED = [milestone(1, achieved=1)]

# The fixture phase runs 2026-01-05 for six weeks, so it ends 2026-02-16.
DURING = date(2026, 1, 20)
BEFORE = date(2025, 12, 1)
AFTER = date(2026, 6, 1)


def test_a_project_with_no_phases_is_planning():
    assert project_stage(COMMITTED, [], [], OPEN, DURING) == "planning"


def test_a_project_whose_phases_name_nothing_is_planning():
    phases = [make_phase(1, "Design", start=""), make_phase(2, "Build", start="")]
    assert project_stage(UNDATED, phases, [], OPEN, DURING) == "planning"


def test_one_named_phase_is_enough_to_leave_planning():
    """Coverage is not all-or-nothing any more: the old rule read `planning`
    for six of seven real projects because one thin phase outranked everything."""
    phases = [make_phase(1, "Design", start=""), make_phase(2, "Build", start="")]
    assert project_stage(UNDATED, phases, [deliverable(1, 1)], OPEN,
                         DURING) == "planned"


def test_a_shaped_plan_with_no_dates_is_planned():
    phases = [make_phase(1, "Design", start="")]
    assert project_stage(UNDATED, phases, [deliverable(1, 1)], OPEN,
                         DURING) == "planned"


def test_the_same_plan_with_nothing_to_aim_at_is_planning():
    """Checkpoint presence replaced the `draft_complete` switch as this gate."""
    phases = [make_phase(1, "Design", start="")]
    assert project_stage(UNDATED, phases, [deliverable(1, 1)], [],
                         DURING) == "planning"


def test_a_fully_dated_project_reads_from_the_calendar():
    phases = [make_phase(1, "Design")]
    deliverables = [deliverable(1, 1)]
    assert project_stage(COMMITTED, phases, deliverables, OPEN, BEFORE) == "dated"
    assert project_stage(COMMITTED, phases, deliverables, OPEN, DURING) == "active"
    assert project_stage(COMMITTED, phases, deliverables, OPEN, AFTER) == "overdue"


def test_dates_outrank_the_planning_gate():
    """The inversion this ladder guards against: a project that is dated and
    running must never read `planning` merely because nobody wrote a checkpoint."""
    phases = [make_phase(1, "Design"), make_phase(2, "Build")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], [],
                         DURING) == "active"


def test_a_half_placed_project_is_not_on_the_calendar_yet():
    """One undated phase means the span is incomplete, so it stays in the tray."""
    phases = [make_phase(1, "Design"), make_phase(2, "Build", start="")]
    deliverables = [deliverable(1, 1), deliverable(2, 2)]
    assert project_stage(UNDATED, phases, deliverables, OPEN, DURING) == "planned"


def test_dated_phases_under_an_undated_project_are_not_scheduled_yet():
    phases = [make_phase(1, "Design"), make_phase(2, "Build")]
    deliverables = [deliverable(1, 1), deliverable(2, 2)]
    assert project_stage(UNDATED, phases, deliverables, OPEN, DURING) == "planned"


def test_the_ladder_ignores_whether_a_deliverable_is_ticked():
    """Naming the work is planning; ticking it is progress, which is not this."""
    phases = [make_phase(1, "Design")]
    ticked = [{**deliverable(1, 1), "done": 1}]
    unticked = [{**deliverable(1, 1), "done": 0}]
    assert project_stage(COMMITTED, phases, ticked, OPEN, DURING) == "active"
    assert project_stage(COMMITTED, phases, unticked, OPEN, DURING) == "active"


def test_done_is_derived_once_every_milestone_is_achieved():
    """What the plan was aiming at has been reached, so the plan is finished."""
    phases = [make_phase(1), make_phase(2)]
    reached = [milestone(1, "Private beta", achieved=1),
               milestone(2, "Launch", achieved=1)]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], reached,
                         AFTER) == "done"


def test_one_unreached_milestone_keeps_a_project_off_done():
    phases = [make_phase(1), make_phase(2)]
    mixed = [milestone(1, "Private beta", achieved=1), milestone(2, "Launch")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], mixed,
                         AFTER) == "overdue"


def test_a_project_with_no_milestones_is_never_vacuously_done():
    """`all([])` is True, which is the 0-of-0 trap. A plan aiming at nothing
    cannot have arrived, so the count is checked before the ticks."""
    phases = [make_phase(1), make_phase(2)]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], [],
                         AFTER) == "overdue"


def test_a_late_checkpoint_reads_overdue_inside_a_running_span():
    """The gap this closed: the last phase end had months to run, so the project
    read `active` while a checkpoint sat ten days past its date."""
    phases = [make_phase(1, "Design")]
    late = [milestone(1, "Private beta", target_date="2026-01-10")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], late,
                         DURING) == "overdue"


def test_a_ticked_checkpoint_is_never_late_however_old_its_date():
    """V8's rule, so V8's boundaries: reached late is not a problem to fix.

    The second checkpoint is what keeps this off `done` -- one ticked milestone
    on its own is every milestone, which is the rung above."""
    phases = [make_phase(1, "Design")]
    mixed = [milestone(1, "Private beta", achieved=1,
                       target_date="2026-01-10"),
             milestone(2, "Launch")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], mixed,
                         DURING) == "active"


def test_an_undated_checkpoint_cannot_be_late():
    phases = [make_phase(1, "Design")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], OPEN,
                         DURING) == "active"


def test_a_checkpoint_due_today_is_not_late_yet():
    phases = [make_phase(1, "Design")]
    today = [milestone(1, "Private beta", target_date=DURING.isoformat())]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], today,
                         DURING) == "active"


def test_a_late_checkpoint_beats_dated_before_the_work_starts():
    """A checkpoint dated before its own project is odd, but it has still
    passed, and the alarm outranks a span that has not opened."""
    phases = [make_phase(1, "Design")]
    late = [milestone(1, "Private beta", target_date="2025-11-01")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], late,
                         BEFORE) == "overdue"


def test_a_late_checkpoint_does_not_pull_an_undated_plan_to_overdue():
    """The placement decision: the alarm needs the project on the calendar
    first. V8 still reports this one, and `/api/late` still lists it."""
    phases = [make_phase(1, "Design", start="")]
    late = [milestone(1, "Private beta", target_date="2026-01-10")]
    assert project_stage(UNDATED, phases, [deliverable(1, 1)], late,
                         DURING) == "planned"


def test_every_checkpoint_reached_still_beats_a_late_one():
    """`done` is decided above the span, so a plan that arrived cannot then be
    re-read as late -- and an achieved checkpoint is not late anyway."""
    phases = [make_phase(1, "Design")]
    reached = [milestone(1, "Private beta", achieved=1,
                         target_date="2026-01-10")]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], reached,
                         AFTER) == "done"


def test_closing_every_phase_no_longer_derives_done():
    """`phase.status` fell out of the ladder: on the real file nothing
    maintained it, so this route was unreachable. It still feeds V6 and V7."""
    phases = [{**make_phase(1), "status": "done"},
              {**make_phase(2), "status": "done"}]
    assert project_stage(COMMITTED, phases, [deliverable(1, 1)], OPEN,
                         AFTER) == "overdue"


def test_the_manual_close_beats_the_ladder():
    """Cancelled work never reaches every checkpoint and must not nag forever."""
    closed = {**PROJECT, "stage": "done"}
    phases = [{**make_phase(1), "status": "planned"}]
    assert project_stage(closed, phases, [], OPEN, AFTER) == "done"


def test_an_idea_stays_an_idea_whatever_its_plan_says():
    """The portfolio filters on the stored stage, so the two must not disagree.
    Promoting an idea is a deliberate action, never an inference."""
    idea = {**PROJECT, "stage": "idea"}
    assert project_stage(idea, [], [], [], DURING) == "idea"
    phases = [make_phase(1, "Design")]
    assert project_stage(idea, phases, [deliverable(1, 1)], REACHED,
                         DURING) == "idea"


# --- V6 / V7 ----------------------------------------------------------------


def test_v6_fires_once_a_phase_end_has_passed():
    phase = make_phase(1, "Design")          # ends 2026-02-16
    warning = check_phase_overdue({**phase, "status": "planned"}, AFTER)
    assert warning is not None
    assert warning.rule == "V6"
    assert warning.phase_id == 1
    assert "2026-02-16" in warning.message


def test_v6_is_quiet_before_the_end_and_once_the_phase_is_done():
    phase = {**make_phase(1, "Design"), "status": "planned"}
    assert check_phase_overdue(phase, DURING) is None
    assert check_phase_overdue({**phase, "status": "done"}, AFTER) is None


def test_v6_skips_an_unscheduled_phase():
    phase = {**make_phase(1, "Design", start=""), "status": "planned"}
    assert check_phase_overdue(phase, AFTER) is None


def test_v7_fires_when_a_done_phase_names_nothing():
    phase = {**make_phase(1, "Design"), "status": "done"}
    warning = check_phase_done_without_deliverables(phase, [])
    assert warning is not None
    assert warning.rule == "V7"
    assert warning.phase_id == 1


def test_v7_reads_presence_and_never_the_tick():
    """Rule 4: the tick fires no rule. An unticked deliverable still counts."""
    phase = {**make_phase(1, "Design"), "status": "done"}
    unticked = [{**deliverable(1, 1), "done": 0}]
    assert check_phase_done_without_deliverables(phase, unticked) is None


def test_v7_is_quiet_while_the_phase_is_open():
    phase = {**make_phase(1, "Design"), "status": "planned"}
    assert check_phase_done_without_deliverables(phase, []) is None


def test_validate_plan_skips_the_newer_rules_without_their_inputs():
    """Both default to None, which skips rather than inventing a clock."""
    phases = [{**make_phase(1, "Design"), "status": "done"}]
    assert [w.rule for w in validate_plan(PROJECT, phases)] == []
    with_both = validate_plan(PROJECT, phases, None, {}, AFTER)
    assert [w.rule for w in with_both] == ["V7"]


# --- V8 ---------------------------------------------------------------------


def test_v8_fires_once_a_checkpoint_target_date_has_passed():
    late = {**milestone(4, "Ethics sign-off", target_date="2026-02-11"),
            "project_id": 1}
    warning = check_milestone_overdue(late, AFTER)
    assert warning is not None
    assert warning.rule == "V8"
    assert warning.milestone_id == 4
    assert warning.project_id == 1
    # V8 belongs to a project and to no phase, which is the whole reason
    # `milestone_id` had to exist.
    assert warning.phase_id is None
    assert "2026-02-11" in warning.message


def test_v8_is_quiet_once_the_checkpoint_is_ticked():
    """A checkpoint reached late is not a problem to fix. V6's rule, V6's reason."""
    reached = milestone(4, achieved=1, target_date="2026-02-11")
    assert check_milestone_overdue(reached, AFTER) is None


def test_v8_skips_an_undated_checkpoint():
    """`""` is unscheduled, here as everywhere else. Chased up in the project view."""
    assert check_milestone_overdue(milestone(4), AFTER) is None


def test_v8_is_quiet_on_the_day_it_is_due():
    """Due today is not late, matching V6's boundary exactly."""
    due_today = milestone(4, target_date=DURING.isoformat())
    assert check_milestone_overdue(due_today, DURING) is None
    assert check_milestone_overdue(due_today, AFTER) is not None


# --- what is past its date, across everything -------------------------------


def open_phase(phase_id, name, start, project_id=1):
    return {**make_phase(phase_id, name, start=start, weeks=1, points=10),
            "project_id": project_id, "status": "planned"}


def test_days_late_counts_only_backwards():
    """Today and anything ahead of it are zero, never negative."""
    assert days_late("2026-01-05", "2026-01-20") == 15
    assert days_late("2026-01-20", "2026-01-20") == 0
    assert days_late("2026-02-20", "2026-01-20") == 0
    assert days_late(None, "2026-01-20") == 0


def test_overdue_items_carries_both_rules_worst_first():
    phases = {1: [open_phase(1, "Design", "2026-01-05"),      # ends 2026-01-12
                  open_phase(2, "Build", "2026-05-04")]}      # ends 2026-05-11
    milestones = {1: [milestone(9, "Ethics sign-off",
                                target_date="2026-03-02")]}
    groups = overdue_items([PROJECT], phases, milestones, date(2026, 6, 1))

    assert len(groups) == 1
    assert groups[0]["project_id"] == 1 and groups[0]["name"] == "Payments"
    # Worst first: Design slipped in January, the checkpoint in March, Build in
    # May. Both rules are in one list, ordered by how late rather than by kind.
    assert [(item["rule"], item["days_late"]) for item in groups[0]["items"]] == [
        ("V6", 140), ("V8", 91), ("V6", 21)]


def test_overdue_items_drops_a_project_with_nothing_late():
    phases = {1: [open_phase(1, "Design", "2026-01-05")],
              2: [open_phase(3, "Ship", "2026-09-07", project_id=2)]}
    groups = overdue_items([PROJECT, LEDGER], phases, {}, date(2026, 6, 1))

    assert [group["project_id"] for group in groups] == [1]


def test_overdue_items_looks_only_at_the_projects_it_is_given():
    """`projects` is the filter -- an idea never reaches this at all."""
    phases = {1: [open_phase(1, "Design", "2026-01-05")],
              2: [open_phase(3, "Ship", "2026-01-05", project_id=2)]}
    groups = overdue_items([LEDGER], phases, {}, date(2026, 6, 1))

    assert [group["project_id"] for group in groups] == [2]


def test_overdue_items_asks_the_rules_rather_than_the_dates():
    """A done phase and a ticked checkpoint are both silent, as V6 and V8 say."""
    phases = {1: [{**open_phase(1, "Design", "2026-01-05"), "status": "done"}]}
    milestones = {1: [milestone(9, achieved=1, target_date="2026-03-02")]}
    assert overdue_items([PROJECT], phases, milestones, date(2026, 6, 1)) == []


def test_overdue_items_orders_projects_by_their_worst():
    phases = {1: [open_phase(1, "Design", "2026-05-04")],
              2: [open_phase(3, "Ship", "2026-01-05", project_id=2)]}
    groups = overdue_items([PROJECT, LEDGER], phases, {}, date(2026, 6, 1))

    assert [group["project_id"] for group in groups] == [2, 1]


# --- phases waiting to be closed --------------------------------------------

# The alert's second list. A readout, not a rule: it reports that a phase's ticks
# and its status disagree, and every one of these tests is about it *reporting*.
# Rule 4 is the last one, and it is the important one.


def ticked(deliverable_id, phase_id, done=1, name="Wireframes"):
    return {**deliverable(deliverable_id, phase_id, name), "done": done}


def test_ready_to_close_names_a_phase_with_every_box_ticked():
    phases = {1: [open_phase(1, "Design", "2026-01-05")]}
    by_phase = {1: [ticked(10, 1), ticked(11, 1, name="Copy")]}
    groups = phases_ready_to_close([PROJECT], phases, by_phase)

    assert len(groups) == 1
    assert groups[0]["project_id"] == 1 and groups[0]["name"] == "Payments"
    item = groups[0]["items"][0]
    assert item["phase_id"] == 1 and item["name"] == "Design"
    assert (item["done"], item["total"]) == (2, 2)
    assert item["message"] == (
        "'Design' has all 2 deliverables ticked and is not marked done.")


def test_ready_to_close_is_silent_while_a_box_is_open():
    phases = {1: [open_phase(1, "Design", "2026-01-05")]}
    by_phase = {1: [ticked(10, 1), ticked(11, 1, done=0, name="Copy")]}

    assert phases_ready_to_close([PROJECT], phases, by_phase) == []


def test_ready_to_close_skips_a_phase_already_done():
    """It has no button left to offer, whatever its ticks say."""
    phases = {1: [{**open_phase(1, "Design", "2026-01-05"), "status": "done"}]}
    by_phase = {1: [ticked(10, 1)]}

    assert phases_ready_to_close([PROJECT], phases, by_phase) == []


def test_ready_to_close_never_calls_an_empty_phase_ready():
    """0 of 0 is not complete -- `deliverable_progress`'s refusal, one level up.

    A phase that names nothing is V7's business, not this one's.
    """
    phases = {1: [open_phase(1, "Design", "2026-01-05")]}

    assert phases_ready_to_close([PROJECT], phases, {}) == []
    assert phases_ready_to_close([PROJECT], phases, {1: []}) == []


def test_ready_to_close_drops_a_project_with_nothing_ready():
    phases = {1: [open_phase(1, "Design", "2026-01-05")],
              2: [open_phase(3, "Ship", "2026-01-05", project_id=2)]}
    by_phase = {1: [ticked(10, 1, done=0)], 3: [ticked(30, 3)]}
    groups = phases_ready_to_close([PROJECT, LEDGER], phases, by_phase)

    assert [group["project_id"] for group in groups] == [2]


def test_ready_to_close_looks_only_at_the_projects_it_is_given():
    """`projects` is the filter, exactly as it is for `overdue_items`."""
    phases = {1: [open_phase(1, "Design", "2026-01-05")],
              2: [open_phase(3, "Ship", "2026-01-05", project_id=2)]}
    by_phase = {1: [ticked(10, 1)], 3: [ticked(30, 3)]}
    groups = phases_ready_to_close([LEDGER], phases, by_phase)

    assert [group["project_id"] for group in groups] == [2]


def test_ready_to_close_changes_nothing_it_reads():
    """**Rule 4.** The tick sets no stored value -- this one reports and stops."""
    phase = open_phase(1, "Design", "2026-01-05")
    rows = [ticked(10, 1)]
    phases_ready_to_close([PROJECT], {1: [phase]}, {1: rows})

    assert phase == open_phase(1, "Design", "2026-01-05")
    assert phase["status"] == "planned"
    assert rows == [ticked(10, 1)]


# --- the fortnight slice ----------------------------------------------------


# Monday 2026-08-03 to Sunday 2026-08-16, lead-out 2026-08-17 to 2026-08-23.
WINDOW = fortnight_window("2026-08-03")

COMMITTED_PROJECT = {**PROJECT, "stage": "planned", "track": "Core / Billing"}
SECOND_PROJECT = {**LEDGER, "stage": "planned", "track": "Core"}


def slice_phase(phase_id=1, name="Build", start="2026-08-04", weeks: float = 1,
                points=10, project_id=1, status="in_progress"):
    return {**make_phase(phase_id, name, start, weeks, points),
            "project_id": project_id, "status": status}


def band_of(**kwargs):
    return phase_band(slice_phase(**kwargs), WINDOW)


def test_the_window_snaps_back_to_its_monday_and_says_that_it_did():
    window = fortnight_window("2026-08-05")          # a Wednesday
    assert window["requested_start"] == "2026-08-05"
    assert window["start"] == "2026-08-03"
    assert window["end"] == "2026-08-16"
    assert window["lead_out_start"] == "2026-08-17"
    assert window["lead_out_end"] == "2026-08-23"
    assert window["days"] == 14


def test_a_monday_start_is_left_where_it_is():
    window = fortnight_window("2026-08-03")
    assert window["requested_start"] == window["start"] == "2026-08-03"


def test_today_rides_along_while_it_is_on_the_strip():
    assert fortnight_window("2026-08-03", today=date(2026, 8, 6))["today"] == "2026-08-06"
    # The lead-out is drawn, so the today line still has somewhere to go.
    assert fortnight_window("2026-08-03", today=date(2026, 8, 20))["today"] == "2026-08-20"


def test_today_outside_the_strip_is_none():
    assert fortnight_window("2026-08-03", today=date(2026, 7, 31))["today"] is None
    assert fortnight_window("2026-08-03", today=date(2026, 8, 24))["today"] is None
    assert fortnight_window("2026-08-03")["today"] is None


# --- bands ------------------------------------------------------------------


def test_a_phase_wholly_inside_the_fortnight_is_in_the_window_band():
    assert band_of(start="2026-08-04", weeks=1) == "window"


def test_a_phase_overlapping_either_edge_is_still_in_the_window_band():
    assert band_of(start="2026-07-27", weeks=2) == "window"     # ends 2026-08-10
    assert band_of(start="2026-08-14", weeks=2) == "window"     # ends 2026-08-28


def test_a_phase_ending_the_day_the_window_opens_is_in_the_window_band():
    """The end is the day work stops, not the last day of work. Nothing may
    fall between `end < start` and `start <= end`, so this belongs to a band."""
    assert band_of(start="2026-07-27", weeks=1) == "window"     # ends 2026-08-03


def test_a_phase_starting_in_the_following_week_is_lead_out():
    assert band_of(start="2026-08-17", weeks=1) == "lead_out"
    assert band_of(start="2026-08-23", weeks=1) == "lead_out"


def test_a_phase_starting_after_the_lead_out_is_in_no_band():
    assert band_of(start="2026-08-24", weeks=1) is None


def test_a_phase_that_ended_before_the_window_is_overdue_while_it_is_open():
    assert band_of(start="2026-07-06", weeks=2) == "overdue"    # ends 2026-07-20


def test_a_phase_that_ended_before_the_window_and_is_done_is_in_no_band():
    assert band_of(start="2026-07-06", weeks=2, status="done") is None


def test_an_unscheduled_phase_is_in_no_band():
    assert band_of(start="") is None


# --- lanes ------------------------------------------------------------------


LANE_KEYS = {
    "project_id", "project_name", "track", "phase_id", "phase_name",
    "start_date", "end_date", "effort_points", "duration_weeks", "status",
    "band", "clipped_start", "clipped_end", "deliverables",
}


def one_lane(phase, deliverables=None, project=COMMITTED_PROJECT):
    lanes = fortnight_slice(
        [project], {project["id"]: [phase]},
        {phase["id"]: deliverables} if deliverables else {}, WINDOW,
    )
    assert len(lanes) == 1
    return lanes[0]


def test_a_lane_carries_the_phase_whole_and_names_its_project():
    lane = one_lane(slice_phase(7, "Build", points=25, weeks=1))
    assert lane["project_id"] == 1
    assert lane["project_name"] == "Payments"
    assert lane["track"] == "Core / Billing"
    assert lane["phase_id"] == 7
    assert lane["phase_name"] == "Build"
    assert lane["start_date"] == "2026-08-04"
    assert lane["end_date"] == "2026-08-11"          # derived, never stored
    assert lane["effort_points"] == 25
    assert lane["duration_weeks"] == 1
    assert lane["status"] == "in_progress"
    assert lane["band"] == "window"


def test_nothing_in_the_slice_sums_points():
    """Invariant 2. A windowed points total is a points-per-day constant in
    disguise -- assert on the key sets so one cannot arrive quietly."""
    lane = one_lane(slice_phase())
    assert set(lane) == LANE_KEYS
    assert set(WINDOW) == {
        "requested_start", "start", "end", "lead_out_start", "lead_out_end",
        "days", "today",
    }


def test_a_phase_starting_before_the_window_is_clipped_at_the_start_only():
    lane = one_lane(slice_phase(start="2026-07-27", weeks=2))    # ends 2026-08-10
    assert lane["clipped_start"] is True
    assert lane["clipped_end"] is False


def test_a_phase_starting_exactly_on_the_window_start_is_not_clipped():
    """The distinction the strip's edge markers exist to draw."""
    lane = one_lane(slice_phase(start="2026-08-03", weeks=1))
    assert lane["clipped_start"] is False
    assert lane["clipped_end"] is False


def test_a_phase_running_past_both_edges_is_clipped_at_both():
    lane = one_lane(slice_phase(start="2026-07-20", weeks=6))    # ends 2026-08-31
    assert lane["clipped_start"] is True
    assert lane["clipped_end"] is True


def test_a_phase_wholly_inside_the_strip_is_clipped_at_neither_edge():
    lane = one_lane(slice_phase(start="2026-08-04", weeks=1))
    assert lane["clipped_start"] is False
    assert lane["clipped_end"] is False


def test_crossing_into_the_lead_out_is_not_clipping():
    """The lead-out is drawn, so a bar that reaches into it is not cut off."""
    lane = one_lane(slice_phase(start="2026-08-10", weeks=1.5))  # ends 2026-08-20
    assert lane["clipped_end"] is False


def test_a_lane_lists_the_deliverables_its_phase_names():
    deliverables = [{"id": 41, "phase_id": 1, "name": "Retry + backoff", "done": 0}]
    lane = one_lane(slice_phase(), deliverables)
    assert lane["deliverables"] == [
        {"id": 41, "name": "Retry + backoff", "done": 0}
    ]


def test_a_phase_naming_nothing_still_gets_a_lane():
    """Presence is a planning fact, and its absence is not a reason to hide
    work that is happening this fortnight."""
    lane = one_lane(slice_phase())
    assert lane["deliverables"] == []


# --- what the slice leaves out ----------------------------------------------


def test_an_idea_never_reaches_the_slice():
    idea = {**COMMITTED_PROJECT, "stage": "idea"}
    phase = slice_phase()
    assert fortnight_slice([idea], {1: [phase]}, {}, WINDOW) == []


def test_an_unscheduled_phase_never_reaches_the_slice():
    phase = slice_phase(start="")
    assert fortnight_slice([COMMITTED_PROJECT], {1: [phase]}, {}, WINDOW) == []


def test_an_overdue_phase_shows_beside_the_projects_other_work_here():
    late = slice_phase(1, "Discovery", start="2026-07-06", weeks=2)
    current = slice_phase(2, "Build", start="2026-08-04", weeks=1)
    lanes = fortnight_slice(
        [COMMITTED_PROJECT], {1: [late, current]}, {}, WINDOW
    )
    assert [(lane["phase_id"], lane["band"]) for lane in lanes] == [
        (1, "overdue"), (2, "window"),
    ]


def test_an_overdue_phase_alone_in_its_project_is_left_out():
    """Otherwise a phase that ended two years ago shows in every fortnight
    forever. V6 answers 'what is late' globally, and answers it better."""
    late = slice_phase(1, "Discovery", start="2026-07-06", weeks=2)
    assert fortnight_slice([COMMITTED_PROJECT], {1: [late]}, {}, WINDOW) == []


def test_a_project_with_nothing_in_the_window_contributes_no_lanes():
    phase = slice_phase(start="2026-09-07", weeks=1)
    assert fortnight_slice([COMMITTED_PROJECT], {1: [phase]}, {}, WINDOW) == []


# --- lane order -------------------------------------------------------------


def test_lanes_sort_by_band_then_by_the_order_they_were_given_in():
    first = [
        slice_phase(1, "Late", start="2026-07-06", weeks=2),
        slice_phase(2, "Now", start="2026-08-04", weeks=1),
        slice_phase(3, "Next", start="2026-08-17", weeks=1),
    ]
    second = [
        slice_phase(4, "Late", start="2026-07-06", weeks=2, project_id=2),
        slice_phase(5, "Now", start="2026-08-10", weeks=1, project_id=2),
    ]
    lanes = fortnight_slice(
        [COMMITTED_PROJECT, SECOND_PROJECT], {1: first, 2: second}, {}, WINDOW
    )
    assert [lane["phase_id"] for lane in lanes] == [1, 4, 2, 5, 3]
    assert [lane["band"] for lane in lanes] == [
        "overdue", "overdue", "window", "window", "lead_out",
    ]


def test_project_order_is_the_callers_and_is_not_re_derived():
    """`db.list_projects` already imposes the order the portfolio swimlanes and
    the map slots share. The fortnight does not get a fourth opinion."""
    phases = {1: [slice_phase(1)], 2: [slice_phase(2, project_id=2)]}
    lanes = fortnight_slice(
        [SECOND_PROJECT, COMMITTED_PROJECT], phases, {}, WINDOW
    )
    assert [lane["project_id"] for lane in lanes] == [2, 1]


# --- checkpoints in the slice -------------------------------------------------


def checkpoint(milestone_id, target_date, name=None, achieved=False):
    return {"id": milestone_id, "name": name or f"M{milestone_id}",
            "target_date": target_date, "achieved": achieved}


def scoped(milestones_by_project, projects=None):
    return fortnight_milestones(
        projects or [COMMITTED_PROJECT], milestones_by_project, WINDOW)


def test_a_checkpoint_dated_in_the_fortnight_is_in_the_window_band():
    assert milestone_band(checkpoint(1, "2026-08-03"), WINDOW) == "window"
    assert milestone_band(checkpoint(1, "2026-08-16"), WINDOW) == "window"


def test_a_checkpoint_dated_in_the_lead_out_is_marked_as_such():
    assert milestone_band(checkpoint(1, "2026-08-17"), WINDOW) == "lead_out"
    assert milestone_band(checkpoint(1, "2026-08-23"), WINDOW) == "lead_out"


def test_a_checkpoint_outside_the_strip_or_with_no_date_is_in_no_band():
    assert milestone_band(checkpoint(1, "2026-08-02"), WINDOW) is None
    assert milestone_band(checkpoint(1, "2026-08-24"), WINDOW) is None
    assert milestone_band(checkpoint(1, ""), WINDOW) is None
    assert milestone_band(checkpoint(1, None), WINDOW) is None


def test_a_reached_checkpoint_still_appears_and_says_so():
    """Shown, never derived from: the tick is the roadmap's own answer to "is
    this done", and the panel draws it exactly as the deliverable list does."""
    scope = scoped({1: [checkpoint(1, "2026-08-05", achieved=True)]})
    assert [one["achieved"] for one in scope] == [True]


def test_checkpoints_sort_by_band_then_date():
    scope = scoped({1: [
        checkpoint(1, "2026-08-20"),
        checkpoint(2, "2026-08-12"),
        checkpoint(3, "2026-08-04"),
    ]})
    assert [one["id"] for one in scope] == [3, 2, 1]
    assert [one["band"] for one in scope] == ["window", "window", "lead_out"]


def test_a_checkpoint_needs_no_phase_in_the_window():
    """The one place this parts company with the lanes. A checkpoint carries its
    own date, so it is in scope on that date whatever its project's phases do --
    and `fortnight_slice` would have dropped this project entirely."""
    scope = scoped({1: [checkpoint(1, "2026-08-05")]})
    assert [one["id"] for one in scope] == [1]
    assert fortnight_slice([COMMITTED_PROJECT], {}, {}, WINDOW) == []


def test_an_ideas_checkpoints_are_skipped():
    """The same skip the lanes make, and for the same reason: nobody has
    committed to an idea."""
    idea = {**PROJECT, "stage": "idea"}
    assert scoped({1: [checkpoint(1, "2026-08-05")]}, [idea]) == []


def test_a_checkpoint_carries_its_project_and_nothing_about_a_person():
    scope = scoped({1: [checkpoint(1, "2026-08-05", name="Beta")]})
    assert scope[0] == {
        "id": 1,
        "name": "Beta",
        "target_date": "2026-08-05",
        "achieved": False,
        "project_id": 1,
        "project_name": COMMITTED_PROJECT["name"],
        "band": "window",
    }


def test_checkpoint_ties_keep_the_callers_project_order():
    milestones = {1: [checkpoint(1, "2026-08-05")],
                  2: [checkpoint(2, "2026-08-05")]}
    scope = fortnight_milestones(
        [SECOND_PROJECT, COMMITTED_PROJECT], milestones, WINDOW)
    assert [one["project_id"] for one in scope] == [2, 1]


# --- track paths ------------------------------------------------------------


def tracked(project_id, track, name=None):
    return {"id": project_id, "name": name or f"P{project_id}", "track": track}


TRACKED = [
    tracked(1, "Source Expansion"),
    tracked(2, "Source Expansion / Platform Engineering"),
    tracked(3, "Source Expansion / Platform Engineering / CI"),
    tracked(4, "Source Expansion / MCP"),
    tracked(5, "Reporting / Platform Engineering"),
    tracked(6, ""),
]


def test_track_path_drops_empty_segments_and_normalises_spacing():
    assert track_path("Source Expansion /  New Metrics ") == [
        "Source Expansion", "New Metrics",
    ]
    assert track_path("/ Metrics") == ["Metrics"]
    assert track_path("") == []
    assert track_path(None) == []
    assert track_value(["A", "B"]) == "A / B"


def test_insert_takes_the_level_and_its_subtree_inside_the_new_one():
    moves = retrack(TRACKED, ["Source Expansion", "Platform Engineering"], "Product")
    assert {move["id"]: move["to"] for move in moves} == {
        2: "Source Expansion / Product / Platform Engineering",
        3: "Source Expansion / Product / Platform Engineering / CI",
    }


def test_insert_above_a_root_re_parents_the_whole_track():
    moves = retrack(TRACKED, ["Source Expansion"], "Product")
    assert [move["id"] for move in moves] == [1, 2, 3, 4]
    assert moves[0]["to"] == "Product / Source Expansion"


def test_a_level_of_the_same_name_under_another_parent_is_left_alone():
    """The map is a tree: one project carries one path, so two levels spelt
    alike under different parents are two rings and only one of them moves."""
    moves = retrack(TRACKED, ["Source Expansion", "Platform Engineering"], "Product")
    assert 5 not in [move["id"] for move in moves]


def test_matching_is_spelling_exact_because_the_map_groups_on_the_string():
    assert retrack(TRACKED, ["source expansion"], "Product") == []


def test_remove_raises_whatever_was_under_the_level():
    moves = retrack(TRACKED, ["Source Expansion", "Platform Engineering"])
    assert {move["id"]: move["to"] for move in moves} == {
        2: "Source Expansion",
        3: "Source Expansion / CI",
    }


def test_removing_the_only_level_leaves_a_project_untracked():
    """An honest result rather than a refusal -- the count is what the page has
    to show before anyone agrees to it."""
    moves = retrack(TRACKED, ["Source Expansion"])
    assert {move["id"]: move["to"] for move in moves} == {
        1: "", 2: "Platform Engineering", 3: "Platform Engineering / CI", 4: "MCP",
    }


def test_retrack_reports_nothing_when_no_project_names_the_level():
    assert retrack(TRACKED, ["Nowhere"], "Product") == []
    assert retrack(TRACKED, [], "Product") == []


def test_a_move_carries_the_row_it_names_and_lands_on_one_spelling():
    """Odd spacing in a stored value is rewritten to the one spelling the map
    groups on, which is the same normalising the picker does on entry."""
    assert retrack([tracked(1, "A /  B")], ["A", "B"], "Mid") == [
        {"id": 1, "name": "P1", "from": "A /  B", "to": "A / Mid / B"},
    ]
