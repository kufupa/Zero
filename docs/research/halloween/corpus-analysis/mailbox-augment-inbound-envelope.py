#!/usr/bin/env python3
"""Index saved inbound To/Cc headers by source ID and augment private packets.

Source files are supplied oldest-to-newest; the last occurrence of a source ID
wins, matching mailbox-frame-build's --prefer-last-source behavior. Empty or
missing recipient arrays are unknown because the exporter collapses null and
empty source values. This script never reads packet message text for labeling.
"""

from __future__ import annotations

import argparse
import email.utils
import hashlib
import json
import os
import re
import stat
from collections import Counter
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
PRIVATE_ROOT = HERE.parents[3] / ".private"
INDEX_SCHEMA = "centurion_inbound_envelope_index/v1"
SELECTION_SCHEMA = "centurion_envelope_target_selection/v1"
MAX_ROWS = 50_000
MAX_FILE_BYTES = 200_000_000
MAX_ADDRESS_COUNT = 100
MAX_ADDRESS_CHARS = 320
LABEL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
EMAIL_ADDRESS_RE = re.compile(r"^[^@\s<>]+@[^@\s<>@]+$")


class EnvelopeFailure(Exception):
    """Expected, content-free failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise EnvelopeFailure("duplicate_json_key")
        result[key] = value
    return result


def _private_path(path_value: str | Path, *, existing: bool) -> Path:
    path = Path(path_value)
    if not path.is_absolute():
        path = Path.cwd() / path
    path = Path(os.path.abspath(path))
    root = PRIVATE_ROOT.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    if not parent.is_relative_to(root) or path.is_symlink():
        raise EnvelopeFailure("path_not_private")
    if stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise EnvelopeFailure("private_parent_permissions")
    if existing:
        if not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise EnvelopeFailure("input_not_private_file")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise EnvelopeFailure("input_too_large")
    elif path.exists():
        raise EnvelopeFailure("output_exists")
    return parent / path.name


def _read_jsonl(path: Path, *, allow_empty: bool = False) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("rb") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                if line_number > MAX_ROWS:
                    raise EnvelopeFailure("too_many_rows")
                row = json.loads(line, object_pairs_hook=_strict_object)
                if not isinstance(row, dict):
                    raise EnvelopeFailure("row_not_object")
                rows.append(row)
    except EnvelopeFailure:
        raise
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        raise EnvelopeFailure("input_jsonl_invalid") from None
    if not rows and not allow_empty:
        raise EnvelopeFailure("input_empty")
    return rows


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                          allow_nan=False)
    except (TypeError, ValueError, UnicodeError):
        raise EnvelopeFailure("input_not_serializable") from None


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_address_field(value: Any, *, present: bool) -> tuple[list[str] | None, str]:
    if not present or value is None:
        return None, "unknown_missing"
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        values = value
    else:
        return None, "unknown_invalid"
    if len(values) > MAX_ADDRESS_COUNT or any(
        len(item) > MAX_ADDRESS_CHARS * 2 or "\r" in item or "\n" in item for item in values
    ):
        return None, "unknown_invalid"
    nonempty = [item for item in values if item.strip()]
    if not nonempty:
        # Snapshot export normalizes absent/null values to []; cannot prove
        # that this means the original message had no recipient.
        return None, "unknown_empty"
    addresses: set[str] = set()
    for raw in nonempty:
        parsed = [address.strip().casefold()
                  for _, address in email.utils.getaddresses([raw]) if "@" in address]
        if not parsed or any(
            len(address) > MAX_ADDRESS_CHARS or not EMAIL_ADDRESS_RE.fullmatch(address)
            for address in parsed
        ):
            return None, "unknown_invalid"
        addresses.update(parsed)
    if not addresses or len(addresses) > MAX_ADDRESS_COUNT:
        return None, "unknown_invalid"
    return sorted(addresses), "known"


def _reduce_source_row(row: dict[str, Any], source: str, ordinal: int) -> dict[str, Any]:
    source_id = row.get("id")
    if not isinstance(source_id, str) or not source_id or source_id != source_id.strip():
        raise EnvelopeFailure("source_id_invalid")
    to, to_status = _parse_address_field(row.get("to"), present="to" in row)
    cc, cc_status = _parse_address_field(row.get("cc"), present="cc" in row)
    from_addresses, from_status = _parse_address_field(row.get("from"), present="from" in row)
    raw_digest = hashlib.sha256(_canonical_json(row).encode("utf-8")).hexdigest()
    return {
        "id": source_id,
        "selected_source": source,
        "selected_ordinal": ordinal,
        "direction": row.get("direction") if row.get("direction") in ("inbound", "outbound") else None,
        "from": from_addresses,
        "from_status": from_status,
        "to": to,
        "to_status": to_status,
        "cc": cc,
        "cc_status": cc_status,
        "_digest": raw_digest,
        "_occurrences": [source],
        "_duplicate_conflict": False,
        "_recipient_conflict_fields": [],
    }


def load_source_rows(source_specs: list[tuple[str, Path]]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Load reduced envelope rows; later sources and rows take precedence."""
    if not source_specs:
        raise EnvelopeFailure("sources_required")
    labels: set[str] = set()
    selected: dict[str, dict[str, Any]] = {}
    row_counts: Counter[str] = Counter()
    duplicate_occurrences = 0
    duplicate_conflict_ids: set[str] = set()
    recipient_conflict_ids: set[str] = set()
    recipient_field_conflicts: Counter[str] = Counter()
    internal_senders: set[str] = set()
    internal_domains: set[str] = set()

    for label, path in source_specs:
        if not LABEL_RE.fullmatch(label) or label in labels:
            raise EnvelopeFailure("source_label_invalid_or_duplicate")
        labels.add(label)
        try:
            with path.open("rb") as source:
                for ordinal, line in enumerate(source, 1):
                    if not line.strip():
                        continue
                    if ordinal > MAX_ROWS:
                        raise EnvelopeFailure("too_many_source_rows")
                    row = json.loads(line, object_pairs_hook=_strict_object)
                    if not isinstance(row, dict):
                        raise EnvelopeFailure("source_row_not_object")
                    reduced = _reduce_source_row(row, label, ordinal)
                    row_counts[label] += 1
                    source_id = reduced["id"]
                    previous = selected.get(source_id)
                    if previous is not None:
                        duplicate_occurrences += 1
                        if previous["_digest"] != reduced["_digest"]:
                            duplicate_conflict_ids.add(source_id)
                            reduced["_duplicate_conflict"] = True
                        recipient_changes = [
                            field for field in ("to", "cc")
                            if previous[field] != reduced[field]
                            or previous[f"{field}_status"] != reduced[f"{field}_status"]
                        ]
                        if recipient_changes:
                            recipient_conflict_ids.add(source_id)
                            recipient_field_conflicts.update(recipient_changes)
                        reduced["_occurrences"] = previous["_occurrences"] + [label]
                        reduced["_duplicate_conflict"] = (
                            reduced["_duplicate_conflict"] or previous["_duplicate_conflict"]
                        )
                        reduced["_recipient_conflict_fields"] = sorted(
                            set(previous["_recipient_conflict_fields"]) | set(recipient_changes)
                        )
                    selected[source_id] = reduced
        except EnvelopeFailure:
            raise
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
            raise EnvelopeFailure("source_jsonl_invalid") from None

    # Derive internal sender identities only from precedence-selected rows.
    for row in selected.values():
        if row["direction"] == "outbound" and row["from_status"] == "known":
            for address in row["from"] or []:
                internal_senders.add(address)
                internal_domains.add(address.rsplit("@", 1)[-1])

    summary = {
        "source_order": [label for label, _ in source_specs],
        "source_sha256": {label: _file_sha256(path) for label, path in source_specs},
        "source_rows_by_label": dict(sorted(row_counts.items())),
        "unique_source_ids": len(selected),
        "duplicate_occurrences": duplicate_occurrences,
        "duplicate_conflict_ids": len(duplicate_conflict_ids),
        "recipient_conflict_ids": len(recipient_conflict_ids),
        "recipient_conflicting_fields": dict(sorted(recipient_field_conflicts.items())),
        "precedence": "last row in last supplied source wins",
        "internal_outbound_sender_count": len(internal_senders),
        "internal_outbound_domain_count": len(internal_domains),
    }
    return selected, {"summary": summary, "internal_senders": internal_senders,
                      "internal_domains": internal_domains}


def _packet_source_ids(packet: dict[str, Any]) -> list[str]:
    source = packet.get("_source")
    if not isinstance(source, dict):
        raise EnvelopeFailure("packet_source_missing")
    ids = source.get("row_ids")
    if not isinstance(ids, list):
        raise EnvelopeFailure("packet_source_ids_invalid")
    if any(not isinstance(value, str) or not value or value != value.strip() for value in ids):
        raise EnvelopeFailure("packet_source_ids_invalid")
    return list(ids)


def _field_from_source_rows(source_rows: list[dict[str, Any]], source_status: str,
                            field: str) -> tuple[list[str] | None, str]:
    if source_status != "ok":
        return None, "unknown_source_coverage"
    if not source_rows:
        return None, "unknown_no_source_ids"
    if any(not row.get("present") for row in source_rows):
        return None, "unknown_source_coverage"
    statuses = [row.get(f"{field}_status") for row in source_rows]
    if any(status != "known" for status in statuses):
        return None, "unknown_source_field"
    values = {tuple(row.get(field) or []) for row in source_rows}
    if len(values) != 1:
        return None, "unknown_multiple_envelopes"
    return list(next(iter(values))), "known"


def build_envelope_index(packets: list[dict[str, Any]],
                         source_rows_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Create one case record, source-ID-bound, for every packet."""
    seen_cases: set[str] = set()
    output: list[dict[str, Any]] = []
    for packet in packets:
        case = packet.get("case")
        if not isinstance(case, str) or not case or case in seen_cases:
            raise EnvelopeFailure("packet_case_invalid_or_duplicate")
        seen_cases.add(case)
        row_ids = _packet_source_ids(packet)
        found_count = sum(source_id in source_rows_by_id for source_id in row_ids)
        if not row_ids:
            source_status = "no_source_ids"
        elif found_count == 0:
            source_status = "source_missing"
        elif found_count < len(row_ids):
            source_status = "partial_source"
        else:
            source_status = "ok"
        case_rows: list[dict[str, Any]] = []
        for source_id in row_ids:
            source_row = source_rows_by_id.get(source_id)
            if source_row is None:
                case_rows.append({
                    "id": source_id, "present": False, "selected_source": None,
                    "source_occurrences": [], "duplicate_conflict": False,
                    "recipient_conflict_fields": [],
                    "to": None, "to_status": "unknown_source_missing",
                    "cc": None, "cc_status": "unknown_source_missing",
                })
                continue
            case_rows.append({
                "id": source_id,
                "present": True,
                "selected_source": source_row["selected_source"],
                "source_occurrences": source_row["_occurrences"],
                "duplicate_conflict": source_row["_duplicate_conflict"],
                "recipient_conflict_fields": source_row["_recipient_conflict_fields"],
                "to": source_row["to"],
                "to_status": source_row["to_status"],
                "cc": source_row["cc"],
                "cc_status": source_row["cc_status"],
            })
        to, to_status = _field_from_source_rows(case_rows, source_status, "to")
        cc, cc_status = _field_from_source_rows(case_rows, source_status, "cc")
        output.append({
            "schema": INDEX_SCHEMA,
            "case": case,
            "source_row_ids": row_ids,
            "source_status": source_status,
            "source_rows": case_rows,
            "to": to,
            "to_status": to_status,
            "cc": cc,
            "cc_status": cc_status,
            "precedence_conflict_count": sum(
                1 for row in case_rows if row.get("duplicate_conflict")
            ),
        })
    return output


def _validate_source_row_record(row: Any, expected_id: str) -> dict[str, Any]:
    required = {
        "id", "present", "selected_source", "source_occurrences", "duplicate_conflict",
        "recipient_conflict_fields", "to", "to_status", "cc", "cc_status",
    }
    if not isinstance(row, dict) or set(row) != required or row.get("id") != expected_id:
        raise EnvelopeFailure("index_source_row_schema")
    if not isinstance(row.get("present"), bool):
        raise EnvelopeFailure("index_source_row_schema")
    for field in ("to", "cc"):
        value, status = row.get(field), row.get(f"{field}_status")
        if status == "known":
            if (not isinstance(value, list) or not value
                    or any(not isinstance(item, str) or not EMAIL_ADDRESS_RE.fullmatch(item)
                           or len(item) > MAX_ADDRESS_CHARS for item in value)
                    or value != sorted(set(value))):
                raise EnvelopeFailure("index_address_schema")
        elif value is not None or status not in {
            "unknown_missing", "unknown_empty", "unknown_invalid", "unknown_source_missing",
        }:
            raise EnvelopeFailure("index_address_unknown_schema")
    if (not isinstance(row.get("source_occurrences"), list)
            or any(not isinstance(item, str) for item in row["source_occurrences"])):
        raise EnvelopeFailure("index_source_occurrences_schema")
    if not isinstance(row.get("duplicate_conflict"), bool):
        raise EnvelopeFailure("index_source_conflict_schema")
    conflicts = row.get("recipient_conflict_fields")
    if not isinstance(conflicts, list) or any(item not in ("to", "cc") for item in conflicts):
        raise EnvelopeFailure("index_recipient_conflict_schema")
    if row["present"] != bool(row["source_occurrences"]):
        raise EnvelopeFailure("index_source_presence_mismatch")
    return row


def reconstruct_envelope_annotation(packet: dict[str, Any],
                                    index_record: dict[str, Any]) -> dict[str, Any]:
    """Rebuild To/Cc values from per-source records, not case-level cached fields."""
    if (not isinstance(index_record, dict) or index_record.get("schema") != INDEX_SCHEMA
            or index_record.get("case") != packet.get("case")):
        raise EnvelopeFailure("index_case_mismatch")
    row_ids = _packet_source_ids(packet)
    if index_record.get("source_row_ids") != row_ids:
        raise EnvelopeFailure("source_id_identity_mismatch")
    source_rows = index_record.get("source_rows")
    if not isinstance(source_rows, list) or len(source_rows) != len(row_ids):
        raise EnvelopeFailure("index_source_rows_schema")
    source_rows = [
        _validate_source_row_record(row, source_id)
        for row, source_id in zip(source_rows, row_ids, strict=True)
    ]
    present = sum(1 for row in source_rows if row["present"])
    if not row_ids:
        source_status = "no_source_ids"
    elif present == 0:
        source_status = "source_missing"
    elif present < len(row_ids):
        source_status = "partial_source"
    else:
        source_status = "ok"
    if index_record.get("source_status") != source_status:
        raise EnvelopeFailure("index_source_status_mismatch")
    to, to_status = _field_from_source_rows(source_rows, source_status, "to")
    cc, cc_status = _field_from_source_rows(source_rows, source_status, "cc")
    for field, value, status in (("to", to, to_status), ("cc", cc, cc_status)):
        if index_record.get(field) != value or index_record.get(f"{field}_status") != status:
            raise EnvelopeFailure("index_annotation_not_reproducible")
    conflict_count = sum(1 for row in source_rows if row.get("duplicate_conflict"))
    if index_record.get("precedence_conflict_count") != conflict_count:
        raise EnvelopeFailure("index_conflict_count_mismatch")
    return {"to": to, "cc": cc, "to_status": to_status, "cc_status": cc_status}


def _index_map(index_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in index_rows:
        case = row.get("case")
        if not isinstance(case, str) or not case or case in result:
            raise EnvelopeFailure("index_case_invalid_or_duplicate")
        result[case] = row
    return result


def augment_packets(packets: list[dict[str, Any]],
                    index_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    index_by_case = _index_map(index_rows)
    if len(packets) != len(index_by_case):
        raise EnvelopeFailure("packet_index_count_mismatch")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for packet in packets:
        case = packet.get("case")
        if not isinstance(case, str) or case in seen or case not in index_by_case:
            raise EnvelopeFailure("packet_index_case_mismatch")
        seen.add(case)
        annotation = reconstruct_envelope_annotation(packet, index_by_case[case])
        inbound = packet.get("inbound")
        if not isinstance(inbound, dict):
            raise EnvelopeFailure("packet_inbound_schema")
        if any(key in inbound and inbound[key] != annotation[key] for key in ("to", "cc")):
            raise EnvelopeFailure("existing_envelope_annotation_mismatch")
        copied = dict(packet)
        copied_inbound = dict(inbound)
        copied_inbound["to"] = annotation["to"]
        copied_inbound["cc"] = annotation["cc"]
        copied["inbound"] = copied_inbound
        output.append(copied)
    report = validate_annotations(packets, index_rows, output)
    return output, report


def validate_annotations(packets: list[dict[str, Any]],
                         index_rows: list[dict[str, Any]],
                         augmented_packets: list[dict[str, Any]],
                         source_rows_by_id: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Reconstruct every recipient annotation; optionally revalidate source precedence."""
    index_by_case = _index_map(index_rows)
    packet_by_case = {row.get("case"): row for row in packets}
    augmented_by_case = {row.get("case"): row for row in augmented_packets}
    if (len(packet_by_case) != len(packets) or len(augmented_by_case) != len(augmented_packets)
            or set(packet_by_case) != set(index_by_case)
            or set(packet_by_case) != set(augmented_by_case)):
        raise EnvelopeFailure("validation_case_sets_differ")
    status_counts: Counter[str] = Counter()
    field_status_counts: Counter[str] = Counter()
    for case, packet in packet_by_case.items():
        index_record = index_by_case[case]
        expected = reconstruct_envelope_annotation(packet, index_record)
        augmented = augmented_by_case[case]
        inbound = augmented.get("inbound")
        original_inbound = packet.get("inbound")
        if not isinstance(inbound, dict) or not isinstance(original_inbound, dict):
            raise EnvelopeFailure("validation_inbound_schema")
        if any(inbound.get(field, "__missing__") != expected[field] for field in ("to", "cc")):
            raise EnvelopeFailure("annotation_mismatch")
        clean_original = dict(original_inbound)
        clean_augmented = dict(inbound)
        for field in ("to", "cc"):
            clean_original.pop(field, None)
            clean_augmented.pop(field, None)
        if clean_original != clean_augmented:
            raise EnvelopeFailure("packet_non_envelope_content_changed")
        base_packet = dict(packet)
        augmented_packet = dict(augmented)
        base_packet.pop("inbound", None)
        augmented_packet.pop("inbound", None)
        if base_packet != augmented_packet:
            raise EnvelopeFailure("packet_non_inbound_content_changed")
        status_counts[index_record["source_status"]] += 1
        field_status_counts["to:" + expected["to_status"]] += 1
        field_status_counts["cc:" + expected["cc_status"]] += 1
    source_verified = False
    if source_rows_by_id is not None:
        rebuilt = build_envelope_index(packets, source_rows_by_id)
        if rebuilt != index_rows:
            raise EnvelopeFailure("index_source_rebuild_mismatch")
        source_verified = True
    return {
        "schema": INDEX_SCHEMA,
        "packets": len(packets),
        "source_verified": source_verified,
        "source_status_counts": dict(sorted(status_counts.items())),
        "field_status_counts": dict(sorted(field_status_counts.items())),
    }


def _addresses_from_packet(value: Any) -> set[str]:
    addresses, status = _parse_address_field(value, present=value is not None)
    return set(addresses or []) if status == "known" else set()


def _target_stratum(packet: dict[str, Any], index_row: dict[str, Any],
                    internal_domains: set[str]) -> str | None:
    inbound = packet.get("inbound")
    if not isinstance(inbound, dict):
        return None
    senders = _addresses_from_packet(inbound.get("from"))
    sender_domains = {address.rsplit("@", 1)[-1] for address in senders}
    if not sender_domains.intersection(internal_domains):
        return None
    to, cc = index_row.get("to"), index_row.get("cc")
    to_known, cc_known = isinstance(to, list), isinstance(cc, list)
    to_external = to_known and any(
        address.rsplit("@", 1)[-1] not in internal_domains for address in to
    )
    cc_internal = cc_known and any(
        address.rsplit("@", 1)[-1] in internal_domains for address in cc
    )
    if to_external and cc_internal:
        return "hotel_sender_external_to_internal_cc"
    if to_external and not cc_known:
        return "hotel_sender_external_to_cc_unknown"
    if not to_known or not cc_known:
        return "hotel_sender_envelope_ambiguous"
    if (to or []) and all(
        address.rsplit("@", 1)[-1] in internal_domains for address in (to + cc)
    ):
        return "internal_staff_direction"
    return "hotel_sender_other_recipient_mix"


def select_targeted_packets(packets: list[dict[str, Any]],
                            index_rows: list[dict[str, Any]],
                            internal_domains: set[str], *, limit: int,
                            seed: str, include_cases: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not 1 <= limit <= MAX_ROWS or not seed or len(seed) > 128:
        raise EnvelopeFailure("selection_limits_invalid")
    index_by_case = _index_map(index_rows)
    candidates: dict[str, tuple[dict[str, Any], str]] = {}
    strata: dict[str, list[str]] = {}
    for packet in packets:
        case = packet.get("case")
        record = index_by_case.get(case)
        if record is None:
            raise EnvelopeFailure("selection_index_case_missing")
        reconstruct_envelope_annotation(packet, record)
        stratum = _target_stratum(packet, record, internal_domains)
        if stratum:
            candidates[case] = (packet, stratum)
            strata.setdefault(stratum, []).append(case)
    if not candidates:
        raise EnvelopeFailure("selection_no_target_candidates")
    if len(set(include_cases)) != len(include_cases):
        raise EnvelopeFailure("include_case_duplicate")
    if any(case not in candidates for case in include_cases):
        raise EnvelopeFailure("include_case_not_targeted")
    if len(include_cases) > limit:
        raise EnvelopeFailure("include_cases_exceed_limit")
    selected: list[str] = list(include_cases)
    selected_set = set(selected)

    def rank(case: str) -> str:
        return hashlib.sha256((seed + "\0" + case).encode("utf-8")).hexdigest()

    ordered_strata = sorted(strata)
    pools = {
        stratum: sorted((case for case in cases if case not in selected_set), key=rank)
        for stratum, cases in strata.items()
    }
    while len(selected) < min(limit, len(candidates)):
        progress = False
        for stratum in ordered_strata:
            while pools[stratum] and pools[stratum][0] in selected_set:
                pools[stratum].pop(0)
            if pools[stratum] and len(selected) < limit:
                case = pools[stratum].pop(0)
                if case not in selected_set:
                    selected.append(case)
                    selected_set.add(case)
                    progress = True
        if not progress:
            break
    selected_in_input_order = [packet for packet in packets if packet.get("case") in selected_set]
    selected_counts = Counter(candidates[case][1] for case in selected_set)
    manifest = {
        "schema": SELECTION_SCHEMA,
        "seed": seed,
        "limit": limit,
        "candidate_count": len(candidates),
        "selected_count": len(selected_in_input_order),
        "internal_outbound_domain_count": len(internal_domains),
        "strata_candidate_counts": dict(sorted(
            (key, len(value)) for key, value in strata.items()
        )),
        "strata_selected_counts": dict(sorted(selected_counts.items())),
        "case_ids": [packet["case"] for packet in selected_in_input_order],
        "selection_reasons": {
            packet["case"]: candidates[packet["case"]][1] for packet in selected_in_input_order
        },
    }
    return selected_in_input_order, manifest


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            for row in rows:
                target.write(_canonical_json(row) + "\n")
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _write_json(path: Path, value: dict[str, Any]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _parse_sources(values: list[str]) -> list[tuple[str, Path]]:
    parsed: list[tuple[str, Path]] = []
    for value in values:
        if "=" not in value:
            raise EnvelopeFailure("source_arg_requires_label_path")
        label, path_text = value.split("=", 1)
        if not path_text:
            raise EnvelopeFailure("source_arg_requires_label_path")
        parsed.append((label, _private_path(path_text, existing=True)))
    if not parsed:
        raise EnvelopeFailure("sources_required")
    return parsed


def _summary(index_rows: list[dict[str, Any]], source_meta: dict[str, Any],
             packet_path: Path) -> dict[str, Any]:
    source_statuses = Counter(row["source_status"] for row in index_rows)
    field_statuses = Counter()
    precedence_conflicts = 0
    for row in index_rows:
        field_statuses["to:" + row["to_status"]] += 1
        field_statuses["cc:" + row["cc_status"]] += 1
        precedence_conflicts += row["precedence_conflict_count"]
    return {
        "schema": INDEX_SCHEMA,
        "packet_file_sha256": _file_sha256(packet_path),
        "source_summary": source_meta["summary"],
        "packet_count": len(index_rows),
        "source_status_counts": dict(sorted(source_statuses.items())),
        "field_status_counts": dict(sorted(field_statuses.items())),
        "packet_source_precedence_conflict_occurrences": precedence_conflicts,
        "note": "Empty normalized recipient arrays are unknown; exporter erased null-versus-empty.",
    }


def self_test() -> int:
    checks = 0

    def check(condition: bool, code: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            raise EnvelopeFailure("self_test_" + code)

    old_row = {
        "id": "source-1", "direction": "inbound", "from": ["Staff <staff@hotel.test>"],
        "to": ["Guest <guest@outside.test>"], "cc": ["frontdesk@hotel.test"],
        "body": "private body must not be copied",
    }
    tail_row = {
        **old_row, "to": ["agent@outside.test"], "body": "new source revision",
    }
    second_row = {
        "id": "source-2", "direction": "inbound", "from": ["staff@hotel.test"],
        "to": ["agent@outside.test"], "cc": [],
    }
    sources = [
        _reduce_source_row(old_row, "old", 1),
        _reduce_source_row(tail_row, "tail", 1),
        _reduce_source_row(second_row, "tail", 2),
    ]
    merged = {}
    for row in sources:
        prior = merged.get(row["id"])
        if prior:
            row["_occurrences"] = prior["_occurrences"] + [row["selected_source"]]
            row["_duplicate_conflict"] = prior["_digest"] != row["_digest"] or prior["_duplicate_conflict"]
            changed = {field for field in ("to", "cc")
                       if prior[field] != row[field] or prior[f"{field}_status"] != row[f"{field}_status"]}
            row["_recipient_conflict_fields"] = sorted(
                set(prior["_recipient_conflict_fields"]) | changed
            )
        merged[row["id"]] = row
    packet = {"case": "I00001", "_source": {"row_ids": ["source-1", "source-2"]},
              "inbound": {"message": "kept", "from": ["staff@hotel.test"]},
              "candidate_replies": []}
    missing = {"case": "I00002", "_source": {"row_ids": ["absent"]},
               "inbound": {"message": "kept"}, "candidate_replies": []}
    no_ids = {"case": "I00003", "_source": {"row_ids": []},
              "inbound": {"message": "kept"}, "candidate_replies": []}
    index_rows = build_envelope_index([packet, missing, no_ids], merged)
    first = index_rows[0]
    check(first["source_rows"][0]["selected_source"] == "tail", "last_source_precedence")
    check(first["source_rows"][0]["duplicate_conflict"], "duplicate_conflict_recorded")
    check(first["source_rows"][0]["recipient_conflict_fields"] == ["to"], "recipient_conflict_fields")
    check(first["to"] == ["agent@outside.test"] and first["to_status"] == "known",
          "tail_address_used")
    check(first["cc"] is None and first["cc_status"] == "unknown_source_field",
          "empty_cc_is_unknown")
    check(missing["case"] == index_rows[1]["case"]
          and index_rows[1]["to_status"] == "unknown_source_coverage", "missing_source_unknown")
    check(index_rows[2]["source_status"] == "no_source_ids", "empty_source_id_unknown")
    check("body" not in first["source_rows"][0], "source_body_not_indexed")
    augmented, report = augment_packets([packet, missing, no_ids], index_rows)
    check(augmented[0]["inbound"]["to"] == ["agent@outside.test"], "to_augmented")
    check(augmented[0]["inbound"]["cc"] is None, "cc_null_augmented")
    check(augmented[0]["candidate_replies"] == [], "other_fields_preserved")
    check(report["packets"] == 3, "validation_happy_path")
    tampered = [dict(augmented[0], inbound={**augmented[0]["inbound"], "to": ["wrong@outside.test"]}),
                augmented[1], augmented[2]]
    try:
        validate_annotations([packet, missing, no_ids], index_rows, tampered)
    except EnvelopeFailure as exc:
        check(exc.code == "annotation_mismatch", "tamper_detected")
    else:
        raise EnvelopeFailure("self_test_tamper_not_detected")
    check(_parse_address_field([], present=True) == (None, "unknown_empty"),
          "normalized_empty_explicit_unknown")
    check(_parse_address_field(["Staff <staff@hotel.test>"], present=True)
          == (["staff@hotel.test"], "known"), "address_display_name_removed")
    check(checks == 15, "check_count")
    return checks


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("self-test", help="run synthetic source-precedence and validation checks")

    index_parser = commands.add_parser("index", help="bind source-row To/Cc to every input packet")
    index_parser.add_argument("--packets", required=True)
    index_parser.add_argument("--source", action="append", required=True,
                              help="ordered LABEL=PRIVATE_JSONL source; later source wins")
    index_parser.add_argument("--output", required=True)

    augment_parser = commands.add_parser("augment", help="add optional inbound.to/cc to packets")
    augment_parser.add_argument("--packets", required=True)
    augment_parser.add_argument("--index", required=True)
    augment_parser.add_argument("--output", required=True)

    validate_parser = commands.add_parser("validate", help="rebuild and validate every annotation")
    validate_parser.add_argument("--packets", required=True, help="original packet JSONL")
    validate_parser.add_argument("--index", required=True)
    validate_parser.add_argument("--augmented", required=True)
    validate_parser.add_argument("--source", action="append", required=True,
                                 help="same ordered LABEL=PRIVATE_JSONL inputs used by index")

    select_parser = commands.add_parser("select", help="make deterministic hotel-direction review subset")
    select_parser.add_argument("--packets", required=True, help="augmented packet JSONL")
    select_parser.add_argument("--index", required=True)
    select_parser.add_argument("--source", action="append", required=True,
                               help="same ordered LABEL=PRIVATE_JSONL sources")
    select_parser.add_argument("--output", required=True)
    select_parser.add_argument("--selection-output", required=True)
    select_parser.add_argument("--limit", type=int, default=20)
    select_parser.add_argument("--seed", required=True)
    select_parser.add_argument("--include-case", action="append", default=[])
    return parser


def main() -> None:
    args = _build_cli().parse_args()
    try:
        if args.command == "self-test":
            print(json.dumps({"self_test": "passed", "checks": self_test()}, sort_keys=True))
            return

        if args.command == "index":
            packets_path = _private_path(args.packets, existing=True)
            output_path = _private_path(args.output, existing=False)
            summary_path = _private_path(str(output_path) + ".summary.json", existing=False)
            source_specs = _parse_sources(args.source)
            packets = _read_jsonl(packets_path)
            source_rows, source_meta = load_source_rows(source_specs)
            index_rows = build_envelope_index(packets, source_rows)
            _write_jsonl(output_path, index_rows)
            summary = _summary(index_rows, source_meta, packets_path)
            _write_json(summary_path, summary)
            print(json.dumps({
                "index_rows": len(index_rows),
                "source_status_counts": summary["source_status_counts"],
                "field_status_counts": summary["field_status_counts"],
                "duplicate_conflict_ids": source_meta["summary"]["duplicate_conflict_ids"],
                "recipient_conflict_ids": source_meta["summary"]["recipient_conflict_ids"],
            }, sort_keys=True))
            return

        if args.command == "augment":
            packets = _read_jsonl(_private_path(args.packets, existing=True))
            index_rows = _read_jsonl(_private_path(args.index, existing=True))
            output = _private_path(args.output, existing=False)
            augmented, report = augment_packets(packets, index_rows)
            _write_jsonl(output, augmented)
            print(json.dumps(report, sort_keys=True))
            return

        if args.command == "validate":
            packets = _read_jsonl(_private_path(args.packets, existing=True))
            index_rows = _read_jsonl(_private_path(args.index, existing=True))
            augmented = _read_jsonl(_private_path(args.augmented, existing=True))
            source_specs = _parse_sources(args.source)
            source_rows, _ = load_source_rows(source_specs)
            report = validate_annotations(packets, index_rows, augmented, source_rows)
            print(json.dumps(report, sort_keys=True))
            return

        if args.command == "select":
            packets = _read_jsonl(_private_path(args.packets, existing=True))
            index_rows = _read_jsonl(_private_path(args.index, existing=True))
            source_specs = _parse_sources(args.source)
            source_rows, source_meta = load_source_rows(source_specs)
            # Also verify that every selected packet's annotation is source-bound.
            validate_annotations(packets, index_rows, packets, source_rows)
            selected, manifest = select_targeted_packets(
                packets, index_rows, source_meta["internal_domains"],
                limit=args.limit, seed=args.seed, include_cases=args.include_case,
            )
            output_path = _private_path(args.output, existing=False)
            manifest_path = _private_path(args.selection_output, existing=False)
            _write_jsonl(output_path, selected)
            _write_json(manifest_path, manifest)
            print(json.dumps({
                "candidate_count": manifest["candidate_count"],
                "selected_count": manifest["selected_count"],
                "strata_candidate_counts": manifest["strata_candidate_counts"],
                "strata_selected_counts": manifest["strata_selected_counts"],
            }, sort_keys=True))
            return
        raise EnvelopeFailure("command_invalid")
    except EnvelopeFailure as exc:
        raise SystemExit(exc.code) from None
    except (OSError, ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        raise SystemExit("io_or_json_error") from None


if __name__ == "__main__":
    main()
