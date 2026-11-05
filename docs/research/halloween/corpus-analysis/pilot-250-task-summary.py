#!/usr/bin/env python3
"""Offline aggregate of first-pass model-inferred task states by cohort and slot.

Reads only the owner-only frozen pilot manifest and normalized assessment
JSONL under .private. It emits counts only: no source text, case identifiers,
quotes, transcripts, or per-case rows. Each slot stays separate. Review
rollups deduplicate POP/voucher filing within one file/stay only; totals here
are not deduplicated across case rows into unique tasks, independent truth,
or observed assistance.

Offline check: python3 -I -B pilot-250-task-summary.py --self-test
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import re
import sys
from collections import Counter
from typing import Any, Sequence


VERSION = "centurion-pilot-task-summary-v1"
SOURCE_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
TASK_STATES = ("helped_complete", "helped_partial", "not_helped", "unknown")
SLOT_MODEL_EFFORT = {
    "luna_max_a": ("gpt-6-luna", "max"),
    "luna_max_b": ("gpt-6-luna", "max"),
    "sol_high": ("gpt-6.1-sol", "high"),
}
DEV_COHORTS = ("random_development", "targeted_development")
HOLDOUT_COHORTS = ("random_holdout", "embargoed_development")


class SafeFailure(Exception):
    """Expected failure represented only by a non-sensitive code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _require_current_normalizer(records: Sequence[dict[str, Any]], review: Any) -> None:
    """Do not recompute task states using different code than the recorded normalizer."""
    for record in records:
        if record.get("arm") == "cleaned" and type(record.get("round")) is int and record["round"] == 1:
            if record.get("normalizer_code_sha256") != review.NORMALIZER_CODE_SHA256:
                raise SafeFailure("assessment_normalizer_not_current")


def _load_helper(filename: str, module_name: str) -> Any:
    path = pathlib.Path(__file__).resolve().with_name(filename)
    try:
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise SafeFailure("helper_unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except SafeFailure:
        raise
    except Exception:
        raise SafeFailure("helper_unavailable") from None


def _analysis_helper() -> Any:
    return _load_helper("pilot-250-analysis.py", "pilot_250_analysis_task_summary_runtime")


def _review_helper() -> Any:
    return _load_helper("pilot-250-review.py", "pilot_250_review_task_summary_runtime")


def _prepare_helper() -> Any:
    return _load_helper("pilot-250-prepare.py", "pilot_250_prepare_task_summary_runtime")


def _trusted_manifest(document: Any, analysis: Any, prepare: Any) -> tuple[str, dict[str, dict[str, Any]]]:
    """Validate frozen source/seed/cohort design before trusting cohort labels."""
    try:
        validated_rows = prepare._validate_manifest(
            document,
            source_sha256=prepare.PLAN_SOURCE_SHA256,
            seed=prepare.PLAN_SEED,
            expected_counts=prepare.PLAN_COHORT_COUNTS,
        )
        _seed, manifest = analysis._validate_manifest(document)
    except Exception:
        raise SafeFailure("manifest_untrusted") from None
    source_sha256 = document.get("source_sha256") if isinstance(document, dict) else None
    if not isinstance(source_sha256, str) or not SOURCE_SHA256_RE.fullmatch(source_sha256):
        raise SafeFailure("manifest_source_invalid")
    if {row.get("case_id") for row in validated_rows} != set(manifest):
        raise SafeFailure("manifest_identity_mismatch")
    return source_sha256, manifest


def _test_normalized(
    work_items: list[dict[str, Any]] | None = None,
    documents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "origin": {},
        "work_items": work_items or [],
        "documents": documents or [],
        "rollup": {},
        "evidence_quotes": ["SYNTHETIC_CONTENT_SENTINEL"],
    }


def _test_record(
    case_id: str,
    slot: str,
    normalized: dict[str, Any],
    *,
    phase: str = "development",
    status: str = "ok",
    parse_status: str | None = "valid",
    **overrides: Any,
) -> dict[str, Any]:
    model, effort = SLOT_MODEL_EFFORT[slot]
    record = {
        "case_id": case_id,
        "phase": phase,
        "arm": "cleaned",
        "round": 1,
        "arm_pair_sha256": "a" * 64,
        "slot": slot,
        "model": model,
        "reasoning_effort": effort,
        "input_sha256": "b" * 64,
        "prompt_sha256": "c" * 64,
        "endpoint_sha256": "d" * 64,
        "normalizer_code_sha256": "e" * 64,
        "source_sha256": "f" * 64,
        "status": status,
        "parse_status": parse_status,
        "normalized": normalized,
        "raw_output_text": "SYNTHETIC_TRANSCRIPT_SENTINEL",
    }
    record.update(overrides)
    return record


def _summarize_records(
    manifest: dict[str, dict[str, Any]],
    records: Sequence[dict[str, Any]],
    source_sha256: str,
    holdout_unsealed: bool,
    analysis: Any,
    review: Any,
) -> dict[str, Any]:
    """Build counts from trusted manifest rows and the selected first pass."""
    if not SOURCE_SHA256_RE.fullmatch(source_sha256):
        raise SafeFailure("source_provenance_invalid")
    if type(holdout_unsealed) is not bool:
        raise SafeFailure("holdout_flag_invalid")
    if not isinstance(manifest, dict) or not isinstance(records, Sequence):
        raise SafeFailure("summary_input_invalid")

    for row in records:
        if not isinstance(row, dict):
            raise SafeFailure("assessment_record_invalid")
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or case_id not in manifest:
            raise SafeFailure("assessment_manifest_mismatch")
        entry = manifest[case_id]
        expected_phase = entry.get("expected_phase")
        row_phase = row.get("phase")
        has_holdout_result = row_phase == "holdout" or expected_phase == "holdout"
        if has_holdout_result and not holdout_unsealed:
            raise SafeFailure("holdout_unsealed_required")
        if row_phase != expected_phase:
            raise SafeFailure("assessment_phase_mismatch")
        if "source_sha256" in row:
            row_source = row.get("source_sha256")
            if (not isinstance(row_source, str)
                    or not SOURCE_SHA256_RE.fullmatch(row_source)
                    or row_source != source_sha256):
                raise SafeFailure("assessment_source_mismatch")
        if row.get("arm") == "cleaned" and type(row.get("round")) is int and row["round"] == 1:
            slot = row.get("slot")
            if slot not in SLOT_MODEL_EFFORT:
                raise SafeFailure("assessment_slot_invalid")
            if (row.get("model"), row.get("reasoning_effort")) != SLOT_MODEL_EFFORT[slot]:
                raise SafeFailure("assessment_slot_model_effort_mismatch")

    try:
        chosen, _diagnostics = analysis._first_pass_rows(records, manifest)
    except Exception as exc:
        code = getattr(exc, "code", None)
        if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,80}", code):
            raise SafeFailure(code) from None
        raise SafeFailure("assessment_provenance_invalid") from None

    include_holdout = holdout_unsealed
    cohort_cases: dict[str, list[str]] = {}
    for case_id, entry in manifest.items():
        if not include_holdout and entry.get("expected_phase") == "holdout":
            continue
        cohort = entry.get("cohort")
        if not isinstance(cohort, str):
            raise SafeFailure("manifest_cohort_invalid")
        cohort_cases.setdefault(cohort, []).append(case_id)

    cohorts: dict[str, Any] = {}
    for cohort, case_ids in sorted(cohort_cases.items()):
        slot_summaries: dict[str, Any] = {}
        for slot in SLOT_MODEL_EFFORT:
            states: Counter[str] = Counter()
            for case_id in case_ids:
                record = chosen.get(case_id, {}).get("slots", {}).get(slot)
                if analysis._record_status(record) != "valid":
                    # Missing, failed, withheld, or invalid assessment stays visible.
                    states["unknown"] += 1
                    continue
                normalized = record.get("normalized")
                if (not isinstance(normalized, dict)
                        or any(not isinstance(item, dict)
                               for item in normalized.get("work_items", []))
                        or any(not isinstance(item, dict)
                               for item in normalized.get("documents", []))):
                    states["unknown"] += 1
                    continue
                try:
                    task_states = review._derive_rollup(normalized).get("task_states")
                except Exception:
                    task_states = None
                if not isinstance(task_states, dict):
                    states["unknown"] += 1
                    continue
                valid_counts = True
                for state, count in task_states.items():
                    if (state not in TASK_STATES or type(count) is not int or count < 0):
                        valid_counts = False
                        break
                if not valid_counts:
                    states["unknown"] += 1
                    continue
                states.update(task_states)
            slot_summaries[slot] = {
                "task_state_counts": {state: states[state] for state in TASK_STATES},
            }
        cohorts[cohort] = {"slots": slot_summaries}

    return {
        "summary_version": VERSION,
        "interpretation": (
            "model-inferred task states per slot; not independent truth or observed assistance; "
            "not deduplicated across case rows into unique tasks; not merged across slots"
        ),
        "missing_assessment_rule": (
            "each missing, failed, withheld, or invalid case-slot assessment contributes one unknown placeholder"
        ),
        "source_provenance_note": (
            "manifest source pin validated; optional record source_sha256 must match it; per-case input and "
            "arm-pair fingerprints select first-pass records; this summary does not reopen source or rederive "
            "each record-to-source row link"
        ),
        "cohorts": cohorts,
    }


def run_self_tests() -> int:
    """Synthetic-only checks; no private input, file, network, or model access."""
    analysis = _analysis_helper()
    review = _review_helper()
    prepare = _prepare_helper()
    checks: list[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            raise SafeFailure("self_test_failed_" + name)
        checks.append(name)

    def expect_failure(function: Any, code: str) -> bool:
        try:
            function()
        except Exception as exc:
            return getattr(exc, "code", None) == code
        return False

    current_record = _test_record(
        "SYNTHETIC_CURRENT", "luna_max_a", _test_normalized(),
        normalizer_code_sha256=review.NORMALIZER_CODE_SHA256,
    )
    _require_current_normalizer([current_record], review)
    check("current_normalizer_required", expect_failure(
        lambda: _require_current_normalizer(
            [dict(current_record, normalizer_code_sha256="0" * 64)], review,
        ), "assessment_normalizer_not_current",
    ))

    def manifest_entry(
        cohort: str = "random_development", *, embargoed: bool = False,
    ) -> dict[str, Any]:
        return {
            "source_row_id": "SYNTHETIC_SOURCE_ROW",
            "cohort": cohort,
            "embargoed": embargoed,
            "expected_phase": "holdout" if cohort in HOLDOUT_COHORTS else "development",
        }

    manifest = {"SYNTHETIC_CASE_A": manifest_entry()}
    source_sha = "f" * 64
    docs = [
        {
            "stay_index": 0,
            "file_index": 7,
            "kinds": ["proof_of_payment"],
            "filing_trigger": "yes",
            "filing_scope": "in_scope",
            "filing_assistance": "complete",
        },
        {
            "stay_index": 0,
            "file_index": 7,
            "kinds": ["voucher"],
            "filing_trigger": "yes",
            "filing_scope": "in_scope",
            "filing_assistance": "complete",
        },
    ]
    normalized = _test_normalized([
        {"action": "proof_of_payment", "stay_index": 0, "scope": "in_scope", "assistance": "complete"},
        {"action": "voucher", "stay_index": 0, "scope": "in_scope", "assistance": "complete"},
    ], docs)
    summary = _summarize_records(
        manifest,
        [_test_record("SYNTHETIC_CASE_A", slot, normalized) for slot in SLOT_MODEL_EFFORT],
        source_sha,
        False,
        analysis,
        review,
    )
    slot_counts = summary.get("cohorts", {}).get("random_development", {}).get("slots", {})
    check("same_file_pop_voucher_once", all(
        slot_counts.get(slot, {}).get("task_state_counts", {}).get("helped_complete") == 1
        for slot in SLOT_MODEL_EFFORT
    ))

    separate_normalized = _test_normalized(
        [{"action": "billing", "scope": "in_scope", "assistance": "complete"}], docs[:1],
    )
    separate_summary = _summarize_records(
        manifest,
        [_test_record("SYNTHETIC_CASE_A", slot, separate_normalized) for slot in SLOT_MODEL_EFFORT],
        source_sha,
        False,
        analysis,
        review,
    )
    separate_counts = (
        separate_summary.get("cohorts", {}).get("random_development", {}).get("slots", {})
    )
    check("separate_work_and_file_each_counted", all(
        separate_counts.get(slot, {}).get("task_state_counts", {}).get("helped_complete") == 2
        for slot in SLOT_MODEL_EFFORT
    ))

    unknown_normalized = _test_normalized([{"action": "unknown"}])
    unknown_summary = _summarize_records(
        manifest,
        [_test_record("SYNTHETIC_CASE_A", slot, unknown_normalized) for slot in SLOT_MODEL_EFFORT],
        source_sha,
        False,
        analysis,
        review,
    )
    unknown_slots = unknown_summary["cohorts"]["random_development"]["slots"]
    check(
        "unknown_model_evidence_retained",
        all(unknown_slots[slot]["task_state_counts"]["unknown"] == 1 for slot in SLOT_MODEL_EFFORT),
    )

    two_case_manifest = {
        "SYNTHETIC_CASE_A": manifest_entry(),
        "SYNTHETIC_CASE_B": manifest_entry(),
    }
    missing_summary = _summarize_records(
        two_case_manifest,
        [_test_record("SYNTHETIC_CASE_A", "luna_max_a", unknown_normalized)],
        source_sha,
        False,
        analysis,
        review,
    )
    missing_slots = missing_summary["cohorts"]["random_development"]["slots"]
    check(
        "missing_case_slot_becomes_unknown",
        missing_slots["luna_max_a"]["task_state_counts"]["unknown"] == 2
        and missing_slots["luna_max_b"]["task_state_counts"]["unknown"] == 2
        and missing_slots["sol_high"]["task_state_counts"]["unknown"] == 2,
    )
    failed_summary = _summarize_records(
        manifest,
        [_test_record(
            "SYNTHETIC_CASE_A", "luna_max_a", separate_normalized,
            status="error", parse_status=None,
        )],
        source_sha,
        False,
        analysis,
        review,
    )
    check(
        "failed_assessment_retained_as_unknown",
        failed_summary["cohorts"]["random_development"]["slots"]["luna_max_a"]
        ["task_state_counts"]["unknown"] == 1,
    )

    retry_success = _test_record(
        "SYNTHETIC_CASE_A", "luna_max_a", separate_normalized,
    )
    retry_failure = _test_record(
        "SYNTHETIC_CASE_A", "luna_max_a", separate_normalized,
        status="error", parse_status=None,
    )
    latest_failed = _summarize_records(
        manifest, [retry_success, retry_failure], source_sha, False, analysis, review,
    )
    latest_success = _summarize_records(
        manifest, [retry_failure, retry_success], source_sha, False, analysis, review,
    )
    check(
        "retry_history_latest_append_wins",
        latest_failed["cohorts"]["random_development"]["slots"]["luna_max_a"]
        ["task_state_counts"]["unknown"] == 1
        and latest_success["cohorts"]["random_development"]["slots"]["luna_max_a"]
        ["task_state_counts"]["helped_complete"] == 2,
    )

    ignored_original = dict(retry_success, arm="original")
    ignored_later_round = dict(retry_success, round=2)
    no_work = _test_normalized([{"action": "no_current_work"}])
    first_pass_only = _summarize_records(
        manifest,
        [
            _test_record("SYNTHETIC_CASE_A", "luna_max_a", no_work),
            ignored_original,
            ignored_later_round,
        ],
        source_sha,
        False,
        analysis,
        review,
    )
    check(
        "only_cleaned_round_one_contributes",
        first_pass_only["cohorts"]["random_development"]["slots"]["luna_max_a"]
        ["task_state_counts"]["helped_complete"] == 0,
    )

    phase_manifest = {
        "SYNTHETIC_CASE_A": manifest_entry(),
        "SYNTHETIC_CASE_HOLDOUT": manifest_entry("random_holdout", embargoed=True),
        "SYNTHETIC_CASE_EMBARGOED": manifest_entry("embargoed_development", embargoed=True),
    }
    development_summary = _summarize_records(
        phase_manifest,
        [_test_record("SYNTHETIC_CASE_A", "luna_max_a", unknown_normalized)],
        source_sha,
        False,
        analysis,
        review,
    )
    check(
        "development_summary_excludes_unsealed_cohorts",
        set(development_summary["cohorts"]) == {"random_development"},
    )
    holdout_record = _test_record(
        "SYNTHETIC_CASE_HOLDOUT", "luna_max_a", unknown_normalized, phase="holdout",
    )
    embargoed_record = _test_record(
        "SYNTHETIC_CASE_EMBARGOED", "luna_max_a", unknown_normalized, phase="holdout",
    )
    check(
        "holdout_results_require_explicit_flag",
        expect_failure(
            lambda: _summarize_records(
                phase_manifest, [holdout_record], source_sha, False, analysis, review,
            ),
            "holdout_unsealed_required",
        )
        and expect_failure(
            lambda: _summarize_records(
                phase_manifest, [embargoed_record], source_sha, False, analysis, review,
            ),
            "holdout_unsealed_required",
        ),
    )
    allowed_holdout = _summarize_records(
        phase_manifest,
        [holdout_record, embargoed_record],
        source_sha,
        True,
        analysis,
        review,
    )
    serialized = json.dumps(allowed_holdout, sort_keys=True)
    check(
        "holdout_allowed_only_when_flagged_and_no_content_or_ids",
        set(allowed_holdout["cohorts"]) == {
            "random_development", "random_holdout", "embargoed_development",
        }
        and all(marker not in serialized for marker in (
            "SYNTHETIC_CASE_", "SYNTHETIC_SOURCE_", "SYNTHETIC_CONTENT_SENTINEL",
            "SYNTHETIC_TRANSCRIPT_SENTINEL",
        )),
    )

    wrong_source = _test_record(
        "SYNTHETIC_CASE_A", "luna_max_a", unknown_normalized,
        source_sha256="0" * 64,
    )
    check(
        "record_source_fingerprint_mismatch_rejected",
        expect_failure(
            lambda: _summarize_records(manifest, [wrong_source], source_sha, False, analysis, review),
            "assessment_source_mismatch",
        ),
    )
    bad_slot = _test_record(
        "SYNTHETIC_CASE_A", "luna_max_a", unknown_normalized,
        model="gpt-6.1-sol",
    )
    check(
        "model_slot_provenance_mismatch_rejected",
        expect_failure(
            lambda: _summarize_records(manifest, [bad_slot], source_sha, False, analysis, review),
            "assessment_slot_model_effort_mismatch",
        ),
    )
    provenance_checks: list[bool] = []
    for field in ("prompt_sha256", "endpoint_sha256", "normalizer_code_sha256"):
        second_record = _test_record(
            "SYNTHETIC_CASE_B", "luna_max_a", unknown_normalized, **{field: "9" * 64},
        )
        first_record = _test_record(
            "SYNTHETIC_CASE_A", "luna_max_a", unknown_normalized,
        )
        provenance_checks.append(expect_failure(
            lambda rows=[first_record, second_record]: _summarize_records(
                two_case_manifest, rows, source_sha, False, analysis, review,
            ),
            "first_pass_provenance_not_uniform",
        ))
    check("prompt_endpoint_normalizer_must_be_uniform", all(provenance_checks))

    changed_input = _test_record(
        "SYNTHETIC_CASE_A", "luna_max_b", separate_normalized,
        input_sha256="9" * 64,
    )
    unmerged_versions = _summarize_records(
        manifest,
        [retry_success, changed_input],
        source_sha,
        False,
        analysis,
        review,
    )
    unmerged_slots = unmerged_versions["cohorts"]["random_development"]["slots"]
    check(
        "different_input_fingerprints_are_not_mixed",
        unmerged_slots["luna_max_a"]["task_state_counts"]["helped_complete"] == 2
        and unmerged_slots["luna_max_b"]["task_state_counts"]["unknown"] == 1,
    )

    manifest_rows: list[dict[str, Any]] = []
    case_number = 0
    for cohort, count in prepare.PLAN_COHORT_COUNTS.items():
        for index in range(count):
            case_number += 1
            embargoed = cohort == "targeted_development" and index == count - 1
            manifest_rows.append({
                "case_id": f"case-{case_number:03d}",
                "source_row_id": f"SYNTHETIC_SOURCE_ROW_{case_number:03d}",
                "thread_id": f"SYNTHETIC_THREAD_{case_number:03d}",
                "source_line": case_number,
                "message_index": 0,
                "timestamp": "2026-10-01T09:00:00Z",
                "cohort": cohort,
                "embargoed": embargoed,
                "stratum": "synthetic",
                "cue_flags": [],
            })
    synthetic_manifest = {
        "schema": "centurion-pilot250-v1",
        "seed": prepare.PLAN_SEED,
        "source_sha256": prepare.PLAN_SOURCE_SHA256,
        "selected": manifest_rows,
    }
    manifest_source, trusted = _trusted_manifest(synthetic_manifest, analysis, prepare)
    check(
        "pinned_synthetic_manifest_validation",
        manifest_source == prepare.PLAN_SOURCE_SHA256 and len(trusted) == 250
        and sum(entry["cohort"] == "embargoed_development" for entry in trusted.values()) == 1,
    )
    wrong_manifest = dict(synthetic_manifest, source_sha256="0" * 64)
    check(
        "untrusted_manifest_source_rejected",
        expect_failure(
            lambda: _trusted_manifest(wrong_manifest, analysis, prepare), "manifest_untrusted",
        ),
    )
    return len(checks)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="Frozen pilot manifest under owner-only .private")
    parser.add_argument("--assessments", help="Normalized assessment JSONL under owner-only .private")
    parser.add_argument(
        "--holdout-unsealed",
        action="store_true",
        help="Required when assessment results include holdout or embargoed rows",
    )
    parser.add_argument("--self-test", action="store_true", help="Run synthetic offline checks only")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.self_test:
        try:
            checks = run_self_tests()
            print(json.dumps({"self_test": "passed", "synthetic_checks": checks, "model_calls": 0}))
            return 0
        except Exception as exc:
            code = getattr(exc, "code", "internal")
            if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,80}", code):
                code = "internal"
            print("error=" + code, file=sys.stderr)
            return 2
    if not args.manifest or not args.assessments:
        parser.error("--manifest and --assessments are required")
    try:
        analysis = _analysis_helper()
        review = _review_helper()
        prepare = _prepare_helper()
        private_root = analysis._private_root()
        manifest_path = analysis._private_input_path(
            args.manifest, private_root, 32 * 1024 * 1024,
        )
        assessment_path = analysis._private_input_path(args.assessments, private_root)
        manifest_raw = review._read_limited_private(
            manifest_path, "manifest", 32 * 1024 * 1024,
        )
        manifest_document = review._strict_json_loads(manifest_raw)
        source_sha256, manifest = _trusted_manifest(manifest_document, analysis, prepare)
        records = review._load_result_records(assessment_path, missing_ok=False)
        _require_current_normalizer(records, review)
        summary = _summarize_records(
            manifest, records, source_sha256, args.holdout_unsealed, analysis, review,
        )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as exc:
        code = getattr(exc, "code", None)
        if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,80}", code):
            code = "internal"
        print("error=" + code, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
