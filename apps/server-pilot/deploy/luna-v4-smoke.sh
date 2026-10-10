#!/usr/bin/env bash
# Luna v4 prod smoke, run from the dev VPS. Each step sends one remote script to EC2 through
# apps/server-pilot/deploy/ssm-run-command.sh (base64-encoded, so no quoting reaches SSM).
#
# Writes: analyseSelection (one model call and one cache file per sampled email; no sends) and,
# only with --with-quote, one staff quote (run and revision rows on the named thread).
# No HMS writes. Never run this from automation against prod.
#
#   luna-v4-smoke.sh [--dry-run] [--out DIR] [--ssm-root DIR]
#     [--with-quote --quote-message-id ID --quote-arrival YYYY-MM-DD --quote-departure YYYY-MM-DD]
#
# Output: a PASS, FAIL, NOT_DEPLOYED or SKIPPED line per step, and a JSON summary (mode 600).
# Exit: 0 when no step FAILs, 1 when one does, 2 on usage errors.
#
# Secrets: nothing from the environment is printed. Remote stderr is kept in a private file and
# never printed. Remote stdout is reduced on EC2 by jq before it reaches this host.
#
# Test-only: LUNA_SMOKE_STUB_BIN runs the same remote scripts on this host with stub commands
# on PATH (requires SMOKE_APP_DIR to name a non-prod app directory). No SSM call is made then.
set -uo pipefail

SSM_ROOT="${SSM_ROOT:-/home/ubuntu/projects/zero/.worktrees/recover-parse-failure}"
PROD_APP_DIR=/home/ubuntu/repos/zero/apps/server-pilot
OUT_DIR=""
DRY_RUN=0
WITH_QUOTE=0
QUOTE_MID=""
QUOTE_ARR=""
QUOTE_DEP=""

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

die_usage() {
  echo "usage error: $1" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --with-quote) WITH_QUOTE=1 ;;
    --quote-message-id) QUOTE_MID="${2:-}"; shift ;;
    --quote-arrival) QUOTE_ARR="${2:-}"; shift ;;
    --quote-departure) QUOTE_DEP="${2:-}"; shift ;;
    --out) OUT_DIR="${2:-}"; shift ;;
    --ssm-root) SSM_ROOT="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die_usage "unknown argument: $1" ;;
  esac
  shift
done

if [ "$WITH_QUOTE" = 1 ]; then
  printf '%s' "$QUOTE_MID" | grep -Eq '^[A-Za-z0-9._%+@:<>=!#-]{3,320}$' \
    || die_usage "--with-quote needs --quote-message-id (no default: the brief names no safe thread)"
  printf '%s' "$QUOTE_ARR" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
    || die_usage "--with-quote needs --quote-arrival YYYY-MM-DD"
  printf '%s' "$QUOTE_DEP" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
    || die_usage "--with-quote needs --quote-departure YYYY-MM-DD"
  [ "$QUOTE_ARR" != "$QUOTE_DEP" ] \
    && [ "$(printf '%s\n%s\n' "$QUOTE_ARR" "$QUOTE_DEP" | sort | head -1)" = "$QUOTE_ARR" ] \
    || die_usage "--quote-arrival must be before --quote-departure"
fi

SSM_RUN="$SSM_ROOT/apps/server-pilot/deploy/ssm-run-command.sh"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(date -u +%FT%TZ)"

MODE=live
if [ -n "${LUNA_SMOKE_STUB_BIN:-}" ]; then MODE=local-stub; fi
if [ "$DRY_RUN" = 1 ]; then MODE=dry-run; fi

if [ "$MODE" = local-stub ]; then
  [ -n "${SMOKE_APP_DIR:-}" ] && [ "$SMOKE_APP_DIR" != "$PROD_APP_DIR" ] && [ -d "$SMOKE_APP_DIR" ] \
    || { echo "local-stub mode needs SMOKE_APP_DIR set to a non-prod directory" >&2; exit 2; }
  [ -d "$LUNA_SMOKE_STUB_BIN" ] || { echo "LUNA_SMOKE_STUB_BIN is not a directory" >&2; exit 2; }
fi

if [ "$MODE" = live ]; then
  command -v jq >/dev/null 2>&1 || { echo "jq is required on this host" >&2; exit 2; }
  [ -f "$SSM_RUN" ] || { echo "ssm runner not found under --ssm-root" >&2; exit 2; }
fi

if [ -z "$OUT_DIR" ]; then OUT_DIR="$SSM_ROOT/.private/luna-v4-smoke"; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"
STEPS_NDJSON="$TMP/steps.ndjson"
ERR_LOG="$TMP/ssm-stderr.log"
: > "$STEPS_NDJSON"
: > "$ERR_LOG"

# ---- remote scripts ---------------------------------------------------------------------------
# Each prints one script. Remote stdout is kept small and secret-free: jq reduces responses on EC2.

remote_head() {
  cat <<'REMOTE'
umask 077
APP="${SMOKE_APP_DIR:-/home/ubuntu/repos/zero/apps/server-pilot}"
cd "$APP" || { echo '{"fatal":"app_dir_missing"}'; exit 0; }
. ~/.nvm/nvm.sh >/dev/null 2>&1 || true
REMOTE
}

# Base variables come after the env file, so an env entry cannot shadow them (as in the brief).
remote_base_vars() {
  cat <<'REMOTE'
B=https://nava.legacyhotels.co.za
RS="--resolve nava.legacyhotels.co.za:443:127.0.0.1"
J="$(mktemp)"
cleanup() { rm -f "$J" "$J".*; }
trap cleanup EXIT
REMOTE
}

remote_prelude() {
  remote_head
  remote_base_vars
}

remote_env_prelude() {
  remote_head
  cat <<'REMOTE'
set -a
. ./.env.production
set +a
REMOTE
  remote_base_vars
}

remote_login() {
  cat <<'REMOTE'
pw="$(aws secretsmanager get-secret-value --region af-south-1 --secret-id nava-zero/server-pilot/pilot-users --query SecretString --output text 2>/dev/null | jq -r '."navaai@legacyhotels.co.za" | if type=="string" then . else .password end' 2>/dev/null)"
jq -nc --arg p "$pw" '{email:"navaai@legacyhotels.co.za",password:$p}' > "$J.body"
pw=""
lc="$(curl -sS $RS -c "$J" -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data @"$J.body" "$B/api/auth/sign-in/email" 2>/dev/null)"
rm -f "$J.body"
echo "login_http=$lc"
REMOTE
}

script_step1() {
  remote_prelude
  cat <<'REMOTE'
H="$(curl -sS $RS -o "$J.h" -w '%{http_code}' "$B/health" 2>/dev/null)"
if grep -qi ok "$J.h" 2>/dev/null; then HOK=true; else HOK=false; fi
P="$(curl -sS $RS -o /dev/null -w '%{http_code}' "$B/outlook-pane" 2>/dev/null)"
HEADSHA="$(git -C /home/ubuntu/repos/zero rev-parse --short=12 HEAD 2>/dev/null)"
PM="$(pm2 jlist 2>/dev/null | jq -c '[.[] | {name, status: .pm2_env.status}]' 2>/dev/null)"
[ -n "$PM" ] || PM='[]'
curl -sS $RS "$B/outlook-pane" > "$J.pane" 2>/dev/null
grep -oE '/assets/[^"]+\.js' "$J.pane" | sort -u > "$J.assets"
: > "$J.bundle"
while read -r A; do curl -sS $RS "$B$A" >> "$J.bundle" 2>/dev/null; done < "$J.assets"
: > "$J.hits"
for S in 'Change to booking' 'See what Luna did in HMS' 'Find this booking in HMS' 'Create one reply with all date options'; do
  echo "$(grep -c -F "$S" "$J.bundle")|$S" >> "$J.hits"
done
NASSETS="$(wc -l < "$J.assets" | tr -d ' ')"
jq -nc --arg h "$H" --argjson hok "$HOK" --arg p "$P" --arg head "$HEADSHA" --argjson pm "$PM" \
  --argjson assets "$NASSETS" --rawfile hits "$J.hits" \
  '{http_health:$h,health_ok:$hok,pane:$p,head:$head,pm2:$pm,asset_bundles:$assets,
    hits:($hits|split("\n")|map(select(length>0)|split("|")|{hits:(.[0]|tonumber),text:.[1]}))}'
REMOTE
}

script_step2() {
  remote_env_prelude
  remote_login
  cat <<'REMOTE'
PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -q -At -c 'BEGIN READ ONLY; SELECT m.message_id_header FROM message m WHERE m.transport_id=$q$transport-centurion$q$ AND m.direction=$q$inbound$q$ AND m.message_id_header IS NOT NULL AND m.received_at>now()-interval $q$3 days$q$ AND m.thread_id IN (SELECT tc.thread_id FROM mail_thread_category tc JOIN mail_category c ON c.id=tc.category_id WHERE c.slug IN ($q$new-bookings$q$,$q$bookings$q$)) ORDER BY m.received_at DESC LIMIT 3; COMMIT;' > "$J.mids" 2>/dev/null || echo DB_PICK_FAILED
RED='{status:(.result.data.json.status // .error.json.data.code // "error"),source:(.result.data.json.source // null),workflow:(.result.data.json.workflow // null),amendment:(if ((.result.data.json.luna.flags // []) | index("amendment_or_cancel")) then "amendment_or_cancel" else "none" end)}'
i=0
while read -r MID; do
  i=$((i+1))
  BODY="$(jq -nc --arg m "$MID" '{json:{internetMessageId:$m,storeId:"s",entryId:"s",folderEntryId:"s",selectionEpoch:1}}')"
  C0="$(ls .private/luna-analyse-cache 2>/dev/null | wc -l)"
  R1="$(curl -sS --max-time 300 $RS -b "$J" -X POST -H 'content-type: application/json' -H 'x-zero-active-transport: transport-centurion' -d "$BODY" -o "$J.a1" -w '%{http_code} %{time_total}' "$B/api/trpc/quoteWorkflow.analyseSelection" 2>/dev/null)"
  C1="$(ls .private/luna-analyse-cache 2>/dev/null | wc -l)"
  R2="$(curl -sS --max-time 300 $RS -b "$J" -X POST -H 'content-type: application/json' -H 'x-zero-active-transport: transport-centurion' -d "$BODY" -o "$J.a2" -w '%{http_code} %{time_total}' "$B/api/trpc/quoteWorkflow.analyseSelection" 2>/dev/null)"
  C2="$(ls .private/luna-analyse-cache 2>/dev/null | wc -l)"
  S1="$(jq -c "$RED" "$J.a1" 2>/dev/null)"; [ -n "$S1" ] || S1='{}'
  S2="$(jq -c "$RED" "$J.a2" 2>/dev/null)"; [ -n "$S2" ] || S2='{}'
  printf '{"n":%s,"c1":{"http":"%s","sec":%s,"writes":%s,"r":%s},"c2":{"http":"%s","sec":%s,"writes":%s,"r":%s}}\n' \
    "$i" "${R1%% *}" "${R1##* }" "$((C1-C0))" "$S1" "${R2%% *}" "${R2##* }" "$((C2-C1))" "$S2"
done < "$J.mids"
REMOTE
}

script_step3() {
  remote_prelude
  cat <<'REMOTE'
pm2 logs ai-worker --nostream --lines 3000 > "$J.log" 2>/dev/null
OK="$(grep -c luna_warm_ok "$J.log")"
SKIP="$(grep -c luna_warm_skip "$J.log")"
FAILED="$(grep -c luna_warm_failed "$J.log")"
SINCE="$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="ai-worker") | (.pm2_env.pm_uptime / 1000 | todate)' 2>/dev/null)"
echo "ok=$OK skip=$SKIP failed=$FAILED since=$SINCE"
REMOTE
}

script_step4() {
  # Operator-validated values only (see the argument checks above): no quotes can reach here.
  printf "MID='%s'\nARR='%s'\nDEP='%s'\n" "$QUOTE_MID" "$QUOTE_ARR" "$QUOTE_DEP"
  remote_env_prelude
  remote_login
  cat <<'REMOTE'
SB="$(jq -nc --arg m "$MID" '{json:{internetMessageId:$m}}')"
SRC="$(curl -sS --max-time 120 $RS -b "$J" -G -H 'x-zero-active-transport: transport-centurion' --data-urlencode "input=$SB" -o "$J.s" -w '%{http_code}' "$B/api/trpc/workstation.staffQuoteSource" 2>/dev/null)"
SST="$(jq -r '.result.data.json.status // .error.json.data.code // "error"' "$J.s" 2>/dev/null)"
MSG="$(jq -r '.result.data.json.messageId // empty' "$J.s" 2>/dev/null)"
SH="$(jq -r '.result.data.json.sourceHash // empty' "$J.s" 2>/dev/null)"
EB="$(jq -nc --arg m "$MSG" --arg sh "$SH" --arg a "$ARR" --arg d "$DEP" '{json:{messageId:$m,sourceHash:$sh,selectionEpoch:1,inputRevision:1,groups:[{id:"group-1",arrivalDate:$a,departureDate:$d,quantity:1,adults:2,board:"bb"}],salesStrategy:"BAR"}}')"
EX="$(curl -sS --max-time 1300 $RS -b "$J" -X POST -H 'content-type: application/json' -H 'x-zero-active-transport: transport-centurion' -d "$EB" -o "$J.e" -w '%{http_code} %{time_total}' "$B/api/trpc/workstation.executeStaffQuote" 2>/dev/null)"
EST="$(jq -r '.result.data.json.status // .error.json.data.code // "error"' "$J.e" 2>/dev/null)"
WRI="$(jq -r '.result.data.json.workflowRunId // empty' "$J.e" 2>/dev/null)"
REV="$(jq -r '.result.data.json.revisionRef // empty' "$J.e" 2>/dev/null)"
TE="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -q -At -c 'BEGIN READ ONLY; SELECT email FROM mailbox_transport WHERE id=$q$transport-centurion$q$; COMMIT;' 2>/dev/null | head -1)"
PB="$(jq -nc --arg w "$WRI" --arg r "$REV" --arg m "$MSG" --arg e "$TE" '{json:{workflowRunId:$w,revisionRef:$r,messageId:$m,outlookEmail:$e,factRefs:[],agency:"Quote"}}')"
PX="$(curl -sS --max-time 300 $RS -b "$J" -X POST -H 'content-type: application/json' -H 'x-zero-active-transport: transport-centurion' -d "$PB" -o "$J.p" -w '%{http_code} %{time_total}' "$B/api/trpc/workstation.qualifiedQuoteProposalPdf" 2>/dev/null)"
PST="$(jq -r '.result.data.json.status // .error.json.data.code // "error"' "$J.p" 2>/dev/null)"
jq -r '.result.data.json.pdfBase64 // empty' "$J.p" 2>/dev/null | base64 -d > "$J.pdf" 2>/dev/null
PBYTES="$(wc -c < "$J.pdf" 2>/dev/null | tr -d ' ')"
if [ "$(head -c 4 "$J.pdf" 2>/dev/null)" = '%PDF' ]; then PMOK=true; else PMOK=false; fi
SRH="$(printf '%s' "$SRC" | cut -d' ' -f1)"
EXH="$(printf '%s' "$EX" | cut -d' ' -f1)"
EXE="$(printf '%s' "$EX" | cut -d' ' -f2)"
PXH="$(printf '%s' "$PX" | cut -d' ' -f1)"
PXE="$(printf '%s' "$PX" | cut -d' ' -f2)"
jq -nc --arg ss "$SST" --arg sh "$SRH" --arg eh "$EXH" --arg ee "${EXE:-0}" --arg es "$EST" \
  --arg ph "$PXH" --arg pe "${PXE:-0}" --arg ps "$PST" --argjson pb "${PBYTES:-0}" --argjson mo "$PMOK" \
  '{staff_source:$ss,source_http:$sh,execute_http:$eh,execute_sec:($ee|tonumber),execute_status:$es,pdf_http:$ph,pdf_sec:($pe|tonumber),pdf_status:$ps,pdf_bytes:$pb,pdf_magic_ok:$mo}'
REMOTE
}

# ---- execution helpers ------------------------------------------------------------------------

# ssm_call LABEL TIMEOUT_SECONDS SCRIPT_FN: sets CALL_OK (1/0) and CALL_STDOUT.
ssm_call() {
  local label="$1" timeout="$2" script_fn="$3" script b64 cmd raw line rc resp
  script="$("$script_fn")"
  b64="$(printf '%s\n' "$script" | base64 -w0)"
  cmd="echo $b64 | base64 -d | bash"
  CALL_OK=0
  CALL_STDOUT=""
  if [ "$DRY_RUN" = 1 ]; then
    printf '\nDRY-RUN %s (SSM_EXECUTION_TIMEOUT_SECONDS=%s): would run on EC2 via %s\n' \
      "$label" "$timeout" "apps/server-pilot/deploy/ssm-run-command.sh"
    printf -- '--- remote script ---\n%s\n--- end remote script ---\n' "$script"
    return 0
  fi
  if [ "$MODE" = local-stub ]; then
    raw="$(env -u DATABASE_URL PATH="$LUNA_SMOKE_STUB_BIN:$PATH" bash -c "$cmd" 2>>"$ERR_LOG")"
    rc=$?
    raw="$(jq -nc --arg out "$raw" --argjson rc "$rc" \
      '{Status:"Success",ResponseCode:(if $rc==0 then 0 else 1 end),StatusDetails:"Success",Stdout:$out,Stderr:""}')"
  else
    raw="$(cd "$SSM_ROOT" && SSM_EXECUTION_TIMEOUT_SECONDS="$timeout" bash apps/server-pilot/deploy/ssm-run-command.sh "$cmd" 2>>"$ERR_LOG")"
    rc=$?
  fi
  line="$(printf '%s\n' "$raw" | grep -E '^\{"Status"' | tail -1)"
  if [ "$rc" -ne 0 ] || [ -z "$line" ]; then
    return 0
  fi
  resp="$(printf '%s' "$line" | jq -r '.ResponseCode // ""' 2>/dev/null)"
  if [ "$resp" != "0" ]; then
    return 0
  fi
  CALL_STDOUT="$(printf '%s' "$line" | jq -r '.Stdout // ""' 2>/dev/null)"
  CALL_OK=1
}

# record_step ID NAME STATUS REASON DETAIL_JSON: appends to the summary and prints one line.
record_step() {
  local id="$1" name="$2" status="$3" reason="$4" detail="$5"
  jq -nc --arg id "$id" --arg name "$name" --arg status "$status" --arg reason "$reason" \
    --argjson detail "$detail" '{id:$id,name:$name,status:$status,reason:$reason,detail:$detail}' \
    >> "$STEPS_NDJSON"
  printf 'STEP %s %s: %s%s\n' "$id" "$name" "$status" "${reason:+ ($reason)}"
}

# ---- steps ------------------------------------------------------------------------------------

step1() {
  ssm_call step1 900 script_step1
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$CALL_OK" != 1 ]; then
    record_step 1 health_pane_pm2_assets FAIL "ssm call failed" '{}'; return 0
  fi
  local evalr ok missing reason status
  evalr="$(printf '%s' "$CALL_STDOUT" | jq -c '
    {
      health: ((.http_health=="200") and (.health_ok==true)),
      pane: (.pane=="200"),
      head: ((.head // "") != ""),
      pm2_core_online: (([.pm2[] | select(.name=="http" or .name=="remote-http" or .name=="worker" or .name=="ai-worker") | select(.status=="online")] | length) == 4),
      hms_ai_worker: (([.pm2[] | select(.name=="hms-ai-worker") | .status] | .[0]) // "absent"),
      head_short: (.head // ""),
      asset_bundles: .asset_bundles,
      strings: [.hits[] | {text, hits}],
      missing: [.hits[] | select(.hits==0) | .text]
    }' 2>/dev/null)"
  if [ -z "$evalr" ]; then
    record_step 1 health_pane_pm2_assets FAIL "unreadable step 1 output" '{}'; return 0
  fi
  ok="$(printf '%s' "$evalr" | jq -r '.health and .pane and .head and .pm2_core_online')"
  missing="$(printf '%s' "$evalr" | jq -r '.missing | join(", ")')"
  if [ "$ok" != "true" ]; then
    reason="$(printf '%s' "$evalr" | jq -r '[(if .health then empty else "health" end), (if .pane then empty else "pane" end), (if .head then empty else "git head" end), (if .pm2_core_online then empty else "pm2 core not online" end)] | "failed: " + join(", ")')"
    status=FAIL
  elif [ -n "$missing" ]; then
    reason="not in the bundle, so not deployed: $missing"
    status=NOT_DEPLOYED
  else
    reason=""
    status=PASS
  fi
  record_step 1 health_pane_pm2_assets "$status" "$reason" "$evalr"
}

step2() {
  ssm_call step2 1500 script_step2
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$CALL_OK" != 1 ]; then
    record_step 2 analyse_selection FAIL "ssm call failed" '{}'; return 0
  fi
  if printf '%s' "$CALL_STDOUT" | grep -q 'DB_PICK_FAILED'; then
    record_step 2 analyse_selection FAIL "read-only sample query failed" '{}'; return 0
  fi
  local login rows evalr count passing status reason
  login="$(printf '%s' "$CALL_STDOUT" | sed -n 's/^login_http=\([0-9]*\)$/\1/p' | tail -1)"
  rows="$(printf '%s\n' "$CALL_STDOUT" | grep -E '^\{"n":' || true)"
  evalr="$(printf '%s\n' "$rows" | jq -s -c --arg login "${login:-none}" '
    def ok(c): (c.http=="200") and (c.r.status=="ready") and (c.r.source=="luna");
    {
      login_http: $login,
      emails: [ .[] | {
        n,
        call1: {http: .c1.http, latency_s: .c1.sec, status: .c1.r.status, source: .c1.r.source,
                workflow: .c1.r.workflow, amendment: .c1.r.amendment, cache_writes: .c1.writes},
        call2: {http: .c2.http, latency_s: .c2.sec, status: .c2.r.status, source: .c2.r.source,
                workflow: .c2.r.workflow, amendment: .c2.r.amendment, cache_writes: .c2.writes},
        cache_hit: ((.c2.writes==0) and ok(.c2) and (.c2.sec < .c1.sec)),
        pass: (ok(.c1) and ok(.c2) and (.c2.writes==0) and (.c2.sec < .c1.sec))
      } ]
    }' 2>/dev/null)"
  if [ -z "$evalr" ]; then
    record_step 2 analyse_selection FAIL "unreadable step 2 output" '{}'; return 0
  fi
  count="$(printf '%s' "$evalr" | jq -r '.emails | length')"
  passing="$(printf '%s' "$evalr" | jq -r '[.emails[] | select(.pass)] | length')"
  if [ "$count" -lt 3 ]; then
    status=FAIL; reason="insufficient sample: $count of 3 emails"
  elif [ "$passing" -ne "$count" ]; then
    status=FAIL; reason="$((count - passing)) of $count emails failed (status, source or cache-hit check)"
  else
    status=PASS; reason="$passing of $count emails: call 2 was a cache hit"
  fi
  printf '%s' "$evalr" | jq -r '.emails[] | "  email \(.n): call1 \(.call1.latency_s)s \(.call1.source // "-") \(.call1.workflow // "-") amendment=\(.call1.amendment) | call2 \(.call2.latency_s)s cache_hit=\(.cache_hit)"'
  record_step 2 analyse_selection "$status" "$reason" "$evalr"
}

step3() {
  ssm_call step3 900 script_step3
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$CALL_OK" != 1 ]; then
    record_step 3 luna_warm_counts FAIL "ssm call failed" '{}'; return 0
  fi
  local line ok skip failed since total status reason detail
  line="$(printf '%s' "$CALL_STDOUT" | grep -E '^ok=[0-9]+' | tail -1)"
  if [ -z "$line" ]; then
    record_step 3 luna_warm_counts FAIL "unreadable step 3 output" '{}'; return 0
  fi
  ok="$(printf '%s' "$line" | sed -n 's/^ok=\([0-9][0-9]*\).*/\1/p')"
  skip="$(printf '%s' "$line" | sed -n 's/.* skip=\([0-9][0-9]*\).*/\1/p')"
  failed="$(printf '%s' "$line" | sed -n 's/.* failed=\([0-9][0-9]*\).*/\1/p')"
  since="$(printf '%s' "$line" | sed -n 's/.* since=\(.*\)$/\1/p')"
  ok="${ok:-0}"; skip="${skip:-0}"; failed="${failed:-0}"
  total=$((ok + skip + failed))
  detail="$(jq -nc --argjson ok "$ok" --argjson skip "$skip" --argjson failed "$failed" --arg since "$since" \
    '{luna_warm_ok:$ok,luna_warm_skip:$skip,luna_warm_failed:$failed,ai_worker_since:$since,window:"last 3000 log lines"}')"
  if [ "$failed" -gt 0 ]; then
    status=FAIL; reason="$failed luna_warm_failed lines"
  elif [ "$total" -eq 0 ]; then
    status=NOT_DEPLOYED; reason="no luna_warm lines: not in the prod dist yet"
  else
    status=PASS; reason="ok=$ok skip=$skip failed=$failed"
  fi
  record_step 3 luna_warm_counts "$status" "$reason" "$detail"
}

step4() {
  if [ "$WITH_QUOTE" != 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      printf '\nSTEP 4 staff_quote: SKIPPED (pass --with-quote; writes run and revision rows on a thread)\n'
    else
      record_step 4 staff_quote SKIPPED "pass --with-quote to run" '{}'
    fi
    return 0
  fi
  ssm_call step4 1500 script_step4
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$CALL_OK" != 1 ]; then
    record_step 4 staff_quote FAIL "ssm call failed" '{}'; return 0
  fi
  local evalr status reason
  evalr="$(printf '%s' "$CALL_STDOUT" | grep -E '^\{"staff_source"' | tail -1)"
  if [ -z "$evalr" ]; then
    record_step 4 staff_quote FAIL "unreadable step 4 output" '{}'; return 0
  fi
  if printf '%s' "$evalr" | jq -e '.staff_source=="ready" and .source_http=="200"
      and .execute_http=="200" and .execute_status=="ready" and .pdf_http=="200"
      and .pdf_status=="ready" and .pdf_magic_ok==true and .pdf_bytes>0' >/dev/null 2>&1; then
    status=PASS; reason="ready PDF, $(printf '%s' "$evalr" | jq -r '.pdf_bytes') bytes"
  else
    status=FAIL; reason="staff quote did not reach a ready PDF"
  fi
  record_step 4 staff_quote "$status" "$reason" "$evalr"
}

# ---- main -------------------------------------------------------------------------------------

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN: no SSM call, no network, no file written. Remote scripts below are what would run."
fi
if [ "$MODE" = local-stub ]; then
  echo "LOCAL STUB MODE: remote scripts run on this host with stub commands (test only, no SSM)."
fi
if [ "$MODE" = live ]; then
  echo "LIVE MODE against prod via $SSM_RUN"
fi

step1
step2
step3
step4

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "dry run complete: no summary written"
  exit 0
fi

OVERALL=PASS
if grep -q '"status":"FAIL"' "$STEPS_NDJSON"; then OVERALL=FAIL; fi
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
SUMMARY="$OUT_DIR/luna-v4-smoke-$STAMP.json"
jq -s -c --arg started "$STARTED" --arg finished "$(date -u +%FT%TZ)" --arg mode "$MODE" \
  --arg overall "$OVERALL" \
  '{schema:"luna-v4-smoke/1",started_at:$started,finished_at:$finished,mode:$mode,overall:$overall,steps:.}' \
  "$STEPS_NDJSON" > "$SUMMARY"
chmod 600 "$SUMMARY"
echo "OVERALL $OVERALL"
echo "summary: $SUMMARY"
if [ "$OVERALL" = FAIL ]; then exit 1; fi
exit 0
