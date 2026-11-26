#!/usr/bin/env python3
"""CONTRACT C citation/chronology validator.

The linker records only tool-delivered text in EvidenceStore. Validation never treats
model memory, lead metadata, or the target HMS orientation card as citable evidence.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from tools import connect

CITABLE_PREFIXES = ("msg:", "att:", "hdr:", "hms:")
ROLES = {
    "earliest_create_request", "prior_context", "amend_request", "cancel_request",
    "filing_voucher_pop", "staff_reply_or_letter", "later_outcome", "confounder", "unrelated",
}
STATUSES = {"found", "not_found", "ambiguous"}
NON_EVIDENCE_KEYS = {
    "id", "message_id", "attachment_id", "mail_id", "error", "message", "query_syntax", "doc_source",
    "source", "fetched_at", "count", "limit", "offset", "missing_ids", "disabled", "found", "excluded",
    "fts_rank", "is_inline", "size_bytes", "adults", "children", "is_labtest", "cohort_clean",
}
META_KEYS = {"sent_at", "received_at", "direction", "thread_id", "message_id", "attachment_id", "confirmation"}


def is_citable(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(CITABLE_PREFIXES)


class EvidenceStore:
    """Delivered source text keyed by citable id. Chunks are preserved, not concatenated."""

    def __init__(self) -> None:
        self.texts: dict[str, list[str]] = {}
        self.meta: dict[str, dict[str, Any]] = {}

    def add_text(self, citable_id: str, text: Any, **meta: Any) -> None:
        if not is_citable(citable_id) or not isinstance(text, str) or text == "":
            return
        bucket = self.texts.setdefault(citable_id, [])
        if text not in bucket:
            bucket.append(text)
        if meta:
            self.meta.setdefault(citable_id, {}).update({key: value for key, value in meta.items() if value is not None})

    def _add_dict_scalars(self, citable_id: str, obj: dict[str, Any]) -> None:
        meta: dict[str, Any] = {}
        for key in META_KEYS:
            if key in obj and isinstance(obj[key], (str, int, float)):
                meta[key] = obj[key]
        for key, value in obj.items():
            if key in NON_EVIDENCE_KEYS or isinstance(value, (dict, list, tuple)):
                continue
            if isinstance(value, str) and value:
                self.add_text(citable_id, value, **meta)
            elif isinstance(value, (int, float)) and key in {"sent_at", "received_at"}:
                self.add_text(citable_id, str(value), **meta)
        if meta:
            self.meta.setdefault(citable_id, {}).update(meta)

    def add_tool_output(self, value: Any) -> None:
        """Walk one tool result. Any scalar inside an object carrying a citable id is delivered text."""
        def walk(node: Any, inherited_id: str | None = None) -> None:
            if isinstance(node, dict):
                own = node.get("id") if is_citable(node.get("id")) else inherited_id
                if own:
                    self._add_dict_scalars(own, node)
                for child in node.values():
                    walk(child, own)
            elif isinstance(node, list):
                for child in node:
                    walk(child, inherited_id)
        walk(value)

    def has_id(self, citable_id: str) -> bool:
        return citable_id in self.texts or citable_id in self.meta

    def chunks(self, citable_id: str) -> list[str]:
        return list(self.texts.get(citable_id, []))

    def to_json(self) -> dict[str, Any]:
        return {"texts": self.texts, "meta": self.meta}

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "EvidenceStore":
        store = cls()
        if isinstance(value.get("texts"), dict):
            store.texts = {str(key): [str(item) for item in items if isinstance(item, str)] for key, items in value["texts"].items() if isinstance(items, list)}
        if isinstance(value.get("meta"), dict):
            store.meta = {str(key): dict(item) for key, item in value["meta"].items() if isinstance(item, dict)}
        return store


def parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
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


def whitespace_repair(source: str, quote: str) -> str | None:
    """Return the exact source substring when quote differs only by whitespace runs."""
    core = quote.strip()
    if not core:
        return None
    pieces = [re.escape(piece) for piece in re.split(r"\s+", core) if piece]
    if not pieces:
        return None
    pattern = r"\s+".join(pieces)
    try:
        match = re.search(pattern, source, flags=re.MULTILINE)
    except re.error:
        return None
    return match.group(0) if match else None


def quote_in_chunks(chunks: list[str], quote: str) -> tuple[bool, str | None, str]:
    """(ok, exact_repaired_quote, problem). Exact first, whitespace-normalised repair second."""
    if not isinstance(quote, str) or not quote.strip():
        return False, None, "empty_quote"
    for chunk in chunks:
        if quote in chunk:
            return True, quote, ""
    for chunk in chunks:
        repaired = whitespace_repair(chunk, quote)
        if repaired is not None:
            return True, repaired, "whitespace_repaired"
    return False, None, "quote_not_in_delivered_text"


def _drop_edge(result: dict[str, Any], citable_id: str, role: str | None = None) -> bool:
    removed = False
    if role in (None, "earliest_create_request"):
        before = len(result.get("earliest_request", []))
        result["earliest_request"] = [item for item in result.get("earliest_request", []) if not (isinstance(item, dict) and item.get("id") == citable_id)]
        removed = removed or len(result["earliest_request"]) != before
    members = result.get("members", [])
    kept = []
    for item in members:
        if not isinstance(item, dict):
            removed = True
            continue
        if item.get("id") == citable_id and (role is None or item.get("role") == role or role == "earliest_create_request"):
            removed = True
            continue
        kept.append(item)
    result["members"] = kept
    return removed


def _drop_confounder(result: dict[str, Any], citable_id: str) -> bool:
    before = len(result.get("confounders", []))
    result["confounders"] = [item for item in result.get("confounders", []) if not (isinstance(item, dict) and item.get("id") == citable_id)]
    return len(result["confounders"]) != before


def _resolve_message_id(con: sqlite3.Connection, citable_id: str) -> str | None:
    if citable_id.startswith("msg:"):
        return citable_id[4:]
    if citable_id.startswith("hdr:"):
        return citable_id[4:]
    if citable_id.startswith("att:"):
        row = con.execute("SELECT message_id FROM attachment WHERE id=?", [citable_id[4:]]).fetchone()
        return row["message_id"] if row else None
    return None


def _sent_at(con: sqlite3.Connection, evidence: EvidenceStore, citable_id: str) -> datetime | None:
    meta = evidence.meta.get(citable_id, {})
    direct = parse_dt(meta.get("sent_at"))
    if direct is not None:
        return direct
    message_id = _resolve_message_id(con, citable_id)
    if not message_id:
        return None
    row = con.execute("SELECT sent_at FROM message WHERE id=?", [message_id]).fetchone()
    return parse_dt(row["sent_at"]) if row else None


def validate_result(
    result: dict[str, Any],
    evidence: EvidenceStore,
    db: str | None = None,
    ctx: dict[str, Any] | None = None,
    repairer: Callable[[dict[str, Any]], dict[str, str] | None] | None = None,
) -> dict[str, Any]:
    """Validate/repair one CONTRACT C result.

    - ids must be in the delivered set
    - quotes must be exact contiguous substrings; whitespace-only drift is repaired in place
    - for any other failing citation, repairer is asked once for that citation only
    - failing edges are dropped, never silently retained
    - earliest_create_request mail must be sent_at <= hms.created_at + 15 minutes
    """
    out = copy.deepcopy(result)
    out.setdefault("earliest_request", [])
    out.setdefault("members", [])
    out.setdefault("confounders", [])
    repaired = 0
    dropped = 0
    dropped_marks: set[tuple[str, str]] = set()
    structural_ok = isinstance(out.get("confirmation"), str) and out.get("status") in STATUSES

    def mark_dropped(kind: str, citable_id: str) -> None:
        nonlocal dropped
        mark = (kind, citable_id)
        if mark not in dropped_marks:
            dropped_marks.add(mark)
            dropped += 1

    def check_citation(container: str, index: int, item: Any) -> None:
        nonlocal repaired, structural_ok
        if not isinstance(item, dict):
            structural_ok = False
            if container == "members":
                out["members"].pop(index)
            elif container == "earliest_request":
                out["earliest_request"].pop(index)
            elif container == "confounders":
                out["confounders"].pop(index)
            mark_dropped(container, f"index:{index}")
            return
        citable_id = item.get("id")
        role = item.get("role") if container == "members" else None
        if container == "members" and role not in ROLES:
            problem = "invalid_role"
        elif not is_citable(citable_id):
            problem = "invalid_citable_id"
        elif not evidence.has_id(citable_id):
            problem = "id_not_in_delivered_set"
        elif container == "confounders":
            problem = ""
        else:
            ok, fixed_quote, quote_problem = quote_in_chunks(evidence.chunks(citable_id), item.get("quote"))
            if ok and fixed_quote != item.get("quote"):
                item["quote"] = fixed_quote
                repaired += 1
                problem = ""
            elif ok:
                problem = ""
            else:
                problem = quote_problem
        if not problem:
            return

        failure = {
            "container": container,
            "index": index,
            "id": citable_id if isinstance(citable_id, str) else "",
            "role": role or "",
            "quote": item.get("quote") if isinstance(item.get("quote"), str) else "",
            "problem": problem,
        }
        fixed: dict[str, str] | None = None
        if repairer is not None and problem not in {"invalid_role", "invalid_citable_id"}:
            try:
                candidate = repairer(failure)
                if isinstance(candidate, dict) and is_citable(candidate.get("id")) and isinstance(candidate.get("quote"), str):
                    fixed = {"id": str(candidate["id"]), "quote": candidate["quote"]}
            except Exception:
                fixed = None
        accepted = False
        if fixed is not None and evidence.has_id(fixed["id"]):
            ok, exact, _why = quote_in_chunks(evidence.chunks(fixed["id"]), fixed["quote"])
            if ok and exact is not None:
                original_id = str(citable_id) if isinstance(citable_id, str) else ""
                original_quote = failure.get("quote", "")
                item["id"] = fixed["id"]
                item["quote"] = exact
                # earliest_request and the earliest member are two views of one edge;
                # repair the paired citation too so Luna is asked once per edge/citation.
                if container == "members" and role == "earliest_create_request":
                    for paired in out.get("earliest_request", []):
                        if isinstance(paired, dict) and paired.get("id") == original_id and paired.get("quote") == original_quote:
                            paired["id"] = fixed["id"]
                            paired["quote"] = exact
                elif container == "earliest_request":
                    for paired in out.get("members", []):
                        if isinstance(paired, dict) and paired.get("role") == "earliest_create_request" and paired.get("id") == original_id and paired.get("quote") == original_quote:
                            paired["id"] = fixed["id"]
                            paired["quote"] = exact
                repaired += 1
                accepted = True
        if accepted:
            return

        cid = str(citable_id) if isinstance(citable_id, str) else f"index:{index}"
        removed = False
        if container == "members":
            removed = _drop_edge(out, cid, str(role) if isinstance(role, str) else None)
        elif container == "earliest_request":
            removed = _drop_edge(out, cid, "earliest_create_request")
        elif container == "confounders":
            removed = _drop_confounder(out, cid)
        if removed or not is_citable(citable_id):
            mark_dropped(container, cid)

    # Work backwards so list removal does not disturb later indexes.
    for container in ("members", "earliest_request", "confounders"):
        values = list(out.get(container, []))
        if not isinstance(values, list):
            structural_ok = False
            out[container] = []
            continue
        for index in range(len(values) - 1, -1, -1):
            if index < len(out.get(container, [])):
                check_citation(container, index, out[container][index])

    # Chronology: every earliest-create citation must be at/before created_at + 15m.
    if db:
        con = connect(db, ctx or {})
        try:
            stay = con.execute("SELECT created_at FROM hms_stay WHERE confirmation=?", [out.get("confirmation")]).fetchone()
            created = parse_dt(stay["created_at"]) if stay else None
            if created is not None:
                deadline = created + timedelta(minutes=15)
                chrono_ids: set[str] = set()
                for item in out.get("earliest_request", []):
                    if isinstance(item, dict) and is_citable(item.get("id")):
                        chrono_ids.add(item["id"])
                for item in out.get("members", []):
                    if isinstance(item, dict) and item.get("role") == "earliest_create_request" and is_citable(item.get("id")):
                        chrono_ids.add(item["id"])
                for citable_id in sorted(chrono_ids):
                    sent = _sent_at(con, evidence, citable_id)
                    if sent is None or sent > deadline:
                        if _drop_edge(out, citable_id, "earliest_create_request"):
                            mark_dropped("chronology", citable_id)
        finally:
            con.close()

    has_earliest = bool(out.get("earliest_request")) and any(
        isinstance(item, dict) and item.get("role") == "earliest_create_request" for item in out.get("members", [])
    )
    ok = structural_ok
    if out.get("status") == "found" and not has_earliest:
        ok = False
    out["validator"] = {"ok": bool(ok), "repaired": int(repaired), "dropped": int(dropped)}
    return out


def evidence_path_key(confirmation: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", confirmation) + ".json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate CONTRACT C lines against serialized EvidenceStore files")
    parser.add_argument("--links", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--db", default=None)
    parser.add_argument("--ctx", default="{}")
    ns = parser.parse_args(argv)
    ctx = json.loads(ns.ctx)
    evidence_dir = Path(ns.evidence_dir)
    for line in Path(ns.links).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        path = evidence_dir / evidence_path_key(str(row.get("confirmation", "")))
        store = EvidenceStore.from_json(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else EvidenceStore()
        print(json.dumps(validate_result(row, store, db=ns.db, ctx=ctx), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
