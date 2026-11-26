#!/usr/bin/env python3
"""On-demand attachment text fetcher for the P4 snapshot.

Python API: fetch(attachment_id) -> text | None
Uses direct local AWS/S3 when available, otherwise EC2 through SSM.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path('/home/orca/orca/workspaces/zero/nava-agent-rewrite-20261125')
SSM = REPO / 'apps/server-pilot/deploy/ssm-run-command.sh'
DEFAULT_DB = Path('/home/orca/.local/share/zero/research/thanksgiving/work/p4/snapshot.sqlite')
CHUNK_CHARS = 18000


def run_ssm(remote_cmd, label, timeout=180, execution_timeout=150):
    env = os.environ.copy()
    env['SSM_MAX_POLL_SECONDS'] = str(timeout + 60)
    env['SSM_EXECUTION_TIMEOUT_SECONDS'] = str(execution_timeout)
    proc = subprocess.run(
        ['bash', str(SSM), remote_cmd],
        cwd=REPO,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout + 90,
        check=False,
    )
    try:
        outer = json.loads(proc.stdout.decode('utf-8'))
    except Exception:
        return None
    if proc.returncode != 0 or outer.get('Status') != 'Success' or outer.get('ResponseCode') != 0:
        return None
    return outer.get('Stdout') or ''


def marker(stdout, name):
    prefix = name + ' '
    for line in reversed(stdout.splitlines()):
        if line.startswith(prefix):
            try:
                return json.loads(line[len(prefix):])
            except json.JSONDecodeError:
                return None
    return None


def attachment_row(db_path, attachment_id):
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        row = conn.execute(
            'SELECT id, filename, mime_type, size_bytes, s3_key, sha256 FROM attachment WHERE id = ?',
            (attachment_id,),
        ).fetchone()
        if not row:
            return None
        bucket = None
        try:
            bucket = conn.execute("SELECT value FROM meta WHERE key = 's3_bucket'").fetchone()[0] or None
        except Exception:
            pass
        return {
            'id': row[0],
            'filename': row[1],
            'mime_type': row[2],
            'size_bytes': row[3],
            's3_key': row[4],
            'sha256': row[5],
            'bucket': bucket,
        }
    finally:
        conn.close()


def is_pdf(row):
    return 'pdf' in (row.get('mime_type') or '').lower() or (row.get('filename') or '').lower().endswith('.pdf')


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def pdf_bytes_to_text(data):
    if not shutil.which('pdftotext'):
        return None
    with tempfile.NamedTemporaryFile(prefix='p4-fetch-', suffix='.pdf', delete=False) as handle:
        path = handle.name
        handle.write(data)
    try:
        proc = subprocess.run(
            ['pdftotext', '-layout', path, '-'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
        if proc.returncode != 0:
            return None
        return proc.stdout.decode('utf-8', 'replace')
    except Exception:
        return None
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def direct_s3_text(row):
    bucket = row.get('bucket') or os.environ.get('S3_BUCKET')
    key = row.get('s3_key')
    if not bucket or not key or not shutil.which('aws'):
        return None
    try:
        proc = subprocess.run(
            ['aws', 's3', 'cp', f's3://{bucket}/{key}', '-', '--only-show-errors'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=90,
            check=False,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    data = proc.stdout
    if row.get('sha256') and sha256_bytes(data) != row['sha256']:
        return None
    if is_pdf(row):
        return pdf_bytes_to_text(data)
    if (row.get('mime_type') or '').lower().startswith('text/'):
        return data.decode('utf-8', 'replace')
    return None


def ssm_fetch_text(row):
    key = row.get('s3_key')
    if not key:
        return None
    expected_sha = row.get('sha256') or ''
    bucket = row.get('bucket') or ''
    remote = f"""set -euo pipefail
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a
source .env.production
set +a
export AWS_REGION="${{AWS_REGION:-af-south-1}}"
python3 - <<'PY'
import base64, gzip, hashlib, json, os, subprocess, tempfile
bucket = {bucket!r} or os.environ.get('S3_BUCKET')
key = {key!r}
expected = {expected_sha!r}
if not bucket or not key:
    raise SystemExit(2)
work = tempfile.mkdtemp(prefix='p4-fetch-')
pdf_path = os.path.join(work, 'doc.pdf')
out_path = os.path.join(work, 'text.gz.b64')
try:
    subprocess.run(['aws', 's3', 'cp', 's3://' + bucket + '/' + key, pdf_path, '--only-show-errors'], check=True, timeout=120)
    data = open(pdf_path, 'rb').read()
    if expected and hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit(3)
    proc = subprocess.run(['pdftotext', '-layout', pdf_path, '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if proc.returncode != 0:
        raise SystemExit(4)
    packed = base64.b64encode(gzip.compress(proc.stdout, 6)).decode('ascii')
    open(out_path, 'w', encoding='ascii').write(packed)
    print('P4_FETCH_META ' + json.dumps({{'ok': True, 'path': out_path, 'chars': len(packed), 'sha256': hashlib.sha256(packed.encode('ascii')).hexdigest()}}))
finally:
    try: os.unlink(pdf_path)
    except OSError: pass
PY
"""
    stdout = run_ssm(remote, 'fetch-prepare', timeout=240, execution_timeout=210)
    if not stdout:
        return None
    meta = marker(stdout, 'P4_FETCH_META')
    if not meta or not meta.get('ok'):
        return None
    chunks = (int(meta['chars']) + CHUNK_CHARS - 1) // CHUNK_CHARS
    parts = []
    for index in range(chunks):
        start = index * CHUNK_CHARS
        cmd = f"python3 - <<'PY'\nimport sys\np=open({meta['path']!r},'rb')\np.seek({start})\nsys.stdout.buffer.write(p.read({CHUNK_CHARS}))\nPY"
        part = run_ssm(cmd, f'fetch-chunk-{index}', timeout=120, execution_timeout=90)
        if part is None:
            return None
        parts.append(part)
    packed = ''.join(parts)[:int(meta['chars'])]
    if hashlib.sha256(packed.encode('ascii')).hexdigest() != meta['sha256']:
        return None
    try:
        return gzip.decompress(base64.b64decode(packed)).decode('utf-8', 'replace')
    except Exception:
        return None


def fetch(attachment_id, db_path=DEFAULT_DB):
    row = attachment_row(db_path, attachment_id)
    if not row or not row.get('s3_key'):
        return None
    return direct_s3_text(row) or ssm_fetch_text(row)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attachment_id')
    parser.add_argument('--db', type=Path, default=DEFAULT_DB)
    parser.add_argument('--no-text', action='store_true', help='print metadata only')
    args = parser.parse_args()
    text = fetch(args.attachment_id, args.db)
    result = {'attachment_id': args.attachment_id, 'found': text is not None, 'chars': len(text or '')}
    if not args.no_text:
        result['text'] = text
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if text is not None else 1


if __name__ == '__main__':
    raise SystemExit(main())
