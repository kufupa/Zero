#!/usr/bin/env python3
"""Deterministic P4 lead generation (R1-R8 + billing/caller) and Arm-0 baseline."""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from tools import connect

EMAIL_RE = re.compile(r"[A-Z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+", re.I)
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
INTERNAL_DOMAINS = {"legacyhotels.co.za", "legacyhotels.com", "legacygroup.co.za"}
GENERIC_ORG_WORDS = {"the", "pty", "ltd", "limited", "cc", "inc", "company", "co", "and"}

ROUTE_SCORE = {
    "R1": 70,   # exact confirmation in body/subject/doc
    "R2": 85,   # confirmation-letter recipient -> prior inbound
    "R3": 90,   # HMS email address -> inbound
    "R4": 60,   # agency/company-like sender domain + surname
    "R5": 45,   # hotel-internal forward containing surname/conf
    "R6": 20,   # header neighbour
    "R7": 80,   # surname/fuzzy + stay dates in body
    "R8": 35,   # outbound staff reply/proforma to lead address
    "R9": 75,   # billing reference lookup
    "R10": 65,  # caller lookup
}


def parse_dt(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def strip_msg(value: str) -> str:
    return value[4:] if value.startswith("msg:") else value


def surname_of(guest_name: str | None) -> str:
    tokens = TOKEN_RE.findall(guest_name or "")
    if not tokens:
        return ""
    return tokens[-1].strip("'-").lower()


def tokens_of(text: str | None) -> list[str]:
    return [token.strip("'-").lower() for token in TOKEN_RE.findall(text or "") if token.strip("'-")]


def edit_distance_one_or_less(a: str, b: str) -> bool:
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        return sum(x != y for x, y in zip(a, b)) <= 1
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    i = j = edits = 0
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        else:
            edits += 1
            j += 1
            if edits > 1:
                return False
    return True


def fuzzy_token_match(needle: str, token: str) -> bool:
    if not needle or not token:
        return False
    if needle == token:
        return True
    if min(len(needle), len(token)) < 4:
        return False
    return edit_distance_one_or_less(needle, token) or difflib.SequenceMatcher(None, needle, token).ratio() >= 0.84


def emails_in(value: str | None) -> list[str]:
    return sorted(set(match.group(0).lower() for match in EMAIL_RE.finditer(value or "")))


def domain_of(address: str | None) -> str:
    found = emails_in(address)
    if not found:
        return ""
    return found[0].split("@", 1)[1].lower()


def org_key(value: str | None) -> str:
    words = [word for word in re.findall(r"[a-z0-9]+", (value or "").lower()) if word not in GENERIC_ORG_WORDS]
    return "".join(words)


def domain_key(domain: str) -> str:
    parts = [part for part in domain.lower().split(".") if part]
    if not parts:
        return ""
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "gov"}:
        core = parts[-3]
    elif len(parts) >= 2:
        core = parts[-2]
    else:
        core = parts[0]
    return re.sub(r"[^a-z0-9]", "", core)


def domain_matches_org(domain: str, orgs: list[str]) -> str | None:
    key = domain_key(domain)
    if not key or len(key) < 4:
        return None
    for org in orgs:
        okey = org_key(org)
        if not okey or len(okey) < 4:
            continue
        if key in okey or okey in key or difflib.SequenceMatcher(None, key, okey).ratio() >= 0.68:
            return org
    return None


def is_internal(address: str | None) -> bool:
    return domain_of(address) in INTERNAL_DOMAINS


def in_window(row: sqlite3.Row, window_from: str, window_to: str) -> bool:
    sent = row["sent_at"] or ""
    return window_from <= sent <= window_to


def window_bounds(stay: sqlite3.Row, ctx: dict[str, Any] | None) -> tuple[str, str]:
    ctx = ctx or {}
    created = parse_dt(stay["created_at"])
    if created is None:
        created = datetime(1970, 1, 1, tzinfo=timezone.utc)
    default_from = iso_z(created - timedelta(days=30))
    default_to = iso_z(created + timedelta(hours=48))
    return str(ctx.get("window_from") or default_from), str(ctx.get("window_to") or default_to)


def load_stay(con: sqlite3.Connection, confirmation: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM hms_stay WHERE confirmation=?", [confirmation]).fetchone()


def _fetch_message(con: sqlite3.Connection, message_id: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM message WHERE id=?", [message_id]).fetchone()


def _window_rows(con: sqlite3.Connection, window_from: str, window_to: str, direction: str | None = None) -> list[sqlite3.Row]:
    sql = "SELECT * FROM message WHERE sent_at >= ? AND sent_at <= ?"
    params: list[Any] = [window_from, window_to]
    if direction:
        sql += " AND direction=?"
        params.append(direction)
    sql += " ORDER BY sent_at,id"
    return list(con.execute(sql, params))


def _rows_containing_any(
    con: sqlite3.Connection,
    window_from: str,
    window_to: str,
    needles: list[str],
    direction: str | None = None,
) -> list[sqlite3.Row]:
    clean = [str(item) for item in needles if str(item)]
    if not clean:
        return []
    pieces = []
    params: list[Any] = [window_from, window_to]
    for needle in clean:
        pieces.append("(instr(lower(COALESCE(subject,'')), lower(?))>0 OR instr(lower(COALESCE(body_text,'')), lower(?))>0)")
        params.extend([needle, needle])
    sql = "SELECT * FROM message WHERE sent_at>=? AND sent_at<=? AND (" + " OR ".join(pieces) + ")"
    if direction:
        sql += " AND direction=?"
        params.append(direction)
    sql += " ORDER BY sent_at,id"
    return list(con.execute(sql, params))


def _contains_text(row: sqlite3.Row, needle: str, body_only: bool = False) -> bool:
    if not needle:
        return False
    haystacks = [row["body_text"] or ""]
    if not body_only:
        haystacks.append(row["subject"] or "")
    needle_lower = needle.lower()
    return any(needle_lower in haystack.lower() for haystack in haystacks)


def date_variants(arrival: str | None, departure: str | None) -> list[str]:
    try:
        a = datetime.fromisoformat(str(arrival)[:10])
        d = datetime.fromisoformat(str(departure)[:10])
    except ValueError:
        return []
    months_full = [None, "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    months_short = [None, "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    variants = {
        a.strftime("%Y-%m-%d"), d.strftime("%Y-%m-%d"),
        f"{a.day} {months_full[a.month]} {a.year}", f"{d.day} {months_full[d.month]} {d.year}",
        f"{a.day:02d} {months_full[a.month]} {a.year}", f"{d.day:02d} {months_full[d.month]} {d.year}",
        f"{a.day} {months_short[a.month]} {a.year}", f"{d.day} {months_short[d.month]} {d.year}",
        f"{a.day:02d} {months_short[a.month]} {a.year}", f"{d.day:02d} {months_short[d.month]} {d.year}",
    }
    if a.month == d.month and a.year == d.year:
        variants.add(f"{a.day}-{d.day} {months_full[a.month]}")
        variants.add(f"{a.day}-{d.day} {months_short[a.month]}")
        variants.add(f"{a.day} to {d.day} {months_full[a.month]}")
        variants.add(f"{a.day} to {d.day} {months_short[a.month]}")
    return sorted(variants)


def has_stay_dates(body: str, arrival: str | None, departure: str | None) -> bool:
    lower = (body or "").lower()
    return any(variant.lower() in lower for variant in date_variants(arrival, departure))


def _add(candidates: dict[str, dict[str, Any]], row: sqlite3.Row, route: str, why: str) -> None:
    mid = row["id"]
    entry = candidates.setdefault(mid, {
        "row": row,
        "routes": [],
        "why": [],
        "route_scores": {},
    })
    if route not in entry["routes"]:
        entry["routes"].append(route)
        entry["route_scores"][route] = ROUTE_SCORE.get(route, 0)
    if why not in entry["why"]:
        entry["why"].append(why)


def _finalize(candidates: dict[str, dict[str, Any]], cap: int = 25) -> list[dict[str, Any]]:
    rows = []
    for mid, entry in candidates.items():
        row = entry["row"]
        ordered_routes = sorted(entry["routes"], key=lambda route: (-ROUTE_SCORE.get(route, 0), route))
        score = max(entry["route_scores"].values(), default=0)
        score += 4 * (len(entry["routes"]) - 1)
        if row["direction"] == "inbound":
            score += 5
        rows.append((mid, score, row["sent_at"] or "", ordered_routes[0] if ordered_routes else "", entry))
    rows.sort(key=lambda item: (-item[1], item[2], item[0]))
    return [
        {"id": "msg:" + mid, "route": route, "why": "; ".join(entry["why"])}
        for mid, _score, _sent, route, entry in rows[:cap]
    ]


def generate_leads(
    confirmation: str,
    ctx: dict[str, Any] | None = None,
    db: str | None = None,
    cap: int = 25,
    include_r1: bool = True,
    with_details: bool = False,
) -> list[dict[str, Any]]:
    """Return ranked deterministic seeds, each exactly {id, route, why} unless with_details."""
    ctx = dict(ctx or {})
    con = connect(db, ctx)
    try:
        stay = load_stay(con, confirmation)
        if stay is None:
            return []
        window_from, window_to = window_bounds(stay, ctx)
        created = parse_dt(stay["created_at"])
        guest = stay["guest_name"] or ""
        surname = surname_of(guest)
        candidates: dict[str, dict[str, Any]] = {}

        def rows_for_sql(sql: str, params: list[Any]) -> list[sqlite3.Row]:
            return list(con.execute(sql, params))

        # R1: confirmation key in body/subject/document. P3 rows are trusted precomputed keys;
        # direct text scans keep the fixture and lazy-doc path useful too.
        if include_r1 and confirmation:
            p3_rows = rows_for_sql(
                "SELECT DISTINCT m.*, pk.source AS hit_source FROM p3_key pk JOIN message m ON m.id=pk.message_id "
                "WHERE pk.confirmation=? AND m.sent_at>=? AND m.sent_at<=?",
                [confirmation, window_from, window_to],
            )
            for row in p3_rows:
                _add(candidates, row, "R1", f"R1 exact confirmation in {row['hit_source'] or 'P3 key'}")
            direct_rows = rows_for_sql(
                "SELECT * FROM message WHERE sent_at>=? AND sent_at<=? AND "
                "(instr(lower(COALESCE(subject,'')), lower(?))>0 OR instr(lower(COALESCE(body_text,'')), lower(?))>0)",
                [window_from, window_to, confirmation, confirmation],
            )
            for row in direct_rows:
                _add(candidates, row, "R1", "R1 exact confirmation in subject/body")
            doc_rows = rows_for_sql(
                "SELECT DISTINCT m.*, a.id AS attachment_hit FROM doc_text d JOIN attachment a ON a.id=d.attachment_id "
                "JOIN message m ON m.id=a.message_id WHERE instr(lower(COALESCE(d.text,'')), lower(?))>0 "
                "AND m.sent_at>=? AND m.sent_at<=?",
                [confirmation, window_from, window_to],
            )
            for row in doc_rows:
                _add(candidates, row, "R1", f"R1 exact confirmation in document {row['attachment_hit']}")

        # R2: outbound confirmation-letter recipient -> inbound from that recipient in [-72h,0] of the letter.
        outbound_rows = rows_for_sql(
            "SELECT DISTINCT m.* FROM message m WHERE m.direction='outbound' AND m.sent_at>=? AND m.sent_at<=? AND "
            "(instr(lower(COALESCE(m.subject,'')), lower(?))>0 OR instr(lower(COALESCE(m.body_text,'')), lower(?))>0 "
            " OR EXISTS(SELECT 1 FROM p3_key pk WHERE pk.message_id=m.id AND pk.confirmation=?) "
            " OR EXISTS(SELECT 1 FROM attachment a JOIN doc_text d ON d.attachment_id=a.id WHERE a.message_id=m.id AND instr(lower(COALESCE(d.text,'')), lower(?))>0))",
            [window_from, window_to, confirmation, confirmation, confirmation, confirmation],
        )
        for letter in outbound_rows:
            recipients = emails_in((letter["to_addrs"] or "") + " " + (letter["cc_addrs"] or ""))
            letter_sent = parse_dt(letter["sent_at"])
            if letter_sent is None:
                continue
            since = iso_z(letter_sent - timedelta(hours=72))
            for recipient in recipients:
                prior = rows_for_sql(
                    "SELECT * FROM message WHERE direction='inbound' AND lower(COALESCE(from_addr,'')) LIKE ? "
                    "AND sent_at>=? AND sent_at<=? ORDER BY sent_at",
                    ["%" + recipient + "%", since, letter["sent_at"]],
                )
                for row in prior:
                    _add(candidates, row, "R2", f"R2 inbound from confirmation-letter recipient {recipient} within 72h before {letter['id']}")

        # R3: HMS email_address -> inbound from it.
        hms_email = (stay["email_address"] or "").strip().lower()
        if hms_email:
            for row in rows_for_sql(
                "SELECT * FROM message WHERE direction='inbound' AND lower(COALESCE(from_addr,'')) LIKE ? AND sent_at>=? AND sent_at<=? ORDER BY sent_at",
                ["%" + hms_email + "%", window_from, window_to],
            ):
                _add(candidates, row, "R3", f"R3 inbound from HMS email address {hms_email}")

        # R4: sender domain ~ company/travel_agent + surname.
        orgs = [value for value in [stay["company"], stay["travel_agent"]] if isinstance(value, str) and value.strip()]
        if surname and orgs:
            for row in _rows_containing_any(con, window_from, window_to, [surname], "inbound"):
                if surname not in ((row["subject"] or "") + "\n" + (row["body_text"] or "")).lower():
                    continue
                matched = domain_matches_org(domain_of(row["from_addr"]), orgs)
                if matched:
                    _add(candidates, row, "R4", f"R4 sender domain matches {matched!r} and surname {surname!r} present")

        # R5: hotel-internal forwards containing surname or confirmation.
        for row in _rows_containing_any(con, window_from, window_to, [surname, confirmation], "inbound"):
            subject = (row["subject"] or "").lower()
            body = row["body_text"] or ""
            forwardish = subject.startswith(("fwd:", "fw:")) or "forwarded message" in body.lower()
            if not forwardish or not is_internal(row["from_addr"]):
                continue
            hit = confirmation and _contains_text(row, confirmation)
            name_hit = surname and surname in ((row["subject"] or "") + "\n" + body).lower()
            if hit or name_hit:
                thing = "confirmation" if hit else "surname"
                _add(candidates, row, "R5", f"R5 hotel-internal forward contains {thing}")

        # R7: surname/fuzzy token + stay dates in body. Prefix prefilter keeps this cheap on the real snapshot.
        if surname:
            prefix = surname[:max(3, min(5, len(surname) - 1))]
            possible = [row for row in _rows_containing_any(con, window_from, window_to, [prefix], "inbound") if prefix in (row["body_text"] or "").lower()]
            for row in possible:
                body = row["body_text"] or ""
                if not has_stay_dates(body, stay["arrival"], stay["departure"]):
                    continue
                match = next((token for token in tokens_of(body) if fuzzy_token_match(surname, token)), "")
                if match:
                    fuzzy = "exact" if match == surname else f"fuzzy token {match!r}"
                    _add(candidates, row, "R7", f"R7 surname {fuzzy} plus stay dates in body")

        # R9/R10: billing_reference and caller lookups.
        billing = (stay["billing_reference"] or "").strip()
        if billing:
            for row in _rows_containing_any(con, window_from, window_to, [billing]):
                _add(candidates, row, "R9", f"R9 billing_reference {billing!r} in subject/body")
        caller = (stay["caller"] or "").strip()
        if caller and len(caller) >= 5:
            for row in _rows_containing_any(con, window_from, window_to, [caller]):
                _add(candidates, row, "R10", f"R10 caller {caller!r} in subject/body")

        # R6: direct header neighbours of any current lead; one expansion only.
        if not ctx.get("disable_headers") and candidates:
            lead_ids = sorted(candidates)
            marks = ",".join("?" for _ in lead_ids)
            edge_rows = list(con.execute(
                f"SELECT src_id,dst_id,kind FROM header_edge WHERE src_id IN ({marks}) OR dst_id IN ({marks})",
                lead_ids + lead_ids,
            ))
            for edge in edge_rows:
                src_hit = edge["src_id"] in candidates
                other = edge["dst_id"] if src_hit else edge["src_id"]
                base = edge["src_id"] if src_hit else edge["dst_id"]
                row = _fetch_message(con, other)
                if row is not None and in_window(row, window_from, window_to):
                    _add(candidates, row, "R6", f"R6 {edge['kind']} header neighbour of {base}")

        # R8: outbound staff replies/proformas to addresses already discovered on inbound leads.
        lead_addresses = sorted({
            address
            for entry in candidates.values()
            if entry["row"]["direction"] == "inbound"
            for address in emails_in(entry["row"]["from_addr"])
            if not is_internal(address)
        })
        for address in lead_addresses:
            for row in rows_for_sql(
                "SELECT * FROM message WHERE direction='outbound' AND lower(COALESCE(to_addrs,'') || ' ' || COALESCE(cc_addrs,'')) LIKE ? "
                "AND sent_at>=? AND sent_at<=? ORDER BY sent_at LIMIT 8",
                ["%" + address + "%", window_from, window_to],
            ):
                text = ((row["subject"] or "") + "\n" + (row["body_text"] or "")).lower()
                kind = "proforma" if "proforma" in text else "staff reply"
                _add(candidates, row, "R8", f"R8 outbound {kind} to lead address {address}")

        detailed = []
        for mid, entry in candidates.items():
            row = entry["row"]
            ordered_routes = sorted(entry["routes"], key=lambda route: (-ROUTE_SCORE.get(route, 0), route))
            score = max(entry["route_scores"].values(), default=0) + 4 * (len(entry["routes"]) - 1) + (5 if row["direction"] == "inbound" else 0)
            detailed.append({
                "id": "msg:" + mid,
                "message_id": mid,
                "route": ordered_routes[0] if ordered_routes else "",
                "routes": ordered_routes,
                "score": score,
                "sent_at": row["sent_at"],
                "direction": row["direction"],
                "why": "; ".join(entry["why"]),
            })
        detailed.sort(key=lambda item: (-int(item["score"]), str(item["sent_at"]), str(item["message_id"])))
        detailed = detailed[:cap]
        if with_details:
            return detailed
        return [{key: item[key] for key in ("id", "route", "why")} for item in detailed]
    finally:
        con.close()


def _line_quote(body: str, needles: list[str], mask_tokens: list[str]) -> str:
    lines = [line.strip() for line in (body or "").splitlines() if line.strip()]
    def masked(text: str) -> bool:
        return any(token and token.lower() in text.lower() for token in mask_tokens)
    for needle in [item for item in needles if item]:
        needle_lower = needle.lower()
        for line in lines:
            if needle_lower in line.lower() and not masked(line):
                return line[:180]
    action_words = ("please book", "please proceed", "we accept", "confirm acceptance", "booking request", "please quote")
    for line in lines:
        if any(word in line.lower() for word in action_words) and not masked(line):
            return line[:180]
    for line in lines:
        if not masked(line):
            return line[:180]
    return ""


def baseline_prediction(
    confirmation: str,
    ctx: dict[str, Any] | None = None,
    db: str | None = None,
    arm: str = "leads",
) -> dict[str, Any]:
    """Arm-0 deterministic prediction: top-1 lead; R1 suppressed when mask_tokens are active."""
    started = time.monotonic()
    ctx = dict(ctx or {})
    mask_tokens = [str(token) for token in (ctx.get("mask_tokens") or []) if str(token)]
    include_r1 = not bool(mask_tokens)
    details = generate_leads(confirmation, ctx, db, cap=25, include_r1=include_r1, with_details=True)
    con = connect(db, ctx)
    evidence = None
    try:
        stay = load_stay(con, confirmation)
        top = details[0] if details else None
        row = _fetch_message(con, strip_msg(top["id"])) if top else None
        result: dict[str, Any] = {
            "confirmation": confirmation,
            "arm": arm,
            "status": "found" if row is not None else "not_found",
            "earliest_request": [],
            "members": [],
            "confounders": [],
            "notes": "deterministic leads baseline" + ("; R1 suppressed because mask_tokens active" if mask_tokens else ""),
            "tool_calls": 0,
            "tokens": {"in": 0, "cached": 0, "out": 0},
            "wall_s": round(time.monotonic() - started, 3),
            "model": "none",
            "validator": {"ok": False, "repaired": 0, "dropped": 0},
        }
        if row is not None and stay is not None:
            needles = []
            if include_r1:
                needles.append(confirmation)
            needles.extend([stay["billing_reference"] or "", stay["caller"] or "", surname_of(stay["guest_name"])])
            quote = _line_quote(row["body_text"] or "", needles, mask_tokens)
            if not quote:
                quote = _line_quote(row["subject"] or "", needles, mask_tokens)
            if quote:
                cid = "msg:" + row["id"]
                result["earliest_request"] = [{"id": cid, "quote": quote}]
                result["members"] = [{"id": cid, "role": "earliest_create_request", "quote": quote}]
                result["notes"] += "; top route " + str(top["route"]) + ": " + str(top["why"])
                try:
                    from validate import EvidenceStore, validate_result
                    evidence = EvidenceStore()
                    evidence.add_text(cid, row["subject"] or "", sent_at=row["sent_at"])
                    evidence.add_text(cid, row["body_text"] or "", sent_at=row["sent_at"])
                    result = validate_result(result, evidence, db=db, ctx=ctx)
                except Exception:
                    result["validator"] = {"ok": bool(quote), "repaired": 0, "dropped": 0}
            else:
                result["status"] = "ambiguous"
                result["notes"] += "; top lead had no unmasked exact quote"
        result["wall_s"] = round(time.monotonic() - started, 3)
        return result
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate deterministic P4 leads")
    parser.add_argument("confirmation")
    parser.add_argument("--db", default=None)
    parser.add_argument("--ctx", default="{}")
    parser.add_argument("--baseline", action="store_true", help="emit Arm-0 CONTRACT C line")
    parser.add_argument("--details", action="store_true")
    ns = parser.parse_args(argv)
    ctx = json.loads(ns.ctx)
    if ns.baseline:
        out = baseline_prediction(ns.confirmation, ctx, ns.db)
    else:
        out = generate_leads(ns.confirmation, ctx, ns.db, with_details=ns.details)
    print(json.dumps(out, ensure_ascii=False, indent=2 if not ns.baseline else None, separators=None if not ns.baseline else (",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
