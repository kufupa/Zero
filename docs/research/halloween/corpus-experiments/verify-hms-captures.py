#!/usr/bin/env python3
"""Verify selected PDF identities against already-saved later HMS captures.

Usage: python3 -I -B verify-hms-captures.py PDF_RECORDS_JSONL HMS_CAPTURE_JSON
Prints aggregate counts only. Captures are later observations, not historical
HMS state, current deployment proof, or evidence that a quote was correct.
"""
import collections
import json
import pathlib
import sys


def norm(value):
    return str(value or '').strip().casefold()


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: verify-hms-captures.py PDF_RECORDS_JSONL HMS_CAPTURE_JSON')
    pdf_path, capture_path = map(pathlib.Path, sys.argv[1:])
    with pdf_path.open(encoding='utf-8') as source:
        pdfs = [json.loads(line) for line in source if line.strip()]
    capture = json.loads(capture_path.read_text(encoding='utf-8'))
    by_token = collections.defaultdict(list)
    for item in capture['results']:
        if item.get('ok'):
            by_token[norm(item.get('confirmation'))].append(item)
    matched, missing, sections = [], 0, collections.Counter()
    for pdf in pdfs:
        token = norm(pdf['confirmationIdEvidence']['filenameToken'])
        found = [item for item in by_token[token]
                 if pdf['attachmentId'] in item.get('sourcePdfEvidence', {}).get('pdfAttachmentIds', [])]
        if not found:
            missing += 1
            continue
        item = found[0]
        matched.append((token, item))
        stay = item.get('stay360', {}).get('details', {})
        record = item.get('recordView', {}).get('details', {})
        guest = item.get('guestDetails', {}).get('details', {})
        sections['stay360_header_matches'] += norm(stay.get('confirmationInHeader')) == token
        sections['record_view_header_matches'] += norm(record.get('confirmationInRecord')) == token
        sections['guest_details_fields_nonempty'] += bool(guest.get('fields'))
    unique_matches = {token: item for token, item in matched}
    fields = collections.Counter()
    for item in unique_matches.values():
        rv = item.get('recordView', {}).get('details', {}).get('fields', [])
        for field in rv:
            if field.get('label') == 'Source Of Business:' and norm(field.get('value')) == 'e-mail':
                fields['source_of_business_e_mail'] += 1
            if field.get('label') == 'CMS Booker Email:' and str(field.get('value') or '').strip():
                fields['cms_booker_email_populated'] += 1
    print(json.dumps({
        'historical_capture_started_at': capture.get('startedAt'),
        'historical_capture_updated_at': capture.get('updatedAt'),
        'all_capture_results': len(capture['results']),
        'all_capture_successes': sum(bool(item.get('ok')) for item in capture['results']),
        'selected_pdf_records': len(pdfs),
        'matched_selected_pdf_records': len(matched),
        'missing_selected_pdf_records': missing,
        'distinct_matched_confirmation_tokens': len(unique_matches),
        'matched_record_sections': dict(sections),
        'unique_matched_field_counts': dict(fields),
    }, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
