#!/usr/bin/env python3
"""Join reduced MIME attachment metadata to outbound reply candidates.

The join key is each candidate's existing ``outbound_case``. This utility
copies input packets and adds one deterministic, bounded
``outbound_attachment_context`` string per candidate. It never reads
attachment contents. Missing/unavailable MIME is kept distinct from confirmed
zero attachments.

Example::

    python3 -B mailbox-augment-outbound-attachments.py augment \
      --packets .private/invoice-cases.jsonl \
      --index .private/outbound-mime-index.jsonl \
      --output .private/invoice-cases-with-outbound-mime.jsonl

Use ``validate`` to independently reconstruct and compare every candidate
annotation against the MIME index before composing or aggregating results.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from collections import Counter
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
PRIVATE_ROOT = HERE.parents[3] / ".private"
SCHEMA_VERSION = "outbound_attachment_context/v1"
MIME_STATUSES = {"ok", "locator_missing", "too_large", "read_error"}
UNAVAILABLE_STATUSES = {"locator_missing", "too_large", "read_error"}
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9_]+(?:\.[A-Za-z0-9]{1,12})?$")
SAFE_CONTENT_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+\-]+/[A-Za-z0-9!#$&^_.+\-]+$")
MAX_CONTEXT_BYTES = 4096
MAX_SHOWN_ATTACHMENTS = 12
MAX_ROWS = 50_000
MAX_FILE_BYTES = 200_000_000


class AugmentFailure(Exception):
    """Expected, content-free validation error."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _private_path(path: Path, *, existing: bool) -> Path:
    path = path.absolute()
    root = PRIVATE_ROOT.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    if not parent.is_relative_to(root) or path.is_symlink():
        raise AugmentFailure("path_not_private")
    if stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise AugmentFailure("private_parent_permissions")
    if existing:
        if not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise AugmentFailure("input_not_private_file")
    elif path.exists():
        raise AugmentFailure("output_exists")
    return parent / path.name


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AugmentFailure("duplicate_json_key")
        result[key] = value
    return result


def _read_rows(path: Path, *, allow_empty: bool = False) -> list[dict[str, Any]]:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise AugmentFailure("input_too_large")
    rows: list[dict[str, Any]] = []
    cases: set[str] = set()
    try:
        with path.open("rb") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                if line_number > MAX_ROWS:
                    raise AugmentFailure("too_many_rows")
                row = json.loads(line, object_pairs_hook=_strict_object)
                if not isinstance(row, dict):
                    raise AugmentFailure("row_not_object")
                case = row.get("case")
                if not isinstance(case, str) or not case or case != case.strip():
                    raise AugmentFailure("case_schema")
                if case in cases:
                    raise AugmentFailure("duplicate_case")
                cases.add(case)
                rows.append(row)
    except AugmentFailure:
        raise
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        raise AugmentFailure("input_jsonl_invalid") from None
    if not rows and not allow_empty:
        raise AugmentFailure("input_empty")
    return rows


def _validate_attachment(entry: Any) -> dict[str, str]:
    if not isinstance(entry, dict) or set(entry) != {"name", "content_type"}:
        raise AugmentFailure("attachment_schema")
    name = entry.get("name")
    content_type = entry.get("content_type")
    if not isinstance(name, str) or len(name) > 128 or not SAFE_FILENAME.fullmatch(name):
        raise AugmentFailure("attachment_name_unsafe")
    if (not isinstance(content_type, str) or len(content_type) > 128
            or not SAFE_CONTENT_TYPE.fullmatch(content_type)):
        raise AugmentFailure("attachment_content_type_invalid")
    return {"name": name, "content_type": content_type}


def render_outbound_attachment_context(mime_record: dict[str, Any]) -> str:
    """Return stable bounded model context from one MIME index record.

    The MIME index row's ``case`` must be the candidate's ``outbound_case``.
    Filenames/types are reduced metadata only; no attachment content is read.
    """
    if not isinstance(mime_record, dict):
        raise AugmentFailure("mime_record_schema")
    case = mime_record.get("case")
    status = mime_record.get("status")
    if not isinstance(case, str) or not case or not isinstance(status, str) or status not in MIME_STATUSES:
        raise AugmentFailure("mime_record_identity_or_status")
    attachments = mime_record.get("attachments")
    if not isinstance(attachments, list) or len(attachments) > 1000:
        raise AugmentFailure("mime_attachments_schema")
    if status in UNAVAILABLE_STATUSES:
        if attachments:
            raise AugmentFailure("unavailable_mime_has_attachments")
        return (f"{SCHEMA_VERSION}; status={status}; absence_confirmed=unknown; "
                "attachment_count=unknown; attachments=unavailable")

    normalized = [_validate_attachment(item) for item in attachments]
    if not normalized:
        return (f"{SCHEMA_VERSION}; status=ok; absence_confirmed=true; "
                "attachment_count=0; attachments=[]")
    shown = normalized[:MAX_SHOWN_ATTACHMENTS]
    omitted = len(normalized) - len(shown)
    context = (
        f"{SCHEMA_VERSION}; status=ok; absence_confirmed=false; "
        f"attachment_count={len(normalized)}; attachments="
        + json.dumps(shown, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    )
    if omitted:
        context += f"; omitted_count={omitted}"
    if len(context.encode("utf-8")) > MAX_CONTEXT_BYTES:
        # The indexer's names are short and only twelve are shown. Fail closed
        # rather than silently clipping the string or dropping MIME evidence.
        raise AugmentFailure("context_too_large")
    return context


def _index_map(mime_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in mime_rows:
        case = row.get("case")
        if not isinstance(case, str) or case in result:
            raise AugmentFailure("mime_index_case_duplicate_or_invalid")
        # Render now, so malformed/status-conflicting rows fail before join.
        render_outbound_attachment_context(row)
        result[case] = row
    return result


def _candidate_outbounds(packets: list[dict[str, Any]]) -> tuple[set[str], int]:
    outbounds: set[str] = set()
    candidates = 0
    for packet in packets:
        candidate_rows = packet.get("candidate_replies", [])
        if candidate_rows is None:
            candidate_rows = []
        if not isinstance(candidate_rows, list) or len(candidate_rows) > 100:
            raise AugmentFailure("candidate_replies_schema")
        reply_ids: set[str] = set()
        for candidate in candidate_rows:
            if not isinstance(candidate, dict):
                raise AugmentFailure("candidate_reply_schema")
            reply_id = candidate.get("reply_id")
            if not isinstance(reply_id, (str, int)) or isinstance(reply_id, bool):
                raise AugmentFailure("candidate_reply_id_schema")
            reply_id = str(reply_id)
            if not reply_id or reply_id in reply_ids:
                raise AugmentFailure("candidate_reply_id_duplicate")
            reply_ids.add(reply_id)
            outbound_case = candidate.get("outbound_case")
            if not isinstance(outbound_case, str) or not outbound_case:
                raise AugmentFailure("candidate_outbound_case_missing")
            outbounds.add(outbound_case)
            candidates += 1
    return outbounds, candidates


def reconstruct_candidate_context(candidate: dict[str, Any],
                                  mime_by_case: dict[str, dict[str, Any]]) -> str:
    """Rebuild a candidate annotation from ``outbound_case`` and MIME index."""
    outbound_case = candidate.get("outbound_case")
    if not isinstance(outbound_case, str) or not outbound_case:
        raise AugmentFailure("candidate_outbound_case_missing")
    record = mime_by_case.get(outbound_case)
    if record is None:
        raise AugmentFailure("candidate_mime_index_missing")
    if record.get("case") != outbound_case:
        raise AugmentFailure("candidate_mime_index_case_mismatch")
    return render_outbound_attachment_context(record)


def validate_annotations(packets: list[dict[str, Any]],
                         mime_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate every annotation by independently reconstructing its string."""
    mime_by_case = _index_map(mime_rows)
    counts: Counter[str] = Counter()
    annotated = 0
    outbounds, candidate_count = _candidate_outbounds(packets)
    if outbounds - set(mime_by_case):
        raise AugmentFailure("candidate_mime_index_missing")
    for packet in packets:
        for candidate in packet.get("candidate_replies") or []:
            if "outbound_attachment_context" not in candidate:
                raise AugmentFailure("candidate_annotation_missing")
            expected = reconstruct_candidate_context(candidate, mime_by_case)
            if candidate.get("outbound_attachment_context") != expected:
                raise AugmentFailure("candidate_annotation_mismatch")
            row = mime_by_case[candidate["outbound_case"]]
            status = row["status"]
            if status == "ok":
                counts["ok_with_attachments" if row["attachments"] else "ok_empty"] += 1
            else:
                counts[status] += 1
            annotated += 1
    unique_statuses = Counter(mime_by_case[case]["status"] for case in outbounds)
    return {
        "schema": SCHEMA_VERSION,
        "packets": len(packets),
        "candidate_edges": candidate_count,
        "unique_outbound_cases": len(outbounds),
        "annotated_candidates": annotated,
        "mime_status_by_unique_outbound": dict(sorted(unique_statuses.items())),
        "mime_status_by_candidate": dict(sorted(counts.items())),
    }


def augment_packets(packets: list[dict[str, Any]],
                    mime_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    mime_by_case = _index_map(mime_rows)
    outbounds, candidate_count = _candidate_outbounds(packets)
    missing = outbounds - set(mime_by_case)
    if missing:
        raise AugmentFailure("candidate_mime_index_missing")
    output: list[dict[str, Any]] = []
    for packet in packets:
        row = dict(packet)
        candidates = []
        for candidate in packet.get("candidate_replies") or []:
            updated = dict(candidate)
            context = reconstruct_candidate_context(candidate, mime_by_case)
            if ("outbound_attachment_context" in candidate
                    and candidate["outbound_attachment_context"] != context):
                raise AugmentFailure("existing_candidate_annotation_mismatch")
            updated["outbound_attachment_context"] = context
            candidates.append(updated)
        row["candidate_replies"] = candidates
        output.append(row)
    report = validate_annotations(output, mime_rows)
    if report["candidate_edges"] != candidate_count:
        raise AugmentFailure("candidate_count_changed")
    return output, report


def _write_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            for row in rows:
                target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def self_test() -> int:
    invoice = {"case": "O00001", "status": "ok", "attachments": [
        {"name": "invoice_redacted.pdf", "content_type": "application/pdf"},
    ]}
    empty = {"case": "O00002", "status": "ok", "attachments": []}
    unavailable = {"case": "O00003", "status": "read_error", "attachments": []}
    rows = [invoice, empty, unavailable]
    packets = [{"case": "I00001", "candidate_replies": [
        {"reply_id": "R1", "outbound_case": "O00001"},
        {"reply_id": "R2", "outbound_case": "O00002"},
        {"reply_id": "R3", "outbound_case": "O00003"},
    ]}]
    augmented, report = augment_packets(packets, rows)
    candidates = augmented[0]["candidate_replies"]
    if "outbound_attachment_context" in packets[0]["candidate_replies"][0]:
        raise AugmentFailure("self_test_input_mutated")
    if "invoice_redacted.pdf" not in candidates[0]["outbound_attachment_context"]:
        raise AugmentFailure("self_test_filename_missing")
    if "absence_confirmed=true" not in candidates[1]["outbound_attachment_context"]:
        raise AugmentFailure("self_test_empty_not_confirmed")
    if "attachment_count=unknown" not in candidates[2]["outbound_attachment_context"]:
        raise AugmentFailure("self_test_unavailable_not_empty")
    validate_annotations(augmented, rows)
    changed = json.loads(json.dumps(augmented))
    changed[0]["candidate_replies"][0]["outbound_attachment_context"] += " tampered"
    try:
        validate_annotations(changed, rows)
    except AugmentFailure as exc:
        if exc.code != "candidate_annotation_mismatch":
            raise
    else:
        raise AugmentFailure("self_test_tampering_not_caught")
    if report["candidate_edges"] != 3 or report["unique_outbound_cases"] != 3:
        raise AugmentFailure("self_test_counts")
    return 7


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("self-test", help="run offline schema and reconstruction checks")
    augment_parser = commands.add_parser("augment", help="add deterministic MIME context to candidates")
    augment_parser.add_argument("--packets", type=Path, required=True)
    augment_parser.add_argument("--index", type=Path, required=True)
    augment_parser.add_argument("--output", type=Path, required=True)
    validate_parser = commands.add_parser("validate", help="reconstruct and verify every candidate annotation")
    validate_parser.add_argument("--packets", type=Path, required=True)
    validate_parser.add_argument("--index", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            checks = self_test()
            print(json.dumps({"self_test": "passed", "checks": checks}, sort_keys=True))
            return 0
        packet_path = _private_path(args.packets, existing=True)
        index_path = _private_path(args.index, existing=True)
        packets = _read_rows(packet_path)
        mime_rows = _read_rows(index_path, allow_empty=True)
        if args.command == "validate":
            report = validate_annotations(packets, mime_rows)
        else:
            output_path = _private_path(args.output, existing=False)
            output, report = augment_packets(packets, mime_rows)
            _write_rows(output_path, output)
        print(json.dumps(report, sort_keys=True))
        return 0
    except AugmentFailure as exc:
        print("error=" + exc.code, file=sys.stderr)
        return 2
    except Exception:
        print("error=internal", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
