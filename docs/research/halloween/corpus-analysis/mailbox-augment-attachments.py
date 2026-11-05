#!/usr/bin/env python3
"""Join a mailbox's MIME attachment inventory to its cleaned LLM packets.

The inventory describes this message only. An unavailable inventory is never
represented as a confirmed absence, and filenames are not document contents.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
from collections import Counter
from pathlib import Path


HERE = Path(__file__).resolve().parent
PRIVATE_ROOT = HERE.parents[3] / ".private"
UNAVAILABLE = {"locator_missing", "too_large", "read_error", "not_checked"}
MAX_ATTACHMENTS = 100


def _module(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cleaner = _module("range_prepare_attachment_join", "centurion-range-prepare.py")
pilot = _module("pilot_review_attachment_join", "pilot-250-review.py")


def _private_path(path: Path, *, existing: bool) -> Path:
    # Resolve the parent even for a new output; reject symlinks and paths outside
    # the owner's private directory. Do not create or overwrite input data.
    path = path.absolute()
    root = PRIVATE_ROOT.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    if not parent.is_relative_to(root) or path.is_symlink():
        raise ValueError("path_not_private")
    if existing and (not path.is_file() or path.stat().st_mode & 0o077):
        raise ValueError("input_not_private_file")
    return parent / path.name


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _read_rows(path: Path) -> list[dict]:
    with path.open("rb") as source:
        rows = [json.loads(line, object_pairs_hook=_strict_object) for line in source if line.strip()]
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise ValueError("empty_or_invalid_jsonl")
    cases = [row.get("case") for row in rows]
    if any(not isinstance(case, str) or not case for case in cases) or len(set(cases)) != len(cases):
        raise ValueError("missing_or_duplicate_case")
    return rows


def _safe_filename(value: object) -> str:
    if not isinstance(value, str):
        return "[filename unavailable]"
    # Filenames are untrusted data. Limit length, remove links/control chars,
    # scrub credentials/payment details, and withhold anything still detected.
    value = re.sub(r"(?i)\b(?:https?://|www\.)\S+", "[link removed]", value)
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)
    value = cleaner.scrub(value)[:200].strip()
    if not value or pilot._contains_sensitive_payment_data({"target": value}):
        return "[filename withheld]"
    return value


def _inventory_context(row: dict) -> tuple[str, str]:
    status = row.get("status")
    if status in UNAVAILABLE:
        return "Current-message MIME attachment inventory unavailable.", status
    if status != "ok" or not isinstance(row.get("attachments"), list):
        raise ValueError("invalid_inventory_status")
    attachments = row["attachments"]
    if not attachments:
        return "Current-message MIME inventory found no attachments.", "ok_empty"
    entries = []
    for attachment in attachments[:MAX_ATTACHMENTS]:
        if not isinstance(attachment, dict):
            raise ValueError("invalid_attachment")
        name = _safe_filename(attachment.get("name"))
        kind = attachment.get("content_type")
        if not isinstance(kind, str) or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+\-]+/[A-Za-z0-9!#$&^_.+\-]+", kind):
            kind = "application/octet-stream"
        entries.append({"filename": name, "content_type": kind})
    suffix = f" ({len(attachments) - MAX_ATTACHMENTS} additional attachments omitted)" if len(attachments) > MAX_ATTACHMENTS else ""
    return ("Current-message MIME attachment metadata (filenames/types only; contents not inspected): "
            + json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + suffix), "ok_with_attachments"


def augment(packets: list[dict], inventory: list[dict]) -> tuple[list[dict], dict]:
    by_case = {row["case"]: row for row in inventory}
    if set(by_case) != {row["case"] for row in packets}:
        raise ValueError("packet_inventory_case_mismatch")
    counts: Counter[str] = Counter()
    output = []
    for packet in packets:
        if not isinstance(packet.get("inbound"), dict):
            raise ValueError("missing_inbound")
        item = by_case[packet["case"]]
        context, status = _inventory_context(item)
        old = packet["inbound"].get("attachment_context", packet.get("attachment_context"))
        if old is not None and not isinstance(old, str):
            raise ValueError("invalid_existing_attachment_context")
        row = dict(packet)
        row["inbound"] = dict(packet["inbound"])
        row["inbound"]["attachment_context"] = context + ("\nPreviously inspected attachment observation: " + old if old else "")
        row.pop("attachment_context", None)
        body_status = item.get("body_status", "not_requested")
        if not isinstance(body_status, str):
            raise ValueError("invalid_body_status")
        if (not (row["inbound"].get("message") or "").strip()
                and not (row["inbound"].get("quoted_context") or "").strip() and body_status == "ok"):
            recovered = item.get("recovered_body")
            if not isinstance(recovered, str) or not recovered.strip():
                raise ValueError("invalid_recovered_body")
            current, quoted = cleaner.split_body(recovered, row["inbound"].get("subject") or "")
            row["inbound"]["message"] = current[:4000]
            row["inbound"]["quoted_context"] = quoted[:2000]
            counts["body_recovered"] += 1
        if isinstance(row.get("_source"), dict):
            row["_source"] = {**row["_source"], "mime_inventory_status": item.get("status"),
                              "mime_body_status": body_status}
        counts[status] += 1
        output.append(row)
    return output, dict(counts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        input_path = _private_path(args.input, existing=True)
        index_path = _private_path(args.index, existing=True)
        output_path = _private_path(args.output, existing=False)
        packets, inventory = _read_rows(input_path), _read_rows(index_path)
        rows, counts = augment(packets, inventory)
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            for row in rows:
                target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(json.dumps({"input": len(packets), "inventory": counts, "output": len(rows)}, sort_keys=True))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        # Do not echo JSON values, filenames, or sensitive input text.
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r"[a-z_]+", str(exc)) else "io_or_json_error"
        raise SystemExit(code) from None


if __name__ == "__main__":
    main()
