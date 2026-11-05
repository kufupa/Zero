#!/usr/bin/env python3
"""Aggregate a single-model Centurion run, retaining distinct message units."""

import argparse
import hashlib
import importlib.util
import json
import os
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('luna_corpus_runner', HERE / 'luna-corpus-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

SUPPORTED = {'quote', 'booking', 'amendment', 'cancellation', 'payment_proof', 'voucher', 'invoice'}


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open() as source:
        return [json.loads(line) for line in source if line.strip()]


def load_direction(directory, direction, prompt, allowed_prompts=()):
    inputs = read_jsonl(directory / f'{direction}.jsonl')
    results = read_jsonl(directory / f'results-{direction}.jsonl')
    by_case = {row['case']: row for row in inputs}
    if len(by_case) != len(inputs):
        raise SystemExit(f'duplicate {direction} input case')
    prompt_hashes = {hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in (prompt, *allowed_prompts)}
    latest = {}
    for record in results:
        case = record.get('case')
        if case not in by_case or record.get('prompt_sha256') not in prompt_hashes:
            raise SystemExit(f'{direction} result identity mismatch')
        if record.get('model') != 'gpt-6-luna' or record.get('effort') != 'medium':
            raise SystemExit(f'{direction} model identity mismatch')
        projected = runner._project_inbound(by_case[case]) if direction == 'inbound' else runner._project_outbound(by_case[case])
        expected_hash = hashlib.sha256(runner._canonical_json(projected).encode('utf-8')).hexdigest()
        if record.get('input_sha256') != expected_hash:
            raise SystemExit(f'{direction} input identity mismatch')
        previous = latest.get(case)
        if previous and (previous.get('status') != 'failed' or record.get('attempt') != previous.get('attempt', 0) + 1):
            raise SystemExit(f'{direction} result retry sequence mismatch')
        latest[case] = record
    good = {case: row['result'] for case, row in latest.items() if row.get('status') == 'ok'}
    status = Counter(row.get('status', 'missing') for row in latest.values())
    return by_case, good, {'input': len(inputs), 'ok': len(good),
                           'failed': status['failed'], 'withheld': status['withheld'],
                           'missing': len(inputs) - len(latest),
                           'failed_cases': sorted(case for case, row in latest.items() if row.get('status') == 'failed'),
                           'withheld_cases': sorted(case for case, row in latest.items() if row.get('status') == 'withheld'),
                           'missing_cases': sorted(set(by_case) - set(latest))}


def top_domains(cases, packets, limit=10):
    counts = Counter()
    for case in cases:
        addresses = packets[case]['inbound'].get('from') or []
        domains = {a.rsplit('@', 1)[-1].casefold() for a in addresses if '@' in a}
        counts.update(domains)
    return [{'domain': domain, 'emails': n} for domain, n in counts.most_common(limit)]


def apply_recovered(input_path, result_path, inbound, results, allow_partial, prompt):
    """Use reclassified original MIME evidence without changing source records."""
    rows = read_jsonl(input_path)
    recovered = {row['case']: row for row in rows}
    if len(recovered) != len(rows):
        raise SystemExit('duplicate recovered case')
    for case, row in recovered.items():
        original = inbound.get(case)
        if not original or row['_source'] != original['_source'] or row['candidate_replies'] != original['candidate_replies']:
            raise SystemExit('recovered source or candidate mismatch')
        for field in ('date', 'from', 'subject'):
            if row['inbound'].get(field) != original['inbound'].get(field):
                raise SystemExit('recovered message identity mismatch')
    prompt_hash = hashlib.sha256(prompt.read_bytes()).hexdigest()
    latest = {}
    for record in read_jsonl(result_path):
        case = record.get('case')
        if case not in recovered or record.get('prompt_sha256') != prompt_hash:
            raise SystemExit('recovered result identity mismatch')
        if record.get('model') != 'gpt-6-luna' or record.get('effort') != 'medium':
            raise SystemExit('recovered model mismatch')
        projected = runner._project_inbound(recovered[case])
        digest = hashlib.sha256(runner._canonical_json(projected).encode('utf-8')).hexdigest()
        if record.get('input_sha256') != digest:
            raise SystemExit('recovered input mismatch')
        previous = latest.get(case)
        if previous and (previous.get('status') != 'failed' or record.get('attempt') != previous.get('attempt', 0) + 1):
            raise SystemExit('recovered retry sequence mismatch')
        latest[case] = record
    good = {case: record for case, record in latest.items() if record.get('status') == 'ok'}
    if not allow_partial and set(good) != set(recovered):
        raise SystemExit('recovered classification incomplete')
    changed = []
    for case, record in good.items():
        if case not in results:
            if allow_partial: continue
            raise SystemExit('original classification missing for recovered case')
        result = runner._validate_inbound_result({'results': [record['result']]}, runner._project_inbound(recovered[case]))
        before = (results[case]['reservation_email'], results[case]['can_help'])
        after = (result['reservation_email'], result['can_help'])
        if before != after:
            changed.append({'case': case, 'before': before, 'after': after})
        inbound[case], results[case] = recovered[case], result
    return {'expected': len(recovered), 'reclassified': len(good), 'decisions_changed': changed}


def apply_envelope_review(input_path, result_path, index_path, source_specs,
                          inbound, results, allow_partial, prompt):
    """Apply To/Cc review only after rebuilding recipients from the source rows."""
    envelope_spec = importlib.util.spec_from_file_location(
        'mailbox_augment_inbound_envelope', HERE / 'mailbox-augment-inbound-envelope.py')
    envelope = importlib.util.module_from_spec(envelope_spec)
    envelope_spec.loader.exec_module(envelope)
    reviewed = read_jsonl(input_path)
    index_rows = read_jsonl(index_path)
    index = envelope._index_map(index_rows)
    if len({row.get('case') for row in reviewed}) != len(reviewed):
        raise SystemExit('duplicate envelope review case')
    try:
        originals = [inbound[row['case']] for row in reviewed]
        selected_index = [index[row['case']] for row in reviewed]
    except KeyError:
        raise SystemExit('envelope review source missing') from None
    source_rows, source_meta = envelope.load_source_rows(envelope._parse_sources(source_specs))
    validation = envelope.validate_annotations(originals, selected_index, reviewed, source_rows)
    review = apply_recovered(input_path, result_path, inbound, results, allow_partial, prompt)
    return {**review, 'recipient_validation': validation,
            'source_sha256': source_meta['summary']['source_sha256']}


def enrich_all_envelopes(index_path, source_specs, inbound):
    """Carry source-verified To/Cc on every final packet for later review."""
    envelope_spec = importlib.util.spec_from_file_location(
        'mailbox_augment_inbound_envelope', HERE / 'mailbox-augment-inbound-envelope.py')
    envelope = importlib.util.module_from_spec(envelope_spec)
    envelope_spec.loader.exec_module(envelope)
    index = envelope._index_map(read_jsonl(index_path))
    if set(index) != set(inbound):
        raise SystemExit('envelope index does not cover the frame')
    originals = list(inbound.values())
    ordered_index = [index[row['case']] for row in originals]
    augmented, _ = envelope.augment_packets(originals, ordered_index)
    source_rows, _ = envelope.load_source_rows(envelope._parse_sources(source_specs))
    validation = envelope.validate_annotations(originals, ordered_index, augmented, source_rows)
    for row in augmented:
        inbound[row['case']] = row
    return validation


def apply_same_packet_review(input_path, result_path, prompt, inbound, results, allow_partial):
    """Apply an independently reviewed label only to the identical full packet."""
    for row in read_jsonl(input_path):
        if inbound.get(row.get('case')) != row:
            raise SystemExit('semantic review packet differs from current evidence')
    return apply_recovered(input_path, result_path, inbound, results, allow_partial, prompt)


def apply_group_review(path, inbound, results, allow_partial, resolutions=None, prompt=None):
    """Replace only the help decision after reviewing every identified group."""
    expected = {case for case, result in results.items()
                if result['reservation_email'] is True and 'group' in result['actions']}
    prompt = prompt or HERE / '2026-11-02-luna-group-review-prompt.md'
    prompt_hash = hashlib.sha256(prompt.read_bytes()).hexdigest()
    latest = {}
    for record in read_jsonl(path):
        case = record.get('case')
        if case not in expected or record.get('prompt_sha256') != prompt_hash:
            raise SystemExit('group review identity mismatch')
        if record.get('model') != 'gpt-6-luna' or record.get('effort') != 'medium':
            raise SystemExit('group review model mismatch')
        projected = runner._project_inbound(inbound[case])
        digest = hashlib.sha256(runner._canonical_json(projected).encode('utf-8')).hexdigest()
        if record.get('input_sha256') != digest:
            raise SystemExit('group review input mismatch')
        previous = latest.get(case)
        if previous and (previous.get('status') != 'failed' or record.get('attempt') != previous.get('attempt', 0) + 1):
            raise SystemExit('group review retry sequence mismatch')
        latest[case] = record
    good = {case: record for case, record in latest.items() if record.get('status') == 'ok'}
    if not allow_partial and set(good) != expected:
        raise SystemExit('group review incomplete')
    resolutions = resolutions or {}
    changed, disagreements, resolved = [], [], []
    for case, record in good.items():
        reviewed = runner._validate_inbound_result({'results': [record['result']]}, runner._project_inbound(inbound[case]))
        if reviewed['reservation_email'] is not True or 'group' not in reviewed['actions']:
            resolution = resolutions.get(case, {})
            decision = resolution.get('decision')
            if decision and not resolution.get('reason'):
                raise SystemExit('group resolution must include its reason')
            if decision == 'use_review':
                results[case] = reviewed
                resolved.append(case)
            elif decision == 'keep_original':
                resolved.append(case)
            else:
                disagreements.append(case)
            continue
        before, after = results[case]['can_help'], reviewed['can_help']
        if before != after:
            changed.append({'case': case, 'before': before, 'after': after})
            explanation = ('The requested work concerns a group of more than 10 rooms and is outside the supported workflows.'
                           if after is False else
                           'A separate supported non-group task is present alongside the large-group work.'
                           if after is True else 'The separate non-group task needs more information.')
            results[case] = {**results[case], 'can_help': after, 'reason': explanation,
                             'scope_review_reason': reviewed['reason']}
        else:
            results[case] = {**results[case], 'can_help': after}
    if disagreements and not allow_partial:
        raise SystemExit('group review disputes group/inclusion; inspect: ' + ', '.join(disagreements))
    return {'expected': len(expected), 'reviewed': len(good), 'decisions_changed': changed,
            'group_or_inclusion_disagreements': disagreements, 'resolved_disagreements': resolved}


def apply_audit_corrections(path, results, allow_partial, inbound=None):
    rows = json.loads(path.read_text())
    applied = []
    for row in rows:
        case = row['case']
        if case not in results:
            if allow_partial: continue
            raise SystemExit('audit correction case missing')
        expected_input = row.get('expected_input_sha256')
        if expected_input:
            if not inbound or case not in inbound:
                raise SystemExit('audit correction source packet missing')
            actual = hashlib.sha256(runner._canonical_json(runner._project_inbound(inbound[case])).encode('utf-8')).hexdigest()
            if actual != expected_input:
                raise SystemExit('audit correction source packet mismatch')
        for supporting in row.get('supporting_packets', []):
            supporting_case = supporting.get('case')
            if not inbound or supporting_case not in inbound:
                raise SystemExit('audit correction supporting packet missing')
            actual = hashlib.sha256(runner._canonical_json(
                runner._project_inbound(inbound[supporting_case])).encode('utf-8')).hexdigest()
            if actual != supporting.get('input_sha256'):
                raise SystemExit('audit correction supporting packet mismatch')
        result = results[case]
        remove_replies = set(row['remove_reply_ids'])
        remove_actions = set(row['remove_actions'])
        add_actions = set(row.get('add_actions', []))
        if not remove_replies.issubset(result['reply_ids']) or not remove_actions.issubset(result['actions']):
            raise SystemExit('audit correction does not match original result')
        if not add_actions.issubset(set(runner.INBOUND_ACTIONS)) or add_actions.intersection(result['actions']):
            raise SystemExit('invalid added audit action')
        revised = {**result,
                   'reply_ids': [x for x in result['reply_ids'] if x not in remove_replies],
                   'actions': [x for x in result['actions'] if x not in remove_actions] + sorted(add_actions)}
        if 'replace_reservation_email' in row:
            if not isinstance(row['replace_reservation_email'], bool):
                raise SystemExit('invalid audit inclusion correction')
            revised['reservation_email'] = row['replace_reservation_email']
        if 'replace_can_help' in row:
            if row['replace_can_help'] is not None and not isinstance(row['replace_can_help'], bool):
                raise SystemExit('invalid audit help correction')
            revised['can_help'] = row['replace_can_help']
        if row.get('replace_reason'): revised['reason'] = row['replace_reason']
        if row.get('invoice_handling'):
            if row['invoice_handling'] not in runner.INVOICE_HANDLING:
                raise SystemExit('invalid audit invoice correction')
            revised['invoice_handling'] = row['invoice_handling']
        if row.get('response_type'):
            if row['response_type'] not in runner.INBOUND_RESPONSE_TYPES:
                raise SystemExit('invalid audit response correction')
            revised['response_type'] = row['response_type']
        if revised['reservation_email'] is False and revised['can_help'] is not False:
            raise SystemExit('excluded audit result cannot be helpable')
        revised['audit_correction'] = {
            'reason': row.get('replace_reason', ''),
            'before': {key: result.get(key) for key in
                       ('reservation_email', 'can_help', 'actions', 'reply_ids', 'response_type', 'invoice_handling')},
        }
        results[case] = revised
        applied.append(case)
    return applied


def apply_reply_audit_corrections(path, inbound, results, allow_partial):
    """Remove source-bound, independently rejected reply edges after overlay.

    This never changes an email's workflow, inclusion, or helpability label.
    """
    rows = json.loads(path.read_text())
    applied = []
    seen = set()
    for row in rows:
        case = row['case']
        if case in seen:
            raise SystemExit('duplicate reply audit case')
        seen.add(case)
        if case not in results or case not in inbound:
            if allow_partial:
                continue
            raise SystemExit('reply audit case missing')
        result = results[case]
        remove = row.get('remove_reply_ids')
        expected = row.get('expected_outbounds')
        if (not isinstance(remove, list) or not remove or len(set(remove)) != len(remove)
                or not isinstance(expected, dict) or set(expected) != set(remove)
                or not set(remove).issubset(result['reply_ids'])):
            raise SystemExit('reply audit edge set mismatch')
        candidates = {item['reply_id']: item for item in inbound[case]['candidate_replies']}
        if any(reply not in candidates or candidates[reply].get('outbound_case') != expected[reply]
               for reply in remove):
            raise SystemExit('reply audit source mismatch')
        if row.get('remove_actions') or row.get('add_actions') or 'replace_can_help' in row or 'replace_reservation_email' in row:
            raise SystemExit('reply audit cannot change classification')
        remaining = [reply for reply in result['reply_ids'] if reply not in set(remove)]
        response = row.get('response_type')
        if (response not in runner.INBOUND_RESPONSE_TYPES
                or (not remaining and response != 'none_linked')
                or (remaining and response == 'none_linked')):
            raise SystemExit('reply audit response inconsistent')
        revised = {**result, 'reply_ids': remaining, 'response_type': response,
                   'reply_audit_correction': {'reason': row.get('replace_reason', ''),
                                              'removed': expected,
                                              'previous_response_type': result['response_type']}}
        if not remaining and revised['invoice_handling'] in ('staff_invoice', 'hms_confirmation_candidate'):
            revised['invoice_handling'] = 'invoice_no_reply'
        results[case] = revised
        applied.append(case)
    return applied


def normalize_impossible_evidence_sources(inbound, results):
    """Correct a model claiming reply evidence when no reply was provided."""
    corrections = []
    for case, result in results.items():
        before = result.get('evidence_source')
        if before not in ('reply', 'both') or inbound[case].get('candidate_replies'):
            continue
        email = inbound[case]['inbound']
        after = ('inbound' if any(email.get(key) for key in
                                  ('subject', 'message', 'quoted_context', 'attachment_context')) else 'none')
        results[case] = {**result, 'evidence_source': after,
                         'evidence_source_original': before,
                         'evidence_source_correction': 'no_reply_candidates_supplied'}
        corrections.append({'case': case, 'before': before, 'after': after})
    return corrections


def export_labeled(path, inbound, results, only_actionable, allowed_failures):
    private = HERE.parents[3] / '.private'
    if not path.resolve().is_relative_to(private.resolve()):
        raise SystemExit('labelled export must stay in .private')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        for case in sorted(inbound):
            classification = results.get(case)
            if classification is None:
                if only_actionable or case not in allowed_failures: continue
                packet = inbound[case]
                row = {'case': case, 'inbound': packet['inbound'], 'candidate_replies': [],
                       'classification': None, 'processing': allowed_failures[case], '_source': packet['_source']}
                target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
                continue
            if only_actionable and classification['reservation_email'] is not True: continue
            packet = inbound[case]
            replies = [reply for reply in packet['candidate_replies'] if reply['reply_id'] in classification['reply_ids']]
            row = {'case': case, 'inbound': packet['inbound'], 'candidate_replies': replies,
                   'classification': classification, '_source': packet['_source']}
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def export_full_packets(path, inbound):
    private = HERE.parents[3] / '.private'
    if not path.resolve().is_relative_to(private.resolve()):
        raise SystemExit('full packet export must stay in .private')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        for case in sorted(inbound):
            target.write(json.dumps(inbound[case], ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--allow-partial', action='store_true')
    parser.add_argument('--inbound-prompt', type=Path,
                        default=HERE / '2026-11-01-luna-opportunity-prompt-v12.md')
    parser.add_argument('--allowed-inbound-prompt', type=Path, action='append', default=[],
                        help='additional explicitly versioned prompts used by selected input rows')
    parser.add_argument('--recovered-prompt', type=Path,
                        help='prompt used for attachment-enriched reclassifications')
    parser.add_argument('--group-prompt', type=Path,
                        default=HERE / '2026-11-02-luna-group-review-prompt.md')
    parser.add_argument('--group-review', type=Path)
    parser.add_argument('--group-resolutions', type=Path)
    parser.add_argument('--recovered-input', type=Path, action='append', default=[])
    parser.add_argument('--recovered-results', type=Path, action='append', default=[])
    parser.add_argument('--envelope-review-input', type=Path)
    parser.add_argument('--envelope-review-results', type=Path)
    parser.add_argument('--envelope-review-prompt', type=Path)
    parser.add_argument('--envelope-index', type=Path)
    parser.add_argument('--envelope-source', action='append', default=[], metavar='LABEL=PATH')
    parser.add_argument('--include-envelope-all', action='store_true',
                        help='carry source-validated recipient metadata on all final packets')
    parser.add_argument('--semantic-review-input', type=Path, action='append', default=[])
    parser.add_argument('--semantic-review-results', type=Path, action='append', default=[])
    parser.add_argument('--semantic-review-prompt', type=Path, action='append', default=[])
    parser.add_argument('--reply-review-input', type=Path)
    parser.add_argument('--reply-review-results', type=Path)
    parser.add_argument('--reply-review-prompt', type=Path)
    parser.add_argument('--audit-corrections', type=Path)
    parser.add_argument('--post-reply-corrections', type=Path)
    parser.add_argument('--export-labeled', type=Path)
    parser.add_argument('--export-action-input', type=Path)
    parser.add_argument('--export-full-packets', type=Path,
                        help='private packets retaining all possible reply candidates')
    parser.add_argument('--allowed-failures', type=Path)
    args = parser.parse_args()
    inbound, in_results, in_status = load_direction(args.directory, 'inbound', args.inbound_prompt,
                                                   args.allowed_inbound_prompt)
    outbound, out_results, out_status = load_direction(
        args.directory, 'outbound', HERE / '2026-11-01-luna-outbound-prompt.md')
    allowed_failures = json.loads(args.allowed_failures.read_text()) if args.allowed_failures else {}
    if not isinstance(allowed_failures, dict): raise SystemExit('allowed failures must be an object')
    if any(not isinstance(value, dict) or value.get('status') not in
           ('provider_blocked', 'provider_rejected', 'withheld_sensitive')
           for value in allowed_failures.values()):
        raise SystemExit('allowed failure must record an explicit processing status')
    if not args.allow_partial:
        unclassified = set(in_status['failed_cases'] + in_status['withheld_cases'] + in_status['missing_cases'])
        if (out_status['ok'] != out_status['input'] or unclassified != set(allowed_failures)):
            raise SystemExit('results incomplete or unapproved failure; inspect before aggregating')
    if len(args.recovered_input) != len(args.recovered_results):
        raise SystemExit('recovered input and results must be supplied together')
    recovered_review = [apply_recovered(source, result, inbound, in_results, args.allow_partial,
                                        args.recovered_prompt or args.inbound_prompt)
                        for source, result in zip(args.recovered_input, args.recovered_results, strict=True)]
    envelope_args = (args.envelope_review_input, args.envelope_review_results,
                     args.envelope_review_prompt, args.envelope_index, args.envelope_source)
    if any(envelope_args) and not all(envelope_args):
        raise SystemExit('envelope review input, results, prompt, index and source required together')
    envelope_review = (apply_envelope_review(args.envelope_review_input, args.envelope_review_results,
                                            args.envelope_index, args.envelope_source, inbound, in_results,
                                            args.allow_partial, args.envelope_review_prompt)
                       if all(envelope_args) else None)
    if args.include_envelope_all and not all(envelope_args):
        raise SystemExit('all-packet envelopes require the verified envelope review inputs')
    envelope_all = (enrich_all_envelopes(args.envelope_index, args.envelope_source, inbound)
                    if args.include_envelope_all else None)
    if not (len(args.semantic_review_input) == len(args.semantic_review_results)
            == len(args.semantic_review_prompt)):
        raise SystemExit('each semantic review requires input, results and prompt')
    semantic_review = [apply_same_packet_review(source, result, prompt, inbound, in_results,
                                                args.allow_partial)
                       for source, result, prompt in zip(args.semantic_review_input,
                                                         args.semantic_review_results,
                                                         args.semantic_review_prompt, strict=True)]
    resolutions = json.loads(args.group_resolutions.read_text()) if args.group_resolutions else {}
    group_review = apply_group_review(args.group_review, inbound, in_results, args.allow_partial,
                                      resolutions, args.group_prompt) if args.group_review else None
    corrected_cases = apply_audit_corrections(args.audit_corrections, in_results, args.allow_partial, inbound) if args.audit_corrections else []
    reply_args = (args.reply_review_input, args.reply_review_results, args.reply_review_prompt)
    if any(reply_args) and not all(reply_args):
        raise SystemExit('reply review input, results, and prompt must be supplied together')
    reply_review = None
    if all(reply_args):
        reply_spec = importlib.util.spec_from_file_location(
            'mailbox_reply_review_overlay', HERE / 'mailbox-reply-review-overlay.py')
        reply_overlay = importlib.util.module_from_spec(reply_spec)
        reply_spec.loader.exec_module(reply_overlay)
        reply_review = reply_overlay.apply(*reply_args[:2], inbound, in_results, out_results,
                                           args.reply_review_prompt.resolve())
    if args.post_reply_corrections and not reply_review:
        raise SystemExit('post-reply corrections require the reply review overlay')
    reply_corrected_cases = (apply_reply_audit_corrections(args.post_reply_corrections, inbound, in_results,
                                                           args.allow_partial)
                             if args.post_reply_corrections else [])
    evidence_source_corrections = normalize_impossible_evidence_sources(inbound, in_results)

    relevant = {case for case, result in in_results.items() if result['reservation_email'] is True}
    excluded = {case for case, result in in_results.items() if result['reservation_email'] is False}
    insufficient = {case for case, result in in_results.items() if result['reservation_email'] is None}
    helped = {case for case in relevant if in_results[case]['can_help'] is True}
    not_helped = {case for case in relevant if in_results[case]['can_help'] is False}
    needs_more = {case for case in relevant if in_results[case]['can_help'] is None}
    groups = {case for case in relevant if 'group' in in_results[case]['actions']}
    all_groups = {case for case, result in in_results.items() if 'group' in result['actions']}
    room_missing = {case for case in needs_more if 'room' in in_results[case]['reason'].casefold()}
    relevant_actions = Counter(action for case in relevant for action in in_results[case]['actions'])
    helped_actions = Counter(action for case in helped for action in in_results[case]['actions'])
    bad_help = [case for case in helped if not (set(in_results[case]['actions']) & SUPPORTED)]
    if bad_help and not args.allow_partial:
        raise SystemExit('helpable results lack a supported action; review: ' + ', '.join(sorted(bad_help)))
    invoice_cases = {case for case in relevant if 'invoice' in in_results[case]['actions']}
    invoice_types = Counter(in_results[case]['invoice_handling'] for case in invoice_cases)
    helped_invoice_types = Counter(in_results[case]['invoice_handling'] for case in invoice_cases & helped)
    response_types = Counter(in_results[case]['response_type'] for case in relevant)
    outbound_types = Counter(result['message_type'] for result in out_results.values())
    outbound_automation = Counter(result['automation_status'] for result in out_results.values())
    outbound_actions = Counter(action for result in out_results.values() for action in result['categories'])

    linked, linked_helped, staff_linked, pms_linked, cross_thread = set(), set(), set(), set(), set()
    linked_outbound = set()
    staff_outbound_linked, staff_outbound_helped = set(), set()
    pms_outbound_linked, pms_outbound_helped = set(), set()
    unresolved_outbound = set()
    for case in relevant:
        result = in_results[case]
        candidates = {row['reply_id']: row for row in inbound[case]['candidate_replies']}
        for reply_id in result['reply_ids']:
            reply = candidates.get(reply_id)
            if not reply or not reply.get('outbound_case'):
                raise SystemExit('matched reply lacks source mapping')
            out_case = reply['outbound_case']
            if out_case not in outbound:
                raise SystemExit('matched outbound missing from frame')
            linked.add(case)
            linked_outbound.add(out_case)
            if case in helped: linked_helped.add(case)
            if not reply.get('same_thread'): cross_thread.add(case)
            out_result = out_results.get(out_case)
            if not out_result:
                unresolved_outbound.add(out_case)
            elif out_result['message_type'] == 'staff_written':
                staff_linked.add(case)
                staff_outbound_linked.add(out_case)
                if case in helped: staff_outbound_helped.add(out_case)
            elif out_result['message_type'] == 'pms_confirmation_template':
                pms_linked.add(case)
                pms_outbound_linked.add(out_case)
                if case in helped: pms_outbound_helped.add(out_case)

    manifest = read_jsonl(args.directory / 'manifest.jsonl')[0]
    summary = {
        'frame': {'window': [manifest.get('start_south_africa', manifest.get('start')),
                             manifest.get('end_south_africa_exclusive', manifest.get('end_exclusive'))],
                  'source_rows': manifest['raw'], 'deduplicated_emails': manifest['deduplicated'],
                  'inbound_run': in_status, 'outbound_run': out_status},
        'inbound': {'reservation_actionable': len(relevant), 'not_actionable_or_out_of_scope': len(excluded),
                    'insufficient_evidence_for_reservation': len(insufficient), 'potential_nava_help': len(helped),
                    'provider_blocked': sum(value.get('status') == 'provider_blocked' for value in allowed_failures.values()),
                    'provider_rejected': sum(value.get('status') == 'provider_rejected' for value in allowed_failures.values()),
                    'withheld_sensitive': sum(value.get('status') == 'withheld_sensitive' for value in allowed_failures.values()),
                    'no_supported_help': len(not_helped), 'needs_specific_information': len(needs_more),
                    'missing_room_count_reason': len(room_missing),
                    'group_emails_over_ten_rooms': len(groups),
                    'group_related_emails_all_analyzed': len(all_groups),
                    'group_emails_with_separate_helpable_task': len(groups & helped),
                    'help_share_of_reservation_pct': round(100 * len(helped) / len(relevant), 1) if relevant else None,
                    'actions_all_reservation': dict(relevant_actions), 'actions_helped': dict(helped_actions),
                    'invoice_handling': dict(invoice_types), 'invoice_handling_helped': dict(helped_invoice_types),
                    'response_types': dict(response_types)},
        'reply_links': {'reservation_inbounds_linked': len(linked), 'helped_inbounds_linked': len(linked_helped),
                        'help_share_of_linked_pct': round(100 * len(linked_helped) / len(linked), 1) if linked else None,
                        'inbounds_linked_to_staff': len(staff_linked), 'inbounds_linked_to_pms_template': len(pms_linked),
                        'inbounds_with_cross_thread_link': len(cross_thread), 'distinct_outbounds_linked': len(linked_outbound),
                        'distinct_staff_outbounds_linked_to_reservation': len(staff_outbound_linked),
                        'distinct_staff_outbounds_linked_to_helpable': len(staff_outbound_helped),
                        'help_share_of_linked_staff_outbounds_pct': round(
                            100 * len(staff_outbound_helped) / len(staff_outbound_linked), 1) if staff_outbound_linked else None,
                        'distinct_pms_outbounds_linked_to_reservation': len(pms_outbound_linked),
                        'distinct_pms_outbounds_linked_to_helpable': len(pms_outbound_helped),
                        'linked_outbounds_without_classification': len(unresolved_outbound),
                        'interpretation': 'Candidate-based estimate: replies can be missed or linked incorrectly; no link does not prove no reply.'},
        'outbound': {'message_types': dict(outbound_types), 'automation_status': dict(outbound_automation),
                     'actions': dict(outbound_actions),
                     'interpretation': 'PMS template volume is an estimate of system-generated messages, not proof of unattended sending.'},
        'domains': {'all_inbound': top_domains(inbound, inbound), 'all_analyzed_inbound': top_domains(in_results, inbound),
                    'reservation_inbound': top_domains(relevant, inbound)},
        'quality': {'potential_help_without_supported_action_cases': bad_help,
                    'recovered_original_mime': recovered_review,
                    'inbound_envelope_review': envelope_review,
                    'inbound_envelope_all': envelope_all,
                    'semantic_review': semantic_review,
                    'group_scope_review': group_review,
                    'audit_correction_cases': corrected_cases,
                    'reply_audit_correction_cases': reply_corrected_cases,
                    'reply_only_review': reply_review,
                    'impossible_evidence_source_corrections': evidence_source_corrections,
                    'no_independent_human_gold': True, 'actions_can_overlap': True},
    }
    if args.output:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as target:
            json.dump(summary, target, ensure_ascii=False, indent=2)
    if args.export_labeled: export_labeled(args.export_labeled, inbound, in_results, False, allowed_failures)
    if args.export_action_input: export_labeled(args.export_action_input, inbound, in_results, True, allowed_failures)
    if args.export_full_packets: export_full_packets(args.export_full_packets, inbound)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
