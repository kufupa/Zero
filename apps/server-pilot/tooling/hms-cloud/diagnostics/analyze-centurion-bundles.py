#!/usr/bin/env python3
"""Freeze and analyze private Centurion bundle investigation snapshots."""
import argparse
import hashlib
import json
import os
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".partial")
    with temporary.open("x") as target:
        json.dump(value, target, ensure_ascii=False, indent=2)
        target.write("\n")
    temporary.replace(path)


def field(fields, name):
    matches = [item for item in fields if item.get("name") == name]
    return matches[0].get("value") if len(matches) == 1 else None


def distribution(rows, key):
    return dict(Counter(row.get(key) if row.get(key) is not None else "[unknown]" for row in rows))


def status_label(value):
    # Stay-card cancellation numbers appear on a separate line in the status cell.
    # Keep the complete source value elsewhere; group only the known displayed status.
    first_line = value.splitlines()[0].strip() if isinstance(value, str) and value else None
    return {"CheckedOut": "Checked Out", "Checked Out": "Checked Out", "Cancelled": "Cancelled",
            "Reserved": "Reserved", "In-house": "In-house", "NoShow": "No Show", "No Show": "No Show"}.get(first_line)


def private_output(path, exists=True):
    for ancestor in [path, *path.parents]:
        if (ancestor / ".git").exists():
            raise ValueError("OUTPUT_IN_GIT")
    if exists:
        stat = path.lstat()
        if not path.is_dir() or path.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
            raise ValueError("OUTPUT_DIRECTORY_NOT_PRIVATE")


def prepare(source, output, revision):
    if output.exists():
        raise ValueError("OUTPUT_ALREADY_EXISTS")
    private_output(output, exists=False)
    output.mkdir(mode=0o700)
    os.chmod(output, 0o700)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    document = json.loads(source.read_text())
    rows = document["results"]
    confirmations = [row["confirmation"] for row in rows]
    if (len(confirmations) != len(set(confirmations)) or
            any(not re.fullmatch(r"\d+-\d+", value) for value in confirmations)):
        raise ValueError("INVALID_CONFIRMATION_COHORT")
    candidates = []
    for index, row in enumerate(rows):
        provenance = row.get("sourcePdfEvidence", {})
        arrival = provenance.get("arrivalDateHint")
        if not isinstance(arrival, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arrival):
            raise ValueError("ARRIVAL_HINT_REQUIRED")
        datetime.strptime(arrival, "%Y-%m-%d")
        fields = row.get("recordView", {}).get("details", {}).get("fields", [])
        verified = row.get("ok") is True
        if verified and (row["recordView"]["details"].get("confirmationInRecord") != row["confirmation"] or
                         row.get("stay360", {}).get("confirmation") != row["confirmation"]):
            raise ValueError("HISTORICAL_IDENTITY_MISMATCH")
        historical = {key: field(fields, name) for key, name in {
            "status": "status", "mealPlan": "mealplan", "ratePlan": "rateplan",
            "sourceOfBusiness": "sourceofbusinessdesc", "arrival": "arrivaldate", "departure": "departuredate",
        }.items()}
        candidates.append({"confirmation": row["confirmation"], "arrivalDate": arrival,
                           "guestName": provenance.get("guestNameHint"), "historicalVerified": verified,
                           "historical": historical, "sourceIndex": index, "provenance": provenance})
    shutil.copyfile(source, output / "source-snapshot.json")
    os.chmod(output / "source-snapshot.json", 0o600)
    verified = [row["historical"] for row in candidates if row["historicalVerified"]]
    analysis = {"observedAt": document.get("updatedAt"), "sourceSha256": source_hash,
                "candidates": len(candidates), "historicalSucceeded": len(verified),
                "historicalFailed": len(candidates) - len(verified),
                "distributions": {key: distribution(verified, key) for key in
                                  ["status", "mealPlan", "ratePlan", "sourceOfBusiness"]},
                "scope": "Historical Record View fields; Add-Ons were not expanded",
                "limitations": ["Outbound confirmation-PDF cohort, not a random or complete hotel sample",
                                 "Historical meal-plan labels do not prove attached PACK rows or booking-time input"]}
    write_json(output / "candidates.json", {"propertyCode": "HRCEN", "sourceSha256": source_hash,
                                            "candidates": candidates})
    write_json(output / "historical-analysis.json", analysis)
    write_json(output / "manifest.json", {"runId": output.name, "startedAt": now(), "propertyCode": "HRCEN",
                                          "source": str(source), "sourceSha256": source_hash,
                                          "sourceSnapshot": "source-snapshot.json", "codeRevision": revision,
                                          "candidateCount": len(candidates), "readOnly": True,
                                          "artifacts": ["source-snapshot.json", "candidates.json", "historical-analysis.json"],
                                          "limitations": analysis["limitations"]})
    print(json.dumps({"prepared": True, "candidates": len(candidates), "historicalSucceeded": len(verified),
                      "sourceSha256": source_hash, "output": str(output)}))


def load_json(path):
    return json.loads(path.read_text())


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def paired_distribution(rows, first, second):
    counts = Counter((row.get(first), row.get(second)) for row in rows)
    return [{first: a, second: b, "count": count} for (a, b), count in
            sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))]


def analyze(output, final):
    private_output(output)
    inputs = load_json(output / "candidates.json")
    manifest = load_json(output / "manifest.json")
    progress = load_json(output / "scan/progress.json")
    catalogues = load_json(output / "catalogues.json")
    candidates = inputs["candidates"]
    if (inputs["sourceSha256"] != manifest["sourceSha256"] or
            progress["sourceSha256"] != inputs["sourceSha256"] or
            progress["inputSha256"] != sha256(output / "candidates.json") or
            set(progress["results"]) - {row["confirmation"] for row in candidates}):
        raise ValueError("ANALYSIS_INPUT_MISMATCH")
    if final and (not progress.get("scanFinished") or len(progress["results"]) != len(candidates)):
        raise ValueError("SCAN_NOT_FINISHED")
    if final and sha256(output / "source-snapshot.json") != inputs["sourceSha256"]:
        raise ValueError("SOURCE_SNAPSHOT_CHANGED")

    catalogue_index = defaultdict(list)
    configuration = []
    for catalogue in catalogues["catalogues"]:
        configuration.append({"itemType": catalogue["itemType"], "outcome": catalogue["outcome"],
                              "coverage": catalogue["coverage"], "entries": catalogue["candidates"]})
        if catalogues.get("verified") and catalogue["outcome"] == "ok":
            for entry in catalogue["candidates"]:
                catalogue_index[(catalogue["itemType"], entry["itemId"])].append(entry)

    records, observed_rows, attempts, anomalies = [], [], [], []
    for candidate in candidates:
        confirmation = candidate["confirmation"]
        summary = progress["results"].get(confirmation)
        record = {"confirmation": confirmation, "historicalVerified": candidate["historicalVerified"],
                  "historical": candidate["historical"], "outcome": "not_attempted", "current": None,
                  "rowCount": None, "evidence": None}
        if not summary:
            records.append(record)
            continue
        for attempt in summary["attempts"]:
            raw = load_json(output / "scan" / attempt["artifact"])
            if (raw["confirmation"] != confirmation or raw["inputSha256"] != progress["inputSha256"] or
                    raw["sourceSha256"] != inputs["sourceSha256"]):
                raise ValueError("ATTEMPT_IDENTITY_MISMATCH")
            attempts.append({"confirmation": confirmation, "attempt": raw["attempt"], "ok": raw["ok"],
                             "issue": raw.get("issue"), "phase": raw.get("phase"),
                             "sessionVerified": raw["sessionVerified"], "writes": raw.get("writes", []),
                             "toolHashes": raw.get("toolHashes"), "artifact": "scan/" + attempt["artifact"]})
        raw = load_json(output / "scan" / summary["selectedArtifact"])
        record.update({"issue": raw.get("issue"), "attemptCount": len(summary["attempts"]),
                       "observedAt": raw["observedAt"], "evidence": "scan/" + summary["selectedArtifact"]})
        if not raw["ok"]:
            record["outcome"] = "failed"
            records.append(record)
            continue
        addons = raw["addOns"]
        if (not raw["sessionVerified"] or addons["target"]["confirmation"] != confirmation or
                addons["target"]["propertyCode"] != "HRCEN" or raw.get("writes")):
            raise ValueError("READ_ATTESTATION_FAILED")
        complete = addons.get("coverage", {}).get("complete") is True
        if complete != bool(raw["completeRead"]):
            raise ValueError("READ_COVERAGE_MISMATCH")
        fields = [item for card in raw["lookup"]["details"].get("cards", [])
                  if card.get("title") in ["Stay", "Associations"] for item in card.get("fields", [])]
        current = {key: field(fields, name) for key, name in {
            "status": "status", "mealPlan": "mealplan", "ratePlan": "rateplan",
            "sourceOfBusiness": "sourceofbusinessdesc", "arrival": "arrivaldate", "departure": "departuredate",
        }.items()}
        current["rawStatus"] = current["status"]
        current["status"] = status_label(current["rawStatus"])
        record.update({"outcome": "complete" if complete else "partial", "current": current,
                       "coverage": addons["coverage"], "rowCount": len(addons["rows"])})
        records.append(record)
        seen = {}
        for offset, row in enumerate(addons["rows"]):
            row_id = row.get("enhexpsequencekey")
            if row_id and row_id in seen:
                equal = seen[row_id] == row
                anomalies.append({"confirmation": confirmation, "rowId": row_id,
                                  "issue": "duplicate_identical_row" if equal else "conflicting_row_id",
                                  "evidence": record["evidence"]})
                if equal:
                    continue
            if not row_id:
                anomalies.append({"confirmation": confirmation, "offset": offset, "issue": "missing_row_id",
                                  "evidence": record["evidence"]})
            else:
                seen[row_id] = row
            matches = catalogue_index[(row.get("itemtype"), row.get("itemid"))]
            codes = [row.get(key) for key in ["itemorbundlecode", "item"] if row.get(key)]
            if len(set(codes)) > 1:
                anomalies.append({"confirmation": confirmation, "rowId": row_id, "issue": "conflicting_codes",
                                  "values": codes, "evidence": record["evidence"]})
            code = codes[0] if len(set(codes)) == 1 else None
            code_source = "saved_row" if code else None
            if not codes and len(matches) == 1:
                code, code_source = matches[0]["code"], "current_catalogue_exact_type_and_item_id"
            observed_rows.append({"confirmation": confirmation, "rowId": row_id, "offset": offset,
                                  "completeRead": complete, "itemType": row.get("itemtype"),
                                  "itemId": row.get("itemid"), "code": code, "codeSource": code_source,
                                  "name": row.get("itemdesc"), "bundleId": row.get("bundleid"),
                                  "parentId": row.get("enhancedbundleid"), "packageItem": row.get("packageitem"),
                                  "automaticallyAdded": row.get("automaticallyadded"),
                                  "currentRatePlan": current["ratePlan"], "currentStatus": current["status"],
                                  "currentMealPlan": current["mealPlan"], "evidence": record["evidence"]})

    complete_records = [row for row in records if row["outcome"] == "complete"]
    # Conflicting IDs cannot contribute twice to a usage count. Preserve both raw observations.
    conflicted = {(row["confirmation"], row["rowId"]) for row in anomalies
                  if row["issue"] == "conflicting_row_id"}
    usage_rows = [row for row in observed_rows if row["completeRead"] and
                  (row["confirmation"], row["rowId"]) not in conflicted]
    row_index = {(row["confirmation"], row["rowId"]): row for row in usage_rows if row["rowId"]}
    relationships = []
    for row in usage_rows:
        if row["parentId"] not in [None, ""]:
            parent = row_index.get((row["confirmation"], row["parentId"]))
            relationships.append({"confirmation": row["confirmation"], "rowId": row["rowId"],
                                  "rawParentId": row["parentId"], "matchedSavedRowId": parent["rowId"] if parent else None,
                                  "matchedParentType": parent["itemType"] if parent else None,
                                  "outcome": "matches_saved_row" if parent else "unresolved_parent_id",
                                  "evidence": row["evidence"]})
    changes = []
    for row in complete_records:
        if row["historicalVerified"]:
            for key in ["status", "mealPlan", "ratePlan", "sourceOfBusiness"]:
                old, current = row["historical"].get(key), row["current"].get(key)
                if key == "status":
                    old = status_label(old)
                if old is not None and current is not None and old != current:
                    changes.append({"confirmation": row["confirmation"], "field": key, "historical": old,
                                    "current": current, "evidence": row["evidence"]})
    by_type = []
    for item_type in sorted({row["itemType"] for row in usage_rows}, key=str):
        rows = [row for row in usage_rows if row["itemType"] == item_type]
        by_type.append({"itemType": item_type, "rows": len(rows),
                        "confirmations": len({row["confirmation"] for row in rows}),
                        "codes": distribution(rows, "code")})
    bundle_rows = [row for row in usage_rows if row["itemType"] == "PACK"]
    linked_rows = [row for row in usage_rows if row["bundleId"] not in [None, ""] or
                   row["parentId"] not in [None, ""] or row["packageItem"] not in [None, "", "0", 0]]
    limitations = manifest["limitations"] + [
        "Native PACK bundles and MEAL meal plans are separate categories; meal-plan labels are not PACK usage",
        "Fresh complete Add-On grids establish current rows, not past/deleted items or booking-time actions",
        "Type/item-ID catalogue joins describe current configuration; unresolved codes remain unknown",
        "Rate associations and automaticallyAdded flags do not establish creation or pricing rules",
        "Partial and failed reads are excluded from complete-grid usage denominators",
        "Raw source values are retained; known status labels are grouped separately from cancellation-number lines",
        "Other raw label formatting differences may appear as disagreements",
    ]
    recommendation = {
        "bundleWorkflow": "Investigate populated PACK or linked-package examples before deciding bundle-write scope" if bundle_rows or linked_rows else
                          "Defer separate PACK writes: configured conference bundles were not observed in complete cohort reads",
        "reads": "Keep the existing saved Add-On/detail reader and the typed ITEM/MEAL/PACK catalogue reader",
        "nextProof": "Native bundle preparation, component behavior, Save and independent readback remain unproven",
        "mealPlans": "Use the reservation rate/meal-plan field evidence separately from Non-Room Bundle usage",
    }
    if not final:
        recommendation["bundleWorkflow"] = "Provisional: continue the remaining cohort reads before deciding bundle-write scope"
    elif not complete_records:
        recommendation["bundleWorkflow"] = "No complete reads: bundle usage remains unknown"
    rate_path = output / "rate-catalogue-attempt-2.json"
    rate_configuration = {"outcome": "not_read"}
    if rate_path.exists():
        rate = load_json(rate_path)
        catalogue = rate.get("catalogue", {})
        rate_configuration = {"evidence": rate_path.name, "sessionVerified": rate.get("verified"),
                              "outcome": catalogue.get("outcome"), "coverage": catalogue.get("coverage"),
                              "cleanup": rate.get("cleanup"), "scope": rate.get("scope")}
        if rate.get("verified") and catalogue.get("outcome") == "matches" and rate.get("cleanup", {}).get("outcome") == "closed_unsaved":
            flags = [{"code": row["code"], "name": row["name"],
                      "mealPlanFlag": row.get("responseData", {}).get("mealplan"),
                      "nonRoomBundleFlag": row.get("responseData", {}).get("nonroombundle")}
                     for row in catalogue["candidates"]]
            rate_configuration.update({"entries": flags,
                                       "rawMealPlanFlags": distribution(flags, "mealPlanFlag"),
                                       "rawNonRoomBundleFlags": distribution(flags, "nonRoomBundleFlag"),
                                       "interpretation": "Raw catalogue flags, not bundle/meal IDs or proof of automatic attachment"})
    detail_evidence = {"outcome": "not_read"}
    if (output / "details.json").exists():
        detail = load_json(output / "details.json")
        samples = detail.get("cohortExamples", [])
        detail_evidence = {"evidence": "details.json", "cohortSamples": sum(row["counts"]["total"] for row in samples),
                           "completeSamples": sum(row["counts"]["completeReads"] for row in samples),
                           "cohortSelectionComplete": detail.get("cohortSelectionComplete"), "labExcludedFromUsage": True}
    analysis = {"schemaVersion": 1, "final": final, "analyzedAt": now(), "propertyCode": "HRCEN",
                "sourceSha256": inputs["sourceSha256"], "inputSha256": progress["inputSha256"],
                "observationWindow": {"startedAt": progress["startedAt"], "updatedAt": progress["updatedAt"]},
                "coverage": {"candidates": len(candidates), "attempted": len(progress["results"]),
                             "attempts": len(attempts), "outcomes": distribution(records, "outcome"),
                             "completeReads": len(complete_records),
                             "completeEmpty": sum(row["rowCount"] == 0 for row in complete_records),
                             "completePopulated": sum(row["rowCount"] > 0 for row in complete_records),
                             "retriedConfirmations": sum(row.get("attemptCount", 0) > 1 for row in records),
                             "failedLookupIssues": distribution([row for row in records if row["outcome"] == "failed"], "issue"),
                             "writeRequestsObserved": sum(len(row["writes"]) for row in attempts)},
                "configuration": configuration, "rateConfiguration": rate_configuration, "detailEvidence": detail_evidence,
                "usage": {"denominator": len(complete_records), "byType": by_type,
                    "countUnit": "saved rows under complete reads; child items are not counted as PACK parents",
                    "rowCount": len(usage_rows), "identifiedRows": sum(bool(row["rowId"]) for row in usage_rows),
                    "unidentifiedRows": sum(not row["rowId"] for row in usage_rows),
                    "bundleParentRows": len(bundle_rows),
                    "rowsWithBundleOrPackageLinks": len(linked_rows),
                    "linkedBundleChildRows": sum(row["matchedParentType"] == "PACK" for row in relationships),
                    "byTypeAndCode": paired_distribution(usage_rows, "itemType", "code"),
                    "byTypeAndRate": paired_distribution(usage_rows, "itemType", "currentRatePlan"),
                    "byTypeAndStatus": paired_distribution(usage_rows, "itemType", "currentStatus"),
                    "packageFlags": distribution(usage_rows, "packageItem"),
                    "automaticFlags": distribution(usage_rows, "automaticallyAdded")},
                "currentFields": {key: distribution([row["current"] for row in complete_records], key)
                                  for key in ["status", "mealPlan", "ratePlan", "sourceOfBusiness"]},
                "historicalRateMealAssociations": paired_distribution(
                    [row["historical"] for row in candidates if row["historicalVerified"]], "ratePlan", "mealPlan"),
                "currentRateMealAssociations": paired_distribution(
                    [row["current"] for row in complete_records], "ratePlan", "mealPlan"),
                "historicalCurrentDisagreements": changes, "relationships": relationships,
                "rowIdentityAnomalies": anomalies, "observedRows": observed_rows, "records": records,
                "attempts": attempts, "recommendation": recommendation, "limitations": limitations}
    write_json(output / ("analysis.json" if final else "analysis-in-progress.json"), analysis)
    if final:
        hashes = {str(path.relative_to(output)): {"sha256": sha256(path), "bytes": path.stat().st_size}
                  for path in sorted(output.rglob("*.json")) if path.name != "manifest.json"}
        manifest.update({"completedAt": now(), "coverage": analysis["coverage"], "artifactHashes": hashes,
                         "analysisScriptSha256": sha256(Path(__file__)), "limitations": limitations})
        write_json(output / "manifest.json", manifest)
    print(json.dumps({"final": final, "coverage": analysis["coverage"], "usageByType": by_type}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    freeze = commands.add_parser("prepare")
    freeze.add_argument("source", type=Path)
    freeze.add_argument("output", type=Path)
    freeze.add_argument("--revision", required=True)
    summary = commands.add_parser("analyze")
    summary.add_argument("output", type=Path)
    summary.add_argument("--final", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "prepare":
        prepare(args.source.resolve(), args.output.resolve(), args.revision)
    else:
        analyze(args.output.resolve(), args.final)


if __name__ == "__main__":
    main()
