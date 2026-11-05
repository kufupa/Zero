#!/usr/bin/env python3
"""Select labeled workflow and uncertain cases for a semantic review, not a rule label."""

import argparse
import collections
import importlib.util
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'
spec = importlib.util.spec_from_file_location('luna_corpus_runner', HERE / 'luna-corpus-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def load(path):
    source = runner._validate_private_path(path, PRIVATE, must_exist=True)
    with source.open(encoding='utf-8') as f:
        rows = [json.loads(line) for line in f if line.strip()]
    indexed = {row['case']: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError('duplicate_case')
    return indexed


def write(path, rows):
    target = runner._validate_private_path(path, PRIVATE, must_exist=False)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--labeled', type=Path, required=True)
    parser.add_argument('--action', action='append', default=[], choices=runner.INBOUND_ACTIONS)
    parser.add_argument('--include-unclear', action='store_true')
    parser.add_argument('--include-reservation', action='store_true',
                        help='Review every currently actionable reservation email.')
    parser.add_argument('--include-high-attendance', action='store_true',
                        help='Also review current text mentioning at least 30 attendees or rooms; this selects, not labels.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    args = parser.parse_args()
    if not args.action and not args.include_unclear and not args.include_reservation and not args.include_high_attendance:
        raise ValueError('selection_criterion_required')
    packets, labels = load(args.packets), load(args.labeled)
    selected, reasons, counts = [], [], collections.Counter()
    for case, packet in packets.items():
        label = labels.get(case)
        if not label or label.get('classification') is None:
            continue
        if label.get('_source') != packet.get('_source') or label.get('inbound') != packet.get('inbound'):
            raise ValueError('packet_label_source_mismatch')
        classification = label['classification']
        matched = sorted(set(args.action) & set(classification.get('actions') or []))
        if args.include_unclear and (classification.get('reservation_email') is None
                                    or classification.get('can_help') is None):
            matched.append('unclear')
        if args.include_reservation and classification.get('reservation_email') is True:
            matched.append('reservation')
        if args.include_high_attendance:
            current = ' '.join(str(packet['inbound'].get(field) or '') for field in ('subject', 'message'))
            pattern = (r'\b(\d{2,3})\s*(?:x\s*)?(?:pax|guests?|delegates?|people|persons?|attendees?|rooms?)\b'
                       r'|\b(?:pax|guests?|delegates?|people|persons?|attendees?|rooms?)\s*[:=-]?\s*(\d{2,3})\b')
            if any(30 <= int(a or b) <= 500 for a, b in re.findall(pattern, current, re.I)):
                matched.append('high_attendance_candidate')
        if matched:
            selected.append(packet)
            reasons.append({'case': case, 'selection_reasons': matched})
            counts.update(matched)
    write(args.output, selected)
    write(args.selection, reasons)
    print(json.dumps({'selected': len(selected), 'selection_reasons': dict(counts)}, sort_keys=True))


if __name__ == '__main__':
    main()
