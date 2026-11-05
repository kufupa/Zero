#!/usr/bin/env python3
"""Select possible group-context conflicts without assigning group labels."""

import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'


def subject_key(value):
    value = re.sub(r'^(?:(?:re|fw|fwd|aw|sv)\s*:\s*)+', '', value or '', flags=re.I)
    return ' '.join(re.findall(r'\w+', value.casefold()))


def related(left, right):
    return (min(len(left), len(right)) >= 24 and
            (left.startswith(right) or right.startswith(left)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labeled', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--max-context', type=int, default=3)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        assert related(subject_key('RE: Conference accommodation 18 October'),
                       subject_key('Conference accommodation 18 October - Proof'))
        assert not related(subject_key('RE: Confirmation'), subject_key('Confirmation'))
        assert not related(subject_key('Conference accommodation 18 October'),
                           subject_key('Conference accommodation 19 October'))
        print('group-context selection checks passed')
        return
    if not all((args.labeled, args.output, args.manifest)) or not 1 <= args.max_context <= 6:
        parser.error('labeled, output, manifest and max-context (1–6) are required')
    spec = importlib.util.spec_from_file_location('luna_corpus_runner', HERE / 'luna-corpus-runner.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    source = runner._validate_private_path(args.labeled, PRIVATE, must_exist=True)
    output = runner._validate_private_path(args.output, PRIVATE, must_exist=False)
    manifest = runner._validate_private_path(args.manifest, PRIVATE, must_exist=False)
    with source.open() as f:
        rows = [json.loads(line) for line in f if line.strip()]
    if len({row['case'] for row in rows}) != len(rows):
        raise ValueError('duplicate case')
    groups = []
    for row in rows:
        cl, inbound = row.get('classification') or {}, row['inbound']
        key = subject_key(inbound.get('subject'))
        if len(key) >= 24 and 'group' in cl.get('actions', []):
            groups.append((key, row))

    def source_hash(row):
        model_input = runner._project_inbound(row)
        return hashlib.sha256(runner._canonical_json(model_input).encode()).hexdigest()

    def rank(row):
        inbound = row['inbound']
        body = (inbound.get('message') or '') + ' ' + (inbound.get('quoted_context') or '')
        # Ranking only; no rule here decides whether the current task is a group.
        terms = len(re.findall(r'\b(?:rooms?|guests?|people|pax|accommodation|rooming)\b', body, re.I))
        return (min(terms, 20), min(len(body), 3000), row['case'])

    selected, index = [], []
    for row in rows:
        cl, inbound = row.get('classification') or {}, row['inbound']
        if cl.get('can_help') is not True:
            continue
        key = subject_key(inbound.get('subject'))
        candidates = [other for group_key, other in groups
                      if other['case'] != row['case'] and related(key, group_key)]
        if not candidates:
            continue
        candidates = sorted(candidates, key=rank, reverse=True)[:args.max_context]
        snippets = []
        for other in candidates:
            oi = other['inbound']
            snippets.append({'case': other['case'], 'date': oi.get('date'),
                'subject': oi.get('subject'), 'current_message': (oi.get('message') or '')[:1400],
                'quoted_context': (oi.get('quoted_context') or '')[:1000],
                'attachment_context': (oi.get('attachment_context') or '')[:800]})
        packet = {'case': row['case'], 'inbound': dict(inbound),
                  'candidate_replies': row.get('candidate_replies') or [],
                  '_source': row.get('_source') or {}}
        marker = ('\n\nOTHER EMAILS MATCHED BY SUBJECT (candidate context only; '
                  'not the triggering email; the stay may be different):\n')
        packet['inbound']['quoted_context'] = ((inbound.get('quoted_context') or '') + marker +
                                               json.dumps(snippets, ensure_ascii=False))
        selected.append(packet)
        index.append({'case': row['case'], 'original_input_sha256': source_hash(row),
                      'context_cases': [{'case': other['case'], 'input_sha256': source_hash(other)}
                                        for other in candidates]})

    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
        for packet in selected:
            target.write(json.dumps(packet, ensure_ascii=False, separators=(',', ':')) + '\n')
    with os.fdopen(os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
        json.dump({'selection_rule': 'helpable case with another group-tagged message sharing a long normalized subject prefix',
                   'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                   'selected': index}, target, indent=2, ensure_ascii=False)
        target.write('\n')
    print(json.dumps({'selected': len(selected), 'group_candidates': len(groups)}))


if __name__ == '__main__':
    main()
