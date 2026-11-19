"""Canonical Stay360 (118) + guest-profile (65) for hms_raw inspection; proposal-path map for gold."""
from __future__ import annotations

import json
from pathlib import Path

DATA = Path("/home/orca/.local/share/zero/bench/replay-bench-20261119")
BENCH_INPUTS = Path("/home/orca/.local/share/zero/research/bench-inputs-20261119")
GP_RESULTS = Path(
    "/home/orca/.local/share/zero/research/halloween/"
    "guest-profile-fields-20261105-k36uhxce/results.json"
)


def _load_stay360() -> list[dict]:
    local = DATA / "catalog/stay360-record-fields.json"
    if local.exists():
        rows = json.loads(local.read_text())
        assert len(rows) == 118, len(rows)
        return rows
    cat = json.loads((BENCH_INPUTS / "F-tool-io-catalogue.json").read_text())
    rows = [
        {"name": f["name"], "label": f.get("label"), "type": f.get("type")}
        for f in cat["tools"]["hms_read_reservation"]["reservation_fields"]
    ]
    assert len(rows) == 118, len(rows)
    return rows


def _load_profile() -> list[dict]:
    local = DATA / "catalog/guest-profile-fields.json"
    if local.exists():
        rows = json.loads(local.read_text())
        assert len(rows) == 65, len(rows)
        return rows
    rows = [
        {"name": f["name"], "label": f.get("label"), "xtype": f.get("xtype")}
        for f in json.loads(GP_RESULTS.read_text())["fields"]
    ]
    assert len(rows) == 65, len(rows)
    return rows


STAY360_FIELDS: list[dict] = _load_stay360()
PROFILE_FIELDS: list[dict] = _load_profile()
STAY360_NAMES = [f["name"] for f in STAY360_FIELDS]
PROFILE_NAMES = [f["name"] for f in PROFILE_FIELDS]

# HMS record-view / later_hms key -> proposal_publish path template ({n}=booking index).
# Gold NEVER uses /hms/* paths — those live only in hms_raw for inspection.
HMS_TO_PROPOSAL_MAP: dict[str, dict] = {
    "confirmationnumber": {"path": "/bookings/{n}/reservation_id", "tier": "tier1_core", "pane": "reservation_id"},
    "confirmation": {"path": "/bookings/{n}/reservation_id", "tier": "tier1_core", "pane": "reservation_id"},
    "arrivaldate": {"path": "/bookings/{n}/fields/arrival_date", "tier": "tier1_core", "pane": "arrival_date"},
    "departuredate": {"path": "/bookings/{n}/fields/departure_date", "tier": "tier1_core", "pane": "departure_date"},
    "adults": {"path": "/bookings/{n}/fields/adults", "tier": "tier1_core", "pane": "adults"},
    "children": {"path": "/bookings/{n}/fields/child_count", "tier": "tier1_core", "pane": "child_count"},
    "roomtype": {"path": "/bookings/{n}/fields/room_type", "tier": "tier1_core", "pane": "room_type"},
    "rateplan": {"path": "/bookings/{n}/fields/rate_plan", "tier": "tier1_core", "pane": "rate_plan"},
    "mealplan": {"path": "/bookings/{n}/fields/meal_plan", "tier": "tier1_core", "pane": "meal_plan"},
    # Create pane uses first_name/last_name only — guest_name is NOT a create proposal path.
    "guestfullname": {"path": "/bookings/{n}/fields/guest_name", "tier": "tier1_core", "pane": "guest_name", "workflows": ["cancel", "amend", "filing", "triage"]},
    "firstname": {"path": "/bookings/{n}/fields/first_name", "tier": "tier1_core", "pane": "first_name"},
    "lastname": {"path": "/bookings/{n}/fields/last_name", "tier": "tier1_core", "pane": "last_name"},
    "company": {"path": "/bookings/{n}/fields/organization_name", "tier": "tier1_core", "pane": "organization_name"},
    "ta1": {"path": "/bookings/{n}/fields/agency_name", "tier": "tier1_core", "pane": "agency_name"},
    "emailaddress": {"path": "/bookings/{n}/fields/guest_email", "tier": "tier1_core", "pane": "guest_email"},
    "guaranteetype": {"path": "/bookings/{n}/fields/guarantee_type", "tier": "tier2_defaults", "pane": "guarantee_type"},
    "sourceofbusiness": {"path": "/bookings/{n}/fields/source_of_business", "tier": "tier2_defaults", "pane": "source_of_business"},
    "marketsegment": {"path": "/bookings/{n}/fields/market_segment", "tier": "tier2_defaults", "pane": "market_segment"},
    "track": {"path": "/bookings/{n}/fields/track", "tier": "tier2_defaults", "pane": "track"},
    "billingreference": {"path": "/bookings/{n}/fields/billing_reference", "tier": "tier2_defaults", "pane": "billing_reference"},
    "cms": {"path": "/bookings/{n}/fields/cms_send", "tier": "tier2_defaults", "pane": "cms_send"},
    "udfchar09": {"path": "/bookings/{n}/fields/cms_send", "tier": "tier2_defaults", "pane": "cms_send"},
    "udfchar13": {"path": "/bookings/{n}/fields/cms_message_id", "tier": "tier2_defaults", "pane": "cms_message_id"},
}

# Confirmations in the Sep-2026 group amend wave (shorten departure). Only these get multi-booking gold.
GROUP_AMEND_CONFS = {"22098684-1", "37768113-1", "38564475-1", "60387251-1"}

TIER_HISTORY = "history_knowable"

# Action / doc targets (filing, cancel, quote, triage).
ACTION_PATHS = {
    "cancel_scope": {"path": "/actions/0/details/requested_scope", "tier": "tier1_core"},
    "cancel_reason": {"path": "/actions/0/details/cancellation_reason", "tier": "tier1_core"},
    "filing_attachment": {"path": "/actions/0/details/attachment_id", "tier": "tier1_core"},
    "filing_description": {"path": "/actions/0/details/description", "tier": "tier1_core"},
    "filing_confirmation": {"path": "/bookings/0/fields/confirmation_number", "tier": "tier1_core"},
    "quote_property": {"path": "/actions/0/details/property_code", "tier": "tier1_core"},
    "triage_reservation": {"path": "/actions/0/details/lookup/reservation_id", "tier": "tier1_core"},
}

TIER1 = "tier1_core"
TIER2 = "tier2_defaults"
