#!/usr/bin/env python3
"""Privately subclassify real actionable emails tagged other, one bin per email."""

import argparse
import collections
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import random
from pathlib import Path


HERE = Path(__file__).resolve().parent
RUNNER = HERE.parent / 'corpus-analysis' / 'luna-corpus-runner.py'
MODEL = 'gpt-6-luna'
EFFORT = 'medium'
ENDPOINT_SHA256 = '7cbded1e0844b02d82afa6ffd1d79d2e83e66558d05f38613403b224d4dd9bbf'
CATEGORIES = (
    'booking_confirmation_or_status', 'payment_or_banking_admin',
    'missing_or_requested_proof_voucher', 'guest_stay_logistics_or_service',
    'guest_documents_or_information', 'acknowledgement_or_general_reply',
    'group_or_event_coordination', 'inventory_channel_or_system',
    'outside_reservation_scope', 'no_distinct_other_task', 'misc_or_unclear',
)
SCHEMA = {
    'type': 'object',
    'properties': {
        'case': {'type': 'string'},
        'category': {'type': 'string', 'enum': list(CATEGORIES)},
        'description': {'type': 'string', 'maxLength': 180},
        'confidence': {'type': 'string', 'enum': ['high', 'medium', 'low']},
    },
    'required': ['case', 'category', 'description', 'confidence'],
    'additionalProperties': False,
}


def load_runner():
    spec = importlib.util.spec_from_file_location('corpus_runner_for_other_bins', RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def project(row, runner):
    source = runner._project_inbound(row)['inbound']
    inbound = {}
    for key, limit in (('subject', 500), ('message', 4000), ('quoted_context', 1500),
                       ('attachment_context', 2500)):
        value = source.get(key)
        inbound[key] = value[:limit] if isinstance(value, str) else value
    classification = row['classification']
    actions = (row.get('action_details') or {}).get('request_actions') or []
    return {'case': row['case'], 'inbound': inbound,
            'prior_labels': classification.get('actions') or [],
            'prior_reason': classification.get('reason') or '',
            'prior_action_descriptions': [
                {'action': x.get('action'), 'state': x.get('state'), 'task': x.get('task')}
                for x in actions]}


def valid_result(result, case, pilot):
    return (isinstance(result, dict) and set(result) == set(SCHEMA['properties'])
            and result['case'] == case and result['category'] in CATEGORIES
            and result['confidence'] in ('high', 'medium', 'low')
            and isinstance(result['description'], str) and len(result['description']) <= 180
            and not pilot._contains_sensitive_payment_data({'target': result}))


def classify(pilot, prompt, model_input, endpoint, key, identity):
    payload = {
        'model': MODEL, 'store': False, 'reasoning': {'effort': EFFORT},
        'input': [
            {'role': 'system', 'content': [{'type': 'input_text', 'text': prompt}]},
            {'role': 'user', 'content': [{'type': 'input_text', 'text': canonical(model_input)}]},
        ],
        'text': {'format': {'type': 'json_schema', 'name': 'reservation_other_bin',
                            'strict': True, 'schema': SCHEMA}},
    }
    raw, usage, error, attempts = pilot._send_request(endpoint, key, payload, 90, 2)
    base = {**identity, 'request_attempts': attempts}
    if error or raw is None:
        return {**base, 'status': 'failed', 'error_code': error or 'empty_response'}
    try:
        result = pilot._strict_json_loads(raw)
        if not valid_result(result, model_input['case'], pilot):
            raise ValueError('invalid result')
    except Exception:
        return {**base, 'status': 'failed', 'error_code': 'invalid_or_sensitive_output'}
    return {**base, 'status': 'ok', 'result': result, 'usage': usage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--prompt', type=Path, default=HERE / 'other-bin-prompt-v2.md')
    parser.add_argument('--sample', type=int, default=0, help='Randomly select this many real cases')
    parser.add_argument('--seed', type=int, default=52026)
    parser.add_argument('--concurrency', type=int, default=16)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--route-verified', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 16 or args.sample < 0:
        raise SystemExit('invalid concurrency or sample size')
    runner = load_runner()
    pilot = runner._load_pilot_helper()
    private = runner.HERE.parents[3] / '.private'
    source = runner._validate_private_path(args.dataset, private, must_exist=True)
    output = runner._validate_private_path(args.output, private, must_exist=False)
    source_bytes = pilot._read_limited_private(source, 'input', 100_000_000)
    rows = runner._decode_jsonl_strict(pilot, source_bytes, 'input_invalid_jsonl')
    chosen = [r for r in rows if (r.get('classification') or {}).get('reservation_email') is True
              and 'other' in (r.get('classification') or {}).get('actions', [])]
    projected = {r['case']: project(r, runner) for r in chosen}
    if not projected or len(projected) != len(chosen):
        raise SystemExit('no cases or duplicate cases')
    prompt_bytes = args.prompt.read_bytes()
    prompt = prompt_bytes.decode('utf-8')
    if not prompt.strip():
        raise SystemExit('empty prompt')
    common = {'model': MODEL, 'effort': EFFORT, 'prompt_sha256': sha(prompt_bytes),
              'schema_sha256': sha(canonical(SCHEMA).encode()), 'source_sha256': sha(source_bytes),
              'endpoint_sha256': ENDPOINT_SHA256}
    identity = {case: {**common, 'case': case, 'input_sha256': sha(canonical(value).encode())}
                for case, value in projected.items()}

    existing = {}
    if output.exists():
        if not args.resume:
            raise SystemExit('output exists; use --resume')
        for record in runner._decode_jsonl_strict(
                pilot, pilot._read_limited_private(output, 'results', 10_000_000), 'results_invalid_jsonl'):
            case = record.get('case')
            if (case not in identity or case in existing or any(record.get(k) != v for k, v in identity[case].items())
                    or record.get('status') not in ('ok', 'failed', 'withheld')
                    or (record.get('status') == 'ok' and not valid_result(record.get('result'), case, pilot))):
                raise SystemExit('resume provenance mismatch')
            existing[case] = record
    elif args.resume:
        raise SystemExit('resume output missing')
    cases = sorted(projected)
    if args.sample:
        cases = sorted(random.Random(args.seed).sample(cases, min(args.sample, len(cases))))
    todo = [case for case in cases if case not in existing]
    safe = []
    withheld = []
    for case in todo:
        if pilot._contains_sensitive_payment_data({'target': projected[case]}):
            withheld.append({**identity[case], 'status': 'withheld',
                             'error_code': 'sensitive_payment_or_credential_pattern'})
        else:
            safe.append(case)
    endpoint, key = pilot._route_preflight(args.route_verified, expected_endpoint_sha256=ENDPOINT_SHA256)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if output.exists() else os.O_EXCL)
    descriptor = os.open(output, flags, 0o600)
    counts = collections.Counter()
    with os.fdopen(descriptor, 'a', encoding='utf-8') as target:
        def write(record):
            target.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
            target.flush()
            counts[record['status']] += 1
        for record in withheld:
            write(record)
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {pool.submit(classify, pilot, prompt, projected[case], endpoint, key, identity[case]): case
                       for case in safe}
            for number, future in enumerate(concurrent.futures.as_completed(futures), 1):
                case = futures[future]
                try:
                    record = future.result()
                except Exception:
                    record = {**identity[case], 'status': 'failed', 'error_code': 'worker_failure'}
                write(record)
                if number % 40 == 0:
                    print(json.dumps({'completed': number, 'network_jobs': len(safe),
                                      'status': dict(counts)}), flush=True)
    print(json.dumps({'eligible': len(projected), 'selected': len(cases), 'existing': len(existing),
                      'new_status': dict(counts)}, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
