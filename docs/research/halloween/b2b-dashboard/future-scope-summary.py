#!/usr/bin/env python3
"""Summarise a time window of saved inbound labels and a group-inclusive scenario."""

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path


WORKFLOWS = {
    'quote', 'booking_create', 'booking_amend', 'booking_cancel',
    'file_payment_proof', 'file_voucher', 'invoice',
}
ACTIVE_STATES = {'requested', 'supplied_for_action', 'completed_or_confirmed'}


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError(f'timestamp needs a UTC offset: {value}')
    return result


def actions(row, scopes):
    details = (row.get('action_details') or {}).get('request_actions', [])
    return [item for item in details if item.get('action') in WORKFLOWS
            and item.get('state') in ACTIVE_STATES and item.get('scope') in scopes]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--start', required=True, help='inclusive timestamp with UTC offset')
    parser.add_argument('--end', required=True, help='exclusive timestamp with UTC offset')
    parser.add_argument('--accept-uncertain', nargs='*', default=[], metavar='CASE')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    private = (Path(__file__).resolve().parents[4] / '.private').resolve(strict=True)
    dataset = args.dataset.resolve(strict=True)
    output = args.output.absolute()
    if not dataset.is_relative_to(private) or not output.parent.resolve(strict=True).is_relative_to(private):
        raise ValueError('dataset and output must be inside .private')
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')
    start, end = timestamp(args.start), timestamp(args.end)
    if start >= end:
        raise ValueError('start must be before end')

    raw = dataset.read_bytes()
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if len({row['case'] for row in rows}) != len(rows):
        raise ValueError('duplicate case IDs')
    window = [row for row in rows if start <= timestamp(row['inbound']['date']) < end]
    actionable = [row for row in window if (row.get('classification') or {}).get('reservation_email') is True]
    staff = [row for row in actionable if row['classification'].get('response_type') in {'staff', 'both'}]
    baseline = {row['case'] for row in staff if row['classification'].get('can_help') is True}

    group_rows = [row for row in staff if 'group' in (row['classification'].get('actions') or [])]
    group_added = {
        row['case'] for row in group_rows if row['case'] not in baseline
        and actions(row, {'large_group', 'unclear'})
    }
    scope_candidates = {
        row['case'] for row in staff if row['case'] not in baseline | group_added
        and row['classification'].get('can_help') is None
        and actions(row, {'non_group', 'large_group', 'unclear'})
    }
    accepted = set(args.accept_uncertain)
    if len(accepted) != len(args.accept_uncertain) or not accepted <= scope_candidates:
        raise ValueError('accepted cases must be unique and drawn from the scope candidates')
    future = baseline | group_added | accepted
    group_breakdown = Counter(
        action for row in group_rows if row['case'] in group_added
        for action in {item['action'] for item in actions(row, {'large_group', 'unclear'})}
    )
    counts = {
        'inbound': len(window),
        'actionable_reservation': len(actionable),
        'staff_linked': len(staff),
        'original_potential_non_group': len(baseline),
        'staff_linked_large_group_tag': len(group_rows),
        'additional_group_candidates': len(group_added),
        'scope_candidates_to_review': len(scope_candidates),
        'reviewed_scope_candidates_added': len(accepted),
        'future_group_inclusive': len(future),
        'outside_future_estimate': len(staff) - len(future),
    }
    result = {
        'source_sha256': hashlib.sha256(raw).hexdigest(),
        'window_start_inclusive': args.start,
        'window_end_exclusive': args.end,
        'unit': 'deduplicated inbound email with a model-linked staff reply',
        'counts': counts,
        'group_actions_overlapping': dict(sorted(group_breakdown.items())),
        'case_ids': {
            'original_potential_non_group': sorted(baseline),
            'additional_group_candidates': sorted(group_added),
            'scope_candidates_to_review': sorted(scope_candidates),
            'reviewed_scope_candidates_added': sorted(accepted),
            'future_group_inclusive': sorted(future),
            'outside_future_estimate': sorted({row['case'] for row in staff} - future),
        },
    }
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
        json.dump(result, target, ensure_ascii=False, indent=2)
        target.write('\n')
    print(json.dumps({'counts': counts, 'group_actions_overlapping': result['group_actions_overlapping']}))


if __name__ == '__main__':
    main()
