#!/usr/bin/env python3
"""Select bounded private request-first packets; print aggregate counts only.

Usage: python3 -I -B month-sample-select.py SOURCE_JSONL NEW_PRIVATE_DIR
Input/outcome packets contain guest information and must never be committed.
"""
import collections
import datetime as dt
import email.utils
import hashlib
import html
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path('.private').resolve(strict=True)
START, END = '2026-09-28', '2026-10-23'
SEED = 'nava-month-request-sample-v1'
BLOCKS = (('2026-09-28', '2026-10-04'), ('2026-10-05', '2026-10-11'),
          ('2026-10-12', '2026-10-18'), ('2026-10-19', '2026-10-23'))
WORDS = re.compile(r'\b(?:quot(?:e|es|ation|ations)|rates?|tariffs?|availability|available|'
                   r'pric(?:e|es|ing)|costs?|corporate|overnight|stay|stays|rooms?|'
                   r'accommodat(?:ion|e)|beds?|breakfast|lodging|inquir(?:y|ies|e)|'
                   r'enquir(?:y|ies|e)|book(?:ing|ings)|devis|tarifs?|chambres?|'
                   r'disponibilit\w*|kamers?|tariewe|beskikbaarheid)\b', re.I)
SECRET = re.compile(r'\b(?:password|passcode|one[ -]time[ -]code|cvv|cvc|card[ -]number|'
                    r'security[ -]code|payment[ -]result[ -]for[ -]reservation|'
                    r'order[ -]confirmation[ -]from)\b', re.I)
URL = re.compile(r'https?://[^\s<>"\']+', re.I)
EMAIL = re.compile(r'(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')
LONG_NUMBER = re.compile(r'(?<!\d)(?:\d[ -]?){7,19}(?!\d)')
TAG = re.compile(r'<[^>]+>')
MAX_TEXT = 14000


def block_for(day):
    return next((i for i, (start, end) in enumerate(BLOCKS) if start <= day <= end), None)


def scoped(message):
    rows = [r for r in message.get('sourceRows', [])
            if 'active_transport' in r.get('scopeMembership', [])
            and r.get('privateMessage', {}).get('sourceMetadata', {}).get('transportId') == 'transport-centurion']
    if rows and len(rows) != len(message.get('sourceRows', [])):
        raise ValueError('mixed_scope_logical_message_requires_review')
    if len(rows) > 1:
        raise ValueError('multiple_source_rows_require_review')
    return rows


def timestamp(value):
    return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))


def safe_text(value, subject=''):
    value = str(value or '')
    if SECRET.search(str(subject or '') + ' ' + value):
        return {'text': '[sensitive content withheld]', 'withheld': True, 'truncated': False}
    value = html.unescape(TAG.sub(' ', value))
    value = URL.sub('[link withheld]', value)
    value = EMAIL.sub('[address withheld]', value)
    value = LONG_NUMBER.sub('[long number withheld]', value)
    truncated = len(value) > MAX_TEXT
    return {'text': value[:MAX_TEXT], 'withheld': False, 'truncated': truncated}


def addresses(values):
    return {v.casefold() for _, v in email.utils.getaddresses(values or []) if v}


def view(message, row):
    private = row.get('privateMessage') or {}
    subject = private.get('subject') or ''
    address = private.get('addresses') or {}
    from_addr = addresses(address.get('from'))
    recipients = addresses((address.get('to') or []) + (address.get('cc') or []) + (address.get('bcc') or []))
    return {'timestamp': message.get('timestamp'), 'direction': private.get('direction'),
            'subject': safe_text(subject), 'body': safe_text(row.get('body'), subject),
            'same_from_and_recipient': bool(from_addr & recipients),
            'no_reply_sender_clue': any(re.search(r'no[-_.]?reply', v, re.I) for v in from_addr),
            'attachment_inventory': 'unknown'}


def write_private(path, records):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: month-sample-select.py SOURCE_JSONL NEW_PRIVATE_DIR')
    source = pathlib.Path(sys.argv[1]).resolve(strict=True)
    out = pathlib.Path(sys.argv[2])
    if not source.is_relative_to(ROOT) or out.parent.resolve(strict=True) != ROOT or out.exists():
        raise SystemExit('source must be private and output must be a new direct child of .private')
    pools = collections.defaultdict(list)
    days, directions = collections.Counter(), collections.Counter()
    threads, source_ids = set(), set()
    first_hash = hashlib.sha256()
    with source.open('rb') as f:
        for line_no, raw in enumerate(f, 1):
            first_hash.update(raw)
            record = json.loads(raw)
            if record.get('recordType') != 'thread':
                continue
            for mi, message in enumerate(record.get('messages', [])):
                day = str(message.get('timestamp') or '')[:10]
                block = block_for(day)
                if block is None:
                    continue
                rows = scoped(message)
                if not rows:
                    continue
                row = rows[0]
                sid = str(row.get('sourceRowId') or '')
                if not sid or sid in source_ids:
                    raise ValueError('missing_or_duplicate_source_row_id')
                source_ids.add(sid)
                threads.add(record.get('threadId'))
                direction = row.get('privateMessage', {}).get('direction') or 'unknown'
                days[day] += 1
                directions[direction] += 1
                if direction != 'inbound':
                    continue
                text = (row.get('privateMessage', {}).get('subject') or '') + '\n' + str(row.get('body') or '')
                stratum = 'candidate' if WORDS.search(html.unescape(TAG.sub(' ', text))) else 'complement'
                rank = hashlib.sha256((SEED + '\0' + sid).encode('utf-8')).hexdigest()
                pools[(block, stratum)].append({'rank': rank, 'line': line_no, 'message_index': mi,
                                                'source_row_id': sid, 'timestamp': message['timestamp']})
    selected = []
    populations = {}
    for block in range(len(BLOCKS)):
        for stratum, limit in (('candidate', 10), ('complement', 5)):
            pool = sorted(pools[(block, stratum)], key=lambda x: (x['rank'], x['timestamp'], x['source_row_id']))
            populations[f'{block + 1}_{stratum}'] = len(pool)
            for item in pool[:limit]:
                item.update({'block': block + 1, 'stratum': stratum})
                selected.append(item)
    for i, item in enumerate(selected, 1):
        item.update({'case': f'M{i:03}', 'lane': 'a' if i % 2 else 'b'})
    by_line = collections.defaultdict(list)
    for item in selected:
        by_line[item['line']].append(item)
    inputs, outcomes = {'a': [], 'b': []}, {'a': [], 'b': []}
    second_hash = hashlib.sha256()
    with source.open('rb') as f:
        for line_no, raw in enumerate(f, 1):
            second_hash.update(raw)
            if line_no not in by_line:
                continue
            thread = json.loads(raw)
            messages = thread.get('messages', [])
            for item in by_line[line_no]:
                msg = messages[item['message_index']]
                row = scoped(msg)[0]
                if row.get('sourceRowId') != item['source_row_id'] or msg.get('timestamp') != item['timestamp']:
                    raise ValueError('selected_row_changed')
                anchor = timestamp(msg['timestamp'])
                prior, later = [], []
                for other in messages:
                    day = str(other.get('timestamp') or '')[:10]
                    if not START <= day <= END:
                        continue
                    rows = scoped(other)
                    if not rows:
                        continue
                    stamp = timestamp(other['timestamp'])
                    if stamp < anchor:
                        prior.append((stamp, view(other, rows[0])))
                    elif stamp > anchor and rows[0].get('privateMessage', {}).get('direction') == 'outbound':
                        later.append((stamp, view(other, rows[0])))
                prior.sort(key=lambda x: x[0]); later.sort(key=lambda x: x[0])
                inputs[item['lane']].append({'case': item['case'], 'block': item['block'],
                    'stratum': item['stratum'], 'private_source': {'corpus_line': line_no,
                    'thread_id': thread.get('threadId'), 'source_row_id': item['source_row_id']},
                    'selected': view(msg, row), 'previous_same_thread': [x[1] for x in prior[-3:]],
                    'previous_omitted': max(0, len(prior) - 3),
                    'context_limit': 'Strictly earlier saved rows within the specified date window only.'})
                outcomes[item['lane']].append({'case': item['case'],
                    'later_same_thread_outbound': [x[1] for x in later[:5]],
                    'later_outbound_omitted': max(0, len(later) - 5),
                    'outcome_limit': 'Strictly later saved outbound rows within the specified date window only.'})
    if first_hash.digest() != second_hash.digest():
        raise ValueError('source_changed_during_selection')
    for lane in ('a', 'b'):
        inputs[lane].sort(key=lambda x: x['case']); outcomes[lane].sort(key=lambda x: x['case'])
        if [x['case'] for x in inputs[lane]] != [x['case'] for x in outcomes[lane]]:
            raise ValueError('selected_packet_count_mismatch')
    os.mkdir(out, 0o700)
    os.chmod(out, 0o700)
    for lane in ('a', 'b'):
        write_private(out / f'input-{lane}.jsonl', inputs[lane])
        write_private(out / f'outcome-{lane}.jsonl', outcomes[lane])
    summary = {'source_sha256': first_hash.hexdigest(), 'seed': SEED, 'date_start': START,
               'date_end': END, 'blocks': BLOCKS, 'logical_messages': sum(days.values()),
               'distinct_threads': len(threads), 'directions': dict(directions),
               'populations_by_block_stratum': populations, 'selected': len(selected),
               'selected_by_block_stratum': dict(collections.Counter(f"{x['block']}_{x['stratum']}" for x in selected)),
               'lane_counts': {lane: len(inputs[lane]) for lane in ('a', 'b')},
               'previous_context_limit': 3, 'later_outbound_limit': 5,
               'attachment_inventory': 'unknown', 'timestamp_timezone': 'unverified'}
    write_private(out / 'manifest.jsonl', [summary])
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
