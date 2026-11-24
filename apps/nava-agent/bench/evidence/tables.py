"""Independent request / attributable_outcome / later_unknown tables + FactRefs."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

from .clocks import resolve_clocks
from .dedup import stable_hash
from .privacy import scrub_public_message_meta, value_ref
from .schema import (
    DEFAULT_MAILBOX,
    DEFAULT_PROPERTY,
    SCHEMA_VERSION,
    FactRef,
    Scope,
)
from .sources import SourcePaths, iter_jsonl, load_json


def _scope(property_code: str | None = None, mailbox: str | None = None) -> Scope:
    return {
        "property": property_code or DEFAULT_PROPERTY,
        "mailbox": mailbox or DEFAULT_MAILBOX,
    }


def _fact(
    *,
    subject: str,
    field: str,
    source_id: str,
    source_kind: str,
    value_ref: str,
    clocks: dict[str, Any],
    property_code: str | None = None,
) -> FactRef:
    fid = "fact:" + stable_hash(subject, field, source_id, value_ref)[:24]
    ref: FactRef = {
        "id": fid,
        "scope": _scope(property_code),
        "subjectKey": subject,
        "field": field,
        "sourceId": source_id,
        "sourceKind": source_kind,
        "valueRef": value_ref,
        "eventAt": clocks.get("eventAt"),
        "availableAt": clocks.get("availableAt"),
        "capturedAt": clocks.get("capturedAt") or clocks.get("eventAt") or "unknown",
        "precision": clocks.get("precision") or "unknown",
    }
    return ref


def build_tables(paths: SourcePaths) -> dict[str, Any]:
    """Materialize three independent tables. Preserve missing/contested/unverified."""
    requests: list[dict[str, Any]] = []
    outcomes: list[dict[str, Any]] = []
    later: list[dict[str, Any]] = []
    facts: list[FactRef] = []
    public_frame: list[dict[str, Any]] = []
    private_index: list[dict[str, Any]] = []
    quarantine = Counter()

    # --- v6 cases: request from case selected_email meta; outcome from gold; later unknown ---
    gold_by_id: dict[str, dict[str, Any]] = {}
    for split, dirname in (("train", "cases-train"), ("val", "cases-val"), ("test", "cases-test")):
        gold_path = paths.overnight_root / dirname / "gold.json"
        if gold_path.exists():
            try:
                blob = load_json(gold_path)
                if isinstance(blob, dict):
                    for k, v in blob.items():
                        if isinstance(v, dict):
                            gold_by_id[k] = v
            except (OSError, json.JSONDecodeError):
                quarantine["gold_unreadable"] += 1

        split_dir = paths.overnight_root / dirname
        if not split_dir.exists():
            continue
        for case_dir in sorted(split_dir.iterdir()):
            if not case_dir.is_dir() or not case_dir.name.startswith("v6-"):
                continue
            case_path = case_dir / "case.json"
            if not case_path.exists():
                quarantine["missing_case_json"] += 1
                continue
            try:
                card = load_json(case_path)
            except (OSError, json.JSONDecodeError):
                quarantine["case_unreadable"] += 1
                continue
            cid = str(card.get("case_id") or case_dir.name)
            selected = card.get("selected_email") if isinstance(card.get("selected_email"), dict) else {}
            source = card.get("source") if isinstance(card.get("source"), dict) else {}
            clocks = resolve_clocks(
                event_at=selected.get("timestamp") or selected.get("received_at") or card.get("as_of"),
                available_at=selected.get("received_at") or source.get("input_cutoff") or card.get("as_of"),
                captured_at=None,  # case export capture time unknown — do not invent
                fallback_event=card.get("as_of"),
            )
            if clocks["capturedAt"] is None:
                clocks["capturedAt"] = None  # explicit unknown
                # FactRef requires capturedAt string — mark unknown
                clocks_for_fact = {**clocks, "capturedAt": "unknown"}
            else:
                clocks_for_fact = clocks

            prop = card.get("property_code") or source.get("property_code")
            pub = scrub_public_message_meta(selected, case_id=cid)
            pub.update(
                {
                    "schema": SCHEMA_VERSION,
                    "split": split,
                    "workflow_v6": card.get("workflow"),
                    "as_of": card.get("as_of"),
                    "input_cutoff": source.get("input_cutoff"),
                    "property_code": prop,
                    "clocks": clocks,
                    "frame": "v6_selected",
                }
            )
            public_frame.append(pub)

            body_ref = pub["body_ref"]
            facts.append(
                _fact(
                    subject=cid,
                    field="selected_message",
                    source_id=str(selected.get("message_id") or cid),
                    source_kind="v6_case",
                    value_ref=body_ref,
                    clocks=clocks_for_fact,
                    property_code=prop if isinstance(prop, str) else None,
                )
            )

            # REQUEST table — decision-time ask only (workflow label is routing candidate).
            gold = gold_by_id.get(cid) or {}
            req_fields = []
            for gf in gold.get("gold") or []:
                if not isinstance(gf, dict):
                    continue
                # v6 gold mixes request and outcome; keep as candidate request paths only when basis is email
                basis = str(gf.get("basis") or gf.get("source") or "")
                status = "candidate"
                if gf.get("expectation") == "no_gold":
                    status = "unobservable"
                req_fields.append(
                    {
                        "path": gf.get("path"),
                        "expectation": gf.get("expectation"),
                        "basis": basis,
                        "status": status,
                        "knowable": gf.get("knowable"),
                        "valueRef": value_ref("gold_field", cid, gf.get("path"), basis),
                        # never copy raw values into public request table
                    }
                )

            requests.append(
                {
                    "unit_id": cid,
                    "table": "request",
                    "schema": SCHEMA_VERSION,
                    "workflow_candidate": card.get("workflow") or gold.get("workflow"),
                    "expected_disposition_candidate": gold.get("expected_disposition"),
                    "expected_action_count": gold.get("expected_action_count"),
                    "skip": bool(gold.get("skip")),
                    "fields": req_fields,
                    "status": "candidate",
                    "clocks": clocks,
                    "evidence_refs": [facts[-1]["id"]],
                }
            )

            # ATTRIBUTABLE OUTCOME — staff_outcome_only / HMS readback candidates; not invented.
            staff = gold.get("staff_outcome_only")
            outcome_status = "missing"
            outcome_payload: dict[str, Any] = {}
            if staff is None:
                outcome_status = "missing"
            elif staff == {} or staff == []:
                outcome_status = "unverified"
            else:
                outcome_status = "candidate"
                # store only key shapes / counts, not guest PII values
                if isinstance(staff, dict):
                    outcome_payload = {
                        "keys": sorted(staff.keys()),
                        "valueRef": value_ref("staff_outcome", cid, json.dumps(sorted(staff.keys()))),
                    }
                else:
                    outcome_payload = {"type": type(staff).__name__, "valueRef": value_ref("staff_outcome", cid, type(staff).__name__)}

            outcomes.append(
                {
                    "unit_id": cid,
                    "table": "attributable_outcome",
                    "schema": SCHEMA_VERSION,
                    "status": outcome_status,
                    "staff_outcome_present": staff is not None,
                    "payload_meta": outcome_payload,
                    "source_label": gold.get("source_label"),
                    "real_confirmation_present": bool(card.get("real_confirmation") or card.get("confirmation")),
                    "note": "first attributable saved state only; later revisions stay in later_unknown",
                }
            )

            # LATER / UNKNOWN — cross-thread empty, later revisions not in request
            cross = card.get("cross_thread_context")
            later_status = "missing"
            if cross is None:
                later_status = "missing"
            elif cross == [] or cross == {}:
                later_status = "unverified"
            else:
                later_status = "candidate"
            later.append(
                {
                    "unit_id": cid,
                    "table": "later_unknown",
                    "schema": SCHEMA_VERSION,
                    "status": later_status,
                    "cross_thread_empty": cross in (None, [], {}),
                    "hms_shown_present": card.get("hms_shown") not in (None, [], {}),
                    "pdf_versions_n": len(card.get("pdf_versions") or []) if isinstance(card.get("pdf_versions"), list) else 0,
                    "note": "later evidence must not supply missing prompt facts",
                }
            )

            private_index.append(
                {
                    "unit_id": cid,
                    "split": split,
                    "case_path": str(case_path),
                    "gold_present": cid in gold_by_id,
                    "body_ref": body_ref,
                }
            )

    # --- Halloween: preserve input/outcome separation ---
    halloween_inputs = paths.halloween_dataset / "inputs.jsonl"
    halloween_outcomes = paths.halloween_dataset / "outcomes.jsonl"
    halloween_by_id: dict[str, dict[str, Any]] = {}
    if halloween_outcomes.exists():
        for row in iter_jsonl(halloween_outcomes):
            if row.get("__parse_error__"):
                quarantine["halloween_outcome_parse"] += 1
                continue
            did = row.get("decision_id")
            if did:
                halloween_by_id[str(did)] = row

    if halloween_inputs.exists():
        for row in iter_jsonl(halloween_inputs):
            if row.get("__parse_error__"):
                quarantine["halloween_input_parse"] += 1
                continue
            did = str(row.get("decision_id") or "")
            if not did:
                quarantine["halloween_missing_decision_id"] += 1
                continue
            sm = row.get("selected_message") if isinstance(row.get("selected_message"), dict) else {}
            clocks = resolve_clocks(
                event_at=sm.get("timestamp"),
                available_at=sm.get("timestamp"),
                captured_at=None,
            )
            clocks_for_fact = {**clocks, "capturedAt": clocks.get("capturedAt") or "unknown"}
            pub = {
                "schema": SCHEMA_VERSION,
                "case_id": did,
                "frame": "halloween",
                "source_row_id_present": bool(sm.get("source_row_id")),
                "message_id_present": bool(sm.get("message_id")),
                "thread_id_present": bool(sm.get("thread_id")),
                "direction": sm.get("direction"),
                "timestamp": sm.get("timestamp"),
                "clocks": clocks,
                "earlier_relevant_n": len(row.get("earlier_relevant_source_events") or [])
                if isinstance(row.get("earlier_relevant_source_events"), list)
                else 0,
                "body_ref": value_ref("halloween_body", did, sm.get("message_id") or ""),
            }
            public_frame.append(pub)
            facts.append(
                _fact(
                    subject=did,
                    field="selected_message",
                    source_id=str(sm.get("message_id") or did),
                    source_kind="halloween_input",
                    value_ref=pub["body_ref"],
                    clocks=clocks_for_fact,
                )
            )

            outcome = halloween_by_id.get(did)
            if outcome is None:
                requests.append(
                    {
                        "unit_id": did,
                        "table": "request",
                        "schema": SCHEMA_VERSION,
                        "frame": "halloween",
                        "status": "missing",
                        "fields": [],
                        "note": "outcome row missing for decision_id",
                    }
                )
                outcomes.append({"unit_id": did, "table": "attributable_outcome", "status": "missing", "frame": "halloween"})
                later.append({"unit_id": did, "table": "later_unknown", "status": "missing", "frame": "halloween"})
                continue

            # Request-side: unscored + model_assisted are request candidates, not gold confirmation
            req_fields = []
            for item in outcome.get("unscored_request_fields") or []:
                if isinstance(item, dict):
                    req_fields.append(
                        {
                            "path": item.get("field") or item.get("path"),
                            "status": "unverified",
                            "origin": "unscored_request_fields",
                            "valueRef": value_ref("halloween_req", did, item.get("field"), item.get("source_row_id")),
                        }
                    )
            for item in outcome.get("model_assisted_request_fields") or []:
                if isinstance(item, dict):
                    req_fields.append(
                        {
                            "path": item.get("field") or item.get("path"),
                            "status": "candidate",
                            "origin": "model_assisted_request_fields",
                            "valueRef": value_ref("halloween_req", did, item.get("field"), item.get("source_row_id")),
                            "note": "model-assisted candidate only; not staff adjudication",
                        }
                    )
            tags = outcome.get("workflow_tags") or []
            requests.append(
                {
                    "unit_id": did,
                    "table": "request",
                    "schema": SCHEMA_VERSION,
                    "frame": "halloween",
                    "workflow_tags": tags if isinstance(tags, list) else [],
                    "fields": req_fields,
                    "status": "candidate",
                    "clocks": clocks,
                }
            )

            direct = outcome.get("direct_observed_events") or []
            support = outcome.get("supporting_staff_events") or []
            outcomes.append(
                {
                    "unit_id": did,
                    "table": "attributable_outcome",
                    "schema": SCHEMA_VERSION,
                    "frame": "halloween",
                    "status": "candidate" if direct or support else "unverified",
                    "direct_observed_n": len(direct) if isinstance(direct, list) else 0,
                    "supporting_staff_n": len(support) if isinstance(support, list) else 0,
                    "hms_current_n": len(outcome.get("hms_current_observations") or [])
                    if isinstance(outcome.get("hms_current_observations"), list)
                    else 0,
                    "note": "HMS current observations are not decision-time dated facts",
                }
            )

            later_ev = outcome.get("later_evidence") or []
            later_in = outcome.get("later_inbound_context") or []
            later.append(
                {
                    "unit_id": did,
                    "table": "later_unknown",
                    "schema": SCHEMA_VERSION,
                    "frame": "halloween",
                    "status": "candidate" if later_ev or later_in else "unverified",
                    "later_evidence_n": len(later_ev) if isinstance(later_ev, list) else 0,
                    "later_inbound_n": len(later_in) if isinstance(later_in, list) else 0,
                }
            )
            private_index.append({"unit_id": did, "frame": "halloween", "body_ref": pub["body_ref"]})

    # Sort for reproducibility
    public_frame.sort(key=lambda r: (r.get("frame") or "", r.get("case_id") or ""))
    requests.sort(key=lambda r: (r.get("frame") or "v6", r["unit_id"]))
    outcomes.sort(key=lambda r: (r.get("frame") or "v6", r["unit_id"]))
    later.sort(key=lambda r: (r.get("frame") or "v6", r["unit_id"]))
    facts.sort(key=lambda r: r["id"])

    return {
        "public_frame": public_frame,
        "requests": requests,
        "outcomes": outcomes,
        "later": later,
        "facts": facts,
        "private_index": private_index,
        "quarantine": dict(quarantine),
        "counts": {
            "public_frame": len(public_frame),
            "requests": len(requests),
            "outcomes": len(outcomes),
            "later": len(later),
            "facts": len(facts),
            "status_request": dict(Counter(r.get("status") for r in requests)),
            "status_outcome": dict(Counter(r.get("status") for r in outcomes)),
            "status_later": dict(Counter(r.get("status") for r in later)),
        },
    }
