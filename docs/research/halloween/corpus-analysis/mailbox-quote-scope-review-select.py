#!/usr/bin/env python3
"""Select possible ancillary-fee false positives for LLM review, not automatic exclusion."""

import argparse
import json
import os
import re
from pathlib import Path

PRIVATE = Path(__file__).resolve().parents[4] / '.private'
ANCILLARY = re.compile(
    r'(?i)\b(?:early|late)[\s-]*(?:check[\s-]*)?(?:in|out)\b'
    r'|\b(?:additional|extra|ancillary|surcharge|service)[\s-]+(?:charge|fee|cost|price|rate)\b'
    r'|\b(?:parking|shuttle|breakfast|lunch|dinner|airport\s+transfer|venue\s+hire)\b'
    r'|\b(?:conference|conferencing|venue|meeting\s+room|event\s+package|banquet|'
    r'delegate\s+package|function\s+room)\b'
)


def read(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inbound', type=Path, required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--exclude-packets', type=Path, action='append', default=[])
    args = parser.parse_args()
    if not args.output.resolve().is_relative_to(PRIVATE.resolve()):
        raise ValueError('output must be private')
    latest = {}
    for record in read(args.results):
        old = latest.get(record['case'])
        if record.get('attempt') != (old['attempt'] + 1 if old else 1) or (old and old['status'] != 'failed'):
            raise ValueError('invalid result retry order')
        latest[record['case']] = record
    excluded = {row['case'] for path in args.exclude_packets for row in read(path)}
    selected = []
    for row in read(args.inbound):
        record = latest.get(row['case']) or {}
        result = record.get('result') or {}
        if (row['case'] not in excluded and record.get('status') == 'ok'
                and result.get('reservation_email') is True
                and result.get('can_help') is not False and 'quote' in result.get('actions', [])):
            inbound = row['inbound']
            text = str(inbound.get('subject') or '') + '\n' + str(inbound.get('message') or '')
            if ANCILLARY.search(text):
                selected.append(row)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for row in selected:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'selected': len(selected)}, sort_keys=True))


if __name__ == '__main__':
    main()
