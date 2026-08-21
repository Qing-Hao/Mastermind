"""End-to-end API tests mapped to the acceptance criteria in PROMPT.md."""

import base64
import json
import os
import re
import sqlite3
import threading
import time
from datetime import date, timedelta
from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth, db, main
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


def test_portfolio_carries_each_project_span_and_totals(client):
    """The swimlane title's content: the project's own dates, counts and stage."""
    project = make_project(client, "Payments", "2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 55)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["span_start"] == "2026-01-05"
    assert lane["span_end"] == "2026-03-16"
    assert lane["phase_count"] == 2
    assert lane["total_points"] == 95


def test_a_project_payload_carries_the_same_span_the_portfolio_reports(client):
    """The top bar prints a project's dates, and it must be the portfolio's answer.

    Both routes run `with_project_span`, so this is really asserting that neither
    one grew its own copy of the arithmetic. The frontend reads `span_end` rather
    than taking a `max` over the phases it already holds for the same reason.
    """
    project = make_project(client, "Payments", "2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 55)

    plan = client.get(f"/api/projects/{project['id']}").json()["project"]
    lane = client.get("/api/portfolio").json()["projects"][0]

    assert plan["span_start"] == lane["span_start"] == "2026-01-05"
    assert plan["span_end"] == lane["span_end"] == "2026-03-16"
    assert plan["phase_count"] == lane["phase_count"] == 2
    assert plan["total_points"] == lane["total_points"] == 95
    assert plan["completion"] == lane["completion"]


def test_an_undated_project_reports_no_span_on_its_own_payload_either(client):
    """Half a range is worse than none, so the unscheduled convention holds here."""
    project = make_project(client, "Payments", start="")
    make_phase(client, project["id"], "Design", "", 4, 40)

    plan = client.get(f"/api/projects/{project['id']}").json()["project"]
    assert plan["span_start"] == ""
    assert plan["span_end"] == ""
    assert plan["phase_count"] == 1


def test_a_swimlane_carries_its_deliverable_tally(client):
    """What the collapsed lane's progress bar fills from. Display only.

    Read off the ticks rather than `phase.status`, which nothing maintains --
    see `validation.deliverable_progress`. A project naming no deliverables
    reports 0 of 0 and gets no bar at all, never an empty one.
    """
    project = make_project(client, "Payments", "2026-01-05")
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 55)
    ticked = add_deliverable(client, design["id"], "Wireframes")
    add_deliverable(client, design["id"], "Prototype")
    client.put(f"/api/deliverables/{ticked['id']}", json={"done": True})

    bare = make_project(client, "Search", "2026-01-05")
    make_phase(client, bare["id"], "Spike", "2026-01-05", 1, 10)

    lanes = {lane["name"]: lane for lane in
             client.get("/api/portfolio").json()["projects"]}
    assert (lanes["Payments"]["deliverables_done"],
            lanes["Payments"]["deliverables_total"]) == (1, 2)
    assert (lanes["Search"]["deliverables_done"],
            lanes["Search"]["deliverables_total"]) == (0, 0)
    # Design is half ticked and Build names nothing, so the bar fills a quarter.
    assert lanes["Payments"]["completion"] == 0.25
    assert lanes["Search"]["completion"] == 0.0


def test_a_swimlane_with_no_phases_reports_no_completion(client):
    """`None`, never 0 -- with no phases there is no frame to measure against."""
    make_project(client, "Payments", "2026-01-05")
    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["completion"] is None


def test_a_swimlane_carries_the_derived_stage_too(client):
    """Dated around today, so the rung is the clock's answer and not the file's."""
    started = (date.today() - timedelta(days=7)).isoformat()
    project = make_project(client, "Payments", started)
    make_phase(client, project["id"], "Build", started, 6, 55)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["derived_stage"] == "active"
    # The stored commitment travels untouched beside it, the same contract
    # /api/projects has: `active` is what this route's default writes, and it
    # reads identically to `planned` -- both simply mean committed.
    assert lane["stage"] == "active"


def test_portfolio_carries_dated_milestones_for_the_chart(client):
    """The diamonds the swimlanes draw: dated checkpoints, flat, project-tagged."""
    first = make_project(client, "Payments", "2026-01-05")
    second = make_project(client, "Search", "2026-03-02")
    client.post(f"/api/projects/{first['id']}/milestones",
                json={"name": "Private beta", "target_date": "2026-02-02"})
    client.post(f"/api/projects/{second['id']}/milestones",
                json={"name": "Launch", "target_date": "2026-04-06"})

    drawn = client.get("/api/portfolio").json()["milestones"]
    assert [(m["project_id"], m["name"]) for m in drawn] == [
        (first["id"], "Private beta"),
        (second["id"], "Launch"),
    ]


def test_portfolio_omits_an_undated_milestone(client):
    """Same rule as an unscheduled phase: no honest place on a calendar.

    Unlike a phase it is not handed back in a tray either -- a checkpoint has no
    work to place, and the project view is where an undated one is chased up.
    """
    project = make_project(client, start="2026-01-05")
    client.post(f"/api/projects/{project['id']}/milestones", json={"name": "Someday"})

    assert client.get("/api/portfolio").json()["milestones"] == []


def test_portfolio_omits_an_idea_s_milestones(client):
    """An idea has no swimlane, so its checkpoints have no lane to draw in."""
    idea = make_project(client, "Someday", start="2026-01-05")
    client.put(f"/api/projects/{idea['id']}", json={"name": "Someday", "stage": "idea"})
    client.post(f"/api/projects/{idea['id']}/milestones",
                json={"name": "Private beta", "target_date": "2026-02-02"})

    assert client.get("/api/portfolio").json()["milestones"] == []


def test_a_project_span_ignores_the_chart_window(client):
    """The span is every phase, so a lane cannot report the visible slice.

    A lane only draws the phases inside the window it is scrolled to. Measuring
    those would make the same project claim different dates depending on where
    the chart sits, which is the one trap in this feature.
    """
    project = make_project(client, "Payments", "2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    # Years away: no window shows both of these at once.
    make_phase(client, project["id"], "Rollout", "2029-06-04", 2, 20)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["span_start"] == "2026-01-05"
    assert lane["span_end"] == "2029-06-18"


def test_an_undated_project_reports_no_span_rather_than_a_guess(client):
    project = make_project(client, "Payments", start="")
    make_phase(client, project["id"], "Design", "", 4, 40)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["span_start"] == ""
    assert lane["span_end"] == ""
    assert lane["phase_count"] == 1
    assert lane["total_points"] == 40


def test_a_span_covers_a_phase_dated_before_its_project(client):
    """V4 warns about this separately; the span still reports where work starts."""
    project = make_project(client, "Payments", "2026-03-01")
    make_phase(client, project["id"], "Discovery", "2026-01-05", 2, 20)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert lane["span_start"] == "2026-01-05"


def test_portfolio_is_empty_when_nothing_is_planned(client):
    assert client.get("/api/portfolio").json() == {
        "projects": [], "phases": [], "milestones": [], "unscheduled": [],
        "unscheduled_count": 0, "dependencies": [], "warnings": [],
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


def test_graph_carries_the_deliverable_tally_the_node_fills_from(client):
    """How full a node draws. A different question from the phase tally beside it.

    The fill reads ticks rather than `phase.status` because that field is
    maintained by nobody on the real file, so a phase-driven fill draws every
    circle empty. Both tallies travel; neither derives anything (rule 4).
    """
    project = make_project(client, start="2026-01-05")
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    build = make_phase(client, project["id"], "Build", "2026-02-02", 6, 60)
    ticked = add_deliverable(client, design["id"], "Wireframes")
    add_deliverable(client, design["id"], "Prototype")
    add_deliverable(client, build["id"], "Refund flow")
    client.put(f"/api/deliverables/{ticked['id']}", json={"done": True})

    node = client.get("/api/graph").json()["projects"][0]
    assert (node["deliverables_done"], node["deliverables_total"]) == (1, 3)
    # Nothing was closed, so the phase tally disagrees -- which is the point of
    # carrying both.
    assert (node["phases_done"], node["phases_total"]) == (0, 2)
    # Half of Design's two, none of Build's one, over two phases.
    assert node["completion"] == 0.25


def test_the_two_charts_read_one_completion_field(client):
    """The map node and the swimlane must not be able to disagree."""
    project = make_project(client, "Payments", "2026-01-05")
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 55)
    ticked = add_deliverable(client, design["id"], "Wireframes")
    client.put(f"/api/deliverables/{ticked['id']}", json={"done": True})

    lane = client.get("/api/portfolio").json()["projects"][0]
    node = client.get("/api/graph").json()["projects"][0]
    assert lane["completion"] == node["completion"] == 0.5


def test_a_closed_phase_completes_its_share_on_the_map(client):
    """The one place `phase.status` still moves the number: a hand-closed phase."""
    project = make_project(client, "Payments", "2026-01-05")
    first = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    make_phase(client, project["id"], "Build", "2026-02-02", 6, 55)
    add_deliverable(client, first["id"], "Wireframes")

    assert client.get("/api/graph").json()["projects"][0]["completion"] == 0.0
    client.put(f"/api/phases/{first['id']}", json={"status": "done"})
    # Its deliverable is still unticked; closing the phase counts it whole.
    assert client.get("/api/graph").json()["projects"][0]["completion"] == 0.5


def test_graph_tally_of_a_project_naming_no_deliverables_is_zero_of_zero(client):
    """The map draws no fill for this, rather than an empty one meaning 0%."""
    project = make_project(client, start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)

    node = client.get("/api/graph").json()["projects"][0]
    assert (node["deliverables_done"], node["deliverables_total"]) == (0, 0)


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


# --- the template ------------------------------------------------------------
#
# The one openable file that is not a sprint. Same two verbs and the same mtime
# guard, on `templates/sprint.md` -- which is checked into git and edited by hand
# as well, so **no test may go near the real one**: the fixture below points the
# module-level path at `tmp_path`, the same shape the `sprints` fixture uses.

TEMPLATE_FILE = """# Sprint N · YYYY-MM-DD → YYYY-MM-DD

## 1. Sprint Goal

**Sprint Goal:**
"""


@pytest.fixture
def template(tmp_path, monkeypatch):
    path = tmp_path / "template" / "sprint.md"
    path.parent.mkdir()
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(TEMPLATE_FILE)
    monkeypatch.setattr(main, "SPRINT_TEMPLATE", str(path))
    return path


def read_template(client):
    response = client.get("/api/template")
    assert response.status_code == 200, response.text
    return response.json()


def test_reading_the_template_returns_its_text_and_its_blocks(client, template):
    payload = read_template(client)
    assert payload["text"] == TEMPLATE_FILE
    assert payload["path"] == "templates/sprint.md"
    assert [block["type"] for block in payload["blocks"]] == [
        "heading",
        "heading",
        "paragraph",
    ]
    assert payload["mtime"] > 0


def test_saving_the_template_persists_it_and_returns_a_new_mtime(client, template):
    payload = read_template(client)
    edited = TEMPLATE_FILE.replace("Sprint Goal", "Goal")

    response = client.put("/api/template", json={"text": edited, "mtime": payload["mtime"]})
    assert response.status_code == 200, response.text
    with open(template, encoding="utf-8", newline="") as handle:
        assert handle.read() == edited
    assert response.json()["mtime"] == os.path.getmtime(template)


def test_a_stale_template_mtime_is_a_409_and_the_file_is_untouched(client, template):
    """The template is checked in and hand-edited, so the app does not decide
    whose version wins here either."""
    response = client.put("/api/template", json={"text": "clobbered", "mtime": 1.0})
    assert response.status_code == 409
    assert response.json()["detail"]["mtime"] == os.path.getmtime(template)
    with open(template, encoding="utf-8", newline="") as handle:
        assert handle.read() == TEMPLATE_FILE


def test_a_missing_template_is_a_500_at_both_verbs(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "SPRINT_TEMPLATE", str(tmp_path / "gone.md"))
    assert client.get("/api/template").status_code == 500
    assert client.put("/api/template", json={"text": "x", "mtime": 0.0}).status_code == 500
    assert not (tmp_path / "gone.md").exists()


def test_editing_the_template_changes_what_the_next_sprint_copies(client, sprints, template):
    """The whole point of the route: a new file is a copy of whatever is in the
    template *now*, and no file already on disk is touched by the edit."""
    first = start_sprint(client, "2026-08-03")
    payload = read_template(client)
    client.put("/api/template", json={
        "text": TEMPLATE_FILE + "\n## 7. Anything else\n",
        "mtime": payload["mtime"],
    })

    start_sprint(client, "2026-08-17")
    assert "## 7. Anything else" in (sprints / "02.md").read_text(encoding="utf-8")
    # The sprint written before the edit still says what it said.
    assert "## 7. Anything else" not in (sprints / first["name"]).read_text(encoding="utf-8")


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


# --- block-addressed writes ---------------------------------------------------
#
# The same file, written one run of blocks at a time. Whole-file PUT is
# untouched above; this is the finer door, and its only two outcomes are the
# right block and a 409.

SPLICE_FILE = """# Sprint 1 · 2026-08-03 → 2026-08-17

## 1. Sprint Goal

- [ ] Token refresh on the auth API
"""


@pytest.fixture
def splice_file(sprints):
    """One sprint file on disk, in the disposable directory."""
    return write_sprint(sprints, "01.md", SPLICE_FILE)


def file_text(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def tick():
    return {
        "at": 2,
        "expect": ["- [ ] Token refresh on the auth API"],
        "blocks": [{"raw": "- [x] Token refresh on the auth API"}],
    }


def test_a_splice_writes_one_block_and_leaves_the_rest_of_the_file_alone(client, splice_file):
    response = client.patch("/api/sprints/1/blocks", json=tick())
    assert response.status_code == 200, response.text
    assert file_text(splice_file) == SPLICE_FILE.replace("- [ ]", "- [x]")


def test_the_reply_carries_the_new_mtime_the_index_and_the_whole_block_list(client, splice_file):
    payload = client.patch("/api/sprints/1/blocks", json=tick()).json()
    assert payload["mtime"] == os.path.getmtime(splice_file)
    assert payload["at"] == 2
    # The whole document, so the caller re-syncs without a second GET.
    assert [block["raw"] for block in payload["blocks"]] == [
        "# Sprint 1 · 2026-08-03 → 2026-08-17",
        "## 1. Sprint Goal",
        "- [x] Token refresh on the auth API",
    ]


def test_a_block_that_moved_is_still_written(client, splice_file):
    """Someone inserted a section above. The write lands on the same block."""
    client.patch("/api/sprints/1/blocks", json={
        "at": 1, "expect": [], "blocks": [{"raw": "## 0. Notes"}]})
    response = client.patch("/api/sprints/1/blocks", json=tick())
    assert response.status_code == 200, response.text
    # Asked for block 2, applied at 3.
    assert response.json()["at"] == 3
    assert "- [x] Token refresh on the auth API" in file_text(splice_file)
    assert "## 0. Notes" in file_text(splice_file)


def test_a_stale_expectation_is_a_409_carrying_the_file_as_it_stands(client, splice_file):
    response = client.patch("/api/sprints/1/blocks", json={
        "at": 2,
        "expect": ["- [ ] Something nobody wrote"],
        "blocks": [{"raw": "- [x] Something nobody wrote"}],
    })
    assert response.status_code == 409
    current = response.json()["detail"]["current"]
    assert current["text"] == SPLICE_FILE
    assert current["mtime"] == os.path.getmtime(splice_file)
    assert [block["raw"] for block in current["blocks"]][0].startswith("# Sprint 1")
    # Refused, so nothing was written.
    assert file_text(splice_file) == SPLICE_FILE


def test_two_identical_blocks_are_refused_rather_than_guessed_at(client, splice_file):
    with open(splice_file, "w", encoding="utf-8", newline="") as handle:
        handle.write("- \n\n## Middle\n\n- \n")
    response = client.patch("/api/sprints/1/blocks", json={
        "at": 1, "expect": ["- "], "blocks": [{"raw": "- typed"}]})
    assert response.status_code == 409
    assert "guess" in response.json()["detail"]["error"]


def test_an_insert_and_a_delete_are_the_same_operation(client, splice_file):
    added = client.patch("/api/sprints/1/blocks", json={
        "at": 3, "expect": [], "blocks": [{"raw": "## 2. What happened"}]})
    assert added.status_code == 200, added.text
    assert file_text(splice_file).endswith("## 2. What happened\n")

    removed = client.patch("/api/sprints/1/blocks", json={
        "at": 3, "expect": ["## 2. What happened"], "blocks": []})
    assert removed.status_code == 200, removed.text
    assert file_text(splice_file) == SPLICE_FILE


def test_a_splice_against_a_sprint_that_is_not_on_disk_is_a_404(client, sprints):
    sprints.mkdir(exist_ok=True)
    assert client.patch("/api/sprints/7/blocks", json=tick()).status_code == 404


def test_a_write_that_lands_mid_splice_is_re_read_and_both_survive(
    client, splice_file, monkeypatch
):
    """The retry, forced: somebody else's write lands between this one's read and
    its write. Ours is recomputed against the new text rather than clobbering it."""
    real_read = main.read_sprint_file
    reads = []

    def read_and_meddle(path):
        text = real_read(path)
        reads.append(path)
        if len(reads) == 1:
            main.write_sprint_file(path, text.replace("## 1. Sprint Goal", "## 1. Goal"))
        return text

    monkeypatch.setattr(main, "read_sprint_file", read_and_meddle)
    response = client.patch("/api/sprints/1/blocks", json=tick())
    assert response.status_code == 200, response.text

    text = file_text(splice_file)
    assert "## 1. Goal" in text  # the other write survived
    assert "- [x] Token refresh on the auth API" in text  # and so did this one


def test_a_file_that_keeps_moving_is_refused_rather_than_retried_forever(
    client, splice_file, monkeypatch
):
    """One retry. Contention becomes a visible refusal rather than a loop."""
    real_read = main.read_sprint_file
    version = [0]

    def read_and_meddle(path):
        text = real_read(path)
        version[0] += 1
        main.write_sprint_file(path, text + f"\n\nEdit {version[0]}\n")
        return text

    monkeypatch.setattr(main, "read_sprint_file", read_and_meddle)
    response = client.patch("/api/sprints/1/blocks", json=tick())

    assert response.status_code == 409
    assert "being written to" in response.json()["detail"]["error"]
    assert "- [x]" not in file_text(splice_file)


def test_the_template_takes_the_same_splice(client, template):
    response = client.patch("/api/template/blocks", json={
        "at": 2, "expect": ["**Sprint Goal:**"], "blocks": [{"raw": "**Goal:**"}]})
    assert response.status_code == 200, response.text
    assert file_text(template) == TEMPLATE_FILE.replace("**Sprint Goal:**", "**Goal:**")


def test_a_splice_leaves_the_whole_file_route_working(client, splice_file):
    """PUT still writes whole files, and still refuses a stale mtime, after a splice.

    Deliberately not asserting that the mtime the caller read *before* the splice
    is now stale: two writes inside one clock tick can share an mtime, which is a
    hole in that guard rather than in this one -- `apply_splice` compares the text.
    """
    assert client.patch("/api/sprints/1/blocks", json=tick()).status_code == 200
    assert client.put("/api/sprints/1", json={
        "text": "clobbered", "mtime": 1.0}).status_code == 409
    assert file_text(splice_file) == SPLICE_FILE.replace("- [ ]", "- [x]")

    fresh = client.get("/api/sprints/1").json()
    assert client.put("/api/sprints/1", json={
        "text": "# Sprint 1\n", "mtime": fresh["mtime"]}).status_code == 200
    assert file_text(splice_file) == "# Sprint 1\n"


# --- two writers on one row ---------------------------------------------------


def test_a_write_whose_expectation_is_current_goes_through(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    response = client.put(f"/api/phases/{phase['id']}", json={
        "effort_points": 55, "expect": {"effort_points": 40}})
    assert response.status_code == 200
    assert response.json()["effort_points"] == 55


def test_a_stale_expectation_is_refused_and_nothing_is_written(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)

    # Someone else saves first.
    assert client.put(f"/api/phases/{phase['id']}",
                      json={"effort_points": 55}).status_code == 200

    stale = client.put(f"/api/phases/{phase['id']}", json={
        "effort_points": 70, "expect": {"effort_points": 40}})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["fields"] == ["effort_points"]
    assert "Effort points changed" in detail["error"]
    # The refusal carries the row as it stands, and the write did not land.
    assert detail["current"]["effort_points"] == 55
    assert plan_of(client, project["id"])["phases"][0]["effort_points"] == 55


def test_two_people_editing_different_fields_of_one_row_both_land(client):
    """The reason this is per field and not per row: these do not collide."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)

    assert client.put(f"/api/phases/{phase['id']}", json={
        "name": "Discovery", "expect": {"name": "Design"}}).status_code == 200
    assert client.put(f"/api/phases/{phase['id']}", json={
        "effort_points": 55, "expect": {"effort_points": 40}}).status_code == 200

    saved = plan_of(client, project["id"])["phases"][0]
    assert (saved["name"], saved["effort_points"]) == ("Discovery", 55)


def test_the_whole_form_save_names_every_field_that_moved(client):
    """A project save sends seven fields, so it can overwrite six nobody touched."""
    project = make_project(client)
    client.put(f"/api/projects/{project['id']}", json={"track": "Platform"})
    client.put(f"/api/projects/{project['id']}", json={"tier": 2})

    stale = client.put(f"/api/projects/{project['id']}", json={
        "name": "Payments", "track": "AI Agent", "tier": 1,
        "expect": {"name": "Payments", "track": "", "tier": 0},
    })
    assert stale.status_code == 409
    assert stale.json()["detail"]["fields"] == ["tier", "track"]
    assert plan_of(client, project["id"])["project"]["track"] == "Platform"


def test_a_tick_and_a_date_compare_across_the_shapes_json_uses(client):
    """`done` is true on the wire and 1 in the column; weeks arrive 4 and 4.0."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    response = client.post(f"/api/phases/{phase['id']}/deliverables",
                           json={"name": "Wireframes", "done": True})
    deliverable = response.json()

    assert client.put(f"/api/deliverables/{deliverable['id']}", json={
        "name": "Wireframes v2", "expect": {"done": True}}).status_code == 200
    assert client.put(f"/api/phases/{phase['id']}", json={
        "start_date": "2026-02-02", "expect": {"duration_weeks": 4}}).status_code == 200


def test_a_write_that_states_no_expectation_is_not_guarded(client):
    """Reorder and the ticks send nothing, and last writer wins by design."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.put(f"/api/phases/{phase['id']}", json={"sort_order": 5})

    assert client.put(f"/api/phases/{phase['id']}",
                      json={"sort_order": 9}).status_code == 200
    assert plan_of(client, project["id"])["phases"][0]["sort_order"] == 9


def test_the_guard_covers_deliverables_and_checkpoints_too(client):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    deliverable = client.post(f"/api/phases/{phase['id']}/deliverables",
                              json={"name": "Wireframes"}).json()
    milestone = client.post(f"/api/projects/{project['id']}/milestones",
                            json={"name": "Design signed off"}).json()

    client.put(f"/api/deliverables/{deliverable['id']}", json={"name": "Mockups"})
    refused = client.put(f"/api/deliverables/{deliverable['id']}", json={
        "name": "Sketches", "expect": {"name": "Wireframes"}})
    assert refused.status_code == 409
    assert "deliverable" in refused.json()["detail"]["error"]

    client.put(f"/api/milestones/{milestone['id']}", json={"target_date": "2026-03-02"})
    refused = client.put(f"/api/milestones/{milestone['id']}", json={
        "target_date": "2026-04-06", "expect": {"target_date": ""}})
    assert refused.status_code == 409
    assert "checkpoint" in refused.json()["detail"]["error"]


def test_an_expectation_about_a_field_the_row_lacks_is_ignored(client):
    """A caller cannot be stale about something that was never stored."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    response = client.put(f"/api/phases/{phase['id']}", json={
        "name": "Discovery", "expect": {"name": "Design", "invented": "whatever"}})
    assert response.status_code == 200


# --- the connection ----------------------------------------------------------


def test_connect_opens_the_file_in_wal_with_a_busy_timeout(tmp_path):
    db.set_db_path(str(tmp_path / "pragmas.db"))
    try:
        db.init_db()
        with db.connect() as connection:
            assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            assert (connection.execute("PRAGMA busy_timeout").fetchone()[0]
                    == db.BUSY_TIMEOUT_MS)
            # WAL must not have cost the cascade guard the rebuild depends on.
            assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


def test_a_second_writer_waits_for_the_lock_rather_than_failing(tmp_path):
    """Without the busy timeout this is `database is locked` and a lost save."""
    db.set_db_path(str(tmp_path / "contended.db"))
    try:
        db.init_db()
        holder = db.connect()
        holder.execute("BEGIN IMMEDIATE")
        holder.execute("UPDATE settings SET sprint_length_days = 14 WHERE id = 1")

        outcome = {}

        def second_writer():
            connection = db.connect()
            try:
                connection.execute(
                    "UPDATE settings SET sprint_length_days = 21 WHERE id = 1")
                connection.commit()
                outcome["result"] = "committed"
            except sqlite3.OperationalError as error:
                outcome["result"] = str(error)
            finally:
                connection.close()

        thread = threading.Thread(target=second_writer)
        thread.start()
        time.sleep(0.3)  # well inside the timeout, so the wait has to succeed
        holder.commit()
        holder.close()
        thread.join(timeout=db.BUSY_TIMEOUT_MS / 1000 + 5)

        assert outcome["result"] == "committed"
        with db.connect() as connection:
            assert connection.execute(
                "SELECT sprint_length_days FROM settings WHERE id = 1"
            ).fetchone()[0] == 21
    finally:
        db.set_db_path(db.DEFAULT_DB_PATH)


# --- live invalidation --------------------------------------------------------

# A landed write is announced down every open socket so the other windows re-read
# themselves. The database is the record and the socket is a hint: nothing here
# may fail a write, which is what the last two tests in this section are for.


def wait_for_clients(count, timeout=2.0):
    """Wait for the registry to reach `count`. Registering happens on the loop."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(main.live_clients) == count:
            return True
        time.sleep(0.01)
    return len(main.live_clients) == count


def next_change(socket, timeout=2.0):
    """The next *write* announcement, stepping over presence traffic.

    A socket carries two conversations: what changed, and who is where. These
    tests are about the first, and a page's own `welcome` plus the presence roll
    that follows every connect and disconnect would otherwise arrive first.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        message = socket.receive_json()
        if message.get("type") == "changed":
            return message
    raise AssertionError("no write was announced")


def test_a_row_write_is_announced_to_every_open_page(client):
    project = make_project(client)
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        assert wait_for_clients(2)
        client.put(f"/api/projects/{project['id']}", json={"name": "Renamed"})
        for socket in (one, two):
            assert next_change(socket) == {"type": "changed", "scope": "roadmap"}


def test_a_read_announces_nothing(client):
    """The GET must not queue anything, so the next message is the write's."""
    project = make_project(client)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.get(f"/api/projects/{project['id']}")
        client.get("/api/portfolio")
        client.put(f"/api/projects/{project['id']}", json={"name": "Renamed"})
        assert next_change(socket)["scope"] == "roadmap"


def test_laying_out_a_project_announces_once_for_the_batch(client):
    project = make_project(client)
    make_phase(client, project["id"], "One", "", 2, 20)
    make_phase(client, project["id"], "Two", "", 2, 20)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.post(f"/api/projects/{project['id']}/layout")
        assert next_change(socket)["scope"] == "roadmap"
        # If the batch had announced per phase, this would be the second of two.
        client.delete(f"/api/projects/{project['id']}")
        assert next_change(socket)["scope"] == "roadmap"


def test_a_sprint_save_is_announced_with_the_new_mtime(client, sprints):
    """The mtime is what stops your own save reloading over your own typing."""
    write_sprint(sprints)
    payload = read_sprint(client)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        saved = client.put("/api/sprints/3",
                           json={"text": SPRINT_FILE + "\nmore\n",
                                 "mtime": payload["mtime"]})
        assert saved.status_code == 200, saved.text
        assert next_change(socket) == {
            "type": "changed", "scope": "sprint", "key": 3,
            "mtime": saved.json()["mtime"],
        }


def test_a_refused_sprint_save_announces_nothing(client, sprints):
    write_sprint(sprints)
    read_sprint(client)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        stale = client.put("/api/sprints/3", json={"text": "x", "mtime": 1.0})
        assert stale.status_code == 409
        # Nothing was written, so the next message is the one that follows it.
        client.put("/api/settings", json={"sprint_length_days": 14})
        assert next_change(socket)["scope"] == "roadmap"


def test_a_splice_is_announced_with_the_new_mtime(client, splice_file):
    """Step 3 rests entirely on this: the broadcast is how a remote splice
    reaches the other windows at all."""
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        spliced = client.patch("/api/sprints/1/blocks", json=tick())
        assert spliced.status_code == 200, spliced.text
        announced = next_change(socket)
        assert {key: announced[key] for key in ("type", "scope", "key", "mtime")} == {
            "type": "changed", "scope": "sprint", "key": 1,
            "mtime": spliced.json()["mtime"],
        }
        # What the write did rides along -- see the test below.
        assert announced["splice"]["at"] == 2


def test_the_announcement_carries_what_the_splice_did(client, splice_file):
    """The other pages repeat the write instead of re-reading the file, so the
    message has to say what it did -- rendered, and with what it replaced."""
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.patch("/api/sprints/1/blocks", json=tick())
        splice = next_change(socket)["splice"]

    assert splice["at"] == 2
    assert splice["expect"] == ["- [ ] Token refresh on the auth API"]
    # The run's **new** blocks, drawn: a page applying this needs no second call.
    assert [block["raw"] for block in splice["blocks"]] == [
        "- [x] Token refresh on the auth API"]
    assert "checkbox" in splice["blocks"][0]["html"]


def test_an_insert_announces_the_blocks_it_added_and_no_expectation(client, splice_file):
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.patch("/api/sprints/1/blocks", json={
            "at": 1, "expect": [], "blocks": [{"raw": "## 0. Notes"}]})
        splice = next_change(socket)["splice"]

    assert splice == {
        "at": 1, "expect": [],
        "blocks": [dict(splice["blocks"][0])],
    }
    assert splice["blocks"][0]["raw"] == "## 0. Notes"


def test_a_delete_announces_an_expectation_and_no_blocks(client, splice_file):
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.patch("/api/sprints/1/blocks", json={
            "at": 2, "expect": ["- [ ] Token refresh on the auth API"], "blocks": []})
        splice = next_change(socket)["splice"]

    assert splice["blocks"] == []
    assert splice["expect"] == ["- [ ] Token refresh on the auth API"]


def test_a_whole_file_save_announces_no_splice(client, splice_file):
    """It has none to name, so those pages re-read exactly as they always did."""
    payload = client.get("/api/sprints/1").json()
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        client.put("/api/sprints/1", json={"text": "# Sprint 1\n", "mtime": payload["mtime"]})
        assert "splice" not in next_change(socket)


def test_a_refused_splice_announces_nothing(client, splice_file):
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        refused = client.patch("/api/sprints/1/blocks", json={
            "at": 2, "expect": ["- [ ] Nobody wrote this"], "blocks": [{"raw": "x"}]})
        assert refused.status_code == 409
        # Nothing was written, so the next message is the one that follows it.
        client.put("/api/settings", json={"sprint_length_days": 14})
        assert next_change(socket)["scope"] == "roadmap"


def test_a_template_splice_announces_under_the_template_key(client, template):
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        spliced = client.patch("/api/template/blocks", json={
            "at": 2, "expect": ["**Sprint Goal:**"], "blocks": [{"raw": "**Goal:**"}]})
        assert spliced.status_code == 200, spliced.text
        assert next_change(socket)["key"] == "template"


def test_a_template_save_announces_under_the_template_key(client, template):
    payload = read_template(client)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        saved = client.put("/api/template",
                           json={"text": TEMPLATE_FILE, "mtime": payload["mtime"]})
        assert saved.status_code == 200, saved.text
        assert next_change(socket)["key"] == "template"


def test_pushing_a_tick_into_files_announces_each_one(client, sprints):
    project = make_project(client)
    phase = make_phase(client, project["id"], "Build", "2026-01-05", 2, 20)
    deliverable = client.post(f"/api/phases/{phase['id']}/deliverables",
                              json={"name": "Ship it"}).json()
    marker = f"- [ ] work [#D-{deliverable['id']}]\n"
    write_sprint(sprints, "03.md", SPRINT_FILE + marker)
    write_sprint(sprints, "04.md", SPRINT_FILE + marker)
    with client.websocket_connect("/ws") as socket:
        assert wait_for_clients(1)
        response = client.post("/api/sprints/marks",
                               json={"deliverable_id": deliverable["id"], "done": True})
        assert len(response.json()["files"]) == 2
        announced = [next_change(socket) for _ in range(2)]
        assert [one["key"] for one in announced] == [3, 4]
        assert all(one["scope"] == "sprint" for one in announced)


# --- the startup backup -------------------------------------------------------


def test_a_start_copies_the_dataset_aside_before_migrating(client, tmp_path):
    make_project(client, name="Worth keeping")
    main.db.init_db()

    backups = sorted((tmp_path / "backups").glob("roadmap-*.db"))
    assert len(backups) == 1
    kept = sqlite3.connect(backups[0])
    assert kept.execute("SELECT name FROM project").fetchone()[0] == "Worth keeping"
    kept.close()


def test_only_the_last_few_backups_are_kept(client, tmp_path):
    directory = tmp_path / "backups"
    directory.mkdir()
    for index in range(db.BACKUP_KEEP + 5):
        (directory / f"roadmap-2026010{index:02d}-000000.db").write_text("x")

    db.prune_backups(str(directory))
    assert len(list(directory.glob("roadmap-*.db"))) == db.BACKUP_KEEP


def test_a_backup_that_cannot_be_written_does_not_stop_the_app(client, tmp_path, monkeypatch):
    real_makedirs = db.os.makedirs

    def refuse_the_backup_directory(path, **kwargs):
        # Only the backup directory: `connect` makes the data directory through
        # this same call, and failing that would test something else.
        if str(path).endswith(db.BACKUP_DIR_NAME):
            raise OSError("read-only volume")
        return real_makedirs(path, **kwargs)

    monkeypatch.setattr(db.os, "makedirs", refuse_the_backup_directory)
    assert db.backup_before_migrate() is None
    # And the app still starts.
    db.init_db()
    assert client.get("/api/projects").status_code == 200


# --- presence -----------------------------------------------------------------

# Who is where, drawn as a badge on the cell they are in. A field belongs to the
# caret that reached it first and the other pages draw it read-only -- but that is
# a hold and not a lock, and the difference is what the second half of this
# section is about. No write consults it: the only refusal on a row is still the
# stale-expectation 409, which is about the data having moved rather than whose
# turn it is.


def next_presence(socket, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        message = socket.receive_json()
        if message.get("type") == "presence":
            return message["users"]
    raise AssertionError("no presence was announced")


def test_a_page_is_told_who_it_is_and_who_else_is_here(client):
    with client.websocket_connect("/ws") as one:
        welcome = one.receive_json()
        assert welcome["type"] == "welcome"
        # With the gate off there is no name to be had, and a typed one would be
        # the self-asserted label B1 rejected. So: honestly anonymous.
        assert welcome["name"].startswith("guest-")
        roll = next_presence(one)
        # `idle_ms` is a stopwatch and cannot be asserted exactly; it has its own
        # test below.
        assert [{key: user[key] for key in
                 ("id", "name", "view", "key", "field", "holding")} for user in roll] == [
            {"id": welcome["id"], "name": welcome["name"],
             "view": "", "key": None, "field": "", "holding": ""}]

        with client.websocket_connect("/ws") as two:
            two.receive_json()
            assert len(next_presence(one)) == 2
        # A close is an event: the badge goes when the tab does.
        assert len(next_presence(one)) == 1


def test_a_page_says_where_its_caret_is_and_everyone_is_told(client):
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        one.receive_json()
        two.receive_json()
        two.send_json({"type": "here", "view": "project", "key": 4,
                       "field": "phase:12:duration_weeks"})

        roll = next_presence(one)
        while len(roll) != 2 or not any(user["field"] for user in roll):
            roll = next_presence(one)
        held = [user for user in roll if user["field"]][0]
        assert held["field"] == "phase:12:duration_weeks"
        assert held["view"] == "project"
        assert held["key"] == 4


def test_presence_never_refuses_a_write(client):
    """B6: the badge informs. Two pages in one cell both write, and both land."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Build", "2026-01-05", 2, 20)
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.send_json({"type": "here", "view": "project", "key": project["id"],
                          "field": f"phase:{phase['id']}:duration_weeks"})
        time.sleep(0.05)
        # Somebody else writes the very cell that socket is sitting in.
        assert client.put(f"/api/phases/{phase['id']}",
                          json={"duration_weeks": 3}).status_code == 200


def test_the_name_comes_from_keycloak_once_the_gate_is_armed(client, realm):
    sign_in(client, realm, arm=True)
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["name"] == "qinghao"


# --- holds: the caret that got there first ------------------------------------

# **A hold is a caret, not a lease**, and that is what these tests are pinning
# down: it dies with the socket, it never takes a field off somebody who is
# typing, and it moves off anybody who has stopped for `HOLD_IDLE_SECONDS`. The
# write path knows none of it -- `test_presence_never_refuses_a_write` above is
# still true and is the one that says so.

GOAL_FIELD = "project:1:goal"
TRACK_FIELD = "project:1:track"


def here(field, view="project", key=1):
    return {"type": "here", "view": view, "key": key, "field": field}


def own_id(socket):
    """This page's own connection id, off the first message on the socket."""
    message = socket.receive_json()
    assert message["type"] == "welcome"
    return message["id"]


def wait_until(predicate, timeout=2.0):
    """Wait for the loop to catch up with a message just sent.

    Asserted against the registry rather than the socket on purpose: a *refused*
    take announces nothing, and a test that waited on a message for it would
    block until the suite gave up rather than fail.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def roll_until(socket, connection_id, wanted, timeout=2.0):
    """Read rolls until this connection's entry satisfies `wanted`."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        message = socket.receive_json()
        if message.get("type") != "presence":
            continue
        for user in message["users"]:
            if user["id"] == connection_id:
                last = user
                if wanted(user):
                    return user
    raise AssertionError(f"no roll matched; the last one said {last}")


def test_a_caret_holds_the_field_it_lands_in(client):
    """And the roll says so, which is what the other pages draw."""
    with client.websocket_connect("/ws") as socket:
        mine = own_id(socket)
        assert wait_for_clients(1)
        socket.send_json(here(GOAL_FIELD))
        entry = roll_until(socket, mine, lambda user: user["holding"] == GOAL_FIELD)
        assert entry["field"] == GOAL_FIELD
        assert entry["idle_ms"] < 2000


def test_a_second_caret_does_not_take_a_held_field(client):
    """Both carets are in the box; only the first one owns it."""
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        first, second = own_id(one), own_id(two)
        assert wait_for_clients(2)
        one.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[first].holding == GOAL_FIELD)

        two.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[second].place["field"] == GOAL_FIELD)
        assert main.live_clients[second].holding == ""
        assert main.live_clients[first].holding == GOAL_FIELD


def test_a_hold_is_given_up_when_the_caret_moves_on(client):
    with client.websocket_connect("/ws") as socket:
        mine = own_id(socket)
        assert wait_for_clients(1)
        socket.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[mine].holding == GOAL_FIELD)

        socket.send_json(here(TRACK_FIELD))
        assert wait_until(lambda: main.live_clients[mine].holding == TRACK_FIELD)
        assert main.field_holder(GOAL_FIELD) is None


def test_a_hold_dies_with_the_socket(client):
    """The reason this is not a lease: there is nothing left to expire."""
    with client.websocket_connect("/ws") as socket:
        mine = own_id(socket)
        assert wait_for_clients(1)
        socket.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[mine].holding == GOAL_FIELD)

    assert wait_for_clients(0)
    assert main.field_holder(GOAL_FIELD) is None


def test_a_fresh_hold_cannot_be_taken(client):
    """Somebody typing keeps their field, whatever the other page asks for."""
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        first, second = own_id(one), own_id(two)
        assert wait_for_clients(2)
        one.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[first].holding == GOAL_FIELD)

        two.send_json({"type": "take", "field": GOAL_FIELD})
        assert not wait_until(
            lambda: main.live_clients[second].holding == GOAL_FIELD, timeout=0.4)
        assert main.live_clients[first].holding == GOAL_FIELD


def test_an_idle_hold_can_be_taken(client):
    """The lunch break case: the field moves, and the holder loses it."""
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        first, second = own_id(one), own_id(two)
        assert wait_for_clients(2)
        one.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[first].holding == GOAL_FIELD)

        # Thirty seconds of nothing, without the test waiting thirty seconds.
        main.live_clients[first].active_at -= main.HOLD_IDLE_SECONDS + 1
        two.send_json({"type": "take", "field": GOAL_FIELD})
        assert wait_until(lambda: main.live_clients[second].holding == GOAL_FIELD)
        assert main.live_clients[first].holding == ""


def test_typing_puts_a_hold_back_out_of_reach(client):
    """`active` is a keystroke, and it is what the countdown is counting."""
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        first, second = own_id(one), own_id(two)
        assert wait_for_clients(2)
        one.send_json(here(GOAL_FIELD))
        assert wait_until(lambda: main.live_clients[first].holding == GOAL_FIELD)

        main.live_clients[first].active_at -= main.HOLD_IDLE_SECONDS + 1
        one.send_json({"type": "active"})
        assert wait_until(lambda: main.live_clients[first].idle_ms() < 1000)

        two.send_json({"type": "take", "field": GOAL_FIELD})
        assert not wait_until(
            lambda: main.live_clients[second].holding == GOAL_FIELD, timeout=0.4)


def test_a_page_that_talks_nonsense_is_ignored_rather_than_dropped(client):
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.send_text("not json at all")
        socket.send_json({"type": "something-else"})
        socket.send_json({"type": "here", "view": "map", "key": None, "field": ""})
        # Still connected, still answering.
        assert wait_for_clients(1)


def test_a_write_lands_with_nobody_listening(client):
    """The common case, and the one that must not need a socket at all."""
    assert not main.live_clients
    project = make_project(client)
    assert client.put(f"/api/projects/{project['id']}",
                      json={"name": "Renamed"}).status_code == 200


def test_a_closed_page_is_deregistered_and_does_not_fail_a_write(client):
    project = make_project(client)
    with client.websocket_connect("/ws"):
        assert wait_for_clients(1)
    assert wait_for_clients(0), "a closed socket kept its slot in the registry"
    assert client.put(f"/api/projects/{project['id']}",
                      json={"name": "Renamed"}).status_code == 200


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


def test_phases_and_milestones_are_created_on_one_sort_order_sequence(client):
    """One number line, so a new row of either kind lands last in the sequence.

    The project view draws the two interleaved, and where a checkpoint falls
    between two phases is what you arrange. Taking each table's own MAX would put
    a new phase and a new checkpoint on the same number.
    """
    project = make_project(client, start="")
    first = make_phase(client, project["id"], "Discovery", "", 2, 20)
    beta = client.post(f"/api/projects/{project['id']}/milestones",
                       json={"name": "Private beta"}).json()
    second = make_phase(client, project["id"], "Build", "", 4, 40)
    launch = client.post(f"/api/projects/{project['id']}/milestones",
                         json={"name": "Launch"}).json()

    assert [first["sort_order"], beta["sort_order"],
            second["sort_order"], launch["sort_order"]] == [0, 1, 2, 3]

    # And a second project counts from zero again: the sequence is per project.
    other = make_project(client, name="Ledger", start="")
    fresh = client.post(f"/api/projects/{other['id']}/milestones",
                        json={"name": "Books balance"}).json()
    assert fresh["sort_order"] == 0


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


def checkpoint(client, project, name="Ethics sign-off", target_date="",
               achieved=False):
    response = client.post(f"/api/projects/{project['id']}/milestones", json={
        "name": name, "target_date": target_date, "achieved": achieved,
    })
    assert response.status_code == 201
    return response.json()


def test_v8_reaches_the_project_view(client):
    """The bell is not the only place a late checkpoint is said out loud."""
    project = make_project(client, "Payments", start="2026-01-05")
    beta = checkpoint(client, project, target_date="2020-01-01")

    v8 = [w for w in plan_of(client, project["id"])["warnings"]
          if w["rule"] == "V8"]
    assert len(v8) == 1
    assert v8[0]["milestone_id"] == beta["id"]
    assert v8[0]["project_id"] == project["id"]
    # A checkpoint hangs off the project, so there is no phase to name.
    assert v8[0]["phase_id"] is None
    assert "2020-01-01" in v8[0]["message"]


def test_v8_is_silent_once_the_checkpoint_is_ticked(client):
    project = make_project(client, "Payments", start="2026-01-05")
    beta = checkpoint(client, project, target_date="2020-01-01")
    assert client.put(f"/api/milestones/{beta['id']}",
                      json={"achieved": True}).status_code == 200

    assert not [w for w in plan_of(client, project["id"])["warnings"]
                if w["rule"] == "V8"]


def test_v8_says_nothing_about_an_undated_checkpoint(client):
    """No date is not a late date. The project view is where that gets chased."""
    project = make_project(client, "Payments", start="2026-01-05")
    checkpoint(client, project)

    assert not [w for w in plan_of(client, project["id"])["warnings"]
                if w["rule"] == "V8"]


# --- what is past its date --------------------------------------------------


def test_late_gathers_both_rules_under_the_project_they_belong_to(client):
    project = make_project(client, "Payments", start="2020-01-01")
    make_phase(client, project["id"], "Design", "2020-01-01", 1, 10)
    beta = checkpoint(client, project, target_date="2020-03-02")

    payload = client.get("/api/late").json()
    assert payload["count"] == 2
    assert payload["as_of"] == date.today().isoformat()
    assert len(payload["groups"]) == 1

    group = payload["groups"][0]
    assert group["project_id"] == project["id"] and group["name"] == "Payments"
    assert group["derived_stage"] == "overdue"
    # Worst first, and both rules in one list.
    assert [item["rule"] for item in group["items"]] == ["V6", "V8"]
    assert group["items"][0]["days_late"] > group["items"][1]["days_late"]
    assert group["items"][1]["milestone_id"] == beta["id"]


def test_late_is_empty_when_nothing_has_slipped(client):
    project = make_project(client, "Payments", start="2099-01-05")
    make_phase(client, project["id"], "Design", "2099-01-05", 4, 40)
    checkpoint(client, project, target_date="2099-06-01")

    payload = client.get("/api/late").json()
    assert payload == {"groups": [], "count": 0,
                       "as_of": date.today().isoformat()}


def test_late_never_counts_an_idea(client):
    """An uncommitted idea has no date to be late against."""
    idea = make_direction(client, "Caching")
    client.post(f"/api/projects/{idea['id']}/milestones",
                json={"name": "Spike", "target_date": "2020-01-01"})

    assert client.get("/api/late").json()["count"] == 0


def test_late_falls_silent_when_the_work_closes(client):
    """It leaves because the plan changed -- there is nothing to dismiss."""
    project = make_project(client, "Payments", start="2020-01-01")
    beta = checkpoint(client, project, target_date="2020-03-02")
    assert client.get("/api/late").json()["count"] == 1

    client.put(f"/api/milestones/{beta['id']}", json={"achieved": True})
    assert client.get("/api/late").json()["count"] == 0


def test_the_milestone_tally_rides_on_the_project_list_and_the_portfolio(client):
    """What tells a delivered project from one closed by hand, off the map.

    Both read `done`; only "every checkpoint achieved" is work delivered. The
    tally was on `/api/graph` alone, so the sidebar dot and the top bar badge
    drew a cancelled project and a finished one exactly the same grey.
    """
    project = make_project(client, "Payments", start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    beta = checkpoint(client, project, target_date="2026-03-02")
    checkpoint(client, project, name="Launch", target_date="2026-04-01")

    listed = client.get("/api/projects").json()[0]
    assert (listed["milestones_reached"], listed["milestones_total"]) == (0, 2)

    client.put(f"/api/milestones/{beta['id']}", json={"achieved": True})
    listed = client.get("/api/projects").json()[0]
    assert (listed["milestones_reached"], listed["milestones_total"]) == (1, 2)

    lane = client.get("/api/portfolio").json()["projects"][0]
    assert (lane["milestones_reached"], lane["milestones_total"]) == (1, 2)


def test_the_map_and_the_project_list_agree_about_the_tally(client):
    """One helper feeds both, so the two surfaces cannot disagree."""
    project = make_project(client, "Payments", start="2026-01-05")
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    done = checkpoint(client, project, target_date="2026-03-02")
    client.put(f"/api/milestones/{done['id']}", json={"achieved": True})

    listed = client.get("/api/projects").json()[0]
    node = [n for n in client.get("/api/graph").json()["projects"]
            if n["id"] == project["id"]][0]
    assert (node["milestones_reached"], node["milestones_total"]) == (
        listed["milestones_reached"], listed["milestones_total"])


def test_rules_names_every_number_a_chip_can_carry(client):
    """V3 refuses a write and never reaches a chip; V5 is deleted."""
    rules = client.get("/api/rules").json()
    assert sorted(rules) == ["V1", "V2", "V4", "V6", "V7", "V8"]
    assert "checkpoint" in rules["V8"]


# --- deliverable links --------------------------------------------------------

# `[#D-42]` in a sprint file means deliverable 42, in a table row or on a list
# line. The reference is text in the file and the tick is the deliverable's, which
# is the whole design: there is nothing stored in between for these tests to
# check.
#
# `D-42` without the brackets is the older spelling and is still read, because
# every file written before the brackets says it. Nothing writes it any more.


def make_deliverable(client, phase_id, name):
    response = client.post(f"/api/phases/{phase_id}/deliverables", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def stage_sprint(sprints, number, text):
    """Put a sprint file on disk directly, the way you would in a text editor."""
    sprints.mkdir(parents=True, exist_ok=True)
    path = sprints / f"{number:02d}.md"
    path.write_text(text, encoding="utf-8")
    return path


def linked_plan(client):
    """A project with one phase and two deliverables, for a file to refer to."""
    project = make_project(client)
    phase = make_phase(client, project["id"], "Build", "2026-01-05", 2, 8)
    first = make_deliverable(client, phase["id"], "Auth API")
    second = make_deliverable(client, phase["id"], "Audit log")
    return project, phase, first, second


def test_a_reference_is_read_from_anywhere_in_the_row(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | PIC | Status | Remarks |\n"
        "| --- | --- | --- | --- |\n"
        f"| Auth API D-{first['id']} | @me | Development | |\n"
        f"| Something else | @you | Done | blocked on D-{second['id']} |\n"
    ))

    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"], second["id"]]
    # The label is the row's first non-empty cell, not the cell the reference is in.
    assert links[1]["label"] == "Something else"
    assert links[1]["name"] == "Audit log"


def test_a_link_carries_the_deliverables_tick_and_not_the_rows_status(client, sprints):
    _, _, first, _ = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | Done |\n"
    ))

    # The row says Done. The deliverable does not, and the deliverable is what the
    # link reports -- a five-state note in a cell is never read as a tick.
    assert client.get("/api/sprints/1/links").json()[0]["done"] is False

    client.put(f"/api/deliverables/{first['id']}", json={"done": True})
    assert client.get("/api/sprints/1/links").json()[0]["done"] is True


def test_ticking_through_a_link_never_writes_the_sprint_file(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | Testing |\n"
    )
    path = stage_sprint(sprints, 1, text)

    client.put(f"/api/deliverables/{first['id']}", json={"done": True})
    client.put(f"/api/deliverables/{first['id']}", json={"done": False})

    # Byte-for-byte: no Status rewritten, no table realigned, no value invented to
    # put back when the tick was cleared. Saving a deliverable is a roadmap write
    # and stays one; the file write lives on `/api/sprints/marks`, is asked for by
    # name, and reaches task markers only.
    assert path.read_text(encoding="utf-8") == text


def test_a_reference_to_nothing_is_reported_rather_than_dropped(client, sprints):
    linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        "| Long gone D-999 | Done |\n"
    ))

    link = client.get("/api/sprints/1/links").json()[0]
    assert link["deliverable_id"] == 999
    assert link["missing"] is True
    assert link["done"] is False


def test_one_deliverable_named_twice_is_one_link_counting_its_rows(client, sprints):
    _, _, first, _ = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | Development |\n\n"
        "| Carried over | Reason |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | ran out of time |\n"
    ))

    links = client.get("/api/sprints/1/links").json()
    assert len(links) == 1
    assert links[0]["rows"] == 2


def test_a_reference_outside_a_table_is_not_a_link(client, sprints):
    _, _, first, _ = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"We should finish D-{first['id']} this fortnight.\n"
    ))

    # Prose is prose. The reference belongs to a unit of planned work -- a row or a
    # line -- and a paragraph mentioning one is neither.
    assert client.get("/api/sprints/1/links").json() == []


def test_both_spellings_of_a_reference_are_read(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API [#D-{first['id']}] | Development |\n"
        f"| Audit log D-{second['id']} | Development |\n"
    ))

    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"], second["id"]]
    assert [one["missing"] for one in links] == [False, False]


def test_each_checkbox_line_in_a_cell_is_its_own_link(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | PIC |\n"
        "| --- | --- |\n"
        f"| ☐ Ship the auth API [#D-{first['id']}]<br>"
        f"- [ ] Write the audit log [#D-{second['id']}] | @me |\n"
    ))

    # A cell holding a checklist plans one thing per line, and the editor puts a
    # sync press on each of them -- so each line is its own link, not one link for
    # whichever reference happened to come first.
    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"], second["id"]]
    # And the label is that line, marker and reference out, rather than the row's
    # first cell repeated twice.
    assert [one["label"] for one in links] == ["Ship the auth API", "Write the audit log"]


def test_two_cells_of_one_row_naming_different_deliverables_are_two_links(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Remarks |\n"
        "| --- | --- |\n"
        f"| Auth API [#D-{first['id']}] | blocked on [#D-{second['id']}] |\n"
    ))

    # Every reference in the row is read, not only the first. The label of one that
    # sits on a line with no marker of its own is still the row's first cell --
    # there is nothing else on that line to call it.
    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"], second["id"]]
    row_label = f"Auth API [#D-{first['id']}]"
    assert [one["label"] for one in links] == [row_label, row_label]


def test_a_cell_line_carrying_two_references_links_only_the_first(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | PIC |\n"
        "| --- | --- |\n"
        f"| ☐ Both at once [#D-{first['id']}] [#D-{second['id']}] | @me |\n"
    ))

    # One link per line, first spelling wins -- the same rule a list line has, and
    # the reason the picker moves a line's reference rather than adding a second.
    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"]]


def test_a_reference_on_a_checkbox_line_is_a_link(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [ ] Ship the auth API [#D-{first['id']}]\n"
        "- [x] Write the migration note\n"
        f"- [ ] Audit log D-{second['id']}\n"
    ))

    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"], second["id"]]
    # The label is the line without its marker and without the reference: what you
    # would call the task if asked.
    assert links[0]["label"] == "Ship the auth API"
    assert links[0]["name"] == "Auth API"


def test_a_quoted_checkbox_line_is_a_link_too(client, sprints):
    _, _, first, _ = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"> - [ ] Carried over: ship the auth API [#D-{first['id']}]\n"
    ))

    # A quote is where a carried-over plan gets parked. The editor draws it as a
    # task line, so it is one here as well.
    assert client.get("/api/sprints/1/links").json()[0]["deliverable_id"] == first["id"]


def test_a_line_and_a_row_naming_one_deliverable_count_together(client, sprints):
    _, _, first, _ = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [ ] Ship the auth API [#D-{first['id']}]\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API [#D-{first['id']}] | Development |\n"
    ))

    links = client.get("/api/sprints/1/links").json()
    assert len(links) == 1
    assert links[0]["rows"] == 2


def test_a_line_carrying_two_references_links_only_the_first(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [ ] Both at once [#D-{first['id']}] [#D-{second['id']}]\n"
    ))

    # The same "first one wins" a row has, and the reason the picker moves a line's
    # reference rather than adding a second beside it.
    links = client.get("/api/sprints/1/links").json()
    assert [one["deliverable_id"] for one in links] == [first["id"]]


# --- the tick going the other way ---------------------------------------------

# A task line's box draws the deliverable's tick, so ticking the deliverable has to
# reach the marker in the file -- otherwise the file disagrees with the screen it
# is drawn on. This is the one place the app writes a document you did not type
# in, and every test below is about how narrow that write is.


def test_a_tick_reaches_the_task_lines_that_name_it(client, sprints):
    _, _, first, _ = linked_plan(client)
    one = stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [ ] Ship the auth API [#D-{first['id']}]\n"
        "- [ ] Something else\n"
    ))
    two = stage_sprint(sprints, 2, (
        "# Sprint 2 · 2026-01-19 → 2026-02-02\n\n"
        f"- [ ] Carried over: the auth API D-{first['id']}\n"
    ))

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    assert answer.status_code == 200
    assert [one["number"] for one in answer.json()["files"]] == [1, 2]

    # Both spellings, and only the line that names it.
    assert f"- [x] Ship the auth API [#D-{first['id']}]" in one.read_text(encoding="utf-8")
    assert "- [ ] Something else" in one.read_text(encoding="utf-8")
    assert f"- [x] Carried over" in two.read_text(encoding="utf-8")


def test_a_tick_reaches_a_checkbox_line_inside_a_cell(client, sprints):
    _, _, first, second = linked_plan(client)
    path = stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | PIC |\n"
        "| --- | --- |\n"
        f"| ☐ Ship the auth API [#D-{first['id']}]<br>"
        f"- [ ] Write the audit log [#D-{second['id']}] | @me |\n"
    ))

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    # A checkbox line in a cell draws the deliverable's tick like any other, so the
    # marker has to follow. The line beside it names something else and is left as
    # it was, in the spelling it was written in.
    assert [one["lines"] for one in answer.json()["files"]] == [1]
    written = path.read_text(encoding="utf-8")
    assert f"☑ Ship the auth API [#D-{first['id']}]" in written
    assert f"- [ ] Write the audit log [#D-{second['id']}]" in written


def test_a_tick_inside_a_cell_keeps_the_table_aligned(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task                        | PIC  |\n"
        "| --------------------------- | ---- |\n"
        f"| - [ ] Ship the API [#D-{first['id']}]   | @me  |\n"
    )
    path = stage_sprint(sprints, 1, text)

    client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    # `[ ]` and `[x]` are the same three characters, so the padding the user last
    # aligned still lines up: one character changed in the whole file.
    written = path.read_text(encoding="utf-8")
    assert written == text.replace("- [ ] Ship", "- [x] Ship")
    assert len(written) == len(text)


def test_clearing_a_tick_reaches_a_cell_too(client, sprints):
    _, _, first, _ = linked_plan(client)
    path = stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | PIC |\n"
        "| --- | --- |\n"
        f"| ☑ Ship the auth API [#D-{first['id']}] | @me |\n"
    ))
    client.put(f"/api/deliverables/{first['id']}", json={"done": True})

    client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": False,
    })
    assert f"☐ Ship the auth API" in path.read_text(encoding="utf-8")


def test_a_pipe_inside_a_fence_is_code_and_never_a_row(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "```\n"
        f"| ☐ Ship the auth API [#D-{first['id']}] | @me |\n"
        "```\n"
    )
    path = stage_sprint(sprints, 1, text)

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    # A fenced block is a document about a table, not a table. Nothing in it draws
    # a checkbox, so nothing in it is a marker to flip.
    assert answer.json()["files"] == []
    assert path.read_text(encoding="utf-8") == text


def test_a_tick_never_writes_a_table_row(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API [#D-{first['id']}] | Testing |\n"
    )
    path = stage_sprint(sprints, 1, text)

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    # Nothing to flip: a row has no marker, and its Status column is a note the app
    # does not get an opinion about.
    assert answer.json()["files"] == []
    assert path.read_text(encoding="utf-8") == text


def test_a_file_the_editor_is_holding_is_skipped(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [ ] Ship the auth API [#D-{first['id']}]\n"
    )
    path = stage_sprint(sprints, 1, text)

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True, "skip": [1],
    })
    # The editor's copy is newer than the disk's. Writing under it is how a
    # half-typed line goes missing, so the caller keeps that one to apply itself.
    assert answer.json()["files"] == []
    assert path.read_text(encoding="utf-8") == text


def test_a_line_already_in_that_state_is_left_alone(client, sprints):
    _, _, first, _ = linked_plan(client)
    text = (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        f"- [X] Ship the auth API [#D-{first['id']}]\n"
    )
    path = stage_sprint(sprints, 1, text)

    answer = client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": True,
    })
    # `[X]` already says done. Rewriting it to `[x]` would be the app tidying a
    # spelling it does not own, and would report a change nobody made.
    assert answer.json()["files"] == []
    assert path.read_text(encoding="utf-8") == text


def test_a_tick_keeps_every_other_character_of_the_line(client, sprints):
    _, _, first, _ = linked_plan(client)
    sprints.mkdir(parents=True, exist_ok=True)
    path = sprints / "01.md"
    # Bytes both ways: the line endings are the thing under test, and every
    # convenience that reads or writes text translates them.
    path.write_bytes((
        "# Sprint 1 · 2026-01-05 → 2026-01-19\r\n\r\n"
        f">   * [x]   Carried over: **the auth API** [#D-{first['id']}]\r\n"
    ).encode("utf-8"))

    client.post("/api/sprints/marks", json={
        "deliverable_id": first["id"], "done": False,
    })
    # Quote, indent, bullet, spacing, emphasis and the CRLF endings all survive:
    # the box is the only thing rewritten.
    assert path.read_bytes().endswith(
        f">   * [ ]   Carried over: **the auth API** [#D-{first['id']}]\r\n".encode("utf-8"))


def test_links_of_a_sprint_that_is_not_there_is_a_404(client, sprints):
    sprints.mkdir(parents=True, exist_ok=True)
    assert client.get("/api/sprints/7/links").status_code == 404


def test_the_reverse_index_names_every_file_a_deliverable_is_in(client, sprints):
    _, _, first, second = linked_plan(client)
    stage_sprint(sprints, 1, (
        "# Sprint 1 · 2026-01-05 → 2026-01-19\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | Development |\n"
    ))
    stage_sprint(sprints, 2, (
        "# Sprint 2 · 2026-01-19 → 2026-02-02\n\n"
        "| Task | Status |\n"
        "| --- | --- |\n"
        f"| Auth API D-{first['id']} | Done |\n"
        f"| Audit log D-{second['id']} | Not Started |\n"
    ))

    found = {one["deliverable_id"]: one["sprints"] for one
             in client.get("/api/sprints/links").json()}
    assert [one["number"] for one in found[first["id"]]] == [1, 2]
    assert [one["number"] for one in found[second["id"]]] == [2]
    # `links` is not a number, and the route above `/api/sprints/{number}` is the
    # one that answers -- the same ordering `split` and `table` rely on.
    assert client.get("/api/sprints/links").status_code == 200


def test_the_picker_offers_every_deliverable_in_the_roadmap(client):
    _, phase, first, second = linked_plan(client)
    other = make_project(client, name="Billing", start="2026-02-02")
    other_phase = make_phase(client, other["id"], "Build", "2026-02-02", 2, 8)
    third = make_deliverable(client, other_phase["id"], "Invoices")

    listed = client.get("/api/deliverables").json()
    assert [one["id"] for one in listed] == [first["id"], second["id"], third["id"]]
    # A fortnight is planned across projects, so the picker says which one each
    # deliverable belongs to.
    assert listed[2]["project_name"] == "Billing"
    assert listed[0]["phase_id"] == phase["id"]
    # And which phase, because the picker groups by project and a project with
    # thirty deliverables needs a second heading to stay readable.
    assert listed[0]["phase_name"] == "Build"


# --- the sign-in gate ---------------------------------------------------------

# A whole OIDC round trip, offline. `auth.http_client` is the one seam both
# provider calls go through, so a stub realm served by ASGI stands in for
# Keycloak -- no network, no VPN, nothing that fails when a realm is down.

STUB_ISSUER = "http://realm.test/realms/mastermind"


def jwt_of(claims):
    """A JWT whose payload is `claims`. The signature is junk on purpose.

    Nothing verifies it: the ID token arrives over the back channel, which is the
    case OIDC Core 3.1.3.7(6) lets TLS validation cover. A test that signed it
    would be testing a check the app deliberately does not make.
    """
    def segment(payload):
        raw = json.dumps(payload).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{segment({'alg': 'RS256'})}.{segment(claims)}.{'x' * 8}"


class StubRealm:
    """Keycloak's two endpoints, and a handle on what the next token will say."""

    def __init__(self):
        self.claims = {"sub": "abc-123", "preferred_username": "qinghao",
                       "email": "qinghao@example.com"}
        self.nonce = ""
        self.exchanges = 0

    def metadata(self):
        return {
            "issuer": STUB_ISSUER,
            "authorization_endpoint": f"{STUB_ISSUER}/protocol/openid-connect/auth",
            "token_endpoint": f"{STUB_ISSUER}/protocol/openid-connect/token",
            "end_session_endpoint": f"{STUB_ISSUER}/protocol/openid-connect/logout",
        }

    def id_token(self):
        claims = {
            "iss": STUB_ISSUER,
            "aud": "mastermind",
            "exp": int(time.time()) + 300,
            "nonce": self.nonce,
            **self.claims,
        }
        return jwt_of(claims)

    def handle(self, request):
        """Answer one request the way the realm would. Wired in as a transport."""
        path = request.url.path
        if path.endswith("/.well-known/openid-configuration"):
            return httpx.Response(200, json=self.metadata())
        if path.endswith("/token"):
            self.exchanges += 1
            return httpx.Response(200, json={"id_token": self.id_token(),
                                             "token_type": "Bearer"})
        return httpx.Response(404, json={"error": "not found"})


@pytest.fixture
def realm(client, monkeypatch):
    """A configured, reachable stub realm. The gate is not armed yet."""
    stub = StubRealm()
    monkeypatch.setattr(
        auth, "http_client",
        lambda timeout=None: httpx.Client(transport=httpx.MockTransport(stub.handle)),
    )
    monkeypatch.setenv(auth.ENV_CLIENT_SECRET, "shhh")
    monkeypatch.setenv(auth.ENV_SESSION_KEY, "test-signing-key")
    # The stub speaks http, which `check_transport` refuses without this. One
    # test below asserts that refusal.
    monkeypatch.setenv(auth.ENV_ALLOW_HTTP, "1")
    monkeypatch.delenv(auth.ENV_SSO, raising=False)
    monkeypatch.delenv(auth.ENV_PUBLIC, raising=False)

    response = client.put("/api/sso", json={
        "issuer": STUB_ISSUER,
        "client_id": "mastermind",
        "identity_claim": "preferred_username",
        "allowlist": "qinghao",
        "mode": "allowlist",
    })
    assert response.status_code == 200
    return stub


def start_sign_in(client, realm, arm=False, destination="/"):
    """Follow `/auth/login` far enough to hold the state the realm was given."""
    response = client.get(
        f"/auth/login?arm={1 if arm else 0}&next={destination}", follow_redirects=False
    )
    assert response.status_code == 303
    query = dict(parse_qsl(urlsplit(response.headers["location"]).query))
    realm.nonce = query["nonce"]
    return query


def sign_in(client, realm, arm=False, destination="/", state=None):
    query = start_sign_in(client, realm, arm=arm, destination=destination)
    return client.get(
        f"/auth/callback?code=abc&state={state or query['state']}", follow_redirects=False
    )


def refusal_of(response):
    """The message a refused sign-in carries back to the sign-in page."""
    assert response.status_code == 303
    location = response.headers["location"]
    assert location.startswith("/auth/signin")
    return dict(parse_qsl(urlsplit(location).query)).get("error", "")


def test_is_allowed_is_pure_and_answers_all_three_ways():
    claims = {"preferred_username": "Qinghao", "sub": "abc"}
    assert auth.is_allowed(claims, "allowlist", "qinghao, amir")
    # Case is a typo, not a different person.
    assert auth.is_allowed(claims, "allowlist", "QINGHAO")
    assert not auth.is_allowed(claims, "allowlist", "amir")
    assert auth.is_allowed(claims, "any", "")
    # No identity at all is never allowed, whatever the mode.
    assert not auth.is_allowed({"sub": "abc"}, "any", "")
    assert auth.parse_allowlist("a, b\nc,\n") == ["a", "b", "c"]


def test_a_sealed_cookie_survives_a_round_trip_and_not_a_tamper():
    payload = auth.new_session({"sub": "abc", "preferred_username": "qinghao"},
                               "preferred_username")
    sealed = auth.seal(payload, "key")
    assert auth.unseal(sealed, "key")["name"] == "qinghao"
    assert auth.unseal(sealed, "another key") is None
    body, _, signature = sealed.rpartition(".")
    assert auth.unseal(f"{body}x.{signature}", "key") is None
    stale = auth.seal({"name": "qinghao", "exp": time.time() - 1}, "key")
    assert auth.unseal(stale, "key") is None


def test_the_gate_is_off_until_a_real_sign_in_arms_it(client, realm):
    # Configuration alone changes nothing: the app is as open as it was.
    assert client.get("/api/projects").status_code == 200
    assert client.get("/api/sso").json()["armed"] is False

    response = sign_in(client, realm, arm=True)
    assert response.status_code == 303
    assert response.headers["location"] == "/"
    assert auth.SESSION_COOKIE in response.cookies

    status = client.get("/auth/status").json()
    assert status["armed"] is True
    assert status["name"] == "qinghao"
    # And the roadmap still answers, because the cookie is held.
    assert client.get("/api/projects").status_code == 200


def test_a_misconfiguration_cannot_arm_the_gate(client, realm):
    realm.claims["preferred_username"] = "someone-else"

    message = refusal_of(sign_in(client, realm, arm=True))
    # The refusal names what was seen and which claim was read: a bare 403 is
    # indistinguishable from a broken realm.
    assert "someone-else" in message
    assert "preferred_username" in message
    assert client.get("/api/sso").json()["armed"] is False


def test_an_armed_gate_refuses_a_stranger_and_answers_an_api_call_with_401(client, realm):
    sign_in(client, realm, arm=True)
    client.cookies.clear()

    assert client.get("/api/projects").status_code == 401
    page = client.get("/", follow_redirects=False)
    assert page.status_code == 303
    assert page.headers["location"] == "/auth/signin"
    # The gate's own page, its assets and the socket stay reachable.
    assert client.get("/auth/signin").status_code == 200
    assert client.get("/static/style.css").status_code == 200


def test_a_tampered_cookie_is_not_a_session(client, realm):
    sign_in(client, realm, arm=True)
    sealed = client.cookies[auth.SESSION_COOKIE]
    client.cookies.set(auth.SESSION_COOKIE, sealed[:-2] + "xy")
    assert client.get("/api/projects").status_code == 401


def test_the_wrong_state_or_nonce_is_refused(client, realm):
    assert "state" in refusal_of(sign_in(client, realm, state="not-the-state"))

    query = start_sign_in(client, realm)
    realm.nonce = "a different sign-in"
    response = client.get(f"/auth/callback?code=abc&state={query['state']}",
                          follow_redirects=False)
    assert "nonce" in refusal_of(response)


def test_an_expired_or_foreign_token_is_refused(client, realm):
    stale = {"iss": STUB_ISSUER, "aud": "mastermind", "exp": time.time() - 3600,
             "preferred_username": "qinghao"}
    with pytest.raises(auth.AuthError, match="expired"):
        auth.check_claims(stale, STUB_ISSUER, "mastermind", nonce="")

    other_realm = {**stale, "exp": time.time() + 60, "iss": "http://elsewhere"}
    with pytest.raises(auth.AuthError, match="issuer"):
        auth.check_claims(other_realm, STUB_ISSUER, "mastermind", nonce="")

    other_client = {**stale, "exp": time.time() + 60, "aud": "another-app"}
    with pytest.raises(auth.AuthError, match="issued for this client"):
        auth.check_claims(other_client, STUB_ISSUER, "mastermind", nonce="")


def test_sso_off_in_the_environment_opens_the_gate_again(client, realm, monkeypatch):
    sign_in(client, realm, arm=True)
    client.cookies.clear()
    assert client.get("/api/projects").status_code == 401

    monkeypatch.setenv(auth.ENV_SSO, "off")
    assert client.get("/api/projects").status_code == 200
    # The flag in the database is untouched -- this is a way in, not a way to
    # disarm by accident.
    assert client.get("/api/sso").json()["enabled"] is True
    assert client.get("/api/sso").json()["reason"] == f"{auth.ENV_SSO}=off"


def test_the_settings_surface_is_reachable_on_loopback_and_gated_when_public(
        client, realm, monkeypatch):
    sign_in(client, realm, arm=True)
    client.cookies.clear()
    # Loopback: whoever reaches the port can read the database file anyway, so
    # gating the page that repairs the gate buys nothing.
    assert client.get("/api/sso").status_code == 200

    monkeypatch.setenv(auth.ENV_PUBLIC, "1")
    assert client.get("/api/sso").status_code == 401


def test_signing_out_drops_the_cookie_and_visits_the_realm(client, realm):
    sign_in(client, realm, arm=True)
    response = client.get("/auth/logout", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"].startswith(
        f"{STUB_ISSUER}/protocol/openid-connect/logout")
    assert client.get("/api/projects", follow_redirects=False).status_code == 401


def test_a_plain_http_realm_is_refused_without_the_escape_hatch(client, realm, monkeypatch):
    monkeypatch.delenv(auth.ENV_ALLOW_HTTP, raising=False)
    result = client.post("/api/sso/test").json()
    assert result["ok"] is False
    assert auth.ENV_ALLOW_HTTP in result["detail"]


def test_the_connection_test_reports_the_realms_endpoints_and_never_a_secret(client, realm):
    result = client.post("/api/sso/test").json()
    assert result["ok"] is True
    assert result["token_endpoint"].endswith("/token")
    assert result["client_secret_set"] is True
    assert "shhh" not in json.dumps(result)


def test_the_config_route_never_hands_back_a_secret(client, realm):
    body = client.get("/api/sso").json()
    assert body["env"]["client_secret"] == {"name": auth.ENV_CLIENT_SECRET, "set": True}
    assert "shhh" not in json.dumps(body)


def test_the_page_cannot_arm_the_gate_by_writing_a_field(client, realm):
    client.put("/api/sso", json={"enabled": True, "sso_enabled": 1})
    assert client.get("/api/sso").json()["enabled"] is False
    assert client.put("/api/sso", json={"mode": "everyone"}).status_code == 400


def test_disarming_from_inside_turns_the_gate_off(client, realm):
    sign_in(client, realm, arm=True)
    assert client.post("/api/sso/disarm").json()["enabled"] is False
    client.cookies.clear()
    assert client.get("/api/projects").status_code == 200


def test_an_export_carries_no_sign_in_configuration(client, realm):
    settings = client.get("/api/export").json()["settings"]
    assert not [key for key in settings if key.startswith("sso_")]
    # And importing somebody's plan does not disarm the gate on this machine.
    sign_in(client, realm, arm=True)
    client.post("/api/import", json={"version": 10, "settings": {}, "projects": []})
    assert client.get("/api/sso").json()["enabled"] is True
