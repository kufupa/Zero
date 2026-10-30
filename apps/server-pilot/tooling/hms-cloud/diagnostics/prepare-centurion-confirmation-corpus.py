#!/usr/bin/env python3
"""Prepare a private, deduplicated HMS read list from a Centurion PDF dataset."""

import argparse
import json
import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path


NUMBER = re.compile(r"(?<!\d)\d{6,10}-\d{1,2}(?!\d)")


def arrival_date(value):
    for date_format in ("%d-%m-%Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), date_format).date().isoformat()
        except ValueError:
            continue
    raise ValueError("Unsupported PDF arrival date format")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("records", type=Path)
    parser.add_argument("previous_results", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    os.umask(0o077)

    previous = json.loads(args.previous_results.read_text())
    previous_rows = previous["results"]
    previous_ids = [row["confirmation"] for row in previous_rows]
    if len(previous_ids) != len(set(previous_ids)):
        raise ValueError("Duplicate confirmation in previous results")
    successful = {row["confirmation"] for row in previous_rows if row.get("ok") is True}

    candidates = {}
    counts = Counter()
    with args.records.open() as source:
        for line in source:
            record = json.loads(line)
            qualification = record["qualification"]
            if (qualification["transportId"] != "transport-centurion" or
                    qualification["direction"] != "outbound" or
                    not qualification["filenamePatternMatch"]):
                raise ValueError("A record falls outside the Centurion PDF selection")

            filename = set(NUMBER.findall(record["attachment"]["filename"]))
            if len(filename) != 1:
                raise ValueError("A PDF filename does not contain exactly one confirmation candidate")
            confirmation = next(iter(filename))
            extraction = record["pdfExtraction"]
            labels = {item["value"] for item in extraction["confirmationNumberCandidates"]}
            text_numbers = set(NUMBER.findall(" ".join(page["markdown"] for page in extraction["pages"])))
            subject = set(NUMBER.findall(record["parentMessage"]["subject"] or ""))
            if text_numbers != filename or (labels and labels != filename):
                raise ValueError("A PDF confirmation candidate conflicts with its extracted text")
            if not labels and confirmation not in subject:
                raise ValueError("An unlabeled confirmation lacks matching subject evidence")
            arrival_values = extraction["extractedFields"]["arrivalDate"]
            if not arrival_values:
                raise ValueError("A PDF is missing its arrival date")
            arrival = arrival_date(arrival_values[0]["value"])
            guest_values = extraction["extractedFields"]["guestName"]
            guest_name = guest_values[0]["value"] if guest_values else None
            sent_at = record["parentMessage"]["sentAt"] or record["parentMessage"]["createdAt"] or ""

            item = candidates.setdefault(confirmation, {
                "confirmation": confirmation,
                "pdfRecordCount": 0,
                "labeledPdfCount": 0,
                "filenameAndSubjectMatchPdfCount": 0,
                "conflictingSubjectPdfCount": 0,
                "pdfAttachmentIds": [],
                "arrivalDateHint": arrival,
                "arrivalHintPdfSentAt": sent_at,
                "guestNameHint": guest_name,
            })
            if sent_at > item["arrivalHintPdfSentAt"]:
                item["arrivalDateHint"] = arrival
                item["arrivalHintPdfSentAt"] = sent_at
                item["guestNameHint"] = guest_name
            item["pdfRecordCount"] += 1
            item["labeledPdfCount"] += bool(labels)
            item["filenameAndSubjectMatchPdfCount"] += confirmation in subject
            item["conflictingSubjectPdfCount"] += bool(subject and confirmation not in subject)
            item["pdfAttachmentIds"].append(record["source"]["attachmentId"])
            counts["pdfRecords"] += 1
            counts["labeledPdfRecords"] += bool(labels)
            counts["filenameAndSubjectRecoveredPdfRecords"] += not labels
            counts["subjectConflicts"] += bool(subject and confirmation not in subject)

    if not set(previous_ids).issubset(candidates):
        raise ValueError("Previous results contain IDs outside the full PDF dataset")
    if not candidates:
        raise ValueError("No confirmation candidates found")

    ordered = [candidates[value] for value in sorted(candidates)]
    pending = [item["confirmation"] for item in ordered if item["confirmation"] not in successful]
    args.output_dir.mkdir(mode=0o700)
    evidence = {
        "sourceRecords": str(args.records.resolve()),
        "previousResults": str(args.previous_results.resolve()),
        "counts": dict(counts),
        "candidateCount": len(ordered),
        "previousSuccessfulReads": len(successful),
        "pendingReads": len(pending),
        "candidates": ordered,
    }
    (args.output_dir / "candidate-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    lines = ["# Centurion full-corpus HMS reads", "", "## Distinct exact ID candidates", "",
             "| Confirmation |", "| --- |"]
    lines.extend(f"| `{value}` |" for value in pending)
    (args.output_dir / "pending-confirmations.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({**counts, "uniqueCandidates": len(ordered),
                      "previousSuccessfulReads": len(successful), "pendingReads": len(pending)}))


if __name__ == "__main__":
    main()
