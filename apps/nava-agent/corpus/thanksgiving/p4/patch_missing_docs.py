#!/usr/bin/env python3
"""Patch post-build PDF text gaps and refresh doc FTS/P3/meta."""
import argparse
import gzip
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_snapshot

PDF_FILTER = "(lower(coalesce(a.mime_type,'')) like '%pdf%' or lower(coalesce(a.filename,'')) like '%.pdf')"
MISSING_SQL = f'''
SELECT a.id, a.sha256, a.s3_key
FROM attachment a
JOIN message m ON m.id = a.message_id
LEFT JOIN doc_text d ON d.attachment_id = a.id
WHERE m.direction = 'inbound'
  AND m.sent_at >= '2026-09-09T00:00:00.000Z'
  AND a.cut_reason IS NULL
  AND m.cut_reason IS NULL
  AND {PDF_FILTER}
  AND d.attachment_id IS NULL
  AND a.s3_key IS NOT NULL
'''


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def rows_by_sha(conn):
    out = {}
    for sha, text, source, fetched_at in conn.execute('''
      SELECT a.sha256, d.text, d.source, d.fetched_at
      FROM attachment a JOIN doc_text d ON d.attachment_id = a.id
      WHERE a.sha256 IS NOT NULL AND d.text IS NOT NULL AND d.source = 'ec2_pdftotext'
    '''):
        if sha not in out or len(text or '') > len(out[sha][0] or ''):
            out[sha] = (text, source, fetched_at)
    return out


def load_patch_rows(path):
    rows = []
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--patch-jsonl', type=Path)
    parser.add_argument('--emit-missing', type=Path)
    args = parser.parse_args()
    started = time.time()
    conn = sqlite3.connect(args.db)
    conn.execute('PRAGMA journal_mode=DELETE')
    conn.execute('PRAGMA synchronous=OFF')

    missing = conn.execute(MISSING_SQL).fetchall()
    sha_map = rows_by_sha(conn)
    fill_rows = []
    for attachment_id, sha, _s3_key in missing:
        if sha in sha_map:
            text, source, fetched_at = sha_map[sha]
            fill_rows.append((attachment_id, text, source, fetched_at))
    conn.executemany('INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)', fill_rows)

    patch_rows = load_patch_rows(args.patch_jsonl) if args.patch_jsonl else []
    conn.executemany(
        'INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)',
        [(row.get('attachment_id'), row.get('text'), row.get('source'), row.get('fetched_at')) for row in patch_rows],
    )
    conn.commit()

    remaining_rows = conn.execute(MISSING_SQL).fetchall()
    if args.emit_missing:
        args.emit_missing.write_text(json.dumps([
            {'attachment_id': attachment_id, 'sha256': sha, 's3_key': s3_key}
            for attachment_id, sha, s3_key in remaining_rows
        ], indent=2), encoding='utf-8')

    conn.execute("INSERT INTO doc_fts(doc_fts) VALUES('rebuild')")
    conn.execute('DELETE FROM p3_key')
    p3 = export_snapshot.build_p3_keys(conn)
    conn.commit()
    counts = export_snapshot.table_counts(conn)
    old_counts = {}
    try:
        old_counts = json.loads(conn.execute("SELECT value FROM meta WHERE key='counts'").fetchone()[0])
    except Exception:
        pass
    patched_at = utc_now()
    counts_detail = {**old_counts, **counts, 'p3': p3, 'missing_doc_patch': {
        'patched_at': patched_at,
        'sha_propagated_rows': len(fill_rows),
        'ec2_patch_rows': len(patch_rows),
        'remaining_postsep_inbound_pdf_missing': len(remaining_rows),
    }}
    conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('counts', json.dumps(counts_detail, ensure_ascii=False, sort_keys=True)))
    conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('patched_at', patched_at))
    conn.commit()
    quick = conn.execute('PRAGMA quick_check').fetchone()[0]
    conn.close()
    print('P4_DOC_PATCH_JSON ' + json.dumps({
        'sha_propagated_rows': len(fill_rows),
        'ec2_patch_rows': len(patch_rows),
        'remaining_missing': len(remaining_rows),
        'counts': counts,
        'p3': p3,
        'quick_check': quick,
        'wall_s': round(time.time() - started, 3),
    }, sort_keys=True))


if __name__ == '__main__':
    main()
