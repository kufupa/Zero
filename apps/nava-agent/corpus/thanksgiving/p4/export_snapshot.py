#!/usr/bin/env python3
"""Build the P4 linkage snapshot.

Orchestrates the RDS/S3 export on EC2 over SSM, transfers the compact sqlite build
through the private scratch S3 prefix, then finishes local HMS evidence, FTS5,
header edges, and deterministic P3 keys.
"""
import argparse
import base64
import concurrent.futures
import copy
import gzip
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path('/home/orca/orca/workspaces/zero/nava-agent-rewrite-20261125')
P4_DIR = REPO / 'apps/nava-agent/corpus/thanksgiving/p4'
SSM = REPO / 'apps/server-pilot/deploy/ssm-run-command.sh'
ZERO = Path('/home/orca/.local/share/zero')
WORK = ZERO / 'research/thanksgiving/work/p4'
RUNS = WORK / 'runs'
LANE_H = ZERO / 'research/thanksgiving/work/lane-h'
STABLE_TIERS = LANE_H / 'derived/stable-tiers.jsonl'
OBSERVATIONS = LANE_H / 'observations/hms-observations.jsonl'
OUTBOUND_PDFS = ZERO / 'research/halloween/raw-data/centurion-outbound-pdf-records-2026-10-29.jsonl'
DEFAULT_OUT = WORK / 'snapshot.sqlite'
CHUNK_CHARS = 18000
CONF_RE = re.compile(r'(?<![0-9])(\d{6,12}-\d{1,2})(?![0-9])')
HMS_CUTOFF = datetime.fromisoformat('2026-09-09T00:00:00+00:00')


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run_ssm(remote_cmd, label, timeout=1800, execution_timeout=1800):
    env = os.environ.copy()
    env['SSM_MAX_POLL_SECONDS'] = str(timeout + 120)
    env['SSM_EXECUTION_TIMEOUT_SECONDS'] = str(execution_timeout)
    proc = subprocess.run(
        ['bash', str(SSM), remote_cmd],
        cwd=REPO,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout + 180,
        check=False,
    )
    try:
        outer = json.loads(proc.stdout.decode('utf-8'))
    except Exception as exc:
        raise RuntimeError(f'{label}: SSM output not JSON rc={proc.returncode}: {type(exc).__name__}') from exc
    return {
        'ok': proc.returncode == 0 and outer.get('Status') == 'Success' and outer.get('ResponseCode') == 0,
        'label': label,
        'status': outer.get('Status'),
        'response_code': outer.get('ResponseCode'),
        'stdout': outer.get('Stdout') or '',
        'stderr': outer.get('Stderr') or '',
        'runner_exit_code': proc.returncode,
        'runner_stderr': proc.stderr.decode('utf-8', 'replace')[-500:],
    }


def require_ok(result):
    if not result['ok']:
        detail = (result.get('stderr') or result.get('stdout') or '')[-1200:]
        raise RuntimeError(
            f"{result['label']}: status={result.get('status')} response={result.get('response_code')} "
            f"rc={result.get('runner_exit_code')}: {detail}"
        )
    return result


def parse_marker(stdout, marker):
    rows = []
    prefix = marker + ' '
    for line in stdout.splitlines():
        if line.startswith(prefix):
            try:
                rows.append(json.loads(line[len(prefix):]))
            except json.JSONDecodeError:
                pass
    return rows[-1] if rows else None


def parse_utc(value):
    if not value:
        return None
    try:
        text = str(value).strip()
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def timestamp_sort_key(value):
    digits = re.sub(r'\D', '', value or '')
    return int(digits[:14] or 0)


def empty_to_none(value):
    return None if value in (None, '') else value


def load_capture_completeness(observations_path, wanted_ids):
    capture = {}
    with open(observations_path, encoding='utf-8') as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            observation_id = row.get('observation_id')
            if observation_id in wanted_ids:
                capture[observation_id] = (row.get('capture') or {}).get('completeness')
    return capture


def evidence_rank(row, completeness):
    kind = row.get('observation_kind')
    if kind == 'shallow_header_view':
        return None
    if kind == 'full_record_view' and completeness != 'derived_partial':
        quality = 0
    elif kind == 'list_row':
        quality = 1
    elif kind == 'full_record_view' and completeness == 'derived_partial':
        quality = 2
    else:
        return None
    return (
        quality,
        -timestamp_sort_key(row.get('observed_at')),
        -int((row.get('field_presence') or {}).get('stable_nonblank') or 0),
        row.get('observation_id') or '',
    )


def select_best_hms_rows(stable_path=STABLE_TIERS, observations_path=OBSERVATIONS):
    stable_rows = []
    with open(stable_path, encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                stable_rows.append(json.loads(line))
    wanted_ids = {row.get('observation_id') for row in stable_rows}
    completeness = load_capture_completeness(observations_path, wanted_ids)

    grouped = defaultdict(list)
    skipped = Counter()
    for row in stable_rows:
        comp = completeness.get(row.get('observation_id'))
        rank = evidence_rank(row, comp)
        if rank is None:
            skipped[f"{row.get('observation_kind')}:{comp or 'unknown'}"] += 1
            continue
        key = (row.get('property_code'), row.get('confirmation_key'))
        grouped[key].append((rank, row, comp))

    best_by_key = {}
    for key, candidates in grouped.items():
        best_by_key[key] = min(candidates, key=lambda item: item[0])

    by_confirmation = defaultdict(list)
    for (property_code, confirmation), item in best_by_key.items():
        if confirmation:
            by_confirmation[confirmation].append((property_code, item))

    selected = {}
    collisions = 0
    corrupt_created_fallbacks = 0
    for confirmation, choices in sorted(by_confirmation.items()):
        collisions += max(0, len(choices) - 1)
        choices.sort(key=lambda item: (0 if item[0] == 'HRCEN' else 1, item[1][0]))
        property_code, (rank, row, comp) = choices[0]
        audit = row.get('audit') or {}
        created_at = audit.get('created_at')
        created_source_observation = row.get('observation_id')
        observed_at = row.get('observed_at')
        created_dt = parse_utc(created_at)
        observed_dt = parse_utc(observed_at)
        if created_dt and observed_dt and created_dt > observed_dt:
            fallbacks = []
            key = (property_code, confirmation)
            for other_rank, other, other_comp in grouped.get(key, []):
                if other.get('observation_kind') != 'list_row':
                    continue
                other_created = (other.get('audit') or {}).get('created_at')
                other_created_dt = parse_utc(other_created)
                other_observed_dt = parse_utc(other.get('observed_at'))
                if other_created_dt and other_observed_dt and other_created_dt <= other_observed_dt:
                    fallbacks.append((other_rank, other, other_comp))
            if fallbacks:
                _rank, fallback_row, _comp = min(fallbacks, key=lambda item: item[0])
                created_at = (fallback_row.get('audit') or {}).get('created_at')
                created_source_observation = fallback_row.get('observation_id')
                corrupt_created_fallbacks += 1
        selected[confirmation] = {
            'property_code': property_code,
            'row': row,
            'completeness': comp,
            'rank': rank,
            'created_at': created_at,
            'created_source_observation': created_source_observation,
        }
    return selected, {
        'stable_rows': len(stable_rows),
        'grouped_confirmations': len(selected),
        'skipped': dict(sorted(skipped.items())),
        'property_collisions': collisions,
        'corrupt_created_fallbacks': corrupt_created_fallbacks,
    }


def hms_rows_for_insert():
    selected, meta = select_best_hms_rows()
    rows = []
    cohort_count = 0
    for confirmation, item in sorted(selected.items()):
        row = item['row']
        stay = row.get('stay_core') or {}
        commercial = row.get('commercial') or {}
        audit = row.get('audit') or {}
        created_at = item.get('created_at') or audit.get('created_at')
        created_dt = parse_utc(created_at)
        observed_dt = parse_utc(row.get('observed_at'))
        guest_name = empty_to_none(stay.get('guest_name'))
        created_by = empty_to_none(audit.get('created_by'))
        source_of_business = empty_to_none(commercial.get('source_of_business'))
        is_labtest = int(
            (created_by or '').strip().upper() == 'NAVAAI'
            or 'labtest' in (guest_name or '').lower()
        )
        cohort_clean = int(
            bool(created_dt)
            and created_dt >= HMS_CUTOFF
            and (source_of_business or '').strip() == 'E-Mail'
            and not is_labtest
            and bool(observed_dt)
            and created_dt <= observed_dt
        )
        cohort_count += cohort_clean
        raw = copy.deepcopy(row)
        raw['snapshot_selection'] = {
            'property_code': item.get('property_code'),
            'capture_completeness': item.get('completeness'),
            'created_at': created_at,
            'created_source_observation': item.get('created_source_observation'),
        }
        rows.append((
            confirmation,
            guest_name,
            empty_to_none(stay.get('arrival_date')),
            empty_to_none(stay.get('departure_date')),
            created_at,
            created_by,
            source_of_business,
            empty_to_none(commercial.get('company')),
            empty_to_none(commercial.get('travel_agency_1')),
            empty_to_none(audit.get('email_address')),
            empty_to_none(audit.get('caller')),
            empty_to_none(commercial.get('billing_reference')),
            empty_to_none(audit.get('reservation_note')),
            empty_to_none(commercial.get('rate_plan')),
            empty_to_none(commercial.get('room_type')),
            empty_to_none(commercial.get('meal_plan')),
            stay.get('adults'),
            stay.get('children'),
            empty_to_none(stay.get('status')),
            is_labtest,
            cohort_clean,
            json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
        ))
    meta['cohort_clean'] = cohort_count
    return rows, meta


def outbound_scan_after():
    latest = None
    with open(OUTBOUND_PDFS, encoding='utf-8') as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            sent = (row.get('parentMessage') or {}).get('sentAt')
            if sent and (latest is None or sent > latest):
                latest = sent
    return latest or '2026-10-29T15:02:21.000Z'


def insert_hms(conn):
    rows, meta = hms_rows_for_insert()
    conn.executemany('INSERT OR REPLACE INTO hms_stay VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    return len(rows), meta


def insert_outbound_doc_text(conn):
    attachment_ids = {row[0] for row in conn.execute('SELECT id FROM attachment')}
    fetched_at = utc_now()
    inserted = 0
    skipped_missing_attachment = 0
    rows_seen = 0
    with open(OUTBOUND_PDFS, encoding='utf-8') as handle:
        batch = []
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            rows_seen += 1
            attachment_id = (row.get('source') or {}).get('attachmentId') or row.get('recordId')
            if attachment_id not in attachment_ids:
                skipped_missing_attachment += 1
                continue
            pages = ((row.get('pdfExtraction') or {}).get('pages')) or []
            text = '\n\f\n'.join(page.get('markdown') or '' for page in pages).strip()
            if not text:
                continue
            batch.append((attachment_id, text, 'rds_outbound', fetched_at))
            if len(batch) >= 500:
                conn.executemany('INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)', batch)
                inserted += len(batch)
                batch.clear()
        if batch:
            conn.executemany('INSERT OR REPLACE INTO doc_text VALUES (?,?,?,?)', batch)
            inserted += len(batch)
    return {'rows_seen': rows_seen, 'inserted': inserted, 'skipped_missing_attachment': skipped_missing_attachment}


def header_tokens(value):
    if not value:
        return []
    text = str(value).strip()
    if not text:
        return []
    angled = re.findall(r'<([^<>]+)>', text)
    pieces = angled if angled else re.split(r'\s+', text)
    out = []
    for piece in pieces:
        piece = piece.strip().strip('<>').strip()
        if piece:
            out.append(piece.casefold())
    return out


def build_header_edges(conn):
    rows = list(conn.execute('SELECT id, message_id_header, in_reply_to, references_hdr FROM message'))
    by_header = defaultdict(list)
    for message_id, header, _in_reply, _refs in rows:
        for token in header_tokens(header):
            by_header[token].append(message_id)
    edges = set()
    for src_id, _header, in_reply, refs in rows:
        for token in header_tokens(in_reply):
            for dst_id in by_header.get(token, []):
                if dst_id != src_id:
                    edges.add((src_id, dst_id, 'in_reply_to'))
        for token in header_tokens(refs):
            for dst_id in by_header.get(token, []):
                if dst_id != src_id:
                    edges.add((src_id, dst_id, 'references'))
    conn.executemany('INSERT INTO header_edge VALUES (?,?,?)', sorted(edges))
    return len(edges)


def build_fts(conn):
    conn.executescript('''
CREATE VIRTUAL TABLE message_fts USING fts5(subject, body_text, from_addr, to_addrs, content='message', content_rowid='rowid');
INSERT INTO message_fts(message_fts) VALUES('rebuild');
CREATE VIRTUAL TABLE doc_fts USING fts5(text, content='doc_text', content_rowid='rowid');
INSERT INTO doc_fts(doc_fts) VALUES('rebuild');
CREATE VIRTUAL TABLE hms_fts USING fts5(guest_name, company, travel_agent, email_address, caller, billing_reference, reservation_note, content='hms_stay', content_rowid='rowid');
INSERT INTO hms_fts(hms_fts) VALUES('rebuild');
''')


def build_p3_keys(conn):
    confirmations = {row[0] for row in conn.execute('SELECT confirmation FROM hms_stay')}
    found = set()
    for message_id, subject, body in conn.execute('SELECT id, subject, body_text FROM message'):
        for source, text in (('subject', subject), ('body', body)):
            if not text:
                continue
            for match in CONF_RE.finditer(text):
                confirmation = match.group(1)
                if confirmation in confirmations:
                    found.add((message_id, confirmation, source))
    for attachment_id, message_id, text in conn.execute(
        'SELECT a.id, a.message_id, d.text FROM attachment a JOIN doc_text d ON d.attachment_id = a.id WHERE d.text IS NOT NULL'
    ):
        if not text:
            continue
        for match in CONF_RE.finditer(text):
            confirmation = match.group(1)
            if confirmation in confirmations:
                found.add((message_id, confirmation, 'pdf'))
    rows = sorted(found)
    conn.executemany('INSERT INTO p3_key VALUES (?,?,?)', rows)
    return {'rows': len(rows), 'distinct_confirmations': len({row[1] for row in rows}), 'messages': len({row[0] for row in rows})}


def table_counts(conn):
    one = lambda sql: conn.execute(sql).fetchone()[0]
    return {
        'messages': one('SELECT count(*) FROM message'),
        'uncut': one("SELECT count(*) FROM message WHERE cut_reason IS NULL"),
        'attachments': one('SELECT count(*) FROM attachment'),
        'doc_text_rows': one('SELECT count(*) FROM doc_text'),
        'doc_text_nonempty': one("SELECT count(*) FROM doc_text WHERE text IS NOT NULL AND text <> ''"),
        'hms_stay': one('SELECT count(*) FROM hms_stay'),
        'cohort_clean': one('SELECT count(*) FROM hms_stay WHERE cohort_clean = 1'),
        'header_edges': one('SELECT count(*) FROM header_edge'),
        'p3_rows': one('SELECT count(*) FROM p3_key'),
        'p3_distinct_confirmations': one('SELECT count(DISTINCT confirmation) FROM p3_key'),
    }


def finalize_snapshot(part_sqlite, out_path, remote_meta, timings):
    started = time.time()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = out_path.with_suffix('.sqlite.tmp')
    for path in (tmp_out, out_path):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    shutil.copyfile(part_sqlite, tmp_out)
    conn = sqlite3.connect(tmp_out)
    conn.execute('PRAGMA journal_mode=OFF')
    conn.execute('PRAGMA synchronous=OFF')

    hms_count, hms_meta = insert_hms(conn)
    outbound_meta = insert_outbound_doc_text(conn)
    edge_count = build_header_edges(conn)
    build_fts(conn)
    p3_meta = build_p3_keys(conn)
    conn.commit()
    counts = table_counts(conn)
    quick_check = conn.execute('PRAGMA quick_check').fetchone()[0]
    git_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    built_at = utc_now()
    counts_json = {
        **counts,
        'hms_selection': hms_meta,
        'outbound_doc_text': outbound_meta,
        'remote_export': remote_meta.get('remote_stats'),
        'remote_build': remote_meta.get('build'),
        'p3': p3_meta,
    }
    for key, value in (
        ('built_at', built_at),
        ('source_git_sha', git_sha),
        ('counts', json.dumps(counts_json, ensure_ascii=False, sort_keys=True)),
        ('s3_bucket', remote_meta.get('bucket') or ''),
        ('schema', 'p4_snapshot_v1'),
    ):
        conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, value))
    conn.commit()
    integrity = conn.execute('PRAGMA quick_check').fetchone()[0]
    conn.close()
    os.replace(tmp_out, out_path)
    timings['finalize_s'] = round(time.time() - started, 3)
    return {
        'built_at': built_at,
        'git_sha': git_sha,
        'counts': counts,
        'counts_detail': counts_json,
        'quick_check_before_meta': quick_check,
        'quick_check': integrity,
        'out': str(out_path),
        'bytes': out_path.stat().st_size,
        'sha256': sha_file(out_path),
    }


def stage_and_run_remote(run_id, scan_mode, scan_after, workers, run_dir):
    remote_root = f'/tmp/p4-export-{run_id}'
    export_b64 = base64.b64encode((P4_DIR / 'remote_export.mjs').read_bytes()).decode('ascii')
    build_b64 = base64.b64encode((P4_DIR / 'remote_build.py').read_bytes()).decode('ascii')
    stage_cmd = f"""set -euo pipefail
umask 077
rm -f {remote_root}/remote_export.mjs {remote_root}/remote_build.py 2>/dev/null || true
mkdir -p {remote_root}
printf '%s' '{export_b64}' | base64 -d > {remote_root}/remote_export.mjs
printf '%s' '{build_b64}' | base64 -d > {remote_root}/remote_build.py
chmod 700 {remote_root}/remote_export.mjs {remote_root}/remote_build.py
"""
    require_ok(run_ssm(stage_cmd, 'stage', timeout=180, execution_timeout=120))

    scratch_key = f'p4-scratch/snapshot/{run_id}/snapshot-part.sqlite.gz'
    main_cmd = f"""set -u
export NVM_DIR=/home/ubuntu/.nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/ubuntu/repos/zero/apps/server-pilot || exit 20
set -a
source .env.production
set +a
export AWS_REGION="${{AWS_REGION:-af-south-1}}"
export P4_SCRATCH_KEY='{scratch_key}'
node {remote_root}/remote_export.mjs --work {remote_root} --scan-mode {scan_mode} --scan-after '{scan_after}' --workers {workers} > {remote_root}/node-stdout.log 2> {remote_root}/node-stderr.log
node_rc=$?
cat {remote_root}/node-stdout.log 2>/dev/null
if [ "$node_rc" -ne 0 ]; then
  echo 'P4_NODE_STDERR_BEGIN'
  tail -n 30 {remote_root}/node-stderr.log 2>/dev/null
  echo 'P4_NODE_STDERR_END'
  exit "$node_rc"
fi
python3 {remote_root}/remote_build.py --work {remote_root} > {remote_root}/build-stdout.log 2> {remote_root}/build-stderr.log
build_rc=$?
cat {remote_root}/build-stdout.log 2>/dev/null
if [ "$build_rc" -ne 0 ]; then
  echo 'P4_BUILD_STDERR_BEGIN'
  tail -n 30 {remote_root}/build-stderr.log 2>/dev/null
  echo 'P4_BUILD_STDERR_END'
  exit "$build_rc"
fi
python3 - <<'PY'
import json, os, subprocess
bucket = os.environ.get('S3_BUCKET')
key = os.environ.get('P4_SCRATCH_KEY')
path = os.path.join('{remote_root}', 'snapshot-part.sqlite.gz')
result = {{'ok': False, 'bucket': bucket, 'key': key}}
if bucket and key and os.path.exists(path):
    proc = subprocess.run(['aws', 's3', 'cp', path, f's3://{{bucket}}/{{key}}', '--only-show-errors'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1800)
    result['rc'] = proc.returncode
    if proc.returncode == 0:
        result['ok'] = True
    else:
        result['error'] = proc.stderr[-300:]
print('P4_UPLOAD_JSON ' + json.dumps(result, sort_keys=True))
PY
"""
    result = run_ssm(main_cmd, 'remote-main', timeout=3600, execution_timeout=3300)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / 'remote-main.stdout').write_text(result.get('stdout') or '', encoding='utf-8')
    (run_dir / 'remote-main.stderr').write_text(result.get('stderr') or '', encoding='utf-8')
    require_ok(result)
    stdout = result['stdout']
    remote_stats = parse_marker(stdout, 'P4_REMOTE_STATS')
    build = parse_marker(stdout, 'P4_BUILD_JSON')
    upload = parse_marker(stdout, 'P4_UPLOAD_JSON')
    if not build:
        raise RuntimeError('remote build metadata missing')
    return {
        'remote_root': remote_root,
        'scratch_key': scratch_key,
        'bucket': (upload or {}).get('bucket'),
        'remote_stats': remote_stats,
        'build': build,
        'upload': upload,
        'stdout': stdout,
    }


def download_from_s3(bucket, key, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ['aws', 's3', 'cp', f's3://{bucket}/{key}', str(dest), '--only-show-errors'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=1800,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'local aws s3 cp failed: {proc.stderr[-500:]}')


def download_chunked(remote_gz_path, dest, workers=6):
    meta_cmd = f"""set -euo pipefail
python3 - <<'PY'
import base64, hashlib, json, os
path = {remote_gz_path!r}
b64_path = path + '.b64'
with open(path, 'rb') as source, open(b64_path, 'wb') as target:
    while True:
        chunk = source.read(3 * 1024 * 1024)
        if not chunk:
            break
        target.write(base64.b64encode(chunk))
data = open(b64_path, 'rb').read()
print('P4_B64_META ' + json.dumps({{'chars': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'path': b64_path}}))
PY
"""
    meta = parse_marker(require_ok(run_ssm(meta_cmd, 'b64-prepare', timeout=900, execution_timeout=900))['stdout'], 'P4_B64_META')
    if not meta:
        raise RuntimeError('b64 metadata missing')
    chunks = math.ceil(meta['chars'] / CHUNK_CHARS)

    def one(index):
        start = index * CHUNK_CHARS
        length = CHUNK_CHARS
        cmd = f"python3 - <<'PY'\nimport sys\np=open({meta['path']!r},'rb')\np.seek({start})\nsys.stdout.buffer.write(p.read({length}))\nPY"
        result = require_ok(run_ssm(cmd, f'download-{index}', timeout=180, execution_timeout=120))
        return index, result['stdout']

    parts = [''] * chunks
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for index, text in pool.map(one, range(chunks)):
            parts[index] = text
    packed = ''.join(parts)[:meta['chars']]
    if hashlib.sha256(packed.encode('ascii')).hexdigest() != meta['sha256']:
        raise RuntimeError('chunked transfer sha mismatch')
    dest.write_bytes(base64.b64decode(packed))


def cleanup_scratch(bucket, keys):
    deleted = []
    for key in sorted(set(filter(None, keys))):
        proc = subprocess.run(
            ['aws', 's3', 'rm', f's3://{bucket}/{key}', '--only-show-errors'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        deleted.append({'key': key, 'ok': proc.returncode == 0, 'error': proc.stderr[-200:] if proc.returncode else ''})
    return deleted


def cleanup_remote(remote_root):
    cmd = f"rm -f {remote_root}/remote_export.mjs {remote_root}/remote_build.py {remote_root}/messages.jsonl {remote_root}/attachments.jsonl {remote_root}/doc_text.jsonl {remote_root}/snapshot-part.sqlite {remote_root}/snapshot-part.sqlite.gz {remote_root}/snapshot-part.sqlite.gz.b64 {remote_root}/node-stdout.log {remote_root}/node-stderr.log {remote_root}/build-stdout.log {remote_root}/build-stderr.log {remote_root}/remote_stats.json {remote_root}/build_result.json 2>/dev/null; rmdir {remote_root} 2>/dev/null || true"
    result = run_ssm(cmd, 'remote-cleanup', timeout=120, execution_timeout=90)
    return {'ok': result.get('ok'), 'status': result.get('status')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--scan-mode', choices=['auto', 'yes', 'no'], default='auto')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--run-id')
    parser.add_argument('--no-remote-cleanup', action='store_true')
    args = parser.parse_args()

    started = time.time()
    timings = {}
    run_id = args.run_id or 'p4-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
    run_id = re.sub(r'[^A-Za-z0-9_.-]', '-', run_id)
    run_dir = RUNS / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    scan_after = outbound_scan_after()
    print(json.dumps({'stage': 'remote_start', 'run_id': run_id, 'scan_after': scan_after}), flush=True)
    remote_started = time.time()
    remote = stage_and_run_remote(run_id, args.scan_mode, scan_after, args.workers, run_dir)
    timings['remote_export_build_s'] = round(time.time() - remote_started, 3)
    print(json.dumps({'stage': 'remote_done', 'scan_enabled': (remote.get('remote_stats') or {}).get('scan_enabled'), 'doc_rows': (remote.get('remote_stats') or {}).get('doc_rows')}), flush=True)

    gz_path = run_dir / 'snapshot-part.sqlite.gz'
    transfer_started = time.time()
    upload = remote.get('upload') or {}
    if upload.get('ok') and upload.get('bucket') and upload.get('key'):
        download_from_s3(upload['bucket'], upload['key'], gz_path)
    else:
        download_chunked(remote['build']['gzip_path'], gz_path)
    if sha_file(gz_path) != remote['build']['gzip_sha256']:
        raise RuntimeError('downloaded gzip sha256 mismatch')
    timings['transfer_s'] = round(time.time() - transfer_started, 3)
    print(json.dumps({'stage': 'transfer_done', 'gzip_bytes': gz_path.stat().st_size, 'transfer_s': timings['transfer_s']}), flush=True)

    part_sqlite = run_dir / 'snapshot-part.sqlite'
    with gzip.open(gz_path, 'rb') as source, open(part_sqlite, 'wb') as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
    if sha_file(part_sqlite) != remote['build']['sqlite_sha256']:
        raise RuntimeError('decompressed sqlite sha256 mismatch')

    final = finalize_snapshot(part_sqlite, args.out, remote, timings)
    timings['total_s'] = round(time.time() - started, 3)
    final['timings'] = timings
    final['run_id'] = run_id

    probe_key = 'p4-scratch/probe/1795732701751-9790fc2b.txt'
    bucket = upload.get('bucket') or remote.get('bucket')
    final['scratch_cleanup'] = cleanup_scratch(bucket, [upload.get('key'), probe_key]) if bucket else []
    if not args.no_remote_cleanup:
        try:
            final['remote_cleanup'] = cleanup_remote(remote['remote_root'])
        except Exception as exc:
            final['remote_cleanup'] = {'ok': False, 'error': f'{type(exc).__name__}: {exc}'}

    (run_dir / 'final.json').write_text(json.dumps(final, indent=2, sort_keys=True), encoding='utf-8')
    print('P4_FINAL_JSON ' + json.dumps(final, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
