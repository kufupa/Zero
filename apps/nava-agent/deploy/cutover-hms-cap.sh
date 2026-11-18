#!/usr/bin/env bash
set -euo pipefail
[[ ( $# == 1 && $1 == 4 ) || ( $# == 2 && $1 == 10 ) ]] || { echo 'usage: cutover-hms-cap.sh 4 | 10 PRIVATE_FIXTURE.json' >&2; exit 2; }
cap=$1
runtime=/home/ubuntu/.config/nava-agent/runtime.env
root=/home/ubuntu/.local/share/nava-agent/current
export PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin
cd "$root"
trap 'echo "cutover interrupted; inspect service state, then use cutover commands to restore cap 4" >&2' ERR
bash apps/nava-agent/deploy/drain-hms-cap.sh
for name in http remote-http worker ai-worker hms-ai-worker; do
  if pm2 describe "$name" >/dev/null 2>&1; then pm2 stop "$name" >/dev/null; fi
done
bash apps/nava-agent/deploy/set-hms-cap.sh "$cap"
env -i HOME=/home/ubuntu PATH="$PATH" USER=ubuntu node --env-file="$runtime" \
  ./apps/nava-agent/deploy/align-pilot-hms-cap.mjs "$cap"
if [[ $cap == 10 ]]; then
  if ! bash apps/nava-agent/deploy/set-hms-cap.sh verify "$2"; then
    bash apps/nava-agent/deploy/set-hms-cap.sh 4
    env -i HOME=/home/ubuntu PATH="$PATH" USER=ubuntu node --env-file="$runtime" \
      ./apps/nava-agent/deploy/align-pilot-hms-cap.mjs 4
    sudo -n systemctl start nava-agent@start.service nava-agent@worker.service
    echo 'verification failed; both caps restored to 4, pilot remains stopped' >&2
    exit 1
  fi
fi
sudo -n systemctl start nava-agent@start.service nava-agent@worker.service
api_pid=$(systemctl show nava-agent@start.service --property=MainPID --value)
worker_pid=$(systemctl show nava-agent@worker.service --property=MainPID --value)
python3 - "$api_pid" "$worker_pid" <<'PY'
import os, sys
from pathlib import Path
release = os.path.realpath('/home/ubuntu/.local/share/nava-agent/current')
for role, pid in zip(('main', 'worker'), sys.argv[1:]):
    path = Path('/proc') / str(int(pid))
    args = path.joinpath('cmdline').read_bytes().split(b'\0')
    if (b'--env-file=/home/ubuntu/.config/nava-agent/runtime.env' not in args or
            f'apps/nava-agent/src/{role}.ts'.encode() not in args or
            os.path.realpath(path / 'cwd') != release):
        raise SystemExit(f'{role} launcher mismatch')
print('api_worker_runtime=PASS')
PY
if [[ $cap == 10 ]]; then
  env -i HOME=/home/ubuntu PATH="$PATH" USER=ubuntu node --env-file="$runtime" \
    ./apps/nava-agent/deploy/check-hms-cap.mjs
fi
echo "nava_cap=$cap pilot=stopped restart_pilot_with=ops-restart.sh"
