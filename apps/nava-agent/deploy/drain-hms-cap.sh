#!/usr/bin/env bash
set -euo pipefail
runtime=/home/ubuntu/.config/nava-agent/runtime.env
root=/home/ubuntu/.local/share/nava-agent/current
[[ -f $runtime && ! -L $runtime && -O $runtime && $(stat -c %a "$runtime") == 600 ]] || { echo 'runtime permissions invalid' >&2; exit 2; }
cd "$root"
if systemctl is-active --quiet nava-agent@start.service; then sudo -n systemctl stop nava-agent@start.service; fi
if systemctl is-active --quiet nava-agent@worker.service; then
  echo 'intake=closed worker=draining'
  drained=false
  for ((attempt=1; attempt<=30; attempt++)); do
    if env -i HOME=/home/ubuntu PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin USER=ubuntu \
      node --env-file="$runtime" ./apps/nava-agent/deploy/check-hms-drain.mjs; then
      drained=true
      break
    fi
    sleep 10
  done
  [[ $drained == true ]] || { echo 'drain incomplete; API is stopped and worker remains active' >&2; exit 2; }
  sudo -n systemctl stop nava-agent@worker.service
fi
env -i HOME=/home/ubuntu PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin USER=ubuntu \
  node --env-file="$runtime" ./apps/nava-agent/deploy/check-hms-drain.mjs
echo 'intake=closed worker=stopped drain=complete'
