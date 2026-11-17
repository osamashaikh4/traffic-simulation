"""Editable density/green-time rules (stored in MySQL rule_config)."""

import pytest

from rules import DEFAULT_CONFIG, build_rules, classify

# Fixed times per band (min = max), as in the original rules.
CUSTOM = {"low_max": 5, "medium_max": 30,
          "low_green_min": 10, "low_green_max": 10,
          "medium_green_min": 40, "medium_green_max": 40,
          "high_green_min": 90, "high_green_max": 90}
# Green time scaling with the count inside each band.
SCALED = {"low_max": 10, "medium_max": 25,
          "low_green_min": 10, "low_green_max": 20,
          "medium_green_min": 20, "medium_green_max": 35,
          "high_green_min": 35, "high_green_max": 60}


def test_defaults_when_nothing_saved(client):
    data = client.get("/api/rules").get_json()
    assert data["config"] == DEFAULT_CONFIG
    assert [(r["min"], r["max"], r["density"], r["green_time"]) for r in data["rules"]] == [
        (0, 10, "Low", 15), (11, 25, "Medium", 30), (26, 50, "High", 45)]
    assert [r["green_label"] for r in data["rules"]] == ["15", "30", "45"]


def test_save_rules_and_use_them_for_new_simulations(client):
    res = client.put("/api/rules", json=CUSTOM)
    assert res.status_code == 200
    assert res.get_json()["config"] == CUSTOM
    # survives a fresh read
    assert client.get("/api/rules").get_json()["config"] == CUSTOM

    for count, density, green in [(5, "Low", 10), (6, "Medium", 40), (30, "Medium", 40), (31, "High", 90)]:
        rec = client.post("/api/simulations", json={"vehicle_count": count}).get_json()["record"]
        assert (rec["density_level"], rec["green_time_seconds"]) == (density, green), count


def test_old_records_keep_their_values_after_rules_change(client):
    before = client.post("/api/simulations", json={"vehicle_count": 20}).get_json()["record"]
    client.put("/api/rules", json=CUSTOM)
    saved = client.get("/api/simulations").get_json()["records"][0]
    assert saved["traffic_id"] == before["traffic_id"]
    assert (saved["density_level"], saved["green_time_seconds"]) == ("Medium", 30)


def test_reset_to_defaults(client):
    client.put("/api/rules", json=CUSTOM)
    res = client.delete("/api/rules")
    assert res.status_code == 200
    assert res.get_json()["config"] == DEFAULT_CONFIG
    rec = client.post("/api/simulations", json={"vehicle_count": 26}).get_json()["record"]
    assert (rec["density_level"], rec["green_time_seconds"]) == ("High", 45)


def test_home_page_shows_saved_rules(client):
    client.put("/api/rules", json=CUSTOM)
    html = client.get("/").get_data(as_text=True)
    assert "6–30" in html and "31–50" in html and "90 seconds" in html


def test_green_time_scales_with_count_inside_each_band(client):
    assert client.put("/api/rules", json=SCALED).status_code == 200
    expected = {
        0: ("Low", 10), 5: ("Low", 15), 10: ("Low", 20),
        11: ("Medium", 20), 18: ("Medium", 28), 25: ("Medium", 35),
        26: ("High", 35), 38: ("High", 48), 44: ("High", 54), 50: ("High", 60),
    }
    for count, want in expected.items():
        rec = client.post("/api/simulations", json={"vehicle_count": count}).get_json()["record"]
        assert (rec["density_level"], rec["green_time_seconds"]) == want, count
    # NFR3: the same count still always gives the same time
    times = {client.post("/api/simulations", json={"vehicle_count": 38}).get_json()["record"]["green_time_seconds"]
             for _ in range(3)}
    assert times == {48}


def test_scaled_rules_show_as_ranges(client):
    client.put("/api/rules", json=SCALED)
    labels = [r["green_label"] for r in client.get("/api/rules").get_json()["rules"]]
    assert labels == ["10–20", "20–35", "35–60"]
    assert "35–60 seconds" in client.get("/").get_data(as_text=True)


def test_scaled_green_never_leaves_its_range():
    rules = build_rules(SCALED)
    for low, high, _density, gmin, gmax in rules:
        times = [classify(n, rules)[1] for n in range(low, high + 1)]
        assert times[0] == gmin and times[-1] == gmax
        assert times == sorted(times)  # more vehicles never means less green


def test_legacy_single_green_values_still_accepted(client):
    legacy = {"low_max": 10, "medium_max": 25, "low_green": 12, "medium_green": 33, "high_green": 50}
    assert client.put("/api/rules", json=legacy).status_code == 200
    config = client.get("/api/rules").get_json()["config"]
    assert (config["low_green_min"], config["low_green_max"]) == (12, 12)
    assert (config["high_green_min"], config["high_green_max"]) == (50, 50)


def test_numbers_as_text_are_accepted(client):
    body = {k: str(v) for k, v in CUSTOM.items()}
    assert client.put("/api/rules", json=body).status_code == 200


INVALID = [
    ({**CUSTOM, "low_max": -1}, "Low upper limit must be between 0 and 48"),
    ({**CUSTOM, "low_max": 49}, "Low upper limit must be between 0 and 48"),
    ({**CUSTOM, "medium_max": 5}, "Medium upper limit must be between 6 and 49"),   # not above Low
    ({**CUSTOM, "medium_max": 50}, "Medium upper limit must be between 6 and 49"),  # leaves High empty
    ({**CUSTOM, "low_green_min": 4}, "Low minimum green time must be between 5 and 120"),
    ({**CUSTOM, "high_green_max": 121}, "High maximum green time must be between 5 and 120"),
    ({**CUSTOM, "medium_green_min": 30.5}, "whole number"),
    ({**CUSTOM, "medium_green_max": "abc"}, "must be a number"),
    ({**SCALED, "high_green_max": 30}, "High maximum green time must be at least the minimum (35 seconds)"),
    ({k: v for k, v in CUSTOM.items() if k != "high_green_max"}, "Please enter the high maximum green time"),
]


@pytest.mark.parametrize("body,message", INVALID)
def test_invalid_rules_rejected_and_not_saved(client, body, message):
    res = client.put("/api/rules", json=body)
    assert res.status_code == 400
    assert message in res.get_json()["error"]
    assert client.get("/api/rules").get_json()["config"] == DEFAULT_CONFIG


def test_non_json_rules_rejected(client):
    assert client.put("/api/rules", data="x").status_code == 400


def test_custom_bands_cover_every_count_exactly_once():
    rules = build_rules(CUSTOM)
    for n in range(0, 51):
        matches = [r for r in rules if r[0] <= n <= r[1]]
        assert len(matches) == 1, n
    assert classify(5, rules) == ("Low", 10) and classify(50, rules) == ("High", 90)


def test_old_database_layout_is_upgraded(app):
    """A rule_config table from before green ranges (low_green, ...) is migrated
    by init-db, keeping the saved values as fixed times."""
    import db
    with app.app_context():
        with db.get_db().cursor() as cur:
            cur.execute("DROP TABLE rule_config")
            cur.execute(
                "CREATE TABLE rule_config (id TINYINT PRIMARY KEY, low_max INT NOT NULL, medium_max INT NOT NULL, "
                "low_green INT NOT NULL, medium_green INT NOT NULL, high_green INT NOT NULL, "
                "updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            cur.execute("INSERT INTO rule_config (id, low_max, medium_max, low_green, medium_green, high_green) "
                        "VALUES (1, 8, 20, 12, 25, 40)")
        db.close_db()
    db.init_db(app.config)
    with app.app_context():
        config = db.get_rule_config()
        db.close_db()
    assert config == {"low_max": 8, "medium_max": 20, "low_green_min": 12, "low_green_max": 12,
                      "medium_green_min": 25, "medium_green_max": 25,
                      "high_green_min": 40, "high_green_max": 40}
