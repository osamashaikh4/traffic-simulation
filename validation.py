"""Input validation for vehicle counts and scenario labels (FR9, TC10-TC13)."""

import re

from rules import MAX_COUNT, MIN_COUNT

SCENARIO_LABEL_MAX = 50
WHOLE_NUMBER = re.compile(r"[+-]?\d+")


class ValidationError(ValueError):
    pass


def parse_vehicle_count(raw):
    """Turn a JSON/form value into a valid whole-number vehicle count.

    Documented rule for decimals (TC13): decimals are rejected, not rounded.
    """
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        raise ValidationError("Please enter a vehicle count.")
    if isinstance(raw, bool):
        raise ValidationError("Vehicle count must be a whole number.")

    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, float):
        if not raw.is_integer():
            raise ValidationError("Vehicle count must be a whole number (decimals are not allowed).")
        value = int(raw)
    elif isinstance(raw, str):
        text = raw.strip()
        if WHOLE_NUMBER.fullmatch(text):
            value = int(text)
        else:
            try:
                float(text)
            except ValueError:
                raise ValidationError("Vehicle count must be a number.")
            raise ValidationError("Vehicle count must be a whole number (decimals are not allowed).")
    else:
        raise ValidationError("Vehicle count must be a number.")

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
