#!/usr/bin/env python3
"""Build FRESH 100-case holdout from 29 Oct→19 Nov 2026 hotel mail.

NEW file only. Imports rebuild_samples helpers; does not edit rebuild_all/run/score.
Output: ~/.local/share/zero/bench/replay-bench-20261119/cases/holdout-fresh/
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from pathlib import Path
from typing import Any

# Import card builder helpers (reference only — do not mutate that module's files).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rebuild_samples import (  # noqa: E402
    build_card,
    load_jsonl,
    render_md,
    strip_images,
)

FRESH = Path("/home/orca/.local/share/zero/research/hms-fresh-reads-20261119")
DATA = Path("/home/orca/.local/share/zero/bench/replay-bench-20261119")
OUT = DATA / "cases" / "holdout-fresh"
CATALOG = DATA / "catalog" / "catalog.json"

CONF_RE = re.compile(r"\b(\d{6,10}-1)\b")
CONF_FILE_RE = re.compile(r"(\d{6,10}-1)")
OTA_RE = re.compile(
    r"booking\.com|expedia|profitroom|synxis|gds:|channel.?manager|agoda|hotels\.com|"
    r"ostrovok|hotelbeds|siteminder|travelport|amadeus|sabre|redx|derbysoft|siteconnect|"
    r"failed to integrate|daily report \[channel|noreply@|no-reply@|donotreply|"
    r"mailer-daemon|automated message|channel manager",
    re.I,
)
NAVA_GUEST_RE = re.compile(r"labtest|example\.invalid", re.I)
QUOTE_RE = re.compile(
    r"\bquot(e|ation)\b|availability|rate request|please advise rates|rack rate|"
    r"rate enquiry|pricing request|can you quote",
    re.I,
)
CANCEL_RE = re.compile(r"\bcancel(?:l?ation|l?ed|ling)?\b", re.I)
AMEND_RE = re.compile(
    r"\bamend|modif(?:y|ication)|early depart|extend(?:\s+stay)?|shorten|"
    r"change (?:of )?dates?|name change|room change|late departure|arrive early",
    re.I,
)
FILING_RE = re.compile(
    r"voucher|proof of payment|\bPOP\b|payment advice|remittance|proforma|"
    r"payment confirmation|bank (?:deposit|transfer)",
    re.I,
)
CREATE_RE = re.compile(
    r"\bbook(?:ing)?\b|\breserv(?:e|ation)\b|kindly (?:book|reserve)|please (?:book|reserve)|"
    r"new booking|room for|accommodation for",
    re.I,
)
TRIAGE_HINT_RE = re.compile(
    r"no-show|discrepancy|complaint|invoice|statement|roster|manifest|group list|"
    r"who is arriving|unexpected stay|housekeeping|maintenance|feedback",
    re.I,
)

# Target mix — Amend/Cancel may use 6-week window (from 8 Oct). No weak pad.
NEED = {"create": 23, "amend": 15, "cancel": 15, "filing": 12, "quote": 20, "triage": 15}  # sums to 100
AMEND_CANCEL_START = "2026-10-08T00:00:00.000Z"  # 6-week window
FRESH_START = "2026-10-29T00:00:00.000Z"  # create/quote/filing/triage stay in 3-week fresh window

AZURE_BASE = (os.environ.get("AZURE_OPENAI_BASE_URL") or "https://nava.openai.azure.com/openai/v1").rstrip("/")
AZURE_KEY = os.environ.get("AZURE_FOUNDRY_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY") or ""
LUNA_DEPLOY = os.environ.get("NAVA_AGENT_AZURE_DEPLOYMENT") or "gpt-6-luna"


def norm_msgid(raw: Any) -> str | None:
    if not raw:
        return None
    s = str(raw).strip().strip("<>").strip().lower()
    return s or None


def walk_collect_msgids(obj: Any, found: set[str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in (
                "message_id_header",
                "internetMessageId",
                "internet_message_id",
                "rfc_message_id",
                "Message-ID",
                "messageId",
            ) or str(k).endswith("message_id_header"):
                mid = norm_msgid(v)
                if mid:
                    found.add(mid)
            if k in ("message_id", "id") and isinstance(v, str) and "@" in v:
                mid = norm_msgid(v)
                if mid:
                    found.add(mid)
            walk_collect_msgids(v, found)
    elif isinstance(obj, list):
        for item in obj:
            walk_collect_msgids(item, found)


def load_dev_blocklist() -> dict[str, Any]:
    """Block Message-IDs + confs already in the 200 v1/dev cases, plus Halloween∩fresh Message-IDs."""
    msgids: set[str] = set()
    confs: set[str] = set()
    v1 = DATA / "cases" / "v1"
    if v1.exists():
        for d in v1.iterdir():
            if not d.is_dir() or not (d / "case.json").exists():
                continue
            card = json.loads((d / "case.json").read_text())
            if card.get("real_confirmation"):
                confs.add(str(card["real_confirmation"]))
            walk_collect_msgids(card, msgids)
    for p in (DATA / "gold").glob("*.jsonl"):
        for line in open(p):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                continue
            if row.get("real_confirmation"):
                confs.add(str(row["real_confirmation"]))
            src = row.get("source") or {}
            if isinstance(src, dict):
                for msg in src.get("messages_as_of_cutoff") or []:
                    if not isinstance(msg, dict):
                        continue
                    mid = norm_msgid(msg.get("message_id_header") or msg.get("message_id"))
                    if mid:
                        msgids.add(mid)

    hall_msgids: set[str] = set()
    hall = DATA / "inbound" / "halloween"
    if hall.exists():
        for p in hall.rglob("*.jsonl"):
            for line in open(p):
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                walk_collect_msgids(obj, hall_msgids)

    fresh_msgids: set[str] = set()
    for row in load_jsonl(FRESH / "pilot-mail.jsonl"):
        mid = norm_msgid(row.get("message_id_header"))
        if mid:
            fresh_msgids.add(mid)
    for row in load_jsonl(FRESH / "prod-mail.jsonl"):
        payload = row.get("payload") or {}
        for key in ("internet_message_id", "message_id_header", "internetMessageId"):
            mid = norm_msgid(payload.get(key) or row.get(key))
            if mid:
                fresh_msgids.add(mid)

    overlap = hall_msgids & fresh_msgids
    blocked_msgids = msgids | overlap
    return {
        "blocked_confirmations": confs,
        "blocked_message_ids": blocked_msgids,
        "halloween_fresh_msgid_overlap_n": len(overlap),
        "halloween_fresh_msgid_overlap": sorted(overlap),
        "v1_msgid_n": len(msgids),
        "v1_conf_n": len(confs),
    }


def visible_confs_before_as_of(card: dict) -> set[str]:
    """Confirmation numbers visible in shown mail/PDF text at or before as_of — never invent from gold."""
    as_of = card.get("as_of") or ""
    found: set[str] = set()
    msgs = [card.get("selected_email") or {}] + list(card.get("context_before") or [])
    for msg in msgs:
        ts = msg.get("timestamp") or msg.get("received_at") or ""
        if ts and as_of and ts > as_of:
            continue
        blob = " ".join(
            str(msg.get(k) or "")
            for k in ("subject", "body_text", "body")
        )
        found.update(CONF_RE.findall(blob))
        for pdf in msg.get("pdf_attachments_text") or []:
            pdf_ts = pdf.get("sent_at") or ""
            if pdf_ts and as_of and pdf_ts > as_of:
                continue
            text = str(pdf.get("text") or "") + " " + str(pdf.get("filename") or "")
            found.update(CONF_RE.findall(text))
            found.update(CONF_FILE_RE.findall(str(pdf.get("filename") or "")))
    return found


def strip_gold_conf_inputs(card: dict) -> dict:
    """Rule (b): cross-thread rank2 + earlier PDFs only from confs visible in shown text."""
    visible = visible_confs_before_as_of(card)
    gold = card.get("real_confirmation")
    # Filter PDFs attached to shown messages: drop ones whose conf is only the gold key and not visible.
    for msg in [card.get("selected_email") or {}] + list(card.get("context_before") or []):
        kept = []
        for pdf in msg.get("pdf_attachments_text") or []:
            name = str(pdf.get("filename") or "")
            text = str(pdf.get("text") or "")
            pdf_confs = set(CONF_FILE_RE.findall(name)) | set(CONF_RE.findall(text + " " + name))
            if not pdf_confs:
                # unstructured attachment text — keep (not fetched via gold conf key)
                kept.append(pdf)
                continue
            if pdf_confs & visible:
                kept.append(pdf)
                continue
            # PDF only for gold conf that never appears in shown text → drop
            if gold and pdf_confs <= {gold} and gold not in visible:
                continue
            if pdf_confs & visible or not gold:
                kept.append(pdf)
        msg["pdf_attachments_text"] = kept

    xt_kept = []
    for link in card.get("cross_thread_context") or []:
        matched = link.get("matched_confirmation")
        rank = link.get("rank")
        if rank == 2:
            if matched and matched not in visible:
                continue
            if matched is None and gold and gold not in visible:
                # rank2 without matched conf but fetched via gold — drop
                continue
        xt_kept.append(link)
    card["cross_thread_context"] = xt_kept
    card["input_confs_visible"] = sorted(visible)
    card["card_fixes"] = list(card.get("card_fixes") or []) + [
        "no_gold_conf_input_fetch",
        "cross_thread_rank2_and_pdfs_from_visible_confs_only",
    ]
    return card


def card_hits_dev_blocklist(card: dict, blocked_msgids: set[str], blocked_confs: set[str]) -> str | None:
    """Return reason if case overlaps 200-dev Message-ID or confirmation."""
    conf = card.get("real_confirmation")
    if conf and conf in blocked_confs:
        return f"dev_conf:{conf}"
    msgs = [card.get("selected_email") or {}] + list(card.get("context_before") or [])
    for link in card.get("cross_thread_context") or []:
        msgs.extend(link.get("messages") or [])
    for msg in msgs:
        mid = norm_msgid(msg.get("message_id_header") or msg.get("message_id"))
        if mid and mid in blocked_msgids:
            return f"dev_msgid:{mid}"
    return None


def gold_row_hits_dev_blocklist(
    row: dict,
    blocked_msgids: set[str],
    blocked_confs: set[str],
    mail_by_id: dict,
    threads: dict[str, list[dict]],
) -> str | None:
    conf = row.get("real_confirmation")
    if conf and conf in blocked_confs:
        return f"dev_conf:{conf}"
    src = row.get("source") or {}
    for msg in src.get("messages_as_of_cutoff") or []:
        mid = norm_msgid(msg.get("message_id_header") or msg.get("message_id"))
        if mid and mid in blocked_msgids:
            return f"dev_msgid:{mid}"
        raw = mail_by_id.get(msg.get("source_row_id") or msg.get("message_id") or "")
        if raw:
            mid = norm_msgid(raw.get("message_id_header"))
            if mid and mid in blocked_msgids:
                return f"dev_msgid:{mid}"
    sel_id = src.get("selected_message_id")
    sel = mail_by_id.get(sel_id or "")
    tid = (sel or {}).get("thread_id") or src.get("thread_id")
    for msg in threads.get(tid or "") or []:
        mid = norm_msgid(msg.get("message_id_header"))
        if mid and mid in blocked_msgids:
            return f"dev_msgid:{mid}"
    return None


def parse_pdf_text(text: str) -> dict[str, Any]:
    """Extract confirmation-letter fields from pdftotext."""
    fields: dict[str, Any] = {}
    if not text:
        return fields

    def grab(label: str) -> str | None:
        m = re.search(
            rf"{label}\s*:\s*(.+?)(?:\s{{2,}}\w[\w\s/()]*:|$)",
            text,
            re.I | re.M,
        )
        if not m:
            return None
        return re.sub(r"\s+", " ", m.group(1)).strip() or None

    guest = grab("Guest Name")
    conf = grab("Confirmation Number")
    arrival = grab("Arrival Date")
    departure = grab("Departure Date")
    room = grab("Accommodation Type")
    occ = grab("Number of Person\\(s\\)") or grab("Number of Persons")
    adr = grab("Average Daily rate") or grab("Average Daily Rate")
    rate_inc = grab("Rate Includes")
    total = grab("Total Accommodation for stay")

    adults = children = None
    if occ:
        ma = re.search(r"(\d+)\s*Adult", occ, re.I)
        mc = re.search(r"(\d+)\s*Child", occ, re.I)
        adults = int(ma.group(1)) if ma else None
        children = int(mc.group(1)) if mc else 0

    def dd_mm_yyyy(raw: str | None) -> str | None:
        if not raw:
            return None
        m = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", raw.strip())
        if m:
            return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        return raw.strip()

    # Agency/company often appears above "Dear Partner"
    agency = None
    m = re.search(r"\n\s*\n([A-Z][^\n]{2,60})\n(?:\d|[A-Za-z]).{0,80}\n(?:VAT number|Dear Partner)", text)
    if m:
        agency = m.group(1).strip()

    fields = {
        "guestName": [guest] if guest else [],
        "confirmationNumber": [conf] if conf else [],
        "arrivalDate": [arrival] if arrival else [],
        "departureDate": [departure] if departure else [],
        "accommodationType": [room] if room else [],
        "occupancy": [occ] if occ else [],
        "averageDailyRate": [adr] if adr else [],
        "rateIncludes": [rate_inc] if rate_inc else [],
        "totalAccommodation": [total] if total else [],
        "agency": [agency] if agency else [],
        "adults": adults,
        "children": children,
        # normalized aliases used by rebuild_samples.normalize_pdf_stay
        "guest_name": guest,
        "arrival_date": dd_mm_yyyy(arrival),
        "departure_date": dd_mm_yyyy(departure),
        "room_type_text": room,
        "occupancy_text": occ,
        "rate_includes_text": rate_inc,
        "average_daily_rate_text": adr,
        "total_accommodation_text": total,
        "agency_text": agency,
    }
    return fields


def flat_hms_fields(read: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for scope in ("shallow", "record_view"):
        node = read.get(scope) or {}
        details = node.get("details") or {}
        for card in details.get("cards") or []:
            for f in card.get("fields") or []:
                name = f.get("name")
                if name and f.get("value") not in (None, ""):
                    out[str(name)] = f.get("value")
        for f in details.get("fields") or []:
            name = f.get("name")
            if name and f.get("value") not in (None, ""):
                out[str(name)] = f.get("value")
    if read.get("status") and "status" not in out:
        out["status"] = read["status"]
    return out


def read_is_usable(read: dict | None) -> bool:
    """Empty stub rows in reads-all do not count as live HMS gold."""
    if not read:
        return False
    fields = flat_hms_fields(read)
    # Need core stay fields, not just a status string.
    return any(k in fields for k in ("arrivaldate", "departuredate", "guestfullname", "roomtype"))


def pdf_fields_as_hms(fields: dict) -> dict[str, Any]:
    """Map confirmation-PDF fields into later_hms key space when HMS stub empty."""
    out: dict[str, Any] = {}
    if fields.get("guest_name"):
        out["guestfullname"] = fields["guest_name"]
    if fields.get("arrival_date"):
        out["arrivaldate"] = fields["arrival_date"]
    if fields.get("departure_date"):
        out["departuredate"] = fields["departure_date"]
    if fields.get("adults") is not None:
        out["adults"] = f"{fields['adults']} Adult{fields.get('children') or 0} Children"
    if fields.get("room_type_text"):
        out["room_type_text"] = fields["room_type_text"]
    if fields.get("agency_text"):
        out["ta1"] = fields["agency_text"]
    if fields.get("rate_includes_text"):
        out["mealplan"] = fields["rate_includes_text"]
    return out


def is_nava_touched(read: dict) -> bool:
    fields = flat_hms_fields(read)
    for key in ("createdby", "updatedby", "createdBy", "updatedBy"):
        if "NAVA" in str(fields.get(key) or "").upper():
            return True
    guest = str(fields.get("guestfullname") or "")
    return bool(NAVA_GUEST_RE.search(guest))


def is_ota_blob(*parts: str) -> bool:
    return bool(OTA_RE.search(" ".join(p or "" for p in parts)))


def load_code_maps() -> dict:
    catalog = json.loads(CATALOG.read_text())
    code_maps: dict[str, dict] = {}
    for kind, key in [
        ("room_type", "roomTypes"),
        ("rate_plan", "ratePlans"),
        ("source_of_business", "sourceBusiness"),
        ("track", "trackSubsegment"),
        ("guarantee_type", "guaranteeTypes"),
        ("agency", "agencies"),
        ("organization", "organizations"),
    ]:
        recs = ((catalog.get("catalogs") or {}).get(key) or {}).get("records") or []
        code_maps[kind] = {r["code"]: r.get("meaning") for r in recs if r.get("code")}
        for r in recs:
            if r.get("nativeId"):
                code_maps[kind][str(r["nativeId"])] = r.get("meaning")
    return code_maps


def resolve_catalogue(code_maps: dict, pdf_fields: dict, hms_fields: dict) -> dict:
    """Best-effort catalogue resolve for create gold."""
    out: dict[str, Any] = {}
    room_text = (pdf_fields.get("room_type_text") or (pdf_fields.get("accommodationType") or [None])[0] or "")
    room_text = str(room_text).strip().lower()
    if room_text:
        hits = [c for c, m in (code_maps.get("room_type") or {}).items() if m and str(m).strip().lower() == room_text]
        if len(hits) == 1:
            out["room_type"] = {"code": hits[0], "meaning": code_maps["room_type"][hits[0]], "basis": "unique_pdf_room"}
    if hms_fields.get("roomtype") and "room_type" not in out:
        code = str(hms_fields["roomtype"]).strip()
        out["room_type"] = {"code": code, "meaning": (code_maps.get("room_type") or {}).get(code), "basis": "hms_roomtype"}
    company = str(hms_fields.get("company") or "").strip()
    if company:
        hits = [c for c, m in (code_maps.get("organization") or {}).items() if m and str(m).strip().lower() == company.lower()]
        if len(hits) == 1:
            out["organization"] = {"code": hits[0], "meaning": code_maps["organization"][hits[0]], "basis": "unique_hms_company"}
        else:
            out["organization"] = {"code": None, "meaning": company, "basis": "hms_company_text"}
    agency = str(hms_fields.get("ta1") or pdf_fields.get("agency_text") or "").strip()
    if agency:
        hits = [c for c, m in (code_maps.get("agency") or {}).items() if m and str(m).strip().lower() == agency.lower()]
        if len(hits) == 1:
            out["agency"] = {"code": hits[0], "meaning": code_maps["agency"][hits[0]], "basis": "unique_agency"}
        else:
            out["agency"] = {"code": None, "meaning": agency, "basis": "agency_text"}
    return out


def msg_to_source_msg(m: dict, *, body: str | None = None) -> dict:
    text = body if body is not None else (m.get("text_body") or m.get("body") or "")
    cleaned, _ = strip_images(text)
    return {
        "timestamp": m.get("received_at") or m.get("sent_at") or m.get("message_at"),
        "direction": m.get("direction"),
        "subject": m.get("subject"),
        "body": cleaned,
        "body_text": cleaned,
        "from": m.get("from_address") or m.get("from"),
        "to": m.get("to_addresses") or m.get("to"),
        "cc": m.get("cc_addresses") or m.get("cc"),
        "message_id": m.get("id") or m.get("message_id"),
        "message_id_header": m.get("message_id_header"),
        "source_row_id": m.get("id"),
    }


def short_id(*parts: str) -> str:
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return h


def luna_triage(subject: str, body: str, after_subjects: list[str]) -> dict | None:
    """Label unclear triage with gpt-6-luna; evidence quote must appear in inputs."""
    if not AZURE_KEY:
        return None
    shown = f"SUBJECT:\n{subject}\n\nBODY:\n{body[:3500]}\n\nSTAFF_NEXT_SUBJECTS:\n" + "\n".join(after_subjects[:8])
    prompt = (
        "You label hotel inbox triage for a holdout bench.\n"
        "Pick one workflow the staff should run next: quote|create|amend|cancel|filing|triage|skip.\n"
        "Return JSON only: {\"workflow\":..., \"evidence_quote\": \"verbatim substring from SUBJECT/BODY/STAFF_NEXT_SUBJECTS\", \"basis\": \"short reason\"}.\n"
        "evidence_quote MUST be copied verbatim from the shown inputs.\n\n"
        f"{shown}"
    )
    payload = {
        "model": LUNA_DEPLOY,
        "messages": [
            {"role": "system", "content": "Return JSON only. No markdown."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_completion_tokens": 300,
    }
    req = urllib.request.Request(
        f"{AZURE_BASE}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "api-key": AZURE_KEY, "Authorization": f"Bearer {AZURE_KEY}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        content = data["choices"][0]["message"]["content"]
        content = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        obj = json.loads(content)
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, IndexError) as exc:
        return {"_error": str(exc)}
    quote = str(obj.get("evidence_quote") or "")
    if not quote or quote not in shown:
        return {"_error": "evidence_quote_not_in_inputs", "raw": obj}
    wf = str(obj.get("workflow") or "triage").lower()
    if wf not in NEED and wf != "skip":
        wf = "triage"
    return {"workflow": "triage" if wf == "skip" else wf, "skip": wf == "skip", "evidence_quote": quote, "basis": obj.get("basis")}


class FreshIndex:
    def __init__(self) -> None:
        self.mail_by_id: dict[str, dict] = {}
        self.threads: dict[str, list[dict]] = defaultdict(list)
        self.reads: dict[str, dict] = {}
        self.pdfs_by_conf: dict[str, list[dict]] = defaultdict(list)
        self.pdf_by_att: dict[str, dict] = {}
        self.evidence_by_conf: dict[str, list[dict]] = defaultdict(list)
        self.exclusions: list[dict] = []
        self.missing_reads: list[str] = []

    def load(self) -> None:
        # Re-read reads-all at build time (lane may still be writing).
        for row in load_jsonl(FRESH / "reads-all.jsonl"):
            conf = row.get("confirmation")
            if not conf:
                continue
            self.reads[conf] = row
            if not read_is_usable(row):
                self.missing_reads.append(conf)

        for row in load_jsonl(FRESH / "pdf-manifest.jsonl"):
            self.pdf_by_att[row["attachment_id"]] = row
            m = CONF_FILE_RE.search(row.get("filename") or "")
            if m:
                conf = m.group(1)
                text_path = Path(row.get("local_text") or "")
                text = text_path.read_text(errors="ignore") if text_path.exists() else ""
                fields = parse_pdf_text(text)
                self.pdfs_by_conf[conf].append({
                    **row,
                    "pdf_fields": fields,
                    "fields": {
                        "guest_name": fields.get("guest_name"),
                        "arrival_date": fields.get("arrival_date"),
                        "departure_date": fields.get("departure_date"),
                        "room_type_text": fields.get("room_type_text"),
                        "occupancy_text": fields.get("occupancy_text"),
                        "adults": fields.get("adults"),
                        "children": fields.get("children"),
                        "rate_includes_text": fields.get("rate_includes_text"),
                        "average_daily_rate_text": fields.get("average_daily_rate_text"),
                        "total_accommodation_text": fields.get("total_accommodation_text"),
                        "agency_text": fields.get("agency_text"),
                    },
                    "extracted_text": text[:20000],
                })
        for conf in self.pdfs_by_conf:
            self.pdfs_by_conf[conf].sort(key=lambda p: p.get("sent_at") or "")

        for row in load_jsonl(FRESH / "mail-candidate-evidence.jsonl"):
            if row.get("confirmation"):
                self.evidence_by_conf[row["confirmation"]].append(row)

        for row in load_jsonl(FRESH / "pilot-mail.jsonl"):
            self.mail_by_id[row["id"]] = row
            self.threads[row["thread_id"]].append(row)
        # prod mail (phase4-w) — normalize into same shape
        for row in load_jsonl(FRESH / "prod-mail.jsonl"):
            payload = row.get("payload") or {}
            mid = row.get("source_message_id") or row.get("id")
            norm = {
                "id": mid,
                "thread_id": row.get("source_thread_id") or row.get("thread_id"),
                "direction": "inbound" if (payload.get("direction") or "inbound") == "inbound" else payload.get("direction") or "inbound",
                "subject": payload.get("subject"),
                "text_body": payload.get("body_text") or "",
                "html_body": payload.get("body_html") or "",
                "from_address": (payload.get("from") or {}).get("email") if isinstance(payload.get("from"), dict) else payload.get("from"),
                "to_addresses": [a.get("email") for a in (payload.get("to") or []) if isinstance(a, dict)],
                "cc_addresses": [a.get("email") for a in (payload.get("cc") or []) if isinstance(a, dict)],
                "received_at": payload.get("received_at") or row.get("received_at"),
                "sent_at": payload.get("sent_at") or payload.get("received_at") or row.get("received_at"),
                "message_at": payload.get("received_at") or row.get("received_at"),
                "attachments": [
                    {
                        "id": a.get("id"),
                        "filename": a.get("name") or a.get("filename"),
                        "mime_type": a.get("content_type") or a.get("mime_type"),
                        "extracted_text": a.get("extracted_text"),
                    }
                    for a in (payload.get("attachments") or [])
                ],
                "_source": "prod",
            }
            # Heuristic direction from mailbox: if from contains centurion@legacy → outbound
            fr = str(norm.get("from_address") or "").lower()
            if "centurion@legacy" in fr or "reservations@legacy" in fr:
                norm["direction"] = "outbound"
            self.mail_by_id[mid] = norm
            if norm.get("thread_id"):
                self.threads[norm["thread_id"]].append(norm)

        # Halloween corpus: Amend/Cancel only, from 8 Oct (6-week window).
        hall_inputs = DATA / "inbound" / "halloween" / "inputs.jsonl"
        if hall_inputs.exists():
            for obj in load_jsonl(hall_inputs):
                sm = obj.get("selected_message") or {}
                ts = sm.get("timestamp") or obj.get("input_cutoff") or ""
                if not ts or ts < AMEND_CANCEL_START:
                    continue
                mid = sm.get("source_row_id") or sm.get("message_id") or obj.get("decision_id")
                if not mid or mid in self.mail_by_id:
                    continue
                addresses = sm.get("addresses") if isinstance(sm.get("addresses"), dict) else {}
                fr = addresses.get("from") if addresses else sm.get("from")
                if isinstance(fr, list):
                    fr = fr[0] if fr else None
                norm = {
                    "id": mid,
                    "thread_id": sm.get("thread_id") or f"hall-{obj.get('decision_id')}",
                    "direction": sm.get("direction") or "inbound",
                    "subject": sm.get("subject"),
                    "text_body": sm.get("body") or sm.get("body_text") or "",
                    "from_address": fr,
                    "received_at": ts,
                    "sent_at": ts,
                    "message_at": ts,
                    "message_id_header": sm.get("message_id") or sm.get("message_id_header"),
                    "attachments": [],
                    "_source": "halloween",
                    "_decision_id": obj.get("decision_id"),
                    "_earlier": obj.get("earlier_relevant_source_events") or [],
                }
                self.mail_by_id[mid] = norm
                self.threads[norm["thread_id"]].append(norm)
                # Also index earlier events as thread context
                for ev in norm["_earlier"]:
                    msg = ev.get("message") or ev
                    if not isinstance(msg, dict):
                        continue
                    eid = msg.get("source_row_id") or msg.get("message_id") or f"{mid}-earlier-{msg.get('timestamp')}"
                    if eid in self.mail_by_id:
                        continue
                    ets = msg.get("timestamp") or msg.get("received_at") or ""
                    if not ets:
                        continue
                    em = {
                        "id": eid,
                        "thread_id": norm["thread_id"],
                        "direction": msg.get("direction") or "inbound",
                        "subject": msg.get("subject"),
                        "text_body": msg.get("body") or msg.get("body_text") or "",
                        "from_address": msg.get("from"),
                        "received_at": ets,
                        "sent_at": ets,
                        "message_id_header": msg.get("message_id") or msg.get("message_id_header"),
                        "attachments": [],
                        "_source": "halloween_earlier",
                    }
                    self.mail_by_id[eid] = em
                    self.threads[norm["thread_id"]].append(em)

        for tid in self.threads:
            self.threads[tid].sort(key=lambda m: m.get("received_at") or m.get("sent_at") or "")

    def build_anchors(self) -> dict[str, dict]:
        anchors: dict[str, dict] = {}
        for conf, pdfs in self.pdfs_by_conf.items():
            read = self.reads.get(conf)
            hms_fields = flat_hms_fields(read) if read else {}
            anchors[conf] = {
                "confirmation": conf,
                "hms_capture_later": (read or {}).get("read_at"),
                "hms_fields": hms_fields,
                "issues": [],
                "pdfs": [
                    {
                        "filename": p.get("filename"),
                        "sent_at": p.get("sent_at"),
                        "sha256": p.get("sha256"),
                        "pdf_attachment_id": p.get("attachment_id"),
                        "source_row_id": p.get("source_message_id"),
                        "thread_id": (self.mail_by_id.get(p.get("source_message_id") or "") or {}).get("thread_id"),
                        "pdf_fields": p.get("pdf_fields") or {},
                        "fields": p.get("fields") or {},
                    }
                    for p in pdfs
                ],
                "primary": True,
            }
        # Also anchors for reads without PDFs (cancel/filing still need later_hms)
        for conf, read in self.reads.items():
            if conf not in anchors:
                anchors[conf] = {
                    "confirmation": conf,
                    "hms_capture_later": read.get("read_at"),
                    "hms_fields": flat_hms_fields(read),
                    "issues": ["no_confirmation_pdf_in_fresh_window"],
                    "pdfs": [],
                    "primary": False,
                }
        return anchors

    def build_stay360(self) -> dict[str, dict]:
        stay: dict[str, dict] = {}
        for conf, read in self.reads.items():
            rv = read.get("record_view") or {}
            details = rv.get("details") or {}
            fields = details.get("fields")
            if not fields:
                # flatten cards → fields list
                fields = []
                for card in details.get("cards") or []:
                    fields.extend(card.get("fields") or [])
            stay[conf] = {
                "ok": True,
                "confirmation": conf,
                "stay360": {
                    "selectedRow": ((read.get("shallow") or {}).get("selectedRow")),
                    "details": {"cards": ((read.get("shallow") or {}).get("details") or {}).get("cards")},
                },
                "recordView": {"details": {"fields": fields}},
                "guestDetails": read.get("guest_details"),
            }
        return stay

    def threads_for_conf(self, conf: str) -> set[str]:
        tids: set[str] = set()
        for p in self.pdfs_by_conf.get(conf) or []:
            mid = p.get("source_message_id")
            m = self.mail_by_id.get(mid or "")
            if m and m.get("thread_id"):
                tids.add(m["thread_id"])
        for ev in self.evidence_by_conf.get(conf) or []:
            mid = ev.get("source_message_id")
            m = self.mail_by_id.get(mid or "")
            if m and m.get("thread_id"):
                tids.add(m["thread_id"])
        # scan a capped set of threads mentioning conf (expensive — use evidence first)
        return tids

    def exclude(self, reason: str, **meta: Any) -> None:
        self.exclusions.append({"reason": reason, **meta})


def earlier_context(msgs: list[dict], selected: dict, limit: int = 8) -> list[dict]:
    as_of = selected.get("received_at") or ""
    out = []
    for m in msgs:
        at = m.get("received_at") or ""
        if not at or at >= as_of:
            continue
        if m.get("id") == selected.get("id"):
            continue
        if is_ota_blob(m.get("from_address") or "", m.get("subject") or "", (m.get("text_body") or "")[:400]):
            continue
        out.append(msg_to_source_msg(m))
    return out[-limit:]


def make_gold_row(
    *,
    workflow: str,
    case_id: str,
    conf: str | None,
    selected: dict,
    thread_msgs: list[dict],
    anchors: dict,
    code_maps: dict,
    amendment: dict | None = None,
    filing_attachment: dict | None = None,
    evidence_limits: list[str] | None = None,
    triage_meta: dict | None = None,
) -> dict:
    as_of = selected.get("received_at")
    body, _ = strip_images(selected.get("text_body") or "")
    before = earlier_context(thread_msgs, selected)
    selected_src = msg_to_source_msg(selected, body=body)
    messages = before + [selected_src]
    anchor = anchors.get(conf) if conf else None
    hms_fields = dict((anchor or {}).get("hms_fields") or {})
    pdfs = (anchor or {}).get("pdfs") or []
    first_pdf = None
    after_pdfs = [p for p in pdfs if (p.get("sent_at") or "") > (as_of or "")]
    if after_pdfs:
        first_pdf = after_pdfs[0]
    elif pdfs and workflow == "create":
        first_pdf = pdfs[0]
    pre_pdfs = [p for p in pdfs if (p.get("sent_at") or "") <= (as_of or "")]
    decision_base = pre_pdfs[-1] if pre_pdfs else None

    pdf_fields = (first_pdf or {}).get("fields") or {}
    # Prefer live HMS; fill gaps from after-as_of confirmation PDF (owner rule).
    # Ensure first_pdf.fields always carries normalized aliases for create knowability.
    if first_pdf:
        raw = first_pdf.get("pdf_fields") or {}
        merged_fields = {
            "guest_name": (first_pdf.get("fields") or {}).get("guest_name") or raw.get("guest_name"),
            "arrival_date": (first_pdf.get("fields") or {}).get("arrival_date") or raw.get("arrival_date"),
            "departure_date": (first_pdf.get("fields") or {}).get("departure_date") or raw.get("departure_date"),
            "room_type_text": (first_pdf.get("fields") or {}).get("room_type_text") or raw.get("room_type_text"),
            "occupancy_text": (first_pdf.get("fields") or {}).get("occupancy_text") or raw.get("occupancy_text"),
            "adults": (first_pdf.get("fields") or {}).get("adults", raw.get("adults")),
            "children": (first_pdf.get("fields") or {}).get("children", raw.get("children")),
            "rate_includes_text": (first_pdf.get("fields") or {}).get("rate_includes_text") or raw.get("rate_includes_text"),
            "average_daily_rate_text": (first_pdf.get("fields") or {}).get("average_daily_rate_text") or raw.get("average_daily_rate_text"),
            "total_accommodation_text": (first_pdf.get("fields") or {}).get("total_accommodation_text") or raw.get("total_accommodation_text"),
            "agency_text": (first_pdf.get("fields") or {}).get("agency_text") or raw.get("agency_text"),
        }
        first_pdf = {**first_pdf, "fields": merged_fields}
        pdf_fields = merged_fields

    if not any(k in hms_fields for k in ("arrivaldate", "departuredate", "guestfullname")):
        hms_fields = {**pdf_fields_as_hms(pdf_fields if isinstance(pdf_fields, dict) else {}), **hms_fields}
        provenance = "confirmation_pdf_after_as_of_plus_stub_read"
    else:
        provenance = "fresh_reads_all.jsonl live HMS read"

    resolved = resolve_catalogue(code_maps, pdf_fields if isinstance(pdf_fields, dict) else {}, hms_fields)
    # Inject catalogue room code so exhaustive_gold emits room_type path.
    if "roomtype" not in hms_fields and isinstance(resolved.get("room_type"), dict) and resolved["room_type"].get("code"):
        hms_fields["roomtype"] = resolved["room_type"]["code"]
    if "company" not in hms_fields and isinstance(resolved.get("organization"), dict) and resolved["organization"].get("meaning"):
        hms_fields["company"] = resolved["organization"]["meaning"]
    if "ta1" not in hms_fields and isinstance(resolved.get("agency"), dict) and resolved["agency"].get("meaning"):
        hms_fields["ta1"] = resolved["agency"]["meaning"]

    later_hms = {
        "observed_at": (anchor or {}).get("hms_capture_later"),
        "fields": dict(hms_fields),
        "provenance": provenance,
    }
    if conf:
        later_hms["fields"]["confirmationnumber"] = conf

    row: dict[str, Any] = {
        "schema_version": "nava.holdout-fresh.v1",
        "case_id": case_id,
        "workflow": workflow,
        "split": "holdout-fresh",
        "real_confirmation": conf,
        "source": {
            "thread_id": selected.get("thread_id"),
            "selected_message_id": selected.get("id"),
            "input_cutoff": as_of,
            "subject": selected.get("subject"),
            "body_text": body,
            "messages_as_of_cutoff": messages,
            "provenance": {"corpus": "hms-fresh-reads-20261119", "window": "2026-10-29→2026-11-19"},
        },
        "first_pdf": {
            "sent_at": (first_pdf or {}).get("sent_at"),
            "sha256": (first_pdf or {}).get("sha256"),
            "filename": (first_pdf or {}).get("filename"),
            "attachment_id": (first_pdf or {}).get("pdf_attachment_id") or (first_pdf or {}).get("attachment_id"),
            "fields": (first_pdf or {}).get("fields") or {},
            "selection": "first_pdf_after_as_of" if after_pdfs else "earliest_pdf",
        } if first_pdf else {},
        "decision_time_base_pdf": {
            "sent_at": (decision_base or {}).get("sent_at"),
            "sha256": (decision_base or {}).get("sha256"),
            "fields": (decision_base or {}).get("fields") or {},
        } if decision_base else {},
        "resolved_base_fields": resolved,
        "later_hms": later_hms,
        "amendment": amendment or {},
        "filing_attachment": filing_attachment or {},
        "evidence_limits": evidence_limits or ["holdout_fresh_window"],
    }
    if triage_meta:
        row["triage_label"] = triage_meta
    return row


def _filing_hms_doc_after(read: dict | None, as_of: str) -> bool:
    """True if HMS documents list shows a filing after as_of (best filing evidence)."""
    if not read or not as_of:
        return False
    docs = read.get("documents") or {}
    items = docs if isinstance(docs, list) else (docs.get("items") or docs.get("documents") or docs.get("rows") or [])
    if isinstance(docs, dict) and not items:
        # nested shapes from Stay360 document pane
        for key in ("uploaded", "files", "attachments", "list"):
            if isinstance(docs.get(key), list):
                items = docs[key]
                break
    for doc in items or []:
        if not isinstance(doc, dict):
            continue
        ts = (
            doc.get("uploadedAt")
            or doc.get("uploaded_at")
            or doc.get("createdAt")
            or doc.get("created_at")
            or doc.get("timestamp")
            or doc.get("date")
            or ""
        )
        if ts and str(ts) > as_of:
            return True
    return False


def mine_candidates(idx: FreshIndex, anchors: dict, code_maps: dict) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    used_selected: set[str] = set()

    # Confirmations with PDF and (usable HMS or PDF gold).
    conf_pool = set(idx.pdfs_by_conf) | {c for c, r in idx.reads.items() if read_is_usable(r)}
    for conf in sorted(conf_pool):
        read = idx.reads.get(conf) or {}
        if read and is_nava_touched(read):
            idx.exclude("nava_touched", confirmation=conf)
            continue
        pdfs = idx.pdfs_by_conf.get(conf) or []
        tids = idx.threads_for_conf(conf)
        if not tids:
            continue
        status = str(read.get("status") or flat_hms_fields(read).get("status") or "")
        usable = read_is_usable(read) or bool(pdfs)

        for tid in tids:
            msgs = idx.threads.get(tid) or []
            if not msgs:
                continue

            # CREATE: last inbound non-OTA before first confirmation PDF (3-week fresh window only)
            if pdfs and usable:
                first_at = pdfs[0]["sent_at"]
                earlier_in = [
                    m for m in msgs
                    if (m.get("received_at") or "") < first_at
                    and (m.get("received_at") or "") >= FRESH_START
                    and m.get("direction") == "inbound"
                    and not is_ota_blob(m.get("from_address") or "", m.get("subject") or "", (m.get("text_body") or "")[:600])
                    and "Confirmation Letter" not in (m.get("subject") or "")
                    and m.get("_source") not in ("halloween", "halloween_earlier")
                ]
                if earlier_in:
                    sel = earlier_in[-1]
                    case_id = f"hf-create-{short_id(conf, sel['id'])}"
                    row = make_gold_row(
                        workflow="create",
                        case_id=case_id,
                        conf=conf,
                        selected=sel,
                        thread_msgs=msgs,
                        anchors=anchors,
                        code_maps=code_maps,
                        evidence_limits=["holdout_fresh", "create_inbound_before_first_pdf"],
                    )
                    # Require first_pdf dates for create gold quality
                    if ((row.get("first_pdf") or {}).get("fields") or {}).get("arrival_date"):
                        buckets["create"].append(row)

                # AMEND: PDF field diffs with inbound ask before the after-PDF
                for i in range(len(pdfs) - 1):
                    a, b = pdfs[i], pdfs[i + 1]
                    between = [
                        m for m in msgs
                        if (a.get("sent_at") or "") < (m.get("received_at") or "") < (b.get("sent_at") or "")
                        and m.get("direction") == "inbound"
                        and not is_ota_blob(m.get("from_address") or "", m.get("subject") or "", (m.get("text_body") or "")[:600])
                    ]
                    # Also allow last inbound at/after first pdf before second if between empty
                    if not between:
                        between = [
                            m for m in msgs
                            if (m.get("received_at") or "") <= (b.get("sent_at") or "")
                            and (m.get("received_at") or "") > (a.get("sent_at") or "")
                            and m.get("direction") == "inbound"
                            and not is_ota_blob(m.get("from_address") or "", m.get("subject") or "", (m.get("text_body") or "")[:600])
                            and "Confirmation Letter" not in (m.get("subject") or "")
                        ]
                    dep_before = ((a.get("fields") or {}).get("departure_date"))
                    dep_after = ((b.get("fields") or {}).get("departure_date"))
                    arr_before = ((a.get("fields") or {}).get("arrival_date"))
                    arr_after = ((b.get("fields") or {}).get("arrival_date"))
                    guest_before = ((a.get("fields") or {}).get("guest_name"))
                    guest_after = ((b.get("fields") or {}).get("guest_name"))
                    changes = {}
                    if dep_before and dep_after and dep_before != dep_after:
                        changes["departure_date"] = {"before": dep_before, "after": dep_after}
                    if arr_before and arr_after and arr_before != arr_after:
                        changes["arrival_date"] = {"before": arr_before, "after": arr_after}
                    # name-only change: keep as amend with reservation_id gold only unless dates also move
                    for m in between or []:
                        blob = (m.get("subject") or "") + " " + (m.get("text_body") or "")[:1500]
                        if not (changes or AMEND_RE.search(blob) or (guest_before and guest_after and guest_before != guest_after)):
                            continue
                        if not changes and not AMEND_RE.search(blob):
                            continue
                        amendment = {
                            "changes": changes,
                            "after_pdf": {
                                "sent_at": b.get("sent_at"),
                                "sha256": b.get("sha256"),
                                "fields": b.get("fields") or {},
                                "selection": "next_pdf_after_request",
                            },
                        }
                        case_id = f"hf-amend-{short_id(conf, m['id'])}"
                        row = make_gold_row(
                            workflow="amend",
                            case_id=case_id,
                            conf=conf,
                            selected=m,
                            thread_msgs=msgs,
                            anchors=anchors,
                            code_maps=code_maps,
                            amendment=amendment,
                            evidence_limits=["holdout_fresh", "amend_between_pdfs"],
                        )
                        buckets["amend"].append(row)
                        break

            # CANCEL: inbound cancel language from 6-week window (booking may predate window)
            for m in msgs:
                if m.get("direction") != "inbound":
                    continue
                if (m.get("received_at") or "") < AMEND_CANCEL_START:
                    continue
                blob = (m.get("subject") or "") + " " + (m.get("text_body") or "")[:1200]
                if is_ota_blob(m.get("from_address") or "", blob):
                    continue
                if not CANCEL_RE.search(blob):
                    continue
                # require conf mentioned or only conf in thread
                if conf not in blob and conf not in (m.get("subject") or ""):
                    # still allow if thread is exclusively about this conf via PDFs
                    if not pdfs:
                        continue
                case_id = f"hf-cancel-{short_id(conf, m['id'])}"
                row = make_gold_row(
                    workflow="cancel",
                    case_id=case_id,
                    conf=conf,
                    selected=m,
                    thread_msgs=msgs,
                    anchors=anchors,
                    code_maps=code_maps,
                    evidence_limits=["holdout_fresh_6wk", f"hms_status={status}"],
                )
                buckets["cancel"].append(row)

            # FILING: 3-week fresh only; prefer HMS doc uploaded after as_of
            for m in msgs:
                if m.get("direction") != "inbound":
                    continue
                if (m.get("received_at") or "") < FRESH_START:
                    continue
                if m.get("_source") in ("halloween", "halloween_earlier"):
                    continue
                blob = (m.get("subject") or "") + " " + (m.get("text_body") or "")[:800]
                atts = m.get("attachments") or []
                att_hit = any(FILING_RE.search(a.get("filename") or "") for a in atts)
                if not (FILING_RE.search(blob) or att_hit):
                    continue
                if is_ota_blob(m.get("from_address") or "", blob):
                    continue
                # pick a PDF attachment if present
                fa = None
                for a in atts:
                    fn = a.get("filename") or ""
                    if str(a.get("mime_type") or "").endswith("pdf") or fn.lower().endswith(".pdf"):
                        fa = {"filename": fn, "attachment_id": a.get("id")}
                        break
                if not fa and atts:
                    fa = {"filename": atts[0].get("filename"), "attachment_id": atts[0].get("id")}
                case_id = f"hf-filing-{short_id(conf, m['id'])}"
                as_of = m.get("received_at") or ""
                hms_filed = _filing_hms_doc_after(read, as_of)
                row = make_gold_row(
                    workflow="filing",
                    case_id=case_id,
                    conf=conf,
                    selected=m,
                    thread_msgs=msgs,
                    anchors=anchors,
                    code_maps=code_maps,
                    filing_attachment=fa or {},
                    evidence_limits=[
                        "holdout_fresh",
                        "filing_voucher_or_pop",
                        "hms_doc_after_as_of" if hms_filed else "mail_attachment_only",
                    ],
                )
                row["_filing_hms_doc_after"] = hms_filed
                buckets["filing"].append(row)

    # Extended Amend/Cancel: any inbound ask from 8 Oct mentioning a conf (booking may be older).
    for tid, msgs in idx.threads.items():
        for m in msgs:
            if m.get("direction") != "inbound":
                continue
            ts = m.get("received_at") or ""
            if ts < AMEND_CANCEL_START:
                continue
            subj = m.get("subject") or ""
            body = m.get("text_body") or ""
            if is_ota_blob(m.get("from_address") or "", subj, body[:500]):
                continue
            if "Confirmation Letter" in subj:
                continue
            blob = subj + "\n" + body[:2000]
            if CANCEL_RE.search(blob):
                label = "cancel"
            elif AMEND_RE.search(blob):
                label = "amend"
            else:
                continue
            confs = list(dict.fromkeys(CONF_RE.findall(blob)))
            # thread PDFs / earlier subjects
            for other in msgs:
                if (other.get("received_at") or "") > ts:
                    continue
                confs.extend(CONF_RE.findall((other.get("subject") or "") + " " + (other.get("text_body") or "")[:400]))
                for att in other.get("attachments") or []:
                    confs.extend(CONF_FILE_RE.findall(att.get("filename") or ""))
            confs = list(dict.fromkeys(confs))
            for conf in confs:
                if not conf:
                    continue
                read = idx.reads.get(conf) or {}
                if read and is_nava_touched(read):
                    continue
                # ensure anchor exists for build_card
                if conf not in anchors:
                    anchors[conf] = {
                        "confirmation": conf,
                        "hms_capture_later": (read or {}).get("read_at"),
                        "hms_fields": flat_hms_fields(read) if read else {},
                        "issues": ["extended_window_no_fresh_pdf"],
                        "pdfs": idx.pdfs_by_conf.get(conf) or [],
                        "primary": False,
                    }
                case_id = f"hf-{label}-{short_id(conf, m['id'])}"
                row = make_gold_row(
                    workflow=label,
                    case_id=case_id,
                    conf=conf,
                    selected=m,
                    thread_msgs=msgs,
                    anchors=anchors,
                    code_maps=code_maps,
                    evidence_limits=["holdout_6wk_extend", f"{label}_ask_mail"],
                )
                buckets[label].append(row)

    # Cancel requests mentioning confs NOT yet in reads → missing list
    for tid, msgs in idx.threads.items():
        for m in msgs:
            if m.get("direction") != "inbound":
                continue
            blob = (m.get("subject") or "") + " " + (m.get("text_body") or "")[:1500]
            if not CANCEL_RE.search(blob):
                continue
            if is_ota_blob(m.get("from_address") or "", blob):
                continue
            for conf in set(CONF_RE.findall(blob + " " + (m.get("subject") or ""))):
                if conf not in idx.reads:
                    idx.missing_reads.append(conf)

    # --- Quote: inbound quote ask + later staff outbound ---
    for tid, msgs in idx.threads.items():
        for m in msgs:
            if m.get("direction") != "inbound":
                continue
            subj = m.get("subject") or ""
            body = m.get("text_body") or ""
            if is_ota_blob(m.get("from_address") or "", subj, body[:500]):
                continue
            if not QUOTE_RE.search(subj + " " + body[:800]):
                continue
            at = m.get("received_at") or ""
            if not at:
                continue
            later_out = [
                x for x in msgs
                if (x.get("received_at") or "") > at and x.get("direction") == "outbound"
            ]
            if not later_out:
                continue
            # optional conf link
            confs = list(dict.fromkeys(CONF_RE.findall(subj + " " + body[:2000])))
            conf = next((c for c in confs if c in idx.reads), confs[0] if confs else None)
            if conf and conf not in idx.reads:
                idx.missing_reads.append(conf)
                conf = None
            case_id = f"hf-quote-{short_id(m['id'])}"
            row = make_gold_row(
                workflow="quote",
                case_id=case_id,
                conf=conf,
                selected=m,
                thread_msgs=msgs,
                anchors=anchors,
                code_maps=code_maps,
                evidence_limits=["holdout_fresh", "quote_with_staff_reply_after"],
            )
            # attach staff reply into context_after via gold later — store on row
            reply = later_out[0]
            reply_body, _ = strip_images(reply.get("text_body") or "")
            row["quotes"] = {
                "staff_reply": {
                    "message_id": reply.get("id"),
                    "timestamp": reply.get("received_at"),
                    "subject": reply.get("subject"),
                    "body_text": reply_body[:8000],
                }
            }
            buckets["quote"].append(row)

    # --- Triage / skip ---
    triage_pool = []
    for tid, msgs in idx.threads.items():
        for m in msgs:
            if m.get("direction") != "inbound":
                continue
            subj = m.get("subject") or ""
            body = m.get("text_body") or ""
            if is_ota_blob(m.get("from_address") or "", subj, body[:500]):
                idx.exclude("ota_or_automated", message_id=m.get("id"), subject=subj[:120])
                continue
            if "Confirmation Letter" in subj:
                continue
            at = m.get("received_at") or ""
            if not at:
                idx.exclude("null_date", message_id=m.get("id"))
                continue
            # skip if already strongly another workflow
            blob = subj + " " + body[:800]
            if QUOTE_RE.search(blob) or CANCEL_RE.search(blob) or AMEND_RE.search(blob) or FILING_RE.search(blob):
                continue
            if CREATE_RE.search(blob) and CONF_RE.search(blob):
                continue
            after = [x for x in msgs if (x.get("received_at") or "") > at]
            after_subj = [x.get("subject") or "" for x in after[:6]]
            clear = None
            if TRIAGE_HINT_RE.search(blob):
                clear = {"workflow": "triage", "basis": "staff_ops_keyword", "evidence_quote": None}
            elif after and any(CANCEL_RE.search(s) for s in after_subj):
                clear = {"workflow": "triage", "basis": "staff_next_cancel_thread", "evidence_quote": next(s for s in after_subj if CANCEL_RE.search(s))}
            triage_pool.append((m, msgs, after_subj, clear))

    # Prefer clear triage first, then Luna-label a capped unclear set
    clear_rows = [t for t in triage_pool if t[3]]
    unclear = [t for t in triage_pool if not t[3]]
    # diversify by subject prefix
    def diversify(rows, n):
        seen = set()
        out = []
        for m, msgs, after_subj, clear in rows:
            key = re.sub(r"^(re:|fw:|fwd:)\s*", "", (m.get("subject") or ""), flags=re.I)[:40].lower()
            if key in seen:
                continue
            seen.add(key)
            out.append((m, msgs, after_subj, clear))
            if len(out) >= n:
                break
        return out

    clear_pick = diversify(clear_rows, NEED["triage"] + 10)
    unclear_pick = diversify(unclear, max(0, NEED["triage"] + 15 - len(clear_pick)))

    luna_inputs = unclear_pick[:40]
    luna_results: dict[str, dict] = {}
    if luna_inputs and AZURE_KEY:
        def _job(item):
            m, msgs, after_subj, _ = item
            body, _ = strip_images(m.get("text_body") or "")
            return m["id"], luna_triage(m.get("subject") or "", body, after_subj)
        with ThreadPoolExecutor(max_workers=20) as pool:
            futs = [pool.submit(_job, item) for item in luna_inputs]
            for fut in as_completed(futs):
                mid, res = fut.result()
                if res:
                    luna_results[mid] = res

    for m, msgs, after_subj, clear in clear_pick + unclear_pick:
        meta = clear or luna_results.get(m["id"])
        if not meta or meta.get("_error"):
            # default triage with weak gold
            meta = {"workflow": "triage", "basis": "default_unclear_holdout", "evidence_quote": (m.get("subject") or "")[:80]}
        confs = list(dict.fromkeys(CONF_RE.findall((m.get("subject") or "") + " " + (m.get("text_body") or "")[:2000])))
        conf = next((c for c in confs if c in idx.reads), None)
        case_id = f"hf-triage-{short_id(m['id'])}"
        row = make_gold_row(
            workflow="triage",
            case_id=case_id,
            conf=conf,
            selected=m,
            thread_msgs=msgs,
            anchors=anchors,
            code_maps=code_maps,
            evidence_limits=["holdout_fresh", "triage_or_skip"],
            triage_meta=meta,
        )
        buckets["triage"].append(row)

    return buckets


def dedupe_prefer(rows: list[dict]) -> list[dict]:
    """Prefer unique selected_message_id; keep first."""
    seen_msg: set[str] = set()
    seen_case: set[str] = set()
    out = []
    for row in rows:
        mid = (row.get("source") or {}).get("selected_message_id")
        cid = row.get("case_id")
        if cid in seen_case:
            continue
        if mid and mid in seen_msg and row["workflow"] not in ("create", "amend"):
            # create/amend may share selected across multi-room; still allow up to 1 per conf
            continue
        if mid and row["workflow"] in ("create", "amend"):
            # unique per confirmation
            key = f"{row['workflow']}:{row.get('real_confirmation')}"
            if key in seen_case:
                continue
            seen_case.add(key)
        if mid:
            seen_msg.add(mid)
        seen_case.add(cid)
        out.append(row)
    return out


def select_mix(buckets: dict[str, list[dict]], need: dict[str, int]) -> tuple[list[dict], dict]:
    """Select up to NEED per workflow. No weak pad on amend/cancel/filing — fill rest with create/quote/triage only."""
    selected: list[dict] = []
    got: dict[str, int] = {}
    shifts: dict[str, Any] = {"requested": dict(need), "notes": [], "no_pad": True}
    for wf, n in need.items():
        rows = dedupe_prefer(buckets.get(wf) or [])
        if wf == "cancel":
            rows.sort(key=lambda r: (
                0 if "Cancelled" in str(((r.get("later_hms") or {}).get("fields") or {}).get("status") or "") else 1,
                r["case_id"],
            ))
        elif wf == "amend":
            rows.sort(key=lambda r: (0 if (r.get("amendment") or {}).get("changes") else 1, r["case_id"]))
        elif wf == "filing":
            # Best-evidenced first: HMS doc after as_of, then attachment present
            rows.sort(key=lambda r: (
                0 if r.get("_filing_hms_doc_after") else 1,
                0 if (r.get("filing_attachment") or {}).get("filename") else 1,
                r["case_id"],
            ))
        elif wf == "create":
            rows.sort(key=lambda r: (0 if (r.get("first_pdf") or {}).get("sent_at") else 1, r["case_id"]))
        take = rows[:n]
        got[wf] = len(take)
        selected.extend(take)
        if len(take) < n:
            shifts["notes"].append(f"{wf}: wanted {n}, got {len(take)} (no weak pad)")

    # Make up to 100 with Create/Quote/Triage only — never pad Amend/Cancel/Filing.
    if len(selected) < 100:
        used = {r["case_id"] for r in selected}
        used_msg = {(r.get("source") or {}).get("selected_message_id") for r in selected}
        for wf in ("create", "quote", "triage"):
            for row in dedupe_prefer(buckets.get(wf) or []):
                if len(selected) >= 100:
                    break
                mid = (row.get("source") or {}).get("selected_message_id")
                if row["case_id"] in used:
                    continue
                if mid and mid in used_msg:
                    continue
                selected.append(row)
                used.add(row["case_id"])
                if mid:
                    used_msg.add(mid)
                got[wf] = got.get(wf, 0) + 1
                shifts["notes"].append(f"fill +1 {wf} → {row['case_id']}")
    # Freeze real counts — do not invent cases if under 100
    shifts["final"] = dict(Counter(r["workflow"] for r in selected))
    shifts["n"] = len(selected)
    if len(selected) < 100:
        shifts["notes"].append(f"FROZEN under 100: n={len(selected)} (no pad)")
    return selected, shifts


def main() -> None:
    print("[holdout] loading fresh index…", flush=True)
    idx = FreshIndex()
    idx.load()
    print(f"[holdout] reads={len(idx.reads)} mail={len(idx.mail_by_id)} pdf_confs={len(idx.pdfs_by_conf)}", flush=True)

    print("[holdout] loading 200-dev / Halloween∩fresh blocklist…", flush=True)
    block = load_dev_blocklist()
    blocked_msgids: set[str] = set(block["blocked_message_ids"])
    blocked_confs: set[str] = set(block["blocked_confirmations"])
    print(
        f"[holdout] blocked confs={len(blocked_confs)} msgids={len(blocked_msgids)} "
        f"halloween∩fresh={block['halloween_fresh_msgid_overlap_n']}",
        flush=True,
    )
    (FRESH / "holdout-dev-blocklist.json").write_text(json.dumps({
        "halloween_fresh_msgid_overlap_n": block["halloween_fresh_msgid_overlap_n"],
        "halloween_fresh_msgid_overlap": block["halloween_fresh_msgid_overlap"],
        "v1_msgid_n": block["v1_msgid_n"],
        "v1_conf_n": block["v1_conf_n"],
        "blocked_message_ids_n": len(blocked_msgids),
        "blocked_confirmations_n": len(blocked_confs),
        "blocked_confirmations": sorted(blocked_confs),
        "blocked_message_ids_sample": sorted(blocked_msgids)[:50],
    }, indent=2))

    code_maps = load_code_maps()
    anchors = idx.build_anchors()
    stay360 = idx.build_stay360()
    profiles: list = []

    print("[holdout] mining candidates…", flush=True)
    buckets = mine_candidates(idx, anchors, code_maps)

    # Pre-filter gold rows against dev blocklist (Message-ID / confirmation).
    dropped_pre: list[dict] = []
    filtered: dict[str, list[dict]] = defaultdict(list)
    for wf, rows in buckets.items():
        for row in rows:
            hit = gold_row_hits_dev_blocklist(
                row, blocked_msgids, blocked_confs, idx.mail_by_id, idx.threads,
            )
            if hit:
                dropped_pre.append({"case_id": row.get("case_id"), "workflow": wf, "reason": hit, "stage": "pre_build"})
                continue
            filtered[wf].append(row)
    print(
        f"[holdout] mined={ {k: len(v) for k, v in buckets.items()} } "
        f"after_dedup={ {k: len(v) for k, v in filtered.items()} } "
        f"dropped_pre={len(dropped_pre)}",
        flush=True,
    )

    selected, shifts = select_mix(filtered, NEED)
    print("[holdout] mix", shifts["final"], "notes", shifts["notes"][:20], flush=True)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    built = []
    errors = []
    leaks = []
    dropped_post: list[dict] = []

    def _accept(row: dict) -> dict | None:
        try:
            card = build_card(row, anchors, stay360, profiles, code_maps)
        except Exception as exc:  # noqa: BLE001
            errors.append({"case_id": row.get("case_id"), "error": str(exc)})
            return None
        if not card["leak_guard"]["ok"]:
            leaks.append({"case_id": card["case_id"], "leaks": card["leak_guard"]["leaks"][:5]})
            return None
        card = strip_gold_conf_inputs(card)
        # Re-check blocklist on final shown messages (headers may appear only after build).
        hit = card_hits_dev_blocklist(card, blocked_msgids, blocked_confs)
        if hit:
            dropped_post.append({"case_id": card["case_id"], "workflow": card["workflow"], "reason": hit, "stage": "post_build"})
            return None
        if row.get("quotes"):
            card["quotes"] = row["quotes"]
        if row.get("triage_label"):
            card["triage_label"] = row["triage_label"]
        return card

    for row in selected:
        card = _accept(row)
        if not card:
            continue
        path = OUT / card["case_id"]
        path.mkdir(parents=True, exist_ok=True)
        (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
        (path / "case.md").write_text(render_md(card))
        built.append(card)

    # Refill to 100 from Create/Quote/Triage only (never pad amend/cancel/filing).
    if len(built) < 100:
        used = {c["case_id"] for c in built}
        used_msg = {
            (c.get("selected_email") or {}).get("message_id")
            or (c.get("selected_email") or {}).get("source_row_id")
            for c in built
        }
        leftovers = []
        for wf in ("create", "quote", "triage"):
            for row in filtered.get(wf) or []:
                if row["case_id"] in used:
                    continue
                leftovers.append(row)
        for row in leftovers:
            if len(built) >= 100:
                break
            mid = (row.get("source") or {}).get("selected_message_id")
            if mid and mid in used_msg:
                continue
            card = _accept(row)
            if not card:
                continue
            # Prefer cancel/amend already selected; this path is create/quote/triage only
            if card["workflow"] not in ("create", "quote", "triage"):
                continue
            path = OUT / card["case_id"]
            path.mkdir(parents=True, exist_ok=True)
            (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
            (path / "case.md").write_text(render_md(card))
            built.append(card)
            used.add(card["case_id"])
            if mid:
                used_msg.add(mid)
            shifts["notes"].append(f"refill +1 {card['workflow']} → {card['case_id']}")

    def _real_conf(c: str) -> bool:
        return bool(re.match(r"^(\d{6,10})-1$", c or ""))

    missing = sorted({c for c in idx.missing_reads if _real_conf(c)})
    for conf in sorted(idx.pdfs_by_conf):
        if not _real_conf(conf):
            continue
        read = idx.reads.get(conf)
        if not read_is_usable(read):
            missing.append(conf)
    missing = sorted(set(missing))
    needed_by_cases = sorted({
        c.get("real_confirmation")
        for c in built
        if c.get("real_confirmation")
        and _real_conf(c.get("real_confirmation") or "")
        and not read_is_usable(idx.reads.get(c["real_confirmation"] or ""))
    })
    missing = needed_by_cases + [c for c in missing if c not in set(needed_by_cases)]
    missing = missing[:200]

    dropped_all = dropped_pre + dropped_post
    by_wf = dict(Counter(c["workflow"] for c in built))
    shifts["final"] = by_wf
    manifest = {
        "n": len(built),
        "by_workflow": by_wf,
        "requested": NEED,
        "shifts": shifts,
        "leaks_rejected": len(leaks),
        "leak_samples": leaks[:20],
        "build_errors": len(errors),
        "error_samples": errors[:20],
        "exclusions_n": len(idx.exclusions),
        "exclusion_reasons": dict(Counter(e["reason"] for e in idx.exclusions)),
        "dev_dedup": {
            "halloween_fresh_msgid_overlap_n": block["halloween_fresh_msgid_overlap_n"],
            "blocked_confirmations_n": len(blocked_confs),
            "blocked_message_ids_n": len(blocked_msgids),
            "dropped_n": len(dropped_all),
            "dropped_pre_n": len(dropped_pre),
            "dropped_post_n": len(dropped_post),
            "dropped_by_reason": dict(Counter(
                ("conf" if r["reason"].startswith("dev_conf") else "msgid") for r in dropped_all
            )),
            "dropped_samples": dropped_all[:30],
        },
        "missing_reads_n": len(missing),
        "missing_reads": missing,
        "reads_available": len(idx.reads),
        "out": str(OUT),
        "window": {
            "create_quote_filing_triage": "2026-10-29→2026-11-19",
            "amend_cancel": "2026-10-08→2026-11-19",
        },
        "rules": [
            "as_of=selected_email.received_at",
            "hms_shown backdated per workflow",
            "leak_guard on; null dates fail",
            "PDF text only",
            "exclude NAVAAI / Proof Labtest",
            "exclude OTA/channel/automated",
            "holdout never used for tuning",
            "dedup vs 200-dev Message-ID + confirmation (+ Halloween∩fresh Message-IDs)",
            "no gold-conf input fetch; rank2/PDFs from visible confs only",
            "amend/cancel 6-week window from 8 Oct; bookings may predate window",
            "filing capped at 12; prefer HMS doc after as_of",
            "no weak pad — freeze real counts; fill remainder with create/quote/triage only",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (OUT / "exclusions.jsonl").write_text(
        "\n".join(json.dumps(e) for e in idx.exclusions[:5000]) + ("\n" if idx.exclusions else "")
    )
    (OUT / "dev-dedup-dropped.jsonl").write_text(
        "\n".join(json.dumps(e) for e in dropped_all) + ("\n" if dropped_all else "")
    )

    # queue-holdout.json: amend+cancel first for reads lane
    from datetime import datetime, timezone
    q_rows = []
    for card in built:
        conf = card.get("real_confirmation")
        wf = card.get("workflow")
        if not conf or wf not in ("cancel", "amend", "create", "filing"):
            continue
        if conf in blocked_confs:
            continue
        read = idx.reads.get(conf)
        if read_is_usable(read):
            continue
        if read and is_nava_touched(read):
            continue
        pri = {"cancel": 1, "amend": 2, "create": 3, "filing": 4}[wf]
        q_rows.append({
            "confirmation": conf,
            "why": wf,
            "priority": pri,
            "reason_detail": "stub_read_needs_full_record_view" if read else "missing_from_reads_all",
            "case_id": card.get("case_id"),
            "workflow": wf,
            "as_of": card.get("as_of"),
            "subject": ((card.get("selected_email") or {}).get("subject") or "")[:160],
            "has_stub_read": bool(read) and not read_is_usable(read),
            "absent_from_reads_all": conf not in idx.reads,
            "has_confirmation_pdf": conf in idx.pdfs_by_conf,
            "n_pdfs": len(idx.pdfs_by_conf.get(conf) or []),
        })
    # also queue amend/cancel candidates that failed gold build for lack of reads
    have = {r["confirmation"] for r in q_rows}
    for wf in ("cancel", "amend"):
        for row in filtered.get(wf) or []:
            conf = row.get("real_confirmation")
            if not conf or conf in have or conf in blocked_confs:
                continue
            read = idx.reads.get(conf)
            if read_is_usable(read):
                continue
            q_rows.append({
                "confirmation": conf,
                "why": wf,
                "priority": 1 if wf == "cancel" else 2,
                "reason_detail": "holdout_candidate_needs_hms_for_gold",
                "case_id": row.get("case_id"),
                "workflow": wf,
                "as_of": (row.get("source") or {}).get("input_cutoff"),
                "subject": ((row.get("source") or {}).get("subject") or "")[:160],
                "has_stub_read": bool(read) and not read_is_usable(read),
                "absent_from_reads_all": conf not in idx.reads,
                "has_confirmation_pdf": conf in idx.pdfs_by_conf,
                "n_pdfs": len(idx.pdfs_by_conf.get(conf) or []),
            })
            have.add(conf)
    q_rows.sort(key=lambda r: (r["priority"], 0 if r.get("absent_from_reads_all") else 1, r["confirmation"]))
    # dedupe by conf keeping best priority
    seen_q: set[str] = set()
    q_dedup = []
    for r in q_rows:
        if r["confirmation"] in seen_q:
            continue
        seen_q.add(r["confirmation"])
        q_dedup.append(r)
    queue_payload = {
        "schema_version": "holdout-missing-reads/v1",
        "written_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "instruction": (
            "Reads lane: JUMP THESE TO FRONT. Order = cancel → amend → create → filing. "
            "Full live record_view required. Skip NAVAAI/Labtest. 6-week amend/cancel window from 8 Oct."
        ),
        "counts": {
            "queued": len(q_dedup),
            "cancel": sum(1 for r in q_dedup if r["why"] == "cancel"),
            "amend": sum(1 for r in q_dedup if r["why"] == "amend"),
            "create": sum(1 for r in q_dedup if r["why"] == "create"),
            "filing": sum(1 for r in q_dedup if r["why"] == "filing"),
            "holdout_n": len(built),
            "holdout_by_workflow": by_wf,
        },
        "queue": q_dedup,
    }
    (FRESH / "queue-holdout.json").write_text(json.dumps(queue_payload, indent=2, ensure_ascii=False))
    manifest["queue_holdout"] = queue_payload["counts"]
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))

    print(json.dumps({
        k: manifest[k]
        for k in ("n", "by_workflow", "shifts", "leaks_rejected", "build_errors", "dev_dedup", "queue_holdout", "reads_available")
    }, indent=2))


if __name__ == "__main__":
    main()
