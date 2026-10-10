#!/usr/bin/env bash
# Tests for luna-v4-smoke.sh. No SSM, no network, no database: the remote scripts run on this
# host with stub curl, psql, pm2, aws and git on PATH (LUNA_SMOKE_STUB_BIN). Run: bash <this file>
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/luna-v4-smoke.sh"
T="$(mktemp -d)"
trap '[ -n "${KEEP_T:-}" ] || rm -rf "$T"' EXIT
PASS=0
FAIL=0

SENTINEL_URL='postgres://sentinel-user:SENTINEL-PASS@127.0.0.1/db'
STUB_PASSWORD='stub-pass-DO-NOT-PRINT'
GUEST='GUEST-NAME-DO-NOT-PRINT'

ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }
contains() { if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 (missing [$2])"; fi; }
absent() { if grep -qF -- "$2" "$3"; then bad "$1 (found [$2])"; else ok "$1"; fi; }

# ---- fixture tree: a fake app dir, stub commands and stub state ------------------------------

APP="$T/app"
STATE="$T/state"
BIN="$T/bin"
SSMROOT="$T/ssm-root"
mkdir -p "$APP/.private/luna-analyse-cache" "$STATE" "$BIN" "$SSMROOT/apps/server-pilot/deploy"
printf '#!/usr/bin/env bash\ntouch "%s/executed"\n' "$SSMROOT" > "$SSMROOT/apps/server-pilot/deploy/ssm-run-command.sh"
printf 'DATABASE_URL=%s\nOTHER=1\n' "$SENTINEL_URL" > "$APP/.env.production"
printf 'stub-bundle\n' > "$STATE/bundle.js"
cat > "$STATE/bundle.js" <<BUNDLE
const a="Change to booking";const b="See what Luna did in HMS";const c="Find this booking in HMS";const d="Create one reply with all date options";
BUNDLE
cp "$STATE/bundle.js" "$STATE/bundle.js.keep"
printf '%s\n' "<one@example.invalid>" "<two@example.invalid>" "<three@example.invalid>" > "$STATE/mids.txt"
printf '%s\n' '[{"name":"http","pm2_env":{"status":"online","pm_uptime":1760000000000}},{"name":"remote-http","pm2_env":{"status":"online","pm_uptime":1760000000000}},{"name":"worker","pm2_env":{"status":"online","pm_uptime":1760000000000}},{"name":"ai-worker","pm2_env":{"status":"online","pm_uptime":1760000000000}},{"name":"hms-ai-worker","pm2_env":{"status":"stopped","pm_uptime":0}}]' > "$STATE/pm2.json"
: > "$STATE/pm2_logs.txt"

# curl: answers by URL path. -o FILE writes the body, -w FORMAT prints the format, -d/--data bodies
# are recorded for assertions. Analyse calls alternate call1/call2 per email (odd/even counter).
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -u
st="$STUB_STATE"
out=""; fmt=""; jar=""; url=""; data=""
args=("$@"); i=0
while [ "$i" -lt "${#args[@]}" ]; do
  a="${args[$i]}"
  case "$a" in
    -o) out="${args[$((i+1))]}"; i=$((i+1)) ;;
    -w) fmt="${args[$((i+1))]}"; i=$((i+1)) ;;
    -c) jar="${args[$((i+1))]}"; i=$((i+1)) ;;
    -d|--data-urlencode) data="${args[$((i+1))]}"; i=$((i+1)) ;;
    --data) data="$(cat "${args[$((i+1))]#@}")"; i=$((i+1)) ;;
    -X|-H|-b|--max-time|--resolve) i=$((i+1)) ;;
    -*) ;;
    *) url="$a" ;;
  esac
  i=$((i+1))
done
code=200; body=""; tt="0.010"
case "$url" in
  */health) body="ok" ;;
  */outlook-pane)
    code="${STUB_PANE_CODE:-200}"
    body='<html><script src="/assets/index-stub.js"></script></html>' ;;
  */assets/*) body="$(cat "$st/bundle.js")" ;;
  */api/auth/sign-in/email)
    [ -n "$jar" ] && printf '# stub\nlocalhost\tFALSE\t/\tFALSE\t0\tbetter-auth.session_token\tstub\n' > "$jar" ;;
  */api/trpc/quoteWorkflow.analyseSelection)
    n=$(( $(cat "$st/analyse_n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$st/analyse_n"
    printf '%s' "$data" > "$st/analyse_in_$n.json"
    body="{\"result\":{\"data\":{\"json\":{\"status\":\"ready\",\"intent\":\"quote\",\"source\":\"luna\",\"workflow\":\"quote\",\"groups\":[{\"guestName\":\"$GUEST\"}],\"luna\":{\"workflow\":\"quote\",\"flags\":[\"amendment_or_cancel\",\"multi_date\"]}}}}}"
    mkdir -p .private/luna-analyse-cache
    if [ $((n % 2)) -eq 1 ] || [ "${STUB_CALL2_WRITES:-0}" = 1 ]; then
      : > ".private/luna-analyse-cache/entry-$n.json"
    fi
    if [ $((n % 2)) -eq 1 ]; then tt="${STUB_TIME_CALL1:-12.500}"; else tt="${STUB_TIME_CALL2:-0.250}"; fi ;;
  */api/trpc/workstation.staffQuoteSource)
    printf '%s' "$data" > "$st/source_in.txt"
    body='{"result":{"data":{"json":{"status":"ready","messageId":"mail-stub","threadId":"thread-stub","sourceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}' ;;
  */api/trpc/workstation.executeStaffQuote)
    printf '%s' "$data" > "$st/execute_in.json"
    body='{"result":{"data":{"json":{"status":"ready","workflowRunId":"run-stub","revisionRef":"rev-stub","totalMinor":123400}}}}' ;;
  */api/trpc/workstation.qualifiedQuoteProposalPdf)
    printf '%s' "$data" > "$st/pdf_in.json"
    if [ "${STUB_PDF_MAGIC:-good}" = bad ]; then pdf="$(printf 'NOTPDF' | base64 -w0)"; else pdf="$(printf '%%PDF-1.4 stub' | base64 -w0)"; fi
    body="{\"result\":{\"data\":{\"json\":{\"status\":\"ready\",\"pdfBase64\":\"$pdf\"}}}}" ;;
  *) code=404 ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; fi
if [ -n "$fmt" ]; then
  s="${fmt//%\{http_code\}/$code}"; s="${s//%\{time_total\}/$tt}"; printf '%s' "$s"
elif [ -z "$out" ]; then printf '%s' "$body"; fi
exit 0
STUB
cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
sql=""; prev=""
for a in "$@"; do [ "$prev" = -c ] && sql="$a"; prev="$a"; done
if [ "${STUB_PSQL_FAIL:-0}" = 1 ]; then
  echo "psql: could not connect to $DATABASE_URL" >&2; exit 2
fi
case "$sql" in
  *message_id_header*) cat "$STUB_STATE/mids.txt" ;;
  *mailbox_transport*) echo "${STUB_TRANSPORT_EMAIL:-centurion@example.invalid}" ;;
esac
exit 0
STUB
cat > "$BIN/pm2" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  jlist) cat "$STUB_STATE/pm2.json" ;;
  logs) cat "$STUB_STATE/pm2_logs.txt" ;;
esac
STUB
cat > "$BIN/aws" <<STUB
#!/usr/bin/env bash
printf '%s' '{"navaai@legacyhotels.co.za":{"password":"$STUB_PASSWORD"}}'
STUB
cat > "$BIN/git" <<'STUB'
#!/usr/bin/env bash
echo 8e572b1735ab
STUB
chmod +x "$BIN"/*

export STUB_STATE="$STATE"
export LUNA_SMOKE_STUB_BIN="$BIN"
export SMOKE_APP_DIR="$APP"

reset_state() {
  rm -f "$STATE/analyse_n" "$STATE"/analyse_in_*.json "$STATE/execute_in.json" "$STATE/pdf_in.json" "$STATE/source_in.txt"
  rm -f "$APP"/.private/luna-analyse-cache/*
  unset STUB_CALL2_WRITES STUB_PANE_CODE STUB_PSQL_FAIL STUB_PDF_MAGIC STUB_TIME_CALL1 STUB_TIME_CALL2
  : > "$STATE/pm2_logs.txt"
  cp "$STATE/bundle.js.keep" "$STATE/bundle.js"
  rm -f "$SSMROOT/executed"
}

run() { # run OUTDIR ARGS...: captures stdout+stderr into OUTDIR/run.log, sets RC
  local out="$1"; shift
  mkdir -p "$out"
  "$RUNNER" --out "$out/summary" "$@" > "$out/run.log" 2>&1
  RC=$?
}

# ---- 1. dry run: prints commands, executes nothing -------------------------------------------

reset_state
DATABASE_URL="$SENTINEL_URL" bash "$RUNNER" --dry-run --ssm-root "$SSMROOT" > "$T/dry.log" 2>&1
check "dry-run exits 0" 0 "$?"
contains "dry-run lists step 1" "DRY-RUN step1" "$T/dry.log"
contains "dry-run lists step 2" "DRY-RUN step2" "$T/dry.log"
contains "dry-run lists step 3" "DRY-RUN step3" "$T/dry.log"
contains "dry-run says step 4 is skipped without --with-quote" "STEP 4 staff_quote: SKIPPED" "$T/dry.log"
contains "dry-run prints a remote script" "--- remote script ---" "$T/dry.log"
absent "dry-run never prints the database URL" "SENTINEL-PASS" "$T/dry.log"
absent "dry-run never writes a summary" "luna-v4-smoke-" "$T/dry.log"
if [ -e "$SSMROOT/executed" ]; then bad "dry-run executed a runner"; else ok "dry-run executed no runner"; fi

# ---- 2. usage errors --------------------------------------------------------------------------

reset_state
bash "$RUNNER" --dry-run --with-quote --quote-arrival 2027-11-12 --quote-departure 2027-11-14 >/dev/null 2>&1
check "--with-quote without a message id is a usage error" 2 "$?"
bash "$RUNNER" --dry-run --with-quote --quote-message-id '<a@example.invalid>' --quote-arrival 2027-11-14 --quote-departure 2027-11-12 >/dev/null 2>&1
check "--with-quote with arrival after departure is a usage error" 2 "$?"
bash "$RUNNER" --dry-run --with-quote --quote-message-id 'bad id;rm' --quote-arrival 2027-11-12 --quote-departure 2027-11-14 >/dev/null 2>&1
check "--with-quote rejects a message id with shell characters" 2 "$?"
bash "$RUNNER" --dry-run --bogus >/dev/null 2>&1
check "unknown argument is a usage error" 2 "$?"
SMOKE_APP_DIR=/home/ubuntu/repos/zero/apps/server-pilot LUNA_SMOKE_STUB_BIN="$BIN" bash "$RUNNER" --out "$T/refuse" >/dev/null 2>&1
check "stub mode refuses the prod app directory" 2 "$?"

# ---- 3. local stub run: every step PASS, NOT_DEPLOYED where the warmer is absent --------------

reset_state
run "$T/pass"
check "healthy run exits 0" 0 "$RC"
contains "step 1 passes" "STEP 1 health_pane_pm2_assets: PASS" "$T/pass/run.log"
contains "step 2 passes" "STEP 2 analyse_selection: PASS" "$T/pass/run.log"
contains "step 3 is not deployed without warm lines" "STEP 3 luna_warm_counts: NOT_DEPLOYED" "$T/pass/run.log"
contains "step 4 is skipped" "STEP 4 staff_quote: SKIPPED" "$T/pass/run.log"
contains "overall is PASS" "OVERALL PASS" "$T/pass/run.log"
absent "run output hides the sentinel" "SENTINEL-PASS" "$T/pass/run.log"
absent "run output hides the stub password" "$STUB_PASSWORD" "$T/pass/run.log"
absent "run output hides guest names" "$GUEST" "$T/pass/run.log"
absent "run output hides message ids" "one@example.invalid" "$T/pass/run.log"
SUMMARY="$(ls "$T"/pass/summary/luna-v4-smoke-*.json 2>/dev/null | head -1)"
if [ -n "$SUMMARY" ]; then ok "summary file written"; else bad "summary file written"; fi
check "summary has four steps" 4 "$(jq '.steps | length' "$SUMMARY")"
check "summary mode is local-stub" "local-stub" "$(jq -r '.mode' "$SUMMARY")"
check "summary is mode 600" "600" "$(stat -c %a "$SUMMARY")"
check "step 2 saw three emails" 3 "$(jq '.steps[1].detail.emails | length' "$SUMMARY")"
check "step 2 call 2 is a cache hit for every email" "true,true,true" "$(jq -r '[.steps[1].detail.emails[].cache_hit] | join(",")' "$SUMMARY")"
check "step 2 records the workflow" "quote" "$(jq -r '.steps[1].detail.emails[0].call1.workflow' "$SUMMARY")"
check "step 2 records the amendment kind" "amendment_or_cancel" "$(jq -r '.steps[1].detail.emails[0].call1.amendment' "$SUMMARY")"
check "step 2 records the source" "luna" "$(jq -r '.steps[1].detail.emails[0].call2.source' "$SUMMARY")"
check "step 2 carries the login status" "200" "$(jq -r '.steps[1].detail.login_http' "$SUMMARY")"
absent "summary hides the sentinel" "SENTINEL-PASS" "$SUMMARY"
absent "summary hides the stub password" "$STUB_PASSWORD" "$SUMMARY"
absent "summary hides guest names" "$GUEST" "$SUMMARY"

# ---- 4. a non-hit on call 2 fails step 2 -----------------------------------------------------

reset_state
export STUB_CALL2_WRITES=1; run "$T/nohit"
check "a cache miss on call 2 exits 1" 1 "$RC"
contains "step 2 fails on the cache check" "STEP 2 analyse_selection: FAIL" "$T/nohit/run.log"
contains "overall is FAIL" "OVERALL FAIL" "$T/nohit/run.log"

# ---- 5. a missing bundle string is NOT_DEPLOYED, not FAIL -----------------------------------

reset_state
grep -v 'Create one reply' "$STATE/bundle.js.keep" > "$STATE/bundle.js"
run "$T/notdeployed"
check "a missing bundle string still exits 0" 0 "$RC"
contains "step 1 reports the missing string as not deployed" "STEP 1 health_pane_pm2_assets: NOT_DEPLOYED" "$T/notdeployed/run.log"

# ---- 6. a pane that does not return 200 fails step 1 ----------------------------------------

reset_state
export STUB_PANE_CODE=500; run "$T/panefail"
check "a pane that does not return 200 exits 1" 1 "$RC"
contains "step 1 fails on the pane" "STEP 1 health_pane_pm2_assets: FAIL" "$T/panefail/run.log"

# ---- 7. warm counts: failures fail, ok lines pass --------------------------------------------

reset_state
printf '%s\n' 'luna_warm_ok run 1' 'luna_warm_ok run 2' 'luna_warm_skip run 3' > "$STATE/pm2_logs.txt"
run "$T/warm-ok"
contains "warm ok lines pass step 3" "STEP 3 luna_warm_counts: PASS" "$T/warm-ok/run.log"
reset_state
printf '%s\n' 'luna_warm_ok run 1' 'luna_warm_failed run 2' > "$STATE/pm2_logs.txt"
run "$T/warm-fail"
check "a luna_warm_failed line exits 1" 1 "$RC"
contains "step 3 fails on a warm failure" "STEP 3 luna_warm_counts: FAIL" "$T/warm-fail/run.log"

# ---- 8. database read failure is reported without its text ----------------------------------

reset_state
export STUB_PSQL_FAIL=1; run "$T/dbfail"
check "a failed sample query exits 1" 1 "$RC"
contains "step 2 reports the failed sample query" "read-only sample query failed" "$T/dbfail/run.log"
absent "failed query does not echo the database URL" "postgres://" "$T/dbfail/run.log"
absent "failed query does not echo the sentinel" "SENTINEL-PASS" "$T/dbfail/run.log"

# ---- 9. optional staff quote: writes only what the brief allows, reports timings and bytes --

reset_state
run "$T/quote" --with-quote --quote-message-id '<test-1@example.invalid>' --quote-arrival 2027-11-12 --quote-departure 2027-11-14
check "a healthy quote run exits 0" 0 "$RC"
contains "step 4 passes" "STEP 4 staff_quote: PASS" "$T/quote/run.log"
contains "step 4 reports the PDF size" "ready PDF, 13 bytes" "$T/quote/run.log"
absent "quote output hides the message id" "test-1@example.invalid" "$T/quote/run.log"
check "execute body carries the approved arrival" "2027-11-12" "$(jq -r '.json.groups[0].arrivalDate' "$STATE/execute_in.json")"
check "execute body carries the approved departure" "2027-11-14" "$(jq -r '.json.groups[0].departureDate' "$STATE/execute_in.json")"
check "execute body uses board bb, two adults, BAR" "bb/2/BAR" "$(jq -r '[.json.groups[0].board, (.json.groups[0].adults|tostring), .json.salesStrategy] | join("/")' "$STATE/execute_in.json")"
check "execute body uses the source message and hash" "mail-stub" "$(jq -r '.json.messageId' "$STATE/execute_in.json")"
check "pdf body carries the workflow run and transport email" "run-stub/centurion@example.invalid/Quote" "$(jq -r '[.json.workflowRunId, .json.outlookEmail, .json.agency] | join("/")' "$STATE/pdf_in.json")"
check "quote summary records the PDF size" 13 "$(jq -r '.steps[3].detail.pdf_bytes' "$(ls "$T"/quote/summary/luna-v4-smoke-*.json | head -1)")"

reset_state
export STUB_PDF_MAGIC=bad; run "$T/quotebad" --with-quote --quote-message-id '<test-2@example.invalid>' --quote-arrival 2027-11-12 --quote-departure 2027-11-14
check "a PDF without the magic number exits 1" 1 "$RC"
contains "step 4 fails without a valid PDF" "STEP 4 staff_quote: FAIL" "$T/quotebad/run.log"

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
