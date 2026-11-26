#!/usr/bin/env python3
import argparse
import base64
import concurrent.futures
import gzip
import hashlib
import json
import math
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from hms_payload import build_hms_payload

REPO = Path(__file__).resolve().parents[5]
CORPUS_DIR = Path(__file__).resolve().parents[1]
SSM = REPO / 'apps/server-pilot/deploy/ssm-run-command.sh'
MAIL_INGEST = REPO / 'apps/nava-agent/src/mail-ingest.ts'
REMOTE_SCRIPT = CORPUS_DIR / 'scripts/remote_pipeline.mjs'
WORK = Path('/home/orca/.local/share/zero/research/thanksgiving/work/p0-p3')
CHUNK_CHARS = 30000
DD_BLOCK = 9000


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def extract_domain_array(source, name):
    match = re.search(rf'const\s+{re.escape(name)}\s*=\s*\[(.*?)\];', source, re.S)
    if not match:
        raise RuntimeError(f'mail-ingest array not found: {name}')
    return re.findall(r"'([^']+)'", match.group(1))


def git_sha():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()


def run_ssm(remote_cmd, label, timeout=600):
    proc = subprocess.run(
        ['bash', str(SSM), remote_cmd],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    stdout_bytes = proc.stdout
    try:
        outer = json.loads(stdout_bytes.decode('utf-8'))
    except Exception as exc:
        raise RuntimeError(f'{label}: SSM runner output was not JSON rc={proc.returncode}: {type(exc).__name__}') from exc
    ok = proc.returncode == 0 and outer.get('Status') == 'Success' and outer.get('ResponseCode') == 0
    return {
        'ok': ok,
        'label': label,
        'status': outer.get('Status'),
        'response_code': outer.get('ResponseCode'),
        'stdout': outer.get('Stdout') or '',
        'stderr_chars': len(outer.get('Stderr') or ''),
        'runner_exit_code': proc.returncode,
        'runner_stderr': proc.stderr.decode('utf-8', 'replace')[-500:],
    }


def require_ok(result):
    if not result['ok']:
        raise RuntimeError(
            f"{result['label']}: status={result.get('status')} response={result.get('response_code')} "
            f"rc={result.get('runner_exit_code')} stderr={result.get('runner_stderr')!r}"
        )
    return result


def upload_payload(run_id, packed_b64, workers):
    chunk_count = math.ceil(len(packed_b64) / CHUNK_CHARS)
    base = f'/tmp/thanksgiving-p0p3-input-{run_id}'
    chunks = [packed_b64[i * CHUNK_CHARS:(i + 1) * CHUNK_CHARS] for i in range(chunk_count)]

    def upload_one(item):
        index, chunk = item
        path = f'{base}.part{index:04d}'
        cmd = f"umask 077; printf '%s' '{chunk}' > {path}"
        result = run_ssm(cmd, f'upload-{index:04d}', timeout=180)
        require_ok(result)
        return index

    print(json.dumps({'upload_chunks': chunk_count, 'stage': 'upload_start'}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(upload_one, enumerate(chunks), chunksize=1))
    print(json.dumps({'upload_chunks': chunk_count, 'stage': 'upload_done'}), flush=True)

    ordered_parts = ' '.join(f'{base}.part{index:04d}' for index in range(chunk_count))
    concat_cmd = f"set -e; cat {ordered_parts} > /tmp/thanksgiving-p0p3-input.b64; chmod 600 /tmp/thanksgiving-p0p3-input.b64; rm -f {ordered_parts}"
    require_ok(run_ssm(concat_cmd, 'upload-concat', timeout=180))
    return {'chunks': chunk_count, 'chunk_chars': CHUNK_CHARS, 'workers': workers}


def download_output(remote_info, workers):
    packed_chars = int(remote_info['packed_chars'])
    chunks = math.ceil(packed_chars / (DD_BLOCK * 2))

    def download_one(index):
        cmd = f'dd if=/tmp/thanksgiving-p0p3-output.b64 bs={DD_BLOCK} skip={index * 2} count=2 status=none'
        result = run_ssm(cmd, f'download-{index:02d}', timeout=180)
        require_ok(result)
        return index, result['stdout']

    parts = [''] * chunks
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for index, text in pool.map(download_one, range(chunks)):
            parts[index] = text
    packed = ''.join(parts)[:packed_chars]
    sha = hashlib.sha256(packed.encode('ascii')).hexdigest()
    if sha != remote_info['packed_sha256']:
        raise RuntimeError('packed output sha256 mismatch')
    return json.loads(gzip.decompress(base64.b64decode(packed)).decode('utf-8'))


def build_input(run_id):
    sql_files = {
        'schema': CORPUS_DIR / 'sql/001_schema.sql',
        'p0': CORPUS_DIR / 'sql/002_p0_register.sql',
        'p1': CORPUS_DIR / 'sql/003_p1_cut.sql',
        'p3': CORPUS_DIR / 'sql/004_p3_match.sql',
        'metrics': CORPUS_DIR / 'sql/005_metrics.sql',
    }
    sql_text = {name: path.read_text(encoding='utf-8') for name, path in sql_files.items()}
    mail_source = MAIL_INGEST.read_text(encoding='utf-8')
    domains = {
        'ota': extract_domain_array(mail_source, 'otaChannelDomains'),
        'system': extract_domain_array(mail_source, 'systemDomains'),
    }
    hms_payload = build_hms_payload()
    script_bytes = REMOTE_SCRIPT.read_bytes()
    params = {
        'message_cutoff': '2026-09-09',
        'hms_cutoff': '2026-09-09T00:00:00Z',
        'pdf_text_enabled': True,
        'branding_image_max_bytes': 102400,
        'branding_image_min_distinct_messages': 5,
        'hms_payload_meta': hms_payload['meta'],
        'sql_sha256': {name: sha_bytes(text.encode('utf-8')) for name, text in sql_text.items()},
        'remote_script_sha256': sha_bytes(script_bytes),
    }
    return {
        'runId': run_id,
        'gitSha': git_sha(),
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'sql': sql_text,
        'domains': domains,
        'hmsColumns': hms_payload['columns'],
        'hmsRows': hms_payload['rows'],
        'params': params,
    }


def cleanup_remote(run_id):
    pattern_base = f'/tmp/thanksgiving-p0p3-input-{run_id}'
    cmd = (
        'rm -f /tmp/thanksgiving-p0p3-input.b64 '
        '/tmp/thanksgiving-p0p3-output.b64 '
        '/tmp/thanksgiving-p0p3-remote.mjs '
        f'{pattern_base}.part*'
    )
    result = run_ssm(cmd, 'cleanup', timeout=120)
    return {key: value for key, value in result.items() if key != 'stdout'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=int(os.environ.get('THANKSGIVING_SSM_WORKERS', '6')))
    parser.add_argument('--run-id')
    parser.add_argument('--no-cleanup', action='store_true')
    parser.add_argument('--reuse-hms', action='store_true')
    args = parser.parse_args()

    run_id = args.run_id or 'p0p3-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
    run_id = re.sub(r'[^A-Za-z0-9_.-]', '-', run_id)
    WORK.mkdir(parents=True, exist_ok=True)

    started = datetime.now(timezone.utc)
    input_payload = build_input(run_id)
    if args.reuse_hms:
        input_payload['hmsRows'] = []
        input_payload['params']['reuse_hms'] = True
    input_bytes = json.dumps(input_payload, separators=(',', ':')).encode('utf-8')
    input_gzip = gzip.compress(input_bytes, 9)
    input_b64 = base64.b64encode(input_gzip).decode('ascii')
    script_bytes = REMOTE_SCRIPT.read_bytes()
    script_b64 = base64.b64encode(script_bytes).decode('ascii')

    meta = {
        'run_id': run_id,
        'started_at': started.isoformat().replace('+00:00', 'Z'),
        'input_json_bytes': len(input_bytes),
        'input_gzip_bytes': len(input_gzip),
        'input_b64_chars': len(input_b64),
        'input_sha256': sha_bytes(input_bytes),
        'remote_script_sha256': sha_bytes(script_bytes),
        'hms_rows': len(input_payload['hmsRows']),
        'hms_meta': input_payload['params']['hms_payload_meta'],
        'ota_domains': len(input_payload['domains']['ota']),
        'system_domains': len(input_payload['domains']['system']),
    }
    meta_path = WORK / f'{run_id}-meta.json'
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps({'run_id': run_id, 'input_gzip_bytes': len(input_gzip), 'hms_rows': len(input_payload['hmsRows'])}, sort_keys=True))

    try:
        upload_meta = upload_payload(run_id, input_b64, args.workers)
        meta['upload'] = upload_meta
        remote_cmd = f"""set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm
[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"
export PATH=\"$HOME/.local/share/pnpm:$PATH\"
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a
source .env.production
set +a
export NODE_EXTRA_CA_CERTS=/home/ubuntu/repos/zero/apps/server-pilot/deploy/rds-ca-global.pem
umask 077
printf '%s' '{script_b64}' | base64 -d > /tmp/thanksgiving-p0p3-remote.mjs
node /tmp/thanksgiving-p0p3-remote.mjs
"""
        main_result = require_ok(run_ssm(remote_cmd, 'main', timeout=1800))
        stdout_lines = main_result['stdout'].strip().splitlines()
        if not stdout_lines:
            raise RuntimeError('remote pipeline produced no stdout metadata')
        remote_info = json.loads(stdout_lines[-1])
        meta['remote_info'] = remote_info
        print(json.dumps({'stage': 'remote_main_done', 'ok': remote_info.get('ok')}), flush=True)
        result = download_output(remote_info, args.workers)
        meta['finished_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        meta['result_ok'] = result.get('ok')
        meta['result_counts'] = result.get('table_counts')
        meta['errors'] = result.get('errors')
        result_path = WORK / f'{run_id}-result.json'
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        meta['result_path'] = str(result_path)
        print(json.dumps({
            'run_id': run_id,
            'ok': result.get('ok'),
            'errors': result.get('errors'),
            'table_counts': result.get('table_counts'),
            'result_path': str(result_path),
        }, sort_keys=True))
        return 0 if result.get('ok') else 1
    finally:
        if not args.no_cleanup:
            try:
                meta['cleanup'] = cleanup_remote(run_id)
            except Exception as exc:
                meta['cleanup_error'] = f'{type(exc).__name__}: {exc}'
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + '\n', encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())
