#!/usr/bin/env python3
"""Independently recheck the Centurion subject census and historical-label join.

Reads owner-only mail locally to compare exact stored values. Prints aggregate
counts and a source fingerprint, never addresses, subjects, bodies or message IDs.
The date windows and historical TSV/JSONL schema are specific to this study.
"""

import argparse
import collections
import csv
import email.utils
import gzip
import hashlib
import json
import pathlib
import re


WINDOWS = {
    "full_snapshot": (None, None),
    "2026-09-28_to_2026-10-23": ("2026-09-28", "2026-10-23"),
    "2026-07-30_to_2026-10-13": ("2026-07-30", "2026-10-13"),
}
ACTIONS = {
    "no_action", "quote_availability", "new_booking", "amend", "cancel",
    "billing", "payment_proof", "group_event", "other_actionable",
}


def addresses(values):
    if isinstance(values, str):
        values = [values]
    return {value.casefold() for _, value in email.utils.getaddresses(values or []) if "@" in value}


def no_reply(values):
    return any(re.search(r"no[-_.]?reply", value.rsplit("@", 1)[0]) for value in values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="owner-only current corpus.jsonl")
    parser.add_argument("--historical-messages", type=pathlib.Path, required=True, help="R3 messages.jsonl.gz")
    parser.add_argument("--historical-labels", type=pathlib.Path, required=True, help="R3 labels.tsv")
    parser.add_argument("--transport", required=True, help="exact selected transport ID")
    args = parser.parse_args()

    labels = {}
    with args.historical_labels.open(newline="", encoding="utf-8") as source:
        for label in csv.DictReader(source, delimiter="\t"):
            identifier = label.get("message_id")
            if not identifier or identifier in labels:
                raise ValueError("historical labels contain a missing or duplicate ID")
            labels[identifier] = label

    historical = {}
    with gzip.open(args.historical_messages, "rt", encoding="utf-8") as source:
        for line in source:
            message = json.loads(line)
            identifier = str(message.get("id") or "")
            if identifier in labels:
                if identifier in historical:
                    raise ValueError("historical source contains a duplicate labeled ID")
                historical[identifier] = message

    alerts = {key: collections.Counter() for key in WINDOWS}
    comparisons = collections.Counter()
    no_reply_actions = collections.Counter()
    seen = set()
    digest = hashlib.sha256()
    with args.source.open("rb") as source:
        for raw in source:
            digest.update(raw)
            thread = json.loads(raw)
            if thread.get("recordType") != "thread":
                continue
            for message in thread.get("messages", []):
                day = str(message.get("timestamp") or "")[:10]
                for row in message.get("sourceRows", []):
                    private = row.get("privateMessage") or {}
                    if private.get("direction") != "inbound":
                        continue
                    if "active_transport" not in (row.get("scopeMembership") or []):
                        continue
                    if (private.get("sourceMetadata") or {}).get("transportId") != args.transport:
                        continue
                    comparisons["selected_inbound_rows"] += 1
                    sender = addresses((private.get("addresses") or {}).get("from"))
                    synxis = {value for value in sender if value.rsplit("@", 1)[1] == "synxis.com"}
                    subject = str(private.get("subject") or "").casefold()
                    if synxis and "reservation failed to integrate" in subject:
                        modification = "modification" in subject
                        cancellation = "cancellation" in subject
                        for key, (start, end) in WINDOWS.items():
                            if (start and day < start) or (end and day > end):
                                continue
                            alerts[key]["subject_matches"] += 1
                            alerts[key]["no_reply_sender_clue"] += bool(no_reply(synxis))
                            alerts[key]["modification_only"] += modification and not cancellation
                            alerts[key]["cancellation_only"] += cancellation and not modification
                            alerts[key]["both_or_neither"] += modification == cancellation

                    identifier = str(row.get("sourceRowId") or "")
                    if identifier not in historical:
                        continue
                    if identifier in seen:
                        raise ValueError("current source contains a duplicate matching source-row ID")
                    seen.add(identifier)
                    comparisons["matching_historical_ids"] += 1
                    old = historical[identifier]
                    same_subject = str(private.get("subject") or "") == str(old.get("subject") or "")
                    same_body = str(row.get("body") or "") == str(old.get("body") or "")
                    same_from = sender == addresses(old.get("from_address"))
                    same_direction = old.get("direction") == "inbound"
                    if not (same_subject and same_body and same_from and same_direction):
                        continue
                    comparisons["same_id_subject_body_from_direction"] += 1
                    clue = bool(no_reply(sender))
                    need = labels[identifier].get("needs_action")
                    if need not in ("yes", "no"):
                        need = "unknown"
                    comparisons[f"no_reply_{str(clue).lower()}_needs_action_{need}"] += 1
                    if clue:
                        action = labels[identifier].get("action")
                        no_reply_actions[action if action in ACTIONS else "unrecognized"] += 1

    if not comparisons["selected_inbound_rows"] or not comparisons["matching_historical_ids"]:
        raise SystemExit("No selected inbound rows or historical ID matches; verify source and transport.")
    result = {
        "source_sha256": digest.hexdigest(),
        "historical_label_rows": len(labels),
        "historical_messages_found": len(historical),
        "comparison": dict(sorted(comparisons.items())),
        "no_reply_historical_actions": dict(sorted(no_reply_actions.items())),
        "synxis_failure_subject_counts": {key: dict(sorted(values.items())) for key, values in alerts.items()},
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
