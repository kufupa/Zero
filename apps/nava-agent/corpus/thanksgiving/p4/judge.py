#!/usr/bin/env python3
"""Run the blind Haiku judge for P4 booking-to-mail linkage."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO = Path("/home/orca/orca/workspaces/zero/nava-agent-rewrite-20261125")
TOOLS = REPO / "apps/nava-agent/corpus/thanksgiving/p4/tools.py"
DEFAULT_WORK = Path.home() / ".local/share/zero/research/thanksgiving/work/p4"
DEFAULT_DB = DEFAULT_WORK / "snapshot.sqlite"
MODEL = "claude-haiku-5-5"

ROLES = [
    "earliest_create_request",
    "prior_context",
    "amend_request",
    "cancel_request",
    "filing_voucher_pop",
    "staff_reply_or_letter",
    "later_outcome",
    "confounder",
    "unrelated",
]

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["confirmation", "arm", "status", "earliest_request", "members", "confounders", "notes", "tool_calls", "tokens", "wall_s", "model", "validator"],
    "properties": {
        "confirmation": {"type": "string"},
        "arm": {"type": "string", "enum": ["haiku_judge"]},
        "status": {"type": "string", "enum": ["found", "not_found", "ambiguous"]},
        "earliest_request": {
            "type": "array",
            "items": {"type": "object", "additionalProperties": False, "required": ["id", "quote"], "properties": {"id": {"type": "string"}, "quote": {"type": "string"}}},
        },
        "members": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "role", "quote"],
                "properties": {"id": {"type": "string"}, "role": {"type": "string", "enum": ROLES}, "quote": {"type": "string"}},
            },
        },
        "confounders": {
            "type": "array",
            "items": {"type": "object", "additionalProperties": False, "required": ["id", "why"], "properties": {"id": {"type": "string"}, "why": {"type": "string"}}},
        },
        "notes": {"type": "string"},
        "tool_calls": {"type": "integer", "minimum": 0},
        "tokens": {"type": "object", "additionalProperties": False, "required": ["in", "cached", "out"], "properties": {"in": {"type": "integer", "minimum": 0}, "cached": {"type": "integer", "minimum": 0}, "out": {"type": "integer", "minimum": 0}}},
        "wall_s": {"type": "number", "minimum": 0},
        "model": {"type": "string"},
        "validator": {"type": "object", "additionalProperties": False, "required": ["ok", "repaired", "dropped"], "properties": {"ok": {"type": "boolean"}, "repaired": {"type": "integer", "minimum": 0}, "dropped": {"type": "integer", "minimum": 0}}},
    },
}

SYSTEM_PROMPT = """You are the blind independent judge for booking-to-email linkage.

You never see Luna's answer. Do not ask for it, infer it, or mention it.

Use Bash only for commands of this exact form:
python3 /home/orca/orca/workspaces/zero/nava-agent-rewrite-20261125/apps/nava-agent/corpus/thanksgiving/p4/tools.py <tool> '<json args>' --db <db path from the case brief> --ctx '<json ctx>'

Allowed tools: search_mail, read_mail, header_neighbours, search_documents, read_document, search_native, read_native. Do not use cat, grep, sqlite3, python inspectors, web access, or any file read outside those seven tool commands. Pass the ctx JSON from the case brief unchanged on every call.

Task: find the earliest inbound request that caused the target booking, then classify other relevant messages. Search adversarially, not just backwards from confirmation evidence:
- hunt forwards from likely requests into staff replies, vouchers, payment proofs, amendments, cancellations, and later outcomes;
- expect other guests at the same agency in the same week, multi-room bursts, forwards inside hotel mail, copied prior threads, and one email causing several stays;
- never merge a different guest at the same agency into this booking; a false merge is catastrophic, while a false split is benign;
- later HMS/PDF/letter evidence is outcome evidence, not the create request;
- distinguish membership in the booking journey from temporal role;
- when evidence is insufficient say not_found; when two or more incompatible readings remain say ambiguous.

Every quote must be an exact contiguous substring of tool-delivered text. Prefer short quotes that prove guest, dates, request, amendment, cancellation, voucher/POP, or outcome. Use citable ids exactly as returned: msg:<id>, att:<id>, hdr:<id>, hms:<confirmation>.

Count every Bash invocation and put that count in tool_calls. Set arm exactly to haiku_judge. Set validator to {"ok":true,"repaired":0,"dropped":0}; post-validation will correct it if needed. Return only structured output matching the required schema."""


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if len(text) == 10:
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


def norm_space(value: str) -> str:
    return " ".join(value.split())


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def append_jsonl(path: Path, row: dict[str, Any], lock: threading.Lock) -> None:
    with lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def load_booking(db: Path, confirmation: str) -> dict[str, Any] | None:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            """
            select confirmation, guest_name, arrival, departure, created_at, created_by,
                   source_of_business, company, travel_agent, email_address, caller,
                   billing_reference, reservation_note, rate_plan, room_type, meal_plan,
                   adults, children, status, is_labtest, cohort_clean
            from hms_stay where confirmation = ?
            """,
            (confirmation,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def make_ctx(row: dict[str, Any], booking: dict[str, Any]) -> dict[str, Any]:
    created = parse_time(booking.get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    return {
        "window_from": iso_z(created - timedelta(days=30)),
        "window_to": iso_z(created + timedelta(hours=48)),
        "mask_tokens": list(row.get("mask_tokens") or []),
        "disable_headers": bool(row.get("disable_headers")),
        "exclude_confirmation": row["confirmation"],
    }


def case_brief(row: dict[str, Any], booking: dict[str, Any], ctx: dict[str, Any], db: Path) -> str:
    card = json.dumps(booking, ensure_ascii=False, sort_keys=True)
    ctx_text = json.dumps(ctx, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"""Investigate this booking blind.

Target booking read_native card (trusted booking facts):
{card}

Runtime facts:
- db: {db}
- ctx, pass unchanged to every tools.py call: {ctx_text}
- target confirmation: {row['confirmation']}

Find the earliest inbound request that caused this exact stay. Check forwards, same-agency other guests, multi-room bursts, later amendments, cancellation requests, voucher/POP filings, and unrelated lookalikes. Output the CONTRACT C object only."""


def command_for(prompt_file: Path, schema_text: str, brief: str, cfg: Path, cwd: Path) -> list[str]:
    unset = [
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_CHILD_NOTES_DIR",
        "CLAUDE_CODE_PLUGIN_DIRS",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ATTENDED",
    ]
    cmd = ["env"]
    for name in unset:
        cmd.extend(["-u", name])
    cmd.extend(
        [
            f"CLAUDE_CONFIG_DIR={cfg}",
            "claude",
            "-p",
            "--model",
            "haiku",
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--system-prompt-file",
            str(prompt_file),
            "--json-schema",
            schema_text,
            brief,
            "--tools",
            "Bash",
        ]
    )
    return cmd


def extract_usage(payload: dict[str, Any]) -> dict[str, int]:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return {
        "in": int(usage.get("input_tokens") or 0),
        "cached": int(usage.get("cache_read_input_tokens") or 0),
        "out": int(usage.get("output_tokens") or 0),
    }


def normalise_result(obj: dict[str, Any], confirmation: str) -> dict[str, Any]:
    out = dict(obj)
    out["confirmation"] = confirmation
    out["arm"] = "haiku_judge"
    out["status"] = out.get("status") if out.get("status") in {"found", "not_found", "ambiguous"} else "ambiguous"
    for key in ("earliest_request", "members", "confounders"):
        out[key] = list(out.get(key) or [])
    out["notes"] = str(out.get("notes") or "")
    try:
        out["tool_calls"] = max(0, int(out.get("tool_calls") or 0))
    except (TypeError, ValueError):
        out["tool_calls"] = 0
    tokens = out.get("tokens") if isinstance(out.get("tokens"), dict) else {}
    out["tokens"] = {"in": int(tokens.get("in") or 0), "cached": int(tokens.get("cached") or 0), "out": int(tokens.get("out") or 0)}
    try:
        out["wall_s"] = float(out.get("wall_s") or 0)
    except (TypeError, ValueError):
        out["wall_s"] = 0.0
    out["model"] = MODEL
    validator = out.get("validator") if isinstance(out.get("validator"), dict) else {}
    out["validator"] = {"ok": bool(validator.get("ok", True)), "repaired": int(validator.get("repaired") or 0), "dropped": int(validator.get("dropped") or 0)}
    return out


def quote_in_texts(quote: str, texts: list[str]) -> bool:
    q = norm_space(quote)
    if not q:
        return False
    return any(q in norm_space(text or "") for text in texts)


def validate_citations(obj: dict[str, Any], db: Path) -> dict[str, Any]:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    dropped = 0

    def valid(item: dict[str, Any]) -> bool:
        nonlocal dropped
        ident = str(item.get("id") or "")
        quote = str(item.get("quote") or "")
        kind, _, key = ident.partition(":")
        ok = False
        if kind == "msg" and key:
            row = con.execute("select subject, body_text from message where id=?", (key,)).fetchone()
            ok = bool(row) and quote_in_texts(quote, [row["subject"] or "", row["body_text"] or ""])
        elif kind == "hdr" and key:
            row = con.execute("select subject, body_text from message where id=?", (key,)).fetchone()
            ok = bool(row) and bool(norm_space(quote))
        elif kind == "att" and key:
            row = con.execute("select text from doc_text where attachment_id=?", (key,)).fetchone()
            ok = bool(row) and quote_in_texts(quote, [row["text"] or ""])
        elif kind == "hms" and key:
            row = con.execute("select raw_json,reservation_note,guest_name from hms_stay where confirmation=?", (key,)).fetchone()
            ok = bool(row) and (not norm_space(quote) or quote_in_texts(quote, [row["raw_json"] or "", row["reservation_note"] or "", row["guest_name"] or ""]))
        if not ok:
            dropped += 1
        return ok

    out = dict(obj)
    out["earliest_request"] = [item for item in out.get("earliest_request", []) if isinstance(item, dict) and valid(item)]
    out["members"] = [item for item in out.get("members", []) if isinstance(item, dict) and valid(item)]
    if out.get("status") == "found" and not out["earliest_request"]:
        out["status"] = "ambiguous"
        out["notes"] = (out.get("notes") + " validator: found had no surviving earliest_request citation.").strip()
    validator = dict(out.get("validator") or {})
    validator["dropped"] = int(validator.get("dropped") or 0) + dropped
    validator["repaired"] = int(validator.get("repaired") or 0)
    validator["ok"] = dropped == 0
    out["validator"] = validator
    con.close()
    return out


def error_result(row: dict[str, Any], error: str, wall_s: float) -> dict[str, Any]:
    return {
        "confirmation": row["confirmation"],
        "arm": "haiku_judge",
        "status": "ambiguous",
        "earliest_request": [],
        "members": [],
        "confounders": [],
        "notes": "judge_error: " + error[:500],
        "tool_calls": 0,
        "tokens": {"in": 0, "cached": 0, "out": 0},
        "wall_s": wall_s,
        "model": MODEL,
        "validator": {"ok": False, "repaired": 0, "dropped": 0},
    }


def run_case(row: dict[str, Any], args: argparse.Namespace, prompt_file: Path, schema_text: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    start = time.monotonic()
    confirmation = row["confirmation"]
    booking = load_booking(args.db, confirmation)
    if booking is None:
        return error_result(row, "confirmation missing from hms_stay", 0.0), None
    ctx = make_ctx(row, booking)
    brief = case_brief(row, booking, ctx, args.db)
    cmd = command_for(prompt_file, schema_text, brief, args.judge_cfg, args.judge_cwd)
    try:
        proc = subprocess.run(cmd, cwd=str(args.judge_cwd), text=True, capture_output=True, timeout=args.timeout, env=os.environ.copy())
    except Exception as exc:
        return error_result(row, f"spawn failed: {exc}", time.monotonic() - start), None
    wall = time.monotonic() - start
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")[:500]
        return error_result(row, f"claude rc={proc.returncode}: {err}", wall), None
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return error_result(row, "claude stdout was not json", wall), None
    structured = payload.get("structured_output")
    if not isinstance(structured, dict):
        result_text = payload.get("result")
        try:
            structured = json.loads(result_text) if isinstance(result_text, str) else None
        except json.JSONDecodeError:
            structured = None
    if not isinstance(structured, dict):
        return error_result(row, "structured_output missing", wall), None
    result = normalise_result(structured, confirmation)
    result["wall_s"] = round(wall, 3)
    result["tokens"] = extract_usage(payload)
    result = validate_citations(result, args.db)
    diagnostic = {
        "confirmation": confirmation,
        "session_id": payload.get("session_id"),
        "num_turns": payload.get("num_turns"),
        "duration_ms": payload.get("duration_ms"),
        "terminal_reason": payload.get("terminal_reason"),
        "total_cost_usd": payload.get("total_cost_usd"),
        "is_error": payload.get("is_error"),
    }
    return result, diagnostic


def prepare_profile(cfg: Path, cwd: Path) -> None:
    cfg.mkdir(parents=True, exist_ok=True)
    cwd.mkdir(parents=True, exist_ok=True)
    creds = Path.home() / ".claude/.credentials.json"
    link = cfg / ".credentials.json"
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(creds)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", type=Path, required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--run-id")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--judge-cfg", type=Path, default=DEFAULT_WORK / "judge-cfg")
    parser.add_argument("--judge-cwd", type=Path, default=DEFAULT_WORK / "judge-cwd")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    rows = read_jsonl(args.sample)
    if args.limit:
        rows = rows[: args.limit]
    run_id = args.run_id or datetime.now(timezone.utc).strftime("judge-%Y%m%dT%H%M%SZ")
    run_dir = DEFAULT_WORK / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out or (run_dir / "judge.jsonl")
    prompt_file = run_dir / "judge_prompt.md"
    prompt_file.write_text(SYSTEM_PROMPT + "\n", encoding="utf-8")
    schema_text = json.dumps(SCHEMA, separators=(",", ":"))
    (run_dir / "judge_schema.json").write_text(json.dumps(SCHEMA, indent=2) + "\n", encoding="utf-8")
    prepare_profile(args.judge_cfg, args.judge_cwd)

    done = {row.get("confirmation") for row in read_jsonl(out_path)}
    todo = [row for row in rows if row.get("confirmation") not in done]
    if args.dry_run:
        for row in todo[:1]:
            booking = load_booking(args.db, row["confirmation"])
            if booking:
                brief = case_brief(row, booking, make_ctx(row, booking), args.db)
                cmd = command_for(prompt_file, schema_text, brief, args.judge_cfg, args.judge_cwd)
                print(json.dumps({"cases": len(todo), "out": str(out_path), "command_preview": cmd[:8] + ["..."], "prompt_file": str(prompt_file)}, sort_keys=True))
                return 0
        print(json.dumps({"cases": len(todo), "out": str(out_path), "prompt_file": str(prompt_file)}, sort_keys=True))
        return 0

    lock = threading.Lock()
    errors_path = run_dir / "judge-diagnostics.jsonl"
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {pool.submit(run_case, row, args, prompt_file, schema_text): row for row in todo}
        for future in as_completed(futures):
            row = futures[future]
            try:
                result, diagnostic = future.result()
            except Exception as exc:
                result, diagnostic = error_result(row, f"worker crashed: {exc}", 0.0), None
            append_jsonl(out_path, result, lock)
            if diagnostic:
                append_jsonl(errors_path, diagnostic, lock)
            completed += 1
            print(f"judge {completed}/{len(todo)} {row.get('confirmation')} {result.get('status')}", flush=True)
    print(json.dumps({"ok": True, "run_id": run_id, "out": str(out_path), "completed": completed, "skipped_existing": len(rows) - len(todo)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
