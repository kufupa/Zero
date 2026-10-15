#!/usr/bin/env bash
# Overnight Luna v4.1 run: refuse to let the orchestrator stop before the deadline.
# Allows stop when: deadline passed, ledger has HANDOFF_DONE, or a deliberate wait
# marker (epoch seconds) is still in the future (background agents / scheduled wakeup).
# Remove this hook (settings.local.json) after the run.
set -u
cat >/dev/null # drain hook JSON input

DEADLINE_EPOCH=$(date -u -d '2026-10-09T07:35:00Z' +%s)
SDD=/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.superpowers/sdd
LEDGER="$SDD/v8-progress.md"
WAIT_UNTIL_FILE="$SDD/v8-wait-until"
now=$(date -u +%s)

[ "$now" -ge "$DEADLINE_EPOCH" ] && exit 0
grep -q 'HANDOFF_DONE' "$LEDGER" 2>/dev/null && exit 0
if [ -f "$WAIT_UNTIL_FILE" ]; then
  until_epoch=$(tr -dc '0-9' <"$WAIT_UNTIL_FILE")
  [ -n "$until_epoch" ] && [ "$now" -lt "$until_epoch" ] && exit 0
fi

left=$(( (DEADLINE_EPOCH - now) / 60 ))
cat <<JSON
{"decision":"block","reason":"Overnight v8 run active: ${left} min left until 07:35 UTC and no HANDOFF_DONE in ledger. Do not stop. Read $LEDGER, then take the next plan item, parked-queue item, or never-idle ladder rung from /home/orca/.claude/plans/dont-start-build-yet-velvet-lake.md (DoD sweep if all done). If you are legitimately waiting on background agents, write a wake epoch (now+<=1500s) to $WAIT_UNTIL_FILE and schedule a wakeup before ending the turn."}
JSON
exit 0
