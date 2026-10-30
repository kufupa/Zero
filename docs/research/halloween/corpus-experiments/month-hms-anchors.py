#!/usr/bin/env python3
"""Build private in-window PDF anchors for the existing saved-HMS verifier.

Usage: python3 -I -B month-hms-anchors.py CORPUS_JSONL ATTACHMENTS_JSONL NEW_PRIVATE_DIR
The output contains private confirmation and attachment identifiers. Never commit it.
"""
import hashlib
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path('.private').resolve(strict=True)
START, END = '2026-09-28', '2026-10-18'
FILENAME = re.compile(r'^HRCEN_Confirmation_Letter_(\d+(?:-[A-Za-z0-9]+)?)\.pdf$')


def main():
    if len(sys.argv) != 4:
        raise SystemExit('usage: month-hms-anchors.py CORPUS_JSONL ATTACHMENTS_JSONL NEW_PRIVATE_DIR')
    corpus, attachments = (pathlib.Path(x).resolve(strict=True) for x in sys.argv[1:3])
    out = pathlib.Path(sys.argv[3])
    if not corpus.is_relative_to(ROOT) or not attachments.is_relative_to(ROOT):
        raise SystemExit('source files must be under .private')
    if out.parent.resolve(strict=True) != ROOT or out.exists():
        raise SystemExit('output must be a new direct child of .private')
    selected, fingerprint = {}, hashlib.sha256()
    with corpus.open('rb') as f:
        for line in f:
            fingerprint.update(line)
            thread = json.loads(line)
            if thread.get('recordType') != 'thread':
                continue
            for message in thread.get('messages', []):
                day = str(message.get('timestamp') or '')[:10]
                if not START <= day <= END:
                    continue
                rows = [r for r in message.get('sourceRows', [])
                        if 'active_transport' in r.get('scopeMembership', [])
                        and r.get('privateMessage', {}).get('sourceMetadata', {}).get('transportId') == 'transport-centurion']
                if rows and (len(rows) != 1 or len(rows) != len(message.get('sourceRows', []))):
                    raise ValueError('mixed_or_multiple_source_rows')
                for row in rows:
                    sid = str(row.get('sourceRowId') or '')
                    if not sid or sid in selected:
                        raise ValueError('missing_or_duplicate_source_row')
                    selected[sid] = day
    anchors, seen, date_disagreements, absent_token = [], set(), 0, 0
    with attachments.open(encoding='utf-8') as f:
        for line in f:
            row = json.loads(line)
            parent, attachment = row.get('parentMessage', {}), row.get('attachment', {})
            parent_id = str(parent.get('messageDbId') or '')
            if parent_id not in selected:
                continue
            aid = str(attachment.get('attachmentId') or '')
            if not aid or aid in seen:
                raise ValueError('missing_or_duplicate_attachment_id')
            seen.add(aid)
            date_disagreements += str(parent.get('sentAt') or '')[:10] != selected[parent_id]
            match = FILENAME.fullmatch(str(attachment.get('filename') or ''))
            token = match.group(1).upper() if match else None
            absent_token += token is None
            anchors.append({'attachmentId': aid, 'confirmationIdEvidence': {'filenameToken': token}})
    if date_disagreements:
        raise ValueError('selected_message_and_pdf_parent_dates_disagree')
    os.mkdir(out, 0o700)
    os.chmod(out, 0o700)
    fd = os.open(out / 'pdf-anchors.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for anchor in anchors:
            f.write(json.dumps(anchor, separators=(',', ':')) + '\n')
    print(json.dumps({'date_start': START, 'date_end': END, 'scoped_messages': len(selected),
                      'selected_pdf_records': len(anchors), 'missing_filename_token': absent_token,
                      'parent_date_disagreements': date_disagreements,
                      'corpus_sha256': fingerprint.hexdigest()}, sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
