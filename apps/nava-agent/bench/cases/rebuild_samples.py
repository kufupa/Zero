#!/usr/bin/env python3
"""Rebuild Create+Amend sample case cards with the 8 coordinator fixes."""
from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

DATA = Path("/home/orca/.local/share/zero/bench/replay-bench-20261119")
OUT = DATA / "cases" / "samples"
CONF_RE = re.compile(r"(?:n[°º]\s*)?(\d{6,10})-1", re.I)
CONF_FILE_RE = re.compile(r"(\d{6,10}-1)")
IMG_RE = re.compile(
    r"(?is)(<img\b[^>]*>|\[cid:[^\]]+\]|cid:[^\s\"'<>]+|data:image/[^;]+;base64,[a-z0-9+/=]+|"
    r"https?://\S+\.(?:png|jpe?g|gif|webp)|\b[\w.-]+\.(?:png|jpe?g|gif|webp)\b)"
)


def _norm_conf(value: str | None) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if re.fullmatch(r"\d{6,10}", raw):
        return f"{raw}-1"
    m = re.search(r"(\d{6,10}-\d)", raw)
    return m.group(1) if m else raw


def visible_confs_in_mail_text(card: dict) -> set[str]:
    """Conf numbers in subject/body of shown mail only — not from gold-keyed PDF attachments."""
    as_of = card.get("as_of") or ""
    found: set[str] = set()
    msgs = [card.get("selected_email") or {}] + list(card.get("context_before") or [])
    for msg in msgs:
        ts = msg.get("timestamp") or msg.get("received_at") or ""
        if ts and as_of and ts > as_of:
            continue
        blob = " ".join(str(msg.get(k) or "") for k in ("subject", "body_text", "body"))
        for hit in CONF_RE.findall(blob):
            found.add(_norm_conf(hit) or hit)
        for hit in CONF_FILE_RE.findall(blob):
            found.add(_norm_conf(hit) or hit)
    return {c for c in found if c}


# Back-compat alias used by holdout builders / callers.
visible_confs_before_as_of = visible_confs_in_mail_text


def strip_gold_conf_inputs(card: dict) -> dict:
    """Rank-2 cross-thread + earlier PDFs only from confs visible in shown mail (no gold-key fetch)."""
    visible = visible_confs_in_mail_text(card)
    gold = _norm_conf(card.get("real_confirmation"))
    for msg in [card.get("selected_email") or {}] + list(card.get("context_before") or []):
        kept = []
        for pdf in msg.get("pdf_attachments_text") or []:
            name = str(pdf.get("filename") or "")
            text = str(pdf.get("text") or "")
            pdf_confs = {
                _norm_conf(c) or c
                for c in (set(CONF_FILE_RE.findall(name)) | set(CONF_RE.findall(text + " " + name)))
            }
            pdf_confs = {c for c in pdf_confs if c}
            if not pdf_confs:
                # Unstructured attachment (voucher/POP without conf token) — keep.
                kept.append(pdf)
                continue
            # Keep only when at least one conf also appears in shown mail text.
            if pdf_confs & visible:
                kept.append(pdf)
        msg["pdf_attachments_text"] = kept

    xt_kept = []
    for link in card.get("cross_thread_context") or []:
        matched = _norm_conf(link.get("matched_confirmation"))
        rank = link.get("rank")
        if rank == 2:
            if matched and matched not in visible:
                continue
            if matched is None and gold and gold not in visible:
                continue
        xt_kept.append(link)
    card["cross_thread_context"] = xt_kept
    card["input_confs_visible"] = sorted(visible)
    card["card_fixes"] = list(card.get("card_fixes") or []) + [
        "no_gold_conf_input_fetch",
        "cross_thread_rank2_and_pdfs_from_visible_confs_only",
    ]
    return card

from field_catalog import (  # noqa: E402
    ACTION_PATHS,
    GROUP_AMEND_CONFS,
    HMS_TO_PROPOSAL_MAP,
    PROFILE_FIELDS,
    STAY360_FIELDS,
    TIER1,
    TIER2,
    TIER_HISTORY,
)

# Group amend wave (same staff outbound cluster shortening departure to 04-09-2026).
AMEND_GROUP = [
    {"confirmation": "22098684-1", "guest_name": "N Lethwane"},
    {"confirmation": "37768113-1", "guest_name": "GR Gasebone"},
    {"confirmation": "38564475-1", "guest_name": "M Mthandeki"},
    {"confirmation": "60387251-1", "guest_name": "A Stemmer"},
]


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def strip_images(text: str | None) -> tuple[str, list[str]]:
    text = text or ""
    found = [m.group(0)[:120] for m in IMG_RE.finditer(text)]
    cleaned = IMG_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, found


def parse_ts(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value


def pdf_fields(pdf: dict) -> dict:
    return dict(pdf.get("pdf_fields") or pdf.get("fields") or {})


def normalize_pdf_stay(fields: dict, confirmation: str | None) -> dict:
    def first(key: str):
        val = fields.get(key)
        if isinstance(val, list):
            return val[0] if val else None
        return val

    arrival = first("arrivalDate") or fields.get("arrival_date")
    departure = first("departureDate") or fields.get("departure_date")
    guest = first("guestName") or fields.get("guest_name")
    room_text = first("accommodationType") or fields.get("room_type_text")
    occ = first("occupancy") or fields.get("occupancy_text")
    rate_inc = first("rateIncludes") or fields.get("rate_includes_text")
    adr = first("averageDailyRate") or fields.get("average_daily_rate_text")
    total = first("totalAccommodation") or fields.get("total_accommodation_text")
    conf = first("confirmationNumber") or confirmation

    adults = fields.get("adults")
    children = fields.get("children")
    if adults is None and isinstance(occ, str):
        m = re.search(r"(\d+)\s*Adult", occ, re.I)
        adults = int(m.group(1)) if m else None
    if children is None and isinstance(occ, str):
        m = re.search(r"(\d+)\s*Child", occ, re.I)
        children = int(m.group(1)) if m else 0

    def iso_date(raw: Any) -> str | None:
        if raw is None:
            return None
        s = str(raw)
        # DD-MM-YYYY
        m = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", s)
        if m:
            return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            return s
        return s

    first_name = last_name = None
    if isinstance(guest, str) and guest.strip():
        parts = guest.strip().split()
        if len(parts) >= 2:
            first_name = " ".join(parts[:-1]) if parts[0].endswith(".") or len(parts[0]) <= 2 else parts[0]
            # "N Lethwane" -> first N, last Lethwane; "Mike Mazhindu" -> Mike / Mazhindu
            if len(parts) == 2:
                first_name, last_name = parts[0], parts[1]
            else:
                first_name, last_name = parts[0], parts[-1]
        else:
            last_name = guest.strip()

    return {
        "status": "Reserved",
        "confirmation": conf,
        "confirmationnumber": conf,
        "guest_name": guest,
        "guestfullname": guest,
        "first_name": first_name,
        "last_name": last_name,
        "arrival_date": iso_date(arrival),
        "arrivaldate": arrival,
        "departure_date": iso_date(departure),
        "departuredate": departure,
        "adults": adults,
        "children": children,
        "room_type_text": room_text,
        "occupancy_text": occ,
        "rate_includes_text": rate_inc,
        "average_daily_rate_text": adr,
        "total_accommodation_text": total,
        "agency_text": first("agency") or fields.get("agency_text"),
        "company_text": first("company") or fields.get("company_text"),
        "source": "last_pre_as_of_pdf",
    }


def load_world():
    anchors = {}
    with open(DATA / "world/anchors.jsonl") as f:
        for line in f:
            if line.strip():
                a = json.loads(line)
                anchors[a["confirmation"]] = a
    stay360 = {}
    obj = json.loads((DATA / "world/stay360-run01.json").read_text())
    for row in obj.get("results") or []:
        if row.get("ok") and row.get("confirmation"):
            stay360[row["confirmation"]] = row
    profiles = json.loads((DATA / "world/profiles.json").read_text()).get("profiles") or []
    catalog = json.loads((DATA / "catalog/catalog.json").read_text())
    code_maps = {}
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
        # also by nativeId for agency/org
        for r in recs:
            if r.get("nativeId"):
                code_maps[kind][str(r["nativeId"])] = r.get("meaning")
    return anchors, stay360, profiles, code_maps


def last_pdf_before(anchor: dict | None, as_of: str) -> dict | None:
    if not anchor:
        return None
    pdfs = []
    for pdf in anchor.get("pdfs") or []:
        sent = parse_ts(pdf.get("sent_at"))
        if sent and sent <= as_of:
            pdfs.append(pdf)
    if not pdfs:
        return None
    pdfs.sort(key=lambda p: p.get("sent_at") or "")
    return pdfs[-1]


def first_pdf_after(anchor: dict | None, as_of: str) -> dict | None:
    if not anchor:
        return None
    pdfs = []
    for pdf in anchor.get("pdfs") or []:
        sent = parse_ts(pdf.get("sent_at"))
        if sent and sent > as_of:
            pdfs.append(pdf)
    if not pdfs:
        return None
    pdfs.sort(key=lambda p: p.get("sent_at") or "")
    return pdfs[0]


def record_view_fields(stay_row: dict | None) -> list[dict]:
    if not stay_row:
        return []
    rv = stay_row.get("recordView") or {}
    details = rv.get("details") or {}
    fields = details.get("fields")
    if isinstance(fields, list):
        return fields
    return []


def code_name(code_maps: dict, kind: str, code: Any) -> dict | None:
    if code is None or code == "":
        return None
    c = str(code)
    meaning = (code_maps.get(kind) or {}).get(c)
    return {"code": c, "name": meaning}


def project_shown(workflow: str, as_of: str, conf: str | None, anchor: dict | None, base_pdf: dict | None) -> dict:
    # Quote/triage (and any case without a confirmation) never invent a stay.
    if workflow in ("quote", "triage") or not conf:
        return {
            "exists": False,
            "confirmation": None,
            "stay": None,
            "documents": [],
            "basis": "no_stay_at_as_of" if workflow in ("quote", "triage") else "missing_confirmation",
            "basis_pdf_sent_at": None,
        }
    if workflow == "create":
        first = None
        if anchor:
            ordered = sorted(
                [p for p in (anchor.get("pdfs") or []) if parse_ts(p.get("sent_at"))],
                key=lambda p: p["sent_at"],
            )
            first = ordered[0] if ordered else None
        if not first or first["sent_at"] > as_of:
            return {
                "exists": False,
                "confirmation": conf,
                "stay": None,
                "documents": [],
                "basis": "create_booking_absent_at_as_of",
                "basis_pdf_sent_at": None,
            }
    pdf = base_pdf or last_pdf_before(anchor, as_of)
    if workflow in ("amend", "cancel", "filing") and not pdf:
        return {
            "exists": False,
            "confirmation": conf,
            "stay": None,
            "documents": [],
            "basis": "no_pre_as_of_pdf",
            "basis_pdf_sent_at": None,
        }
    stay = normalize_pdf_stay(pdf_fields(pdf) if pdf else {}, conf)
    if workflow == "cancel":
        stay["status"] = "Reserved"
    # NEVER merge later HMS snapshot into shown
    return {
        "exists": True,
        "confirmation": conf,
        "stay": stay,
        "documents": [],
        "basis": "last_pre_as_of_pdf",
        "basis_pdf_sent_at": (pdf or {}).get("sent_at"),
        "basis_pdf_sha256": (pdf or {}).get("sha256"),
    }


def leak_guard(card: dict) -> dict:
    leaks = []
    as_of = card["as_of"]
    conf = card.get("real_confirmation")

    def check_msg(msg: dict, where: str, *, allow_eq_as_of: bool = False):
        ts = parse_ts(msg.get("timestamp") or msg.get("received_at") or msg.get("sent_at"))
        if ts is None:
            leaks.append(f"{where}:null_date")
            return
        if where.startswith("shown") and (ts > as_of if not allow_eq_as_of else ts > as_of):
            # selected may equal as_of; anything strictly after is a leak
            if ts > as_of:
                leaks.append(f"{where}:after_as_of:{ts}")

    for i, msg in enumerate(card.get("context_before") or []):
        check_msg(msg, f"shown.context_before[{i}]")
    check_msg(card.get("selected_email") or {}, "shown.selected_email")
    for i, link in enumerate(card.get("cross_thread_context") or []):
        for j, msg in enumerate(link.get("messages") or []):
            check_msg(msg, f"shown.cross_thread[{i}].messages[{j}]")

    stay = (card.get("hms_shown") or {}).get("stay") or {}
    if card["workflow"] == "create" and (card.get("hms_shown") or {}).get("exists"):
        # create should usually be absent; if exists, departure/status from later cancel is leak
        if "cancel" in str(stay.get("status", "")).lower():
            leaks.append("shown.stay:create_cancelled_status")
    if card["workflow"] == "amend":
        # shown departure must not equal gold after if gold before differs — compare to basis PDF
        gold_dep = None
        gold_before = None
        for g in card.get("gold") or []:
            if g.get("path", "").endswith("departure_date") and g.get("expectation") == "expected":
                gold_dep = g.get("value")
                gold_before = g.get("before")
        shown_dep = stay.get("departure_date")
        if gold_before and shown_dep and str(shown_dep) == str(gold_dep) and str(gold_dep) != str(gold_before):
            leaks.append(f"shown.stay.departure_date_is_post_amend_answer:{shown_dep}")
        if gold_before and shown_dep and str(shown_dep) != str(gold_before):
            # also catch if shown matches after
            if str(shown_dep) == str(gold_dep):
                leaks.append(f"shown.stay.departure_leaked_after:{shown_dep}")
    if card["workflow"] == "cancel" and str(stay.get("status", "")).lower() == "cancelled":
        leaks.append("shown.stay:cancel_status_cancelled")

    # shown must not include after-as_of confirmation PDF fields as truth for amend
    after = card.get("context_after") or {}
    for pdf in after.get("confirmation_pdfs") or []:
        if pdf.get("sent_at") and pdf["sent_at"] <= as_of:
            leaks.append("context_after.pdf_not_after")

    # rank2 links must only be this confirmation
    for link in card.get("cross_thread_context") or []:
        if link.get("rank") == 2 and conf and link.get("matched_confirmation") not in (conf, None):
            # allow None only if reason says this conf; else leak
            if link.get("matched_confirmation") and link.get("matched_confirmation") != conf:
                leaks.append(f"cross_thread.rank2_other_conf:{link.get('matched_confirmation')}")

    return {"ok": len(leaks) == 0, "leaks": leaks}


def cross_thread(as_of: str, thread_id: str | None, conf: str | None, selected_headers: dict) -> list[dict]:
    """Rank1 headers; Rank2 THIS conf only; Rank3 surname+arrival; Rank4 weak sender."""
    links: list[dict] = []
    if not conf:
        return links
    seen = set()
    with open(DATA / "world/pairs.jsonl") as f:
        for line in f:
            if conf not in line:
                continue
            p = json.loads(line)
            if p.get("confirmation") != conf:
                continue
            methods = p.get("methods") or {}
            th = p.get("thread") or {}
            tid = th.get("thread_id") or th.get("id")
            if not tid or tid == thread_id or tid in seen:
                continue
            rank = None
            reason = None
            if methods.get("direct_header") or selected_headers.get("in_reply_to") or selected_headers.get("references"):
                # header into other thread
                if methods.get("direct_header"):
                    rank, reason = 1, "reply_header"
            if methods.get("direct_confirmation"):
                rank, reason = 2, "confirmation_in_text"
            if rank is None:
                continue
            msgs = []
            null_date = False
            for m in th.get("messages") or th.get("msgs") or []:
                ts = parse_ts(m.get("timestamp") or m.get("received_at") or m.get("sent_at"))
                if ts is None:
                    null_date = True
                    continue
                if ts > as_of:
                    continue
                body, _ = strip_images(m.get("body") or m.get("body_text") or "")
                msgs.append({
                    "timestamp": ts,
                    "direction": m.get("direction"),
                    "subject": m.get("subject"),
                    "body": body[:8000],
                    "body_text": body[:8000],
                    "from": m.get("from"),
                })
            if null_date:
                # still include link but mark; leak guard will fail if we put undated into shown — skip undated
                pass
            if not msgs:
                continue
            seen.add(tid)
            links.append({
                "thread_id": tid,
                "rank": rank,
                "reason": reason,
                "matched_confirmation": conf if rank == 2 else None,
                "messages": msgs[:20],
            })
            if len(links) >= 12:
                break
    links.sort(key=lambda x: (x["rank"], x["thread_id"]))
    return links


def context_after(as_of: str, conf: str | None, anchor: dict | None, gold_row: dict) -> dict:
    items = []
    pdfs = []
    if conf:
        with open(DATA / "world/pairs.jsonl") as f:
            for line in f:
                if conf not in line:
                    continue
                p = json.loads(line)
                if p.get("confirmation") != conf:
                    continue
                th = p.get("thread") or {}
                tid = th.get("thread_id") or th.get("id")
                for m in th.get("messages") or th.get("msgs") or []:
                    ts = parse_ts(m.get("timestamp") or m.get("received_at") or m.get("sent_at"))
                    if ts is None or ts <= as_of:
                        continue
                    body, stripped = strip_images(m.get("body") or m.get("body_text") or "")
                    items.append({
                        "thread_id": tid,
                        "timestamp": ts,
                        "direction": m.get("direction"),
                        "subject": m.get("subject"),
                        "body_text": body[:8000],
                        "images_stripped": stripped[:5],
                    })
    after_pdf = first_pdf_after(anchor, as_of)
    if after_pdf:
        pdfs.append({
            "sent_at": after_pdf.get("sent_at"),
            "sha256": after_pdf.get("sha256"),
            "filename": after_pdf.get("filename"),
            "fields": pdf_fields(after_pdf),
            "selection": "first_pdf_after_as_of",
        })
    # gold amendment after_pdf
    am_after = ((gold_row.get("amendment") or {}).get("after_pdf")) if gold_row.get("workflow") == "amend" else None
    if am_after and am_after.get("sent_at") and am_after["sent_at"] > as_of:
        if not any(p.get("sha256") == am_after.get("sha256") for p in pdfs):
            pdfs.append({
                "sent_at": am_after.get("sent_at"),
                "sha256": am_after.get("sha256"),
                "fields": am_after.get("fields"),
                "selection": "amendment.after_pdf",
            })
    # dedupe messages
    seen = set()
    uniq = []
    for it in sorted(items, key=lambda x: x["timestamp"]):
        key = (it.get("thread_id"), it.get("timestamp"), it.get("subject"))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    return {
        "note": "grader-only; agent never sees this",
        "messages": uniq[:50],
        "confirmation_pdfs": pdfs,
    }


def hms_raw(conf: str | None, anchor: dict | None, stay_row: dict | None, profiles: list, gold_row: dict) -> dict:
    profile = None
    guest = None
    if stay_row:
        # try match profile by last name from later fields / pdf
        hf = (anchor or {}).get("hms_fields") or {}
        guest = hf.get("guestfullname")
    if guest:
        last = str(guest).split(",")[0].strip().lower()
        for p in profiles:
            if (p.get("lastName") or "").lower() == last:
                profile = {
                    "nativeId": p.get("nativeId"),
                    "firstName": p.get("firstName"),
                    "lastName": p.get("lastName"),
                    "email": p.get("email"),
                    "mobile": p.get("mobile"),
                    "observedAt": p.get("observedAt"),
                    "fields": p.get("fields"),
                    "capture_note": "profile snapshot later than many emails; not as-of",
                }
                break
    rv_fields = record_view_fields(stay_row)
    return {
        "confirmation": conf,
        "stay360": {
            "capture_note": "batch read 2026-10-29/30 — later state",
            "selectedRow": (stay_row or {}).get("stay360", {}).get("selectedRow") if stay_row else None,
            "cards": ((stay_row or {}).get("stay360") or {}).get("details", {}).get("cards") if stay_row else None,
        },
        "record_view": {
            "captured_with": "stay360-run01",
            "field_count": len(rv_fields),
            "fields": rv_fields,
        },
        "guest_details": (stay_row or {}).get("guestDetails"),
        "anchor_hms_fields": {
            "captured_at": (anchor or {}).get("hms_capture_later"),
            "fields": (anchor or {}).get("hms_fields"),
            "note": "later HMS snapshot; not as-of",
        },
        "pdf_versions": [
            {
                "sent_at": p.get("sent_at"),
                "sha256": p.get("sha256"),
                "filename": p.get("filename"),
                "thread_id": p.get("thread_id"),
                "fields": pdf_fields(p),
            }
            for p in ((anchor or {}).get("pdfs") or [])
        ],
        "profile": profile,
        "later_hms_from_gold": gold_row.get("later_hms"),
        "first_pdf_from_gold": gold_row.get("first_pdf"),
        "decision_time_base_pdf": gold_row.get("decision_time_base_pdf"),
        "source_pdf_evidence": (stay_row or {}).get("sourcePdfEvidence"),
    }


def _code_name_lookup(code_maps: dict, kind: str, code: Any = None, name: Any = None) -> dict | None:
    if code is None and name is None:
        return None
    c = str(code) if code not in (None, "") else None
    n = name
    if c and n is None:
        n = (code_maps.get(kind) or {}).get(c)
    if n and c is None:
        for cand, meaning in (code_maps.get(kind) or {}).items():
            if meaning and str(meaning).lower() == str(n).lower():
                c = cand
                break
    return {"code": c, "name": n}


def _parse_hms_date(raw: Any) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    # Tue 27-OCT-2026 / Fri 04-SEP-2026 11:00
    m = re.search(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", s)
    if m:
        months = {mth: i for i, mth in enumerate(
            ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"], 1)}
        mon = months.get(m.group(2).upper())
        if mon:
            return f"{m.group(3)}-{mon:02d}-{int(m.group(1)):02d}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    m = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return s


def _parse_adults(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    m = re.search(r"(\d+)\s*Adult", str(raw), re.I)
    return int(m.group(1)) if m else None


def _parse_children(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    m = re.search(r"(\d+)\s*Child", str(raw), re.I)
    return int(m.group(1)) if m else None


def _parse_guest(raw: Any) -> tuple[str | None, str | None, str | None]:
    """Return (first, last, full display). Handles 'Mazhindu, Mr Mike'."""
    if not raw:
        return None, None, None
    s = str(raw).strip()
    if "," in s:
        last, rest = [p.strip() for p in s.split(",", 1)]
        rest = re.sub(r"^(Mr|Ms|Mrs|Miss|Dr)\.?\s+", "", rest, flags=re.I).strip()
        return (rest or None), (last or None), f"{rest} {last}".strip()
    parts = s.split()
    if len(parts) >= 2:
        return parts[0], parts[-1], s
    return None, s, s


def _normalize_later_value(hms_key: str, raw: Any, code_maps: dict) -> Any:
    if raw is None or raw == "":
        return None
    if hms_key in ("arrivaldate", "departuredate"):
        return _parse_hms_date(raw)
    if hms_key == "adults":
        return _parse_adults(raw)
    if hms_key == "children":
        return _parse_children(raw)
    if hms_key == "roomtype":
        code = str(raw).strip()
        return _code_name_lookup(code_maps, "room_type", code=code) or {"code": code, "name": None}
    if hms_key == "rateplan":
        code = str(raw).strip()
        return _code_name_lookup(code_maps, "rate_plan", code=code) or {"code": code, "name": None}
    if hms_key == "company":
        name = str(raw).strip()
        return _code_name_lookup(code_maps, "organization", name=name) or {"code": None, "name": name}
    if hms_key == "ta1":
        name = str(raw).strip()
        if not name:
            return None
        return _code_name_lookup(code_maps, "agency", name=name) or {"code": None, "name": name}
    if hms_key == "guestfullname":
        first, last, full = _parse_guest(raw)
        return {"first_name": first, "last_name": last, "name": full, "raw": raw}
    if hms_key in ("confirmation", "confirmationnumber"):
        return str(raw).strip()
    return raw


def _knowable_from_shown(
    pane: str,
    workflow: str,
    gold_row: dict,
    value: Any,
) -> tuple[str, str]:
    """Return (expectation, basis). Value is later-HMS truth; label by shown knowability."""
    rbf = gold_row.get("resolved_base_fields") or {}
    fp = ((gold_row.get("first_pdf") or {}).get("fields")) or ((gold_row.get("decision_time_base_pdf") or {}).get("fields")) or {}
    am = (gold_row.get("amendment") or {}).get("changes") or {}

    if workflow == "amend" and pane in am:
        return "expected", "reviewed_amendment"
    if pane == "reservation_id" and gold_row.get("real_confirmation") and workflow in ("amend", "cancel", "filing"):
        return "expected", "reviewed_confirmation"
    if workflow == "create":
        if pane == "room_type" and isinstance(rbf.get("room_type"), dict) and rbf["room_type"].get("code"):
            return "expected", rbf["room_type"].get("basis") or "first_pdf_catalogue"
        if pane == "organization_name" and (
            (isinstance(rbf.get("organization"), dict) and rbf["organization"].get("code"))
            or fp.get("company_text")
        ):
            return "expected", "first_pdf_catalogue"
        if pane == "agency_name" and (
            (isinstance(rbf.get("agency"), dict) and rbf["agency"].get("code"))
            or fp.get("agency_text")
        ):
            return "expected", "first_pdf_catalogue"
        if pane == "arrival_date" and fp.get("arrival_date"):
            return "expected", "first_pdf"
        if pane == "departure_date" and fp.get("departure_date"):
            return "expected", "first_pdf"
        if pane == "adults" and fp.get("adults") is not None:
            return "expected", "first_pdf"
        if pane == "child_count" and fp.get("children") is not None:
            return "expected", "first_pdf"
        if pane in ("first_name", "last_name", "guest_name") and fp.get("guest_name"):
            return "expected", "first_pdf"
        if pane == "rate_plan":
            # later HMS has code; knowable only if rbf resolved uniquely
            if isinstance(rbf.get("rate_plan"), dict) and rbf["rate_plan"].get("code"):
                return "expected", rbf["rate_plan"].get("basis") or "first_pdf_catalogue"
            return "not_expected", rbf.get("rate_plan_reason") or "rate_plan_not_unique_from_shown"
        if pane == "meal_plan":
            return "not_expected", "meal_plan_text_not_unique_code_from_shown"
        if pane == "guest_email":
            return "not_expected", "email_not_required_from_shown_before_arrival"
        if pane in ("guarantee_type", "source_of_business", "track", "cms_send", "cms_message_id", "market_segment"):
            return "not_expected", "tier2_default_not_forced_by_shown"
        if pane == "reservation_id":
            return "not_expected", "create_has_no_confirmation_in_proposal"
    if workflow == "cancel":
        if pane == "reservation_id":
            return "expected", "reviewed_confirmation"
        return "not_expected", "cancel_patch_field_not_labelled"
    if workflow == "filing":
        if pane in ("attachment_id", "confirmation_number", "reservation_id"):
            return "expected", "filing_target"
        return "not_expected", "filing_optional_unlabelled"
    if workflow in ("quote", "triage"):
        return "not_expected", f"{workflow}_weak_gold"
    # amend non-changed fields: staff did not publish them as patch
    if workflow == "amend":
        if pane in ("guarantee_type", "source_of_business", "track", "cms_send", "cms_message_id", "market_segment"):
            return "not_expected", "tier2_default_not_in_amend_patch"
        return "not_expected", "unchanged_field_not_in_amend_patch"
    return "not_expected", "not_knowable_from_shown_inputs"


def exhaustive_gold(
    workflow: str,
    gold_row: dict,
    shown_stay: dict | None,
    code_maps: dict,
    rv_fields: list[dict],
    profile: dict | None,
    group_bookings: list[dict] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Proposal-path gold only. 118/65 stay in hms_raw, never as /hms/* gold paths."""
    void = (rv_fields, profile, shown_stay)  # kept for call-site compat; unused in gold paths
    del void
    fields: list[dict] = []
    omitted: list[dict] = []
    seen: set[str] = set()

    def add(path: str, expectation: str, value=None, basis: str = "", tier: str = TIER1, **extra):
        if path in seen:
            return
        seen.add(path)
        row = {"path": path, "expectation": expectation, "basis": basis, "tier": tier, **extra}
        if expectation == "expected":
            row["value"] = value
        elif value is not None:
            row["later_value"] = value  # truth retained for inspection when not_expected
        fields.append(row)

    later = ((gold_row.get("later_hms") or {}).get("fields")) or {}
    case_conf = gold_row.get("real_confirmation")
    # Group gold ONLY for the real Sep-2026 wave cases; never stamp every amend.
    is_group = (
        workflow == "amend"
        and case_conf in GROUP_AMEND_CONFS
        and group_bookings
    )
    bookings = list(group_bookings) if is_group else [{"confirmation": case_conf}]
    if not bookings:
        bookings = [{"confirmation": case_conf}]
    # Primary booking is always THIS case's confirmation (not AMEND_GROUP[0]).
    if is_group:
        bookings = sorted(
            bookings,
            key=lambda b: 0 if b.get("confirmation") == case_conf else 1,
        )

    am = (gold_row.get("amendment") or {}).get("changes") or {}

    for n, booking in enumerate(bookings):
        conf = booking.get("confirmation") or case_conf
        # Per-booking later fields: primary booking uses gold later_hms; others reservation_id only.
        later_fields = dict(later) if n == 0 else {}
        if conf and n == 0:
            later_fields["confirmationnumber"] = case_conf or conf
        elif conf and n > 0:
            later_fields = {"confirmationnumber": conf}

        # Inject amendment after values into primary booking later fields.
        if n == 0 and "departure_date" in am:
            later_fields["departuredate"] = am["departure_date"].get("after")
        if n == 0 and "arrival_date" in am:
            later_fields["arrivaldate"] = am["arrival_date"].get("after")
        if n == 0 and "adults" in am:
            later_fields["adults"] = am["adults"].get("after")

        for hms_key, meta in HMS_TO_PROPOSAL_MAP.items():
            if hms_key not in later_fields and not (hms_key in ("confirmation", "confirmationnumber") and conf):
                continue
            raw = later_fields.get(hms_key)
            if raw is None and hms_key in ("confirmation", "confirmationnumber"):
                raw = conf
            if raw is None or raw == "":
                continue
            path = meta["path"].format(n=n)
            pane = meta["pane"]
            tier = meta["tier"]
            value = _normalize_later_value(hms_key, raw, code_maps)

            # Expand guestfullname into first/last. guest_name only for workflows that use it (not create).
            if hms_key == "guestfullname" and isinstance(value, dict):
                pairs = [
                    ("first_name", value.get("first_name"), f"/bookings/{n}/fields/first_name"),
                    ("last_name", value.get("last_name"), f"/bookings/{n}/fields/last_name"),
                ]
                if workflow != "create":
                    pairs.append(("guest_name", value.get("name"), f"/bookings/{n}/fields/guest_name"))
                for sub_pane, sub_val, sub_path in pairs:
                    if sub_val is None:
                        continue
                    exp, basis = _knowable_from_shown(sub_pane, workflow, gold_row, sub_val)
                    add(sub_path, exp, sub_val, basis, tier=TIER1, hms_key=hms_key)
                continue

            allowed_wf = meta.get("workflows")
            if allowed_wf and workflow not in allowed_wf:
                continue
            # Filing pane uses confirmation_number, not reservation_id.
            if workflow == "filing" and pane == "reservation_id":
                continue

            exp, basis = _knowable_from_shown(pane, workflow, gold_row, value)
            # Create: override room/org/agency values with resolved catalogue when knowable
            if workflow == "create" and exp == "expected":
                rbf = gold_row.get("resolved_base_fields") or {}
                if pane == "room_type" and isinstance(rbf.get("room_type"), dict):
                    value = {"code": rbf["room_type"]["code"], "name": rbf["room_type"].get("meaning")}
                if pane == "organization_name" and isinstance(rbf.get("organization"), dict):
                    value = {"code": rbf["organization"].get("code"), "name": rbf["organization"].get("meaning")}
                if pane == "agency_name" and isinstance(rbf.get("agency"), dict):
                    value = {"code": rbf["agency"].get("code"), "name": rbf["agency"].get("meaning")}
            if workflow == "amend" and pane in am:
                value = am[pane].get("after")
                add(path, "expected", value, "reviewed_amendment", tier=tier, hms_key=hms_key, before=am[pane].get("before"))
                continue
            add(path, exp, value, basis, tier=tier, hms_key=hms_key)

    # Workflow action / doc targets
    if workflow == "cancel" and case_conf:
        add("/bookings/0/reservation_id", "expected", case_conf, "reviewed_confirmation", tier=TIER1)
        add(ACTION_PATHS["cancel_scope"]["path"], "not_expected", "whole_stay", "scope_default_unlabelled", tier=TIER1)
        add(ACTION_PATHS["cancel_reason"]["path"], "not_expected", None, "staff_picks_reason_at_go", tier=TIER1)
    if workflow == "filing":
        # Bench mailPayload exposes attachments as pdf-0..N — gold must match that id, not corpus UUID.
        bench_att = gold_row.get("_bench_attachment_id") or "pdf-0"
        add(ACTION_PATHS["filing_attachment"]["path"], "expected", bench_att, "bench_mail_attachment_id", tier=TIER1)
        if case_conf:
            # Filing pane uses confirmation_number field; reservation_id often left null.
            add(ACTION_PATHS["filing_confirmation"]["path"], "expected", case_conf, "filing_target", tier=TIER1)
            add("/bookings/0/reservation_id", "not_expected", case_conf, "filing_uses_confirmation_number_field", tier=TIER1)
        add(ACTION_PATHS["filing_description"]["path"], "not_expected", "Booking voucher", "description_default", tier=TIER1)
    if workflow == "quote":
        add(ACTION_PATHS["quote_property"]["path"], "expected", "HRCEN", "property_default", tier=TIER1)
        q = gold_row.get("_quote_from_email") or {}
        if q.get("arrival_date"):
            add("/actions/0/details/groups/0/arrival_date", "expected", q["arrival_date"], "selected_email_dates", tier=TIER1)
        if q.get("departure_date"):
            add("/actions/0/details/groups/0/departure_date", "expected", q["departure_date"], "selected_email_dates", tier=TIER1)
        if q.get("adults") is not None:
            add("/actions/0/details/groups/0/rooms/0/adults", "expected", q["adults"], "selected_email_pax", tier=TIER1)
        if q.get("quantity") is not None:
            add("/actions/0/details/groups/0/rooms/0/quantity", "expected", q["quantity"], "selected_email_rooms", tier=TIER1)
        if q.get("board"):
            add("/actions/0/details/board", "expected", q["board"], "selected_email_meal", tier=TIER1)
        if q.get("rate_plan"):
            add("/actions/0/details/groups/0/rooms/0/rate_code", "expected", q["rate_plan"], "staff_quote_or_linked_stay", tier=TIER1)
    if workflow == "triage" and case_conf:
        add(ACTION_PATHS["triage_reservation"]["path"], "not_expected", case_conf, "triage_weak_gold", tier=TIER1)

    # Tier2: history_knowable from earlier same-org/agency HMS bookings before as_of.
    history = gold_row.get("_history_defaults") or {}
    for pane, path in [
        ("guarantee_type", "/bookings/0/fields/guarantee_type"),
        ("source_of_business", "/bookings/0/fields/source_of_business"),
        ("track", "/bookings/0/fields/track"),
        ("rate_plan", "/bookings/0/fields/rate_plan"),
        ("billing_reference", "/bookings/0/fields/billing_reference"),
        ("cms_send", "/bookings/0/fields/cms_send"),
        ("cms_message_id", "/bookings/0/fields/cms_message_id"),
        ("cms_recipient", "/bookings/0/fields/cms_recipient"),
    ]:
        if path in seen and any(f.get("path") == path and f.get("expectation") == "expected" for f in fields):
            continue
        if pane in history and history[pane] is not None:
            # Replace prior not_expected with history_knowable expected.
            fields[:] = [f for f in fields if f.get("path") != path]
            seen.discard(path)
            add(path, "expected", history[pane], "history_same_org_agency_before_as_of", tier=TIER_HISTORY)
        elif workflow == "create" and path not in seen:
            add(path, "not_expected", None, "tier2_default_not_forced_by_shown", tier=TIER2)

    return fields, omitted



def build_message(raw: dict, *, is_selected: bool = False) -> dict:
    ts = parse_ts(raw.get("timestamp") or raw.get("received_at") or raw.get("sent_at"))
    body, stripped = strip_images(raw.get("body") or raw.get("body_text") or "")
    non_pdf = []
    for name in re.findall(r"\b([\w.-]+\.(?:docx?|xlsx?|zip|txt))\b", body, re.I):
        non_pdf.append({"filename": name})
    # image filenames referenced but stripped
    for ref in stripped:
        m = re.search(r"([\w.-]+\.(?:png|jpe?g|gif|webp))", ref, re.I)
        if m:
            non_pdf.append({"filename": m.group(1), "note": "image_stripped"})
    return {
        "timestamp": ts,
        "direction": raw.get("direction"),
        "subject": raw.get("subject"),
        "body_text": body,
        "from": raw.get("from"),
        "to": raw.get("to"),
        "cc": raw.get("cc"),
        "in_reply_to": raw.get("in_reply_to"),
        "references": raw.get("references"),
        "message_id_header": raw.get("message_id_header"),
        "source_row_id": raw.get("source_row_id") or raw.get("message_id"),
        "attachments_non_pdf": non_pdf,
        "images_stripped_count": len(stripped),
        "is_selected": is_selected,
    }


def extract_quote_from_email(body: str, later_hms: dict | None = None) -> dict:
    """Dates/pax/meal from selected quote email; optional rate from linked later HMS."""
    text = body or ""
    out: dict[str, Any] = {}
    # 10 August - 04 September / 10 Aug - 4 Sep 2026 / 2026-08-10
    months = {m: i for i, m in enumerate(
        ["january","february","march","april","may","june","july","august","september","october","november","december"], 1)}
    months.update({m[:3]: i for m, i in months.items()})
    m = re.search(
        r"(\d{1,2})\s+([A-Za-z]+)\s*(?:-|\u2013|to)\s*(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?",
        text, re.I,
    )
    if m:
        year = int(m.group(5) or "2026")
        mo1, mo2 = months.get(m.group(2).lower()[:3]), months.get(m.group(4).lower()[:3])
        if mo1 and mo2:
            out["arrival_date"] = f"{year}-{mo1:02d}-{int(m.group(1)):02d}"
            out["departure_date"] = f"{year}-{mo2:02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{4}-\d{2}-\d{2}).{0,40}(\d{4}-\d{2}-\d{2})", text)
    if m and "arrival_date" not in out:
        out["arrival_date"], out["departure_date"] = m.group(1), m.group(2)
    if re.search(r"\bone person\b|\b1 (?:adult|person|pax)\b", text, re.I):
        out["adults"] = 1
    else:
        m = re.search(r"(\d+)\s*(?:adults?|persons?|pax|people)", text, re.I)
        if m:
            out["adults"] = int(m.group(1))
    m = re.search(r"(\d+)\s*(?:rooms?|×|x)", text, re.I)
    out["quantity"] = int(m.group(1)) if m else 1
    low = text.lower()
    if "breakfast" in low and ("dinner" in low or "supper" in low):
        out["board"] = "DBB"
    elif "bed and breakfast" in low or re.search(r"\bb&b\b|\bbb\b", low):
        out["board"] = "BB"
    elif "dinner" in low:
        out["board"] = "DBB"
    later = (later_hms or {}).get("fields") or {}
    if later.get("rateplan"):
        out["rate_plan"] = {"code": str(later["rateplan"]).strip(), "name": None}
    return out


def history_defaults_for(as_of: str, later: dict, anchors: dict, code_maps: dict) -> dict:
    """Tier2 values staff set on earlier same-org/agency bookings before as_of."""
    company = str(later.get("company") or "").strip().lower()
    agency = str(later.get("ta1") or "").strip().lower()
    if not company and not agency:
        return {}
    hits: dict[str, list[Any]] = {
        "guarantee_type": [], "source_of_business": [], "track": [],
        "rate_plan": [], "billing_reference": [],
    }
    key_map = {
        "guaranteetype": "guarantee_type",
        "guarantee_type": "guarantee_type",
        "sourceofbusiness": "source_of_business",
        "source_of_business": "source_of_business",
        "track": "track",
        "rateplan": "rate_plan",
        "rate_plan": "rate_plan",
        "billingreference": "billing_reference",
        "billing_reference": "billing_reference",
    }
    for conf, anchor in anchors.items():
        fields = anchor.get("hms_fields") or {}
        a_company = str(fields.get("company") or "").strip().lower()
        a_agency = str(fields.get("ta1") or "").strip().lower()
        if company and a_company != company and agency and a_agency != agency:
            continue
        if company and a_company != company and not agency:
            continue
        if agency and a_agency != agency and not company:
            continue
        # Prefer PDF timestamps before as_of as proxy for booking era.
        pdfs = [p for p in (anchor.get("pdfs") or []) if parse_ts(p.get("sent_at")) and parse_ts(p.get("sent_at")) <= as_of]
        if not pdfs and (anchor.get("hms_capture_later") or "") <= as_of:
            pdfs = [{"sent_at": as_of}]
        if not pdfs:
            continue
        for hk, pane in key_map.items():
            if fields.get(hk) not in (None, ""):
                val = fields[hk]
                if pane == "rate_plan":
                    val = _code_name_lookup(code_maps, "rate_plan", code=val) or val
                hits[pane].append(val)
    out = {}
    for pane, vals in hits.items():
        if not vals:
            continue
        # unanimous history only
        norms = {json.dumps(v, sort_keys=True, default=str) if isinstance(v, dict) else str(v).strip().lower() for v in vals}
        if len(norms) == 1:
            out[pane] = vals[0]
    return out


def build_card(gold_row: dict, anchors, stay360, profiles, code_maps) -> dict:
    workflow = gold_row["workflow"]
    src = gold_row["source"]
    conf = gold_row.get("real_confirmation")
    anchor = anchors.get(conf) if conf else None
    stay_row = stay360.get(conf) if conf else None

    msgs = src.get("messages_as_of_cutoff") or []
    # ensure selected is last; all must be dated
    before_raw = msgs[:-1] if len(msgs) > 1 else []
    selected_raw = msgs[-1] if msgs else {
        "timestamp": src.get("input_cutoff"),
        "direction": "inbound",
        "subject": src.get("subject"),
        "body": src.get("body_text"),
        "source_row_id": src.get("selected_message_id"),
    }
    # as_of = selected email received time (owner rule). Fall back to input_cutoff.
    as_of = (
        parse_ts(selected_raw.get("timestamp"))
        or parse_ts(src.get("input_cutoff"))
    )
    if not as_of:
        raise ValueError(f"missing as_of for {gold_row.get('case_id')}")
    selected_raw["timestamp"] = as_of

    base_pdf = None
    if workflow == "amend":
        # prefer decision_time_base_pdf from gold
        dt = gold_row.get("decision_time_base_pdf") or {}
        if dt.get("fields"):
            base_pdf = {
                "sent_at": dt.get("sent_at"),
                "sha256": dt.get("sha256"),
                "pdf_fields": {
                    "guestName": [dt["fields"].get("guest_name")],
                    "arrivalDate": [dt["fields"].get("arrival_date")],
                    "departureDate": [dt["fields"].get("departure_date")],
                    "accommodationType": [dt["fields"].get("room_type_text")],
                    "occupancy": [dt["fields"].get("occupancy_text")],
                    "rateIncludes": [dt["fields"].get("rate_includes_text")],
                    "averageDailyRate": [dt["fields"].get("average_daily_rate_text")],
                    "totalAccommodation": [dt["fields"].get("total_accommodation_text")],
                    "confirmationNumber": [conf],
                },
                "fields": dt["fields"],
            }
        else:
            base_pdf = last_pdf_before(anchor, as_of)
    else:
        base_pdf = last_pdf_before(anchor, as_of)
    context_before = []
    for m in before_raw:
        built = build_message(m)
        if built["timestamp"] is None:
            # keep placeholder for leak guard to catch
            built["timestamp"] = None
        if built["timestamp"] and built["timestamp"] > as_of:
            continue
        # Earlier message PDF text (not only selected).
        earlier_pdfs = []
        msg_ts = built["timestamp"] or as_of
        if anchor:
            for pdf in anchor.get("pdfs") or []:
                sent = parse_ts(pdf.get("sent_at"))
                if not sent or sent > msg_ts:
                    continue
                earlier_pdfs.append({
                    "sent_at": sent,
                    "sha256": pdf.get("sha256"),
                    "filename": pdf.get("filename") or "HRCEN_Confirmation_Letter.pdf",
                    "text": json.dumps(pdf_fields(pdf), ensure_ascii=False)[:20000],
                    "note": "earlier_message_pdf_fields",
                })
        built["pdf_attachments_text"] = earlier_pdfs
        context_before.append(built)
    selected = build_message(selected_raw, is_selected=True)
    selected["message_id"] = src.get("selected_message_id")
    selected["thread_id"] = src.get("thread_id")
    selected["received_at"] = selected["timestamp"] or as_of
    # PDF text only for selected/earlier — from pre-as_of PDFs of this conf
    pdf_texts = []
    if anchor:
        for pdf in anchor.get("pdfs") or []:
            sent = parse_ts(pdf.get("sent_at"))
            if not sent or sent > as_of:
                continue
            # no raw pdftotext here; use structured fields as text stand-in + note
            text = json.dumps(pdf_fields(pdf), ensure_ascii=False)
            pdf_texts.append({
                "sent_at": sent,
                "sha256": pdf.get("sha256"),
                "filename": pdf.get("filename") or "HRCEN_Confirmation_Letter.pdf",
                "text": text[:20000],
                "note": "structured pdf_fields; binary images not passed",
            })
    selected["pdf_attachments_text"] = pdf_texts

    headers = {
        "in_reply_to": selected.get("in_reply_to"),
        "references": selected.get("references"),
        "message_id_header": selected.get("message_id_header"),
    }
    xt = cross_thread(as_of, src.get("thread_id"), conf, headers)
    shown = project_shown(workflow, as_of, conf, anchor, base_pdf)
    raw = hms_raw(conf, anchor, stay_row, profiles, gold_row)
    # Always expose canonical 118 field defs in raw even when stay capture thin.
    by_name = {str(f.get("name")): f for f in raw["record_view"]["fields"] if f.get("name")}
    raw["record_view"]["fields"] = [
        {
            "name": meta["name"],
            "label": meta.get("label"),
            "type": meta.get("type"),
            "value": (by_name.get(meta["name"]) or {}).get("value"),
            "code": meta["name"],
        }
        for meta in STAY360_FIELDS
    ]
    raw["record_view"]["field_count"] = len(raw["record_view"]["fields"])
    raw["record_view"]["canonical"] = 118
    if raw.get("profile") is None:
        raw["profile"] = {"fields": [], "capture_note": "no_matched_profile"}
    p_by = {
        str(f.get("name")): f
        for f in (raw["profile"].get("fields") or [])
        if isinstance(f, dict) and f.get("name")
    }
    raw["profile"]["fields"] = [
        {
            "name": meta["name"],
            "label": meta.get("label"),
            "xtype": meta.get("xtype"),
            "value": (p_by.get(meta["name"]) or {}).get("value", (p_by.get(meta["name"]) or {}).get("rawValue")),
            "code": meta["name"],
        }
        for meta in PROFILE_FIELDS
    ]
    raw["profile"]["field_count"] = 65
    profile = raw.get("profile")
    group = AMEND_GROUP if (workflow == "amend" and conf in GROUP_AMEND_CONFS) else None
    # Enrich gold_row with bench-only hints (not persisted as separate top-level unless useful).
    enriched = dict(gold_row)
    if workflow == "filing":
        # Match filename when possible; else first selected PDF = pdf-0.
        fa = gold_row.get("filing_attachment") or {}
        want = (fa.get("filename") or "").lower()
        bench_id = "pdf-0"
        for i, pdf in enumerate(selected.get("pdf_attachments_text") or []):
            if want and want in str(pdf.get("filename") or "").lower():
                bench_id = f"pdf-{i}"
                break
        if not (selected.get("pdf_attachments_text") or []) and (context_before):
            # fall back to earlier message PDFs
            for msg in context_before:
                for i, pdf in enumerate(msg.get("pdf_attachments_text") or []):
                    bench_id = f"pdf-{i}"
                    break
        enriched["_bench_attachment_id"] = bench_id
    if workflow == "quote":
        enriched["_quote_from_email"] = extract_quote_from_email(
            selected.get("body_text") or "", gold_row.get("later_hms")
        )
        # If linked confirmation has later HMS, use its rate.
        if conf and stay360.get(conf):
            pass
        elif conf and anchors.get(conf):
            enriched.setdefault("_quote_from_email", {})
            hf = (anchors[conf].get("hms_fields") or {})
            if hf.get("rateplan") and "rate_plan" not in enriched["_quote_from_email"]:
                enriched["_quote_from_email"]["rate_plan"] = _code_name_lookup(
                    code_maps, "rate_plan", code=hf["rateplan"]
                ) or {"code": hf["rateplan"], "name": None}
    later_fields = ((gold_row.get("later_hms") or {}).get("fields")) or {}
    if workflow == "create" and later_fields:
        enriched["_history_defaults"] = history_defaults_for(as_of, later_fields, anchors, code_maps)

    gold, omitted = exhaustive_gold(
        workflow,
        enriched,
        shown.get("stay"),
        code_maps,
        raw["record_view"]["fields"],
        profile,
        group_bookings=group,
    )

    card = {
        "case_id": gold_row["case_id"],
        "workflow": workflow,
        "real_confirmation": conf,
        "as_of": as_of,
        "selected_email": selected,
        "context_before": context_before,
        "cross_thread_context": xt,
        "context_after": context_after(as_of, conf, anchor, gold_row),
        "hms_raw": raw,
        "hms_shown": shown,
        "gold": gold,
        "omitted": omitted,
        "group_bookings": group,
        "evidence_limits": gold_row.get("evidence_limits"),
        "card_fixes": [
            "backdated_hms_shown_from_last_pre_as_of_pdf",
            "dated_messages_leak_guard_fails_null_dates",
            "rank2_this_case_conf_only",
            "exhaustive_gold_118_stay360_65_profile_all_pane",
            "full_hms_raw",
            "group_amend_lists_every_booking",
            "hidden_after_filled",
            "images_stripped",
            "luna_only_no_cassette_no_save_sim",
        ],
    }
    strip_gold_conf_inputs(card)
    card["leak_guard"] = leak_guard(card)
    return card


def render_md(card: dict) -> str:
    lines = [
        f"# Case `{card['case_id']}` — {card['workflow']}",
        "",
        f"- **as_of**: {card['as_of']}",
        f"- **confirmation**: {card.get('real_confirmation')}",
        f"- **leak_guard**: `{json.dumps(card['leak_guard'])}`",
        f"- **hms_shown.basis**: {card['hms_shown'].get('basis')} pdf@{card['hms_shown'].get('basis_pdf_sent_at')}",
        f"- **hms_shown.exists**: {card['hms_shown'].get('exists')}",
        f"- **cross_thread**: {len(card['cross_thread_context'])} (rank2 conf-only)",
        f"- **context_after messages**: {len((card.get('context_after') or {}).get('messages') or [])}",
        f"- **gold fields**: {len(card['gold'])} "
        f"(expected={sum(1 for g in card['gold'] if g['expectation']=='expected')} "
        f"not_expected={sum(1 for g in card['gold'] if g['expectation']=='not_expected')} "
        f"no_gold={sum(1 for g in card['gold'] if g['expectation']=='no_gold')})",
        f"- **omitted**: {len(card.get('omitted') or [])}",
        f"- **record_view fields in raw**: {card['hms_raw']['record_view']['field_count']}",
        f"- **profile fields in raw**: {(card['hms_raw'].get('profile') or {}).get('field_count')}",
        "",
        "## 1. Selected email",
        f"**Subject:** {card['selected_email'].get('subject')}",
        f"**timestamp:** {card['selected_email'].get('timestamp')}",
        f"**images_stripped:** {card['selected_email'].get('images_stripped_count')}",
        "",
        "```",
        (card["selected_email"].get("body_text") or "")[:3500],
        "```",
        "",
        f"PDF attachments (text): {len(card['selected_email'].get('pdf_attachments_text') or [])}",
        f"Non-PDF filenames: {card['selected_email'].get('attachments_non_pdf')}",
        "",
        "## 2. Context before",
    ]
    for m in card["context_before"]:
        lines.append(f"- {m.get('timestamp')} {m.get('direction')} {m.get('subject')}")
    lines += ["", "## 3. Cross-thread context"]
    for link in card["cross_thread_context"][:10]:
        lines.append(
            f"- rank {link['rank']} `{link['reason']}` conf={link.get('matched_confirmation')} "
            f"thread `{link['thread_id']}` msgs={len(link['messages'])}"
        )
    lines += [
        "",
        "## 4. Context after (hidden)",
        f"messages={len(card['context_after'].get('messages') or [])} "
        f"pdfs={len(card['context_after'].get('confirmation_pdfs') or [])}",
        "",
        "## 5. HMS raw",
        f"record_view fields={card['hms_raw']['record_view']['field_count']}",
        f"pdf versions={len(card['hms_raw'].get('pdf_versions') or [])}",
        f"profile_id={(card['hms_raw'].get('profile') or {}).get('nativeId')}",
        "",
        "## 6. HMS shown (backdated)",
        f"```json\n{json.dumps(card['hms_shown'], indent=2, ensure_ascii=False)[:2000]}\n```",
        "",
        "## 7. Gold (ALL fields)",
    ]
    for g in card["gold"]:
        if g["expectation"] == "expected":
            lines.append(f"- **expected** `{g['path']}` = `{json.dumps(g.get('value'), ensure_ascii=False)}` ({g['basis']})")
        else:
            lines.append(f"- **{g['expectation']}** `{g['path']}` ({g['basis']})")
    if card.get("omitted"):
        lines += ["", "## Omitted (must have reason)"]
        for row in card["omitted"]:
            lines.append(f"- `{row.get('path')}` — {row.get('reason')}")
    if card.get("group_bookings"):
        lines += ["", "## Group bookings (amend all guests)", json.dumps(card["group_bookings"], indent=2)]
    return "\n".join(lines) + "\n"


def main():
    anchors, stay360, profiles, code_maps = load_world()
    creates = load_jsonl(DATA / "gold/create-pilot-v3.jsonl")
    amends = load_jsonl(DATA / "gold/amend-reviewed-dedup-v6.jsonl")
    create_row = next(r for r in creates if r["case_id"] == "p4-create-18d366412daec8827a02" or r.get("real_confirmation") == "14298500-1")
    # prefer exact sample id if present
    create_row = next((r for r in creates if r["case_id"] == "p4-create-18d366412daec8827a02"), create_row)
    amend_row = next(r for r in amends if r["case_id"] == "p4-amend-0d54e605fe6f00c6ee77")

    OUT.mkdir(parents=True, exist_ok=True)
    summaries = []
    for row in (create_row, amend_row):
        card = build_card(row, anchors, stay360, profiles, code_maps)
        d = OUT / card["case_id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "case.json").write_text(json.dumps(card, indent=2, ensure_ascii=False))
        (d / "case.md").write_text(render_md(card))
        stay = (card.get("hms_shown") or {}).get("stay") or {}
        summaries.append(
            f"## {card['workflow'].upper()} {card['case_id']}\n"
            f"path: {d / 'case.md'}\n"
            f"as_of={card['as_of']} conf={card.get('real_confirmation')}\n"
            f"leak_ok={card['leak_guard']['ok']} leaks={card['leak_guard']['leaks']}\n"
            f"shown.exists={card['hms_shown'].get('exists')} basis={card['hms_shown'].get('basis')} "
            f"pdf@{card['hms_shown'].get('basis_pdf_sent_at')}\n"
            f"shown.departure={stay.get('departure_date')} shown.status={stay.get('status')}\n"
            f"before={len(card['context_before'])} xt={len(card['cross_thread_context'])} "
            f"after_msgs={len(card['context_after'].get('messages') or [])} gold={len(card['gold'])} "
            f"rv={card['hms_raw']['record_view']['field_count']}\n"
            f"group={card.get('group_bookings')}\n"
        )
        print("WROTE", d, "leak", card["leak_guard"])
    (OUT / "SUMMARY.txt").write_text("\n".join(summaries))
    print(open(OUT / "SUMMARY.txt").read())


if __name__ == "__main__":
    main()
