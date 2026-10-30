#!/usr/bin/env python3
"""Merge private, checkpointed HMS reads with the previously saved corpus."""

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def load(path):
    return json.loads(path.read_text())


def index_results(document):
    rows = document["results"]
    indexed = {row["confirmation"]: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError("Duplicate confirmation in result file")
    return indexed


def attempt(row, source):
    return {**{key: value for key, value in row.items() if key != "previousAttempts"},
            "source": source}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate_evidence", type=Path)
    parser.add_argument("previous_results", type=Path)
    parser.add_argument("pending_batch", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--retry-batch", type=Path, action="append", default=[])
    args = parser.parse_args()
    os.umask(0o077)
    if args.previous_results.resolve() == args.output.resolve():
        raise ValueError("Keep the original result snapshot separate from the output")
    if args.output.parent.stat().st_mode & 0o077:
        raise ValueError("Output directory is not private")

    evidence = load(args.candidate_evidence)
    previous = load(args.previous_results)
    batch = load(args.pending_batch)
    old_rows, new_rows = index_results(previous), index_results(batch)
    retry_batches = [index_results(load(path)) for path in args.retry_batch]
    candidates = {item["confirmation"]: item for item in evidence["candidates"]}
    if len(candidates) != len(evidence["candidates"]):
        raise ValueError("Duplicate confirmation in candidate evidence")
    successful_previous = {number for number, row in old_rows.items() if row.get("ok") is True}
    if set(new_rows) != set(candidates) - successful_previous:
        raise ValueError("Pending batch and source candidates differ")
    if (not set(old_rows).issubset(candidates) or
            any(not set(rows).issubset(new_rows) for rows in retry_batches)):
        raise ValueError("A results file contains an unexpected confirmation")

    order = list(old_rows) + [number for number in candidates if number not in old_rows]
    results = []
    for number in order:
        old, current = old_rows.get(number), new_rows.get(number)
        selected = old if number in successful_previous else current
        selected = dict(selected)
        selected_source = "previous batch" if number in successful_previous else "full-corpus batch"
        prior = list(old.get("previousAttempts", [])) if old and old.get("ok") is False else []
        if old and old.get("ok") is False:
            prior.append(attempt(old, "previous batch"))
        prior.extend(selected.get("previousAttempts", []))
        for index, rows in enumerate(retry_batches, start=1):
            retry = rows.get(number)
            if not retry or retry.get("ok") is None or selected.get("ok") is True:
                continue
            if selected.get("ok") is not None:
                prior.append(attempt(selected, selected_source))
            prior.extend(retry.get("previousAttempts", []))
            selected = dict(retry)
            selected_source = f"retry batch {index}"
        if prior:
            selected["previousAttempts"] = prior
        item = candidates[number]
        selected["sourcePdfEvidence"] = {key: value for key, value in item.items() if key != "confirmation"}
        if selected.get("ok") is True:
            if (selected.get("stay360", {}).get("confirmation") != number or
                selected.get("recordView", {}).get("details", {}).get("confirmationInRecord") != number or
                selected.get("recordView", {}).get("details", {}).get("activeTab") != "Record View" or
                selected.get("guestDetails", {}).get("details", {}).get("activeTab") != "Guest Details"):
                raise ValueError("Successful result is missing or mismatching a workflow stage")
        results.append(selected)

    result = {**previous, "source": evidence["sourceRecords"],
              "sourceType": "Centurion outbound confirmation-letter PDF candidates",
              "previousSource": previous.get("source"),
              "pdfCorpus": {**evidence["counts"], "uniqueCandidates": len(candidates),
                            "candidateEvidence": str(args.candidate_evidence.resolve()),
                            "description": "Filename and native PDF text agree; unlabeled values also match the subject."},
              "fullCorpusStartedAt": batch["startedAt"],
              "updatedAt": datetime.now(timezone.utc).isoformat(),
              "concurrency": batch["concurrency"],
              "total": len(results),
              "completed": sum(row.get("ok") is not None for row in results),
              "succeeded": sum(row.get("ok") is True for row in results),
              "failed": sum(row.get("ok") is False for row in results),
              "results": results}
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent,
                                         prefix=".corpus-merge-", delete=False) as handle:
            tmp = Path(handle.name)
            json.dump(result, handle, indent=2)
            handle.write("\n")
        # Publish a completed snapshot only if the output does not already exist.
        os.link(tmp, args.output)
    finally:
        if tmp and tmp.exists():
            tmp.unlink()
    print(json.dumps({key: result[key] for key in ("total", "completed", "succeeded", "failed")}))


if __name__ == "__main__":
    main()
