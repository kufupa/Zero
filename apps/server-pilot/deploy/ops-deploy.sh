#!/usr/bin/env bash
# Laptop entrypoint: ship new code to pilot EC2 (sync → optional migrate → deploy → health).
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DO_MIGRATE=0
QUIESCED=0
ALLOW_ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --migrate) DO_MIGRATE=1 ;;
    --quiesced) QUIESCED=1 ;;
    --allow-rollback) ALLOW_ROLLBACK=1 ;;
    -h|--help)
      echo "usage: $0 [--migrate] [--quiesced] [--allow-rollback]"
      echo "  sync git bundle → optional db:migrate → deploy-ec2.sh → health"
      echo "  --quiesced: assets only (no PM2/health); online pm2 http OK; VPN assert retained"
      echo "  --allow-rollback: forward to bundle sync (override ancestor/unverified SHA refuse)"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg (try --migrate / --quiesced / --allow-rollback)" >&2
      exit 2
      ;;
  esac
done

echo "== ops-deploy: sync bundle (prints shipping SHA and EC2 SHA) =="
if [ "$ALLOW_ROLLBACK" -eq 1 ]; then
  bash "${SCRIPT_DIR}/sync-ec2-git-bundle.sh" --allow-rollback
else
  bash "${SCRIPT_DIR}/sync-ec2-git-bundle.sh"
fi

REMOTE_NVM='export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"'

# Every on-box pnpm install runs husky's prepare, which fails with EACCES while .husky/_/h is mode 0444.
# Restore the owner write bit before the first install. A missing hook is skipped.
# See docs/solutions/workflow-issues/ec2-deploy-husky-prepare-eacces-readonly-hook.md
echo "== ops-deploy: restore husky hook write bit =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'hook=/home/ubuntu/repos/zero/.husky/_/h; if [ -e "$hook" ]; then chmod u+w "$hook"; fi'

echo "== ops-deploy: install dependencies before migration check =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && pnpm install --frozen-lockfile"

if [ "$DO_MIGRATE" -eq 1 ]; then
  echo "== ops-deploy: migrate =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: verify database before remote env bootstrap =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/check-migration-compatibility.sh"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: bootstrap isolated remote env when absent =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && \
      if [ ! -e apps/server-pilot/.env.remote-common ] && [ ! -e apps/server-pilot/.env.remote-admin ]; then \
        bash apps/server-pilot/deploy/write-ec2-remote-env.sh; \
      elif [ ! -f apps/server-pilot/.env.remote-common ] || [ ! -f apps/server-pilot/.env.remote-admin ]; then \
        echo 'remote HTTP env files must both exist or both be bootstrapped' >&2; exit 20; \
      fi"
fi

if [ "$QUIESCED" = "1" ]; then
  echo "== ops-deploy: on-box quiesced deploy (no PM2 / no HTTP health) =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh --quiesced"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: on-box deploy =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh"

  echo "== ops-deploy: health =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    'curl -fsS http://127.0.0.1:8788/health && curl -fsS http://127.0.0.1:8789/health && curl --disable --noproxy "*" -fsS --connect-to "nava-admin.trynava.io:8443:172.31.12.112:8443" -H "Host: nava-admin.trynava.io" "http://nava-admin.trynava.io:8443/" >/dev/null'

  echo "== ops-deploy: remote-admin lifecycle readiness =="
  echo "== ops-deploy: read last-good deploy marker =="
  # A failed SSM read must not stop the deploy: the empty result falls back to the 24-hour window below.
  LAST_GOOD_DEPLOY_SSM_RESULT="$(
    bash "${SCRIPT_DIR}/ssm-run-command.sh" \
      'marker=/home/ubuntu/.nava-deploy/last-good.json
       if [ -r "$marker" ]; then
         marker_b64="$(base64 -w0 "$marker" 2>/dev/null || true)"
         printf "NAVA_LAST_GOOD_DEPLOY_B64=%s\n" "$marker_b64"
       else
         printf "NAVA_LAST_GOOD_DEPLOY_B64=\n"
       fi'
  )" || LAST_GOOD_DEPLOY_SSM_RESULT=""
  LAST_GOOD_DEPLOY_AT="$(
    node - "$LAST_GOOD_DEPLOY_SSM_RESULT" <<'NODE' || true
const prefix = "NAVA_LAST_GOOD_DEPLOY_B64=";
try {
  const invocation = JSON.parse(process.argv[2] || "");
  const line = String(invocation.Stdout ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) process.exit(1);
  const marker = JSON.parse(Buffer.from(line.slice(prefix.length), "base64").toString("utf8"));
  // Shape only, passed through as-is. launch-readiness.sh validates the timestamp strictly before SQL binds it.
  if (typeof marker?.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(marker.at)) {
    process.exit(1);
  }
  process.stdout.write(marker.at);
} catch {
  process.exit(1);
}
NODE
  )"
  if [ -n "$LAST_GOOD_DEPLOY_AT" ]; then
    export LAST_GOOD_DEPLOY_AT
    echo "ops-deploy: last-good marker $LAST_GOOD_DEPLOY_AT passed to readiness; launch-readiness validates it and prints the effective window start"
  else
    unset LAST_GOOD_DEPLOY_AT
    echo "ops-deploy: last-good marker unavailable (missing, unreadable, or invalid); using 24-hour readiness window"
  fi
  # Boundary for the marker written after every gate passes: the EC2 host clock (the clock the workers and their dead
  # letters run on), read right before readiness queries the database, minus a 5-minute margin for clock skew and the
  # SSM round trip. The operator laptop clock is only a fallback, and it is pulled back 15 minutes to stay on the safe
  # side. An earlier boundary only counts more dead letters next time, which is the safe direction.
  READINESS_HOST_CLOCK_SSM_RESULT="$(
    bash "${SCRIPT_DIR}/ssm-run-command.sh" \
      'printf "NAVA_HOST_CLOCK_UTC=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"'
  )" || READINESS_HOST_CLOCK_SSM_RESULT=""
  READINESS_STARTED_AT="$(
    node - "$READINESS_HOST_CLOCK_SSM_RESULT" <<'NODE' || true
const prefix = "NAVA_HOST_CLOCK_UTC=";
const marginMs = 5 * 60 * 1000;
try {
  const invocation = JSON.parse(process.argv[2] || "");
  const line = String(invocation.Stdout ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) process.exit(1);
  const hostNow = line.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(hostNow)) process.exit(1);
  process.stdout.write(new Date(Date.parse(hostNow) - marginMs).toISOString().replace(/\.\d{3}Z$/, "Z"));
} catch {
  process.exit(1);
}
NODE
  )"
  if [ -z "$READINESS_STARTED_AT" ]; then
    READINESS_STARTED_AT="$(node -e 'process.stdout.write(new Date(Date.now() - 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"))')"
    echo "ops-deploy: host clock unavailable; readiness boundary uses the operator clock minus 15 minutes"
  fi
  REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"
fi

echo "== ops-deploy: VPN HARD assert =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'

# Phase B source+registry CAS (Task 13): when HMS_REGISTRY_CANDIDATE is set,
# invoke runSourceRegistryTransaction via source-registry-cas.sh.
# Crash injection: before/after_source_switch, before/after_registry_rename,
# before/after_pm2_restart, before/after_health_verdict (HMS_CAS_CRASH_AT).
# Incomplete restore → exit 20 and halt the live lane.
if [ -n "${HMS_REGISTRY_CANDIDATE:-}" ]; then
  echo "== ops-deploy: source+registry CAS (source-registry-transaction) =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && \
      export HMS_REGISTRY_CANDIDATE='${HMS_REGISTRY_CANDIDATE}' \
        HMS_SOURCE_REGISTRY_CURRENT='${HMS_SOURCE_REGISTRY_CURRENT:?}' \
        HMS_SOURCE_REGISTRY_CANDIDATE='${HMS_SOURCE_REGISTRY_CANDIDATE:?}' \
        HMS_CAS_CRASH_AT='${HMS_CAS_CRASH_AT:-}' && \
      bash apps/server-pilot/deploy/source-registry-cas.sh" || {
        status=$?
        if [ "$status" -eq 20 ]; then
          echo "ops-deploy: incomplete restore (exit 20) — halt live lane" >&2
          exit 20
        fi
        exit "$status"
      }
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: record last-good deploy marker =="
  # The SSM helper runs payloads as ubuntu, so the directory, temp file, and marker are ubuntu-owned.
  # The marker records the boundary taken before readiness (READINESS_STARTED_AT), not this write time. A dead letter
  # that lands between readiness and this write is then inside the next deploy's window.
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "readiness_started_at='${READINESS_STARTED_AT:?}'"'
     set -euo pipefail
     marker_dir=/home/ubuntu/.nava-deploy
     marker_path="$marker_dir/last-good.json"
     mkdir -p "$marker_dir"
     tmp="$(mktemp "$marker_dir/.last-good.json.XXXXXX")"
     cleanup() { if [ -n "${tmp:-}" ]; then rm -f "$tmp"; fi; }
     trap cleanup EXIT
     commit="$(git -C /home/ubuntu/repos/zero rev-parse HEAD)"
     case "$commit" in
       ""|*[!0-9a-f]*) echo "ops-deploy: deployed commit SHA is invalid" >&2; exit 1 ;;
     esac
     case "$readiness_started_at" in
       ????-??-??T??:??:??Z) ;;
       *) echo "ops-deploy: readiness boundary is invalid" >&2; exit 1 ;;
     esac
     at="$readiness_started_at"
     printf "{\"commit\":\"%s\",\"at\":\"%s\"}\n" "$commit" "$at" >"$tmp"
     mv -f "$tmp" "$marker_path"
     tmp=""
     trap - EXIT'
fi

echo "ops-deploy ok"
