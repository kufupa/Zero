#!/usr/bin/env python3
"""Rebuild 200 v1 case cards in parallel workers (owner: no one-at-a-time)."""
from __future__ import annotations

import json
import os
import shutil
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from rebuild_samples import (
    CONF_RE,
    DATA,
    build_card,
    load_jsonl,
    load_world,
    render_md,
    strip_images,
)
from route_from_email import route_from_email

OUT = DATA / "cases" / "v1"
WORKERS = int(os.environ.get("BENCH_CASE_WORKERS", "24"))
NEED = {"create": 40, "amend": 24, "cancel": 35, "filing": 26, "quote": 40, "triage": 35}

_WORLD = None


def _init_worker() -> None:
    global _WORLD
    _WORLD = load_world()


def _build_one(row: dict) -> dict | None:
    assert _WORLD is not None
    anchors, stay360, profiles, code_maps = _WORLD
    try:
        card = build_card(row, anchors, stay360, profiles, code_maps)
    except Exception as exc:  # noqa: BLE001
        return {"_error": f"{row.get('case_id')}:{exc}"}
    if not card["leak_guard"]["ok"]:
        return {"_leak": card["case_id"], "leaks": card["leak_guard"]["leaks"][:3]}
    return card


def _halloween_row(meta: dict, wf: str, hall_inputs: dict, *, force_wf: bool = False) -> dict | None:
    did = meta["decision_id"]
    inp = hall_inputs.get(did)
    if not inp:
        return None
    sm = inp["selected_message"]
    as_of = sm.get("timestamp") or inp["input_cutoff"]
    body, _ = strip_images(sm.get("body") or "")
    # Align gold workflow with triage skill table (other_request often hides a create/quote).
    routed = route_from_email(sm.get("subject"), body)
    if not force_wf:
        wf = routed
    conf = None
    match = CONF_RE.search((sm.get("subject") or "") + " " + body)
    if match:
        conf = match.group(1) + "-1"
    earlier = []
    for event in inp.get("earlier_relevant_source_events") or []:
        msg = event.get("message")
        if not msg:
            continue
        earlier.append({**msg, "body": msg.get("body"), "timestamp": msg.get("timestamp")})
    return {
        "case_id": f"hall-{wf}-{did.replace(':', '')[:16]}",
        "workflow": wf,
        "routed_from": routed,
        "real_confirmation": conf,
        "source": {
            "thread_id": sm.get("thread_id"),
            "selected_message_id": sm.get("message_id"),
            "input_cutoff": as_of,
            "subject": sm.get("subject"),
            "body_text": body,
            "messages_as_of_cutoff": [
                *earlier,
                {
                    **sm,
                    "body": sm.get("body"),
                    "timestamp": as_of,
                    "direction": sm.get("direction"),
                    "subject": sm.get("subject"),
                },
            ],
        },
        "first_pdf": {},
        "later_hms": {},
        "resolved_base_fields": {},
        "amendment": {},
        "decision_time_base_pdf": None,
        "evidence_limits": ["halloween_weak_gold"],
    }


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    creates = []
    seen: set[str] = set()
    for row in load_jsonl(DATA / "gold/create-pilot-v3.jsonl") + load_jsonl(DATA / "gold/create-heldout-rule-v2.jsonl"):
        if row["case_id"] in seen:
            continue
        seen.add(row["case_id"])
        creates.append(row)

    phase4 = {
        "create": creates,
        "amend": load_jsonl(DATA / "gold/amend-reviewed-dedup-v6.jsonl"),
        "cancel": load_jsonl(DATA / "gold/cancel.jsonl"),
        "filing": load_jsonl(DATA / "gold/filing.jsonl"),
    }

    hall_inputs = {}
    with open(DATA / "inbound/halloween/inputs.jsonl") as f:
        for line in f:
            obj = json.loads(line)
            hall_inputs[obj["decision_id"]] = obj

    # Over-sample candidates per workflow, build in parallel, then take quotas.
    candidates: list[dict] = []
    for wf, need in [("create", 40), ("amend", 24), ("cancel", 35), ("filing", 26)]:
        for row in phase4[wf][: max(need * 4, need + 20)]:
            candidates.append(row)
    for wf, fname, need in [
        ("quote", "quote_request.jsonl", 40),
        ("create", "create_request.jsonl", 40),
        ("cancel", "cancel_request.jsonl", 35),
        ("filing", "voucher_submission.jsonl", 26),
        ("filing", "payment_proof_submission.jsonl", 26),
    ]:
        path = DATA / "inbound/halloween/workflows" / fname
        if not path.exists():
            continue
        for meta in load_jsonl(path)[: need * 3]:
            row = _halloween_row(meta, wf, hall_inputs, force_wf=True)
            if row:
                candidates.append(row)
    # other_request: route by triage table so create/quote asks are not labelled triage.
    for meta in load_jsonl(DATA / "inbound/halloween/workflows/other_request.jsonl")[:200]:
        row = _halloween_row(meta, "triage", hall_inputs, force_wf=False)
        if row:
            candidates.append(row)

    buckets: dict[str, list[dict]] = defaultdict(list)
    errors = 0
    leaks = 0
    with ProcessPoolExecutor(max_workers=WORKERS, initializer=_init_worker) as pool:
        futures = [pool.submit(_build_one, row) for row in candidates]
        for fut in as_completed(futures):
            result = fut.result()
            if not result:
                continue
            if result.get("_error"):
                errors += 1
                continue
            if result.get("_leak"):
                leaks += 1
                continue
            buckets[result["workflow"]].append(result)

    selected: list[dict] = []
    for wf, n in NEED.items():
        selected.extend(buckets.get(wf, [])[:n])

    # Pad to 200 from leftover create/amend/etc if a workflow short.
    if len(selected) < 200:
        used = {c["case_id"] for c in selected}
        for wf in ("create", "amend", "cancel", "filing", "quote", "triage"):
            for card in buckets.get(wf, []):
                if len(selected) >= 200:
                    break
                if card["case_id"] in used:
                    continue
                selected.append(card)
                used.add(card["case_id"])

    selected = selected[:200]
    for card in selected:
        path = OUT / card["case_id"]
        path.mkdir(parents=True, exist_ok=True)
        (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
        (path / "case.md").write_text(render_md(card))

    counts: dict[str, int] = defaultdict(int)
    gold_lens = []
    omit_n = 0
    hms_gold = 0
    phantom = 0
    for card in selected:
        counts[card["workflow"]] += 1
        gold_lens.append(len(card.get("gold") or []))
        omit_n += len(card.get("omitted") or [])
        hms_gold += sum(1 for g in card.get("gold") or [] if str(g.get("path", "")).startswith("/hms/"))
        shown = card.get("hms_shown") or {}
        if card["workflow"] in ("quote", "triage") and shown.get("exists"):
            phantom += 1
        if not card["leak_guard"]["ok"]:
            leaks += 1

    manifest = {
        "n": len(selected),
        "by_workflow": dict(counts),
        "leaks": leaks,
        "build_errors": errors,
        "workers": WORKERS,
        "gold_field_min": min(gold_lens) if gold_lens else 0,
        "gold_field_max": max(gold_lens) if gold_lens else 0,
        "omitted_total": omit_n,
        "hms_gold_paths": hms_gold,
        "phantom_quote_triage_shown": phantom,
        "bucket_sizes": {k: len(v) for k, v in buckets.items()},
        "out": str(OUT),
        "fixes": "followup_5_structural_bugs",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
