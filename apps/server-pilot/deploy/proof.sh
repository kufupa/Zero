#!/usr/bin/env bash
# VPS-side Labtest proof for one HMS workflow on the deployed box.
#   bash apps/server-pilot/deploy/proof.sh <workflow> <property> <sha> [--request <file>] [--no-ledger]
#
# create: census + unsaved Prepare, one Labtest Save, fresh readback.
# cancel: cancels the stay left by `proof.sh create` for the same property and sha, fresh readback.
# Each then installs `CANARY PASS <workflow> <property> <sha>` and its writers.json row
# (deploy/install-canary-ledger.mjs) unless --no-ledger is given.
# amend, attach, addons and guest_profile_create have no committed Labtest runner: PROOF UNSUPPORTED.
#
# The stages run on the box through ssm-run-command.sh (tooling/hms-cloud/labtest-proof.mjs).
# SSM stdout only carries short status lines; the journal and stage logs come back as a
# gzip archive in base64 chunks, checked against its sha256 before unpacking into
# ~/.local/share/zero/proofs/<sha>/<property>/<workflow>/. Screenshots stay on the box.
# The request defaults to tooling/hms-cloud/examples/labtest-proof-request.<property>.json;
# its dates are a preference, the census moves to the first free arrival.
# Last line: PROOF PASS|FAIL <workflow> <property> <sha> conf=<confirmation>. Exit 0 pass, 1 fail, 2 usage, 3 unsupported.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REMOTE_SERVER_PILOT=/home/ubuntu/repos/zero/apps/server-pilot
CHUNK_CHARS=16000

usage() {
  echo "usage: $0 <create|cancel|amend|attach|addons|guest_profile_create> <HRCEN|HRDAV|HRDAVS> <40-hex sha> [--request <file>] [--no-ledger]" >&2
  exit 2
}
[ "$#" -ge 3 ] || usage
WORKFLOW="$1"; PROPERTY="$2"; SHA="$3"; shift 3
REQUEST=""; LEDGER=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) [ "$#" -ge 2 ] || usage; REQUEST="$2"; shift 2 ;;
    --no-ledger) LEDGER=0; shift ;;
    *) usage ;;
  esac
done
case "$WORKFLOW" in
  create|cancel) ;;
  amend|attach|addons|guest_profile_create)
    echo "PROOF UNSUPPORTED $WORKFLOW: no committed Labtest Save and readback runner exists for it; only create and cancel are proven by tooling/hms-cloud/labtest-proof.mjs"
    exit 3
    ;;
  *) usage ;;
esac
[[ "$PROPERTY" =~ ^(HRCEN|HRDAV|HRDAVS)$ ]] || usage
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage

hold="${NAVA_RUN_HOLD_FILE:-/tmp/mh1024/HOLD.txt}"
if [ -f "$hold" ]; then
  echo "proof: refuse: HOLD file present ($hold)" >&2
  exit 2
fi

ARTIFACTS="${NAVA_PROOF_ARTIFACT_ROOT:-$HOME/.local/share/zero/proofs}/${SHA}/${PROPERTY}/${WORKFLOW}"
mkdir -p "$ARTIFACTS"
CONFIRMATION="-"

finish() {
  local verdict="$1" line
  line="PROOF ${verdict} ${WORKFLOW} ${PROPERTY} ${SHA} conf=${CONFIRMATION}"
  printf '%s\n' "$line" >"${ARTIFACTS}/result.txt"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >>"${ARTIFACTS}/results.log"
  printf '%s\n' "$line"
  [ "$verdict" = PASS ] && exit 0
  exit 1
}

# Runs one script on the box. Sets REMOTE_STDOUT; stderr and the raw SSM envelope go to the artifact log.
remote() {
  local label="$1" script="$2" response rc=0
  response="$(SSM_EXECUTION_TIMEOUT_SECONDS="${PROOF_STAGE_TIMEOUT_SECONDS:-1800}" \
    SSM_MAX_POLL_SECONDS="$(( ${PROOF_STAGE_TIMEOUT_SECONDS:-1800} + 120 ))" \
    bash "${SCRIPT_DIR}/ssm-run-command.sh" "$script")" || rc=$?
  REMOTE_STDOUT="$(node -e '
    let envelope = {};
    try { envelope = JSON.parse(process.argv[1]); } catch { /* A missing envelope is an SSM failure. */ }
    process.stderr.write(`${process.argv[2]}: ssm status=${envelope.Status ?? "none"} code=${envelope.ResponseCode ?? "none"}\n`);
    if (envelope.Stderr) process.stderr.write(`${String(envelope.Stderr).trimEnd()}\n`);
    process.stdout.write(String(envelope.Stdout ?? ""));
  ' "$response" "$label" 2>>"${ARTIFACTS}/proof.log")"
  return "$rc"
}

# Shared head of every remote script: exact checkout, no PM2 leftovers, private files.
REMOTE_HEAD="set -euo pipefail
umask 077
unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID pm_id pm_exec_path
export NVM_DIR=/home/ubuntu/.nvm
[ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
cd ${REMOTE_SERVER_PILOT}
[ \"\$(git rev-parse --verify 'HEAD^{commit}')\" = ${SHA} ] || { echo 'proof: box checkout is not ${SHA}' >&2; exit 20; }
STATE=\"\$HOME/.local/state/nava-labtest-proof\"
RUN=\"\$STATE/${SHA}\"
REQUEST_FILE=\"\$STATE/requests/${PROPERTY}-${SHA}.json\"
mkdir -p \"\$RUN\" \"\$STATE/requests\"
"

run_stage() {
  local stage="$1" upload="" keep="" line
  if [ "$stage" = prepare ]; then
    # A refused prepare must not replace the request an earlier created stay is bound to.
    upload="REQUEST_FILE=\"\$REQUEST_FILE.next\"
printf '%s' '$(base64 -w0 "$REQUEST")' | base64 -d >\"\$REQUEST_FILE\""
    keep="[ \"\$rc\" != 0 ] || mv -f \"\$REQUEST_FILE\" \"\${REQUEST_FILE%.next}\""
  fi
  remote "$stage" "${REMOTE_HEAD}${upload}
[ -f \"\$REQUEST_FILE\" ] || { echo 'proof: no request on the box; run proof.sh create first' >&2; exit 20; }
ENV_FILE=${REMOTE_SERVER_PILOT}/.env.production
[ -f \"\$ENV_FILE\" ] || ENV_FILE=/home/ubuntu/.env.production
set -a
. \"\$ENV_FILE\"
set +a
export NAVA_BUILD_COMMIT=${SHA} NODE_EXTRA_CA_CERTS=${REMOTE_SERVER_PILOT}/deploy/rds-ca-global.pem
rc=0
node tooling/hms-cloud/labtest-proof.mjs --stage ${stage} --property ${PROPERTY} --expected-sha ${SHA} \\
  --request \"\$REQUEST_FILE\" --state-dir \"\$STATE\" >\"\$RUN/${PROPERTY}-${stage}.out\" 2>\"\$RUN/${PROPERTY}-${stage}.err\" || rc=\$?
${keep}
tail -c 1500 \"\$RUN/${PROPERTY}-${stage}.err\" >&2
tail -n 2 \"\$RUN/${PROPERTY}-${stage}.out\" | cut -c1-2000
exit \"\$rc\"" || true
  printf '%s\n' "$REMOTE_STDOUT" >>"${ARTIFACTS}/proof.log"
  line="$(printf '%s\n' "$REMOTE_STDOUT" | grep -E "^PROOF (PASS|FAIL) ${stage} ${PROPERTY} ${SHA} conf=[0-9-]+$" | tail -n 1 || true)"
  case "$line" in
    *conf=-) ;;
    ?*) CONFIRMATION="${line##*conf=}" ;;
  esac
  case "$line" in
    "PROOF PASS "*) return 0 ;;
  esac
  echo "proof: stage ${stage} did not pass; see ${ARTIFACTS}/proof.log" >&2
  return 1
}

# Journal and stage logs: packed on the box, pulled in checked chunks, never as raw SSM stdout.
fetch_artifacts() {
  local meta digest chars index=0 encoded="${ARTIFACTS}/.transfer.b64"
  remote pack "${REMOTE_HEAD}cd \"\$RUN\"
files=\"\$(ls ${PROPERTY}-journal.json ${PROPERTY}-prepare.out ${PROPERTY}-prepare.err ${PROPERTY}-create.out ${PROPERTY}-create.err ${PROPERTY}-cancel.out ${PROPERTY}-cancel.err 2>/dev/null || true)\"
[ -n \"\$files\" ] || { echo 'proof: nothing to fetch' >&2; exit 20; }
tar -czf .transfer-${PROPERTY}.tgz \$files
base64 -w0 .transfer-${PROPERTY}.tgz >.transfer-${PROPERTY}.b64
printf 'PROOF_TRANSFER %s %s\n' \"\$(sha256sum <.transfer-${PROPERTY}.tgz | cut -d' ' -f1)\" \"\$(stat -c %s .transfer-${PROPERTY}.b64)\"" || return 1
  meta="$(printf '%s\n' "$REMOTE_STDOUT" | grep -E '^PROOF_TRANSFER [0-9a-f]{64} [0-9]+$' | tail -n 1 || true)"
  [ -n "$meta" ] || return 1
  digest="$(printf '%s' "$meta" | cut -d' ' -f2)"
  chars="$(printf '%s' "$meta" | cut -d' ' -f3)"
  : >"$encoded"
  while [ $(( index * CHUNK_CHARS )) -lt "$chars" ]; do
    remote "chunk-${index}" "${REMOTE_HEAD}printf 'PROOF_CHUNK ${index} %s\n' \"\$(dd if=\"\$RUN/.transfer-${PROPERTY}.b64\" bs=${CHUNK_CHARS} skip=${index} count=1 status=none)\"" || return 1
    printf '%s\n' "$REMOTE_STDOUT" | sed -n "s/^PROOF_CHUNK ${index} \([A-Za-z0-9+\/=]*\)$/\1/p" | tr -d '\n' >>"$encoded"
    index=$(( index + 1 ))
  done
  [ "$(stat -c %s "$encoded")" = "$chars" ] || return 1
  base64 -d "$encoded" >"${ARTIFACTS}/.transfer.tgz" || return 1
  [ "$(sha256sum <"${ARTIFACTS}/.transfer.tgz" | cut -d' ' -f1)" = "$digest" ] || return 1
  tar -xzf "${ARTIFACTS}/.transfer.tgz" -C "$ARTIFACTS" --no-same-owner || return 1
  rm -f "$encoded" "${ARTIFACTS}/.transfer.tgz"
  remote cleanup "${REMOTE_HEAD}rm -f \"\$RUN/.transfer-${PROPERTY}.tgz\" \"\$RUN/.transfer-${PROPERTY}.b64\"" || true
}

install_ledger() {
  remote ledger "${REMOTE_HEAD}rc=0
sudo -n env \"PATH=\$PATH\" node deploy/install-canary-ledger.mjs --expected-sha ${SHA} --property ${PROPERTY} \\
  --workflow ${WORKFLOW} --state-dir \"\$STATE\" >\"\$RUN/${PROPERTY}-ledger-${WORKFLOW}.out\" 2>\"\$RUN/${PROPERTY}-ledger-${WORKFLOW}.err\" || rc=\$?
tail -c 1500 \"\$RUN/${PROPERTY}-ledger-${WORKFLOW}.err\" >&2
tail -n 1 \"\$RUN/${PROPERTY}-ledger-${WORKFLOW}.out\" | cut -c1-2000
exit \"\$rc\"" || { printf '%s\n' "$REMOTE_STDOUT" >>"${ARTIFACTS}/proof.log"; return 1; }
  printf '%s\n' "$REMOTE_STDOUT" | tee -a "${ARTIFACTS}/proof.log" >"${ARTIFACTS}/ledger.json"
  grep -q '"status":"installed"' "${ARTIFACTS}/ledger.json"
}

passed=1
if [ "$WORKFLOW" = create ]; then
  REQUEST="${REQUEST:-${SERVER_PILOT}/tooling/hms-cloud/examples/labtest-proof-request.${PROPERTY}.json}"
  if [ ! -f "$REQUEST" ]; then
    echo "proof: no request file for ${PROPERTY}; pass --request <file> (see examples/labtest-proof-request.HRCEN.json)" >&2
    finish FAIL
  fi
  cp "$REQUEST" "${ARTIFACTS}/request.json"
  run_stage prepare && run_stage create || passed=0
else
  run_stage cancel || passed=0
fi
fetch_artifacts || echo "proof: artifact fetch failed; journal remains on the box under ~/.local/state/nava-labtest-proof/${SHA}" >&2
[ "$passed" = 1 ] || finish FAIL
if [ "$LEDGER" = 1 ]; then
  install_ledger || { echo "proof: ledger install refused; see ${ARTIFACTS}/proof.log" >&2; finish FAIL; }
fi
if [ "$WORKFLOW" = create ]; then
  echo "proof: Labtest stay ${CONFIRMATION} is still reserved; clean up with: $0 cancel ${PROPERTY} ${SHA}" >&2
fi
finish PASS
