# Handoff: or2 closed, open items for the next chat (2026-10-26 ~16:45 UK)

Entry point for the next LLM. Supersedes the open lists in [005 session handoff](2026-10-26-005-session-handoff.md). Read order: `PRODUCT.md` → `docs/context/ACTIVE.md` (top section "or2 closeout") → [afternoon retro](../context/ledger/2026-10-26-or2-retro-pm.md) → this file.

## 1. State right now

| Item | Value |
|---|---|
| Live SHA | `f70fbae67` (deployed 15:42Z, health 200, 4 pm2 procs). Last-good before: `60c52d376` |
| Main | `d8e20d329` (+ this doc) |
| Migration | 0054 applied 14:40Z with owner approval; verified |
| Flags (unchanged today) | `RESERVATIONIST_PANE_SAVE=lab` on http/worker/ai-worker; `HMS_DAVINCI_*` on; `PANE_WRITE_CREATE=on`; `CANCEL_UNPAID=on`; `AMEND_*`/`CANCEL_PAID=lab`; `HMS_QUOTE_PREPARE=true` |
| or2 orchestration | **Closed.** `/tmp/or2/STOP` present; coord-loop and deploy-train stopped; hourly cron deleted; no lanes running; no background watches |
| Units | All T1/T2 merged except **R-SEED** (held, see 3.4) |

## 2. Acceptance checks still open (no code needed)

| # | Check | How | Pass |
|---|---|---|---|
| 2.1 | Staff load the new pane | nginx access log on EC2 for `nava-pane-DACG_mgw.js` after 15:42Z | a 200 after 15:42Z; then a staff edit shows Undo + AI/Edited markers |
| 2.2 | Approved Azure-drafted reply sends (#611) | read-only prod SQL for a `mail.send` with an approved draft after 15:42Z | sent, no `invalid approval` error. Never send mail yourself |
| 2.3 | DV priced prepared quote end-to-end | read-only SQL: HRDAV `read_tool` BAR run `succeeded` with `ok=true`, no deploy mid-run | priced rows stored; PDF canary DS4-K2 after |
| 2.4 | Owner canaries prepared, not run | `/tmp/or2/fix/*.live.md` (DS2-S5 Needs-you, DS4-K2 PDF, DS4-L1/L2 preview persistence, DS4-Lease-*, DS3-*) | each file states its pass line; run Labtest/read-only ones, real-guest ones need owner |

## 3. Next-run backlog (plan with `/speed-plan`; it now enforces retro fixes as T0)

### 3.1 T0: scripts first, or the run does not start (~2.5 h, 3–4 parallel lanes)
| Item | Why | Notes |
|---|---|---|
| `gate.sh` + nightly `baseline.json` from clean main | lanes waited ~297 lane-min for the coordinator to compare failures | lane passes if failing set ⊆ baseline and own tests pass; run remote gates **serially** per worktree |
| `dispatch.sh`: `needs` column separate from `files`; stacked child starts when parent's gates pass | WIRE waited 2 h on J1 | in `.worktrees/speed-mode-scripts/scripts/orch/` (new branch off origin/main) |
| `eta.sh` | ETA re-quoted ~12× without parts | chain × per-kind p50 (simple ~40, contract-heavy ~90) + P1 round + deploy ~7.5 + canary |
| `canary.sh` | Opus drove live canaries (~$82 morning) | deterministic; reads the `.live.md` pass lines |
| `ops-deploy.sh --migrate` CA fix | 0054 migrate failed `SELF_SIGNED_CERT_IN_CHAIN` | add `NODE_EXTRA_CA_CERTS=$PWD/deploy/rds-ca-global.pem` to the migrate step (or `ssl.ca` in `drizzle.config.ts`). Keep TLS verification on. Detail: `/tmp/or2/fix/OPS-migrate-ca.md` |

### 3.2 Product fixes (small)
| Item | Detail |
|---|---|
| #607 P2: switching mail mid-Undo | `apps/mail/.../use-work-item.ts:~714` keeps `historyPending` for mail B until A settles; A's error shows on B. Fix: reset pending on selected-mail change + request-id guard. `/tmp/or2/fix/DS4-WIRE.followup.md` |
| Stay date/room AI/Edited markers | not wired on stay fields yet (contact fields are) |
| 6 failing tests on main | `apps/mail/tests/rate-controls.test.tsx` (2: fixture lacks `bookingDrafts`) and `rate-cards.test.tsx` (4: expects BAR table; panel now renders `StayRateGrid` since #441). Update tests to the current UI contract. `/tmp/or2/baseline-failures.md` |
| DV multi-room-type room profile refresh | 12:38 UK BAR failure on `transport-faith` ("Room profile…") |
| Leftovers | idempotency keys ignore dead-letter state; `staff_quote_private_file_invalid` classed TRANSIENT_NETWORK (hides config errors); empty/missing corpus should mean "no documents"; prepared-quote attach dead-letters at attempt 1/2; deploy-train fixture tests (#576 P2) |

### 3.3 Owner decision pending
Coordinator (Opus) may write fixes ≤20 product lines only when a lane is stuck at Greptile round 3 or on a prod bug, still through gates + Apex + merge-gate? Recommended yes (retro §9). Not decided; don't assume it.

### 3.4 R-SEED (held, redesign, not a live step)
- Needs a source-aware append-only `staff_rate_pick` store (`source=backfill|live`) + smoothed-count reader (DS1-P3c, migration, Grok 4.6). Current DS1-P3b (`apps/server-pilot/src/ai/staff-rate-pick-history.ts`) reads `quote.prepared` work_events; `work_event.work_item_id` is NOT NULL. **Never seed via synthetic work items.**
- ROI is low now: HRDAV answer key 38/38 BAR, HRCEN quotes BAR B&B; ranker already puts BAR first. Revisit when live `quote.prepared` shows non-BAR picks ≥10% on a property. Detail: `/tmp/or2/fix/R-SEED.blocked`.

## 4. Rules that bit us today (read before acting)
- Every ETA: run the ledger jq in `~/.claude/CLAUDE.md` + measured parts (Apex p50 3.3 min, deploy ~7.5 min). Never "rough"/"unchecked".
- Contract-heavy units (history/undo, concurrent edits, file retention, grants, HMS outage) carry the race-matrix checklist; fix the class, never one field per Greptile round.
- Never stack UI on an unmerged server PR; contract PR (≤30 lines) first.
- Split at planning when forecast >400 product lines; never raise `MAX_PRODUCT_LINES`.
- Never commit conflict markers; check `git diff --check` before push.
- Explain terms to the owner in plain words.
- Hook quirk: Bash commands containing the test-runner word in some forms are blocked even in echo/heredoc; write scripts to files.
- Speed-plan skill lives at `/home/ubuntu/.agents/skills/speed-plan/SKILL.md` (symlinked; edit as `ubuntu` via sudo).

## 5. Holds (need owner OK in the executing chat)
Real-guest HMS writes, flag/env changes, prod deletes, requeues, R-SEED prod backfill, any mail send, GitHub Actions. Labtest writes and read-only HMS/SQL are allowed.

## 6. Key paths
| What | Where |
|---|---|
| or2 artefacts (kept for reference) | `/tmp/or2/{units.tsv,state,fix,logs,coord.log,hourly.md,baseline-failures.md,retro/}` |
| Orch scripts | `.worktrees/speed-mode-scripts/scripts/orch/{dispatch,merge-gate,deploy-train}.sh` |
| Prod read-only SQL | `/tmp/or2/bin/prodsql.sh <file.sql>` (BEGIN READ ONLY … ROLLBACK) |
| Deploy | `.worktrees/recover-parse-failure` → `apps/server-pilot/deploy/ops-deploy.sh` (rc=1 from the 24 h dead-letter gate is normal) |
| Remote gates | `/home/orca/bin/remote-typecheck.sh`, `/home/orca/bin/remote-vitest.sh` (never local tsc/tests) |
