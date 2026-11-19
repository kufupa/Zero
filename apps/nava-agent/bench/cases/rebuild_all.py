#!/usr/bin/env python3
"""Rebuild 200 v1 case cards with the 8 coordinator fixes."""
from __future__ import annotations

import json
import shutil
from collections import defaultdict
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

OUT = DATA / "cases" / "v1"


def main() -> None:
    anchors, stay360, profiles, code_maps = load_world()
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

    selected: list[dict] = []
    for wf, need in [("create", 40), ("amend", 24), ("cancel", 35), ("filing", 26)]:
        for row in phase4[wf]:
            if sum(1 for c in selected if c["workflow"] == wf) >= need:
                break
            try:
                card = build_card(row, anchors, stay360, profiles, code_maps)
            except Exception as exc:  # noqa: BLE001
                print("FAIL", row.get("case_id"), exc)
                continue
            if not card["leak_guard"]["ok"]:
                print("LEAK", card["case_id"], card["leak_guard"]["leaks"][:2])
                continue
            selected.append(card)

    hall_inputs = {}
    with open(DATA / "inbound/halloween/inputs.jsonl") as f:
        for line in f:
            obj = json.loads(line)
            hall_inputs[obj["decision_id"]] = obj

    def build_halloween(meta: dict, wf: str):
        did = meta["decision_id"]
        inp = hall_inputs.get(did)
        if not inp:
            return None
        sm = inp["selected_message"]
        as_of = sm.get("timestamp") or inp["input_cutoff"]
        body, _ = strip_images(sm.get("body") or "")
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
        gold_row = {
            "case_id": f"hall-{wf}-{did.replace(':', '')[:16]}",
            "workflow": wf,
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
        try:
            return build_card(gold_row, anchors, stay360, profiles, code_maps)
        except Exception as exc:  # noqa: BLE001
            print("hall fail", did, exc)
            return None

    for wf, fname, need in [
        ("quote", "quote_request.jsonl", 40),
        ("triage", "other_request.jsonl", 35),
    ]:
        n = 0
        for meta in load_jsonl(DATA / "inbound/halloween/workflows" / fname):
            if n >= need:
                break
            card = build_halloween(meta, wf)
            if not card or not card["leak_guard"]["ok"]:
                continue
            selected.append(card)
            n += 1

    if len(selected) < 200:
        for meta in load_jsonl(DATA / "inbound/halloween/workflows/create_request.jsonl"):
            if len(selected) >= 200:
                break
            card = build_halloween(meta, "create")
            if card and card["leak_guard"]["ok"]:
                selected.append(card)

    selected = selected[:200]
    counts: dict[str, int] = defaultdict(int)
    leaks = 0
    for card in selected:
        counts[card["workflow"]] += 1
        path = OUT / card["case_id"]
        path.mkdir(parents=True, exist_ok=True)
        (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
        (path / "case.md").write_text(render_md(card))
        if not card["leak_guard"]["ok"]:
            leaks += 1

    manifest = {"n": len(selected), "by_workflow": dict(counts), "leaks": leaks, "out": str(OUT), "fixes": 8}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    for card in selected:
        if card["workflow"] == "amend" and card.get("real_confirmation") == "22098684-1":
            print(
                "spot amend shown dep",
                (card["hms_shown"].get("stay") or {}).get("departure_date"),
                "leak",
                card["leak_guard"],
            )
            break


if __name__ == "__main__":
    main()
