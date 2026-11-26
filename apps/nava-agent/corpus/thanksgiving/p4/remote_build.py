#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import html
import json
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

BODY_CAP = 60000
WINDOW_START = '2026-08-01T00:00:00.000Z'


class TextHTMLParser(HTMLParser):
    BLOCK_TAGS = {
        'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset',
        'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
        'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in ('script', 'style'):
            self.skip_depth += 1
        elif not self.skip_depth and tag in self.BLOCK_TAGS:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in ('script', 'style') and self.skip_depth:
            self.skip_depth -= 1
        elif not self.skip_depth and tag in self.BLOCK_TAGS:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)


def collapse_text(text):
    text = text.replace('\x00', '').replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
    text = re.sub(r'[\t\f\v ]+', ' ', text)
    text = re.sub(r' *\n *', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def strip_html(value):
    parser = TextHTMLParser()
    try:
        parser.feed(value or '')
        parser.close()
        return collapse_text(''.join(parser.parts))
    except Exception:
        return collapse_text(re.sub(r'<[^>]*>', ' ', html.unescape(value or '')))


def plain_body(text_body, html_body):
    if isinstance(text_body, str) and text_body.strip():
        body = collapse_text(text_body)
    elif isinstance(html_body, str) and html_body.strip():
        body = strip_html(html_body)
    else:
        body = ''
    return body[:BODY_CAP]


def json_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def pg_ts(value):
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        elif ' ' in text and 'T' not in text:
            text = text.replace(' ', 'T', 1)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return str(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def references_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ' '.join(str(item) for item in value if item)
    return str(value)


def create_schema(conn):
    conn.executescript('''
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  message_id_header TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  sent_at TEXT,
  received_at TEXT,
  direction TEXT,
  mailbox TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  body_text TEXT,
  cut_reason TEXT
);
CREATE TABLE header_edge (
  src_id TEXT,
  dst_id TEXT,
  kind TEXT
);
CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  s3_key TEXT,
  sha256 TEXT,
  is_inline INTEGER,
  cut_reason TEXT
);
CREATE TABLE doc_text (
  attachment_id TEXT PRIMARY KEY,
  text TEXT,
  source TEXT,
  fetched_at TEXT
);
CREATE TABLE hms_stay (
  confirmation TEXT PRIMARY KEY,
  guest_name TEXT,
  arrival TEXT,
  departure TEXT,
  created_at TEXT,
  created_by TEXT,
  source_of_business TEXT,
  company TEXT,
  travel_agent TEXT,
  email_address TEXT,
  caller TEXT,
  billing_reference TEXT,
  reservation_note TEXT,
  rate_plan TEXT,
  room_type TEXT,
  meal_plan TEXT,
  adults INTEGER,
  children INTEGER,
  status TEXT,
  is_labtest INTEGER,
  cohort_clean INTEGER,
  raw_json TEXT
);
CREATE TABLE p3_key (
  message_id TEXT,
  confirmation TEXT,
  source TEXT
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX attachment_message_idx ON attachment(message_id);
CREATE INDEX attachment_sha256_idx ON attachment(sha256);
CREATE INDEX message_sent_at_idx ON message(sent_at);
CREATE INDEX message_thread_idx ON message(thread_id);
CREATE INDEX header_edge_src_idx ON header_edge(src_id);
CREATE INDEX header_edge_dst_idx ON header_edge(dst_id);
CREATE INDEX p3_key_confirmation_idx ON p3_key(confirmation);
CREATE INDEX p3_key_message_idx ON p3_key(message_id);
''')


def read_jsonl(path):
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    args = parser.parse_args()
    work = Path(args.work)
    started = time.time()
    sqlite_path = work / 'snapshot-part.sqlite'
    gzip_path = work / 'snapshot-part.sqlite.gz'
    for path in (sqlite_path, gzip_path):
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    conn = sqlite3.connect(sqlite_path)
    conn.execute('PRAGMA journal_mode=OFF')
    conn.execute('PRAGMA synchronous=OFF')
    conn.execute('PRAGMA temp_store=MEMORY')
    conn.execute('PRAGMA cache_size=-200000')
    create_schema(conn)

    message_count = 0
    batch = []
    for row in read_jsonl(work / 'messages.jsonl'):
        batch.append((
            row.get('id'),
            row.get('thread_id'),
            row.get('message_id_header'),
            row.get('in_reply_to'),
            references_text(row.get('references_hdr')),
            pg_ts(row.get('sent_at')),
            pg_ts(row.get('received_at')),
            row.get('direction'),
            row.get('mailbox'),
            row.get('from_addr'),
            json_text(row.get('to_addresses')),
            json_text(row.get('cc_addresses')),
            row.get('subject'),
            plain_body(row.get('text_body'), row.get('html_body')),
            row.get('cut_reason'),
        ))
        if len(batch) >= 1000:
            conn.executemany('INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', batch)
            message_count += len(batch)
            batch.clear()
    if batch:
        conn.executemany('INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', batch)
        message_count += len(batch)
        batch.clear()

    attachment_count = 0
    batch = []
    for row in read_jsonl(work / 'attachments.jsonl'):
        batch.append((
            row.get('id'),
            row.get('message_id'),
            row.get('filename'),
            row.get('mime_type'),
            row.get('size_bytes'),
            row.get('s3_key'),
            row.get('sha256'),
            1 if row.get('is_inline') else 0,
            row.get('cut_reason'),
        ))
        if len(batch) >= 1500:
            conn.executemany('INSERT INTO attachment VALUES (?,?,?,?,?,?,?,?,?)', batch)
            attachment_count += len(batch)
            batch.clear()
    if batch:
        conn.executemany('INSERT INTO attachment VALUES (?,?,?,?,?,?,?,?,?)', batch)
        attachment_count += len(batch)
        batch.clear()

    doc_count = 0
    doc_path = work / 'doc_text.jsonl'
    if doc_path.exists():
        batch = []
        for row in read_jsonl(doc_path):
            if row.get('source') not in ('rds_outbound', 'ec2_pdftotext', 'lazy'):
                continue
            batch.append((row.get('attachment_id'), row.get('text'), row.get('source'), row.get('fetched_at')))
            if len(batch) >= 1000:
                conn.executemany('INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)', batch)
                doc_count += len(batch)
                batch.clear()
        if batch:
            conn.executemany('INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)', batch)
            doc_count += len(batch)
            batch.clear()

    conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('window_start', WINDOW_START))
    conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('remote_built_at', datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')))
    conn.commit()
    conn.close()

    with open(sqlite_path, 'rb') as source, gzip.open(gzip_path, 'wb', compresslevel=6) as target:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            target.write(chunk)

    result = {
        'sqlite_path': str(sqlite_path),
        'gzip_path': str(gzip_path),
        'sqlite_bytes': sqlite_path.stat().st_size,
        'gzip_bytes': gzip_path.stat().st_size,
        'sqlite_sha256': sha_file(sqlite_path),
        'gzip_sha256': sha_file(gzip_path),
        'messages': message_count,
        'attachments': attachment_count,
        'doc_text_rows': doc_count,
        'wall_s': round(time.time() - started, 3),
    }
    (work / 'build_result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('P4_BUILD_JSON ' + json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('P4_BUILD_ERROR ' + json.dumps({'error': f'{type(exc).__name__}: {exc}'}) , file=sys.stderr)
        raise
