#!/usr/bin/env python3
"""Run one no-tools Haiku classification pass on the prepared sample."""

import argparse
import json
import subprocess
from collections import Counter
from pathlib import Path


ACTIONS = ['quote', 'booking', 'amendment', 'cancellation', 'payment_proof',
           'voucher', 'invoice', 'payment_request', 'group', 'other']
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['results'],
    'properties': {'results': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'required': ['case', 'reservation_email', 'can_help', 'actions', 'reply_ids',
                     'response_type', 'invoice_handling', 'evidence_source', 'evidence', 'reason'],
        'properties': {
            'case': {'type': 'string'},
            'reservation_email': {'type': ['boolean', 'null']},
            'can_help': {'type': ['boolean', 'null']},
            'actions': {'type': 'array', 'items': {'type': 'string', 'enum': ACTIONS}},
            'reply_ids': {'type': 'array', 'items': {'type': 'string'}},
            'response_type': {'type': 'string', 'enum': ['staff', 'hms_confirmation_candidate', 'both', 'none_linked', 'other']},
            'invoice_handling': {'type': 'string', 'enum': ['staff_invoice', 'hms_confirmation_candidate', 'invoice_no_reply', 'not_invoice']},
            'evidence_source': {'type': 'string', 'enum': ['inbound', 'reply', 'both', 'none']},
            'evidence': {'type': 'string', 'maxLength': 180},
            'reason': {'type': 'string', 'maxLength': 220},
        },
    }}},
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--packets', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cases', nargs='*')
    parser.add_argument('--effort', choices=['low', 'medium', 'high', 'max'])
    parser.add_argument('--prompt', type=Path,
                        default=Path(__file__).with_name('2026-11-01-haiku-opportunity-prompt.md'))
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('output already exists')
    packets = json.loads(args.packets.read_text())
    selected = [item for item in packets['sample'] if not args.cases or item['case'] in args.cases]
    if args.cases and {item['case'] for item in selected} != set(args.cases):
        raise SystemExit('one or more requested cases are absent')
    clean_cases = [{k: v for k, v in item.items() if k not in {'cohort', 'source_row_id'}}
                   for item in selected]
    prompt = args.prompt.read_text()
    payload = prompt + '\n\nCASES:\n' + json.dumps(clean_cases, ensure_ascii=False)
    command = ['claude', '-p', '--model', 'haiku', '--tools', '', '--no-session-persistence',
               '--output-format', 'json', '--max-budget-usd', '1.50',
               '--json-schema', json.dumps(SCHEMA, separators=(',', ':'))]
    if args.effort:
        command.extend(['--effort', args.effort])
    completed = subprocess.run(command, input=payload, text=True, capture_output=True, timeout=240)
    if completed.returncode != 0:
        raise SystemExit(f'model call failed with exit code {completed.returncode}')
    response = json.loads(completed.stdout)
    if response.get('is_error'):
        raise SystemExit('model returned an error')
    output = response.get('structured_output')
    if not isinstance(output, dict) or not isinstance(output.get('results'), list):
        raise SystemExit('model returned no structured results')
    expected = {item['case'] for item in clean_cases}
    received = [item.get('case') for item in output['results']]
    if len(received) != len(expected) or set(received) != expected:
        raise SystemExit('model did not return exactly one result per case')
    for item in output['results']:
        source = next(case for case in clean_cases if case['case'] == item['case'])
        valid_reply_ids = {reply['reply_id'] for reply in source['candidate_replies']}
        if not set(item['reply_ids']).issubset(valid_reply_ids):
            raise SystemExit('model referred to a nonexistent reply')
    with args.output.open('x') as result_file:
        json.dump({'results': output['results'], 'cost_usd': response.get('total_cost_usd'),
                   'duration_ms': response.get('duration_ms'),
                   'model_usage': response.get('modelUsage'),
                   'effort': args.effort or 'cli_default', 'prompt': str(args.prompt)},
                  result_file, ensure_ascii=False, indent=2)
    cohorts = {item['case']: item['cohort'] for item in packets['sample']}
    random_results = [row for row in output['results'] if cohorts[row['case']] == 'random']
    print(json.dumps({'cases': len(output['results']), 'random_cases': len(random_results),
                      'reservation_email': dict(Counter(str(x['reservation_email']) for x in random_results)),
                      'can_help_within_reservation': dict(Counter(str(x['can_help']) for x in random_results if x['reservation_email'] is True)),
                      'nonreservation_help_inconsistencies': sum(x['can_help'] is True and x['reservation_email'] is False for x in random_results),
                      'response_type': dict(Counter(x['response_type'] for x in random_results)),
                      'cost_usd': response.get('total_cost_usd'), 'duration_ms': response.get('duration_ms'),
                      'models': list((response.get('modelUsage') or {}).keys())}))


if __name__ == '__main__':
    main()
