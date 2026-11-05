#!/usr/bin/env python3
"""Publish categorical fields from private staged staff-response reviews."""

import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CASES = {f"PB-{chr(65 + i)}" for i in range(15)}
REPLIES = {
    "acceptance_or_update", "extra_charge_or_price", "other_condition",
    "not_decidable", "clarification", "payment_condition",
    "cancellation_fee_or_policy", "offered_alternative", "specific_refusal_or_unavailability",
}
REQUESTS = {
    "room_quote_and_transfer_request", "cancellation_fee_inquiry", "room_availability_inquiry",
    "reservation_change_request", "group_room_availability_inquiry_unclear",
    "room_quote_and_booking_conditions_request", "multi_room_quote_and_booking_conditions_request",
    "cancellation_fee_waiver_request", "reservation_modification_request", "deposit_condition_update",
    "room_quote_and_policy_request", "contact_routing_and_account_update",
    "reservation_request_with_arrival_details", "payment_timing_inquiry", "payment_link_request",
}
SCOPES = {
    "room_quote_and_booking_confirmation_process", "cancellation_charge",
    "booking_status_and_payment_reference", "charge_status", "room_rate_options",
    "availability_and_booking_choice", "group_quote_and_booking_confirmation_process",
    "cancellation_waiver_decision", "booking_payment_condition", "checkout_status_and_charge",
    "booking_status_and_payment", "communication_receipt_or_routing", "payment_timing",
    "attachment_or_payment_link",
}


def read_labels(path):
    if path.stat().st_mode & 0o077:
        raise ValueError("Input label file must be private")
    rows = json.loads(path.read_text(encoding="utf-8"))["labels"]
    result = {row["case"]: row for row in rows}
    if len(rows) != 15 or set(result) != CASES:
        raise ValueError("Expected 15 distinct reviewed cases")
    return result


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: project-pushback-review.py PRIVATE_PACKET_DIRECTORY")
    private = pathlib.Path(sys.argv[1]).resolve(strict=True)
    if not private.is_dir() or private.stat().st_mode & 0o077:
        raise SystemExit("packet directory must be private")
    target = read_labels(private / "target-labels.json")
    response = read_labels(private / "response-labels.json")
    cases = []
    for key in sorted(CASES):
        row = response[key]
        if target[key]["request_label"] != row["request_label"]:
            raise ValueError("Frozen request label changed after response review")
        if row["request_label"] not in REQUESTS or row["scope"] not in SCOPES:
            raise ValueError("Unsupported request or scope category")
        if not isinstance(row["reply_classes"], list) or not set(row["reply_classes"]) <= REPLIES:
            raise ValueError("Unsupported reply category")
        if row["relationship"] not in {"direct", "ambiguous", "unknown"}:
            raise ValueError("Unsupported relationship category")
        if row["decision_specificity"] not in {"none", "partial", "specific", "unclear"}:
            raise ValueError("Unsupported specificity category")
        if row["confidence"] not in {"low", "medium", "high"}:
            raise ValueError("Unsupported confidence category")
        cases.append({k: row[k] for k in (
            "case", "request_label", "reply_classes", "scope", "decision_specificity",
            "relationship", "confidence",
        )})

    counts = collections.Counter(code for row in cases for code in row["reply_classes"])
    result = {
        "schema": "hms-staff-response-categorical-review-v1",
        "method": {
            "case_count": 15,
            "selection": "Purposive sample of 15 from 38 same-thread candidate pairs found with change/cancel and staff-response cues.",
            "review": "One reviewer labeled redacted target requests first, froze labels, then labeled authored-top staff responses.",
            "limits": [
                "Selection is not representative; classes overlap and do not estimate prevalence.",
                "Masking and truncated request tails obscure details; later staff replies are not HMS or payment proof.",
                "Directness is reviewer judgment, not a proven reply-to relationship; 10 links are ambiguous.",
                "Acceptance or update is a text classification, not proof the requested action was fulfilled.",
            ],
        },
        "reply_class_counts": {key: counts[key] for key in sorted(REPLIES)},
        "relationship_counts": dict(collections.Counter(row["relationship"] for row in cases)),
        "cases": cases,
    }
    out = ROOT / "2026-10-31-staff-response-review.json"
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} categorical case reviews to {out.name}")


if __name__ == "__main__":
    main()
