#!/usr/bin/env python3
"""Select changed action packets and retryable output-validation failures."""

import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path


HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-input', type=Path, required=True)
    parser.add_argument('--previous-results', type=Path, required=True)
    parser.add_argument('--final-input', type=Path, required=True)
    parser.add_argument('--prompt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('action_details', HERE / 'luna-action-details.py')
    action = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(action)
    runner = action.load_runner()
    root = PRIVATE.resolve()
    for path in (args.previous_input, args.previous_results, args.final_input):
        runner._validate_private_path(path, root, must_exist=True)
    for path in (args.output, args.report):
        runner._validate_private_path(path, root, must_exist=False)

    def load(path):
        with path.open() as source:
            items = [json.loads(line) for line in source if line.strip()]
        indexed = {item['case']: item for item in items}
        if len(indexed) != len(items):
            raise ValueError('duplicate action input case')
        return indexed

    old, final = load(args.previous_input), load(args.final_input)
    old_projected = {case: action.project(row, runner) for case, row in old.items()}
    final_projected = {case: action.project(row, runner) for case, row in final.items()}
    old_manifest = hashlib.sha256(args.previous_input.read_bytes()).hexdigest()
    prompt_hash = hashlib.sha256(args.prompt.read_bytes()).hexdigest()
    schema_hash = action.sha(action.canonical(action.SCHEMA).encode())
    latest = {}
    with args.previous_results.open() as source:
        for line in source:
            if not line.strip():
                continue
            row = json.loads(line)
            case = row['case']
            if case not in old_projected:
                raise ValueError('previous action result has no input')
            expected = {'model': action.MODEL, 'effort': action.EFFORT,
                        'input_manifest_sha256': old_manifest,
                        'input_sha256': action.sha(action.canonical(old_projected[case]).encode()),
                        'prompt_sha256': prompt_hash, 'schema_sha256': schema_hash}
            if any(row.get(key) != value for key, value in expected.items()):
                raise ValueError('previous action result identity mismatch')
            before = latest.get(case)
            if row.get('attempt') != (before['attempt'] + 1 if before else 1):
                raise ValueError('previous action attempt order invalid')
            if before and before['status'] != 'failed':
                raise ValueError('previous action retry invalid')
            latest[case] = row
    if set(latest) != set(old):
        raise ValueError('previous action batch incomplete')

    chosen, reasons, counts, protected = [], {}, collections.Counter(), []
    for case, row in final.items():
        prior = latest.get(case)
        changed = case in old_projected and old_projected[case] != final_projected[case]
        if prior is None:
            reason = 'new_actionable_case'
        elif prior['status'] == 'withheld' or (prior['status'] == 'failed'
                and not str(prior.get('error_code', '')).startswith('output_')):
            protected.append(case)
            counts['not_retried_sensitive_or_provider_failure'] += 1
            continue
        elif changed:
            reason = 'changed_model_input'
        elif prior['status'] == 'failed':
            reason = 'retry_output_validation_failure'
        else:
            counts['unchanged_success'] += 1
            continue
        chosen.append(row)
        reasons[case] = reason
        counts[reason] += 1

    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        for row in chosen:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    report = {'selected': len(chosen), 'reasons': reasons, 'counts': dict(counts),
              'not_retried_cases': sorted(protected),
              'no_longer_actionable': len(set(old) - set(final))}
    fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        json.dump(report, target, ensure_ascii=False, indent=2)
        target.write('\n')
    print(json.dumps({'selected': len(chosen), 'counts': dict(counts),
                      'no_longer_actionable': report['no_longer_actionable']}))


if __name__ == '__main__':
    main()
