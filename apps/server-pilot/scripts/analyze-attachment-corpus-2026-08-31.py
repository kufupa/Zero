#!/usr/bin/env python3
"""Analyze a sealed local Centurion corpus without contacting production.

The input is a published private snapshot directory.  This script deliberately
does not print message bodies, addresses, filenames, storage keys, or artifact
contents.  It emits only opaque identifiers, hashes, extraction states, and
aggregate field relationships.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "attachment-corpus-analysis-v1"
MONEY_RE = re.compile(
    r"(?i)(?:(?P<code>USD|ZAR|EUR|GBP|AUD|CAD)\s*)?"
    r"(?P<symbol>[$€£])?\s*(?P<amount>\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))"
)
REFERENCE_RE = re.compile(r"(?i)\b(?:reservation|booking|confirmation|reference|res)\s*(?:id|no|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})")
DATE_RE = re.compile(r"\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b")
DECORATIVE_NAME_RE = re.compile(r"(?i)(?:logo|banner|signature|tracking|pixel|spacer|icon|favicon|beacon)")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _read_corpus(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    records: list[dict[str, Any]] = []
    metadata: dict[str, Any] | None = None
    lines: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            lines.append(line)
            if not line.strip():
                continue
            value = json.loads(line)
            if index == 0:
                if value.get("recordType") != "metadata":
                    raise ValueError("corpus metadata record missing")
                metadata = value
                continue
            if value.get("recordType") != "thread":
                raise ValueError("corpus thread record malformed")
            records.append(value)
    if metadata is None:
        raise ValueError("corpus metadata record missing")
    ordered = "".join(lines[1:])
    if metadata.get("orderedRecordSha256") != _sha256(ordered.encode("utf-8")):
        raise ValueError("corpus ordered-record hash mismatch")
    return metadata, records, "".join(lines)


def _safe_artifact(snapshot_dir: Path, kind: str, reference: dict[str, Any] | None) -> tuple[bytes | None, str]:
    if not reference:
        return None, "not_retained"
    artifact_id = reference.get("id")
    if not isinstance(artifact_id, str) or not re.fullmatch(r"[a-f0-9]{64}", artifact_id):
        return None, "malformed"
    directory = {"attachment_bytes": "attachment-bytes", "attachment_text": "attachment-text"}.get(kind)
    extension = {"attachment_bytes": "bin", "attachment_text": "txt"}.get(kind)
    if directory is None or extension is None:
        return None, "unsupported"
    target = snapshot_dir / directory / f"{artifact_id}.{extension}"
    try:
        directory_path = snapshot_dir / directory
        directory_stat = directory_path.lstat()
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_ISLNK(directory_stat.st_mode)
            or stat.S_IMODE(directory_stat.st_mode) != 0o700
            or directory_path.resolve(strict=True) != directory_path
        ):
            return None, "unsafe_path"
        target_stat = target.lstat()
        if (
            not stat.S_ISREG(target_stat.st_mode)
            or stat.S_ISLNK(target_stat.st_mode)
            or stat.S_IMODE(target_stat.st_mode) != 0o600
            or target.resolve(strict=True) != target
        ):
            return None, "unsafe_permissions"
        data = target.read_bytes()
    except (OSError, RuntimeError):
        return None, "missing"
    if len(data) != reference.get("bytes") or _sha256(data) != reference.get("sha256"):
        return None, "hash_mismatch"
    return data, "available"


def _normal_amount(code: str | None, symbol: str | None, raw: str) -> str | None:
    compact = raw.replace(" ", "")
    if "." in compact and "," in compact:
        decimal_separator = "." if compact.rfind(".") > compact.rfind(",") else ","
        thousands_separator = "," if decimal_separator == "." else "."
        value = compact.replace(thousands_separator, "").replace(decimal_separator, ".")
    elif "," in compact:
        value = compact.replace(",", ".") if len(compact.rsplit(",", 1)[1]) == 2 else compact.replace(",", "")
    elif "." in compact:
        value = compact if len(compact.rsplit(".", 1)[1]) == 2 else compact.replace(".", "")
    else:
        value = compact
    try:
        amount = Decimal(value).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
    currency = code or {"$": "USD", "€": "EUR", "£": "GBP"}.get(symbol or "", "UNKNOWN")
    return f"{currency}:{amount:.2f}"


def _fields(text: str) -> dict[str, list[str]]:
    amounts = sorted({value for value in (_normal_amount(m.group("code"), m.group("symbol"), m.group("amount")) for m in MONEY_RE.finditer(text)) if value})
    references = sorted({match.group(1).upper() for match in REFERENCE_RE.finditer(text)})
    dates = sorted(set(DATE_RE.findall(text)))
    lowered = text.lower()
    payment = []
    for token in ("paid", "payment received", "payment confirmed", "deposit", "invoice"):
        if token in lowered:
            payment.append(token.replace(" ", "_"))
    confirmation = []
    for token in ("confirmed", "confirmation", "reserved", "reservation"):
        if token in lowered:
            confirmation.append(token)
    return {
        "amount": amounts,
        "reservation_reference": references,
        "date": dates,
        "payment_status": sorted(set(payment)),
        "confirmation_status": sorted(set(confirmation)),
    }


def _relationship(email: list[str], attachment: list[str], unresolved: bool = False) -> str:
    if unresolved:
        return "unresolved_extraction"
    if email and attachment:
        return "both" if set(email) == set(attachment) else "mismatch"
    if email:
        return "email_only"
    if attachment:
        return "attachment_only"
    return "unresolved_extraction" if unresolved else "neither"


def _iter_rows(threads: Iterable[dict[str, Any]]) -> Iterable[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    for thread in threads:
        for message in thread.get("messages", []):
            for row in message.get("sourceRows", []):
                yield thread, message, row


def analyze_snapshot(snapshot_dir: str | Path) -> dict[str, Any]:
    requested_root = Path(snapshot_dir).absolute()
    root = requested_root.resolve(strict=True)
    root_stat = requested_root.lstat()
    if (
        requested_root != root
        or not stat.S_ISDIR(root_stat.st_mode)
        or stat.S_ISLNK(root_stat.st_mode)
        or stat.S_IMODE(root_stat.st_mode) != 0o700
    ):
        raise ValueError("snapshot directory permissions are unsafe")
    for name in ("manifest.json", "corpus.jsonl"):
        file_path = root / name
        file_stat = file_path.lstat()
        if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode) or stat.S_IMODE(file_stat.st_mode) != 0o600:
            raise ValueError("snapshot file permissions are unsafe")
    manifest = _read_json(root / "manifest.json")
    metadata, threads, corpus_bytes = _read_corpus(root / "corpus.jsonl")
    if manifest.get("snapshotId") is None:
        raise ValueError("manifest snapshot id missing")
    if metadata.get("snapshotId") != manifest.get("snapshotId") or manifest.get("localObjectSha256") != _sha256(corpus_bytes.encode("utf-8")):
        raise ValueError("sealed snapshot hash mismatch")

    attachment_records: list[dict[str, Any]] = []
    thread_text: dict[str, str] = {}
    thread_attachments: dict[str, list[str]] = defaultdict(list)
    hash_to_ids: dict[str, list[str]] = defaultdict(list)
    extraction_states: Counter[str] = Counter()

    for thread, _message, row in _iter_rows(threads):
        thread_id = str(thread.get("threadId") or f"unresolved:{row.get('sourceRowId', '')}")
        thread_text[thread_id] = thread_text.get(thread_id, "") + "\n" + str(row.get("body", ""))
        private = row.get("privateMessage") or {}
        for descriptor in private.get("attachments", []):
            attachment_id = descriptor.get("id")
            if not isinstance(attachment_id, str):
                raise ValueError("attachment id missing")
            text_artifact = descriptor.get("textArtifact")
            bytes_artifact = descriptor.get("bytesArtifact")
            text, text_state = _safe_artifact(root, "attachment_text", (text_artifact or {}).get("artifact") if isinstance(text_artifact, dict) else None)
            raw_bytes, byte_state = _safe_artifact(root, "attachment_bytes", (bytes_artifact or {}).get("artifact") if isinstance(bytes_artifact, dict) else None)
            if isinstance(bytes_artifact, dict) and bytes_artifact.get("status") != "available":
                byte_state = str(bytes_artifact.get("status"))
            if isinstance(text_artifact, dict) and text_artifact.get("status") != "available":
                text_state = str(text_artifact.get("status"))
            if str(descriptor.get("contentType", "")).lower().startswith("image/") and text_state != "available":
                extraction_state = "ocr_unavailable" if byte_state == "available" else byte_state
            else:
                extraction_state = text_state
            extraction_states[extraction_state] += 1
            attachment_text = text.decode("utf-8", errors="replace") if text is not None else ""
            fields = _fields(attachment_text) if text is not None else {key: [] for key in ("amount", "reservation_reference", "date", "payment_status", "confirmation_status")}
            content_hash = _sha256(raw_bytes) if raw_bytes is not None else None
            if content_hash:
                hash_to_ids[content_hash].append(attachment_id)
            thread_attachments[thread_id].append(attachment_id)
            inline_value = descriptor.get("inline", "inline_unknown")
            if inline_value not in (True, False):
                inline_value = "inline_unknown"
            attachment_records.append({
                "attachmentId": attachment_id,
                "messageId": str(descriptor.get("messageId", row.get("sourceRowId", ""))),
                "mimeType": str(descriptor.get("contentType", "")),
                "byteSize": int(descriptor.get("byteSize", 0)),
                "inline": inline_value,
                "contentHash": content_hash,
                "duplicate": False,
                "documentClass": "unknown",
                "extractionState": extraction_state,
                "fields": fields,
                "textRetained": text_state == "available",
                "bytesRetained": byte_state == "available",
                "_filenameHint": str(descriptor.get("filename", "")),
            })

    for record in attachment_records:
        content_hash = record["contentHash"]
        duplicate_count = len(hash_to_ids.get(content_hash, [])) if content_hash else 0
        record["duplicate"] = duplicate_count > 1
        mime = record["mimeType"].lower()
        inline = record["inline"]
        filename_hint = str(record.get("_filenameHint", ""))
        if inline is True or (mime.startswith("image/") and (duplicate_count > 1 or DECORATIVE_NAME_RE.search(filename_hint))):
            record["documentClass"] = "decorative"
        elif record["textRetained"] or (mime == "application/pdf" and record["bytesRetained"]):
            record["documentClass"] = "useful" if record["fields"]["amount"] or record["fields"]["reservation_reference"] or record["fields"]["payment_status"] or record["fields"]["confirmation_status"] else "unknown"
        elif mime.startswith("image/"):
            record["documentClass"] = "unknown"
        record.pop("_filenameHint", None)

    relationships: Counter[str] = Counter()
    reconciliations: list[dict[str, Any]] = []
    field_names = ("amount", "reservation_reference", "date", "payment_status", "confirmation_status")
    by_id = {record["attachmentId"]: record for record in attachment_records}
    for thread_id in sorted(thread_text):
        email_fields = _fields(thread_text[thread_id])
        attachment_fields = {name: [] for name in field_names}
        unresolved = False
        for attachment_id in thread_attachments.get(thread_id, []):
            record = by_id[attachment_id]
            for name in field_names:
                attachment_fields[name].extend(record["fields"][name])
            unresolved = unresolved or (
                record["documentClass"] != "decorative"
                and record["extractionState"] in {
                    "ocr_unavailable",
                    "unresolved_extraction",
                    "not_retained",
                    "missing",
                    "hash_mismatch",
                    "unsafe_path",
                    "unsafe_permissions",
                    "encrypted",
                    "malformed",
                    "read_failed",
                    "timeout",
                }
            )
        fields = {}
        for name in field_names:
            email_values = sorted(set(email_fields[name]))
            attachment_values = sorted(set(attachment_fields[name]))
            relation = _relationship(email_values, attachment_values, unresolved and not attachment_values)
            relationships[relation] += 1
            fields[name] = {"email": email_values, "attachment": attachment_values, "relationship": relation}
        reconciliations.append({"threadId": thread_id, "fields": fields})

    duplicate_groups = {content_hash: sorted(ids) for content_hash, ids in hash_to_ids.items() if len(ids) > 1}
    counts = {
        "threads": len(threads),
        "messages": sum(len(thread.get("messages", [])) for thread in threads),
        "attachments": len(attachment_records),
        "pdfs": sum(record["mimeType"].lower() == "application/pdf" for record in attachment_records),
        "images": sum(record["mimeType"].lower().startswith("image/") for record in attachment_records),
        "uniqueContentHashes": len(hash_to_ids),
        "duplicateGroups": len(duplicate_groups),
        "inline": sum(record["inline"] is True for record in attachment_records),
        "inlineImages": sum(record["inline"] is True and record["mimeType"].lower().startswith("image/") for record in attachment_records),
        "inlineUnknown": sum(record["inline"] == "inline_unknown" for record in attachment_records),
        "bytesRetained": sum(record["bytesRetained"] for record in attachment_records),
        "textRetained": sum(record["textRetained"] for record in attachment_records),
        "usefulDocuments": sum(record["documentClass"] == "useful" for record in attachment_records),
        "decorativeDocuments": sum(record["documentClass"] == "decorative" for record in attachment_records),
        "unknownDocuments": sum(record["documentClass"] == "unknown" for record in attachment_records),
        "extractionStates": dict(sorted(extraction_states.items())),
        "fieldRelationships": dict(sorted(relationships.items())),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "snapshotId": manifest["snapshotId"],
        "sourceSchemaVersion": manifest.get("schemaVersion"),
        "asOf": manifest.get("window", {}).get("endExclusive"),
        "sourceIntegrity": {
            "orderedRecordSha256": manifest.get("orderedRecordSha256"),
            "localObjectSha256": manifest.get("localObjectSha256"),
            "artifactInventorySha256": manifest.get("artifactInventorySha256"),
            "scope": manifest.get("scope"),
        },
        "denominators": {"reconciliationThreads": len(thread_text)},
        "counts": counts,
        "duplicateGroups": duplicate_groups,
        "attachments": sorted(attachment_records, key=lambda record: record["attachmentId"]),
        "reconciliation": reconciliations,
    }


def markdown_report(report: dict[str, Any]) -> str:
    counts = report["counts"]
    lines = [
        "# Attachment Corpus Analysis",
        "",
        f"Schema: `{report['schemaVersion']}`  ",
        f"Snapshot: `{report['snapshotId']}`  ",
        f"As of: `{report.get('asOf')}`  ",
        f"Ordered-record hash: `{report['sourceIntegrity']['orderedRecordSha256']}`  ",
        f"Artifact-inventory hash: `{report['sourceIntegrity']['artifactInventorySha256']}`",
        "",
        "## Counts",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
    ]
    for key in ("threads", "messages", "attachments", "pdfs", "images", "uniqueContentHashes", "duplicateGroups", "usefulDocuments", "decorativeDocuments", "unknownDocuments"):
        lines.append(f"| {key} | {counts[key]} |")
    lines += ["", "## Extraction states", ""]
    for key, value in sorted(counts["extractionStates"].items()):
        lines.append(f"- `{key}`: {value}")
    lines += ["", "## Field relationships", ""]
    for key, value in sorted(counts["fieldRelationships"].items()):
        lines.append(f"- `{key}`: {value}")
    lines += ["", "Raw bodies, addresses, filenames, storage keys, and attachment text are intentionally absent from this report.", ""]
    return "\n".join(lines)


def _write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
    finally:
        try:
            path.chmod(0o600)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", required=True)
    parser.add_argument("--out-json", required=True)
    parser.add_argument("--out-md", required=True)
    args = parser.parse_args()
    report = analyze_snapshot(args.snapshot_dir)
    _write_private(Path(args.out_json), json.dumps(report, indent=2, sort_keys=True) + "\n")
    _write_private(Path(args.out_md), markdown_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
