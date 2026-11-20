#!/usr/bin/env python3
"""Build blind gold-v5 overlays from HMS truth + explicit email text.

Never reads agent outputs or scoreboards. Never edits case.json or gold-v4.

Output (per set):
  $NAVA_BENCH_DATA_ROOT/gold-audit/<set>/gold-v5.json
  $NAVA_BENCH_DATA_ROOT/gold-audit/<set>/gold-v5.meta.json

Usage:
  python3 build_gold_v5.py --set holdout-v2
  python3 build_gold_v5.py --set dev-v2
  python3 build_gold_v5.py --set holdout-v3   # when L4 finishes
  python3 build_gold_v5.py --set holdout-v2 --set dev-v2 --sanity
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

DATA = Path(os.environ.get("NAVA_BENCH_DATA_ROOT") or "/home/orca/.local/share/zero/bench/replay-bench-20261119")
READS = Path(
  os.environ.get("NAVA_HMS_FRESH_READS_ROOT")
  or "/home/orca/.local/share/zero/research/hms-fresh-reads-20261119"
)
STAY360 = Path(
  os.environ.get("NAVA_STAY360_PATH")
  or "/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json"
)

TIER1 = "tier1_core"
TIER2 = "tier2_defaults"
TIER_HIST = "history_knowable"
TIER_PARITY = "parity"
TIER_ROUTE = "workflow_routing"
TIER_DIAG = "diagnostic"

# Known blind fixes from audit B (prefix → handler note).
KNOWN_CANCEL_CONF = {
  # Tollink cancel for Mr Lengo — gold-v4 pointed at wrong stay.
  "hf-8b09110355f8257f": "48122614-1",
}

MONTHS = {
  "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
  "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
  "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
  "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

ROOM_PHRASE_TO_CODE = [
  (re.compile(r"\bdeluxe\s+twin\b|\bdlxtwn\b", re.I), "DLXTWN", "Deluxe Twin"),
  (re.compile(r"\bdeluxe\s+queen\b|\bdlxqn\b", re.I), "DLXQN", "Deluxe Queen"),
  (re.compile(r"\bdeluxe\s+king\b|\bdlxkng\b", re.I), "DLXKNG", "Deluxe King"),
  (re.compile(r"\bexecutive\s+king\b|\bexkng\b", re.I), "EXKNG", "Executive King"),
  (re.compile(r"\bluxury\s+king\b|\bluxkng\b", re.I), "LUXKNG", "Luxury King"),
  (re.compile(r"\bstandard\s+twin\b|\bstwn\b|\btwin\s+room\b|\btwin\b", re.I), "STWN", "Standard Twin"),
  (re.compile(r"\bstandard\s+queen\b|\bstqn\b|\bqueen\s+room\b|\bqueen\b", re.I), "STQN", "Standard Queen"),
  (re.compile(r"\bstandard\s+king\b|\bskng\b|\bking\s+room\b|\bking\s+size\b|\bking\b", re.I), "SKNG", "Standard King"),
  (re.compile(r"\bsingle\s+standard\s+room\b|\bstandard\s+room\b", re.I), "STQN", "Standard Queen"),
]

POP_RE = re.compile(
  r"\b(?:proof\s+of\s+payment|\bpop\b|payment\s+proof|remittance|eft\s+proof|payment\s+notification)\b",
  re.I,
)
# Filename-only extras (CamelCase/underscore PDFs); keep out of text-blob match.
POP_FN_RE = re.compile(
  r"\b(?:proof\s+of\s+payment|\bpop\b|payment\s+proof|remittance|eft\s+proof|payment\s+notification|"
  r"payment\s+confirmation|eft|deposit\s+slip|bank\s+transfer)\b",
  re.I,
)


def normalize_filename(fn: str) -> str:
  """Split CamelCase / separators so POP_FN_RE can match ProofOfPaymentNotification.pdf etc."""
  s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", fn)
  s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
  return re.sub(r"[_\-.]+", " ", s).lower()
VOUCHER_RE = re.compile(
  r"(?:\bvouch(?:er|ers)?\b|\bvch[_-]|booking\s+voucher)",
  re.I,
)
# Hotel-generated confirmation/proforma — never filing attachment gold.
# Derived from naming patterns (property mailbox letters), not a hard-coded property code.
HOTEL_GENERATED_PDF_RE = re.compile(
  r"Confirmation[_\s-]?Letter|"
  r"Pro[\s-]?forma|"
  r"(?:^|[_\s-])[A-Z]{3,6}_Confirmation|"
  r"amended\s+confirmation\s+letter",
  re.I,
)
CONF_RE = re.compile(r"(\d{6,10}-\d)")
ISO_DATE_RE = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
DMY_RE = re.compile(
  r"\b(\d{1,2})[./\-](\d{1,2})[./\-](20\d{2})\b"
)
NAMED_DATE_RE = re.compile(
  r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
  r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
  r"(?:\s+(\d{4}|\d{2}))?\b",
  re.I,
)
# Avoid bare "from"/"to"/"arrival" (matches "upon arrival", "from the DRC").
CHECK_IN_RE = re.compile(
  r"(?:check[\s-]?in|arrive[sd]?|in\s+on)\s*[:\-]?\s*",
  re.I,
)
CHECK_OUT_RE = re.compile(
  r"(?:check[\s-]?out|depart(?:s|ing)?|out\s+on|until)\s*[:\-]?\s*",
  re.I,
)
SURNAME_AMEND_RE = re.compile(
  r"amendments?\s+to\s+the\s+clients['']?\s+surnames|"
  r"surname\s+correction|full\s+surnames|amend(?:ed|ing)?\s+(?:the\s+)?(?:guest\s+)?surnames?",
  re.I,
)
# LAST[, FIRST] lines typical of series surname corrections.
SURNAME_LINE_RE = re.compile(
  r"^([A-Z][A-Z'’ \-]+(?:,?\s+Junior)?),\s*([A-Za-z][A-Za-z'’\-]+(?:\s+[A-Za-z][A-Za-z'’\-]+)?)\s*$",
  re.M,
)
CHANGE_ARRIVAL_FROM_TO_RE = re.compile(
  r"change\s+arrival\s+from\s+(.+?)\s+to\s+(.+?)(?:\.|$|\n|Keep)",
  re.I | re.S,
)
KEEP_DEPARTURE_RE = re.compile(
  r"(?:keep\s+)?departure\s+on\s+(.+?)(?:\.|$|\n)",
  re.I,
)
CHANGE_DEPARTURE_FROM_TO_RE = re.compile(
  r"change\s+departure\s+from\s+(.+?)\s+to\s+(.+?)(?:\.|$|\n)",
  re.I | re.S,
)
ADULTS_RE = re.compile(
  r"\b(\d+)\s*(?:adults?|pax|guests?|officials?|delegates?|persons?|people)\b",
  re.I,
)
CHILDREN_RE = re.compile(r"\b(\d+)\s*(?:children|child|kids?)\b", re.I)
ROOMS_RE = re.compile(
  # Require real whitespace before "room(s)" so URL "%20Room" does not match.
  r"\b(\d{1,2})\s*[x×]\s*(?:rooms?|officials?|guests?|delegates?)\b|\b(\d{1,2})[ \t]+rooms?\b",
  re.I,
)
CANCEL_REASON_RE = re.compile(
  r"(?:cancel(?:lation)?\s+(?:because|due to|reason)|will not be joining|no longer needs?|"
  r"not\s+joining|flight\s+change|budget|double\s+book)",
  re.I,
)


def leaf(path: str) -> str:
  return path.rstrip("/").split("/")[-1]


def priority_for(path: str) -> str:
  leaf_name = leaf(path)
  if leaf_name in {
    "arrival_date", "departure_date", "first_name", "last_name", "guest_name",
    "reservation_id", "confirmation_number", "attachment_id", "adults",
    "child_count", "child_ages",
    # Owner ruler 2026-11-20: create/amend party + quote board are P0.
    "agency_name", "organization_name", "board",
  }:
    return "P0"
  if leaf_name in {
    "room_type", "rate_plan", "rate_code",
    "track", "source_of_business", "type", "cancellation_reason",
    "quantity",
  }:
    return "P1"
  # guarantee_type → P2: decided after payment/POP, not from the email.
  return "P2"


def parse_hms_date(raw: Any) -> str | None:
  if raw is None:
    return None
  s = str(raw).strip()
  if not s:
    return None
  m = ISO_DATE_RE.search(s)
  if m:
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
  m = re.search(
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})[- ]([A-Za-z]{3,9})[- ](20\d{2})",
    s,
    re.I,
  )
  if m:
    day, mon, year = int(m.group(1)), m.group(2).lower()[:3], int(m.group(3))
    month = MONTHS.get(mon) or MONTHS.get(m.group(2).lower())
    if month:
      return f"{year:04d}-{month:02d}-{day:02d}"
  m = re.search(r"(\d{2})-([A-Z]{3})-(20\d{2})", s, re.I)
  if m:
    day, mon, year = int(m.group(1)), m.group(2).lower(), int(m.group(3))
    month = MONTHS.get(mon)
    if month:
      return f"{year:04d}-{month:02d}-{day:02d}"
  return None


def parse_adults(raw: Any) -> int | None:
  if raw is None or raw == "":
    return None
  if isinstance(raw, (int, float)):
    return int(raw)
  s = str(raw)
  m = re.search(r"(\d+)\s*Adult", s, re.I)
  if m:
    return int(m.group(1))
  m = re.fullmatch(r"\d+", s.strip())
  if m:
    return int(m.group(0))
  return None


def parse_children(raw: Any) -> int | None:
  if raw is None or raw == "":
    return None
  if isinstance(raw, (int, float)):
    return int(raw)
  s = str(raw)
  m = re.search(r"(\d+)\s*Child", s, re.I)
  if m:
    return int(m.group(1))
  m = re.fullmatch(r"\d+", s.strip())
  if m:
    return int(m.group(0))
  return None


def fields_from_list(arr: Any) -> dict[str, Any]:
  out: dict[str, Any] = {}
  if not isinstance(arr, list):
    return out
  for f in arr:
    if isinstance(f, dict) and f.get("name"):
      out[str(f["name"]).lower()] = f.get("value")
  return out


def flatten_case_hms(card: dict) -> dict[str, Any]:
  """Best native-ish field map from case.json hms_raw (no agent outputs)."""
  raw = card.get("hms_raw") or {}
  out: dict[str, Any] = {}
  for key in ("anchor_hms_fields", "later_hms_from_gold", "later_hms"):
    block = raw.get(key)
    if not isinstance(block, dict):
      continue
    fields = block.get("fields") if isinstance(block.get("fields"), dict) else block
    if not isinstance(fields, dict):
      continue
    for k, v in fields.items():
      if v is None or v == "" or k in ("captured_at", "note", "observed_at", "provenance", "fields"):
        continue
      if isinstance(v, dict) and set(v.keys()) <= {"captured_at", "fields", "note"}:
        continue
      out.setdefault(str(k).lower(), v)
  # stay360 cards on case
  stay = raw.get("stay360") or raw.get("record_view") or {}
  if isinstance(stay, dict):
    details = stay.get("details") if isinstance(stay.get("details"), dict) else stay
    if isinstance(details, dict):
      cards = details.get("cards")
      if isinstance(cards, list):
        for c in cards:
          for f in (c.get("fields") or []) if isinstance(c, dict) else []:
            if isinstance(f, dict) and f.get("name") and f.get("value") not in (None, ""):
              out.setdefault(str(f["name"]).lower(), f.get("value"))
      fl = fields_from_list(details.get("fields"))
      for k, v in fl.items():
        if v not in (None, ""):
          out.setdefault(k, v)
  return out


@lru_cache(maxsize=1)
def load_reads_index() -> dict[str, dict[str, Any]]:
  path = READS / "reads-all.jsonl"
  out: dict[str, dict[str, Any]] = {}
  if not path.exists():
    return out
  with path.open() as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      try:
        o = json.loads(line)
      except json.JSONDecodeError:
        continue
      conf = o.get("confirmation")
      if not conf:
        continue
      rv = o.get("record_view") or {}
      details = rv.get("details") if isinstance(rv, dict) else None
      fields = fields_from_list(details.get("fields") if isinstance(details, dict) else None)
      out[conf] = {
        "fields": fields,
        "status": fields.get("status") or o.get("status"),
        "read_at": o.get("read_at"),
        "source": "hms_fresh_reads",
      }
  return out


@lru_cache(maxsize=1)
def load_stay360_index() -> dict[str, dict[str, Any]]:
  if not STAY360.exists():
    return {}
  data = json.loads(STAY360.read_text())
  out: dict[str, dict[str, Any]] = {}
  for r in data.get("results") or []:
    if not isinstance(r, dict):
      continue
    conf = r.get("confirmation")
    if not conf:
      continue
    fields: dict[str, Any] = {}
    stay = r.get("stay360") or {}
    details = (stay.get("details") if isinstance(stay, dict) else None) or {}
    for card in details.get("cards") or []:
      if not isinstance(card, dict):
        continue
      for f in card.get("fields") or []:
        if isinstance(f, dict) and f.get("name") and f.get("value") not in (None, ""):
          fields[str(f["name"]).lower()] = f.get("value")
    gd = r.get("guestDetails") or {}
    if isinstance(gd, dict):
      for k, v in gd.items():
        if v not in (None, ""):
          fields.setdefault(str(k).lower(), v)
    out[conf] = {"fields": fields, "source": "stay360_20261029"}
  return out


def hms_truth_for(conf: str | None, card: dict) -> tuple[dict[str, Any], str | None, str | None]:
  """Return (fields, source_tag, read_at). Prefer fresh reads, then stay360, then case hms_raw."""
  if conf:
    reads = load_reads_index()
    if conf in reads and reads[conf]["fields"]:
      return reads[conf]["fields"], "hms_truth", reads[conf].get("read_at")
    stay = load_stay360_index()
    if conf in stay and stay[conf]["fields"]:
      return stay[conf]["fields"], "hms_truth", None
  case_fields = flatten_case_hms(card)
  if case_fields:
    return case_fields, "hms_truth", None
  return {}, None, None


def iter_mail_msgs(card: dict) -> list[dict]:
  out: list[dict] = []
  se = card.get("selected_email")
  if isinstance(se, dict):
    out.append(se)
  for key in ("context_before",):
    for msg in card.get(key) or []:
      if isinstance(msg, dict):
        as_of = card.get("as_of") or ""
        ts = msg.get("timestamp") or msg.get("received_at") or ""
        if as_of and ts and str(ts) > str(as_of):
          continue
        out.append(msg)
  return out


def mail_blob(card: dict) -> str:
  parts: list[str] = []
  for msg in iter_mail_msgs(card):
    parts.append(str(msg.get("subject") or ""))
    parts.append(str(msg.get("body_text") or msg.get("body") or ""))
    for pdf in msg.get("pdf_attachments_text") or []:
      if isinstance(pdf, dict):
        parts.append(str(pdf.get("filename") or ""))
        parts.append(str(pdf.get("text") or "")[:4000])
  return "\n".join(parts)


def selected_blob(card: dict) -> str:
  se = card.get("selected_email") or {}
  if not isinstance(se, dict):
    return ""
  parts = [str(se.get("subject") or ""), str(se.get("body_text") or se.get("body") or "")]
  for pdf in se.get("pdf_attachments_text") or []:
    if isinstance(pdf, dict):
      parts.append(str(pdf.get("filename") or ""))
      parts.append(str(pdf.get("text") or "")[:4000])
  return "\n".join(parts)


def parse_date_fragment(frag: str, *, default_year: int | None = None) -> str | None:
  """Parse a short date phrase into YYYY-MM-DD."""
  frag = (frag or "").strip().strip(".,;")
  if not frag:
    return None
  m = ISO_DATE_RE.search(frag)
  if m:
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
  m = NAMED_DATE_RE.search(frag)
  if m:
    day = int(m.group(1))
    mon = MONTHS.get(m.group(2).lower()[:3]) or MONTHS.get(m.group(2).lower())
    year_raw = m.group(3)
    year = int(year_raw) if year_raw else default_year
    if year is not None and year < 100:
      year += 2000
    if mon and year:
      return f"{year:04d}-{mon:02d}-{day:02d}"
  m = DMY_RE.search(frag)
  if m:
    a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if a > 12:
      day, month = a, b
    elif b > 12:
      day, month = b, a
    else:
      day, month = a, b
    if 1 <= month <= 12 and 1 <= day <= 31:
      return f"{y:04d}-{month:02d}-{day:02d}"
  # "09 November 2026" / "1 October 2027" via looser named match
  m = re.search(
    r"(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"(?:\s+(20\d{2}))?",
    frag,
    re.I,
  )
  if m:
    day = int(m.group(1))
    mon = MONTHS.get(m.group(2).lower()[:3]) or MONTHS.get(m.group(2).lower())
    year = int(m.group(3)) if m.group(3) else default_year
    if mon and year:
      return f"{year:04d}-{mon:02d}-{day:02d}"
  return None


def email_dates(blob: str) -> dict[str, str]:
  """Extract arrival/departure when explicitly labelled in email text."""
  out: dict[str, str] = {}
  year_hit = re.search(r"\b(20\d{2})\b", blob)
  default_year = int(year_hit.group(1)) if year_hit else 2026

  # High-priority: "Change arrival from X to Y" / "Keep departure on Z"
  m = CHANGE_ARRIVAL_FROM_TO_RE.search(blob)
  if m:
    d = parse_date_fragment(m.group(2), default_year=default_year)
    if d:
      out["arrival_date"] = d
  m = CHANGE_DEPARTURE_FROM_TO_RE.search(blob)
  if m:
    d = parse_date_fragment(m.group(2), default_year=default_year)
    if d:
      out["departure_date"] = d
  m = KEEP_DEPARTURE_RE.search(blob)
  if m and "departure_date" not in out:
    d = parse_date_fragment(m.group(1), default_year=default_year)
    if d:
      out["departure_date"] = d

  # Labeled Check-in / Check-out bullets (prefer over loose from/to)
  for kind, label in (
    ("arrival_date", r"check[\s-]?in"),
    ("departure_date", r"check[\s-]?out"),
  ):
    if kind in out:
      continue
    m = re.search(rf"{label}\s*[:\-]\s*(.+?)(?:\n|$)", blob, re.I)
    if m:
      d = parse_date_fragment(m.group(1), default_year=default_year)
      if d:
        out[kind] = d

  # Stay range: "from 10 to 17 November 2026" / "09 - 14 November 2026"
  if "arrival_date" not in out or "departure_date" not in out:
    m = re.search(
      r"(?:from\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*[–\-to]+\s*(\d{1,2})(?:st|nd|rd|th)?\s+"
      r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
      r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
      r"(?:\s+(20\d{2}))?",
      blob,
      re.I,
    )
    if m:
      mon = MONTHS.get(m.group(3).lower()[:3]) or MONTHS.get(m.group(3).lower())
      year = int(m.group(4)) if m.group(4) else default_year
      if mon and year:
        if "arrival_date" not in out:
          out["arrival_date"] = f"{year:04d}-{mon:02d}-{int(m.group(1)):02d}"
        if "departure_date" not in out:
          out["departure_date"] = f"{year:04d}-{mon:02d}-{int(m.group(2)):02d}"

  for kind, cre in (("arrival_date", CHECK_IN_RE), ("departure_date", CHECK_OUT_RE)):
    if kind in out:
      continue
    for m in cre.finditer(blob):
      # Skip "upon arrival" / "on arrival" payment language
      prefix = blob[max(0, m.start() - 12): m.start()].lower()
      if "upon " in prefix or prefix.endswith("on "):
        continue
      tail = blob[m.end(): m.end() + 48]
      d = parse_date_fragment(tail, default_year=default_year)
      if d:
        out[kind] = d
        break

  # "in the 2nd" / "out the 4th" — day-of-month only; need a month/year anchor.
  day_in = re.search(
    r"(?:check[\s-]?in|arrive)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?",
    blob,
    re.I,
  )
  day_out = re.search(
    r"(?:check[\s-]?out|depart|out)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?",
    blob,
    re.I,
  )
  anchor = out.get("arrival_date") or out.get("departure_date")

  def with_day(day: int, other: str | None) -> str | None:
    if other:
      y, mo, _ = other.split("-")
      return f"{y}-{mo}-{day:02d}"
    return parse_date_fragment(f"{day} " + (re.search(
      r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
      r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
      r"\s+(20\d{2})",
      blob,
      re.I,
    ).group(0) if re.search(
      r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
      r"Aug(?:ust)|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
      r"\s+(20\d{2})",
      blob,
      re.I,
    ) else ""), default_year=default_year)

  if day_out and "departure_date" not in out:
    d = with_day(int(day_out.group(1)), out.get("arrival_date") or anchor)
    if d:
      out["departure_date"] = d
  if day_in and "arrival_date" not in out:
    d = with_day(int(day_in.group(1)), out.get("departure_date") or anchor)
    if d:
      out["arrival_date"] = d
  return out


def is_surname_only_amend(blob: str) -> bool:
  if not SURNAME_AMEND_RE.search(blob):
    return False
  # Surname-only if no explicit stay-change language beyond subject allocation dates.
  if re.search(
    r"change\s+arrival|change\s+departure|check[\s-]?in\s*:|check[\s-]?out\s*:|"
    r"revised\s+dates|amend(?:ed|ing)?\s+(?:the\s+)?(?:reservation\s+)?dates|"
    r"shorten|extend\s+(?:the\s+)?stay",
    blob,
    re.I,
  ):
    return False
  return True


def parse_surname_amend_names(blob: str) -> list[tuple[str, str]]:
  """Return [(last, first), ...] from SURNAME, First lines."""
  out: list[tuple[str, str]] = []
  for m in SURNAME_LINE_RE.finditer(strip_quoted_reply(blob)):
    last = re.sub(r"\s+", " ", m.group(1).strip(" ,"))
    first = re.sub(r"\s+", " ", m.group(2).strip())
    # Drop ALL-CAPS noise that isn't a person line
    if len(last) < 2 or len(first) < 2:
      continue
    out.append((last.title() if last.isupper() else last, first))
  return out


def match_surname_for_guest(
  names: list[tuple[str, str]],
  h_first: str | None,
  h_last: str | None,
) -> tuple[str, str] | None:
  if not names:
    return None
  hf, hl = norm_name(h_first), norm_name(h_last)
  for last, first in names:
    if hf and norm_name(first) == hf:
      return first, last
    if hf and hf in norm_name(first):
      return first, last
  if hl:
    for last, first in names:
      if hl in norm_name(last) or norm_name(last) in hl:
        return first, last
  return None


def email_room(blob: str) -> dict | None:
  for cre, code, name in ROOM_PHRASE_TO_CODE:
    if cre.search(blob):
      return {"code": code, "name": name}
  return None


def email_adults_children(blob: str) -> tuple[int | None, int | None]:
  adults = None
  children = None
  m = ADULTS_RE.search(blob)
  if m:
    n = int(m.group(1))
    # guard: years / phone fragments / absurd headcounts
    if 1 <= n <= 30:
      adults = n
  m = CHILDREN_RE.search(blob)
  if m:
    n = int(m.group(1))
    if 0 <= n <= 20:
      children = n
  return adults, children


def strip_quoted_reply(text: str) -> str:
  """Drop quoted reply tails so amend/create parsers see the current ask only."""
  lines: list[str] = []
  for line in (text or "").splitlines():
    s = line.strip()
    if s.startswith(">"):
      continue
    if re.match(r"^On .+ wrote:\s*$", s, re.I):
      break
    if re.match(r"^From:\s+\S+", s, re.I) and lines:
      break
    if re.match(r"^-{2,}\s*Original Message\s*-{2,}$", s, re.I):
      break
    if re.match(r"^_{5,}$", s) and lines:
      break
    lines.append(line)
  return "\n".join(lines)


def email_guest_names(blob: str) -> tuple[str | None, str | None]:
  """Best-effort first/last from current ask when stated (not HMS, not quoted thread)."""
  blob = strip_quoted_reply(blob)
  patterns = [
    re.compile(
      r"(?:reservation|booking|accommodation)\s+for\s+(?:Mr|Mrs|Ms|Miss|Dr)?\.?\s*"
      r"([A-Z][A-Za-z'’-]+)\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)",
      re.I,
    ),
    re.compile(
      r"(?:guest|traveller|traveler|official)\s*[:\-]\s*(?:Mr|Mrs|Ms|Miss|Dr)?\.?\s*"
      r"([A-Z][A-Za-z'’-]+)\s+([A-Z][A-Za-z'’-]+)",
      re.I,
    ),
  ]
  for cre in patterns:
    m = cre.search(blob)
    if m:
      return m.group(1).strip(), m.group(2).strip()
  return None, None


def norm_name(s: str | None) -> str:
  return re.sub(r"[^a-z]", "", (s or "").lower())


def names_conflict(email_first: str | None, email_last: str | None, h_first: str | None, h_last: str | None) -> bool:
  """True when email states a name and HMS differs on first or last."""
  if not (email_first or email_last):
    return False
  if not (h_first or h_last):
    return False
  ef, el = norm_name(email_first), norm_name(email_last)
  hf, hl = norm_name(h_first), norm_name(h_last)
  if ef and hf and ef != hf and ef not in hf and hf not in ef:
    return True
  if el and hl and el != hl and el not in hl and hl not in el:
    return True
  return False


def email_quantity(blob: str) -> int | None:
  """Explicit room quantity only. Never default to 1."""
  m = ROOMS_RE.search(blob)
  if not m:
    return None
  for g in m.groups():
    if g:
      n = int(g)
      if 1 <= n <= 50:
        return n
  return None


def rate_plan_to_board(rate_plan: Any) -> str | None:
  """HRCEN rate_plan code → board (DBB|BB|RO). Spec GEMINI-SPEC-E2E3 (b)1."""
  if isinstance(rate_plan, dict):
    code = rate_plan.get("code") or rate_plan.get("rate_plan") or rate_plan.get("rateplan")
  else:
    code = rate_plan
  if code is None or code == "":
    return None
  c = str(code).strip().upper()
  if c in {"HSE", "BARB2B"}:
    return None
  if re.search(r"DBB?$", c, re.I):
    return "DBB"
  if re.search(r"RO$", c, re.I) or c == "DAY":
    return "RO"
  if c in {"BAR", "EDU"} or re.match(r"^BDIRB[1-5]$", c, re.I):
    return "BB"
  if re.search(r"B$", c, re.I) and not re.search(r"DB$", c, re.I):
    return "BB"
  return None


def email_board(blob: str) -> str | None:
  # RO before BB so "without breakfast" / room-only never collapses to BB.
  if re.search(
    r"\bwithout\s+breakfast\b|\broom[-\s]only\b|\bRO\b|\bbed\s+only\b",
    blob,
    re.I,
  ):
    return "RO"
  # DBB: dinner + breakfast/B&B anywhere (e.g. "dinner R250 + bed and breakfast").
  if re.search(r"\bDBB\b|\bhalf\s+board\b", blob, re.I) or (
    re.search(r"\bdinner\b", blob, re.I)
    and re.search(r"\bbreakfast\b|\bB\s*&\s*B\b|\bBB\b", blob, re.I)
  ):
    return "DBB"
  if re.search(
    r"\bbed\s*(?:and|&)\s*breakfast\b|\bB(?:\s*(?:&|and)\s*)B\b|\bBB\b|\bbreakfast\b",
    blob,
    re.I,
  ):
    return "BB"
  return None


def email_rate_code(blob: str) -> str | None:
  # Only catalogue-looking rate codes (avoid NOTICE/NOVEMBER/etc.).
  m = re.search(
    r"\b(NCOR\d*[A-Z]?|NGOV[A-Z]*|BAR[A-Z0-9]*|WSF\d+[A-Z]?|NGOVB|NGOVDB|BARRO)\b",
    blob,
    re.I,
  )
  if m:
    return m.group(1).upper()
  return None


def code_name(code: str | None, name: str | None = None) -> dict | str | None:
  if not code and not name:
    return None
  if code and name:
    return {"code": code, "name": name}
  return code or name


def room_value_from_hms(fields: dict) -> dict | str | None:
  code = fields.get("roomtype") or fields.get("room_type")
  if isinstance(code, dict):
    return code
  if code:
    return {"code": str(code).strip(), "name": None}
  text = fields.get("room_type_text")
  if text:
    return str(text)
  return None


def rate_value_from_hms(fields: dict) -> dict | str | None:
  code = fields.get("rateplan") or fields.get("rate_plan")
  if isinstance(code, dict):
    return code
  if code:
    return {"code": str(code).strip(), "name": None}
  return None


def org_agency_from_hms(fields: dict) -> tuple[Any, Any]:
  org = fields.get("company")
  agency = fields.get("ta1")
  if org in (None, ""):
    org = None
  if agency in (None, ""):
    agency = None
  return org, agency


_GUEST_TITLES = frozenset({"mr", "mrs", "ms", "miss", "dr", "prof"})


def split_guest_full_name(guest: str) -> tuple[str | None, str | None]:
  """Parse HMS guestfullname / guestName forms: 'Last, Title First' or 'First Last'."""
  g = guest.strip()
  if not g:
    return None, None
  if "," in g:
    last_part, rest = [x.strip() for x in g.split(",", 1)]
    tokens = rest.split()
    while tokens and tokens[0].lower().rstrip(".") in _GUEST_TITLES:
      tokens = tokens[1:]
    first = " ".join(tokens) if tokens else None
    last = last_part or None
    return first, last
  parts = g.split()
  if len(parts) >= 2:
    return parts[0], " ".join(parts[1:])
  if len(parts) == 1:
    return None, parts[0]
  return None, None


def names_from_hms(fields: dict) -> tuple[str | None, str | None]:
  first = fields.get("firstname") or fields.get("first_name")
  last = fields.get("lastname") or fields.get("last_name")
  if first or last:
    return (str(first).strip() if first else None), (str(last).strip() if last else None)
  # Flatten lowercases keys: guestName→guestname, guestFullName→guestfullname.
  for key in ("guestname", "guest_name", "guestfullname", "guest_full_name"):
    guest = fields.get(key)
    if guest and isinstance(guest, str) and guest.strip():
      return split_guest_full_name(guest)
  return None, None


def mail_has_headers(card: dict) -> bool:
  for msg in iter_mail_msgs(card):
    for key in ("from", "to", "cc"):
      if msg.get(key):
        return True
  return False


# Mirror apps/nava-agent/src/party-matching.ts PARTY_STOPWORDS (+ cc).
PARTY_STOPWORDS = frozenset({
  "travel", "travels", "tours", "tour", "agency", "agent", "agents", "company",
  "group", "services", "service", "solutions", "holdings", "pty", "ltd", "limited",
  "south", "africa", "african", "hotel", "hotels", "booking", "bookings",
  "local", "district", "metropolitan", "municipality", "municipal", "department",
  "national", "provincial", "office", "the", "and", "for", "of", "sa", "cc",
})


def distinctive_party_tokens(value: Any) -> list[str]:
  raw = str(value or "").strip()
  if not raw:
    return []
  parts = re.split(r"[\s,./&+\-_|]+", raw)
  out: list[str] = []
  for p in parts:
    t = p.strip()
    if len(t) < 3:
      continue
    if t.isdigit():
      continue
    if t.lower() in PARTY_STOPWORDS:
      continue
    out.append(t)
  if len(raw) >= 3 and raw.lower() not in {x.lower() for x in out} and raw.lower() not in PARTY_STOPWORDS:
    out.append(raw)
  return out


def party_derivable(card: dict, party_value: Any) -> str:
  """Tag party gold: email | header_stripped | history_only (compare.py splits)."""
  blob = (mail_blob(card) or "").lower()
  header_bits: list[str] = []
  for msg in iter_mail_msgs(card):
    for key in ("from", "to", "cc"):
      v = msg.get(key)
      if v:
        header_bits.append(str(v))
  header_blob = " ".join(header_bits).lower()
  full = f"{blob}\n{header_blob}"
  for tok in distinctive_party_tokens(party_value):
    if tok.lower() in full:
      return "email"
  # Domain/brand labels from From/To/Cc (e.g. rennies.co.za → rennies).
  for m in re.finditer(r"@([a-z0-9.-]+)", header_blob, re.I):
    host = m.group(1).lower()
    label = host.split(".")[0]
    if len(label) >= 3 and label in str(party_value or "").lower().replace(" ", ""):
      return "email"
    if len(label) >= 3 and label in full and label in str(party_value or "").lower():
      return "email"
  if not mail_has_headers(card):
    return "header_stripped"
  return "history_only"


def add_child_count(
  b: "GoldBuilder",
  path: str,
  value: int,
  *,
  basis: str,
  source: str,
  hms_key: str | None = "children",
  conflict: bool = False,
) -> None:
  """child_count==0 → diagnostic (not P0); nonzero stays expected P0; conflict → no_gold."""
  if conflict:
    b.add(path, "no_gold", value=value, basis=basis, source=source, hms_key=hms_key)
    return
  if value == 0:
    b.add(
      path,
      "diagnostic",
      value=0,
      basis=basis,
      source=source,
      tier=TIER_DIAG,
      priority="P2",
      hms_key=hms_key,
    )
    return
  b.add(path, "expected", value=value, basis=basis, source=source, hms_key=hms_key)


def filing_doc_kind(doc_type: str | None, basis: str, att_id: str | None) -> str:
  """Gold-level filing doc_kind from type logic: voucher | pop | none."""
  if basis == "no_guest_pdf_in_input" or not att_id:
    return "none"
  if doc_type == "payment_proof_submission":
    return "pop"
  if doc_type == "voucher_submission":
    return "voucher"
  return "none"


class GoldBuilder:
  def __init__(self) -> None:
    self.rows: list[dict] = []
    self.seen: set[str] = set()
    self.notes: list[str] = []
    self.stats: Counter[str] = Counter()
    self.doc_kind: str | None = None

  def add(
    self,
    path: str,
    expectation: str,
    *,
    value: Any = None,
    basis: str,
    source: str,
    tier: str = TIER1,
    priority: str | None = None,
    before: Any = None,
    later_value: Any = None,
    hms_key: str | None = None,
    derivable: str | None = None,
  ) -> None:
    if path in self.seen:
      return
    self.seen.add(path)
    row: dict[str, Any] = {
      "path": path,
      "expectation": expectation,
      "basis": basis,
      "source": source,
      "tier": tier,
      "priority": priority or priority_for(path),
    }
    if expectation == "expected":
      row["value"] = value
    elif later_value is not None:
      row["later_value"] = later_value
    elif value is not None and expectation != "expected":
      row["later_value"] = value
    if before is not None:
      row["before"] = before
    if hms_key:
      row["hms_key"] = hms_key
    if derivable:
      row["derivable"] = derivable
    self.rows.append(row)
    if source == "heuristic" and basis == "email_hms_conflict":
      self.stats["create_email_hms_conflict"] += 1
      self.stats[f"create_email_hms_conflict:{leaf(path)}"] += 1


def is_hotel_generated_pdf(filename: str, text: str = "") -> bool:
  """True for property confirmation-letter / proforma PDFs (not guest voucher/POP)."""
  fn = filename or ""
  if HOTEL_GENERATED_PDF_RE.search(fn):
    return True
  # Text fallback when filename is generic but body is a hotel letterhead.
  head = (text or "")[:800]
  if re.search(r"confirmation\s+letter", head, re.I) and re.search(
    r"confirmation\s*(?:no|number|#)|reservation\s+confirmation",
    head,
    re.I,
  ):
    return True
  return False


def pick_filing_attachment(card: dict) -> tuple[str | None, str, str, str]:
  """Return (attachment_id, doc_type, source, basis). Guest voucher/POP only — never hotel letter."""
  se = card.get("selected_email") or {}
  pdfs = se.get("pdf_attachments_text") or [] if isinstance(se, dict) else []
  pdfs = [p for p in pdfs if isinstance(p, dict)]
  if not pdfs:
    return None, "voucher_submission", "heuristic", "no_guest_pdf_in_input"

  guest_pdfs = [
    p for p in pdfs
    if not is_hotel_generated_pdf(str(p.get("filename") or ""), str(p.get("text") or ""))
  ]
  if not guest_pdfs:
    return None, "voucher_submission", "heuristic", "no_guest_pdf_in_input"

  def score(p: dict) -> tuple[int, str, str]:
    fn = str(p.get("filename") or "")
    tx = str(p.get("text") or "")[:2000]
    blob = f"{fn}\n{tx}"
    if POP_FN_RE.search(normalize_filename(fn)):
      return 100, "payment_proof_submission", "email_explicit"
    if POP_RE.search(blob):
      return 90, "payment_proof_submission", "heuristic"
    if VOUCHER_RE.search(fn):
      return 80, "voucher_submission", "email_explicit"
    if VOUCHER_RE.search(blob):
      return 70, "voucher_submission", "heuristic"
    return 40, "voucher_submission", "heuristic"

  ranked = sorted(((score(p), p) for p in guest_pdfs), key=lambda x: -x[0][0])
  (sc, doc_type, source), best = ranked[0]
  att_id = best.get("attachment_id")
  if not att_id:
    # fall back to index among selected_email pdfs (stable for scorer)
    idx = pdfs.index(best)
    att_id = f"pdf-{idx}"
    source = "heuristic"
  basis = f"selected_pdf:{best.get('filename') or 'unnamed'}"
  return str(att_id), doc_type, source, basis


def email_named_confs(card: dict) -> list[str]:
  """Confirmation numbers named in email subject/body/attachment filenames+text (pre-as_of)."""
  found: list[str] = []
  seen: set[str] = set()
  for msg in iter_mail_msgs(card):
    parts = [str(msg.get("subject") or ""), str(msg.get("body_text") or msg.get("body") or "")]
    for pdf in msg.get("pdf_attachments_text") or []:
      if isinstance(pdf, dict):
        parts.append(str(pdf.get("filename") or ""))
        parts.append(str(pdf.get("text") or "")[:3000])
    for conf in CONF_RE.findall("\n".join(parts)):
      if conf not in seen:
        seen.add(conf)
        found.append(conf)
  return found


def multi_stay_bookings(card: dict, primary: str | None) -> list[dict]:
  """Bookings for amend/cancel: every stay the email names (≥2), else group_bookings, else primary."""
  email_confs = email_named_confs(card)
  if len(email_confs) >= 2:
    ordered: list[str] = []
    if primary and primary in email_confs:
      ordered.append(primary)
    for conf in email_confs:
      if conf not in ordered:
        ordered.append(conf)
    return [{"confirmation": c} for c in ordered]
  group = list(card.get("group_bookings") or [])
  if group:
    return sorted(group, key=lambda x: 0 if (x.get("confirmation") == primary) else 1)
  return [{"confirmation": primary}]


def read_after_as_of(read_at: str | None, as_of: str | None) -> bool:
  if not read_at or not as_of:
    return False
  return str(read_at) > str(as_of)


def build_create(card: dict, wf: str, b: GoldBuilder) -> None:
  conf = card.get("real_confirmation")
  bookings = list(card.get("group_bookings") or [])
  if not bookings:
    bookings = [{"confirmation": conf}]
  # primary first
  bookings = sorted(bookings, key=lambda x: 0 if (x.get("confirmation") == conf) else 1)
  blob = mail_blob(card)
  edates = email_dates(blob)
  eroom = email_room(blob)
  e_adults, e_children = email_adults_children(blob)
  # Names: selected ask only (avoid thread false positives).
  e_first, e_last = email_guest_names(selected_blob(card) or blob)
  e_qty = email_quantity(blob)

  for n, booking in enumerate(bookings):
    bconf = booking.get("confirmation") or conf
    fields, src, _read_at = hms_truth_for(bconf, card)
    # reservation_id not expected on create proposal
    b.add(
      f"/bookings/{n}/reservation_id",
      "not_expected",
      value=bconf,
      basis="create_has_no_confirmation_in_proposal",
      source="hms_truth" if bconf else "heuristic",
      hms_key="confirmationnumber",
    )

    # dates — conflict → no_gold (agent cannot know HMS over email)
    h_arr = parse_hms_date(fields.get("arrivaldate") or fields.get("arrival_date"))
    h_dep = parse_hms_date(fields.get("departuredate") or fields.get("departure_date"))
    if n == 0 and edates.get("arrival_date"):
      if h_arr and h_arr != edates["arrival_date"]:
        b.add(
          f"/bookings/{n}/fields/arrival_date",
          "no_gold",
          value=h_arr,
          basis="email_hms_conflict",
          source="heuristic",
          hms_key="arrivaldate",
        )
        b.notes.append(f"arrival email={edates['arrival_date']} hms={h_arr} conflict")
      elif h_arr:
        b.add(
          f"/bookings/{n}/fields/arrival_date",
          "expected",
          value=h_arr,
          basis="hms_and_or_email_arrival",
          source="hms_truth",
          hms_key="arrivaldate",
        )
      else:
        b.add(
          f"/bookings/{n}/fields/arrival_date",
          "expected",
          value=edates["arrival_date"],
          basis="email_explicit_arrival",
          source="email_explicit",
        )
    elif h_arr:
      b.add(
        f"/bookings/{n}/fields/arrival_date",
        "expected",
        value=h_arr,
        basis="hms_arrival",
        source="hms_truth",
        hms_key="arrivaldate",
      )

    if n == 0 and edates.get("departure_date"):
      if h_dep and h_dep != edates["departure_date"]:
        b.add(
          f"/bookings/{n}/fields/departure_date",
          "no_gold",
          value=h_dep,
          basis="email_hms_conflict",
          source="heuristic",
          hms_key="departuredate",
        )
        b.notes.append(f"departure email={edates['departure_date']} hms={h_dep} conflict")
      elif h_dep:
        b.add(
          f"/bookings/{n}/fields/departure_date",
          "expected",
          value=h_dep,
          basis="hms_and_or_email_departure",
          source="hms_truth",
          hms_key="departuredate",
        )
      else:
        b.add(
          f"/bookings/{n}/fields/departure_date",
          "expected",
          value=edates["departure_date"],
          basis="email_explicit_departure",
          source="email_explicit",
        )
    elif h_dep:
      b.add(
        f"/bookings/{n}/fields/departure_date",
        "expected",
        value=h_dep,
        basis="hms_departure",
        source="hms_truth",
        hms_key="departuredate",
      )

    # names
    first, last = names_from_hms(fields)
    name_conflict = n == 0 and names_conflict(e_first, e_last, first, last)
    if first:
      b.add(
        f"/bookings/{n}/fields/first_name",
        "no_gold" if name_conflict else "expected",
        value=first,
        basis="email_hms_conflict" if name_conflict else "hms_firstname",
        source="heuristic" if name_conflict else "hms_truth",
        hms_key="firstname",
      )
    if last:
      b.add(
        f"/bookings/{n}/fields/last_name",
        "no_gold" if name_conflict else "expected",
        value=last,
        basis="email_hms_conflict" if name_conflict else "hms_lastname",
        source="heuristic" if name_conflict else "hms_truth",
        hms_key="lastname",
      )
    if name_conflict:
      b.notes.append(f"name email={e_first} {e_last} hms={first} {last} conflict")

    # adults / children
    h_adults = parse_adults(fields.get("adults"))
    h_children = parse_children(fields.get("children"))
    if n == 0 and e_adults is not None:
      if h_adults is not None and h_adults != e_adults:
        b.add(
          f"/bookings/{n}/fields/adults",
          "no_gold",
          value=h_adults,
          basis="email_hms_conflict",
          source="heuristic",
          hms_key="adults",
        )
        b.notes.append(f"adults email={e_adults} hms={h_adults} conflict")
      elif h_adults is not None:
        b.add(
          f"/bookings/{n}/fields/adults",
          "expected",
          value=h_adults,
          basis="hms_and_or_email_adults",
          source="hms_truth",
          hms_key="adults",
        )
      else:
        b.add(
          f"/bookings/{n}/fields/adults",
          "expected",
          value=e_adults,
          basis="email_explicit_adults",
          source="email_explicit",
          hms_key="adults",
        )
    elif h_adults is not None:
      b.add(
        f"/bookings/{n}/fields/adults",
        "expected",
        value=h_adults,
        basis="hms_adults",
        source="hms_truth",
        hms_key="adults",
      )

    if n == 0 and e_children is not None:
      if h_children is not None and h_children != e_children:
        add_child_count(
          b,
          f"/bookings/{n}/fields/child_count",
          h_children,
          basis="email_hms_conflict",
          source="heuristic",
          hms_key="children",
          conflict=True,
        )
      elif h_children is not None:
        add_child_count(
          b,
          f"/bookings/{n}/fields/child_count",
          h_children,
          basis="hms_and_or_email_children",
          source="hms_truth",
          hms_key="children",
        )
      else:
        add_child_count(
          b,
          f"/bookings/{n}/fields/child_count",
          e_children,
          basis="email_explicit_children",
          source="email_explicit",
          hms_key="children",
        )
    elif h_children is not None:
      add_child_count(
        b,
        f"/bookings/{n}/fields/child_count",
        h_children,
        basis="hms_children",
        source="hms_truth",
        hms_key="children",
      )

    # room_type: email explicit wins; else HMS email-silent → diagnostic tier
    if n == 0 and eroom:
      h_room = room_value_from_hms(fields)
      h_code = h_room.get("code") if isinstance(h_room, dict) else None
      if h_code and h_code != eroom["code"]:
        # email asked X, HMS ended Y — score what email asked
        b.add(
          f"/bookings/{n}/fields/room_type",
          "expected",
          value=eroom,
          basis="email_explicit_room_over_hms",
          source="email_explicit",
          hms_key="roomtype",
        )
        b.notes.append(f"room email={eroom['code']} hms={h_code}")
      else:
        b.add(
          f"/bookings/{n}/fields/room_type",
          "expected",
          value=eroom if not h_room else (h_room if isinstance(h_room, dict) and h_room.get("code") else eroom),
          basis="email_and_hms_room",
          source="email_explicit",
          hms_key="roomtype",
        )
    else:
      h_room = room_value_from_hms(fields)
      if h_room:
        # Silent room: diagnostic (not scored). score.ts only skips expectation=diagnostic.
        b.add(
          f"/bookings/{n}/fields/room_type",
          "diagnostic",
          value=h_room,
          basis="hms_room_email_silent",
          source="heuristic",
          tier=TIER_DIAG,
          priority="P2",
          hms_key="roomtype",
        )

    # rate / agency / org / guarantee / track / source
    h_rate = rate_value_from_hms(fields)
    if h_rate:
      b.add(
        f"/bookings/{n}/fields/rate_plan",
        "expected",
        value=h_rate,
        basis="hms_rateplan",
        source="hms_truth",
        tier=TIER1,
        hms_key="rateplan",
      )
    # board P0 from HMS rate_plan; email meal conflict → no_gold
    hms_board = rate_plan_to_board(h_rate)
    if hms_board:
      e_board = email_board(blob)
      if e_board and e_board != hms_board:
        b.add(
          f"/bookings/{n}/fields/board",
          "no_gold",
          value=hms_board,
          basis="email_hms_board_conflict",
          source="heuristic",
        )
        b.notes.append(f"board email={e_board} hms={hms_board} conflict")
      else:
        b.add(
          f"/bookings/{n}/fields/board",
          "expected",
          value=hms_board,
          basis="email_and_hms_board" if e_board else "hms_rate_plan_board",
          source="email_explicit" if e_board else "hms_truth",
        )
    org, agency = org_agency_from_hms(fields)
    if org:
      b.add(
        f"/bookings/{n}/fields/organization_name",
        "expected",
        value=org,
        basis="hms_company",
        source="hms_truth",
        hms_key="company",
        derivable=party_derivable(card, org),
      )
    if agency:
      b.add(
        f"/bookings/{n}/fields/agency_name",
        "expected",
        value=agency,
        basis="hms_ta1",
        source="hms_truth",
        hms_key="ta1",
        derivable=party_derivable(card, agency),
      )
    if fields.get("guaranteetype"):
      b.add(
        f"/bookings/{n}/fields/guarantee_type",
        "expected",
        value=fields.get("guaranteetype"),
        basis="hms_guaranteetype",
        source="hms_truth",
        tier=TIER2,
        hms_key="guaranteetype",
      )
    if fields.get("track"):
      b.add(
        f"/bookings/{n}/fields/track",
        "expected",
        value=fields.get("track"),
        basis="hms_track",
        source="hms_truth",
        tier=TIER2,
        hms_key="track",
      )
    if fields.get("sourceofbusiness"):
      b.add(
        f"/bookings/{n}/fields/source_of_business",
        "expected",
        value=fields.get("sourceofbusiness"),
        basis="hms_sourceofbusiness",
        source="hms_truth",
        tier=TIER2,
        hms_key="sourceofbusiness",
      )

    # quantity only when email explicit (never default 1)
    if n == 0 and e_qty is not None and e_qty != 1:
      b.add(
        f"/bookings/{n}/fields/quantity",
        "expected",
        value=e_qty,
        basis="email_explicit_rooms",
        source="email_explicit",
        tier=TIER_PARITY,
      )
    elif n == 0 and e_qty == 1:
      # explicit "1 room" is ok; still record. "default 1" is not — only when regex hit.
      b.add(
        f"/bookings/{n}/fields/quantity",
        "expected",
        value=1,
        basis="email_explicit_one_room",
        source="email_explicit",
        tier=TIER_PARITY,
      )


def amend_ask_blob(card: dict) -> str:
  """Current amend ask: selected + pre-as_of thread, quotes stripped, no PDF letter text."""
  parts: list[str] = []
  for msg in iter_mail_msgs(card):
    parts.append(str(msg.get("subject") or ""))
    parts.append(strip_quoted_reply(str(msg.get("body_text") or msg.get("body") or "")))
  return "\n".join(parts)


def sanitize_amend_date_pair(b: GoldBuilder) -> None:
  """Never leave expected arrival >= departure; demote remaining impossibles to heuristic."""
  by_path = {r["path"]: r for r in b.rows}
  arr = by_path.get("/bookings/0/fields/arrival_date")
  dep = by_path.get("/bookings/0/fields/departure_date")
  if not arr or not dep:
    return
  if arr.get("expectation") != "expected" or dep.get("expectation") != "expected":
    return
  a, d = arr.get("value"), dep.get("value")
  if not (isinstance(a, str) and isinstance(d, str)):
    return
  if a < d:
    return
  # Impossible stay window — agent cannot be scored on these as hard expecteds.
  for row in (arr, dep):
    row["expectation"] = "no_gold"
    row["basis"] = "impossible_stay_window_arrival_ge_departure"
    row["source"] = "heuristic"
    if "value" in row:
      row["later_value"] = row.pop("value")
    b.stats["amend_impossible_dates_demoted"] += 1
  b.notes.append(f"impossible_dates arrival={a} departure={d}")


def build_amend(card: dict, wf: str, b: GoldBuilder) -> None:
  """Amend gold: expected after-values ONLY when email/pre-as_of thread asks to change them."""
  conf = card.get("real_confirmation")
  blob = amend_ask_blob(card)
  surname_only = is_surname_only_amend(blob)
  edates = {} if surname_only else email_dates(blob)
  eroom = None if surname_only else email_room(blob)
  e_adults, e_children = (None, None) if surname_only else email_adults_children(blob)
  fields, src, read_at = hms_truth_for(conf, card)
  h_first, h_last = names_from_hms(fields)

  bookings = multi_stay_bookings(card, conf)
  if len(bookings) > 1:
    b.notes.append(f"multi_stay_n={len(bookings)}")
    b.stats["amend_multi_stay_cases"] += 1
    b.stats["amend_multi_stay_bookings"] += len(bookings)

  for n, booking in enumerate(bookings):
    bconf = booking.get("confirmation") or conf
    if bconf:
      b.add(
        f"/bookings/{n}/reservation_id",
        "expected",
        value=bconf,
        basis="reviewed_confirmation_multi" if len(bookings) > 1 else "reviewed_confirmation",
        source="email_explicit",
        hms_key="confirmationnumber",
      )

  n = 0
  h_arr = parse_hms_date(fields.get("arrivaldate"))
  h_dep = parse_hms_date(fields.get("departuredate"))
  h_adults = parse_adults(fields.get("adults"))
  h_children = parse_children(fields.get("children"))
  h_room = room_value_from_hms(fields)
  h_rate = rate_value_from_hms(fields)

  if surname_only:
    b.notes.append("surname_only_amend")
    b.stats["amend_surname_only"] += 1
    # Dates are not requested — no_gold (subject allocation dates are not changes).
    for path, hval, hms_key in (
      ("/bookings/0/fields/arrival_date", h_arr, "arrivaldate"),
      ("/bookings/0/fields/departure_date", h_dep, "departuredate"),
    ):
      b.add(
        path,
        "no_gold",
        value=hval,
        basis="surname_amend_dates_not_requested",
        source="heuristic",
        hms_key=hms_key,
      )
    names = parse_surname_amend_names(blob)
    matched = match_surname_for_guest(names, h_first, h_last)
    if matched:
      first, last = matched
      b.add(
        "/bookings/0/fields/first_name",
        "expected",
        value=first,
        basis="email_surname_amend",
        source="email_explicit",
        hms_key="firstname",
      )
      b.add(
        "/bookings/0/fields/last_name",
        "expected",
        value=last,
        basis="email_surname_amend",
        source="email_explicit",
        hms_key="lastname",
      )
      b.stats["amend_email_expected"] += 2
    else:
      b.notes.append("surname_amend_no_name_match")
    return

  # Only email-requested change fields are expected.
  if edates.get("arrival_date"):
    b.add(
      f"/bookings/{n}/fields/arrival_date",
      "expected",
      value=edates["arrival_date"],
      basis="email_amend_arrival",
      source="email_explicit",
      hms_key="arrivaldate",
    )
    b.stats["amend_email_expected"] += 1
  elif h_arr:
    b.add(
      f"/bookings/{n}/fields/arrival_date",
      "not_expected",
      value=h_arr,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="arrivaldate",
    )
    b.stats["amend_hms_only_demoted"] += 1

  if edates.get("departure_date"):
    b.add(
      f"/bookings/{n}/fields/departure_date",
      "expected",
      value=edates["departure_date"],
      basis="email_amend_departure",
      source="email_explicit",
      hms_key="departuredate",
    )
    b.stats["amend_email_expected"] += 1
  elif h_dep:
    b.add(
      f"/bookings/{n}/fields/departure_date",
      "not_expected",
      value=h_dep,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="departuredate",
    )
    b.stats["amend_hms_only_demoted"] += 1

  if eroom:
    b.add(
      f"/bookings/{n}/fields/room_type",
      "expected",
      value=eroom,
      basis="email_amend_room",
      source="email_explicit",
      hms_key="roomtype",
    )
    b.stats["amend_email_expected"] += 1
  elif h_room:
    b.add(
      f"/bookings/{n}/fields/room_type",
      "not_expected",
      value=h_room,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="roomtype",
    )
    b.stats["amend_hms_only_demoted"] += 1

  if e_adults is not None:
    b.add(
      f"/bookings/{n}/fields/adults",
      "expected",
      value=e_adults,
      basis="email_amend_adults",
      source="email_explicit",
      hms_key="adults",
    )
    b.stats["amend_email_expected"] += 1
  elif h_adults is not None:
    b.add(
      f"/bookings/{n}/fields/adults",
      "not_expected",
      value=h_adults,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="adults",
    )
    b.stats["amend_hms_only_demoted"] += 1

  if e_children is not None:
    add_child_count(
      b,
      f"/bookings/{n}/fields/child_count",
      e_children,
      basis="email_amend_children",
      source="email_explicit",
      hms_key="children",
    )
    b.stats["amend_email_expected"] += 1
  elif h_children is not None:
    b.add(
      f"/bookings/{n}/fields/child_count",
      "not_expected",
      value=h_children,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="children",
    )
    b.stats["amend_hms_only_demoted"] += 1

  rc = email_rate_code(blob)
  if rc:
    b.add(
      f"/bookings/{n}/fields/rate_plan",
      "expected",
      value={"code": rc, "name": None},
      basis="email_amend_rate",
      source="email_explicit",
      hms_key="rateplan",
    )
    b.stats["amend_email_expected"] += 1
  elif h_rate:
    b.add(
      f"/bookings/{n}/fields/rate_plan",
      "not_expected",
      value=h_rate,
      basis="unchanged_field_not_in_email_amend",
      source="heuristic",
      hms_key="rateplan",
    )
    b.stats["amend_hms_only_demoted"] += 1

  sanitize_amend_date_pair(b)

  # Count booking-field expecteds (excl reservation_id) for amend reporting.
  for row in b.rows:
    if row.get("expectation") != "expected":
      continue
    path = row.get("path") or ""
    if path.endswith("reservation_id"):
      continue
    if "/fields/" in path or path.endswith("rate_plan"):
      b.stats["amend_booking_field_expected"] += 1


def build_cancel(card: dict, wf: str, b: GoldBuilder) -> None:
  cid = card.get("case_id") or ""
  conf = KNOWN_CANCEL_CONF.get(cid) or card.get("real_confirmation")
  if cid in KNOWN_CANCEL_CONF:
    b.notes.append(f"fixed_cancel_conf:{KNOWN_CANCEL_CONF[cid]}")
  blob = mail_blob(card)
  bookings = multi_stay_bookings(card, conf)
  # Known single-conf fix overrides a wrong primary, but keep other email-named stays.
  if cid in KNOWN_CANCEL_CONF:
    fix = KNOWN_CANCEL_CONF[cid]
    bookings = [{"confirmation": fix}] + [
      bkg for bkg in bookings if (bkg.get("confirmation") or "") not in {fix, conf}
    ]
  if len(bookings) > 1:
    b.notes.append(f"multi_stay_n={len(bookings)}")
    b.stats["cancel_multi_stay_cases"] += 1
    b.stats["cancel_multi_stay_bookings"] += len(bookings)
  for n, booking in enumerate(bookings):
    bconf = booking.get("confirmation") or conf
    if bconf:
      b.add(
        f"/bookings/{n}/reservation_id",
        "expected",
        value=bconf,
        basis="cancel_target_confirmation_multi" if len(bookings) > 1 else "cancel_target_confirmation",
        source="email_explicit",
        hms_key="confirmationnumber",
      )
  if CANCEL_REASON_RE.search(blob):
    # capture a short reason snippet when stated
    m = CANCEL_REASON_RE.search(blob)
    snip = blob[m.start(): m.start() + 80].split("\n")[0].strip()
    b.add(
      "/actions/0/details/cancellation_reason",
      "expected",
      value=snip[:120],
      basis="email_cancel_reason",
      source="email_explicit",
      priority="P1",
    )


def build_filing(card: dict, wf: str, b: GoldBuilder) -> None:
  conf = card.get("real_confirmation")
  att_id, doc_type, source, basis = pick_filing_attachment(card)
  b.doc_kind = filing_doc_kind(doc_type, basis, att_id)
  if basis == "no_guest_pdf_in_input" or not att_id:
    b.add(
      "/actions/0/details/attachment_id",
      "no_gold",
      basis="no_guest_pdf_in_input",
      source="heuristic",
    )
    b.add(
      "/actions/0/type",
      "no_gold",
      basis="no_guest_pdf_in_input",
      source="heuristic",
      tier=TIER_PARITY,
      priority="P1",
    )
    b.stats["filing_no_guest_pdf"] += 1
  else:
    b.add(
      "/actions/0/details/attachment_id",
      "expected",
      value=att_id,
      basis=basis,
      source=source if att_id and not str(att_id).startswith("pdf-") else "heuristic",
    )
    b.add(
      "/actions/0/type",
      "expected",
      value=doc_type,
      basis=f"filing_doc_type:{doc_type}",
      source=source,
      tier=TIER_PARITY,
      priority="P1",
    )
    b.stats["filing_guest_pdf"] += 1
  if conf:
    b.add(
      "/bookings/0/fields/confirmation_number",
      "expected",
      value=conf,
      basis="filing_target",
      source="hms_truth",
      hms_key="confirmationnumber",
    )
    b.add(
      "/bookings/0/reservation_id",
      "not_expected",
      value=conf,
      basis="filing_uses_confirmation_number_field",
      source="hms_truth",
    )


def quote_adults_per_room(e_adults: int, e_qty: int | None) -> int | None:
  """Quote rooms/N/adults is per-room. None when only a group total is knowable."""
  if e_qty is None or e_qty <= 0:
    return None
  if e_adults % e_qty != 0:
    return None
  return e_adults // e_qty


def build_quote(card: dict, wf: str, b: GoldBuilder) -> None:
  blob = selected_blob(card) or mail_blob(card)
  edates = email_dates(blob)
  e_adults, _e_children = email_adults_children(blob)
  e_qty = email_quantity(blob)
  board = email_board(blob)
  # rate_code gold dropped (v5.1) — catalogue code rarely explicit in email.
  if edates.get("arrival_date"):
    b.add(
      "/actions/0/details/groups/0/arrival_date",
      "expected",
      value=edates["arrival_date"],
      basis="email_explicit_arrival",
      source="email_explicit",
    )
  if edates.get("departure_date"):
    b.add(
      "/actions/0/details/groups/0/departure_date",
      "expected",
      value=edates["departure_date"],
      basis="email_explicit_departure",
      source="email_explicit",
    )
  if e_adults is not None:
    per_room = quote_adults_per_room(e_adults, e_qty)
    if per_room is not None:
      b.add(
        "/actions/0/details/groups/0/rooms/0/adults",
        "expected",
        value=per_room,
        basis="email_explicit_adults_per_room",
        source="email_explicit",
      )
    else:
      b.add(
        "/actions/0/details/groups/0/rooms/0/adults",
        "no_gold",
        value=e_adults,
        basis="quote_adults_not_per_room",
        source="heuristic",
      )
  if e_qty is not None:
    b.add(
      "/actions/0/details/groups/0/rooms/0/quantity",
      "expected",
      value=e_qty,
      basis="email_explicit_rooms",
      source="email_explicit",
    )
  if board:
    b.add(
      "/actions/0/details/board",
      "expected",
      value=board,
      basis="email_explicit_board",
      source="email_explicit",
    )


def build_triage(card: dict, wf: str, b: GoldBuilder) -> None:
  # Routing kept; field gold mostly unknowable — emit no expected booking fields.
  conf = card.get("real_confirmation")
  if conf:
    b.add(
      "/actions/0/details/lookup/reservation_id",
      "not_expected",
      value=conf,
      basis="triage_weak_gold",
      source="heuristic",
    )


def apply_known_case_fixes(card: dict, wf: str, b: GoldBuilder) -> None:
  cid = card.get("case_id") or ""
  # hf-2275: HMS arrival 2026-11-02 conflicts with email/PDF 11-01 → heuristic
  if cid.startswith("hf-2275"):
    fields, _, _ = hms_truth_for(card.get("real_confirmation"), card)
    h_arr = parse_hms_date(fields.get("arrivaldate"))
    if h_arr:
      # drop prior arrival so conflict tag wins (and recount conflict if re-added)
      prior = [r for r in b.rows if r.get("path") == "/bookings/0/fields/arrival_date"]
      for r in prior:
        if r.get("basis") == "email_hms_conflict":
          b.stats["create_email_hms_conflict"] -= 1
          b.stats["create_email_hms_conflict:arrival_date"] -= 1
      b.rows = [r for r in b.rows if r.get("path") != "/bookings/0/fields/arrival_date"]
      b.seen.discard("/bookings/0/fields/arrival_date")
      b.add(
        "/bookings/0/fields/arrival_date",
        "no_gold",
        value=h_arr,
        basis="email_hms_conflict",
        source="heuristic",
        hms_key="arrivaldate",
      )
      b.notes.append(f"hf-2275 arrival→{h_arr} email_hms_conflict")
  # p4-amend-eba5: email "check in the 2nd … out the 4th"
  if cid.startswith("p4-amend-eba5"):
    b.rows = [
      r for r in b.rows
      if r.get("path") not in (
        "/bookings/0/fields/departure_date",
        "/bookings/0/fields/arrival_date",
        "/bookings/0/fields/rate_plan",
      )
    ]
    b.seen.discard("/bookings/0/fields/departure_date")
    b.seen.discard("/bookings/0/fields/arrival_date")
    b.seen.discard("/bookings/0/fields/rate_plan")
    b.add(
      "/bookings/0/fields/arrival_date",
      "expected",
      value="2026-09-02",
      basis="audit_b_fix_email_arrival",
      source="email_explicit",
      hms_key="arrivaldate",
    )
    b.add(
      "/bookings/0/fields/departure_date",
      "expected",
      value="2026-09-04",
      basis="audit_b_fix_email_departure",
      source="email_explicit",
      hms_key="departuredate",
    )
    b.notes.append("p4-amend-eba5 arrival→2026-09-02 departure→2026-09-04")
  # hv2r-068f: email asks single standard room
  if cid.startswith("hv2r-068f"):
    b.rows = [r for r in b.rows if r.get("path") != "/bookings/0/fields/room_type"]
    b.seen.discard("/bookings/0/fields/room_type")
    b.add(
      "/bookings/0/fields/room_type",
      "expected",
      value={"code": "STQN", "name": "Standard Queen"},
      basis="audit_b_fix_email_room",
      source="email_explicit",
      hms_key="roomtype",
    )
    b.notes.append("hv2r-068f room→STQN from email")


def build_case(card: dict, routing: dict | None) -> dict:
  old_wf = card.get("workflow")
  wf = (routing or {}).get("workflow") or old_wf
  b = GoldBuilder()
  if wf == "create":
    build_create(card, wf, b)
  elif wf == "amend":
    build_amend(card, wf, b)
  elif wf == "cancel":
    build_cancel(card, wf, b)
  elif wf == "filing":
    build_filing(card, wf, b)
  elif wf == "quote":
    build_quote(card, wf, b)
  elif wf == "triage":
    build_triage(card, wf, b)
  else:
    b.notes.append(f"unknown_workflow:{wf}")

  apply_known_case_fixes(card, wf, b)

  out: dict[str, Any] = {
    "workflow": wf,
    "old_workflow": (routing or {}).get("old_workflow") or old_wf,
    "changed": bool((routing or {}).get("changed")) if routing else (wf != old_wf),
    "skip": bool((routing or {}).get("skip")),
    "evidence_quote": (routing or {}).get("evidence_quote"),
    "gold": b.rows,
    "n_gold": len(b.rows),
    "notes": b.notes,
    "stats": dict(b.stats),
    # keep empty patches key for shape compatibility with gold-v4 overlays
    "gold_patches": [],
    "n_patches": 0,
  }
  if wf == "filing":
    out["doc_kind"] = b.doc_kind or "none"
  return out


def count_amend_booking_expected(overlay: dict) -> dict[str, int]:
  """Booking-field expecteds on amend cases (excl reservation_id)."""
  by_leaf: Counter[str] = Counter()
  total = 0
  cases = 0
  for row in overlay.values():
    if row.get("workflow") != "amend":
      continue
    cases += 1
    for g in row.get("gold") or []:
      if g.get("expectation") != "expected":
        continue
      path = g.get("path") or ""
      if path.endswith("reservation_id"):
        continue
      if "/fields/" in path:
        by_leaf[leaf(path)] += 1
        total += 1
  return {"amend_cases": cases, "booking_field_expected": total, "by_leaf": dict(by_leaf)}


def effective_v4_gold(card: dict, overlay: dict | None) -> list[dict]:
  gold = [dict(g) for g in (card.get("gold") or [])]
  if not overlay:
    return gold
  patches = {p["path"]: p for p in overlay.get("gold_patches") or []}
  out = []
  for g in gold:
    p = patches.get(g.get("path"))
    if not p:
      out.append(g)
      continue
    ng = dict(g)
    ng["expectation"] = p.get("expectation", g.get("expectation"))
    if p.get("basis"):
      ng["basis"] = p["basis"]
    out.append(ng)
  return out


def meta_counts(overlay: dict) -> dict:
  by = Counter()
  for row in overlay.values():
    for g in row.get("gold") or []:
      path = leaf(g.get("path") or "")
      src = g.get("source") or "unknown"
      exp = g.get("expectation") or "unknown"
      by[(path, src, exp)] += 1
  return {
    f"{path}|{src}|{exp}": n
    for (path, src, exp), n in sorted(by.items(), key=lambda x: (-x[1], x[0]))
  }


def sha256_file(path: Path) -> str:
  h = hashlib.sha256()
  h.update(path.read_bytes())
  return h.hexdigest()


def build_set(name: str) -> dict:
  cases_dir = DATA / "cases" / name
  audit_dir = DATA / "gold-audit" / name
  if not cases_dir.exists():
    raise SystemExit(f"missing cases dir {cases_dir}")
  audit_dir.mkdir(parents=True, exist_ok=True)

  v4_path = audit_dir / "gold-v4.json"
  v4 = json.loads(v4_path.read_text()) if v4_path.exists() else {}
  prev_path = audit_dir / "gold-v5.json"
  prev_overlay = json.loads(prev_path.read_text()) if prev_path.exists() else {}
  amend_before = count_amend_booking_expected(prev_overlay)

  # holdout-v3: shared case ids must match holdout-v2 gold-v5 byte-for-byte
  # (audited routing + field gold). Rebuild holdout-v2 first in the same run.
  hv2_overlay: dict | None = None
  if name == "holdout-v3":
    hv2_path = DATA / "gold-audit" / "holdout-v2" / "gold-v5.json"
    if not hv2_path.exists():
      raise SystemExit(f"holdout-v3 requires {hv2_path} — build holdout-v2 first")
    hv2_overlay = json.loads(hv2_path.read_text())

  out: dict[str, dict] = {}
  wf_counts: Counter[str] = Counter()
  note_counts: Counter[str] = Counter()
  rule_stats: Counter[str] = Counter()
  copied_from_hv2 = 0

  for case_dir in sorted(p for p in cases_dir.iterdir() if p.is_dir()):
    card_path = case_dir / "case.json"
    if not card_path.exists():
      continue
    card = json.loads(card_path.read_text())
    cid = card.get("case_id") or case_dir.name
    card["case_id"] = cid
    if hv2_overlay and cid in hv2_overlay:
      # Exact copy — shared ids must match holdout-v2 gold-v5 byte-for-byte.
      row = json.loads(json.dumps(hv2_overlay[cid]))
      out[cid] = row
      copied_from_hv2 += 1
      wf_counts[row.get("workflow") or "unknown"] += 1
      for n in row.get("notes") or []:
        note_counts[str(n).split(":")[0].split("→")[0][:40]] += 1
      continue
    routing = v4.get(cid)
    row = build_case(card, routing)
    out[cid] = row
    wf_counts[row["workflow"]] += 1
    for k, v in (row.get("stats") or {}).items():
      rule_stats[k] += int(v)
    # drop per-case stats from frozen overlay (keep meta rollup)
    row.pop("stats", None)
    for n in row.get("notes") or []:
      note_counts[n.split(":")[0].split("→")[0][:40]] += 1

  amend_after = count_amend_booking_expected(out)
  out_path = audit_dir / "gold-v5.json"
  out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
  digest = sha256_file(out_path)
  meta = {
    "set": name,
    "built_at": datetime.now(timezone.utc).isoformat(),
    "gold_file": str(out_path),
    "sha256": digest,
    "n_cases": len(out),
    "workflows": dict(wf_counts),
    "counts_path_source_expectation": meta_counts(out),
    "notes_top": dict(note_counts.most_common(30)),
    "rule_stats": {
      "create_email_hms_conflict_rows": rule_stats.get("create_email_hms_conflict", 0),
      "create_email_hms_conflict_by_leaf": {
        k.split(":", 1)[1]: v
        for k, v in rule_stats.items()
        if k.startswith("create_email_hms_conflict:")
      },
      "amend_booking_field_expected_before": amend_before,
      "amend_booking_field_expected_after": amend_after,
      "amend_email_expected_rows": rule_stats.get("amend_email_expected", 0),
      "amend_hms_only_demoted_rows": rule_stats.get("amend_hms_only_demoted", 0),
      "amend_surname_only_cases": rule_stats.get("amend_surname_only", 0),
      "amend_impossible_dates_demoted": rule_stats.get("amend_impossible_dates_demoted", 0),
      "amend_multi_stay_cases": rule_stats.get("amend_multi_stay_cases", 0),
      "amend_multi_stay_bookings": rule_stats.get("amend_multi_stay_bookings", 0),
      "cancel_multi_stay_cases": rule_stats.get("cancel_multi_stay_cases", 0),
      "filing_guest_pdf": rule_stats.get("filing_guest_pdf", 0),
      "filing_no_guest_pdf": rule_stats.get("filing_no_guest_pdf", 0),
      "holdout_v3_copied_from_holdout_v2": copied_from_hv2,
    },
    "truth_sources": {
      "reads_all": str(READS / "reads-all.jsonl"),
      "stay360": str(STAY360),
      "routing": str(v4_path) if v4_path.exists() else None,
      "holdout_v2_gold": str(DATA / "gold-audit" / "holdout-v2" / "gold-v5.json") if name == "holdout-v3" else None,
    },
    "blind": True,
    "version": "gold-v5",
    "rules": [
      "create_email_hms_conflict_dates_names_adults",
      "amend_email_only_expected_after_values",
      "amend_impossible_stay_window_no_gold",
      "amend_surname_only_dates_no_gold",
      "multi_stay_reservation_ids_from_email",
      "filing_hotel_pdf_never_attachment_gold",
      "holdout_v3_copy_shared_ids_from_holdout_v2",
    ],
  }
  meta_path = audit_dir / "gold-v5.meta.json"
  meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
  print(json.dumps({
    "set": name,
    "n": len(out),
    "sha256": digest,
    "workflows": dict(wf_counts),
    "rule_stats": meta["rule_stats"],
  }, indent=2))
  return {"overlay": out, "meta": meta, "v4": v4}


def sanity(name: str, built: dict) -> dict:
  cases_dir = DATA / "cases" / name
  overlay = built["overlay"]
  v4 = built["v4"]
  # compare expected-value paths vs effective v4
  diffs: list[dict] = []
  src_v5 = Counter()
  src_v4_proxy = Counter()  # v4 has no source; use basis buckets
  for cid, row in overlay.items():
    card = json.loads((cases_dir / cid / "case.json").read_text())
    v4_gold = effective_v4_gold(card, v4.get(cid))
    v4_by = {g["path"]: g for g in v4_gold}
    for g in row.get("gold") or []:
      src_v5[g.get("source") or "unknown"] += 1
      vg = v4_by.get(g["path"])
      if not vg:
        diffs.append({
          "case_id": cid,
          "path": g["path"],
          "kind": "added",
          "v5": {k: g.get(k) for k in ("expectation", "value", "source", "basis")},
          "evidence": g.get("basis"),
        })
        continue
      same_exp = vg.get("expectation") == g.get("expectation")
      same_val = True
      if g.get("expectation") == "expected":
        same_val = vg.get("value") == g.get("value")
      if not same_exp or not same_val:
        diffs.append({
          "case_id": cid,
          "path": g["path"],
          "kind": "changed",
          "v4": {k: vg.get(k) for k in ("expectation", "value", "basis")},
          "v5": {k: g.get(k) for k in ("expectation", "value", "source", "basis")},
          "evidence": g.get("basis"),
        })
    for g in v4_gold:
      # rough v4 provenance proxy
      basis = str(g.get("basis") or "")
      if re.search(r"hms_|reviewed_|filing_target|first_pdf", basis, re.I):
        src_v4_proxy["hms_ish"] += 1
      elif re.search(r"selected_email|email|bench_mail", basis, re.I):
        src_v4_proxy["email_ish"] += 1
      else:
        src_v4_proxy["other"] += 1

  rng = random.Random(20261119)
  sample = diffs[:]
  rng.shuffle(sample)
  sample = sample[:15]

  # known fixes check
  known = {}
  for pref, check in [
    ("hf-2275", lambda g: any(
      x.get("path") == "/bookings/0/fields/arrival_date"
      and (x.get("value") or x.get("later_value")) == "2026-11-02"
      and x.get("basis") == "email_hms_conflict"
      for x in g
    )),
    ("p4-amend-eba5", lambda g: any(x.get("path") == "/bookings/0/fields/departure_date" and x.get("value") == "2026-09-04" for x in g)),
    ("hf-8b09", lambda g: any(x.get("path") == "/bookings/0/reservation_id" and x.get("value") == "48122614-1" for x in g)),
    ("hv2r-068f", lambda g: any(x.get("path") == "/bookings/0/fields/room_type" and (x.get("value") or {}).get("code") == "STQN" for x in g)),
  ]:
    hits = [cid for cid in overlay if cid.startswith(pref)]
    known[pref] = {
      "cases": hits,
      "ok": all(check(overlay[cid].get("gold") or []) for cid in hits) if hits else False,
    }

  report = {
    "set": name,
    "n_diffs": len(diffs),
    "v5_source_counts": dict(src_v5),
    "v4_basis_proxy_counts": dict(src_v4_proxy),
    "path_source_expectation_top": dict(
      list(Counter(
        (leaf(g["path"]), g.get("source"), g.get("expectation"))
        for row in overlay.values()
        for g in row.get("gold") or []
      ).most_common(40))
    ),
    "random_15_diffs": sample,
    "known_fixes": known,
  }
  out_path = DATA / "gold-audit" / name / "gold-v5.sanity.json"
  # stringify tuple keys
  report["path_source_expectation_top"] = {
    f"{a}|{b}|{c}": n for (a, b, c), n in
    Counter(
      (leaf(g["path"]), g.get("source"), g.get("expectation"))
      for row in overlay.values()
      for g in row.get("gold") or []
    ).most_common(40)
  }
  out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str) + "\n")
  print(json.dumps({
    "sanity": name,
    "n_diffs": report["n_diffs"],
    "v5_sources": report["v5_source_counts"],
    "known_fixes": report["known_fixes"],
  }, indent=2))
  return report


def main() -> None:
  ap = argparse.ArgumentParser()
  ap.add_argument("--set", action="append", dest="sets", required=True)
  ap.add_argument("--sanity", action="store_true")
  args = ap.parse_args()
  # warm indexes
  print(f"reads indexed: {len(load_reads_index())}", file=sys.stderr)
  print(f"stay360 indexed: {len(load_stay360_index())}", file=sys.stderr)
  for name in args.sets:
    built = build_set(name)
    if args.sanity:
      sanity(name, built)


if __name__ == "__main__":
  main()
