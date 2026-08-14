"""End-to-end API tests mapped to the acceptance criteria in PROMPT.md."""

import os
import re
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.main import app


@pytest.fixture
def client(tmp_path):
    db.set_db_path(str(tmp_path / "test.db"))
    with TestClient(app) as test_client:
        yield test_client
    db.set_db_path(db.DEFAULT_DB_PATH)


def make_project(client, name="Payments", start="2026-01-05"):
    response = client.post("/api/projects", json={"name": name, "start_date": start})
    assert response.status_code == 201
    return response.json()


def make_phase(client, project_id, name, start, weeks, points):
    response = client.post(
        f"/api/projects/{project_id}/phases",
        json={"name": name, "start_date": start,
              "duration_weeks": weeks, "effort_points": points},
    )
    assert response.status_code == 201
    return response.json()


def plan_of(client, project_id):
    response = client.get(f"/api/projects/{project_id}")
    assert response.status_code == 200
    return response.json()


def link(client, predecessor, successor):
    """Make `successor` depend on `predecessor`. Returns the raw response so
    tests can assert on a rejection as well as a success."""
    return client.post("/api/dependencies", json={
        "predecessor_project_id": predecessor["id"],
        "successor_project_id": successor["id"],
    })


# --- criterion 2: phases carry correct derived dates ------------------------


def test_phase_end_date_is_returned_and_correct(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    assert phase["end_date"] == "2026-02-02"


# --- criterion 5: the V1 worked example -------------------------------------


def test_v1_warning_reports_the_implied_duration(client):
    project = make_project(client)
    make_phase(client, project["id"], "Build", "2026-01-05", 6, 55)
    warnings = plan_of(client, project["id"])["warnings"]
    v1 = [w for w in warnings if w["rule"] == "V1"]
    assert len(v1) == 1
    assert "5.5 weeks" in v1[0]["message"]


# --- criterion 3: V2 surfaces on both projects ------------------------------


def test_v2_warning_names_both_projects(client):
    """Ledger begins 2026-01-19 but Payments does not finish until 2026-02-02."""
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-01-19")
    make_phase(client, payments["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, ledger["id"], "Build", "2026-01-19", 4, 40)
    assert link(client, payments, ledger).status_code == 201

    v2 = [w for w in plan_of(client, ledger["id"])["warnings"] if w["rule"] == "V2"]
    assert len(v2) == 1
    assert v2[0]["project_id"] == ledger["id"]
    assert v2[0]["related_project_id"] == payments["id"]
    assert "Payments" in v2[0]["message"] and "Ledger" in v2[0]["message"]


def test_v2_is_visible_from_the_predecessor_project_too(client):
    """Both ends must see it -- the warning is about the link, not one project."""
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-01-19")
    make_phase(client, payments["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, ledger["id"], "Build", "2026-01-19", 4, 40)
    link(client, payments, ledger)

    assert any(w["rule"] == "V2" for w in plan_of(client, payments["id"])["warnings"])


def test_v2_also_surfaces_on_the_portfolio(client):
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-01-19")
    make_phase(client, payments["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, ledger["id"], "Build", "2026-01-19", 4, 40)
    link(client, payments, ledger)

    portfolio = client.get("/api/portfolio").json()
    assert [w["rule"] for w in portfolio["warnings"]] == ["V2"]
    assert len(portfolio["dependencies"]) == 1
    assert portfolio["dependencies"][0]["predecessor_name"] == "Payments"


def test_extending_a_project_never_reschedules_its_dependents(client):
    """The timeline must never auto-move anything -- only warn."""
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-02-02")
    design = make_phase(client, payments["id"], "Design", "2026-01-05", 4, 40)
    build = make_phase(client, ledger["id"], "Build", "2026-02-02", 4, 40)
    link(client, payments, ledger)
    assert not any(w["rule"] == "V2" for w in plan_of(client, ledger["id"])["warnings"])

    client.put(f"/api/phases/{design['id']}", json={"duration_weeks": 12})

    phases = {p["id"]: p for p in plan_of(client, ledger["id"])["phases"]}
    assert phases[build["id"]]["start_date"] == "2026-02-02"
    assert any(w["rule"] == "V2" for w in plan_of(client, ledger["id"])["warnings"])


def test_phase_order_inside_a_project_is_never_validated(client):
    """Deliberate: dependencies moved up to projects, so nothing checks phases
    against each other any more."""
    project = make_project(client)
    make_phase(client, project["id"], "Design", "2026-02-02", 4, 40)
    make_phase(client, project["id"], "Build", "2026-01-05", 4, 40)
    assert not any(w["rule"] == "V2" for w in plan_of(client, project["id"])["warnings"])


# --- criterion 4: cycles are blocked, not warned ----------------------------


def test_dependency_cycle_is_rejected_with_a_readable_message(client):
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-02-02")
    assert link(client, payments, ledger).status_code == 201

    response = link(client, ledger, payments)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "cycle" in detail.lower()
    assert "Payments" in detail and "Ledger" in detail


def test_rejected_cycle_leaves_no_dependency_behind(client):
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-02-02")
    link(client, payments, ledger)
    link(client, ledger, payments)
    assert len(plan_of(client, payments["id"])["dependencies"]) == 1


def test_a_project_cannot_depend_on_itself(client):
    project = make_project(client)
    response = link(client, project, project)
    assert response.status_code == 409
    assert "cycle" in response.json()["detail"].lower()


def test_a_dependency_on_a_missing_project_is_a_404(client):
    project = make_project(client)
    response = client.post("/api/dependencies", json={
        "predecessor_project_id": project["id"], "successor_project_id": 999,
    })
    assert response.status_code == 404


def test_both_directions_of_a_link_are_listed_on_a_project(client):
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-02-02")
    search = make_project(client, "Search", "2026-04-01")
    link(client, payments, ledger)   # Ledger waits on Payments
    link(client, ledger, search)     # Search waits on Ledger

    dependencies = plan_of(client, ledger["id"])["dependencies"]
    assert len(dependencies) == 2
    incoming = [d for d in dependencies if d["successor_project_id"] == ledger["id"]]
    outgoing = [d for d in dependencies if d["predecessor_project_id"] == ledger["id"]]
    assert incoming[0]["predecessor_name"] == "Payments"
    assert outgoing[0]["successor_name"] == "Search"


def test_deleting_a_project_takes_its_dependencies_with_it(client):
    payments = make_project(client, "Payments", "2026-01-05")
    ledger = make_project(client, "Ledger", "2026-02-02")
    link(client, payments, ledger)

    client.delete(f"/api/projects/{payments['id']}")
    assert plan_of(client, ledger["id"])["dependencies"] == []


# --- criterion 7: export / wipe / import round trip -------------------------


def test_export_then_import_restores_the_identical_dataset(client):
    project = make_project(client)
    client.put(f"/api/projects/{project['id']}", json={"goal": "Ship payments v1."})
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 60)
    wireframes = client.post(f"/api/phases/{design['id']}/deliverables",
                             json={"name": "Wireframes"}).json()
    client.put(f"/api/deliverables/{wireframes['id']}", json={"done": True})
    client.post(f"/api/phases/{design['id']}/deliverables", json={"name": "Prototype"})
    search = make_project(client, "Search", "2026-03-01")
    link(client, project, search)

    exported = client.get("/api/export").json()

    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.get("/api/projects").json() == []

    assert client.post("/api/import", json=exported).status_code == 200
    reimported = client.get("/api/export").json()

    assert reimported["projects"] == exported["projects"]
    assert reimported["phases"] == exported["phases"]
    assert reimported["deliverables"] == exported["deliverables"]
    assert reimported["dependencies"] == exported["dependencies"]
    assert reimported["projects"][0]["goal"] == "Ship payments v1."
    assert [d["done"] for d in reimported["deliverables"]] == [1, 0]


# --- settings ---------------------------------------------------------------


def test_project_velocity_override_changes_v1_outcome(client):
    project = make_project(client)
    make_phase(client, project["id"], "Build", "2026-01-05", 6, 55)
    assert any(w["rule"] == "V1" for w in plan_of(client, project["id"])["warnings"])

    # 55 pts over 6 weeks needs ~18.3 pts/sprint; at 18 the plan reconciles.
    client.put(f"/api/projects/{project['id']}", json={"velocity_override": 18})
    assert not any(w["rule"] == "V1" for w in plan_of(client, project["id"])["warnings"])


def test_widening_tolerance_silences_v1(client):
    project = make_project(client)
    make_phase(client, project["id"], "Build", "2026-01-05", 6, 55)
    client.put("/api/settings", json={"v1_tolerance_pct": 20})
    assert not any(w["rule"] == "V1" for w in plan_of(client, project["id"])["warnings"])


# --- unscheduled planning ---------------------------------------------------


def test_empty_start_date_does_not_break_the_project_view(client):
    """Regression: '' used to raise ValueError and 500 the whole project."""
    project = make_project(client, start="")
    make_phase(client, project["id"], "Dev", "", 1, 20)
    response = client.get(f"/api/projects/{project['id']}")
    assert response.status_code == 200
    assert response.json()["phases"][0]["end_date"] == ""


def test_a_project_can_be_created_with_no_start_date(client):
    project = make_project(client, start="")
    assert project["start_date"] == ""


def test_estimate_rules_still_run_on_undated_phases(client):
    """The whole point: estimate first, schedule later."""
    project = make_project(client, start="")
    phase = make_phase(client, project["id"], "Build", "", 6, 55)
    client.post(f"/api/phases/{phase['id']}/deliverables", json={"name": "Chunk"})

    rules = {w["rule"] for w in plan_of(client, project["id"])["warnings"]}
    assert "V1" in rules


def test_date_rules_are_skipped_while_unscheduled(client):
    payments = make_project(client, "Payments", start="")
    ledger = make_project(client, "Ledger", start="")
    make_phase(client, payments["id"], "Design", "", 4, 40)
    make_phase(client, ledger["id"], "Build", "", 4, 40)
    link(client, payments, ledger)

    for project in (payments, ledger):
        rules = {w["rule"] for w in plan_of(client, project["id"])["warnings"]}
        assert "V2" not in rules and "V4" not in rules


def test_a_garbage_date_is_rejected_rather_than_stored(client):
    project = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/phases",
                           json={"name": "Bad", "start_date": "not-a-date"})
    assert response.status_code == 422


def test_clearing_a_date_returns_a_phase_to_unscheduled(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Dev", "2026-01-05", 2, 20)
    updated = client.put(f"/api/phases/{phase['id']}", json={"start_date": ""}).json()
    assert updated["start_date"] == ""
    assert updated["end_date"] == ""


# --- relative week offsets (the W1/W2 timeline) -----------------------------


def test_plan_carries_week_offsets_for_undated_phases(client):
    """A project nobody has dated still has a shape: W1 onwards, in order."""
    project = make_project(client, start="")
    make_phase(client, project["id"], "Dev", "", 1, 10)
    make_phase(client, project["id"], "Validation", "", 2, 20)
    make_phase(client, project["id"], "Rollout", "", 1, 10)

    phases = plan_of(client, project["id"])["phases"]
    assert [p["offset_weeks"] for p in phases] == [0, 1, 3]
    assert [p["start_date"] for p in phases] == ["", "", ""]


def test_week_offsets_follow_sort_order_not_dates(client):
    project = make_project(client, start="2026-09-01")
    make_phase(client, project["id"], "First", "2026-12-01", 2, 20)
    make_phase(client, project["id"], "Second", "2026-09-01", 1, 10)

    phases = plan_of(client, project["id"])["phases"]
    assert [(p["name"], p["offset_weeks"]) for p in phases] == [
        ("First", 0), ("Second", 2),
    ]


def test_reordering_a_phase_restacks_the_week_offsets(client):
    """What a drag in the W-grid writes: sort_order only, no dates touched."""
    project = make_project(client, start="")
    dev = make_phase(client, project["id"], "Dev", "", 1, 10)
    validation = make_phase(client, project["id"], "Validation", "", 2, 20)

    client.put(f"/api/phases/{validation['id']}", json={"sort_order": 0})
    client.put(f"/api/phases/{dev['id']}", json={"sort_order": 1})

    phases = plan_of(client, project["id"])["phases"]
    assert [(p["name"], p["offset_weeks"]) for p in phases] == [
        ("Validation", 0), ("Dev", 2),
    ]
    assert all(p["start_date"] == "" for p in phases)


def test_week_offsets_carry_half_weeks(client):
    project = make_project(client, start="")
    make_phase(client, project["id"], "Spike", "", 0.5, 5)
    make_phase(client, project["id"], "Build", "", 1.5, 15)

    phases = plan_of(client, project["id"])["phases"]
    assert [p["offset_weeks"] for p in phases] == [0, 0.5]


# --- sequential layout ------------------------------------------------------


def test_layout_places_undated_phases_back_to_back(client):
    project = make_project(client, start="2026-09-01")
    make_phase(client, project["id"], "Dev", "", 1, 10)
    make_phase(client, project["id"], "Validation", "", 2, 20)
    make_phase(client, project["id"], "Rollout", "", 1, 10)

    assert client.post(f"/api/projects/{project['id']}/layout").json()["placed"] == 3

    dates = [p["start_date"] for p in plan_of(client, project["id"])["phases"]]
    assert dates == ["2026-09-01", "2026-09-08", "2026-09-22"]


def test_layout_leaves_already_dated_phases_alone(client):
    project = make_project(client, start="2026-09-01")
    pinned = make_phase(client, project["id"], "Pinned", "2026-10-01", 1, 10)
    make_phase(client, project["id"], "Floating", "", 1, 10)

    client.post(f"/api/projects/{project['id']}/layout")
    phases = {p["name"]: p for p in plan_of(client, project["id"])["phases"]}
    assert phases["Pinned"]["start_date"] == "2026-10-01"
    assert phases["Floating"]["start_date"] == "2026-10-08"
    assert pinned["start_date"] == "2026-10-01"


def test_layout_refuses_without_a_project_start_date(client):
    project = make_project(client, start="")
    make_phase(client, project["id"], "Dev", "", 1, 10)
    response = client.post(f"/api/projects/{project['id']}/layout")
    assert response.status_code == 400
    assert "start date" in response.json()["detail"].lower()


def test_portfolio_omits_unscheduled_phases_but_counts_them(client):
    project = make_project(client, start="2026-09-01")
    make_phase(client, project["id"], "Dated", "2026-09-01", 1, 10)
    make_phase(client, project["id"], "Undated", "", 1, 10)

    portfolio = client.get("/api/portfolio").json()
    assert len(portfolio["phases"]) == 1
    assert portfolio["unscheduled_count"] == 1


# --- the staging tray: undated work waiting to be placed ---------------------


def test_portfolio_stages_undated_work_by_project(client):
    """Estimated but undated phases come back grouped, ready to be placed."""
    project = make_project(client, "Payments", start="")
    make_phase(client, project["id"], "Design", "", 2, 20)
    make_phase(client, project["id"], "Build", "", 4, 40)

    tray = client.get("/api/portfolio").json()["unscheduled"]
    assert len(tray) == 1
    assert tray[0]["project_name"] == "Payments"
    assert [phase["name"] for phase in tray[0]["phases"]] == ["Design", "Build"]
    assert tray[0]["total_weeks"] == 6
    assert tray[0]["total_points"] == 60
    assert tray[0]["scheduled_count"] == 0


def test_a_fully_dated_project_is_not_in_the_tray(client):
    project = make_project(client, start="2026-09-07")
    make_phase(client, project["id"], "Design", "2026-09-07", 2, 20)
    assert client.get("/api/portfolio").json()["unscheduled"] == []


def test_a_project_with_no_phases_is_not_in_the_tray(client):
    """The tray places work; a project with none has nothing to place."""
    make_project(client, start="")
    assert client.get("/api/portfolio").json()["unscheduled"] == []


def test_a_half_placed_project_stays_in_the_tray(client):
    """Only the undated phases are offered, and the dated one is counted."""
    project = make_project(client, start="2026-09-07")
    make_phase(client, project["id"], "Design", "2026-09-07", 2, 20)
    make_phase(client, project["id"], "Build", "", 4, 40)

    tray = client.get("/api/portfolio").json()["unscheduled"]
    assert [phase["name"] for phase in tray[0]["phases"]] == ["Build"]
    assert tray[0]["total_weeks"] == 4
    assert tray[0]["scheduled_count"] == 1
    assert tray[0]["start_date"] == "2026-09-07"


def test_an_idea_never_reaches_the_tray(client):
    """Committing to a direction is a project-view decision, not a drag."""
    idea = make_direction(client)
    make_phase(client, idea["id"], "Sketch", "", 1, 10)
    assert client.get("/api/portfolio").json()["unscheduled"] == []


def test_placing_a_project_dates_it_and_lays_out_its_phases(client):
    """What the tray drop does: set the start date, then lay out from it.

    Two existing endpoints, no new one -- the drop is the gesture, the server
    still only does what it was already asked to do explicitly.
    """
    project = make_project(client, "Payments", start="")
    make_phase(client, project["id"], "Design", "", 2, 20)
    make_phase(client, project["id"], "Build", "", 4, 40)

    client.put(f"/api/projects/{project['id']}", json={"start_date": "2026-09-07"})
    client.post(f"/api/projects/{project['id']}/layout")

    portfolio = client.get("/api/portfolio").json()
    assert portfolio["unscheduled"] == []
    assert [(p["name"], p["start_date"]) for p in portfolio["phases"]] == [
        ("Design", "2026-09-07"), ("Build", "2026-09-21")]


def test_layout_reports_exactly_which_phases_it_dated(client):
    """`placements` is what makes a placement reversible -- the client keeps it."""
    project = make_project(client, start="2026-09-07")
    already = make_phase(client, project["id"], "Design", "2026-09-07", 2, 20)
    pending = make_phase(client, project["id"], "Build", "", 4, 40)

    placed = client.post(f"/api/projects/{project['id']}/layout").json()
    assert placed["placed"] == 1
    assert placed["placements"] == {str(pending["id"]): "2026-09-21"}
    assert str(already["id"]) not in placed["placements"]


def test_undoing_a_placement_returns_the_project_to_the_tray(client):
    """The reversal the tray's Undo runs: blank those phases, restore the date.

    Only the phases the drop dated are cleared, so a half-placed project keeps
    the dates it already had.
    """
    project = make_project(client, "Payments", start="")
    kept = make_phase(client, project["id"], "Spike", "2026-08-10", 1, 10)
    make_phase(client, project["id"], "Build", "", 4, 40)

    client.put(f"/api/projects/{project['id']}", json={"start_date": "2026-09-07"})
    placed = client.post(f"/api/projects/{project['id']}/layout").json()

    for phase_id in placed["placements"]:
        client.put(f"/api/phases/{phase_id}", json={"start_date": ""})
    client.put(f"/api/projects/{project['id']}", json={"start_date": ""})

    portfolio = client.get("/api/portfolio").json()
    tray = portfolio["unscheduled"]
    assert tray[0]["project_name"] == "Payments"
    assert [phase["name"] for phase in tray[0]["phases"]] == ["Build"]
    assert tray[0]["start_date"] == ""
    # The phase that was already dated before the drop is untouched by the undo.
    assert [(p["id"], p["start_date"]) for p in portfolio["phases"]] == [
        (kept["id"], "2026-08-10")]


# --- project goal -----------------------------------------------------------


def test_project_goal_defaults_empty_and_persists(client):
    project = make_project(client)
    assert project["goal"] == ""
    client.put(f"/api/projects/{project['id']}",
               json={"goal": "Cut checkout abandonment to under 20%."})
    assert plan_of(client, project["id"])["project"]["goal"] == (
        "Cut checkout abandonment to under 20%."
    )


# --- deliverables -----------------------------------------------------------


def add_deliverable(client, phase_id, name):
    response = client.post(f"/api/phases/{phase_id}/deliverables", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_deliverables_are_returned_with_their_phase(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 5.5, 55)
    add_deliverable(client, phase["id"], "Payment intent API")
    add_deliverable(client, phase["id"], "Webhook receiver")
    add_deliverable(client, phase["id"], "Refund flow")

    returned = plan_of(client, project["id"])["phases"][0]
    names = [deliverable["name"] for deliverable in returned["deliverables"]]
    assert names == ["Payment intent API", "Webhook receiver", "Refund flow"]


def test_deliverables_can_be_resequenced(client):
    """What a drag on the grip writes: sort_order only, tick untouched."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 5.5, 55)
    intent = add_deliverable(client, phase["id"], "Payment intent API")
    webhook = add_deliverable(client, phase["id"], "Webhook receiver")
    refund = add_deliverable(client, phase["id"], "Refund flow")
    client.put(f"/api/deliverables/{intent['id']}", json={"done": True})

    # Refund flow dragged to the top: every row that moved is renumbered.
    for index, moved in enumerate([refund, intent, webhook]):
        client.put(f"/api/deliverables/{moved['id']}", json={"sort_order": index})

    returned = plan_of(client, project["id"])["phases"][0]["deliverables"]
    assert [deliverable["name"] for deliverable in returned] == [
        "Refund flow", "Payment intent API", "Webhook receiver"]
    assert [deliverable["done"] for deliverable in returned] == [0, 1, 0]


def test_deliverable_carries_no_estimate(client):
    """Weeks and points live on the phase; a deliverable is just an entry."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 6, 60)
    deliverable = add_deliverable(client, phase["id"], "Only one")

    assert "duration_weeks" not in deliverable
    assert "effort_points" not in deliverable

    returned = plan_of(client, project["id"])["phases"][0]
    assert returned["duration_weeks"] == 6
    assert returned["effort_points"] == 60
    assert returned["end_date"] == "2026-02-16"


def test_deliverable_can_be_edited_and_deleted(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 4, 40)
    deliverable = add_deliverable(client, phase["id"], "Draft")

    updated = client.put(f"/api/deliverables/{deliverable['id']}",
                         json={"name": "Final draft"}).json()
    assert updated["name"] == "Final draft"

    assert client.delete(f"/api/deliverables/{deliverable['id']}").status_code == 204
    assert plan_of(client, project["id"])["phases"][0]["deliverables"] == []


def test_deleting_a_phase_removes_its_deliverables(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 4, 40)
    add_deliverable(client, phase["id"], "Draft")
    client.delete(f"/api/phases/{phase['id']}")
    assert client.get("/api/export").json()["deliverables"] == []


def test_a_new_deliverable_starts_ongoing(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 4, 40)
    assert add_deliverable(client, phase["id"], "Draft")["done"] == 0


def test_ticking_a_deliverable_persists(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 4, 40)
    deliverable = add_deliverable(client, phase["id"], "Draft")

    ticked = client.put(f"/api/deliverables/{deliverable['id']}",
                        json={"done": True}).json()
    assert ticked["done"] == 1
    assert plan_of(client, project["id"])["phases"][0]["deliverables"][0]["done"] == 1

    unticked = client.put(f"/api/deliverables/{deliverable['id']}",
                          json={"done": False}).json()
    assert unticked["done"] == 0


def test_ticking_leaves_the_phase_estimate_and_status_alone(client):
    """The tick records progress. It does not schedule, estimate, or roll up."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 6, 60)
    for name in ("First", "Second"):
        deliverable = add_deliverable(client, phase["id"], name)
        client.put(f"/api/deliverables/{deliverable['id']}", json={"done": True})

    returned = plan_of(client, project["id"])["phases"][0]
    assert returned["duration_weeks"] == 6
    assert returned["effort_points"] == 60
    assert returned["status"] == "planned"


def test_renaming_a_deliverable_does_not_clear_its_tick(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Core", "2026-01-05", 4, 40)
    deliverable = add_deliverable(client, phase["id"], "Draft")
    client.put(f"/api/deliverables/{deliverable['id']}", json={"done": True})

    renamed = client.put(f"/api/deliverables/{deliverable['id']}",
                         json={"name": "Final draft"}).json()
    assert renamed["name"] == "Final draft"
    assert renamed["done"] == 1


# --- portfolio --------------------------------------------------------------


def test_portfolio_returns_every_project_and_phase(client):
    first = make_project(client, "Payments", "2026-01-05")
    second = make_project(client, "Search", "2026-03-01")
    make_phase(client, first["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, second["id"], "Spike", "2026-03-01", 2, 20)

    portfolio = client.get("/api/portfolio").json()
    assert len(portfolio["projects"]) == 2
    assert len(portfolio["phases"]) == 2
    assert all("end_date" in phase for phase in portfolio["phases"])
    assert {p["project_id"] for p in portfolio["phases"]} == {first["id"], second["id"]}


def test_portfolio_is_empty_when_nothing_is_planned(client):
    assert client.get("/api/portfolio").json() == {
        "projects": [], "phases": [], "unscheduled": [], "unscheduled_count": 0,
        "dependencies": [], "warnings": [],
    }


def test_deleting_a_project_removes_its_phases(client):
    project = make_project(client)
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.delete(f"/api/projects/{project['id']}")
    assert client.get(f"/api/projects/{project['id']}").status_code == 404
    assert client.get("/api/export").json()["phases"] == []


# --- the derived stage on the project list ----------------------------------
#
# The ladder reads the clock, so these follow the convention the graph tests
# already use: 2026-01-05 is unambiguously behind us and 2099 unambiguously
# ahead, which keeps every expectation below deterministic.


def stages_of(client):
    """The list as {name: derived_stage}, plus the order it came back in."""
    projects = client.get("/api/projects").json()
    return ({project["name"]: project["derived_stage"] for project in projects},
            [project["name"] for project in projects])


def test_the_project_list_carries_the_ladder_through_the_whole_lifecycle(client):
    project = make_project(client, start="")
    assert stages_of(client)[0] == {"Payments": "planning"}

    phase = make_phase(client, project["id"], "Design", "", 4, 40)
    assert stages_of(client)[0] == {"Payments": "planning"}

    client.post(f"/api/phases/{phase['id']}/deliverables", json={"name": "Wireframes"})
    # Named, but a plan with nothing to aim at is still being drafted.
    assert stages_of(client)[0] == {"Payments": "planning"}

    db.create_milestone(project["id"], "Private beta")
    assert stages_of(client)[0] == {"Payments": "planned"}

    client.put(f"/api/projects/{project['id']}", json={"start_date": "2099-01-05"})
    client.post(f"/api/projects/{project['id']}/layout")
    assert stages_of(client)[0] == {"Payments": "dated"}

    client.put(f"/api/projects/{project['id']}", json={"stage": "done"})
    assert stages_of(client)[0] == {"Payments": "done"}


def test_a_dated_project_reads_active_or_overdue_from_the_calendar(client):
    project = make_project(client, start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    assert stages_of(client)[0] == {"Payments": "overdue"}

    client.put(f"/api/projects/{project['id']}", json={"stage": "done"})
    assert stages_of(client)[0] == {"Payments": "done"}


def test_a_thin_phase_no_longer_drags_the_whole_project_backwards(client):
    """The rule this replaced read `planning` for six of seven real projects,
    because one phase with nothing under it outranked every date on the plan."""
    project = make_project(client, start="2099-01-05")
    first = make_phase(client, project["id"], "Design", "2099-01-05", 4, 40)
    client.post(f"/api/phases/{first['id']}/deliverables", json={"name": "Wireframes"})
    assert stages_of(client)[0] == {"Payments": "dated"}

    make_phase(client, project["id"], "Build", "2099-02-02", 4, 40)
    assert stages_of(client)[0] == {"Payments": "dated"}


def test_the_ladder_is_computed_per_project(client):
    empty = make_project(client, "Ledger")
    dated = make_project(client, "Payments", start="2099-01-05")
    phase = make_phase(client, dated["id"], "Design", "2099-01-05", 4, 40)
    client.post(f"/api/phases/{phase['id']}/deliverables", json={"name": "Wireframes"})

    assert stages_of(client)[0] == {"Ledger": "planning", "Payments": "dated"}
    assert empty["id"] != dated["id"]


def test_finished_work_sorts_below_ideas_and_ideas_below_live_work(client):
    make_project(client, "Payments", start="2099-01-05")
    finished = make_project(client, "Ledger", start="2026-01-05")
    client.post("/api/projects", json={
        "name": "Caching", "start_date": "", "stage": "idea",
    })
    client.put(f"/api/projects/{finished['id']}", json={"stage": "done"})

    assert stages_of(client)[1] == ["Payments", "Caching", "Ledger"]


def test_a_project_finished_by_its_milestones_sorts_last_too(client):
    """`db.list_projects` can only sort on the stored stage, which now says done
    for a manual close alone. The list re-sorts on the ladder for this reason."""
    make_project(client, "Payments", start="2099-01-05")
    finished = make_project(client, "Ledger", start="2026-01-05")
    make_phase(client, finished["id"], "Design", "2026-01-05", 4, 40)
    reached = created(db.create_milestone(finished["id"], "Launch"))
    db.update_milestone(reached["id"], {"achieved": True})

    listed, order = stages_of(client)
    assert listed["Ledger"] == "done"
    assert order == ["Payments", "Ledger"]


def test_closing_every_phase_does_not_finish_a_project(client):
    """`phase.status` left the ladder: nothing maintained it, so the route was
    unreachable. Milestones carry the decision now; V6 and V7 still read status."""
    project = make_project(client, "Ledger", start="2026-01-05")
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.put(f"/api/phases/{phase['id']}", json={"status": "done"})

    assert stages_of(client)[0]["Ledger"] == "overdue"


# --- future directions ------------------------------------------------------


def make_direction(client, name="Build caching", track=""):
    response = client.post("/api/projects", json={
        "name": name, "start_date": "", "stage": "idea", "track": track,
    })
    assert response.status_code == 201
    return response.json()


def test_a_project_is_active_with_no_track_by_default(client):
    project = make_project(client)
    assert project["stage"] == "active"
    assert project["track"] == ""


def test_an_unknown_stage_is_rejected_rather_than_stored(client):
    response = client.post("/api/projects", json={"name": "Odd", "stage": "maybe"})
    assert response.status_code == 422
    assert "maybe" in response.json()["detail"]

    project = make_project(client)
    assert client.put(f"/api/projects/{project['id']}",
                      json={"stage": "shipped"}).status_code == 422
    assert client.get(f"/api/projects/{project['id']}").json()["project"]["stage"] \
        == "active"


# --- tier -------------------------------------------------------------------


def test_a_project_starts_untiered(client):
    """Nobody has ranked a project the moment it is created, and 0 says so.

    Defaulting to a middle tier would invent a priority the user never set --
    the same reason an unscheduled project keeps an empty start date.
    """
    project = make_project(client)
    assert project["tier"] == 0
    assert make_direction(client)["tier"] == 0


def test_a_tier_is_stored_and_reaches_the_map(client):
    project = client.post("/api/projects", json={
        "name": "Payments", "start_date": "2026-01-05", "tier": 1,
    }).json()
    assert project["tier"] == 1

    node = next(item for item in client.get("/api/graph").json()["projects"]
                if item["id"] == project["id"])
    assert node["tier"] == 1

    assert client.put(f"/api/projects/{project['id']}",
                      json={"tier": 3}).json()["tier"] == 3


def test_an_unknown_tier_is_rejected_rather_than_stored(client):
    response = client.post("/api/projects", json={"name": "Odd", "tier": 4})
    assert response.status_code == 422
    assert "4" in response.json()["detail"]

    project = client.post("/api/projects", json={
        "name": "Payments", "start_date": "2026-01-05", "tier": 2,
    }).json()
    assert client.put(f"/api/projects/{project['id']}",
                      json={"tier": -1}).status_code == 422
    assert client.get(f"/api/projects/{project['id']}").json()["project"]["tier"] == 2


def test_tier_changes_nothing_a_rule_reads(client):
    """It is a label for the map, not a scheduling opinion."""
    project = client.post("/api/projects", json={
        "name": "Payments", "start_date": "2026-01-05", "tier": 1,
    }).json()
    make_phase(client, project["id"], "Design", "2026-01-05", 6, 55)
    before = client.get(f"/api/projects/{project['id']}").json()
    stage_before = client.get("/api/projects").json()[0]["derived_stage"]

    client.put(f"/api/projects/{project['id']}", json={"tier": 3})
    after = client.get(f"/api/projects/{project['id']}").json()

    assert after["warnings"] == before["warnings"]
    assert [phase["start_date"] for phase in after["phases"]] \
        == [phase["start_date"] for phase in before["phases"]]
    assert client.get("/api/projects").json()[0]["derived_stage"] == stage_before


def test_a_pre_tier_export_imports_as_untiered(client):
    """A version-6 file ranked nothing, so everything in it arrives unranked."""
    legacy = {
        "version": 6,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14, "v1_tolerance_pct": 5.0,
                     "department_name": "Platform Engineering"},
        "projects": [{"id": 1, "name": "Payments", "description": "", "goal": "",
                      "start_date": "2026-01-05", "velocity_override": None,
                      "stage": "active", "track": "Source expansion",
                      "created_at": "2026-01-01T00:00:00+00:00",
                      "updated_at": "2026-01-01T00:00:00+00:00"}],
        "phases": [], "deliverables": [], "dependencies": [],
    }
    assert client.post("/api/import", json=legacy).status_code == 200

    project = client.get("/api/projects").json()[0]
    assert project["tier"] == 0
    assert project["track"] == "Source expansion"


def test_tier_survives_a_round_trip(client):
    client.post("/api/projects", json={
        "name": "Payments", "start_date": "2026-01-05", "tier": 1,
    })
    client.post("/api/projects", json={
        "name": "Caching", "start_date": "", "stage": "idea", "tier": 3,
    })

    exported = client.get("/api/export").json()
    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.post("/api/import", json=exported).status_code == 200

    assert {project["name"]: project["tier"]
            for project in client.get("/api/projects").json()} \
        == {"Payments": 1, "Caching": 3}


# --- the planned stage ------------------------------------------------------


def make_planned(client, name="Payments"):
    response = client.post("/api/projects", json={
        "name": name, "start_date": "", "stage": "planned",
    })
    assert response.status_code == 201
    return response.json()


def test_planned_is_stored_and_round_trips(client):
    """The stage the schema rebuild exists for."""
    project = make_planned(client)
    assert project["stage"] == "planned"
    assert client.get(f"/api/projects/{project['id']}").json()["project"]["stage"] \
        == "planned"

    exported = client.get("/api/export").json()
    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.post("/api/import", json=exported).status_code == 200
    assert client.get("/api/projects").json()[0]["stage"] == "planned"


def test_a_planned_project_reaches_the_staging_tray(client):
    """The point of the stage: committed work with nothing slotted yet."""
    project = make_planned(client)
    make_phase(client, project["id"], "Design", "", 2, 20)
    make_phase(client, project["id"], "Build", "", 4, 40)

    portfolio = client.get("/api/portfolio").json()
    tray = portfolio["unscheduled"]
    assert [entry["project_name"] for entry in tray] == ["Payments"]
    assert tray[0]["total_weeks"] == 6
    # No bars until something is dated -- a swimlane is drawn from phases.
    assert portfolio["phases"] == []


def test_a_planned_project_draws_bars_once_its_phases_are_dated(client):
    project = make_planned(client)
    make_phase(client, project["id"], "Design", "2026-09-07", 2, 20)

    portfolio = client.get("/api/portfolio").json()
    assert [phase["name"] for phase in portfolio["phases"]] == ["Design"]
    assert portfolio["unscheduled"] == []


def test_an_idea_still_stays_off_the_portfolio_entirely(client):
    """Widening SCHEDULABLE_STAGES must not have let ideas in with it."""
    idea = make_direction(client)
    make_phase(client, idea["id"], "Sketch", "2026-09-07", 1, 10)

    portfolio = client.get("/api/portfolio").json()
    assert portfolio["phases"] == []
    assert portfolio["unscheduled"] == []
    assert [project["name"] for project in portfolio["projects"]] == []


def test_planned_sorts_between_live_work_and_ideas(client):
    make_project(client, "Payments", start="2026-01-05")
    make_planned(client, "Caching")
    client.post("/api/projects", json={
        "name": "Telemetry", "start_date": "", "stage": "idea",
    })
    finished = make_project(client, "Ledger", start="2026-01-05")
    client.put(f"/api/projects/{finished['id']}", json={"stage": "done"})

    assert [project["name"] for project in client.get("/api/projects").json()] \
        == ["Payments", "Caching", "Telemetry", "Ledger"]


def test_the_stored_stage_and_the_derived_one_both_travel(client):
    """The stored column keeps recording commitment, because the portfolio
    filters on it and a write echoes it back. The ladder rides alongside."""
    project = make_planned(client)
    phase = make_phase(client, project["id"], "Design", "", 2, 20)
    client.post(f"/api/phases/{phase['id']}/deliverables", json={"name": "Wireframes"})
    db.create_milestone(project["id"], "Private beta")

    listed = client.get("/api/projects").json()[0]
    assert listed["stage"] == "planned"
    assert listed["derived_stage"] == "planned"

    # 'active' is the same commitment as 'planned' as far as the ladder cares:
    # both mean committed, and the dates decide the rest.
    client.put(f"/api/projects/{project['id']}", json={"stage": "active"})
    listed = client.get("/api/projects").json()[0]
    assert listed["stage"] == "active"
    assert listed["derived_stage"] == "planned"


def test_an_unknown_stage_is_still_rejected(client):
    response = client.post("/api/projects", json={"name": "Odd", "stage": "queued"})
    assert response.status_code == 422
    assert "queued" in response.json()["detail"]


def test_promoting_a_direction_keeps_its_id_and_everything_written_on_it(client):
    idea = make_direction(client, "Build caching", track="Developer experience")
    client.put(f"/api/projects/{idea['id']}", json={"goal": "Cut CI to 5 minutes."})

    promoted = client.put(f"/api/projects/{idea['id']}", json={"stage": "active"}).json()
    assert promoted["id"] == idea["id"]
    assert promoted["stage"] == "active"
    assert promoted["track"] == "Developer experience"
    assert promoted["goal"] == "Cut CI to 5 minutes."


def test_a_direction_stays_off_the_portfolio_timeline(client):
    project = make_project(client, start="2026-09-01")
    make_phase(client, project["id"], "Dated", "2026-09-01", 1, 10)
    idea = make_direction(client)
    # Even with a scheduled phase hung off it, an uncommitted idea stays off.
    make_phase(client, idea["id"], "Sketch", "2026-09-01", 1, 10)

    portfolio = client.get("/api/portfolio").json()
    assert [p["id"] for p in portfolio["projects"]] == [project["id"]]
    assert len(portfolio["phases"]) == 1
    assert portfolio["unscheduled_count"] == 0


# --- map view ---------------------------------------------------------------


def test_graph_reports_progress_size_and_what_lands_next(client):
    project = make_project(client, start="2026-01-05")
    client.put(f"/api/projects/{project['id']}", json={"track": "Payments"})
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 60)
    client.put(f"/api/phases/{design['id']}", json={"status": "done"})

    node = client.get("/api/graph").json()["projects"][0]
    assert node["track"] == "Payments"
    assert (node["phases_done"], node["phases_total"]) == (1, 2)
    assert node["effort_points"] == 100
    # Dates are all in the past by the time this runs, so nothing is upcoming.
    assert node["next_date"] is None


def test_graph_next_date_is_the_soonest_boundary_still_ahead(client):
    project = make_project(client, start="2099-01-05")
    make_phase(client, project["id"], "Build", "2099-01-05", 2, 20)
    node = client.get("/api/graph").json()["projects"][0]
    assert node["next_date"] == "2099-01-05"


def test_graph_includes_directions_with_nothing_planned(client):
    make_direction(client, "Build caching", track="Developer experience")
    node = client.get("/api/graph").json()["projects"][0]
    assert node["stage"] == "idea"
    assert (node["phases_done"], node["phases_total"]) == (0, 0)
    assert node["effort_points"] == 0
    assert node["next_date"] is None


def test_graph_carries_dependencies_for_the_hover_highlight(client):
    """The map draws links only on hover, so the payload has to hold them."""
    payments = make_project(client, "Payments", "2026-01-05")
    caching = make_project(client, "Caching", "2026-03-02")
    link(client, payments, caching)

    graph = client.get("/api/graph").json()
    assert len(graph["dependencies"]) == 1

    dependency = graph["dependencies"][0]
    assert dependency["predecessor_project_id"] == payments["id"]
    assert dependency["successor_project_id"] == caching["id"]
    # Names ride along so the map never needs a second fetch to label a link.
    assert dependency["predecessor_name"] == "Payments"
    assert dependency["successor_name"] == "Caching"


def test_graph_dependencies_are_empty_when_nothing_is_linked(client):
    make_project(client, "Payments", "2026-01-05")
    assert client.get("/api/graph").json()["dependencies"] == []


def test_department_name_defaults_empty_and_persists(client):
    assert client.get("/api/graph").json()["department_name"] == ""
    client.put("/api/settings", json={"department_name": "Platform Engineering | Product"})
    assert client.get("/api/graph").json()["department_name"] \
        == "Platform Engineering | Product"


def test_stage_track_and_department_survive_a_round_trip(client):
    client.put("/api/settings", json={"department_name": "Platform Engineering"})
    make_project(client, "Payments")
    make_direction(client, "Build caching", track="Developer experience")

    exported = client.get("/api/export").json()
    assert exported["version"] == 10

    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.post("/api/import", json=exported).status_code == 200

    reimported = client.get("/api/export").json()
    assert reimported["projects"] == exported["projects"]
    assert reimported["settings"]["department_name"] == "Platform Engineering"


def test_milestones_survive_the_round_trip_with_their_ids(client):
    """Ids are preserved so a milestone stays attached to its project."""
    project = make_project(client, start="2026-01-05")
    client.post(f"/api/projects/{project['id']}/milestones",
                json={"name": "Private beta", "target_date": "2026-03-02"})
    client.post(f"/api/projects/{project['id']}/milestones", json={"name": "Launch"})

    exported = client.get("/api/export").json()
    assert [m["name"] for m in exported["milestones"]] == ["Private beta", "Launch"]

    assert client.post("/api/import", json=exported).status_code == 200
    assert client.get("/api/export").json()["milestones"] == exported["milestones"]


def test_a_version_9_export_imports_and_drops_its_drafting_flag(client):
    """v9 is the one version that carried `draft_complete`. It is read and
    discarded rather than translated: inventing a checkpoint to carry the flag
    across would be making up a target the file never named."""
    legacy = {
        "version": 9,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14, "v1_tolerance_pct": 5.0,
                     "department_name": "Platform"},
        "projects": [{"id": 1, "name": "Payments", "description": "", "goal": "",
                      "start_date": "", "velocity_override": None,
                      "stage": "planned", "track": "", "tier": 2,
                      "draft_complete": 1,
                      "created_at": "2026-01-01T00:00:00+00:00",
                      "updated_at": "2026-01-01T00:00:00+00:00"}],
        "phases": [{"id": 1, "project_id": 1, "name": "Design", "description": "",
                    "start_date": "", "duration_weeks": 4, "effort_points": 40,
                    "status": "planned", "sort_order": 0}],
        "deliverables": [{"id": 1, "phase_id": 1, "name": "Wireframes",
                          "description": "", "done": 0, "sort_order": 0}],
        "dependencies": [],
    }
    assert client.post("/api/import", json=legacy).status_code == 200

    exported = client.get("/api/export").json()
    assert exported["version"] == 10
    assert "draft_complete" not in exported["projects"][0]
    assert exported["milestones"] == []
    # A plan that was flagged drafted arrives with nothing to aim at, so the
    # ladder reads it as still drafting. Understating a finished plan is the
    # quieter of the two errors, the same trade the flag itself arrived with.
    assert stages_of(client)[0]["Payments"] == "planning"


def test_a_version_2_export_still_imports(client):
    """Files written before stage/track existed must not need hand-editing."""
    legacy = {
        "version": 2,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14,
                     "v1_tolerance_pct": 5.0, "v5_tolerance_pct": 5.0},
        "projects": [{"id": 1, "name": "Payments", "description": "",
                      "goal": "Ship it.", "start_date": "2026-01-05",
                      "velocity_override": None,
                      "created_at": "2026-01-01T00:00:00+00:00",
                      "updated_at": "2026-01-01T00:00:00+00:00"}],
        "phases": [], "deliverables": [], "dependencies": [],
    }
    assert client.post("/api/import", json=legacy).status_code == 200

    project = client.get("/api/projects").json()[0]
    assert project["goal"] == "Ship it."
    # Everything in a v2 file was committed work, so 'active' is the honest read.
    assert project["stage"] == "active"
    assert project["track"] == ""
    assert client.get("/api/graph").json()["department_name"] == ""


def test_a_version_3_export_imports_without_its_deliverable_estimates(client):
    """Deliverables used to carry weeks and points. The fields are ignored now."""
    legacy = {
        "version": 3,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14,
                     "v1_tolerance_pct": 5.0, "v5_tolerance_pct": 5.0},
        "projects": [{"id": 1, "name": "Payments", "description": "",
                      "goal": "", "start_date": "2026-01-05",
                      "velocity_override": None, "stage": "active", "track": "",
                      "created_at": "2026-01-01T00:00:00+00:00",
                      "updated_at": "2026-01-01T00:00:00+00:00"}],
        "phases": [{"id": 1, "project_id": 1, "name": "Design", "description": "",
                    "start_date": "2026-01-05", "duration_weeks": 4,
                    "effort_points": 40, "status": "planned", "sort_order": 0}],
        "deliverables": [{"id": 1, "phase_id": 1, "name": "Wireframes",
                          "description": "", "duration_weeks": 2.0,
                          "effort_points": 20, "sort_order": 0}],
        "dependencies": [],
    }
    assert client.post("/api/import", json=legacy).status_code == 200

    deliverable = client.get("/api/export").json()["deliverables"][0]
    assert deliverable["name"] == "Wireframes"
    assert "duration_weeks" not in deliverable
    assert "effort_points" not in deliverable


def test_a_version_4_export_imports_with_every_deliverable_ongoing(client):
    """The tick did not exist yet, and nothing recorded these as finished."""
    legacy = {
        "version": 4,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14, "v1_tolerance_pct": 5.0,
                     "department_name": "Platform"},
        "projects": [{"id": 1, "name": "Payments", "description": "",
                      "goal": "", "start_date": "2026-01-05",
                      "velocity_override": None, "stage": "active", "track": "",
                      "created_at": "2026-01-01T00:00:00+00:00",
                      "updated_at": "2026-01-01T00:00:00+00:00"}],
        "phases": [{"id": 1, "project_id": 1, "name": "Design", "description": "",
                    "start_date": "2026-01-05", "duration_weeks": 4,
                    "effort_points": 40, "status": "done", "sort_order": 0}],
        "deliverables": [{"id": 1, "phase_id": 1, "name": "Wireframes",
                          "description": "", "sort_order": 0}],
        "dependencies": [],
    }
    assert client.post("/api/import", json=legacy).status_code == 200

    exported = client.get("/api/export").json()
    assert exported["version"] == 10
    # Even under a phase marked done -- the tick is the user's to set, and a
    # phase status is not evidence about any particular deliverable.
    assert exported["deliverables"][0]["done"] == 0
    # A version-4 file predates checkpoints, so it names nothing to aim at and
    # the project reads as still being drafted.
    assert exported["milestones"] == []
    assert "draft_complete" not in exported["projects"][0]


def version_5_file(dependencies):
    """A v5 export -- two projects, one phase each -- with phase-level links."""
    def project(project_id, name, start):
        return {"id": project_id, "name": name, "description": "", "goal": "",
                "start_date": start, "velocity_override": None,
                "stage": "active", "track": "",
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00"}

    def phase(phase_id, project_id, name, start):
        return {"id": phase_id, "project_id": project_id, "name": name,
                "description": "", "start_date": start, "duration_weeks": 4,
                "effort_points": 40, "status": "planned", "sort_order": 0}

    return {
        "version": 5,
        "settings": {"default_velocity_points_per_sprint": 20,
                     "sprint_length_days": 14, "v1_tolerance_pct": 5.0,
                     "department_name": "Platform"},
        "projects": [project(1, "Payments", "2026-01-05"),
                     project(2, "Ledger", "2026-03-02")],
        "phases": [phase(1, 1, "Design", "2026-01-05"),
                   phase(2, 1, "Build", "2026-02-02"),
                   phase(3, 2, "Ledger core", "2026-03-02")],
        "deliverables": [],
        "dependencies": dependencies,
    }


def test_a_version_5_export_lifts_phase_dependencies_up_to_projects(client):
    """Phase 2 (Payments) before phase 3 (Ledger) becomes Payments before Ledger."""
    legacy = version_5_file([
        {"id": 1, "predecessor_phase_id": 2, "successor_phase_id": 3},
    ])
    assert client.post("/api/import", json=legacy).status_code == 200

    dependencies = client.get("/api/export").json()["dependencies"]
    assert len(dependencies) == 1
    assert dependencies[0]["predecessor_project_id"] == 1
    assert dependencies[0]["successor_project_id"] == 2
    assert "predecessor_phase_id" not in dependencies[0]


def test_a_version_5_intra_project_dependency_is_discarded(client):
    """Design before Build inside Payments is no longer something we record."""
    legacy = version_5_file([
        {"id": 1, "predecessor_phase_id": 1, "successor_phase_id": 2},
    ])
    assert client.post("/api/import", json=legacy).status_code == 200
    assert client.get("/api/export").json()["dependencies"] == []


def test_version_5_links_folding_onto_the_same_pair_collapse_to_one(client):
    """Two phase links between the same two projects say one thing at this level."""
    legacy = version_5_file([
        {"id": 1, "predecessor_phase_id": 1, "successor_phase_id": 3},
        {"id": 2, "predecessor_phase_id": 2, "successor_phase_id": 3},
    ])
    assert client.post("/api/import", json=legacy).status_code == 200
    assert len(client.get("/api/export").json()["dependencies"]) == 1


# --- the fortnight slice -----------------------------------------------------


def fortnight(client, start=None):
    response = client.get("/api/fortnight",
                          params={"start": start} if start else None)
    assert response.status_code == 200
    return response.json()


def test_the_fortnight_returns_a_lane_per_phase_in_the_window(client):
    project = make_project(client, "Payments", "2026-08-03")
    client.put(f"/api/projects/{project['id']}", json={"track": "Core / Billing"})
    build = make_phase(client, project["id"], "Build", "2026-08-04", 1, 10)
    client.post(f"/api/phases/{build['id']}/deliverables",
                json={"name": "Retry + backoff"})

    lanes = fortnight(client, "2026-08-03")["lanes"]
    assert len(lanes) == 1
    lane = lanes[0]
    assert lane["project_name"] == "Payments"
    assert lane["track"] == "Core / Billing"
    assert lane["phase_name"] == "Build"
    assert lane["start_date"] == "2026-08-04"
    assert lane["end_date"] == "2026-08-11"
    assert lane["effort_points"] == 10
    assert lane["band"] == "window"
    assert lane["clipped_start"] is False
    assert [d["name"] for d in lane["deliverables"]] == ["Retry + backoff"]


def test_the_fortnight_snaps_to_a_monday_and_says_that_it_did(client):
    window = fortnight(client, "2026-08-05")["window"]      # a Wednesday
    assert window["requested_start"] == "2026-08-05"
    assert window["start"] == "2026-08-03"
    assert window["end"] == "2026-08-16"
    assert window["lead_out_end"] == "2026-08-23"


def test_the_fortnight_defaults_to_the_monday_of_this_week(client):
    today = date.today()
    window = fortnight(client)["window"]
    assert window["start"] == (today - timedelta(days=today.weekday())).isoformat()
    # Today is inside its own fortnight, so the strip always has a today line.
    assert window["today"] == today.isoformat()


def test_a_garbage_start_is_rejected_rather_than_guessed_at(client):
    assert client.get("/api/fortnight", params={"start": "next week"}).status_code == 422


def test_the_fortnight_leaves_ideas_out(client):
    """The drawer opens off the portfolio chart, which never drew them."""
    idea = make_direction(client, "Build caching")
    client.put(f"/api/projects/{idea['id']}", json={"start_date": "2026-08-03"})
    make_phase(client, idea["id"], "Spike", "2026-08-04", 1, 10)
    assert fortnight(client, "2026-08-03")["lanes"] == []


def test_the_fortnight_never_sums_points(client):
    """Invariant 2, checked at the boundary: a windowed total is a
    points-per-day constant in disguise, and nothing may add one quietly."""
    project = make_project(client, "Payments", "2026-08-03")
    make_phase(client, project["id"], "Build", "2026-08-04", 1, 10)
    make_phase(client, project["id"], "Ship", "2026-08-11", 1, 10)

    payload = fortnight(client, "2026-08-03")
    assert set(payload) == {"window", "lanes"}
    assert set(payload["window"]) == {
        "requested_start", "start", "end", "lead_out_start", "lead_out_end",
        "days", "today",
    }
    assert all(set(lane) == {
        "project_id", "project_name", "track", "phase_id", "phase_name",
        "start_date", "end_date", "effort_points", "duration_weeks", "status",
        "band", "clipped_start", "clipped_end", "deliverables",
    } for lane in payload["lanes"])


def test_the_fortnight_bands_late_work_beside_what_is_running(client):
    project = make_project(client, "Payments", "2026-07-06")
    make_phase(client, project["id"], "Discovery", "2026-07-06", 2, 20)
    make_phase(client, project["id"], "Build", "2026-08-04", 1, 10)
    make_phase(client, project["id"], "Ship", "2026-08-17", 1, 10)

    lanes = fortnight(client, "2026-08-03")["lanes"]
    assert [(lane["phase_name"], lane["band"]) for lane in lanes] == [
        ("Discovery", "overdue"), ("Build", "window"), ("Ship", "lead_out"),
    ]


def test_an_empty_fortnight_still_returns_its_window(client):
    """The strip is the drop target for the tray, so the frame always exists."""
    payload = fortnight(client, "2026-08-03")
    assert payload["lanes"] == []
    assert payload["window"]["start"] == "2026-08-03"


def test_unscheduled_work_stays_off_the_fortnight(client):
    project = make_project(client, "Payments", "2026-08-03")
    make_phase(client, project["id"], "Dated", "2026-08-04", 1, 10)
    make_phase(client, project["id"], "Undated", "", 1, 10)

    lanes = fortnight(client, "2026-08-03")["lanes"]
    assert [lane["phase_name"] for lane in lanes] == ["Dated"]


# --- starting a sprint file --------------------------------------------------


@pytest.fixture
def sprints(tmp_path, monkeypatch):
    """Point the sprint directory somewhere disposable.

    The real one is `sprints/` at the repo root and holds work you have
    actually done, so no test may go near it.
    """
    directory = tmp_path / "sprints"
    monkeypatch.setattr(main, "SPRINTS_DIR", str(directory))
    return directory


def template_body():
    """The template below its heading -- what a new file must reproduce."""
    with open(main.SPRINT_TEMPLATE, encoding="utf-8", newline="") as handle:
        return handle.read().partition("\n")[2]


def start_sprint(client, start="2026-08-03"):
    response = client.post("/api/sprints", json={"start": start})
    assert response.status_code == 201, response.text
    return response.json()


def test_the_first_sprint_file_is_01(client, sprints):
    created = start_sprint(client)
    assert created["number"] == 1
    assert created["name"] == "01.md"
    assert created["path"] == "sprints/01.md"
    assert (sprints / "01.md").exists()


def test_the_heading_carries_the_number_and_the_fortnight(client, sprints):
    start_sprint(client, "2026-08-03")
    first = (sprints / "01.md").read_text(encoding="utf-8").partition("\n")[0]
    # Ends on the handover day -- the day sprint 2 starts, not the day before it.
    assert first == "# Sprint 1 · 2026-08-03 → 2026-08-17"


def test_everything_below_the_heading_is_the_template_untouched(client, sprints):
    """The template is the sprint format. This only fills in the top line."""
    start_sprint(client)
    with open(sprints / "01.md", encoding="utf-8", newline="") as handle:
        assert handle.read().partition("\n")[2] == template_body()


def test_numbering_carries_on_from_the_highest_file_present(client, sprints):
    sprints.mkdir()
    (sprints / "01.md").write_text("done", encoding="utf-8")
    (sprints / "03.md").write_text("done", encoding="utf-8")
    # 4, not 2: a gap is a sprint that was skipped, not a number to reuse.
    assert start_sprint(client)["name"] == "04.md"


def test_names_with_no_number_do_not_count(client, sprints):
    sprints.mkdir()
    (sprints / "notes.md").write_text("scratch", encoding="utf-8")
    assert start_sprint(client)["name"] == "01.md"


def test_a_sprint_file_is_never_overwritten(client, sprints, monkeypatch):
    """Needs the number pinned: 'next after the highest' cannot collide on its
    own, and this guard is here for the case where something else did.

    The second start is the **next** fortnight, not the same one. Reusing it would
    trip the overlap check first and this test would pass without ever reaching the
    exclusive create it exists for.
    """
    start_sprint(client)
    monkeypatch.setattr(main, "next_sprint_number", lambda _: 1)
    response = client.post("/api/sprints", json={"start": "2026-08-17"})
    assert response.status_code == 409
    # The filled-in file is still exactly what it was.
    with open(sprints / "01.md", encoding="utf-8", newline="") as handle:
        assert handle.read().partition("\n")[2] == template_body()


def test_the_sprint_start_is_the_date_it_was_given(client, sprints):
    """Nothing is snapped: the cadence is the team's, and it is not always Monday.

    `validation.fortnight_window` still snaps, and `GET /api/fortnight` still
    wants it to -- the drawer's strip is drawn on Monday week columns. A sprint
    file's heading is not a chart window.
    """
    created = start_sprint(client, "2026-08-05")          # a Wednesday, and it stays one
    assert created["window"]["start"] == "2026-08-05"
    assert created["window"]["end"] == "2026-08-19"
    assert (sprints / "01.md").read_text(encoding="utf-8").partition("\n")[0] \
        == "# Sprint 1 · 2026-08-05 → 2026-08-19"


def test_a_garbage_sprint_start_is_rejected(client, sprints):
    assert client.post("/api/sprints", json={"start": "soon"}).status_code == 422
    assert not sprints.exists()


# --- one team, one sprint at a time ------------------------------------------
#
# Two sprints covering the same day cannot both be run by one team, so creating
# that is refused and existing files that manage it anyway are reported. The dates
# are read back out of the heading `sprint_heading` writes; a heading that cannot
# be read has no window and takes part in nothing.
#
# The **handover day is the exception**: one sprint may end on the day the next
# begins, which is how the sprints are written down. Every window this app
# generates now lands exactly there -- `sprint_window` ends a sprint on its
# successor's first day -- so the allowance is what makes consecutive sprints
# creatable at all. The strictly-back-to-back case is the one that now only
# arrives by hand, and it is written that way below.


def test_a_heading_window_is_read_back_out_of_the_line_it_was_written_on():
    assert main.sprint_window_from_heading("# Sprint 1 · 2026-08-03 → 2026-08-16") \
        == {"start": "2026-08-03", "end": "2026-08-16"}
    # Retitled by hand, but it still says which fortnight it is about.
    assert main.sprint_window_from_heading("# The bad one, 2026-08-03 to 2026-08-16") \
        == {"start": "2026-08-03", "end": "2026-08-16"}


@pytest.mark.parametrize("heading", [
    "# Sprint 1",                                  # no dates at all
    "# Sprint 1 · 2026-08-03",                     # only one
    "# Sprint 1 · 2026-08-16 → 2026-08-03",        # backwards, so not a window
    "# Sprint 1 · 2026-13-01 → 2026-13-14",        # not dates
    "",
])
def test_a_heading_that_cannot_be_read_has_no_window(heading):
    """Lenient like `as_optional_date`: none of these is guessed at."""
    assert main.sprint_window_from_heading(heading) is None


def test_a_fortnight_overlapping_a_sprint_on_disk_is_refused(client, sprints):
    start_sprint(client, "2026-08-03")                     # covers 03 -> 17 Aug
    response = client.post("/api/sprints", json={"start": "2026-08-10"})
    assert response.status_code == 409
    assert "one sprint at a time" in response.json()["detail"]
    assert "sprint 1" in response.json()["detail"]
    # Refused means nothing was written, not written and then complained about.
    assert sorted(path.name for path in sprints.iterdir()) == ["01.md"]


def test_the_very_same_fortnight_is_an_overlap_too(client, sprints):
    start_sprint(client, "2026-08-03")
    assert client.post("/api/sprints", json={"start": "2026-08-03"}).status_code == 409
    assert sorted(path.name for path in sprints.iterdir()) == ["01.md"]


def test_back_to_back_fortnights_are_not_an_overlap(client, sprints):
    """One ending the day *before* the next begins is still fine.

    Written by hand: a generated window ends on the handover day now, so a gapless
    pair that does not share a day only arrives by editing a heading.
    """
    write_sprint(sprints, "01.md", "# Sprint 1 · 2026-08-03 → 2026-08-16\n")
    created = start_sprint(client, "2026-08-17")           # 17 -> 31 Aug
    assert created["name"] == "02.md"
    assert (sprints / "02.md").exists()


def test_a_shared_handover_day_is_not_an_overlap(client, sprints):
    """`... -> 17 Aug` then `17 Aug -> ...` is one day of planning, not two sprints.

    **This is the cadence, created twice through the API.** A sprint ends on the
    day the next one starts, so continuing a cadence means asking for a fortnight
    that begins on the previous sprint's end date -- and it has to be accepted, or
    the app could not start a second sprint at all.
    """
    first = start_sprint(client, "2026-08-03")
    assert first["window"]["end"] == "2026-08-17"

    created = start_sprint(client, first["window"]["end"])
    assert created["window"]["start"] == "2026-08-17"      # the day 01.md ends
    assert created["window"]["end"] == "2026-08-31"
    assert created["name"] == "02.md"
    assert (sprints / "02.md").exists()


def test_the_cadence_keeps_the_weekday_it_started_on(client, sprints):
    """Wednesday to Wednesday, sprint after sprint, with nothing snapping it back.

    The point of the unsnapped start: a team whose sync is on a Wednesday plans on
    Wednesdays, and the file headings say so.
    """
    made = []
    start = "2026-08-12"                                   # a Wednesday
    for _ in range(3):
        created = start_sprint(client, start)
        made.append((created["window"]["start"], created["window"]["end"]))
        start = created["window"]["end"]                   # hand over, carry on

    assert made == [
        ("2026-08-12", "2026-08-26"),
        ("2026-08-26", "2026-09-09"),
        ("2026-09-09", "2026-09-23"),
    ]


def test_one_day_past_the_handover_is_still_an_overlap(client, sprints):
    """The allowance is the touching endpoint alone, not a day of slack."""
    write_sprint(sprints, "01.md", "# Sprint 1 · 2026-07-27 → 2026-08-11\n")
    response = client.post("/api/sprints", json={"start": "2026-08-10"})
    assert response.status_code == 409
    assert "one sprint at a time" in response.json()["detail"]
    assert sorted(path.name for path in sprints.iterdir()) == ["01.md"]


def test_a_one_day_sprint_inside_another_is_an_overlap():
    """A single shared day is only forgiven at an endpoint -- nested is not that."""
    outer = {"start": "2026-08-03", "end": "2026-08-16"}
    inner = {"start": "2026-08-10", "end": "2026-08-10"}
    assert main.windows_overlap(outer, inner)
    assert main.windows_overlap(inner, outer)


def test_a_file_whose_heading_cannot_be_read_blocks_nothing(client, sprints):
    """It might cover those days. Guessing that it does would refuse a real sprint
    on the strength of an invented window."""
    write_sprint(sprints, "01.md", "# notes to self\n\nnothing here yet.\n")
    assert start_sprint(client, "2026-08-03")["name"] == "02.md"


def test_the_list_reports_the_window_and_who_it_overlaps(client, sprints):
    # Written by hand, because the app refuses to create this state.
    write_sprint(sprints, "01.md", "# Sprint 1 · 2026-08-03 → 2026-08-16\n")
    write_sprint(sprints, "02.md", "# Sprint 2 · 2026-08-10 → 2026-08-23\n")
    write_sprint(sprints, "03.md", "# Sprint 3 · 2026-08-24 → 2026-09-06\n")

    listed = {file["number"]: file for file in client.get("/api/sprints").json()}
    assert listed[1]["window"] == {"start": "2026-08-03", "end": "2026-08-16"}
    # Reported at both ends, so opening either file tells you.
    assert listed[1]["overlaps"] == [2]
    assert listed[2]["overlaps"] == [1]
    # Back to back with 2, and nowhere near 1.
    assert listed[3]["overlaps"] == []


def test_the_list_does_not_report_a_shared_handover_day(client, sprints):
    """The convention the sprints are actually written in must read as clean."""
    write_sprint(sprints, "01.md", "# Sprint 1 · 2026-06-17 → 2026-07-01\n")
    write_sprint(sprints, "02.md", "# Sprint 2 · 2026-07-01 → 2026-07-15\n")
    listed = {file["number"]: file for file in client.get("/api/sprints").json()}
    assert listed[1]["overlaps"] == []
    assert listed[2]["overlaps"] == []


def test_a_file_with_no_readable_window_overlaps_nothing(client, sprints):
    write_sprint(sprints, "01.md", "# Sprint 1 · 2026-08-03 → 2026-08-16\n")
    write_sprint(sprints, "02.md", "# untitled\n")
    listed = {file["number"]: file for file in client.get("/api/sprints").json()}
    assert listed[2]["window"] is None
    assert listed[2]["overlaps"] == []
    assert listed[1]["overlaps"] == []


# --- reading and writing a sprint file ---------------------------------------

SPRINT_FILE = """# Sprint 3 · 2026-08-10 → 2026-08-23

**Goal:** something.

| Person | Days |
|---|---|
| @qh | 10 |
"""


def write_sprint(sprints, name="03.md", text=SPRINT_FILE):
    sprints.mkdir(exist_ok=True)
    path = sprints / name
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return path


def read_sprint(client, number=3):
    response = client.get(f"/api/sprints/{number}")
    assert response.status_code == 200, response.text
    return response.json()


def test_the_sprint_list_is_sorted_and_carries_headings(client, sprints):
    write_sprint(sprints, "10.md", "# Sprint 10 · later\n")
    write_sprint(sprints, "03.md")
    listed = client.get("/api/sprints").json()
    assert [row["number"] for row in listed] == [3, 10]
    assert listed[0]["heading"] == "Sprint 3 · 2026-08-10 → 2026-08-23"
    assert listed[1]["name"] == "10.md"


def test_the_sprint_list_is_empty_before_any_sprint_exists(client, sprints):
    assert client.get("/api/sprints").json() == []


def test_a_name_with_no_number_is_ignored_but_left_alone(client, sprints):
    write_sprint(sprints, "notes.md", "scratch\n")
    assert client.get("/api/sprints").json() == []
    assert (sprints / "notes.md").exists()


def test_reading_a_sprint_returns_its_text_and_its_blocks(client, sprints):
    write_sprint(sprints)
    payload = read_sprint(client)
    assert payload["text"] == SPRINT_FILE
    assert [block["type"] for block in payload["blocks"]] == [
        "heading",
        "paragraph",
        "table",
    ]
    assert payload["blocks"][2]["table"]["head"] == ["Person", "Days"]
    assert payload["mtime"] > 0


def test_reading_a_missing_sprint_is_a_404(client, sprints):
    assert client.get("/api/sprints/7").status_code == 404


def test_saving_a_sprint_persists_it_and_returns_a_new_mtime(client, sprints):
    path = write_sprint(sprints)
    payload = read_sprint(client)
    edited = SPRINT_FILE.replace("something", "something else")

    response = client.put("/api/sprints/3", json={"text": edited, "mtime": payload["mtime"]})
    assert response.status_code == 200, response.text
    with open(path, encoding="utf-8", newline="") as handle:
        assert handle.read() == edited
    assert response.json()["mtime"] == os.path.getmtime(path)


def test_a_stale_mtime_is_a_409_and_the_file_is_untouched(client, sprints):
    """The AI review script reads these files and you will edit them by hand, so
    the app never decides whose version wins."""
    path = write_sprint(sprints)
    response = client.put("/api/sprints/3", json={"text": "clobbered", "mtime": 1.0})
    assert response.status_code == 409
    assert response.json()["detail"]["mtime"] == os.path.getmtime(path)
    with open(path, encoding="utf-8", newline="") as handle:
        assert handle.read() == SPRINT_FILE


def test_saving_leaves_no_temporary_file_behind(client, sprints):
    write_sprint(sprints)
    payload = read_sprint(client)
    client.put("/api/sprints/3", json={"text": "edited\n", "mtime": payload["mtime"]})
    assert [path.name for path in sprints.iterdir()] == ["03.md"]


def test_saving_a_missing_sprint_is_a_404_and_creates_nothing(client, sprints):
    sprints.mkdir()
    response = client.put("/api/sprints/7", json={"text": "new", "mtime": 0.0})
    assert response.status_code == 404
    assert list(sprints.iterdir()) == []


def test_saving_without_an_mtime_is_rejected(client, sprints):
    # The guard is not optional: a caller cannot save by leaving it out.
    write_sprint(sprints)
    assert client.put("/api/sprints/3", json={"text": "edited"}).status_code == 422


def test_line_endings_survive_a_save(client, sprints):
    text = SPRINT_FILE.replace("\n", "\r\n")
    path = write_sprint(sprints, text=text)
    payload = read_sprint(client)
    client.put("/api/sprints/3", json={"text": payload["text"], "mtime": payload["mtime"]})
    with open(path, encoding="utf-8", newline="") as handle:
        assert handle.read() == text


def test_split_turns_one_edited_block_into_several(client):
    blocks = client.post(
        "/api/sprints/split", json={"text": "one\n\ntwo\n\nthree"}
    ).json()["blocks"]
    assert [block["raw"] for block in blocks] == ["one", "two", "three"]


def test_split_changes_the_type_when_a_heading_is_typed(client):
    blocks = client.post("/api/sprints/split", json={"text": "## Capacity"}).json()["blocks"]
    assert [block["type"] for block in blocks] == ["heading"]
    assert "<h2>" in blocks[0]["html"]


def test_an_edited_grid_comes_back_as_aligned_markdown(client):
    blocks = client.post(
        "/api/sprints/table",
        json={"head": ["Person", "Days"], "align": ["", "right"], "rows": [["@qh", "10"]]},
    ).json()["blocks"]
    assert [block["type"] for block in blocks] == ["table"]
    # The right-aligned column pads on the left, so its numbers line up in the
    # file the same way they line up when the table is rendered.
    assert blocks[0]["raw"].splitlines() == [
        "| Person | Days |",
        "| ------ | ---: |",
        "| @qh    |   10 |",
    ]


def test_an_empty_grid_is_rejected_rather_than_written_as_pipes(client):
    response = client.post("/api/sprints/table", json={"head": [], "align": [], "rows": []})
    assert response.status_code == 422


# --- migrating an existing file ---------------------------------------------


def created(row):
    """Narrow the `dict | None` the db create helpers return."""
    assert row is not None
    return row


def test_migrate_lifts_an_old_phase_dependency_table_to_projects(tmp_path):
    """The one-way upgrade of a real file: translate, then drop the old table."""
    db.set_db_path(str(tmp_path / "old.db"))
    try:
        db.init_db()
        with db.connect() as connection:
            # Rebuild the pre-version-6 table and populate it directly.
            connection.execute("""
                CREATE TABLE dependency (
                    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                    predecessor_phase_id INTEGER NOT NULL,
                    successor_phase_id   INTEGER NOT NULL,
                    UNIQUE (predecessor_phase_id, successor_phase_id))""")
        payments = created(db.create_project("Payments", "2026-01-05"))
        ledger = created(db.create_project("Ledger", "2026-03-02"))
        design = created(db.create_phase(payments["id"], "Design", "2026-01-05", 4, 40))
        build = created(db.create_phase(payments["id"], "Build", "2026-02-02", 4, 40))
        core = created(db.create_phase(ledger["id"], "Ledger core", "2026-03-02", 4, 40))

        with db.connect() as connection:
            connection.executemany(
                "INSERT INTO dependency (predecessor_phase_id, successor_phase_id)"
                " VALUES (?, ?)",
                [(design["id"], build["id"]),   # inside Payments -- dropped
                 (build["id"], core["id"])],    # Payments -> Ledger -- kept
            )
            db.migrate(connection)
            assert not db.table_exists(connection, "dependency")

        assert db.list_all_dependencies() == [
            {"id": 1, "predecessor_project_id": payments["id"],
             "successor_project_id": ledger["id"]},
        ]
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def pre_planned_file(path):
    """A file whose project table still carries the old three-value CHECK.

    Built the way a real one was: create the modern schema, then swap the
    project table for the pre-'planned' definition, carrying the rows over.
    """
    db.set_db_path(str(path))
    db.init_db()
    payments = created(db.create_project("Payments", "2026-01-05", stage="active"))
    design = created(db.create_phase(payments["id"], "Design", "2026-01-05", 4, 40))
    db.create_deliverable(design["id"], "Wireframes")

    with db.connect() as connection:
        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("""
            CREATE TABLE project_old (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                name              TEXT NOT NULL,
                description       TEXT NOT NULL DEFAULT '',
                goal              TEXT NOT NULL DEFAULT '',
                start_date        TEXT NOT NULL,
                velocity_override INTEGER,
                stage             TEXT NOT NULL DEFAULT 'active'
                                  CHECK (stage IN ('idea', 'active', 'done')),
                track             TEXT NOT NULL DEFAULT '',
                tier              INTEGER NOT NULL DEFAULT 0
                                  CHECK (tier IN (0, 1, 2, 3)),
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL)""")
        # A file this old predates every column added since, not just the wider
        # CHECK -- so copy the intersection rather than PROJECT_COLUMNS, which
        # is the current shape and grows.
        current = db.columns_of(connection, "project")
        columns = ", ".join(column for column in db.columns_of(connection, "project_old")
                            if column in current)
        connection.execute(
            f"INSERT INTO project_old ({columns}) SELECT {columns} FROM project")
        connection.execute("DROP TABLE project")
        connection.execute("ALTER TABLE project_old RENAME TO project")
        connection.commit()
    return payments, design


def test_migrate_widens_the_stage_check_without_losing_anything(tmp_path):
    """The rebuild that 'planned' needs, on a file that predates it.

    The dangerous part is the drop: phase.project_id is ON DELETE CASCADE, so
    dropping the old project table with foreign keys enabled would take every
    phase and deliverable with it.
    """
    try:
        payments, design = pre_planned_file(tmp_path / "old.db")

        with db.connect() as connection:
            with pytest.raises(Exception):
                connection.execute(
                    "UPDATE project SET stage = 'planned' WHERE id = ?",
                    (payments["id"],))

        db.init_db()   # migrate runs on every open

        updated = created(db.update_project(payments["id"], {"stage": "planned"}))
        assert updated["stage"] == "planned"
        # Nothing cascaded away.
        assert [phase["name"] for phase in db.list_phases(payments["id"])] == ["Design"]
        assert [d["name"] for d in db.list_deliverables(design["id"])] == ["Wireframes"]
        assert created(db.get_project(payments["id"]))["name"] == "Payments"
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_the_stage_rebuild_keeps_the_foreign_keys_pointing_at_project(tmp_path):
    """Renaming the old table out of the way would have repointed them."""
    try:
        pre_planned_file(tmp_path / "old.db")
        db.init_db()

        with db.connect() as connection:
            phase_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = 'phase'").fetchone()[0]
            assert "REFERENCES project(id)" in phase_sql
            assert "project_rebuilt" not in phase_sql
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_the_stage_rebuild_runs_once_and_then_leaves_the_file_alone(tmp_path):
    try:
        payments, _ = pre_planned_file(tmp_path / "old.db")
        db.init_db()
        db.update_project(payments["id"], {"stage": "planned"})

        db.init_db()   # a second open must not rebuild or reset anything
        assert created(db.get_project(payments["id"]))["stage"] == "planned"
        with db.connect() as connection:
            assert not db.table_exists(connection, "project_rebuilt")
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_the_frontend_loads_nothing_from_off_this_machine(client):
    """Localhost-only, and it works offline: mermaid is vendored, never fetched.

    The failure this guards is a missing `vendor/mermaid.min.js` being "fixed"
    with a CDN tag, which would quietly make the app need the internet to draw.
    """
    page = client.get("/static/index.html")
    assert page.status_code == 200
    assert not re.search(r'(?:src|href)\s*=\s*"[^"]*//', page.text)

    editor = client.get("/static/editor.js")
    assert editor.status_code == 200
    assert 'MERMAID_SRC = "/static/vendor/mermaid.min.js"' in editor.text


def test_migrate_is_a_no_op_once_the_old_table_is_gone(tmp_path):
    db.set_db_path(str(tmp_path / "current.db"))
    try:
        db.init_db()
        payments = created(db.create_project("Payments", "2026-01-05"))
        ledger = created(db.create_project("Ledger", "2026-03-02"))
        db.create_dependency(payments["id"], ledger["id"])
        db.init_db()   # migrate runs again on every open
        assert len(db.list_all_dependencies()) == 1
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


# --- milestones -------------------------------------------------------------


def test_a_file_predating_milestones_gains_the_table_on_open(tmp_path):
    """The whole milestone migration: CREATE TABLE IF NOT EXISTS, nothing else.

    No `migrate` step, no table rebuild, no foreign-key pragma -- the additive
    path, nowhere near `migrate_stage_check`. Built the way a real old file
    arrives: create the schema, drop the table back off, reopen.
    """
    db.set_db_path(str(tmp_path / "old.db"))
    try:
        db.init_db()
        payments = created(db.create_project("Payments", "2026-01-05"))
        with db.connect() as connection:
            connection.execute("DROP TABLE milestone")
            assert not db.table_exists(connection, "milestone")

        db.init_db()

        with db.connect() as connection:
            assert db.table_exists(connection, "milestone")
        # And the project it belongs to came through untouched.
        assert created(db.get_project(payments["id"]))["name"] == "Payments"
        assert db.list_milestones(payments["id"]) == []
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_milestones_are_created_in_order_and_default_to_unachieved(tmp_path):
    db.set_db_path(str(tmp_path / "milestones.db"))
    try:
        db.init_db()
        payments = created(db.create_project("Payments", "2026-01-05"))
        beta = created(db.create_milestone(payments["id"], "Private beta",
                                           target_date="2026-03-02"))
        launch = created(db.create_milestone(payments["id"], "Launch"))

        assert [beta["sort_order"], launch["sort_order"]] == [0, 1]
        assert beta["achieved"] == 0 and launch["achieved"] == 0
        # Unscheduled is '' and not NULL, so it round-trips a date input.
        assert launch["target_date"] == ""
        assert [m["name"] for m in db.list_milestones(payments["id"])] == [
            "Private beta", "Launch"]
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_milestones_by_project_groups_every_project_in_one_query(tmp_path):
    db.set_db_path(str(tmp_path / "grouped.db"))
    try:
        db.init_db()
        payments = created(db.create_project("Payments", "2026-01-05"))
        ledger = created(db.create_project("Ledger", "2026-03-02"))
        db.create_milestone(payments["id"], "Private beta")
        db.create_milestone(payments["id"], "Launch")
        db.create_milestone(ledger["id"], "Books balance")

        grouped = db.milestones_by_project()
        assert [m["name"] for m in grouped[payments["id"]]] == [
            "Private beta", "Launch"]
        assert [m["name"] for m in grouped[ledger["id"]]] == ["Books balance"]
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_milestones_round_trip_through_their_routes(client):
    project = make_project(client, start="")
    created_at = client.post(f"/api/projects/{project['id']}/milestones", json={
        "name": "Private beta", "target_date": "2026-03-02",
    })
    assert created_at.status_code == 201
    assert created_at.json()["achieved"] == 0

    listed = client.get(f"/api/projects/{project['id']}/milestones").json()
    assert [m["name"] for m in listed] == ["Private beta"]

    # They ride on the plan payload too, so the view needs no second fetch.
    plan = client.get(f"/api/projects/{project['id']}").json()
    assert [m["name"] for m in plan["milestones"]] == ["Private beta"]


def test_a_milestone_date_is_strict_on_the_way_in(client):
    """Writes are strict so a bad value never gets stored; empty stays empty."""
    project = make_project(client, start="")
    bad = client.post(f"/api/projects/{project['id']}/milestones", json={
        "name": "Private beta", "target_date": "next tuesday",
    })
    assert bad.status_code == 422

    undated = client.post(f"/api/projects/{project['id']}/milestones",
                          json={"name": "Launch"})
    assert undated.json()["target_date"] == ""


def test_missing_projects_and_milestones_are_404(client):
    assert client.get("/api/projects/999/milestones").status_code == 404
    assert client.post("/api/projects/999/milestones",
                       json={"name": "Launch"}).status_code == 404
    assert client.put("/api/milestones/999", json={"achieved": True}).status_code == 404
    assert client.delete("/api/milestones/999").status_code == 404


def test_ticking_the_last_milestone_through_the_route_finishes_the_project(client):
    project = make_project(client, start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    beta = client.post(f"/api/projects/{project['id']}/milestones",
                       json={"name": "Private beta"}).json()
    launch = client.post(f"/api/projects/{project['id']}/milestones",
                         json={"name": "Launch"}).json()

    client.put(f"/api/milestones/{beta['id']}", json={"achieved": True})
    assert stages_of(client)[0]["Payments"] == "overdue"

    client.put(f"/api/milestones/{launch['id']}", json={"achieved": True})
    assert stages_of(client)[0]["Payments"] == "done"

    # Untick one and the project is unfinished again -- nothing latches.
    client.put(f"/api/milestones/{launch['id']}", json={"achieved": False})
    assert stages_of(client)[0]["Payments"] == "overdue"

    # And deleting the only unreached one finishes it, which is the same rule
    # read the other way: what is left to aim at is all that counts.
    client.delete(f"/api/milestones/{launch['id']}")
    assert stages_of(client)[0]["Payments"] == "done"


def test_the_graph_carries_the_milestone_tally_the_map_colours_from(client):
    """The map's green splits `done` into delivered and merely closed. The ladder
    derives `done` from checkpoints, so the split reads checkpoints too -- reading
    the phase tally would be wrong in both directions."""
    project = make_project(client, start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    beta = client.post(f"/api/projects/{project['id']}/milestones",
                       json={"name": "Private beta"}).json()

    node = client.get("/api/graph").json()["projects"][0]
    assert (node["milestones_reached"], node["milestones_total"]) == (0, 1)
    assert node["derived_stage"] == "overdue"

    client.put(f"/api/milestones/{beta['id']}", json={"achieved": True})
    node = client.get("/api/graph").json()["projects"][0]
    assert (node["milestones_reached"], node["milestones_total"]) == (1, 1)
    assert node["derived_stage"] == "done"
    # The phase is still open, and the node is still green -- reaching what the
    # plan aimed at is the delivery, not the phase bookkeeping under it.
    assert (node["phases_done"], node["phases_total"]) == (0, 1)


def test_a_manual_close_carries_no_milestones_to_earn_the_green(client):
    """The case the split exists for: closed without finishing stays grey."""
    project = make_project(client, start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.put(f"/api/projects/{project['id']}", json={"stage": "done"})

    node = client.get("/api/graph").json()["projects"][0]
    assert node["derived_stage"] == "done"
    assert node["milestones_total"] == 0


def test_promoting_an_idea_is_a_write_and_never_an_inference(client):
    """`idea` beats every derived rung, so a checkpoint alone must not promote:
    the portfolio and map filter on the stored stage and the two must agree.
    The frontend gates the button on >=1 milestone; the server refuses nothing,
    because setting your own project's stage is not malformed data."""
    idea = client.post("/api/projects", json={
        "name": "Caching", "start_date": "", "stage": "idea",
    }).json()
    phase = make_phase(client, idea["id"], "Design", "", 2, 20)
    client.post(f"/api/phases/{phase['id']}/deliverables", json={"name": "Wireframes"})
    db.create_milestone(idea["id"], "Private beta")

    # Everything a plan needs, and it is still an idea until you say otherwise.
    assert stages_of(client)[0]["Caching"] == "idea"

    promoted = client.put(f"/api/projects/{idea['id']}", json={"stage": "planned"})
    assert promoted.status_code == 200
    assert promoted.json()["stage"] == "planned"
    assert stages_of(client)[0]["Caching"] == "planned"


def test_ticking_a_milestone_stores_a_flag_and_deleting_a_project_takes_it(tmp_path):
    db.set_db_path(str(tmp_path / "achieved.db"))
    try:
        db.init_db()
        payments = created(db.create_project("Payments", "2026-01-05"))
        beta = created(db.create_milestone(payments["id"], "Private beta"))

        ticked = created(db.update_milestone(beta["id"], {"achieved": True}))
        assert ticked["achieved"] == 1
        # project_id is not writable -- a milestone cannot move house.
        moved = created(db.update_milestone(beta["id"], {"project_id": 999}))
        assert moved["project_id"] == payments["id"]

        db.delete_project(payments["id"])
        assert db.get_milestone(beta["id"]) is None
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)
