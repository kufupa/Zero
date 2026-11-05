#!/usr/bin/env python3
"""Count saved-source directions and selected exact From hosts, without printing mail.

The input must be a saved corpus.jsonl using the thread/messages/sourceRows schema.
Each selected source row is counted once per transport, not deduplicated across
mailboxes. Dates use the stored message timestamp prefix. This does not classify
work, establish sender authenticity, or prove that a message was automated.
"""

import argparse
import collections
import datetime as dt
import email.utils
import hashlib
import json
import pathlib
import re


def date_arg(value):
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise argparse.ArgumentTypeError("dates must be YYYY-MM-DD") from exc


def host_arg(value):
    value = value.casefold().strip()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value):
        raise argparse.ArgumentTypeError("host must be an exact domain, without @ or wildcards")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="owner-only saved corpus.jsonl")
    parser.add_argument("--transport", action="append", required=True, help="exact transport ID; repeat as needed")
    parser.add_argument("--host", action="append", type=host_arg, default=[], help="exact From host; repeat as needed")
    parser.add_argument("--start", type=date_arg, help="inclusive stored date")
    parser.add_argument("--end", type=date_arg, help="inclusive stored date")
    args = parser.parse_args()
    if args.start and args.end and args.start > args.end:
        parser.error("--start must be no later than --end")

    selected_hosts = set(args.host)
    transports = set(args.transport)
    directions = collections.Counter()
    host_counts = {host: collections.Counter() for host in sorted(selected_hosts)}
    inbound_stats = collections.Counter()
    date_stats = collections.Counter()
    scope_stats = collections.Counter()
    transport_counts = collections.Counter()
    dated = []
    source_hash = hashlib.sha256()

    with args.source.open("rb") as source:
        for raw in source:
            source_hash.update(raw)
            record = json.loads(raw)
            if record.get("recordType") != "thread":
                continue
            scope_stats["thread_records"] += 1
            for message in record.get("messages", []):
                scope_stats["messages_in_threads"] += 1
                day = str(message.get("timestamp") or "")[:10]
                try:
                    day_valid = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)) and dt.date.fromisoformat(day).isoformat() == day
                except ValueError:
                    day_valid = False
                rows = message.get("sourceRows") or []
                if not rows:
                    scope_stats["messages_without_source_rows"] += 1
                for row in rows:
                    scope_stats["source_rows"] += 1
                    private = row.get("privateMessage") or {}
                    metadata = private.get("sourceMetadata") or {}
                    if "active_transport" not in (row.get("scopeMembership") or []):
                        continue
                    scope_stats["active_transport_rows"] += 1
                    transport = metadata.get("transportId")
                    if transport not in transports:
                        continue
                    transport_counts[transport] += 1
                    if not day_valid:
                        date_stats["scoped_rows_with_unusable_date"] += 1
                        if args.start or args.end:
                            date_stats["excluded_unusable_date"] += 1
                            continue
                    if (args.start and day < args.start) or (args.end and day > args.end):
                        continue
                    if day_valid:
                        dated.append(day)
                    direction = private.get("direction")
                    direction = direction if direction in ("inbound", "outbound") else "unknown"
                    directions[direction] += 1
                    if direction != "inbound":
                        continue

                    sender = (private.get("addresses") or {}).get("from") or []
                    if isinstance(sender, str):
                        sender = [sender]
                    addresses = [address.casefold() for _, address in email.utils.getaddresses(sender) if "@" in address]
                    domains = {address.rsplit("@", 1)[1] for address in addresses}
                    if not domains:
                        inbound_stats["no_parseable_from"] += 1
                    if len(addresses) > 1:
                        inbound_stats["multiple_from_addresses"] += 1
                    no_reply_clue = any(re.search(r"no[-_.]?reply", address.rsplit("@", 1)[0]) for address in addresses)
                    subject = str(private.get("subject") or "")
                    integration_clue = "reservation failed to integrate" in subject.casefold()
                    inbound_stats["no_reply_sender_clue"] += bool(no_reply_clue)
                    inbound_stats["subject_contains_integration_phrase"] += bool(integration_clue)
                    inbound_stats["integration_phrase_and_no_reply_clue"] += bool(integration_clue and no_reply_clue)
                    inbound_stats["selected_host_union"] += bool(domains & selected_hosts)
                    for host in domains & selected_hosts:
                        host_no_reply_clue = any(
                            address.rsplit("@", 1)[1] == host
                            and re.search(r"no[-_.]?reply", address.rsplit("@", 1)[0])
                            for address in addresses
                        )
                        host_counts[host]["inbound"] += 1
                        host_counts[host]["multiple_from_addresses"] += len(addresses) > 1
                        host_counts[host]["no_reply_sender_clue"] += bool(host_no_reply_clue)
                        host_counts[host]["subject_contains_integration_phrase"] += bool(integration_clue)
                        host_counts[host]["integration_phrase_and_no_reply_clue"] += bool(integration_clue and host_no_reply_clue)

    if not scope_stats["thread_records"] or not transport_counts:
        raise SystemExit("No selected active-transport rows; verify the source schema and transport IDs.")

    result = {
        "source_sha256": source_hash.hexdigest(),
        "source_scope_checks": {
            **{key: scope_stats[key] for key in (
                "thread_records", "messages_in_threads", "messages_without_source_rows",
                "source_rows", "active_transport_rows")},
            "selected_transport_rows_before_date_filter": {key: transport_counts[key] for key in sorted(transports)},
        },
        "stored_date_filter": {"start_inclusive": args.start, "end_inclusive": args.end},
        "observed_stored_dates": {"first": min(dated) if dated else None, "last": max(dated) if dated else None},
        "stored_date_gaps": {key: date_stats[key] for key in ("scoped_rows_with_unusable_date", "excluded_unusable_date")},
        "unit": "selected active-transport source rows; unresolved duplicates retained",
        "directions": {key: directions[key] for key in ("inbound", "outbound", "unknown")},
        "inbound_statistics": {key: inbound_stats[key] for key in (
            "no_parseable_from", "multiple_from_addresses", "selected_host_union",
            "no_reply_sender_clue", "subject_contains_integration_phrase", "integration_phrase_and_no_reply_clue")},
        "exact_from_hosts": {host: {key: counts[key] for key in (
            "inbound", "multiple_from_addresses", "no_reply_sender_clue", "subject_contains_integration_phrase",
            "integration_phrase_and_no_reply_clue")}
            for host, counts in host_counts.items()},
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
