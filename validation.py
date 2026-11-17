"""Input validation for vehicle counts, scenario labels and rule settings."""

import re

from rules import GREEN_MAX, GREEN_MIN, MAX_COUNT, MIN_COUNT

SCENARIO_LABEL_MAX = 50
WHOLE_NUMBER = re.compile(r"[+-]?\d+")


class ValidationError(ValueError):
    pass


def _whole_number(raw, label, blank_message):
    """Parse an int from JSON/form input. Decimals are rejected, not rounded."""
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        raise ValidationError(blank_message)
    if isinstance(raw, bool):
        raise ValidationError(f"{label} must be a whole number.")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        if not raw.is_integer():
            raise ValidationError(f"{label} must be a whole number (decimals are not allowed).")
        return int(raw)
    if isinstance(raw, str):
        text = raw.strip()
        if WHOLE_NUMBER.fullmatch(text):
            return int(text)
        try:
            float(text)
        except ValueError:
            raise ValidationError(f"{label} must be a number.")
        raise ValidationError(f"{label} must be a whole number (decimals are not allowed).")
    raise ValidationError(f"{label} must be a number.")


def parse_vehicle_count(raw):
    value = _whole_number(raw, "Vehicle count", "Please enter a vehicle count.")
    if value < MIN_COUNT or value > MAX_COUNT:
        raise ValidationError(f"Vehicle count must be between {MIN_COUNT} and {MAX_COUNT}.")
    return value


def parse_scenario_label(raw):
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError("Scenario label must be text.")
    label = raw.strip()
    if not label:
        return None
    if len(label) > SCENARIO_LABEL_MAX:
        raise ValidationError(f"Scenario label must be {SCENARIO_LABEL_MAX} characters or fewer.")
    return label


def _ranged(data, key, label, low, high):
    value = _whole_number(data.get(key), label, f"Please enter the {label.lower()}.")
    if value < low or value > high:
        raise ValidationError(f"{label} must be between {low} and {high}.")
    return value


def parse_rule_config(data):
    """Validate rule settings. Bands must stay contiguous and cover 0..MAX_COUNT,
    with at least one count in each band. Each band has a green-time minimum and
    maximum (maximum >= minimum); for a fixed time they are equal.

    The older single-value form (e.g. "low_green": 15) is still accepted and
    means minimum = maximum = 15.
    """
    if not isinstance(data, dict):
        raise ValidationError("Request body must be JSON.")
    low_max = _ranged(data, "low_max", "Low upper limit", MIN_COUNT, MAX_COUNT - 2)
    medium_max = _ranged(data, "medium_max", "Medium upper limit", low_max + 1, MAX_COUNT - 1)
    config = {"low_max": low_max, "medium_max": medium_max}
    for key, level in (("low", "Low"), ("medium", "Medium"), ("high", "High")):
        values = dict(data)
        legacy = f"{key}_green"
        if legacy in data and f"{key}_green_min" not in data and f"{key}_green_max" not in data:
            values[f"{key}_green_min"] = values[f"{key}_green_max"] = data[legacy]
        g_min = _ranged(values, f"{key}_green_min", f"{level} minimum green time", GREEN_MIN, GREEN_MAX)
        g_max = _ranged(values, f"{key}_green_max", f"{level} maximum green time", GREEN_MIN, GREEN_MAX)
        if g_max < g_min:
            raise ValidationError(
                f"{level} maximum green time must be at least the minimum ({g_min} seconds).")
        config[f"{key}_green_min"] = g_min
        config[f"{key}_green_max"] = g_max
    return config
