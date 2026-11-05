#!/usr/bin/env python3
"""Rank frequent outbound To hosts in a saved corpus; print aggregates only.

Each saved source row contributes at most once per exact To host. Rows with
multiple hosts can appear in more than one count. CC/BCC, deduplication,
delivery, and replies are outside this tally. Low-frequency hosts are hidden;
the script never prints addresses or message contents.
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
    parser.add_argument("--minimum-count", type=int, default=25)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    if args.minimum_count < 25 or not 1 <= args.limit <= 50:
        parser.error("minimum-count must be at least 25; limit must be 1–50")

    digest = hashlib.sha256()
    hosts = collections.Counter()
    total = missing = multiple_hosts = 0
    with args.source.open("rb") as stream:
        for raw in stream:
            digest.update(raw)
            thread = json.loads(raw)
            if thread.get("recordType") != "thread":
                continue
            for message in thread.get("messages") or []:
                for row in message.get("sourceRows") or []:
                    private = row.get("privateMessage") or {}
                    if ("active_transport" not in (row.get("scopeMembership") or [])
                            or (private.get("sourceMetadata") or {}).get("transportId") != args.transport
                            or private.get("direction") != "outbound"):
                        continue
                    total += 1
                    values = (private.get("addresses") or {}).get("to") or []
                    if isinstance(values, str):
                        values = [values]
                    parsed = [address.casefold() for _, address in email.utils.getaddresses(values)
                              if "@" in address]
                    domains = {address.rsplit("@", 1)[1].rstrip(".") for address in parsed}
                    domains = {domain for domain in domains if HOST.fullmatch(domain)}
                    missing += not bool(domains)
                    multiple_hosts += len(domains) > 1
                    hosts.update(domains)
    if not total:
        raise SystemExit("No outbound rows found for the selected transport.")
    ranked = sorted(((host, count) for host, count in hosts.items() if count >= args.minimum_count),
                    key=lambda pair: (-pair[1], pair[0]))[:args.limit]
    print(json.dumps({
        "source_sha256": digest.hexdigest(),
        "unit": "saved outbound source rows with a To host, not distinct deliveries or recipients",
        "outbound_rows": total,
        "rows_without_parseable_to_host": missing,
        "rows_with_multiple_to_hosts": multiple_hosts,
        "minimum_count": args.minimum_count,
        "ranked_to_hosts": [{"host": host, "rows": count} for host, count in ranked],
    }, indent=2))


if __name__ == "__main__":
    main()
