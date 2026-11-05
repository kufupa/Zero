#!/usr/bin/env python3
"""Publish categorical comparison of four blinded, redacted review arms."""

import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
ACTIONS = {"amend", "cancel", "create", "quote", "payment_or_billing", "service", "none", "unclear"}
FIELDS = {"dates", "nights", "room", "occupancy", "guest", "party", "rate_board", "service", "invoice_payment", "cancel_policy", "other"}
MISSING = FIELDS | {"action", "scope", "identity"}
CONFIDENCE = {"low", "medium", "high"}
IDS = {f"case_{i:02}" for i in range(1, 25)}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def case_map(payload):
    rows = payload["cases"]
    result = {row["case_id"]: row for row in rows}
    if len(rows) != 24 or set(result) != IDS:
        raise ValueError("Expected 24 distinct case IDs")
    return result


def label_projection(row):
    if row["action"] not in ACTIONS or row["confidence"] not in CONFIDENCE:
        raise ValueError("Unsupported action or confidence")
    for key, allowed in (("secondary_actions", ACTIONS), ("field_families", FIELDS),
                         ("known_from_input", FIELDS), ("missing_or_uncertain", MISSING)):
        if not isinstance(row[key], list) or not set(row[key]) <= allowed:
            raise ValueError(f"Unsupported categorical values in {key}")
    return {key: row[key] for key in (
        "action", "secondary_actions", "field_families", "known_from_input",
        "missing_or_uncertain", "confidence",
    )}


def compare(a, b, ids):
    actions = lambda row: {row["action"], *row["secondary_actions"]}
    return {
        "cases": len(ids),
        "primary_action_changed": sum(a[key]["action"] != b[key]["action"] for key in ids),
        "any_action_set_changed": sum(actions(a[key]) != actions(b[key]) for key in ids),
        "known_field_set_changed": sum(set(a[key]["known_from_input"]) != set(b[key]["known_from_input"]) for key in ids),
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: compare-context-arms.py PRIVATE_PACKET_DIRECTORY")
    private = pathlib.Path(sys.argv[1]).resolve(strict=True)
    if not private.is_dir() or private.stat().st_mode & 0o077:
        raise SystemExit("packet directory must be private")
    packets = {name: case_map(load(private / f"{name}.json")) for name in ("current", "prior", "attachments")}
    labels = {name: {case: label_projection(row) for case, row in case_map(
        load(private / f"labels-{name}.json")).items()} for name in ("current", "prior", "attachments", "current-repeat")}
    for case in IDS:
        if not (packets["current"][case]["current"] == packets["prior"][case]["current"] ==
                packets["attachments"][case]["current"]):
            raise ValueError("Current-message content differs between arms")
        if packets["prior"][case]["prior"] != packets["attachments"][case]["prior"]:
            raise ValueError("Prior content differs between arms")
    prior_yes = {case for case in IDS if packets["prior"][case]["prior"]}
    attachment_yes = {case for case in IDS if packets["attachments"][case]["attachments"]}
    if len(prior_yes) != 12 or len(attachment_yes) != 12:
        raise ValueError("Unexpected context availability")
    result = {
        "schema": "hms-context-arm-comparison-v1",
        "method": {
            "cases": 24,
            "design": "Four separate reviewers: current, current+prior, current+prior+attachment text, repeated current.",
            "prior_cases": len(prior_yes),
            "attachment_cases": len(attachment_yes),
            "limitations": [
                "Purposively selected historical examples, redacted and not representative.",
                "Same-content controls have different packet arm labels and empty fields; current repeat sees the exact same packet.",
                "Some current bodies already contain quoted history; attachment content is text-only, potentially partial, with no image bytes.",
                "No independently verified gold: changes measure reviewer sensitivity, not correctness or causal lift.",
                "Different reviewers and random model outputs contribute noise; zero or missing evidence does not prove absence.",
            ],
        },
        "primary_action_counts": {name: dict(collections.Counter(v["action"] for v in rows.values()))
                                  for name, rows in labels.items()},
        "comparisons": {
            "current_vs_prior": {
                "prior_present": compare(labels["current"], labels["prior"], prior_yes),
                "same_content_no_prior": compare(labels["current"], labels["prior"], IDS - prior_yes),
            },
            "prior_vs_attachments": {
                "attachment_present": compare(labels["prior"], labels["attachments"], attachment_yes),
                "same_content_no_attachment": compare(labels["prior"], labels["attachments"], IDS - attachment_yes),
            },
            "current_vs_current_repeat": compare(labels["current"], labels["current-repeat"], IDS),
        },
        "cases": [
            {"case": case, "prior_present": case in prior_yes, "attachment_text_present": case in attachment_yes,
             "labels": {name: rows[case] for name, rows in labels.items()}}
            for case in sorted(IDS)
        ],
    }
    output = ROOT / "2026-10-31-context-arm-comparison.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(result['cases'])} categorical case comparisons to {output.name}")


if __name__ == "__main__":
    main()
