"""Report section 5.2 - functional test cases TC01-TC09 (rule logic)."""

import pytest

from rules import classify

FUNCTIONAL_CASES = [
    ("TC01", 0, "Low", 15),
    ("TC02", 5, "Low", 15),
    ("TC03", 10, "Low", 15),
    ("TC04", 11, "Medium", 30),
    ("TC05", 20, "Medium", 30),
    ("TC06", 25, "Medium", 30),
    ("TC07", 26, "High", 45),
    ("TC08", 40, "High", 45),
    ("TC09", 50, "High", 45),
]


@pytest.mark.parametrize("test_id,count,density,green", FUNCTIONAL_CASES, ids=[c[0] for c in FUNCTIONAL_CASES])
def test_classification(test_id, count, density, green):
    assert classify(count) == (density, green)


def test_every_count_in_range_is_covered_and_deterministic():
    # NFR3: the same count always returns the same result.
    for count in range(0, 51):
        assert classify(count) == classify(count)


@pytest.mark.parametrize("bad", [-1, 51, 10.5, "10", None, True])
def test_classify_rejects_invalid(bad):
    with pytest.raises(ValueError):
        classify(bad)
