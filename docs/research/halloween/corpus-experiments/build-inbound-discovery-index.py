#!/usr/bin/env python3
"""Index the already-published, anonymized 125-case review; never read raw mail."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def without_case(row):
    return {key: value for key, value in row.items() if key != "case"}


def split_context(row):
    prior = {key: row[key] for key in ("earlier_count", "prior_effect") if key in row}
    later = {key: value for key, value in row.items() if key not in {"case", *prior}}
    return prior, later


def target_projection(case):
    """Give downstream readers a stable envelope without inventing common labels."""
    target = case["target"]
    lane = case["review_lane"]
    if lane == 1:
        return {
            "request_codes": [target["target_type"]],
            "field_or_context_codes": target["subtype"],
            "reviewer_notes_or_limits": None,
            "confidence_as_recorded": target["confidence"],
        }
    if lane == 2:
        return {
            "request_codes": target["current"]["task_kinds"],
            "field_or_context_codes": target["current"]["field_families"],
            "reviewer_notes_or_limits": target["notes"],
            "confidence_as_recorded": target["confidence"],
        }
    return {
        "request_codes": [target["kind"]],
        "field_or_context_codes": target["fields"],
        "reviewer_notes_or_limits": target["limits"],
        "confidence_as_recorded": None,
    }


def main():
    lane1 = read("2026-10-31-amend-lane1-review.json")
    lane2 = read("2026-10-31-amend-lane2-review.json")
    coordinator = read("2026-10-31-amend-context-pilot.json")
    cases = {}

    for row in lane1["cases"]:
        case = row["case"]
        assert case not in cases
        cases[case] = {
            "case": case,
            "review_lane": 1,
            "target": without_case(row["target_only"]),
            "prior_thread": without_case(row["earlier_context"]) if row["earlier_context"] else None,
            "later_thread": without_case(row["later_observations"]) if row["later_observations"] else None,
        }

    # The frozen lane-2 ordinal is the one-based position in sorted target-2.jsonl.
    # Sampler assigns A001,A002,A003 to lanes 1,2,3, repeating in that order.
    for ordinal, row in enumerate(lane2["cases"], 1):
        assert row["case_index"] == ordinal
        case = f"A{3 * ordinal - 1:03}"
        assert case not in cases
        cases[case] = {
            "case": case,
            "review_lane": 2,
            "target": {key: row[key] for key in ("current", "quoted_in_target", "confidence", "visibility", "notes")},
            "prior_thread": row["prior_context"],
            "later_thread": row["later_followup"],
        }

    lane3_context = {row["case"]: row for row in coordinator["context_review"]["additional_cases"]}
    for row in coordinator["additional_target_only_cases"]["cases"]:
        case = row["case"]
        assert case not in cases and case in lane3_context
        prior, later = split_context(lane3_context[case])
        cases[case] = {
            "case": case,
            "review_lane": 3,
            "target": without_case(row),
            "prior_thread": prior,
            "later_thread": later,
        }

    # These 12 coordinator reviews overlap lane 1; preserve both rather than
    # silently resolving differences or counting them as extra cases.
    coordinator_context = {row["case"]: row for row in coordinator["context_review"]["cases"]}
    for row in coordinator["cases"]:
        case = row["case"]
        prior, later = split_context(coordinator_context[case])
        cases[case]["additional_coordinator_review"] = {
            "target": without_case(row), "prior_thread": prior, "later_thread": later
        }
    for row in coordinator["recovered_prefix_review"]["cases"]:
        cases[row["case"]]["recovered_prefix_review"] = without_case(row)
    correction = lane1["independent_review"]
    cases[correction["case"]]["post_freeze_correction"] = without_case(correction)
    for case in cases.values():
        case["target_projection"] = target_projection(case)

    expected = {f"A{index:03}" for index in range(1, 126)}
    assert set(cases) == expected
    assert sum("additional_coordinator_review" in case for case in cases.values()) == 12
    result = {
        "schema": "hms-inbound-discovery-index-v2",
        "sample": {
            "case_count": 125,
            "window": "2026-09-28 through 2026-10-29",
            "design": "Stratified fixed-seed discovery sample; 125 separate threads, not representative prevalence.",
            "stages": "Target review frozen first; earlier context and later same-thread observations separate.",
            "limits": [
                "Lossy privacy redaction; original selected requests may be misread or withheld.",
                "No inbound attachment contents or independent current-HMS truth in this sample.",
                "Later staff text can reflect another message; it is not proof of a saved HMS or money outcome.",
                "Censored or absent replies do not establish that no response occurred.",
                "These case notes are evidence for tool discovery, not production accuracy or policy.",
                "Target projections provide a stable envelope but preserve different reviewer vocabularies; do not aggregate their codes as a shared ontology.",
            ],
            "source_reviews": [
                "2026-10-31-amend-lane1-review.json",
                "2026-10-31-amend-lane2-review.json",
                "2026-10-31-amend-context-pilot.json",
            ],
            "separate_experiments": [
                "2026-10-31-attachment-context-pilot.json",
                "2026-10-31-recovered-prefix-screen.json",
            ],
        },
        "cases": [cases[case] for case in sorted(cases)],
    }
    output = ROOT / "2026-10-31-inbound-discovery-index.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(result['cases'])} anonymized case records to {output.name}")


if __name__ == "__main__":
    main()
