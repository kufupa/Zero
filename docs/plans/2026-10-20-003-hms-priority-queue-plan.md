---
title: "HMS job priority queue: staff clicks > prefill > dev/eval > refresh"
date: 2026-10-20
status: owner GO 2026-10-20 ~02:55Z ("go queue"); runs after quote slice (~06:00Z)
owner_ask: OWNER-ASKS 151; original definition 2026-10-19 chat ("number one, HMS stuff that the user has added … number two is like the pre-fill slash backfill stuff … testing stuff … fourth priority … refresh … when the HMS is completely not being used")
---

# HMS job priority queue

## Why now (ROI)
Centurion staff may start using quotes on 2026-10-20 while we keep developing. Today every dev/eval HMS read we enqueue (e.g. `quote-ready-eval.ts --enqueue`, backtests) lands at the SAME priority as background prefill (0), and both share Nava's single serial HMS lane. A staff click is priority 10 and already jumps the queue, but cannot preempt a job that is already running.

## Evidence (read-only prod, last 7 days, hms lane read_tool)

| priority | kind | n | wait p50 s | wait p90 s | run p50 s | run p90 s |
|---:|---|---:|---:|---:|---:|---:|
| 10 (staff) | staff_quote | 114 | 8 | 333 | 127 | 195 |
| 10 | party | 23 | 148 | 447 | 26 | 32 |
| 10 | search_guest | 18 | 2 | 118 | 16 | 42 |
| 10 | find | 13 | 54 | 91 | 17 | 39 |
| 0 (prefill) | party | 259 | 95 | 1018 | 53 | 84 |
| 0 | find | 142 | 11 | 183 | 14 | 46 |
| 0 | staff_quote | 140 | 3 | 129 | 105 | 240 |
| 0 | search_guest | 32 | 2 | 115 | 15 | 45 |

Jobs: 169 staff (117 in 05–15Z) vs 650 prefill (332 in 05–15Z). Claim order today: `priority DESC, staff_quote first, created_at` (`apps/server-pilot/src/ai/run-ledger.ts:653`). Staff p90 wait 333 s for a quote = a staff click stuck behind a running ~2–4 min prefill/eval job (no preemption).

What this means:
- Tiering already exists for 1 vs 2. **Missing:** tier 3 (dev/eval) and tier 4 (refresh) — dev runs today are indistinguishable from prefill, so an overnight backtest of 30 quotes (~60 min serial) would also delay real prefill and could delay a staff click by one job length.
- Staff p90 wait is dominated by "one long job already running", not by queue order. Biggest lever for staff wait is **not starting long low-tier jobs during staff hours**, not reordering.

## Push back (argue the opposite)
- A full scheduler/preemption rewrite is NOT worth it tonight: 1 HMS browser, serial lane, Playwright jobs can't be safely interrupted mid-form.
- History lookup (owner's old #4) is not live as a queue kind; refresh sweep (ask 125) not built. Define tier 4 constant + gate now, build the sweep later.
- Alternative higher-ROI for "dev in parallel with live use": a **second HMS browser/session for dev** (Chat A noted ~75% of party run time is login/navigation; D2 = parallel HMS slots). That removes contention entirely but is multi-hour and touches the live browser service → not tonight.

## Slice (≈2 h, one PR, ≤ ~150 product lines)

| # | Change | File | Test |
|---|---|---|---|
| Q1 | Named tiers: `STAFF=10`, `PREFILL=0`, `DEV=-10`, `REFRESH=-20` (keep existing values so no migration; claim already orders `priority DESC`) | `apps/server-pilot/src/ai/hms-jobs.ts:183` | claim order test: staff > prefill > dev > refresh |
| Q2 | Dev/eval scripts enqueue at DEV: `quote-ready-eval.ts --enqueue`, `nava-ae2-find-proof.ts`, any `scripts/*` that calls enqueue | `apps/server-pilot/scripts/*.ts`, small `priority` param on `prefetchQuoteReadyForExtraction` | script arg parse test |
| Q3 | Staff-hours gate: during 05:00–16:00Z (configurable env, default on) the hms claimer skips DEV/REFRESH jobs **if any staff/prefill job queued or a staff pane opened in the last N min**; else runs them | `run-ledger.ts` claim predicate (`hms` lane only) | gate tests (inside/outside hours, idle) |
| Q4 | Code that treats `priority === PREFETCH` as "system prepared" must also accept DEV (eval runs must still produce prepared-quote rows the pane can read) | `hms-jobs.ts:611,3057,3413,3487`, `workstation.ts:375,572` | existing prepared-quote tests + 1 DEV case |
| Q5 | Pane queue position ignores lower tiers (already: counts `priority >` only) — verify, no change expected | `hms-jobs.ts:3382` | — |

Done check (measurable): after deploy, enqueue 3 DEV quote reads + 1 staff-priority read on prod → claim order staff first (run timestamps); inside gated window DEV stays queued while a prefill job exists. Read-only SQL proof. No HMS writes.

ETA (revised 02:55Z on measured lane B: Luna 7 min for 46 lines, remote typecheck+tests 5 min): code 15 + gates 10 (typecheck+tests ‖ Greptile ‖ Grok high) + merge 5 + deploy 10 (ride the quote final deploy if ready, saves 10) + proof 15 (4 serial HMS jobs ~2 min each + SQL) = **≈55 min**. Proof runs 06–08Z, inside the staff-hours window, so prove: staff job claims first; dev job stays queued while a prefill job exists; dev runs once queue empty.

Risks / holds:
- Q4 is the trap: priority currently doubles as "system-prepared" flag → split to `metrics.tier`? Smaller: keep check as `priority <= PREFETCH`. Coordinator reads diff for every `=== HMS_JOB_PRIORITY_PREFETCH` site.
- Negative priority values: column is `smallint` (signed, schema mail.ts:611) — OK; check for a CHECK constraint in migrations before merge.
- No flag flips beyond the new env default; gate default ON is a behaviour change → owner told in summary.

## Next after this (not tonight)
1. Refresh sweep (ask 125) at REFRESH tier, 02:00–03:00Z.
2. Second HMS session for dev/eval (parallel slot) — real fix for dev-while-live.
