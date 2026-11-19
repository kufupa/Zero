#!/usr/bin/env python3
"""Build gold-v4 overlays from gold-v3 + measurement patches. Never edits case.json.

Default output: $NAVA_BENCH_DATA_ROOT/gold-audit/{holdout-fresh,v1,dev-fresh}/gold-v4.json
Loaded automatically by bench runner/rescore for those sets.

Also marks booking gold no_gold when:
- holdout-fresh + dev-fresh: synthetic Labtest/Proof/NAVAAI booking or unreadable
  HMS conf (NOT_FOUND / HINT_MISMATCH / DETAILS_NOT_LOADED / AMBIGUOUS)
- holdout-fresh + dev-fresh: CREATE whose gold booking has createdby=HRCEN
  (channel/GDS interface — not staff email create). Routing workflow kept.
- all sets: cms_send (CMS Send Mail tick) — later HMS reads are false after CMS
  clears the tick; PRODUCT.md default is ticked, so later-read gold is not evidence.
  cms_message_id / cms_recipient stay only when basis is staff/hotel-sourced.

Cases stay in the set.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path

DATA = Path(os.environ.get("NAVA_BENCH_DATA_ROOT") or "/home/orca/.local/share/zero/bench/replay-bench-20261119")
READS_ROOT = Path(os.environ.get("NAVA_HMS_FRESH_READS_ROOT") or "/home/orca/.local/share/zero/research/hms-fresh-reads-20261119")

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

# Holdout fail-retry queue (reads lane 2026-11-19): 0/11 recovered.
UNREADABLE_CONFS_SEED = frozenset({
  "1092349285-1",
  "1618525656-1",
  "1092338215-1",
  "35763203-1",
  "5230229983-1",
  "48122614-1",
  "7107547889-1",
  "7539901789-1",
  "45498877-1",
  "8057220826-1",
  "1538599818-1",
})

UNREAD_ERR_RE = re.compile(
  r"NOT_FOUND|HINT_MISMATCH|DETAILS_NOT_LOADED|AMBIGUOUS_CONFIRMATION",
  re.I,
)

LAB_RE = re.compile(
  r"labtest|proof\s*lab|navaai|example\.invalid|synthetic[\s_-]?lab",
  re.I,
)

# Bases that encode HMS stay / confirmation identity (not mail/PDF alone).
HMS_TIED_BASIS = re.compile(
  r"reviewed_confirmation|reviewed_amendment|filing_target|"
  r"from_shown|unchanged_field|cancel_patch|create_has_no_confirmation|"
  r"meal_plan_text_not_unique",
  re.I,
)

# Mail/PDF bases — keep even when conf is unreadable (unless Labtest booking).
MAIL_OK_BASIS = re.compile(r"first_pdf|bench_mail|description_default|scope_default|staff_picks", re.I)

# CMS recipient / message-id: keep gold only if labelled from staff/hotel source
# (not later HMS read / tier2_default_not_forced_by_shown).
CMS_STAFF_HOTEL_BASIS = re.compile(
  r"staff_|hotel_|requester|from_email|mail_body|signature|context_after|"
  r"bench_mail|first_pdf|known_requester",
  re.I,
)
CMS_TICK_LEAF = "cms_send"
CMS_KEEPABLE_LEAVES = frozenset({"cms_message_id", "cms_recipient"})


def leaf(path: str) -> str:
  return path.rstrip("/").split("/")[-1]


@lru_cache(maxsize=1)
def unreadable_confs() -> frozenset[str]:
  """Fail-retry seed + confs whose latest fresh-read never loaded a stay."""
  out = set(UNREADABLE_CONFS_SEED)
  reads = READS_ROOT / "reads-all.jsonl"
  if not reads.exists():
    return frozenset(out)
  latest: dict[str, dict] = {}
  with reads.open() as f:
    for line in f:
      try:
        o = json.loads(line)
      except json.JSONDecodeError:
        continue
      conf = o.get("confirmation")
      if conf:
        latest[conf] = o
  for conf, o in latest.items():
    errs = " ".join(
      (e.get("error") if isinstance(e, dict) else str(e))
      for e in (o.get("errors") or [])
    )
    if UNREAD_ERR_RE.search(errs) and not (o.get("record_view") or o.get("shallow")):
      out.add(conf)
  return frozenset(out)


def labtest_or_navaai(card: dict) -> bool:
  se = card.get("selected_email") or {}
  parts = [
    json.dumps(card.get("hms_raw") or {}),
    json.dumps(card.get("hms_shown") or {}),
    str(se.get("subject") or ""),
    str(se.get("from") or ""),
    str(se.get("body_text") or "")[:2000],
  ]
  blob = "\n".join(parts)
  return bool(LAB_RE.search(blob))


def booking_createdby(card: dict) -> str | None:
  """createdby on gold booking (anchor / later HMS)."""
  raw = card.get("hms_raw") or {}
  for key in ("anchor_hms_fields", "later_hms_from_gold", "later_hms"):
    block = raw.get(key) or {}
    fields = block.get("fields") if isinstance(block, dict) else None
    if isinstance(fields, dict) and fields.get("createdby"):
      return str(fields["createdby"])
  shown = card.get("hms_shown") or {}
  # shallow dig
  stack = [shown]
  while stack:
    cur = stack.pop()
    if isinstance(cur, dict):
      if cur.get("createdby"):
        return str(cur["createdby"])
      stack.extend(cur.values())
    elif isinstance(cur, list):
      stack.extend(cur[:20])
  return None


def is_channel_hrcen_create(card: dict, wf: str) -> bool:
  """CREATE (card or overlay) whose gold booking was channel/GDS (createdby=HRCEN)."""
  card_wf = card.get("workflow")
  if wf != "create" and card_wf != "create":
    return False
  return (booking_createdby(card) or "").upper() == "HRCEN"


def taint_reason(card: dict, *, set_name: str, wf: str) -> str | None:
  conf = card.get("real_confirmation")
  parts: list[str] = []
  if set_name in ("holdout-fresh", "dev-fresh"):
    lab = labtest_or_navaai(card)
    unread = conf in unreadable_confs()
    if lab and unread:
      parts.append(f"labtest_or_navaai+unreadable_conf:{conf}")
    elif lab:
      parts.append(f"labtest_or_navaai:{conf}")
    elif unread:
      parts.append(f"unreadable_conf:{conf}")
    if is_channel_hrcen_create(card, wf):
      parts.append(f"create_createdby_hrcen_channel:{conf}")
  return "+".join(parts) if parts else None


def field_depends_on_taint(
  g: dict,
  *,
  lab: bool,
  unread: bool,
  hrcen_create: bool,
) -> bool:
  """True → patch to no_gold."""
  path = g.get("path") or ""
  exp = g.get("expectation")
  if exp == "no_gold":
    return False
  basis = str(g.get("basis") or "")
  if lab:
    # Synthetic Nava booking: any booking gold is contaminated.
    if path.startswith("/bookings/"):
      return True
    return False
  if hrcen_create:
    # Channel/GDS booking — create field gold not from this email. Keep routing only.
    if path.startswith("/bookings/"):
      return True
    return False
  if unread:
    if path.startswith("/bookings/"):
      if MAIL_OK_BASIS.search(basis) and not HMS_TIED_BASIS.search(basis):
        # PDF/mail create fields stay measurable.
        return False
      return True
    if leaf(path) == "confirmation_number":
      return True
  return False


def cms_field_no_gold(g: dict) -> str | None:
  """Return basis tag if this CMS gold field should become no_gold."""
  path = g.get("path") or ""
  leaf_name = leaf(path)
  if g.get("expectation") == "no_gold":
    return None
  if leaf_name == CMS_TICK_LEAF:
    return "gold_v4_cms_tick_later_hms_not_evidence"
  if leaf_name in CMS_KEEPABLE_LEAVES:
    basis = str(g.get("basis") or "")
    if CMS_STAFF_HOTEL_BASIS.search(basis):
      return None
    return "gold_v4_cms_id_recipient_not_staff_hotel_source"
  return None


def build(name: str) -> dict:
  cases = DATA / "cases" / name
  audit = DATA / "gold-audit" / name
  v3_path = audit / "gold-v3.json"
  if not v3_path.exists():
    raise SystemExit(f"missing {v3_path}")
  v3 = json.loads(v3_path.read_text())
  out: dict = {}
  patch_reasons: Counter[str] = Counter()
  tainted_rows: list[dict] = []
  for cid, v3row in v3.items():
    card = json.loads((cases / cid / "case.json").read_text())
    wf = v3row.get("workflow") or card.get("workflow")
    reason = taint_reason(card, set_name=name, wf=wf)
    lab = bool(reason and "labtest_or_navaai" in reason)
    unread = bool(reason and "unreadable_conf" in reason)
    hrcen_create = bool(reason and "create_createdby_hrcen_channel" in reason)
    patches_by_path: dict[str, dict] = {}

    # Measurement patches (expected → not_expected).
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
        patches_by_path[path] = {
          "path": path,
          "expectation": "not_expected",
          "basis": "+".join(reasons),
          "was_value": val,
        }
        for r in reasons:
          patch_reasons[r] += 1

    # Taint patches override measurement (expected/not_expected → no_gold).
    taint_paths: list[str] = []
    if reason:
      for g in card.get("gold") or []:
        path = g.get("path") or ""
        if not field_depends_on_taint(
          g, lab=lab, unread=unread, hrcen_create=hrcen_create,
        ):
          continue
        patches_by_path[path] = {
          "path": path,
          "expectation": "no_gold",
          "basis": f"gold_v4_tainted:{reason}",
          "was_expectation": g.get("expectation"),
          "was_value": g.get("value"),
        }
        patch_reasons["gold_v4_tainted_no_gold"] += 1
        taint_paths.append(path)
      tainted_rows.append({
        "case_id": cid,
        "confirmation": card.get("real_confirmation"),
        "workflow": wf,
        "card_workflow": card.get("workflow"),
        "createdby": booking_createdby(card),
        "reason": reason,
        "n_no_gold_patches": len(taint_paths),
        "paths": taint_paths,
      })

    # CMS Send Mail tick: later HMS read is cleared by CMS user — not evidence.
    # Recipient / message-id: keep only staff/hotel-sourced gold.
    for g in card.get("gold") or []:
      path = g.get("path") or ""
      cms_basis = cms_field_no_gold(g)
      if not cms_basis:
        continue
      # Don't clobber a stronger taint tag already applied to this path.
      if path in patches_by_path and patches_by_path[path].get("expectation") == "no_gold":
        continue
      patches_by_path[path] = {
        "path": path,
        "expectation": "no_gold",
        "basis": cms_basis,
        "was_expectation": g.get("expectation"),
        "was_value": g.get("value"),
      }
      patch_reasons[cms_basis] += 1

    patches = list(patches_by_path.values())
    out[cid] = {
      "workflow": wf,
      "old_workflow": v3row.get("old_workflow") or card.get("workflow"),
      "changed": bool(v3row.get("changed")),
      "skip": bool(v3row.get("skip")),
      "evidence_quote": v3row.get("evidence_quote"),
      "gold_patches": patches,
      "n_patches": len(patches),
      "taint_reason": reason,
    }
  summary = {
    "n": len(out),
    "cases_with_patches": sum(1 for r in out.values() if r["n_patches"]),
    "patch_total": sum(r["n_patches"] for r in out.values()),
    "patch_reasons": dict(patch_reasons),
    "tainted_cases": len(tainted_rows),
    "from": "gold-v3",
    "set": name,
  }
  audit.mkdir(parents=True, exist_ok=True)
  (audit / "gold-v4.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
  (audit / "summary-v4.json").write_text(json.dumps(summary, indent=2))
  if name in ("holdout-fresh", "dev-fresh"):
    (audit / "tainted-gold-cases.json").write_text(
      json.dumps({"n": len(tainted_rows), "cases": tainted_rows}, indent=2, ensure_ascii=False)
    )
  print(json.dumps(summary, indent=2))
  return summary


def main() -> None:
  sets = sys.argv[1:] or ["holdout-fresh", "v1", "dev-fresh"]
  for name in sets:
    build(name)


if __name__ == "__main__":
  main()
