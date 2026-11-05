#!/usr/bin/env python3
"""Compare v14 synthetic expected labels with private Luna runner results.

The report intentionally contains counts, synthetic case IDs, and field names
only; it never prints email text, evidence quotes, reasons, or actual labels.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any


LABEL_FIELDS = (
    "reservation_email",
    "can_help",
    "actions",
    "reply_ids",
    "response_type",
    "invoice_handling",
    "evidence_source",
)
ARRAY_FIELDS = {"actions", "reply_ids"}


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as stream:
            for line_number, raw in enumerate(stream, start=1):
                if not raw.strip():
                    continue
                try:
                    row = json.loads(raw)
                except (json.JSONDecodeError, UnicodeError):
                    raise ValueError(f"invalid_jsonl_line_{line_number}") from None
                if not isinstance(row, dict):
                    raise ValueError(f"non_object_jsonl_line_{line_number}")
                rows.append(row)
    except (OSError, UnicodeError):
        raise ValueError("file_unavailable_or_invalid_utf8") from None
    return rows


def case_map(rows: list[dict[str, Any]], source: str) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for row in rows:
        case = row.get("case")
        if not isinstance(case, str) or not case:
            raise ValueError(f"{source}_case_invalid")
        if case in indexed:
            raise ValueError(f"{source}_case_duplicate")
        indexed[case] = row
    return indexed


def equivalent(field: str, expected: Any, actual: Any) -> bool:
    if field in ARRAY_FIELDS and isinstance(expected, list) and isinstance(actual, list):
        return sorted(expected) == sorted(actual)
    return expected == actual


def compare(fixtures: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    expected_by_case = case_map(fixtures, "fixture")
    results_by_case = case_map(results, "result")
    mismatches: list[dict[str, Any]] = []

    for case, fixture in expected_by_case.items():
        expected = fixture.get("expected")
        if not isinstance(expected, dict) or not expected or not set(expected).issubset(LABEL_FIELDS):
            raise ValueError("fixture_expected_schema")
        record = results_by_case.get(case)
        if record is None:
            mismatches.append({"case": case, "fields": ["missing_result"]})
            continue
        if record.get("status") != "ok" or not isinstance(record.get("result"), dict):
            mismatches.append({"case": case, "fields": ["status"]})
            continue
        actual = record["result"]
        different = [
            field for field in LABEL_FIELDS
            if field in expected and not equivalent(field, expected[field], actual.get(field))
        ]
        if different:
            mismatches.append({"case": case, "fields": different})

    for case in results_by_case.keys() - expected_by_case.keys():
        mismatches.append({"case": case, "fields": ["unexpected_result"]})

    return {
        "fixture_count": len(fixtures),
        "result_count": len(results),
        "ok_result_count": sum(row.get("status") == "ok" for row in results),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", required=True, type=pathlib.Path)
    parser.add_argument("--results", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        report = compare(read_jsonl(args.fixtures), read_jsonl(args.results))
    except ValueError as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        return 2
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    return 0 if report["mismatch_count"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
