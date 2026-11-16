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
    assert "Run Simulation" in html


# --- Dashboard pages: Home, Reports, Analytics ----------------------------

def _run(client, *counts):
    for n in counts:
        client.post("/api/simulations", json={"vehicle_count": n})


def test_analytics_shown_by_default(client):
    assert 'href="/analytics"' in client.get("/").get_data(as_text=True)
    assert client.get("/analytics").status_code == 200


def test_analytics_can_be_hidden(client, app):
    app.config["SHOW_ANALYTICS"] = False
    html = client.get("/").get_data(as_text=True)
    assert 'href="/analytics"' not in html
    assert client.get("/analytics").status_code == 404
    assert client.get("/api/analytics").status_code == 404


def test_sidebar_links_on_every_page(client, app):
    app.config["SHOW_ANALYTICS"] = True
    for path in ("/", "/dashboard", "/reports", "/analytics", "/about"):
        html = client.get(path).get_data(as_text=True)
        for link in ('href="/"', 'href="/dashboard"', 'href="/reports"', 'href="/analytics"', 'href="/about"'):
            assert link in html, f"{link} missing on {path}"
        assert 'aria-current="page"' in html


def test_home_recent_results_limited_to_three(client):
    _run(client, 1, 12, 30, 45, 8)
    records = client.get("/api/simulations?limit=3").get_json()["records"]
    assert [r["vehicle_count"] for r in records] == [8, 45, 30]


def test_reports_lists_all_runs_and_filters_by_density(client):
    _run(client, 3, 14, 27, 49)
    html = client.get("/reports").get_data(as_text=True)
    assert "Showing 1–4 of 4" in html
    high = client.get("/reports?density=High").get_data(as_text=True)
    assert "Showing 1–2 of 2" in high
    assert client.get("/reports?density=Bogus").status_code == 400


def test_reports_pagination(client):
    _run(client, *range(0, 30))
    page1 = client.get("/reports").get_data(as_text=True)
    assert "Showing 1–20 of 30" in page1  # default 20 rows per page
    page2 = client.get("/reports?page=2").get_data(as_text=True)
    assert "Showing 21–30 of 30" in page2
    # out-of-range page numbers are clamped
    assert "Showing 21–30 of 30" in client.get("/reports?page=99").get_data(as_text=True)


def test_reports_rows_per_page(client):
    _run(client, *range(0, 30))
    assert "Showing 1–10 of 30" in client.get("/reports?per_page=10").get_data(as_text=True)
    html = client.get("/reports?per_page=10&page=3").get_data(as_text=True)
    assert "Showing 21–30 of 30" in html
    assert "per_page=10" in html  # page links keep the chosen size
    assert "Showing 1–30 of 30" in client.get("/reports?per_page=50").get_data(as_text=True)
    # unsupported sizes fall back to the default of 20
    assert "Showing 1–20 of 30" in client.get("/reports?per_page=7").get_data(as_text=True)


def test_reports_empty_state(client):
    assert "No simulations saved yet" in client.get("/reports").get_data(as_text=True)


def test_analytics_api(client, app):
    app.config["SHOW_ANALYTICS"] = True
    _run(client, 4, 10, 11, 30, 50)
    data = client.get("/api/analytics").get_json()
    assert data["summary"] == {"total_runs": 5, "avg_count": 21.0, "min_count": 4,
                               "max_count": 50, "avg_green": 30.0}
    assert data["totals"] == {"Low": 2, "Medium": 1, "High": 2}
    assert [r["vehicle_count"] for r in data["recent"]] == [4, 10, 11, 30, 50]  # oldest first
    buckets = {b["label"]: b for b in data["distribution"]}
    assert buckets["0–5"]["runs"] == 1 and buckets["6–10"]["runs"] == 1
    assert buckets["11–15"]["runs"] == 1 and buckets["11–15"]["density"] == "Medium"
    assert buckets["46–50"]["runs"] == 1 and buckets["46–50"]["density"] == "High"
    assert sum(b["runs"] for b in data["distribution"]) == 5


def test_analytics_api_empty(client, app):
    app.config["SHOW_ANALYTICS"] = True
    data = client.get("/api/analytics").get_json()
    assert data["summary"]["total_runs"] == 0
    assert data["summary"]["avg_count"] is None


def test_reports_export_csv(client):
    _run(client, 3, 14, 27)
    client.post("/api/simulations", json={"vehicle_count": 40, "scenario_label": "=HYPERLINK(1)"})
    res = client.get("/reports/export.csv")
    assert res.status_code == 200
    assert res.mimetype == "text/csv"
    assert "attachment" in res.headers["Content-Disposition"]
    lines = res.get_data(as_text=True).lstrip("\ufeff").splitlines()
    assert lines[0] == "ID,Scenario,Vehicle count,Density,Green time (s),Saved at"
    assert len(lines) == 5
    assert ",'=HYPERLINK(1),40,High,45," in lines[1]  # newest first, formula neutralised


def test_reports_export_csv_respects_filter(client):
    _run(client, 3, 14, 27, 49)
    res = client.get("/reports/export.csv?density=High")
    assert "-high.csv" in res.headers["Content-Disposition"]
    rows = res.get_data(as_text=True).splitlines()[1:]
    assert len(rows) == 2 and all(",High," in r for r in rows)
    assert client.get("/reports/export.csv?density=Bogus").status_code == 400


def test_reports_export_csv_empty(client):
    lines = client.get("/reports/export.csv").get_data(as_text=True).splitlines()
    assert len(lines) == 1  # header only


def test_get_single_simulation_for_replay(client):
    rec = client.post("/api/simulations", json={"vehicle_count": 33, "scenario_label": "Demo"}).get_json()["record"]
    res = client.get(f"/api/simulations/{rec['traffic_id']}")
    assert res.status_code == 200
    assert res.get_json()["record"] == rec
    assert client.get("/api/simulations/999999").status_code == 404


def test_reports_rows_link_to_replay(client):
    rec = client.post("/api/simulations", json={"vehicle_count": 12}).get_json()["record"]
    html = client.get("/reports").get_data(as_text=True)
    assert f'href="/?replay={rec["traffic_id"]}"' in html


def test_dashboard_and_about_pages(client, app):
    client.put("/api/rules", json={"low_max": 5, "medium_max": 30, "low_green": 10, "medium_green": 40, "high_green": 90})
    dash = client.get("/dashboard")
    assert dash.status_code == 200 and "Last 20 runs" in dash.get_data(as_text=True)
    about = client.get("/about").get_data(as_text=True)
    assert "31–50 vehicles" in about and "90 seconds" in about  # shows the live rules
