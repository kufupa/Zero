#!/usr/bin/env python3
"""Aggregate Centurion pilot first-pass assessments; emit only aggregate output.

First pass means arm=cleaned, round=1, with one result from each of
luna_max_a, luna_max_b, and sol_high. The helper never calls a model or network.
Challenge packets preserve the prepared case_id/input/cleaning packet exactly;
the runner projects only input to the model. No assessment output, cohort, or
cue data is added to challenge packets.

Real inputs and outputs must be private children of the repository .private
anchor. Use --self-test for synthetic-only verification.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import unittest
from typing import Any, Iterable, Mapping, Sequence


VERSION = "centurion-pilot250-analysis-v1"
SLOTS = ("luna_max_a", "luna_max_b", "sol_high")
EXPECTED_SLOT_MODEL_EFFORT = {
    "luna_max_a": ("gpt-6-luna", "max"),
    "luna_max_b": ("gpt-6-luna", "max"),
    "sol_high": ("gpt-6.1-sol", "high"),
}
VERSION_PROVENANCE_FIELDS = (
    "prompt_sha256",
    "endpoint_sha256",
    "normalizer_code_sha256",
)
COHORTS = (
    "random_development",
    "targeted_development",
    "random_holdout",
    "embargoed_development",
)
DEV_COHORTS = ("random_development", "targeted_development")
MAX_JSON_BYTES = 512 * 1024 * 1024
MAX_JSONL_LINE_BYTES = 32 * 1024 * 1024
CASE_ID_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")

ACTION_LABELS = {
    "quote",
    "new_booking",
    "amendment",
    "person_cancellation_request",
    "cancellation_notice_no_action",
    "billing",
    "proof_of_payment",
    "other_payment",
    "voucher",
    "service",
    "group_event",
    "other",
    "marketing_spam",
    "no_current_work",
    "unknown",
}
KNOWN_NONACTION_LABELS = {
    "no_current_work",
    "cancellation_notice_no_action",
    "marketing_spam",
}
ROOM_ACTIONS = {"quote", "new_booking", "amendment", "group_event"}
ORIGIN_LABELS = {
    "channel_ota",
    "system_automated",
    "travel_agent",
    "direct",
    "internal",
    "mixed",
    "unknown",
}
HELP_LABELS = {"complete", "partial", "no_material_help", "unknown", "out_of_scope"}
FILE_CLAIMS = {"explicit_sender_claim", "attachment_metadata", "no_claim", "unknown"}
PAYMENT_CLAIMS = {"sender_claim", "no_claim", "unknown"}

MODEL_INPUT_KEYS = {"target", "prior_messages", "context_gaps"}
PACKET_KEYS = {"case_id", "input", "cleaning"}
CLEANING_KEYS = {"version", "flags", "privacy", "removals", "provenance"}
TARGET_KEYS = {
    "subject",
    "body",
    "stored_message_date",
    "sender_domain",
    "no_reply_sender_clue",
    "same_from_and_recipient",
    "attachment_inventory",
    "attachments",
}

METRICS = (
    "primary_work_type",
    "multi_action",
    "origin_label",
    "origin_ota_channel_flag",
    "origin_automated_flag",
    "document_pop_signal",
    "document_voucher_signal",
    "document_filing_trigger",
    "document_filing_assistance",
    "document_file_claim",
    "document_payment_claim",
    "over_10_room_exclusion",
    "any_help",
    "fully_preparable",
    "eligibility_for_K",
)


class AnalysisError(Exception):
    """Failure represented by a non-sensitive code only."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _private_root(repo_root: Path | None = None) -> Path:
    repo_root = repo_root or Path(__file__).resolve().parents[4]
    root = repo_root / ".private"
    try:
        info = root.lstat()
    except OSError:
        raise AnalysisError("private_root_unavailable") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise AnalysisError("private_root_not_directory")
    # The workspace anchor may be group-shared; descendants remain owner-only.
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o007:
        raise AnalysisError("private_root_permissions")
    return root.resolve(strict=True)


def _check_private_parents(path: Path, root: Path) -> None:
    current = path
    while current != root:
        try:
            info = current.stat()
        except OSError:
            raise AnalysisError("private_parent_unavailable") from None
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077
        ):
            raise AnalysisError("private_parent_permissions")
        if root not in current.parents:
            raise AnalysisError("path_outside_private_root")
        current = current.parent


def _private_input_path(argument: str | Path, root: Path, limit: int = MAX_JSON_BYTES) -> Path:
    supplied = Path(argument)
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    try:
        if supplied.is_symlink():
            raise AnalysisError("private_input_symlink")
        resolved = supplied.resolve(strict=True)
        resolved.relative_to(root)
        info = resolved.stat()
    except AnalysisError:
        raise
    except (OSError, ValueError):
        raise AnalysisError("private_input_path_invalid") from None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
        or info.st_size > limit
    ):
        raise AnalysisError("private_input_permissions_or_size")
    _check_private_parents(resolved.parent, root)
    return resolved


def _new_output_path(argument: str | Path, root: Path) -> Path:
    supplied = Path(argument)
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    try:
        parent = supplied.parent.resolve(strict=True)
    except OSError:
        raise AnalysisError("output_parent_invalid") from None
    if (
        parent != root
        or supplied.name in {"", ".", ".."}
        or os.path.lexists(supplied)
    ):
        raise AnalysisError("output_must_be_new_private_child")
    return root / supplied.name


def _read_json(path: Path) -> Any:
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_JSON_BYTES + 1)
    except OSError:
        raise AnalysisError("input_unreadable") from None
    if len(raw) > MAX_JSON_BYTES:
        raise AnalysisError("input_too_large")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise AnalysisError("input_invalid_json") from None


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("rb") as handle:
            total = 0
            for raw in handle:
                total += len(raw)
                if total > MAX_JSON_BYTES or len(raw) > MAX_JSONL_LINE_BYTES:
                    raise AnalysisError("jsonl_too_large")
                if not raw.strip():
                    continue
                try:
                    row = json.loads(raw.decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError):
                    raise AnalysisError("jsonl_invalid") from None
                if not isinstance(row, dict):
                    raise AnalysisError("jsonl_record_invalid")
                rows.append(row)
    except AnalysisError:
        raise
    except OSError:
        raise AnalysisError("input_unreadable") from None
    return rows


def _cohort_bucket(cohort: Any, embargoed: Any) -> tuple[str, str]:
    if not isinstance(cohort, str) or type(embargoed) is not bool:
        raise AnalysisError("manifest_cohort_invalid")
    normalized = cohort.replace("-", "_")
    if normalized not in {"random_development", "targeted_development", "random_holdout"}:
        raise AnalysisError("manifest_cohort_invalid")
    if normalized == "random_holdout":
        return normalized, "holdout"
    if embargoed:
        return "embargoed_development", "holdout"
    return normalized, "development"


def _validate_manifest(document: Any) -> tuple[str, dict[str, dict[str, Any]]]:
    if not isinstance(document, dict) or document.get("schema") != "centurion-pilot250-v1":
        raise AnalysisError("manifest_schema_invalid")
    seed = document.get("seed")
    selected = document.get("selected")
    if (
        not isinstance(seed, str)
        or not seed
        or len(seed) > 256
        or not isinstance(selected, list)
        or not selected
    ):
        raise AnalysisError("manifest_selection_invalid")

    result: dict[str, dict[str, Any]] = {}
    source_ids: set[str] = set()
    for row in selected:
        if not isinstance(row, dict):
            raise AnalysisError("manifest_row_invalid")
        case_id = row.get("case_id")
        source_row_id = row.get("source_row_id")
        if (
            not isinstance(case_id, str)
            or not CASE_ID_RE.fullmatch(case_id)
            or not isinstance(source_row_id, str)
            or not source_row_id
            or len(source_row_id) > 2048
        ):
            raise AnalysisError("manifest_identity_invalid")
        if case_id in result or source_row_id in source_ids:
            raise AnalysisError("manifest_duplicate_identity")
        bucket, expected_phase = _cohort_bucket(row.get("cohort"), row.get("embargoed"))
        result[case_id] = {
            "source_row_id": source_row_id,
            "cohort": bucket,
            "embargoed": row["embargoed"],
            "expected_phase": expected_phase,
        }
        source_ids.add(source_row_id)
    return seed, result


def _validate_packet_input(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != MODEL_INPUT_KEYS:
        return False
    target = value.get("target")
    prior = value.get("prior_messages")
    gaps = value.get("context_gaps")
    return (
        isinstance(target, dict)
        and set(target) == TARGET_KEYS
        and isinstance(prior, list)
        and all(isinstance(item, dict) for item in prior)
        and isinstance(gaps, list)
        and all(isinstance(item, str) for item in gaps)
    )


def _packet_map(
    records: Sequence[dict[str, Any]],
    manifest: Mapping[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    packets: dict[str, dict[str, Any]] = {}
    for row in records:
        if not isinstance(row, dict):
            raise AnalysisError("packet_record_invalid_or_duplicate")
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or case_id not in manifest:
            raise AnalysisError("packet_manifest_mismatch")
        cleaning = row.get("cleaning")
        if (
            case_id in packets
            or set(row) != PACKET_KEYS
            or not isinstance(cleaning, dict)
            or set(cleaning) != CLEANING_KEYS
            or not _validate_packet_input(row.get("input"))
        ):
            raise AnalysisError("packet_record_invalid_or_duplicate")
        # Keep the prepared packet object intact; its cleaning/provenance
        # metadata is private runner input, not part of the projected model input.
        packets[case_id] = row
    return packets


def _safe_hash(value: Any) -> str:
    if isinstance(value, str) and SHA256_RE.fullmatch(value.casefold()):
        return value.casefold()
    return "<missing>" if value is None else "<invalid>"


def _require_holdout_unsealed(
    records: Sequence[dict[str, Any]],
    holdout_unsealed: bool,
) -> None:
    if holdout_unsealed is not True and any(
        isinstance(row, dict) and row.get("phase") == "holdout"
        for row in records
    ):
        raise AnalysisError("holdout_unsealed_required")


def _first_pass_rows(
    records: Sequence[dict[str, Any]],
    manifest: Mapping[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, int]]]:
    versions: dict[
        str,
        dict[tuple[str, str, str, str, str, str], dict[str, Any]],
    ] = collections.defaultdict(dict)
    diagnostics: dict[str, collections.Counter[str]] = {
        cohort: collections.Counter() for cohort in COHORTS
    }
    first_seen = 0
    for row in records:
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or case_id not in manifest:
            raise AnalysisError("assessment_manifest_mismatch")
        if (
            row.get("arm") != "cleaned"
            or type(row.get("round")) is not int
            or row.get("round") != 1
            or row.get("phase") != manifest[case_id]["expected_phase"]
            or row.get("slot") not in SLOTS
        ):
            continue
        expected_model, expected_effort = EXPECTED_SLOT_MODEL_EFFORT[row["slot"]]
        if row.get("model") != expected_model or row.get("reasoning_effort") != expected_effort:
            raise AnalysisError("assessment_slot_model_effort_mismatch")
        provenance_hashes = tuple(_safe_hash(row.get(field)) for field in VERSION_PROVENANCE_FIELDS)
        if any(value.startswith("<") for value in provenance_hashes):
            raise AnalysisError("assessment_version_provenance_missing_or_invalid")
        signature = (
            str(row["phase"]),
            _safe_hash(row.get("arm_pair_sha256")),
            _safe_hash(row.get("input_sha256")),
            *provenance_hashes,
        )
        if any(value.startswith("<") for value in signature[1:]):
            # A record without all version hashes cannot establish which
            # packet/prompt/endpoint it assessed. Do not let it join a triad or
            # shadow a later verifiable first-pass group.
            diagnostics[manifest[case_id]["cohort"]]["records_with_unverifiable_version_hashes"] += 1
            first_seen += 1
            continue
        if signature not in versions[case_id]:
            versions[case_id][signature] = {"order": first_seen, "slots": {}, "duplicates": 0}
        group = versions[case_id][signature]
        slot = row["slot"]
        if slot in group["slots"]:
            group["duplicates"] += 1
        # Assessment JSONL is append-only; latest same-signature record is runner's active result.
        group["slots"][slot] = row
        first_seen += 1

    chosen: dict[str, dict[str, Any]] = {}
    for case_id, candidates in versions.items():
        entry = manifest[case_id]
        ordered = sorted(candidates.items(), key=lambda pair: pair[1]["order"])
        if len(ordered) > 1:
            diagnostics[entry["cohort"]]["cases_with_multiple_first_pass_versions"] += 1
        if len({signature[4] for signature, _group in ordered}) > 1:
            diagnostics[entry["cohort"]]["cases_with_multiple_first_pass_endpoints"] += 1
        signature, group = ordered[0]
        chosen[case_id] = {"signature": signature, "slots": group["slots"]}
        diagnostics[entry["cohort"]]["duplicate_attempt_records"] += group["duplicates"]
        diagnostics[entry["cohort"]]["selected_first_pass_records"] += len(group["slots"])
    for signature_index in (3, 4, 5):
        versions_across_cases = {
            case["signature"][signature_index]
            for case in chosen.values()
        }
        if len(versions_across_cases) > 1:
            raise AnalysisError("first_pass_provenance_not_uniform")
    return chosen, {key: dict(value) for key, value in diagnostics.items()}


def _ternary(value: Any) -> str:
    if value is True or value == "yes":
        return "yes"
    if value is False or value == "no":
        return "no"
    return "unknown"


def _valid_index(item: Mapping[str, Any], key: str) -> int | None | object:
    if key not in item:
        return None
    value = item[key]
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9999:
        return value
    return _INVALID


_INVALID = object()


def _document_bundle_groups(documents: Sequence[Any]) -> set[int]:
    groups: dict[tuple[Any, ...], set[str]] = collections.defaultdict(set)
    for index, item in enumerate(documents):
        if not isinstance(item, dict):
            continue
        kinds = item.get("kinds")
        stay = item.get("stay_index")
        if (
            isinstance(kinds, list)
            and item.get("filing_trigger") != "no"
            and isinstance(stay, int)
            and not isinstance(stay, bool)
        ):
            file_index = item.get("file_index")
            key = (stay, "file", file_index) if isinstance(file_index, int) and not isinstance(file_index, bool) \
                else (stay, "unidentified_document", index)
            groups[key].update(kind for kind in kinds if kind in {"proof_of_payment", "voucher"})
    by_stay: dict[int, list[set[str]]] = collections.defaultdict(list)
    for key, kinds in groups.items():
        if kinds:
            by_stay[key[0]].append(kinds)
    return {
        stay for stay, candidates in by_stay.items()
        if len(candidates) == 1 and {"proof_of_payment", "voucher"}.issubset(candidates[0])
    }


def _positive_filing_missing_work_label(items: Sequence[Mapping[str, Any]], documents: Sequence[Any]) -> bool:
    """Return true when a positive filing document contradicts work labels."""
    allowed_kinds = {"proof_of_payment", "voucher", "other_document", "unknown"}
    filing_actions = {"proof_of_payment", "voucher"}
    for document in documents:
        if not isinstance(document, dict) or document.get("filing_trigger") != "yes":
            continue
        kinds = document.get("kinds")
        if (
            not isinstance(kinds, list)
            or not kinds
            or any(not isinstance(kind, str) or kind not in allowed_kinds for kind in kinds)
            or "unknown" in kinds
        ):
            return True
        required_actions = set(kinds) & filing_actions
        # A positive filing trigger without a recognized POP/voucher kind is
        # incomplete for this work-type taxonomy, so do not guess its label.
        work_actions_for_stay = {
            item.get("action") for item in items
            if item.get("stay_index") == document.get("stay_index")
        }
        if not required_actions or not required_actions.issubset(work_actions_for_stay):
            return True
    return False


def _work_features(normalized: Mapping[str, Any]) -> tuple[str, str]:
    raw_items = normalized.get("work_items")
    raw_documents = normalized.get("documents")
    if not isinstance(raw_items, list) or not raw_items:
        return "unknown", "unknown"
    if not isinstance(raw_documents, list):
        raw_documents = []
    items: list[dict[str, Any]] = [item for item in raw_items if isinstance(item, dict)]
    if len(items) != len(raw_items):
        return "unknown", "unknown"
    actions = [item.get("action") for item in items]
    if any(action not in ACTION_LABELS or action == "unknown" for action in actions):
        return "unknown", "unknown"
    if _positive_filing_missing_work_label(items, raw_documents):
        return "unknown", "unknown"

    # Cancellation/system notices and no-current-work markers do not count as
    # a second task. Marketing spam remains an explicit work-type label, so it
    # stays visible when the same message also contains real work.
    active = [
        item for item in items
        if item["action"] not in {"no_current_work", "cancellation_notice_no_action"}
    ]
    if not active:
        if "cancellation_notice_no_action" in actions:
            primary = "cancellation_notice_no_action"
        else:
            primary = "no_current_work"
        return primary, "no"

    bundle_stays = _document_bundle_groups(raw_documents)
    effective_keys: set[tuple[int | None, int | None, str]] = set()
    effective_types: set[str] = set()
    for item in active:
        episode = _valid_index(item, "episode_index")
        stay = _valid_index(item, "stay_index")
        if episode is _INVALID or stay is _INVALID:
            return "unknown", "unknown"
        action = item["action"]
        if (
            action in {"proof_of_payment", "voucher"}
            and stay in bundle_stays
            and any(
                other.get("action") in {"proof_of_payment", "voucher"}
                and other.get("stay_index") == stay
                and _valid_index(other, "episode_index") == episode
                and other.get("action") != action
                for other in active
            )
        ):
            action = "document_filing"
        effective_keys.add((episode, stay, action))
        effective_types.add(action)

    if effective_types == {"document_filing"}:
        primary = "proof_of_payment_and_voucher"
    elif len(effective_types) == 1:
        primary = next(iter(effective_types))
    else:
        primary = "multiple_work_types"
    return primary, "yes" if len(effective_keys) > 1 else "no"


def _document_features(normalized: Mapping[str, Any]) -> dict[str, str]:
    work_items = normalized.get("work_items")
    documents = normalized.get("documents")
    if not isinstance(work_items, list) or not isinstance(documents, list):
        return {
            "document_pop_signal": "unknown",
            "document_voucher_signal": "unknown",
            "document_filing_trigger": "unknown",
            "document_filing_assistance": "unknown",
            "document_file_claim": "unknown",
            "document_payment_claim": "unknown",
        }
    item_actions = {
        item.get("action") for item in work_items if isinstance(item, dict)
    }
    doc_kinds: set[str] = set()
    valid_docs: list[dict[str, Any]] = []
    for document in documents:
        if not isinstance(document, dict):
            return {
                "document_pop_signal": "unknown",
                "document_voucher_signal": "unknown",
                "document_filing_trigger": "unknown",
                "document_filing_assistance": "unknown",
                "document_file_claim": "unknown",
                "document_payment_claim": "unknown",
            }
        valid_docs.append(document)
        kinds = document.get("kinds")
        if isinstance(kinds, list):
            doc_kinds.update(kind for kind in kinds if isinstance(kind, str))
        else:
            doc_kinds.add("unknown")

    action_unknown = "unknown" in item_actions or any(action not in ACTION_LABELS for action in item_actions)

    def signal(kind: str) -> str:
        if kind in item_actions or kind in doc_kinds:
            return "present"
        if action_unknown or "unknown" in doc_kinds:
            return "unknown"
        return "not_labelled"

    if not valid_docs:
        trigger = "not_reported"
        filing_help = "not_reported"
        file_claim = "not_reported"
        payment_claim = "not_reported"
    else:
        triggers = [item.get("filing_trigger") for item in valid_docs]
        if "yes" in triggers:
            trigger = "yes"
        elif any(value not in {"no", "unknown"} for value in triggers) or "unknown" in triggers:
            trigger = "unknown"
        else:
            trigger = "no"

        trigger_docs = [item for item in valid_docs if item.get("filing_trigger") == "yes"]
        if trigger_docs:
            help_values = [
                item.get("filing_assistance")
                if item.get("filing_assistance") in HELP_LABELS
                else "unknown"
                for item in trigger_docs
            ]
            filing_help = help_values[0] if len(set(help_values)) == 1 else "mixed"
        elif "unknown" in triggers:
            filing_help = "unknown"
        else:
            filing_help = "not_reported"

        def combined_label(field: str, allowed: set[str]) -> str:
            values = [
                item.get(field) if item.get(field) in allowed else "unknown"
                for item in valid_docs
            ]
            return values[0] if len(set(values)) == 1 else "mixed"

        file_claim = combined_label("file_claim", FILE_CLAIMS)
        payment_claim = combined_label("payment_claim", PAYMENT_CLAIMS)

    return {
        "document_pop_signal": signal("proof_of_payment"),
        "document_voucher_signal": signal("voucher"),
        "document_filing_trigger": trigger,
        "document_filing_assistance": filing_help,
        "document_file_claim": file_claim,
        "document_payment_claim": payment_claim,
    }


def _over_ten_feature(normalized: Mapping[str, Any]) -> str:
    items = normalized.get("work_items")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        return "unknown"
    room_items = [item for item in items if item.get("action") in ROOM_ACTIONS]
    if not room_items:
        if any(item.get("action") == "unknown" for item in items):
            return "unknown"
        return "not_applicable"
    counts = [item.get("requested_room_count") for item in room_items]
    episode_totals = [item.get("episode_total_room_count") for item in room_items]
    if any(
        isinstance(count, int) and not isinstance(count, bool) and count > 10
        for count in counts + episode_totals
    ):
        return "yes"
    if any(item.get("action") == "unknown" for item in items):
        return "unknown"
    if any(
        not isinstance(count, int) or isinstance(count, bool) or count < 0
        for count in counts
    ):
        return "unknown"
    if len(room_items) == 1:
        return "no"

    # The runner sets an episode total only after validating the relationship
    # between room allocations and clears it when separation is uncertain.
    # Distinct model-supplied indices alone do not prove separate requests.
    return "no" if all(
        isinstance(total, int) and not isinstance(total, bool) and 0 <= total <= 10
        for total in episode_totals
    ) else "unknown"


def _eligibility_for_K(normalized: Mapping[str, Any]) -> str:
    items = normalized.get("work_items")
    documents = normalized.get("documents")
    if not isinstance(items, list) or not isinstance(documents, list):
        return "unknown"
    positive = False
    uncertain = False
    for item in items:
        if not isinstance(item, dict):
            uncertain = True
            continue
        action = item.get("action")
        if action in KNOWN_NONACTION_LABELS:
            # These labels are known non-actionable despite normalized scope=unknown.
            continue
        if action not in ACTION_LABELS or action == "unknown":
            uncertain = True
            continue
        if action in {"proof_of_payment", "voucher"}:
            # These work labels are document signals. Only a corresponding
            # filing task, evaluated below, establishes actionable eligibility.
            matching = any(
                isinstance(document, dict)
                and isinstance(document.get("kinds"), list)
                and action in document.get("kinds", [])
                and document.get("stay_index") == item.get("stay_index")
                and document.get("filing_trigger") != "no"
                for document in documents
            )
            if not matching:
                uncertain = True
            continue
        scope = item.get("scope")
        if scope == "in_scope":
            positive = True
        elif scope in {"unknown", "policy_conflict"}:
            uncertain = True
        elif scope != "out_of_scope":
            uncertain = True
    for document in documents:
        if not isinstance(document, dict):
            uncertain = True
            continue
        trigger = document.get("filing_trigger")
        scope = document.get("filing_scope")
        kinds = document.get("kinds")
        possible_filing = isinstance(kinds, list) and any(
            kind in {"proof_of_payment", "voucher", "unknown"} for kind in kinds
        )
        if trigger == "yes":
            if scope == "in_scope":
                positive = True
            elif scope in {"unknown", "policy_conflict"}:
                uncertain = True
        elif trigger == "unknown" and possible_filing:
            uncertain = True
    if positive:
        return "yes"
    return "unknown" if uncertain else "no"


def _record_status(record: dict[str, Any] | None) -> str:
    if record is None:
        return "missing"
    status = record.get("status")
    if status == "withheld":
        return "withheld"
    if status == "error":
        return "failed"
    if status != "ok":
        return "failed"
    if record.get("parse_status") != "valid":
        return "invalid"
    normalized = record.get("normalized")
    if (
        not isinstance(normalized, dict)
        or not isinstance(normalized.get("origin"), dict)
        or not isinstance(normalized.get("work_items"), list)
        or not isinstance(normalized.get("documents"), list)
        or not isinstance(normalized.get("rollup"), dict)
    ):
        return "invalid"
    return "valid"


def _features(normalized: Mapping[str, Any]) -> dict[str, str]:
    work_type, multi_action = _work_features(normalized)
    origin = normalized.get("origin")
    if not isinstance(origin, dict):
        origin = {}

    def origin_flag(*names: str) -> str:
        values = {_ternary(origin[name]) for name in names if name in origin}
        return next(iter(values)) if len(values) == 1 else "unknown"

    origin_label = origin.get("label")
    if origin_label not in ORIGIN_LABELS:
        origin_label = "unknown"
    rollup = normalized.get("rollup")
    if not isinstance(rollup, dict):
        rollup = {}
    any_help = rollup.get("any_help")
    fully_preparable = rollup.get("fully_preparable")
    if any_help not in {"yes", "no", "unknown"}:
        any_help = "unknown"
    if fully_preparable not in {"yes", "no", "unknown"}:
        fully_preparable = "unknown"
    return {
        "primary_work_type": work_type,
        "multi_action": multi_action,
        "origin_label": origin_label,
        # Support both the current normalized assessment schema and the
        # evaluator's clearer flag names; conflicting aliases stay unknown.
        "origin_ota_channel_flag": origin_flag("ota_channel_flag", "channel_ota"),
        "origin_automated_flag": origin_flag("automated_flag", "automated"),
        **_document_features(normalized),
        "over_10_room_exclusion": _over_ten_feature(normalized),
        "any_help": any_help,
        "fully_preparable": fully_preparable,
        "eligibility_for_K": _eligibility_for_K(normalized),
    }


def _quote_instances(normalized: Mapping[str, Any]) -> list[str]:
    found: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(key, str) and key.endswith("_quotes") and isinstance(item, list):
                    found.extend(text for text in item if isinstance(text, str) and text)
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(normalized)
    return found


def _input_texts(value: Any) -> list[str]:
    result: list[str] = []
    if isinstance(value, str):
        result.append(value)
    elif isinstance(value, list):
        for item in value:
            result.extend(_input_texts(item))
    elif isinstance(value, dict):
        for item in value.values():
            result.extend(_input_texts(item))
    return result


def _consensus(values: Sequence[str], complete: bool) -> str:
    if not complete or not values or any(value != values[0] for value in values[1:]):
        return "unknown"
    return values[0]


def _hash_rank(seed: str, source_row_id: str) -> str:
    material = seed.encode("utf-8") + b"\0agreement-check\0" + source_row_id.encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _counter_json(counter: Mapping[str, int]) -> dict[str, int]:
    return {key: int(counter[key]) for key in sorted(counter) if counter[key]}


def _rate(numerator: int, denominator: int) -> dict[str, Any]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rate": round(numerator / denominator, 6) if denominator else None,
    }


def _sample_k_h(cases: Sequence[dict[str, Any]]) -> dict[str, Any]:
    eligible = [case["k_state"] for case in cases]
    total = len(cases)
    known_K = sum(value == "yes" for value in eligible)
    known_H = sum(case["k_state"] == "yes" and case["h_state"] == "yes" for case in cases)
    unknown_help = sum(case["k_state"] == "yes" and case["h_state"] == "unknown" for case in cases)
    unknown_eligibility = sum(value == "unknown" for value in eligible)
    upper_numerator = known_H + unknown_help + unknown_eligibility
    sensitivity_denominator = known_K + unknown_eligibility
    return {
        "E": total,
        "K": known_K,
        "H": known_H,
        "U_h": unknown_help,
        "U_e": unknown_eligibility,
        "known_K_not_helped": max(0, known_K - known_H - unknown_help),
        "H_over_E": {
            "lower": _rate(known_H, total),
            "unknown_sensitivity_upper": _rate(upper_numerator, total),
        },
        "H_over_K": {
            "lower": (
                _rate(known_H, sensitivity_denominator)
                if sensitivity_denominator else None
            ),
            "unknown_sensitivity_upper": (
                _rate(upper_numerator, sensitivity_denominator)
                if sensitivity_denominator else None
            ),
            "known_K_only_rate": _rate(known_H, known_K) if known_K else None,
            "sensitivity_unavailable_reason": (
                "K_and_U_e_are_zero" if not sensitivity_denominator else None
            ),
        },
        "interpretation": "strict-triad sample description only; no population projection",
        "rules": {
            "E": "all selected manifest rows in this cohort, including missing or failed assessments",
            "K": "all three valid assessments identify at least one known in-scope work or filing unit",
            "H": "K row where all three normalized any_help rollups are yes",
            "U_h": "K row without unanimous yes/no help status",
            "U_e": "row with unresolved eligibility, including missing/failed model assessments",
            "known_nonactionable": "no_current_work, cancellation_notice_no_action, and marketing_spam",
            "mixed_tasks": "a known in-scope unit may establish row-level K; unresolved units remain unknown in task metrics",
        },
    }


def _make_case_details(
    manifest: Mapping[str, dict[str, Any]],
    first_pass: Mapping[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for case_id, entry in manifest.items():
        group = first_pass.get(case_id, {})
        selected_slots = group.get("slots", {})
        slot_data: dict[str, dict[str, Any]] = {}
        for slot in SLOTS:
            record = selected_slots.get(slot)
            status = _record_status(record)
            normalized = record.get("normalized") if status == "valid" else None
            features = _features(normalized) if isinstance(normalized, dict) else {
                metric: "unknown" for metric in METRICS
            }
            slot_data[slot] = {
                "status": status,
                "record": record,
                "features": features,
            }
        complete = all(slot_data[slot]["status"] == "valid" for slot in SLOTS)
        metric_values: dict[str, list[str]] = {
            metric: [slot_data[slot]["features"][metric] for slot in SLOTS]
            for metric in METRICS
        }
        metric_consensus = {
            metric: _consensus(values, complete)
            for metric, values in metric_values.items()
        }
        if not complete:
            decision_status = "incomplete"
        elif any(len(set(values)) > 1 for values in metric_values.values()):
            decision_status = "disagreement"
        elif any(value == "unknown" for value in metric_consensus.values()):
            decision_status = "unanimous_unknown"
        else:
            decision_status = "agreement"
        k_state = metric_consensus["eligibility_for_K"]
        h_state = metric_consensus["any_help"]
        if k_state == "no" and h_state == "yes":
            k_state = "unknown"
            h_state = "unknown"
        cases.append({
            "case_id": case_id,
            "source_row_id": entry["source_row_id"],
            "cohort": entry["cohort"],
            "slot_data": slot_data,
            "complete": complete,
            "metric_values": metric_values,
            "metric_consensus": metric_consensus,
            "decision_status": decision_status,
            "k_state": k_state,
            "h_state": h_state,
        })
    return cases


def _citation_summary(
    cases: Sequence[dict[str, Any]],
    originals: Mapping[str, dict[str, Any]],
    original_packets_supplied: bool,
) -> dict[str, Any]:
    by_slot: dict[str, dict[str, Any]] = {}
    for slot in SLOTS:
        by_slot[slot] = {
            "valid_assessments": 0,
            "assessments_without_original_packet": 0,
            "quote_instances_not_audited": 0,
            "quote_instances_checked": 0,
            "literal_matches_in_guarded_original": 0,
            "missing_from_guarded_original": 0,
            "assessments_with_missing_quotes": 0,
        }
    cases_with_original = sum(case["case_id"] in originals for case in cases)
    cases_with_missing_quotes = 0
    for case in cases:
        original_packet = originals.get(case["case_id"])
        texts = _input_texts(original_packet["input"]) if original_packet else []
        case_missing = False
        for slot in SLOTS:
            slot_info = case["slot_data"][slot]
            if slot_info["status"] != "valid":
                continue
            by_slot[slot]["valid_assessments"] += 1
            normalized = slot_info["record"]["normalized"]
            quotes = _quote_instances(normalized)
            if original_packet is None:
                by_slot[slot]["assessments_without_original_packet"] += 1
                by_slot[slot]["quote_instances_not_audited"] += len(quotes)
                continue
            slot_missing = False
            for quote in quotes:
                by_slot[slot]["quote_instances_checked"] += 1
                if any(quote in text for text in texts):
                    by_slot[slot]["literal_matches_in_guarded_original"] += 1
                else:
                    by_slot[slot]["missing_from_guarded_original"] += 1
                    slot_missing = True
                    case_missing = True
            if slot_missing:
                by_slot[slot]["assessments_with_missing_quotes"] += 1
        if case_missing:
            cases_with_missing_quotes += 1
    return {
        "available": original_packets_supplied,
        "cases_with_original_packet": cases_with_original,
        "cases_without_original_packet": len(cases) - cases_with_original,
        "cases_with_missing_quotes": cases_with_missing_quotes,
        "by_slot": by_slot,
        "method": "literal substring check against corresponding guarded-original packet input; quote text is never emitted",
    }


def _cohort_summary(
    cases: Sequence[dict[str, Any]],
    originals: Mapping[str, dict[str, Any]],
    original_packets_supplied: bool,
    diagnostics: Mapping[str, int],
) -> dict[str, Any]:
    per_slot: dict[str, dict[str, Any]] = {}
    for slot in SLOTS:
        status_counts: collections.Counter[str] = collections.Counter()
        category_counts: dict[str, collections.Counter[str]] = {
            metric: collections.Counter() for metric in METRICS
        }
        slot_cases: list[dict[str, str]] = []
        for case in cases:
            slot_info = case["slot_data"][slot]
            status_counts[slot_info["status"]] += 1
            if slot_info["status"] == "valid":
                for metric, value in slot_info["features"].items():
                    category_counts[metric][value] += 1
                k_state = slot_info["features"]["eligibility_for_K"]
                h_state = slot_info["features"]["any_help"]
                if k_state == "no" and h_state == "yes":
                    k_state = h_state = "unknown"
            else:
                k_state = h_state = "unknown"
            slot_cases.append({"k_state": k_state, "h_state": h_state})
        slot_sensitivity = _sample_k_h(slot_cases)
        slot_sensitivity["interpretation"] = (
            "single model-slot sample description only; no population projection or accuracy claim"
        )
        slot_sensitivity["rules"]["K"] = (
            "valid slot identifies at least one known in-scope work or filing unit"
        )
        slot_sensitivity["rules"]["H"] = "K row where that slot's any_help rollup is yes"
        per_slot[slot] = {
            "expected_cases": len(cases),
            "record_status_counts": _counter_json(status_counts),
            "category_counts": {
                metric: _counter_json(counts)
                for metric, counts in category_counts.items()
            },
            "sample_K_H_sensitivity": slot_sensitivity,
        }

    metric_summary: dict[str, Any] = {}
    case_status_counts: collections.Counter[str] = collections.Counter()
    complete_triplets = 0
    missing_slot_cases = 0
    failed_or_invalid_cases = 0
    for case in cases:
        case_status_counts[case["decision_status"]] += 1
        statuses = [case["slot_data"][slot]["status"] for slot in SLOTS]
        if case["complete"]:
            complete_triplets += 1
        if "missing" in statuses:
            missing_slot_cases += 1
        if any(status in {"failed", "withheld", "invalid"} for status in statuses):
            failed_or_invalid_cases += 1
    for metric in METRICS:
        unanimous: collections.Counter[str] = collections.Counter()
        disagreements = incomplete = any_unknown = 0
        for case in cases:
            if not case["complete"]:
                incomplete += 1
                continue
            values = case["metric_values"][metric]
            if len(set(values)) == 1:
                unanimous[values[0]] += 1
            else:
                disagreements += 1
            if "unknown" in values:
                any_unknown += 1
        metric_summary[metric] = {
            "unanimous_counts": _counter_json(unanimous),
            "disagreement_cases": disagreements,
            "incomplete_cases": incomplete,
            "cases_with_at_least_one_unknown_label": any_unknown,
        }
    return {
        "manifest_cases": len(cases),
        "assessment_coverage": {
            "three_valid_slots": complete_triplets,
            "cases_missing_at_least_one_slot": missing_slot_cases,
            "cases_with_failed_withheld_or_invalid_slot": failed_or_invalid_cases,
            "case_consensus_status_counts": _counter_json(case_status_counts),
            **dict(diagnostics),
            "slots": per_slot,
        },
        "strict_three_slot_unanimity": metric_summary,
        "sample_K_H_sensitivity": _sample_k_h(cases),
        "guarded_original_citation_audit": _citation_summary(
            cases, originals, original_packets_supplied
        ),
    }


def analyze_data(
    manifest_document: Any,
    assessment_records: Sequence[dict[str, Any]],
    cleaned_packet_records: Sequence[dict[str, Any]],
    original_packet_records: Sequence[dict[str, Any]] = (),
    *,
    original_packets_supplied: bool | None = None,
    holdout_unsealed: bool = False,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    _require_holdout_unsealed(assessment_records, holdout_unsealed)
    seed, manifest = _validate_manifest(manifest_document)
    cleaned = _packet_map(cleaned_packet_records, manifest)
    originals = _packet_map(original_packet_records, manifest) if original_packet_records else {}
    has_original_input = (
        bool(original_packet_records)
        if original_packets_supplied is None
        else original_packets_supplied
    )
    first_pass, diagnostics = _first_pass_rows(assessment_records, manifest)
    cases = _make_case_details(manifest, first_pass)
    by_cohort: dict[str, list[dict[str, Any]]] = {
        cohort: [case for case in cases if case["cohort"] == cohort]
        for cohort in COHORTS
    }
    summary = {
        "analysis_version": VERSION,
        "first_pass_definition": {
            "arm": "cleaned",
            "round": 1,
            "slots": list(SLOTS),
            "record_version_rule": "earliest matching phase/input/arm-pair/prompt/endpoint/normalizer signature per case; latest appended record per slot within that signature",
            "uniform_provenance_fields": list(VERSION_PROVENANCE_FIELDS),
            "slot_model_effort": {
                slot: {"model": model, "reasoning_effort": effort}
                for slot, (model, effort) in EXPECTED_SLOT_MODEL_EFFORT.items()
            },
            "unanimity_rule": "all three slots must be valid; no majority label",
        },
        "claims": {
            "accuracy_claim": "none",
            "population_projection": "none",
            "agreement_is_truth": False,
            "cohort_results_are_separate": True,
            "oversampled_cohorts_are_not_combined": True,
        },
        "measurement_rules": [
            "Missing, failed, withheld, invalid, and unknown assessments remain visible; they never count as a vote.",
            "Origin label, OTA/channel flag, automated flag, and work type are separate; origin never excludes work.",
            "POP/voucher not_labelled or not_reported means model did not label a signal, not that no file existed.",
            "A multi-model agreement is descriptive only, not ground truth or accuracy.",
            "K means unanimous model-level evidence of at least one in-scope actionable task or filing task; H means K plus unanimous any_help=yes. These are model-labelled sample descriptions, not observed help or ground truth.",
            "No-current-work, cancellation_notice_no_action, and marketing_spam count as known non-actionable for K even when scope is unknown.",
            "Unknown sensitivity uses H/E bounds H/E to (H+U_h+U_e)/E and H/K bounds H/(K+U_e) to (H+U_h+U_e)/(K+U_e), within each cohort only; known-K-only H/K is reported separately.",
            "The saved source has no inbound attachment inventory or bytes; unknown/not_reported is not evidence that a document or image was absent.",
            "More than 10 is yes only for an explicit per-task room count; multiple small totals are not summed without a proven request-episode relation.",
            "Challenge pool is unembargoed random/targeted development only; holdout and embargoed development are excluded.",
        ],
        "cohorts": {},
    }
    for cohort in COHORTS:
        summary["cohorts"][cohort] = _cohort_summary(
            by_cohort[cohort],
            originals,
            has_original_input,
            diagnostics.get(cohort, {}),
        )

    challenge_candidates: dict[str, list[dict[str, Any]]] = {
        cohort: [] for cohort in DEV_COHORTS
    }
    disagreement_counts: collections.Counter[str] = collections.Counter()
    agreement_cases: list[dict[str, Any]] = []
    for case in cases:
        cohort = case["cohort"]
        if cohort not in DEV_COHORTS:
            continue
        status = case["decision_status"]
        if status in {"agreement", "unanimous_unknown"}:
            agreement_cases.append(case)
        elif status == "disagreement":
            challenge_candidates[cohort].append(case)
            disagreement_counts[cohort] += 1
    agreement_cases.sort(
        key=lambda case: (
            _hash_rank(seed, case["source_row_id"]),
            case["case_id"],
        )
    )
    agreement_selected = agreement_cases[:20]
    selected_by_cohort: dict[str, list[dict[str, Any]]] = {
        cohort: list(challenge_candidates[cohort]) for cohort in DEV_COHORTS
    }
    for case in agreement_selected:
        selected_by_cohort[case["cohort"]].append(case)

    challenge_packets: dict[str, list[dict[str, Any]]] = {cohort: [] for cohort in DEV_COHORTS}
    challenge_by_cohort: dict[str, dict[str, int]] = {}
    for cohort in DEV_COHORTS:
        selected_cases = sorted(
            selected_by_cohort[cohort],
            key=lambda case: (_hash_rank(seed, case["source_row_id"]), case["case_id"]),
        )
        missing_packets = 0
        reasons: collections.Counter[str] = collections.Counter()
        for case in selected_cases:
            reasons[case["decision_status"]] += 1
            packet = cleaned.get(case["case_id"])
            if packet is None:
                missing_packets += 1
                continue
            # Preserve the exact prepared cleaned packet for the runner's
            # provenance re-derivation. The runner projects only packet["input"].
            challenge_packets[cohort].append(packet)
        challenge_by_cohort[cohort] = {
            "selected_cases": len(selected_cases),
            "all_disagreement_cases": len(challenge_candidates[cohort]),
            "disagreement_cases": disagreement_counts[cohort],
            "agreement_candidates": sum(case["cohort"] == cohort for case in agreement_cases),
            "agreement_check_selected": sum(case["cohort"] == cohort for case in agreement_selected),
            "challenge_packets_written": len(challenge_packets[cohort]),
            "selected_cases_missing_cleaned_packet": missing_packets,
            "selected_decision_status_counts": _counter_json(reasons),
        }
    summary["challenge_selection"] = {
        "agreement_check_target": 20,
        "agreement_check_selected": len(agreement_selected),
        "all_dev_disagreements_selected": True,
        "incomplete_cases_added": False,
        "unanimous_unknown_cases_treated_as_agreement_candidates": True,
        "agreement_rank_formula": "SHA256(seed + NUL + 'agreement-check' + NUL + sourceRowId)",
        "challenge_packets_written": sum(len(rows) for rows in challenge_packets.values()),
        "by_cohort": challenge_by_cohort,
    }
    return summary, challenge_packets


def _write_private_file(path: Path, payloads: Iterable[dict[str, Any]]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except OSError:
        raise AnalysisError("output_file_create_failed") from None
    try:
        os.fchmod(fd, 0o600)
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise AnalysisError("output_file_permissions")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            fd = -1
            for payload in payloads:
                handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
    except AnalysisError:
        raise
    except (OSError, TypeError, ValueError, UnicodeError):
        raise AnalysisError("output_write_failed") from None
    finally:
        if fd >= 0:
            os.close(fd)


def write_outputs(
    output_dir: Path,
    summary: dict[str, Any],
    challenge_packets: Mapping[str, Sequence[dict[str, Any]]],
) -> None:
    if os.path.lexists(output_dir):
        raise AnalysisError("output_directory_exists")
    try:
        os.mkdir(output_dir, 0o700)
        os.chmod(output_dir, 0o700)
    except OSError:
        raise AnalysisError("output_directory_create_failed") from None
    for cohort in DEV_COHORTS:
        cohort_dir = output_dir / cohort
        try:
            os.mkdir(cohort_dir, 0o700)
            os.chmod(cohort_dir, 0o700)
        except OSError:
            raise AnalysisError("challenge_cohort_directory_failed") from None
        _write_private_file(cohort_dir / "challenge.jsonl", challenge_packets.get(cohort, ()))
    _write_private_file(output_dir / "summary.json", [summary])


def _synthetic_normalized(
    *,
    action: str = "quote",
    scope: str = "in_scope",
    assistance: str = "partial",
    any_help: str = "yes",
    fully_preparable: str = "no",
    quote: str = "Synthetic evidence phrase.",
    room_count: int | None = None,
    origin_flags: tuple[str, str] = ("no", "no"),
    documents: list[dict[str, Any]] | None = None,
    extra_unknown_action: bool = False,
) -> dict[str, Any]:
    actions = [action]
    if extra_unknown_action:
        actions.append("unknown")
    work_items: list[dict[str, Any]] = []
    for item_action in actions:
        unknown = item_action == "unknown"
        work_items.append({
            "action": item_action,
            "stay_index": None if unknown or item_action == "no_current_work" else 0,
            "episode_index": 0 if not unknown else None,
            "episode_evidence_quotes": [quote] if not unknown else [],
            "scope": "unknown" if unknown or item_action == "no_current_work" else scope,
            "requested_room_count": room_count if item_action != "unknown" else None,
            "room_count_quotes": [quote] if room_count is not None and item_action != "unknown" else [],
            "rooms_individually_specified": "unknown",
            "room_details_evidence_quotes": [],
            "group_spreadsheet_or_linked_requirement": "unknown",
            "relationship_evidence_quotes": [],
            "assistance": "unknown" if unknown else assistance,
            "capability_ids": [],
            "evidence_quotes": [] if unknown else [quote],
        })
    if action == "no_current_work":
        work_items[0]["scope"] = "unknown"
        work_items[0]["assistance"] = "no_material_help"
    return {
        "origin": {
            "label": "direct",
            "channel_ota": origin_flags[0],
            "channel_ota_evidence_quotes": [quote],
            "automated": origin_flags[1],
            "automated_evidence_quotes": [quote],
            "evidence_quotes": [quote],
        },
        "work_items": work_items,
        "documents": documents or [],
        "rollup": {
            "any_help": any_help,
            "fully_preparable": fully_preparable,
            "status": "material_tasks",
            "material_task_count": 1,
            "task_states": {},
        },
        "attachment_bytes_status": "not_sent_not_verified",
        "payment_clearance_status": "not_assessed_from_message_packet",
    }


def _synthetic_document() -> dict[str, Any]:
    return {
        "stay_index": 0,
        "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim",
        "filing_trigger": "yes",
        "filing_scope": "in_scope",
        "filing_assistance": "unknown",
        "capability_ids": [],
        "payment_claim": "sender_claim",
        "evidence_quotes": ["Synthetic evidence phrase."],
    }


def _synthetic_cleaning(guarded_body: str, output_body: str) -> dict[str, Any]:
    digest = lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest()
    spans = (
        [{
            "original_start": 0,
            "original_end": len(guarded_body),
            "cleaned_start": 0,
            "cleaned_end": len(output_body),
        }]
        if guarded_body == output_body and guarded_body
        else []
    )
    return {
        "version": "centurion-pilot250-cleaning-v1",
        "flags": ["synthetic_fixture"],
        "privacy": {
            "same_guard_for_original_and_cleaned": True,
            "subject": {"redactions": 0},
            "body": {"redactions": 0},
        },
        "removals": {"decorative_separator_lines": int(guarded_body != output_body)},
        "provenance": {
            "source_body_text_sha256": digest(guarded_body),
            "guarded_visible_body_sha256": digest(guarded_body),
            "output_body_sha256": digest(output_body),
            "span_map_basis": "synthetic guarded-visible source to output",
            "guarded_original_to_output_spans": spans,
        },
    }


def _synthetic_fixture() -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    selected: list[dict[str, Any]] = []
    cases: list[tuple[str, bool]] = [
        ("random_development", False) for _ in range(25)
    ] + [
        ("targeted_development", False),
        ("targeted_development", False),
        ("random_development", True),
        ("random_holdout", True),
    ]
    assessment_records: list[dict[str, Any]] = []
    cleaned_packets: list[dict[str, Any]] = []
    original_packets: list[dict[str, Any]] = []
    for index, (cohort, embargoed) in enumerate(cases):
        case_id = f"SYNTHETIC_CASE_{index:03d}"
        source_row_id = f"SYNTHETIC_SOURCE_ROW_{index:03d}"
        bucket, phase = _cohort_bucket(cohort, embargoed)
        selected.append({
            "case_id": case_id,
            "source_row_id": source_row_id,
            "thread_id": f"SYNTHETIC_THREAD_{index:03d}",
            "source_line": index + 1,
            "message_index": 0,
            "timestamp": "2026-10-01T09:00:00Z",
            "cohort": cohort,
            "embargoed": embargoed,
            "stratum": "synthetic",
            "cue_flags": [],
        })
        quote = "Synthetic evidence phrase."
        clean_body = quote
        original_body = quote
        if index == 7:
            clean_body = "Synthetic clean-only citation phrase."
            quote = clean_body
            original_body = "Synthetic guarded-original phrase."
        input_target = {
            "subject": "Synthetic subject",
            "body": clean_body,
            "stored_message_date": "2026-10-01",
            "sender_domain": "example.test",
            "no_reply_sender_clue": False,
            "same_from_and_recipient": False,
            "attachment_inventory": "unknown",
            "attachments": "unknown",
        }
        original_target = dict(input_target)
        original_target["body"] = original_body
        cleaned_packets.append({
            "case_id": case_id,
            "input": {"target": input_target, "prior_messages": [], "context_gaps": []},
            "cleaning": _synthetic_cleaning(original_body, clean_body),
        })
        original_packets.append({
            "case_id": case_id,
            "input": {"target": original_target, "prior_messages": [], "context_gaps": []},
            "cleaning": _synthetic_cleaning(original_body, original_body),
        })

        for slot in SLOTS:
            if index == 1 and slot == "sol_high":
                continue
            normalized = _synthetic_normalized(action="billing", quote=quote)
            if index == 0 and slot == "sol_high":
                normalized = _synthetic_normalized(
                    action="quote",
                    assistance="partial",
                    quote="Synthetic evidence phrase.",
                )
            elif index == 3:
                normalized = _synthetic_normalized(
                    action="no_current_work",
                    assistance="no_material_help",
                    any_help="no",
                    fully_preparable="unknown",
                    quote=quote,
                )
            elif index == 4:
                normalized = _synthetic_normalized(
                    action="proof_of_payment",
                    assistance="unknown",
                    any_help="unknown",
                    fully_preparable="unknown",
                    quote=quote,
                    documents=[_synthetic_document()],
                )
            elif index == 5:
                normalized = _synthetic_normalized(
                    action="quote",
                    extra_unknown_action=True,
                    quote=quote,
                )
            elif index == 6:
                normalized = _synthetic_normalized(
                    action="group_event",
                    scope="out_of_scope",
                    assistance="out_of_scope",
                    any_help="no",
                    fully_preparable="no",
                    quote=quote,
                    room_count=11,
                )
            elif index == 7:
                normalized = _synthetic_normalized(
                    action="billing",
                    quote=quote,
                    origin_flags=("yes", "yes"),
                )
            row = {
                "case_id": case_id,
                "phase": phase,
                "arm": "cleaned",
                "round": 1,
                "arm_pair_sha256": "a" * 64,
                "slot": slot,
                "input_sha256": "b" * 64,
                "prompt_sha256": "c" * 64,
                "endpoint_sha256": "d" * 64,
                "normalizer_code_sha256": "e" * 64,
                "model": "gpt-6-luna" if slot.startswith("luna_") else "gpt-6.1-sol",
                "reasoning_effort": "max" if slot.startswith("luna_") else "high",
                "status": "ok",
                "parse_status": "valid",
                "normalized": normalized,
                "raw_output_text": "SYNTHETIC_MODEL_OUTPUT_SENTINEL",
            }
            if index == 2 and slot == "sol_high":
                row.update({"status": "error", "parse_status": None})
            assessment_records.append(row)
            if index == 8 and slot == "luna_max_a":
                retry = dict(row)
                retry.update({"status": "error", "parse_status": None})
                assessment_records.insert(len(assessment_records) - 1, retry)
        if index == 0:
            ignored = dict(assessment_records[-1])
            ignored.update({"arm": "original", "slot": "luna_max_a"})
            assessment_records.append(ignored)
            ignored = dict(assessment_records[-1])
            ignored.update({"arm": "cleaned", "round": 2})
            assessment_records.append(ignored)

    return (
        {"schema": "centurion-pilot250-v1", "seed": "synthetic-seed", "selected": selected},
        assessment_records,
        cleaned_packets,
        original_packets,
    )


class SyntheticTests(unittest.TestCase):
    def test_private_inputs_allow_shared_anchor_but_require_private_children(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / ".private"
            root.mkdir(mode=0o770)
            os.chmod(root, 0o770)
            child = root / "inputs"
            child.mkdir(mode=0o700)
            os.chmod(child, 0o700)
            source = child / "synthetic.jsonl"
            source.write_text("synthetic only\n", encoding="utf-8")
            os.chmod(source, 0o600)

            private_root = _private_root(repo)
            self.assertEqual(private_root, root.resolve())
            self.assertEqual(_private_input_path(source, private_root), source.resolve())
            self.assertEqual(_new_output_path(root / "new-run", private_root), root / "new-run")

            os.chmod(source, 0o640)
            with self.assertRaises(AnalysisError):
                _private_input_path(source, private_root)
            os.chmod(source, 0o600)

            os.chmod(child, 0o750)
            with self.assertRaises(AnalysisError):
                _private_input_path(source, private_root)
            os.chmod(child, 0o700)

            link = child / "linked.jsonl"
            link.symlink_to(source)
            with self.assertRaises(AnalysisError):
                _private_input_path(link, private_root)

    def test_strict_cohorts_metrics_and_unknown_sensitive_k_h(self) -> None:
        manifest, records, cleaned, originals = _synthetic_fixture()
        summary, challenge = analyze_data(
            manifest,
            records,
            cleaned,
            originals,
            holdout_unsealed=True,
        )
        random_dev = summary["cohorts"]["random_development"]
        self.assertEqual(random_dev["manifest_cases"], 25)
        self.assertEqual(random_dev["assessment_coverage"]["case_consensus_status_counts"].get("disagreement"), 1)
        self.assertEqual(random_dev["assessment_coverage"]["case_consensus_status_counts"].get("incomplete"), 2)
        self.assertEqual(
            random_dev["strict_three_slot_unanimity"]["primary_work_type"]["disagreement_cases"],
            1,
        )
        self.assertNotIn("strict_three_model_unanimity", random_dev)
        self.assertEqual(
            random_dev["sample_K_H_sensitivity"]["E"],
            25,
        )
        self.assertEqual(random_dev["sample_K_H_sensitivity"]["K"], 21)
        self.assertEqual(random_dev["sample_K_H_sensitivity"]["H"], 20)
        self.assertEqual(random_dev["sample_K_H_sensitivity"]["U_h"], 1)
        self.assertEqual(random_dev["sample_K_H_sensitivity"]["U_e"], 2)
        bounds = random_dev["sample_K_H_sensitivity"]["H_over_K"]
        self.assertEqual(bounds["lower"]["numerator"], 20)
        self.assertEqual(bounds["lower"]["denominator"], 23)
        self.assertEqual(bounds["known_K_only_rate"]["denominator"], 21)
        slot_a = random_dev["assessment_coverage"]["slots"]["luna_max_a"]["sample_K_H_sensitivity"]
        self.assertEqual((slot_a["E"], slot_a["K"], slot_a["H"], slot_a["U_h"], slot_a["U_e"]),
                         (25, 23, 22, 1, 0))
        sol = random_dev["assessment_coverage"]["slots"]["sol_high"]["sample_K_H_sensitivity"]
        self.assertEqual((sol["E"], sol["K"], sol["H"], sol["U_h"], sol["U_e"]),
                         (25, 21, 20, 1, 2))
        self.assertEqual(summary["cohorts"]["random_holdout"]["manifest_cases"], 1)
        self.assertEqual(summary["cohorts"]["embargoed_development"]["manifest_cases"], 1)
        self.assertEqual(len(challenge["random_development"]) + len(challenge["targeted_development"]), 21)
        self.assertEqual(
            random_dev["assessment_coverage"]["slots"]["luna_max_a"]["category_counts"]
            ["origin_ota_channel_flag"].get("yes"),
            1,
        )

    def test_no_work_is_known_nonactionable_and_document_claim_is_unknown_help(self) -> None:
        no_work = _synthetic_normalized(
            action="no_current_work",
            assistance="no_material_help",
            any_help="no",
            fully_preparable="unknown",
        )
        self.assertEqual(_eligibility_for_K(no_work), "no")
        self.assertEqual(_features(no_work)["fully_preparable"], "unknown")
        filing = _synthetic_normalized(
            action="proof_of_payment",
            assistance="unknown",
            any_help="unknown",
            fully_preparable="unknown",
            documents=[_synthetic_document()],
        )
        self.assertEqual(_eligibility_for_K(filing), "yes")
        self.assertEqual(_document_features(filing)["document_pop_signal"], "present")
        self.assertEqual(_features(filing)["document_filing_assistance"], "unknown")
        signal_only = _synthetic_normalized(action="proof_of_payment", scope="in_scope")
        self.assertEqual(_eligibility_for_K(signal_only), "unknown")
        unknown_filing = _synthetic_document()
        unknown_filing["filing_trigger"] = "unknown"
        signal_only["documents"] = [unknown_filing]
        self.assertEqual(_eligibility_for_K(signal_only), "unknown")
        excluded_filing = _synthetic_document()
        excluded_filing["filing_scope"] = "out_of_scope"
        signal_only["documents"] = [excluded_filing]
        self.assertEqual(_eligibility_for_K(signal_only), "no")

        bundled = _synthetic_normalized(action="proof_of_payment")
        voucher_item = dict(bundled["work_items"][0], action="voucher")
        bundled["work_items"].append(voucher_item)
        pop_doc = dict(_synthetic_document(), file_index=0)
        voucher_doc = dict(pop_doc, kinds=["voucher"])
        bundled["documents"] = [pop_doc, voucher_doc]
        self.assertEqual(_work_features(bundled), ("proof_of_payment_and_voucher", "no"))
        bundled["documents"][1] = dict(voucher_doc, file_index=1)
        self.assertEqual(_work_features(bundled), ("multiple_work_types", "yes"))

        cancellation = _synthetic_normalized(
            action="cancellation_notice_no_action",
            any_help="no",
            fully_preparable="unknown",
        )
        self.assertEqual(_eligibility_for_K(cancellation), "no")
        self.assertEqual(_features(cancellation)["primary_work_type"], "cancellation_notice_no_action")

        spam = _synthetic_normalized(action="marketing_spam", any_help="no")
        self.assertEqual(_eligibility_for_K(spam), "no")
        self.assertEqual(_features(spam)["primary_work_type"], "marketing_spam")
        mixed = _synthetic_normalized(action="marketing_spam")
        billing = dict(mixed["work_items"][0])
        billing.update({"action": "billing", "scope": "in_scope", "episode_index": 1})
        mixed["work_items"].append(billing)
        features = _features(mixed)
        self.assertEqual(features["primary_work_type"], "multiple_work_types")
        self.assertEqual(features["multi_action"], "yes")
        self.assertEqual(features["eligibility_for_K"], "yes")

        current_schema = _synthetic_normalized(origin_flags=("yes", "yes"))
        current_features = _features(current_schema)
        self.assertEqual(current_features["origin_ota_channel_flag"], "yes")
        self.assertEqual(current_features["origin_automated_flag"], "yes")
        future_schema = _synthetic_normalized()
        future_origin = future_schema["origin"]
        future_origin.pop("channel_ota")
        future_origin.pop("automated")
        future_origin["ota_channel_flag"] = "yes"
        future_origin["automated_flag"] = "no"
        self.assertEqual(_features(future_schema)["origin_ota_channel_flag"], "yes")
        self.assertEqual(_features(future_schema)["origin_automated_flag"], "no")
        future_origin["channel_ota"] = "no"
        self.assertEqual(_features(future_schema)["origin_ota_channel_flag"], "unknown")

    def test_positive_filing_documents_require_matching_primary_work_labels(self) -> None:
        no_work_with_pop = _synthetic_normalized(
            action="no_current_work",
            documents=[_synthetic_document()],
        )
        self.assertEqual(_work_features(no_work_with_pop), ("unknown", "unknown"))
        self.assertEqual(_eligibility_for_K(no_work_with_pop), "yes")

        other_with_pop = _synthetic_normalized(
            action="other",
            documents=[_synthetic_document()],
        )
        self.assertEqual(_work_features(other_with_pop), ("unknown", "unknown"))

        bundled = _synthetic_normalized(action="proof_of_payment")
        voucher_item = dict(bundled["work_items"][0], action="voucher")
        bundled["work_items"].append(voucher_item)
        pop_doc = dict(_synthetic_document(), file_index=0)
        voucher_doc = dict(pop_doc, kinds=["voucher"])
        bundled["documents"] = [pop_doc, voucher_doc]
        self.assertEqual(_work_features(bundled), ("proof_of_payment_and_voucher", "no"))
        bundled["work_items"].pop()
        self.assertEqual(_work_features(bundled), ("unknown", "unknown"))

        incomplete_types = _synthetic_normalized(
            action="other",
            documents=[dict(_synthetic_document(), kinds=["proof_of_payment", "unknown"])],
        )
        self.assertEqual(_work_features(incomplete_types), ("unknown", "unknown"))

        missing_types = _synthetic_normalized(
            action="quote",
            documents=[dict(_synthetic_document(), kinds=[])],
        )
        self.assertEqual(_work_features(missing_types), ("unknown", "unknown"))

        different_stay = _synthetic_normalized(action="proof_of_payment")
        different_stay["work_items"][0]["stay_index"] = 0
        different_stay["documents"] = [dict(_synthetic_document(), stay_index=1)]
        self.assertEqual(_work_features(different_stay), ("unknown", "unknown"))

    def test_over_ten_requires_validated_episode_totals(self) -> None:
        def room(action: str, count: int, stay: int | None, episode: int | None,
                 total: int | None = None) -> dict[str, Any]:
            return {
                "action": action,
                "requested_room_count": count,
                "stay_index": stay,
                "episode_index": episode,
                "episode_total_room_count": total,
            }

        self.assertEqual(
            _over_ten_feature({"work_items": [room("group_event", 10, 0, 0)]}),
            "no",
        )
        self.assertEqual(
            _over_ten_feature({"work_items": [room("group_event", 11, 0, None)]}),
            "yes",
        )
        self.assertEqual(
            _over_ten_feature({
                "work_items": [
                    room("group_event", 6, 0, 0),
                    room("group_event", 6, 1, 1),
                ],
            }),
            "unknown",
        )
        self.assertEqual(
            _over_ten_feature({
                "work_items": [
                    room("group_event", 6, 0, None),
                    room("group_event", 6, 1, None),
                ],
            }),
            "unknown",
        )
        self.assertEqual(
            _over_ten_feature({
                "work_items": [
                    room("group_event", 6, 0, 0, 12),
                    room("group_event", 6, 1, 0, 12),
                ],
            }),
            "yes",
        )
        self.assertEqual(
            _over_ten_feature({
                "work_items": [
                    room("quote", 6, 0, 0, 6),
                    room("new_booking", 6, 0, 0, 6),
                ],
            }),
            "no",
        )
        self.assertEqual(
            _over_ten_feature({
                "work_items": [room("group_event", 10, 0, 0), {"action": "unknown"}],
            }),
            "unknown",
        )

    def test_missing_packet_hashes_cannot_form_a_first_pass_triad(self) -> None:
        manifest = {
            "SYNTHETIC_CASE": {
                "source_row_id": "SYNTHETIC_SOURCE_ROW",
                "cohort": "random_development",
                "expected_phase": "development",
            },
        }
        records = [
            {
                "case_id": "SYNTHETIC_CASE",
                "phase": "development",
                "arm": "cleaned",
                "round": 1,
                "slot": slot,
                "prompt_sha256": "c" * 64,
                "endpoint_sha256": "d" * 64,
                "normalizer_code_sha256": "e" * 64,
                "model": "gpt-6-luna" if slot.startswith("luna_") else "gpt-6.1-sol",
                "reasoning_effort": "max" if slot.startswith("luna_") else "high",
                "status": "ok",
                "parse_status": "valid",
                "normalized": _synthetic_normalized(action="billing"),
            }
            for slot in SLOTS
        ]
        chosen, diagnostics = _first_pass_rows(records, manifest)
        self.assertNotIn("SYNTHETIC_CASE", chosen)
        self.assertEqual(
            diagnostics["random_development"]["records_with_unverifiable_version_hashes"],
            len(SLOTS),
        )
        details = _make_case_details(manifest, chosen)
        self.assertEqual(details[0]["decision_status"], "incomplete")

    def test_partial_endpoint_rerun_cannot_form_a_first_pass_triad(self) -> None:
        manifest = {
            "SYNTHETIC_CASE": {
                "source_row_id": "SYNTHETIC_SOURCE_ROW",
                "cohort": "random_development",
                "expected_phase": "development",
            },
        }
        records = [
            {
                "case_id": "SYNTHETIC_CASE",
                "phase": "development",
                "arm": "cleaned",
                "round": 1,
                "slot": slot,
                "status": "ok",
                "parse_status": "valid",
                "normalized": _synthetic_normalized(action="billing"),
                "arm_pair_sha256": "a" * 64,
                "input_sha256": "b" * 64,
                "prompt_sha256": "c" * 64,
                "endpoint_sha256": endpoint,
                "normalizer_code_sha256": "e" * 64,
                "model": "gpt-6-luna" if slot.startswith("luna_") else "gpt-6.1-sol",
                "reasoning_effort": "max" if slot.startswith("luna_") else "high",
            }
            for slot, endpoint in (
                ("luna_max_a", "d" * 64),
                ("luna_max_b", "d" * 64),
                ("sol_high", "e" * 64),
            )
        ]

        chosen, diagnostics = _first_pass_rows(records, manifest)

        self.assertEqual(set(chosen["SYNTHETIC_CASE"]["slots"]), {"luna_max_a", "luna_max_b"})
        self.assertEqual(
            diagnostics["random_development"]["cases_with_multiple_first_pass_versions"],
            1,
        )
        self.assertEqual(
            diagnostics["random_development"]["cases_with_multiple_first_pass_endpoints"],
            1,
        )

    def test_first_pass_prompt_endpoint_and_normalizer_hashes_are_required(self) -> None:
        manifest, records, cleaned, _originals = _synthetic_fixture()
        development_records = [row for row in records if row["phase"] == "development"]
        for field in ("prompt_sha256", "endpoint_sha256", "normalizer_code_sha256"):
            with self.subTest(field=field):
                missing = [dict(row) for row in development_records]
                missing[0].pop(field)
                with self.assertRaises(AnalysisError) as raised:
                    analyze_data(manifest, missing, cleaned)
                self.assertEqual(
                    raised.exception.code,
                    "assessment_version_provenance_missing_or_invalid",
                )

    def test_first_pass_prompt_endpoint_and_normalizer_hashes_must_match_across_cases(self) -> None:
        manifest, records, cleaned, _originals = _synthetic_fixture()
        development_records = [row for row in records if row["phase"] == "development"]
        fields = ("prompt_sha256", "endpoint_sha256", "normalizer_code_sha256")
        for field in fields:
            with self.subTest(field=field):
                mismatched = [dict(row) for row in development_records]
                for row in mismatched:
                    if row["case_id"] == "SYNTHETIC_CASE_001":
                        row[field] = "f" * 64
                with self.assertRaises(AnalysisError) as raised:
                    analyze_data(manifest, mismatched, cleaned)
                self.assertEqual(raised.exception.code, "first_pass_provenance_not_uniform")

    def test_model_and_effort_must_match_expected_slot_mapping_across_cases(self) -> None:
        manifest, records, cleaned, _originals = _synthetic_fixture()
        development_records = [row for row in records if row["phase"] == "development"]
        for field, wrong_value in (("model", "gpt-6.1-sol"), ("reasoning_effort", "high")):
            with self.subTest(field=field):
                mismatched = [dict(row) for row in development_records]
                for row in mismatched:
                    if row["case_id"] == "SYNTHETIC_CASE_001" and row["slot"] == "luna_max_a":
                        row[field] = wrong_value
                with self.assertRaises(AnalysisError) as raised:
                    analyze_data(manifest, mismatched, cleaned)
                self.assertEqual(raised.exception.code, "assessment_slot_model_effort_mismatch")

    def test_holdout_records_require_explicit_unsealing_but_manifest_entries_do_not(self) -> None:
        manifest, records, cleaned, _originals = _synthetic_fixture()
        with self.assertRaises(AnalysisError) as raised:
            analyze_data(manifest, records, cleaned)
        self.assertEqual(raised.exception.code, "holdout_unsealed_required")

        summary, _challenge = analyze_data(
            manifest,
            records,
            cleaned,
            holdout_unsealed=True,
        )
        self.assertEqual(summary["cohorts"]["random_holdout"]["manifest_cases"], 1)

        development_records = [row for row in records if row["phase"] == "development"]
        sealed_summary, _challenge = analyze_data(manifest, development_records, cleaned)
        self.assertEqual(sealed_summary["cohorts"]["random_holdout"]["manifest_cases"], 1)

    def test_holdout_cli_flag_is_explicit(self) -> None:
        args = _parser().parse_args(["--holdout-unsealed"])
        self.assertTrue(args.holdout_unsealed)

    def test_agreement_sample_is_hash_deterministic_and_challenge_has_no_outputs(self) -> None:
        manifest, records, cleaned, _ = _synthetic_fixture()
        first, packets_one = analyze_data(manifest, records, cleaned, holdout_unsealed=True)
        second, packets_two = analyze_data(manifest, records, cleaned, holdout_unsealed=True)
        self.assertEqual(first["challenge_selection"], second["challenge_selection"])
        self.assertEqual(packets_one, packets_two)
        self.assertEqual(first["challenge_selection"]["agreement_check_selected"], 20)
        _seed, manifest_rows = _validate_manifest(manifest)
        extra_metadata = dict(cleaned[0], cue_flags=["synthetic"])
        with self.assertRaises(AnalysisError):
            _packet_map([extra_metadata], manifest_rows)
        eligible_agreement_indices = [3, 4, 5] + list(range(6, 25)) + [25, 26]
        ranked_agreements = sorted(
            (
                hashlib.sha256(
                    (
                        "synthetic-seed\0agreement-check\0"
                        f"SYNTHETIC_SOURCE_ROW_{index:03d}"
                    ).encode("utf-8")
                ).hexdigest(),
                f"SYNTHETIC_CASE_{index:03d}",
            )
            for index in eligible_agreement_indices
        )[:20]
        actual_ids = {
            packet["case_id"]
            for rows in packets_one.values()
            for packet in rows
        }
        expected_agreement_ids = {case_id for _, case_id in ranked_agreements}
        self.assertEqual(actual_ids, {"SYNTHETIC_CASE_000"} | expected_agreement_ids)
        expected_unanimous_unknown_ids = {
            case_id
            for case_id in expected_agreement_ids
            if case_id in {f"SYNTHETIC_CASE_{index:03d}" for index in (3, 4, 5)}
        }
        self.assertTrue(expected_unanimous_unknown_ids)
        selected_statuses = collections.Counter(
            status
            for cohort_summary in first["challenge_selection"]["by_cohort"].values()
            for status, count in cohort_summary["selected_decision_status_counts"].items()
            for _ in range(count)
        )
        self.assertEqual(selected_statuses["unanimous_unknown"], len(expected_unanimous_unknown_ids))
        self.assertEqual(
            first["cohorts"]["random_development"]["assessment_coverage"]
            ["case_consensus_status_counts"]["unanimous_unknown"],
            3,
        )
        self.assertEqual(first["challenge_selection"]["by_cohort"]["random_development"]["agreement_candidates"], 22)
        self.assertEqual(first["challenge_selection"]["by_cohort"]["targeted_development"]["agreement_candidates"], 2)
        self.assertTrue(first["challenge_selection"]["unanimous_unknown_cases_treated_as_agreement_candidates"])
        self.assertFalse(first["challenge_selection"]["incomplete_cases_added"])
        self.assertNotIn("SYNTHETIC_CASE_027", actual_ids)
        self.assertNotIn("SYNTHETIC_CASE_028", actual_ids)
        self.assertNotIn("SYNTHETIC_CASE_001", actual_ids)
        self.assertNotIn("SYNTHETIC_CASE_002", actual_ids)
        prepared_by_case = {packet["case_id"]: packet for packet in cleaned}
        serialized = json.dumps(packets_one, ensure_ascii=False)
        self.assertNotIn("SYNTHETIC_SOURCE_ROW_", serialized)
        self.assertNotIn("SYNTHETIC_THREAD_", serialized)
        self.assertNotIn("SYNTHETIC_MODEL_OUTPUT_SENTINEL", serialized)
        self.assertNotIn("cue_flags", serialized)
        self.assertNotIn("stratum", serialized)
        self.assertNotIn('"normalized"', serialized)
        for rows in packets_one.values():
            for packet in rows:
                self.assertEqual(set(packet), PACKET_KEYS)
                self.assertEqual(packet, prepared_by_case[packet["case_id"]])
                self.assertIn("provenance", packet["cleaning"])
                self.assertEqual(set(packet["input"]), MODEL_INPUT_KEYS)
                self.assertNotIn("case_id", packet["input"])
                self.assertNotIn("source_row_id", packet["input"])

    def test_citation_audit_counts_only_and_checks_guarded_original(self) -> None:
        manifest, records, cleaned, originals = _synthetic_fixture()
        summary, _challenge = analyze_data(
            manifest,
            records,
            cleaned,
            originals,
            holdout_unsealed=True,
        )
        audit = summary["cohorts"]["random_development"]["guarded_original_citation_audit"]
        self.assertTrue(audit["available"])
        self.assertGreater(audit["by_slot"]["luna_max_a"]["missing_from_guarded_original"], 0)
        self.assertEqual(
            audit["by_slot"]["luna_max_a"]["assessments_with_missing_quotes"],
            1,
        )
        serialized = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn("Synthetic clean-only citation phrase.", serialized)
        self.assertNotIn("SYNTHETIC_CASE_", serialized)
        self.assertNotIn("SYNTHETIC_SOURCE_ROW_", serialized)

    def test_empty_but_supplied_original_file_is_reported_as_available(self) -> None:
        manifest, records, cleaned, _originals = _synthetic_fixture()
        summary, _challenge = analyze_data(
            manifest,
            records,
            cleaned,
            original_packets_supplied=True,
            holdout_unsealed=True,
        )
        audit = summary["cohorts"]["random_development"]["guarded_original_citation_audit"]
        self.assertTrue(audit["available"])
        self.assertEqual(audit["cases_with_original_packet"], 0)
        self.assertEqual(audit["cases_without_original_packet"], 25)

    def test_private_output_modes_and_cohort_separation(self) -> None:
        manifest, records, cleaned, originals = _synthetic_fixture()
        summary, challenge = analyze_data(
            manifest,
            records,
            cleaned,
            originals,
            holdout_unsealed=True,
        )
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / ".private"
            root.mkdir(mode=0o770)
            os.chmod(root, 0o770)
            output = root / "analysis"
            write_outputs(output, summary, challenge)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((output / "random_development").stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((output / "targeted_development").stat().st_mode), 0o700)
            self.assertFalse((output / "random_holdout").exists())
            for path in (
                output / "summary.json",
                output / "random_development" / "challenge.jsonl",
                output / "targeted_development" / "challenge.jsonl",
            ):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            for cohort in DEV_COHORTS:
                written_packets = [
                    json.loads(line)
                    for line in (output / cohort / "challenge.jsonl")
                    .read_text(encoding="utf-8")
                    .splitlines()
                ]
                self.assertEqual(written_packets, challenge[cohort])
            written_summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
            self.assertNotIn("SYNTHETIC_CASE_", json.dumps(written_summary))
            with self.assertRaises(AnalysisError):
                write_outputs(output, summary, challenge)


def run_self_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="Frozen pilot manifest under .private")
    parser.add_argument("--assessments", help="Private assessments.jsonl from the review runner")
    parser.add_argument(
        "--cleaned-packets",
        action="append",
        default=[],
        help="Cohort cleaned.jsonl packet file; repeat once per cohort",
    )
    parser.add_argument(
        "--original-packets",
        action="append",
        default=[],
        help="Optional guarded-original.jsonl file for literal citation audit; repeat per cohort",
    )
    parser.add_argument(
        "--output",
        help="New direct child directory under .private for summary and challenge packets",
    )
    parser.add_argument(
        "--holdout-unsealed",
        action="store_true",
        help="Explicitly permit input assessment records with phase=holdout",
    )
    parser.add_argument("--self-test", action="store_true", help="Run synthetic-only offline tests")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_tests()
    if not args.manifest or not args.assessments or not args.cleaned_packets or not args.output:
        parser.error("--manifest, --assessments, --cleaned-packets, and --output are required")
    try:
        root = _private_root()
        manifest_path = _private_input_path(args.manifest, root, 32 * 1024 * 1024)
        assessment_path = _private_input_path(args.assessments, root)
        cleaned_paths = [_private_input_path(path, root) for path in args.cleaned_packets]
        original_paths = [_private_input_path(path, root) for path in args.original_packets]
        output_dir = _new_output_path(args.output, root)
        manifest_document = _read_json(manifest_path)
        assessment_records = _read_jsonl(assessment_path)
        cleaned_records = [
            row
            for path in cleaned_paths
            for row in _read_jsonl(path)
        ]
        original_records = [
            row
            for path in original_paths
            for row in _read_jsonl(path)
        ]
        summary, challenge_packets = analyze_data(
            manifest_document,
            assessment_records,
            cleaned_records,
            original_records,
            original_packets_supplied=bool(original_paths),
            holdout_unsealed=args.holdout_unsealed,
        )
        write_outputs(output_dir, summary, challenge_packets)
    except AnalysisError as error:
        print(f"ERROR: {error.code}", file=sys.stderr)
        return 2
    except Exception:
        # Never print arbitrary exception text; it may contain private row data.
        print("ERROR: internal_analysis_failure", file=sys.stderr)
        return 2
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
