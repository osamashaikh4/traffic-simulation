"""Traffic-density and green-time rules (report section 4.5).

The default thresholds and durations live here; the user can change them on
the dashboard, and the active settings are stored in MySQL (rule_config).
The values are illustrative settings for an academic prototype; they are NOT
traffic-engineering standards.
"""

MIN_COUNT = 0
MAX_COUNT = 50

GREEN_MIN = 5
GREEN_MAX = 120

DEFAULT_CONFIG = {
    "low_max": 10,
    "medium_max": 25,
    "low_green": 15,
    "medium_green": 30,
    "high_green": 45,
}


def build_rules(config):
    """Turn a rule config into (lowest, highest, density, green_time) bands."""
    return [
        (MIN_COUNT, config["low_max"], "Low", config["low_green"]),
        (config["low_max"] + 1, config["medium_max"], "Medium", config["medium_green"]),
        (config["medium_max"] + 1, MAX_COUNT, "High", config["high_green"]),
    ]


DEFAULT_RULES = build_rules(DEFAULT_CONFIG)


def classify(vehicle_count, rules=DEFAULT_RULES):
    """Return (density_level, green_time_seconds) for a whole-number count.

    Deterministic (NFR3): the same count and rules always give the same result.
    Raises ValueError if the count is outside MIN_COUNT..MAX_COUNT.
    """
    if isinstance(vehicle_count, bool) or not isinstance(vehicle_count, int):
        raise ValueError("Vehicle count must be a whole number.")
    for low, high, density, green_time in rules:
        if low <= vehicle_count <= high:
            return density, green_time
    raise ValueError(f"Vehicle count must be between {MIN_COUNT} and {MAX_COUNT}.")


def rules_as_dicts(rules=DEFAULT_RULES):
    return [
        {"min": low, "max": high, "density": density, "green_time": green_time}
        for low, high, density, green_time in rules
    ]
