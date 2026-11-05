#!/usr/bin/env python3
"""Count exact links to an older saved attachment export without printing mail.

The older export is an observation made after the message, not proof that a
file was available at the original decision point. PDF/image bytes were not
preserved. Default execution excludes holdout and embargoed cases.
"""

import argparse
import collections
import email.utils
import gzip
import hashlib
import json
import os
import pathlib
import stat
import sys


def addresses(values):
    if isinstance(values, str):
        values = [values]
    return {address.casefold() for _, address in email.utils.getaddresses(values or []) if address}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("manifest", type=pathlib.Path)
    parser.add_argument("old_threads", type=pathlib.Path)
    parser.add_argument("old_selections", type=pathlib.Path)
    parser.add_argument("--after-freeze", action="store_true", help="also count sealed/embargoed cases")
    parser.add_argument("--cohort", choices=("random_development", "random_holdout", "targeted_development"))
    parser.add_argument("--embargoed-only", action="store_true")
    parser.add_argument("--details", type=pathlib.Path, help="new private per-case count file")
    args = parser.parse_args()
    if not args.after_freeze and (args.cohort == "random_holdout" or args.embargoed_only):
        parser.error("sealed and embargoed cases require --after-freeze")
    root = pathlib.Path(".private").resolve(strict=True)
    source, manifest_path = args.source.resolve(strict=True), args.manifest.resolve(strict=True)
    if not source.is_relative_to(root) or not manifest_path.is_relative_to(root):
        raise ValueError("private_source_required")
    if stat.S_IMODE(manifest_path.stat().st_mode) != 0o600:
        raise ValueError("private_manifest_required")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    selected = [
        item for item in manifest["selected"]
        if args.after_freeze or (item["cohort"] != "random_holdout" and not item.get("embargoed"))
    ]
    selected = [item for item in selected if not args.cohort or item["cohort"] == args.cohort]
    if args.embargoed_only:
        selected = [item for item in selected if item.get("embargoed")]
    by_line = collections.defaultdict(list)
    for item in selected:
        by_line[item["source_line"]].append(item)
    found = {}
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            digest.update(raw)
            if line_number not in by_line:
                continue
            thread = json.loads(raw)
            for item in by_line[line_number]:
                message = thread["messages"][item["message_index"]]
                rows = [row for row in message["sourceRows"] if row.get("sourceRowId") == item["source_row_id"]]
                if len(rows) != 1 or thread.get("threadId") != item["thread_id"]:
                    raise ValueError("source_link_mismatch")
                row = rows[0]
                private = row.get("privateMessage") or {}
                if (private.get("direction") != "inbound"
                        or "active_transport" not in (row.get("scopeMembership") or [])
                        or (private.get("sourceMetadata") or {}).get("transportId") != "transport-centurion"):
                    raise ValueError("source_scope_mismatch")
                identifier = item["source_row_id"]
                if identifier in found:
                    raise ValueError("duplicate_source_id")
                found[identifier] = {
                    "case_id": item["case_id"], "thread": item["thread_id"],
                    "subject": str(private.get("subject") or ""), "body": str(row.get("body") or ""),
                    "from": addresses((private.get("addresses") or {}).get("from")),
                }
    if digest.hexdigest() != manifest["source_sha256"] or len(found) != len(selected):
        raise ValueError("source_fingerprint_or_count_mismatch")

    older, older_seen = {}, set()
    with gzip.open(args.old_threads, "rt", encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            identifier = str(row.get("id") or "")
            if identifier not in found:
                continue
            if identifier in older_seen:
                raise ValueError("duplicate_old_message_id")
            older_seen.add(identifier)
            current = found[identifier]
            exact = (
                row.get("direction") == "inbound"
                and row.get("thread_id") == current["thread"]
                and str(row.get("subject") or "") == current["subject"]
                and str(row.get("text_body") or "") == current["body"]
                and bool(current["from"])
                and addresses(row.get("from_address")) == current["from"]
            )
            if exact:
                older[identifier] = row

    selections, selection_seen = {}, set()
    with gzip.open(args.old_selections, "rt", encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            identifier = str(row.get("messageId") or "")
            if identifier not in found:
                continue
            if identifier in selection_seen:
                raise ValueError("duplicate_old_selection_id")
            selection_seen.add(identifier)
            current = found[identifier]
            exact = (
                identifier in older
                and row.get("threadId") == current["thread"]
                and str(row.get("subject") or "") == current["subject"]
                and str(row.get("bodyText") or "") == current["body"]
                and addresses(row.get("fromAddress")) == current["from"]
            )
            if exact:
                selections[identifier] = row

    stats = collections.Counter()
    stats["selected_cases"] = len(selected)
    stats["old_thread_id_matches"] = len(older_seen)
    stats["old_thread_exact_matches"] = len(older)
    stats["old_selection_id_matches"] = len(selection_seen)
    stats["old_selection_exact_matches"] = len(selections)
    details = []
    for identifier, current in found.items():
        old = older.get(identifier)
        old_selection = selections.get(identifier)
        descriptors = (old.get("attachments") or []) if old else []
        descriptor_ids = {str(a.get("id") or "") for a in descriptors if a.get("id")}
        extracted = []
        if old_selection:
            extracted = [a for a in old_selection.get("attachments") or [] if str(a.get("id") or "") in descriptor_ids]
        text_count = sum(bool(str(a.get("text") or "").strip()) for a in extracted)
        stats["exact_matches_with_later_attachment_metadata"] += bool(descriptors)
        stats["later_attachment_descriptors"] += len(descriptors)
        stats["exact_matches_with_linked_later_extracted_text"] += bool(text_count)
        stats["linked_later_extracted_texts"] += text_count
        details.append({
            "case_id": current["case_id"], "old_message_exact": bool(old),
            "old_selection_exact": bool(old_selection), "later_metadata_count": len(descriptors),
            "later_linked_text_count": text_count,
        })
    if args.details:
        destination = args.details
        if destination.parent.resolve(strict=True) != manifest_path.parent or destination.exists():
            raise ValueError("details_must_be_new_pilot_private_file")
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for row in details:
                output.write(json.dumps(row, separators=(",", ":")) + "\n")
    print(json.dumps(dict(sorted(stats.items())), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, TypeError, OSError, IndexError) as exc:
        print("old export audit failed:", type(exc).__name__, file=sys.stderr)
        sys.exit(1)
