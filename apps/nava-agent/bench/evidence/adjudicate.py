"""U3: evaluation-only action graph + v7 candidate expectations.

Does not invent staff adjudication, prices, or native codes.
Legacy v6 remains immutable; v7 is schema-tagged isolated output.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .field_policy import field_policy_document
from .privacy import value_ref
from .schema import SCHEMA_VERSION
from .sources import SourcePaths, load_json


def _map_v6_field(gf: dict[str, Any], *, unit_id: str) -> dict[str, Any]:
    """Extract necessary v6 field mapping — candidate status only."""
    expectation = gf.get("expectation")
    status = "candidate"
    if expectation == "no_gold":
        status = "unobservable"
    elif expectation == "not_expected":
        status = "candidate"
    elif expectation == "diagnostic":
        status = "unverified"
    basis = str(gf.get("basis") or gf.get("source") or "")
    # Refuse to promote heuristic/model-only as confirmed
    if "heuristic" in basis.lower() or basis.startswith("luna"):
        status = "contested" if status == "candidate" else status
    return {
        "path": gf.get("path"),
        "legacy_expectation": expectation,
        "mode": _expectation_mode(expectation),
        "status": status,
        "basis": basis,
        "tier": gf.get("tier") or gf.get("priority"),
        "knowable": gf.get("knowable"),
        "valueRef": value_ref("v6_gold", unit_id, gf.get("path"), basis),
        "origin": "v6_legacy_candidate",
        "note": "not independently adjudicated by this prep",
    }


def _expectation_mode(expectation: object) -> str:
    if expectation == "expected":
        return "require"
    if expectation == "not_expected":
        return "forbid"
    if expectation == "no_gold":
        return "unobserved"
    if expectation == "diagnostic":
        return "defer"
    return "unobserved"


def build_action_graph(card: dict[str, Any], gold: dict[str, Any]) -> dict[str, Any]:
    """Primary ask + secondary placeholders. Time alone does not assign amendments."""
    workflow = gold.get("workflow") or card.get("workflow")
    disposition = gold.get("expected_disposition")
    action_count = gold.get("expected_action_count")
    targets_verified = False
    # v6: unverified targets unscored — preserve
    gold_paths = [g.get("path") for g in (gold.get("gold") or []) if isinstance(g, dict)]
    has_reservation = any(isinstance(p, str) and p.endswith("/reservation_id") for p in gold_paths)
    staff = gold.get("staff_outcome_only")
    return {
        "primary_workflow_candidate": workflow,
        "eligible_dispositions_candidate": [disposition] if disposition else [],
        "expected_action_count": action_count,
        "secondary_actions": [],
        "native_group": False,
        "explicit_no_action": workflow == "triage" and disposition == "skip",
        "staff_review_alternative": disposition == "staff_review",
        "unresolved": disposition is None,
        "target_binding": {
            "status": "unverified" if not has_reservation else "candidate",
            "reservation_id_paths_present": has_reservation,
            "note": "unverified target → score extraction if evidenced; target accuracy not observed",
        },
        "filing_after_create_rule": {
            "note": "pre-existing stay before voucher → Filing; initial order → Create; after-create voucher → separate Filing",
            "applied": False,
            "reason": "requires sourced stay chronology; not inferred here",
        },
        "staff_outcome_keys": sorted(staff.keys()) if isinstance(staff, dict) else [],
    }


def emit_v7_unit(unit_id: str, card: dict[str, Any], gold: dict[str, Any]) -> dict[str, Any]:
    fields = [_map_v6_field(gf, unit_id=unit_id) for gf in (gold.get("gold") or []) if isinstance(gf, dict)]
    return {
        "schema": SCHEMA_VERSION,
        "unit_id": unit_id,
        "legacy_v6_immutable": True,
        "adjudication_status": "candidate",
        "action_graph": build_action_graph(card, gold),
        "expectations": fields,
        "request_vs_outcome_separated": True,
        "later_revisions_excluded_from_request": True,
        "blind_protocol": {
            "independent_intent_reads_required": 2,
            "attribution_pass_separate": True,
            "no_model_predictions_in_view": True,
            "no_old_scores_in_view": True,
            "status": "not_run_in_this_prep",
            "reason": "coordinator controls Luna/lead dispatch; local prep freezes roster only",
        },
        "regression_hooks": [
            "ota_false_positive",
            "dropped_create",
            "earlier_voucher_letter",
            "recycled_quoted_request",
            "october_8_vs_12_amendment",
            "october_13_vs_30_departure",
            "human_wrapped_order",
            "review_only_ambiguous_vouchers",
            "no_confirmation_quote",
        ],
        "old_to_new_reason": [],
        "note": "old→new reasons emitted only when a sourced relabel occurs; none invented here",
    }


def build_v7_candidates(paths: SourcePaths, roster_ids: set[str] | None = None) -> dict[str, Any]:
    """Schema-tagged v7 candidates for frozen roster (or full frame if roster None)."""
    units: list[dict[str, Any]] = []
    missing_card = 0
    missing_gold = 0
    seen: set[str] = set()
    for split, dirname in (("train", "cases-train"), ("val", "cases-val"), ("test", "cases-test")):
        split_dir = paths.overnight_root / dirname
        gold_path = split_dir / "gold.json"
        gold_map: dict[str, Any] = {}
        if gold_path.exists():
            try:
                blob = load_json(gold_path)
                if isinstance(blob, dict):
                    gold_map = blob
            except (OSError, json.JSONDecodeError):
                pass
        if not split_dir.exists():
            continue
        for case_dir in sorted(split_dir.iterdir()):
            if not case_dir.is_dir() or not case_dir.name.startswith("v6-"):
                continue
            cid = case_dir.name
            if roster_ids is not None and cid not in roster_ids:
                continue
            seen.add(cid)
            case_path = case_dir / "case.json"
            if not case_path.exists():
                missing_card += 1
                units.append(
                    {
                        "schema": SCHEMA_VERSION,
                        "unit_id": cid,
                        "adjudication_status": "missing",
                        "reason": "missing_case_json",
                    }
                )
                continue
            try:
                card = load_json(case_path)
            except (OSError, json.JSONDecodeError):
                missing_card += 1
                units.append({"schema": SCHEMA_VERSION, "unit_id": cid, "adjudication_status": "missing", "reason": "unreadable_case"})
                continue
            gold = gold_map.get(cid)
            if not isinstance(gold, dict):
                missing_gold += 1
                units.append(
                    {
                        "schema": SCHEMA_VERSION,
                        "unit_id": cid,
                        "adjudication_status": "missing",
                        "reason": "missing_gold",
                        "workflow_from_card": card.get("workflow"),
                    }
                )
                continue
            unit = emit_v7_unit(cid, card, gold)
            unit["split"] = split
            units.append(unit)

    # Roster IDs outside v6 selected cards (e.g. classifier_skip) stay in coverage bounds.
    if roster_ids is not None:
        for cid in sorted(roster_ids - seen):
            units.append(
                {
                    "schema": SCHEMA_VERSION,
                    "unit_id": cid,
                    "adjudication_status": "missing",
                    "reason": "not_in_v6_selected_frame",
                    "note": "sampling stratum row without recoverable selected case card",
                }
            )
            missing_card += 1

    units.sort(key=lambda u: u["unit_id"])
    return {
        "schema": SCHEMA_VERSION,
        "field_policy": field_policy_document(),
        "units_n": len(units),
        "missing_card": missing_card,
        "missing_gold": missing_gold,
        "status_counts": _status_counts(units),
        "units": units,
        "limitations": [
            "No confirmed adjudications produced locally",
            "No prices or native codes invented",
            "Blind Luna/lead passes not executed in this lane",
            "v6 gold retained as candidates only",
            "Roster IDs absent from v6 cards marked missing (coverage bound)",
        ],
    }


def _status_counts(units: list[dict[str, Any]]) -> dict[str, int]:
    from collections import Counter

    return dict(Counter(u.get("adjudication_status") for u in units))


def write_v7(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Store units as jsonl for streaming; header sidecar
    header = {k: v for k, v in doc.items() if k != "units"}
    (path.parent / "v7-header.json").write_text(json.dumps(header, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    with path.open("w", encoding="utf-8") as f:
        for unit in doc.get("units") or []:
            f.write(json.dumps(unit, sort_keys=True, separators=(",", ":")) + "\n")
