"""Test-only simulated insurance estimate; never sourced from Foresee."""

FAKE_RESULT = {
    "simulated": True,
    "notice": "LOCAL TEST FIXTURE ONLY — NOT A REAL QUOTE",
    "by_line": {"auto": {"carriers": [{
        "carrier": "Example Mutual (SIMULATED)",
        "annual_premium": 1432,
        "monthly_premium": 119.33,
        "assumptions": ["Fictional test values; no insurer lookup was made."],
    }]}},
}
