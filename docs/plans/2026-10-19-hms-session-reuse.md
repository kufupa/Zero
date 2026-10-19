# 2026-10-19 HMS session reuse + three-tier queue

Owner ask (2026-10-19, main chat): HMS reads must stop logging in every time; staff work first, inbound prefetch second, dev third; Centurion now, Da Vinci next. Evidence: [Chat A handoff](2026-10-19-chatA-handoff.md), [queue diagnosis](../research/2026-10-19-hms-queue-wait-diagnosis.md).

## Why it's slow (code, origin/main 6df7bf197)

Every HMS tool (`fetch-quote.mjs` and the 11 scripts importing `login` from it) does `connectOverCDP` → `browser.newContext()` → `login()` → navigate → work → `context.close()`. A new context has no cookies, so **every spawn logs in**. Per party spawn: login 4–6 s + navigation 4–5 s + search 2–4 s. A V2 party job runs up to 6 spawns, e.g. 82 s (Chat A, EC2 events.jsonl).

## Slice 1: reuse the login (all tools, Centurion first)

One shared helper in `fetch-quote.mjs`, used by every tool that calls `login` today:

1. `newContext({ storageState: <slot state file> })` when the file exists (0600, next to the slot profile, never in git or logs).
2. Open the HMS app URL. If the authenticated shell check (the existing `login()` readiness test) passes, skip the login.
3. Otherwise `login()`, then `context.storageState({ path })`.
4. Keep the isolated per-job context, the trace and `context.close()` as they are. Crash isolation is unchanged.

**Probe first (one read-only live run on HRCEN):** does the HMS session survive in `storageState` (cookies), or does it live in sessionStorage? If storageState doesn't carry it, fall back to opening the job's page in the slot browser's default context (cookies shared), with page-level close and screenshots instead of a context trace. Pick by the probe, no owner question.

Bar: per-spawn login+nav time before vs after, from `phaseMs` / events.jsonl on the same tool. Guideline: login phase ~0 s on a warm session; party job ~82 s → ≤ 45 s. Measured, not assumed.

Not in this slice: `slot-session.ts` (long-lived in-process page). storageState gives the same win with a smaller diff and keeps spawn-per-job isolation.

## Slice 2: one spawn per party job (batch the V2 terms)

`party-lookup.mjs` accepts N terms × kinds and runs them in one session on one Guest Stay screen. One login + one navigation per job. Guideline: party job ≤ 20 s. Touches `pane-party-lookup.ts` / `hms-jobs.ts` V2 orchestration.

## Slice 3: dev tier in the queue

Priorities already exist: `HMS_JOB_PRIORITY_USER = 10` (staff), `HMS_JOB_PRIORITY_PREFETCH = 0` (inbound), claim order `priority desc, staff_quote first, createdAt asc` (`run-ledger.ts:653`). Missing: dev/test reads bypass the queue and hit the same browser and login as prod. Add `HMS_JOB_PRIORITY_DEV = -10` and a small CLI on EC2 that enqueues a dev read and prints the result, so dev in staff hours waits behind staff and prefetch instead of colliding. Terms stay as in code: user / prefetch / dev.

## Slice 4: Da Vinci slot (parallel lane)

Split `feat/oct18-hms-slots` (Chat A): 4a = read target + property-keyed locks + HRDAV routing (`f5442a15c`, `12e988f14`, `1e680e812`, `62375df57`); plus the `hms-slot@.service` template from 4b for `hms-slot@hrdav`. Credentials: `nava-zero/server-pilot/infor-hms-read-davinci` (exists). Proof: one HRCEN and one HRDAV read running at the same time, on separate browsers. Dev testing can use HRDAV while Centurion staff are live.

## Rules

Read-only HMS only. No writes, no sends. Deploy via `ops-deploy.sh` from `recover-parse-failure`, after the owner's go in the lane's own chat; staff hours end 15:00Z. Greptile CLI review before merge.
