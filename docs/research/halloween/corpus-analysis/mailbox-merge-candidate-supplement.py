#!/usr/bin/env python3
"""Merge a reverse reply-candidate supplement into its unchanged full frame."""

import argparse
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'
spec = importlib.util.spec_from_file_location('mailbox_compose', HERE / 'mailbox-compose-reviewed.py')
compose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compose)
runner = compose.runner


def load(path):
    path = runner._validate_private_path(path, PRIVATE, must_exist=True)
    with path.open(encoding='utf-8') as f:
        rows = [json.loads(line) for line in f if line.strip()]
    indexed = {row['case']: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError('duplicate_case')
    return indexed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--supplement', type=Path, required=True)
    parser.add_argument('--outbound', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    base, supplement, outbound = map(load, (args.base, args.supplement, args.outbound))
    if not set(supplement).issubset(base):
        raise ValueError('supplement_case_missing')
    for case, packet in supplement.items():
        compose.validate_packet(base[case], packet, outbound, {})
    target = runner._validate_private_path(args.output, PRIVATE, must_exist=False)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for case, original in base.items():
            f.write(json.dumps(supplement.get(case, original), ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'packets': len(base), 'supplemented': len(supplement)}, sort_keys=True))


if __name__ == '__main__':
    main()
