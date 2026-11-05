#!/usr/bin/env python3
"""Review identified groups, resumably, without changing the original run."""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DIR = ROOT / '.private/centurion-opportunity-october-20261101/bulk-sep26-v7'


def read_latest(path):
    latest = {}
    if not path.exists(): return latest
    with path.open() as source:
        for line in source:
            try: record = json.loads(line)
            except json.JSONDecodeError: continue  # active append may be incomplete
            latest[record['case']] = record
    return latest


def main():
    base = read_latest(DIR / 'results-inbound.jsonl')
    for name in ('results-inbound-mime-recovered.jsonl', 'results-inbound-mime-subject-audit.jsonl',
                 'results-inbound-mime-room-audit.jsonl'):
        for case, record in read_latest(DIR / name).items():
            if case in base and record.get('status') == 'ok': base[case] = record
    cases = sorted(case for case, record in base.items()
                   if record.get('status') == 'ok'
                   and record['result']['reservation_email'] is True
                   and 'group' in record['result']['actions'])
    if not cases: raise SystemExit('no completed group cases to review')
    output = DIR / 'group-review-results.jsonl'
    final_input = DIR / 'group-review-input-final.jsonl'
    input_path = final_input if final_input.exists() else DIR / 'group-review-input.jsonl'
    cmd = [sys.executable, str(HERE / 'luna-corpus-runner.py'), 'run', '--direction', 'inbound',
           '--input', str(input_path), '--output', str(output),
           '--prompt', str(HERE / '2026-11-02-luna-group-review-prompt.md'), '--route-verified',
           '--endpoint-sha256', '7cbded1e0844b02d82afa6ffd1d79d2e83e66558d05f38613403b224d4dd9bbf',
           '--effort', 'medium', '--concurrency', '6', '--timeout', '120', '--retries', '3']
    if output.exists(): cmd.append('--resume')
    for case in cases: cmd.extend(('--case', case))
    print(f'Group cases selected: {len(cases)}', flush=True)
    raise SystemExit(subprocess.run(cmd, cwd=ROOT, check=False).returncode)


if __name__ == '__main__': main()
