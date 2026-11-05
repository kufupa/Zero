#!/usr/bin/env python3
"""Select actionable no-link packets that already contain direct/thread replies.

This prepares a review input only. It does not change classifications or decide
whether any candidate matches; the frozen reply-review prompt makes that call.
"""

import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
PRIVATE = ROOT / ".private"
VALID_TYPES = {
    "staff_written", "pms_confirmation_template", "other_automated", "other", "unknown",
}
_runner_spec = importlib.util.spec_from_file_location("reply_review_runner", HERE / "luna-corpus-runner.py")
if _runner_spec is None or _runner_spec.loader is None:
    raise RuntimeError("runner helper unavailable")
runner = importlib.util.module_from_spec(_runner_spec)
_runner_spec.loader.exec_module(runner)


def read_jsonl(path: Path) -> list[dict]:
    """Read LF-delimited JSONL without splitting literal U+2028 in JSON strings."""
    if path.is_symlink() or not path.resolve().is_relative_to(PRIVATE.resolve()):
        raise ValueError("input must be a regular file under .private")
    with path.open(encoding="utf-8") as source:
        rows = [json.loads(line) for line in source if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("JSONL rows must be objects")
    return rows


def unique(rows: list[dict], label: str) -> dict[str, dict]:
    by_case = {row.get("case"): row for row in rows}
    if len(by_case) != len(rows) or any(not isinstance(case, str) for case in by_case):
        raise ValueError(f"duplicate or invalid {label} case")
    return by_case


def latest(records: list[dict], label: str) -> dict[str, dict]:
    by_case: dict[str, dict] = {}
    for row in records:
        case = row.get("case")
        if not isinstance(case, str):
            raise ValueError(f"invalid {label} case")
        old = by_case.get(case)
        expected_attempt = old.get("attempt", 0) + 1 if old else 1
        if row.get("attempt") != expected_attempt or (old and old.get("status") != "failed"):
            raise ValueError(f"invalid {label} retry order")
        by_case[case] = row
    return by_case


def verify_result_inputs(packets: dict[str, dict], results: dict[str, dict],
                         direction: str) -> None:
    project = runner._project_inbound if direction == "inbound" else runner._project_outbound
    for case, record in results.items():
        packet = packets.get(case)
        if packet is None:
            raise ValueError(f"{direction} result case is absent from inputs")
        if record.get("status") != "ok":
            continue
        if record.get("model") != "gpt-6-luna" or record.get("effort") != "medium":
            raise ValueError(f"{direction} result model/effort mismatch")
        digest = hashlib.sha256(runner._canonical_json(project(packet)).encode("utf-8")).hexdigest()
        if record.get("input_sha256") != digest:
            raise ValueError(f"{direction} result input hash mismatch")


def private_write(path: Path, rows: list[dict]) -> None:
    if path.is_symlink() or not path.resolve().is_relative_to(PRIVATE.resolve()):
        raise ValueError("output must be a new file under .private")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def select(packets: dict[str, dict], results: dict[str, dict], outbound_results: dict[str, dict],
           requested: set[str] | None = None, max_cases: int | None = None):
    selected, audit = [], []
    counts = collections.Counter()
    for case in sorted(results):
        record = results[case]
        if record.get("status") != "ok" or case not in packets:
            continue
        if requested is not None and case not in requested:
            continue
        classification = record.get("result") or {}
        if classification.get("reservation_email") is not True or classification.get("reply_ids"):
            continue
        packet = packets[case]
        candidates = packet.get("candidate_replies") or []
        high_signal = [candidate for candidate in candidates
                       if candidate.get("direct_header_match") or candidate.get("same_thread")]
        if not high_signal:
            continue
        annotated = []
        type_counts = collections.Counter()
        for candidate in candidates:
            outbound_case = candidate.get("outbound_case")
            outbound = outbound_results.get(outbound_case)
            message_type = (outbound or {}).get("result", {}).get("message_type")
            if not outbound or outbound.get("status") != "ok" or message_type not in VALID_TYPES:
                raise ValueError("candidate outbound result is missing or invalid")
            annotated.append({**candidate, "outbound_message_type": message_type})
            if candidate.get("direct_header_match") or candidate.get("same_thread"):
                type_counts[message_type] += 1
        staff = type_counts["staff_written"]
        pms = type_counts["pms_confirmation_template"]
        selected.append({**packet, "candidate_replies": annotated})
        audit.append({"case": case, "candidate_count": len(candidates),
                      "direct_or_same_thread_count": len(high_signal),
                      "staff_candidate_count": staff, "pms_candidate_count": pms})
        counts["selected"] += 1
        counts["with_staff_candidate"] += staff > 0
        counts["with_pms_candidate"] += pms > 0
    if requested is not None and not requested.issubset(packets):
        raise ValueError("requested case is absent from input packets")
    if max_cases is not None:
        selected, audit = selected[:max_cases], audit[:max_cases]
        counts = collections.Counter()
        counts["selected"] = len(selected)
        counts["with_staff_candidate"] = sum(row["staff_candidate_count"] > 0 for row in audit)
        counts["with_pms_candidate"] = sum(row["pms_candidate_count"] > 0 for row in audit)
    return selected, audit, dict(counts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inbound", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--outbound", type=Path, required=True)
    parser.add_argument("--outbound-results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[], dest="cases")
    parser.add_argument("--max-cases", type=int)
    args = parser.parse_args()
    if args.max_cases is not None and args.max_cases < 1:
        parser.error("--max-cases must be positive")

    packets = unique(read_jsonl(args.inbound), "inbound")
    outbound_packets = unique(read_jsonl(args.outbound), "outbound")
    results = latest(read_jsonl(args.results), "inbound result")
    outbound_results = latest(read_jsonl(args.outbound_results), "outbound result")
    verify_result_inputs(packets, results, "inbound")
    verify_result_inputs(outbound_packets, outbound_results, "outbound")
    selected, audit, counts = select(
        packets, results, outbound_results,
        requested=set(args.cases) if args.cases else None,
        max_cases=args.max_cases,
    )
    private_write(args.output, selected)
    private_write(args.selection, audit)
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
