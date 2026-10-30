#!/usr/bin/env python3
"""Write a limited case-review view from an owner-only review packet.

Usage: python3 -I -B review-booking-case.py PRIVATE_PACKET_JSON NEW_PRIVATE_OUTPUT
Output contains guest details; keep it outside Git in an owner-only directory.
"""
import io
import json
import os
import pathlib
import re
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: review-booking-case.py PRIVATE_PACKET_JSON NEW_PRIVATE_OUTPUT')
    os.umask(0o077)
    destination = pathlib.Path(sys.argv[2])
    if destination.parent.stat().st_mode & 0o077:
        raise ValueError('Output directory is not private')
    review = io.StringIO()
    packet = json.loads(pathlib.Path(sys.argv[1]).read_text())
    case = packet['selection']
    fields = packet['hmsRecordFieldsLaterSnapshot']
    keep = {'Created On:', 'Updated On:', 'Arrival Date:', 'Departure Date:', 'Status:',
            'Source Of Business:', 'Rate Plan:', 'Average Rate:', 'Meal Plan:', 'Adults:', 'Children:'}
    print(json.dumps({'case': case['case'], 'stored_pdf_date': case['date'],
                      'selection_flags': case['flags'],
                      'later_hms_fields': [x for x in fields if x.get('label') in keep]}, indent=2), file=review)
    # Review all exact-ID and same-thread evidence. For high-volume same-address
    # candidates, inspect the oldest and three newest first; all are retained in
    # the packet and the original source remains available for deeper inspection.
    messages = packet['messages']
    exact = [m for m in messages if set(m['reason']) & {'parent', 'same_thread', 'other_thread_exact_id'}]
    others = [m for m in messages if m not in exact and 'same_recipient_prior_inbound' in m['reason']]
    sampled_others = others if len(others) <= 4 else others[:1] + others[-3:]
    selected = sorted(exact + sampled_others, key=lambda m: (m['timestamp'], m['sourceRowId']))
    print('same-address candidates sampled:', len(sampled_others), '/', len(others), file=review)
    token = case['confirmation']
    for ordinal, message in enumerate(selected, 1):
        body = message['body']
        if re.search(r'order confirmation from|payment result for reservation', message.get('subject') or '', re.I):
            print(json.dumps({'ordinal': ordinal, 'timestamp': message['timestamp'],
                              'direction': message['direction'], 'reason': message['reason'],
                              'subject': '[payment notification]', 'body_prefix': '[withheld]'}), file=review)
            continue
        # The author text is usually first. A token excerpt is additionally shown
        # if its occurrence falls beyond that prefix, without assuming authorship.
        prefix = body[:900]
        hits = list(re.finditer(r'(?<![A-Za-z0-9])' + re.escape(token) + r'(?![A-Za-z0-9]|-[A-Za-z0-9])', body, re.I))
        excerpts = []
        for hit in hits[:2]:
            if hit.start() >= 900:
                excerpts.append(body[max(0, hit.start()-250):min(len(body), hit.end()+250)])
        print(json.dumps({'ordinal': ordinal, 'timestamp': message['timestamp'],
                          'direction': message['direction'], 'reason': message['reason'],
                          'subject': message['subject'], 'body_prefix': prefix,
                          'body_original_chars': message['bodyOriginalChars'],
                          'confirmation_context_after_prefix': excerpts}, ensure_ascii=False), file=review)
    with destination.open('x') as output:
        output.write(review.getvalue())
    print(json.dumps({'messages_reviewed': len(selected), 'same_address_sampled': len(sampled_others)}))


if __name__ == '__main__':
    main()
