#!/usr/bin/env python3
"""Source-check and count the private, one-bin-per-email other analysis."""

import argparse
import collections
import importlib.util
import json
import os
from pathlib import Path


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('other_bins', HERE / 'other-bin-classify.py')
bins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bins)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True, type=Path)
    parser.add_argument('--results', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--prompt', type=Path, default=HERE / 'other-bin-prompt-v2.md')
    args = parser.parse_args()
    runner = bins.load_runner()
    pilot = runner._load_pilot_helper()
    private = runner.HERE.parents[3] / '.private'
    dataset = runner._validate_private_path(args.dataset, private, must_exist=True)
    results = runner._validate_private_path(args.results, private, must_exist=True)
    output = runner._validate_private_path(args.output, private, must_exist=False)
    if output.exists():
        raise SystemExit('output exists')
    source_raw = pilot._read_limited_private(dataset, 'input', 100_000_000)
    result_raw = pilot._read_limited_private(results, 'results', 10_000_000)
    rows = runner._decode_jsonl_strict(pilot, source_raw, 'input_invalid_jsonl')
    records = runner._decode_jsonl_strict(pilot, result_raw, 'results_invalid_jsonl')
    chosen = {r['case']: r for r in rows if (r.get('classification') or {}).get('reservation_email') is True
              and 'other' in (r.get('classification') or {}).get('actions', [])}
    latest = {}
    common = {'model': bins.MODEL, 'effort': bins.EFFORT, 'source_sha256': bins.sha(source_raw),
              'schema_sha256': bins.sha(bins.canonical(bins.SCHEMA).encode()),
              'prompt_sha256': bins.sha(args.prompt.read_bytes()), 'endpoint_sha256': bins.ENDPOINT_SHA256}
    for record in records:
        case = record.get('case')
        if case not in chosen or case in latest or any(record.get(k) != v for k, v in common.items()):
            raise SystemExit('result provenance mismatch')
        projected = bins.project(chosen[case], runner)
        if record.get('input_sha256') != bins.sha(bins.canonical(projected).encode()):
            raise SystemExit('result input mismatch')
        if record.get('status') not in ('ok', 'failed', 'withheld'):
            raise SystemExit('invalid result status')
        if record['status'] == 'ok' and not bins.valid_result(record.get('result'), case, pilot):
            raise SystemExit('invalid result category')
        latest[case] = record
    if len(latest) != len(chosen):
        raise SystemExit('result coverage incomplete')
    summary = {'source_sha256': bins.sha(source_raw), 'results_sha256': bins.sha(result_raw),
               'prompt_sha256': common['prompt_sha256'], 'eligible': len(chosen),
               'status': dict(collections.Counter(r['status'] for r in records)),
               'helpable': sum(r['classification'].get('can_help') is True for r in chosen.values()),
               'other_only': sum(r['classification'].get('actions') == ['other'] for r in chosen.values()),
               'group_tagged': sum('group' in r['classification'].get('actions', []) for r in chosen.values()),
               'bins': {}}
    for category in bins.CATEGORIES:
        cases = sorted(c for c, r in latest.items()
                       if r['status'] == 'ok' and r['result']['category'] == category)
        if cases:
            summary['bins'][category] = {'emails': len(cases),
                'helpable': sum(chosen[c]['classification'].get('can_help') is True for c in cases),
                'group_tagged': sum('group' in chosen[c]['classification'].get('actions', []) for c in cases),
                'other_only': sum(chosen[c]['classification'].get('actions') == ['other'] for c in cases),
                'example_cases': cases[:3]}
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
        json.dump(summary, target, ensure_ascii=False, indent=2)
        target.write('\n')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
