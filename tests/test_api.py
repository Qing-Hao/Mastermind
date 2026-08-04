"""End-to-end API tests mapped to the acceptance criteria in PROMPT.md."""

import pytest
from fastapi.testclient import TestClient

from app import db
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
        "projects": [], "phases": [], "unscheduled_count": 0,
        "dependencies": [], "warnings": [],
    }


def test_deleting_a_project_removes_its_phases(client):
    project = make_project(client)
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.delete(f"/api/projects/{project['id']}")
    assert client.get(f"/api/projects/{project['id']}").status_code == 404
    assert client.get("/api/export").json()["phases"] == []


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
    assert exported["version"] == 6

    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.post("/api/import", json=exported).status_code == 200

    reimported = client.get("/api/export").json()
    assert reimported["projects"] == exported["projects"]
    assert reimported["settings"]["department_name"] == "Platform Engineering"


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
    assert exported["version"] == 6
    # Even under a phase marked done -- the tick is the user's to set, and a
    # phase status is not evidence about any particular deliverable.
    assert exported["deliverables"][0]["done"] == 0


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
