"""Traffic-density and green-time rules (report section 4.5).

Each density band has a vehicle-count range and a green-time range
(minimum-maximum seconds). Inside a band the green time scales with the exact
count: the band's lowest count gets the minimum, its highest count gets the
maximum, and counts in between are spread evenly (rounded to whole seconds).
When minimum = maximum the band gives one fixed time, which is how the report's
original 15 / 30 / 45 s rules are expressed (the defaults below).

The user can change all of this on the Simulation page; the active settings
are stored in MySQL (rule_config). The values are illustrative settings for an
academic prototype; they are NOT traffic-engineering standards.
"""

import math

MIN_COUNT = 0
MAX_COUNT = 50

GREEN_MIN = 5
GREEN_MAX = 120

LEVELS = ("Low", "Medium", "High")

DEFAULT_CONFIG = {
    "low_max": 10,
    "medium_max": 25,
    "low_green_min": 15,
    "low_green_max": 15,
    "medium_green_min": 30,
    "medium_green_max": 30,
    "high_green_min": 45,
    "high_green_max": 45,
}


def build_rules(config):
    """Turn a rule config into (lowest, highest, density, green_min, green_max) bands."""
    c = config
    return [
        (MIN_COUNT, c["low_max"], "Low", c["low_green_min"], c["low_green_max"]),
        (c["low_max"] + 1, c["medium_max"], "Medium", c["medium_green_min"], c["medium_green_max"]),
        (c["medium_max"] + 1, MAX_COUNT, "High", c["high_green_min"], c["high_green_max"]),
    ]


DEFAULT_RULES = build_rules(DEFAULT_CONFIG)


def green_for(vehicle_count, low, high, green_min, green_max):
    """Green time for a count inside the band low..high (linear, rounded half up)."""
    if high == low or green_min == green_max:
        return green_min
    fraction = (vehicle_count - low) / (high - low)
    return int(math.floor(green_min + fraction * (green_max - green_min) + 0.5))


def classify(vehicle_count, rules=DEFAULT_RULES):
    """Return (density_level, green_time_seconds) for a whole-number count.

    Deterministic (NFR3): the same count and rules always give the same result.
    Raises ValueError if the count is outside MIN_COUNT..MAX_COUNT.
    """
    if isinstance(vehicle_count, bool) or not isinstance(vehicle_count, int):
        raise ValueError("Vehicle count must be a whole number.")
    for low, high, density, green_min, green_max in rules:
        if low <= vehicle_count <= high:
            return density, green_for(vehicle_count, low, high, green_min, green_max)
    raise ValueError(f"Vehicle count must be between {MIN_COUNT} and {MAX_COUNT}.")


def green_label(green_min, green_max):
    """"15" for a fixed time, "35–60" for a range."""
    return str(green_min) if green_min == green_max else f"{green_min}–{green_max}"


def rules_as_dicts(rules=DEFAULT_RULES):
    return [
        {
            "min": low, "max": high, "density": density,
            "green_min": gmin, "green_max": gmax,
            "green_label": green_label(gmin, gmax),
            "green_time": gmin,  # kept for older callers: the band's starting time
        }
        for low, high, density, gmin, gmax in rules
    ]
