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


# --- criterion 3: V2 surfaces on both phases --------------------------------


def test_v2_warning_names_both_phases(client):
    project = make_project(client)
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    build = make_phase(client, project["id"], "Build", "2026-01-19", 4, 40)
    response = client.post("/api/dependencies", json={
        "predecessor_phase_id": design["id"], "successor_phase_id": build["id"],
    })
    assert response.status_code == 201

    warnings = plan_of(client, project["id"])["warnings"]
    v2 = [w for w in warnings if w["rule"] == "V2"]
    assert len(v2) == 1
    assert v2[0]["phase_id"] == build["id"]
    assert v2[0]["related_phase_id"] == design["id"]


def test_moving_a_phase_never_reschedules_its_dependents(client):
    """The timeline must never auto-move anything -- only warn."""
    project = make_project(client)
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    build = make_phase(client, project["id"], "Build", "2026-02-02", 4, 40)
    client.post("/api/dependencies", json={
        "predecessor_phase_id": design["id"], "successor_phase_id": build["id"],
    })

    client.put(f"/api/phases/{design['id']}", json={"duration_weeks": 12})

    phases = {p["id"]: p for p in plan_of(client, project["id"])["phases"]}
    assert phases[build["id"]]["start_date"] == "2026-02-02"
    warnings = plan_of(client, project["id"])["warnings"]
    assert any(w["rule"] == "V2" for w in warnings)


# --- criterion 4: cycles are blocked, not warned ----------------------------


def test_dependency_cycle_is_rejected_with_a_readable_message(client):
    project = make_project(client)
    first = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    second = make_phase(client, project["id"], "Build", "2026-02-02", 4, 40)
    client.post("/api/dependencies", json={
        "predecessor_phase_id": first["id"], "successor_phase_id": second["id"],
    })

    response = client.post("/api/dependencies", json={
        "predecessor_phase_id": second["id"], "successor_phase_id": first["id"],
    })
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "cycle" in detail.lower()
    assert "Design" in detail and "Build" in detail


def test_rejected_cycle_leaves_no_dependency_behind(client):
    project = make_project(client)
    first = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    second = make_phase(client, project["id"], "Build", "2026-02-02", 4, 40)
    client.post("/api/dependencies", json={
        "predecessor_phase_id": first["id"], "successor_phase_id": second["id"],
    })
    client.post("/api/dependencies", json={
        "predecessor_phase_id": second["id"], "successor_phase_id": first["id"],
    })
    assert len(plan_of(client, project["id"])["dependencies"]) == 1


# --- criterion 7: export / wipe / import round trip -------------------------


def test_export_then_import_restores_the_identical_dataset(client):
    project = make_project(client)
    design = make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    build = make_phase(client, project["id"], "Build", "2026-02-02", 6, 60)
    client.post("/api/dependencies", json={
        "predecessor_phase_id": design["id"], "successor_phase_id": build["id"],
    })
    make_project(client, "Search", "2026-03-01")

    exported = client.get("/api/export").json()

    for existing in client.get("/api/projects").json():
        client.delete(f"/api/projects/{existing['id']}")
    assert client.get("/api/projects").json() == []

    assert client.post("/api/import", json=exported).status_code == 200
    reimported = client.get("/api/export").json()

    assert reimported["projects"] == exported["projects"]
    assert reimported["phases"] == exported["phases"]
    assert reimported["dependencies"] == exported["dependencies"]


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


def test_deleting_a_project_removes_its_phases(client):
    project = make_project(client)
    make_phase(client, project["id"], "Design", "2026-01-05", 4, 40)
    client.delete(f"/api/projects/{project['id']}")
    assert client.get(f"/api/projects/{project['id']}").status_code == 404
    assert client.get("/api/export").json()["phases"] == []
