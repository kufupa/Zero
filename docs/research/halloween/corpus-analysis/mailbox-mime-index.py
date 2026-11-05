#!/usr/bin/env python3
"""Private, read-only MIME attachment/body indexer over saved mailbox snapshots."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import html
import importlib.util
import json
import os
import random
import re
import shlex
import stat
import subprocess
import sys
import time
import unicodedata
import uuid
import zlib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
PRIVATE_ROOT = ROOT / ".private"
SSM_RUNNER = ROOT / "apps/server-pilot/deploy/ssm-run-command.sh"
TAIL_HELPER = ROOT / "docs/research/halloween/corpus-analysis/centurion-recent-tail.py"
DEFAULT_REMOTE_CORPUS = "/home/ubuntu/repos/zero/.private/connected-mailbox-corpus"
DEFAULT_MAX_OBJECT_BYTES = 15_000_000
DEFAULT_BODY_CHARS = 6_000
INDEX_STATUSES = {"ok", "locator_missing", "too_large", "read_error"}
BODY_STATUSES = {
    "not_needed", "not_requested", "ok", "empty", "locator_missing",
    "too_large", "read_error", "withheld_sensitive",
}
SNAPSHOT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_EXTENSIONS = {
    "pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "rtf", "eml", "msg",
    "png", "jpg", "jpeg", "gif", "tif", "tiff", "bmp", "zip", "html", "htm",
    "ppt", "pptx", "ics", "xml",
}
SAFE_NAME_WORDS = {
    "amend", "amendment", "allocation", "bank", "bill", "billing", "booking",
    "card", "cancel", "cancellation", "client", "confirmation", "contract",
    "credit", "debit", "document", "folio", "group", "guest", "hotel", "image",
    "invoice", "itinerary", "letter", "list", "menu", "payment", "pop",
    "proforma", "proof", "quote", "quotation", "receipt", "refund", "reservation",
    "room", "rooming", "scan", "settlement", "statement", "supplier", "ticket",
    "travel", "travelit", "vcc", "virtual", "voucher",
}
DOCUMENT_NAME_MARKERS = {
    "amend", "allocation", "booking", "cancel", "confirmation", "document",
    "folio", "invoice", "itinerary", "payment", "pop", "proforma", "proof",
    "quote", "receipt", "reservation", "rooming", "scan", "statement", "ticket",
    "voucher",
}


class SafeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


REMOTE_CODE = r'''
import base64, email, hashlib, html, json, logging, os, re, subprocess, sys, time, unicodedata, zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
import boto3
from botocore.config import Config

logging.disable(logging.CRITICAL)

SAFE_NAME_WORDS = set(CONFIG["safe_name_words"])
DOC_MARKERS = set(CONFIG["document_markers"])
SAFE_EXTENSIONS = set(CONFIG["safe_extensions"])

def safe_name(value, mime):
    raw = str(value or "").replace("\\\\", "/").rsplit("/", 1)[-1]
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode().casefold()
    match = re.search(r"\\.([a-z0-9]{1,8})$", folded)
    ext = match.group(1) if match and match.group(1) in SAFE_EXTENSIONS else ""
    stem = folded[:-(len(ext) + 1)] if ext else folded
    words = re.findall(r"[a-z0-9]+", stem)
    kept = [word for word in words if word in SAFE_NAME_WORDS]
    unknown = any(word not in SAFE_NAME_WORDS for word in words)
    if not kept:
        kept = ["document" if not raw else "redacted"]
    if unknown and kept != ["redacted"]:
        kept.append("redacted")
    if not ext:
        ext = {
            "application/pdf": "pdf",
            "application/msword": "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "application/vnd.ms-excel": "xls",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
            "text/plain": "txt",
            "text/csv": "csv",
            "image/png": "png",
            "image/jpeg": "jpg",
        }.get(str(mime or "").casefold(), "")
    return "_".join(kept[:12])[:96] + (("." + ext) if ext else "")

class VisibleHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.suppressed = []

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        attrs = {str(k).casefold(): str(v or "").casefold() for k, v in attrs}
        classes = attrs.get("class", "")
        ident = attrs.get("id", "")
        quote_container = any(mark in classes + " " + ident for mark in (
            "gmail_quote", "yahoo_quoted", "moz-cite-prefix", "divrplyfwdmsg",
            "quoted", "original-message", "forwarded-message",
        ))
        if self.suppressed:
            if tag not in {"br", "img", "hr", "meta", "link", "input"}:
                self.suppressed.append(tag)
            return
        if tag in {"script", "style", "head", "blockquote"} or quote_container:
            self.suppressed.append(tag)
        elif tag in {"br", "p", "div", "tr", "td", "li", "h1", "h2", "h3"}:
            self.parts.append("\\n")

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if self.suppressed:
            for i in range(len(self.suppressed) - 1, -1, -1):
                if self.suppressed[i] == tag:
                    del self.suppressed[i:]
                    break
        elif tag in {"p", "div", "tr", "td", "li", "h1", "h2", "h3"}:
            self.parts.append("\\n")

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(data)

def strip_quotes(text):
    lines = str(text or "").replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")
    cut = len(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if re.match(r"(?i)^(?:>{1,}|-----original message-----|begin forwarded message:|"
                    r"-{2,}\\s*forwarded message\\s*-{2,}|_{8,})", stripped):
            cut = i
            break
        if re.match(r"(?i)^on .{5,180}\\bwrote:\\s*$", stripped):
            cut = i
            break
        if re.match(r"(?i)^from:\\s*\\S+", stripped):
            header = "\\n".join(lines[i:min(i + 10, len(lines))])
            if re.search(r"(?im)^\\s*(?:sent|date|to|subject|cc):", header):
                cut = i
                break
    return "\\n".join(lines[:cut]).strip()

def scrub_body(value, max_chars):
    text = html.unescape(str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = text.replace("\\r\\n", "\\n").replace("\\r", "\\n").replace("\\xa0", " ")
    text = re.sub(r"(?i)https?://\\S+|\\bwww\\.\\S+", "[link]", text)
    text = re.sub(r"(?i)\\bmailto:\\S+", "[email]", text)
    text = re.sub(r"\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b", "[email]", text, flags=re.I)
    text = re.sub(r"(?i)\\b(authori[sz]ation|auth(?:ori[sz]ation)?|security|verification)\\s+code"
                  r"\\s*(?:is|:|=|-)?\\s*[A-Z0-9][A-Z0-9-]{3,24}\\b", "[code removed]", text)
    text = re.sub(r"(?i)\\b(card\\s*(?:number|no\\.?|expiry|expiration)|cvv|cvc|security code|"
                  r"account\\s*(?:number|no\\.?)|iban|password|passcode|pin|otp|verification code)"
                  r"\\s*(?:is|:|=|-)?\\s*[^\\s,;]{3,32}", "[sensitive detail removed]", text)
    text = re.sub(r"(?<!\\d)(?:\\d[ -]?){13,19}(?!\\d)", "[number removed]", text)
    text = re.sub(r"(?i)\\b(?:reservation|booking|confirmation|reference|ref|invoice)"
                  r"\\s*(?:number|no\\.?|id|#)?\\s*[:#=-]\\s*[A-Z0-9-]{4,32}\\b",
                  "[reference removed]", text)
    text = re.sub(r"(?<!\\w)(?:\\+?\\d[\\d ().-]{7,}\\d)(?!\\w)", "[number removed]", text)
    text = re.sub(r"(?im)^\\s*(?:from|to|cc|bcc|reply-to|sent|date|subject):[^\\n]*$", "", text)
    text = re.sub(r"(?im)^(\\s*(?:dear|hi|hello)\\s+)[^,\\n]{1,70}([,!:])", r"\\1[redacted]\\2", text)
    text = re.sub(r"(?im)^(\\s*(?:guest(?: name)?|lead guest|travell?er|contact|client|name)"
                  r"\\s*[:=-]\\s*).+$", r"\\1[redacted]", text)
    text = re.sub(r"(?im)^\\s*(?:--|kind regards|best regards|regards|warm regards|"
                  r"yours sincerely|sincerely)\\s*,?\\s*$[\\s\\S]*", "", text)
    if re.search(r"(?i)\\b(?:otp|one[ -]time password|verification code|security code|"
                 r"authorization code|authorisation code)\\b", text):
        text = re.sub(r"(?im)^\\s*(?=[a-z0-9-]{4,12}\\s*$)(?=[a-z0-9-]*\\d)[a-z0-9-]+\\s*$",
                      "[code removed]", text)
    text = re.sub(r"[ \\t]{2,}", " ", text)
    text = re.sub(r"\\n{3,}", "\\n\\n", text).strip()
    return text[:max_chars]

def sensitive_residual(text):
    if re.search(r"(?<!\\d)(?:\\d[ -]?){13,19}(?!\\d)", text):
        return True
    return bool(re.search(
        r"(?i)\\b(?:card\\s*(?:number|no\\.?)|cvv|cvc|authorization code|authorisation code|"
        r"otp|verification code|security code|password|passcode)\\s*(?:is|:|=|-)\\s*\\S+",
        text,
    ))

def body_from_message(msg, max_chars):
    plain, rich = [], []
    def walk(part):
        mime = part.get_content_type().casefold()
        disp = part.get_content_disposition()
        filename = part.get_filename()
        if mime == "message/rfc822" or disp == "attachment" or filename:
            return
        if part.is_multipart():
            try:
                for child in part.iter_parts():
                    walk(child)
            except Exception:
                return
            return
        if mime not in ("text/plain", "text/html"):
            return
        try:
            value = part.get_content()
        except Exception:
            try:
                payload = part.get_payload(decode=True)
                value = payload.decode(part.get_content_charset() or "utf-8", "replace") if payload else ""
            except Exception:
                return
        if not isinstance(value, str):
            return
        (plain if mime == "text/plain" else rich).append(value)
    walk(msg)
    text = next((v for v in plain if v.strip()), "")
    if not text:
        raw_html = next((v for v in rich if v.strip()), "")
        parser = VisibleHTML()
        try:
            parser.feed(raw_html)
            text = "".join(parser.parts)
        except Exception:
            text = ""
    text = strip_quotes(text)
    return scrub_body(text, max_chars)

def is_document_marker(name):
    low = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().casefold()
    return any(marker in low for marker in DOC_MARKERS)

def is_attachment(part):
    mime = part.get_content_type().casefold()
    disp = part.get_content_disposition()
    name = part.get_filename()
    cid = bool(part.get("Content-ID"))
    if mime == "message/rfc822":
        return bool(name or disp == "attachment")
    if disp == "attachment":
        return True
    if cid and mime.startswith("image/") and disp != "attachment":
        return is_document_marker(name)
    if name:
        return True
    if mime in ("text/plain", "text/html"):
        return False
    return bool(disp == "inline" or not cid)

def attachment_metadata(msg):
    found, skipped = [], 0
    def walk(part):
        nonlocal skipped
        mime = part.get_content_type().casefold()
        disp = part.get_content_disposition()
        name = part.get_filename()
        cid = bool(part.get("Content-ID"))
        if part.is_multipart() and mime != "message/rfc822":
            if disp == "attachment" or name:
                found.append({"name": safe_name(name, mime), "content_type": mime})
                return
            try:
                for child in part.iter_parts():
                    walk(child)
            except Exception:
                return
            return
        if mime == "message/rfc822":
            if is_attachment(part):
                found.append({"name": safe_name(name, mime), "content_type": mime})
            return
        if cid and mime.startswith("image/") and disp != "attachment" and not is_document_marker(name):
            skipped += 1
            return
        if is_attachment(part):
            found.append({"name": safe_name(name, mime), "content_type": mime})
    walk(msg)
    return found, skipped

def main():
    cfg = CONFIG
    started = time.monotonic()
    targets = cfg["targets"]
    wanted = {rid for row in targets.values() for rid in row["row_ids"]}
    locator_by_pair = {}
    scan_errors = 0
    scanned_lines = 0
    scan_started = time.monotonic()
    root = Path(cfg["remote_corpus_root"])
    for snapshot in cfg["snapshots"]:
        source = root / snapshot / "messages.jsonl"
        try:
            stream = source.open("r", encoding="utf-8")
        except Exception:
            scan_errors += 1
            continue
        with stream:
            for line in stream:
                scanned_lines += 1
                try:
                    record = json.loads(line)
                except Exception:
                    scan_errors += 1
                    continue
                rid = record.get("id")
                locator = record.get("rawMimeLocator")
                if rid in wanted and isinstance(locator, str) and locator:
                    key = (snapshot, rid)
                    if key not in locator_by_pair:
                        locator_by_pair[key] = locator
    scan_seconds = time.monotonic() - scan_started

    processes = json.loads(subprocess.check_output(["pm2", "jlist"], stderr=subprocess.DEVNULL, timeout=20))
    env = next((p["pm2_env"] for p in processes if p.get("name") == cfg["pm2_process"]), None)
    if env is None:
        raise RuntimeError("runtime_unavailable")
    nested = env.get("env") or {}
    for key in ("AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
        value = env.get(key) or nested.get(key)
        if value:
            os.environ.setdefault(key, str(value))
    bucket = env.get("S3_BUCKET") or nested.get("S3_BUCKET")
    if not bucket:
        raise RuntimeError("bucket_unavailable")
    client = boto3.client(
        "s3", region_name=env.get("AWS_REGION") or cfg["aws_region"],
        config=Config(connect_timeout=5, read_timeout=30, retries={"max_attempts": 1}),
    )

    candidates = {}
    unique_locators = set()
    duplicate_locators = 0
    for case, row in targets.items():
        rows = []
        seen = set()
        for rid_index, rid in enumerate(row["row_ids"]):
            for snap_index, snapshot in enumerate(cfg["snapshots"]):
                locator = locator_by_pair.get((snapshot, rid))
                if not locator:
                    continue
                if locator in seen:
                    duplicate_locators += 1
                    continue
                seen.add(locator)
                unique_locators.add(locator)
                rows.append({
                    "locator": locator,
                    "row_index": rid_index,
                    "snapshot_index": snap_index,
                    "snapshot": snapshot,
                })
        candidates[case] = rows

    empty_body_cases = set(cfg["body_cases"])
    needs_body = empty_body_cases if cfg["recover_empty_body"] else set()
    body_candidate_locators = {
        item["locator"]
        for case in needs_body
        for item in candidates.get(case, [])
    }
    cache = {}
    metrics = {
        "snapshot_lines_scanned": scanned_lines,
        "snapshot_scan_errors": scan_errors,
        "snapshot_scan_seconds": round(scan_seconds, 3),
        "candidate_locator_count": len(unique_locators),
        "duplicate_candidate_locators": duplicate_locators,
        "s3_get_count": 0,
        "s3_get_bytes": 0,
        "oversize_objects": 0,
        "oversize_declared_bytes": 0,
        "read_errors": 0,
        "parsed_mime_objects": 0,
        "attachments_found": 0,
        "inline_cid_images_skipped": 0,
        "body_extractions": 0,
        "body_nonempty": 0,
        "row_fallback_successes": 0,
        "snapshot_fallback_successes": 0,
        "fallback_candidates_skipped": 0,
        "empty_mime_alternative_attempts": 0,
        "incomplete_empty_mime_cases": 0,
        "unexamined_locator_candidates_after_attachment": 0,
    }
    metrics_lock = __import__("threading").Lock()
    def bump(name, value):
        with metrics_lock:
            metrics[name] += value

    def fetch(locator, want_body):
        result = {"status": "read_error", "attachments": [], "body_status": "read_error",
                  "body": "", "inline_skipped": 0, "bytes": 0, "declared_bytes": 0}
        response = None
        got = 0
        try:
            response = client.get_object(Bucket=bucket, Key=locator)
            stream = response["Body"]
            try:
                declared = int(response.get("ContentLength") or 0)
            except Exception:
                declared = 0
            result["declared_bytes"] = declared
            if declared > cfg["max_object_bytes"]:
                result.update(status="too_large", body_status="too_large")
                return result
            chunks = []
            remaining = cfg["max_object_bytes"] + 1
            while remaining > 0:
                piece = stream.read(min(65_536, remaining))
                if not piece:
                    break
                chunks.append(piece)
                got += len(piece)
                remaining -= len(piece)
            result["bytes"] = got
            if got > cfg["max_object_bytes"]:
                result.update(status="too_large", body_status="too_large")
                return result
            raw = b"".join(chunks)
            msg = BytesParser(policy=policy.default).parsebytes(raw)
            attachments, skipped = attachment_metadata(msg)
            result.update(status="ok", attachments=attachments, inline_skipped=skipped,
                          body_status="not_needed", body="")
            if want_body:
                result["body_extracted"] = True
                try:
                    body = body_from_message(msg, cfg["body_chars"])
                    if body:
                        if sensitive_residual(body):
                            result.update(body_status="withheld_sensitive", body="")
                        else:
                            result.update(body_status="ok", body=body)
                    else:
                        result.update(body_status="empty", body="")
                except Exception:
                    result.update(body_status="read_error", body="")
            return result
        except Exception:
            result["bytes"] = got
            return result
        finally:
            if got:
                bump("s3_get_bytes", got)
            if response is not None:
                try:
                    response["Body"].close()
                except Exception:
                    pass

    # Resolve alternatives in order. Fetch each distinct locator at most once.
    active = {case for case in targets if candidates[case]}
    positions = {case: 0 for case in active}
    final = {}
    empty_success = {}
    empty_success_positions = {}
    candidate_failures = {case: [] for case in active}
    body_best = {}

    def body_rank(item):
        return {"ok": 4, "withheld_sensitive": 3, "empty": 2, "read_error": 1}.get(
            item.get("body_status"), 0
        )

    def body_for(case, fallback):
        if case not in needs_body:
            return "not_requested" if case in empty_body_cases and not cfg["recover_empty_body"] else "not_needed", ""
        item = body_best.get(case) or fallback
        if item is None:
            return "read_error", ""
        return item.get("body_status", "read_error"), item.get("body", "")

    def note_fallback(case, candidate):
        position = empty_success_positions.get(case, positions[case])
        if position > 0:
            metrics["fallback_candidates_skipped"] += position
            if candidate["row_index"] > 0:
                metrics["row_fallback_successes"] += 1
            if candidate["snapshot_index"] > 0:
                metrics["snapshot_fallback_successes"] += 1
    while active:
        round_locators = {}
        for case in active:
            round_locators.setdefault(candidates[case][positions[case]]["locator"], set()).add(case)
        missing_from_cache = [loc for loc in round_locators if loc not in cache]
        if missing_from_cache:
            metrics["s3_get_count"] += len(missing_from_cache)
            with ThreadPoolExecutor(max_workers=cfg["workers"]) as pool:
                futures = {
                    pool.submit(fetch, loc, loc in body_candidate_locators): loc
                    for loc in missing_from_cache
                }
                for future in as_completed(futures):
                    loc = futures[future]
                    try:
                        cache[loc] = future.result()
                    except Exception:
                        cache[loc] = {"status": "read_error", "attachments": [],
                                      "body_status": "read_error", "body": "",
                                      "inline_skipped": 0, "bytes": 0, "declared_bytes": 0}
                for loc in missing_from_cache:
                    item = cache[loc]
                    metrics["oversize_objects"] += int(item["status"] == "too_large")
                    metrics["oversize_declared_bytes"] += (
                        item.get("declared_bytes", 0) if item["status"] == "too_large" else 0
                    )
                    metrics["read_errors"] += int(item["status"] == "read_error")
                    metrics["parsed_mime_objects"] += int(item["status"] == "ok")
                    metrics["attachments_found"] += len(item.get("attachments", []))
                    metrics["inline_cid_images_skipped"] += item.get("inline_skipped", 0)
                    metrics["body_extractions"] += int(item.get("body_extracted", False))
                    metrics["body_nonempty"] += int(item.get("body_status") == "ok")
        for case in list(active):
            candidate = candidates[case][positions[case]]
            got = cache[candidate["locator"]]
            if got["status"] == "ok":
                if case in needs_body and (
                    case not in body_best or body_rank(got) > body_rank(body_best[case])
                ):
                    body_best[case] = got
                if got["attachments"]:
                    body_status, body = body_for(case, got)
                    record = {
                        "case": case,
                        "status": "ok",
                        "attachments": got["attachments"],
                        "body_status": body_status,
                    }
                    if body_status == "ok":
                        record["recovered_body"] = body
                    final[case] = record
                    note_fallback(case, candidate)
                    metrics["unexamined_locator_candidates_after_attachment"] += (
                        len(candidates[case]) - positions[case] - 1
                    )
                    active.remove(case)
                else:
                    if case not in empty_success:
                        empty_success[case] = got
                        empty_success_positions[case] = positions[case]
                    if positions[case] + 1 < len(candidates[case]):
                        metrics["empty_mime_alternative_attempts"] += 1
                        positions[case] += 1
                        continue
                    status = "read_error" if candidate_failures[case] or scan_errors else "ok"
                    if status != "ok":
                        metrics["incomplete_empty_mime_cases"] += 1
                    chosen = candidates[case][empty_success_positions[case]]
                    body_status, body = body_for(case, empty_success[case])
                    record = {
                        "case": case,
                        "status": status,
                        "attachments": [],
                        "body_status": body_status,
                    }
                    if body_status == "ok":
                        record["recovered_body"] = body
                    final[case] = record
                    note_fallback(case, chosen)
                    active.remove(case)
            else:
                candidate_failures[case].append(got["status"])
                if positions[case] + 1 < len(candidates[case]):
                    positions[case] += 1
                    continue
                if case in empty_success:
                    metrics["incomplete_empty_mime_cases"] += 1
                    chosen = candidates[case][empty_success_positions[case]]
                    body_status, body = body_for(case, empty_success[case])
                    record = {
                        "case": case,
                        "status": "read_error",
                        "attachments": [],
                        "body_status": body_status,
                    }
                    if body_status == "ok":
                        record["recovered_body"] = body
                    final[case] = record
                    note_fallback(case, chosen)
                    active.remove(case)
                else:
                    failed = candidate_failures[case]
                    if scan_errors or "read_error" in failed:
                        status = "read_error"
                    elif "too_large" in failed:
                        status = "too_large"
                    else:
                        status = "locator_missing"
                    final[case] = {
                        "case": case, "status": status, "attachments": [],
                        "body_status": (
                            status if case in needs_body
                            else "not_requested" if case in empty_body_cases and not cfg["recover_empty_body"]
                            else "not_needed"
                        ),
                    }
                    active.remove(case)

    for case, row in targets.items():
        if case in final:
            continue
        status = "read_error" if scan_errors else "locator_missing"
        final[case] = {
            "case": case, "status": status, "attachments": [],
            "body_status": (
                status if case in needs_body
                else "not_requested" if case in empty_body_cases and not cfg["recover_empty_body"]
                else "not_needed"
            ),
        }

    metrics["case_count"] = len(targets)
    metrics["source_row_count"] = sum(len(row["row_ids"]) for row in targets.values())
    metrics["locator_missing_cases"] = sum(v["status"] == "locator_missing" for v in final.values())
    metrics["too_large_cases"] = sum(v["status"] == "too_large" for v in final.values())
    metrics["read_error_cases"] = sum(v["status"] == "read_error" for v in final.values())
    metrics["ok_cases"] = sum(v["status"] == "ok" for v in final.values())
    metrics["no_attachment_cases"] = sum(v["status"] == "ok" and not v["attachments"] for v in final.values())
    metrics["cases_with_attachments"] = sum(bool(v["attachments"]) for v in final.values())
    metrics["remote_elapsed_seconds"] = round(time.monotonic() - started, 3)
    return {"records": list(final.values()), "metrics": metrics}

try:
    answer = main()
except Exception:
    answer = {"fatal": "remote_runtime_error"}
payload = zlib.compress(
    json.dumps(answer, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9
)
transfer_path = Path("/tmp") / ("nava-mailbox-mime-index-" + CONFIG["transfer_token"] + ".payload")
try:
    fd = os.open(transfer_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(payload)
    uploaded = subprocess.run([
        "aws", "s3api", "put-object", "--bucket", CONFIG["transfer_bucket"],
        "--key", CONFIG["transfer_key"], "--body", str(transfer_path),
        "--region", CONFIG["transfer_region"], "--expected-bucket-owner",
        CONFIG["transfer_owner"], "--server-side-encryption", "AES256",
        "--query", "ServerSideEncryption", "--output", "text",
    ], capture_output=True, text=True, timeout=120)
    if uploaded.returncode or uploaded.stdout.strip() != "AES256":
        raise RuntimeError("private_transfer_upload_failed")
finally:
    transfer_path.unlink(missing_ok=True)
print(json.dumps({
    "key": CONFIG["transfer_key"], "bytes": len(payload),
    "sha256": hashlib.sha256(payload).hexdigest(),
    "server_side_encryption": "AES256",
}))
'''


def build_remote_source(config: dict[str, Any]) -> str:
    """Construct exactly the Python source executed by the EC2 bootstrap."""
    remote_code = REMOTE_CODE.replace("\\\\", "\\")
    prelude = "import json\nCONFIG = json.loads(" + repr(json.dumps(config, ensure_ascii=False)) + ")\n"
    return prelude + remote_code


def nested_value(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(item for item in value if isinstance(item, str))
    return ""


def unique_strings(values: list[Any]) -> tuple[list[str], int]:
    result, seen = [], set()
    duplicates = 0
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        value = value.strip()
        if value in seen:
            duplicates += 1
            continue
        seen.add(value)
        result.append(value)
    return result, duplicates


def load_packets(path: Path, current_path: str, quoted_path: str) -> tuple[list[dict[str, Any]], int]:
    packets, seen_cases, duplicate_ids = [], set(), 0
    with path.open("r", encoding="utf-8") as source:
        for line_no, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception as exc:
                raise SafeError(f"invalid_json_line_{line_no}") from exc
            if not isinstance(row, dict):
                raise SafeError(f"invalid_packet_line_{line_no}")
            case_value = row.get("case")
            if not isinstance(case_value, (str, int)) or not str(case_value).strip():
                raise SafeError(f"missing_case_line_{line_no}")
            case = str(case_value).strip()
            if case in seen_cases:
                raise SafeError(f"duplicate_case_line_{line_no}")
            seen_cases.add(case)
            source = row.get("_source")
            ids = source.get("row_ids") if isinstance(source, dict) else None
            if isinstance(ids, str):
                ids = [ids]
            if not isinstance(ids, list):
                raise SafeError(f"missing_row_ids_line_{line_no}")
            row_ids, removed = unique_strings(ids)
            duplicate_ids += removed
            if not row_ids:
                raise SafeError(f"empty_row_ids_line_{line_no}")
            current = as_text(nested_value(row, current_path))
            quoted = as_text(nested_value(row, quoted_path))
            packets.append({
                "case": case,
                "row_ids": row_ids,
                "needs_body": not current.strip() and not quoted.strip(),
            })
    if not packets:
        raise SafeError("empty_packet_input")
    return packets, duplicate_ids


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_output_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(PRIVATE_ROOT.resolve())
    except ValueError as exc:
        raise SafeError("output_must_be_under_private") from exc
    if resolved.suffix.casefold() != ".jsonl":
        raise SafeError("output_must_be_jsonl")
    return resolved


def ensure_private_parent(path: Path) -> None:
    if not path.parent.exists():
        path.parent.mkdir(parents=True, mode=0o700)
    mode = stat.S_IMODE(path.parent.stat().st_mode)
    if mode & 0o077:
        raise SafeError("output_directory_not_private")


def atomic_write_jsonl(path: Path, records: dict[str, dict[str, Any]], order: list[str]) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchmod(fd, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for case in order:
                row = records.get(case)
                if row is not None:
                    output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
        dirfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def read_existing(path: Path) -> dict[str, dict[str, Any]]:
    records = {}
    if not path.exists():
        return records
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise SafeError("existing_output_mode_not_600")
    with path.open("r", encoding="utf-8") as source:
        for line_no, line in enumerate(source, 1):
            try:
                row = json.loads(line)
            except Exception as exc:
                raise SafeError(f"invalid_existing_output_line_{line_no}") from exc
            if not isinstance(row, dict) or not isinstance(row.get("case"), str):
                raise SafeError(f"invalid_existing_output_line_{line_no}")
            if row["case"] in records or row.get("status") not in INDEX_STATUSES:
                raise SafeError(f"duplicate_or_invalid_existing_output_line_{line_no}")
            if not isinstance(row.get("attachments"), list):
                raise SafeError(f"invalid_existing_attachments_line_{line_no}")
            records[row["case"]] = row
    return records


def load_tail() -> Any:
    if not TAIL_HELPER.is_file() or not SSM_RUNNER.is_file():
        raise SafeError("approved_ssm_helper_unavailable")
    spec = importlib.util.spec_from_file_location("saved_snapshot_ssm", TAIL_HELPER)
    if spec is None or spec.loader is None:
        raise SafeError("approved_ssm_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise SafeError("approved_ssm_helper_unavailable") from exc
    return module


def invoke_remote(
    tail: Any, batch: list[dict[str, Any]], snapshots: list[str],
    remote_root: str, pm2_process: str, aws_region: str, max_object_bytes: int,
    workers: int, body_chars: int, body_recovery: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    transfer_token = uuid.uuid4().hex
    expected_key = tail.transfer_key(transfer_token)
    targets = {
        row["case"]: {"row_ids": row["row_ids"]}
        for row in batch
    }
    body_cases = [row["case"] for row in batch if row["needs_body"]]
    config = {
        "targets": targets,
        "body_cases": body_cases,
        "recover_empty_body": body_recovery,
        "snapshots": snapshots,
        "remote_corpus_root": remote_root,
        "pm2_process": pm2_process,
        "aws_region": aws_region,
        "max_object_bytes": max_object_bytes,
        "workers": workers,
        "body_chars": body_chars,
        "safe_name_words": sorted(SAFE_NAME_WORDS),
        "document_markers": sorted(DOCUMENT_NAME_MARKERS),
        "safe_extensions": sorted(SAFE_EXTENSIONS),
        "transfer_token": transfer_token,
        "transfer_key": expected_key,
        "transfer_bucket": tail.TRANSFER_BUCKET,
        "transfer_region": tail.TRANSFER_REGION,
        "transfer_owner": tail.EXPECTED_BUCKET_OWNER,
    }
    source = build_remote_source(config)
    packed = base64.b64encode(zlib.compress(source.encode("utf-8"), 9)).decode("ascii")
    bootstrap = "import base64,zlib;exec(zlib.decompress(base64.b64decode(" + repr(packed) + ")))"
    command = "python3 -B -c " + shlex.quote(bootstrap)
    if len(command.encode("utf-8")) > 24_000:
        raise SafeError("ssm_payload_too_large_reduce_batch_cases")
    tail.ensure_private_transfer_bucket()
    try:
        stdout = tail.ssm(command)
        metadata = json.loads(stdout)
        compressed = tail.fetch_payload(metadata, expected_key)
        payload = json.loads(zlib.decompress(compressed))
    except Exception as exc:
        raise SafeError("ssm_or_response_error") from exc
    finally:
        tail.delete_transfer(expected_key)
    if not isinstance(payload, dict):
        raise SafeError("invalid_remote_response")
    if payload.get("fatal"):
        raise SafeError(str(payload["fatal"]))
    rows = payload.get("records")
    metrics = payload.get("metrics")
    if not isinstance(rows, list) or not isinstance(metrics, dict):
        raise SafeError("invalid_remote_response")
    if {row.get("case") for row in rows if isinstance(row, dict)} != set(targets):
        raise SafeError("remote_case_mismatch")
    for row in rows:
        if row.get("status") not in INDEX_STATUSES or row.get("body_status") not in BODY_STATUSES:
            raise SafeError("invalid_remote_status")
        if not isinstance(row.get("attachments"), list):
            raise SafeError("invalid_remote_attachments")
        if row.get("body_status") != "ok":
            row.pop("recovered_body", None)
        elif not isinstance(row.get("recovered_body"), str):
            row["body_status"] = "withheld_sensitive"
            row.pop("recovered_body", None)
    return rows, metrics


def select_packets(
    packets: list[dict[str, Any]], sample_size: int | None, seed: int | None,
) -> tuple[list[dict[str, Any]], int | None]:
    if sample_size is None:
        return packets, seed
    if sample_size < 1:
        raise SafeError("sample_size_must_be_positive")
    if seed is None:
        seed = random.SystemRandom().randrange(0, 2**63)
    count = min(sample_size, len(packets))
    chosen = set(random.Random(seed).sample(range(len(packets)), count))
    return [row for i, row in enumerate(packets) if i in chosen], seed


def report_counts(records: dict[str, dict[str, Any]], selected: list[dict[str, Any]]) -> dict[str, Any]:
    status_counts = {status: 0 for status in sorted(INDEX_STATUSES)}
    body_counts = {status: 0 for status in sorted(BODY_STATUSES)}
    attachment_total = 0
    for row in selected:
        result = records.get(row["case"])
        if result is None:
            continue
        status_counts[result["status"]] += 1
        body_counts[result.get("body_status", "not_requested")] += 1
        attachment_total += len(result.get("attachments", []))
    return {
        "index_status_counts": status_counts,
        "body_status_counts": body_counts,
        "cases_with_attachments": sum(
            bool(records.get(row["case"], {}).get("attachments")) for row in selected
        ),
        "confirmed_no_attachment_cases": sum(
            records.get(row["case"], {}).get("status") == "ok"
            and not records.get(row["case"], {}).get("attachments") for row in selected
        ),
        "attachment_parts_indexed": attachment_total,
    }


def write_private_json(path: Path, data: dict[str, Any]) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchmod(fd, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packets", type=Path, required=True, help="standardized private JSONL packets")
    parser.add_argument("--snapshots", nargs="+", required=True, help="saved remote snapshot names, in priority order")
    parser.add_argument("--output", type=Path, required=True, help="private JSONL index output path")
    parser.add_argument("--report", type=Path, help="private aggregate benchmark report (default: OUTPUT.summary.json)")
    parser.add_argument("--current-text-path", default="inbound.message", help="dotted JSON path for cleaned current text")
    parser.add_argument("--quoted-text-path", default="inbound.quoted_context", help="dotted JSON path for cleaned quoted text")
    parser.add_argument("--remote-corpus-root", default=DEFAULT_REMOTE_CORPUS, help="saved snapshots root on approved EC2")
    parser.add_argument("--pm2-process", default="http", help="remote PM2 process holding read-only S3 configuration")
    parser.add_argument("--aws-region", default="af-south-1")
    parser.add_argument("--max-object-bytes", type=int, default=DEFAULT_MAX_OBJECT_BYTES)
    parser.add_argument("--workers", type=int, default=4, help="bounded S3 GET concurrency (1-4)")
    parser.add_argument("--batch-cases", type=int, default=50, help="cases per SSM call")
    parser.add_argument("--body-chars", type=int, default=DEFAULT_BODY_CHARS)
    parser.add_argument("--no-recover-empty-body", action="store_true")
    parser.add_argument("--sample-size", type=int, help="randomly select N input cases; omit for all")
    parser.add_argument("--seed", type=int, help="reproducible sample seed")
    parser.add_argument("--estimate-full-cases", type=int, help="optional full-run case count for linear time estimate")
    parser.add_argument("--resume", action="store_true", help="resume only when output manifest matches input/config")
    args = parser.parse_args(argv)

    os.umask(0o077)
    if not 1 <= args.max_object_bytes <= 50_000_000:
        raise SafeError("max_object_bytes_out_of_range")
    if not 1 <= args.workers <= 4:
        raise SafeError("workers_must_be_1_to_4")
    if not 1 <= args.batch_cases <= 150:
        raise SafeError("batch_cases_must_be_1_to_150")
    if not 100 <= args.body_chars <= 8_000:
        raise SafeError("body_chars_must_be_100_to_8000")
    if args.estimate_full_cases is not None and args.estimate_full_cases < 1:
        raise SafeError("estimate_full_cases_must_be_positive")
    snapshots = []
    for snapshot in args.snapshots:
        if snapshot in {".", ".."} or not SNAPSHOT_RE.fullmatch(snapshot):
            raise SafeError("invalid_snapshot_name")
        if snapshot not in snapshots:
            snapshots.append(snapshot)
    if not snapshots:
        raise SafeError("no_snapshots")

    output = safe_output_path(args.output)
    ensure_private_parent(output)
    report_path = args.report.expanduser().resolve() if args.report else output.with_suffix(output.suffix + ".summary.json")
    try:
        report_path.relative_to(PRIVATE_ROOT.resolve())
    except ValueError as exc:
        raise SafeError("report_must_be_under_private") from exc
    manifest_path = output.with_suffix(output.suffix + ".manifest.json")
    lock_path = output.with_suffix(output.suffix + ".lock")
    if report_path in {output, manifest_path, lock_path}:
        raise SafeError("report_and_output_must_differ")
    ensure_private_parent(report_path)
    if report_path.exists():
        if stat.S_IMODE(report_path.stat().st_mode) != 0o600:
            raise SafeError("existing_report_mode_not_600")
        if not args.resume:
            raise SafeError("report_exists")

    input_hash = file_sha256(args.packets)
    packets, duplicate_ids = load_packets(args.packets, args.current_text_path, args.quoted_text_path)
    if args.resume and manifest_path.exists():
        if stat.S_IMODE(manifest_path.stat().st_mode) != 0o600:
            raise SafeError("manifest_mode_not_600")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if args.seed is None and manifest.get("sample_size") == args.sample_size:
            args.seed = manifest.get("seed")
    selected, seed = select_packets(packets, args.sample_size, args.seed)
    body_recovery = not args.no_recover_empty_body
    config_manifest = {
        "schema_version": 1,
        "input_sha256": input_hash,
        "input_cases": len(packets),
        "sample_size": args.sample_size,
        "seed": seed,
        "snapshots": snapshots,
        "current_text_path": args.current_text_path,
        "quoted_text_path": args.quoted_text_path,
        "remote_corpus_root": args.remote_corpus_root,
        "pm2_process": args.pm2_process,
        "max_object_bytes": args.max_object_bytes,
        "workers": args.workers,
        "batch_cases": args.batch_cases,
        "body_chars": args.body_chars,
        "body_recovery": body_recovery,
    }
    if manifest_path.exists():
        existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not args.resume or existing_manifest != config_manifest:
            raise SafeError("output_exists_or_manifest_mismatch")
    else:
        if output.exists():
            raise SafeError("existing_output_missing_manifest")
        if args.resume:
            raise SafeError("resume_manifest_missing")
        write_private_json(manifest_path, config_manifest)
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise SafeError("output_locked") from exc
    try:
        records = read_existing(output) if output.exists() else {}
        selected_cases = {row["case"] for row in selected}
        if not set(records).issubset(selected_cases):
            raise SafeError("existing_output_case_set_mismatch")
        for case, row in records.items():
            expected_status = row.get("status")
            body_status = row.get("body_status", "not_requested")
            if expected_status == "read_error" or body_status == "read_error":
                continue
            if expected_status not in INDEX_STATUSES or body_status not in BODY_STATUSES:
                raise SafeError("invalid_resume_record")

        tail = load_tail()
        started = time.monotonic()
        metrics_total: dict[str, float | int] = {}
        pending = [
            row for row in selected
            if row["case"] not in records
            or records[row["case"]].get("status") == "read_error"
            or records[row["case"]].get("body_status") == "read_error"
        ]
        batches = [pending[i:i + args.batch_cases] for i in range(0, len(pending), args.batch_cases)]
        for batch_no, batch in enumerate(batches, 1):
            batch_started = time.monotonic()
            new_rows, batch_metrics = invoke_remote(
                tail=tail,
                batch=batch,
                snapshots=snapshots,
                remote_root=args.remote_corpus_root,
                pm2_process=args.pm2_process,
                aws_region=args.aws_region,
                max_object_bytes=args.max_object_bytes,
                workers=args.workers,
                body_chars=args.body_chars,
                body_recovery=body_recovery,
            )
            returned = {row["case"]: row for row in new_rows}
            for row in new_rows:
                if row["body_status"] == "ok":
                    row["recovered_body"] = scrub_local_body(row["recovered_body"], args.body_chars)
                    if not row["recovered_body"]:
                        row["body_status"] = "empty"
                        row.pop("recovered_body", None)
                    elif local_sensitive_residual(row["recovered_body"]):
                        row["body_status"] = "withheld_sensitive"
                        row.pop("recovered_body", None)
                row["attachments"] = [
                    {
                        "name": safe_attachment_name(item.get("name"), item.get("content_type")),
                        "content_type": safe_content_type(item.get("content_type")),
                    }
                    for item in row["attachments"]
                    if isinstance(item, dict)
                ]
            if set(returned) != {row["case"] for row in batch}:
                raise SafeError("remote_case_mismatch")
            records.update(returned)
            atomic_write_jsonl(output, records, [row["case"] for row in selected])
            for key, value in batch_metrics.items():
                if isinstance(value, (int, float)):
                    metrics_total[key] = metrics_total.get(key, 0) + value
            elapsed = time.monotonic() - batch_started
            print(json.dumps({
                "stage": "batch_complete",
                "batch": batch_no,
                "batches": len(batches),
                "cases_done": len(records),
                "cases_selected": len(selected),
                "batch_seconds": round(elapsed, 2),
                "s3_get_bytes_total": int(metrics_total.get("s3_get_bytes", 0)),
            }), flush=True)

        elapsed = time.monotonic() - started
        counts = report_counts(records, selected)
        actual_source_rows = sum(len(row["row_ids"]) for row in selected)
        full_estimate = None
        if args.estimate_full_cases:
            full_estimate = round(elapsed * args.estimate_full_cases / max(1, len(selected)), 2)
        report = {
            **config_manifest,
            "selected_cases": len(selected),
            "selected_source_row_candidates": actual_source_rows,
            "duplicate_source_row_ids_removed": duplicate_ids,
            **counts,
            "remote_metrics": metrics_total,
            "elapsed_seconds": round(elapsed, 3),
            "cases_per_second": round(len(selected) / elapsed, 4) if elapsed else None,
            "estimated_full_cases": args.estimate_full_cases,
            "estimated_full_seconds_linear": full_estimate,
            "estimate_method": "sample wall time scaled by cases; excludes cohort drift and future SSM variance",
            "max_object_bytes_stop_threshold": args.max_object_bytes,
            "safe_filename_policy": "allowlisted document tokens; unknown filename tokens redacted",
        }
        write_private_json(report_path, report)
        os.chmod(output, 0o600)
        print(json.dumps({
            "stage": "complete",
            "cases": len(selected),
            "s3_get_bytes": int(metrics_total.get("s3_get_bytes", 0)),
            "elapsed_seconds": round(elapsed, 2),
            "estimated_full_seconds_linear": full_estimate,
            "report": str(report_path),
        }), flush=True)
        return 0
    finally:
        os.close(lock_fd)


def safe_content_type(value: Any) -> str:
    text = str(value or "application/octet-stream").casefold().split(";", 1)[0].strip()
    if not re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", text):
        return "application/octet-stream"
    return text[:120]


def safe_attachment_name(value: Any, mime_type: Any) -> str:
    raw = str(value or "")
    raw = raw.replace("\\", "/").rsplit("/", 1)[-1]
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode().casefold()
    match = re.search(r"\.([a-z0-9]{1,8})$", folded)
    ext = match.group(1) if match and match.group(1) in SAFE_EXTENSIONS else ""
    stem = folded[:-(len(ext) + 1)] if ext else folded
    words = re.findall(r"[a-z0-9]+", stem)
    kept = [word for word in words if word in SAFE_NAME_WORDS]
    unknown = any(word not in SAFE_NAME_WORDS for word in words)
    if not kept:
        kept = ["document" if not raw else "redacted"]
    if unknown and kept != ["redacted"]:
        kept.append("redacted")
    if not ext:
        ext = {
            "application/pdf": "pdf",
            "application/msword": "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "application/vnd.ms-excel": "xls",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
            "text/plain": "txt",
            "text/csv": "csv",
            "image/png": "png",
            "image/jpeg": "jpg",
        }.get(safe_content_type(mime_type), "")
    return "_".join(kept[:12])[:96] + (("." + ext) if ext else "")


def scrub_local_body(value: str, max_chars: int) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"(?i)https?://\S+|\bwww\.\S+", "[link]", text)
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[email]", text, flags=re.I)
    text = re.sub(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", "[number removed]", text)
    text = re.sub(r"(?i)\b(?:authorization|authorisation|auth|verification|security)\s+code"
                  r"\s*(?:is|:|=|-)?\s*[A-Z0-9][A-Z0-9-]{3,24}\b", "[code removed]", text)
    text = re.sub(r"(?i)\b(?:card\s*(?:number|no\.?|expiry|expiration)|cvv|cvc|account\s*(?:number|no\.?)|"
                  r"iban|password|passcode|pin|otp|verification code|security code)\b"
                  r"\s*(?:is|:|=|-)?\s*[^\s,;]{3,32}", "[sensitive detail removed]", text)
    text = re.sub(r"(?im)^(\s*(?:dear|hi|hello)\s+)[^,\n]{1,70}([,!:])", r"\1[redacted]\2", text)
    text = re.sub(r"(?im)^(\s*(?:guest(?: name)?|lead guest|travell?er|contact|client|name)\s*[:=-]\s*).+$",
                  r"\1[redacted]", text)
    text = re.sub(r"(?im)^\s*(?:--|kind regards|best regards|regards|warm regards|yours sincerely|sincerely)\s*,?\s*$[\s\S]*",
                  "", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:max_chars]


def local_sensitive_residual(text: str) -> bool:
    if re.search(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", text):
        return True
    if re.search(r"(?i)\b(?:card\s*(?:number|no\.?)|cvv|cvc|authorization code|authorisation code|"
                 r"otp|verification code|security code|password|passcode)\s*(?:is|:|=|-)\s*\S+", text):
        return True
    return False


def safe_main() -> int:
    try:
        return main()
    except SafeError as exc:
        print(json.dumps({"error": exc.code}), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"error": "interrupted; completed checkpoint remains"}), file=sys.stderr)
        return 130
    except Exception:
        print(json.dumps({"error": "unexpected_error"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(safe_main())
