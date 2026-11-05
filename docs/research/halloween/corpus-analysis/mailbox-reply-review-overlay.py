#!/usr/bin/env python3
"""Validate and apply a reply-only Luna review overlay.

API contract:
* ``inbound_packet_map`` maps case IDs to the full source packets.
* ``current_classification_map`` maps case IDs to mutable classification dicts.
* ``outbound_result_map`` maps outbound case IDs to validated outbound result
  objects, full runner records, or bare allowed ``message_type`` strings.

All review rows/results are validated as a complete batch before any class map
mutation. Validated ``outbound_message_type`` annotations from the projected
review packets are preserved on source candidate packets in the same staged
transaction. Only reply_ids/response_type are overlaid on classifications;
invoice_handling is also eligible when both action sets contain invoice.
Invoice labels remain model judgments and are not proof of delivery.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import stat
import tempfile
from collections.abc import Mapping, MutableMapping
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRIVATE = ROOT / ".private"
PROMPT_DEFAULT = HERE / "2026-11-02-centurion-opportunity-prompt-v18-reply-review.md"
OUTBOUND_TYPES = {
    "staff_written", "pms_confirmation_template", "other_automated", "other", "unknown",
}


class OverlayError(ValueError):
    """Safe, content-free input or identity failure."""


def _load_runner():
    spec = importlib.util.spec_from_file_location("reply_overlay_runner", HERE / "luna-corpus-runner.py")
    if spec is None or spec.loader is None:
        raise OverlayError("runner_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load_runner()
pilot = runner._load_pilot_helper()


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json_sha256(value: Any) -> str:
    return _sha256(runner._canonical_json(value).encode("utf-8"))


def _private_file(path_value: str | Path, label: str, *, must_exist: bool = True) -> Path:
    try:
        return runner._validate_private_path(path_value, PRIVATE, must_exist=must_exist)
    except Exception:
        raise OverlayError(f"{label}_path_invalid") from None


def _read_jsonl(path_value: str | Path, label: str) -> list[dict[str, Any]]:
    path = _private_file(path_value, label)
    try:
        raw = pilot._read_limited_private(path, label, runner.MAX_FILE_BYTES)
        rows = runner._decode_jsonl_strict(pilot, raw, f"{label}_invalid_jsonl")
    except Exception:
        raise OverlayError(f"{label}_unreadable") from None
    if any(not isinstance(row, dict) for row in rows):
        raise OverlayError(f"{label}_row_invalid")
    return rows


def _resolve_prompt(path_value: str | Path) -> tuple[Path, bytes, str]:
    path = Path(path_value)
    if not path.is_absolute():
        path = HERE / path
    try:
        resolved = path.resolve(strict=True)
        if path.is_symlink() or not resolved.is_relative_to(HERE) or not resolved.is_file():
            raise OverlayError("prompt_path_invalid")
        raw = resolved.read_bytes()
        raw.decode("utf-8")
    except OverlayError:
        raise
    except Exception:
        raise OverlayError("prompt_unavailable") from None
    if not raw.strip():
        raise OverlayError("prompt_empty")
    return resolved, raw, _sha256(raw)


def _latest(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in records:
        case = record.get("case")
        attempt = record.get("attempt")
        if not isinstance(case, str) or not case or not isinstance(attempt, int) or isinstance(attempt, bool):
            raise OverlayError("result_record_invalid")
        previous = latest.get(case)
        expected_attempt = previous["attempt"] + 1 if previous else 1
        if attempt != expected_attempt or (previous and previous.get("status") != "failed"):
            raise OverlayError("result_retry_order_invalid")
        if record.get("status") not in {"ok", "failed", "withheld"}:
            raise OverlayError("result_status_invalid")
        latest[case] = record
    return latest


def _map_by_case(value: Mapping[str, Any], label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise OverlayError(f"{label}_map_invalid")
    copied = dict(value)
    if any(not isinstance(case, str) or not case for case in copied):
        raise OverlayError(f"{label}_case_invalid")
    return copied


def _outbound_type(outbound_result_map: Mapping[str, Any], outbound_case: Any) -> str:
    if not isinstance(outbound_case, str) or outbound_case not in outbound_result_map:
        raise OverlayError("outbound_result_missing")
    value = outbound_result_map[outbound_case]
    if isinstance(value, str):
        message_type = value
    elif isinstance(value, Mapping):
        if value.get("case", outbound_case) != outbound_case:
            raise OverlayError("outbound_result_case_mismatch")
        if value.get("status", "ok") != "ok":
            raise OverlayError("outbound_result_not_ok")
        if value.get("model", "gpt-6-luna") != "gpt-6-luna" or value.get("effort", "medium") != "medium":
            raise OverlayError("outbound_result_model_mismatch")
        result = value.get("result", value)
        if not isinstance(result, Mapping):
            raise OverlayError("outbound_result_invalid")
        if result.get("case", outbound_case) != outbound_case:
            raise OverlayError("outbound_result_case_mismatch")
        message_type = result.get("message_type")
    else:
        raise OverlayError("outbound_result_invalid")
    if message_type not in OUTBOUND_TYPES:
        raise OverlayError("outbound_message_type_invalid")
    return message_type


def _verify_packet_projection(base: dict[str, Any], review: dict[str, Any],
                              outbound_result_map: Mapping[str, Any]) -> None:
    case = base.get("case")
    if review.get("case") != case:
        raise OverlayError("review_case_mismatch")
    if set(base) != set(review):
        raise OverlayError("review_packet_fields_changed")
    for key in set(base) - {"candidate_replies"}:
        if base[key] != review[key]:
            raise OverlayError("review_source_or_inbound_changed")

    base_candidates = base.get("candidate_replies") or []
    review_candidates = review.get("candidate_replies") or []
    if not isinstance(base_candidates, list) or not isinstance(review_candidates, list):
        raise OverlayError("review_candidates_invalid")
    if len(base_candidates) != len(review_candidates):
        raise OverlayError("review_candidates_changed")
    for original, reviewed in zip(base_candidates, review_candidates, strict=True):
        if not isinstance(original, dict) or not isinstance(reviewed, dict):
            raise OverlayError("review_candidate_invalid")
        original_plain = {k: v for k, v in original.items() if k != "outbound_message_type"}
        reviewed_plain = {k: v for k, v in reviewed.items() if k != "outbound_message_type"}
        if original_plain != reviewed_plain:
            raise OverlayError("review_candidate_changed")
        expected = _outbound_type(outbound_result_map, original.get("outbound_case"))
        original_type = original.get("outbound_message_type")
        review_has_type = "outbound_message_type" in reviewed
        review_type = reviewed.get("outbound_message_type")
        if original_type is not None and original_type != expected:
            raise OverlayError("source_outbound_type_mismatch")
        if original_type is not None and (not review_has_type or review_type != original_type):
            raise OverlayError("review_outbound_type_removed_or_changed")
        if review_has_type and review_type != expected:
            raise OverlayError("review_outbound_type_unverified")


def _prompt_model_effort_sha256(prompt_sha256: str, effort: str) -> str:
    schema_sha256 = _sha256(runner._canonical_json(runner.INBOUND_SCHEMA).encode("utf-8"))
    identity = {"direction": "inbound", "model": runner.MODEL, "effort": effort,
                "prompt_sha256": prompt_sha256, "schema_sha256": schema_sha256}
    return _json_sha256(identity)


def _classification_values(value: Any, case: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("case") != case:
        raise OverlayError("current_classification_invalid")
    actions, reply_ids = value.get("actions"), value.get("reply_ids")
    if not isinstance(actions, list) or not isinstance(reply_ids, list):
        raise OverlayError("current_classification_invalid")
    if (any(not isinstance(action, str) or action not in runner.INBOUND_ACTIONS for action in actions)
            or any(not isinstance(reply_id, str) for reply_id in reply_ids)):
        raise OverlayError("current_classification_invalid")
    if len(set(actions)) != len(actions) or len(set(reply_ids)) != len(reply_ids):
        raise OverlayError("current_classification_duplicates")
    return value


def _audit_snapshot(value: Mapping[str, Any]) -> dict[str, Any]:
    return {key: copy.deepcopy(value.get(key)) for key in (
        "reservation_email", "can_help", "actions", "reply_ids", "response_type", "invoice_handling",
    )}


def apply(review_input_path: str | Path, review_results_path: str | Path,
          inbound_packet_map: Mapping[str, dict[str, Any]],
          current_classification_map: MutableMapping[str, dict[str, Any]],
          outbound_result_map: Mapping[str, Any], prompt_path: str | Path) -> dict[str, Any]:
    """Validate a full reply-review batch, then overlay only approved reply fields.

    ``current_classification_map`` is mutated only after every packet, result,
    outbound annotation, and prompt/input identity in the batch validates.
    Returns per-case before/after audit records plus applied/skipped case IDs.
    """
    packets = _map_by_case(inbound_packet_map, "inbound_packet")
    current = _map_by_case(current_classification_map, "current_classification")
    outbound = _map_by_case(outbound_result_map, "outbound_result")
    if not isinstance(current_classification_map, MutableMapping):
        raise OverlayError("current_classification_map_not_mutable")

    _, _, prompt_sha256 = _resolve_prompt(prompt_path)
    input_rows = _read_jsonl(review_input_path, "review_input")
    result_rows = _read_jsonl(review_results_path, "review_results")
    review_by_case = {row.get("case"): row for row in input_rows}
    if len(review_by_case) != len(input_rows) or any(not isinstance(case, str) for case in review_by_case):
        raise OverlayError("review_input_duplicate_or_invalid_case")
    latest = _latest(result_rows)
    if set(latest) != set(review_by_case):
        raise OverlayError("review_results_case_set_mismatch")

    validated_results: dict[str, dict[str, Any]] = {}
    packet_updates: dict[str, dict[str, Any]] = {}
    packet_annotation_changes: dict[str, list[dict[str, Any]]] = {}
    for case, review_packet in review_by_case.items():
        if case not in packets or case not in current:
            raise OverlayError("review_case_missing_source_or_classification")
        base_packet = packets[case]
        if not isinstance(base_packet, dict) or base_packet.get("case") != case:
            raise OverlayError("source_packet_invalid")
        _verify_packet_projection(base_packet, review_packet, outbound)
        packet_copy = copy.deepcopy(base_packet)
        annotation_changes = []
        for original, reviewed in zip(base_packet.get("candidate_replies") or [],
                                      review_packet.get("candidate_replies") or [], strict=True):
            if "outbound_message_type" not in reviewed:
                continue
            message_type = reviewed["outbound_message_type"]
            previous_type = original.get("outbound_message_type")
            if previous_type != message_type:
                for staged_candidate in packet_copy["candidate_replies"]:
                    if staged_candidate.get("reply_id") == original.get("reply_id"):
                        staged_candidate["outbound_message_type"] = message_type
                        break
                annotation_changes.append({"reply_id": original.get("reply_id"),
                                          "outbound_case": original.get("outbound_case"),
                                          "prior": previous_type, "value": message_type})
        if annotation_changes:
            packet_updates[case] = packet_copy
        packet_annotation_changes[case] = annotation_changes
        model_input = runner._project_inbound(review_packet)
        record = latest[case]
        if record.get("status") != "ok":
            raise OverlayError("review_result_incomplete")
        if (record.get("version") != runner.VERSION or record.get("direction") != "inbound"
                or record.get("case") != case or record.get("model") != runner.MODEL
                or record.get("effort") != "medium"):
            raise OverlayError("review_result_identity_mismatch")
        if record.get("prompt_sha256") != prompt_sha256:
            raise OverlayError("review_prompt_hash_mismatch")
        if record.get("prompt_model_effort_sha256") != _prompt_model_effort_sha256(prompt_sha256, "medium"):
            raise OverlayError("review_prompt_model_effort_hash_mismatch")
        if record.get("input_sha256") != _json_sha256(model_input):
            raise OverlayError("review_projected_input_hash_mismatch")
        result = runner._validate_inbound_result({"results": [record.get("result")]}, model_input)
        ids = result["reply_ids"]
        if (bool(ids) == (result["response_type"] == "none_linked")):
            raise OverlayError("review_reply_response_type_inconsistent")
        validated_results[case] = result

    plan: dict[str, dict[str, Any]] = {}
    audit: list[dict[str, Any]] = []
    for case, review in validated_results.items():
        old = _classification_values(current[case], case)
        old_snapshot = _audit_snapshot(old)
        review_snapshot = _audit_snapshot(review)
        entry = {"case": case, "prior": old_snapshot, "review": review_snapshot,
                 "status": "skipped", "reason": None, "changed_fields": [],
                 "packet_annotation_changes": packet_annotation_changes.get(case, [])}
        if old.get("reservation_email") is not True or old.get("reply_ids"):
            entry["reason"] = "current_not_actionable_no_link"
        elif review.get("reservation_email") is not True:
            entry["reason"] = "review_non_actionable"
        elif set(old["actions"]) != set(review["actions"]):
            entry["reason"] = "action_meaning_conflict"
        elif not review["reply_ids"]:
            entry["reason"] = "review_found_no_matching_reply"
        else:
            updated = copy.deepcopy(old)
            updated["reply_ids"] = list(review["reply_ids"])
            updated["response_type"] = review["response_type"]
            changed = [field for field in ("reply_ids", "response_type")
                       if updated.get(field) != old.get(field)]
            if "invoice" in old["actions"] and "invoice" in review["actions"]:
                if updated.get("invoice_handling") != review.get("invoice_handling"):
                    updated["invoice_handling"] = review["invoice_handling"]
                    changed.append("invoice_handling")
                    entry["invoice_handling_note"] = "review_model_label_only_not_delivery_proof"
            if changed:
                plan[case] = updated
                entry["status"] = "applied"
                entry["reason"] = "reply_fields_reviewed"
                entry["changed_fields"] = changed
            else:
                entry["reason"] = "review_values_unchanged"
        audit.append(entry)

    # All validation and planning is complete. Ensure both destinations are
    # writable before mutating either, then commit packet annotations and reply
    # fields together so downstream reviewers see the same candidate evidence.
    if packet_updates and not isinstance(inbound_packet_map, MutableMapping):
        raise OverlayError("inbound_packet_map_not_mutable_for_annotations")
    for case, packet in packet_updates.items():
        inbound_packet_map[case] = packet
    for case, updated in plan.items():
        current_classification_map[case] = updated
    return {"applied": sorted(plan), "skipped": sorted(set(validated_results) - set(plan)),
            "packet_annotated": sorted(packet_updates),
            "audit": audit}


def _write_private(path: Path, rows: list[dict[str, Any]]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def self_test() -> dict[str, Any]:
    """Offline synthetic coverage for overlays, action conflicts and tampering."""
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="reply-overlay-self-test-", dir=PRIVATE) as temp:
        directory = Path(temp)
        prompt_path = PROMPT_DEFAULT
        _, _, prompt_hash = _resolve_prompt(prompt_path)
        base = {"case": "I00001", "_source": {"row_ids": ["synthetic"]},
                "inbound": {"date": "2026-10-01T00:00:00Z", "from": ["agent@example.test"],
                            "subject": "Invoice request", "message": "Please send the stay invoice.",
                            "quoted_context": "", "attachment_context": "synthetic metadata"},
                "candidate_replies": [{"reply_id": "R1", "outbound_case": "O00001",
                                        "direct_header_match": True, "same_thread": True,
                                        "minutes_after_inbound": 10, "from": ["hotel@example.test"],
                                        "to": ["agent@example.test"], "subject": "Invoice request",
                                        "body": "Please see attached.",
                                        "confirmation_pdf_filename": None}]}
        reviewed_base = copy.deepcopy(base)
        reviewed_base["candidate_replies"][0]["outbound_message_type"] = "staff_written"
        conflict = copy.deepcopy(base)
        conflict["case"] = "I00002"
        reviewed_conflict = copy.deepcopy(reviewed_base)
        reviewed_conflict["case"] = "I00002"
        current = {
            "I00001": {"case": "I00001", "reservation_email": True, "can_help": True,
                        "actions": ["invoice"], "reply_ids": [], "response_type": "none_linked",
                        "invoice_handling": "invoice_no_reply", "evidence_source": "inbound",
                        "evidence": "", "reason": "current invoice request"},
            "I00002": {"case": "I00002", "reservation_email": True, "can_help": True,
                        "actions": ["booking"], "reply_ids": [], "response_type": "none_linked",
                        "invoice_handling": "not_invoice", "evidence_source": "inbound",
                        "evidence": "", "reason": "current booking request"},
        }
        packet_map = {"I00001": base, "I00002": conflict}
        outbound_map = {"O00001": {"case": "O00001", "message_type": "staff_written"}}
        good = runner._project_inbound(reviewed_base)
        conflict_input = runner._project_inbound(reviewed_conflict)
        def result(case: str, model_input: dict[str, Any], actions: list[str], actionable: bool = True):
            return {"case": case, "reservation_email": actionable, "can_help": actionable,
                    "actions": actions, "reply_ids": ["R1"] if actionable else [],
                    "response_type": "staff" if actionable else "none_linked",
                    "invoice_handling": "staff_invoice" if "invoice" in actions else "not_invoice",
                    "evidence_source": "reply" if actionable else "inbound",
                    "evidence": "Please see attached.", "reason": "synthetic reply review"}
        def record(case: str, model_input: dict[str, Any], reviewed: dict[str, Any]):
            return {"version": runner.VERSION, "direction": "inbound", "case": case,
                    "input_sha256": _json_sha256(model_input), "attempt": 1, "status": "ok",
                    "prompt_sha256": prompt_hash,
                    "prompt_model_effort_sha256": _prompt_model_effort_sha256(prompt_hash, "medium"),
                    "model": runner.MODEL, "effort": "medium", "endpoint_sha256": "a" * 64,
                    "result": reviewed}
        review_rows = [reviewed_base, reviewed_conflict]
        results = [record("I00001", good, result("I00001", good, ["invoice"])),
                   record("I00002", conflict_input, result("I00002", conflict_input, ["amendment"]))]
        input_path, result_path = directory / "input.jsonl", directory / "results.jsonl"
        _write_private(input_path, review_rows)
        _write_private(result_path, results)
        before = copy.deepcopy(current)
        output = apply(input_path, result_path, packet_map, current, outbound_map, prompt_path)
        assert output["applied"] == ["I00001"]
        assert output["packet_annotated"] == ["I00001", "I00002"]
        assert output["audit"][1]["reason"] == "action_meaning_conflict"
        assert output["audit"][0]["packet_annotation_changes"] == [
            {"reply_id": "R1", "outbound_case": "O00001", "prior": None,
             "value": "staff_written"}
        ]
        assert packet_map["I00001"]["candidate_replies"][0]["outbound_message_type"] == "staff_written"
        assert packet_map["I00002"]["candidate_replies"][0]["outbound_message_type"] == "staff_written"
        for field in ("reservation_email", "can_help", "actions", "evidence", "reason"):
            assert current["I00001"][field] == before["I00001"][field]
        assert current["I00001"]["reply_ids"] == ["R1"]
        assert current["I00001"]["invoice_handling"] == "staff_invoice"

        tampered = copy.deepcopy(review_rows)
        tampered[0]["inbound"]["message"] = "Changed after review."
        tampered_path = directory / "tampered.jsonl"
        _write_private(tampered_path, tampered)
        current_before_tamper = copy.deepcopy(current)
        packets_before_tamper = copy.deepcopy(packet_map)
        rejected = False
        try:
            apply(tampered_path, result_path, packet_map, current, outbound_map, prompt_path)
        except OverlayError:
            rejected = True
        assert rejected and current == current_before_tamper and packet_map == packets_before_tamper
        return {"synthetic_overlay": "passed", "action_conflict_skip": "passed",
                "tampered_input_rejected_before_mutation": "passed",
                "validated_packet_annotations_staged_and_audited": "passed"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test:
        parser.error("use as a module or pass --self-test")
    print(json.dumps(self_test(), sort_keys=True))
