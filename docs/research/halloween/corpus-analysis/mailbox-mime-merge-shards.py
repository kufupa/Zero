#!/usr/bin/env python3
"""Merge source-verified MIME index shards without treating gaps as empty."""

import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'
spec = importlib.util.spec_from_file_location('luna_corpus_runner', HERE / 'luna-corpus-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
STATUSES = {'ok', 'locator_missing', 'too_large', 'read_error'}


def private(path, existing=True):
    return runner._validate_private_path(path, PRIVATE, must_exist=existing)


def load(path):
    with private(path).open(encoding='utf-8') as f:
        rows = [json.loads(line) for line in f if line.strip()]
    indexed = {row['case']: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError('duplicate_case')
    return indexed


def digest(path):
    return hashlib.sha256(private(path).read_bytes()).hexdigest()


def write(path, rows):
    fd = os.open(private(path, existing=False), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--partial-index', type=Path, action='append', default=[])
    parser.add_argument('--shard-input', type=Path, action='append', default=[])
    parser.add_argument('--shard-index', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.shard_input or len(args.shard_input) != len(args.shard_index):
        raise ValueError('shard_pairs_required')
    packets = load(args.packets)
    snapshots = None
    merged = {}
    conflicts = []
    files = [(args.packets, path, False) for path in args.partial_index]
    files += [(source, index, True) for source, index in zip(args.shard_input, args.shard_index, strict=True)]
    for source, index_path, complete in files:
        source_packets = load(source)
        if any(packets.get(case) != row for case, row in source_packets.items()):
            raise ValueError('shard_packet_mismatch')
        manifest_path = Path(str(index_path) + '.manifest.json')
        manifest = json.loads(private(manifest_path).read_text(encoding='utf-8'))
        if manifest.get('input_sha256') != digest(source) or manifest.get('input_cases') != len(source_packets):
            raise ValueError('shard_manifest_mismatch')
        if snapshots is None:
            snapshots = manifest.get('snapshots')
        elif snapshots != manifest.get('snapshots'):
            raise ValueError('shard_snapshots_mismatch')
        observations = load(index_path)
        if not set(observations).issubset(source_packets) or (complete and set(observations) != set(source_packets)):
            raise ValueError('shard_result_coverage_mismatch')
        for case, row in observations.items():
            if row.get('status') not in STATUSES:
                raise ValueError('inventory_status_invalid')
            previous = merged.get(case)
            if previous is not None and previous != row:
                conflicts.append({'case': case, 'prior': previous['status'], 'new': row['status']})
                if previous['status'] == 'ok' and row['status'] == 'ok':
                    raise ValueError('conflicting_successful_inventories')
                rank = {'ok': 3, 'too_large': 2, 'locator_missing': 1, 'read_error': 0}
                if rank[previous['status']] >= rank[row['status']]:
                    continue
            merged[case] = row
    if set(merged) != set(packets):
        raise ValueError('frame_inventory_incomplete')
    write(args.output, (merged[case] for case in packets))
    summary = {'packets': len(packets), 'status_counts': dict(collections.Counter(row['status'] for row in merged.values())),
               'conflicts': conflicts, 'source_packet_sha256': digest(args.packets), 'snapshots': snapshots,
               'inputs': [{'index_sha256': digest(index), 'packet_sha256': digest(source)}
                          for source, index, _ in files]}
    write(args.report, [summary])
    print(json.dumps({'packets': len(packets), 'status_counts': summary['status_counts'],
                      'conflicts': len(conflicts)}, sort_keys=True))


if __name__ == '__main__':
    main()
