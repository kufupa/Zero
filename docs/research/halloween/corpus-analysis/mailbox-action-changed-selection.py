#!/usr/bin/env python3
"""Select changed action inputs, while preserving previous provider holds."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'
spec = importlib.util.spec_from_file_location('action_details', HERE / 'luna-action-details.py')
action = importlib.util.module_from_spec(spec)
spec.loader.exec_module(action)


def rows(path):
    with path.open() as source:
        items = [json.loads(line) for line in source if line.strip()]
    indexed = {item['case']: item for item in items}
    if len(indexed) != len(items):
        raise ValueError('duplicate case')
    return indexed


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--previous-input', type=Path, required=True)
    p.add_argument('--previous-dataset', type=Path, required=True)
    p.add_argument('--final-input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--report', type=Path, required=True)
    a = p.parse_args()
    runner = action.load_runner()
    for path in (a.previous_input, a.previous_dataset, a.final_input):
        runner._validate_private_path(path, PRIVATE, must_exist=True)
    for path in (a.output, a.report):
        runner._validate_private_path(path, PRIVATE, must_exist=False)
    old, dataset, new = rows(a.previous_input), rows(a.previous_dataset), rows(a.final_input)
    actionable = {case for case, row in dataset.items()
                  if (row.get('classification') or {}).get('reservation_email') is True}
    if set(old) != actionable:
        raise ValueError('previous action input does not match dataset')
    selected, reasons, protected = [], {}, []
    for case, row in new.items():
        previous = old.get(case)
        if previous is not None and action.project(previous, runner) == action.project(row, runner):
            continue
        state = (dataset.get(case, {}).get('action_processing') or {}).get('status')
        if state not in ('ok', 'not_actionable'):
            protected.append(case)
            continue
        selected.append(row)
        reasons[case] = 'changed_model_input' if previous is not None else 'new_actionable_case'
    with os.fdopen(os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
        for row in selected:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    report = {'selected': len(selected), 'reasons': reasons, 'protected_cases': sorted(protected),
              'no_longer_actionable': sorted(set(old) - set(new)),
              'previous_input_sha256': hashlib.sha256(a.previous_input.read_bytes()).hexdigest(),
              'previous_dataset_sha256': hashlib.sha256(a.previous_dataset.read_bytes()).hexdigest(),
              'final_input_sha256': hashlib.sha256(a.final_input.read_bytes()).hexdigest()}
    with os.fdopen(os.open(a.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
        json.dump(report, target, indent=2)
        target.write('\n')
    print(json.dumps({'selected': len(selected), 'protected': len(protected),
                      'no_longer_actionable': len(report['no_longer_actionable'])}))


if __name__ == '__main__':
    main()
