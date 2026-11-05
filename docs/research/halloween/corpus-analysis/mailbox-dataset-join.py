#!/usr/bin/env python3
"""Join reviewed mailbox classifications and action details without losing provenance."""

import argparse
import collections
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
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def unique(records):
    result = {record['case']: record for record in records}
    if len(result) != len(records):
        raise ValueError('duplicate input case')
    return result


def digest(value):
    return hashlib.sha256(action.canonical(value).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labeled', type=Path, required=True)
    parser.add_argument('--action-input', type=Path, required=True)
    parser.add_argument('--action-results', type=Path, action='append', required=True,
                        help='Result files in priority order; repeat for a later correction batch.')
    parser.add_argument('--prior-action-input', type=Path, action='append', default=[],
                        help='Prior or subset input used by a result file; reuse only identical projected cases.')
    parser.add_argument('--action-prompt', type=Path, action='append', required=True,
                        help='Allowed action prompt file; repeat when a reviewed layer uses a different prompt.')
    parser.add_argument('--classification-results', type=Path, action='append', default=[])
    parser.add_argument('--group-context-manifest', type=Path,
                        help='Source-bound candidate group-context selection; flags only, no label changes.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    if not args.output.resolve().is_relative_to(PRIVATE.resolve()):
        raise ValueError('output must be private')

    labeled = unique(rows(args.labeled))
    selected = unique(rows(args.action_input))
    actionable = {case for case, row in labeled.items()
                  if (row.get('classification') or {}).get('reservation_email') is True}
    if set(selected) != actionable:
        raise ValueError('action input must contain exactly the actionable classifications')
    runner = action.load_runner()
    projected = {case: action.project(row, runner) for case, row in selected.items()}
    for case in selected:
        if action.project(labeled[case], runner) != projected[case]:
            raise ValueError('action input differs from final classification')
    group_context = {}
    if args.group_context_manifest:
        with args.group_context_manifest.open(encoding='utf-8') as source:
            group_manifest = json.load(source)
        if group_manifest.get('source_sha256') != hashlib.sha256(args.labeled.read_bytes()).hexdigest():
            raise ValueError('group-context source manifest mismatch')
        for item in group_manifest.get('selected', []):
            case = item['case']
            if case not in labeled or case in group_context:
                raise ValueError('invalid group-context case')
            original_hash = hashlib.sha256(runner._canonical_json(
                runner._project_inbound(labeled[case])).encode()).hexdigest()
            if item.get('original_input_sha256') != original_hash:
                raise ValueError('group-context input mismatch')
            for context in item.get('context_cases', []):
                other = context['case']
                if other not in labeled or context.get('input_sha256') != hashlib.sha256(
                        runner._canonical_json(runner._project_inbound(labeled[other])).encode()).hexdigest():
                    raise ValueError('group-context supporting input mismatch')
            group_context[case] = item['context_cases']
    manifest_hash = hashlib.sha256(args.action_input.read_bytes()).hexdigest()
    input_manifests = {manifest_hash: projected}
    for path in args.prior_action_input:
        old_rows = unique(rows(path))
        old_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        old_projected = {case: action.project(row, runner) for case, row in old_rows.items()}
        if old_hash in input_manifests and input_manifests[old_hash] != old_projected:
            raise ValueError('conflicting action input manifest')
        input_manifests[old_hash] = old_projected
    prompt_hashes = {hashlib.sha256(path.read_bytes()).hexdigest() for path in args.action_prompt}
    schema_hash = digest(action.SCHEMA)

    latest, history = {}, {}
    stale, no_longer_actionable = 0, 0
    for result_path in args.action_results:
        for record in rows(result_path):
            case = record['case']
            source_hash = record.get('input_manifest_sha256')
            source = input_manifests.get(source_hash)
            if source is None or case not in source:
                raise ValueError('action result source manifest missing')
            source_input = source[case]
            expected = {'model': action.MODEL, 'effort': action.EFFORT,
                        'schema_sha256': schema_hash,
                        'input_manifest_sha256': source_hash,
                        'input_sha256': digest(source_input)}
            if (record.get('prompt_sha256') not in prompt_hashes
                    or any(record.get(key) != value for key, value in expected.items())):
                raise ValueError('action result identity mismatch')
            previous = history.get((source_hash, case))
            if record.get('attempt') != (previous['attempt'] + 1 if previous else 1):
                raise ValueError('action retry order mismatch')
            if previous and previous['status'] != 'failed':
                raise ValueError('unexpected action retry')
            history[(source_hash, case)] = record
            if record.get('status') == 'ok':
                result = action.validate(record.get('result'), source_input)
                action.validate_nava_policy_audit(record.get('nava_policy_correction_audit', []), result)
                if (record.get('evidence_quote_audit') != action.quote_audit(result, source_input)
                        or record.get('classification_audit') != action.classification_audit(result, source_input)):
                    raise ValueError('action audit mismatch')
            elif record.get('status') not in ('failed', 'withheld'):
                raise ValueError('invalid action status')
            if case not in projected:
                no_longer_actionable += 1
                continue
            if source_input != projected[case]:
                stale += 1
                continue
            current = latest.get(case)
            if not current or current['status'] != 'ok' or record['status'] == 'ok':
                latest[case] = record
    missing = actionable - set(latest)
    failed = {case for case, record in latest.items() if record['status'] == 'failed'}
    if (missing or failed) and not args.allow_partial:
        raise ValueError(f'action results incomplete: {len(missing)} missing, {len(failed)} failed')

    provenance = collections.defaultdict(list)
    for path in args.classification_results:
        for record in rows(path):
            case = record['case']
            if case not in labeled:
                raise ValueError('classification result case is absent from labeled input')
            provenance[case].append({'file': path.name, **{key: record.get(key) for key in
                ('status', 'attempt', 'model', 'effort', 'prompt_sha256', 'input_sha256')}})

    counts = collections.Counter()
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for case, row in sorted(labeled.items()):
            record = latest.get(case)
            state = (record['status'] if record else 'missing' if case in actionable else
                     'unclassified' if row.get('classification') is None else 'not_actionable')
            counts[state] += 1
            detail = record.get('result') if record and state == 'ok' else None
            audit = ({key: record.get(key) for key in ('model', 'effort', 'prompt_sha256',
                      'input_sha256', 'schema_sha256', 'input_manifest_sha256', 'attempt',
                      'nava_policy_correction_audit', 'evidence_quote_audit', 'classification_audit')}
                     if record else None)
            flags = []
            classification = row.get('classification') or {}
            if detail and classification.get('can_help') is True and not detail['nava_hypothetical']:
                flags.append('helpable_without_nava_steps')
            if audit and (audit.get('classification_audit') or {}).get('large_group_without_final_group_flag'):
                flags.append('action_group_disagrees_with_classification')
            if (detail and 'group' in classification.get('actions', [])
                    and detail['request_actions'] and not any(
                        item['scope'] == 'large_group' for item in detail['request_actions'])):
                # A group email may contain a separate individual task. Flag the
                # mismatch for review rather than rewriting either model output.
                flags.append('group_classification_without_group_action_detail')
            if (detail and row.get('candidate_replies') and any(
                    item['state'] == 'completed_or_confirmed' for item in detail['request_actions'])):
                flags.append('action_state_may_reflect_later_reply')
            if case in group_context:
                flags.append('similar_subject_group_context_candidate')
            joined = {**row, 'action_details': detail, 'action_processing': {'status': state, 'audit': audit},
                      'research_context': {'opportunity_reference': 'at_inbound',
                          'later_replies_supplied_to_analysis': bool(row.get('candidate_replies')),
                          'retrospective_only': True, 'quality_flags': flags,
                          'group_context_candidates': group_context.get(case, [])},
                      'classification_provenance': provenance.get(case, [])}
            target.write(json.dumps(joined, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'rows': len(labeled), 'action_status': dict(counts),
                      'action_result_layers': len(args.action_results), 'stale_action_results': stale,
                      'previously_actionable_results': no_longer_actionable,
                      'classification_provenance_cases': len(provenance)}, sort_keys=True))


if __name__ == '__main__':
    main()
