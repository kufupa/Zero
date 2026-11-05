#!/usr/bin/env python3
"""Independently audit the private Centurion pilot draw; print aggregates only.

This checks source/manifest integrity, random and holdout rankings, targeted
quota/backfill consistency, permissions and holdout isolation. It does not
print message content. Thread, Message-ID, fingerprint and normalized-content
matches are candidate links, never proof of duplicate delivery.
"""

import argparse
import collections
import datetime
import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import unicodedata


SEED = "centurion-pilot-250-v1-20261101"
SOURCE_SHA = "ec9d30c47e2ef0a3dd61ae6db795e1f730feb5e853b9cf76025f523d7a4e6625"
SCHEMA = "centurion-pilot250-v1"
SAMPLER_VERSION = "centurion-pilot-250-select-v2"
CUE_VERSION = "centurion-pilot-cues-v2-20261101"
TARGET_ORDER = (
    "ota_system",
    "proof_of_payment",
    "voucher",
    "group_rooming",
    "mixed_action",
)
TARGET_QUOTA = 20


def rank(domain, source_id):
    value = (SEED + "\0" + domain + "\0" + source_id).encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def normalized_text(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFC", text).strip()


def exact_content_key(subject, body):
    normalized_subject = normalized_text(subject)
    normalized_body = normalized_text(body)
    if not normalized_subject and not normalized_body:
        return None
    payload = json.dumps(
        [normalized_subject, normalized_body],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def message_id_key(value):
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().strip("<> ").casefold()


def source_message_id_key(message, source_row, private):
    headers = private.get("canonicalHeaders")
    header_value = headers.get("Message-ID") if isinstance(headers, dict) else None
    for value in (source_row.get("messageId"), message.get("messageId"), header_value):
        if isinstance(value, (list, tuple)):
            present = [item for item in value if isinstance(item, str) and item.strip()]
            value = present[0] if len(present) == 1 else None
        if isinstance(value, str) and value.strip():
            return message_id_key(value)
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).casefold() == "message-id":
                if isinstance(value, (list, tuple)):
                    present = [item for item in value if isinstance(item, str) and item.strip()]
                    value = present[0] if len(present) == 1 else None
                if isinstance(value, str) and value.strip():
                    return message_id_key(value)
    return None


def fingerprint_key(value):
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().casefold()


def holdout_candidate_reasons(row, holdout_threads, holdout_content, holdout_fingerprints,
                              holdout_message_ids):
    reasons = set()
    if row["thread_id"] in holdout_threads:
        reasons.add("same_thread")
    if row["message_id"] and row["message_id"] in holdout_message_ids:
        reasons.add("message_id_candidate")
    if row["content"] and row["content"] in holdout_content:
        reasons.add("exact_subject_body")
    if row["fingerprint"] and row["fingerprint"] in holdout_fingerprints:
        reasons.add("content_fingerprint")
    return reasons


def candidate_categories(cue_flags):
    flags = set(cue_flags)
    categories = set()
    if flags & {"ota_channel_host", "system_host", "no_reply_sender", "integration_failure_subject"}:
        categories.add("ota_system")
    if flags & {"proof_of_payment_text", "proof_of_payment_older_attachment"}:
        categories.add("proof_of_payment")
    if flags & {"voucher_text", "voucher_older_attachment"}:
        categories.add("voucher")
    if flags & {
        "group_rooming_text",
        "explicit_rooms_ge_10_text",
        "group_rooming_older_attachment",
        "explicit_rooms_ge_10_older_attachment",
    }:
        categories.add("group_rooming")
    if "mixed_action_candidate" in flags:
        categories.add("mixed_action")
    return categories


def validate_targeted_selection(selected, aggregate):
    quota_counts = collections.Counter()
    backfill_counts = collections.Counter()
    fallback_count = 0
    targets = [item for item in selected if item.get("cohort") == "targeted_development"]
    for item in targets:
        if item.get("embargoed") is not False:
            fail("targeted_case_embargoed")
        flags = item.get("cue_flags")
        if (
            not isinstance(flags, list)
            or any(not isinstance(flag, str) for flag in flags)
            or flags != sorted(set(flags))
        ):
            fail("target_cue_flags_invalid")
        categories = candidate_categories(flags)
        stage = item.get("selection_stage")
        stratum = item.get("stratum")
        if stage == "quota":
            if stratum not in TARGET_ORDER or stratum not in categories:
                fail("target_quota_stratum_invalid")
            quota_counts[stratum] += 1
            if "backfill_from" in item:
                fail("target_quota_backfill_metadata")
        elif stage == "candidate_backfill":
            backfill_from = item.get("backfill_from")
            if (
                backfill_from not in TARGET_ORDER
                or stratum != backfill_from
                or backfill_from not in categories
            ):
                fail("target_backfill_stratum_invalid")
            backfill_counts[backfill_from] += 1
        elif stage == "general_fallback":
            if stratum != "fallback" or item.get("backfill_from") is not None:
                fail("target_fallback_metadata_invalid")
            fallback_count += 1
        else:
            fail("target_selection_stage_invalid")

    if any(quota_counts[stratum] > TARGET_QUOTA for stratum in TARGET_ORDER):
        fail("target_quota_exceeded")
    expected_quota = {stratum: quota_counts[stratum] for stratum in TARGET_ORDER}
    expected_backfill = {stratum: backfill_counts[stratum] for stratum in TARGET_ORDER}
    expected_shortfall = {
        stratum: max(0, TARGET_QUOTA - quota_counts[stratum])
        for stratum in TARGET_ORDER
    }
    if aggregate.get("target_quota_selections_by_stratum") != expected_quota:
        fail("target_quota_summary_mismatch")
    if aggregate.get("target_candidate_backfill_by_stratum") != expected_backfill:
        fail("target_backfill_summary_mismatch")
    if aggregate.get("target_general_fallback") != fallback_count:
        fail("target_fallback_summary_mismatch")
    if aggregate.get("quota_shortfall_before_backfill_by_stratum") != expected_shortfall:
        fail("target_shortfall_summary_mismatch")


def validate_private_root(path):
    try:
        if path.is_symlink():
            fail("private_root_symlink")
        resolved = path.resolve(strict=True)
        info = resolved.stat()
        mode = stat.S_IMODE(info.st_mode)
    except OSError:
        fail("private_root_unavailable")
    # The shared .private anchor may be 0770; descendants remain owner-only.
    if not resolved.is_dir() or info.st_uid != os.getuid() or mode & 0o007:
        fail("private_root_permissions")
    return resolved


def validate_private_file(path, private_root, label):
    try:
        if path.is_symlink():
            fail(f"{label}_symlink")
        resolved = path.resolve(strict=True)
        file_info = resolved.stat()
    except OSError:
        fail(f"{label}_unavailable")
    if (
        not resolved.is_file()
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


def fail(reason):
    raise ValueError(reason)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, nargs="?")
    parser.add_argument("manifest", type=pathlib.Path, nargs="?")
    parser.add_argument("--development-packets", type=pathlib.Path, action="append")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        checks = run_synthetic_checks()
        print(json.dumps({"self_test": "passed", "checks": checks}, sort_keys=True))
        return
    if not args.source or not args.manifest:
        parser.print_usage(sys.stderr)
        fail("source_and_manifest_required")

    private_root = validate_private_root(pathlib.Path(".private"))
    source = validate_private_file(args.source, private_root, "source")
    manifest_path = validate_private_file(args.manifest, private_root, "manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schema") != SCHEMA
        or manifest.get("seed") != SEED
        or manifest.get("sampler_version") != SAMPLER_VERSION
        or manifest.get("cue_version") != CUE_VERSION
    ):
        fail("manifest_schema_seed_or_version")
    if manifest.get("source_sha256") != SOURCE_SHA:
        fail("manifest_source_hash")
    scope = manifest.get("scope")
    if (
        not isinstance(scope, dict)
        or scope.get("candidate_link_is_not_duplicate_proof") is not True
        or "matching normalized nonempty source Message-ID candidate"
        not in scope.get("holdout_link_rules", [])
        or not isinstance(scope.get("cue_rules"), dict)
        or scope["cue_rules"].get("version") != CUE_VERSION
        or scope["cue_rules"].get("older_attachment_created_at_available") is not False
        or not scope["cue_rules"].get("older_attachment_observation_limit")
    ):
        fail("manifest_scope_or_link_contract")
    selected = manifest.get("selected")
    if (
        not isinstance(selected, list)
        or len(selected) != 250
        or any(not isinstance(item, dict) for item in selected)
    ):
        fail("selection_size")
    ids = [str(item.get("source_row_id") or "") for item in selected]
    cases = [str(item.get("case_id") or "") for item in selected]
    if not all(ids) or len(set(ids)) != 250 or not all(cases) or len(set(cases)) != 250:
        fail("selection_ids")
    quotas = collections.Counter(item.get("cohort") for item in selected)
    if quotas != {"random_development": 100, "random_holdout": 50, "targeted_development": 100}:
        fail("cohort_sizes")
    aggregate = manifest.get("aggregate")
    if not isinstance(aggregate, dict):
        fail("aggregate_schema")
    validate_targeted_selection(selected, aggregate)

    all_rows = {}
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            digest.update(raw)
            thread = json.loads(raw)
            if thread.get("recordType") != "thread":
                continue
            thread_id = str(thread.get("threadId") or "")
            for message_index, message in enumerate(thread.get("messages") or []):
                timestamp = str(message.get("timestamp") or "")
                for row in message.get("sourceRows") or []:
                    private = row.get("privateMessage") or {}
                    if (
                        private.get("direction") != "inbound"
                        or "active_transport" not in (row.get("scopeMembership") or [])
                        or (private.get("sourceMetadata") or {}).get("transportId") != "transport-centurion"
                    ):
                        continue
                    source_id = str(row.get("sourceRowId") or "")
                    if not source_id or not thread_id or not timestamp or source_id in all_rows:
                        fail("invalid_or_duplicate_source_row")
                    day = datetime.date.fromisoformat(timestamp[:10])
                    if not datetime.date(2026, 7, 27) <= day <= datetime.date(2026, 10, 29):
                        fail("source_date_outside_snapshot")
                    subject = str(private.get("subject") or "")
                    body = str(row.get("body") or "")
                    all_rows[source_id] = {
                        "line": line_number,
                        "message_index": message_index,
                        "thread_id": thread_id,
                        "timestamp": timestamp,
                        "content": exact_content_key(subject, body),
                        "fingerprint": fingerprint_key(row.get("contentFingerprint")),
                        "message_id": source_message_id_key(message, row, private),
                    }
    if digest.hexdigest() != SOURCE_SHA or len(all_rows) != 11211:
        fail("source_fingerprint_or_frame_size")

    for item in selected:
        row = all_rows.get(item["source_row_id"])
        if not row or any(
            row[key] != item.get(field)
            for key, field in (
                ("line", "source_line"),
                ("message_index", "message_index"),
                ("thread_id", "thread_id"),
                ("timestamp", "timestamp"),
            )
        ):
            fail("selected_row_mismatch")

    expected_random = sorted(
        all_rows, key=lambda identifier: (rank("random", identifier), all_rows[identifier]["timestamp"], identifier)
    )[:150]
    expected_holdout = set(sorted(
        expected_random,
        key=lambda identifier: (rank("holdout", identifier), all_rows[identifier]["timestamp"], identifier),
    )[:50])
    actual_random = {item["source_row_id"] for item in selected if item["cohort"].startswith("random_")}
    actual_holdout = {item["source_row_id"] for item in selected if item["cohort"] == "random_holdout"}
    if actual_random != set(expected_random) or actual_holdout != expected_holdout:
        fail("random_or_holdout_ranking")

    holdout_threads = {all_rows[identifier]["thread_id"] for identifier in expected_holdout}
    holdout_content = {all_rows[identifier]["content"] for identifier in expected_holdout} - {None}
    holdout_fingerprints = {all_rows[identifier]["fingerprint"] for identifier in expected_holdout} - {None}
    holdout_message_ids = {all_rows[identifier]["message_id"] for identifier in expected_holdout} - {None}
    conflicts = collections.Counter()
    for item in selected:
        cohort = item["cohort"]
        if cohort == "random_holdout":
            if item.get("cue_flags") or item.get("embargoed") is not True:
                fail("holdout_embargo_or_cues")
            continue
        row = all_rows[item["source_row_id"]]
        link_reasons = holdout_candidate_reasons(
            row,
            holdout_threads,
            holdout_content,
            holdout_fingerprints,
            holdout_message_ids,
        )
        if link_reasons:
            conflicts[cohort] += 1
            if cohort == "targeted_development" or item.get("embargoed") is not True:
                fail("holdout_isolation")
            if set(item.get("candidate_link_reasons") or []) != link_reasons:
                fail("candidate_link_reasons_mismatch")
        elif cohort == "random_development":
            if item.get("embargoed") or item.get("candidate_link_reasons"):
                fail("unexpected_random_embargo")

    ready = [item for item in selected if item["cohort"] != "random_holdout" and not item.get("embargoed")]
    summary = {
        "source_fingerprint_and_frame_match": True,
        "source_inbound_rows": len(all_rows),
        "selection_counts": dict(sorted(quotas.items())),
        "random_rank_and_holdout_rank_match": True,
        "targeted_stratum_backfill_contract_passed": True,
        "random_development_overlap_embargoed": conflicts["random_development"],
        "unembargoed_development_cases": len(ready),
        "holdout_isolation_passed": True,
    }
    if args.development_packets:
        packet_cases = []
        for packet_argument in args.development_packets:
            packets_path = validate_private_file(packet_argument, private_root, "packet")
            with packets_path.open(encoding="utf-8") as packets:
                for line in packets:
                    packet = json.loads(line)
                    packet_cases.append(packet.get("case_id"))
                    if not isinstance(packet.get("input"), dict):
                        fail("packet_input_shape")
        expected_cases = {item["case_id"] for item in ready}
        if len(packet_cases) != len(set(packet_cases)) or set(packet_cases) != expected_cases:
            fail("development_packet_membership")
        summary["development_packets_match_unembargoed_cases"] = True
    print(json.dumps(summary, sort_keys=True))


def run_synthetic_checks():
    checks = 0
    assert exact_content_key("Subject", "line1\r\ncaf\u00e9") == exact_content_key(
        " Subject ", "line1\ncafe\u0301 "
    )
    assert exact_content_key("Subject", "") == exact_content_key(" Subject ", " ")
    assert message_id_key(" <Example@EXAMPLE.invalid> ") == "example@example.invalid"
    assert source_message_id_key({}, {}, {
        "canonicalHeaders": {"Message-ID": ["<synthetic-header@example.invalid>"]},
    }) == "synthetic-header@example.invalid"
    checks += 1

    holdout = {
        "thread_id": "synthetic-holdout-thread",
        "message_id": "synthetic-message@example.invalid",
        "content": exact_content_key("holdout", "different body"),
        "fingerprint": "holdout-fingerprint",
    }
    linked_row = {
        "thread_id": "synthetic-development-thread",
        "message_id": "synthetic-message@example.invalid",
        "content": exact_content_key("development", "changed body"),
        "fingerprint": "different-fingerprint",
    }
    reasons = holdout_candidate_reasons(
        linked_row,
        {holdout["thread_id"]},
        {holdout["content"]},
        {holdout["fingerprint"]},
        {holdout["message_id"]},
    )
    assert reasons == {"message_id_candidate"}
    checks += 1

    cue_for_stratum = {
        "ota_system": "ota_channel_host",
        "proof_of_payment": "proof_of_payment_text",
        "voucher": "voucher_text",
        "group_rooming": "group_rooming_text",
        "mixed_action": "mixed_action_candidate",
    }
    targets = []
    for stratum in TARGET_ORDER:
        for index in range(TARGET_QUOTA):
            targets.append({
                "cohort": "targeted_development",
                "embargoed": False,
                "stratum": stratum,
                "selection_stage": "quota",
                "cue_flags": [cue_for_stratum[stratum]],
            })
    aggregate = {
        "target_quota_selections_by_stratum": {stratum: 20 for stratum in TARGET_ORDER},
        "target_candidate_backfill_by_stratum": {stratum: 0 for stratum in TARGET_ORDER},
        "target_general_fallback": 0,
        "quota_shortfall_before_backfill_by_stratum": {stratum: 0 for stratum in TARGET_ORDER},
    }
    validate_targeted_selection(targets, aggregate)
    wrong_stratum = [dict(item) for item in targets]
    wrong_stratum[0]["stratum"] = "voucher"
    try:
        validate_targeted_selection(wrong_stratum, aggregate)
    except ValueError:
        pass
    else:
        raise AssertionError("target stratum inconsistent with cue flags was accepted")
    checks += 1

    backfill_targets = []
    quota_totals = {}
    for stratum in TARGET_ORDER:
        count = TARGET_QUOTA - 1 if stratum == "ota_system" else TARGET_QUOTA
        quota_totals[stratum] = count
        backfill_targets.extend(
            {
                "cohort": "targeted_development",
                "embargoed": False,
                "stratum": stratum,
                "selection_stage": "quota",
                "cue_flags": [cue_for_stratum[stratum]],
            }
            for _ in range(count)
        )
    backfill_targets.append({
        "cohort": "targeted_development",
        "embargoed": False,
        "stratum": "proof_of_payment",
        "selection_stage": "candidate_backfill",
        "backfill_from": "proof_of_payment",
        "cue_flags": ["proof_of_payment_text"],
    })
    backfill_aggregate = {
        "target_quota_selections_by_stratum": quota_totals,
        "target_candidate_backfill_by_stratum": {
            stratum: 1 if stratum == "proof_of_payment" else 0
            for stratum in TARGET_ORDER
        },
        "target_general_fallback": 0,
        "quota_shortfall_before_backfill_by_stratum": {
            stratum: 1 if stratum == "ota_system" else 0
            for stratum in TARGET_ORDER
        },
    }
    validate_targeted_selection(backfill_targets, backfill_aggregate)
    broken_backfill_aggregate = dict(backfill_aggregate)
    broken_backfill_aggregate["target_candidate_backfill_by_stratum"] = {
        stratum: 0 for stratum in TARGET_ORDER
    }
    try:
        validate_targeted_selection(backfill_targets, broken_backfill_aggregate)
    except ValueError:
        pass
    else:
        raise AssertionError("incorrect candidate backfill summary was accepted")
    checks += 1

    fallback_targets = backfill_targets[:-1] + [{
        "cohort": "targeted_development",
        "embargoed": False,
        "stratum": "fallback",
        "selection_stage": "general_fallback",
        "cue_flags": [],
    }]
    fallback_aggregate = {
        "target_quota_selections_by_stratum": quota_totals,
        "target_candidate_backfill_by_stratum": {
            stratum: 0 for stratum in TARGET_ORDER
        },
        "target_general_fallback": 1,
        "quota_shortfall_before_backfill_by_stratum": {
            stratum: 1 if stratum == "ota_system" else 0
            for stratum in TARGET_ORDER
        },
    }
    validate_targeted_selection(fallback_targets, fallback_aggregate)
    checks += 1

    with tempfile.TemporaryDirectory(prefix="pilot250-audit-synthetic-") as temporary:
        private_root = pathlib.Path(temporary) / ".private"
        private_root.mkdir(mode=0o770)
        os.chmod(private_root, 0o770)
        assert validate_private_root(private_root) == private_root.resolve()
        child = private_root / "run"
        child.mkdir(mode=0o700)
        os.chmod(child, 0o700)
        source = child / "source.jsonl"
        source.write_text("synthetic only\n", encoding="utf-8")
        os.chmod(source, 0o600)
        assert validate_private_file(source, private_root, "source") == source.resolve()
        os.chmod(source, 0o640)
        try:
            validate_private_file(source, private_root, "source")
        except ValueError:
            pass
        else:
            raise AssertionError("group-readable source was accepted")
        os.chmod(source, 0o600)
        os.chmod(child, 0o750)
        try:
            validate_private_file(source, private_root, "source")
        except ValueError:
            pass
        else:
            raise AssertionError("group-readable parent directory was accepted")
    checks += 1
    return checks


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        print("audit failed:", type(exc).__name__, file=sys.stderr)
        sys.exit(1)
