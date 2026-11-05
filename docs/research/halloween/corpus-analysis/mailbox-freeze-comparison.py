#!/usr/bin/env python3
"""Bind final aggregated labels to blind-review packets without inventing a model run."""

import argparse
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


def rows(path):
    private = runner._validate_private_path(path, PRIVATE, must_exist=True)
    with private.open(encoding='utf-8') as source:
        items = [json.loads(line) for line in source if line.strip()]
    index = {item['case']: item for item in items}
    if len(index) != len(items):
        raise ValueError('duplicate_case')
    return index


def freeze(packets, labeled):
    output = []
    required = set(runner.INBOUND_ITEM_SCHEMA['properties'])
    for case, packet in packets.items():
        row = labeled.get(case)
        if not row or row.get('classification') is None:
            raise ValueError('classification_missing')
        if row.get('_source') != packet.get('_source') or row.get('inbound') != packet.get('inbound'):
            raise ValueError('source_or_inbound_mismatch')
        full_replies = {item['reply_id']: item for item in packet['candidate_replies']}
        linked = row.get('candidate_replies') or []
        if any(full_replies.get(item['reply_id']) != item for item in linked):
            raise ValueError('linked_candidate_mismatch')
        classification = row['classification']
        if set(classification.get('reply_ids', [])) != {item['reply_id'] for item in linked}:
            raise ValueError('linked_candidate_set_mismatch')
        projected = runner._project_inbound(packet)
        core = {key: classification[key] for key in required}
        result = runner._validate_inbound_result({'results': [core]}, projected)
        digest = hashlib.sha256(runner._canonical_json(projected).encode('utf-8')).hexdigest()
        output.append({'case': case, 'direction': 'inbound', 'status': 'ok', 'attempt': 1,
                       'input_sha256': digest, 'result': result,
                       'record_kind': 'aggregate_derived_label_not_model_invocation'})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--labeled', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    packets, labeled = rows(args.packets), rows(args.labeled)
    output = freeze(packets, labeled)
    target_path = runner._validate_private_path(args.output, PRIVATE, must_exist=False)
    fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for row in output:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'aggregate_derived_labels': len(output)}))


if __name__ == '__main__':
    main()
