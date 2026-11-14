"""Traffic-density and green-time rules (report section 4.5).

All thresholds and durations live in this one file so they are easy to change
(NFR4 - Maintainability). The values are illustrative settings for an academic
prototype; they are NOT traffic-engineering standards.
"""

MIN_COUNT = 0
MAX_COUNT = 50

# (lowest count, highest count, density label, recommended green time in seconds)
DENSITY_RULES = [
    (0, 10, "Low", 15),
    (11, 25, "Medium", 30),
    (26, 50, "High", 45),
]


def classify(vehicle_count):
    """Return (density_level, green_time_seconds) for a whole-number count.

    Deterministic (NFR3): the same count always gives the same result.
    Raises ValueError if the count is outside MIN_COUNT..MAX_COUNT.
    """
    if isinstance(vehicle_count, bool) or not isinstance(vehicle_count, int):
        raise ValueError("Vehicle count must be a whole number.")
    for low, high, density, green_time in DENSITY_RULES:
        if low <= vehicle_count <= high:
            return density, green_time
    raise ValueError(f"Vehicle count must be between {MIN_COUNT} and {MAX_COUNT}.")


def rules_as_dicts():
    return [
        {"min": low, "max": high, "density": density, "green_time": green_time}
        for low, high, density, green_time in DENSITY_RULES
    ]
