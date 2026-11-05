#!/usr/bin/env python3
"""Aggregate payment-document audit records by trusted cohort and model slot.

The summary has no guest-text output and no ground-truth or negative-proof
interpretation. It reads only owner-only result files named for exact,
rederived input rows. Different input-file hashes across result directories
are permitted; packet and model-input hashes must still match each row.

Offline checks: python3 -I -B pilot-250-payment-document-summary.py self-test
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any


VERSION = "centurion-payment-document-summary-v1"
AUDIT_PATH = pathlib.Path(__file__).resolve().with_name("pilot-250-payment-document-audit.py")
EXPECTED_AUDIT_SHA256 = "257e48b5d44b1e69ddad494c9ab34de6ae34558427bb6da30b556e09ca140059"
EXPECTED_REVIEW_SHA256 = "8218969d815a966fc30d936a759c557f14ab1d2bdece1b4a21ce850f70a598da"
EXPECTED_AUDIT_PROMPT_SHA256 = "2e00c135463cc56dc150c3593a57ccbc3812a4be171f04b764aa7fdcb562ae46"
EXPECTED_REVIEW_PROMPT_SHA256 = "feeebf551723140b9e0703263c14a2ed57285ee01a63c21034a2ef0b9ef87a3c"
EXPECTED_ENDPOINT_SHA256 = "7cbded1e0844b02d82afa6ffd1d79d2e83e66558d05f38613403b224d4dd9bbf"
MAX_RESULT_BYTES = 2_000_000
MAX_RESULT_DIRS = 100
COHORTS = ("random-development", "targeted-development", "random-holdout")
STATUS_NAMES = ("ok", "withheld", "error", "missing")
SIGNALS = (
    "pop_finding",
    "pop_potential_filing_yes",
    "pop_sender_claimed_supplied",
    "voucher_finding",
    "voucher_potential_filing_yes",
    "voucher_sender_claimed_supplied",
    "any_sender_claimed_supplied",
    "any_yes_filing_literal_evidence",
)
AUDIT_ERRORS = frozenset({
    "request_encoding", "response_too_large", "invalid_response", "output_incomplete",
    "rate_limited", "upstream_timeout", "upstream_server", "http_failure",
    "network_timeout", "network_failure", "request_failed", "invalid_json",
    "invalid_output", "invalid_evidence", "internal",
})
PARSE_ERRORS = frozenset({"invalid_json", "invalid_output", "invalid_evidence"})
RESULT_FIELDS = frozenset({
    "version", "case_id", "phase", "cohort", "embargoed", "slot", "model",
    "reasoning_effort", "review_helper_code_sha256", "audit_helper_code_sha256",
    "review_prompt_sha256", "prompt_sha256", "endpoint_sha256", "source_sha256",
    "manifest_sha256", "input_file_sha256", "packet_sha256", "input_sha256",
    "status", "error_code", "parse_status", "usage", "http_attempts",
    "binary_fields_removed", "control_fields_removed", "validation_counts", "normalized",
})


class SafeFailure(Exception):
    """Failure containing only a fixed non-sensitive category."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


try:
    SUMMARY_HELPER_SHA256 = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
except OSError:
    raise SafeFailure("summary_helper_unavailable") from None


def _load_audit_and_review() -> tuple[Any, Any]:
    try:
        source = AUDIT_PATH.read_bytes()
    except OSError:
        raise SafeFailure("payment_audit_helper_unavailable") from None
    digest = hashlib.sha256(source).hexdigest()
    if digest != EXPECTED_AUDIT_SHA256:
        raise SafeFailure("payment_audit_helper_sha_mismatch")
    spec = importlib.util.spec_from_file_location("pilot_250_payment_document_audit_summary", AUDIT_PATH)
    if spec is None:
        raise SafeFailure("payment_audit_helper_unavailable")
    audit = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = audit
    try:
        exec(compile(source, str(AUDIT_PATH), "exec"), audit.__dict__)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise SafeFailure("payment_audit_helper_import_failed") from None
    if (audit.NORMALIZER_CODE_SHA256 != digest
            or audit.PROMPT_SHA256 != EXPECTED_AUDIT_PROMPT_SHA256
            or audit.PINNED_REVIEW_PROMPT_SHA256 != EXPECTED_REVIEW_PROMPT_SHA256
            or audit.EXPECTED_ENDPOINT_SHA256 != EXPECTED_ENDPOINT_SHA256
            or audit.EXPECTED_REVIEW_SHA256 != EXPECTED_REVIEW_SHA256):
        raise SafeFailure("payment_audit_helper_pin_mismatch")
    if [(slot.get("slot"), slot.get("model"), slot.get("effort")) for slot in audit.SLOTS] != [
        ("luna_max", "gpt-6-luna", "max"),
        ("sol_high", "gpt-6.1-sol", "high"),
    ]:
        raise SafeFailure("model_slot_pin_mismatch")
    try:
        review, review_digest = audit._load_review()
    except Exception:
        raise SafeFailure("review_helper_load_failed") from None
    if (review_digest != EXPECTED_REVIEW_SHA256
            or review.NORMALIZER_CODE_SHA256 != EXPECTED_REVIEW_SHA256
            or review.PROMPT_SHA256 != EXPECTED_REVIEW_PROMPT_SHA256):
        raise SafeFailure("review_helper_pin_mismatch")
    return audit, review


def _phase_gate(phase: str, holdout_unsealed: bool) -> None:
    if phase not in ("development", "holdout"):
        raise SafeFailure("phase_invalid")
    if phase == "development" and holdout_unsealed:
        raise SafeFailure("holdout_flag_wrong_phase")
    if phase == "holdout" and not holdout_unsealed:
        raise SafeFailure("holdout_not_unsealed")


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _int_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _hash(value: Any) -> str:
    try:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise SafeFailure("fingerprint_invalid") from None
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class SummaryCase:
    case_id: str
    cohort: str
    embargoed: bool
    packet_sha256: str
    input_sha256: str
    audit_input: dict[str, Any]
    sensitive: bool


@dataclass(frozen=True)
class Selection:
    status: str
    error_code: str | None
    signals: dict[str, bool] | None
    empty_findings: bool
    duplicate_attempts: int
    invalid_attempts: int


def _rederive_cases(args: argparse.Namespace, audit: Any, review: Any) -> tuple[
    list[SummaryCase], dict[str, str], pathlib.Path,
]:
    _phase_gate(args.phase, args.holdout_unsealed)
    provenance_args = argparse.Namespace(
        phase=args.phase,
        holdout_unsealed=args.holdout_unsealed,
        compare_original=False,
        original_input=None,
        source=args.source,
        manifest=args.manifest,
        input=args.input,
    )
    try:
        (
            private_root, source_path, manifest_path, input_path, _original_path,
            manifest_document, _expected_original, expected_cleaned,
        ) = review._rederive_expected_packets(provenance_args)
        packets = review._load_packets(input_path)
        review._exact_packet_map(packets, expected_cleaned)
        manifest = review._normalize_manifest_rows(review._manifest_rows(manifest_document))
        source_sha = review._file_sha256(source_path)
        manifest_sha = review._file_sha256(manifest_path)
        input_file_sha = review._file_sha256(input_path)
    except SafeFailure:
        raise
    except Exception:
        raise SafeFailure("input_rederivation_failed") from None
    if not packets or len(packets) > review.MAX_PILOT_CASES:
        raise SafeFailure("input_case_limit")

    cases: list[SummaryCase] = []
    seen: set[str] = set()
    for packet in packets:
        try:
            case_id, arms, _removed = review._project_packet_arms(packet, compare_original=False)
        except Exception:
            raise SafeFailure("input_packet_invalid") from None
        if case_id in seen or case_id not in manifest:
            raise SafeFailure("input_case_mismatch")
        seen.add(case_id)
        entry = manifest[case_id]
        try:
            review._check_phase(case_id, entry, args.phase, args.holdout_unsealed)
        except Exception:
            raise SafeFailure("input_phase_mismatch") from None
        if entry["cohort"] not in COHORTS:
            raise SafeFailure("input_cohort_invalid")
        projected = arms["cleaned"]
        audit_input = audit.project_audit_input(review, projected)
        sensitive = review._contains_sensitive_payment_data(projected)
        cases.append(SummaryCase(
            case_id=case_id,
            cohort=entry["cohort"],
            embargoed=entry["embargoed"],
            packet_sha256=audit._hash_json(packet),
            input_sha256=audit._hash_json(audit_input),
            audit_input=audit_input,
            sensitive=sensitive,
        ))
    provenance = {
        "source_sha256": source_sha,
        "manifest_sha256": manifest_sha,
        "input_file_sha256": input_file_sha,
    }
    return cases, provenance, private_root


def _validate_result_dir(path_value: str | pathlib.Path, private_root: pathlib.Path,
                         review: Any) -> pathlib.Path:
    path = pathlib.Path(path_value)
    if not path.is_absolute():
        path = pathlib.Path.cwd() / path
    review._validate_private_output_location(path, private_root)
    try:
        info = path.lstat()
    except OSError:
        raise SafeFailure("result_dir_unavailable") from None
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise SafeFailure("result_dir_not_private")
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        raise SafeFailure("result_dir_unavailable") from None
    return resolved


def _distinct_result_dirs(values: list[str], private_root: pathlib.Path, review: Any) -> list[pathlib.Path]:
    if not values:
        raise SafeFailure("result_dir_required")
    if len(values) > MAX_RESULT_DIRS:
        raise SafeFailure("result_dir_count_limit")
    result: list[pathlib.Path] = []
    seen: set[pathlib.Path] = set()
    for value in values:
        path = _validate_result_dir(value, private_root, review)
        if path in seen:
            raise SafeFailure("duplicate_result_dir_argument")
        seen.add(path)
        result.append(path)
    return result


def _unknown_result(audit: Any) -> dict[str, Any]:
    return audit._unknown_result()


def _validate_usage(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"input_tokens", "output_tokens", "total_tokens"} \
        and all(item is None or _int_count(item) for item in value.values())


def _validate_result_record(
    record: Any,
    case: SummaryCase,
    slot: dict[str, str],
    phase: str,
    provenance: dict[str, str],
    audit: Any,
    review: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    """Return normalized valid assessment; never propagate record data in errors."""
    if not isinstance(record, dict) or set(record) != RESULT_FIELDS:
        return None, "result_schema_invalid"
    expected = {
        "version": audit.VERSION,
        "case_id": case.case_id,
        "phase": phase,
        "cohort": case.cohort,
        "embargoed": case.embargoed,
        "slot": slot["slot"],
        "model": slot["model"],
        "reasoning_effort": slot["effort"],
        "review_helper_code_sha256": review.NORMALIZER_CODE_SHA256,
        "audit_helper_code_sha256": audit.NORMALIZER_CODE_SHA256,
        "review_prompt_sha256": EXPECTED_REVIEW_PROMPT_SHA256,
        "prompt_sha256": EXPECTED_AUDIT_PROMPT_SHA256,
        "endpoint_sha256": EXPECTED_ENDPOINT_SHA256,
        "source_sha256": provenance["source_sha256"],
        "manifest_sha256": provenance["manifest_sha256"],
        "packet_sha256": case.packet_sha256,
        "input_sha256": case.input_sha256,
    }
    if any(record.get(key) != value for key, value in expected.items()):
        return None, "result_provenance_mismatch"
    if not _is_sha256(record.get("input_file_sha256")):
        return None, "result_input_file_fingerprint_invalid"
    if not _validate_usage(record.get("usage")):
        return None, "result_usage_invalid"
    attempts = record.get("http_attempts")
    if not _int_count(attempts) or attempts > 2:
        return None, "result_attempt_count_invalid"
    for key in ("binary_fields_removed", "control_fields_removed"):
        if not _int_count(record.get(key)):
            return None, "result_projection_counts_invalid"
    counts = record.get("validation_counts")
    if (not isinstance(counts, dict) or any(
            not isinstance(key, str) or not _int_count(value) for key, value in counts.items())):
        return None, "result_validation_counts_invalid"

    status = record.get("status")
    if status == "withheld":
        if (not case.sensitive or record.get("error_code") != "sensitive_payment_or_credential_pattern"
                or record.get("parse_status") is not None or attempts != 0
                or record.get("normalized") != _unknown_result(audit)):
            return None, "result_withheld_invalid"
        return {"status": "withheld"}, None
    if case.sensitive:
        return None, "sensitive_result_not_withheld"

    if status == "error":
        error_code = record.get("error_code")
        parse_status = record.get("parse_status")
        if not isinstance(error_code, str) or error_code not in AUDIT_ERRORS:
            return None, "result_error_category_invalid"
        if parse_status is not None and (
                not isinstance(parse_status, str) or parse_status not in PARSE_ERRORS):
            return None, "result_parse_status_invalid"
        if parse_status is not None and error_code != parse_status:
            return None, "result_error_parse_mismatch"
        if record.get("normalized") != _unknown_result(audit):
            return None, "result_error_normalized_invalid"
        return {"status": "error", "error_code": error_code}, None
    if status != "ok" or record.get("error_code") is not None or record.get("parse_status") != "valid":
        return None, "result_status_invalid"

    normalized = record.get("normalized")
    if not isinstance(normalized, dict) or set(normalized) != {
            "findings", "attachment_bytes_status", "payment_clearance_status", "live_capabilities_status"}:
        return None, "result_normalized_schema_invalid"
    try:
        revalidated, _validation, error = audit.normalize_audit_output(
            {"findings": normalized["findings"]}, case.audit_input, review,
        )
    except Exception:
        return None, "result_evidence_validation_failed"
    if error is not None or revalidated != normalized:
        return None, "result_evidence_or_normalizer_mismatch"
    return {"status": "ok", "normalized": normalized}, None


def _read_result_attempt(
    path: pathlib.Path,
    case: SummaryCase,
    slot: dict[str, str],
    phase: str,
    provenance: dict[str, str],
    audit: Any,
    review: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        raw = review._read_limited_private(path, "result", MAX_RESULT_BYTES)
        record = review._strict_json_loads(raw)
    except Exception:
        return None, "result_read_or_json_invalid"
    return _validate_result_record(record, case, slot, phase, provenance, audit, review)


def _signal_vector(normalized: dict[str, Any]) -> tuple[dict[str, bool], bool]:
    findings = normalized["findings"]
    pop_rows = [row for row in findings if row["document_kind"] == "proof_of_payment"]
    voucher_rows = [row for row in findings if row["document_kind"] == "voucher"]
    all_rows = findings
    values = {
        "pop_finding": bool(pop_rows),
        "pop_potential_filing_yes": any(row["potential_filing"] == "yes" for row in pop_rows),
        "pop_sender_claimed_supplied": any(row["supply_signal"] == "sender_claimed_supplied" for row in pop_rows),
        "voucher_finding": bool(voucher_rows),
        "voucher_potential_filing_yes": any(row["potential_filing"] == "yes" for row in voucher_rows),
        "voucher_sender_claimed_supplied": any(row["supply_signal"] == "sender_claimed_supplied" for row in voucher_rows),
        "any_sender_claimed_supplied": any(row["supply_signal"] == "sender_claimed_supplied" for row in all_rows),
        "any_yes_filing_literal_evidence": any(row["potential_filing"] == "yes" for row in all_rows),
    }
    return values, not findings


def _select_attempts(
    attempts_by_dir: list[tuple[dict[str, Any] | None, str | None]],
) -> Selection:
    """Retain the first successful or withheld result; use an error only as fallback."""
    valid: dict[str, Any] | None = None
    first_error: dict[str, Any] | None = None
    invalid_count = 0
    for candidate, error_code in attempts_by_dir:
        if candidate is not None:
            if candidate["status"] in ("ok", "withheld") and valid is None:
                valid = candidate
            elif candidate["status"] == "error" and first_error is None:
                first_error = candidate
        else:
            invalid_count += 1
    duplicates = max(0, len(attempts_by_dir) - 1)
    valid = valid or first_error
    if valid is None:
        if invalid_count:
            return Selection("error", "invalid_result_record", None, False, duplicates, invalid_count)
        return Selection("missing", None, None, False, duplicates, 0)
    status = valid["status"]
    if status == "ok":
        signals, empty = _signal_vector(valid["normalized"])
        return Selection("ok", None, signals, empty, duplicates, invalid_count)
    if status == "withheld":
        return Selection("withheld", "sensitive_payment_or_credential_pattern", None,
                         False, duplicates, invalid_count)
    return Selection("error", valid["error_code"], None, False, duplicates, invalid_count)


def _collect_selections(
    cases: list[SummaryCase],
    result_dirs: list[pathlib.Path],
    phase: str,
    provenance: dict[str, str],
    audit: Any,
    review: Any,
) -> tuple[dict[tuple[str, str], Selection], dict[str, collections.Counter[str]]]:
    selected: dict[tuple[str, str], Selection] = {}
    duplicate_counts: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for case in cases:
        for slot in audit.SLOTS:
            attempt_rows: list[tuple[dict[str, Any] | None, str | None]] = []
            file_name = audit._record_filename(case.case_id, slot, phase)
            for result_dir in result_dirs:
                path = result_dir / file_name
                try:
                    path.lstat()
                except FileNotFoundError:
                    continue
                except OSError:
                    attempt_rows.append((None, "result_file_unavailable"))
                    continue
                attempt_rows.append(_read_result_attempt(
                    path, case, slot, phase, provenance, audit, review,
                ))
            selection = _select_attempts(attempt_rows)
            selected[(case.case_id, slot["slot"])] = selection
            if selection.duplicate_attempts:
                duplicate_counts[case.cohort][slot["slot"]] += selection.duplicate_attempts
    return selected, duplicate_counts


def _empty_status_counts() -> dict[str, int]:
    return {name: 0 for name in STATUS_NAMES}


def _agreement(selected: dict[tuple[str, str], Selection], cases: list[SummaryCase],
               audit: Any) -> dict[str, dict[str, int]]:
    first, second = audit.SLOTS
    counts = {signal: {"both_yes": 0, "one_yes_other_not_yes": 0,
                       "both_no_yes": 0, "incomplete": 0} for signal in SIGNALS}
    for case in cases:
        left = selected[(case.case_id, first["slot"])]
        right = selected[(case.case_id, second["slot"])]
        for signal in SIGNALS:
            if left.status != "ok" or right.status != "ok":
                counts[signal]["incomplete"] += 1
                continue
            left_yes = bool(left.signals and left.signals[signal])
            right_yes = bool(right.signals and right.signals[signal])
            if left_yes and right_yes:
                counts[signal]["both_yes"] += 1
            elif left_yes != right_yes:
                counts[signal]["one_yes_other_not_yes"] += 1
            else:
                counts[signal]["both_no_yes"] += 1
    return counts


def _cohort_summary(cases: list[SummaryCase], selected: dict[tuple[str, str], Selection],
                    duplicates: dict[str, collections.Counter[str]], audit: Any) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for cohort in COHORTS:
        rows = [case for case in cases if case.cohort == cohort]
        if not rows:
            continue
        slots: dict[str, Any] = {}
        for slot in audit.SLOTS:
            selected_rows = [selected[(case.case_id, slot["slot"])] for case in rows]
            status_counts = _empty_status_counts()
            signal_counts = {signal: 0 for signal in SIGNALS}
            errors: collections.Counter[str] = collections.Counter()
            empty_findings = 0
            invalid_attempts = 0
            for selection in selected_rows:
                status_counts[selection.status] += 1
                invalid_attempts += selection.invalid_attempts
                if selection.error_code and selection.status == "error":
                    errors[selection.error_code] += 1
                if selection.status == "ok":
                    if selection.empty_findings:
                        empty_findings += 1
                    for signal in SIGNALS:
                        signal_counts[signal] += int(bool(selection.signals and selection.signals[signal]))
            valid_count = status_counts["ok"]
            slots[slot["slot"]] = {
                "input_case_denominator": len(rows),
                "status_counts": status_counts,
                "valid_assessment_denominator": valid_count,
                "valid_assessments_with_empty_findings": empty_findings,
                "signal_yes_counts": signal_counts,
                "error_categories": dict(errors),
                "duplicate_attempts": duplicates.get(cohort, {}).get(slot["slot"], 0),
                "invalid_attempts": invalid_attempts,
            }
        results.append({
            "trusted_cohort": cohort,
            "input_case_denominator": len(rows),
            "by_independent_slot": slots,
            "two_slot_signal_agreement": _agreement(selected, rows, audit),
        })
    return results


def summarize_cases(
    cases: list[SummaryCase],
    attempts: dict[tuple[str, str], list[tuple[dict[str, Any] | None, str | None]]],
    audit: Any,
    provenance: dict[str, str],
    *,
    phase: str,
    input_file_sha256: str,
) -> dict[str, Any]:
    """Pure aggregate for synthetic tests and the private-file CLI."""
    selected: dict[tuple[str, str], Selection] = {}
    duplicate_counts: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for case in cases:
        for slot in audit.SLOTS:
            key = (case.case_id, slot["slot"])
            candidates = attempts.get(key, [])
            result = _select_attempts(candidates)
            selected[key] = result
            duplicate_counts[case.cohort][slot["slot"]] += result.duplicate_attempts
    return _summary_from_selected(
        cases, selected, duplicate_counts, audit, provenance,
        phase=phase, input_file_sha256=input_file_sha256,
    )


def _summary_from_selected(
    cases: list[SummaryCase],
    selected: dict[tuple[str, str], Selection],
    duplicate_counts: dict[str, collections.Counter[str]],
    audit: Any,
    provenance: dict[str, str],
    *,
    phase: str,
    input_file_sha256: str,
) -> dict[str, Any]:
    return {
        "event": "payment_document_audit_summary",
        "phase": phase,
        "input_case_denominator": len(cases),
        "source_sha256": provenance["source_sha256"],
        "manifest_sha256": provenance["manifest_sha256"],
        "input_file_sha256": input_file_sha256,
        "payment_audit_helper_sha256": EXPECTED_AUDIT_SHA256,
        "review_helper_sha256": EXPECTED_REVIEW_SHA256,
        "payment_audit_prompt_sha256": EXPECTED_AUDIT_PROMPT_SHA256,
        "review_prompt_sha256": EXPECTED_REVIEW_PROMPT_SHA256,
        "endpoint_sha256": EXPECTED_ENDPOINT_SHA256,
        "summary_helper_sha256": SUMMARY_HELPER_SHA256,
        "cohorts": _cohort_summary(cases, selected, duplicate_counts, audit),
        "signal_definitions": {
            "pop_finding": "Valid assessment has one or more literal-evidence-validated findings classified as proof_of_payment.",
            "pop_potential_filing_yes": "At least one proof_of_payment finding has potential_filing=yes and exact source-substring evidence.",
            "pop_sender_claimed_supplied": "At least one proof_of_payment finding has sender_claimed_supplied with exact validated evidence; not proof of bytes.",
            "voucher_finding": "Valid assessment has one or more literal-evidence-validated findings classified as voucher.",
            "voucher_potential_filing_yes": "At least one voucher finding has potential_filing=yes and exact source-substring evidence.",
            "voucher_sender_claimed_supplied": "At least one voucher finding has sender_claimed_supplied with exact validated evidence; not proof of bytes.",
            "any_sender_claimed_supplied": "At least one finding of any kind has sender_claimed_supplied with exact validated evidence.",
            "any_yes_filing_literal_evidence": "At least one finding of any kind has potential_filing=yes and exact source-substring evidence.",
        },
        "interpretation_limits": (
            "Signals are supplemental model outputs, not ground truth. Empty findings do not establish that no document was supplied; "
            "both_no_yes means neither valid model yielded that signal, not proof of absence."
        ),
    }


def _summarize_private(args: argparse.Namespace) -> dict[str, Any]:
    _phase_gate(args.phase, args.holdout_unsealed)
    audit, review = _load_audit_and_review()
    if len(audit.SLOTS) != 2:
        raise SafeFailure("two_independent_slots_required")
    cases, provenance, private_root = _rederive_cases(args, audit, review)
    result_dirs = _distinct_result_dirs(args.result_dir, private_root, review)
    selected, duplicates = _collect_selections(
        cases, result_dirs, args.phase, provenance, audit, review,
    )
    return _summary_from_selected(
        cases, selected, duplicates, audit, provenance,
        phase=args.phase, input_file_sha256=provenance["input_file_sha256"],
    )


def _expect_failure(function: Any, code: str) -> bool:
    try:
        function()
    except Exception as exc:
        return getattr(exc, "code", None) == code
    return False


def _synthetic_case(case_id: str, cohort: str, body: str, *, sensitive: bool = False) -> SummaryCase:
    audit_input = {"subject": "Synthetic payment-document summary", "body": body, "attachments": []}
    return SummaryCase(
        case_id=case_id,
        cohort=cohort,
        embargoed=False,
        packet_sha256=_hash({"synthetic_case": case_id, "body": body}),
        input_sha256=_hash(audit_input),
        audit_input=audit_input,
        sensitive=sensitive,
    )


def _synthetic_normalized(audit: Any, review: Any, case: SummaryCase, *, empty: bool = False) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    if not empty:
        findings = [
            {
                "document_kind": "proof_of_payment",
                "supply_signal": "sender_claimed_supplied",
                "potential_filing": "yes",
                "evidence": [{
                    "source": "body", "file_index": None,
                    "quote": "I have attached proof of payment",
                }],
            },
            {
                "document_kind": "proof_of_payment",
                "supply_signal": "mentioned_only",
                "potential_filing": "no",
                "evidence": [{
                    "source": "body", "file_index": None,
                    "quote": "payment receipt",
                }],
            },
            {
                "document_kind": "voucher",
                "supply_signal": "sender_claimed_supplied",
                "potential_filing": "yes",
                "evidence": [{
                    "source": "body", "file_index": None,
                    "quote": "I have enclosed voucher",
                }],
            },
        ]
    normalized, _counts, error = audit.normalize_audit_output({"findings": findings}, case.audit_input, review)
    if error:
        raise AssertionError("synthetic_normalization_fixture_invalid")
    return normalized


def _synthetic_record(
    audit: Any,
    review: Any,
    case: SummaryCase,
    slot: dict[str, str],
    provenance: dict[str, str],
    *,
    status: str = "ok",
    normalized: dict[str, Any] | None = None,
    input_file_sha256: str = "c" * 64,
) -> dict[str, Any]:
    is_withheld = status == "withheld"
    return {
        "version": audit.VERSION,
        "case_id": case.case_id,
        "phase": "development",
        "cohort": case.cohort,
        "embargoed": case.embargoed,
        "slot": slot["slot"],
        "model": slot["model"],
        "reasoning_effort": slot["effort"],
        "review_helper_code_sha256": review.NORMALIZER_CODE_SHA256,
        "audit_helper_code_sha256": audit.NORMALIZER_CODE_SHA256,
        "review_prompt_sha256": EXPECTED_REVIEW_PROMPT_SHA256,
        "prompt_sha256": EXPECTED_AUDIT_PROMPT_SHA256,
        "endpoint_sha256": EXPECTED_ENDPOINT_SHA256,
        "source_sha256": provenance["source_sha256"],
        "manifest_sha256": provenance["manifest_sha256"],
        "input_file_sha256": input_file_sha256,
        "packet_sha256": case.packet_sha256,
        "input_sha256": case.input_sha256,
        "status": status,
        "error_code": "sensitive_payment_or_credential_pattern" if is_withheld
                      else "rate_limited" if status == "error" else None,
        "parse_status": "valid" if status == "ok" else None,
        "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}
                 if status == "ok" else {"input_tokens": None, "output_tokens": None, "total_tokens": None},
        "http_attempts": 0 if is_withheld else 2 if status == "error" else 1,
        "binary_fields_removed": 0,
        "control_fields_removed": 0,
        "validation_counts": {},
        "normalized": normalized if normalized is not None else audit._unknown_result(),
    }


def run_self_tests() -> int:
    """Offline tests use synthetic in-memory cases and temporary result files only."""
    audit, review = _load_audit_and_review()
    checks = 0

    def check(name: str, condition: bool) -> None:
        nonlocal checks
        if not condition:
            raise AssertionError(name)
        checks += 1

    check("frozen_helpers_loaded", audit.NORMALIZER_CODE_SHA256 == EXPECTED_AUDIT_SHA256
          and review.NORMALIZER_CODE_SHA256 == EXPECTED_REVIEW_SHA256)
    check("two_independent_model_slots", len(audit.SLOTS) == 2
          and [slot["slot"] for slot in audit.SLOTS] == ["luna_max", "sol_high"])
    check("holdout_requires_unseal", _expect_failure(
        lambda: _phase_gate("holdout", False), "holdout_not_unsealed",
    ))
    check("development_rejects_unseal", _expect_failure(
        lambda: _phase_gate("development", True), "holdout_flag_wrong_phase",
    ))
    check("invalid_phase_rejected", _expect_failure(
        lambda: _phase_gate("unknown", False), "phase_invalid",
    ))
    check("invalid_manifest_phase_rejected", _expect_failure(
        lambda: review._check_phase("SYNTHETIC_CASE", {
            "cohort": "random-holdout", "embargoed": False,
        }, "development", False), "phase_case_mismatch",
    ))
    check("eligible_development_phase_accepted", not _expect_failure(
        lambda: review._check_phase("SYNTHETIC_CASE", {
            "cohort": "random-development", "embargoed": False,
        }, "development", False), "phase_case_mismatch",
    ))
    check("sha256_shape_is_strict", _is_sha256("a" * 64) and not _is_sha256("A" * 64)
          and not _is_sha256("a" * 63))

    body = (
        "I have attached proof of payment. A payment receipt is mentioned. "
        "I have enclosed voucher. SYNTHETIC_TEXT_SENTINEL."
    )
    multi = _synthetic_case("SYNTHETIC_CASE_ID_SENTINEL", "random-development", body)
    empty = _synthetic_case("SYNTHETIC_EMPTY_CASE", "targeted-development", "Thank you for your message.")
    retry = _synthetic_case("SYNTHETIC_RETRY_CASE", "random-development", body)
    withheld = _synthetic_case("SYNTHETIC_WITHHELD_CASE", "targeted-development", "Synthetic withheld row.", sensitive=True)
    error_case = _synthetic_case("SYNTHETIC_ERROR_CASE", "random-development", "Synthetic error row.")
    normalized_multi = _synthetic_normalized(audit, review, multi)
    normalized_empty = _synthetic_normalized(audit, review, empty, empty=True)
    check("same_kind_multiple_findings_are_revalidated", len(normalized_multi["findings"]) == 3
          and sum(row["document_kind"] == "proof_of_payment" for row in normalized_multi["findings"]) == 2)
    signals, empty_flag = _signal_vector(normalized_multi)
    check("same_kind_messages_count_once_and_can_overlap", signals["pop_finding"]
          and signals["pop_potential_filing_yes"] and signals["pop_sender_claimed_supplied"]
          and signals["voucher_finding"] and signals["voucher_potential_filing_yes"]
          and signals["voucher_sender_claimed_supplied"] and signals["any_yes_filing_literal_evidence"]
          and not empty_flag)
    empty_signals, empty_flag = _signal_vector(normalized_empty)
    check("empty_findings_are_not_a_no_document_signal", empty_flag
          and not any(empty_signals.values()) and "no_document" not in SIGNALS)

    provenance = {"source_sha256": "a" * 64, "manifest_sha256": "b" * 64}
    first_luna = _synthetic_record(
        audit, review, multi, audit.SLOTS[0], provenance,
        normalized=normalized_multi, input_file_sha256="c" * 64,
    )
    later_luna = _synthetic_record(
        audit, review, multi, audit.SLOTS[0], provenance,
        normalized=normalized_empty, input_file_sha256="d" * 64,
    )
    first_check, first_error = _validate_result_record(
        first_luna, multi, audit.SLOTS[0], "development", provenance, audit, review,
    )
    later_check, later_error = _validate_result_record(
        later_luna, multi, audit.SLOTS[0], "development", provenance, audit, review,
    )
    check("valid_records_accept_different_shard_input_hashes", first_error is None
          and later_error is None and first_check is not None and later_check is not None)
    check("result_provenance_mismatch_rejected", _validate_result_record(
        {**first_luna, "packet_sha256": "0" * 64}, multi, audit.SLOTS[0],
        "development", provenance, audit, review,
    )[1] == "result_provenance_mismatch")
    bad_evidence = json.loads(json.dumps(first_luna))
    bad_evidence["normalized"]["findings"][0]["evidence"][0]["quote"] = "not literal source text"
    check("nonliteral_summary_evidence_rejected", _validate_result_record(
        bad_evidence, multi, audit.SLOTS[0], "development", provenance, audit, review,
    )[0] is None)

    selected_retry = _select_attempts([(first_check, None), (later_check, None)])
    check("first_valid_retry_is_stable_and_duplicates_counted", selected_retry.status == "ok"
          and selected_retry.signals == signals and selected_retry.duplicate_attempts == 1)
    selected_after_invalid = _select_attempts([
        (None, "result_provenance_mismatch"), (later_check, None),
    ])
    check("later_valid_retry_used_only_after_invalid", selected_after_invalid.status == "ok"
          and selected_after_invalid.signals == empty_signals
          and selected_after_invalid.invalid_attempts == 1
          and selected_after_invalid.duplicate_attempts == 1)
    check("missing_is_preserved", _select_attempts([]).status == "missing")

    withheld_record = _synthetic_record(audit, review, withheld, audit.SLOTS[0], provenance,
                                        status="withheld")
    valid_withheld, withheld_error = _validate_result_record(
        withheld_record, withheld, audit.SLOTS[0], "development", provenance, audit, review,
    )
    check("withheld_is_preserved_without_signals", withheld_error is None and valid_withheld == {"status": "withheld"}
          and _select_attempts([(valid_withheld, None)]).status == "withheld")
    wrong_withheld = _synthetic_record(audit, review, multi, audit.SLOTS[0], provenance, status="withheld")
    check("withheld_nonsensitive_row_rejected", _validate_result_record(
        wrong_withheld, multi, audit.SLOTS[0], "development", provenance, audit, review,
    )[0] is None)
    error_record = _synthetic_record(audit, review, error_case, audit.SLOTS[0], provenance, status="error")
    valid_error, error_validation = _validate_result_record(
        error_record, error_case, audit.SLOTS[0], "development", provenance, audit, review,
    )
    check("error_is_preserved", error_validation is None and _select_attempts(
        [(valid_error, None)],
    ).status == "error")

    retry_luna = first_check
    multi_sol, multi_sol_error = _validate_result_record(
        _synthetic_record(audit, review, multi, audit.SLOTS[1], provenance,
                          normalized=normalized_multi, input_file_sha256="e" * 64),
        multi, audit.SLOTS[1], "development", provenance, audit, review,
    )
    empty_luna, _ = _validate_result_record(
        _synthetic_record(audit, review, retry, audit.SLOTS[0], provenance,
                          normalized=normalized_multi, input_file_sha256="f" * 64),
        retry, audit.SLOTS[0], "development", provenance, audit, review,
    )
    empty_sol, _ = _validate_result_record(
        _synthetic_record(audit, review, retry, audit.SLOTS[1], provenance,
                          normalized=normalized_empty, input_file_sha256="1" * 64),
        retry, audit.SLOTS[1], "development", provenance, audit, review,
    )
    empty_luna_select, _ = _validate_result_record(
        _synthetic_record(audit, review, empty, audit.SLOTS[0], provenance,
                          normalized=normalized_empty, input_file_sha256="2" * 64),
        empty, audit.SLOTS[0], "development", provenance, audit, review,
    )
    empty_sol_select, _ = _validate_result_record(
        _synthetic_record(audit, review, empty, audit.SLOTS[1], provenance,
                          normalized=normalized_empty, input_file_sha256="3" * 64),
        empty, audit.SLOTS[1], "development", provenance, audit, review,
    )
    error_select, _ = _validate_result_record(error_record, error_case, audit.SLOTS[0],
                                               "development", provenance, audit, review)
    later_success_after_error, later_success_error = _validate_result_record(
        _synthetic_record(audit, review, error_case, audit.SLOTS[0], provenance,
                          normalized=normalized_empty, input_file_sha256="5" * 64),
        error_case, audit.SLOTS[0], "development", provenance, audit, review,
    )
    error_first = _select_attempts([
        (error_select, None), (later_success_after_error, None),
    ])
    check("later_success_used_after_exact_error", later_success_error is None
          and error_first.status == "ok" and error_first.signals == empty_signals
          and error_first.duplicate_attempts == 1)
    error_only = _select_attempts([(error_select, None), (None, "invalid")])
    check("first_error_retained_if_no_success", error_only.status == "error"
          and error_only.error_code == "rate_limited" and error_only.invalid_attempts == 1)
    error_sol_empty, _ = _validate_result_record(
        _synthetic_record(audit, review, error_case, audit.SLOTS[1], provenance,
                          normalized=normalized_empty, input_file_sha256="4" * 64),
        error_case, audit.SLOTS[1], "development", provenance, audit, review,
    )
    attempts = {
        (multi.case_id, audit.SLOTS[0]["slot"]): [(retry_luna, None), (later_check, None)],
        (multi.case_id, audit.SLOTS[1]["slot"]): [(multi_sol, None)],
        (retry.case_id, audit.SLOTS[0]["slot"]): [(empty_luna, None)],
        (retry.case_id, audit.SLOTS[1]["slot"]): [(empty_sol, None)],
        (empty.case_id, audit.SLOTS[0]["slot"]): [(empty_luna_select, None)],
        (empty.case_id, audit.SLOTS[1]["slot"]): [(empty_sol_select, None)],
        (withheld.case_id, audit.SLOTS[0]["slot"]): [(valid_withheld, None)],
        (error_case.case_id, audit.SLOTS[0]["slot"]): [(error_select, None)],
        (error_case.case_id, audit.SLOTS[1]["slot"]): [(error_sol_empty, None)],
    }
    synthetic_cases = [multi, retry, empty, withheld, error_case]
    summary = summarize_cases(
        synthetic_cases, attempts, audit, provenance, phase="development",
        input_file_sha256="9" * 64,
    )
    random_cohort = next(row for row in summary["cohorts"] if row["trusted_cohort"] == "random-development")
    target_cohort = next(row for row in summary["cohorts"] if row["trusted_cohort"] == "targeted-development")
    luna_random = random_cohort["by_independent_slot"][audit.SLOTS[0]["slot"]]
    check("status_denominators_preserve_error_and_missing", luna_random["status_counts"] == {
        "ok": 2, "withheld": 0, "error": 1, "missing": 0,
    } and target_cohort["by_independent_slot"][audit.SLOTS[1]["slot"]]["status_counts"] == {
        "ok": 1, "withheld": 0, "error": 0, "missing": 1,
    })
    check("message_level_count_not_finding_count", luna_random["signal_yes_counts"]["pop_finding"] == 2
          and luna_random["signal_yes_counts"]["voucher_finding"] == 2)
    check("retry_duplicates_are_counted_per_slot", luna_random["duplicate_attempts"] == 1)
    check("both_yes_category", random_cohort["two_slot_signal_agreement"]["pop_finding"]["both_yes"] == 1)
    check("one_yes_other_not_yes_category", random_cohort["two_slot_signal_agreement"]["pop_finding"]["one_yes_other_not_yes"] == 1)
    check("both_no_yes_category", target_cohort["two_slot_signal_agreement"]["pop_finding"]["both_no_yes"] == 1)
    check("incomplete_category_includes_withheld_missing_error", target_cohort["two_slot_signal_agreement"]["pop_finding"]["incomplete"] == 1
          and random_cohort["two_slot_signal_agreement"]["pop_finding"]["incomplete"] == 1)
    summary_json = json.dumps(summary, ensure_ascii=False, sort_keys=True)
    check("stdout_summary_has_no_identifiers_text_or_quotes", all(
        sentinel not in summary_json for sentinel in (
            multi.case_id, retry.case_id, "I have attached proof of payment",
            "SYNTHETIC_TEXT_SENTINEL", "SYNTHETIC_CASE_ID_SENTINEL",
        )
    ))
    check("summary_never_labels_empty_as_no_document", "no_document" not in summary_json
          and "proof of absence" in summary["interpretation_limits"])

    with tempfile.TemporaryDirectory(prefix="payment-summary-selftest-") as temp_name:
        private_root = pathlib.Path(temp_name) / "synthetic-private-root"
        private_root.mkdir(mode=0o700)
        result_dir = private_root / "synthetic-run"
        result_dir.mkdir(mode=0o700)
        retry_dir = private_root / "synthetic-retry"
        retry_dir.mkdir(mode=0o700)
        for folder, record in ((result_dir, first_luna), (retry_dir, later_luna)):
            output_path = folder / audit._record_filename(multi.case_id, audit.SLOTS[0], "development")
            fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                data = json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8")
                os.write(fd, data)
            finally:
                os.close(fd)
        check("temporary_owner_only_result_directory_accepted", _validate_result_dir(
            result_dir, private_root, review,
        ) == result_dir.resolve())
        check("duplicate_result_dir_argument_rejected", _expect_failure(
            lambda: _distinct_result_dirs([str(result_dir), str(result_dir)], private_root, review),
            "duplicate_result_dir_argument",
        ))
        file_selection, file_duplicates = _collect_selections(
            [multi], [result_dir, retry_dir], "development", provenance, audit, review,
        )
        check("private_result_files_use_declared_retry_order", file_selection[
            (multi.case_id, audit.SLOTS[0]["slot"])
        ].signals == signals and file_duplicates[multi.cohort][audit.SLOTS[0]["slot"]] == 1)
        result_dir.chmod(0o755)
        check("nonprivate_result_directory_rejected", _expect_failure(
            lambda: _validate_result_dir(result_dir, private_root, review), "result_dir_not_private",
        ))
    return checks


def _base_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("self-test", help="run synthetic-only offline checks")
    summary = commands.add_parser("summarize", help="aggregate exact, private audit records")
    summary.add_argument("--source", required=True)
    summary.add_argument("--manifest", required=True)
    summary.add_argument("--input", required=True)
    summary.add_argument("--result-dir", action="append", required=True,
                         help="owner-only payment-audit result directory; repeat in retry order")
    summary.add_argument("--phase", choices=("development", "holdout"), default="development")
    summary.add_argument("--holdout-unsealed", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _base_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            checks = run_self_tests()
            print(json.dumps({
                "event": "payment_document_summary_self_test",
                "status": "pass",
                "checks": checks,
                "summary_helper_sha256": SUMMARY_HELPER_SHA256,
                "payment_audit_helper_sha256": EXPECTED_AUDIT_SHA256,
                "review_helper_sha256": EXPECTED_REVIEW_SHA256,
                "private_inputs_read": 0,
            }, sort_keys=True))
            return 0
        summary = _summarize_private(args)
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except SafeFailure as exc:
        print(json.dumps({"event": "payment_document_summary_error", "error": exc.code}, sort_keys=True))
        return 2
    except AssertionError as exc:
        code = str(exc)[:100] if args.command == "self-test" else "internal"
        print(json.dumps({"event": "payment_document_summary_error", "error": code}, sort_keys=True))
        return 2
    except Exception:
        print(json.dumps({"event": "payment_document_summary_error", "error": "internal"}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
