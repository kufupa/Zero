#!/usr/bin/env python3
"""Rank frequent inbound From hosts in a saved corpus; print aggregates only.

Counts saved source rows, without deduplication or sender authentication. A row
with more than one From host can contribute to each host. Low-frequency hosts
are suppressed; this program never prints mail addresses or message content.
"""

import argparse
import collections
import email.utils
import hashlib
import json
import pathlib
import re


HOST = re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\Z")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("--transport", required=True)
    parser.add_argument("--minimum-count", type=int, default=100)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    if args.minimum_count < 25 or not 1 <= args.limit <= 50:
        parser.error("minimum-count must be at least 25; limit must be 1–50")
    digest = hashlib.sha256()
    directions, hosts = collections.Counter(), collections.Counter()
    missing = multiple = 0
    with args.source.open("rb") as stream:
        for raw in stream:
            digest.update(raw)
            thread = json.loads(raw)
            if thread.get("recordType") != "thread":
                continue
            for message in thread.get("messages") or []:
                for row in message.get("sourceRows") or []:
                    private = row.get("privateMessage") or {}
                    if "active_transport" not in (row.get("scopeMembership") or []):
                        continue
                    if (private.get("sourceMetadata") or {}).get("transportId") != args.transport:
                        continue
                    direction = private.get("direction")
                    directions[direction if direction in ("inbound", "outbound") else "unknown"] += 1
                    if direction != "inbound":
                        continue
                    values = (private.get("addresses") or {}).get("from") or []
                    if isinstance(values, str):
                        values = [values]
                    parsed = [a.casefold() for _, a in email.utils.getaddresses(values) if "@" in a]
                    domains = {a.rsplit("@", 1)[1].rstrip(".") for a in parsed}
                    domains = {domain for domain in domains if HOST.fullmatch(domain)}
                    missing += not bool(domains)
                    multiple += len(parsed) > 1
                    hosts.update(domains)
    if not directions["inbound"]:
        raise SystemExit("No inbound rows found for the selected transport.")
    ranked = sorted(((host, count) for host, count in hosts.items() if count >= args.minimum_count),
                    key=lambda pair: (-pair[1], pair[0]))[:args.limit]
    print(json.dumps({
        "source_sha256": digest.hexdigest(),
        "unit": "saved active-transport source rows, not deduplicated deliveries",
        "directions": {key: directions[key] for key in ("inbound", "outbound", "unknown")},
        "inbound_no_parseable_from_host": missing,
        "inbound_multiple_from_addresses": multiple,
        "minimum_count": args.minimum_count,
        "ranked_from_hosts": [{"host": host, "rows": count} for host, count in ranked],
    }, indent=2))


if __name__ == "__main__":
    main()
