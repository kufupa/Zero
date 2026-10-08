#!/usr/bin/env bash
# lab-proof.sh: one 2027+ Labtest stay through Preview, Save, find, cancel preview, cancel commit, readback.
#
# Run from any directory. It drives the CLIs next to this file against the borrowed Chrome (CDP):
#   OUT=/abs/new-dir HMS_STAGEHAND_CDP_URL=<local CDP url> HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed \
#   HMS_READ_SECRET_ARN=<secret id> AWS_REGION=<region> \
#   bash apps/server-pilot/tooling/playwright-quote/lab-proof.sh [request.json]
# HMS_QUOTE_SECRET_PATH=<private json> can replace HMS_READ_SECRET_ARN. Values are never printed.
#
# request.json defaults to examples/lab-proof-request.json. The guard refuses unless lastName is Labtest
# and arrival is on or after 2027-01-01. OUT must be absolute and new or empty.
#
# Steps, in order. Each writes $OUT/<step>/ (result.json, stdout.txt, stderr.txt, PNGs). The run stops at
# the first step that is not as expected. $OUT/summary.json is written on every exit.
#   1-preview         create-lab-stay --stop-before save                 expect previewed
#   2-commit          create-lab-stay --pane-commit                      expect committed <CONF>
#   3-find            cancel-stay --mode preview                         expect preview_ok, Reserved/Confirmed
#   4-cancel-preview  cancel-stay --mode preview                         expect preview_ok, penaltyText kept
#   5-cancel-commit   cancel-stay --mode commit --reason "Test Reservations"  expect cancelled
#   6-readback        cancel-stay --mode preview                         expect already_cancelled
#
# Deliberate choices, from the CLIs themselves:
# - Step 1 uses --stop-before save. --stop-before availability stops before Check Availability.
# - Step 3 uses preview: cancel-stay has no find mode (--mode is preview or commit only).
# - The request has no meal plan: create-tool.schema.json refuses any key it does not list.
# - cancel-stay never clicks OK on a penalty dialog. A pending penalty ends step 5 as cancel_unconfirmed.
#
# Playwright: both CLIs resolve playwright 1.63.0 from apps/server-pilot/tooling/stagehand/node_modules.
# Install it in the worktree that holds this script first: npm ci --prefix apps/server-pilot/tooling/stagehand
# No NODE_PATH is needed, and it would not help: NODE_PATH is consulted only after that walk, so it
# cannot replace the apps/server-pilot/node_modules/playwright (1.52.0) the walk finds first.
#
# Exit: 0 all six steps as expected. 2 refused before any browser step. 3 stopped at a step (see summary.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUEST_ARG="${1:-$SCRIPT_DIR/examples/lab-proof-request.json}"
OUT="${OUT:-}"
REQUEST=""
ARRIVAL=""
CONF=""
STATUS="stopped"
STOP_STEP=""
STOP_REASON="the run ended before the six steps finished"
STEPS_TSV=""
LAST_CODE=0
LAST_MS=0
LAST_DIR=""
LAST_TOOL=""

die() {
  echo "lab-proof: $*" >&2
  exit 2
}

# Environment: names only, never values.
[[ -n "$OUT" && "$OUT" == /* ]] || die "set OUT to an absolute directory that is new or empty"
[[ -n "${HMS_STAGEHAND_CDP_URL:-}" ]] || die "HMS_STAGEHAND_CDP_URL is required (the borrowed Chrome CDP URL)"
[[ "${HMS_STAGEHAND_BROWSER_OWNERSHIP:-}" == borrowed ]] || die "HMS_STAGEHAND_BROWSER_OWNERSHIP must be borrowed"
[[ -n "${HMS_QUOTE_SECRET_PATH:-}" || -n "${HMS_READ_SECRET_ARN:-}" ]] ||
  die "set HMS_QUOTE_SECRET_PATH or HMS_READ_SECRET_ARN (and AWS_REGION for the ARN)"
# create-lab-stay runs a legacy save-then-cancel branch when this is set. This proof must never take it.
unset LAB_CANCEL_CONFIRMATION
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)' ||
  die "Node 22.18 or newer is required"

# Request and lab guard: lastName Labtest, arrival a real date on or after 2027-01-01.
[[ -f "$REQUEST_ARG" ]] || die "request file not found: $REQUEST_ARG"
REQUEST="$(cd "$(dirname "$REQUEST_ARG")" && pwd)/$(basename "$REQUEST_ARG")"
ARRIVAL="$(node -e '
  const fs = require("node:fs");
  const req = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lastName = typeof req.lastName === "string" ? req.lastName.trim() : "";
  const arrival = typeof req.arrival === "string" ? req.arrival : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(arrival) ? new Date(arrival + "T00:00:00Z") : null;
  const real = date !== null && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === arrival;
  if (!/^labtest$/i.test(lastName)) { console.error("lab guard: lastName must be Labtest"); process.exit(2); }
  if (!real || arrival < "2027-01-01") { console.error("lab guard: arrival must be a real date on or after 2027-01-01"); process.exit(2); }
  process.stdout.write(arrival);
' -- "$REQUEST")" || die "request refused by the lab guard"

# Playwright 1.63.0 must resolve the way the CLIs resolve it (createRequire from the stagehand manifest).
[[ -f "$SCRIPT_DIR/../stagehand/package.json" ]] || die "missing apps/server-pilot/tooling/stagehand/package.json"
STAGEHAND_DIR="$(cd "$SCRIPT_DIR/../stagehand" && pwd)"
PW_VERSION="$(node -e '
  const { createRequire } = require("node:module");
  process.stdout.write(createRequire(process.argv[1])("playwright/package.json").version);
' -- "$STAGEHAND_DIR/package.json" 2>/dev/null || true)"
[[ "$PW_VERSION" == 1.63.0 ]] ||
  die "Playwright 1.63.0 is not resolvable from $STAGEHAND_DIR (found: ${PW_VERSION:-none}). Run: npm ci --prefix apps/server-pilot/tooling/stagehand"

# OUT: new or empty, so an earlier proof is never overwritten.
if [[ -d "$OUT" && -n "$(ls -A "$OUT")" ]]; then
  die "OUT must be new or empty: $OUT"
fi
mkdir -p "$OUT"
STEPS_TSV="$OUT/steps.tsv"
: >"$STEPS_TSV"

# Writes summary.json from steps.tsv and each step's result.json. Runs on every exit, including stop_at.
finish() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [out, tsv, status, stopStep, stopReason, conf, arrival, requestPath] = process.argv.slice(1);
    const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
    const steps = (read(tsv) ?? "").split("\n").filter(Boolean).map((row) => {
      const [step, tool, exitCode, durationMs, expected, pass, note] = row.split("\t");
      const dir = path.join(out, step);
      let result = {};
      try { result = JSON.parse(read(path.join(dir, "result.json")) ?? "null") ?? {}; } catch { result = {}; }
      return {
        step,
        tool,
        exitCode: Number(exitCode),
        durationMs: Number(durationMs),
        expected,
        pass: pass === "1",
        note: note || null,
        outcome: result.outcome ?? null,
        confirmationNumber: result.confirmationNumber ?? null,
        statusBefore: result.statusBefore ?? null,
        statusAfter: result.statusAfter ?? null,
        penaltyText: result.penaltyText ?? null,
        outDir: dir,
      };
    });
    let lab = null;
    try {
      const req = JSON.parse(read(requestPath) ?? "null") ?? {};
      lab = { firstName: req.firstName ?? null, lastName: req.lastName ?? null, arrival: req.arrival ?? null, departure: req.departure ?? null };
    } catch { lab = null; }
    const summary = {
      generatedAt: new Date().toISOString(),
      status,
      stoppedAt: stopStep || null,
      stopReason: stopReason || null,
      confirmationNumber: conf || null,
      lab,
      totalDurationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
      steps,
    };
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  ' -- "$OUT" "$STEPS_TSV" "$STATUS" "$STOP_STEP" "$STOP_REASON" "$CONF" "$ARRIVAL" "$REQUEST"
}
trap 'finish || echo "lab-proof: could not write summary.json" >&2' EXIT

# Runs one CLI with --out <OUT>/<step>. Sets LAST_CODE, LAST_MS and LAST_DIR. Does not exit on failure.
run_cli() {
  local step="$1" tool="$2"
  shift 2
  LAST_TOOL="$tool"
  LAST_DIR="$OUT/$step"
  mkdir -p "$LAST_DIR"
  local start end
  start="$(date +%s%3N)"
  set +e
  node "$SCRIPT_DIR/$tool" "$@" --out "$LAST_DIR" >"$LAST_DIR/stdout.txt" 2>"$LAST_DIR/stderr.txt"
  LAST_CODE=$?
  set -e
  end="$(date +%s%3N)"
  LAST_MS=$((end - start))
}

# Prints one top-level field of a step's result.json. Prints nothing when the file or field is missing.
result_field() {
  node -e '
    const fs = require("node:fs");
    let value;
    try { value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]; } catch { value = undefined; }
    process.stdout.write(value === null || value === undefined ? "" : String(value));
  ' -- "$1" "$2"
}

log_step() { # <step> <expected outcome> <pass 1|0> <note>; the tool is the one run_cli just ran
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$LAST_TOOL" "$LAST_CODE" "$LAST_MS" "$2" "$3" "$4" >>"$STEPS_TSV"
}

stop_at() { # <step> <reason>
  STATUS="stopped"
  STOP_STEP="$1"
  STOP_REASON="$2"
  echo "lab-proof: stopped at $1: $2" >&2
  exit 3
}

echo "lab-proof: request $REQUEST, lab arrival $ARRIVAL, out $OUT"

# 1. Preview: fill, Check Availability, stop before Save.
run_cli 1-preview create-lab-stay.mjs --request "$REQUEST" --stop-before save
OUTCOME="$(result_field "$LAST_DIR/result.json" outcome)"
echo "lab-proof: 1-preview outcome=${OUTCOME:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$OUTCOME" == previewed ]]; then
  log_step 1-preview previewed 1 ""
else
  log_step 1-preview previewed 0 "outcome=${OUTCOME:-none}"
  stop_at 1-preview "expected previewed, got ${OUTCOME:-no result} (exit $LAST_CODE). No save was attempted."
fi

# 2. Save: the same request in pane-commit mode. The confirmation number is the only proof of a booking.
run_cli 2-commit create-lab-stay.mjs --request "$REQUEST" --pane-commit
LAST_LINE="$(tail -n 1 "$LAST_DIR/stdout.txt" 2>/dev/null || true)"
read -r COMMIT_OUTCOME CONF_FOUND _ <<<"$LAST_LINE" || true
echo "lab-proof: 2-commit outcome=${COMMIT_OUTCOME:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$COMMIT_OUTCOME" == committed && "$CONF_FOUND" =~ ^[0-9]+-[0-9]+$ ]]; then
  CONF="$CONF_FOUND"
  log_step 2-commit committed 1 ""
else
  log_step 2-commit committed 0 "outcome=${COMMIT_OUTCOME:-none}"
  stop_at 2-commit "no confirmation number (last line '${LAST_LINE:-empty}', exit $LAST_CODE). HMS may hold a Proof Labtest booking arriving $ARRIVAL: check HMS before any retry."
fi
echo "lab-proof: booked as $CONF"

# 3. Find: read the stay as it stands. Preview only, so nothing changes.
run_cli 3-find cancel-stay.mjs --confirmation "$CONF" --arrival "$ARRIVAL" --mode preview
OUTCOME="$(result_field "$LAST_DIR/result.json" outcome)"
STATUS_BEFORE="$(result_field "$LAST_DIR/result.json" statusBefore)"
STATUS_KEY="$(printf '%s' "$STATUS_BEFORE" | tr '[:upper:]' '[:lower:]')"
echo "lab-proof: 3-find outcome=${OUTCOME:-none} status=${STATUS_BEFORE:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$OUTCOME" == preview_ok && ( "$STATUS_KEY" == reserved || "$STATUS_KEY" == confirmed ) ]]; then
  log_step 3-find preview_ok 1 "status=$STATUS_BEFORE"
else
  log_step 3-find preview_ok 0 "outcome=${OUTCOME:-none} status=${STATUS_BEFORE:-none}"
  stop_at 3-find "expected preview_ok with status Reserved or Confirmed, got ${OUTCOME:-no result} / ${STATUS_BEFORE:-no status} (exit $LAST_CODE). Booking $CONF exists: check HMS."
fi

# 4. Cancel preview: opens the cancel dialog, reads the penalty and reasons, dismisses it. Nothing is cancelled.
run_cli 4-cancel-preview cancel-stay.mjs --confirmation "$CONF" --arrival "$ARRIVAL" --mode preview
OUTCOME="$(result_field "$LAST_DIR/result.json" outcome)"
echo "lab-proof: 4-cancel-preview outcome=${OUTCOME:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$OUTCOME" == preview_ok ]]; then
  log_step 4-cancel-preview preview_ok 1 ""
else
  log_step 4-cancel-preview preview_ok 0 "outcome=${OUTCOME:-none}"
  stop_at 4-cancel-preview "expected preview_ok, got ${OUTCOME:-no result} (exit $LAST_CODE). Booking $CONF exists: check HMS."
fi

# 5. Cancel commit: staff reason from the reason list, one OK click. A penalty dialog is never accepted.
run_cli 5-cancel-commit cancel-stay.mjs --confirmation "$CONF" --arrival "$ARRIVAL" --mode commit --reason "Test Reservations"
OUTCOME="$(result_field "$LAST_DIR/result.json" outcome)"
echo "lab-proof: 5-cancel-commit outcome=${OUTCOME:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$OUTCOME" == cancelled ]]; then
  log_step 5-cancel-commit cancelled 1 ""
else
  log_step 5-cancel-commit cancelled 0 "outcome=${OUTCOME:-none}"
  stop_at 5-cancel-commit "expected cancelled, got ${OUTCOME:-no result} (exit $LAST_CODE). Booking $CONF may still be live: check HMS and any penalty dialog by hand."
fi

# 6. Readback: a preview of a cancelled stay must say already_cancelled.
run_cli 6-readback cancel-stay.mjs --confirmation "$CONF" --arrival "$ARRIVAL" --mode preview
OUTCOME="$(result_field "$LAST_DIR/result.json" outcome)"
echo "lab-proof: 6-readback outcome=${OUTCOME:-none} exit=$LAST_CODE ${LAST_MS}ms"
if [[ "$LAST_CODE" -eq 0 && "$OUTCOME" == already_cancelled ]]; then
  log_step 6-readback already_cancelled 1 ""
else
  log_step 6-readback already_cancelled 0 "outcome=${OUTCOME:-none}"
  stop_at 6-readback "expected already_cancelled, got ${OUTCOME:-no result} (exit $LAST_CODE). Check HMS for $CONF."
fi

STATUS="complete"
STOP_STEP=""
STOP_REASON=""
echo "lab-proof: complete. Stay $CONF was booked, cancelled and read back. Summary: $OUT/summary.json"
exit 0
