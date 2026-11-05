#!/usr/bin/env python3
"""Select the Centurion 250 pilot into a private, aggregate-only workflow.

The manifest contains private row/thread links by design. Standard output never
contains mail, row IDs, thread IDs, or cue text. Use --self-test for synthetic
checks; it does not access the repository's .private directory.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import email.utils
import gzip
import hashlib
import html
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Sequence


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[4]
PRIVATE_ROOT = REPOSITORY_ROOT / ".private"
CENTURION_TRANSPORT = "transport-centurion"
EXPECTED_SOURCE_SHA256 = "ec9d30c47e2ef0a3dd61ae6db795e1f730feb5e853b9cf76025f523d7a4e6625"
SEED = "centurion-pilot-250-v1-20261101"
DATE_START = dt.date(2026, 7, 27)
DATE_END = dt.date(2026, 10, 29)
RANDOM_SIZE = 150
HOLDOUT_SIZE = 50
TARGET_SIZE = 100
TARGET_QUOTA = 20
TARGET_ORDER = (
    "ota_system",
    "proof_of_payment",
    "voucher",
    "group_rooming",
    "mixed_action",
)
SAMPLER_VERSION = "centurion-pilot-250-select-v2"
CUE_VERSION = "centurion-pilot-cues-v2-20261101"

# Frozen from the checked-in source registry on 2026-11-01. Host matches allow
# the exact domain or a dot-delimited subdomain; these are candidate cues only.
CHANNEL_DOMAINS = (
    "synxis.com",
    "expediapartnercentral.com",
    "expedia.com",
    "webbeds.com",
    "hotelbeds.com",
    "booking.com",
    "get-e.com",
    "hotels.com",
    "agoda.com",
    "trip.com",
    "traveloka.com",
    "airbnb.com",
    "tiket.com",
    "profitroom.com",
)
SYSTEM_DOMAINS = (
    "hospitality.cloud",
    "reviewpro.com",
    "trustyou.com",
    "revinate.com",
    "medallia.com",
    "tripadvisor.com",
)

POP_SOURCE = (
    r"\b(?:proof\s+of\s+payment|payment\s+proof|proof\s+of\s+transfer|"
    r"receipt\s+of\s+payment|payment\s+receipt|remittance(?:\s+advice)?|"
    r"e\.?f\.?t\.?|pop)\b"
)
VOUCHER_SOURCE = r"\bvouchers?\b"
VOUCHER_CONTEXT_SOURCE = r"\b(?:(?:booking|payment)\s+)?vouchers?\b"
GROUP_SOURCE = r"\b(?:groups?|rooming\s+list|conferences?|delegates?|events?)\b"
ROOMS_BEFORE_SOURCE = r"\b(\d+)\s*[-–]?\s*(?:x\s*)?rooms?\b"
ROOMS_AFTER_SOURCE = r"\brooms?\s*(?:x|:|=)?\s*(\d+)\b"
INTEGRATION_FAILURE_SOURCE = (
    r"\b(?:(?:reservation|booking)\s+)?failed\s+to\s+integrate\b|"
    r"\bintegration\s+(?:has\s+)?failed\b"
)
NO_REPLY_SOURCE = r"no[-_.]?reply"
MIX_POP_REMOVE_SOURCE = (
    r"\b(?:proof\s+of\s+payment|payment\s+proof|proof\s+of\s+transfer|"
    r"receipt\s+of\s+payment|payment\s+receipt|remittance(?:\s+advice)?|"
    r"e\.?f\.?t\.?|pop)\b"
)
MIX_VOUCHER_REMOVE_SOURCE = VOUCHER_CONTEXT_SOURCE
MIX_BOOKING_REFERENCE_REMOVE_SOURCE = r"\b(?:booking|reservation)\s+ref(?:erence)?\.?\b"
MIX_FAMILY_SOURCES = {
    "quote": r"\b(?:quotes?|quotation|quoting|quoted|tariffs?|rates?|pricing|prices?|availability)\b",
    "booking": r"\b(?:book(?:ing|ed|ings)?|reservations?|reserve|proceed)\b",
    "amend": (
        r"\b(?:amend(?:ment|ed|ing|ments)?|modif(?:y|ied|ication)|change(?:d|s)?|"
        r"extend(?:ed|ing|s|sion)?|shorten(?:ed|ing)?|upgrade(?:d|s)?|"
        r"reschedul(?:e|ed|ing))\b"
    ),
    "cancel": r"\b(?:cancel(?:l?ation|l?ed|l?ing|s)?|withdraw(?:al|n)?)\b",
    "billing_payment": r"\b(?:invoices?|billing|folios?|payments?|paid|deposits?|refunds?|remittance|eft)\b",
    "document": r"\b(?:documents?|attachments?|attached|files?|upload|rooming\s+list|guest\s+list|id\s+copy)\b",
}

POP_RE = re.compile(POP_SOURCE, re.IGNORECASE)
VOUCHER_RE = re.compile(VOUCHER_SOURCE, re.IGNORECASE)
GROUP_RE = re.compile(GROUP_SOURCE, re.IGNORECASE)
ROOMS_BEFORE_RE = re.compile(ROOMS_BEFORE_SOURCE, re.IGNORECASE)
ROOMS_AFTER_RE = re.compile(ROOMS_AFTER_SOURCE, re.IGNORECASE)
INTEGRATION_FAILURE_RE = re.compile(INTEGRATION_FAILURE_SOURCE, re.IGNORECASE)
NO_REPLY_RE = re.compile(NO_REPLY_SOURCE, re.IGNORECASE)
MIX_POP_REMOVE_RE = re.compile(MIX_POP_REMOVE_SOURCE, re.IGNORECASE)
MIX_VOUCHER_REMOVE_RE = re.compile(MIX_VOUCHER_REMOVE_SOURCE, re.IGNORECASE)
MIX_BOOKING_REFERENCE_REMOVE_RE = re.compile(
    MIX_BOOKING_REFERENCE_REMOVE_SOURCE, re.IGNORECASE
)
MIX_FAMILY_RES = {
    family: re.compile(source, re.IGNORECASE)
    for family, source in MIX_FAMILY_SOURCES.items()
}
HTML_TAG_RE = re.compile(r"<[^>]+>")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
TRANSPORT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$", re.IGNORECASE)


class PilotError(Exception):
    """Safe-to-report error code; never include source text or row identifiers."""


@dataclass
class FrameRow:
    source_row_id: str
    thread_id: str
    source_line: int
    message_index: int
    timestamp: str
    received_at_key: str | None
    subject_key: str | None
    sender_key: str | None
    message_id_key: str | None
    exact_content_key: str | None
    content_fingerprint: str | None
    cue_flags: set[str] = field(default_factory=set)
    cue_evaluated: bool = False
    cohort: str = ""
    embargoed: bool = False
    stratum: str = ""
    selection_stage: str = ""
    backfill_from: str | None = None
    random_rank: str = ""
    holdout_rank: str = ""


def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _rank(source_row_id: str, domain: str) -> str:
    material = f"{SEED}\0{domain}\0{source_row_id}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _ranked(rows: Iterable[FrameRow], domain: str) -> list[FrameRow]:
    ranked = list(rows)
    for row in ranked:
        if domain == "random":
            row.random_rank = _rank(row.source_row_id, domain)
        elif domain == "holdout":
            row.holdout_rank = _rank(row.source_row_id, domain)
    return sorted(
        ranked,
        key=lambda row: (
            _rank(row.source_row_id, domain),
            row.timestamp,
            row.source_row_id,
        ),
    )


def _normal_text(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFC", text).strip()


def _subject_key(value: Any) -> str | None:
    normalized = " ".join(_normal_text(value).casefold().split())
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _exact_content_key(subject: Any, body: Any) -> str | None:
    normalized_subject = _normal_text(subject)
    normalized_body = _normal_text(body)
    if not normalized_subject and not normalized_body:
        return None
    payload = json.dumps(
        [normalized_subject, normalized_body],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _address_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_values = [value]
    elif isinstance(value, Mapping):
        candidate = value.get("email") or value.get("address")
        raw_values = [str(candidate)] if candidate else []
    elif isinstance(value, (list, tuple)):
        raw_values = []
        for item in value:
            if isinstance(item, str):
                raw_values.append(item)
            elif isinstance(item, Mapping):
                candidate = item.get("email") or item.get("address")
                if candidate:
                    raw_values.append(str(candidate))
    else:
        raw_values = []
    parsed = email.utils.getaddresses(raw_values)
    return sorted({address.strip().casefold() for _, address in parsed if address.strip()})


def _sender_key(value: Any) -> str | None:
    addresses = _address_strings(value)
    if len(addresses) != 1:
        return None
    return hashlib.sha256(addresses[0].encode("utf-8")).hexdigest()


def _sender_hints(value: Any) -> tuple[set[str], bool]:
    hosts: set[str] = set()
    no_reply = False
    for address in _address_strings(value):
        local, separator, host = address.rpartition("@")
        if not separator:
            continue
        host = host.rstrip(".").casefold()
        if host:
            hosts.add(host)
        if NO_REPLY_RE.search(local):
            no_reply = True
    return hosts, no_reply


def _domain_match(host: str, domains: Sequence[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def _plain_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    return HTML_TAG_RE.sub(" ", text)


def _room_count_at_least_ten(text: str) -> bool:
    for pattern in (ROOMS_BEFORE_RE, ROOMS_AFTER_RE):
        for match in pattern.finditer(text):
            try:
                if int(match.group(1)) >= 10:
                    return True
            except (TypeError, ValueError):
                continue
    return False


def _mixed_action_candidate(text: str) -> bool:
    has_pop = bool(POP_RE.search(text))
    has_voucher = bool(VOUCHER_RE.search(text))
    mixed_text = MIX_POP_REMOVE_RE.sub(" ", text)
    mixed_text = MIX_VOUCHER_REMOVE_RE.sub(" ", mixed_text)
    # A booking reference identifies a stay; it is not itself a booking action.
    mixed_text = MIX_BOOKING_REFERENCE_REMOVE_RE.sub(" ", mixed_text)
    families = {
        family
        for family, pattern in MIX_FAMILY_RES.items()
        if family != "document" and pattern.search(mixed_text)
    }
    if has_pop or has_voucher or MIX_FAMILY_RES["document"].search(mixed_text):
        families.add("document")
    # A POP/voucher filing subtask alone is one document family, not mixed work.
    return len(families) >= 2


def _current_cues(subject: Any, body: Any, from_addresses: Any) -> set[str]:
    subject_text = _plain_text(subject)
    body_text = _plain_text(body)
    text = subject_text + "\n" + body_text
    flags: set[str] = set()

    hosts, no_reply = _sender_hints(from_addresses)
    if any(_domain_match(host, CHANNEL_DOMAINS) for host in hosts):
        flags.add("ota_channel_host")
    if any(_domain_match(host, SYSTEM_DOMAINS) for host in hosts):
        flags.add("system_host")
    if no_reply:
        flags.add("no_reply_sender")
    if INTEGRATION_FAILURE_RE.search(subject_text):
        flags.add("integration_failure_subject")
    if POP_RE.search(text):
        flags.add("proof_of_payment_text")
    if VOUCHER_RE.search(text):
        flags.add("voucher_text")
    if GROUP_RE.search(text):
        flags.add("group_rooming_text")
    if _room_count_at_least_ten(text):
        flags.add("explicit_rooms_ge_10_text")
    if _mixed_action_candidate(text):
        flags.add("mixed_action_candidate")
    return flags


def _attachment_cues(filename: Any, extracted_text: Any) -> set[str]:
    text = _plain_text(filename) + "\n" + _plain_text(extracted_text)
    flags: set[str] = set()
    if POP_RE.search(text):
        flags.add("proof_of_payment_older_attachment")
    if VOUCHER_RE.search(text):
        flags.add("voucher_older_attachment")
    if GROUP_RE.search(text):
        flags.add("group_rooming_older_attachment")
    if _room_count_at_least_ten(text):
        flags.add("explicit_rooms_ge_10_older_attachment")
    return flags


def _categories(flags: set[str]) -> set[str]:
    categories: set[str] = set()
    if {
        "ota_channel_host",
        "system_host",
        "no_reply_sender",
        "integration_failure_subject",
    } & flags:
        categories.add("ota_system")
    if {"proof_of_payment_text", "proof_of_payment_older_attachment"} & flags:
        categories.add("proof_of_payment")
    if {"voucher_text", "voucher_older_attachment"} & flags:
        categories.add("voucher")
    if {
        "group_rooming_text",
        "explicit_rooms_ge_10_text",
        "group_rooming_older_attachment",
        "explicit_rooms_ge_10_older_attachment",
    } & flags:
        categories.add("group_rooming")
    if "mixed_action_candidate" in flags:
        categories.add("mixed_action")
    return categories


def _date_prefix(value: Any) -> dt.date:
    if not isinstance(value, str) or len(value) < 10:
        raise PilotError("source_timestamp_invalid")
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError as exc:
        raise PilotError("source_timestamp_invalid") from exc


def _time_key(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return "naive:" + parsed.isoformat(timespec="microseconds")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="microseconds")


def _message_id_value(message: Mapping[str, Any], source_row: Mapping[str, Any],
                      private: Mapping[str, Any]) -> str | None:
    def single_header_value(value: Any) -> str | None:
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, (list, tuple)):
            present = [item for item in value if isinstance(item, str) and item.strip()]
            if len(present) == 1:
                return present[0]
        return None

    for value in (
        source_row.get("messageId"),
        message.get("messageId"),
        private.get("canonicalHeaders", {}).get("Message-ID")
        if isinstance(private.get("canonicalHeaders"), Mapping)
        else None,
    ):
        found = single_header_value(value)
        if found:
            return found
    headers = private.get("canonicalHeaders")
    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if str(key).casefold() == "message-id":
                found = single_header_value(value)
                if found:
                    return found
    return None


def _message_id_key(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().strip("<> ").casefold()


def _iter_scoped_rows(path: pathlib.Path) -> Iterator[tuple[int, int, str, Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PilotError("source_jsonl_invalid") from exc
            if not isinstance(record, Mapping) or record.get("recordType") != "thread":
                continue
            messages = record.get("messages")
            if not isinstance(messages, list):
                raise PilotError("source_thread_schema_invalid")
            record_thread = record.get("threadId")
            for message_index, message in enumerate(messages):
                if not isinstance(message, Mapping):
                    raise PilotError("source_message_schema_invalid")
                source_rows = message.get("sourceRows")
                if not isinstance(source_rows, list):
                    raise PilotError("source_rows_schema_invalid")
                scoped: list[Mapping[str, Any]] = []
                for source_row in source_rows:
                    if not isinstance(source_row, Mapping):
                        raise PilotError("source_row_schema_invalid")
                    membership = source_row.get("scopeMembership")
                    private = source_row.get("privateMessage")
                    metadata = private.get("sourceMetadata") if isinstance(private, Mapping) else None
                    transport_id = metadata.get("transportId") if isinstance(metadata, Mapping) else None
                    if (
                        isinstance(membership, list)
                        and "active_transport" in membership
                        and transport_id == CENTURION_TRANSPORT
                    ):
                        scoped.append(source_row)
                if not scoped:
                    continue
                if len(scoped) != len(source_rows):
                    raise PilotError("mixed_scope_message_requires_review")
                if len(scoped) != 1:
                    raise PilotError("multiple_scoped_source_rows_require_review")
                source_row = scoped[0]
                private = source_row.get("privateMessage")
                if not isinstance(private, Mapping):
                    raise PilotError("source_private_message_schema_invalid")
                row_thread = source_row.get("threadId")
                thread_id = record_thread or row_thread
                if not isinstance(thread_id, str) or not thread_id:
                    raise PilotError("source_thread_id_missing")
                if row_thread and row_thread != thread_id:
                    raise PilotError("source_thread_id_conflict")
                yield line_number, message_index, thread_id, message, source_row, private


def _scan_frame(path: pathlib.Path) -> tuple[list[FrameRow], dict[str, Any]]:
    rows: list[FrameRow] = []
    seen: set[str] = set()
    stats: collections.Counter[str] = collections.Counter()
    for line_number, message_index, thread_id, message, source_row, private in _iter_scoped_rows(path):
        timestamp = message.get("timestamp")
        day = _date_prefix(timestamp)
        if day < DATE_START or day > DATE_END:
            stats["outside_date_window"] += 1
            continue
        direction = private.get("direction")
        if direction not in ("inbound", "outbound"):
            raise PilotError("source_direction_invalid")
        stats[f"scoped_{direction}"] += 1
        if direction != "inbound":
            continue
        source_row_id = source_row.get("sourceRowId")
        if not isinstance(source_row_id, str) or not source_row_id:
            raise PilotError("source_row_id_missing")
        if source_row_id in seen:
            raise PilotError("source_row_id_duplicate")
        seen.add(source_row_id)
        if not isinstance(timestamp, str):
            raise PilotError("source_timestamp_invalid")
        subject = private.get("subject") or ""
        body = source_row.get("body") or ""
        if not isinstance(subject, str) or not isinstance(body, str):
            raise PilotError("source_text_schema_invalid")
        addresses = private.get("addresses")
        from_addresses = addresses.get("from") if isinstance(addresses, Mapping) else None
        received_at = source_row.get("receivedAt")
        message_id = _message_id_value(message, source_row, private)
        fingerprint = source_row.get("contentFingerprint")
        rows.append(
            FrameRow(
                source_row_id=source_row_id,
                thread_id=thread_id,
                source_line=line_number,
                message_index=message_index,
                timestamp=timestamp,
                received_at_key=_time_key(received_at),
                subject_key=_subject_key(subject),
                sender_key=_sender_key(from_addresses),
                message_id_key=_message_id_key(message_id),
                exact_content_key=_exact_content_key(subject, body),
                content_fingerprint=(
                    fingerprint.strip().casefold()
                    if isinstance(fingerprint, str) and fingerprint.strip()
                    else None
                ),
            )
        )
    stats["eligible_inbound_source_rows"] = len(rows)
    stats["distinct_threads"] = len({row.thread_id for row in rows})
    return rows, dict(stats)


def _holdout_links(
    frame: Sequence[FrameRow],
    holdout_rows: Sequence[FrameRow],
) -> tuple[set[str], dict[str, set[str]], set[str]]:
    holdout_threads = {row.thread_id for row in holdout_rows}
    message_ids = {row.message_id_key for row in holdout_rows if row.message_id_key}
    exact_content = {row.exact_content_key for row in holdout_rows if row.exact_content_key}
    fingerprints = {
        row.content_fingerprint for row in holdout_rows if row.content_fingerprint
    }
    linked: set[str] = set()
    reasons: dict[str, set[str]] = {}
    for row in frame:
        found: set[str] = set()
        if row.thread_id in holdout_threads:
            found.add("same_thread")
        if row.message_id_key and row.message_id_key in message_ids:
            found.add("message_id_candidate")
        if row.exact_content_key and row.exact_content_key in exact_content:
            found.add("exact_subject_body")
        if row.content_fingerprint and row.content_fingerprint in fingerprints:
            found.add("content_fingerprint")
        if found:
            linked.add(row.source_row_id)
            reasons[row.source_row_id] = found
    return linked, reasons, holdout_threads


def _scan_current_cues(
    path: pathlib.Path,
    by_id: Mapping[str, FrameRow],
    excluded_ids: set[str],
) -> set[str]:
    evaluated: set[str] = set()
    for line_number, message_index, thread_id, _, source_row, private in _iter_scoped_rows(path):
        source_row_id = source_row.get("sourceRowId")
        if not isinstance(source_row_id, str):
            continue
        candidate = by_id.get(source_row_id)
        if candidate is None or source_row_id in excluded_ids:
            continue
        if (
            candidate.source_line != line_number
            or candidate.message_index != message_index
            or candidate.thread_id != thread_id
        ):
            raise PilotError("source_row_mapping_ambiguous")
        subject = private.get("subject") or ""
        body = source_row.get("body") or ""
        if not isinstance(subject, str) or not isinstance(body, str):
            raise PilotError("source_text_schema_invalid")
        addresses = private.get("addresses")
        from_addresses = addresses.get("from") if isinstance(addresses, Mapping) else None
        candidate.cue_flags.update(_current_cues(subject, body, from_addresses))
        candidate.cue_evaluated = True
        evaluated.add(source_row_id)
    expected = set(by_id) - excluded_ids
    if evaluated != expected:
        raise PilotError("source_changed_during_selection")
    return evaluated


def _safe_manifest_cues() -> dict[str, Any]:
    return {
        "version": CUE_VERSION,
        "ordered_strata": list(TARGET_ORDER),
        "quota_per_stratum": TARGET_QUOTA,
        "channel_domains": list(CHANNEL_DOMAINS),
        "system_domains": list(SYSTEM_DOMAINS),
        "host_match": "exact domain or dot-delimited subdomain",
        "no_reply_local_pattern": NO_REPLY_SOURCE,
        "integration_failure_subject_pattern": INTEGRATION_FAILURE_SOURCE,
        "proof_of_payment_pattern": POP_SOURCE,
        "voucher_pattern": VOUCHER_SOURCE,
        "group_rooming_pattern": GROUP_SOURCE,
        "explicit_rooms_ge_10_patterns": [ROOMS_BEFORE_SOURCE, ROOMS_AFTER_SOURCE],
        "mixed_action_family_patterns": dict(MIX_FAMILY_SOURCES),
        "mixed_pop_voucher_exclusion_patterns": [
            MIX_POP_REMOVE_SOURCE,
            MIX_VOUCHER_REMOVE_SOURCE,
        ],
        "mixed_booking_reference_exclusion_pattern": MIX_BOOKING_REFERENCE_REMOVE_SOURCE,
        "mixed_rule": (
            "At least two independent families in selected subject/body; POP or voucher "
            "filing alone contributes one document family, not mixed work. A booking or "
            "reservation reference is not a booking action."
        ),
        "older_attachment_rule": (
            "Use only filename/extracted text from an exact, metadata-consistent inbound "
            "parent-message match; never use later thread content or attachment bytes."
        ),
        "older_attachment_observation_limit": (
            "Attachment creation/availability time is absent or unverified in the older "
            "export. Linked filenames/extracted text are later-observed candidate-selection "
            "evidence only and do not prove availability at the inbound decision time."
        ),
        "older_attachment_created_at_available": False,
        "candidate_only": True,
    }


def _strip_jsonl_suffix(name: str) -> str | None:
    for suffix in (".jsonl.gz", ".jsonl"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return None


def _filename_transport(path: pathlib.Path, kind: str) -> str | None:
    stem = _strip_jsonl_suffix(path.name)
    if stem is None:
        return None
    prefixes = ("threads-",) if kind == "threads" else ("selections-", "sel-")
    for prefix in prefixes:
        if stem.startswith(prefix):
            transport = stem[len(prefix):]
            return transport if TRANSPORT_RE.fullmatch(transport) else None
    return None


def _old_record_transport(record: Mapping[str, Any], path_transport: str | None) -> tuple[str | None, str]:
    explicit = record.get("transport_id")
    if explicit is None:
        explicit = record.get("transportId")
    if explicit is not None:
        return (str(explicit), "record")
    if path_transport is not None:
        return (path_transport, "canonical_filename")
    return (None, "unknown")


def _old_parent_id(record: Mapping[str, Any], kind: str) -> Any:
    return record.get("id") if kind == "threads" else record.get("messageId")


def _old_thread_id(record: Mapping[str, Any], kind: str) -> Any:
    return record.get("thread_id") if kind == "threads" else record.get("threadId")


def _old_sender(record: Mapping[str, Any], kind: str) -> Any:
    return record.get("from_address") if kind == "threads" else record.get("fromAddress")


def _old_subject(record: Mapping[str, Any]) -> Any:
    return record.get("subject")


def _old_received_at(record: Mapping[str, Any], kind: str) -> Any:
    return record.get("received_at") if kind == "threads" else record.get("receivedAt")


def _old_message_id(record: Mapping[str, Any], kind: str) -> Any:
    if kind == "threads":
        return record.get("message_id_header")
    return record.get("messageIdHeader") or record.get("message_id_header")


def _consistent_old_parent(
    record: Mapping[str, Any],
    kind: str,
    candidate: FrameRow,
    transport: str | None,
) -> bool:
    if transport != CENTURION_TRANSPORT:
        return False
    if str(_old_parent_id(record, kind) or "") != candidate.source_row_id:
        return False
    if str(_old_thread_id(record, kind) or "") != candidate.thread_id:
        return False
    direction = record.get("direction")
    if direction is not None and direction != "inbound":
        return False
    old_subject_key = _subject_key(_old_subject(record))
    old_sender_key = _sender_key(_old_sender(record, kind))
    old_time_key = _time_key(_old_received_at(record, kind))
    if (
        not candidate.subject_key
        or old_subject_key != candidate.subject_key
        or not candidate.sender_key
        or old_sender_key != candidate.sender_key
        or not candidate.received_at_key
        or old_time_key != candidate.received_at_key
    ):
        return False
    old_message_id_key = _message_id_key(_old_message_id(record, kind))
    if (
        candidate.message_id_key
        and old_message_id_key
        and candidate.message_id_key != old_message_id_key
    ):
        return False
    return True


def _older_attachment_items(record: Mapping[str, Any]) -> list[Mapping[str, Any]] | None:
    attachments = record.get("attachments")
    if not isinstance(attachments, list):
        return None
    if any(not isinstance(item, Mapping) for item in attachments):
        return None
    return attachments


def _iter_older_records(path: pathlib.Path) -> Iterator[Mapping[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as stream:
        for raw in stream:
            if not raw.strip():
                continue
            try:
                value = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PilotError("older_export_jsonl_invalid") from exc
            if not isinstance(value, Mapping):
                raise PilotError("older_export_schema_unsupported")
            yield value


def _apply_older_attachment_cues(
    path: pathlib.Path | None,
    kind: str,
    by_id: Mapping[str, FrameRow],
    excluded_ids: set[str],
    holdout_threads: set[str],
) -> dict[str, Any]:
    if path is None:
        return {
            "status": "not_supplied",
            "sha256": None,
            "records_seen": 0,
            "consistent_parent_records": 0,
            "parent_records_with_cues": 0,
            "rejected_metadata_records": 0,
            "rejected_transport_records": 0,
            "cue_flags_added": 0,
            "transport_basis": "none",
        }

    before_hash = _sha256_file(path)
    path_transport = _filename_transport(path, kind)
    updates: dict[str, set[str]] = collections.defaultdict(set)
    records_seen = 0
    consistent = 0
    with_cues = 0
    rejected_metadata = 0
    rejected_transport = 0
    missing_transport = 0
    schema_unsupported = False
    transport_bases: set[str] = set()

    try:
        for record in _iter_older_records(path):
            records_seen += 1
            parent_value = _old_parent_id(record, kind)
            if parent_value is None:
                # Missing/error selection results carry no attachment evidence.
                if kind == "selections" and (record.get("missing") or record.get("error")):
                    continue
                schema_unsupported = True
                continue
            parent_id = str(parent_value)
            candidate = by_id.get(parent_id)
            old_thread_value = _old_thread_id(record, kind)
            old_thread_id = str(old_thread_value) if old_thread_value else ""

            # These exclusions run before attachment fields/text are inspected.
            if (
                candidate is None
                or parent_id in excluded_ids
                or old_thread_id in holdout_threads
                or candidate.thread_id in holdout_threads
            ):
                continue

            transport, transport_basis = _old_record_transport(record, path_transport)
            if transport is None:
                missing_transport += 1
                continue
            transport_bases.add(transport_basis)
            if transport != CENTURION_TRANSPORT:
                rejected_transport += 1
                continue

            attachments = _older_attachment_items(record)
            if attachments is None:
                schema_unsupported = True
                continue
            if not _consistent_old_parent(record, kind, candidate, transport):
                rejected_metadata += 1
                continue

            consistent += 1
            flags: set[str] = set()
            for attachment in attachments:
                flags.update(
                    _attachment_cues(
                        attachment.get("filename"),
                        attachment.get("text"),
                    )
                )
            if flags:
                updates[parent_id].update(flags)
                with_cues += 1
    except PilotError:
        schema_unsupported = True

    after_hash = _sha256_file(path)
    if after_hash != before_hash:
        raise PilotError("older_export_changed_during_selection")

    # A partly understood export is not a safe cue source. Discard every cue
    # from it; the mail-only sampler continues and records the limitation.
    if schema_unsupported:
        updates.clear()
    for source_row_id, flags in updates.items():
        by_id[source_row_id].cue_flags.update(flags)

    if schema_unsupported:
        status = "unsupported_schema"
    elif missing_transport and not path_transport:
        status = "unsupported_transport_provenance"
    elif updates:
        status = "used"
    elif consistent:
        status = "matched_no_target_cue"
    elif records_seen == 0:
        status = "empty"
    else:
        status = "no_consistent_parent_matches"
    return {
        "status": status,
        "sha256": after_hash,
        "records_seen": records_seen,
        "consistent_parent_records": consistent,
        "parent_records_with_cues": len(updates),
        "rejected_metadata_records": rejected_metadata,
        "rejected_transport_records": rejected_transport,
        "missing_transport_records": missing_transport,
        "cue_flags_added": sum(len(flags) for flags in updates.values()),
        "transport_basis": (
            next(iter(transport_bases))
            if len(transport_bases) == 1
            else "mixed" if transport_bases else "none"
        ),
    }


def _validate_private_root(root: pathlib.Path) -> pathlib.Path:
    try:
        if root.is_symlink():
            raise PilotError("private_root_symlink")
        resolved = root.resolve(strict=True)
        info = resolved.stat()
        mode = stat.S_IMODE(info.st_mode)
    except OSError as exc:
        raise PilotError("private_root_unavailable") from exc
    # The repository's .private anchor is shared with the owner's group (0770).
    # Individual corpus and run directories below it must remain owner-only.
    if not resolved.is_dir() or info.st_uid != os.getuid() or mode & 0o007:
        raise PilotError("private_root_permissions_invalid")
    return resolved


def _validate_private_source(path: pathlib.Path, root: pathlib.Path) -> pathlib.Path:
    try:
        if path.is_symlink():
            raise PilotError("source_symlink")
        resolved = path.resolve(strict=True)
        info = resolved.stat()
        mode = stat.S_IMODE(info.st_mode)
    except OSError as exc:
        raise PilotError("source_unavailable") from exc
    if (not resolved.is_file() or not resolved.is_relative_to(root)
            or info.st_uid != os.getuid() or mode & 0o077):
        raise PilotError("source_permissions_or_location_invalid")
    parent = resolved.parent
    while parent != root:
        info = parent.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PilotError("source_parent_not_owner_only")
        parent = parent.parent
    return resolved


def _validate_private_older_input(path: pathlib.Path, root: pathlib.Path) -> pathlib.Path:
    try:
        resolved = path.resolve(strict=True)
        file_info = resolved.stat()
        parent_info = resolved.parent.stat()
        file_mode = stat.S_IMODE(file_info.st_mode)
        parent_mode = stat.S_IMODE(parent_info.st_mode)
    except OSError as exc:
        raise PilotError("older_export_unavailable") from exc
    if (
        not resolved.is_file()
        or file_info.st_uid != os.getuid()
        or parent_info.st_uid != os.getuid()
        or file_mode & 0o077
        or (resolved.parent != root and parent_mode & 0o077)
    ):
        raise PilotError("older_export_permissions_invalid")
    return resolved


def _validate_new_output(path: pathlib.Path, root: pathlib.Path) -> pathlib.Path:
    try:
        parent = path.parent.resolve(strict=True)
    except OSError as exc:
        raise PilotError("output_parent_invalid") from exc
    if parent != root or path.name in ("", ".", "..") or path.exists() or path.is_symlink():
        raise PilotError("output_must_be_new_private_child")
    return parent / path.name


def _safe_write_manifest(path: pathlib.Path, manifest: Mapping[str, Any]) -> None:
    encoded = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise


def _row_manifest(
    row: FrameRow,
    case_id: str,
    candidate_link_reasons: Iterable[str] = (),
) -> dict[str, Any]:
    result = {
        "case_id": case_id,
        "source_row_id": row.source_row_id,
        "thread_id": row.thread_id,
        "source_line": row.source_line,
        "message_index": row.message_index,
        "timestamp": row.timestamp,
        "cohort": row.cohort,
        "embargoed": row.embargoed,
        "stratum": row.stratum,
        "cue_flags": sorted(row.cue_flags) if not row.embargoed else [],
        "selection_stage": row.selection_stage,
    }
    if row.backfill_from:
        result["backfill_from"] = row.backfill_from
    if row.cohort == "random_development" and row.embargoed:
        result["candidate_link_reasons"] = sorted(candidate_link_reasons)
    return result


def _source_cue_manifest() -> dict[str, Any]:
    return {
        "date_start_inclusive": DATE_START.isoformat(),
        "date_end_inclusive": DATE_END.isoformat(),
        "date_basis": "messages[].timestamp stored date prefix; timezone basis unverified",
        "direction": "inbound",
        "scope_membership": "active_transport",
        "transport_id": CENTURION_TRANSPORT,
        "sampling_unit": "source row",
        "row_rank_formula": "SHA-256(UTF-8(seed + NUL + domain + NUL + source_row_id))",
        "tie_break": ["timestamp", "source_row_id"],
        "holdout_split": (
            "Rank the 150 random rows with domain holdout; first 50 are sealed."
        ),
        "holdout_link_rules": [
            "same thread_id",
            "matching normalized nonempty source Message-ID candidate",
            "exact subject+body SHA-256 after NFC/newline normalization and outer trim",
            "matching nonempty source contentFingerprint",
        ],
        "candidate_link_is_not_duplicate_proof": True,
        "cue_rules": _safe_manifest_cues(),
    }


def run_selector(
    source_path: pathlib.Path,
    output_dir: pathlib.Path,
    *,
    private_root: pathlib.Path = PRIVATE_ROOT,
    triage_threads_path: pathlib.Path | None = None,
    triage_selections_path: pathlib.Path | None = None,
    expected_source_sha256: str = EXPECTED_SOURCE_SHA256,
) -> dict[str, Any]:
    root = _validate_private_root(private_root)
    source = _validate_private_source(pathlib.Path(source_path), root)
    output = _validate_new_output(pathlib.Path(output_dir), root)
    expected = expected_source_sha256.casefold()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise PilotError("expected_source_fingerprint_invalid")

    # Freeze and verify the full source before parsing it or ranking any row.
    source_sha_before = _sha256_file(source)
    if source_sha_before != expected:
        raise PilotError("source_fingerprint_mismatch")

    frame, frame_stats = _scan_frame(source)
    if _sha256_file(source) != source_sha_before:
        raise PilotError("source_changed_during_selection")
    if len(frame) < RANDOM_SIZE + TARGET_SIZE:
        raise PilotError("eligible_frame_too_small")

    random_rows = _ranked(frame, "random")[:RANDOM_SIZE]
    random_ids = {row.source_row_id for row in random_rows}
    holdout_rows = _ranked(random_rows, "holdout")[:HOLDOUT_SIZE]
    holdout_ids = {row.source_row_id for row in holdout_rows}
    random_development = [row for row in random_rows if row.source_row_id not in holdout_ids]
    linked_ids, link_reasons, holdout_threads = _holdout_links(frame, holdout_rows)
    for row in holdout_rows:
        row.cohort = "random_holdout"
        row.embargoed = True
        row.stratum = "random_holdout"
        row.selection_stage = "random"
    for row in random_development:
        row.cohort = "random_development"
        row.embargoed = row.source_row_id in linked_ids
        row.stratum = "random"
        row.selection_stage = "random"

    by_id = {row.source_row_id: row for row in frame}
    cue_evaluated = _scan_current_cues(source, by_id, linked_ids)

    older_thread_path = (
        _validate_private_older_input(pathlib.Path(triage_threads_path), root)
        if triage_threads_path is not None
        else None
    )
    older_selection_path = (
        _validate_private_older_input(pathlib.Path(triage_selections_path), root)
        if triage_selections_path is not None
        else None
    )
    older_threads = _apply_older_attachment_cues(
        older_thread_path, "threads", by_id, linked_ids, holdout_threads
    )
    older_selections = _apply_older_attachment_cues(
        older_selection_path, "selections", by_id, linked_ids, holdout_threads
    )

    candidate_rows = [
        row for row in frame
        if row.source_row_id not in random_ids and row.source_row_id not in linked_ids
    ]
    candidate_counts = collections.Counter()
    candidate_pools: dict[str, list[FrameRow]] = {stratum: [] for stratum in TARGET_ORDER}
    for row in candidate_rows:
        if not row.cue_evaluated:
            raise PilotError("target_cue_evaluation_missing")
        for stratum in _categories(row.cue_flags):
            candidate_pools[stratum].append(row)
            candidate_counts[stratum] += 1

    selected_targets: list[FrameRow] = []
    selected_target_ids: set[str] = set()
    quota_counts: collections.Counter[str] = collections.Counter()
    backfill_counts: collections.Counter[str] = collections.Counter()
    fallback_count = 0

    for stratum in TARGET_ORDER:
        pool = _ranked(candidate_pools[stratum], f"target:{stratum}")
        for row in pool:
            if quota_counts[stratum] >= TARGET_QUOTA:
                break
            if row.source_row_id in selected_target_ids:
                continue
            row.cohort = "targeted_development"
            row.embargoed = False
            row.stratum = stratum
            row.selection_stage = "quota"
            selected_targets.append(row)
            selected_target_ids.add(row.source_row_id)
            quota_counts[stratum] += 1

    # Fill quota shortfalls from still-unselected candidates in fixed cue order.
    for stratum in TARGET_ORDER:
        pool = _ranked(candidate_pools[stratum], f"target:{stratum}")
        for row in pool:
            if len(selected_targets) >= TARGET_SIZE:
                break
            if row.source_row_id in selected_target_ids:
                continue
            row.cohort = "targeted_development"
            row.embargoed = False
            row.stratum = stratum
            row.selection_stage = "candidate_backfill"
            row.backfill_from = stratum
            selected_targets.append(row)
            selected_target_ids.add(row.source_row_id)
            backfill_counts[stratum] += 1
        if len(selected_targets) >= TARGET_SIZE:
            break

    # Last deterministic fill uses only non-holdout, nonrandom, nonlinked rows.
    if len(selected_targets) < TARGET_SIZE:
        fallback_pool = _ranked(
            (
                row for row in candidate_rows
                if row.source_row_id not in selected_target_ids
            ),
            "fallback",
        )
        for row in fallback_pool:
            if len(selected_targets) >= TARGET_SIZE:
                break
            row.cohort = "targeted_development"
            row.embargoed = False
            row.stratum = "fallback"
            row.selection_stage = "general_fallback"
            selected_targets.append(row)
            selected_target_ids.add(row.source_row_id)
            fallback_count += 1

    if len(selected_targets) != TARGET_SIZE:
        raise PilotError("targeted_frame_too_small_after_embargo")
    if selected_target_ids & random_ids:
        raise PilotError("sample_cohort_overlap")
    if selected_target_ids & linked_ids:
        raise PilotError("holdout_link_in_targeted_sample")
    if len({row.source_row_id for row in (*random_development, *holdout_rows, *selected_targets)}) != 250:
        raise PilotError("sample_row_ids_not_unique")

    ordered_selected = (
        sorted(random_development, key=lambda row: (row.random_rank, row.timestamp, row.source_row_id))
        + sorted(holdout_rows, key=lambda row: (row.holdout_rank, row.timestamp, row.source_row_id))
        + selected_targets
    )
    selected_manifest = [
        _row_manifest(
            row,
            f"P{index:03d}",
            link_reasons.get(row.source_row_id, ()),
        )
        for index, row in enumerate(ordered_selected, 1)
    ]
    embargoed_random = [row for row in random_development if row.embargoed]
    embargo_reason_counts: collections.Counter[str] = collections.Counter()
    for row in embargoed_random:
        embargo_reason_counts.update(link_reasons.get(row.source_row_id, set()))

    source_sha_after = _sha256_file(source)
    if source_sha_after != source_sha_before:
        raise PilotError("source_changed_during_selection")

    aggregate = {
        "eligible_inbound_source_rows": len(frame),
        "distinct_source_threads": frame_stats["distinct_threads"],
        "scoped_inbound_in_window": frame_stats.get("scoped_inbound", 0),
        "scoped_outbound_in_window": frame_stats.get("scoped_outbound", 0),
        "outside_date_window_scoped_rows": frame_stats.get("outside_date_window", 0),
        "selected_total": len(selected_manifest),
        "selected_by_cohort": {
            "random_development": len(random_development),
            "random_holdout": len(holdout_rows),
            "targeted_development": len(selected_targets),
        },
        "unembargoed_random_development": len(random_development) - len(embargoed_random),
        "target_quota_selections_by_stratum": {
            stratum: quota_counts[stratum] for stratum in TARGET_ORDER
        },
        "target_candidate_population_by_stratum": {
            stratum: candidate_counts[stratum] for stratum in TARGET_ORDER
        },
        "target_candidate_backfill_by_stratum": {
            stratum: backfill_counts[stratum] for stratum in TARGET_ORDER
        },
        "target_general_fallback": fallback_count,
        "quota_shortfall_before_backfill_by_stratum": {
            stratum: max(0, TARGET_QUOTA - quota_counts[stratum])
            for stratum in TARGET_ORDER
        },
        "embargoed_random_development": len(embargoed_random),
        "embargoed_random_development_by_link_reason": {
            reason: embargo_reason_counts[reason]
            for reason in (
                "same_thread",
                "message_id_candidate",
                "exact_subject_body",
                "content_fingerprint",
            )
        },
        "holdout_thread_count": len(holdout_threads),
        "holdout_linked_frame_rows": len(linked_ids),
        "cue_evaluated_non_holdout_nonlinked_rows": len(cue_evaluated),
        "cue_evaluated_holdout_or_linked_rows": 0,
        "older_attachment_cue_parent_records": (
            older_threads["parent_records_with_cues"]
            + older_selections["parent_records_with_cues"]
        ),
    }
    manifest = {
        "schema": "centurion-pilot250-v1",
        "sampler_version": SAMPLER_VERSION,
        "cue_version": CUE_VERSION,
        "source_sha256": source_sha_before,
        "seed": SEED,
        "scope": _source_cue_manifest(),
        "frame_counts": frame_stats,
        "aggregate": aggregate,
        "older_triage_cues": {
            "threads": older_threads,
            "selections": older_selections,
        },
        "selected": selected_manifest,
    }

    output.mkdir(mode=0o700)
    os.chmod(output, 0o700)
    _safe_write_manifest(output / "manifest.json", manifest)
    return manifest


def _public_summary(manifest: Mapping[str, Any]) -> dict[str, Any]:
    # Keep all operational metadata and private linkage data in the manifest;
    # command-line output is aggregate counts only.
    return dict(manifest["aggregate"])


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Select the private Centurion 250 corpus pilot; stdout contains aggregates only."
    )
    parser.add_argument("source_jsonl", nargs="?")
    parser.add_argument("new_private_dir", nargs="?")
    parser.add_argument("--triage-threads")
    parser.add_argument("--triage-selections")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    private_root: pathlib.Path = PRIVATE_ROOT,
    expected_source_sha256: str = EXPECTED_SOURCE_SHA256,
) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.self_test:
        checks = run_synthetic_checks()
        print(json.dumps({"self_test": "passed", "checks": checks}, sort_keys=True))
        return 0
    if not args.source_jsonl or not args.new_private_dir:
        parser.print_usage(sys.stderr)
        print("pilot_selection_failed=source_and_new_private_dir_required", file=sys.stderr)
        return 2
    try:
        manifest = run_selector(
            pathlib.Path(args.source_jsonl),
            pathlib.Path(args.new_private_dir),
            private_root=private_root,
            triage_threads_path=pathlib.Path(args.triage_threads)
            if args.triage_threads
            else None,
            triage_selections_path=pathlib.Path(args.triage_selections)
            if args.triage_selections
            else None,
            expected_source_sha256=expected_source_sha256,
        )
    except PilotError as exc:
        print(f"pilot_selection_failed={exc}", file=sys.stderr)
        return 1
    except OSError:
        print("pilot_selection_failed=filesystem_error", file=sys.stderr)
        return 1
    except Exception:
        # Unexpected parser/runtime failures must not echo private source data.
        print("pilot_selection_failed=internal_error", file=sys.stderr)
        return 1
    print(json.dumps(_public_summary(manifest), sort_keys=True))
    return 0


def _synthetic_records(count: int, *, include_cues: bool = True,
                       include_voucher: bool = True) -> list[dict[str, Any]]:
    start = DATE_START
    if not include_cues:
        categories = ("filler",)
    elif include_voucher:
        categories = ("system", "pop", "voucher", "group", "mixed", "filler")
    else:
        categories = ("system", "pop", "group", "mixed", "filler")
    records: list[dict[str, Any]] = []
    for index in range(count):
        source_id = f"synthetic-source-{index:04d}"
        thread_id = f"synthetic-thread-{index:04d}"
        day = start + dt.timedelta(days=index % 95)
        timestamp = f"{day.isoformat()}T12:00:00Z"
        kind = categories[index % len(categories)]
        subject = f"Synthetic request {index}"
        body = f"SYNTHETIC_MAIL_BODY_SHOULD_NEVER_PRINT row-{index}"
        sender = "Guest <guest@example.invalid>"
        if kind == "system":
            sender = "No Reply <no-reply@booking.com>"
        elif kind == "pop":
            subject = f"Proof of payment synthetic-{index}"
        elif kind == "voucher":
            subject = f"Voucher supplied synthetic-{index}"
        elif kind == "group":
            body = f"Group request for 12 rooms synthetic-{index}"
        elif kind == "mixed":
            body = f"Please quote rates and book one room synthetic-{index}"
        message_id = f"<synthetic-{index:04d}@example.invalid>"
        row = {
            "sourceRowId": source_id,
            "scopeMembership": ["active_transport"],
            "receivedAt": timestamp,
            "threadId": thread_id,
            "messageId": message_id,
            "contentFingerprint": None,
            "body": body,
            "privateMessage": {
                "subject": subject,
                "direction": "inbound",
                "addresses": {"from": [sender]},
                "canonicalHeaders": {"Message-ID": message_id},
                "sourceMetadata": {"transportId": CENTURION_TRANSPORT},
            },
        }
        records.append(
            {
                "recordType": "thread",
                "threadId": thread_id,
                "messages": [
                    {"timestamp": timestamp, "messageId": message_id, "sourceRows": [row]}
                ],
            }
        )
    return records


def _write_synthetic_jsonl(path: pathlib.Path, records: Sequence[Mapping[str, Any]]) -> str:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        for record in records:
            stream.write(
                (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            )
    os.chmod(path, 0o600)
    return _sha256_file(path)


def _source_row(records: Sequence[Mapping[str, Any]], source_row_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    for raw_record in records:
        record = raw_record
        for message in record.get("messages", []):
            for row in message.get("sourceRows", []):
                if row.get("sourceRowId") == source_row_id:
                    return record, row
    raise AssertionError("synthetic source row missing")


def _set_synthetic_message_id(
    records: Sequence[Mapping[str, Any]], source_row_id: str, message_id: str
) -> None:
    for record in records:
        for message in record.get("messages", []):
            for row in message.get("sourceRows", []):
                if row.get("sourceRowId") != source_row_id:
                    continue
                message["messageId"] = message_id
                row["messageId"] = message_id
                row["privateMessage"]["canonicalHeaders"]["Message-ID"] = message_id
                return
    raise AssertionError("synthetic source row missing")


def _test_metadata_record(
    records: Sequence[Mapping[str, Any]],
    source_row_id: str,
    *,
    transport_id: str = CENTURION_TRANSPORT,
    subject_override: str | None = None,
) -> dict[str, Any]:
    _, row = _source_row(records, source_row_id)
    return {
        "messageId": source_row_id,
        "threadId": row["threadId"],
        "transport_id": transport_id,
        "fromAddress": row["privateMessage"]["addresses"]["from"][0],
        "receivedAt": row["receivedAt"],
        "subject": subject_override or row["privateMessage"]["subject"],
        "attachments": [],
    }


def run_synthetic_checks() -> int:
    checks = 0
    assert _message_id_key(_message_id_value({}, {}, {
        "canonicalHeaders": {"Message-ID": ["<synthetic-header@example.invalid>"]},
    })) == "synthetic-header@example.invalid"
    checks += 1
    with tempfile.TemporaryDirectory(prefix="pilot250-synthetic-") as temporary:
        root = pathlib.Path(temporary) / ".private"
        root.mkdir(mode=0o770)
        os.chmod(root, 0o770)

        # A group-shared anchor is allowed, but world access or a non-private
        # source child is rejected; the real workspace uses this layout.
        assert _validate_private_root(root) == root.resolve()
        os.chmod(root, 0o777)
        try:
            _validate_private_root(root)
            raise AssertionError("world-accessible root accepted")
        except PilotError:
            pass
        finally:
            os.chmod(root, 0o770)
        checks += 1
        loose_child = root / "nonprivate-fixture"
        loose_child.mkdir(mode=0o770)
        os.chmod(loose_child, 0o770)
        loose_file = loose_child / "synthetic.jsonl"
        loose_file.write_text("synthetic", encoding="utf-8")
        os.chmod(loose_file, 0o600)
        try:
            _validate_private_source(loose_file, root)
            raise AssertionError("group-accessible source child accepted")
        except PilotError:
            pass
        checks += 1

        # Primary draw: 5 strata, holdout links by thread, exact text and fingerprint.
        records = _synthetic_records(600)
        all_ids = [
            row["sourceRowId"]
            for record in records
            for message in record["messages"]
            for row in message["sourceRows"]
        ]
        random_ids = {
            row_id for row_id in sorted(all_ids, key=lambda value: (_rank(value, "random"), value))[:RANDOM_SIZE]
        }
        holdout_ids = {
            row_id
            for row_id in sorted(random_ids, key=lambda value: (_rank(value, "holdout"), value))[:HOLDOUT_SIZE]
        }
        random_dev_ids = random_ids - holdout_ids
        holdout_one, holdout_two = sorted(holdout_ids)[:2]
        same_thread_dev, exact_content_dev, fingerprint_dev, message_id_dev = sorted(
            random_dev_ids
        )[:4]

        holdout_record, holdout_row = _source_row(records, holdout_one)
        holdout_row["privateMessage"]["subject"] = "SYNTHETIC HOLDOUT CUE"
        holdout_row["body"] = "Voucher proof of payment HOLDOUT_SENTINEL"

        same_thread_record, same_thread_row = _source_row(records, same_thread_dev)
        same_thread_record["threadId"] = holdout_record["threadId"]
        same_thread_row["threadId"] = holdout_record["threadId"]

        exact_dev_record, exact_dev_row = _source_row(records, exact_content_dev)
        exact_dev_row["privateMessage"]["subject"] = holdout_row["privateMessage"]["subject"]
        exact_dev_row["body"] = holdout_row["body"]
        assert exact_dev_record["threadId"] != holdout_record["threadId"]

        fingerprint_holdout_record, fingerprint_holdout_row = _source_row(records, holdout_two)
        fingerprint_value = "synthetic-shared-content-fingerprint"
        fingerprint_holdout_row["contentFingerprint"] = fingerprint_value
        fingerprint_dev_record, fingerprint_dev_row = _source_row(records, fingerprint_dev)
        fingerprint_dev_row["contentFingerprint"] = fingerprint_value
        fingerprint_dev_row["privateMessage"]["subject"] = "Fingerprint-only synthetic difference"
        fingerprint_dev_row["body"] = "Different synthetic content"
        assert fingerprint_dev_record["threadId"] != fingerprint_holdout_record["threadId"]
        _set_synthetic_message_id(records, message_id_dev, holdout_row["messageId"])

        target_duplicate_id = next(value for value in all_ids if value not in random_ids)
        duplicate_record, duplicate_row = _source_row(records, target_duplicate_id)
        duplicate_row["privateMessage"]["subject"] = holdout_row["privateMessage"]["subject"]
        duplicate_row["body"] = holdout_row["body"]
        assert duplicate_record["threadId"] not in {
            _source_row(records, item)[0]["threadId"] for item in holdout_ids
        }
        target_message_id = next(
            value for value in all_ids
            if value not in random_ids and value != target_duplicate_id
        )
        _set_synthetic_message_id(records, target_message_id, holdout_row["messageId"])

        source = root / "synthetic.jsonl"
        source_sha = _write_synthetic_jsonl(source, records)
        output_one = root / "selection-one"
        manifest_one = run_selector(
            source,
            output_one,
            private_root=root,
            expected_source_sha256=source_sha,
        )
        checks += 1
        selected = manifest_one["selected"]
        assert len(selected) == 250
        assert len({item["source_row_id"] for item in selected}) == 250
        assert manifest_one["aggregate"]["selected_by_cohort"] == {
            "random_development": 100,
            "random_holdout": 50,
            "targeted_development": 100,
        }
        checks += 1
        assert manifest_one["sampler_version"] == SAMPLER_VERSION
        assert manifest_one["cue_version"] == CUE_VERSION
        assert manifest_one["scope"]["candidate_link_is_not_duplicate_proof"] is True
        assert "matching normalized nonempty source Message-ID candidate" in manifest_one[
            "scope"
        ]["holdout_link_rules"]
        assert (
            manifest_one["scope"]["cue_rules"]["older_attachment_created_at_available"]
            is False
        )
        assert "inbound decision time" in manifest_one["scope"]["cue_rules"][
            "older_attachment_observation_limit"
        ]
        checks += 1

        target_rows = [item for item in selected if item["cohort"] == "targeted_development"]
        target_quota_rows = [
            item for item in target_rows if item["selection_stage"] == "quota"
        ]
        quota_counts = collections.Counter(item["stratum"] for item in target_quota_rows)
        assert all(quota_counts[stratum] == 20 for stratum in TARGET_ORDER)
        checks += 1

        selected_by_id = {item["source_row_id"]: item for item in selected}
        assert selected_by_id[holdout_one]["cue_flags"] == []
        assert selected_by_id[holdout_one]["embargoed"] is True
        assert selected_by_id[same_thread_dev]["embargoed"] is True
        assert selected_by_id[exact_content_dev]["embargoed"] is True
        assert selected_by_id[fingerprint_dev]["embargoed"] is True
        assert selected_by_id[same_thread_dev]["candidate_link_reasons"] == ["same_thread"]
        assert selected_by_id[exact_content_dev]["candidate_link_reasons"] == [
            "exact_subject_body"
        ]
        assert selected_by_id[fingerprint_dev]["candidate_link_reasons"] == [
            "content_fingerprint"
        ]
        assert selected_by_id[message_id_dev]["embargoed"] is True
        assert selected_by_id[message_id_dev]["candidate_link_reasons"] == [
            "message_id_candidate"
        ]
        assert target_duplicate_id not in {
            item["source_row_id"] for item in target_rows
        }
        assert target_message_id not in {
            item["source_row_id"] for item in target_rows
        }
        assert manifest_one["aggregate"]["cue_evaluated_holdout_or_linked_rows"] == 0
        checks += 1

        assert not _mixed_action_candidate("Proof of payment for booking REF-123")
        assert _mixed_action_candidate("Proof of payment; please book one room")
        checks += 1

        output_two = root / "selection-two"
        manifest_two = run_selector(
            source,
            output_two,
            private_root=root,
            expected_source_sha256=source_sha,
        )
        assert manifest_one["selected"] == manifest_two["selected"]
        checks += 1
        assert stat.S_IMODE(output_one.stat().st_mode) == 0o700
        assert stat.S_IMODE((output_one / "manifest.json").stat().st_mode) == 0o600
        checks += 1

        try:
            run_selector(
                source,
                root / "fingerprint-mismatch",
                private_root=root,
                expected_source_sha256="0" * 64,
            )
        except PilotError as exc:
            assert str(exc) == "source_fingerprint_mismatch"
        else:
            raise AssertionError("source fingerprint mismatch was accepted")
        assert not (root / "fingerprint-mismatch").exists()
        checks += 1

        try:
            run_selector(
                source,
                output_one,
                private_root=root,
                expected_source_sha256=source_sha,
            )
        except PilotError as exc:
            assert str(exc) == "output_must_be_new_private_child"
        else:
            raise AssertionError("existing output directory was overwritten")
        checks += 1

        # Shortage is filled first from remaining cue candidates, then general frame.
        short_records = _synthetic_records(600, include_voucher=False)
        short_source = root / "shortfall.jsonl"
        short_sha = _write_synthetic_jsonl(short_source, short_records)
        short_manifest = run_selector(
            short_source,
            root / "shortfall-selection",
            private_root=root,
            expected_source_sha256=short_sha,
        )
        assert short_manifest["aggregate"]["target_general_fallback"] == 0
        assert sum(short_manifest["aggregate"]["target_candidate_backfill_by_stratum"].values()) > 0
        assert len(short_manifest["selected"]) == 250
        checks += 1

        filler_records = _synthetic_records(600, include_cues=False)
        filler_source = root / "fallback.jsonl"
        filler_sha = _write_synthetic_jsonl(filler_source, filler_records)
        fallback_manifest = run_selector(
            filler_source,
            root / "fallback-selection",
            private_root=root,
            expected_source_sha256=filler_sha,
        )
        assert fallback_manifest["aggregate"]["target_general_fallback"] == TARGET_SIZE
        assert len(fallback_manifest["selected"]) == 250
        checks += 1

        # Older selection attachment cues require exact parent, transport and metadata.
        attachment_records = _synthetic_records(600, include_cues=False)
        attachment_ids = [
            row["sourceRowId"]
            for record in attachment_records
            for message in record["messages"]
            for row in message["sourceRows"]
        ]
        attachment_random = {
            value for value in sorted(attachment_ids, key=lambda item: (_rank(item, "random"), item))[:RANDOM_SIZE]
        }
        attachment_holdout = {
            value
            for value in sorted(attachment_random, key=lambda item: (_rank(item, "holdout"), item))[:HOLDOUT_SIZE]
        }
        attachment_linked, _, attachment_holdout_threads = _holdout_links(
            _scan_frame_from_synthetic_records(attachment_records),
            [
                row for row in _scan_frame_from_synthetic_records(attachment_records)
                if row.source_row_id in attachment_holdout
            ],
        )
        eligible_attachment_targets = [
            value
            for value in attachment_ids
            if value not in attachment_random and value not in attachment_linked
        ]
        attachment_target = eligible_attachment_targets[0]
        selection_records = [
            _test_metadata_record(attachment_records, attachment_target),
        ]
        selection_records[0]["attachments"] = [
            {"filename": "proof-of-payment.pdf", "text": "proof of payment"}
        ]
        holdout_selection = _test_metadata_record(attachment_records, next(iter(attachment_holdout)))
        holdout_selection["attachments"] = [
            {"filename": "HOLDOUT_SENTINEL_voucher.pdf", "text": "voucher proof of payment"}
        ]
        wrong_transport = _test_metadata_record(
            attachment_records,
            eligible_attachment_targets[1],
            transport_id="transport-other",
        )
        wrong_transport["attachments"] = [
            {"filename": "wrong-transport-receipt.pdf", "text": "proof of payment"}
        ]
        inconsistent = _test_metadata_record(
            attachment_records,
            eligible_attachment_targets[2],
            subject_override="Different synthetic subject",
        )
        inconsistent["attachments"] = [
            {"filename": "mismatched-voucher.pdf", "text": "voucher"}
        ]
        selections_path = root / "selections-transport-centurion.jsonl"
        _write_synthetic_jsonl(
            selections_path,
            [*selection_records, holdout_selection, wrong_transport, inconsistent],
        )
        attachment_source = root / "attachment-cues.jsonl"
        attachment_sha = _write_synthetic_jsonl(attachment_source, attachment_records)
        attachment_manifest = run_selector(
            attachment_source,
            root / "attachment-selection",
            private_root=root,
            triage_selections_path=selections_path,
            expected_source_sha256=attachment_sha,
        )
        attachment_selected = {
            item["source_row_id"]: item for item in attachment_manifest["selected"]
        }
        assert "proof_of_payment_older_attachment" in attachment_selected[
            attachment_target
        ]["cue_flags"]
        assert attachment_manifest["aggregate"]["target_quota_selections_by_stratum"][
            "proof_of_payment"
        ] == 1
        assert attachment_manifest["older_triage_cues"]["selections"][
            "rejected_transport_records"
        ] == 1
        assert attachment_manifest["older_triage_cues"]["selections"][
            "rejected_metadata_records"
        ] == 1
        assert all(
            not item["cue_flags"]
            for item in attachment_manifest["selected"]
            if item["source_row_id"] in attachment_holdout
        )
        checks += 1

        # Main CLI stdout is aggregate-only; private manifest remains owner-only.
        cli_output = root / "cli-selection"
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        stdout = StringIO()
        stderr = StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = main(
                [str(source), str(cli_output)],
                private_root=root,
                expected_source_sha256=source_sha,
            )
        visible = stdout.getvalue() + stderr.getvalue()
        assert exit_code == 0
        assert "SYNTHETIC_MAIL_BODY_SHOULD_NEVER_PRINT" not in visible
        assert "synthetic-source-" not in visible
        assert "synthetic-thread-" not in visible
        assert "guest@example.invalid" not in visible
        assert "HOLDOUT_SENTINEL" not in visible
        public_counts = json.loads(stdout.getvalue())
        assert public_counts["selected_total"] == 250
        assert set(public_counts) <= set(manifest_one["aggregate"])
        checks += 1

    return checks


def _scan_frame_from_synthetic_records(records: Sequence[Mapping[str, Any]]) -> list[FrameRow]:
    # Test-only adapter keeps the production selector file-backed.
    with tempfile.TemporaryDirectory(prefix="pilot250-frame-") as temporary:
        path = pathlib.Path(temporary) / "fixture.jsonl"
        _write_synthetic_jsonl(path, records)
        frame, _ = _scan_frame(path)
        return frame


if __name__ == "__main__":
    raise SystemExit(main())
