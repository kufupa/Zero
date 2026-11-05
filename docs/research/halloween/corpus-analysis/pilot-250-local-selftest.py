#!/usr/bin/env python3
"""Exercise the independent local audits with entirely synthetic data."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
PRIVATE = pathlib.Path(".private").resolve(strict=True)


def run(script, *args):
    process = subprocess.run(
        [sys.executable, "-I", "-B", str(HERE / script), *map(str, args)],
        text=True, capture_output=True, check=True,
    )
    return json.loads(process.stdout)


def audit_check():
    spec = importlib.util.spec_from_file_location("pilot_audit", HERE / "pilot-250-audit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    ids = [f"fixture-{index:05}" for index in range(11211)]
    index = {identifier: offset for offset, identifier in enumerate(ids)}
    rank = lambda domain, sid: hashlib.sha256((module.SEED + "\0" + domain + "\0" + sid).encode()).hexdigest()
    timestamp = "2026-10-01T00:00:00Z"
    random_rows = sorted(ids, key=lambda sid: (rank("random", sid), timestamp, sid))[:150]
    holdout = set(sorted(random_rows, key=lambda sid: (rank("holdout", sid), timestamp, sid))[:50])
    development = [sid for sid in random_rows if sid not in holdout]
    overlap, message_id_overlap = development[:2]
    shared = sorted(holdout)[0]
    random_set = set(random_rows)
    embargoed = {overlap, message_id_overlap}
    targeted = [sid for sid in ids if sid not in random_set][:100]
    target_positions = {sid: position for position, sid in enumerate(targeted)}
    cue_for_stratum = {
        "ota_system": "ota_channel_host",
        "proof_of_payment": "proof_of_payment_text",
        "voucher": "voucher_text",
        "group_rooming": "group_rooming_text",
        "mixed_action": "mixed_action_candidate",
    }
    with tempfile.TemporaryDirectory(prefix="audit-synthetic-", dir=PRIVATE) as tmp:
        directory = pathlib.Path(tmp)
        source, manifest, packets = directory / "source.jsonl", directory / "manifest.json", directory / "packets.jsonl"
        with source.open("w", encoding="utf-8") as output:
            for sid in ids:
                thread = "synthetic-thread-" + (shared if sid == overlap else sid)
                message_id = f"<{sid}@example.invalid>"
                if sid == message_id_overlap:
                    message_id = f"<{shared}@example.invalid>"
                row = {"sourceRowId": sid, "scopeMembership": ["active_transport"], "body": "fixture " + sid,
                       "messageId": message_id, "contentFingerprint": "fixture-" + sid,
                       "privateMessage": {"subject": "fixture", "direction": "inbound",
                       "sourceMetadata": {"transportId": "transport-centurion"}}}
                output.write(json.dumps({"recordType": "thread", "threadId": thread, "messages": [
                    {"timestamp": timestamp, "messageId": message_id, "sourceRows": [row]}]}) + "\n")
        os.chmod(source, 0o600)
        module.SOURCE_SHA = hashlib.sha256(source.read_bytes()).hexdigest()
        selected = []
        for number, sid in enumerate(random_rows + targeted, 1):
            if sid in random_set:
                cohort = "random_holdout" if sid in holdout else "random_development"
                stratum = "random_holdout" if sid in holdout else "random"
                selection_stage = "random"
                row_embargoed = sid in holdout or sid in embargoed
                cue_flags = []
                if sid == overlap:
                    link_reasons = ["same_thread"]
                elif sid == message_id_overlap:
                    link_reasons = ["message_id_candidate"]
                else:
                    link_reasons = None
            else:
                cohort = "targeted_development"
                target_position = target_positions[sid]
                stratum = module.TARGET_ORDER[target_position // module.TARGET_QUOTA]
                selection_stage = "quota"
                row_embargoed = False
                cue_flags = [cue_for_stratum[stratum]]
                link_reasons = None
            item = {
                "case_id": f"P{number:03}",
                "source_row_id": sid,
                "thread_id": "synthetic-thread-" + (shared if sid == overlap else sid),
                "source_line": index[sid] + 1,
                "message_index": 0,
                "timestamp": timestamp,
                "cohort": cohort,
                "embargoed": row_embargoed,
                "stratum": stratum,
                "selection_stage": selection_stage,
                "cue_flags": cue_flags,
            }
            if link_reasons is not None:
                item["candidate_link_reasons"] = link_reasons
            selected.append(item)
        manifest_data = {"schema": "centurion-pilot250-v1", "source_sha256": module.SOURCE_SHA,
                         "sampler_version": module.SAMPLER_VERSION, "cue_version": module.CUE_VERSION,
                         "seed": module.SEED,
                         "scope": {"candidate_link_is_not_duplicate_proof": True,
                                   "holdout_link_rules": [
                                       "same thread_id",
                                       "matching normalized nonempty source Message-ID candidate",
                                       "exact subject+body SHA-256 after NFC/newline normalization and outer trim",
                                       "matching nonempty source contentFingerprint",
                                   ],
                                   "cue_rules": {
                                       "version": module.CUE_VERSION,
                                       "older_attachment_created_at_available": False,
                                       "older_attachment_observation_limit": "synthetic: decision-time availability unknown",
                                   }},
                         "aggregate": {
                             "target_quota_selections_by_stratum": {
                                 stratum: module.TARGET_QUOTA for stratum in module.TARGET_ORDER
                             },
                             "target_candidate_backfill_by_stratum": {
                                 stratum: 0 for stratum in module.TARGET_ORDER
                             },
                             "target_general_fallback": 0,
                             "quota_shortfall_before_backfill_by_stratum": {
                                 stratum: 0 for stratum in module.TARGET_ORDER
                             },
                         },
                         "selected": selected}

        def save_manifest():
            manifest.write_text(json.dumps(manifest_data), encoding="utf-8")
            os.chmod(manifest, 0o600)

        save_manifest()
        with packets.open("w", encoding="utf-8") as output:
            for item in selected:
                if item["cohort"] != "random_holdout" and not item["embargoed"]:
                    output.write(json.dumps({"case_id": item["case_id"], "input": {}}) + "\n")
        os.chmod(packets, 0o600)

        def invoke():
            previous, sys.argv = sys.argv, ["audit", str(source), str(manifest), "--development-packets", str(packets)]
            try:
                with contextlib.redirect_stdout(io.StringIO()) as captured:
                    module.main()
                return json.loads(captured.getvalue())
            finally:
                sys.argv = previous

        assert invoke()["unembargoed_development_cases"] == 198
        next(item for item in selected if item["source_row_id"] == overlap)["embargoed"] = False
        save_manifest()
        try:
            invoke()
            raise AssertionError("missing embargo was accepted")
        except ValueError:
            pass
        next(item for item in selected if item["source_row_id"] == overlap)["embargoed"] = True
        next(item for item in selected if item["source_row_id"] == message_id_overlap)["embargoed"] = False
        save_manifest()
        try:
            invoke()
            raise AssertionError("Message-ID candidate overlap without embargo was accepted")
        except ValueError:
            pass
        next(item for item in selected if item["source_row_id"] == message_id_overlap)["embargoed"] = True
        next(item for item in selected if item["cohort"] == "random_holdout")["cue_flags"] = ["must fail"]
        save_manifest()
        try:
            invoke()
            raise AssertionError("holdout cue was accepted")
        except ValueError:
            pass


def old_export_check():
    with tempfile.TemporaryDirectory(prefix="old-audit-synthetic-", dir=PRIVATE) as tmp:
        directory = pathlib.Path(tmp)
        source, manifest = directory / "source.jsonl", directory / "manifest.json"
        old, selections = directory / "old.jsonl.gz", directory / "selection.jsonl.gz"
        cases, old_rows, selection_rows = [], [], []
        with source.open("w", encoding="utf-8") as output:
            for index, cohort in enumerate(("random_development", "random_holdout")):
                sid, thread, body = f"row-{index}", f"thread-{index}", f"synthetic request {index}"
                sender, subject, file_id = "fake@example.invalid", "synthetic subject", f"file-{index}"
                row = {"sourceRowId": sid, "scopeMembership": ["active_transport"], "body": body,
                       "privateMessage": {"direction": "inbound", "sourceMetadata": {"transportId": "transport-centurion"},
                                          "subject": subject, "addresses": {"from": [sender]}}}
                output.write(json.dumps({"recordType": "thread", "threadId": thread, "messages": [
                    {"sourceRows": [row]}]}) + "\n")
                cases.append({"case_id": f"P{index + 1:03}", "source_row_id": sid, "source_line": index + 1,
                              "message_index": 0, "thread_id": thread, "cohort": cohort, "embargoed": False})
                old_rows.append({"id": sid, "thread_id": thread, "direction": "inbound", "subject": subject,
                                 "text_body": body, "from_address": sender, "attachments": [{"id": file_id}]})
                selection_rows.append({"messageId": sid, "threadId": thread, "subject": subject, "bodyText": body,
                                       "fromAddress": sender, "attachments": [{"id": file_id, "text": "fixture"}]})
        manifest.write_text(json.dumps({"source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "selected": cases}))
        os.chmod(manifest, 0o600)

        def save(path, rows):
            with gzip.open(path, "wt", encoding="utf-8") as output:
                for row in rows:
                    output.write(json.dumps(row) + "\n")

        save(old, old_rows)
        save(selections, selection_rows)
        result = run("pilot-250-old-export-audit.py", source, manifest, old, selections)
        assert result["selected_cases"] == 1 and result["linked_later_extracted_texts"] == 1
        result = run("pilot-250-old-export-audit.py", source, manifest, old, selections, "--after-freeze", "--cohort", "random_holdout")
        assert result["selected_cases"] == 1 and result["linked_later_extracted_texts"] == 1
        selection_rows[0]["bodyText"] = "different synthetic body"
        save(selections, selection_rows)
        result = run("pilot-250-old-export-audit.py", source, manifest, old, selections)
        assert result["old_selection_exact_matches"] == 0 and result["linked_later_extracted_texts"] == 0


def domain_check():
    with tempfile.TemporaryDirectory(prefix="domain-synthetic-", dir=PRIVATE) as tmp:
        source = pathlib.Path(tmp) / "source.jsonl"
        with source.open("w", encoding="utf-8") as output:
            for index in range(60):
                sender = (["first@one.invalid", "second@two.invalid"] if index < 30 else
                          ["third@two.invalid"] if index < 55 else ["invalid"])
                row = {"scopeMembership": ["active_transport"], "privateMessage": {
                    "sourceMetadata": {"transportId": "fixture"},
                    "direction": "outbound" if index >= 56 else "inbound", "addresses": {"from": sender}}}
                output.write(json.dumps({"recordType": "thread", "messages": [{"sourceRows": [row]}]}) + "\n")
        result = run("rank-inbound-domains.py", source, "--transport", "fixture", "--minimum-count", "25")
        assert {item["host"]: item["rows"] for item in result["ranked_from_hosts"]} == {"one.invalid": 30, "two.invalid": 55}
        assert result["inbound_multiple_from_addresses"] == 30 and result["inbound_no_parseable_from_host"] == 1
        assert result["directions"] == {"inbound": 56, "outbound": 4, "unknown": 0}


if __name__ == "__main__":
    audit_check()
    old_export_check()
    domain_check()
    print("Synthetic local audit checks passed: sampling/holdout, old-export linkage, and sender-domain counts.")
