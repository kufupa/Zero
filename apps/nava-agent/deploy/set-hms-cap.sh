#!/usr/bin/env bash
set -euo pipefail
[[ ( $# == 1 && ( $1 == 4 || $1 == 10 ) ) || ( $# == 2 && $1 == verify ) ]] || { echo 'usage: set-hms-cap.sh 4|10 | verify PRIVATE_FIXTURE.json' >&2; exit 2; }
target=$1
runtime=/home/ubuntu/.config/nava-agent/runtime.env
root=/home/ubuntu/.local/share/nava-agent/current
[[ -f $runtime && ! -L $runtime && -O $runtime && $(stat -c %a "$runtime") == 600 ]] || { echo 'runtime permissions invalid' >&2; exit 2; }
for unit in start worker; do
  ! systemctl is-active --quiet "nava-agent@$unit.service" || { echo "$unit is still active" >&2; exit 2; }
done
cd "$root"
env -i HOME=/home/ubuntu PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin USER=ubuntu \
  node --env-file="$runtime" ./apps/nava-agent/deploy/check-hms-drain.mjs
if [[ $target == verify ]]; then
  fixture=$2
  [[ -f $fixture && ! -L $fixture && -O $fixture && $(stat -c %a "$fixture") == 600 ]] || { echo 'fixture permissions invalid' >&2; exit 2; }
  verification_marker() {
    python3 - "$runtime" "$1" <<'PY'
import os, sys, tempfile
path, action = sys.argv[1:]
with open(path, encoding='utf-8') as f:
    lines = f.read().splitlines()
for key in ('NAVA_HMS_SLOTS', 'HMS_CREDENTIAL_SESSION_CAP'):
    values = [line.partition('=')[2] for line in lines if line.partition('=')[0] == key]
    if values != ['10']: raise SystemExit('verification requires both caps at 10')
lines = [line for line in lines if line.partition('=')[0] != 'NAVA_HMS_VERIFIED_CAP']
if action == 'set': lines.append('NAVA_HMS_VERIFIED_CAP=10')
fd, temp = tempfile.mkstemp(prefix='.runtime-hms-verified-', dir=os.path.dirname(path))
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)
finally:
    if os.path.exists(temp): os.unlink(temp)
PY
  }
  verification_marker clear
  env -i HOME=/home/ubuntu PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin USER=ubuntu \
    node --env-file="$runtime" --import ./apps/nava-agent/node_modules/tsx/dist/loader.mjs \
    ./apps/nava-agent/deploy/verify-hms-cap.mjs "$fixture"
  verification_marker set
  echo 'runtime_verified_cap=10'
  exit 0
fi
python3 - "$runtime" "$target" <<'PY'
import os, sys, tempfile, time
path, target = sys.argv[1:]
with open(path, encoding='utf-8') as f:
    original = f.read()
lines = original.splitlines()
keys = ('NAVA_HMS_SLOTS', 'HMS_CREDENTIAL_SESSION_CAP')
values = {}
for key in keys:
    matches = [line.partition('=')[2] for line in lines if line.partition('=')[0] == key]
    if len(matches) != 1 or matches[0] not in ('4', '10'):
        raise SystemExit('unexpected cap entry')
    values[key] = matches[0]
if values[keys[0]] != values[keys[1]]:
    raise SystemExit('worker and shared caps differ')
old = values[keys[0]]
if old == target:
    print(f'cap_unchanged={target}')
    raise SystemExit(0)
backup = f'{path}.before-hms-cap-{old}-to-{target}-{time.time_ns()}'
fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(original); f.flush(); os.fsync(f.fileno())
lines = [line for line in lines if line.partition('=')[0] not in (*keys, 'NAVA_HMS_VERIFIED_CAP')]
lines.extend(f'{key}={target}' for key in keys)
fd, temp = tempfile.mkstemp(prefix='.runtime-hms-cap-', dir=os.path.dirname(path))
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)
finally:
    if os.path.exists(temp): os.unlink(temp)
print(f'worker_cap={target} shared_cap={target} backup={backup}')
PY
