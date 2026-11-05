#!/usr/bin/env python3
"""Count post-freeze saved reply-link candidates for the Centurion 250 pilot.

This is aggregate evidence only. A matching active-transport outbound
In-Reply-To in the same saved thread is a candidate relationship, not proof of
an answer, completion, delivery, or staff outcome. Stored-date order is also
uncertain (timezone and ingestion semantics are not established). This helper
must not change counterfactual input labels. It reads the pinned source and
manifest only after an explicit --labels-frozen attestation, and excludes
holdout/embargoed rows unless --holdout-unsealed is also supplied.

Run synthetic-only checks with:
    python3 docs/research/halloween/corpus-analysis/pilot-250-outcomes.py --self-test

Production use (paths must live below the repository's owner-only .private):
    python3 docs/research/halloween/corpus-analysis/pilot-250-outcomes.py \
      --labels-frozen .private/<owner-only-dir>/source.jsonl \
      .private/<owner-only-dir>/manifest.json

Add --holdout-unsealed only after the approved pilot's holdout labels freeze.
Standard output and errors contain aggregates or fixed error codes
only; no message, subject, address, case, thread, or Message-ID is printed.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[4]
PRIVATE_ROOT = REPOSITORY_ROOT / ".private"
CENTURION_TRANSPORT = "transport-centurion"
EXPECTED_SOURCE_SHA256 = "ec9d30c47e2ef0a3dd61ae6db795e1f730feb5e853b9cf76025f523d7a4e6625"
SCHEMA = "centurion-pilot250-v1"
SEED = "centurion-pilot-250-v1-20261101"
SAMPLER_VERSION = "centurion-pilot-250-select-v2"
CUE_VERSION = "centurion-pilot-cues-v2-20261101"
DATE_START = dt.date(2026, 7, 27)
DATE_END = dt.date(2026, 10, 29)
EXPECTED_COHORTS = {
    "random_development": 100,
    "random_holdout": 50,
    "targeted_development": 100,
}
COHORT_ORDER = tuple(EXPECTED_COHORTS)
MESSAGE_ID_TOKEN_RE = re.compile(r"<[^<>\s,]+@[^<>\s,]+>|[^<>\s,]+@[^<>\s,]+")


class OutcomesError(Exception):
    """Controlled error carrying only a fixed, non-sensitive code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ScopedMessage:
    source_row_id: str
    source_line: int
    message_index: int
    thread_id: str | None
    timestamp: str | None
    direction: str
    message_id: str | None
    in_reply_to: tuple[str, ...] | None


def fail(code: str) -> None:
    raise OutcomesError(code)


def _path_for_cli(value: str, repository_root: pathlib.Path) -> pathlib.Path:
    candidate = pathlib.Path(value)
    if not candidate.is_absolute():
        candidate = repository_root / candidate
    try:
        return pathlib.Path(os.path.abspath(candidate))
    except (OSError, ValueError):
        fail("input_path_invalid")


def validate_private_root(path: pathlib.Path) -> pathlib.Path:
    try:
        if path.is_symlink():
            fail("private_root_symlink")
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except OutcomesError:
        raise
    except (OSError, RuntimeError):
        fail("private_root_unavailable")
    mode = stat.S_IMODE(info.st_mode)
    # The shared .private anchor may be group-accessible (currently 0770),
    # while descendants containing inputs must remain owner-only.
    if not resolved.is_dir() or info.st_uid != os.getuid() or mode & 0o007:
        fail("private_root_permissions")
    return resolved


def validate_private_file(
    path: pathlib.Path,
    private_root: pathlib.Path,
    label: str,
) -> pathlib.Path:
    try:
        lexical = pathlib.Path(os.path.abspath(path))
    except (OSError, ValueError):
        fail(f"{label}_path_invalid")
    if not lexical.is_relative_to(private_root) or lexical.parent == private_root:
        fail(f"{label}_outside_private_root")

    cursor = lexical
    while cursor != private_root:
        try:
            if cursor.is_symlink():
                fail(f"{label}_symlink")
        except OutcomesError:
            raise
        except OSError:
            fail(f"{label}_unavailable")
        cursor = cursor.parent

    try:
        resolved = lexical.resolve(strict=True)
        file_info = resolved.stat()
    except OutcomesError:
        raise
    except (OSError, RuntimeError):
        fail(f"{label}_unavailable")
    if (
        resolved != lexical
        or not resolved.is_file()
        or not resolved.is_relative_to(private_root)
        or resolved.parent == private_root
        or file_info.st_uid != os.getuid()
        or stat.S_IMODE(file_info.st_mode) != 0o600
    ):
        fail(f"{label}_permissions")

    parent = resolved.parent
    while parent != private_root:
        try:
            info = parent.stat()
        except OSError:
            fail(f"{label}_parent_permissions")
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            fail(f"{label}_parent_permissions")
        parent = parent.parent
    return resolved


def _open_checked(path: pathlib.Path, label: str):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
    except OSError:
        fail(f"{label}_unavailable")
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        os.close(descriptor)
        fail(f"{label}_permissions")
    try:
        return os.fdopen(descriptor, "rb")
    except OSError:
        os.close(descriptor)
        fail(f"{label}_unavailable")


def _sha256_file(path: pathlib.Path, label: str) -> str:
    digest = hashlib.sha256()
    try:
        with _open_checked(path, label) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OutcomesError:
        raise
    except OSError:
        fail(f"{label}_unavailable")
    return digest.hexdigest()


def _read_manifest(path: pathlib.Path) -> Mapping[str, Any]:
    try:
        with _open_checked(path, "manifest") as stream:
            raw = stream.read(5 * 1024 * 1024 + 1)
    except OutcomesError:
        raise
    except OSError:
        fail("manifest_unavailable")
    if len(raw) > 5 * 1024 * 1024:
        fail("manifest_too_large")
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("manifest_json_invalid")
    if not isinstance(manifest, Mapping):
        fail("manifest_schema_invalid")
    return manifest


def _normalize_message_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("<") and text.endswith(">"):
        text = text[1:-1]
    if (
        not text
        or "<" in text
        or ">" in text
        or any(character.isspace() or ord(character) < 33 for character in text)
        or text.count("@") != 1
    ):
        return None
    local, domain = text.split("@", 1)
    if not local or not domain:
        return None
    return text.casefold()


def _canonical_header_values(private_message: Mapping[str, Any], name: str) -> list[str] | None:
    headers = private_message.get("canonicalHeaders")
    if not isinstance(headers, Mapping):
        return None
    found = False
    values: list[str] = []
    for header_name, raw_values in headers.items():
        if not isinstance(header_name, str) or header_name.casefold() != name.casefold():
            continue
        found = True
        if not isinstance(raw_values, list) or not raw_values:
            return None
        if any(not isinstance(value, str) or not value.strip() for value in raw_values):
            return None
        values.extend(raw_values)
    if not found:
        return None
    return values


def _canonical_message_id(private_message: Mapping[str, Any]) -> str | None:
    values = _canonical_header_values(private_message, "Message-ID")
    if values is None or len(values) != 1:
        return None
    return _normalize_message_id(values[0])


def _parse_in_reply_to(private_message: Mapping[str, Any]) -> tuple[str, ...] | None:
    values = _canonical_header_values(private_message, "In-Reply-To")
    if values is None or len(values) != 1:
        return None
    text = values[0].strip()
    if not text:
        return None

    identifiers: list[str] = []
    cursor = 0
    for match in MESSAGE_ID_TOKEN_RE.finditer(text):
        separator = text[cursor : match.start()]
        if separator and not re.fullmatch(r"[\s,]+", separator):
            return None
        if not identifiers and separator.strip(" \t"):
            return None
        token = match.group(0)
        identifier = _normalize_message_id(token)
        if identifier is None:
            return None
        identifiers.append(identifier)
        cursor = match.end()
    trailing = text[cursor:]
    if (
        not identifiers
        or (trailing and not re.fullmatch(r"[\s,]+", trailing))
        or trailing.strip(" \t")
    ):
        return None
    return tuple(identifiers)


def _stored_date(value: str | None) -> dt.date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError:
        return None


def _iter_source_messages(
    stream,
) -> tuple[dict[str, ScopedMessage], str]:
    by_source_id: dict[str, ScopedMessage] = {}
    digest = hashlib.sha256()
    for line_number, raw in enumerate(stream, 1):
        digest.update(raw)
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("source_jsonl_invalid")
        if not isinstance(record, Mapping) or record.get("recordType") != "thread":
            continue
        messages = record.get("messages")
        if not isinstance(messages, list):
            fail("source_thread_schema_invalid")
        record_thread_id = record.get("threadId")
        for message_index, message in enumerate(messages):
            if not isinstance(message, Mapping):
                fail("source_message_schema_invalid")
            source_rows = message.get("sourceRows")
            if not isinstance(source_rows, list):
                fail("source_rows_schema_invalid")
            scoped_rows: list[Mapping[str, Any]] = []
            for source_row in source_rows:
                if not isinstance(source_row, Mapping):
                    fail("source_row_schema_invalid")
                membership = source_row.get("scopeMembership")
                private_message = source_row.get("privateMessage")
                source_metadata = (
                    private_message.get("sourceMetadata")
                    if isinstance(private_message, Mapping)
                    else None
                )
                transport_id = (
                    source_metadata.get("transportId")
                    if isinstance(source_metadata, Mapping)
                    else None
                )
                if (
                    isinstance(membership, list)
                    and "active_transport" in membership
                    and transport_id == CENTURION_TRANSPORT
                ):
                    scoped_rows.append(source_row)
            if not scoped_rows:
                continue
            if len(scoped_rows) != len(source_rows):
                fail("source_mixed_scope_message")
            if len(scoped_rows) != 1:
                fail("source_multiple_scoped_rows")

            source_row = scoped_rows[0]
            private_message = source_row.get("privateMessage")
            if not isinstance(private_message, Mapping):
                fail("source_private_message_schema_invalid")
            direction = private_message.get("direction")
            if direction not in ("inbound", "outbound"):
                fail("source_direction_invalid")
            source_row_id = source_row.get("sourceRowId")
            if not isinstance(source_row_id, str) or not source_row_id:
                fail("source_row_identity_invalid")
            if source_row_id in by_source_id:
                fail("source_row_identity_duplicate")

            row_thread_id = source_row.get("threadId")
            if (
                isinstance(record_thread_id, str)
                and record_thread_id
                and isinstance(row_thread_id, str)
                and row_thread_id
                and record_thread_id != row_thread_id
            ):
                thread_id = None
            elif isinstance(record_thread_id, str) and record_thread_id:
                thread_id = record_thread_id
            elif isinstance(row_thread_id, str) and row_thread_id:
                thread_id = row_thread_id
            else:
                thread_id = None

            raw_timestamp = message.get("timestamp")
            timestamp = raw_timestamp if isinstance(raw_timestamp, str) and raw_timestamp else None
            by_source_id[source_row_id] = ScopedMessage(
                source_row_id=source_row_id,
                source_line=line_number,
                message_index=message_index,
                thread_id=thread_id,
                timestamp=timestamp,
                direction=direction,
                message_id=_canonical_message_id(private_message),
                in_reply_to=_parse_in_reply_to(private_message),
            )
    return by_source_id, digest.hexdigest()


def _validate_manifest(manifest: Mapping[str, Any], expected_source_sha256: str) -> list[Mapping[str, Any]]:
    if (
        manifest.get("schema") != SCHEMA
        or manifest.get("seed") != SEED
        or manifest.get("sampler_version") != SAMPLER_VERSION
        or manifest.get("cue_version") != CUE_VERSION
    ):
        fail("manifest_schema_seed_or_version")
    if manifest.get("source_sha256") != expected_source_sha256:
        fail("manifest_source_hash")

    scope = manifest.get("scope")
    cue_rules = scope.get("cue_rules") if isinstance(scope, Mapping) else None
    holdout_rules = scope.get("holdout_link_rules") if isinstance(scope, Mapping) else None
    if (
        not isinstance(scope, Mapping)
        or scope.get("direction") != "inbound"
        or scope.get("scope_membership") != "active_transport"
        or scope.get("transport_id") != CENTURION_TRANSPORT
        or scope.get("candidate_link_is_not_duplicate_proof") is not True
        or not isinstance(holdout_rules, list)
        or "matching normalized nonempty source Message-ID candidate" not in holdout_rules
        or not isinstance(cue_rules, Mapping)
        or cue_rules.get("version") != CUE_VERSION
        or cue_rules.get("older_attachment_created_at_available") is not False
        or not isinstance(cue_rules.get("older_attachment_observation_limit"), str)
        or not cue_rules.get("older_attachment_observation_limit")
    ):
        fail("manifest_scope_or_link_contract")

    selected = manifest.get("selected")
    if not isinstance(selected, list) or len(selected) != 250:
        fail("selection_size")
    if any(not isinstance(item, Mapping) for item in selected):
        fail("selection_schema_invalid")
    counts = collections.Counter(item.get("cohort") for item in selected)
    if dict(counts) != EXPECTED_COHORTS:
        fail("cohort_sizes")

    seen_case_ids: set[str] = set()
    seen_source_ids: set[str] = set()
    for item in selected:
        case_id = item.get("case_id")
        source_row_id = item.get("source_row_id")
        if (
            not isinstance(case_id, str)
            or not case_id
            or not isinstance(source_row_id, str)
            or not source_row_id
            or case_id in seen_case_ids
            or source_row_id in seen_source_ids
        ):
            fail("selection_identity_invalid")
        seen_case_ids.add(case_id)
        seen_source_ids.add(source_row_id)
        if (
            not isinstance(item.get("thread_id"), str)
            or not item.get("thread_id")
            or type(item.get("source_line")) is not int
            or item["source_line"] < 1
            or type(item.get("message_index")) is not int
            or item["message_index"] < 0
            or not isinstance(item.get("timestamp"), str)
            or not item.get("timestamp")
            or type(item.get("embargoed")) is not bool
        ):
            fail("selection_row_metadata_invalid")
        cohort = item.get("cohort")
        if cohort == "random_holdout" and item.get("embargoed") is not True:
            fail("holdout_not_embargoed")
        if cohort == "targeted_development" and item.get("embargoed") is not False:
            fail("targeted_case_embargoed")
    return selected


def _validate_selected_rows(
    selected: Sequence[Mapping[str, Any]],
    source_rows: Mapping[str, ScopedMessage],
) -> list[tuple[Mapping[str, Any], ScopedMessage]]:
    result: list[tuple[Mapping[str, Any], ScopedMessage]] = []
    for item in selected:
        row = source_rows.get(item["source_row_id"])
        if row is None or row.direction != "inbound":
            fail("selected_row_not_active_inbound")
        if (
            row.source_line != item["source_line"]
            or row.message_index != item["message_index"]
            or row.thread_id != item["thread_id"]
            or row.timestamp != item["timestamp"]
        ):
            fail("selected_row_mismatch")
        target_date = _stored_date(row.timestamp)
        if target_date is None or target_date < DATE_START or target_date > DATE_END:
            fail("selected_row_date_outside_snapshot")
        result.append((item, row))
    return result


def _empty_cohort_counts() -> dict[str, Any]:
    return {
        "eligible_messages": 0,
        "excluded_sealed_messages": 0,
        "usable_canonical_message_id": 0,
        "same_thread_active_transport_outbound_in_reply_to_candidate_messages": 0,
        "same_thread_candidate_outbound_messages": 0,
        "candidate_messages_with_later_stored_date": 0,
        "messages_with_ambiguous_duplicate_canonical_message_id": 0,
        "missing_metadata": {},
    }


MISSING_METADATA_FIELDS = (
    "target_canonical_message_id",
    "target_thread_id",
    "target_stored_date",
    "same_thread_outbound_with_missing_or_unusable_in_reply_to",
    "matching_outbound_thread_id",
    "candidate_outbound_stored_date",
)


def summarize_outcomes(
    selected_rows: Sequence[tuple[Mapping[str, Any], ScopedMessage]],
    source_rows: Mapping[str, ScopedMessage],
    *,
    holdout_unsealed: bool,
) -> dict[str, Any]:
    id_frequency = collections.Counter(
        row.message_id for row in source_rows.values() if row.message_id is not None
    )
    outbounds_by_thread: dict[str, list[ScopedMessage]] = collections.defaultdict(list)
    outbounds_by_reply_id: dict[str, list[ScopedMessage]] = collections.defaultdict(list)
    for row in source_rows.values():
        if row.direction != "outbound":
            continue
        if row.thread_id is not None:
            outbounds_by_thread[row.thread_id].append(row)
        if row.in_reply_to is not None:
            for reply_id in set(row.in_reply_to):
                outbounds_by_reply_id[reply_id].append(row)

    summaries = {cohort: _empty_cohort_counts() for cohort in COHORT_ORDER}
    missing_cases: dict[str, dict[str, set[str]]] = {
        cohort: {field: set() for field in MISSING_METADATA_FIELDS}
        for cohort in COHORT_ORDER
    }
    any_missing_cases: dict[str, set[str]] = {cohort: set() for cohort in COHORT_ORDER}

    def mark_missing(cohort: str, case_id: str, field: str) -> None:
        missing_cases[cohort][field].add(case_id)
        any_missing_cases[cohort].add(case_id)

    for item, target in selected_rows:
        cohort = item["cohort"]
        is_sealed = cohort == "random_holdout" or item["embargoed"] is True
        if is_sealed and not holdout_unsealed:
            summaries[cohort]["excluded_sealed_messages"] += 1
            continue

        case_id = item["case_id"]
        summary = summaries[cohort]
        summary["eligible_messages"] += 1
        target_date = _stored_date(target.timestamp)
        if target.message_id is None:
            mark_missing(cohort, case_id, "target_canonical_message_id")
        else:
            summary["usable_canonical_message_id"] += 1
            if id_frequency[target.message_id] > 1:
                summary["messages_with_ambiguous_duplicate_canonical_message_id"] += 1
        if target.thread_id is None:
            mark_missing(cohort, case_id, "target_thread_id")
        if target_date is None:
            mark_missing(cohort, case_id, "target_stored_date")

        same_thread_outbounds = (
            outbounds_by_thread.get(target.thread_id, [])
            if target.thread_id is not None
            else []
        )
        if same_thread_outbounds:
            if any(outbound.in_reply_to is None for outbound in same_thread_outbounds):
                mark_missing(
                    cohort,
                    case_id,
                    "same_thread_outbound_with_missing_or_unusable_in_reply_to",
                )

        if target.message_id is None:
            continue
        id_matched_outbounds = outbounds_by_reply_id.get(target.message_id, [])
        same_thread_matches = [
            outbound
            for outbound in id_matched_outbounds
            if target.thread_id is not None and outbound.thread_id == target.thread_id
        ]
        if any(outbound.thread_id is None for outbound in id_matched_outbounds):
            mark_missing(cohort, case_id, "matching_outbound_thread_id")
        if not same_thread_matches:
            continue

        summary["same_thread_active_transport_outbound_in_reply_to_candidate_messages"] += 1
        summary["same_thread_candidate_outbound_messages"] += len(same_thread_matches)
        later_stored_date = False
        for outbound in same_thread_matches:
            outbound_date = _stored_date(outbound.timestamp)
            if outbound_date is None:
                mark_missing(cohort, case_id, "candidate_outbound_stored_date")
            elif target_date is not None and outbound_date > target_date:
                later_stored_date = True
        if later_stored_date:
            summary["candidate_messages_with_later_stored_date"] += 1

    for cohort, summary in summaries.items():
        summary["missing_metadata"] = {
            "messages_missing_any_required_metadata": len(any_missing_cases[cohort]),
            "field_counts_overlap": True,
            **{
                field: len(missing_cases[cohort][field])
                for field in MISSING_METADATA_FIELDS
            },
        }

    return {
        "schema": "centurion-pilot-outcomes-v1",
        "pinned_source_fingerprint_verified": True,
        "labels_frozen_attested": True,
        "holdout_unsealed": holdout_unsealed,
        "eligibility_definition": (
            "eligible_messages are selected inbound pilot rows included in this outcome count; "
            "they are not H/K actionable labels. Random holdout and embargoed rows are excluded "
            "unless --holdout-unsealed is supplied."
        ),
        "cohorts": summaries,
        "linkage_interpretation": (
            "Exact canonical Message-ID/In-Reply-To match in the same thread and active Centurion "
            "transport is candidate linkage only, not proof of a substantive answer, completion, "
            "delivery, or staff outcome. A missing saved reply is not proof no reply occurred."
        ),
        "stored_date_basis": (
            "Compare only messages[].timestamp calendar-date prefixes. Later stored dates are "
            "candidate ordering evidence, not chronology proof; timezone/ingestion semantics are "
            "uncertain. RFC Date headers are ignored."
        ),
        "answered_rate_limitation": (
            "The saved snapshot is not proof of complete delivery; matching reply metadata cannot "
            "establish a substantive answer, and no saved match cannot establish no answer. "
            "These counts cannot support a definitive answered-rate."
        ),
        "definitive_answered_rate_supported": False,
        "substantive_answer_or_completion_proven": False,
        "outcomes_must_not_change_counterfactual_input_labels": True,
    }


def analyze(
    source_argument: str | pathlib.Path,
    manifest_argument: str | pathlib.Path,
    *,
    labels_frozen: bool,
    holdout_unsealed: bool = False,
    private_root_path: pathlib.Path = PRIVATE_ROOT,
    repository_root: pathlib.Path = REPOSITORY_ROOT,
    expected_source_sha256: str = EXPECTED_SOURCE_SHA256,
) -> dict[str, Any]:
    # This gate intentionally precedes path resolution, stat, or file access.
    if not labels_frozen:
        fail("labels_not_frozen")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_source_sha256):
        fail("expected_source_fingerprint_invalid")

    private_root = validate_private_root(private_root_path)
    source_path = validate_private_file(
        _path_for_cli(str(source_argument), repository_root), private_root, "source"
    )
    manifest_path = validate_private_file(
        _path_for_cli(str(manifest_argument), repository_root), private_root, "manifest"
    )
    if source_path == manifest_path:
        fail("source_and_manifest_must_differ")

    manifest = _read_manifest(manifest_path)
    selected = _validate_manifest(manifest, expected_source_sha256)

    # Hash first, before parsing any source content, then hash again during the
    # parse so a changed file is never accepted as the pinned source.
    source_sha_before = _sha256_file(source_path, "source")
    if source_sha_before != expected_source_sha256:
        fail("source_fingerprint_mismatch")
    try:
        with _open_checked(source_path, "source") as stream:
            source_rows, source_sha_during_parse = _iter_source_messages(stream)
    except OutcomesError:
        raise
    except OSError:
        fail("source_unavailable")
    if source_sha_during_parse != expected_source_sha256:
        fail("source_changed_during_read")

    selected_rows = _validate_selected_rows(selected, source_rows)
    return summarize_outcomes(
        selected_rows,
        source_rows,
        holdout_unsealed=holdout_unsealed,
    )


def _canonical_headers(message_id: str | None = None, in_reply_to: str | None = None,
                       date_header: str | None = None) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    if message_id is not None:
        headers["Message-ID"] = [f"<{message_id}>"]
    if in_reply_to is not None:
        headers["In-Reply-To"] = [f"<{in_reply_to}>"]
    if date_header is not None:
        headers["Date"] = [date_header]
    return headers


def _synthetic_source_row(
    source_row_id: str,
    thread_id: str,
    direction: str,
    headers: Mapping[str, list[str]],
    *,
    transport_id: str = CENTURION_TRANSPORT,
    fallback_message_id: str | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "sourceRowId": source_row_id,
        "scopeMembership": ["active_transport"],
        "threadId": thread_id,
        "body": "SYNTHETIC_BODY_MUST_NOT_PRINT",
        "privateMessage": {
            "subject": "SYNTHETIC_SUBJECT_MUST_NOT_PRINT",
            "direction": direction,
            "addresses": {"from": ["synthetic@example.invalid"]},
            "canonicalHeaders": dict(headers),
            "sourceMetadata": {"transportId": transport_id},
        },
    }
    if fallback_message_id is not None:
        row["messageId"] = f"<{fallback_message_id}>"
    return row


def _synthetic_thread(thread_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {"recordType": "thread", "threadId": thread_id, "messages": messages}


def _synthetic_message(timestamp: str, source_row: dict[str, Any],
                       fallback_message_id: str | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"timestamp": timestamp, "sourceRows": [source_row]}
    if fallback_message_id is not None:
        message["messageId"] = f"<{fallback_message_id}>"
    return message


def _write_owner_only(path: pathlib.Path, data: bytes) -> None:
    path.write_bytes(data)
    os.chmod(path, 0o600)


def _run_synthetic_checks() -> int:
    checks = 0
    missing_source = pathlib.Path("/no/synthetic/source")
    missing_manifest = pathlib.Path("/no/synthetic/manifest")
    try:
        analyze(missing_source, missing_manifest, labels_frozen=False)
    except OutcomesError as error:
        assert error.code == "labels_not_frozen"
    else:
        raise AssertionError("labels-frozen gate did not reject an unsealed run")
    checks += 1

    with tempfile.TemporaryDirectory(prefix="pilot250-outcomes-selftest-") as temporary:
        root = pathlib.Path(temporary)
        private_root = root / "private"
        child = private_root / "synthetic"
        child.mkdir(parents=True, mode=0o700)
        os.chmod(private_root, 0o700)
        os.chmod(child, 0o700)
        source_path = child / "source.jsonl"
        manifest_path = child / "manifest.json"

        selected: list[dict[str, Any]] = []
        records: list[dict[str, Any]] = []
        for index in range(250):
            if index < 100:
                cohort = "random_development"
                embargoed = index == 5
            elif index < 150:
                cohort = "random_holdout"
                embargoed = True
            else:
                cohort = "targeted_development"
                embargoed = False

            source_row_id = f"synthetic-source-row-{index:03d}"
            thread_id = f"synthetic-thread-{index:03d}"
            timestamp = f"2026-08-{(index % 20) + 1:02d}T12:00:00Z"
            message_id: str | None = f"inbound-{index:03d}@sample.invalid"
            if index == 0:
                message_id = "direct@sample.invalid"
                timestamp = "2026-08-01T12:00:00Z"
            elif index == 1:
                message_id = None
                timestamp = "2026-08-02T12:00:00Z"
            elif index == 2:
                message_id = "duplicate@sample.invalid"
                timestamp = "2026-08-03T12:00:00Z"
            elif index == 3:
                message_id = "date-order@sample.invalid"
                timestamp = "2026-08-04T12:00:00Z"
            elif index == 4:
                message_id = "no-irt@sample.invalid"
                timestamp = "2026-08-05T12:00:00Z"
            elif index == 5:
                message_id = "embargoed@sample.invalid"
                timestamp = "2026-08-06T12:00:00Z"
            elif index == 100:
                message_id = "holdout@sample.invalid"
                timestamp = "2026-08-11T12:00:00Z"

            inbound_headers = _canonical_headers(message_id=message_id)
            inbound_row = _synthetic_source_row(
                source_row_id,
                thread_id,
                "inbound",
                inbound_headers,
                fallback_message_id=("fallback-only@sample.invalid" if index == 1 else None),
            )
            messages = [_synthetic_message(timestamp, inbound_row,
                                           "fallback-only@sample.invalid" if index == 1 else None)]

            reply_spec: tuple[str, str, str | None] | None = None
            if index == 0:
                reply_spec = ("direct@sample.invalid", "2026-08-02T12:00:00Z", "Mon, 27 Jul 2026 00:00:00 +0000")
            elif index == 1:
                # Prove sourceRow/message fallback IDs are not canonical IDs.
                reply_spec = ("fallback-only@sample.invalid", "2026-08-03T12:00:00Z", None)
            elif index == 2:
                reply_spec = ("duplicate@sample.invalid", "2026-08-03T23:00:00Z", None)
            elif index == 3:
                # Sender Date is tomorrow, but messages[].timestamp is same day.
                reply_spec = ("date-order@sample.invalid", "2026-08-04T23:00:00Z", "Wed, 05 Aug 2026 00:00:00 +0000")
            elif index == 4:
                # An outbound exists but has no usable In-Reply-To metadata.
                outbound = _synthetic_source_row(
                    f"synthetic-outbound-no-irt-{index:03d}",
                    thread_id,
                    "outbound",
                    _canonical_headers(message_id=f"outbound-{index:03d}@sample.invalid"),
                )
                messages.append(_synthetic_message("2026-08-05T22:00:00Z", outbound))
            elif index == 5:
                reply_spec = ("embargoed@sample.invalid", "2026-08-07T12:00:00Z", None)
            elif index == 100:
                reply_spec = ("holdout@sample.invalid", "2026-08-12T12:00:00Z", None)

            if reply_spec is not None:
                reply_to, reply_timestamp, date_header = reply_spec
                outbound = _synthetic_source_row(
                    f"synthetic-outbound-{index:03d}",
                    thread_id,
                    "outbound",
                    _canonical_headers(
                        message_id=f"outbound-{index:03d}@sample.invalid",
                        in_reply_to=reply_to,
                        date_header=date_header,
                    ),
                )
                messages.append(_synthetic_message(reply_timestamp, outbound))

            records.append(_synthetic_thread(thread_id, messages))
            selected.append(
                {
                    "case_id": f"synthetic-case-{index:03d}",
                    "source_row_id": source_row_id,
                    "thread_id": thread_id,
                    "source_line": len(records),
                    "message_index": 0,
                    "timestamp": timestamp,
                    "cohort": cohort,
                    "embargoed": embargoed,
                    "stratum": "synthetic",
                    "cue_flags": ["proof_of_payment_text"] if cohort == "targeted_development" else [],
                }
            )

        # A second active inbound with same canonical Message-ID makes the
        # selected target ambiguous, but does not become a duplicate-delivery claim.
        duplicate_row = _synthetic_source_row(
            "synthetic-unselected-duplicate",
            "synthetic-duplicate-other-thread",
            "inbound",
            _canonical_headers(message_id="duplicate@sample.invalid"),
        )
        records.append(
            _synthetic_thread(
                "synthetic-duplicate-other-thread",
                [_synthetic_message("2026-08-20T12:00:00Z", duplicate_row)],
            )
        )

        # Wrong thread and wrong transport match IDs are not same-thread active links.
        wrong_thread = _synthetic_source_row(
            "synthetic-wrong-thread-outbound",
            "synthetic-wrong-thread",
            "outbound",
            _canonical_headers(
                message_id="wrong-thread-outbound@sample.invalid",
                in_reply_to="direct@sample.invalid",
            ),
        )
        records.append(
            _synthetic_thread(
                "synthetic-wrong-thread",
                [_synthetic_message("2026-08-03T12:00:00Z", wrong_thread)],
            )
        )
        wrong_transport = _synthetic_source_row(
            "synthetic-wrong-transport-outbound",
            "synthetic-thread-000",
            "outbound",
            _canonical_headers(
                message_id="wrong-transport-outbound@sample.invalid",
                in_reply_to="direct@sample.invalid",
            ),
            transport_id="transport-other",
        )
        records.append(
            _synthetic_thread(
                "synthetic-thread-000",
                [_synthetic_message("2026-08-03T12:00:00Z", wrong_transport)],
            )
        )

        source_bytes = b"".join(
            json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
            for record in records
        )
        _write_owner_only(source_path, source_bytes)
        synthetic_source_sha256 = hashlib.sha256(source_bytes).hexdigest()
        manifest = {
            "schema": SCHEMA,
            "source_sha256": synthetic_source_sha256,
            "seed": SEED,
            "sampler_version": SAMPLER_VERSION,
            "cue_version": CUE_VERSION,
            "scope": {
                "direction": "inbound",
                "scope_membership": "active_transport",
                "transport_id": CENTURION_TRANSPORT,
                "candidate_link_is_not_duplicate_proof": True,
                "holdout_link_rules": ["matching normalized nonempty source Message-ID candidate"],
                "cue_rules": {
                    "version": CUE_VERSION,
                    "older_attachment_created_at_available": False,
                    "older_attachment_observation_limit": "Synthetic test: observation time unverified.",
                },
            },
            "selected": selected,
        }
        _write_owner_only(
            manifest_path,
            json.dumps(manifest, separators=(",", ":")).encode("utf-8"),
        )

        default_summary = analyze(
            source_path,
            manifest_path,
            labels_frozen=True,
            private_root_path=private_root,
            repository_root=root,
            expected_source_sha256=synthetic_source_sha256,
        )
        development = default_summary["cohorts"]["random_development"]
        assert development["eligible_messages"] == 99
        assert development["excluded_sealed_messages"] == 1
        assert development["usable_canonical_message_id"] == 98
        assert development["same_thread_active_transport_outbound_in_reply_to_candidate_messages"] == 3
        assert development["same_thread_candidate_outbound_messages"] == 3
        assert development["candidate_messages_with_later_stored_date"] == 1
        assert development["messages_with_ambiguous_duplicate_canonical_message_id"] == 1
        assert development["missing_metadata"]["messages_missing_any_required_metadata"] == 2
        assert development["missing_metadata"]["target_canonical_message_id"] == 1
        assert development["missing_metadata"][
            "same_thread_outbound_with_missing_or_unusable_in_reply_to"
        ] == 1
        assert default_summary["cohorts"]["random_holdout"]["eligible_messages"] == 0
        assert default_summary["cohorts"]["random_holdout"]["excluded_sealed_messages"] == 50
        assert default_summary["cohorts"]["targeted_development"]["eligible_messages"] == 100
        assert default_summary["definitive_answered_rate_supported"] is False
        assert default_summary["substantive_answer_or_completion_proven"] is False
        rendered = json.dumps(default_summary, sort_keys=True)
        for private_marker in (
            "synthetic-source-row",
            "synthetic-thread-",
            "SYNTHETIC_BODY_MUST_NOT_PRINT",
            "SYNTHETIC_SUBJECT_MUST_NOT_PRINT",
            "direct@sample.invalid",
            "proof_of_payment_text",
        ):
            assert private_marker not in rendered
        checks += 1

        unsealed_summary = analyze(
            source_path,
            manifest_path,
            labels_frozen=True,
            holdout_unsealed=True,
            private_root_path=private_root,
            repository_root=root,
            expected_source_sha256=synthetic_source_sha256,
        )
        unsealed_random = unsealed_summary["cohorts"]["random_development"]
        unsealed_holdout = unsealed_summary["cohorts"]["random_holdout"]
        assert unsealed_random["eligible_messages"] == 100
        assert unsealed_random["same_thread_active_transport_outbound_in_reply_to_candidate_messages"] == 4
        assert unsealed_random["candidate_messages_with_later_stored_date"] == 2
        assert unsealed_holdout["eligible_messages"] == 50
        assert unsealed_holdout["same_thread_active_transport_outbound_in_reply_to_candidate_messages"] == 1
        assert unsealed_holdout["candidate_messages_with_later_stored_date"] == 1
        checks += 1

        # Private root may be shared-mode, but descendants/files must remain private.
        os.chmod(private_root, 0o770)
        assert validate_private_root(private_root) == private_root.resolve()
        checks += 1

    return checks


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # noqa: ARG002 - don't echo user input
        print("outcomes_failed=arguments_invalid", file=sys.stderr)
        raise SystemExit(2)


def _parser() -> argparse.ArgumentParser:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", help="pinned source JSONL under .private")
    parser.add_argument("manifest", nargs="?", help="pinned pilot manifest under .private")
    parser.add_argument(
        "--labels-frozen",
        action="store_true",
        help="attest that counterfactual labels are frozen",
    )
    parser.add_argument(
        "--holdout-unsealed",
        action="store_true",
        help="also count holdout and embargoed rows after their labels freeze",
    )
    parser.add_argument("--self-test", action="store_true", help="run synthetic-only checks")
    return parser


def main() -> int:
    try:
        args = _parser().parse_args()
        if args.self_test:
            checks = _run_synthetic_checks()
            print(json.dumps({"self_test": "passed", "checks": checks}, sort_keys=True))
            return 0
        # The attestation is checked before paths are turned into filesystem
        # references, stat'ed, or opened.
        if not args.labels_frozen:
            fail("labels_not_frozen")
        if not args.source or not args.manifest:
            fail("source_and_manifest_required")
        summary = analyze(
            args.source,
            args.manifest,
            labels_frozen=True,
            holdout_unsealed=args.holdout_unsealed,
        )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except OutcomesError as error:
        print(f"outcomes_failed={error.code}", file=sys.stderr)
        return 2
    except Exception:
        # Do not expose exception text: it can include input values or paths.
        print("outcomes_failed=internal_error", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
