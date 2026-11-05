#!/usr/bin/env python3
"""Aggregate message-level overlapping action labels from the Centurion pilot.

Uses the frozen manifest validator and first-pass endpoint/version grouping in
pilot-250-analysis.py. The helper never calls a model or network. Private inputs
must be owner-only children of .private; --self-test uses synthetic data only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from typing import Any, Mapping, Sequence


def _load_analysis_helper() -> Any:
    analysis_path = Path(__file__).with_name("pilot-250-analysis.py")
    try:
        spec = importlib.util.spec_from_file_location("pilot_250_analysis_for_overlap", analysis_path)
        if spec is None or spec.loader is None:
            raise RuntimeError
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        raise RuntimeError("analysis_helper_unavailable") from None


_ANALYSIS = _load_analysis_helper()
ACTIONS = tuple(sorted(_ANALYSIS.ACTION_LABELS - {"unknown"}))
SLOTS = tuple(_ANALYSIS.SLOTS)
COHORTS = tuple(_ANALYSIS.COHORTS)
ACTION_STATES = ("yes", "not_labelled", "unknown")
TRIAD_STATES = ("unanimous_yes", "unanimous_not_labelled", "disagreement", "uncertain", "incomplete")
OVER_TEN_STATES = ("yes", "no", "unknown", "not_applicable")
FIRST_PASS_DIAGNOSTICS = (
    "selected_first_pass_records",
    "records_with_unverifiable_version_hashes",
    "cases_with_multiple_first_pass_versions",
    "cases_with_multiple_first_pass_endpoints",
    "duplicate_attempt_records",
)


def _action_state(record: dict[str, Any] | None, action: str) -> str:
    if _ANALYSIS._record_status(record) != "valid":
        return "unknown"
    assert record is not None
    normalized = record.get("normalized")
    work_items = normalized.get("work_items") if isinstance(normalized, dict) else None
    if not isinstance(work_items, list):
        return "unknown"

    present = False
    unresolved_item = False
    for item in work_items:
        if not isinstance(item, dict):
            unresolved_item = True
            continue
        item_action = item.get("action")
        if item_action == action:
            present = True
        elif (
            not isinstance(item_action, str)
            or item_action == "unknown"
            or item_action not in _ANALYSIS.ACTION_LABELS
        ):
            unresolved_item = True
    if present:
        return "yes"
    return "unknown" if unresolved_item else "not_labelled"


def _action_triad_state(slot_records: Mapping[str, dict[str, Any]], action: str) -> str:
    labels: list[str] = []
    for slot in SLOTS:
        record = slot_records.get(slot)
        if _ANALYSIS._record_status(record) != "valid":
            return "incomplete"
        labels.append(_action_state(record, action))
    if "unknown" in labels:
        return "uncertain"
    if all(label == "yes" for label in labels):
        return "unanimous_yes"
    if all(label == "not_labelled" for label in labels):
        return "unanimous_not_labelled"
    return "disagreement"


def _over_ten_state(record: dict[str, Any] | None) -> str:
    if _ANALYSIS._record_status(record) != "valid":
        return "unknown"
    assert record is not None
    normalized = record.get("normalized")
    if not isinstance(normalized, dict):
        return "unknown"
    value = _ANALYSIS._features(normalized).get("over_10_room_exclusion")
    return value if value in OVER_TEN_STATES else "unknown"


def summarize_overlap_data(
    manifest_document: Any,
    assessment_records: Sequence[dict[str, Any]],
    *,
    holdout_unsealed: bool = False,
) -> dict[str, Any]:
    _ANALYSIS._require_holdout_unsealed(assessment_records, holdout_unsealed)
    _seed, manifest = _ANALYSIS._validate_manifest(manifest_document)
    first_pass, diagnostics = _ANALYSIS._first_pass_rows(assessment_records, manifest)
    cohorts: dict[str, Any] = {}

    for cohort in COHORTS:
        case_ids = [case_id for case_id, row in manifest.items() if row["cohort"] == cohort]
        per_action: dict[str, Any] = {}
        over_ten_counts = {
            slot: {state: 0 for state in OVER_TEN_STATES}
            for slot in SLOTS
        }

        for action in ACTIONS:
            per_slot = {
                slot: {state: 0 for state in ACTION_STATES}
                for slot in SLOTS
            }
            triad_counts = {state: 0 for state in TRIAD_STATES}
            for case_id in case_ids:
                slots = first_pass.get(case_id, {}).get("slots", {})
                for slot in SLOTS:
                    per_slot[slot][_action_state(slots.get(slot), action)] += 1
                triad_counts[_action_triad_state(slots, action)] += 1
            per_action[action] = {
                "per_slot": per_slot,
                "strict_triad": triad_counts,
            }

        for case_id in case_ids:
            slots = first_pass.get(case_id, {}).get("slots", {})
            for slot in SLOTS:
                over_ten_counts[slot][_over_ten_state(slots.get(slot))] += 1

        cohort_diagnostics = diagnostics.get(cohort, {})
        cohorts[cohort] = {
            "manifest_messages": len(case_ids),
            "first_pass_diagnostics": {
                name: int(cohort_diagnostics.get(name, 0))
                for name in FIRST_PASS_DIAGNOSTICS
            },
            "actions": per_action,
            "over_10_room_exclusion": {"per_slot": over_ten_counts},
        }

    return {
        "schema": "centurion-pilot250-overlap-v1",
        "cohorts": cohorts,
    }


def write_private_summary(destination: str | Path, summary: dict[str, Any], root: Path) -> Path:
    output_path = _ANALYSIS._new_output_path(destination, root)
    _ANALYSIS._write_private_file(output_path, [summary])
    return output_path


def _synthetic_manifest(cohorts: Sequence[tuple[str, bool]]) -> dict[str, Any]:
    selected = []
    for index, (cohort, embargoed) in enumerate(cohorts):
        selected.append({
            "case_id": f"SYNTH_CASE_{index}",
            "source_row_id": f"SYNTH_SOURCE_{index}",
            "cohort": cohort,
            "embargoed": embargoed,
        })
    return {
        "schema": "centurion-pilot250-v1",
        "seed": "synthetic-overlap-seed",
        "selected": selected,
    }


def _synthetic_record(
    case_id: str,
    phase: str,
    slot: str,
    actions: Sequence[str],
    *,
    endpoint: str = "d" * 64,
    room_counts: Mapping[str, int | None] | None = None,
    status: str = "ok",
) -> dict[str, Any]:
    room_counts = room_counts or {}
    work_items = [
        {
            "action": action,
            "requested_room_count": room_counts.get(action),
            "episode_index": index,
        }
        for index, action in enumerate(actions)
    ]
    return {
        "case_id": case_id,
        "phase": phase,
        "arm": "cleaned",
        "round": 1,
        "arm_pair_sha256": "a" * 64,
        "slot": slot,
        "input_sha256": "b" * 64,
        "prompt_sha256": "c" * 64,
        "endpoint_sha256": endpoint,
        "normalizer_code_sha256": "e" * 64,
        "model": "gpt-6-luna" if slot.startswith("luna_") else "gpt-6.1-sol",
        "reasoning_effort": "max" if slot.startswith("luna_") else "high",
        "status": status,
        "parse_status": "valid" if status == "ok" else None,
        "normalized": {
            "origin": {},
            "work_items": work_items,
            "documents": [],
            "rollup": {},
        },
    }


class SyntheticTests(unittest.TestCase):
    def test_mixed_duplicate_actions_count_once_and_group_exclusion_is_separate(self) -> None:
        manifest = _synthetic_manifest([("random_development", False)])
        records = [
            _synthetic_record(
                "SYNTH_CASE_0",
                "development",
                slot,
                ("billing", "billing", "new_booking", "group_event"),
            )
            for slot in SLOTS
        ]

        summary = summarize_overlap_data(manifest, records)

        cohort = summary["cohorts"]["random_development"]
        self.assertEqual(cohort["manifest_messages"], 1)
        self.assertEqual(cohort["actions"]["billing"]["per_slot"]["luna_max_a"]["yes"], 1)
        self.assertEqual(cohort["actions"]["new_booking"]["per_slot"]["luna_max_a"]["yes"], 1)
        self.assertEqual(cohort["actions"]["service"]["per_slot"]["luna_max_a"]["not_labelled"], 1)
        self.assertEqual(cohort["actions"]["service"]["strict_triad"]["unanimous_not_labelled"], 1)
        self.assertEqual(cohort["actions"]["group_event"]["strict_triad"]["unanimous_yes"], 1)
        self.assertEqual(cohort["over_10_room_exclusion"]["per_slot"]["luna_max_a"]["unknown"], 1)

    def test_unknown_work_item_makes_absent_action_unknown_not_not_labelled(self) -> None:
        manifest = _synthetic_manifest([("random_development", False)])
        records = [
            _synthetic_record("SYNTH_CASE_0", "development", slot, ("billing", "unknown"))
            for slot in SLOTS
        ]

        summary = summarize_overlap_data(manifest, records)

        actions = summary["cohorts"]["random_development"]["actions"]
        self.assertEqual(actions["billing"]["strict_triad"]["unanimous_yes"], 1)
        self.assertEqual(actions["voucher"]["per_slot"]["luna_max_a"]["unknown"], 1)
        self.assertEqual(actions["voucher"]["strict_triad"]["uncertain"], 1)

    def test_known_action_presence_and_not_labelled_mix_is_disagreement(self) -> None:
        manifest = _synthetic_manifest([("random_development", False)])
        records = [
            _synthetic_record("SYNTH_CASE_0", "development", "luna_max_a", ("billing",)),
            _synthetic_record("SYNTH_CASE_0", "development", "luna_max_b", ("service",)),
            _synthetic_record("SYNTH_CASE_0", "development", "sol_high", ("billing",)),
        ]

        summary = summarize_overlap_data(manifest, records)

        billing = summary["cohorts"]["random_development"]["actions"]["billing"]
        self.assertEqual(billing["per_slot"]["luna_max_b"]["not_labelled"], 1)
        self.assertEqual(billing["strict_triad"]["disagreement"], 1)

    def test_missing_slot_is_unknown_and_strict_triad_incomplete(self) -> None:
        manifest = _synthetic_manifest([("targeted_development", False)])
        records = [
            _synthetic_record("SYNTH_CASE_0", "development", slot, ("service",))
            for slot in SLOTS[:2]
        ]

        summary = summarize_overlap_data(manifest, records)

        cohort = summary["cohorts"]["targeted_development"]
        self.assertEqual(cohort["actions"]["service"]["per_slot"]["sol_high"]["unknown"], 1)
        self.assertEqual(cohort["actions"]["service"]["strict_triad"]["incomplete"], 1)

    def test_partial_endpoint_rerun_cannot_form_an_action_triad(self) -> None:
        manifest = _synthetic_manifest([("random_development", False)])
        records = [
            _synthetic_record("SYNTH_CASE_0", "development", "luna_max_a", ("billing",), endpoint="e" * 64),
            _synthetic_record("SYNTH_CASE_0", "development", "luna_max_b", ("billing",), endpoint="e" * 64),
            _synthetic_record("SYNTH_CASE_0", "development", "sol_high", ("billing",), endpoint="f" * 64),
        ]

        summary = summarize_overlap_data(manifest, records)

        cohort = summary["cohorts"]["random_development"]
        self.assertEqual(cohort["actions"]["billing"]["per_slot"]["sol_high"]["unknown"], 1)
        self.assertEqual(cohort["actions"]["billing"]["strict_triad"]["incomplete"], 1)
        self.assertEqual(cohort["first_pass_diagnostics"]["cases_with_multiple_first_pass_endpoints"], 1)

    def test_holdout_and_embargoed_development_cohorts_stay_separate(self) -> None:
        cohorts = [
            ("random_development", False),
            ("targeted_development", False),
            ("random_holdout", False),
            ("targeted_development", True),
        ]
        manifest = _synthetic_manifest(cohorts)
        records = []
        for index, (cohort, embargoed) in enumerate(cohorts):
            phase = "holdout" if cohort == "random_holdout" or embargoed else "development"
            records.extend(
                _synthetic_record(f"SYNTH_CASE_{index}", phase, slot, ("quote",))
                for slot in SLOTS
            )

        summary = summarize_overlap_data(manifest, records, holdout_unsealed=True)

        self.assertEqual(summary["cohorts"]["random_development"]["manifest_messages"], 1)
        self.assertEqual(summary["cohorts"]["targeted_development"]["manifest_messages"], 1)
        self.assertEqual(summary["cohorts"]["random_holdout"]["manifest_messages"], 1)
        self.assertEqual(summary["cohorts"]["embargoed_development"]["manifest_messages"], 1)
        self.assertEqual(
            summary["cohorts"]["embargoed_development"]["actions"]["quote"]["strict_triad"]["unanimous_yes"],
            1,
        )
        self.assertNotIn("SYNTH_CASE_", json.dumps(summary))

    def test_mixed_first_pass_version_across_cases_is_rejected(self) -> None:
        manifest = _synthetic_manifest([
            ("random_development", False),
            ("random_development", False),
        ])
        records = [
            _synthetic_record(f"SYNTH_CASE_{case_index}", "development", slot, ("billing",))
            for case_index in range(2)
            for slot in SLOTS
        ]
        for row in records:
            if row["case_id"] == "SYNTH_CASE_1":
                row["normalizer_code_sha256"] = "f" * 64

        with self.assertRaises(_ANALYSIS.AnalysisError) as raised:
            summarize_overlap_data(manifest, records)
        self.assertEqual(raised.exception.code, "first_pass_provenance_not_uniform")

    def test_holdout_records_need_explicit_unsealing_not_manifest_entries_alone(self) -> None:
        manifest = _synthetic_manifest([("random_holdout", False)])
        holdout_records = [
            _synthetic_record("SYNTH_CASE_0", "holdout", slot, ("billing",))
            for slot in SLOTS
        ]
        with self.assertRaises(_ANALYSIS.AnalysisError) as raised:
            summarize_overlap_data(manifest, holdout_records)
        self.assertEqual(raised.exception.code, "holdout_unsealed_required")

        summary = summarize_overlap_data(manifest, holdout_records, holdout_unsealed=True)
        self.assertEqual(summary["cohorts"]["random_holdout"]["manifest_messages"], 1)

        sealed_summary = summarize_overlap_data(manifest, [])
        self.assertEqual(sealed_summary["cohorts"]["random_holdout"]["manifest_messages"], 1)

    def test_holdout_cli_flag_is_explicit(self) -> None:
        args = _parser().parse_args(["--holdout-unsealed"])
        self.assertTrue(args.holdout_unsealed)

    def test_private_summary_is_owner_only_and_rejects_existing_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / ".private"
            root.mkdir(mode=0o700)
            os.chmod(root, 0o700)
            destination = root / "overlap-summary.jsonl"
            summary = {"cohorts": {"random_development": {"manifest_messages": 1}}}

            write_private_summary(destination, summary, root)

            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), summary)
            with self.assertRaises(_ANALYSIS.AnalysisError):
                write_private_summary(destination, summary, root)


def run_self_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="Frozen owner-only manifest under .private")
    parser.add_argument("--assessments", help="Owner-only assessments.jsonl under .private")
    parser.add_argument("--output", help="Optional new owner-only summary JSONL directly under .private")
    parser.add_argument(
        "--holdout-unsealed",
        action="store_true",
        help="Explicitly permit input assessment records with phase=holdout",
    )
    parser.add_argument("--self-test", action="store_true", help="Run synthetic-only offline tests")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_tests()
    if not args.manifest or not args.assessments:
        parser.error("--manifest and --assessments are required")
    try:
        root = _ANALYSIS._private_root()
        manifest_path = _ANALYSIS._private_input_path(args.manifest, root, 32 * 1024 * 1024)
        assessments_path = _ANALYSIS._private_input_path(
            args.assessments, root, _ANALYSIS.MAX_JSON_BYTES,
        )
        manifest_document = _ANALYSIS._read_json(manifest_path)
        assessment_records = _ANALYSIS._read_jsonl(assessments_path)
        summary = summarize_overlap_data(
            manifest_document,
            assessment_records,
            holdout_unsealed=args.holdout_unsealed,
        )
        if args.output:
            output_path = _ANALYSIS._new_output_path(args.output, root)
            _ANALYSIS._write_private_file(output_path, [summary])
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except _ANALYSIS.AnalysisError as exc:
        print("error=" + exc.code, file=sys.stderr)
        return 2
    except Exception:
        print("error=internal", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
