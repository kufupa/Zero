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

# Target mix — shift reported in manifest when data short.
NEED = {"create": 25, "amend": 15, "cancel": 15, "filing": 10, "quote": 20, "triage": 15}

AZURE_BASE = (os.environ.get("AZURE_OPENAI_BASE_URL") or "https://nava.openai.azure.com/openai/v1").rstrip("/")
AZURE_KEY = os.environ.get("AZURE_FOUNDRY_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY") or ""
LUNA_DEPLOY = os.environ.get("NAVA_AGENT_AZURE_DEPLOYMENT") or "gpt-6-luna"


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

            # CREATE: last inbound non-OTA before first confirmation PDF
            if pdfs and usable:
                first_at = pdfs[0]["sent_at"]
                earlier_in = [
                    m for m in msgs
                    if (m.get("received_at") or "") < first_at
                    and m.get("direction") == "inbound"
                    and not is_ota_blob(m.get("from_address") or "", m.get("subject") or "", (m.get("text_body") or "")[:600])
                    and "Confirmation Letter" not in (m.get("subject") or "")
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

            # CANCEL: inbound cancel language; prefer Cancelled status
            for m in msgs:
                if m.get("direction") != "inbound":
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
                    evidence_limits=["holdout_fresh", f"hms_status={status}"],
                )
                buckets["cancel"].append(row)

            # FILING: inbound voucher/POP with attachment
            for m in msgs:
                if m.get("direction") != "inbound":
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
                row = make_gold_row(
                    workflow="filing",
                    case_id=case_id,
                    conf=conf,
                    selected=m,
                    thread_msgs=msgs,
                    anchors=anchors,
                    code_maps=code_maps,
                    filing_attachment=fa or {},
                    evidence_limits=["holdout_fresh", "filing_voucher_or_pop"],
                )
                buckets["filing"].append(row)

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
    selected: list[dict] = []
    got: dict[str, int] = {}
    shifts: dict[str, Any] = {"requested": dict(need), "notes": []}
    for wf, n in need.items():
        rows = dedupe_prefer(buckets.get(wf) or [])
        # Prefer stronger evidence
        if wf == "cancel":
            rows.sort(key=lambda r: (0 if "Cancelled" in str(((r.get("later_hms") or {}).get("fields") or {}).get("status") or "") else 1, r["case_id"]))
        elif wf == "amend":
            rows.sort(key=lambda r: (0 if (r.get("amendment") or {}).get("changes") else 1, r["case_id"]))
        elif wf == "create":
            rows.sort(key=lambda r: (0 if (r.get("first_pdf") or {}).get("sent_at") else 1, r["case_id"]))
        take = rows[:n]
        got[wf] = len(take)
        selected.extend(take)
        if len(take) < n:
            shifts["notes"].append(f"{wf}: wanted {n}, got {len(take)}")

    # Pad to 100 from surplus quote/triage/create/filing
    if len(selected) < 100:
        used = {r["case_id"] for r in selected}
        used_msg = {(r.get("source") or {}).get("selected_message_id") for r in selected}
        for wf in ("create", "filing", "quote", "triage", "amend", "cancel"):
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
                shifts["notes"].append(f"pad +1 {wf} → {row['case_id']}")
    selected = selected[:100]
    shifts["final"] = dict(Counter(r["workflow"] for r in selected))
    return selected, shifts


def main() -> None:
    print("[holdout] loading fresh index…", flush=True)
    idx = FreshIndex()
    idx.load()
    print(f"[holdout] reads={len(idx.reads)} mail={len(idx.mail_by_id)} pdf_confs={len(idx.pdfs_by_conf)}", flush=True)

    code_maps = load_code_maps()
    anchors = idx.build_anchors()
    stay360 = idx.build_stay360()
    profiles: list = []

    print("[holdout] mining candidates…", flush=True)
    buckets = mine_candidates(idx, anchors, code_maps)
    print({k: len(v) for k, v in buckets.items()}, flush=True)

    selected, shifts = select_mix(buckets, NEED)
    print("[holdout] mix", shifts["final"], "notes", shifts["notes"][:20], flush=True)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    built = []
    errors = []
    leaks = []
    for row in selected:
        try:
            card = build_card(row, anchors, stay360, profiles, code_maps)
        except Exception as exc:  # noqa: BLE001
            errors.append({"case_id": row.get("case_id"), "error": str(exc)})
            continue
        if not card["leak_guard"]["ok"]:
            leaks.append({"case_id": card["case_id"], "leaks": card["leak_guard"]["leaks"][:5]})
            # still keep? fail closed on leak
            continue
        # attach quotes / triage meta for graders
        if row.get("quotes"):
            card["quotes"] = row["quotes"]
        if row.get("triage_label"):
            card["triage_label"] = row["triage_label"]
        path = OUT / card["case_id"]
        path.mkdir(parents=True, exist_ok=True)
        (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
        (path / "case.md").write_text(render_md(card))
        built.append(card)

    # If under 100 due to leaks/errors, try refill from leftover
    if len(built) < 100:
        used = {c["case_id"] for c in built}
        used_msg = {(c.get("selected_email") or {}).get("message_id") or (c.get("selected_email") or {}).get("source_row_id") for c in built}
        leftovers = []
        for wf, rows in buckets.items():
            for row in rows:
                if row["case_id"] in used:
                    continue
                leftovers.append(row)
        for row in leftovers:
            if len(built) >= 100:
                break
            mid = (row.get("source") or {}).get("selected_message_id")
            if mid and mid in used_msg:
                continue
            try:
                card = build_card(row, anchors, stay360, profiles, code_maps)
            except Exception as exc:  # noqa: BLE001
                errors.append({"case_id": row.get("case_id"), "error": str(exc)})
                continue
            if not card["leak_guard"]["ok"]:
                leaks.append({"case_id": card["case_id"], "leaks": card["leak_guard"]["leaks"][:5]})
                continue
            if row.get("quotes"):
                card["quotes"] = row["quotes"]
            if row.get("triage_label"):
                card["triage_label"] = row["triage_label"]
            path = OUT / card["case_id"]
            path.mkdir(parents=True, exist_ok=True)
            (path / "case.json").write_text(json.dumps(card, ensure_ascii=False))
            (path / "case.md").write_text(render_md(card))
            built.append(card)
            used.add(card["case_id"])
            if mid:
                used_msg.add(mid)

    def _real_conf(c: str) -> bool:
        m = re.match(r"^(\d{6,10})-1$", c or "")
        return bool(m)

    missing = sorted({c for c in idx.missing_reads if _real_conf(c)})
    for conf in sorted(idx.pdfs_by_conf):
        if not _real_conf(conf):
            continue
        read = idx.reads.get(conf)
        if not read_is_usable(read):
            missing.append(conf)
    missing = sorted(set(missing))
    # Prefer listing ones referenced by selected cases first
    needed_by_cases = sorted({
        c.get("real_confirmation")
        for c in built
        if c.get("real_confirmation")
        and _real_conf(c.get("real_confirmation") or "")
        and not read_is_usable(idx.reads.get(c["real_confirmation"] or ""))
    })
    missing = needed_by_cases + [c for c in missing if c not in set(needed_by_cases)]
    missing = missing[:200]

    by_wf = dict(Counter(c["workflow"] for c in built))
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
        "missing_reads_n": len(missing),
        "missing_reads": missing,
        "reads_available": len(idx.reads),
        "out": str(OUT),
        "window": "2026-10-29→2026-11-19",
        "rules": [
            "as_of=selected_email.received_at",
            "hms_shown backdated per workflow",
            "leak_guard on; null dates fail",
            "PDF text only",
            "exclude NAVAAI / Proof Labtest",
            "exclude OTA/channel/automated",
            "holdout never used for tuning",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (OUT / "exclusions.jsonl").write_text("\n".join(json.dumps(e) for e in idx.exclusions[:5000]) + ("\n" if idx.exclusions else ""))
    print(json.dumps({k: manifest[k] for k in ("n", "by_workflow", "shifts", "leaks_rejected", "build_errors", "missing_reads_n", "reads_available")}, indent=2))


if __name__ == "__main__":
    main()
