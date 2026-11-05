#!/usr/bin/env python3
"""Report linked and all outbound audiences from source-bound To/Cc metadata."""

import argparse
import collections
import importlib.util
import json
import os
from pathlib import Path


HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--labeled', type=Path, required=True)
    parser.add_argument('--source', action='append', required=True, help='Source precedence as label=private-jsonl; repeat oldest to newest.')
    parser.add_argument('--outbound-prompt', type=Path, default=HERE / '2026-11-01-luna-outbound-prompt.md')
    parser.add_argument('--internal-domain', action='append', default=[],
                        help='Override domains inferred from saved outbound senders; repeat as needed.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    env = module('mailbox_envelope', 'mailbox-augment-inbound-envelope.py')
    agg = module('mailbox_aggregate', 'centurion-aggregate-opportunity.py')
    output = env._private_path(args.output, existing=False)
    labeled_path = env._private_path(args.labeled, existing=True)
    sources = []
    for item in args.source:
        if '=' not in item:
            raise SystemExit('source must be label=path')
        label, path = item.split('=', 1)
        sources.append((label, env._private_path(path, existing=True)))
    source_rows, source_info = env.load_source_rows(sources)
    domains = set(d.casefold().strip() for d in args.internal_domain) or source_info['internal_domains']
    if not domains or any(not d or '@' in d or ' ' in d for d in domains):
        raise SystemExit('internal domains invalid')

    packets, outbound_results, status = agg.load_direction(args.directory, 'outbound', args.outbound_prompt)
    if status['ok'] != status['input']:
        raise SystemExit('outbound classifications incomplete')
    index = {row['case']: row for row in env.build_envelope_index(list(packets.values()), source_rows)}
    if any(row['source_status'] != 'ok' for row in index.values()):
        raise SystemExit('outbound envelope source incomplete')

    def audience(case):
        row = index[case]
        addresses = set((row.get('to') or []) + (row.get('cc') or []))
        if any(address.rsplit('@', 1)[-1] not in domains for address in addresses):
            return 'external_recipient_observed'
        if addresses:
            return 'only_internal_recipients_observed'
        return 'recipient_unknown'

    labeled = agg.read_jsonl(labeled_path)
    if len({row['case'] for row in labeled}) != len(labeled):
        raise SystemExit('duplicate labeled case')
    reservation, helped = set(), set()
    for row in labeled:
        classification = row.get('classification') or {}
        if classification.get('reservation_email') is not True:
            continue
        replies = row.get('candidate_replies') or []
        if {reply['reply_id'] for reply in replies} != set(classification.get('reply_ids') or []):
            raise SystemExit('linked candidates mismatch')
        for reply in replies:
            outcase = reply.get('outbound_case')
            if outcase not in packets:
                raise SystemExit('linked outbound missing')
            reservation.add(outcase)
            if classification.get('can_help') is True:
                helped.add(outcase)

    def counts(cases):
        result = collections.defaultdict(collections.Counter)
        for case in cases:
            result[outbound_results[case]['message_type']][audience(case)] += 1
        return {kind: dict(sorted(bucket.items())) for kind, bucket in sorted(result.items())}

    report = {
        'internal_domains': sorted(domains),
        'domain_method': 'explicit' if args.internal_domain else 'domains observed as saved outbound senders',
        'source': source_info['summary'],
        'outbound': status,
        'recipient_field_status': dict(collections.Counter(
            f'{field}:{row[field + "_status"]}' for row in index.values() for field in ('to', 'cc'))),
        'all_outbounds': counts(set(packets)),
        'distinct_outbounds_linked_to_reservation': counts(reservation),
        'distinct_outbounds_linked_to_helpable': counts(helped),
        'interpretation': ('A known external To or Cc establishes an observed external recipient. '
                           'Internal-only observed recipients do not prove no external Cc: the source '
                           'export collapses empty and missing recipient fields. Model reply links are estimates.'),
    }
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as target:
        json.dump(report, target, indent=2, ensure_ascii=False)
        target.write('\n')
    print(json.dumps({key: report[key] for key in ('internal_domains', 'recipient_field_status', 'all_outbounds',
                                                    'distinct_outbounds_linked_to_reservation',
                                                    'distinct_outbounds_linked_to_helpable')}))


if __name__ == '__main__':
    main()
