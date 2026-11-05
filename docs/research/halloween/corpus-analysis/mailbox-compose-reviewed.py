#!/usr/bin/env python3
"""Compose a finished mailbox pass with identity-checked, versioned review layers."""

import argparse
import collections
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


aggregate = module('aggregate', 'centurion-aggregate-opportunity.py')
runner = aggregate.runner
outbound_mime = module('outbound_mime', 'mailbox-augment-outbound-attachments.py')


def read(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def unique(rows):
    result = {row['case']: row for row in rows}
    if len(result) != len(rows):
        raise ValueError('duplicate input case')
    return result


def latest(records):
    result = {}
    for record in records:
        old = result.get(record['case'])
        if record.get('attempt') != (old['attempt'] + 1 if old else 1) or (old and old['status'] != 'failed'):
            raise ValueError('invalid retry sequence')
        result[record['case']] = record
    return result


def validate_packet(base, review, outgoing, outgoing_results, mime_by_case=None):
    if (review['case'] != base['case'] or review['_source'] != base['_source']
            or review['inbound'] != base['inbound']):
        raise ValueError('review changed source or inbound content')
    previous = {x['reply_id']: x for x in base['candidate_replies']}
    current = {x['reply_id']: x for x in review['candidate_replies']}
    if len(current) != len(review['candidate_replies']) or not set(previous).issubset(current):
        raise ValueError('review removed or duplicated a candidate')
    for reply_id, candidate in current.items():
        out_case = candidate.get('outbound_case')
        if out_case not in outgoing:
            raise ValueError('candidate outbound absent from frame')
        if reply_id in previous:
            without_annotations = {k: v for k, v in candidate.items()
                                   if k not in ('outbound_message_type', 'outbound_attachment_context')}
            base_without_annotations = {k: v for k, v in previous[reply_id].items()
                                        if k not in ('outbound_message_type', 'outbound_attachment_context')}
            if without_annotations != base_without_annotations:
                raise ValueError('review changed original candidate')
        else:
            matches = [x for x in outgoing[out_case].get('candidate_inbounds', [])
                       if x.get('inbound_case') == base['case']]
            if not any(x.get('minutes_before_outbound') == candidate.get('minutes_after_inbound')
                       and x.get('same_thread') == candidate.get('same_thread')
                       and x.get('direct_header_match') == candidate.get('direct_header_match') for x in matches):
                raise ValueError('added candidate lacks matching reverse source')
            out = outgoing[out_case]['outbound']
            if any(candidate.get(k) != out.get(k) for k in ('from', 'to', 'subject')):
                raise ValueError('added candidate changed outbound metadata')
        if ('outbound_message_type' in candidate and
                candidate['outbound_message_type'] != outgoing_results[out_case]['message_type']):
            raise ValueError('candidate outbound classification mismatch')
        if 'outbound_attachment_context' in candidate:
            if mime_by_case is None:
                raise ValueError('candidate MIME annotation requires an index')
            if candidate['outbound_attachment_context'] != outbound_mime.reconstruct_candidate_context(
                    candidate, mime_by_case):
                raise ValueError('candidate MIME annotation mismatch')


def private_write(path, records):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for record in records:
            target.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--base-prompt', type=Path, required=True)
    parser.add_argument('--layer', type=Path, nargs=3, action='append', default=[],
                        metavar=('INPUT', 'RESULTS', 'PROMPT'), help='ordered review layer')
    parser.add_argument('--outbound-mime-index', type=Path,
                        help='private MIME index used to validate candidate attachment annotations')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    if not args.output_dir.resolve().is_relative_to(PRIVATE.resolve()) or args.output_dir.exists():
        raise ValueError('output directory must be new and private')

    baseline, _, base_status = aggregate.load_direction(args.base, 'inbound', args.base_prompt)
    outgoing, out_results, out_status = aggregate.load_direction(
        args.base, 'outbound', HERE / '2026-11-01-luna-outbound-prompt.md')
    allowed = json.loads((args.base / 'provider-blocked.json').read_text())
    mime_by_case = (outbound_mime._index_map(outbound_mime._read_rows(
        outbound_mime._private_path(args.outbound_mime_index, existing=True)))
                    if args.outbound_mime_index else None)
    missing = set(base_status['failed_cases'] + base_status['withheld_cases'] + base_status['missing_cases'])
    if missing != set(allowed) or out_status['ok'] != out_status['input']:
        raise ValueError('base results incomplete beyond explicitly recorded blocks')
    initial = latest(read(args.base / 'results-inbound.jsonl'))
    packets, results = dict(baseline), dict(initial)
    audit, totals = [], collections.Counter()
    for input_path, result_path, prompt_path in args.layer:
        inputs, layer = unique(read(input_path)), latest(read(result_path))
        if set(inputs) != set(layer) or any(record['status'] != 'ok' for record in layer.values()):
            raise ValueError('review layer incomplete')
        prompt_hash = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
        for case, packet in inputs.items():
            if case not in baseline or case not in results or results[case]['status'] != 'ok':
                raise ValueError('review case lacks a successful base result')
            validate_packet(baseline[case], packet, outgoing, out_results, mime_by_case)
            record = layer[case]
            projected = runner._project_inbound(packet)
            digest = hashlib.sha256(runner._canonical_json(projected).encode()).hexdigest()
            if (record.get('input_sha256') != digest or record.get('prompt_sha256') != prompt_hash
                    or record.get('model') != 'gpt-6-luna' or record.get('effort') != 'medium'):
                raise ValueError('review result identity mismatch')
            result = runner._validate_inbound_result({'results': [record['result']]}, projected)
            old = results[case]['result']
            fields = [field for field in ('reservation_email', 'can_help', 'actions', 'reply_ids',
                                           'response_type', 'invoice_handling')
                      if old.get(field) != result.get(field)]
            audit.append({'case': case, 'layer': result_path.name, 'prompt_sha256': prompt_hash,
                          'changed_fields': fields})
            totals.update(fields)
            packets[case], results[case] = packet, record

    args.output_dir.mkdir(mode=0o700)
    private_write(args.output_dir / 'inbound.jsonl', (packets[case] for case in sorted(packets)))
    private_write(args.output_dir / 'results-inbound.jsonl', (results[case] for case in sorted(results)))
    private_write(args.output_dir / 'review-layer-audit.jsonl', audit)
    for name in ('manifest.jsonl', 'outbound.jsonl', 'results-outbound.jsonl', 'provider-blocked.json'):
        fd = os.open(args.output_dir / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with (args.base / name).open('rb') as source, os.fdopen(fd, 'wb') as target:
            shutil.copyfileobj(source, target)
    print(json.dumps({'inbound_packets': len(packets), 'reviewed_layer_rows': len(audit),
                      'fields_changed_by_layers': dict(totals)}, sort_keys=True))


if __name__ == '__main__':
    main()
