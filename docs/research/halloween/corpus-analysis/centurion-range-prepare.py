#!/usr/bin/env python3
"""Build deduplicated Centurion research packets and candidate reply links.

The old local snapshot is bridged to the verified fresh late-October tail.
This performs retrieval and cleanup only; the LLM makes the classifications.
Outputs, including source mappings, stay in the owner's private directory.
"""

import argparse
import datetime as dt
import email.utils
import hashlib
import importlib.util
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / '.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/corpus.jsonl'
PDFS = ROOT / '.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/attachments.jsonl'
PRIVATE = ROOT / '.private/centurion-opportunity-october-20261101'
TAIL = PRIVATE / 'fresh-tail.json'
BRIDGE = PRIVATE / 'frame-bridge-audit.json'
STOP = {'the', 'and', 'for', 'your', 'with', 'hotel', 'centurion', 'confirmation',
        'letter', 'booking', 'reservation', 'request', 'accommodation', 'invoice',
        'email', 'reply', 'from', 'subject', 'our', 'please', 'guest', 'room'}

spec = importlib.util.spec_from_file_location('october_opportunity_sample', Path(__file__).with_name('october-opportunity-sample.py'))
cleaner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleaner)
cleaner.STRIP_INVISIBLE = True


def parse_time(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (ValueError, TypeError):
        return None


def first(value):
    if isinstance(value, list):
        return str(value[0]) if value else ''
    return str(value or '')


def norm_id(value):
    return first(value).strip().strip('<>').casefold()


def addresses(value):
    return sorted(cleaner.addresses(value))


def mask_card(match):
    digits = [int(char) for char in match.group() if char.isdigit()]
    if not 13 <= len(digits) <= 19:
        return match.group()
    check = 0
    for index, digit in enumerate(reversed(digits)):
        doubled = digit * 2 if index % 2 else digit
        check += doubled - 9 if doubled > 9 else doubled
    return '[card number removed]' if check % 10 == 0 else match.group()


def scrub(value, context=''):
    text = str(value or '')
    text = re.sub(r'(?i)\b(authori[sz]ation\s+code|card\s+(?:number|no)|card\s+expiry|'
                  r'expir(?:y|ation)\s+date|cvv|cvc|account\s+(?:number|no)|iban)'
                  r'\s*[:=]\s*[^\s]+', r'\1: [removed]', text)
    text = re.sub(r'(?<!\d)(?:\d[ -]?){13,19}(?!\d)', mask_card, text)
    text = re.sub(r'(?i)\b(otp|passcode|password|pin|api[ _-]?key|verification code|security code)'
                  r'(\s*(?:is|:|=|-)\s*)(?=[a-z0-9-]*\d)[a-z0-9-]{4,32}', r'\1\2[removed]', text)
    if re.search(r'(?i)\b(?:otp|one[ -]time password|verification code|security code)\b', context + ' ' + text):
        text = re.sub(r'(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$',
                      '[verification code removed]', text)
    text = re.sub(r'(?i)\b(?:password|passcode|one[ -]?time code|otp|pin|cvv|cvc|security code|card number)\b'
                  r'[^\n]{0,40}\b\d{3,19}\b|\b\d{3,19}\b[^\n]{0,40}'
                  r'\b(?:password|passcode|one[ -]?time code|otp|pin|cvv|cvc|security code|card number)\b',
                  '[sensitive detail removed]', text)
    text = re.sub(r'(?im)^\s*\[cid:[^\]]+\]\s*$', '', text)
    text = re.sub(r'(?im)^\s*\[[^\]\n]{0,180}description automatically generated\]\s*$', '', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def split_body(value, subject):
    text = scrub(cleaner.clean(value, 16000), subject)
    parts = re.split(r'(?im)^(?=[ \t]*(?:From:[^\n]*(?:\n[^\n]*){0,8}\n[ \t]*(?:Sent|Date):|'
                     r'On .{5,120} wrote:|-----Original Message-----))', text, maxsplit=1)
    current = parts[0].strip()
    quoted = parts[1].strip() if len(parts) > 1 else ''
    return current, quoted


def tokens(text):
    return {word for word in re.findall(r'[a-z0-9]{3,}', text.casefold()) if word not in STOP}


def private_write(path, rows):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', default='2026-09-26', choices=['2026-09-26', '2026-09-28'])
    parser.add_argument('--current-chars', type=int, default=4000)
    parser.add_argument('--attachment-observations', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    if not 1000 <= args.current_chars <= 8000:
        parser.error('--current-chars must be between 1000 and 8000')
    start = dt.datetime.fromisoformat(args.start).replace(tzinfo=ZoneInfo('Africa/Johannesburg')).astimezone(dt.timezone.utc)
    end = dt.datetime(2026, 10, 30, 17, tzinfo=ZoneInfo('Africa/Johannesburg')).astimezone(dt.timezone.utc)
    if args.output_dir.exists():
        raise SystemExit('output directory already exists')
    observations = {}
    if args.attachment_observations:
        observations = json.loads(args.attachment_observations.read_text()).get('by_row_id', {})
        if not isinstance(observations, dict) or any(not isinstance(v, str) for v in observations.values()):
            raise SystemExit('invalid attachment observations')
    bridge = json.loads(BRIDGE.read_text())
    expected_differences = {'2026-10-29:inbound', '2026-10-30:inbound', '2026-10-30:outbound'}
    if {x['day_and_direction'] for x in bridge['differences']} != expected_differences:
        raise SystemExit('fresh/local frame comparison differs; investigate before combining')
    pdf_parents = set()
    for line in PDFS.open():
        record = json.loads(line)
        if re.fullmatch(r'HRCEN_Confirmation_Letter_.*\.pdf', str((record.get('attachment') or {}).get('filename') or '')):
            pdf_parents.add((record.get('parentMessage') or {}).get('messageDbId'))

    rows = {}
    for line in SOURCE.open():
        record = json.loads(line)
        if record.get('recordType') != 'thread':
            continue
        for message in record.get('messages', []):
            for row in message.get('sourceRows', []):
                private = row.get('privateMessage') or {}
                if ('active_transport' not in (row.get('scopeMembership') or []) or
                    (private.get('sourceMetadata') or {}).get('transportId') != 'transport-centurion'):
                    continue
                direction = private.get('direction')
                delivery = private.get('outboundDelivery') or {}
                preferred = (private.get('sentAt') if direction == 'outbound' and delivery.get('queueState') == 'sent'
                             else row.get('receivedAt'))
                when = parse_time(preferred or private.get('sentAt') or message.get('timestamp'))
                if when is None or not start <= when < end:
                    continue
                header, addr = private.get('canonicalHeaders') or {}, private.get('addresses') or {}
                rows[row['sourceRowId']] = {'id': row['sourceRowId'], 'thread': row.get('threadId') or record.get('threadId'),
                    'when': when, 'direction': direction, 'message_id': first(header.get('Message-ID')),
                    'in_reply_to': first(header.get('In-Reply-To')), 'references': header.get('References') or [],
                    'subject': private.get('subject') or '', 'body': row.get('body') or '',
                    'from': addresses(addr.get('from')), 'to': addresses((addr.get('to') or []) + (addr.get('cc') or [])),
                    'pdf': True if row['sourceRowId'] in pdf_parents else None}

    tail = json.loads(TAIL.read_text())
    if tail.get('snapshot') != 'centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711':
        raise SystemExit('wrong tail snapshot')
    for row in tail['records']:
        when = parse_time(row.get('when'))
        if when is None or not start <= when < end:
            continue
        rows[row['id']] = {**row, 'when': when, 'from': addresses(row.get('from')),
                           'to': addresses((row.get('to') or []) + (row.get('cc') or [])),
                           'pdf': True if row['id'] in pdf_parents else None}
    raw_counts = Counter(row['direction'] for row in rows.values())
    expected = {'2026-09-26': {'inbound': 4719, 'outbound': 2099},
                '2026-09-28': {'inbound': 4653, 'outbound': 2093}}[args.start]
    if dict(raw_counts) != expected:
        raise SystemExit(f'frame count mismatch: {dict(raw_counts)} vs {expected}')

    groups = defaultdict(list)
    for row in rows.values():
        mid = norm_id(row.get('message_id'))
        sender = tuple(row.get('from') or [])
        subject = str(row.get('subject') or '').strip().casefold()
        key = (row['direction'], mid, sender, subject) if mid and sender else (row['direction'], 'row:' + row['id'])
        row['current'], row['quoted'] = split_body(row.get('body'), row.get('subject'))
        groups[key].append(row)

    logical = []
    for group in groups.values():
        # Some MIME-backed copies have empty parsed bodies. Keep the richest
        # current message while preserving every source ID and thread for links.
        best = max(group, key=lambda x: (len(x['current']), len(x['quoted'])))
        item = dict(best)
        item['when'] = min(x['when'] for x in group)
        item['ids'] = sorted(x['id'] for x in group)
        item['threads'] = sorted({x['thread'] for x in group if x.get('thread')})
        item['pdf'] = True if any(x['pdf'] is True for x in group) else None
        item['subject'] = scrub(item['subject'])[:300]
        logical.append(item)
    logical.sort(key=lambda x: (x['when'], x['ids'][0]))
    inbound = [x for x in logical if x['direction'] == 'inbound']
    outbound = [x for x in logical if x['direction'] == 'outbound']
    for i, item in enumerate(inbound, 1): item['case'] = f'I{i:05d}'
    for i, item in enumerate(outbound, 1): item['case'] = f'O{i:05d}'

    out_by_thread, out_by_recipient, out_by_reply = defaultdict(list), defaultdict(list), defaultdict(list)
    in_by_thread, in_by_sender, in_by_mid = defaultdict(list), defaultdict(list), defaultdict(list)
    for item in outbound:
        for thread in item['threads']: out_by_thread[thread].append(item)
        for address in item['to']: out_by_recipient[address].append(item)
        if norm_id(item.get('in_reply_to')): out_by_reply[norm_id(item['in_reply_to'])].append(item)
    for item in inbound:
        for thread in item['threads']: in_by_thread[thread].append(item)
        for address in item['from']: in_by_sender[address].append(item)
        if norm_id(item.get('message_id')): in_by_mid[norm_id(item['message_id'])].append(item)

    def candidate_inbound(item):
        found = {}
        for mid in [norm_id(item.get('in_reply_to'))]:
            for other in in_by_mid.get(mid, []): found[other['case']] = other
        for thread in item['threads']:
            for other in in_by_thread[thread]: found[other['case']] = other
        for address in item['to']:
            for other in in_by_sender[address]: found[other['case']] = other
        selected = []
        for other in found.values():
            delta = (item['when'] - other['when']).total_seconds() / 60
            if delta < 0: continue
            direct = bool(norm_id(item.get('in_reply_to'))) and norm_id(item['in_reply_to']) == norm_id(other.get('message_id'))
            same = bool(set(item['threads']) & set(other['threads']))
            if not (direct or (same and delta <= 7 * 1440) or (set(item['to']) & set(other['from']) and delta <= 72 * 60)): continue
            overlap = len(tokens(item['subject']) & tokens(other['subject'] + ' ' + other['current'][:1000]))
            selected.append(((0 if direct else 1 if same else 2, -overlap, delta), other, delta, direct, same))
        selected.sort(key=lambda value: value[0])
        return [{'request_id': f'Q{i}', 'inbound_case': other['case'], 'direct_header_match': direct, 'same_thread': same,
                 'minutes_before_outbound': round(delta), 'from': other['from'], 'subject': other['subject'],
                 'body': other['current'][:700]}
                for i, (_, other, delta, direct, same) in enumerate(selected[:3], 1)]

    def candidate_outbound(item):
        found = {}
        mid = norm_id(item.get('message_id'))
        for other in out_by_reply.get(mid, []): found[other['case']] = other
        for thread in item['threads']:
            for other in out_by_thread[thread]: found[other['case']] = other
        for address in item['from']:
            for other in out_by_recipient[address]: found[other['case']] = other
        selected = []
        for other in found.values():
            delta = (other['when'] - item['when']).total_seconds() / 60
            if delta < 0: continue
            direct = bool(mid) and norm_id(other.get('in_reply_to')) == mid
            same = bool(set(item['threads']) & set(other['threads']))
            if not (direct or (same and delta <= 7 * 1440) or (set(item['from']) & set(other['to']) and delta <= 72 * 60)): continue
            overlap = len(tokens(other['subject']) & tokens(item['subject'] + ' ' + item['current'][:1000]))
            selected.append(((0 if direct else 1 if same else 2, -overlap, delta), other, delta, direct, same))
        selected.sort(key=lambda value: value[0])
        # Keep one cross-thread candidate in addition to the best direct/thread links.
        chosen = selected[:5]
        cross = next((v for v in selected if not v[4]), None)
        if cross and cross not in chosen and len(chosen) == 5: chosen[-1] = cross
        return [{'reply_id': f'R{i}', 'outbound_case': other['case'], 'direct_header_match': direct, 'same_thread': same,
                 'minutes_after_inbound': round(delta), 'from': other['from'], 'to': other['to'],
                 'subject': other['subject'], 'body': other['current'][:800],
                 'confirmation_pdf_filename': other['pdf']}
                for i, (_, other, delta, direct, same) in enumerate(chosen, 1)]

    inbound_packets = [{'case': x['case'], '_source': {'row_ids': x['ids'], 'current_chars': len(x['current']), 'quoted_chars': len(x['quoted'])},
        'inbound': {'date': x['when'].isoformat(), 'from': x['from'], 'subject': x['subject'],
                    'message': x['current'][:args.current_chars], 'quoted_context': x['quoted'][:2000]},
        'candidate_replies': candidate_outbound(x)} for x in inbound]
    for packet in inbound_packets:
        details = [observations[row_id] for row_id in packet['_source']['row_ids'] if row_id in observations]
        if details:
            packet['inbound']['attachment_context'] = scrub('\n'.join(dict.fromkeys(details)))[:4000]
    outbound_packets = [{'case': x['case'], '_source': {'row_ids': x['ids'], 'current_chars': len(x['current']), 'quoted_chars': len(x['quoted'])},
        'outbound': {'date': x['when'].isoformat(), 'from': x['from'], 'to': x['to'], 'subject': x['subject'],
                     'message': x['current'][:args.current_chars], 'quoted_context': x['quoted'][:2000]},
        'candidate_inbounds': candidate_inbound(x)} for x in outbound]
    args.output_dir.mkdir(mode=0o700, parents=True)
    private_write(args.output_dir / 'inbound.jsonl', inbound_packets)
    private_write(args.output_dir / 'outbound.jsonl', outbound_packets)
    meta = {'start_south_africa': args.start + ' 00:00', 'end_south_africa_exclusive': '2026-10-30 17:00',
            'raw': dict(raw_counts), 'deduplicated': {'inbound': len(inbound), 'outbound': len(outbound)},
            'duplicate_groups': sum(len(v) > 1 for v in groups.values()),
            'inbound_with_candidates': sum(bool(x['candidate_replies']) for x in inbound_packets),
            'inbound_with_direct_header_candidate': sum(any(y['direct_header_match'] for y in x['candidate_replies']) for x in inbound_packets),
            'current_chars_limit': args.current_chars,
            'current_body_over_limit': sum(len(x['current']) > args.current_chars for x in logical),
            'quoted_context_limit': 2000,
            'quoted_context_over_limit': sum(len(x['quoted']) > 2000 for x in logical),
            'inbound_with_attachment_observations': sum('attachment_context' in x['inbound'] for x in inbound_packets),
            'source_fingerprints': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [
                SOURCE, TAIL, BRIDGE, Path(__file__), Path(cleaner.__file__),
                Path(__file__).with_name('pilot-250-prepare.py')]}}
    if args.attachment_observations:
        meta['source_fingerprints'][args.attachment_observations.name] = hashlib.sha256(args.attachment_observations.read_bytes()).hexdigest()
    private_write(args.output_dir / 'manifest.jsonl', [meta])
    print(json.dumps(meta))


if __name__ == '__main__':
    main()
