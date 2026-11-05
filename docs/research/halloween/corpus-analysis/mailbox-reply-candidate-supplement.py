#!/usr/bin/env python3
"""Add reverse-discovered reply candidates; an LLM must still decide whether they match."""

import argparse
import collections
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIVATE = HERE.parents[3] / '.private'


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cleaning = load_module('frame_cleaning', 'centurion-range-prepare.py')
signature = load_module('signature_cleaning', 'mailbox-clean-text.py')


def read(path):
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def unique(rows):
    result = {row['case']: row for row in rows}
    if len(rows) != len(result):
        raise ValueError('duplicate case')
    return result


def supplement(inbound, outbound, limit=100, source_rows=None, outbound_types=None):
    if not 5 <= limit <= 100:
        raise ValueError('candidate limit must be 5 through 100')
    ins, outs = unique(inbound), unique(outbound)
    frequencies = collections.Counter()
    for row in outbound:
        message = row['outbound']
        frequencies.update(cleaning.tokens((message.get('subject') or '') + ' ' + (message.get('message') or '')[:800]))
    extra = collections.defaultdict(dict)
    known_pdf = {}
    for row in inbound:
        for candidate in row.get('candidate_replies') or []:
            if candidate.get('confirmation_pdf_filename'):
                known_pdf[candidate['outbound_case']] = candidate['confirmation_pdf_filename']
    if source_rows:
        source = {row['id']: row for row in source_rows}
        for row in outbound:
            if any(source.get(row_id, {}).get('confirmation_pdf_filename')
                   for row_id in row.get('_source', {}).get('row_ids', [])):
                known_pdf.setdefault(row['case'], True)
    for out in outbound:
        for reverse in out.get('candidate_inbounds') or []:
            case = reverse['inbound_case']
            if case not in ins:
                raise ValueError('reverse candidate refers to an absent inbound')
            if reverse.get('minutes_before_outbound', -1) < 0:
                raise ValueError('reverse candidate precedes inbound')
            if out['case'] in {x['outbound_case'] for x in ins[case].get('candidate_replies') or []}:
                continue
            extra[case][out['case']] = reverse
    changed, equivalences, stats = [], [], collections.Counter()
    for case, reverse_by_out in sorted(extra.items()):
        original = ins[case]
        current = original.get('candidate_replies') or []
        if len(current) > limit:
            raise ValueError('existing candidates exceed limit')
        used_ids = {str(x['reply_id']) for x in current}
        if len(used_ids) != len(current):
            raise ValueError('duplicate reply id')
        mail = original['inbound']
        in_tokens = cleaning.tokens(' '.join(str(mail.get(key) or '')
                                            for key in ('subject', 'message', 'quoted_context')))

        def order(item):
            out_case, reverse = item
            mail_out = outs[out_case]['outbound']
            out_tokens = cleaning.tokens((mail_out.get('subject') or '') + ' ' + (mail_out.get('message') or '')[:800])
            shared = in_tokens & out_tokens
            # Rare names/references carry more signal than boilerplate or the year.
            score = sum(math.log((len(outbound) + 1) / (frequencies[token] + 1)) for token in shared)
            return (not bool(reverse.get('direct_header_match')), not bool(reverse.get('same_thread')),
                    -score, reverse['minutes_before_outbound'], out_case)

        ordered = sorted(reverse_by_out.items(), key=order)
        candidates = [dict(candidate) for candidate in current]
        groups = {}

        def fingerprint(candidate):
            subject = str(candidate.get('subject') or '').strip().casefold()
            recipients = tuple(sorted(candidate.get('to') or []))
            out_case = candidate['outbound_case']
            source = outs[out_case]
            message = source['outbound']
            body = str(message.get('message') or '')
            quoted = str(message.get('quoted_context') or '')
            lengths = source.get('_source') or {}
            # Truncated source content cannot establish equivalence.
            if lengths.get('current_chars', 0) > len(body) or lengths.get('quoted_chars', 0) > len(quoted):
                return (subject, recipients, out_case)
            contents = json.dumps([body, quoted], ensure_ascii=False, separators=(',', ':'))
            return (subject, recipients, hashlib.sha256(contents.encode()).hexdigest())

        for candidate in current:
            groups.setdefault(fingerprint(candidate), {'reply_id': str(candidate['reply_id']),
                              'outbound_cases': []})['outbound_cases'].append(candidate['outbound_case'])
        next_id = 1
        for out_case, reverse in ordered:
            mail_out = outs[out_case]['outbound']
            body, _ = signature.trim_signature((mail_out.get('message') or '')[:800])
            content = {'outbound_case': out_case, 'subject': mail_out.get('subject'),
                       'to': mail_out.get('to'), 'body': body}
            group = groups.get(fingerprint(content))
            if group:
                group['outbound_cases'].append(out_case)
                stats['equivalent_candidates_collapsed'] += 1
                continue
            if len(candidates) >= limit:
                stats['candidates_not_added_due_to_limit'] += 1
                continue
            while f'R{next_id}' in used_ids:
                next_id += 1
            reply_id = f'R{next_id}'
            used_ids.add(reply_id)
            candidates.append({'reply_id': reply_id, 'outbound_case': out_case,
                'direct_header_match': reverse.get('direct_header_match'), 'same_thread': reverse.get('same_thread'),
                'minutes_after_inbound': reverse['minutes_before_outbound'], 'from': mail_out.get('from'),
                'to': mail_out.get('to'), 'subject': mail_out.get('subject'), 'body': body,
                'confirmation_pdf_filename': known_pdf.get(out_case)})
            groups[fingerprint(content)] = {'reply_id': reply_id, 'outbound_cases': [out_case]}
        for group in groups.values():
            if len(group['outbound_cases']) > 1:
                equivalences.append({'case': case, **group})
        if outbound_types is not None:
            for candidate in candidates:
                kind = outbound_types.get(candidate['outbound_case'])
                if kind not in {'staff_written', 'pms_confirmation_template', 'other_automated', 'other', 'unknown'}:
                    raise ValueError('candidate lacks outbound classification')
                candidate['outbound_message_type'] = kind
            stats['inbounds_with_outbound_types'] += 1
        if len(candidates) > len(current) or outbound_types is not None:
            changed.append({**original, 'candidate_replies': candidates})
            stats['inbounds_with_extra_candidates'] += 1
            stats['candidates_added'] += len(candidates) - len(current)
    return changed, equivalences, dict(stats)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inbound', type=Path, required=True)
    parser.add_argument('--outbound', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, action='append', default=[],
                        help='optional normalized source rows for confirmation-PDF metadata')
    parser.add_argument('--outbound-results', type=Path,
                        help='optional independently estimated outbound message types')
    parser.add_argument('--equivalences', type=Path, help='private mapping of identical candidates')
    parser.add_argument('--limit', type=int, default=100)
    args = parser.parse_args()
    if (not args.output.resolve().is_relative_to(PRIVATE.resolve()) or
            (args.equivalences and not args.equivalences.resolve().is_relative_to(PRIVATE.resolve()))):
        raise ValueError('output must be private')
    source = [row for path in args.source for row in read(path)]
    types = None
    if args.outbound_results:
        types = {record['case']: record['result']['message_type']
                 for record in read(args.outbound_results) if record.get('status') == 'ok'}
    changed, equivalences, stats = supplement(read(args.inbound), read(args.outbound), args.limit, source, types)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        for row in changed:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    if args.equivalences:
        fd = os.open(args.equivalences, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            for row in equivalences:
                target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps(stats, sort_keys=True))


if __name__ == '__main__':
    main()
