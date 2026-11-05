#!/usr/bin/env python3
"""Fetch bounded PDF/XLSX evidence for a prioritized private review selection."""

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'


def read(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def private_json(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        json.dump(data, target, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--snapshot', action='append', required=True)
    parser.add_argument('--max-cases', type=int, default=120)
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.max_cases <= 500 or not 1 <= args.workers <= 2:
        raise ValueError('batch limits invalid')
    if not args.output_dir.resolve().is_relative_to(PRIVATE.resolve()) or args.output_dir.exists():
        raise ValueError('output directory must be new and private')
    rows = read(args.selection)
    if len({row['case'] for row in rows}) != len(rows):
        raise ValueError('duplicate selected case')
    available = [row for row in rows if row.get('needs_extraction') is True
                 and row.get('extractor_ready') is True and row.get('mime_state') != 'confirmed_no_attachments']
    chosen = available[:args.max_cases]
    grouped = {purpose: [row['case'] for row in chosen if purpose in row.get('purposes', [])]
               for purpose in ('room', 'document')}
    if any(not re.fullmatch(r'[A-Z][A-Z0-9_-]{0,127}', case) for cases in grouped.values() for case in cases):
        raise ValueError('invalid case id')
    args.output_dir.mkdir(mode=0o700)
    private_json(args.output_dir / 'selection.json', {'eligible_in_selection': len(available),
                 'chosen': len(chosen), 'remaining_in_selection': max(0, len(available) - len(chosen)),
                 'cases_by_purpose': grouped, 'max_cases': args.max_cases})
    jobs = [(purpose, index, cases[start:start + 12]) for purpose, cases in grouped.items()
            for index, start in enumerate(range(0, len(cases), 12), 1)]

    def run(job):
        purpose, index, cases = job
        output = args.output_dir / f'{purpose}-{index:03d}.json'
        log = args.output_dir / f'{purpose}-{index:03d}.log'
        cmd = [sys.executable, str(HERE / 'centurion-attachment-evidence.py'), '--input', str(args.packets),
               '--output', str(output), '--purpose', purpose]
        for snapshot in args.snapshot:
            cmd.extend(['--snapshot', snapshot])
        for case in cases:
            cmd.extend(['--case', case])
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as target:
            try:
                result = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=target, stderr=subprocess.STDOUT,
                                        timeout=600, check=False)
            except (OSError, subprocess.TimeoutExpired):
                return {'purpose': purpose, 'batch': index, 'cases': len(cases), 'status': 'failed'}
        if result.returncode != 0 or not output.is_file():
            return {'purpose': purpose, 'batch': index, 'cases': len(cases), 'status': 'failed'}
        evidence = json.loads(output.read_text())
        statuses = Counter(item.get('status', 'unknown') for item in evidence.get('cases', {}).values())
        return {'purpose': purpose, 'batch': index, 'cases': len(cases), 'status': evidence.get('status'),
                'case_statuses': dict(statuses), 's3_gets': evidence.get('s3_gets')}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, jobs))
    report = {'selected_cases': len(chosen), 'jobs': len(jobs), 'results': results,
              'failed_jobs': sum(row['status'] != 'ok' for row in results)}
    private_json(args.output_dir / 'report.json', report)
    print(json.dumps({'selected_cases': len(chosen), 'jobs': len(jobs),
                      'failed_jobs': report['failed_jobs']}, sort_keys=True))
    if report['failed_jobs']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
