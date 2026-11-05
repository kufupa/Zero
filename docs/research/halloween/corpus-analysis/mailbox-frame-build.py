#!/usr/bin/env python3
"""Build cleaned, deduplicated mailbox packets from normalized source rows.

Input JSONL fields: id, when (timezone-aware), direction, thread, message_id,
in_reply_to, subject, body, from, to, cc, optional confirmation_pdf_filename.
Use one row per transport copy, already restricted to the intended mailbox.
No classification is performed here; reply links are candidates for an LLM.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
PRIVATE_ROOT = HERE.parents[3] / '.private'
spec = importlib.util.spec_from_file_location('frame_cleaning', HERE / 'centurion-range-prepare.py')
cleaning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleaning)


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError('invalid_time')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('invalid_time') from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('timezone_required')
    return parsed.astimezone(timezone.utc)


def addr(value):
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise ValueError('invalid_address')
    return cleaning.addresses(value)


def read_source(paths, start, end, prefer_last):
    rows = {}
    duplicates, conflicts = 0, 0
    for path in paths:
        with path.open() as source:
            for line in source:
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id']:
                    raise ValueError('invalid_source_row')
                when = parse_time(row.get('when'))
                if not start <= when < end:
                    continue
                if row.get('direction') not in ('inbound', 'outbound'):
                    raise ValueError('invalid_direction')
                source_id = row['id']
                if source_id in rows:
                    duplicates += 1
                    if rows[source_id] != row:
                        conflicts += 1
                        if not prefer_last:
                            raise ValueError('conflicting_source_row')
                    else:
                        continue
                rows[source_id] = row
    normalized = []
    for row in rows.values():
        to = sorted(set(addr(row.get('to')) + addr(row.get('cc'))))
        normalized.append({'id': row['id'], 'thread': row.get('thread'), 'when': parse_time(row['when']),
                           'direction': row['direction'], 'message_id': cleaning.first(row.get('message_id')),
                           'in_reply_to': cleaning.first(row.get('in_reply_to')),
                           'subject': str(row.get('subject') or ''), 'body': str(row.get('body') or ''),
                           'from': addr(row.get('from')), 'to': to,
                           'pdf': row.get('confirmation_pdf_filename')})
    return normalized, {'duplicate_source_rows': duplicates, 'conflicting_source_rows': conflicts}


def build(rows, current_chars=4000, quoted_chars=2000):
    groups = defaultdict(list)
    for original in rows:
        row = dict(original)
        mid = cleaning.norm_id(row.get('message_id'))
        sender = tuple(row['from'])
        subject = row['subject'].strip().casefold()
        key = (row['direction'], mid, sender, subject) if mid and sender else (row['direction'], 'row:' + row['id'])
        row['current'], row['quoted'] = cleaning.split_body(row['body'], row['subject'])
        groups[key].append(row)

    logical = []
    for group in groups.values():
        item = dict(max(group, key=lambda row: (len(row['current']), len(row['quoted']))))
        item['when'] = min(row['when'] for row in group)
        item['ids'] = sorted(row['id'] for row in group)
        item['threads'] = sorted({row['thread'] for row in group if row.get('thread')})
        pdfs = [row['pdf'] for row in group if row.get('pdf')]
        item['pdf'] = pdfs[0] if pdfs else None
        item['subject'] = cleaning.scrub(item['subject'])[:300]
        logical.append(item)
    logical.sort(key=lambda row: (row['when'], row['ids'][0]))
    inbound = [row for row in logical if row['direction'] == 'inbound']
    outbound = [row for row in logical if row['direction'] == 'outbound']
    for i, row in enumerate(inbound, 1): row['case'] = f'I{i:05d}'
    for i, row in enumerate(outbound, 1): row['case'] = f'O{i:05d}'

    out_by_thread, out_by_recipient, out_by_reply = defaultdict(list), defaultdict(list), defaultdict(list)
    in_by_thread, in_by_sender, in_by_mid = defaultdict(list), defaultdict(list), defaultdict(list)
    for row in outbound:
        for thread in row['threads']: out_by_thread[thread].append(row)
        for address in row['to']: out_by_recipient[address].append(row)
        if cleaning.norm_id(row['in_reply_to']): out_by_reply[cleaning.norm_id(row['in_reply_to'])].append(row)
    for row in inbound:
        for thread in row['threads']: in_by_thread[thread].append(row)
        for address in row['from']: in_by_sender[address].append(row)
        if cleaning.norm_id(row['message_id']): in_by_mid[cleaning.norm_id(row['message_id'])].append(row)

    def candidate_inbound(item):
        found = {}
        for other in in_by_mid.get(cleaning.norm_id(item['in_reply_to']), []): found[other['case']] = other
        for thread in item['threads']:
            for other in in_by_thread[thread]: found[other['case']] = other
        for address in item['to']:
            for other in in_by_sender[address]: found[other['case']] = other
        chosen = []
        for other in found.values():
            delta = (item['when'] - other['when']).total_seconds() / 60
            if delta < 0: continue
            direct = bool(cleaning.norm_id(item['in_reply_to'])) and cleaning.norm_id(item['in_reply_to']) == cleaning.norm_id(other['message_id'])
            same = bool(set(item['threads']) & set(other['threads']))
            if not (direct or (same and delta <= 7 * 1440) or (set(item['to']) & set(other['from']) and delta <= 72 * 60)): continue
            overlap = len(cleaning.tokens(item['subject']) & cleaning.tokens(other['subject'] + ' ' + other['current'][:1000]))
            chosen.append(((0 if direct else 1 if same else 2, -overlap, delta), other, delta, direct, same))
        chosen.sort(key=lambda value: value[0])
        return [{'request_id': f'Q{i}', 'inbound_case': other['case'], 'direct_header_match': direct,
                 'same_thread': same, 'minutes_before_outbound': round(delta), 'from': other['from'],
                 'subject': other['subject'], 'body': other['current'][:700]}
                for i, (_, other, delta, direct, same) in enumerate(chosen[:3], 1)]

    def candidate_outbound(item):
        found = {}
        mid = cleaning.norm_id(item['message_id'])
        for other in out_by_reply.get(mid, []): found[other['case']] = other
        for thread in item['threads']:
            for other in out_by_thread[thread]: found[other['case']] = other
        for address in item['from']:
            for other in out_by_recipient[address]: found[other['case']] = other
        selected = []
        for other in found.values():
            delta = (other['when'] - item['when']).total_seconds() / 60
            if delta < 0: continue
            direct = bool(mid) and cleaning.norm_id(other['in_reply_to']) == mid
            same = bool(set(item['threads']) & set(other['threads']))
            if not (direct or (same and delta <= 7 * 1440) or (set(item['from']) & set(other['to']) and delta <= 72 * 60)): continue
            overlap = len(cleaning.tokens(other['subject']) & cleaning.tokens(item['subject'] + ' ' + item['current'][:1000]))
            selected.append(((0 if direct else 1 if same else 2, -overlap, delta), other, delta, direct, same))
        selected.sort(key=lambda value: value[0])
        chosen = selected[:5]
        cross = next((value for value in selected if not value[4]), None)
        if cross and cross not in chosen and len(chosen) == 5: chosen[-1] = cross
        return [{'reply_id': f'R{i}', 'outbound_case': other['case'], 'direct_header_match': direct,
                 'same_thread': same, 'minutes_after_inbound': round(delta), 'from': other['from'],
                 'to': other['to'], 'subject': other['subject'], 'body': other['current'][:800],
                 'confirmation_pdf_filename': other['pdf']}
                for i, (_, other, delta, direct, same) in enumerate(chosen, 1)]

    def source(item):
        return {'row_ids': item['ids'], 'current_chars': len(item['current']), 'quoted_chars': len(item['quoted'])}

    in_packets = [{'case': row['case'], '_source': source(row),
                   'inbound': {'date': row['when'].isoformat(), 'from': row['from'], 'subject': row['subject'],
                               'message': row['current'][:current_chars], 'quoted_context': row['quoted'][:quoted_chars]},
                   'candidate_replies': candidate_outbound(row)} for row in inbound]
    out_packets = [{'case': row['case'], '_source': source(row),
                    'outbound': {'date': row['when'].isoformat(), 'from': row['from'], 'to': row['to'],
                                 'subject': row['subject'], 'message': row['current'][:current_chars],
                                 'quoted_context': row['quoted'][:quoted_chars]},
                    'candidate_inbounds': candidate_inbound(row)} for row in outbound]
    meta = {'raw': dict(Counter(row['direction'] for row in rows)),
            'deduplicated': {'inbound': len(inbound), 'outbound': len(outbound)},
            'duplicate_groups': sum(len(group) > 1 for group in groups.values()),
            'inbound_with_candidates': sum(bool(row['candidate_replies']) for row in in_packets),
            'inbound_with_direct_header_candidate': sum(any(candidate['direct_header_match'] for candidate in row['candidate_replies']) for row in in_packets),
            'current_chars_limit': current_chars, 'current_body_over_limit': sum(len(row['current']) > current_chars for row in logical),
            'quoted_context_limit': quoted_chars, 'quoted_context_over_limit': sum(len(row['quoted']) > quoted_chars for row in logical)}
    return in_packets, out_packets, meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, action='append', required=True, help='normalized private JSONL, repeat oldest to newest')
    parser.add_argument('--mailbox', required=True, help='human-readable mailbox identifier for manifest')
    parser.add_argument('--start', required=True, help='inclusive timezone-aware ISO timestamp')
    parser.add_argument('--end', required=True, help='exclusive timezone-aware ISO timestamp')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--prefer-last-source', action='store_true', help='explicitly resolve conflicting repeated source IDs using the last source')
    parser.add_argument('--current-chars', type=int, default=4000)
    parser.add_argument('--quoted-chars', type=int, default=2000)
    args = parser.parse_args()
    try:
        start, end = parse_time(args.start), parse_time(args.end)
        if start >= end or not 1000 <= args.current_chars <= 8000 or not 500 <= args.quoted_chars <= 8000:
            raise ValueError('invalid_limits')
        root = PRIVATE_ROOT.resolve(strict=True)
        inputs = [path.resolve(strict=True) for path in args.input]
        if any(not path.is_relative_to(root) or not path.is_file() or path.stat().st_mode & 0o077 for path in inputs):
            raise ValueError('input_not_private_file')
        outdir = args.output_dir.absolute()
        if not outdir.parent.resolve(strict=True).is_relative_to(root) or outdir.exists() or outdir.is_symlink():
            raise ValueError('output_dir_unsafe_or_exists')
        rows, duplicates = read_source(inputs, start, end, args.prefer_last_source)
        incoming, outgoing, meta = build(rows, args.current_chars, args.quoted_chars)
        meta.update(duplicates)
        meta.update({'mailbox': args.mailbox, 'start': args.start, 'end_exclusive': args.end,
                     'source_fingerprints': {str(i + 1): hashlib.sha256(path.read_bytes()).hexdigest() for i, path in enumerate(inputs)}})
        outdir.mkdir(mode=0o700)
        cleaning.private_write(outdir / 'inbound.jsonl', incoming)
        cleaning.private_write(outdir / 'outbound.jsonl', outgoing)
        cleaning.private_write(outdir / 'manifest.jsonl', [meta])
        print(json.dumps(meta, sort_keys=True))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        # Avoid dumping private message contents or filesystem diagnostics.
        code = str(exc) if isinstance(exc, ValueError) and str(exc).replace('_', '').isalpha() else 'io_or_json_error'
        raise SystemExit(code) from None


if __name__ == '__main__':
    main()
