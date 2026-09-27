#!/usr/bin/env bash
# Idempotent Gotenberg LibreOffice sidecar on the pilot EC2.
# Bind 127.0.0.1 only. Never rewrite .env.production — append GOTENBERG_URL if missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="${SCRIPT_DIR}/gotenberg.compose.yaml"
INSTALL_DIR=/opt/nava/gotenberg
ENV_PATH="${ENV_PATH:-/home/ubuntu/repos/zero/apps/server-pilot/.env.production}"
MIN_FREE_KB=4194304
GOTENBERG_URL_VALUE='http://127.0.0.1:3000'

if [ ! -f "$COMPOSE_SRC" ]; then
  echo "missing $COMPOSE_SRC" >&2
  exit 1
fi

avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ -z "$avail_kb" ] || [ "$avail_kb" -lt "$MIN_FREE_KB" ]; then
  echo "gotenberg install: need 4G free on / (have ${avail_kb:-unknown}K)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y docker.io docker-compose-v2
fi

if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart docker
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker
fi

mkdir -p "$INSTALL_DIR"
cp -f "$COMPOSE_SRC" "${INSTALL_DIR}/gotenberg.compose.yaml"
chmod 644 "${INSTALL_DIR}/gotenberg.compose.yaml"

docker compose -f "${INSTALL_DIR}/gotenberg.compose.yaml" up -d

health_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl --disable --noproxy '*' -fsS "${GOTENBERG_URL_VALUE}/health" >/dev/null; then
    health_ok=1
    break
  fi
  sleep 5
done
if [ "$health_ok" -ne 1 ]; then
  echo "gotenberg /health failed at ${GOTENBERG_URL_VALUE}" >&2
  exit 1
fi

if [ -f "$ENV_PATH" ] && ! grep -q '^GOTENBERG_URL=' "$ENV_PATH"; then
  printf "GOTENBERG_URL='%s'\n" "$GOTENBERG_URL_VALUE" >> "$ENV_PATH"
fi

echo "gotenberg install ok ${GOTENBERG_URL_VALUE}"
