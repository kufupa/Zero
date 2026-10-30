#!/usr/bin/env python3
"""Check E1, B02 and QJ-03 source-linked leads without printing private data.

Usage: python3 -I -B verify-case-leads.py PRIVATE_REVIEW_DIR PRIVATE_DATA_DIR [PRIVATE_PDF_DIR]
A zero candidate count describes only the stated search, not all possible links.
"""
import datetime
import email.utils
import hashlib
import html
import json
import pathlib
import re
import sys


def read_jsonl(path):
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def addresses(values):
    return {address.casefold() for _, address in email.utils.getaddresses(values or []) if address}


def normalized(values):
    return {value.strip().lower() for value in values or []}


def recipients(message):
    return addresses(message.get('to', []) + message.get('cc', []) + message.get('bcc', []))


def pdf_recipients(pdf):
    parent = pdf['originalAttachmentRecord']['parentMessage']
    return addresses(parent.get('toAddresses', []) + parent.get('ccAddresses', []) + parent.get('bccAddresses', []))


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit('usage: verify-case-leads.py PRIVATE_REVIEW_DIR PRIVATE_DATA_DIR [PRIVATE_PDF_DIR]')
    review, data = map(pathlib.Path, sys.argv[1:3])
    pdf_dir = pathlib.Path(sys.argv[3]) if len(sys.argv) == 4 else None
    threads = read_jsonl(data / 'mailbox-threads.jsonl')
    pdfs = read_jsonl(data / 'pdf-records.jsonl')
    all_rows = [(thread, message, row) for thread in threads for message in thread['messages']
                for row in message['sourceRows']]
    by_id = {row['sourceRowId']: (thread, message, row) for thread, message, row in all_rows}

    pointers = json.loads((review / 'prior-agent-leads-pointers.json').read_text())
    b03 = json.loads((review / 'B03-review-private.json').read_text())
    thread = threads[pointers['thread_record']['line'] - 1]
    assert len(thread['messages']) == 6
    rows = [message['sourceRows'][0] for message in thread['messages']]
    inbound, reply, forward = rows[0], rows[1], rows[3]
    assert [row['privateMessage']['direction'] for row in (inbound, reply, forward)] == ['inbound', 'outbound', 'outbound']
    assert reply['sourceRowId'] not in {pdf['parentEmailSourceRowId'] for pdf in pdfs}
    timestamps = [datetime.datetime.fromisoformat(message['timestamp'].replace('Z', '+00:00'))
                  for message in thread['messages']]
    gaps = [round((timestamps[end] - timestamps[start]).total_seconds() / 60)
            for start, end in ((0, 1), (1, 3), (0, 3))]
    assert gaps == [66, 1433, 1499]
    outbound_domains = {address.split('@', 1)[1] for _, _, row in all_rows
                        if row['privateMessage']['direction'] == 'outbound'
                        for address in addresses(row['privateMessage']['addresses'].get('from'))
                        if address.count('@') == 1}
    assert len(outbound_domains) == 1
    internal = next(iter(outbound_domains))
    def external(row):
        fields = row['privateMessage']['addresses']
        return {address for address in addresses(fields.get('from', []) + fields.get('to', []) + fields.get('cc', []))
                if address.count('@') == 1 and address.split('@', 1)[1] != internal}
    assert external(inbound) & external(reply)
    assert not external(forward)
    assert not (external(inbound) & external(forward)) and not (external(reply) & external(forward))
    assert forward['sourceRowId'] == pointers['pdf_record']['parent_email_source_row_id']
    assert forward['sourceRowId'] == b03['selection']['parent_source_row_id']
    headers = lambda row: row['privateMessage'].get('canonicalHeaders') or {}
    inbound_ids = normalized(headers(inbound).get('Message-ID'))
    reply_ids = normalized(headers(reply).get('Message-ID'))
    refs = normalized(headers(forward).get('In-Reply-To')) | normalized(headers(forward).get('References'))
    assert inbound_ids & normalized(headers(reply).get('In-Reply-To'))
    assert inbound_ids & refs and not (reply_ids & refs)
    sender = addresses(inbound['privateMessage']['addresses'].get('from'))
    assert sender & recipients(reply['privateMessage']['addresses'])
    selected = [pdf for pdf in pdfs if pdf['parentEmailSourceRowId'] == forward['sourceRowId']]
    assert len(selected) == 1
    assert selected[0]['sourcePdfSha256'] == pointers['pdf_record']['source_pdf_sha256']
    original = [pdf for pdf in pdfs if pdf['sourcePdfSha256'] == selected[0]['sourcePdfSha256']
                and pdf['parentEmailSourceRowId'] != forward['sourceRowId'] and sender & pdf_recipients(pdf)]
    assert original
    for pdf in (selected[0], original[0]):
        recorded_path = pathlib.Path(pdf['sourcePdfPath'])
        path = pdf_dir / recorded_path.name if pdf_dir is not None else recorded_path
        assert hashlib.sha256(path.read_bytes()).hexdigest() == pdf['sourcePdfSha256']

    qj = (review / 'quote-journeys-20261030-private.txt').read_text()
    block = re.split(r'(?m)^QJ-03$', qj)[1]
    ids = re.findall(r'(?m)^\s*\d{4}-\d\d-\d\dT[^ ]+ \| (?:inbound|outbound) \| ([a-f0-9-]{36})$', block)
    assert ids
    quote_thread, _, quote_request = by_id[ids[0]]
    quote_sender = addresses(quote_request['privateMessage']['addresses'].get('from'))
    assert quote_sender
    same_thread_pdfs = sum(pdf['parentEmailThreadId'] == quote_thread['threadId'] for pdf in pdfs)
    same_sender_pdf_parents = sum(bool(quote_sender & pdf_recipients(pdf)) for pdf in pdfs)

    b02 = json.loads((review / 'B02-review-private.json').read_text())
    surname = next(field['value'].strip() for field in b02['hmsRecordFieldsLaterSnapshot']
                   if field['label'] == 'Last Name:' and field.get('value'))
    name_pattern = re.compile(r'(?<!\w)' + re.escape(surname) + r'(?!\w)', re.I)
    inbound_matches = [message for message in b02['messages'] if message['direction'] == 'inbound'
                       and 'same_recipient_prior_inbound' in message['reason']
                       and name_pattern.search((message.get('subject') or '') + ' ' + message['body'])]
    assert inbound_matches
    request = min(inbound_matches, key=lambda message: message['timestamp'])
    contact = addresses(request['addresses'].get('from'))
    assert contact
    outbounds = []
    for _, _, row in all_rows:
        saved = row['privateMessage']
        body = row.get('body') or ''
        if saved['direction'] != 'outbound' or not (recipients(saved['addresses']) & contact):
            continue
        if not name_pattern.search((saved.get('subject') or '') + ' ' + body):
            continue
        plain = html.unescape(re.sub(r'<[^>]*>', ' ', body))
        outbounds.append({'booked': bool(re.search(r'\bbooked\b', plain, re.I)),
                          'confirmation': bool(re.search(r'\bconfirmation\b', plain, re.I))})
    print(json.dumps({
        'E1': {'sequence_headers_gaps_and_participants_verified': True,
               'same_original_and_forward_pdf_hash_verified': True},
        'QJ03': {'selected_pdf_records': len(pdfs), 'same_thread_pdf_records': same_thread_pdfs,
                 'same_requester_recipient_pdf_records': same_sender_pdf_parents},
        'B02': {'outbound_rows_to_requester_containing_guest_surname': len(outbounds),
                'rows_containing_word_booked': sum(row['booked'] for row in outbounds),
                'rows_containing_word_confirmation': sum(row['confirmation'] for row in outbounds)},
    }, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
