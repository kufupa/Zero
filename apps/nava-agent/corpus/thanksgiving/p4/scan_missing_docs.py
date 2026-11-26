#!/usr/bin/env python3
"""Scan a small missing-PDF list on EC2 and download doc-text patch rows."""
import argparse
import base64
import json
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_snapshot

P4_DIR = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    started = time.time()
    run_id = 'p4patch-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
    run_id = re.sub(r'[^A-Za-z0-9_.-]', '-', run_id)
    remote_root = f'/tmp/{run_id}'
    scratch_key = f'p4-scratch/snapshot/{run_id}/doc-text-patch.jsonl.gz'
    script_b64 = base64.b64encode((P4_DIR / 'remote_pdf_scan.mjs').read_bytes()).decode('ascii')
    input_b64 = base64.b64encode(args.input.read_bytes()).decode('ascii')
    cmd = f"""set -u
umask 077
mkdir -p {remote_root}
printf '%s' '{script_b64}' | base64 -d > {remote_root}/remote_pdf_scan.mjs
printf '%s' '{input_b64}' | base64 -d > {remote_root}/missing.json
export NVM_DIR=/home/ubuntu/.nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/ubuntu/repos/zero/apps/server-pilot || exit 20
set -a
source .env.production
set +a
export AWS_REGION="${{AWS_REGION:-af-south-1}}"
node {remote_root}/remote_pdf_scan.mjs --input {remote_root}/missing.json --work {remote_root} --workers {args.workers} > {remote_root}/scan.log 2> {remote_root}/scan.err
rc=$?
cat {remote_root}/scan.log 2>/dev/null
if [ "$rc" -ne 0 ]; then tail -n 20 {remote_root}/scan.err 2>/dev/null; exit "$rc"; fi
python3 - <<'PY'
import json, os, subprocess
bucket=os.environ.get('S3_BUCKET')
key={scratch_key!r}
path={remote_root!r} + '/doc-text-patch.jsonl.gz'
result={{'ok':False,'bucket':bucket,'key':key}}
if bucket and os.path.exists(path):
 proc=subprocess.run(['aws','s3','cp',path,'s3://'+bucket+'/'+key,'--only-show-errors'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=600)
 result['rc']=proc.returncode
 result['ok']=proc.returncode==0
 if proc.returncode: result['error']=proc.stderr[-250:]
print('P4_PATCH_UPLOAD_JSON '+json.dumps(result,sort_keys=True))
PY
"""
    result = export_snapshot.require_ok(export_snapshot.run_ssm(cmd, 'patch-scan', timeout=1200, execution_timeout=1100))
    stats = export_snapshot.parse_marker(result['stdout'], 'P4_PATCH_SCAN_JSON')
    upload = export_snapshot.parse_marker(result['stdout'], 'P4_PATCH_UPLOAD_JSON')
    if not stats or not upload or not upload.get('ok'):
        raise RuntimeError('patch scan/upload failed: ' + result['stdout'][-800:])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    export_snapshot.download_from_s3(upload['bucket'], upload['key'], args.out)
    cleanup = export_snapshot.cleanup_scratch(upload['bucket'], [upload['key']])
    cleanup_cmd = (
        f"rm -f {remote_root}/remote_pdf_scan.mjs {remote_root}/missing.json "
        f"{remote_root}/doc-text-patch.jsonl.gz {remote_root}/scan.log {remote_root}/scan.err "
        f"{remote_root}/pdf-*.bin 2>/dev/null; rmdir {remote_root} 2>/dev/null || true"
    )
    cleanup_result = export_snapshot.run_ssm(cleanup_cmd, 'patch-remote-cleanup', timeout=120, execution_timeout=90)
    remote_cleanup = {'ok': cleanup_result.get('ok'), 'status': cleanup_result.get('status')}
    print('P4_PATCH_FETCH_JSON ' + json.dumps({
        'out': str(args.out),
        'bytes': args.out.stat().st_size,
        'stats': stats,
        'scratch_cleanup': cleanup,
        'remote_cleanup': remote_cleanup,
        'wall_s': round(time.time() - started, 3),
    }, sort_keys=True))


if __name__ == '__main__':
    main()
