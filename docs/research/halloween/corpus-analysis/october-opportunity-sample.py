#!/usr/bin/env python3
"""Prepare a small Centurion email sample and candidate replies for Haiku.

Input: the saved Halloween corpus.jsonl and outbound confirmation attachments.
Output: owner-only JSON in .private; no live mailbox or HMS actions.
"""

import argparse
import datetime as dt
import email.utils
import hashlib
import html
import importlib.util
import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / '.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/corpus.jsonl'
PDFS = ROOT / '.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/attachments.jsonl'
SEED = 'centurion-october-opportunity-20261101'
STRIP_INVISIBLE = False


def addresses(values):
    if isinstance(values, str):
        values = [values]
    return {address.casefold() for _, address in email.utils.getaddresses(values or []) if '@' in address}


def at(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


def visible_text_function():
    p = Path(__file__).with_name('pilot-250-prepare.py')
    spec = importlib.util.spec_from_file_location('pilot250_prepare', p)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._visible_text


VISIBLE = visible_text_function()


def clean(body, limit=2400):
    text = VISIBLE(body)[0] if isinstance(body, str) else ''
    if re.search(r'(?i)\b(?:otp|one[ -]time password|verification code|security code)\b', text):
        text = re.sub(r'(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$',
                      '[verification code removed]', text)
        text = re.sub(r'(?i)\b(otp|passcode|password|pin|verification code|security code)'
                      r'(\s*(?:is|:|=)\s*)(?=[a-z0-9-]*\d)[a-z0-9-]{4,12}',
                      r'\1\2[removed]', text)
    if STRIP_INVISIBLE:
        text = ''.join(char for char in text if unicodedata.category(char) != 'Cf')
        text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
        text = re.sub(r'[ \t]{2,}', ' ', text)
    text = html.unescape(text)
    text = re.sub(r'https?://\S+', '[link]', text, flags=re.I)
    text = re.sub(r'(?i)\b(password|passcode|pin)\s*[:=]\s*\S+', r'\1: [removed]', text)
    text = re.sub(r'(?im)^\s*\[inline image[^\]]*\]\s*$', '', text)
    text = re.sub(r'(?m)^[ \t]+$', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text[:limit]


def current_text(body, limit=1100):
    text = clean(body, 16000)
    # The latest body is usually followed by Outlook's quoted From/Sent block.
    # Preserve a short piece of earlier context in the inbound packet, but
    # remove it from outbound candidate bodies to avoid repetition.
    parts = re.split(r'(?im)^\s*(?=From:\s*[^\n]+\n\s*Sent:|On .{5,120} wrote:)', text, maxsplit=1)
    return parts[0][:limit].strip(), (parts[1][:900].strip() if len(parts) > 1 else '')


def key(row):
    return hashlib.sha256((SEED + '\0' + row['id']).encode()).hexdigest()


def main():
    global STRIP_INVISIBLE
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--strip-invisible', action='store_true')
    args = parser.parse_args()
    STRIP_INVISIBLE = args.strip_invisible
    pdf_parents = set()
    for line in PDFS.open():
        record = json.loads(line)
        if re.fullmatch(r'HRCEN_Confirmation_Letter_.*\.pdf', str((record.get('attachment') or {}).get('filename') or '')):
            pdf_parents.add((record.get('parentMessage') or {}).get('messageDbId'))

    inbound, outbound = [], []
    with SOURCE.open() as source:
        for line in source:
            thread = json.loads(line)
            if thread.get('recordType') != 'thread':
                continue
            for message in thread.get('messages', []):
                for row in message.get('sourceRows', []):
                    private = row.get('privateMessage') or {}
                    if 'active_transport' not in (row.get('scopeMembership') or []):
                        continue
                    if (private.get('sourceMetadata') or {}).get('transportId') != 'transport-centurion':
                        continue
                    when = at(message.get('timestamp'))
                    if when is None:
                        continue
                    addr = private.get('addresses') or {}
                    item = {
                        'id': row.get('sourceRowId'), 'thread': thread.get('threadId'),
                        'when': when, 'subject': private.get('subject') or '',
                        'body': row.get('body') or '',
                        'from': sorted(addresses(addr.get('from'))),
                        'to': sorted(addresses((addr.get('to') or []) + (addr.get('cc') or []))),
                        'pdf': row.get('sourceRowId') in pdf_parents,
                    }
                    if private.get('direction') == 'outbound':
                        outbound.append(item)
                    elif private.get('direction') == 'inbound' and '2026-10-01' <= when.date().isoformat() <= '2026-10-31':
                        inbound.append(item)

    ordered = sorted(inbound, key=key)
    chosen = [(x, 'random') for x in ordered[:50]]
    selected = {x['id'] for x, _ in chosen}
    strata = [
        ('invoice', r'\binvoice\b|\bpro[ -]?forma\b', 3),
        ('documents', r'proof of payment|\bvoucher\b|\bPOP\b', 3),
        ('cancellation', r'\bcancel(?:lation|led|ed)?\b', 2),
        ('amendment', r'\bamend(?:ment|ed)?\b|\bchange\b', 2),
        ('booking', r'\bbook(?:ing)?\b|\breservation\b', 2),
    ]
    for label, pattern, count in strata:
        added = 0
        for item in ordered:
            if item['id'] in selected:
                continue
            first, _ = current_text(item['body'])
            if re.search(pattern, item['subject'] + '\n' + first, re.I):
                selected.add(item['id'])
                chosen.append((item, 'targeted_' + label))
                added += 1
                if added == count:
                    break

    packets = []
    for index, (item, cohort) in enumerate(chosen, 1):
        first, quoted = current_text(item['body'])
        candidates = []
        for out in outbound:
            delta = (out['when'] - item['when']).total_seconds() / 60
            same_thread = out['thread'] == item['thread']
            same_address = bool(set(item['from']) & set(out['to']))
            # Near-address links include a 20-minute clock skew and 72 hours
            # forward for weekends; same-thread links allow seven days.
            if not ((same_thread and -20 <= delta <= 7 * 24 * 60) or
                    (same_address and -20 <= delta <= 72 * 60)):
                continue
            rank = (0 if same_thread else 1, abs(delta), 0 if out['pdf'] else 1)
            candidates.append((rank, out, delta, same_thread))
        candidates.sort(key=lambda value: value[0])
        replies = []
        for reply_index, (_, out, delta, same_thread) in enumerate(candidates[:3], 1):
            reply_body, _ = current_text(out['body'], 1000)
            replies.append({
                'reply_id': f'R{reply_index}', 'same_thread': same_thread,
                'minutes_after_inbound': round(delta), 'from': out['from'], 'to': out['to'],
                'subject': out['subject'], 'body': reply_body,
                'confirmation_pdf_filename': out['pdf'],
            })
        packets.append({
            'case': f'C{index:02d}', 'cohort': cohort, 'source_row_id': item['id'],
            'inbound': {'date': item['when'].isoformat(), 'from': item['from'],
                        'subject': item['subject'], 'message': first,
                        'quoted_context': quoted},
            'candidate_replies': replies,
        })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as output:
        json.dump({'seed': SEED, 'strip_invisible': STRIP_INVISIBLE,
                   'frame_inbound': len(inbound), 'sample': packets},
                  output, ensure_ascii=False, indent=2)
    print(json.dumps({'frame_inbound': len(inbound), 'random': 50,
                      'targeted': len(packets) - 50,
                      'cases_with_reply_candidates': sum(bool(p['candidate_replies']) for p in packets),
                      'packet_bytes': args.output.stat().st_size}))


if __name__ == '__main__':
    main()
