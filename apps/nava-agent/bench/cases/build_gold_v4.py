#!/usr/bin/env python3
"""Build gold-v4 overlays from gold-v3 + measurement patches. Never edits case.json.

Default output: $NAVA_BENCH_DATA_ROOT/gold-audit/{holdout-fresh,v1}/gold-v4.json
Loaded automatically by bench runner/rescore for those sets.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

DATA = Path(os.environ.get("NAVA_BENCH_DATA_ROOT") or "/home/orca/.local/share/zero/bench/replay-bench-20261119")

FILING_OPTIONAL = {
  "track", "billing_reference", "rate_plan", "guarantee_type", "market_segment",
  "adults", "child_count", "room_type", "organization_name", "agency_name",
  "first_name", "last_name", "guest_name", "arrival_date", "departure_date",
}
TRIAGE_DROP_PREFIXES = ("/bookings/",)
TRIAGE_DROP_LEAVES = {
  "board", "quantity", "room_type", "rate_plan", "adults", "child_count",
  "arrival_date", "departure_date", "first_name", "last_name", "organization_name",
  "agency_name", "track", "guarantee_type", "billing_reference", "property_code",
  "attachment_id", "confirmation_number", "reservation_id",
}


def leaf(path: str) -> str:
  return path.rstrip("/").split("/")[-1]


def build(name: str) -> dict:
  cases = DATA / "cases" / name
  audit = DATA / "gold-audit" / name
  v3_path = audit / "gold-v3.json"
  if not v3_path.exists():
    raise SystemExit(f"missing {v3_path}")
  v3 = json.loads(v3_path.read_text())
  out: dict = {}
  patch_reasons: Counter[str] = Counter()
  for cid, v3row in v3.items():
    card = json.loads((cases / cid / "case.json").read_text())
    wf = v3row.get("workflow") or card.get("workflow")
    patches = []
    for g in card.get("gold") or []:
      path = g.get("path") or ""
      if g.get("expectation") != "expected":
        continue
      val = g.get("value")
      reasons: list[str] = []
      if val is None:
        reasons.append("gold_v4_null_expected")
      if wf in ("triage", "skip"):
        if path.startswith(TRIAGE_DROP_PREFIXES) or leaf(path) in TRIAGE_DROP_LEAVES or "/groups/" in path:
          reasons.append("gold_v4_triage_not_knowable")
      if wf == "filing" and leaf(path) in FILING_OPTIONAL:
        reasons.append("gold_v4_filing_optional")
      if reasons:
        patches.append({
          "path": path,
          "expectation": "not_expected",
          "basis": "+".join(reasons),
          "was_value": val,
        })
        for r in reasons:
          patch_reasons[r] += 1
    out[cid] = {
      "workflow": wf,
      "old_workflow": v3row.get("old_workflow") or card.get("workflow"),
      "changed": bool(v3row.get("changed")),
      "skip": bool(v3row.get("skip")),
      "evidence_quote": v3row.get("evidence_quote"),
      "gold_patches": patches,
      "n_patches": len(patches),
    }
  summary = {
    "n": len(out),
    "cases_with_patches": sum(1 for r in out.values() if r["n_patches"]),
    "patch_total": sum(r["n_patches"] for r in out.values()),
    "patch_reasons": dict(patch_reasons),
    "from": "gold-v3",
    "set": name,
  }
  audit.mkdir(parents=True, exist_ok=True)
  (audit / "gold-v4.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
  (audit / "summary-v4.json").write_text(json.dumps(summary, indent=2))
  print(json.dumps(summary, indent=2))
  return summary


def main() -> None:
  sets = sys.argv[1:] or ["holdout-fresh", "v1"]
  for name in sets:
    build(name)


if __name__ == "__main__":
  main()
