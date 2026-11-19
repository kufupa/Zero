#!/usr/bin/env python3
"""Build gold-v4 overlays from gold-v3 + measurement patches. Never edits case.json.

Default output: $NAVA_BENCH_DATA_ROOT/gold-audit/{holdout-fresh,v1,dev-fresh}/gold-v4.json
Loaded automatically by bench runner/rescore for those sets.

Also marks booking gold no_gold when:
- holdout-fresh + dev-fresh: synthetic Labtest/Proof/NAVAAI booking or still-
  unreadable HMS conf (latest fresh-read has no stay: NOT_FOUND / HINT_MISMATCH /
  DETAILS_NOT_LOADED / AMBIGUOUS). Recovered record_ok confs are un-tainted.
- holdout-fresh + dev-fresh: CREATE whose gold booking has createdby=HRCEN
  (channel/GDS interface — not staff email create). Routing workflow kept.
- all sets: cms_send (CMS Send Mail tick) — later HMS reads are false after CMS
  clears the tick; PRODUCT.md default is ticked, so later-read gold is not evidence.
  cms_message_id / cms_recipient stay only when basis is staff/hotel-sourced.
- amend: drop create-style expected gold (first_pdf / hms_roomtype / …) and any
  booking expected gold when twin stay is absent at as_of (no last-pre-as_of
  hotel conf PDF). Amend gold is reservation_id + reviewed_amendment deltas only.
- quote quantity: no_gold when value is not a sane room count (0, years like
  2026 from date misparse, non-int, or absurdly large).
- quote rate code: a code copied from a linked stay is not a requested
  constraint at decision time.
- filing attachment: gold needs a replay-visible PDF of the submitted type.
  A hotel confirmation letter is not the voucher or payment proof it references.
- create: a later PDF cannot settle a room choice absent from a standalone
  request, or override an explicit stay window in that request.

Use --refresh-v4 <set> for a split supplied with a prebuilt gold-v4 overlay.

Cases stay in the set.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from datetime import datetime
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

# Create-style bases left on amend overlays (create→amend remaps) — not amend deltas.
AMEND_CREATE_STYLE_BASIS = re.compile(
  r"first_pdf|hms_roomtype|first_pdf_catalogue|^create_",
  re.I,
)
AMEND_NO_TWIN_BASIS = frozenset({
  "create_booking_absent_at_as_of",
  "no_pre_as_of_pdf",
})


def leaf(path: str) -> str:
  return path.rstrip("/").split("/")[-1]


@lru_cache(maxsize=1)
def unreadable_confs() -> frozenset[str]:
  """Confs whose *latest* fresh-read still has no stay loaded.

  Fail-retry seed is only a candidate list — recovered record_ok confs
  (reader fix #2277–#2285) are NOT unreadable anymore. Seed confs with no
  re-read yet stay unreadable.
  """
  reads = READS_ROOT / "reads-all.jsonl"
  latest: dict[str, dict] = {}
  if reads.exists():
    with reads.open() as f:
      for line in f:
        try:
          o = json.loads(line)
        except json.JSONDecodeError:
          continue
        conf = o.get("confirmation")
        if conf:
          latest[conf] = o
  out: set[str] = set()
  for conf in set(latest) | set(UNREADABLE_CONFS_SEED):
    o = latest.get(conf)
    if o and (o.get("record_view") or o.get("shallow")):
      continue  # recovered / readable — do not taint as unreadable
    if not o:
      if conf in UNREADABLE_CONFS_SEED:
        out.add(conf)
      continue
    errs = " ".join(
      (e.get("error") if isinstance(e, dict) else str(e))
      for e in (o.get("errors") or [])
    )
    if UNREAD_ERR_RE.search(errs):
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


def amend_ruler_no_gold(g: dict, *, wf: str, shown: dict | None) -> str | None:
  """Amend measurement: only reservation_id + reviewed_amendment deltas score."""
  if wf != "amend":
    return None
  if g.get("expectation") != "expected":
    return None
  path = g.get("path") or ""
  if not path.startswith("/bookings/"):
    return None
  basis = str(g.get("basis") or "")
  shown = shown or {}
  exists = bool(shown.get("exists"))
  shown_basis = str(shown.get("basis") or "")
  if AMEND_CREATE_STYLE_BASIS.search(basis):
    return "gold_v4_amend_create_style_gold"
  if (not exists) or shown_basis in AMEND_NO_TWIN_BASIS:
    return "gold_v4_amend_no_twin_at_as_of"
  return None


def sane_room_quantity(value: object) -> bool:
  """True when gold looks like a real room count (not 0 / year / junk)."""
  if isinstance(value, bool):
    return False
  if isinstance(value, int):
    n = value
  elif isinstance(value, float) and value.is_integer():
    n = int(value)
  elif isinstance(value, str) and value.strip().isdigit():
    n = int(value.strip())
  else:
    return False
  if n < 1 or n > 99:
    return False
  # Year misparsed as qty (e.g. 0/2026 → 2026).
  if 1900 <= n <= 2100:
    return False
  return True


def quote_quantity_no_gold(g: dict, *, wf: str) -> str | None:
  """Room qty gold that isn't a sane count → no_gold.

  Applies on quote and on quote→create remaps (v3 may relabel workflow while
  leaving selected_email_rooms qty junk like 0 / 2026).
  """
  del wf  # path-scoped; remapped creates still carry junk room qty
  if g.get("expectation") != "expected":
    return None
  path = g.get("path") or ""
  if leaf(path) != "quantity" or "/rooms/" not in path:
    return None
  if sane_room_quantity(g.get("value")):
    return None
  return "gold_v4_quote_qty_not_sane_room_count"


ROOM_CHOICE = re.compile(
  r"\b(?:twin|queen|king|suite|family|executive|luxury|deluxe|superior|classic|"
  r"accessible|double|triple|studio|penthouse|connecting|terrace)\b|"
  r"\b(?:STQN|STWN|SKNG|DLXTWN|DLXQN|DLXKNG|EXKNG|LUXKNG)\b",
  re.I,
)
STAY_DATE_LINE = re.compile(
  r"^[ \t]*[-*•]?[ \t]*(check[ -]?in|arrival|check[ -]?out|departure)"
  r"(?:[ \t]+date)?(?:[ \t]*:[ \t]*|[ \t]+)(\S[^\r\n]*?)\s*$",
  re.I | re.M,
)


def current_mail_text(mail: dict) -> tuple[str, str]:
  body = re.split(r"^\s*(?:>|From:|On .+ wrote:|[- ]+Original Message)",
                  mail.get("body_text") or "", maxsplit=1, flags=re.I | re.M)[0]
  return f"{mail.get('subject') or ''}\n{body}", body


def standalone_create_source(card: dict) -> tuple[str, dict[str, str]] | None:
  """Return only clear current-inbound evidence when no other inputs apply."""
  mail = card.get("selected_email") or {}
  non_pdf_docs = any(
    Path(att.get("filename") or "").suffix.lower() not in {".gif", ".png", ".jpg", ".jpeg"}
    for att in mail.get("attachments_non_pdf") or []
  )
  if (card.get("context_before") or card.get("cross_thread_context")
      or mail.get("pdf_attachments_text") or non_pdf_docs):
    return None
  text, body = current_mail_text(mail)
  dates: dict[str, set[str]] = {"arrival_date": set(), "departure_date": set()}
  for label, value in STAY_DATE_LINE.findall(body):
    key = "arrival_date" if label.lower() == "arrival" or label.lower().endswith("in") else "departure_date"
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%d-%m-%Y", "%d %B %Y", "%d %b %Y"):
      try:
        dates[key].add(datetime.strptime(value, fmt).date().isoformat())
        break
      except ValueError:
        continue
  stay = {k: next(iter(v)) for k, v in dates.items() if len(v) == 1}
  if len(stay) != 2 or stay["arrival_date"] >= stay["departure_date"]:
    stay = {}
  return text, stay


def filing_missing_document(mail: dict) -> str | None:
  pdfs = mail.get("pdf_attachments_text") or []
  if not pdfs:
    return "gold_v4_filing_no_selected_pdf_in_replay"
  if (all(re.match(r"^HRCEN_Confirmation_Letter_", p.get("filename") or "", re.I) for p in pdfs)
      and re.search(r"\b(?:vouchers?|proof of payment|pop)\b", current_mail_text(mail)[0], re.I)):
    return "gold_v4_filing_confirmation_pdf_is_not_submission"
  return None


ROOM_COUNT = re.compile(
  r"\b(\d{1,2})\s*(?:x\s+)?"
  r"(?:(?:standard|twin|double|single|queen|king|deluxe|family|executive|luxury)\s+)*rooms?\b",
  re.I,
)


def quote_quantity_conflicts(mail: dict, value: object) -> bool:
  if not sane_room_quantity(value):
    return False  # handled by the existing invalid-quantity rule
  text, _ = current_mail_text(mail)
  counts = {int(n) for n in ROOM_COUNT.findall(text)}
  room_indices = re.findall(r"\b(\d+)(?:st|nd|rd|th)\s+room\b", text, re.I)
  # The old extractor writes a total to rooms[0], which is one room category.
  return len(set(room_indices)) > 1 or bool(counts and int(value) not in counts)


def blind_source_patches(card: dict, wf: str, patches: dict[str, dict]) -> None:
  """Use only case inputs and gold provenance; never read proposals."""
  mail = card.get("selected_email") or {}
  create_source = standalone_create_source(card) if wf == "create" else None
  filing_why = filing_missing_document(mail) if wf == "filing" else None
  for g in card.get("gold") or []:
    path = g["path"]
    if g["expectation"] != "expected" or path in patches:
      continue
    why = None
    if (wf == "quote" and leaf(path) == "rate_code"
        and g.get("basis") == "staff_quote_or_linked_stay"):
      why = "gold_v4_quote_rate_from_linked_stay"
    elif (wf == "quote" and leaf(path) == "quantity"
          and g.get("basis") == "selected_email_rooms"
          and quote_quantity_conflicts(mail, g.get("value"))):
      why = "gold_v4_quote_room_quantity_not_supported"
    elif filing_why and leaf(path) == "attachment_id" and g.get("basis") == "bench_mail_attachment_id":
      why = filing_why
    elif create_source:
      text, stay = create_source
      field = leaf(path)
      basis = g.get("basis") or ""
      if field in stay and basis == "first_pdf" and stay[field] != g.get("value"):
        why = "gold_v4_create_later_pdf_conflicts_with_requested_date"
      elif (field == "room_type" and basis == "unique exact first-PDF description in saved complete catalogue"
            and not ROOM_CHOICE.search(text)):
        why = "gold_v4_create_later_pdf_room_not_requested"
    if why:
      patches[path] = {"path": path, "expectation": "no_gold", "basis": why}


def refresh_v4(name: str) -> None:
  path = DATA / "gold-audit" / name / "gold-v4.json"
  overlay = json.loads(path.read_text())
  counts: Counter[str] = Counter()
  for cid, row in overlay.items():
    card = json.loads((DATA / "cases" / name / cid / "case.json").read_text())
    patches = {p["path"]: p for p in row.get("gold_patches", [])}
    before = set(patches)
    blind_source_patches(card, row.get("workflow") or card["workflow"], patches)
    counts.update(p["basis"] for k, p in patches.items() if k not in before)
    if patches.keys() != before:
      row["gold_patches"] = list(patches.values())
      row["n_patches"] = len(patches)
  if counts:
    path.write_text(json.dumps(overlay, indent=2, ensure_ascii=False))
    summary_path = path.with_name("summary-v4.json")
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    summary.update({
      "set": name,
      "n": len(overlay),
      "cases_with_patches": sum(bool(row.get("gold_patches")) for row in overlay.values()),
      "patch_total": sum(len(row.get("gold_patches", [])) for row in overlay.values()),
      "patch_reasons": dict(Counter(summary.get("patch_reasons", {})) + counts),
    })
    summary_path.write_text(json.dumps(summary, indent=2))
  print(json.dumps({"set": name, "added_patches": counts}, sort_keys=True))


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

    # Amend ruler: create-style gold / no twin at as_of → no_gold (keep routing).
    shown = card.get("hms_shown") if isinstance(card.get("hms_shown"), dict) else {}
    for g in card.get("gold") or []:
      path = g.get("path") or ""
      amend_basis = amend_ruler_no_gold(g, wf=wf, shown=shown)
      if not amend_basis:
        continue
      if path in patches_by_path and patches_by_path[path].get("expectation") == "no_gold":
        continue
      patches_by_path[path] = {
        "path": path,
        "expectation": "no_gold",
        "basis": amend_basis,
        "was_expectation": g.get("expectation"),
        "was_value": g.get("value"),
      }
      patch_reasons[amend_basis] += 1

    # Quote qty: date-as-qty / 0 / non-int junk → no_gold.
    for g in card.get("gold") or []:
      path = g.get("path") or ""
      qty_basis = quote_quantity_no_gold(g, wf=wf)
      if not qty_basis:
        continue
      if path in patches_by_path and patches_by_path[path].get("expectation") == "no_gold":
        continue
      patches_by_path[path] = {
        "path": path,
        "expectation": "no_gold",
        "basis": qty_basis,
        "was_expectation": g.get("expectation"),
        "was_value": g.get("value"),
      }
      patch_reasons[qty_basis] += 1

    prior_paths = set(patches_by_path)
    blind_source_patches(card, wf, patches_by_path)
    for path in patches_by_path.keys() - prior_paths:
      patch_reasons[patches_by_path[path]["basis"]] += 1

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
  if sets[0] == "--refresh-v4":
    if len(sets) != 2:
      raise SystemExit("usage: build_gold_v4.py --refresh-v4 SET")
    refresh_v4(sets[1])
    return
  for name in sets:
    build(name)


if __name__ == "__main__":
  main()
