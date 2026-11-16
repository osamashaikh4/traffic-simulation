"""Editable density/green-time rules (stored in MySQL rule_config)."""

import pytest

from rules import DEFAULT_CONFIG, build_rules, classify

CUSTOM = {"low_max": 5, "medium_max": 30, "low_green": 10, "medium_green": 40, "high_green": 90}


def test_defaults_when_nothing_saved(client):
    data = client.get("/api/rules").get_json()
    assert data["config"] == DEFAULT_CONFIG
    assert [(r["min"], r["max"], r["density"], r["green_time"]) for r in data["rules"]] == [
        (0, 10, "Low", 15), (11, 25, "Medium", 30), (26, 50, "High", 45)]


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
    assert "6–30" in html and "31–50" in html and "90 s" in html


def test_numbers_as_text_are_accepted(client):
    body = {k: str(v) for k, v in CUSTOM.items()}
    assert client.put("/api/rules", json=body).status_code == 200


INVALID = [
    ({**CUSTOM, "low_max": -1}, "Low upper limit must be between 0 and 48"),
    ({**CUSTOM, "low_max": 49}, "Low upper limit must be between 0 and 48"),
    ({**CUSTOM, "medium_max": 5}, "Medium upper limit must be between 6 and 49"),   # not above Low
    ({**CUSTOM, "medium_max": 50}, "Medium upper limit must be between 6 and 49"),  # leaves High empty
    ({**CUSTOM, "low_green": 4}, "Low green time must be between 5 and 120"),
    ({**CUSTOM, "high_green": 121}, "High green time must be between 5 and 120"),
    ({**CUSTOM, "medium_green": 30.5}, "whole number"),
    ({**CUSTOM, "medium_green": "abc"}, "must be a number"),
    ({k: v for k, v in CUSTOM.items() if k != "high_green"}, "Please enter the high green time"),
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
