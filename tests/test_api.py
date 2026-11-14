"""Report sections 5.3 (validation, TC10-TC13) and 5.4 (database and history)."""

import pytest

from tests.test_rules import FUNCTIONAL_CASES


# --- 5.2 through the full stack -------------------------------------------

@pytest.mark.parametrize("test_id,count,density,green", FUNCTIONAL_CASES, ids=[c[0] for c in FUNCTIONAL_CASES])
def test_simulation_endpoint(client, test_id, count, density, green):
    res = client.post("/api/simulations", json={"vehicle_count": count})
    assert res.status_code == 201
    rec = res.get_json()["record"]
    assert rec["vehicle_count"] == count
    assert rec["density_level"] == density
    assert rec["green_time_seconds"] == green


# --- 5.3 Validation test cases --------------------------------------------

VALIDATION_CASES = [
    ("TC10-blank", "", "enter a vehicle count"),
    ("TC10-missing", None, "enter a vehicle count"),
    ("TC11-negative", -1, "between 0 and 50"),
    ("TC11-negative-text", "-5", "between 0 and 50"),
    ("TC12-over-50", 51, "between 0 and 50"),
    ("TC12-over-50-text", "100", "between 0 and 50"),
    ("TC13-decimal", 10.5, "whole number"),
    ("TC13-decimal-text", "25.5", "whole number"),
    ("not-a-number", "abc", "must be a number"),
]


@pytest.mark.parametrize("test_id,value,message", VALIDATION_CASES, ids=[c[0] for c in VALIDATION_CASES])
def test_invalid_values_are_rejected_and_not_saved(client, row_count, test_id, value, message):
    res = client.post("/api/simulations", json={"vehicle_count": value})
    assert res.status_code == 400
    assert message in res.get_json()["error"]
    assert row_count() == 0


def test_non_json_body_rejected(client, row_count):
    res = client.post("/api/simulations", data="vehicle_count=10")
    assert res.status_code == 400
    assert row_count() == 0


def test_scenario_label_too_long_rejected(client, row_count):
    res = client.post("/api/simulations", json={"vehicle_count": 10, "scenario_label": "x" * 51})
    assert res.status_code == 400
    assert row_count() == 0


# --- 5.4 Database and history testing -------------------------------------

def test_one_simulation_creates_exactly_one_record(client, row_count):
    client.post("/api/simulations", json={"vehicle_count": 40})
    assert row_count() == 1


def test_saved_record_matches_dashboard_result_and_has_timestamp(client):
    posted = client.post(
        "/api/simulations", json={"vehicle_count": 40, "scenario_label": "Test Run 1"}
    ).get_json()["record"]
    saved = client.get("/api/simulations").get_json()["records"][0]
    assert saved == posted
    assert saved["scenario_label"] == "Test Run 1"
    assert saved["density_level"] == "High" and saved["green_time_seconds"] == 45
    assert saved["created_at"]


def test_history_is_newest_first(client):
    ids = [
        client.post("/api/simulations", json={"vehicle_count": n}).get_json()["record"]["traffic_id"]
        for n in (5, 20, 40)
    ]
    listed = [r["traffic_id"] for r in client.get("/api/simulations").get_json()["records"]]
    assert listed == list(reversed(ids))


def test_chart_totals_update_with_new_simulation(client):
    before = client.get("/api/simulations").get_json()["totals"]
    assert before == {"Low": 0, "Medium": 0, "High": 0}
    client.post("/api/simulations", json={"vehicle_count": 11})
    client.post("/api/simulations", json={"vehicle_count": 26})
    client.post("/api/simulations", json={"vehicle_count": 50})
    after = client.get("/api/simulations").get_json()["totals"]
    assert after == {"Low": 0, "Medium": 1, "High": 2}


def test_clear_history(client, row_count):
    client.post("/api/simulations", json={"vehicle_count": 5})
    assert client.delete("/api/simulations").status_code == 204
    assert row_count() == 0


def test_dashboard_page_renders(client):
    html = client.get("/").get_data(as_text=True)
    assert "Simulate Traffic" in html
