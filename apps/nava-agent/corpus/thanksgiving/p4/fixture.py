#!/usr/bin/env python3
"""Build the tiny CONTRACT A fixture sqlite used before L1's real snapshot lands."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
from typing import Any

DEFAULT_PATH = Path.home() / ".local/share/zero/research/thanksgiving/work/p4/fixture.sqlite"

SCHEMA = """
CREATE TABLE message(
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  message_id_header TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  sent_at TEXT,
  received_at TEXT,
  direction TEXT,
  mailbox TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  body_text TEXT,
  cut_reason TEXT
);
CREATE TABLE header_edge(src_id TEXT, dst_id TEXT, kind TEXT);
CREATE TABLE attachment(
  id TEXT PRIMARY KEY,
  message_id TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  s3_key TEXT,
  sha256 TEXT,
  is_inline INTEGER,
  cut_reason TEXT
);
CREATE TABLE doc_text(attachment_id TEXT PRIMARY KEY, text TEXT, source TEXT, fetched_at TEXT);
CREATE TABLE hms_stay(
  confirmation TEXT PRIMARY KEY,
  guest_name TEXT,
  arrival TEXT,
  departure TEXT,
  created_at TEXT,
  created_by TEXT,
  source_of_business TEXT,
  company TEXT,
  travel_agent TEXT,
  email_address TEXT,
  caller TEXT,
  billing_reference TEXT,
  reservation_note TEXT,
  rate_plan TEXT,
  room_type TEXT,
  meal_plan TEXT,
  adults INTEGER,
  children INTEGER,
  status TEXT,
  is_labtest INTEGER,
  cohort_clean INTEGER,
  raw_json TEXT
);
CREATE TABLE p3_key(message_id TEXT, confirmation TEXT, source TEXT);
CREATE VIRTUAL TABLE message_fts USING fts5(subject, body_text, from_addr, to_addrs, content='message', content_rowid='rowid');
CREATE VIRTUAL TABLE doc_fts USING fts5(text, content='doc_text', content_rowid='rowid');
CREATE VIRTUAL TABLE hms_fts USING fts5(guest_name, company, travel_agent, email_address, caller, billing_reference, reservation_note, content='hms_stay', content_rowid='rowid');
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
"""


def _insert_message(con: sqlite3.Connection, row: dict[str, Any]) -> int:
    columns = [
        "id", "thread_id", "message_id_header", "in_reply_to", "references_hdr", "sent_at", "received_at",
        "direction", "mailbox", "from_addr", "to_addrs", "cc_addrs", "subject", "body_text", "cut_reason",
    ]
    cur = con.execute(
        "INSERT INTO message(" + ",".join(columns) + ") VALUES(" + ",".join("?" for _ in columns) + ")",
        [row.get(column) for column in columns],
    )
    rowid = int(cur.lastrowid)
    con.execute(
        "INSERT INTO message_fts(rowid,subject,body_text,from_addr,to_addrs) VALUES(?,?,?,?,?)",
        [rowid, row.get("subject") or "", row.get("body_text") or "", row.get("from_addr") or "", row.get("to_addrs") or ""],
    )
    return rowid


def _insert_hms(con: sqlite3.Connection, row: dict[str, Any]) -> None:
    columns = [
        "confirmation", "guest_name", "arrival", "departure", "created_at", "created_by", "source_of_business",
        "company", "travel_agent", "email_address", "caller", "billing_reference", "reservation_note", "rate_plan",
        "room_type", "meal_plan", "adults", "children", "status", "is_labtest", "cohort_clean", "raw_json",
    ]
    cur = con.execute(
        "INSERT INTO hms_stay(" + ",".join(columns) + ") VALUES(" + ",".join("?" for _ in columns) + ")",
        [row.get(column) for column in columns],
    )
    con.execute(
        "INSERT INTO hms_fts(rowid,guest_name,company,travel_agent,email_address,caller,billing_reference,reservation_note) VALUES(?,?,?,?,?,?,?,?)",
        [
            int(cur.lastrowid), row.get("guest_name") or "", row.get("company") or "", row.get("travel_agent") or "",
            row.get("email_address") or "", row.get("caller") or "", row.get("billing_reference") or "", row.get("reservation_note") or "",
        ],
    )


def build(path: Path, force: bool = False) -> dict[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not force:
            raise FileExistsError(f"fixture exists: {path} (use --force)")
        path.unlink()
    con = sqlite3.connect(str(path))
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)

    messages: list[dict[str, Any]] = []

    def msg(
        mid: str,
        thread: str,
        sent: str,
        direction: str,
        sender: str,
        to: str,
        subject: str,
        body: str,
        in_reply_to: str = "",
        references: str = "",
        cc: str = "",
    ) -> None:
        messages.append({
            "id": mid,
            "thread_id": thread,
            "message_id_header": f"<{mid}@fixture.local>",
            "in_reply_to": in_reply_to,
            "references_hdr": references,
            "sent_at": sent,
            "received_at": sent,
            "direction": direction,
            "mailbox": "centurion@legacyhotels.com",
            "from_addr": sender,
            "to_addrs": to,
            "cc_addrs": cc,
            "subject": subject,
            "body_text": body,
            "cut_reason": None,
        })

    # Alice target journey: original request, staff proforma, acceptance, post-create confirmation letter.
    msg(
        "m001", "t-alice", "2026-09-15T09:20:00Z", "inbound", "alice.nkosi@example.com", "centurion@legacyhotels.com",
        "Booking request Alice Nkosi 1-3 October",
        "Dear Centurion team,\n\nPlease book one standard room for Alice Nkosi arriving 1 October 2026 and departing 3 October 2026. Bed and breakfast, one adult. Busy Travel will settle the account. Our reference is PO-7788.\n\nKind regards,\nAlice",
    )
    msg(
        "m002", "t-alice", "2026-09-15T09:35:00Z", "outbound", "centurion@legacyhotels.com", "alice.nkosi@example.com",
        "Re: Booking request Alice Nkosi 1-3 October",
        "Dear Alice,\n\nAttached proforma for Alice Nkosi, standard room, 1 October 2026 to 3 October 2026. Please confirm acceptance.\n\nReservations",
        "<m001@fixture.local>", "<m001@fixture.local>",
    )
    msg(
        "m003", "t-alice", "2026-09-15T09:50:00Z", "inbound", "alice.nkosi@example.com", "centurion@legacyhotels.com",
        "Re: Booking request Alice Nkosi 1-3 October",
        "Good morning,\n\nWe accept the proforma for Alice Nkosi for 1-3 October. Please proceed with the booking.\n\nAlice",
        "<m002@fixture.local>", "<m001@fixture.local> <m002@fixture.local>",
    )
    msg(
        "m004", "t-alice", "2026-09-15T10:05:00Z", "outbound", "centurion@legacyhotels.com", "alice.nkosi@example.com",
        "Confirmation letter Alice Nkosi 48210001-1",
        "Dear Alice,\n\nThank you. Your confirmation letter is attached for reservation 48210001-1.\n\nReservations",
        "<m003@fixture.local>", "<m001@fixture.local> <m002@fixture.local> <m003@fixture.local>",
    )
    msg(
        "m005", "t-ops-alice", "2026-09-15T09:55:00Z", "inbound", "marthamthembu@legacyhotels.co.za", "centurion@legacyhotels.com",
        "Fwd: Booking request Alice Nkosi 1-3 October",
        "Team, please capture this forwarded client ask.\n\n---------- Forwarded message ---------\nPlease book one standard room for Alice Nkosi arriving 1 October 2026 and departing 3 October 2026.\n",
    )

    # Busy agency collision: Ben is same agency/same week but a different guest.
    msg(
        "m006", "t-ben", "2026-09-15T09:25:00Z", "inbound", "bookings@busytravel.co.za", "centurion@legacyhotels.com",
        "Ben Dlamini accommodation request",
        "Please quote and book Ben Dlamini for 2 October 2026 to 4 October 2026. Busy Travel reference BT-442. One room, bed and breakfast.",
    )
    msg(
        "m007", "t-ben", "2026-09-15T09:45:00Z", "outbound", "centurion@legacyhotels.com", "bookings@busytravel.co.za",
        "Re: Ben Dlamini accommodation request",
        "Proforma attached for Ben Dlamini, 2 October 2026 to 4 October 2026.",
        "<m006@fixture.local>", "<m006@fixture.local>",
    )
    msg(
        "m008", "t-ben", "2026-09-15T10:08:00Z", "outbound", "centurion@legacyhotels.com", "bookings@busytravel.co.za",
        "Confirmation Ben Dlamini 48210002-1",
        "Confirmation letter attached for Ben Dlamini reservation 48210002-1.",
        "<m007@fixture.local>", "<m006@fixture.local> <m007@fixture.local>",
    )
    msg(
        "m009", "t-carol", "2026-09-15T09:30:00Z", "inbound", "bookings@busytravel.co.za", "centurion@legacyhotels.com",
        "Carol Mokoena request",
        "Please hold one room for Carol Mokoena, 5 October 2026 to 6 October 2026. Do not confuse this with Alice Nkosi or Ben Dlamini.",
    )
    msg(
        "m010", "t-dave", "2026-09-15T09:40:00Z", "inbound", "dave@example.net", "centurion@legacyhotels.com",
        "Dave Pieterse room request",
        "Please book Dave Pieterse for 8 October 2026 to 9 October 2026.",
    )
    msg(
        "m011", "t-dave", "2026-09-15T09:48:00Z", "outbound", "centurion@legacyhotels.com", "dave@example.net",
        "Re: Dave Pieterse room request",
        "Proforma for Dave Pieterse follows.",
        "<m010@fixture.local>", "<m010@fixture.local>",
    )
    msg(
        "m012", "t-dave", "2026-09-15T09:58:00Z", "inbound", "dave@example.net", "centurion@legacyhotels.com",
        "Re: Dave Pieterse room request",
        "Accepted, please create the Dave Pieterse booking.",
        "<m011@fixture.local>", "<m010@fixture.local> <m011@fixture.local>",
    )

    msg(
        "m013", "t-news", "2026-09-15T08:00:00Z", "inbound", "news@example.com", "centurion@legacyhotels.com",
        "October travel newsletter",
        "Industry news and rates. No reservation request here.",
    )
    msg(
        "m014", "t-alice-billing", "2026-09-15T09:52:00Z", "inbound", "alice.nkosi@example.com", "centurion@legacyhotels.com",
        "Purchase order PO-7788",
        "Please use purchase order PO-7788 for the Nkosi accommodation. The traveller is Alice Nkosi.",
    )
    msg(
        "m015", "t-alice-billing", "2026-09-15T09:56:00Z", "outbound", "centurion@legacyhotels.com", "alice.nkosi@example.com",
        "Re: Purchase order PO-7788",
        "Noted, PO-7788 will be referenced on the booking.",
        "<m014@fixture.local>", "<m014@fixture.local>",
    )
    msg(
        "m016", "t-alice-phone", "2026-09-15T09:54:00Z", "inbound", "pa@busytravel.co.za", "centurion@legacyhotels.com",
        "Contact number for Nkosi booking",
        "The caller number for Alice Nkosi is +2712000111. Dates remain 1 October 2026 to 3 October 2026.",
    )
    msg(
        "m017", "t-alice-phone", "2026-09-15T09:57:00Z", "outbound", "centurion@legacyhotels.com", "pa@busytravel.co.za",
        "Re: Contact number for Nkosi booking",
        "Thank you, noted for Alice Nkosi.",
        "<m016@fixture.local>", "<m016@fixture.local>",
    )
    msg(
        "m018", "t-alice-fuzzy", "2026-09-15T09:58:00Z", "inbound", "alicebooker@gmail.com", "centurion@legacyhotels.com",
        "Nkosl stay 1-3 Oct",
        "Small correction: the surname is sometimes typed Nkosl, but this concerns Alice Nkosi, 1-3 Oct at Centurion.",
    )
    msg(
        "m019", "t-alice-fuzzy", "2026-09-15T10:02:00Z", "outbound", "centurion@legacyhotels.com", "alicebooker@gmail.com",
        "Re: Nkosl stay 1-3 Oct",
        "Thank you, we will check the spelling against the reservation.",
        "<m018@fixture.local>", "<m018@fixture.local>",
    )
    msg(
        "m020", "t-ops-conf", "2026-09-15T10:20:00Z", "inbound", "reservations@legacyhotels.co.za", "centurion@legacyhotels.com",
        "Fwd: confirmation 48210001-1",
        "Internal copy. Guest Alice Nkosi now has confirmation 48210001-1. Keep with the file.",
    )

    msg(
        "m021", "t-erin", "2026-09-15T09:59:00Z", "inbound", "bookings@busytravel.co.za", "centurion@legacyhotels.com",
        "Erin Botha same-week booking",
        "Please book Erin Botha for 1 October 2026 to 3 October 2026. This is not Alice Nkosi.",
    )
    msg(
        "m022", "t-erin", "2026-09-15T10:06:00Z", "outbound", "centurion@legacyhotels.com", "bookings@busytravel.co.za",
        "Re: Erin Botha same-week booking",
        "We will quote Erin Botha separately.",
        "<m021@fixture.local>", "<m021@fixture.local>",
    )
    msg(
        "m023", "t-alice-payment", "2026-09-16T08:30:00Z", "inbound", "alice.nkosi@example.com", "centurion@legacyhotels.com",
        "Payment proof Alice Nkosi",
        "Payment proof for the Alice Nkosi stay is attached. This is after the booking was created.",
    )
    msg(
        "m024", "t-alice", "2026-09-16T09:00:00Z", "outbound", "centurion@legacyhotels.com", "alice.nkosi@example.com",
        "Updated confirmation Alice Nkosi 48210001-1",
        "Updated confirmation letter for reservation 48210001-1 is attached.",
        "<m004@fixture.local>", "<m001@fixture.local> <m004@fixture.local>",
    )
    msg(
        "m025", "t-spa", "2026-09-15T10:30:00Z", "inbound", "spa@legacyhotels.co.za", "centurion@legacyhotels.com",
        "Spa availability",
        "Internal spa rosters for October. No accommodation booking request.",
    )
    msg(
        "m026", "t-other", "2026-09-14T12:00:00Z", "inbound", "other@example.org", "centurion@legacyhotels.com",
        "Family lunch enquiry",
        "Do you have space for a family lunch on 1 October 2026?",
    )
    msg(
        "m027", "t-other", "2026-09-14T12:30:00Z", "outbound", "centurion@legacyhotels.com", "other@example.org",
        "Re: Family lunch enquiry",
        "Yes, please contact the restaurant directly.",
        "<m026@fixture.local>", "<m026@fixture.local>",
    )
    msg(
        "m028", "t-cancel", "2026-09-17T08:00:00Z", "inbound", "alice.nkosi@example.com", "centurion@legacyhotels.com",
        "Possible date change Alice Nkosi",
        "If our plans change, would it be possible to move Alice Nkosi by one night? No change is confirmed yet.",
    )
    msg(
        "m029", "t-cancel", "2026-09-17T08:15:00Z", "outbound", "centurion@legacyhotels.com", "alice.nkosi@example.com",
        "Re: Possible date change Alice Nkosi",
        "Yes, subject to availability. Please confirm before we amend anything.",
        "<m028@fixture.local>", "<m028@fixture.local>",
    )
    msg(
        "m030", "t-noise", "2026-09-15T11:00:00Z", "inbound", "bookings@busytravel.co.za", "centurion@legacyhotels.com",
        "October allocations",
        "General allocation request for several unnamed passengers. No confirmed guest names yet.",
    )

    rowids: dict[str, int] = {}
    for row in messages:
        rowids[row["id"]] = _insert_message(con, row)

    by_header = {row["message_id_header"]: row["id"] for row in messages}
    for row in messages:
        refs = []
        if row["in_reply_to"]:
            refs.append(("in_reply_to", row["in_reply_to"]))
        for token in (row["references_hdr"] or "").split():
            refs.append(("references", token))
        seen = set()
        for kind, header in refs:
            dst = by_header.get(header)
            if dst and (kind, dst) not in seen:
                con.execute("INSERT INTO header_edge(src_id,dst_id,kind) VALUES(?,?,?)", [row["id"], dst, kind])
                seen.add((kind, dst))

    attachments = [
        ("a002", "m002", "proforma-alice.pdf", "Proforma for Alice Nkosi standard room 1 October 2026 to 3 October 2026. Busy Travel PO-7788."),
        ("a004", "m004", "confirmation-alice-48210001-1.pdf", "Confirmation Letter\nGuest: Alice Nkosi\nConfirmation Number: 48210001-1\nArrival: 1 October 2026\nDeparture: 3 October 2026"),
        ("a007", "m007", "proforma-ben.pdf", "Proforma for Ben Dlamini 2 October 2026 to 4 October 2026."),
        ("a008", "m008", "confirmation-ben-48210002-1.pdf", "Confirmation Letter\nGuest: Ben Dlamini\nConfirmation Number: 48210002-1"),
        ("a024", "m024", "updated-confirmation-alice.pdf", "Updated Confirmation Letter\nGuest: Alice Nkosi\nConfirmation Number: 48210001-1"),
    ]
    for aid, mid, filename, text in attachments:
        con.execute(
            "INSERT INTO attachment(id,message_id,filename,mime_type,size_bytes,s3_key,sha256,is_inline,cut_reason) VALUES(?,?,?,?,?,?,?,?,?)",
            [aid, mid, filename, "application/pdf", len(text) + 700, "fixture/" + filename, "sha256-" + aid, 0, None],
        )
        cur = con.execute(
            "INSERT INTO doc_text(attachment_id,text,source,fetched_at) VALUES(?,?,?,?)",
            [aid, text, "rds_outbound", "2026-11-26T00:00:00Z"],
        )
        con.execute("INSERT INTO doc_fts(rowid,text) VALUES(?,?)", [int(cur.lastrowid), text])

    stays = [
        {
            "confirmation": "48210001-1", "guest_name": "Alice Nkosi", "arrival": "2026-10-01", "departure": "2026-10-03",
            "created_at": "2026-09-15T10:00:00Z", "created_by": "CENTURION", "source_of_business": "E-Mail",
            "company": "", "travel_agent": "Busy Travel", "email_address": "alice.nkosi@example.com", "caller": "+2712000111",
            "billing_reference": "PO-7788", "reservation_note": "Standard room, bed and breakfast", "rate_plan": "BAR",
            "room_type": "STD", "meal_plan": "BB", "adults": 1, "children": 0, "status": "RESERVED", "is_labtest": 0,
            "cohort_clean": 1, "raw_json": json.dumps({"fixture": True}),
        },
        {
            "confirmation": "48210002-1", "guest_name": "Ben Dlamini", "arrival": "2026-10-02", "departure": "2026-10-04",
            "created_at": "2026-09-15T10:04:00Z", "created_by": "CENTURION", "source_of_business": "E-Mail",
            "company": "", "travel_agent": "Busy Travel", "email_address": "bookings@busytravel.co.za", "caller": "+2712000222",
            "billing_reference": "BT-442", "reservation_note": "Busy agency collision fixture", "rate_plan": "BAR",
            "room_type": "STD", "meal_plan": "BB", "adults": 1, "children": 0, "status": "RESERVED", "is_labtest": 0,
            "cohort_clean": 1, "raw_json": json.dumps({"fixture": True}),
        },
        {
            "confirmation": "48210003-1", "guest_name": "Dave Pieterse", "arrival": "2026-10-08", "departure": "2026-10-09",
            "created_at": "2026-09-15T10:01:00Z", "created_by": "CENTURION", "source_of_business": "E-Mail",
            "company": "Example Net", "travel_agent": "", "email_address": "dave@example.net", "caller": "",
            "billing_reference": "", "reservation_note": "Separate fixture booking", "rate_plan": "BAR",
            "room_type": "STD", "meal_plan": "BB", "adults": 1, "children": 0, "status": "RESERVED", "is_labtest": 0,
            "cohort_clean": 1, "raw_json": json.dumps({"fixture": True}),
        },
        {
            "confirmation": "48210004-1", "guest_name": "Erin Botha", "arrival": "2026-10-01", "departure": "2026-10-03",
            "created_at": "2026-09-15T10:09:00Z", "created_by": "CENTURION", "source_of_business": "E-Mail",
            "company": "", "travel_agent": "Busy Travel", "email_address": "bookings@busytravel.co.za", "caller": "",
            "billing_reference": "", "reservation_note": "Same dates, different guest", "rate_plan": "BAR",
            "room_type": "STD", "meal_plan": "BB", "adults": 1, "children": 0, "status": "RESERVED", "is_labtest": 0,
            "cohort_clean": 1, "raw_json": json.dumps({"fixture": True}),
        },
    ]
    for stay in stays:
        _insert_hms(con, stay)

    p3 = [
        ("m004", "48210001-1", "body"), ("m004", "48210001-1", "pdf"), ("m020", "48210001-1", "body"),
        ("m024", "48210001-1", "body"), ("m024", "48210001-1", "pdf"),
        ("m008", "48210002-1", "body"), ("m008", "48210002-1", "pdf"),
    ]
    for row in p3:
        con.execute("INSERT INTO p3_key(message_id,confirmation,source) VALUES(?,?,?)", row)

    counts = {
        "message": len(messages),
        "attachment": len(attachments),
        "doc_text": len(attachments),
        "hms_stay": len(stays),
        "p3_key": len(p3),
        "header_edge": int(con.execute("SELECT count(*) FROM header_edge").fetchone()[0]),
    }
    for key, value in counts.items():
        con.execute("INSERT INTO meta(key,value) VALUES(?,?)", ["count_" + key, str(value)])
    con.execute("INSERT INTO meta(key,value) VALUES('built_at','2026-11-26T00:00:00Z')")
    con.execute("INSERT INTO meta(key,value) VALUES('source_git_sha','fixture')")
    con.commit()
    con.close()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build synthetic P4 CONTRACT A fixture sqlite")
    parser.add_argument("--db", default=str(DEFAULT_PATH), help="output sqlite path")
    parser.add_argument("--force", action="store_true", help="replace an existing fixture")
    ns = parser.parse_args(argv)
    counts = build(Path(ns.db).expanduser(), force=ns.force)
    print(json.dumps({"db": str(Path(ns.db).expanduser()), "counts": counts}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
