#!/usr/bin/env python3
"""Select varied, source-linked PDF anchors for human/LLM review, not labels.

Usage: python3 -I -B select-booking-cases.py DATA_DIR NEW_PRIVATE_JSON
The output contains guest identifiers and must stay owner-only and Git-ignored.
"""
import collections
import datetime as dt
import email.utils
import hashlib
import json
import os
import pathlib
import re
import sys


def read_jsonl(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


def address_set(values):
    return {address.casefold() for _, address in email.utils.getaddresses(values or []) if address}


def when(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


def exact_id(text, token):
    return bool(re.search(r'(?<![A-Za-z0-9])' + re.escape(token) + r'(?![A-Za-z0-9]|-[A-Za-z0-9])', text, re.I))


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: select-booking-cases.py DATA_DIR NEW_PRIVATE_JSON')
    base, output = map(pathlib.Path, sys.argv[1:])
    if not output.parent.is_dir() or (output.parent.stat().st_mode & 0o777) != 0o700:
        raise SystemExit('output parent must exist and have mode 0700')
    threads_path, pdfs_path = base / 'mailbox-threads.jsonl', base / 'pdf-records.jsonl'
    threads, pdfs = read_jsonl(threads_path), read_jsonl(pdfs_path)
    rows = []
    for thread in threads:
        for message in thread['messages']:
            for row in message['sourceRows']:
                private = row['privateMessage']
                rows.append({
                    'thread_id': thread['threadId'],
                    'corpus_line': thread['originalCorpusLine'],
                    'source_row_id': row['sourceRowId'],
                    'timestamp': message['timestamp'],
                    'direction': private['direction'],
                    'from': address_set(private['addresses'].get('from')),
                    'text': (private.get('subject') or '') + '\n' + (row.get('body') or ''),
                })
    by_thread = collections.defaultdict(list)
    for row in rows:
        by_thread[row['thread_id']].append(row)
    candidates = []
    for pdf in pdfs:
        token = pdf['confirmationIdEvidence']['filenameToken']
        timestamp = pdf['selectedMessageTimestamp']
        stamp = when(timestamp)
        parent = pdf['originalAttachmentRecord']['parentMessage']
        contacts = address_set(parent.get('toAddresses', []) + parent.get('ccAddresses', []) + parent.get('bccAddresses', []))
        same = [r for r in by_thread[pdf['parentEmailThreadId']] if r['source_row_id'] != pdf['parentEmailSourceRowId']]
        earlier = [r for r in same if stamp and when(r['timestamp']) and when(r['timestamp']) < stamp]
        cross = [r for r in rows if r['thread_id'] != pdf['parentEmailThreadId'] and exact_id(r['text'], token)]
        same_address_inbound = [r for r in rows if r['direction'] == 'inbound' and r['from'] & contacts and stamp and when(r['timestamp']) and when(r['timestamp']) < stamp]
        flags = {
            'same_thread_prior_inbound_rows': sum(r['direction'] == 'inbound' for r in earlier),
            'same_thread_prior_outbound_rows': sum(r['direction'] == 'outbound' for r in earlier),
            'other_thread_exact_id_rows': len(cross),
            'prior_same_recipient_inbound_rows': len(same_address_inbound),
            'prior_same_thread_booking_word': any(bool(re.search(r'\b(booked|confirmed|confirmation)\b', r['text'], re.I)) for r in earlier if r['direction'] == 'outbound'),
        }
        score = (4 * bool(flags['other_thread_exact_id_rows'])
                 + 3 * bool(flags['same_thread_prior_inbound_rows'])
                 + 2 * bool(flags['same_thread_prior_outbound_rows'])
                 + bool(flags['prior_same_recipient_inbound_rows']))
        candidates.append({
            'date': timestamp[:10], 'confirmation': token, 'attachment_id': pdf['attachmentId'],
            'parent_source_row_id': pdf['parentEmailSourceRowId'], 'thread_id': pdf['parentEmailThreadId'],
            'pdf_corpus_line': pdf['parentEmailCorpusLine'], 'timestamp': timestamp,
            'score': score, 'flags': flags,
            'other_thread_id_source_rows': [r['source_row_id'] for r in cross],
            'prior_same_recipient_inbound_source_rows': [r['source_row_id'] for r in same_address_inbound],
        })
    # For each date select one promising anchor and one harder one when possible.
    selected, used = [], set()
    for date in sorted({x['date'] for x in candidates}):
        pool = [x for x in candidates if x['date'] == date and x['confirmation'] not in used]
        if not pool:
            continue
        pool.sort(key=lambda x: (-x['score'], x['timestamp'], x['attachment_id']))
        strongest = pool[0]
        selected.append(strongest)
        used.add(strongest['confirmation'])
        harder = [x for x in pool[1:] if x['confirmation'] not in used and not x['flags']['prior_same_thread_booking_word']]
        if not harder:
            harder = [x for x in pool[1:] if x['confirmation'] not in used]
        if harder:
            chosen = harder[0]
            selected.append(chosen)
            used.add(chosen['confirmation'])
    for index, item in enumerate(selected, 1):
        item['case'] = f'B{index:02d}'
    result = {
        'method': 'Two selected PDF anchors per stored date: strongest structural candidate and a harder candidate without a prior same-thread booking word when available. Signals are candidates, not verified relations.',
        'input_sha256': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in (threads_path, pdfs_path)},
        'source_thread_count': len(threads), 'source_rows': len(rows), 'pdf_records': len(pdfs),
        'cases': selected,
    }
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        json.dump(result, target, indent=2)
        target.write('\n')
    print(json.dumps({'source_threads': len(threads), 'source_rows': len(rows), 'pdf_records': len(pdfs), 'selected_cases': len(selected), 'dates': sorted({x['date'] for x in selected}), 'case_flags': [{'case': x['case'], 'date': x['date'], **x['flags']} for x in selected]}, indent=2))


if __name__ == '__main__':
    main()
