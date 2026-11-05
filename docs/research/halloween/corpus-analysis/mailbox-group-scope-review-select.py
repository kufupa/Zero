#!/usr/bin/env python3
"""Select possible large-group errors for semantic review; never assign labels."""

import argparse
import collections
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('attachment_helper', HERE / 'centurion-attachment-review-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def write(path, rows):
    path = helper._private_path(path, existing=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--classifications', type=Path, required=True)
    parser.add_argument('--allowed-failures', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    args = parser.parse_args()
    packets = helper._read_jsonl(args.packets)
    labels, blocked = helper._classification_map(
        helper._read_jsonl(args.classifications), helper._case_map(packets),
        helper._read_allowed_failures(args.allowed_failures))
    selected, audit = [], []
    for packet in packets:
        case = packet['case']
        if case in blocked:
            continue
        label = labels[case]
        hint = helper._select_one(packet, label, None)
        reasons = [reason for reason in (hint or {}).get('reasons', [])
                   if reason in {'possible_untagged_large_group', 'large_group_help_needs_separate_task_check'}]
        if 'group' in label['actions'] and label.get('can_help') is True:
            reasons.append('group_tagged_and_helpable_review_separate_task')
        inbound = packet['inbound']
        current = str(inbound.get('subject') or '') + '\n' + str(inbound.get('message') or '')
        quoted = str(inbound.get('quoted_context') or '')
        if ('group' not in label['actions'] and helper.GROUP_RE.search(current)
                and max(helper._large_room_counts(quoted), default=0) > 10):
            reasons.append('current_group_context_and_quoted_large_room_count')
        if reasons:
            selected.append(packet)
            audit.append({'case': case, 'reasons': sorted(set(reasons))})
    write(args.output, selected)
    write(args.selection, audit)
    print(json.dumps({'selected': len(selected), 'reason_counts': dict(collections.Counter(
        reason for row in audit for reason in row['reasons']))}, sort_keys=True))


if __name__ == '__main__':
    main()
