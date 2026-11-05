#!/usr/bin/env python3
"""Offline re-normalizer for saved Centurion pilot development results.

This tool makes no model or HTTP calls. It verifies saved packets and records
against the pinned source, manifest, current prompt identity, endpoint hash,
and projected input before re-running the current local normalizer.

Example (use a new direct child of the owner-only .private directory):

    python3 -I -B docs/research/halloween/corpus-analysis/pilot-250-renormalize.py \
      --source .private/<pinned-source.jsonl> \
      --manifest .private/<frozen-manifest.json> \
      --input .private/<development-cleaned-subset.jsonl> \
      --assessments .private/<combined-development-results.jsonl> \
      --output-dir .private/<new-renormalized-run> \
      --endpoint-sha256 <lowercase-endpoint-sha256>

Run ``--self-test`` for synthetic-only checks; it does not open .private data.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import threading
from typing import Any


HELPER_VERSION = "centurion-pilot-renormalizer-v1"
RESULTS_NAME = "assessments.jsonl"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
REQUIRED_RESULT_FIELDS = frozenset({
    "version", "case_id", "phase", "arm", "round", "arm_pair_sha256",
    "slot", "model", "reasoning_effort", "input_sha256", "prompt_sha256",
    "endpoint_sha256", "status", "error_code", "usage", "http_attempts",
    "validation_counts", "parse_status", "normalized", "raw_output_text",
})


class SafeFailure(Exception):
    """Expected, sanitized failure; exception details never reach output."""

    def __init__(self, code: str) -> None:
        self.code = code if SAFE_CODE_RE.fullmatch(code) else "internal"
        super().__init__(self.code)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise SafeFailure("arguments_invalid")


def _safe_error_code(error: Exception, fallback: str) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and SAFE_CODE_RE.fullmatch(code) else fallback


def _load_review() -> Any:
    review_path = pathlib.Path(__file__).resolve().with_name("pilot-250-review.py")
    try:
        spec = importlib.util.spec_from_file_location("pilot_250_review_for_renormalize", review_path)
        if spec is None or spec.loader is None:
            raise SafeFailure("review_helper_unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    except SafeFailure:
        raise
    except Exception:
        sys.modules.pop("pilot_250_review_for_renormalize", None)
        raise SafeFailure("review_helper_unavailable") from None


def _file_sha256(path_value: str | pathlib.Path, failure_code: str) -> str:
    digest = hashlib.sha256()
    try:
        with pathlib.Path(path_value).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise SafeFailure(failure_code) from None
    return digest.hexdigest()


def _canonical_json_bytes(value: Any, failure_code: str = "record_not_serializable") -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise SafeFailure(failure_code) from None


def _projected_sha256(projected: dict[str, Any]) -> str:
    # Match pilot-250-review.py's exact hash for model input identity.
    encoded = json.dumps(
        projected, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _packet_states(review: Any, packets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    states: dict[str, dict[str, Any]] = {}
    for packet in packets:
        try:
            case_id, arms, _removed = review._project_packet_arms(packet, compare_original=False)
            projected = arms["cleaned"]
            input_sha256 = _projected_sha256(projected)
            arm_pair_sha256 = hashlib.sha256(json.dumps(
                {"cleaned": input_sha256}, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            sensitive = review._contains_sensitive_payment_data(projected)
        except Exception as error:
            if isinstance(error, SafeFailure):
                raise
            raise SafeFailure(_safe_error_code(error, "packet_projection_failed")) from None
        if case_id in states:
            raise SafeFailure("input_duplicate_case")
        states[case_id] = {
            "projected": projected,
            "input_sha256": input_sha256,
            "arm_pair_sha256": arm_pair_sha256,
            "sensitive": sensitive,
        }
    if not states:
        raise SafeFailure("input_empty_or_invalid")
    return states


def _stat_token(review: Any, path: pathlib.Path, kind: str) -> tuple[int, ...]:
    try:
        info = review._private_stat(path, kind)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, f"{kind}_unavailable")) from None
    return (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
        stat.S_IMODE(info.st_mode),
    )


def _stable_load_packets(review: Any, path: pathlib.Path) -> list[dict[str, Any]]:
    before = _stat_token(review, path, "input")
    try:
        packets = review._load_packets(path)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "input_invalid")) from None
    if before != _stat_token(review, path, "input"):
        raise SafeFailure("input_changed_during_read")
    return packets


def _stable_load_results(review: Any, path: pathlib.Path) -> list[dict[str, Any]]:
    before = _stat_token(review, path, "results")
    try:
        records = review._load_result_records(path, missing_ok=False)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "assessments_invalid")) from None
    if before != _stat_token(review, path, "results"):
        raise SafeFailure("assessments_changed_during_read")
    if not records:
        raise SafeFailure("assessments_empty")
    return records


def _private_input_path(prepare: Any, path_value: str, private_root: pathlib.Path,
                        failure_code: str) -> pathlib.Path:
    try:
        return prepare._private_input_path(path_value, private_root)
    except Exception:
        raise SafeFailure(failure_code) from None


def _new_output_target(review: Any, value: str, private_root: pathlib.Path) -> pathlib.Path:
    root = private_root.resolve(strict=True)
    target = pathlib.Path(os.path.abspath(value))
    if target.parent != root:
        raise SafeFailure("output_must_be_private_child")
    try:
        review._validate_private_output_location(target, private_root)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "output_must_be_private_child")) from None
    if os.path.lexists(target):
        raise SafeFailure("output_target_exists")
    return target


def _validate_endpoint_sha256(value: str) -> str:
    if not SHA256_RE.fullmatch(value):
        raise SafeFailure("endpoint_sha256_invalid")
    return value


def _validate_result_record(review: Any, record: dict[str, Any],
                            packet_states: dict[str, dict[str, Any]],
                            endpoint_sha256: str, expected_round: int = 1) -> dict[str, Any]:
    if not REQUIRED_RESULT_FIELDS <= record.keys():
        raise SafeFailure("assessment_record_malformed")
    if record.get("version") != review.VERSION:
        raise SafeFailure("assessment_version_mismatch")
    case_id = record.get("case_id")
    if not isinstance(case_id, str) or case_id not in packet_states:
        raise SafeFailure("assessment_case_mismatch")
    if record.get("phase") != "development":
        raise SafeFailure("assessment_phase_mismatch")
    if record.get("arm") != "cleaned":
        raise SafeFailure("assessment_arm_mismatch")
    if type(record.get("round")) is not int or record["round"] != expected_round:
        raise SafeFailure("assessment_round_mismatch")
    if record.get("prompt_sha256") != review.PROMPT_SHA256:
        raise SafeFailure("assessment_prompt_mismatch")
    if record.get("endpoint_sha256") != endpoint_sha256:
        raise SafeFailure("assessment_endpoint_mismatch")

    packet = packet_states[case_id]
    if record.get("input_sha256") != packet["input_sha256"]:
        raise SafeFailure("assessment_input_hash_mismatch")
    if record.get("arm_pair_sha256") != packet["arm_pair_sha256"]:
        raise SafeFailure("assessment_arm_pair_mismatch")

    slot = record.get("slot")
    slot_definition = next((item for item in review.SLOTS if item.get("slot") == slot), None)
    if (slot_definition is None or record.get("model") != slot_definition.get("model")
            or record.get("reasoning_effort") != slot_definition.get("effort")):
        raise SafeFailure("assessment_slot_mismatch")

    status = record.get("status")
    if status not in ("ok", "error", "withheld"):
        raise SafeFailure("assessment_status_invalid")
    error_code = record.get("error_code")
    if status == "ok":
        if error_code is not None or not isinstance(record.get("raw_output_text"), str):
            raise SafeFailure("assessment_record_malformed")
    elif (not isinstance(error_code, str) or not SAFE_CODE_RE.fullmatch(error_code)
          or record.get("raw_output_text") is not None):
        raise SafeFailure("assessment_record_malformed")

    usage = record.get("usage")
    if not isinstance(usage, dict):
        raise SafeFailure("assessment_record_malformed")
    for token_field in ("input_tokens", "output_tokens", "total_tokens"):
        token_value = usage.get(token_field)
        if token_value is not None and (type(token_value) is not int or token_value < 0):
            raise SafeFailure("assessment_record_malformed")
    attempts = record.get("http_attempts")
    if type(attempts) is not int or attempts < 0:
        raise SafeFailure("assessment_record_malformed")
    validation_counts = record.get("validation_counts")
    if not isinstance(validation_counts, dict) or any(
        not isinstance(key, str) or not SAFE_CODE_RE.fullmatch(key)
        or type(count) is not int or count < 0
        for key, count in validation_counts.items()
    ):
        raise SafeFailure("assessment_record_malformed")
    parse_status = record.get("parse_status")
    if parse_status is not None and (
        not isinstance(parse_status, str) or not SAFE_CODE_RE.fullmatch(parse_status)
    ):
        raise SafeFailure("assessment_record_malformed")
    if not isinstance(record.get("normalized"), dict):
        raise SafeFailure("assessment_record_malformed")
    _canonical_json_bytes(record)

    if packet["sensitive"]:
        expected_unknown = review._unknown_assessment()
        if (status != "withheld"
                or error_code != "sensitive_payment_or_credential_pattern"
                or attempts != 0
                or any(usage.get(field) is not None for field in (
                    "input_tokens", "output_tokens", "total_tokens",
                ))
                or validation_counts
                or parse_status is not None
                or _canonical_json_bytes(record["normalized"])
                != _canonical_json_bytes(expected_unknown)):
            raise SafeFailure("sensitive_assessment_inconsistent")

    return packet


def _renormalize_records(review: Any, records: list[dict[str, Any]],
                         packet_states: dict[str, dict[str, Any]], endpoint_sha256: str,
                         normalizer_sha256: str, helper_sha256: str,
                         expected_round: int = 1) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    endpoint_sha256 = _validate_endpoint_sha256(endpoint_sha256)
    if not records:
        raise SafeFailure("assessments_empty")

    slot_status_counts: Counter[str] = Counter()
    parse_status_counts: Counter[str] = Counter()
    validation_totals: Counter[str] = Counter()
    output_records: list[dict[str, Any]] = []
    normalized_changed = 0
    reparsed = 0

    for record in records:
        packet = _validate_result_record(review, record, packet_states, endpoint_sha256, expected_round)
        updated = dict(record)
        status = record["status"]
        slot_status_counts[status] += 1
        if status == "ok":
            try:
                normalized, validation_counts, parse_status = review._parse_model_output(
                    record["raw_output_text"], packet["projected"],
                )
            except Exception as error:
                raise SafeFailure(_safe_error_code(error, "normalizer_failed")) from None
            if (not isinstance(normalized, dict) or not isinstance(validation_counts, dict)
                    or any(not isinstance(key, str) or not SAFE_CODE_RE.fullmatch(key)
                           or type(count) is not int or count < 0
                           for key, count in validation_counts.items())):
                raise SafeFailure("normalizer_result_malformed")
            parse_status = parse_status or "valid"
            if not isinstance(parse_status, str) or not SAFE_CODE_RE.fullmatch(parse_status):
                raise SafeFailure("normalizer_result_malformed")
            if (_canonical_json_bytes(record["normalized"])
                    != _canonical_json_bytes(normalized)):
                normalized_changed += 1
            updated["normalized"] = normalized
            updated["validation_counts"] = validation_counts
            updated["parse_status"] = parse_status
            reparsed += 1
            parse_status_counts[parse_status] += 1
            validation_totals.update(validation_counts)

        updated["normalizer_code_sha256"] = normalizer_sha256
        updated["renormalization_provenance"] = {
            "helper_version": HELPER_VERSION,
            "helper_code_sha256": helper_sha256,
            "normalizer_version": review.VERSION,
            "normalizer_code_sha256": normalizer_sha256,
        }
        _canonical_json_bytes(updated)
        output_records.append(updated)

    invalid_count = sum(count for status, count in parse_status_counts.items() if status != "valid")
    if reparsed == 0:
        validation_status = "no_ok_records_to_validate"
    elif invalid_count:
        validation_status = "invalid_reparsed_outputs_present"
    else:
        validation_status = "all_reparsed_outputs_valid"

    summary = {
        "helper_version": HELPER_VERSION,
        "normalizer_version": review.VERSION,
        "helper_code_sha256": helper_sha256,
        "normalizer_code_sha256": normalizer_sha256,
        "records": len(records),
        "successful_reparsed": reparsed,
        "failed_preserved": slot_status_counts["error"],
        "withheld_preserved": slot_status_counts["withheld"],
        "failed_or_withheld_preserved": slot_status_counts["error"] + slot_status_counts["withheld"],
        "records_normalized_changed": normalized_changed,
        "validation_status": validation_status,
        "parse_status_counts": dict(sorted(parse_status_counts.items())),
        "validation_counts": dict(sorted(validation_totals.items())),
    }
    return output_records, summary


def _write_new_output(review: Any, output_dir: pathlib.Path, private_root: pathlib.Path,
                      records: list[dict[str, Any]]) -> None:
    _new_output_target(review, str(output_dir), private_root)
    try:
        os.mkdir(output_dir, mode=0o700)
        os.chmod(output_dir, 0o700)
    except FileExistsError:
        raise SafeFailure("output_target_exists") from None
    except OSError:
        raise SafeFailure("output_dir_unavailable") from None
    try:
        output_dir = review._ensure_private_output_dir(output_dir)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "output_dir_not_private")) from None

    results_path = output_dir / RESULTS_NAME
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(results_path, flags, 0o600)
    except FileExistsError:
        raise SafeFailure("output_target_exists") from None
    except OSError:
        raise SafeFailure("results_unavailable") from None
    try:
        os.fchmod(fd, 0o600)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise SafeFailure("results_not_private")
    except OSError:
        raise SafeFailure("results_not_private") from None
    finally:
        os.close(fd)

    lock = threading.Lock()
    for record in records:
        try:
            review._append_private_jsonl(results_path, record, lock)
        except Exception as error:
            raise SafeFailure(_safe_error_code(error, "results_write_failed")) from None

    try:
        final_info = results_path.lstat()
        dir_info = output_dir.lstat()
    except OSError:
        raise SafeFailure("results_unavailable") from None
    if (stat.S_ISLNK(final_info.st_mode) or not stat.S_ISREG(final_info.st_mode)
            or final_info.st_uid != os.getuid() or stat.S_IMODE(final_info.st_mode) != 0o600
            or stat.S_ISLNK(dir_info.st_mode) or not stat.S_ISDIR(dir_info.st_mode)
            or dir_info.st_uid != os.getuid() or stat.S_IMODE(dir_info.st_mode) != 0o700):
        raise SafeFailure("output_not_private")


def _run(args: argparse.Namespace, review: Any) -> dict[str, Any]:
    endpoint_sha256 = _validate_endpoint_sha256(args.endpoint_sha256)
    try:
        prepare = review._load_prepare_helper()
        repo_root = pathlib.Path(review.__file__).resolve().parents[4]
        private_root = prepare._private_root(repo_root)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "private_root_unavailable")) from None

    output_dir = _new_output_target(review, args.output_dir, private_root)
    rederive_args = argparse.Namespace(
        phase="development", holdout_unsealed=False, source=args.source,
        manifest=args.manifest, input=args.input, compare_original=False,
        original_input=None,
    )
    try:
        (rederived_root, _source_path, _manifest_path, input_path, _original_path,
         _manifest_document, _expected_original, expected_cleaned) = \
            review._rederive_expected_packets(rederive_args)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "source_manifest_verification_failed")) from None
    if pathlib.Path(rederived_root).resolve(strict=True) != pathlib.Path(private_root).resolve(strict=True):
        raise SafeFailure("private_root_mismatch")

    try:
        prepare = review._load_prepare_helper()
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "preparation_helper_unavailable")) from None
    assessments_path = _private_input_path(
        prepare, args.assessments, private_root, "assessments_path_invalid",
    )

    supplied_packets = _stable_load_packets(review, input_path)
    try:
        exact_packets = review._exact_packet_map(supplied_packets, expected_cleaned)
    except Exception as error:
        raise SafeFailure(_safe_error_code(error, "packet_provenance_mismatch")) from None
    packet_states = _packet_states(review, list(exact_packets.values()))
    records = _stable_load_results(review, assessments_path)

    normalizer_sha256 = _file_sha256(review.__file__, "normalizer_sha_unavailable")
    helper_sha256 = _file_sha256(__file__, "helper_sha_unavailable")
    output_records, summary = _renormalize_records(
        review, records, packet_states, endpoint_sha256,
        normalizer_sha256, helper_sha256, expected_round=args.round,
    )
    _write_new_output(review, output_dir, private_root, output_records)
    return summary


def _synthetic_record(review: Any, packet_state: dict[str, Any], case_id: str,
                      endpoint_sha256: str, *, status: str = "ok") -> dict[str, Any]:
    slot = review.SLOTS[0]
    raw_text = json.dumps(
        review._synthetic_raw("quote", "Please quote a room."),
        ensure_ascii=False, separators=(",", ":"),
    )
    record: dict[str, Any] = {
        "version": review.VERSION,
        "case_id": case_id,
        "phase": "development",
        "arm": "cleaned",
        "round": 1,
        "arm_pair_sha256": packet_state["arm_pair_sha256"],
        "slot": slot["slot"],
        "model": slot["model"],
        "reasoning_effort": slot["effort"],
        "input_sha256": packet_state["input_sha256"],
        "prompt_sha256": review.PROMPT_SHA256,
        "endpoint_sha256": endpoint_sha256,
        "status": status,
        "error_code": None if status == "ok" else "synthetic_failure",
        "usage": {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
        "http_attempts": 1 if status == "ok" else 0,
        "validation_counts": {"old_normalizer_count": 2},
        "parse_status": "invalid_output" if status == "ok" else None,
        "normalized": review._unknown_assessment(),
        "raw_output_text": raw_text if status == "ok" else None,
    }
    return record


def _expect_failure(function: Any, expected_code: str) -> bool:
    try:
        function()
    except SafeFailure as error:
        return error.code == expected_code
    return False


def run_self_tests(review: Any | None = None) -> int:
    review = review or _load_review()
    checks = 0

    def check(_name: str, condition: bool) -> None:
        nonlocal checks
        if not condition:
            raise AssertionError("synthetic_self_test_failed")
        checks += 1

    endpoint_sha256 = "a" * 64
    packet = review._synthetic_packet("SYNTHETIC_RENORMALIZE_CASE", "Please quote a room.")
    case_id, arms, _removed = review._project_packet_arms(packet, compare_original=False)
    packet_states = _packet_states(review, [packet])
    state = packet_states[case_id]
    check("fixture_is_not_sensitive", not state["sensitive"])

    ok_record = _synthetic_record(review, state, case_id, endpoint_sha256)
    error_record = _synthetic_record(review, state, case_id, endpoint_sha256, status="error")
    error_record["usage"] = {"input_tokens": 3, "output_tokens": 0, "total_tokens": 3}
    error_record["validation_counts"] = {"preserved_error_count": 4}
    withheld_record = _synthetic_record(review, state, case_id, endpoint_sha256, status="withheld")
    withheld_record["usage"] = {"input_tokens": None, "output_tokens": None, "total_tokens": None}
    preserved_error = {
        "status": error_record["status"], "usage": dict(error_record["usage"]),
        "raw_output_text": error_record["raw_output_text"],
        "normalized": _canonical_json_bytes(error_record["normalized"]),
        "validation_counts": dict(error_record["validation_counts"]),
        "parse_status": error_record["parse_status"],
    }
    preserved_withheld = {
        "status": withheld_record["status"], "usage": dict(withheld_record["usage"]),
        "raw_output_text": withheld_record["raw_output_text"],
        "normalized": _canonical_json_bytes(withheld_record["normalized"]),
        "validation_counts": dict(withheld_record["validation_counts"]),
        "parse_status": withheld_record["parse_status"],
    }
    raw_output = ok_record["raw_output_text"]
    normalizer_sha256 = _file_sha256(review.__file__, "normalizer_sha_unavailable")
    helper_sha256 = _file_sha256(__file__, "helper_sha_unavailable")
    outputs, summary = _renormalize_records(
        review, [ok_record, error_record, withheld_record], packet_states,
        endpoint_sha256, normalizer_sha256, helper_sha256,
    )
    expected_normalized, expected_counts, expected_status = review._parse_model_output(
        raw_output, arms["cleaned"],
    )
    check("successful_reparse_uses_exact_projected_packet",
          outputs[0]["normalized"] == expected_normalized
          and outputs[0]["validation_counts"] == expected_counts
          and outputs[0]["parse_status"] == (expected_status or "valid"))
    check("reparse_preserves_status_usage_and_raw_output",
          outputs[0]["status"] == ok_record["status"]
          and outputs[0]["usage"] == ok_record["usage"]
          and outputs[0]["raw_output_text"] == raw_output)
    check("error_and_withheld_records_preserved",
          outputs[1]["status"] == preserved_error["status"]
          and outputs[1]["usage"] == preserved_error["usage"]
          and outputs[1]["raw_output_text"] == preserved_error["raw_output_text"]
          and _canonical_json_bytes(outputs[1]["normalized"]) == preserved_error["normalized"]
          and outputs[1]["validation_counts"] == preserved_error["validation_counts"]
          and outputs[1]["parse_status"] == preserved_error["parse_status"]
          and outputs[2]["status"] == preserved_withheld["status"]
          and outputs[2]["usage"] == preserved_withheld["usage"]
          and outputs[2]["raw_output_text"] == preserved_withheld["raw_output_text"]
          and _canonical_json_bytes(outputs[2]["normalized"]) == preserved_withheld["normalized"]
          and outputs[2]["validation_counts"] == preserved_withheld["validation_counts"]
          and outputs[2]["parse_status"] == preserved_withheld["parse_status"])
    check("provenance_records_current_normalizer_and_helper_sha",
          outputs[0]["renormalization_provenance"]["normalizer_code_sha256"] == normalizer_sha256
          and outputs[0]["renormalization_provenance"]["helper_code_sha256"] == helper_sha256
          and outputs[0]["normalizer_code_sha256"] == normalizer_sha256)
    second_round = dict(ok_record, round=2)
    check("repeat_requires_explicit_round", _expect_failure(
        lambda: _renormalize_records(review, [second_round], packet_states, endpoint_sha256,
                                     normalizer_sha256, helper_sha256), "assessment_round_mismatch"))
    check("repeat_can_be_renormalized_with_explicit_round",
          _renormalize_records(review, [second_round], packet_states, endpoint_sha256,
                               normalizer_sha256, helper_sha256, expected_round=2)[0][0]["round"] == 2)
    check("aggregate_counts_are_case_free",
          summary["records"] == 3 and summary["successful_reparsed"] == 1
          and summary["failed_preserved"] == 1 and summary["withheld_preserved"] == 1
          and summary["records_normalized_changed"] == 1
          and summary["validation_status"] == "all_reparsed_outputs_valid"
          and "case_id" not in summary)

    wrong_hash = dict(ok_record, input_sha256="0" * 64)
    check("projected_input_hash_mismatch_rejected", _expect_failure(
        lambda: _renormalize_records(
            review, [wrong_hash], packet_states, endpoint_sha256, normalizer_sha256, helper_sha256,
        ), "assessment_input_hash_mismatch"))
    wrong_phase = dict(ok_record, phase="holdout")
    check("invalid_phase_rejected", _expect_failure(
        lambda: _renormalize_records(
            review, [wrong_phase], packet_states, endpoint_sha256, normalizer_sha256, helper_sha256,
        ), "assessment_phase_mismatch"))
    wrong_endpoint = dict(ok_record, endpoint_sha256="b" * 64)
    check("endpoint_mismatch_rejected", _expect_failure(
        lambda: _renormalize_records(
            review, [wrong_endpoint], packet_states, endpoint_sha256, normalizer_sha256, helper_sha256,
        ), "assessment_endpoint_mismatch"))
    check("malformed_endpoint_hash_rejected", _expect_failure(
        lambda: _validate_endpoint_sha256("not-a-sha256"), "endpoint_sha256_invalid"))
    wrong_version = dict(ok_record, version="synthetic-old-version")
    check("record_version_mismatch_rejected", _expect_failure(
        lambda: _renormalize_records(
            review, [wrong_version], packet_states, endpoint_sha256, normalizer_sha256, helper_sha256,
        ), "assessment_version_mismatch"))

    sensitive_packet = review._synthetic_packet(
        "SYNTHETIC_SENSITIVE_CASE", "Synthetic card number 4111 1111 1111 1111.",
    )
    sensitive_id = sensitive_packet["case_id"]
    sensitive_state = _packet_states(review, [sensitive_packet])[sensitive_id]
    check("sensitive_fixture_is_detected", sensitive_state["sensitive"])
    sensitive_withheld = _synthetic_record(
        review, sensitive_state, sensitive_id, endpoint_sha256, status="withheld",
    )
    sensitive_withheld.update({
        "error_code": "sensitive_payment_or_credential_pattern",
        "usage": {"input_tokens": None, "output_tokens": None, "total_tokens": None},
        "http_attempts": 0,
        "validation_counts": {},
        "parse_status": None,
    })
    check("sensitive_withheld_record_accepted_without_reparse",
          _renormalize_records(
              review, [sensitive_withheld], {sensitive_id: sensitive_state}, endpoint_sha256,
              normalizer_sha256, helper_sha256,
          )[0][0]["status"] == "withheld")
    sensitive_ok = _synthetic_record(review, sensitive_state, sensitive_id, endpoint_sha256)
    check("sensitive_model_output_record_rejected", _expect_failure(
        lambda: _renormalize_records(
            review, [sensitive_ok], {sensitive_id: sensitive_state}, endpoint_sha256,
            normalizer_sha256, helper_sha256,
        ), "sensitive_assessment_inconsistent"))

    with tempfile.TemporaryDirectory() as tempdir:
        private_root = pathlib.Path(tempdir) / ".private"
        private_root.mkdir(mode=0o700)
        os.chmod(private_root, 0o700)
        target = private_root / "synthetic-renormalized"
        _write_new_output(review, target, private_root, outputs[:1])
        target_info = target.lstat()
        result_path = target / RESULTS_NAME
        result_info = result_path.lstat()
        saved = review._load_result_records(result_path, missing_ok=False)
        check("new_private_output_modes_and_append_log",
              stat.S_IMODE(target_info.st_mode) == 0o700
              and stat.S_IMODE(result_info.st_mode) == 0o600
              and len(saved) == 1
              and saved[0]["raw_output_text"] == raw_output)
        check("preexisting_output_target_rejected", _expect_failure(
            lambda: _write_new_output(review, target, private_root, outputs[:1]),
            "output_target_exists"))
        unsafe_target = pathlib.Path(tempdir) / "outside-private"
        check("output_outside_private_root_rejected", _expect_failure(
            lambda: _write_new_output(review, unsafe_target, private_root, outputs[:1]),
            "output_must_be_private_child"))

    return checks


def _build_cli() -> SafeArgumentParser:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("--source", help="pinned owner-only source JSONL under .private")
    parser.add_argument("--manifest", help="frozen owner-only pilot manifest under .private")
    parser.add_argument("--input", help="owner-only development cleaned packet JSONL subset")
    parser.add_argument("--assessments", help="owner-only combined development results JSONL")
    parser.add_argument("--output-dir", help="new direct child of .private; must not already exist")
    parser.add_argument("--endpoint-sha256", help="expected lowercase endpoint SHA-256 from first pass")
    parser.add_argument("--round", type=int, choices=(1, 2), default=1,
                        help="explicit assessment round to re-normalize (default 1)")
    parser.add_argument("--self-test", action="store_true", help="run synthetic-only offline checks")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_cli()
    try:
        args = parser.parse_args(argv)
        if args.self_test:
            if any((args.source, args.manifest, args.input, args.assessments,
                    args.output_dir, args.endpoint_sha256)) or args.round != 1:
                raise SafeFailure("self_test_options_invalid")
            checks = run_self_tests()
            print(json.dumps({"self_test": "passed", "synthetic_checks": checks}, sort_keys=True))
            return 0

        if not all((args.source, args.manifest, args.input, args.assessments,
                    args.output_dir, args.endpoint_sha256)):
            raise SafeFailure("arguments_required")
        summary = _run(args, _load_review())
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except SafeFailure as error:
        print("error=" + error.code, file=sys.stderr)
        return 2
    except Exception:
        print("error=internal", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
