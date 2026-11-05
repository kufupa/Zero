#!/usr/bin/env python3
"""Bounded, read-only PDF/XLSX evidence extraction from saved mailbox snapshots.

Input contract: UTF-8 JSONL under this repository's .private directory, mode
0600, at most 100 MB / 50,000 rows. Every row must have a unique ``case``
matching ``[A-Z][A-Z0-9_-]{0,127}`` and an ``_source.row_ids`` list. For each
selected case, that list must contain 1-10 36-character row IDs using only
hexadecimal digits and hyphens. Select 1-12 existing cases with ``--case``.
Supply 1-8 distinct
``--snapshot`` basenames matching ``[A-Za-z0-9][A-Za-z0-9_-]{0,119}``; they
must be saved snapshot directories directly under the connected mailbox corpus
root on EC2, with directory mode 0700 and ``messages.jsonl`` mode 0600. Names
are mailbox-neutral, so snapshots for Centurion, DaVinci, or another mailbox can
use the same interface. The selected row IDs must occur in those snapshots.

The output path must be new and under .private, in an owner-only directory; it
is created mode 0600. Only bounded, redacted evidence and opaque metadata are
returned, never raw MIME or attachment bytes. ``--purpose room`` (default)
extracts room / occupancy / quantity evidence; ``--purpose document`` extracts
bounded text relevant to distinguishing vouchers, payment proofs, receipts,
and invoices. Neither mode classifies the email or document.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import time
import zlib
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRIVATE_ROOT = ROOT / ".private"
TAIL_PATH = HERE / "centurion-recent-tail.py"
VERSION = "mailbox-attachment-evidence-v2"
MAX_INPUT_BYTES = 100_000_000
MAX_INPUT_ROWS = 50_000
MAX_CASES = 12
MAX_SNAPSHOTS = 8
MAX_TRANSFER_CHARS = 20_000
MAX_DECOMPRESSED_BYTES = 2_000_000
CASE_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,127}")
ROW_ID_RE = re.compile(r"[A-Fa-f0-9-]{36}")
SNAPSHOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}")


class Failure(Exception):
    def __init__(self, code: str):
        self.code = code


def _safe_snapshot(name: Any) -> bool:
    return isinstance(name, str) and bool(SNAPSHOT_RE.fullmatch(name))


REMOTE = r'''
import base64, email, hashlib, html, json, os, re, stat, subprocess, sys
import time, unicodedata, zipfile, zlib
from email import policy
from email.parser import BytesParser
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET
import boto3
from botocore.config import Config

VERSION = "mailbox-attachment-evidence-v2"
SNAPSHOT_ROOT = Path("/home/ubuntu/repos/zero/.private/connected-mailbox-corpus")
MAX_RAW_MIME_BYTES = 15000000
MAX_ATTACHMENT_BYTES = 8000000
MAX_XLSX_EXPANDED_BYTES = 20000000
MAX_XLSX_XML_BYTES = 4000000
MAX_MIME_SOURCES_PER_CASE = 3
MAX_ATTACHMENTS_PER_CASE = 8
MAX_PDF_PAGES = 8
MAX_EVIDENCE_LINES = 20
MAX_EVIDENCE_ROWS = 12
MAX_EVIDENCE_COLUMNS = 6
MAX_EVIDENCE_CHARS_PER_ATTACHMENT = 4500
MAX_REMOTE_RESULT_CHARS = 18000

CASE_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,127}")
ROW_ID_RE = re.compile(r"[A-Fa-f0-9-]{36}")
SNAPSHOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}")
ROOM_CUE_RE = re.compile(
    r"\b(?:rooms?|rooming|occup(?:ancy|ants?)?|quantity|qty|pax|"
    r"adults?|children|child|people|persons?|guest\s+count|"
    r"number\s+of\s+(?:rooms?|guests?)|room\s+type|bed\s+type|"
    r"allocation|allotment|single|double|twin|triple|king)\b", re.I,
)
DOCUMENT_CUE_RE = re.compile(
    r"\b(?:voucher|proof\s+of\s+(?:payment|transfer|bank\s+transfer)|payment\s+proof|"
    r"transfer\s+proof|payment\s+(?:receipt|advice|confirmation)|"
    r"bank\s+(?:transfer|advice|statement)|deposit\s+slip|remittance(?:\s+advice)?|"
    r"tax\s+invoice|invoice|pro[\s-]?forma|receipt|credit\s+note|debit\s+note|pop)\b", re.I,
)
DOCUMENT_VALUE_RE = re.compile(
    r"(?i)(?:[$£€]\s*\d[\d,]*(?:\.\d{1,2})?|"
    r"\b(?:USD|GBP|EUR|ZAR|AED|KES|UGX|NAD|AUD|CAD)\s*\d[\d,]*(?:\.\d{1,2})?\b|"
    r"\b\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|GBP|EUR|ZAR|AED|KES|UGX|NAD|AUD|CAD)\b|"
    r"\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b)"
)
PII_HEADER_RE = re.compile(
    r"\b(?:name|email|e-mail|phone|mobile|contact|card|account|"
    r"reference|confirmation|passport)\b", re.I,
)
LINK_RE = re.compile(r"(?i)(?:https?://|ftp://|www\.)[^\s<>]+")
EMAIL_RE = re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b")
ACCOUNT_VALUE_RE = re.compile(
    r"(?i)\b(card(?:holder)?\s*(?:number|no\.?)|account(?:\s*(?:number|no\.?))?|"
    r"acct(?:\s*(?:number|no\.?))?|iban|routing(?:\s*(?:number|no\.?))?|"
    r"sort\s*code|swift\s*code)\b\s*(?::|=|\bis\b|-)?\s*"
    r"([A-Z0-9][A-Z0-9 \t/-]{2,38})",
)
CREDENTIAL_VALUE_RE = re.compile(
    r"(?i)\b(password|passcode|one[ -]?time code|otp|pin|cvv|cvc|"
    r"security code|verification code|api[ _-]?key|authorization code)\b"
    r"\s*(?:is|:|=|-)\s*([A-Z0-9!@#$%^&*._-]{3,64})",
)
LONG_NUMBER_RE = re.compile(r"(?<!\d)(?:\d[ \u00a0-]?){12,18}\d(?!\d)")
CARD_VALUE_RE = re.compile(
    r"(?i)\b(?:credit\s+|debit\s+)?card(?:holder)?\b\s*"
    r"(?:(?:number|no\.?|ending(?:\s+in)?|ends?\s+in|last\s+four)\s*)?"
    r"(?::|=|#|-)?\s*[xX*•\s-]*(?:\d[ xX*•-]?){4,19}\b"
)


def scrub_text(value):
    text = html.unescape(str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Cf")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    text = LINK_RE.sub("[link removed]", text)
    text = EMAIL_RE.sub("[email removed]", text)
    text = ACCOUNT_VALUE_RE.sub(lambda match: match.group(1) + ": [number removed]", text)
    text = CREDENTIAL_VALUE_RE.sub(lambda match: match.group(1) + ": [removed]", text)
    text = LONG_NUMBER_RE.sub("[number removed]", text)
    text = CARD_VALUE_RE.sub("card: [removed]", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def has_sensitive_residual(value):
    return bool(
        LINK_RE.search(value) or EMAIL_RE.search(value) or ACCOUNT_VALUE_RE.search(value)
        or CREDENTIAL_VALUE_RE.search(value) or LONG_NUMBER_RE.search(value)
        or CARD_VALUE_RE.search(value)
    )


def is_room_header(value):
    header = scrub_text(value).strip()
    if not header or PII_HEADER_RE.search(header):
        return False
    return bool(ROOM_CUE_RE.search(header))


def relevant_pdf_lines(text, purpose="room"):
    if purpose not in {"room", "document"}:
        raise ValueError("invalid extraction purpose")
    cue_re = ROOM_CUE_RE if purpose == "room" else DOCUMENT_CUE_RE
    evidence = []
    used_chars = 0
    for page_number, page in enumerate(str(text or "").split("\f"), start=1):
        lines = [scrub_text(line)[:240] for line in page.splitlines()]
        hit_indexes = [index for index, line in enumerate(lines) if cue_re.search(line)]
        picked = set()
        for index in hit_indexes:
            if purpose == "room":
                picked.update(range(max(0, index - 1), min(len(lines), index + 3)))
            else:
                picked.add(index)
                for adjacent in (index - 1, index + 1):
                    if (0 <= adjacent < len(lines)
                            and DOCUMENT_VALUE_RE.search(lines[adjacent])):
                        picked.add(adjacent)
        for index in sorted(picked):
            line = lines[index]
            if not line:
                continue
            if used_chars + len(line) > MAX_EVIDENCE_CHARS_PER_ATTACHMENT:
                return evidence
            evidence.append({"page": page_number, "line": index + 1, "text": line})
            used_chars += len(line)
            if len(evidence) >= MAX_EVIDENCE_LINES:
                return evidence
    return evidence


def pdf_text(blob):
    try:
        result = subprocess.run(
            ["pdftotext", "-q", "-layout", "-f", "1", "-l", str(MAX_PDF_PAGES), "-", "-"],
            input=blob, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=False,
        )
    except FileNotFoundError:
        return "pdf_extractor_unavailable", ""
    except subprocess.TimeoutExpired:
        return "pdf_extract_timeout", ""
    except Exception:
        return "pdf_parse_error", ""
    if result.returncode != 0:
        return "pdf_parse_error", ""
    text = result.stdout.decode("utf-8", errors="replace")
    return ("pdf_text_available", text) if text.strip() else ("pdf_no_embedded_text_scanned_possible", "")


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _column_index(reference):
    match = re.match(r"([A-Z]+)", str(reference or "").upper())
    if not match:
        return None
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    return value - 1


def _cell_text(cell, shared):
    cell_type = cell.get("t", "")
    if cell_type == "inlineStr":
        return "".join(item.text or "" for item in cell.iter() if _local_name(item.tag) == "t")
    value = next((item.text or "" for item in cell if _local_name(item.tag) == "v"), "")
    if cell_type == "s":
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            return ""
    return value


def xlsx_evidence(blob, purpose="room"):
    if purpose not in {"room", "document"}:
        raise ValueError("invalid extraction purpose")
    try:
        with zipfile.ZipFile(BytesIO(blob)) as archive:
            infos = archive.infolist()
            if (len(infos) > 500 or sum(item.file_size for item in infos) > MAX_XLSX_EXPANDED_BYTES
                    or any(item.file_size > MAX_XLSX_XML_BYTES for item in infos)
                    or any(item.filename.startswith("/") or ".." in item.filename.split("/")
                           for item in infos)):
                return "xlsx_expansion_limit", []
            names = set(archive.namelist())
            shared = []
            if "xl/sharedStrings.xml" in names:
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = [
                    "".join(item.text or "" for item in entry.iter()
                            if _local_name(item.tag) == "t")
                    for entry in root if _local_name(entry.tag) == "si"
                ]
            sheet_names = sorted(
                (name for name in names if re.fullmatch(r"xl/worksheets/sheet[0-9]+\.xml", name)),
                key=lambda name: int(re.search(r"sheet([0-9]+)", name).group(1)),
            )[:8]
            all_rows = []
            for sheet_index, sheet_name in enumerate(sheet_names, start=1):
                root = ET.fromstring(archive.read(sheet_name))
                rows = []
                for fallback_index, row in enumerate(
                    (item for item in root.iter() if _local_name(item.tag) == "row"), start=1
                ):
                    try:
                        row_number = int(row.get("r") or fallback_index)
                    except ValueError:
                        row_number = fallback_index
                    cells = {}
                    for cell in (item for item in row.iter() if _local_name(item.tag) == "c"):
                        column = _column_index(cell.get("r"))
                        value = _cell_text(cell, shared)
                        if column is not None and value.strip():
                            cells[column] = value[:1000]
                    rows.append((row_number, cells))
                    if len(rows) >= 5000:
                        break

                if purpose == "document":
                    for row_number, cells in rows:
                        cleaned = [scrub_text(value)[:160] for value in cells.values()]
                        if not any(DOCUMENT_CUE_RE.search(value) for value in cleaned):
                            continue
                        values = [
                            value for value in cleaned
                            if DOCUMENT_CUE_RE.search(value) or DOCUMENT_VALUE_RE.search(value)
                        ]
                        if values:
                            all_rows.append({
                                "sheet": sheet_index, "row": row_number,
                                "text": values[:MAX_EVIDENCE_COLUMNS],
                            })
                    if len(all_rows) >= MAX_EVIDENCE_ROWS:
                        all_rows = all_rows[:MAX_EVIDENCE_ROWS]
                        break
                    continue

                header_choice = None
                best_headers = {}
                for row_index, (row_number, cells) in enumerate(rows[:20]):
                    headers = {column: value for column, value in cells.items() if is_room_header(value)}
                    if len(headers) > len(best_headers):
                        header_choice = row_index
                        best_headers = headers
                if best_headers:
                    relevant_columns = list(sorted(best_headers))[:MAX_EVIDENCE_COLUMNS]
                    start = (header_choice or 0) + 1
                    for row_number, cells in rows[start:]:
                        values = []
                        for column in relevant_columns:
                            value = scrub_text(cells.get(column, ""))[:120]
                            if value:
                                values.append({
                                    "field": scrub_text(best_headers[column])[:80],
                                    "value": value,
                                })
                        if values:
                            all_rows.append({
                                "sheet": sheet_index, "row": row_number,
                                "fields": values,
                            })
                else:
                    for row_number, cells in rows:
                        values = [
                            scrub_text(value)[:160] for value in cells.values()
                            if ROOM_CUE_RE.search(scrub_text(value))
                        ]
                        if values:
                            all_rows.append({
                                "sheet": sheet_index, "row": row_number, "text": values[:4],
                            })
                if len(all_rows) >= MAX_EVIDENCE_ROWS:
                    all_rows = all_rows[:MAX_EVIDENCE_ROWS]
                    break
    except (zipfile.BadZipFile, ET.ParseError, OSError, RuntimeError):
        return "xlsx_parse_error", []
    if not sheet_names:
        return "xlsx_no_worksheet", []
    if purpose == "document":
        return (
            "xlsx_text_available" if all_rows else "xlsx_text_available_no_document_cues",
            all_rows,
        )
    return ("xlsx_text_available" if all_rows else "xlsx_text_available_no_room_rows"), all_rows


def extract_attachment(blob, kind, purpose="room"):
    if purpose not in {"room", "document"}:
        raise ValueError("invalid extraction purpose")
    if len(blob) > MAX_ATTACHMENT_BYTES:
        return {"text_status": "attachment_too_large", "evidence_lines": [], "evidence_rows": []}
    if kind == "pdf":
        status, text = pdf_text(blob)
        lines = relevant_pdf_lines(text, purpose)
        if status == "pdf_text_available" and not lines:
            status = ("pdf_text_available_no_room_cues" if purpose == "room"
                      else "pdf_text_available_no_document_cues")
        serialized = json.dumps(lines, ensure_ascii=False)
        if has_sensitive_residual(serialized):
            return {"text_status": "withheld_sensitive_residual",
                    "evidence_lines": [], "evidence_rows": []}
        return {"text_status": status, "evidence_lines": lines, "evidence_rows": []}
    status, rows = xlsx_evidence(blob, purpose)
    serialized = json.dumps(rows, ensure_ascii=False)
    if has_sensitive_residual(serialized):
        return {"text_status": "withheld_sensitive_residual",
                "evidence_lines": [], "evidence_rows": []}
    return {"text_status": status, "evidence_lines": [], "evidence_rows": rows}


def _safe_snapshot(name):
    return isinstance(name, str) and bool(SNAPSHOT_RE.fullmatch(name))


def _s3_client():
    processes = json.loads(subprocess.check_output(["pm2", "jlist"], text=True, timeout=15))
    app = next(item["pm2_env"] for item in processes if item.get("name") == "http")
    app_env = app.get("env") if isinstance(app.get("env"), dict) else {}
    for key in ("AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
        value = app.get(key) or app_env.get(key)
        if value:
            os.environ.setdefault(key, str(value))
    bucket = app.get("S3_BUCKET") or app_env.get("S3_BUCKET")
    if not isinstance(bucket, str) or not bucket:
        raise RuntimeError("bucket unavailable")
    region = app.get("AWS_REGION") or app_env.get("AWS_REGION") or "af-south-1"
    return bucket, boto3.client(
        "s3", region_name=region,
        config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 1}),
    )


def _raw_key(value):
    return (isinstance(value, str) and 1 <= len(value) <= 1024
            and not any(ord(char) < 32 for char in value))


def _is_target_attachment(part):
    mime = str(part.get_content_type() or "").casefold()
    name = str(part.get_filename() or "").casefold()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if (mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            or name.endswith(".xlsx")):
        return "xlsx"
    return None


def _source_result(bucket, s3, case, source_ordinal, reference, purpose, counters):
    record = {
        "source_ordinal": source_ordinal, "snapshot": reference["snapshot"],
        "status": "s3_read_error", "attachments": [],
    }
    key = reference["key"]
    if not _raw_key(key):
        record["status"] = "locator_invalid"
        return record
    counters["s3_gets"] += 1
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            size = response.get("ContentLength")
            if isinstance(size, int) and size > MAX_RAW_MIME_BYTES:
                record["status"] = "raw_mime_too_large"
                return record
            raw = body.read(MAX_RAW_MIME_BYTES + 1)
        finally:
            body.close()
    except Exception:
        return record
    if len(raw) > MAX_RAW_MIME_BYTES:
        record["status"] = "raw_mime_too_large"
        return record
    record["raw_mime_sha256"] = hashlib.sha256(raw).hexdigest()
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
    except Exception:
        record["status"] = "mime_parse_error"
        return record

    record["status"] = "ok"
    for part in message.walk():
        if part.is_multipart():
            continue
        try:
            kind = _is_target_attachment(part)
        except Exception:
            continue
        if kind is None:
            continue
        if len(record["attachments"]) >= MAX_ATTACHMENTS_PER_CASE:
            record["attachments_truncated"] = True
            break
        try:
            blob = part.get_payload(decode=True) or b""
        except Exception:
            blob = b""
        attachment = {
            "ordinal": len(record["attachments"]) + 1, "type": kind,
            "mime_type": str(part.get_content_type() or "application/octet-stream"),
            "attachment_sha256": hashlib.sha256(blob).hexdigest(),
        }
        attachment.update(extract_attachment(blob, kind, purpose))
        record["attachments"].append(attachment)
    return record


def _decode_snapshots(target, snapshots):
    if not isinstance(target, dict) or not target:
        raise ValueError("target schema")
    if (not isinstance(snapshots, list) or not snapshots
            or any(not _safe_snapshot(name) for name in snapshots)):
        raise ValueError("snapshot schema")
    row_to_cases = {}
    for case, row_ids in target.items():
        if not isinstance(case, str) or not CASE_RE.fullmatch(case):
            raise ValueError("case schema")
        if (not isinstance(row_ids, list) or not row_ids or len(row_ids) > 10
                or any(not isinstance(row_id, str) or not ROW_ID_RE.fullmatch(row_id)
                       for row_id in row_ids)):
            raise ValueError("row id schema")
        for row_id in row_ids:
            row_to_cases.setdefault(row_id, []).append(case)
    references = {case: [] for case in target}
    resolved = set()
    root = SNAPSHOT_ROOT.resolve()
    for snapshot in snapshots:
        directory = SNAPSHOT_ROOT / snapshot
        try:
            directory_stat = directory.lstat()
            file_path = directory / "messages.jsonl"
            file_stat = file_path.lstat()
            if (stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode)
                    or stat.S_IMODE(directory_stat.st_mode) != 0o700
                    or directory.resolve(strict=True) != directory
                    or not file_path.resolve(strict=True).is_relative_to(root)
                    or stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode)
                    or stat.S_IMODE(file_stat.st_mode) != 0o600):
                continue
        except (OSError, RuntimeError):
            continue
        with file_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                row_id = row.get("id") if isinstance(row, dict) else None
                if row_id not in row_to_cases or row_id in resolved:
                    continue
                locator = row.get("rawMimeLocator")
                if not _raw_key(locator):
                    continue
                for case in row_to_cases[row_id]:
                    if len(references[case]) < MAX_MIME_SOURCES_PER_CASE:
                        references[case].append({"snapshot": snapshot, "key": locator})
                resolved.add(row_id)
        if len(resolved) >= len(row_to_cases):
            break
    return references


def _run_remote():
    request = json.loads(base64.b64decode(REQUEST_B64, validate=True).decode("utf-8"))
    target = request.get("target")
    snapshots = request.get("snapshots")
    purpose = request.get("purpose")
    if purpose not in {"room", "document"}:
        raise ValueError("purpose schema")
    references = _decode_snapshots(target, snapshots)
    bucket, s3 = _s3_client()
    counters = {"s3_gets": 0}
    started = time.perf_counter()
    cases = {}
    for case, case_references in references.items():
        sources = [
            _source_result(bucket, s3, case, index, reference, purpose, counters)
            for index, reference in enumerate(case_references, start=1)
        ]
        attachment_count = sum(len(source.get("attachments", [])) for source in sources)
        cases[case] = {
            "status": ("processed" if attachment_count else
                       "no_pdf_xlsx_attachments" if sources else "locator_missing"),
            "source_count": len(sources), "sources": sources,
        }
    return {
        "status": "ok", "version": VERSION, "purpose": purpose, "cases": cases,
        "s3_gets": counters["s3_gets"],
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    }


if __name__ == "__main__":
    try:
        result = _run_remote()
    except Exception:
        result = {"status": "failed", "error_code": "remote_extract_failed"}
    encoded = base64.b64encode(zlib.compress(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9,
    )).decode("ascii")
    if len(encoded) > MAX_REMOTE_RESULT_CHARS:
        encoded = base64.b64encode(zlib.compress(
            b'{"status":"failed","error_code":"transfer_too_large"}', 9,
        )).decode("ascii")
    print("B64:" + encoded)
'''


def _module(name: str, path: pathlib.Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Failure("ssm_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        raise Failure("ssm_helper_unavailable") from None
    return module


def _safe_private_path(path: pathlib.Path, must_exist: bool) -> pathlib.Path:
    candidate = path if path.is_absolute() else ROOT / path
    absolute = pathlib.Path(os.path.abspath(candidate))
    private = PRIVATE_ROOT.resolve(strict=True)
    parent = absolute.parent.resolve(strict=True)
    if (absolute == private or not absolute.is_relative_to(private)
            or not parent.is_relative_to(private) or parent != absolute.parent):
        raise Failure("private_path_required")
    if must_exist:
        try:
            file_stat = absolute.lstat()
        except OSError:
            raise Failure("private_input_unavailable") from None
        if (stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode)
                or stat.S_IMODE(file_stat.st_mode) != 0o600
                or absolute.resolve(strict=True) != absolute):
            raise Failure("private_input_permissions")
    elif absolute.exists() or absolute.is_symlink():
        raise Failure("output_exists")
    else:
        parent_stat = parent.stat()
        if (stat.S_ISLNK(parent_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode)
                or stat.S_IMODE(parent_stat.st_mode) & 0o077):
            raise Failure("private_output_directory_permissions")
    return absolute


def _read_jsonl(path: pathlib.Path) -> tuple[list[dict[str, Any]], bytes]:
    try:
        raw = path.read_bytes()
    except OSError:
        raise Failure("private_input_unavailable") from None
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise Failure("input_size_invalid")
    rows = []
    for line_number, line in enumerate(raw.split(b"\n"), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise Failure("input_invalid_jsonl") from None
        if not isinstance(value, dict):
            raise Failure("input_row_schema")
        rows.append(value)
        if len(rows) > MAX_INPUT_ROWS:
            raise Failure("input_row_limit")
    if not rows:
        raise Failure("input_empty")
    return rows, raw


def _target_rows(rows: list[dict[str, Any]], selected: list[str]) -> dict[str, list[str]]:
    if (not selected or len(selected) > MAX_CASES or len(set(selected)) != len(selected)
            or any(not CASE_RE.fullmatch(case) for case in selected)):
        raise Failure("case_selection_invalid")
    found = {}
    for row in rows:
        case = row.get("case")
        if not isinstance(case, str) or not CASE_RE.fullmatch(case):
            raise Failure("input_case_invalid")
        source = row.get("_source")
        row_ids = source.get("row_ids") if isinstance(source, dict) else None
        if not isinstance(row_ids, list):
            raise Failure("input_source_row_ids_missing")
        if case in found:
            raise Failure("input_duplicate_case")
        found[case] = row_ids
    if any(case not in found for case in selected):
        raise Failure("selected_case_missing")
    target = {}
    for case in selected:
        row_ids = found[case]
        if (not row_ids or len(row_ids) > 10
                or any(not isinstance(row_id, str) or not ROW_ID_RE.fullmatch(row_id)
                       for row_id in row_ids)):
            raise Failure("source_row_ids_invalid")
        target[case] = row_ids
    return target


def _decode_remote(value: str, selected: list[str]) -> dict[str, Any]:
    if not isinstance(value, str) or len(value) > MAX_TRANSFER_CHARS or not value.startswith("B64:"):
        raise Failure("remote_result_invalid")
    try:
        compressed = base64.b64decode(value[4:].strip(), validate=True)
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, MAX_DECOMPRESSED_BYTES + 1)
        if len(raw) > MAX_DECOMPRESSED_BYTES or decoder.unconsumed_tail:
            raise Failure("remote_result_too_large")
        result = json.loads(raw.decode("utf-8"))
    except Failure:
        raise
    except Exception:
        raise Failure("remote_result_invalid") from None
    if not isinstance(result, dict) or result.get("status") != "ok":
        raise Failure(result.get("error_code", "remote_extract_failed")
                      if isinstance(result, dict) else "remote_extract_failed")
    cases = result.get("cases")
    if not isinstance(cases, dict) or set(cases) != set(selected):
        raise Failure("remote_case_mismatch")
    return result


def _write_private(path: pathlib.Path, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        raise Failure("private_output_create_failed") from None
    with os.fdopen(fd, "wb") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(payload)


def self_test() -> dict[str, Any]:
    namespace = {"__name__": "centurion_attachment_evidence_self_test"}
    try:
        exec(REMOTE, namespace)
    except Exception:
        raise Failure("self_test_remote_source_invalid") from None
    scrubbed = namespace["scrub_text"](
        "Rooms: 12; card number: 4111 1111 1111 1111; account: 1234567890; "
        "card ending in 1234; password: abc123; https://private.invalid/signed"
    )
    if any(value in scrubbed for value in (
        "4111", "1234567890", "1234", "abc123", "https://", "private.invalid",
    )):
        raise Failure("self_test_redaction_failed")
    lines = namespace["relevant_pdf_lines"]("Header\nRooms | Guests\n3 | 8\nOther text")
    if not lines or not any("Rooms" in row["text"] for row in lines):
        raise Failure("self_test_pdf_evidence_selection_failed")
    document_lines = namespace["relevant_pdf_lines"](
        "Proof of payment; card ending in 1234\nAmount: GBP 125.00",
        "document",
    )
    document_pdf = json.dumps(document_lines)
    if (not any("Proof of payment" in row["text"] for row in document_lines)
            or "GBP 125.00" not in document_pdf
            or any(value in document_pdf for value in ("4111", "1111 1111", "1234"))
            or namespace["has_sensitive_residual"](document_pdf)):
        raise Failure("self_test_document_pdf_redaction_failed")

    valid_snapshots = (
        "centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51",
        "davinci_mailbox_20261102", "snapshot-1", "a" + "b" * 119,
    )
    invalid_snapshots = ("../outside", "-hidden", "name.with.dot", "a/b", "a\\b", "")
    if (any(not _safe_snapshot(name) for name in valid_snapshots)
            or any(_safe_snapshot(name) for name in invalid_snapshots)
            or _safe_snapshot("a" + "b" * 120)):
        raise Failure("self_test_mailbox_neutral_snapshot_validation_failed")
    remote_references = namespace["_decode_snapshots"](
        {"N01": ["00000000-0000-0000-0000-000000000000"]},
        ["davinci_mailbox_20261102"],
    )
    if remote_references != {"N01": []}:
        raise Failure("self_test_remote_generic_snapshot_name_failed")
    try:
        namespace["_decode_snapshots"](
            {"N01": ["00000000-0000-0000-0000-000000000000"]}, ["../outside"],
        )
    except ValueError:
        pass
    else:
        raise Failure("self_test_remote_snapshot_traversal_not_rejected")

    import io
    import zipfile

    sheet = (
        b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        b'<sheetData><row r="1">'
        b'<c r="A1" t="inlineStr"><is><t>Guest Name</t></is></c>'
        b'<c r="B1" t="inlineStr"><is><t>Room Type</t></is></c>'
        b'<c r="C1" t="inlineStr"><is><t>Quantity</t></is></c>'
        b'</row><row r="2">'
        b'<c r="A2" t="inlineStr"><is><t>Private Person</t></is></c>'
        b'<c r="B2" t="inlineStr"><is><t>Twin</t></is></c>'
        b'<c r="C2"><v>4</v></c></row></sheetData></worksheet>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    status, evidence = namespace["xlsx_evidence"](buffer.getvalue())
    rendered = json.dumps(evidence)
    if status != "xlsx_text_available" or "Quantity" not in rendered or "Private Person" in rendered:
        raise Failure("self_test_xlsx_minimization_failed")

    document_sheet = (
        b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        b'<sheetData><row r="1">'
        b'<c r="A1" t="inlineStr"><is><t>Document Type</t></is></c>'
        b'<c r="B1" t="inlineStr"><is><t>Amount</t></is></c>'
        b'<c r="C1" t="inlineStr"><is><t>Card Number</t></is></c>'
        b'<c r="D1" t="inlineStr"><is><t>Account</t></is></c>'
        b'<c r="E1" t="inlineStr"><is><t>Payment Contact</t></is></c>'
        b'</row><row r="2">'
        b'<c r="A2" t="inlineStr"><is><t>Proof of Payment; password: abc123</t></is></c>'
        b'<c r="B2" t="inlineStr"><is><t>GBP 125.00</t></is></c>'
        b'<c r="C2" t="inlineStr"><is><t>4111 1111 1111 1111</t></is></c>'
        b'<c r="D2" t="inlineStr"><is><t>account: 1234567890</t></is></c>'
        b'<c r="E2" t="inlineStr"><is><t>Paid by Private Person</t></is></c>'
        b'</row></sheetData></worksheet>'
    )
    document_buffer = io.BytesIO()
    with zipfile.ZipFile(document_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", document_sheet)
    document_status, document_evidence = namespace["xlsx_evidence"](
        document_buffer.getvalue(), "document",
    )
    document_xlsx = json.dumps(document_evidence)
    if (document_status != "xlsx_text_available"
            or "Proof of Payment" not in document_xlsx or "GBP 125.00" not in document_xlsx
            or any(value in document_xlsx for value in (
                "4111", "1234567890", "abc123", "Private Person",
            ))):
        raise Failure("self_test_document_xlsx_redaction_failed")
    if namespace["pdf_text"](b"not a pdf")[0] not in {
        "pdf_parse_error", "pdf_extractor_unavailable", "pdf_extract_timeout",
    }:
        raise Failure("self_test_pdf_unavailable_status_failed")
    return {
        "self_test": "ok", "card_account_credential_and_link_redaction": True,
        "pdf_relevant_line_selection": True, "xlsx_relevant_rows_without_names": True,
        "pdf_parse_failure_distinguished": True,
        "mailbox_neutral_snapshot_names": True,
        "document_evidence_mode_redacted": True,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    input_path = _safe_private_path(args.input, must_exist=True)
    output_path = _safe_private_path(args.output, must_exist=False)
    if args.purpose not in {"room", "document"}:
        raise Failure("purpose_invalid")
    if not args.snapshot or len(args.snapshot) > MAX_SNAPSHOTS:
        raise Failure("snapshot_selection_invalid")
    snapshots = args.snapshot
    if (len(set(snapshots)) != len(snapshots)
            or any(not _safe_snapshot(name) for name in snapshots)):
        raise Failure("snapshot_selection_invalid")
    rows, raw = _read_jsonl(input_path)
    target = _target_rows(rows, args.case)
    request = {"target": target, "snapshots": snapshots, "purpose": args.purpose}
    request_b64 = base64.b64encode(
        json.dumps(request, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).decode("ascii")
    remote = "REQUEST_B64 = " + repr(request_b64) + "\n" + REMOTE
    command = "python3 - <<'PY'\n" + remote + "\nPY"
    helper = _module("centurion_attachment_tail", TAIL_PATH)
    started = time.perf_counter()
    try:
        response = helper.ssm(command)
    except Exception:
        raise Failure("read_only_s3_fetch_failed") from None
    result = _decode_remote(response, args.case)
    if result.get("purpose") != args.purpose:
        raise Failure("remote_purpose_mismatch")
    result.update({
        "input_sha256": hashlib.sha256(raw).hexdigest(),
        "selected_cases": args.case,
        "snapshot_names": snapshots,
        "purpose": args.purpose,
        "elapsed_seconds_local": round(time.perf_counter() - started, 3),
        "output": str(output_path),
    })
    _write_private(output_path, result)
    return {
        "status": "ok", "selected_cases": len(args.case),
        "s3_gets": result.get("s3_gets"),
        "elapsed_seconds_local": result["elapsed_seconds_local"],
        "case_statuses": {
            case: {
                "status": row.get("status"),
                "source_count": row.get("source_count"),
                "attachment_count": sum(len(source.get("attachments", []))
                                        for source in row.get("sources", [])),
                "text_statuses": [
                    attachment.get("text_status")
                    for source in row.get("sources", [])
                    for attachment in source.get("attachments", [])
                ],
            } for case, row in result["cases"].items()
        },
        "output": str(output_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--snapshot", action="append", default=[])
    parser.add_argument("--purpose", choices=("room", "document"), default="room")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            result = self_test()
        else:
            if args.input is None or args.output is None:
                raise Failure("input_and_output_required")
            result = run(args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Failure as exc:
        print(json.dumps({"status": "failed", "error_code": exc.code}, sort_keys=True))
        return 1
    except Exception:
        print(json.dumps({"status": "failed", "error_code": "internal"}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
