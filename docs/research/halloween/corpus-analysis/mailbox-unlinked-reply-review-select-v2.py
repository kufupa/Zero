#!/usr/bin/env python3
"""Prepare a hashed review set from final labels and full enriched packets.

Packet JSONL rows carry ``case``, ``_source``, ``inbound``, and every
``candidate_replies`` item. A separate classification JSONL may carry
``{case, classification}`` rows or runner result rows; when omitted, labels
must be embedded as ``classification`` in each packet row. Outbound result
rows supply the optional independently estimated message type. This script
selects actionable no-link cases with at least one direct-header or same-thread
candidate, preserves every candidate, and never edits a classification.
"""

from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import importlib.util
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRIVATE = ROOT / ".private"
PROMPT_DEFAULT = HERE / "2026-11-02-centurion-opportunity-prompt-v18-reply-review.md"


def _load_overlay():
    spec = importlib.util.spec_from_file_location("reply_overlay_for_selector", HERE / "mailbox-reply-review-overlay.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("reply-review overlay helper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


overlay = _load_overlay()
runner = overlay.runner


def _digest(value: Any) -> str:
    return hashlib.sha256(runner._canonical_json(value).encode("utf-8")).hexdigest()


def _classification(row: dict[str, Any], case: str) -> dict[str, Any]:
    value = row.get("classification", row.get("result", row))
    if not isinstance(value, dict) or value.get("case") != case:
        raise overlay.OverlayError("classification_row_invalid")
    if row.get("status") is not None and row.get("status") != "ok":
        raise overlay.OverlayError("classification_result_not_ok")
    if row.get("model") is not None and row.get("model") != runner.MODEL:
        raise overlay.OverlayError("classification_model_mismatch")
    if row.get("effort") is not None and row.get("effort") != "medium":
        raise overlay.OverlayError("classification_effort_mismatch")
    return value


def _class_map(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    if rows and all("attempt" in row and "status" in row for row in rows):
        rows = list(overlay._latest(rows).values())
    for row in rows:
        case = row.get("case")
        if not isinstance(case, str) or case in seen:
            raise overlay.OverlayError("classification_case_duplicate_or_invalid")
        seen.add(case)
        if "classification" in row and row["classification"] is None:
            if (row.get("processing") or {}).get("status") not in ("provider_blocked", "withheld_sensitive"):
                raise overlay.OverlayError("classification_unexplained_null")
            continue
        if row.get("status") is not None and row.get("status") != "ok":
            raise overlay.OverlayError("classification_result_not_ok")
        result[case] = _classification(row, case)
    return result


def _outbound_map(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if rows and all("attempt" in row and "status" in row for row in rows):
        return overlay._latest(rows)
    result: dict[str, Any] = {}
    for row in rows:
        case = row.get("case")
        if not isinstance(case, str) or case in result:
            raise overlay.OverlayError("outbound_case_duplicate_or_invalid")
        result[case] = row
    return result


def _packet_rows(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    packets, embedded = {}, {}
    for row in rows:
        case = row.get("case")
        if not isinstance(case, str) or case in packets:
            raise overlay.OverlayError("packet_case_duplicate_or_invalid")
        packet = {key: copy.deepcopy(value) for key, value in row.items() if key != "classification"}
        if not isinstance(packet.get("inbound"), dict) or not isinstance(packet.get("candidate_replies", []), list):
            raise overlay.OverlayError("full_packet_invalid")
        packets[case] = packet
        if "classification" in row:
            if row["classification"] is None:
                if (row.get("processing") or {}).get("status") not in ("provider_blocked", "withheld_sensitive"):
                    raise overlay.OverlayError("classification_unexplained_null")
            else:
                embedded[case] = _classification(row, case)
    return packets, embedded


def select_review_inputs(full_packet_map: Mapping[str, dict[str, Any]],
                         classification_map: Mapping[str, dict[str, Any]],
                         outbound_result_map: Mapping[str, Any], prompt_path: str | Path,
                         *, requested_cases: set[str] | None = None,
                         max_cases: int | None = None,
                         include_indirect: bool = False,
                         input_file_hashes: Mapping[str, str] | None = None):
    """Return model packets and per-case source/projection hashes without mutation."""
    packets = dict(full_packet_map)
    classes = dict(classification_map)
    if not set(classes).issubset(packets):
        raise overlay.OverlayError("classification_packet_missing")
    if requested_cases is not None and not requested_cases.issubset(classes):
        raise overlay.OverlayError("requested_case_missing_or_unclassified")
    _, _, prompt_sha256 = overlay._resolve_prompt(prompt_path)
    selected, audit = [], []
    counts = collections.Counter()
    for case in sorted(classes):
        if requested_cases is not None and case not in requested_cases:
            continue
        packet = packets[case]
        classification = classes[case]
        if not isinstance(packet, dict) or packet.get("case") != case:
            raise overlay.OverlayError("full_packet_case_mismatch")
        if not isinstance(classification, dict) or classification.get("case") != case:
            raise overlay.OverlayError("classification_case_mismatch")
        actions = classification.get("actions")
        reply_ids = classification.get("reply_ids")
        if not isinstance(actions, list) or not isinstance(reply_ids, list):
            raise overlay.OverlayError("classification_fields_invalid")
        if classification.get("reservation_email") is not True or reply_ids:
            continue
        candidates = packet.get("candidate_replies") or []
        if not isinstance(candidates, list):
            raise overlay.OverlayError("packet_candidates_invalid")
        if not candidates:
            continue
        if not include_indirect and not any(
                candidate.get("direct_header_match") or candidate.get("same_thread")
                for candidate in candidates if isinstance(candidate, dict)):
            continue

        typed_candidates = []
        types_for_hash = []
        high_signal_types = collections.Counter()
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise overlay.OverlayError("packet_candidate_invalid")
            candidate_copy = copy.deepcopy(candidate)
            message_type = overlay._outbound_type(outbound_result_map, candidate.get("outbound_case"))
            previous_type = candidate.get("outbound_message_type")
            if previous_type is not None and previous_type != message_type:
                raise overlay.OverlayError("source_outbound_type_mismatch")
            candidate_copy["outbound_message_type"] = message_type
            typed_candidates.append(candidate_copy)
            types_for_hash.append({"reply_id": candidate.get("reply_id"),
                                   "outbound_case": candidate.get("outbound_case"),
                                   "outbound_message_type": message_type})
            if candidate.get("direct_header_match") or candidate.get("same_thread"):
                high_signal_types[message_type] += 1

        review_packet = {**copy.deepcopy(packet), "candidate_replies": typed_candidates}
        model_input = runner._project_inbound(review_packet)
        selection = {
            "case": case,
            "candidate_count": len(typed_candidates),
            "include_indirect": include_indirect,
            "direct_or_same_thread_count": sum(
                bool(c.get("direct_header_match") or c.get("same_thread")) for c in typed_candidates
            ),
            "staff_candidate_count": high_signal_types["staff_written"],
            "pms_candidate_count": high_signal_types["pms_confirmation_template"],
            "packet_sha256": _digest(packet),
            "classification_sha256": _digest(classification),
            "outbound_types_sha256": _digest(types_for_hash),
            "projected_input_sha256": _digest(model_input),
            "prompt_sha256": prompt_sha256,
            "input_file_sha256": dict(input_file_hashes or {}),
        }
        selected.append(review_packet)
        audit.append(selection)
        counts["selected"] += 1
        counts["with_staff_candidate"] += high_signal_types["staff_written"] > 0
        counts["with_pms_candidate"] += high_signal_types["pms_confirmation_template"] > 0
    if max_cases is not None:
        selected, audit = selected[:max_cases], audit[:max_cases]
        counts = collections.Counter()
        counts["selected"] = len(selected)
        counts["with_staff_candidate"] = sum(row["staff_candidate_count"] > 0 for row in audit)
        counts["with_pms_candidate"] = sum(row["pms_candidate_count"] > 0 for row in audit)
    counts["packet_without_final_classification"] = len(set(packets) - set(classes))
    return selected, audit, dict(counts)


def _file_hash(path: Path) -> str:
    safe = overlay._private_file(path, "selector_input")
    raw = overlay.pilot._read_limited_private(safe, "selector_input", runner.MAX_FILE_BYTES)
    return hashlib.sha256(raw).hexdigest()


def _write_private(path: Path, rows: list[dict[str, Any]]) -> None:
    overlay._private_file(path, "selector_output", must_exist=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packets", type=Path,
                        help="full attachment-enriched packet JSONL under .private")
    parser.add_argument("--classifications", type=Path,
                        help="final labels JSONL; omit when classification is embedded in each packet")
    parser.add_argument("--outbound-results", type=Path)
    parser.add_argument("--prompt", type=Path, default=PROMPT_DEFAULT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--case", action="append", default=[], dest="cases")
    parser.add_argument("--max-cases", type=int)
    parser.add_argument("--include-indirect", action="store_true",
                        help="also review cross-thread recipient/time candidates")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps(self_test(), sort_keys=True))
        return
    if not all((args.packets, args.outbound_results, args.output, args.selection)):
        parser.error("--packets, --outbound-results, --output and --selection are required")
    if args.max_cases is not None and args.max_cases < 1:
        parser.error("--max-cases must be positive")

    packet_rows = overlay._read_jsonl(args.packets, "selector_packets")
    packets, embedded = _packet_rows(packet_rows)
    class_rows = overlay._read_jsonl(args.classifications, "selector_classifications") if args.classifications else []
    classes = _class_map(class_rows) if class_rows else embedded
    if not classes:
        parser.error("provide --classifications or embedded classification objects")
    if embedded and any(embedded.get(case) != classes.get(case) for case in embedded):
        raise overlay.OverlayError("embedded_classification_mismatch")
    outbound_rows = overlay._read_jsonl(args.outbound_results, "selector_outbound_results")
    outbound = _outbound_map(outbound_rows)

    if class_rows:
        raw_by_case = {row.get("case"): row for row in class_rows}
        for case, row in raw_by_case.items():
            if row.get("input_sha256"):
                if case not in packets or row["input_sha256"] != _digest(runner._project_inbound(packets[case])):
                    raise overlay.OverlayError("classification_projected_input_hash_mismatch")

    file_hashes = {"packets": _file_hash(args.packets),
                   "classifications": _file_hash(args.classifications) if args.classifications else _digest(classes),
                   "outbound_results": _file_hash(args.outbound_results)}
    selected, audit, counts = select_review_inputs(
        packets, classes, outbound, args.prompt,
        requested_cases=set(args.cases) if args.cases else None,
        max_cases=args.max_cases, include_indirect=args.include_indirect, input_file_hashes=file_hashes,
    )
    _write_private(args.output, selected)
    _write_private(args.selection, audit)
    print(json.dumps(counts, sort_keys=True))


def self_test() -> dict[str, str]:
    packet = {"case": "I90001", "_source": {"row_ids": ["r1"]},
              "inbound": {"date": "2026-10-01T00:00:00Z", "from": ["guest@example.test"],
                          "subject": "Stay", "message": "Please confirm.",
                          "quoted_context": "", "attachment_context": "voucher metadata"},
              "candidate_replies": [
                  {"reply_id": "R1", "outbound_case": "O90001", "direct_header_match": True,
                   "same_thread": True, "minutes_after_inbound": 10, "from": ["staff@example.test"],
                   "to": ["guest@example.test"], "subject": "Stay", "body": "Confirmed."},
                  {"reply_id": "R2", "outbound_case": "O90002", "direct_header_match": False,
                   "same_thread": False, "minutes_after_inbound": 15, "from": ["staff@example.test"],
                   "to": ["guest@example.test"], "subject": "Other stay", "body": "See attached."},
              ]}
    classification = {"case": "I90001", "reservation_email": True, "can_help": True,
                      "actions": ["booking"], "reply_ids": [], "response_type": "none_linked",
                      "invoice_handling": "not_invoice", "evidence_source": "inbound",
                      "evidence": "", "reason": "synthetic"}
    outbound = {"O90001": {"case": "O90001", "message_type": "staff_written"},
                "O90002": {"case": "O90002", "message_type": "pms_confirmation_template"}}
    before = copy.deepcopy(packet)
    selected, audit, counts = select_review_inputs(
        {"I90001": packet}, {"I90001": classification}, outbound, PROMPT_DEFAULT,
    )
    assert len(selected) == 1 and len(selected[0]["candidate_replies"]) == 2
    assert selected[0]["candidate_replies"][0]["outbound_message_type"] == "staff_written"
    assert selected[0]["candidate_replies"][1]["outbound_message_type"] == "pms_confirmation_template"
    assert packet == before and audit[0]["projected_input_sha256"]
    indirect = copy.deepcopy(packet)
    indirect["candidate_replies"] = [indirect["candidate_replies"][1]]
    without, _, _ = select_review_inputs({"I90001": indirect}, {"I90001": classification},
                                         outbound, PROMPT_DEFAULT)
    with_indirect, _, _ = select_review_inputs({"I90001": indirect}, {"I90001": classification},
                                               outbound, PROMPT_DEFAULT, include_indirect=True)
    assert not without and len(with_indirect) == 1
    blocked = {"case": "I90002", "classification": None,
               "processing": {"status": "provider_blocked"}}
    assert _class_map([blocked]) == {}
    return {"full_packet_preserved": "passed", "all_candidates_typed": "passed",
            "input_hashes_recorded": "passed", "indirect_opt_in": "passed",
            "provider_block_skipped": "passed"}


if __name__ == "__main__":
    main()
