"""Versioned field policy inventory. Modes only — no invented weights/rubrics/prices/codes."""
from __future__ import annotations

from .schema import FIELD_POLICY_VERSION

# Policies mirror contract Product Contract + U3 rules. Sparse labels stay unrepresented.
FIELD_POLICIES: list[dict[str, object]] = [
    # Create hard paths — exact when evidenced; else abstention
    {"path": "/bookings/*/fields/first_name", "mode": "exact", "unit": "booking", "workflow": ["create", "amend"]},
    {"path": "/bookings/*/fields/last_name", "mode": "exact", "unit": "booking", "workflow": ["create", "amend"]},
    {"path": "/bookings/*/fields/arrival_date", "mode": "exact", "unit": "booking", "workflow": ["create", "amend", "quote"]},
    {"path": "/bookings/*/fields/departure_date", "mode": "exact", "unit": "booking", "workflow": ["create", "amend", "quote"]},
    {"path": "/bookings/*/fields/adults", "mode": "exact", "unit": "booking", "workflow": ["create", "amend", "quote"]},
    {"path": "/bookings/*/fields/child_count", "mode": "exact", "unit": "booking", "workflow": ["create", "amend"], "note": "Quote uses /children"},
    {"path": "/actions/*/details/groups/*/rooms/*/children", "mode": "exact", "unit": "quote_room", "workflow": ["quote"]},
    {"path": "/bookings/*/fields/room_type", "mode": "semantic", "unit": "booking", "workflow": ["create", "amend"], "note": "catalogue code when attributable; never from occupancy alone"},
    {"path": "/bookings/*/fields/board", "mode": "allowed_set", "unit": "booking", "workflow": ["create", "amend", "quote"], "allowed": ["RO", "BB", "DBB"]},
    {"path": "/bookings/*/fields/rate_plan", "mode": "required_abstention", "unit": "booking", "workflow": ["create"], "note": "printed price is not native rate code"},
    {"path": "/bookings/*/fields/agency_name", "mode": "semantic", "unit": "booking", "workflow": ["create"]},
    {"path": "/bookings/*/fields/organization_name", "mode": "semantic", "unit": "booking", "workflow": ["create"], "note": "employer ≠ agency; no credit from past payer"},
    {"path": "/bookings/*/fields/guarantee_type", "mode": "allowed_set", "unit": "booking", "workflow": ["create"], "allowed": ["AVOUCH", "CNFREC"], "note": "canonical aliases only; reject unknown"},
    {"path": "/bookings/*/fields/billing_reference", "mode": "exact", "unit": "booking", "workflow": ["create"]},
    {"path": "/bookings/*/fields/booking_source", "mode": "deterministic_default", "unit": "booking", "workflow": ["create"], "default": "EMA", "note": "code-owned on initial email proposal; not model hit"},
    {"path": "/bookings/*/fields/bed_preference", "mode": "deterministic_default", "unit": "booking", "workflow": ["create"], "default": "STQN", "note": "staff-editable application default; not guest evidence"},
    {"path": "/bookings/*/reservation_id", "mode": "exact", "unit": "booking", "workflow": ["amend", "cancel", "filing"], "note": "unverified target → not observed"},
    {"path": "/bookings/*/fields/confirmation_number", "mode": "exact", "unit": "booking", "workflow": ["filing", "amend", "cancel"]},
    {"path": "/actions/*/type", "mode": "allowed_set", "unit": "action", "workflow": ["filing"], "allowed": ["voucher_submission", "payment_proof_submission"]},
    {"path": "/actions/*/details/attachment_id", "mode": "exact", "unit": "action", "workflow": ["filing"]},
    {"path": "/actions/*/details/cancellation_reason", "mode": "semantic", "unit": "action", "workflow": ["cancel"], "note": "native reason vs free-text guest note separated"},
    # Outcome-only / not observable
    {"path": "native_availability", "mode": "outcome_only", "unit": "offer", "workflow": ["quote"], "note": "cannot infer from draft"},
    {"path": "native_price", "mode": "not_observable", "unit": "offer", "workflow": ["quote", "create"], "note": "do not invent prices"},
    {"path": "native_rate_code_from_letter", "mode": "not_observable", "unit": "booking", "workflow": ["create"], "note": "0/2399 native rate codes in letters-STATS"},
    {"path": "original_ar_from_refund", "mode": "required_abstention", "unit": "booking", "workflow": ["create"], "note": "never derive original A/R from Refund Account"},
    {"path": "inventory_from_letter", "mode": "not_observable", "unit": "offer", "workflow": ["quote"]},
]


def field_policy_document() -> dict[str, object]:
    return {
        "schema": FIELD_POLICY_VERSION,
        "version": FIELD_POLICY_VERSION,
        "source": "contract.md U3 + Product Contract field policies",
        "audit_ref": "/home/orca/.local/share/zero/research/2026-11-24-replay-field-audit.md",
        "policies": FIELD_POLICIES,
        "unrepresented_material_fields": [
            "track",
            "market_segment",
            "credit_entitlement_from_history",
        ],
        "note": "No weights. Unrepresented material fields reported explicitly; sparse labels not promoted to headline metrics.",
    }
