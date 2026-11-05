#!/usr/bin/env python3
"""Extract bounded, redacted evidence from legacy XLS attachments.

This is a sibling to centurion-attachment-evidence.py and deliberately leaves
that PDF/XLSX extractor unchanged. It selects packets whose attachment context
declares a legacy .xls (not .xlsx), locates original MIME through the approved
read-only S3/SSM route, and parses on EC2 with xlrd 2.0.1 installed into a
temporary target directory. It does not alter the EC2/global Python packages.

Only bounded evidence, opaque source IDs, and hashes return to the local
owner-private output. Filenames, original MIME, attachment bytes, names, and
arbitrary spreadsheet cells are never returned.

Example (all detected legacy XLS cases):
  python3 centurion-xls-evidence.py \
    --input .private/centurion-opportunity-october-20261101/bulk-v22-effective/full-packets-attachments.jsonl \
    --output .private/centurion-opportunity-october-20261101/xls-evidence-v1.json \
    --snapshot centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51 \
    --snapshot centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import time
import uuid
import zlib
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRIVATE_ROOT = ROOT / ".private"
TAIL_PATH = HERE / "centurion-recent-tail.py"
VERSION = "centurion-xls-evidence-v1"
MAX_INPUT_BYTES = 100_000_000
MAX_INPUT_ROWS = 50_000
MAX_CASES = 100
MAX_SNAPSHOTS = 8
MAX_RAW_RESULT_BYTES = 2_000_000
MAX_TRANSFER_BYTES = 2_000_000
TRANSFER_CHUNK_BYTES = 12_000
CASE_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,127}")
ROW_ID_RE = re.compile(r"[A-Fa-f0-9-]{36}")
SNAPSHOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}")
LEGACY_XLS_RE = re.compile(
    r"(?i)\.xls(?!x)\b|application/(?:vnd\.ms-excel|x-msexcel|msexcel|x-excel)"
)

# SHA-256 published by PyPI for xlrd-2.0.1-py2.py3-none-any.whl.
XLRD_WHEEL_SHA256 = "6a33ee89877bd9abc1158129f6e94be74e2679636b8a205b43b85206c3f0bbdd"


class Failure(Exception):
    def __init__(self, code: str):
        self.code = code


REMOTE = r'''
import base64, contextlib, hashlib, html, importlib.util, io
import json, os, re, signal, stat, subprocess, sys, tempfile, time
import unicodedata, warnings, zlib
from email import policy
from email.parser import BytesParser
from pathlib import Path
import boto3
from botocore.config import Config

VERSION = "centurion-xls-evidence-v1"
XLRD_VERSION = "2.0.1"
XLRD_WHEEL_SHA256 = "6a33ee89877bd9abc1158129f6e94be74e2679636b8a205b43b85206c3f0bbdd"
SNAPSHOT_ROOT = Path("/home/ubuntu/repos/zero/.private/connected-mailbox-corpus")
TRANSFER_ROOT = Path("/tmp")
MAX_RAW_MIME_BYTES = 15000000
MAX_ATTACHMENT_BYTES = 8000000
MAX_MIME_SOURCES_PER_CASE = 3
MAX_ATTACHMENTS_PER_CASE = 8
MAX_SHEETS = 8
MAX_ROWS_PER_SHEET = 5000
MAX_COLUMNS_PER_SHEET = 64
MAX_EVIDENCE_ROWS = 12
MAX_EVIDENCE_COLUMNS = 6
MAX_EVIDENCE_CHARS_PER_PURPOSE = 4500
MAX_RESULT_BYTES = 2000000
MAX_TRANSFER_BYTES = 2000000
CASE_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,127}")
ROW_ID_RE = re.compile(r"[A-Fa-f0-9-]{36}")
SNAPSHOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}")
TOKEN_RE = re.compile(r"[0-9a-f]{32}")

ROOM_CUE_RE = re.compile(
    r"\b(?:rooms?|rooming|occup(?:ancy|ants?)?|quantity|qty|pax|"
    r"adults?|children|child|people|persons?|guest\s+count|"
    r"number\s+of\s+(?:rooms?|guests?)|room\s+type|bed\s+type|"
    r"allocation|allotment|single|double|twin|triple|king|queen|suite|"
    r"check[ -]?in|check[ -]?out|arrival|departure|stay\s+date|nights?)\b", re.I,
)
ROOM_QUANTITY_HEADER_RE = re.compile(
    r"(?i)\b(?:room\s*(?:count|quantity|qty)|number\s+of\s+rooms?|"
    r"rooms?\s*(?:count|quantity|qty)|no\.?\s*of\s+rooms?)\b"
)
ROOM_TYPE_RE = re.compile(
    r"(?i)\b(?:single|double|twin|triple|quad(?:ruple)?|king|queen|"
    r"suite|deluxe|standard|superior|family|executive|studio|accessible|"
    r"dbl|twn|twin\s+share|sng|sgl)\b"
)
STAY_DATE_HEADER_RE = re.compile(
    r"(?i)\b(?:arrival|departure|check[ -]?in|check[ -]?out|stay\s+date|nights?)\b"
)
PII_HEADER_RE = re.compile(
    r"(?i)\b(?:name|email|e-mail|phone|mobile|contact|card|account|"
    r"reference|confirmation|passport|address|guest\s+id)\b"
)
DOCUMENT_CUE_RE = re.compile(
    r"(?i)\b(?:voucher|proof\s+of\s+(?:payment|transfer|bank\s+transfer)|"
    r"payment\s+proof|transfer\s+proof|payment\s+(?:receipt|advice|confirmation)|"
    r"bank\s+(?:transfer|advice|statement)|deposit\s+slip|remittance(?:\s+advice)?|"
    r"tax\s+invoice|invoice|pro[ -]?forma|receipt|credit\s+note|debit\s+note|pop)\b"
)
DOCUMENT_VALUE_RE = re.compile(
    r"(?i)(?:[$£€]\s*\d[\d,]*(?:\.\d{1,2})?|"
    r"\b(?:USD|GBP|EUR|ZAR|AED|KES|UGX|NAD|AUD|CAD)\s*\d[\d,]*(?:\.\d{1,2})?\b|"
    r"\b\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|GBP|EUR|ZAR|AED|KES|UGX|NAD|AUD|CAD)\b|"
    r"\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b)"
)
LINK_RE = re.compile(r"(?i)(?:https?://|ftp://|www\.)[^\s<>]+")
EMAIL_RE = re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b")
ACCOUNT_VALUE_RE = re.compile(
    r"(?i)\b(card(?:holder)?\s*(?:number|no\.?)|account(?:\s*(?:number|no\.?))?|"
    r"acct(?:\s*(?:number|no\.?))?|iban|routing(?:\s*(?:number|no\.?))?|"
    r"sort\s*code|swift\s*code)\b\s*(?::|=|\bis\b|-)?\s*"
    r"([A-Z0-9][A-Z0-9 \t/-]{2,38})"
)
CREDENTIAL_VALUE_RE = re.compile(
    r"(?i)\b(password|passcode|one[ -]?time code|otp|pin|cvv|cvc|"
    r"security code|verification code|api[ _-]?key|authorization code)\b"
    r"\s*(?:is|:|=|-)\s*([A-Z0-9!@#$%^&*._-]{3,64})"
)
LONG_NUMBER_RE = re.compile(r"(?<!\d)(?:\d[ \u00a0-]?){12,18}\d(?!\d)")
CARD_VALUE_RE = re.compile(
    r"(?i)\b(?:credit\s+|debit\s+)?card(?:holder)?\b\s*"
    r"(?:(?:number|no\.?|ending(?:\s+in)?|ends?\s+in|last\s+four)\s*)?"
    r"(?::|=|#|-)?\s*[xX*•\s-]*(?:\d[ xX*•-]?){4,19}\b"
)
ROOM_COUNT_RE = re.compile(r"(?i)\b(\d{1,4})\s*(?:rooms?|units?)\b")
PURE_NUMBER_RE = re.compile(r"^\s*\d{1,4}(?:\.\d+)?\s*$")
DATE_ONLY_RE = re.compile(
    r"(?i)^\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\s*$"
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
    return bool(LINK_RE.search(value) or EMAIL_RE.search(value)
                or ACCOUNT_VALUE_RE.search(value) or CREDENTIAL_VALUE_RE.search(value)
                or LONG_NUMBER_RE.search(value) or CARD_VALUE_RE.search(value))


def _column_name(index):
    result = ""
    value = int(index) + 1
    while value:
        value, rem = divmod(value - 1, 26)
        result = chr(65 + rem) + result
    return result


def _cell_text(sheet, row, column, book, xlrd):
    try:
        cell = sheet.cell(row, column)
        value = cell.value
        if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
            return ""
        if cell.ctype == xlrd.XL_CELL_DATE:
            try:
                return xlrd.xldate_as_datetime(value, book.datemode).isoformat()
            except Exception:
                return ""
        if cell.ctype == xlrd.XL_CELL_BOOLEAN:
            return "true" if value else "false"
        if cell.ctype == xlrd.XL_CELL_ERROR:
            return ""
        if cell.ctype == xlrd.XL_CELL_NUMBER and isinstance(value, (int, float)):
            if float(value).is_integer():
                return str(int(value))
            return str(value)[:80]
        return str(value or "")[:1000]
    except Exception:
        return ""


def _safe_room_value(header, value):
    value = scrub_text(value)[:120]
    if not value or "[removed]" in value or "[number removed]" in value:
        return None
    if PURE_NUMBER_RE.fullmatch(value):
        return value.strip()
    if STAY_DATE_HEADER_RE.search(header) and DATE_ONLY_RE.fullmatch(value):
        return value.strip()
    types = list(dict.fromkeys(match.group(0).casefold() for match in ROOM_TYPE_RE.finditer(value)))
    if types:
        return ", ".join(types[:3])
    if ROOM_COUNT_RE.search(value):
        match = ROOM_COUNT_RE.search(value)
        return match.group(1) + " rooms"
    return None


def _safe_room_header(header):
    cues = list(dict.fromkeys(
        re.sub(r"\s+", " ", match.group(0).casefold()).strip()
        for match in ROOM_CUE_RE.finditer(scrub_text(header))
    ))
    return ", ".join(cues[:6])


def _parse_timeout_handler(*_):
    raise TimeoutError()


def _safe_room_clues(value):
    cleaned = scrub_text(value)[:500]
    if not cleaned:
        return []
    cues = list(dict.fromkeys(match.group(0).casefold() for match in ROOM_CUE_RE.finditer(cleaned)))
    if not cues:
        return []
    quantities = [match.group(1) for match in ROOM_COUNT_RE.finditer(cleaned)]
    result = []
    for cue in cues[:4]:
        item = {"cue": cue}
        if quantities:
            item["explicit_room_quantities"] = quantities[:4]
        result.append(item)
    return result


def _document_terms(value):
    cleaned = scrub_text(value)[:1000]
    if not cleaned:
        return [], []
    terms = []
    for match in DOCUMENT_CUE_RE.finditer(cleaned):
        term = re.sub(r"\s+", " ", match.group(0).casefold()).strip()
        if term not in terms:
            terms.append(term[:60])
    values = []
    for match in DOCUMENT_VALUE_RE.finditer(cleaned):
        token = scrub_text(match.group(0))[:80]
        if token and token not in values:
            values.append(token)
    return terms[:4], values[:4]


def _worksheet_rows(book, sheet, xlrd, max_rows=MAX_ROWS_PER_SHEET,
                    max_columns=MAX_COLUMNS_PER_SHEET):
    rows = []
    row_limit = min(int(sheet.nrows or 0), max_rows)
    column_limit = min(int(sheet.ncols or 0), max_columns)
    for row_index in range(row_limit):
        values = []
        for column in range(column_limit):
            value = _cell_text(sheet, row_index, column, book, xlrd)
            if value.strip():
                values.append((column, value))
        rows.append((row_index + 1, dict(values)))
    return rows, {
        "rows_reported": int(sheet.nrows or 0),
        "columns_reported": int(sheet.ncols or 0),
        "rows_scanned": row_limit,
        "columns_scanned": column_limit,
        "rows_truncated": int(sheet.nrows or 0) > max_rows,
        "columns_truncated": int(sheet.ncols or 0) > max_columns,
    }


def room_evidence(book, xlrd):
    evidence = []
    sheet_meta = []
    sheet_names = book.sheet_names()
    selected_names = sheet_names[:MAX_SHEETS]
    for sheet_index, sheet_name in enumerate(selected_names, start=1):
        try:
            sheet = book.sheet_by_name(sheet_name)
            rows, meta = _worksheet_rows(book, sheet, xlrd)
        except Exception:
            sheet_meta.append({"sheet": sheet_index, "status": "sheet_read_error"})
            continue
        sheet_meta.append({"sheet": sheet_index, **meta})
        best_header_index = None
        best_headers = {}
        for index, (row_number, cells) in enumerate(rows[:20]):
            headers = {
                column: scrub_text(value)[:80]
                for column, value in cells.items()
                if (ROOM_CUE_RE.search(value) and not PII_HEADER_RE.search(value))
            }
            if len(headers) > len(best_headers):
                best_header_index, best_headers = index, headers

        emitted = 0
        if best_headers:
            relevant = sorted(best_headers)[:MAX_EVIDENCE_COLUMNS]
            for row_number, cells in rows[(best_header_index or 0) + 1:]:
                fields = []
                for column in relevant:
                    safe = _safe_room_value(best_headers[column], cells.get(column, ""))
                    if safe:
                        field = best_headers[column]
                        fields.append({
                            "field": _safe_room_header(field),
                            "field_role": ("explicit_room_quantity"
                                           if ROOM_QUANTITY_HEADER_RE.search(field)
                                           else "room_or_stay_attribute_ambiguous"),
                            "value": safe,
                        })
                if fields:
                    evidence.append({"sheet": sheet_index, "row": row_number,
                                     "fields": fields[:MAX_EVIDENCE_COLUMNS]})
                    emitted += 1
                if len(evidence) >= MAX_EVIDENCE_ROWS:
                    break
        else:
            for row_number, cells in rows:
                clues = []
                for value in cells.values():
                    clues.extend(_safe_room_clues(value))
                if clues:
                    evidence.append({"sheet": sheet_index, "row": row_number,
                                     "clues": clues[:MAX_EVIDENCE_COLUMNS]})
                    emitted += 1
                if len(evidence) >= MAX_EVIDENCE_ROWS:
                    break
        sheet_meta[-1]["evidence_rows"] = emitted
        if len(evidence) >= MAX_EVIDENCE_ROWS:
            break
    evidence_limit_reached = len(evidence) >= MAX_EVIDENCE_ROWS
    sheets_not_scanned_due_evidence_cap = len(sheet_meta) < len(selected_names)
    truncated = (len(sheet_names) > MAX_SHEETS or sheets_not_scanned_due_evidence_cap
                 or evidence_limit_reached or any(
        item.get("rows_truncated") or item.get("columns_truncated") for item in sheet_meta
    ))
    output = {"sheet_count": len(sheet_names), "sheets_scanned": len(sheet_meta),
              "sheets_truncated": len(sheet_names) > MAX_SHEETS,
              "sheets_not_scanned_due_evidence_cap": sheets_not_scanned_due_evidence_cap,
              "evidence_limit_reached": evidence_limit_reached,
              "truncated": bool(truncated), "sheet_limits": sheet_meta,
              "evidence_rows": evidence}
    serialized = json.dumps(output, ensure_ascii=False)
    if len(serialized) > MAX_EVIDENCE_CHARS_PER_PURPOSE or has_sensitive_residual(serialized):
        return {"status": "withheld_sensitive_or_over_limit", "evidence_rows": [],
                "sheet_count": len(sheet_names), "sheets_scanned": len(sheet_meta),
                "sheets_not_scanned_due_evidence_cap": sheets_not_scanned_due_evidence_cap,
                "evidence_limit_reached": evidence_limit_reached,
                "truncated": bool(truncated)}
    output["status"] = "xls_text_available" if evidence else "xls_text_available_no_room_cues"
    return output


def document_evidence(book, xlrd):
    evidence = []
    sheet_meta = []
    sheet_names = book.sheet_names()
    selected_names = sheet_names[:MAX_SHEETS]
    for sheet_index, sheet_name in enumerate(selected_names, start=1):
        try:
            sheet = book.sheet_by_name(sheet_name)
            rows, meta = _worksheet_rows(book, sheet, xlrd)
        except Exception:
            sheet_meta.append({"sheet": sheet_index, "status": "sheet_read_error"})
            continue
        sheet_meta.append({"sheet": sheet_index, **meta})
        header = {}
        for _, cells in rows[:20]:
            for column, value in cells.items():
                if value.strip() and not PII_HEADER_RE.search(value):
                    header.setdefault(column, scrub_text(value)[:80])
        emitted = 0
        for row_number, cells in rows:
            selected = []
            for column, value in cells.items():
                field = header.get(column, "")
                if PII_HEADER_RE.search(field):
                    continue
                terms, document_values = _document_terms(value)
                if not terms and not document_values:
                    continue
                cell = {"column": _column_name(column)}
                if terms:
                    cell["document_terms"] = terms
                if document_values:
                    cell["value_hints"] = document_values
                selected.append(cell)
            if selected:
                evidence.append({"sheet": sheet_index, "row": row_number,
                                 "cells": selected[:MAX_EVIDENCE_COLUMNS]})
                emitted += 1
            if len(evidence) >= MAX_EVIDENCE_ROWS:
                break
        sheet_meta[-1]["evidence_rows"] = emitted
        if len(evidence) >= MAX_EVIDENCE_ROWS:
            break
    evidence_limit_reached = len(evidence) >= MAX_EVIDENCE_ROWS
    sheets_not_scanned_due_evidence_cap = len(sheet_meta) < len(selected_names)
    truncated = (len(sheet_names) > MAX_SHEETS or sheets_not_scanned_due_evidence_cap
                 or evidence_limit_reached or any(
        item.get("rows_truncated") or item.get("columns_truncated") for item in sheet_meta
    ))
    output = {"sheet_count": len(sheet_names), "sheets_scanned": len(sheet_meta),
              "sheets_truncated": len(sheet_names) > MAX_SHEETS,
              "sheets_not_scanned_due_evidence_cap": sheets_not_scanned_due_evidence_cap,
              "evidence_limit_reached": evidence_limit_reached,
              "truncated": bool(truncated), "sheet_limits": sheet_meta,
              "evidence_rows": evidence}
    serialized = json.dumps(output, ensure_ascii=False)
    if len(serialized) > MAX_EVIDENCE_CHARS_PER_PURPOSE or has_sensitive_residual(serialized):
        return {"status": "withheld_sensitive_or_over_limit", "evidence_rows": [],
                "sheet_count": len(sheet_names), "sheets_scanned": len(sheet_meta),
                "sheets_not_scanned_due_evidence_cap": sheets_not_scanned_due_evidence_cap,
                "evidence_limit_reached": evidence_limit_reached,
                "truncated": bool(truncated)}
    output["status"] = "xls_text_available" if evidence else "xls_text_available_no_document_cues"
    return output


def parse_xls(blob, xlrd):
    if len(blob) > MAX_ATTACHMENT_BYTES:
        return {"parse_status": "attachment_too_large", "room": None, "document": None}
    if not blob:
        return {"parse_status": "empty_attachment", "room": None, "document": None}
    previous_handler = signal.signal(signal.SIGALRM, _parse_timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, 4.0)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                book = xlrd.open_workbook(file_contents=blob, on_demand=True,
                                          ragged_rows=True, formatting_info=False)
        try:
            if not book.sheet_names():
                return {"parse_status": "xls_no_worksheet", "room": None, "document": None}
            room = room_evidence(book, xlrd)
            document = document_evidence(book, xlrd)
            parse_status = "xls_text_available"
            if (room.get("status") == "xls_text_available_no_room_cues"
                    and document.get("status") == "xls_text_available_no_document_cues"):
                parse_status = "xls_text_available_no_cues"
            return {"parse_status": parse_status, "room": room, "document": document}
        finally:
            try:
                book.release_resources()
            except Exception:
                pass
    except TimeoutError:
        return {"parse_status": "xls_parse_timeout", "room": None, "document": None}
    except Exception:
        return {"parse_status": "xls_parse_error", "room": None, "document": None}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def _safe_snapshot(name):
    return isinstance(name, str) and bool(SNAPSHOT_RE.fullmatch(name))


def _raw_key(value):
    return isinstance(value, str) and 1 <= len(value) <= 1024 and not any(ord(c) < 32 for c in value)


def _decode_snapshots(target, snapshots):
    if (not isinstance(target, dict) or not target or len(target) > 100
            or not isinstance(snapshots, list) or not snapshots or len(snapshots) > 8
            or any(not _safe_snapshot(name) for name in snapshots)):
        raise ValueError("request_schema")
    row_to_cases = {}
    for case, row_ids in target.items():
        if not isinstance(case, str) or not CASE_RE.fullmatch(case):
            raise ValueError("case_schema")
        if (not isinstance(row_ids, list) or not row_ids or len(row_ids) > 10
                or any(not isinstance(row_id, str) or not ROW_ID_RE.fullmatch(row_id)
                       for row_id in row_ids)):
            raise ValueError("row_id_schema")
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
                        references[case].append({"row_id": row_id, "snapshot": snapshot, "key": locator})
                resolved.add(row_id)
        if len(resolved) >= len(row_to_cases):
            break
    return references


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


def _load_isolated_xlrd():
    temporary = tempfile.TemporaryDirectory(prefix="centurion-xls-xlrd-")
    req_path = Path(temporary.name) / "requirements.txt"
    requirement = (
        "xlrd==2.0.1 --hash=sha256:" + XLRD_WHEEL_SHA256 + "\n"
    ).encode("ascii")
    fd = os.open(req_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(requirement)
    command = [
        sys.executable, "-m", "pip", "install", "--isolated", "--no-cache-dir",
        "--disable-pip-version-check", "--quiet", "--no-deps", "--only-binary=:all:",
        "--require-hashes", "--index-url", "https://pypi.org/simple",
        "--target", temporary.name, "-r", str(req_path),
    ]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=50, check=False)
    except Exception:
        temporary.cleanup()
        raise RuntimeError("isolated_parser_install_failed")
    if result.returncode != 0:
        temporary.cleanup()
        raise RuntimeError("isolated_parser_install_failed")
    sys.path.insert(0, temporary.name)
    try:
        import xlrd
        if xlrd.__version__ != XLRD_VERSION:
            raise RuntimeError("isolated_parser_version_mismatch")
    except Exception:
        temporary.cleanup()
        raise RuntimeError("isolated_parser_import_failed")
    return xlrd, temporary


def _is_legacy_xls(part):
    try:
        name = str(part.get_filename() or "").strip().casefold()
        content_type = str(part.get_content_type() or "").casefold()
    except Exception:
        return False
    if name.endswith(".xlsx"):
        return False
    return name.endswith(".xls") or content_type in {
        "application/vnd.ms-excel", "application/x-msexcel",
        "application/msexcel", "application/x-excel",
    }


def _source_result(bucket, s3, case, reference, xlrd, counters):
    record = {"source_row_id": reference["row_id"], "snapshot": reference["snapshot"],
              "status": "s3_read_error", "attachments": []}
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
        if not _is_legacy_xls(part):
            continue
        if len(record["attachments"]) >= MAX_ATTACHMENTS_PER_CASE:
            record["attachments_truncated"] = True
            break
        try:
            blob = part.get_payload(decode=True) or b""
        except Exception:
            blob = b""
        attachment = {
            "ordinal": len(record["attachments"]) + 1,
            "type": "legacy_xls",
            "mime_type": str(part.get_content_type() or "application/octet-stream"),
            "attachment_size_bytes": len(blob),
            "attachment_sha256": hashlib.sha256(blob).hexdigest(),
            "filename_redacted": True,
        }
        try:
            parsed = parse_xls(blob, xlrd)
            attachment.update(parsed)
        except Exception:
            attachment.update(parse_status="xls_parse_error", room=None, document=None)
        record["attachments"].append(attachment)
    return record


def _run_remote():
    request = json.loads(base64.b64decode(REQUEST_B64, validate=True).decode("utf-8"))
    target = request.get("target")
    snapshots = request.get("snapshots")
    token = request.get("transfer_token")
    declared = request.get("declared_xls")
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        raise ValueError("transfer_token")
    if not isinstance(declared, dict) or set(declared) != set(target or {}):
        raise ValueError("declared_schema")
    references = _decode_snapshots(target, snapshots)
    xlrd, package_temp = _load_isolated_xlrd()
    try:
        bucket, s3 = _s3_client()
        counters = {"s3_gets": 0}
        started = time.perf_counter()
        cases = {}
        for case, case_references in references.items():
            sources = [
                _source_result(bucket, s3, case, reference, xlrd, counters)
                for reference in case_references
            ]
            attachments = [attachment for source in sources
                           for attachment in source.get("attachments", [])]
            if attachments:
                case_status = "processed"
            elif not sources:
                case_status = "locator_missing"
            elif any(source.get("status") != "ok" for source in sources):
                case_status = "source_unavailable"
            elif declared.get(case):
                case_status = "declared_xls_not_found_in_mime"
            else:
                case_status = "no_legacy_xls_attachment"
            cases[case] = {
                "status": case_status,
                "declared_legacy_xls": bool(declared.get(case)),
                "source_count": len(sources),
                "attachment_count": len(attachments),
                "sources": sources,
            }
        result = {
            "status": "ok", "version": VERSION,
            "parser": {"name": "xlrd", "version": XLRD_VERSION,
                       "install_scope": "temporary_target", "wheel_sha256": XLRD_WHEEL_SHA256},
            "s3_gets": counters["s3_gets"],
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "cases": cases,
            "method_notes": [
                "No formulas or macros executed; xlrd read cached workbook cell values only.",
                "Room/guest names and arbitrary cell contents are not returned.",
                "Spreadsheet row counts are evidence only, not inferred room counts.",
                "No legacy XLS found is distinct from an unavailable MIME source.",
            ],
        }
        raw_result = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw_result) > MAX_RESULT_BYTES:
            raise ValueError("result_size_limit")
        compressed = zlib.compress(raw_result, 9)
        if len(compressed) > MAX_TRANSFER_BYTES:
            raise ValueError("transfer_size_limit")
        transfer_path = TRANSFER_ROOT / ("centurion-xls-evidence-" + token + ".z")
        fd = os.open(transfer_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(compressed)
        return {
            "status": "ok", "version": VERSION,
            "transfer_path": str(transfer_path), "transfer_bytes": len(compressed),
            "transfer_sha256": hashlib.sha256(compressed).hexdigest(),
            "case_count": len(cases), "s3_gets": counters["s3_gets"],
        }
    finally:
        package_temp.cleanup()


if __name__ == "__main__":
    try:
        result = _run_remote()
    except Exception:
        result = {"status": "failed", "version": VERSION,
                  "error_code": "remote_xls_extract_failed"}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
'''


def _safe_snapshot(value: Any) -> bool:
    return isinstance(value, str) and bool(SNAPSHOT_RE.fullmatch(value))


def _private_path(path: pathlib.Path, must_exist: bool) -> pathlib.Path:
    candidate = path if path.is_absolute() else ROOT / path
    absolute = pathlib.Path(os.path.abspath(candidate))
    private = PRIVATE_ROOT.resolve(strict=True)
    parent = absolute.parent.resolve(strict=True)
    if (absolute == private or not absolute.is_relative_to(private)
            or not parent.is_relative_to(private) or parent != absolute.parent):
        raise Failure("private_path_required")
    if must_exist:
        try:
            info = absolute.lstat()
        except OSError:
            raise Failure("private_input_unavailable") from None
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o600
                or absolute.resolve(strict=True) != absolute):
            raise Failure("private_input_permissions")
    elif absolute.exists() or absolute.is_symlink():
        raise Failure("output_exists")
    else:
        info = parent.stat()
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise Failure("private_output_directory_permissions")
    return absolute


def _read_jsonl(path: pathlib.Path) -> tuple[list[dict[str, Any]], bytes]:
    try:
        raw = path.read_bytes()
    except OSError:
        raise Failure("private_input_unavailable") from None
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise Failure("input_size_invalid")
    rows: list[dict[str, Any]] = []
    # Split on literal LF bytes only; JSON strings may contain Unicode LS/PS.
    for line in raw.split(b"\n"):
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


def _declares_legacy_xls(row: dict[str, Any]) -> bool:
    inbound = row.get("inbound")
    if not isinstance(inbound, dict):
        return False
    context = inbound.get("attachment_context")
    return isinstance(context, str) and bool(LEGACY_XLS_RE.search(context))


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


def _write_private(path: pathlib.Path, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        raise Failure("private_output_create_failed") from None
    with os.fdopen(fd, "wb") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(payload)


def _ssm(helper: Any, command: str) -> str:
    try:
        return helper.ssm(command)
    except Exception:
        raise Failure("read_only_s3_fetch_failed") from None


def _cleanup_remote(helper: Any, token: str) -> bool:
    expected = f"/tmp/centurion-xls-evidence-{token}.z"
    cleanup = f'''python3 - <<'PY'
import json,os,stat
from pathlib import Path
p=Path({expected!r})
try:
 s=p.lstat()
 if stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and stat.S_IMODE(s.st_mode)==0o600:
  p.unlink(); print(json.dumps({{"status":"cleaned"}}))
 else: print(json.dumps({{"status":"not_removed"}}))
except FileNotFoundError:
 print(json.dumps({{"status":"already_absent"}}))
PY'''
    try:
        result = json.loads(helper.ssm(cleanup))
        return result.get("status") in {"cleaned", "already_absent"}
    except Exception:
        return False


def _fetch_remote_result(helper: Any, token: str, metadata: dict[str, Any]) -> bytes:
    expected_path = f"/tmp/centurion-xls-evidence-{token}.z"
    size = metadata.get("transfer_bytes")
    digest = metadata.get("transfer_sha256")
    if (metadata.get("transfer_path") != expected_path or not isinstance(size, int)
            or size < 1 or size > MAX_TRANSFER_BYTES
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
        raise Failure("remote_transfer_metadata_invalid")

    def fetch(offset: int) -> tuple[int, bytes]:
        command = f'''python3 - <<'PY'
import base64
from pathlib import Path
p=Path({expected_path!r})
with p.open("rb") as source:
 source.seek({offset})
 chunk=source.read({TRANSFER_CHUNK_BYTES})
print(base64.b64encode(chunk).decode("ascii"))
PY'''
        value = _ssm(helper, command)
        try:
            chunk = base64.b64decode(value.strip(), validate=True)
        except Exception:
            raise Failure("remote_transfer_chunk_invalid") from None
        expected = min(TRANSFER_CHUNK_BYTES, size - offset)
        if len(chunk) != expected:
            raise Failure("remote_transfer_chunk_length_mismatch")
        return offset, chunk

    offsets = list(range(0, size, TRANSFER_CHUNK_BYTES))
    chunks: dict[int, bytes] = {}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for offset, chunk in pool.map(fetch, offsets):
                chunks[offset] = chunk
    except Failure:
        raise
    except Exception:
        raise Failure("remote_transfer_fetch_failed") from None
    data = b"".join(chunks[offset] for offset in offsets)
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise Failure("remote_transfer_integrity_mismatch")
    return data


def run(args: argparse.Namespace) -> dict[str, Any]:
    input_path = _private_path(args.input, must_exist=True)
    output_path = _private_path(args.output, must_exist=False)
    if not args.snapshot or len(args.snapshot) > MAX_SNAPSHOTS:
        raise Failure("snapshot_selection_invalid")
    if (len(set(args.snapshot)) != len(args.snapshot)
            or any(not _safe_snapshot(name) for name in args.snapshot)):
        raise Failure("snapshot_selection_invalid")
    rows, raw = _read_jsonl(input_path)
    declared = {row["case"]: _declares_legacy_xls(row) for row in rows}
    selected = args.case or [case for case, is_xls in declared.items() if is_xls]
    if not selected:
        raise Failure("no_legacy_xls_cases_selected")
    if len(selected) > MAX_CASES:
        raise Failure("case_limit_exceeded")
    target = _target_rows(rows, selected)
    declared_selected = {case: bool(declared.get(case, False)) for case in selected}
    token = uuid.uuid4().hex
    request = {
        "target": target,
        "snapshots": args.snapshot,
        "declared_xls": declared_selected,
        "transfer_token": token,
    }
    request_b64 = base64.b64encode(
        json.dumps(request, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).decode("ascii")
    command = "REQUEST_B64 = " + repr(request_b64) + "\n" + REMOTE
    wrapped = "python3 - <<'PY'\n" + command + "\nPY"
    helper = _module("centurion_xls_tail", TAIL_PATH)
    started = time.perf_counter()
    transfer_cleaned = False
    try:
        metadata_text = _ssm(helper, wrapped)
        try:
            metadata = json.loads(metadata_text)
        except Exception:
            raise Failure("remote_metadata_invalid") from None
        if (not isinstance(metadata, dict) or metadata.get("status") != "ok"
                or metadata.get("version") != VERSION or metadata.get("case_count") != len(selected)):
            raise Failure(metadata.get("error_code", "remote_extract_failed")
                          if isinstance(metadata, dict) else "remote_extract_failed")
        compressed = _fetch_remote_result(helper, token, metadata)
        try:
            decompressor = zlib.decompressobj()
            result_bytes = decompressor.decompress(compressed, MAX_RAW_RESULT_BYTES + 1)
            if len(result_bytes) > MAX_RAW_RESULT_BYTES or decompressor.unconsumed_tail:
                raise Failure("remote_result_too_large")
            result = json.loads(result_bytes.decode("utf-8"))
        except Failure:
            raise
        except Exception:
            raise Failure("remote_result_invalid") from None
        if (not isinstance(result, dict) or result.get("status") != "ok"
                or result.get("version") != VERSION
                or not isinstance(result.get("cases"), dict)
                or set(result["cases"]) != set(selected)):
            raise Failure("remote_case_mismatch")
    finally:
        transfer_cleaned = _cleanup_remote(helper, token)

    result.update({
        "input_sha256": hashlib.sha256(raw).hexdigest(),
        "input_path": str(input_path),
        "selected_cases": selected,
        "snapshot_names": args.snapshot,
        "elapsed_seconds_local": round(time.perf_counter() - started, 3),
        "remote_transfer_cleanup_verified": transfer_cleaned,
        "output": str(output_path),
    })
    _write_private(output_path, result)
    statuses: dict[str, int] = {}
    attachment_statuses: dict[str, int] = {}
    for case in result["cases"].values():
        status = str(case.get("status", "unknown"))
        statuses[status] = statuses.get(status, 0) + 1
        for source in case.get("sources", []):
            for attachment in source.get("attachments", []):
                status = str(attachment.get("parse_status", "unknown"))
                attachment_statuses[status] = attachment_statuses.get(status, 0) + 1
    return {
        "status": "ok", "version": VERSION,
        "selected_cases": len(selected),
        "s3_gets": result.get("s3_gets"),
        "case_statuses": statuses,
        "attachment_parse_statuses": attachment_statuses,
        "remote_transfer_cleanup_verified": transfer_cleaned,
        "input_sha256": result["input_sha256"],
        "output": str(output_path),
        "elapsed_seconds_local": result["elapsed_seconds_local"],
    }


def self_test() -> dict[str, Any]:
    try:
        compile(REMOTE, "centurion-xls-evidence-remote", "exec")
    except Exception:
        raise Failure("self_test_remote_source_invalid") from None
    valid_cases = ["I00003", "N04", "CASE_1"]
    invalid_cases = ["../x", "", "bad.case", "a" * 130]
    if (any(not CASE_RE.fullmatch(case) for case in valid_cases)
            or any(CASE_RE.fullmatch(case) for case in invalid_cases)):
        raise Failure("self_test_case_validation_failed")
    positives = ["application/vnd.ms-excel; name=rooming.xls", "guestfile.XLS"]
    negatives = ["booking.xlsx", "report.xlsm", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
    if (any(not LEGACY_XLS_RE.search(value) for value in positives)
            or any(LEGACY_XLS_RE.search(value) for value in negatives)):
        raise Failure("self_test_legacy_extension_detection_failed")
    if (not re.fullmatch(r"[a-f0-9]{64}", XLRD_WHEEL_SHA256)
            or "xlrd==2.0.1" not in REMOTE
            or "MAX_ATTACHMENT_BYTES = 8000000" not in REMOTE
            or "s3.get_object" not in REMOTE
            or "_safe_room_header(field)" not in REMOTE
            or 'cell["field"] = field' in REMOTE
            or "s3.put_object" in REMOTE or "s3.delete_object" in REMOTE):
        raise Failure("self_test_dependency_or_read_only_contract_failed")
    return {
        "self_test": "ok",
        "remote_source_compiles": True,
        "legacy_xls_distinguished_from_xlsx": True,
        "pinned_isolated_dependency": "xlrd==2.0.1",
        "pypi_wheel_sha256": XLRD_WHEEL_SHA256,
        "max_cases": MAX_CASES,
        "attachment_bytes_cap": 8_000_000,
        "no_raw_file_transfer": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--case", action="append", default=[],
                        help="repeat to select specific cases; default selects exact .xls metadata")
    parser.add_argument("--snapshot", action="append", default=[], required=False)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            result = self_test()
        else:
            if args.input is None or args.output is None or not args.snapshot:
                raise Failure("input_output_and_snapshot_required")
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
