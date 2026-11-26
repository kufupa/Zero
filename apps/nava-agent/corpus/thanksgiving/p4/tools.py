#!/usr/bin/env python3
"""P4 snapshot read tools (CONTRACT B).

CLI:
  python3 tools.py <tool> '<json args>' [--db PATH] [--ctx '<json ctx>']

Python:
  from tools import call
  call(name, args, ctx) -> dict

The Python API uses --db unchanged for one process. For a non-default DB either set
P4_DB or pass a `_db` key in ctx (internal convenience; it is never emitted).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

CONTRACT_DIR = Path(__file__).resolve().parent
DEFAULT_WORK = Path.home() / ".local/share/zero/research/thanksgiving/work/p4"
DEFAULT_DB = DEFAULT_WORK / "snapshot.sqlite"
MASK = "[MASKED]"
MAX_LIMIT = 25
MAX_READ_CHARS = 12000

CITABLE_PREFIXES = ("msg:", "att:", "hdr:", "hms:")


def _db_path(ctx: dict[str, Any] | None = None, db: str | os.PathLike[str] | None = None) -> Path:
    if db:
        return Path(db).expanduser()
    if ctx and isinstance(ctx.get("_db"), str) and ctx.get("_db"):
        return Path(ctx["_db"]).expanduser()
    if os.environ.get("P4_DB"):
        return Path(os.environ["P4_DB"]).expanduser()
    return DEFAULT_DB


def connect(db: str | os.PathLike[str] | None = None, ctx: dict[str, Any] | None = None) -> sqlite3.Connection:
    path = _db_path(ctx, db)
    if not path.exists():
        raise FileNotFoundError(f"P4_SNAPSHOT_MISSING:{path}")
    con = sqlite3.connect(str(path), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=30000")
    return con


def _clean_ctx(ctx: dict[str, Any] | None) -> dict[str, Any]:
    return dict(ctx or {})


def _mask_text(value: str, tokens: list[str]) -> str:
    out = value
    for token in tokens:
        if not token:
            continue
        out = re.sub(re.escape(str(token)), MASK, out, flags=re.IGNORECASE)
    return out


def _mask_value(value: Any, tokens: list[str]) -> Any:
    if not tokens:
        return value
    if isinstance(value, str):
        return _mask_text(value, tokens)
    if isinstance(value, list):
        return [_mask_value(item, tokens) for item in value]
    if isinstance(value, tuple):
        return [_mask_value(item, tokens) for item in value]
    if isinstance(value, dict):
        return {key: _mask_value(item, tokens) for key, item in value.items()}
    return value


def _finish(result: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    tokens = ctx.get("mask_tokens") or []
    if not isinstance(tokens, list):
        tokens = [str(tokens)]
    return _mask_value(result, [str(token) for token in tokens if str(token)])


def _int_arg(args: dict[str, Any], name: str, default: int, low: int, high: int) -> int:
    value = args.get(name, default)
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _window_clause(ctx: dict[str, Any], args: dict[str, Any] | None = None, column: str = "sent_at") -> tuple[str, list[Any]]:
    clauses: list[str] = []
    values: list[Any] = []
    args = args or {}
    for key, op in (("window_from", ">="), ("window_to", "<=")):
        value = ctx.get(key)
        if isinstance(value, str) and value:
            clauses.append(f"m.{column} {op} ?")
            values.append(value)
    for key, op in (("date_from", ">="), ("date_to", "<=")):
        value = args.get(key)
        if isinstance(value, str) and value:
            clauses.append(f"m.{column} {op} ?")
            values.append(value)
    return (" AND ".join(clauses), values)


def _sent_in_ctx_window(sent_at: Any, ctx: dict[str, Any]) -> bool:
    sent = str(sent_at or "")
    window_from = ctx.get("window_from")
    window_to = ctx.get("window_to")
    if isinstance(window_from, str) and window_from and sent < window_from:
        return False
    if isinstance(window_to, str) and window_to and sent > window_to:
        return False
    return True


def _rows(con: sqlite3.Connection, sql: str, params: list[Any] | tuple[Any, ...]) -> list[sqlite3.Row]:
    return list(con.execute(sql, params))


def _message_card(row: sqlite3.Row, snippet: str | None = None) -> dict[str, Any]:
    card: dict[str, Any] = {
        "id": "msg:" + row["id"],
        "message_id": row["id"],
        "thread_id": row["thread_id"],
        "sent_at": row["sent_at"],
        "received_at": row["received_at"],
        "direction": row["direction"],
        "mailbox": row["mailbox"],
        "from_addr": row["from_addr"],
        "to_addrs": row["to_addrs"],
        "cc_addrs": row["cc_addrs"],
        "subject": row["subject"],
        "cut_reason": row["cut_reason"],
    }
    if snippet is not None:
        card["snippet"] = snippet
    return card


def _fts_rows(
    con: sqlite3.Connection,
    fts_table: str,
    base_table: str,
    base_alias: str,
    query: str,
    where: str,
    params: list[Any],
    order: str,
    limit: int,
    offset: int,
    snippet_column: int | None = None,
) -> list[sqlite3.Row]:
    join = f"JOIN {base_table} {base_alias} ON {base_alias}.rowid = f.rowid"
    match = f"{fts_table} MATCH ?"
    snippet_sql = "NULL"
    if snippet_column is not None:
        snippet_sql = f"snippet({fts_table}, {snippet_column}, '[', ']', ' … ', 18)"
    sql = (
        f"SELECT {base_alias}.*, {snippet_sql} AS fts_snippet, bm25({fts_table}) AS fts_rank "
        f"FROM {fts_table} f {join} WHERE {match}"
    )
    if where:
        sql += " AND " + where
    sql += f" ORDER BY {order} LIMIT ? OFFSET ?"
    return _rows(con, sql, [query, *params, limit, offset])


def search_mail(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    con = connect(db, ctx)
    try:
        query = str(args.get("query") or "").strip()
        limit = _int_arg(args, "limit", 10, 1, MAX_LIMIT)
        offset = _int_arg(args, "offset", 0, 0, 1_000_000)
        where_parts: list[str] = []
        params: list[Any] = []
        if isinstance(args.get("thread_id"), str) and args["thread_id"]:
            where_parts.append("m.thread_id = ?")
            params.append(args["thread_id"])
        participants = args.get("participants")
        if isinstance(participants, str):
            participants = [participants]
        if isinstance(participants, list) and participants:
            pieces: list[str] = []
            for participant in [str(item).lower() for item in participants if str(item).strip()]:
                pieces.append("(lower(COALESCE(m.from_addr,'')) LIKE ? OR lower(COALESCE(m.to_addrs,'')) LIKE ? OR lower(COALESCE(m.cc_addrs,'')) LIKE ?)")
                needle = "%" + participant + "%"
                params.extend([needle, needle, needle])
            if pieces:
                where_parts.append("(" + " OR ".join(pieces) + ")")
        window_sql, window_params = _window_clause(ctx, args)
        if window_sql:
            where_parts.append(window_sql)
            params.extend(window_params)
        where = " AND ".join("(" + part + ")" for part in where_parts)
        if query:
            rows = _fts_rows(
                con,
                "message_fts",
                "message",
                "m",
                query,
                where,
                params,
                "fts_rank, m.sent_at, m.id",
                limit,
                offset,
                snippet_column=1,
            )
        else:
            sql = "SELECT m.*, NULL AS fts_snippet FROM message m"
            if where:
                sql += " WHERE " + where
            sql += " ORDER BY m.sent_at, m.id LIMIT ? OFFSET ?"
            rows = _rows(con, sql, [*params, limit, offset])
        return _finish({
            "results": [_message_card(row, row["fts_snippet"] if "fts_snippet" in row.keys() else None) for row in rows],
            "count": len(rows),
            "limit": limit,
            "offset": offset,
            "query_syntax": "sqlite_fts5",
        }, ctx)
    finally:
        con.close()


def _header_text(row: sqlite3.Row, disable_headers: bool = False) -> str:
    lines = [
        f"message_id_header: {row['message_id_header'] or ''}",
        f"thread_id: {row['thread_id'] or ''}",
    ]
    if not disable_headers:
        lines.extend([
            f"in_reply_to: {row['in_reply_to'] or ''}",
            f"references_hdr: {row['references_hdr'] or ''}",
        ])
    return "\n".join(lines)


def read_mail(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    con = connect(db, ctx)
    try:
        ids = args.get("message_ids") or args.get("ids") or []
        if isinstance(ids, str):
            ids = [ids]
        clean_ids = []
        for item in ids:
            text = str(item)
            clean_ids.append(text[4:] if text.startswith("msg:") else text)
        clean_ids = clean_ids[:5]
        offset = _int_arg(args, "offset", 0, 0, 1_000_000)
        max_chars = _int_arg(args, "max_chars", MAX_READ_CHARS, 1, MAX_READ_CHARS)
        if not clean_ids:
            return _finish({"messages": [], "count": 0, "error": "message_ids_required"}, ctx)
        marks = ",".join("?" for _ in clean_ids)
        rows = [row for row in _rows(con, f"SELECT * FROM message WHERE id IN ({marks}) ORDER BY sent_at, id", clean_ids) if _sent_in_ctx_window(row["sent_at"], ctx)]
        disable_headers = bool(ctx.get("disable_headers"))
        messages: list[dict[str, Any]] = []
        for row in rows:
            body = row["body_text"] or ""
            chunk = body[offset:offset + max_chars]
            card = _message_card(row)
            card.update({
                "body_text": chunk,
                "body_offset": offset,
                "body_end": offset + len(chunk),
                "body_total_chars": len(body),
                "body_omitted_chars": max(0, len(body) - (offset + len(chunk))),
                "truncated": offset + len(chunk) < len(body),
            })
            if not disable_headers:
                card["header"] = {
                    "id": "hdr:" + row["id"],
                    "text": _header_text(row, False),
                }
            attachments = _rows(
                con,
                "SELECT id, filename, mime_type, size_bytes, sha256, is_inline, cut_reason FROM attachment WHERE message_id=? ORDER BY id",
                [row["id"]],
            )
            card["attachments"] = [
                {
                    "id": "att:" + att["id"],
                    "attachment_id": att["id"],
                    "filename": att["filename"],
                    "mime_type": att["mime_type"],
                    "size_bytes": att["size_bytes"],
                    "sha256": att["sha256"],
                    "is_inline": att["is_inline"],
                    "cut_reason": att["cut_reason"],
                }
                for att in attachments
            ]
            messages.append(card)
        return _finish({"messages": messages, "count": len(messages), "missing_ids": sorted(set(clean_ids) - {row["id"] for row in rows})}, ctx)
    finally:
        con.close()


def header_neighbours(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    message_id = str(args.get("message_id") or "")
    if message_id.startswith("msg:"):
        message_id = message_id[4:]
    if ctx.get("disable_headers"):
        return _finish({"message_id": message_id, "neighbours": [], "count": 0, "disabled": True}, ctx)
    con = connect(db, ctx)
    try:
        edges = _rows(
            con,
            "SELECT src_id, dst_id, kind FROM header_edge WHERE src_id=? OR dst_id=? ORDER BY kind, src_id, dst_id",
            [message_id, message_id],
        )
        other_ids = sorted({edge["dst_id"] if edge["src_id"] == message_id else edge["src_id"] for edge in edges})
        cards: dict[str, sqlite3.Row] = {}
        if other_ids:
            marks = ",".join("?" for _ in other_ids)
            cards = {row["id"]: row for row in _rows(con, f"SELECT * FROM message WHERE id IN ({marks})", other_ids) if _sent_in_ctx_window(row["sent_at"], ctx)}
        out = []
        for edge in edges:
            outgoing = edge["src_id"] == message_id
            other_id = edge["dst_id"] if outgoing else edge["src_id"]
            other = cards.get(other_id)
            item: dict[str, Any] = {
                "id": "msg:" + other_id,
                "message_id": other_id,
                "kind": edge["kind"],
                "direction_of_edge": "outgoing" if outgoing else "incoming",
            }
            if other is not None:
                item.update({
                    "thread_id": other["thread_id"],
                    "sent_at": other["sent_at"],
                    "direction": other["direction"],
                    "from_addr": other["from_addr"],
                    "to_addrs": other["to_addrs"],
                    "cc_addrs": other["cc_addrs"],
                    "subject": other["subject"],
                    "snippet": (other["body_text"] or "")[:350],
                })
            out.append(item)
        return _finish({"message_id": message_id, "neighbours": out, "count": len(out)}, ctx)
    finally:
        con.close()


def search_documents(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    con = connect(db, ctx)
    try:
        query = str(args.get("query") or "").strip()
        limit = _int_arg(args, "limit", 10, 1, MAX_LIMIT)
        offset = _int_arg(args, "offset", 0, 0, 1_000_000)
        where_parts: list[str] = []
        params: list[Any] = []
        if isinstance(args.get("message_id"), str) and args["message_id"]:
            mid = args["message_id"][4:] if args["message_id"].startswith("msg:") else args["message_id"]
            where_parts.append("a.message_id = ?")
            params.append(mid)
        if isinstance(args.get("thread_id"), str) and args["thread_id"]:
            where_parts.append("m.thread_id = ?")
            params.append(args["thread_id"])
        window_sql, window_params = _window_clause(ctx, {}, "sent_at")
        if window_sql:
            where_parts.append(window_sql)
            params.extend(window_params)
        where = " AND ".join("(" + part + ")" for part in where_parts)
        if query:
            join = "JOIN attachment a ON a.rowid = f.rowid JOIN message m ON m.id = a.message_id"
            # doc_fts is external-content on doc_text, whose rowid differs from attachment rowid on real snapshots.
            # Prefer joining through doc_text rowid, then attachment id.
            sql = (
                "SELECT a.*, m.thread_id, m.sent_at, m.subject, d.source AS doc_source, "
                "snippet(doc_fts, 0, '[', ']', ' … ', 18) AS fts_snippet, bm25(doc_fts) AS fts_rank "
                "FROM doc_fts f JOIN doc_text d ON d.rowid = f.rowid "
                "JOIN attachment a ON a.id = d.attachment_id JOIN message m ON m.id = a.message_id "
                "WHERE doc_fts MATCH ?"
            )
            if where:
                sql += " AND " + where
            sql += " ORDER BY fts_rank, m.sent_at, a.id LIMIT ? OFFSET ?"
            rows = _rows(con, sql, [query, *params, limit, offset])
        else:
            sql = (
                "SELECT a.*, m.thread_id, m.sent_at, m.subject, d.source AS doc_source, NULL AS fts_snippet, 0 AS fts_rank "
                "FROM attachment a JOIN message m ON m.id=a.message_id "
                "LEFT JOIN doc_text d ON d.attachment_id=a.id"
            )
            if where:
                sql += " WHERE " + where
            sql += " ORDER BY m.sent_at, a.id LIMIT ? OFFSET ?"
            rows = _rows(con, sql, [*params, limit, offset])
        results = []
        for row in rows:
            results.append({
                "id": "att:" + row["id"],
                "attachment_id": row["id"],
                "message_id": row["message_id"],
                "mail_id": "msg:" + row["message_id"],
                "thread_id": row["thread_id"],
                "sent_at": row["sent_at"],
                "filename": row["filename"],
                "mime_type": row["mime_type"],
                "size_bytes": row["size_bytes"],
                "doc_source": row["doc_source"],
                "snippet": row["fts_snippet"],
                "cut_reason": row["cut_reason"],
            })
        return _finish({"results": results, "count": len(results), "limit": limit, "offset": offset, "query_syntax": "sqlite_fts5"}, ctx)
    finally:
        con.close()


def _load_fetch_hook():
    path = CONTRACT_DIR / "fetch_doc.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("p4_fetch_doc", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, "fetch", None)


def read_document(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    attachment_id = str(args.get("attachment_id") or args.get("id") or "")
    if attachment_id.startswith("att:"):
        attachment_id = attachment_id[4:]
    offset = _int_arg(args, "offset", 0, 0, 1_000_000)
    max_chars = _int_arg(args, "max_chars", MAX_READ_CHARS, 1, MAX_READ_CHARS)
    if not attachment_id:
        return _finish({"found": False, "error": "attachment_id_required"}, ctx)
    con = connect(db, ctx)
    try:
        row = con.execute(
            "SELECT a.*, m.thread_id, m.sent_at, m.subject, d.text, d.source AS doc_source, d.fetched_at "
            "FROM attachment a JOIN message m ON m.id=a.message_id "
            "LEFT JOIN doc_text d ON d.attachment_id=a.id WHERE a.id=?",
            [attachment_id],
        ).fetchone()
        if row is None:
            return _finish({"found": False, "id": "att:" + attachment_id, "attachment_id": attachment_id}, ctx)
        if not _sent_in_ctx_window(row["sent_at"], ctx):
            return _finish({"found": False, "outside_window": True, "id": "att:" + attachment_id, "attachment_id": attachment_id}, ctx)
        text = row["text"]
        source = row["doc_source"]
        fetched = False
        if text is None:
            hook = _load_fetch_hook()
            if hook is not None:
                try:
                    fetched_text = hook(attachment_id)
                except Exception as exc:  # fetch hook is external I/O; report as data miss, not tool crash
                    fetched_text = None
                    source = "lazy_error:" + exc.__class__.__name__
                if fetched_text:
                    text = str(fetched_text)
                    source = "lazy"
                    fetched = True
                    con.execute(
                        "INSERT OR REPLACE INTO doc_text(attachment_id,text,source,fetched_at) VALUES(?,?,?,?)",
                        [attachment_id, text, "lazy", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")],
                    )
                    try:
                        fts_row = con.execute("SELECT rowid FROM doc_text WHERE attachment_id=?", [attachment_id]).fetchone()
                        if fts_row is not None:
                            con.execute("INSERT OR REPLACE INTO doc_fts(rowid,text) VALUES(?,?)", [fts_row["rowid"], text])
                    except sqlite3.Error:
                        pass
                    con.commit()
        chunk = (text or "")[offset:offset + max_chars]
        return _finish({
            "found": text is not None,
            "id": "att:" + attachment_id,
            "attachment_id": attachment_id,
            "message_id": row["message_id"],
            "mail_id": "msg:" + row["message_id"],
            "thread_id": row["thread_id"],
            "sent_at": row["sent_at"],
            "filename": row["filename"],
            "mime_type": row["mime_type"],
            "text": chunk,
            "offset": offset,
            "end": offset + len(chunk),
            "total_chars": len(text or ""),
            "omitted_chars": max(0, len(text or "") - (offset + len(chunk))),
            "truncated": offset + len(chunk) < len(text or ""),
            "source": source,
            "fetched_now": fetched,
            "cut_reason": row["cut_reason"],
        }, ctx)
    finally:
        con.close()


def _native_card(row: sqlite3.Row, snippet: str | None = None) -> dict[str, Any]:
    keys = [
        "confirmation", "guest_name", "arrival", "departure", "created_at", "created_by",
        "source_of_business", "company", "travel_agent", "email_address", "caller",
        "billing_reference", "reservation_note", "rate_plan", "room_type", "meal_plan",
        "adults", "children", "status", "is_labtest", "cohort_clean",
    ]
    card = {key: row[key] for key in keys if key in row.keys()}
    card["id"] = "hms:" + row["confirmation"]
    if snippet is not None:
        card["snippet"] = snippet
    return card


def search_native(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    con = connect(db, ctx)
    try:
        query = str(args.get("query") or "").strip()
        guest = str(args.get("guest") or "").strip()
        limit = _int_arg(args, "limit", 10, 1, MAX_LIMIT)
        offset = _int_arg(args, "offset", 0, 0, 1_000_000)
        where_parts: list[str] = []
        params: list[Any] = []
        if guest:
            where_parts.append("lower(COALESCE(h.guest_name,'')) LIKE ?")
            params.append("%" + guest.lower() + "%")
        for key, column, op in (
            ("date_from", "departure", ">="),
            ("date_to", "arrival", "<="),
        ):
            value = args.get(key)
            if isinstance(value, str) and value:
                where_parts.append(f"COALESCE(h.{column},'') {op} ?")
                params.append(value[:10])
        exclude = ctx.get("exclude_confirmation")
        if isinstance(exclude, str) and exclude:
            where_parts.append("h.confirmation <> ?")
            params.append(exclude)
        where = " AND ".join("(" + part + ")" for part in where_parts)
        if query:
            sql = (
                "SELECT h.*, snippet(hms_fts, 6, '[', ']', ' … ', 12) AS fts_snippet, bm25(hms_fts) AS fts_rank "
                "FROM hms_fts f JOIN hms_stay h ON h.rowid=f.rowid WHERE hms_fts MATCH ?"
            )
            if where:
                sql += " AND " + where
            sql += " ORDER BY fts_rank, h.created_at, h.confirmation LIMIT ? OFFSET ?"
            rows = _rows(con, sql, [query, *params, limit, offset])
        else:
            sql = "SELECT h.*, NULL AS fts_snippet FROM hms_stay h"
            if where:
                sql += " WHERE " + where
            sql += " ORDER BY h.created_at, h.confirmation LIMIT ? OFFSET ?"
            rows = _rows(con, sql, [*params, limit, offset])
        return _finish({
            "results": [_native_card(row, row["fts_snippet"] if "fts_snippet" in row.keys() else None) for row in rows],
            "count": len(rows),
            "limit": limit,
            "offset": offset,
            "query_syntax": "sqlite_fts5",
        }, ctx)
    finally:
        con.close()


def read_native(args: dict[str, Any], ctx: dict[str, Any], db: str | None = None) -> dict[str, Any]:
    confirmation = str(args.get("confirmation") or "")
    if confirmation.startswith("hms:"):
        confirmation = confirmation[4:]
    if not confirmation:
        return _finish({"found": False, "error": "confirmation_required"}, ctx)
    if ctx.get("exclude_confirmation") == confirmation:
        return _finish({"found": False, "excluded": True, "confirmation": confirmation, "id": "hms:" + confirmation}, ctx)
    con = connect(db, ctx)
    try:
        row = con.execute("SELECT * FROM hms_stay WHERE confirmation=?", [confirmation]).fetchone()
        if row is None:
            return _finish({"found": False, "confirmation": confirmation, "id": "hms:" + confirmation}, ctx)
        card = _native_card(row)
        card["found"] = True
        return _finish(card, ctx)
    finally:
        con.close()


TOOLS = {
    "search_mail": search_mail,
    "read_mail": read_mail,
    "header_neighbours": header_neighbours,
    "search_documents": search_documents,
    "read_document": read_document,
    "search_native": search_native,
    "read_native": read_native,
}


def call(name: str, args: dict[str, Any] | None, ctx: dict[str, Any] | None = None, db: str | None = None) -> dict[str, Any]:
    """Call one CONTRACT B tool and return its JSON-able dict."""
    context = _clean_ctx(ctx)
    arguments = dict(args or {})
    if name not in TOOLS:
        return {"error": "unknown_tool", "tool": name, "available": sorted(TOOLS)}
    try:
        return TOOLS[name](arguments, context, db)
    except sqlite3.Error as exc:
        return {"error": "sqlite_error", "tool": name, "message": str(exc)}
    except FileNotFoundError as exc:
        return {"error": "snapshot_missing", "tool": name, "message": str(exc)}


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="P4 CONTRACT B snapshot tools")
    parser.add_argument("tool", choices=sorted(TOOLS))
    parser.add_argument("args", help="JSON object of tool arguments")
    parser.add_argument("--db", default=None, help="snapshot sqlite path")
    parser.add_argument("--ctx", default="{}", help="JSON context object")
    ns = parser.parse_args(argv)
    try:
        args = json.loads(ns.args)
        if not isinstance(args, dict):
            raise ValueError("args must be a JSON object")
        ctx = json.loads(ns.ctx)
        if not isinstance(ctx, dict):
            raise ValueError("ctx must be a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"error": "bad_json", "message": str(exc)}, ensure_ascii=False))
        return 2
    result = call(ns.tool, args, ctx, ns.db)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
