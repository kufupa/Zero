#!/usr/bin/env python3
"""Freeze P4 evaluation samples with a salted fixed seed."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_WORK = Path.home() / ".local/share/zero/research/thanksgiving/work/p4"
DEFAULT_DB = DEFAULT_WORK / "snapshot.sqlite"
DEFAULT_OUT = DEFAULT_WORK / "samples"
SEED = "p4-e0-freeze-2026-11-26"
E0A_N = 50
E0B_PER_STRATUM = 5
STRATA = [
    "p3_keyed_multi_thread",
    "busy_tmc_collision",
    "multi_room_burst",
    "non_p3_with_contact_or_ref",
    "non_p3_cold",
    "cancelled_or_multi_pdf",
]

STATIC_HOOKS = [
    {
        "hook_id": "J02",
        "confirmation": "18468506-1",
        "expected_status": "found",
        "expected_earliest_request_ids": ["msg:a80c3623-854e-4690-822a-aedac14a067c"],
        "confounder_ids": [
            "msg:3083a331-aec3-406a-8eb9-694179a904dd",
            "msg:d07a932c-2e30-4c34-82fe-f392834b23fd",
            "msg:df32b7d6-4c79-4332-876c-12744bf3dec0",
            "msg:67d60e5f-482a-4191-8d17-172760427452",
        ],
        "notes": "Cheyeza Linga create; same sender asked for two other guests.",
    },
    {
        "hook_id": "J08",
        "confirmation": "16652227-1",
        "expected_status": "found",
        "expected_earliest_request_ids": ["msg:8757598e-2f1f-47da-8f34-b424dae93c9e"],
        "confounder_ids": [],
        "notes": "Ayele Sossou extension created a different confirmation; do not require the old id.",
    },
    {
        "hook_id": "J09",
        "confirmation": "48746254-1",
        "expected_status": "found",
        "expected_earliest_request_ids": ["msg:771252cd-3b43-43df-8640-81c081dfff76"],
        "confounder_ids": [
            "msg:4f2afa4d-c7a9-41c9-88bb-e52c8af2abc1",
            "msg:2cd9e225-99bd-4ddf-8897-4de026a0fa28",
            "msg:99871b1a-30fb-400b-8aed-0fb566a00b3f",
        ],
        "notes": "Siphokazi Tshongweni create; In-Reply-To confounder names another guest.",
    },
]


def salted_key(seed: str, *parts: object) -> str:
    raw = seed + "\0" + "\0".join(str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def week_key(value: datetime | None) -> tuple[int, int] | None:
    if value is None:
        return None
    iso = value.date().isocalendar()
    return (iso.year, iso.week)


def norm_text(value: Any) -> str:
    return str(value or "").strip()


def mask_tokens(confirmation: str) -> list[str]:
    out = [confirmation]
    base = confirmation.split("-", 1)[0]
    if base and base != confirmation:
        out.append(base)
    return out


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def connect(db_path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    return con


def require_tables(con: sqlite3.Connection) -> None:
    names = {row[0] for row in con.execute("select name from sqlite_master where type in ('table','view')")}
    missing = [name for name in ("message", "hms_stay", "p3_key") if name not in names]
    if missing:
        raise SystemExit(f"snapshot missing required tables: {', '.join(missing)}")


def load_stays(con: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    rows = con.execute(
        """
        select confirmation, guest_name, arrival, departure, created_at, created_by,
               source_of_business, company, travel_agent, email_address, caller,
               billing_reference, status, cohort_clean
        from hms_stay
        """
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = dict(row)
        item["created_dt"] = parse_time(item.get("created_at"))
        item["arrival_dt"] = parse_time(item.get("arrival"))
        item["confirmation"] = norm_text(item.get("confirmation"))
        out[item["confirmation"]] = item
    return out


def load_p3(con: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    rows = con.execute(
        """
        select pk.confirmation, pk.message_id, pk.source, m.thread_id, m.sent_at, m.direction
        from p3_key pk
        join message m on m.id = pk.message_id
        """
    ).fetchall()
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        item = dict(row)
        item["sent_dt"] = parse_time(item.get("sent_at"))
        out[norm_text(item.get("confirmation"))].append(item)
    for items in out.values():
        items.sort(key=lambda x: (x["sent_dt"] or datetime.max.replace(tzinfo=timezone.utc), x["message_id"], x["source"]))
    return dict(out)


def cohort_stays(stays: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {conf: row for conf, row in stays.items() if int(row.get("cohort_clean") or 0) == 1 and row.get("created_dt")}


def agency_key(stay: dict[str, Any]) -> str:
    return norm_text(stay.get("travel_agent")).casefold()


def agency_week_counts(stays: dict[str, dict[str, Any]], field: str) -> dict[tuple[str, tuple[int, int]], int]:
    counts: dict[tuple[str, tuple[int, int]], int] = defaultdict(int)
    for stay in stays.values():
        agency = agency_key(stay)
        if not agency:
            continue
        moment = stay.get("created_dt") if field == "created" else stay.get("arrival_dt")
        week = week_key(moment)
        if week:
            counts[(agency, week)] += 1
    return counts


def features(stays: dict[str, dict[str, Any]], p3: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    created_weeks = agency_week_counts(stays, "created")
    arrival_weeks = agency_week_counts(stays, "arrival")
    by_creator: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    for conf, stay in stays.items():
        creator = norm_text(stay.get("created_by")).casefold()
        if creator and stay.get("created_dt"):
            by_creator[creator].append((stay["created_dt"], conf))

    out: dict[str, dict[str, Any]] = {}
    for conf, stay in stays.items():
        hits = p3.get(conf, [])
        threads = {norm_text(hit.get("thread_id")) for hit in hits if norm_text(hit.get("thread_id"))}
        agency = agency_key(stay)
        created_week = week_key(stay.get("created_dt"))
        arrival_week = week_key(stay.get("arrival_dt"))
        created_collision = created_weeks.get((agency, created_week), 0) if agency and created_week else 0
        arrival_collision = arrival_weeks.get((agency, arrival_week), 0) if agency and arrival_week else 0
        creator = norm_text(stay.get("created_by")).casefold()
        burst_count = 0
        if creator and stay.get("created_dt"):
            created_at = stay["created_dt"]
            burst_count = sum(
                1
                for other_at, other_conf in by_creator.get(creator, [])
                if other_conf != conf and abs((other_at - created_at).total_seconds()) <= 600
            ) + 1
        contact_or_ref = any(norm_text(stay.get(field)) for field in ("email_address", "caller", "billing_reference"))
        pdf_hits = len({hit["message_id"] for hit in hits if hit.get("source") == "pdf"})
        out[conf] = {
            "p3_hit_count": len(hits),
            "p3_thread_count": len(threads),
            "p3_keyed_multi_thread": len(threads) >= 2,
            "same_agency_week_count": max(created_collision, arrival_collision),
            "same_agency_week_hard_negative": max(created_collision, arrival_collision) >= 2,
            "busy_tmc_collision": max(created_collision, arrival_collision) >= 5,
            "multi_room_burst_count": burst_count,
            "multi_room_burst": burst_count >= 2,
            "contact_or_ref": contact_or_ref,
            "non_p3": not hits,
            "non_p3_with_contact_or_ref": not hits and contact_or_ref,
            "non_p3_cold": not hits and not contact_or_ref,
            "cancelled_or_multi_pdf": "cancel" in norm_text(stay.get("status")).casefold() or pdf_hits >= 2,
            "pdf_hit_count": pdf_hits,
        }
    return out


def pick_ordered(candidates: list[str], seed: str, n: int, exclude: set[str] | None = None) -> list[str]:
    excluded = exclude or set()
    ordered = sorted((c for c in candidates if c not in excluded), key=lambda c: salted_key(seed, c))
    return ordered[:n]


def freeze_e0a(stays: dict[str, dict[str, Any]], feats: dict[str, dict[str, Any]], seed: str, exclude: set[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    strict = [
        conf
        for conf in stays
        if conf not in exclude and feats[conf]["p3_keyed_multi_thread"] and feats[conf]["same_agency_week_hard_negative"]
    ]
    selected = pick_ordered(strict, seed + ":e0a", E0A_N)
    relaxations: list[str] = []
    if len(selected) < E0A_N:
        relaxed = [
            conf
            for conf in stays
            if conf not in exclude and conf not in selected and feats[conf]["p3_keyed_multi_thread"]
        ]
        fill = pick_ordered(relaxed, seed + ":e0a-relax-hard-negative", E0A_N - len(selected))
        if fill:
            relaxations.append(f"filled {len(fill)} rows without same-agency/same-week hard-negative requirement")
            selected.extend(fill)
    if len(selected) < E0A_N:
        relaxed = [conf for conf in stays if conf not in exclude and conf not in selected and feats[conf]["p3_hit_count"] > 0]
        fill = pick_ordered(relaxed, seed + ":e0a-relax-multi-thread", E0A_N - len(selected))
        if fill:
            relaxations.append(f"filled {len(fill)} rows without multi-thread requirement")
            selected.extend(fill)

    header_order = sorted(selected, key=lambda c: salted_key(seed + ":e0a-header", c))
    header_masked = set(header_order[: len(selected) // 2])
    rows = [
        {"confirmation": conf, "mask_tokens": mask_tokens(conf), "disable_headers": conf in header_masked}
        for conf in selected
    ]
    meta = {
        "strict_candidates": len(strict),
        "selected": len(rows),
        "target": E0A_N,
        "header_masked": sum(1 for row in rows if row["disable_headers"]),
        "relaxations": relaxations,
        "shortfall": max(0, E0A_N - len(rows)),
    }
    return rows, meta


def freeze_e0b(stays: dict[str, dict[str, Any]], feats: dict[str, dict[str, Any]], seed: str, exclude: set[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    selected: set[str] = set()
    stratum_meta: dict[str, Any] = {}
    for stratum in STRATA:
        candidates = [conf for conf in stays if conf not in exclude and conf not in selected and feats[conf].get(stratum)]
        picked = pick_ordered(candidates, seed + ":e0b:" + stratum, E0B_PER_STRATUM)
        selected.update(picked)
        rows.extend({"confirmation": conf, "stratum": stratum} for conf in picked)
        stratum_meta[stratum] = {"candidates": len(candidates), "selected": len(picked), "target": E0B_PER_STRATUM}
    return rows, {"strata": stratum_meta, "selected": len(rows), "target": len(STRATA) * E0B_PER_STRATUM}


def surname_tokens(guest_name: str) -> list[str]:
    clean = " ".join(guest_name.replace(",", " ").split())
    words = [w.strip(".,()") for w in clean.split()]
    titles = {"mr", "mrs", "ms", "miss", "dr", "prof"}
    words = [w for w in words if w.casefold() not in titles]
    if not words:
        return []
    if "," in guest_name:
        return [words[0]] if words[0] else []
    return [words[-1]] if words[-1] else []


def surname_hit_count(con: sqlite3.Connection, stay: dict[str, Any]) -> int:
    tokens = surname_tokens(norm_text(stay.get("guest_name")))
    if not tokens or not stay.get("created_dt"):
        return 10**6
    surname = tokens[0]
    if len(surname) < 4:
        return 10**6
    start = iso_z(stay["created_dt"] - timedelta(days=30))
    end = iso_z(stay["created_dt"] + timedelta(hours=48))
    pattern = "%" + surname.replace("%", "") + "%"
    has_fts = con.execute("select 1 from sqlite_master where type='table' and name='message_fts'").fetchone()
    if has_fts:
        fts_query = '"' + surname.replace('"', '') + '"'
        row = con.execute(
            """
            select count(*) as n
            from message_fts f join message m on m.rowid = f.rowid
            where message_fts match ? and m.sent_at >= ? and m.sent_at <= ?
            """,
            (fts_query, start, end),
        ).fetchone()
    else:
        row = con.execute(
            """
            select count(*) as n
            from message
            where sent_at >= ? and sent_at <= ?
              and (lower(body_text) like lower(?) or lower(subject) like lower(?))
            """,
            (start, end, pattern, pattern),
        ).fetchone()
    return int(row["n"] if row else 0)


def freeze_hooks(con: sqlite3.Connection, stays: dict[str, dict[str, Any]], feats: dict[str, dict[str, Any]], seed: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    missing: list[str] = []
    for hook in STATIC_HOOKS:
        row = dict(hook)
        conf = row["confirmation"]
        if conf not in stays:
            missing.append(conf)
            continue
        row["mask_tokens"] = mask_tokens(conf)
        row["disable_headers"] = False
        rows.append(row)

    cold = [
        conf
        for conf, stay in stays.items()
        if conf not in {r["confirmation"] for r in rows} and feats[conf]["non_p3_cold"] and "cancel" not in norm_text(stay.get("status")).casefold()
    ]
    ordered = sorted(cold, key=lambda c: salted_key(seed + ":negative", c))
    chosen = None
    chosen_hits = None
    for conf in ordered:
        hits = surname_hit_count(con, stays[conf])
        if hits == 0:
            chosen = conf
            chosen_hits = hits
            break
        if chosen is None:
            chosen = conf
            chosen_hits = hits
    negative_meta: dict[str, Any] = {"selected": False}
    if chosen:
        rows.append(
            {
                "hook_id": "real_create_negative",
                "confirmation": chosen,
                "expected_status": "not_found",
                "expected_earliest_request_ids": [],
                "confounder_ids": [],
                "mask_tokens": mask_tokens(chosen),
                "disable_headers": False,
                "notes": "No P3 key, no contact/reference, and no surname-bearing mail in the linking window.",
                "observed_surname_hits": chosen_hits,
            }
        )
        negative_meta = {"selected": True, "confirmation": chosen, "observed_surname_hits": chosen_hits, "candidate_count": len(cold)}
    meta = {"missing_static_confirmations": missing, "negative": negative_meta, "selected": len(rows)}
    return rows, meta


def freeze(db_path: Path, out_dir: Path, seed: str) -> dict[str, Any]:
    con = connect(db_path)
    try:
        require_tables(con)
        all_stays = load_stays(con)
        p3 = load_p3(con)
        stays = cohort_stays(all_stays)
        feats = features(stays, p3)
        hook_confs = {hook["confirmation"] for hook in STATIC_HOOKS}
        e0a, e0a_meta = freeze_e0a(stays, feats, seed, hook_confs)
        e0b, e0b_meta = freeze_e0b(stays, feats, seed, hook_confs)
        hooks, hook_meta = freeze_hooks(con, stays, feats, seed)
    finally:
        con.close()

    write_jsonl(out_dir / "e0a-50.jsonl", e0a)
    write_jsonl(out_dir / "e0b-30.jsonl", e0b)
    write_jsonl(out_dir / "hooks.jsonl", hooks)
    selected_ids = sorted([r["confirmation"] for r in e0a] + [r["confirmation"] for r in e0b] + [r["confirmation"] for r in hooks])
    manifest = {
        "schema": "p4-sample-manifest-v1",
        "seed": seed,
        "db": str(db_path),
        "frozen_at": iso_z(datetime.now(timezone.utc)),
        "counts": {"e0a": len(e0a), "e0b": len(e0b), "hooks": len(hooks), "cohort_clean": len(stays)},
        "e0a": e0a_meta,
        "e0b": e0b_meta,
        "hooks": {k: v for k, v in hook_meta.items() if k != "negative" or not v.get("confirmation")},
        "content_hash_of_ids": salted_key(seed, "|".join(selected_ids)),
    }
    (out_dir / "sample_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def create_test_fixture(path: Path) -> None:
    con = sqlite3.connect(str(path))
    con.executescript(
        """
        create table message(id text primary key, thread_id text, message_id_header text, in_reply_to text, references_hdr text, sent_at text, received_at text, direction text, mailbox text, from_addr text, to_addrs text, cc_addrs text, subject text, body_text text, cut_reason text);
        create table header_edge(src_id text, dst_id text, kind text);
        create table attachment(id text primary key, message_id text, filename text, mime_type text, size_bytes int, s3_key text, sha256 text, is_inline int, cut_reason text);
        create table doc_text(attachment_id text primary key, text text, source text, fetched_at text);
        create table hms_stay(confirmation text primary key, guest_name text, arrival text, departure text, created_at text, created_by text, source_of_business text, company text, travel_agent text, email_address text, caller text, billing_reference text, reservation_note text, rate_plan text, room_type text, meal_plan text, adults int, children int, status text, is_labtest int, cohort_clean int, raw_json text);
        create table p3_key(message_id text, confirmation text, source text);
        create table meta(key text, value text);
        """
    )
    base = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)
    for i in range(70):
        conf = f"700000{i:02d}-1"
        agency = "Busy TMC" if i < 55 else ("Agency X" if i % 2 else "")
        created = base + timedelta(days=i % 14, hours=i % 5)
        creator = "BONGIWEK" if i % 9 else "SARAH"
        status = "Cancelled" if i in {60, 61, 62, 63, 64} else "Reserved"
        email = "agent@example.com" if 40 <= i < 45 else ""
        billing = "REF" + str(i) if 40 <= i < 45 else ""
        con.execute(
            "insert into hms_stay values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (conf, f"Guest{i} Test{i}", "2026-11-01", "2026-11-03", iso_z(created), creator, "E-Mail", "", agency, email, "", billing, "", "NGOVB", "STWN", "BB", 1, 0, status, 0, 1, "{}"),
        )
        if i < 55:
            for part in (1, 2):
                mid = f"m-{conf}-{part}"
                con.execute(
                    "insert into message values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (mid, f"thread-{conf}-{part}", f"hdr-{mid}", None, None, iso_z(created + timedelta(hours=part)), iso_z(created + timedelta(hours=part)), "outbound", "centurion", "centurion@example.com", "agent@example.com", "", "Confirmation", f"Confirmation {conf}", None),
                )
                con.execute("insert into p3_key values (?,?,?)", (mid, conf, "body"))
    for conf, guest, created in [
        ("18468506-1", "Cheyeza Linga", datetime(2026, 10, 20, 15, 30, tzinfo=timezone.utc)),
        ("16652227-1", "Ayele Sossou", datetime(2026, 10, 19, 8, 50, tzinfo=timezone.utc)),
        ("48746254-1", "Siphokazi Tshongweni", datetime(2026, 10, 20, 6, 54, tzinfo=timezone.utc)),
    ]:
        con.execute(
            "insert or replace into hms_stay values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (conf, guest, "2026-10-25", "2026-10-30", iso_z(created), "BONGIWEK", "E-Mail", "", "XL Nexus", "", "", "", "", "NGOVB", "STWN", "BB", 1, 0, "Reserved", 0, 1, "{}"),
        )
    for mid, body in [
        ("a80c3623-854e-4690-822a-aedac14a067c", "Cheyeza Linga In: 25 October 2026 Out: 30 October 2026"),
        ("8757598e-2f1f-47da-8f34-b424dae93c9e", "Please extend this booking by 1 more week In 20Oct Out 27Oct"),
        ("771252cd-3b43-43df-8640-81c081dfff76", "Mrs Siphokazi Tshongweni Check in: 25 Oct 2026 Check out: 30 Oct 2026"),
    ]:
        con.execute(
            "insert or replace into message values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (mid, "hook-thread", "hdr-" + mid, None, None, "2026-10-20T06:00:00Z", "2026-10-20T06:00:00Z", "inbound", "centurion", "agent@example.com", "centurion@example.com", "", "Booking", body, None),
        )
    con.commit()
    con.close()


def self_test() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db = root / "fixture.sqlite"
        out1 = root / "samples1"
        out2 = root / "samples2"
        create_test_fixture(db)
        m1 = freeze(db, out1, SEED)
        m2 = freeze(db, out2, SEED)
        rows = read_jsonl(out1 / "e0a-50.jsonl")
        assert len(rows) == E0A_N, len(rows)
        assert sum(1 for row in rows if row["disable_headers"]) == 25
        assert read_jsonl(out1 / "e0a-50.jsonl") == read_jsonl(out2 / "e0a-50.jsonl")
        assert m1["content_hash_of_ids"] == m2["content_hash_of_ids"]
        hooks = read_jsonl(out1 / "hooks.jsonl")
        assert {row["hook_id"] for row in hooks} >= {"J02", "J08", "J09"}
        print(json.dumps({"ok": True, "e0a": len(rows), "e0b": m1["counts"]["e0b"], "hooks": len(hooks)}, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--seed", default=SEED)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    if not args.db.exists():
        raise SystemExit(f"snapshot not found: {args.db}")
    manifest = freeze(args.db, args.out_dir, args.seed)
    print(json.dumps({"ok": True, "out_dir": str(args.out_dir), "counts": manifest["counts"], "hash": manifest["content_hash_of_ids"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
