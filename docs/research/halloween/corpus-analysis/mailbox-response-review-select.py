#!/usr/bin/env python3
"""Select invoice/reply inconsistencies for semantic re-review, not rule-based labeling."""

import argparse
import collections
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PRIVATE = ROOT / '.private'
TYPES = {'staff_written', 'pms_confirmation_template', 'other_automated', 'other', 'unknown'}


def read(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def latest(records):
    result = {}
    for row in records:
        old = result.get(row['case'])
        if row.get('attempt') != (old['attempt'] + 1 if old else 1) or (old and old['status'] != 'failed'):
            raise ValueError('invalid result retry order')
        result[row['case']] = row
    return result


def private_write(path, rows):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inbound', type=Path, required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--outbound-results', type=Path, required=True)
    parser.add_argument('--exclude-packets', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    args = parser.parse_args()
    if any(not path.resolve().is_relative_to(PRIVATE.resolve()) for path in (args.output, args.selection)):
        raise ValueError('outputs must be private')
    packets = {row['case']: row for row in read(args.inbound)}
    classifications = latest(read(args.results))
    outgoing = latest(read(args.outbound_results))
    excluded = {row['case'] for path in args.exclude_packets for row in read(path)}
    rows, selection, counts = [], [], collections.Counter()
    for case, record in classifications.items():
        if case in excluded or record['status'] != 'ok' or case not in packets:
            continue
        result, packet = record['result'], packets[case]
        candidates = packet.get('candidate_replies') or []
        if result.get('reservation_email') is not True or not candidates:
            continue
        by_reply = {row['reply_id']: row for row in candidates}
        if not set(result['reply_ids']).issubset(by_reply):
            raise ValueError('linked candidate absent')
        annotated = []
        for candidate in candidates:
            out = outgoing.get(candidate.get('outbound_case'))
            kind = (out or {}).get('result', {}).get('message_type')
            if not out or out['status'] != 'ok' or kind not in TYPES:
                raise ValueError('candidate outbound classification absent')
            annotated.append({**candidate, 'outbound_message_type': kind})
        kinds = {row['outbound_message_type'] for row in annotated if row['reply_id'] in result['reply_ids']}
        staff, pms = 'staff_written' in kinds, 'pms_confirmation_template' in kinds
        expected = ('both' if staff and pms else 'staff' if staff else
                    'hms_confirmation_candidate' if pms else 'other')
        reasons = []
        if 'invoice' in result['actions']:
            reasons.append('invoice_with_candidate_replies')
        if result['reply_ids'] and result['response_type'] != expected:
            reasons.append('independent_reply_type_disagreement')
        if not reasons:
            continue
        counts.update(reasons)
        rows.append({**packet, 'candidate_replies': annotated})
        selection.append({'case': case, 'reasons': reasons})
    private_write(args.output, rows)
    private_write(args.selection, selection)
    print(json.dumps({'selected': len(rows), 'selection_reasons': dict(counts)}, sort_keys=True))


if __name__ == '__main__':
    main()
