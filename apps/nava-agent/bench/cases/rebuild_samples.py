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
IMG_RE = re.compile(
    r"(?is)(<img\b[^>]*>|\[cid:[^\]]+\]|cid:[^\s\"'<>]+|data:image/[^;]+;base64,[a-z0-9+/=]+|"
    r"https?://\S+\.(?:png|jpe?g|gif|webp)|\b[\w.-]+\.(?:png|jpe?g|gif|webp)\b)"
)

CREATE_PANE = [
    "room_count", "arrival_date", "departure_date", "adults", "child_count", "child_ages",
    "room_type", "rate_plan", "guarantee_type", "source_of_business", "track",
    "guest_profile_id", "first_name", "last_name", "guest_email", "profile_create_new",
    "profile_mobile", "profile_email", "agency_name", "agency_id", "organization_name",
    "organization_id", "ar_account_name", "ar_account_id", "billing_reference",
    "booker_name", "booker_contact", "reason_for_stay", "note", "guest_opt_in",
    "cms_send", "cms_message_id", "cms_recipient", "price",
]
AMEND_PANE = [
    "arrival_date", "departure_date", "adults", "room_type", "rate_plan",
    "first_name", "last_name", "guest_email", "booker_name", "booker_contact",
    "billing_reference", "reservation_note", "cms_send", "cms_message_id", "cms_recipient",
]

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
    if workflow == "create":
        # should not reach if absent; if reached, still PDF-only
        pass
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


def exhaustive_gold(workflow: str, gold_row: dict, shown_stay: dict | None, code_maps: dict, rv_fields: list[dict], profile: dict | None) -> list[dict]:
    fields: list[dict] = []
    seen = set()

    def add(path: str, expectation: str, value=None, basis: str = "", **extra):
        if path in seen:
            return
        seen.add(path)
        row = {"path": path, "expectation": expectation, "basis": basis, **extra}
        if expectation == "expected":
            row["value"] = value
        fields.append(row)

    rbf = gold_row.get("resolved_base_fields") or {}
    fp = ((gold_row.get("first_pdf") or {}).get("fields")) or ((gold_row.get("decision_time_base_pdf") or {}).get("fields")) or {}
    am = (gold_row.get("amendment") or {}).get("changes") or {}

    # Pane fields
    pane = CREATE_PANE if workflow == "create" else AMEND_PANE
    for key in pane:
        path = f"/bookings/0/fields/{key}"
        if key in am:
            ch = am[key]
            add(path, "expected", ch.get("after"), "reviewed", before=ch.get("before"))
            continue
        if workflow == "create":
            if key == "room_type":
                val = rbf.get("room_type")
                if isinstance(val, dict) and val.get("code"):
                    add(path, "expected", {"code": val["code"], "name": val.get("meaning") or code_maps["room_type"].get(val["code"])}, val.get("basis") or "first_pdf")
                else:
                    add(path, "not_expected", basis="no_unique_room_code_in_inputs")
                continue
            if key == "rate_plan":
                val = rbf.get("rate_plan")
                if isinstance(val, dict) and val.get("code"):
                    add(path, "expected", {"code": val["code"], "name": val.get("meaning") or code_maps["rate_plan"].get(val["code"])}, "first_pdf")
                else:
                    add(path, "not_expected", basis=rbf.get("rate_plan_reason") or "no_unique_rate_plan")
                continue
            if key == "organization_name":
                org = rbf.get("organization")
                if isinstance(org, dict) and (org.get("code") or org.get("name")):
                    code = str(org.get("code") or org.get("nativeId") or "")
                    add(path, "expected", {"code": code, "name": org.get("name") or org.get("meaning") or code_maps["organization"].get(code)}, "first_pdf")
                elif fp.get("company_text"):
                    # try map name
                    name = fp["company_text"]
                    code = None
                    for c, n in code_maps["organization"].items():
                        if n and str(n).lower() == str(name).lower():
                            code = c
                            break
                    add(path, "expected", {"code": code, "name": name}, "first_pdf")
                else:
                    add(path, "not_expected", basis="organization_not_in_inputs")
                continue
            if key == "agency_name":
                ag = rbf.get("agency")
                if isinstance(ag, dict) and (ag.get("code") or ag.get("name")):
                    code = str(ag.get("code") or ag.get("nativeId") or "")
                    add(path, "expected", {"code": code, "name": ag.get("name") or ag.get("meaning") or code_maps["agency"].get(code)}, "first_pdf")
                elif fp.get("agency_text"):
                    name = fp["agency_text"]
                    code = None
                    for c, n in code_maps["agency"].items():
                        if n and str(n).lower() == str(name).lower():
                            code = c
                            break
                    add(path, "expected", {"code": code, "name": name}, "first_pdf")
                else:
                    add(path, "not_expected", basis="agency_not_in_inputs")
                continue
            if key == "arrival_date" and fp.get("arrival_date"):
                add(path, "expected", fp["arrival_date"], "first_pdf")
                continue
            if key == "departure_date" and fp.get("departure_date"):
                add(path, "expected", fp["departure_date"], "first_pdf")
                continue
            if key == "adults" and fp.get("adults") is not None:
                add(path, "expected", fp["adults"], "first_pdf")
                continue
            if key == "child_count" and fp.get("children") is not None:
                add(path, "expected", fp["children"], "first_pdf")
                continue
            if key in ("first_name", "last_name") and fp.get("guest_name"):
                parts = str(fp["guest_name"]).split()
                if key == "first_name" and parts:
                    add(path, "expected", parts[0], "first_pdf")
                    continue
                if key == "last_name" and parts:
                    add(path, "expected", parts[-1], "first_pdf")
                    continue
            if key in ("guarantee_type", "source_of_business", "track", "cms_send", "cms_message_id", "room_count"):
                add(path, "no_gold", basis="default_or_staff_only")
                continue
            if key in ("guest_email", "profile_mobile", "profile_email", "billing_reference", "note", "reason_for_stay"):
                add(path, "not_expected", basis="not_knowable_from_shown_inputs_at_as_of")
                continue
        if key in ("guest_email",) or "address" in key:
            add(path, "not_expected", basis="address_or_contact_before_arrival")
            continue
        add(path, "no_gold", basis="no_labelled_truth")

    # classic address
    add("/bookings/0/fields/guest_address", "not_expected", basis="address_before_arrival")
    if workflow == "create":
        add("/bookings/0/fields/confirmation", "no_gold", basis="create_has_no_confirmation_yet")
    if workflow == "amend" and gold_row.get("real_confirmation"):
        add("/bookings/0/reservation_id", "expected", gold_row["real_confirmation"], "reviewed")

    # All 118 record-view fields
    for f in rv_fields:
        name = f.get("name") or "unknown"
        path = f"/hms/record_view/{name}"
        label = f.get("label")
        # For amend/create gold: most later HMS values are no_gold / not_expected at as_of
        if workflow == "amend" and name in ("departuredate",) and "departure_date" in am:
            add(path, "expected", {
                "code": None,
                "name": label,
                "value": am["departure_date"]["after"],
            }, "reviewed", before=am["departure_date"]["before"])
            continue
        if name in ("streetaddress", "city", "postalcode", "address", "emailaddress"):
            add(path, "not_expected", basis="address_or_email_before_arrival")
            continue
        if workflow == "create":
            add(path, "no_gold", basis="create_booking_absent_at_as_of")
        else:
            # knowable only if mirrored in pre-as_of PDF shown stay
            shown_keys = set((shown_stay or {}).keys())
            if name in ("confirmationnumber",) and gold_row.get("real_confirmation"):
                add(path, "expected", {"code": gold_row["real_confirmation"], "name": label, "value": gold_row["real_confirmation"]}, "reviewed")
            elif name in ("arrivaldate", "departuredate", "adults", "roomtype", "rateplan", "status", "guestfullname"):
                # mapped via PDF for current state (shown), gold for change fields already handled
                if name == "departuredate" and "departure_date" in am:
                    continue
                add(path, "no_gold", basis="shown_from_pdf_but_staff_truth_not_labelled_beyond_amendment")
            else:
                add(path, "no_gold", basis="later_record_view_unlabelled_at_as_of")

    # Profile fields
    for f in (profile or {}).get("fields") or []:
        name = f.get("name") or "unknown"
        path = f"/hms/profile/{name}"
        if name in ("streetaddress", "city", "postalcode", "stateprovincedesc", "countrydesc", "emailaddress", "phonenumber", "mobilenumber", "birthdateforprofile"):
            add(path, "not_expected", basis="profile_pii_not_knowable_from_email_at_as_of")
        else:
            add(path, "no_gold", basis="profile_snapshot_later_unlabelled")

    # code+name enrichment for room/rate on shown PDF text
    if shown_stay and shown_stay.get("room_type_text"):
        # map meaning -> code
        meaning = shown_stay["room_type_text"]
        code = None
        for c, n in code_maps["room_type"].items():
            if n and str(n).lower() == str(meaning).lower():
                code = c
                break
        add("/bookings/0/fields/room_type_from_pdf", "expected" if workflow != "create" else "not_expected",
            {"code": code, "name": meaning} if workflow != "create" else None,
            basis="last_pre_as_of_pdf" if workflow != "create" else "create_absent")

    return fields


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
    profile = raw.get("profile")
    gold = exhaustive_gold(workflow, gold_row, shown.get("stay"), code_maps, raw["record_view"]["fields"], profile)

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
        "group_bookings": AMEND_GROUP if workflow == "amend" else None,
        "evidence_limits": gold_row.get("evidence_limits"),
        "card_fixes": [
            "backdated_hms_shown_from_last_pre_as_of_pdf",
            "dated_messages_leak_guard_fails_null_dates",
            "rank2_this_case_conf_only",
            "exhaustive_gold_record_profile_pane_code_name",
            "full_hms_raw",
            "group_amend_lists_every_booking",
            "hidden_after_filled",
            "images_stripped",
        ],
    }
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
        f"- **gold fields**: {len(card['gold'])}",
        f"- **record_view fields in raw**: {card['hms_raw']['record_view']['field_count']}",
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
        "## 7. Gold (excerpt expected)",
    ]
    for g in card["gold"]:
        if g["expectation"] == "expected":
            lines.append(f"- **expected** `{g['path']}` = `{g.get('value')}` ({g['basis']})")
    lines.append("")
    lines.append(f"not_expected/no_gold counts: "
                 f"{sum(1 for g in card['gold'] if g['expectation']=='not_expected')}/"
                 f"{sum(1 for g in card['gold'] if g['expectation']=='no_gold')}")
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
