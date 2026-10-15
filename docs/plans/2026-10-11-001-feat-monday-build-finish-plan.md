---
title: Monday Build Finish (Centurion Nava pane) - Plan
type: feat
date: 2026-10-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
supersedes: ~/.claude/plans/proud-skipping-flamingo.md
---

# Monday Build Finish (Centurion Nava pane) - Plan

**Target repo:** `kufupa/zero`. Lane worktrees live under `.worktrees/` at the main checkout root (`.worktrees/m1-a` … `m1-d`). Code paths below are relative to each worktree.

---

## Goal Capsule

**Objective.** By Monday 2026-10-12 06:00 UTC (08:00 SAST), the Centurion reservations team gets a pane with correct mail kinds, live HMS lookups on arrival, a voucher-to-booking card, and a Needs You queue without already-answered items. The batch HITL backend and the skill cleanup land in the same run.

**Authority order.** User decisions recorded in this plan → `~/.claude/CLAUDE.md` and memory rules (no GitHub Actions, local tests + Greptile before merge, deploy via `ops-deploy.sh`, Greptile P1 triage, diagnostics first) → Key Technical Decisions here → `.worktrees/M1-LANE-BRIEF.md`.

**Stop and ask the user when:**
- A step needs an HMS write, an email send, a DB migration, or any prod flag other than `HMS_PREFETCH_ENABLED`.
- The U1 diagnostic does not confirm the POP3-delivery-lag cause.
- Prod health fails after a deploy and rollback does not restore it.
- A Greptile P1 cannot be fixed or credibly rebutted.

**Execution profile (money-efficient routing).**

| Role | Model | Used for | Cost rule |
|---|---|---|---|
| Orchestrator | Opus 5.5 (this chat's successor) | Sequencing, U1 design check, merge calls, Greptile triage judgment, prod steps, final report | Read summaries and diffs only. Delegate all file reading. Keep the main loop busy so the 1 h cache stays warm |
| Coder | GPT-6 Luna, `model_reasoning_effort="max"`, via `codex exec` | All code and skill drafting | Cheapest per token. Give it the brief + unit text, not the whole plan |
| Reviewer | Haiku 5.5, effort max, Claude subagent | Review, fix P0/P1, run gates, commit, push, open PR | Keep each call under 100k context; the price is 5× above it. Read the diff + targeted ranges, never whole files |

Estimated spend (assumed, API list prices): Luna ~$1–2, Haiku ~$2–5, Opus ~$12–15, prod re-extraction a few dollars. Total ~$15–25.

**Process survival.** The last session lost all background work when it ended. Launch every `codex exec` detached (`setsid nohup … &`), write its log and `-o` output under `.worktrees/<lane>.{log,out.md}`, and never stage drafts in `/tmp`.

---

## Product Contract

### Summary

Finish lanes A–D, add lane E (batch backend), and ship them in two deploys. Correct the lane D approach before it ships. Then re-score open items, apply the reply-link backfill, turn on HMS prefetch after a watch window, and install the cleaned-up skills.

### Problem Frame

Staff have the pane installed but get little value from it. Channel booking notices show up as voucher/other, already-answered mail sits in Needs You, and HMS lookups only run on a click. The previous session coded four lanes but died before review, PRs, or deploy. Its plan contained two errors that would have hurt prod: turning off `AI_WRITE_GATE_ENABLED`, and shipping a lane D fix that reverts #157.

### Requirements

**Queue correctness**
- R1. A request answered by the hotel leaves Needs You. A POP3 message is placed in time by trusted delivery time, never by the sender's `Date` header (keeps the #157 guard).
- R2. Mail is classified by the action it carries: channel or agent notices of new, changed, or cancelled reservations become booking, amendment, or cancellation. Rate, group, and event enquiries are never spam. Staff forwards use the forwarded guest as the contact. An `origin` field marks person vs system notice.
- R3. Open Needs You items are re-extracted once under the new rules, so Monday's queue shows corrected kinds.

**Pane value (both surfaces: Outlook pane and webmail panel)**
- R4. Contact sits at the top with one-click copy. A single "Copy for HMS" action copies the landing URL plus the confirmation. A single room row inherits `totalRooms`. Copy actions record `copy.link` and `copy.contact` telemetry with no mail text.
- R5. On arrival, booking, amendment, cancellation, and voucher_pop mail triggers read-only HMS lookups. The pane hydrates the stored result instead of starting a new one. The voucher card shows the matched booking beside the attachment's Save action.

**Batch HITL backend**
- R6. A caller enqueues any number of Needs You items as one batch and can cancel its queued remainder. Items run serially in submission order. Each has its own status, the batch has a rollup, and results can be read later. Every item is anchored to its mail thread. No UI in this run.

**Safety**
- R7. `AI_WRITE_GATE_ENABLED` stays `true`. No migrations, no HMS writes, no email sends. Every new flag defaults off. `HMS_PREFETCH_ENABLED` turns on only after a 30-minute watch.

**Tooling**
- R8. Skills: re-draft the lost drafts, install them, archive four retired skills, and fix the `nava-run` → `ce-compound` flag. Fix the nightly-retro script. Its cron stays on hold.
- R9. ETA ledger rows close out, and the final report gives $ by model.

### Scope Boundaries

- Batch UI waits for the product-design talk with the user.
- POP attach into HMS Documents stays parked until a live capture of the Documents modal on a test property and the user's second screenshot. Lane C stops at find + Save to laptop.
- Reply draft after HMS read (lane F) is parked; the user said not yet.
- Nightly-retro cron install is a hold.

### Deferred to Follow-Up Work

Ranked by ROI.

| # | Item | Why deferred | What unblocks it |
|---|---|---|---|
| 1 | Reply draft after HMS read | User: not yet | User yes. ~125–170 min scaled |
| 2 | Automatic POP attach to HMS Documents | HMS write (hold H8). No `hms_attach_*` code; selectors unknown | Live capture on a test property, screenshot, user go |
| 3 | Batch HITL UI | Needs the product-design talk | Talk with the user |
| 4 | Spam rule beyond rate/group | Needs a labelled sample | B5 export → B4 backtest |
| 5 | Outlook drag-drop to HMS Documents | Office host spike | Test in the real Office host |
| 6 | Haiku >100k prompt compaction | Untested pipeline change; ~$390–540/week (assumed) | Code read + estimate |
| 7 | Luna vs Opus coding experiment | Needs a holdout design | Design doc |
| 8 | TTL for HMS job PII (`readRequest`, `readResult`) | Not Monday-critical | Small follow-up |
| 9 | Auto-send replies | Hold H8 | Per-message approval design |
| 10 | Voucher ROI write-up | User: later. Staff minutes per voucher unmeasured | 1-week time sample |
| 11 | Multi-room pooling | User: parked (2.5% of messages, upper bound) | User revisit |
| — | Infor/Legacy API, weekend staff sessions, Sonnet 5.5, GPT-6.1 Sol | User ruled out | — |

---

## Planning Contract

### Audit of the previous plan (why this plan replaces it)

| # | Previous plan said | Code says | Correction |
|---|---|---|---|
| 1 | Turn `AI_WRITE_GATE_ENABLED` off | It gates AI triage writes to the mailbox DB. When off, every external-domain inbound gets the `soft-quarantine` label (`src/mail/ingest/store.ts`, `src/mail/ingest/live-admission.ts`), and durable triage stops (`src/ai/worker.ts` `writeGateEnabled`) | Keep it on. User confirmed |
| 2 | Lane D: compare on `received_at` | For POP3 rows, `received_at` is the sender's `Date` header. #157 (`0a92bd034`, Greptile P1 "arrival clock") deliberately uses `created_at` for them. Lane D deletes that guard | U1 reworks it with a trusted delivery time |
| 3 | Prefetch ships behind its flag (off) | Flag off means no Monday value | Turn on after a watch (U9). User confirmed |
| 4 | Classifier fix is enough | New rules apply only to new mail. Work items point at their extraction row | Re-extract open items (U8). User confirmed |
| 5 | Lanes run in parallel and merge in any order | B and D both edit `src/ai/work-items.ts` and `tests/work-items.test.ts` | Merge D first, rebase B |
| 6 | Batch needs a serial claim predicate | One HMS claimer loop in the default `ai-worker` (`runHmsJobLoop`) plus the HRCEN advisory lock already serialize | Drop the predicate. Fix ordering ties instead (KTD-5) |
| 7 | Skill drafts in `/tmp/skills-l4` | `/tmp` was cleared | Durable `~/skill-drafts/20261011/` |
| 8 | Install skills as `orca` | `~/.agents/skills` → `/home/ubuntu/.agents/skills`, `orca` has r-x ACL only. `orca` has passwordless sudo | Use `sudo -u ubuntu` |

### Key Technical Decisions

- KTD-1. **Arrival clock = trusted delivery time.** At ingest, parse the date from the top-most `Received:` header (stamped by the receiving mail server) and store it as `deliveredAt` in `message.sourceProvenance` (jsonb, no migration; today it is null except for ambiguous-source rows, so merge into the existing value, never overwrite it). POP3 rows that are not Outlook-synced arrive at `deliveredAt`, else `createdAt`. Outlook-synced and non-POP3 rows keep today's rule. Ignore `deliveredAt` if it is after `createdAt` + 5 min or before `createdAt` − 30 days. A reply must be strictly after the request; a tie does not close the item. *Why:* the server's stamp is trustworthy and the `Date` header is not. Existing rows get stamped by a dry-run-first backfill that reads raw MIME from S3 (read-only S3, jsonb write).
- KTD-2. **No `MAIL_KINDS` change.** `mail_extraction.kind` and `work_item.kind` have DB CHECK constraints, so a new kind needs a migration. Lane A adds `origin` inside the jsonb payload only.
- KTD-3. **`copy.link` and `copy.contact` need no migration.** `work_event.type` has no CHECK constraint (verified in `src/db/schema/work.ts`).
- KTD-4. **Batch input is work-item ids.** The server loads each item's latest extraction and picks the job: confirmation → `find`, surname + arrival → `search_guest`, otherwise `skipped: insufficient_data`. This reuses lane C's prefetch selection. Idempotency key `hms-job:batch:<batchId>:<workItemId>`.
- KTD-10. **No item cap.** HMS load is already bounded: one claimer, the property lock, and staff quotes going first. Batch size only changes duration, not concurrency. Two guards replace the cap:
  - **Reuse:** an item with a job in flight, or a result less than 1 h old, links to that job as `reused` instead of queuing a new lookup.
  - **Cancel:** `cancelHmsBatch` marks the batch's still-queued items cancelled; running and done items are untouched.
  Insert in chunks of 500 rows inside the batch transaction so large payloads stay within statement limits.
- KTD-5. **Serial order needs explicit timestamps.** `claimNextAiRun` orders by priority desc, then `createdAt`. Postgres `now()` is fixed inside a transaction, so items inserted together would tie. Give each item a strictly increasing `createdAt` (base + index ms) or an order key. Batch items use prefetch priority, so staff quotes go first.
- KTD-6. **Crash counter.** `requeueHmsReadsAfterRestart` does not bump `attempts`, so a poison item loops forever. Count restarts in `metrics` and dead-letter after 3.
- KTD-7. **Lane E stacks on lane C.** E depends on C's uncommitted `src/ai/hms-jobs.ts` and `src/ai/worker.ts` changes. Branch `m1/e` from the reviewed `m1/c` commit and open its PR against `m1/c` until C merges, then retarget it to `main`.
- KTD-8. **Two deploys.** Deploy 1 is D + A + B + C (Monday value). Deploy 2 is E (backend only, no user surface). Neither uses `--migrate`.
- KTD-9. **Post-deploy order:** stamp `deliveredAt` → reply-link backfill → re-extract open items → kind-drift check → prefetch flip → 30-minute watch. Re-extraction runs while prefetch is off, so old items do not flood HMS.

### High-Level Technical Design

```mermaid
flowchart LR
  subgraph W0[Wave 0 · orchestrator · 15 min]
    K[ledger rows · durable dirs · gate stays ON]
  end
  subgraph W1[Wave 1 · parallel]
    D[U1 lane D rework<br/>diagnostic → Luna → Haiku]
    A[U2 lane A finish]
    B[U3 lane B finish]
    C[U4 lane C finish]
    S[U7 skills lane]
  end
  subgraph W2[Wave 2]
    E[U5 lane E batch<br/>stacked on m1/c]
  end
  subgraph W3[Merge · serial]
    M1[D] --> M2[A] --> M3[B rebase on D] --> M4[C]
  end
  DEP1[U6 deploy 1] --> POST[U8 backfills + re-extract] --> FLIP[U9 prefetch on + watch]
  M5[E merge] --> DEP2[deploy 2]
  K --> W1
  C --> E
  D & A & B & C --> W3
  M4 --> DEP1
  E --> M5
  FLIP --> DEP2
```

Test runs share a 4-vCPU VPS with no swap. Run at most two vitest processes at a time and always `--maxWorkers=1`. `.worktrees/v5-gate.sh` is the shared gate wrapper.

### Assumptions

- Mail from the hosted POP3 mailbox carries a top-most `Received:` header with a valid date. U1's diagnostic checks this before coding.
- `INBOUND_EXTRACTION_MAX_PER_HOUR` limits re-extraction throughput. The executor reads its prod value and sizes U8's wait.
- Greptile reviews PRs as a GitHub App. No Actions are involved.

---

## Implementation Units

### U1. Lane D rework: trusted arrival clock

**Goal:** Answered requests leave Needs You without reverting #157.
**Requirements:** R1, R7
**Dependencies:** none
**Files:** `apps/server-pilot/src/mail/ingest/parse-message.ts`, `apps/server-pilot/src/mail/ingest/store.ts`, `apps/server-pilot/src/ai/work-items.ts` (`messageArrivedAt`, `MESSAGE_ARRIVED_AT`, `OUTLOOK_SYNCED`), `apps/server-pilot/src/ai/quote-followup.ts`, new `apps/server-pilot/scripts/backfill-delivered-at.ts`, tests `apps/server-pilot/tests/work-items.test.ts`, new `apps/server-pilot/tests/parse-message-delivered-at.test.ts`, new `apps/server-pilot/tests/backfill-delivered-at.test.ts`
**Approach:**
- Diagnostic first, read-only against prod and run by the orchestrator. For the ~110 stuck items, compare `created_at`, `received_at`, the hotel reply's `sent_at`, and the top `Received:` date from raw MIME. Proceed only if the delivery date sits before the reply while `created_at` sits after it. Otherwise stop and report.
- Restore the lane's deleted `OUTLOOK_SYNCED`/POP3 branch, then add the `deliveredAt` path per KTD-1. Keep the forged-From, own-domain, user-touched, and idempotency guards unchanged.
- The backfill stamps `deliveredAt` only on POP3 rows tied to open work items. It supports `--dry-run`, prints ids and counts only, and writes an audit row per change.
- Add the optional `--since <iso>` to `scripts/backfill-reply-link.ts` only if trivial.

**Execution note:** Restore the #157 regression tests first and keep them green. The red tests below come next.
**Patterns to follow:** existing `messageArrivedAt` doc comments; `scripts/backfill-reply-link.ts` dry-run and audit style.
**Test scenarios:**
- POP3 request: `createdAt` after the reply's `sentAt`, `deliveredAt` before it → planned `hotel_replied`.
- POP3 request with no `deliveredAt` → arrival = `createdAt` (#157 behavior holds).
- `Date` header before the reply but `deliveredAt` after it → not closed.
- `deliveredAt` 2 h after `createdAt`, or 40 days before it → ignored, `createdAt` used.
- Guest follow-up whose `deliveredAt` is after the reply → overtaken, stays open.
- Outlook-synced row → unchanged (`receivedAt ?? createdAt`).
- Reply `sentAt` equal to the request arrival → not closed, same result on repeat runs.
- Parser: several `Received:` headers → the top-most date wins. Malformed or missing → null. Never throws.
- Backfill: dry-run writes nothing. Apply stamps only eligible rows. A second apply is a no-op.

**Verification:** work-items and new tests pass. A prod dry run of the reply-link backfill (after U6/U8 stamping) plans roughly the stuck set, and every sampled close has delivery < reply.

### U2. Lane A finish: action-based classifier

**Goal:** Ship the existing lane A diff after review.
**Requirements:** R2, R7
**Dependencies:** none
**Files:** `apps/server-pilot/src/ai/extraction/extract.ts`, `apps/server-pilot/src/ai/extraction/schema.ts`, `apps/server-pilot/scripts/kind-drift-sample.ts`, tests `apps/server-pilot/tests/inbound-extraction.test.ts`, `apps/server-pilot/tests/extraction-schema.test.ts`, `apps/server-pilot/tests/kind-drift-sample.test.ts`, `apps/server-pilot/tests/fixtures/inbound-extraction.ts`
**Approach:** Luna finishes anything missing against `.worktrees/m1-a.prompt`. Haiku reviews against these checks: no vendor or company literals in `src/` (fixtures use invented names); `MAIL_KINDS` unchanged (KTD-2); `origin` optional and nullable; the kind-drift script reads only and prints ids and counts.
**Test scenarios:** the six cases in `.worktrees/m1-a.prompt` item 5. Also: a stored payload without `origin` still parses, and the rules text contains the action-based definitions.
**Verification:** tests green, `tsc` 0, oxlint clean, PR open.

### U3. Lane B finish: pane top, Copy for HMS, totalRooms, telemetry

**Goal:** Ship the existing lane B diff after review, rebased on U1.
**Requirements:** R4
**Dependencies:** U1 merged (shared `work-items.ts`)
**Files:** as in `git -C .worktrees/m1-b status`. Key: `apps/mail/components/nava-pane/nava-pane.tsx`, `apps/mail/components/nava-pane/blocks/contact-block.tsx`, `apps/mail/components/quote-workflow/hms-link-actions.tsx`, `apps/server-pilot/src/db/schema/work.ts`, `apps/server-pilot/src/ai/work-items.ts`; tests `apps/mail/tests/contact-block.test.tsx`, `apps/mail/tests/hms-link-actions.test.tsx`, `apps/mail/tests/pane-telemetry.test.tsx`, `apps/mail/tests/nava-pane-render.test.tsx`, `apps/server-pilot/tests/work-items.test.ts`
**Approach:** Haiku reviews against `.worktrees/m1-b.prompt`. It checks both surfaces render the change, telemetry values hold field names only, the staff/own-domain sender never becomes the contact fallback, and totals are never split across rows. Rebase on `main` after U1 merges and resolve `work-items.ts` by keeping both changes.
**Test scenarios:** the lane prompt's test list. Also: a forward from the own domain shows no sender fallback, and Copy for HMS without a configured URL copies the number only.
**Verification:** mail tests green, mail `tsc` error count not above the `origin/main` baseline, server tests green after rebase.

### U4. Lane C finish: prefetch on arrival + voucher card

**Goal:** Ship the existing lane C diff after review. Prefetch stays behind `HMS_PREFETCH_ENABLED`.
**Requirements:** R5, R7
**Dependencies:** none (U5 builds on it)
**Files:** `apps/server-pilot/src/ai/hms-jobs.ts`, `apps/server-pilot/src/ai/worker.ts`, `apps/server-pilot/src/env.ts`, `apps/mail/lib/quote-workflow/use-hms-job.ts`, `apps/mail/lib/quote-workflow/voucher-find.ts`, `apps/mail/components/quote-workflow/voucher-find-card.tsx`, `apps/mail/components/quote-workflow/hms-queue-status.tsx`; tests `apps/server-pilot/tests/hms-jobs.test.ts`, `apps/mail/tests/voucher-find-card.test.tsx`, `apps/mail/tests/hms-job-tray.test.tsx`
**Approach:** Haiku reviews against `.worktrees/m1-c.prompt` U3/U4. Drop the prompt's U6 UI part (no needs-you UI in this run). Checks: stable idempotency keys; `HMS_GUEST_PREFETCH_PER_HOUR` default 12; skips spam, backfill and sent copies, staff-sent mail, and resolved items; no second HMS claimant; the voucher card auto-starts only on an unambiguous surname + date and never auto-picks among several matches.
**Test scenarios:** the lane prompt's lists. Also: re-extracting the same message queues no duplicate job, and flag off queues nothing.
**Verification:** tests green, gates clean, PR open. The reviewed commit SHA is handed to U5.

### U5. Lane E: batch HITL backend

**Goal:** Enqueue any number of Needs You items as one serial batch, with per-item status, a rollup, a later read, and cancel.
**Requirements:** R6, R7
**Dependencies:** U4 reviewed commit (KTD-7)
**Files:** `apps/server-pilot/src/ai/hms-jobs.ts` (`enqueueHmsBatch`, `readHmsBatchView`, `cancelHmsBatch`, crash counter in `requeueHmsReadsAfterRestart`), `apps/server-pilot/src/trpc/routes/pane-stay-lookup.ts` (batch enqueue, status, and cancel procedures); tests `apps/server-pilot/tests/hms-jobs-batch.test.ts`
**Approach:**
- Reuse `ai_workflow_run`, `enqueueHmsJob`, `toView`, `STATUS_BY_STATE`, `claimNextAiRun`, `runHmsJobLoop`, and `paneStayPropertyLock`.
- Store `batchId` and `itemIndex` in `metrics` (no migration).
- Validate the whole batch before inserting anything. Insert the batch in one transaction with explicit increasing `createdAt` values (KTD-5).
- Each item is anchored to its work item's thread and trigger message.
- Rollup: `queued | running | partial | done | failed | cancelled`, plus `skipped` and `reused` per item.
- No item cap (KTD-10): reuse fresh or in-flight jobs, cancel the queued remainder, chunked inserts.
- No UI.

**Patterns to follow:** `queueUserHmsJob`, `queueFind`/`jobStatus` procedures, `tests/hms-jobs.test.ts` fixtures.
**Test scenarios:**
- The same `batchId` submitted twice creates no new rows.
- 1,200 items → all inserted in chunks, claim order matches submission order.
- One unknown or foreign-transport work item → the whole batch is rejected and nothing is inserted.
- An item with a job in flight or a result under 1 h old → `reused`, linked to that job, no new row. A result over 1 h old → a new job.
- Cancel mid-batch → queued items become `cancelled`, the running item finishes, done items keep their results, and the rollup reads `cancelled`. Cancelling again is a no-op.
- An item without a confirmation or surname+arrival → `skipped: insufficient_data`; the others run.
- `HMS_JOB_QUEUE` off → no-op response, no rows.
- Items claim in submission order even when inserted in one transaction.
- Two concurrent claimers never take the same item.
- A failed item does not block later items; the rollup reads `partial`.
- The rollup moves `queued` → `running` → `done`.
- Read after a simulated remount returns stored snapshots.
- Restart requeues claimed items, keeps done ones, and bumps the crash counter. The third crash dead-letters the item.
- `HMS_LANE_PAUSED` holds the batch with no attempts burned.
- A staff quote in flight runs before queued batch items.

**Verification:** all U5 tests plus existing `hms-jobs.test.ts` green. PR retargeted to `main` after U4 merges.

### U6. Merge and deploy 1

**Goal:** Land D, A, B, C on `main` and deploy them.
**Requirements:** R1–R5, R7
**Dependencies:** U1–U4 PRs
**Files:** none (ops)
**Approach:**
- Merge order: D → A → B (rebased) → C, each on local green plus Greptile triage (every P1 fixed or answered).
- Before deploy, confirm no lane adds a file under `apps/server-pilot/drizzle/`.
- Deploy with `apps/server-pilot/deploy/ops-deploy.sh`, no `--migrate`. It builds both server and mail.
- Rollback: redeploy the previous `main` SHA.

**Test expectation:** none — ops unit. Gates live in the Verification Contract.
**Verification:** deploy exit 0; pm2 `http`, `remote-http`, `worker`, `ai-worker`, `hms-ai-worker` online with 0 restarts; `/health` ok on 8788 and 8789; no new dead letters.

### U8. Post-deploy data steps

**Goal:** Correct Monday's queue.
**Requirements:** R1, R3
**Dependencies:** U6
**Files:** none (runs existing scripts on EC2 under `systemd-run`, per the live-proof rule)
**Approach (order fixed, KTD-9):**
1. `backfill-delivered-at.ts`: dry run, review counts, apply.
2. `backfill-reply-link.ts`: dry run (expect roughly the stuck set), spot-check 5 closes, apply, re-dry-run plans 0.
3. Collect the trigger message ids of open Needs You items. Run `kind-drift-sample.ts` (before).
4. `backfill-inbound-extraction.ts --message-id …`: dry run, then apply, paced by `INBOUND_EXTRACTION_MAX_PER_HOUR`.
5. `kind-drift-sample.ts` (after). Save the kind × origin table for the report.

**Test expectation:** none — ops unit.
**Verification:** re-dry-runs plan 0. Fewer items labelled voucher_pop/other that are booking-shaped. No user-touched item closed.

### U9. Prefetch flip and watch

**Goal:** HMS lookups on arrival for Monday.
**Requirements:** R5, R7
**Dependencies:** U8
**Files:** prod `apps/server-pilot/.env.production` on EC2 (single-key edit), restart via `apps/server-pilot/deploy/ops-restart.sh`
**Approach:** Do not use `write-ec2-env.sh`; it regenerates the whole file from secrets and can clobber other values. Over SSM, back up `.env.production` with a timestamp, change only the `HMS_PREFETCH_ENABLED` line, and diff against the backup (exactly one line changed). Set `HMS_PREFETCH_ENABLED=1` (`HMS_JOB_QUEUE` is already `on`) and restart workers. Watch for 30 minutes: job outcomes, `HMS_LOCK_BUSY` count, dead letters, guest-prefetch cap hits, staff quote latency. Leave `HMS_AVAILABILITY_PREFETCH`, `AI_DRAFTS_ENABLED`, and `QUOTE_FOLLOWUPS` off. Roll back by flag off + restart if dead letters appear, `HMS_LOCK_BUSY` repeats, or any staff quote is delayed.
**Test expectation:** none — ops unit.
**Verification:** at least one live arrival produces a stored lookup that the pane hydrates without a click, with no regressions in the watch window.

### U10. Merge and deploy 2 (lane E)

**Goal:** Ship the batch backend.
**Requirements:** R6
**Dependencies:** U5, U9
**Approach:** Retarget the PR to `main`, rebase, run local green + Greptile triage, merge, run `ops-deploy.sh`, and repeat the U6 health checks. Live proof: enqueue a 3-item batch on real Needs You items under `systemd-run` (read-only HMS), cancel after the first item finishes, confirm serial order and the `cancelled` rollup, then read results.
**Test expectation:** none — ops unit (feature tests live in U5).
**Verification:** health checks pass and the live 2-item batch reaches `done` or `partial` with correct per-item states.

### U7. Skills lane (host, not repo)

**Goal:** Restore and install the skill set and retire the old skills.
**Requirements:** R8
**Dependencies:** none (runs in Wave 1)
**Files (host):** drafts in `~/skill-drafts/20261011/`; install target `/home/ubuntu/.agents/skills/`; archive `/home/ubuntu/.agents/archive/skills/`; originals in `~/.claude/skill-backups/20261011/`
**Approach:**
- Recover the L4 spec from the previous session transcript: the `Write` of `/tmp/skills-l4/L4.prompt` in `~/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/42d2a9c1-c0a1-4b1f-9deb-137025e8e367.jsonl`.
- Re-run Luna with the output dir pointed at `~/skill-drafts/20261011/`. Deliverables: `zero-plan`, `product-office-hours-lite`, `nightly-retro` (+ `scripts/nightly-retro.sh`), `GUIDE.md` (adhd shape), `CHANGES.md`, and patches to `nava-run`, `building-hms-playwright-tools`, `ce-compound`, `autonomous-plan`, `continue-autonomously`. Do not patch `nava-plan`; it is archived.
- `nava-run`: `ce-compound mode:non-interactive` → `mode:headless`.
- Nightly retro fixes: commits from `origin/main`; Haiku cache price $0.01/M ≤100k and $0.05/M above; dedupe sessions; adoption counts from `actor_kind='user'` only. Output to `~/retros/`.
- Haiku max reviews the drafts.
- Install with `sudo -u ubuntu cp -r`. Archive `nava-plan`, `gstack-office-hours`, `gstack-retro`, and `ce-product-pulse` with `sudo -u ubuntu mv`. Do not change ACLs.
- Update the memory index for the new skills.

**Test scenarios:** `nightly-retro.sh` runs once end-to-end with exit 0 and an adhd-shape report. `grep mode:headless` finds the `nava-run` call. The archived skills no longer appear in the skills list.
**Verification:** as above, plus a skill-list check in a fresh session.

---

## Verification Contract

- **Lane DBs:** disposable Postgres `postgres://postgres:w4test@127.0.0.1:55601/<lane_db>?sslmode=disable` with `CONFIRM_DISPOSABLE_TEST_DB=1` (`v5n_a`, `v5n_b`, `v5n_c`, `v5n_d`; create `v5n_e` the same way as the others). Never an RDS URL.
- **Server:** `npx vitest run --maxWorkers=1 <touched + direct suites>` from `apps/server-pilot`, through `.worktrees/v5-gate.sh`; `npx tsc --noEmit -p .` = 0 errors.
- **Mail:** `npx vitest run --maxWorkers=1 <files>` from `apps/mail`; `tsc` error count ≤ the `origin/main` baseline.
- **Lint:** `pnpm dlx oxlint@1.6.0 --deny-warnings <changed files>`.
- **Merge gate:** local results + Greptile with every P1 triaged. No GitHub checks, no workflow files.
- **Prod:** `ops-deploy.sh` exit 0, pm2 all online with 0 restarts, `/health` 8788/8789 ok, dead letters since deploy = 0 (except the known pre-existing one), `AI_WRITE_GATE_ENABLED` still `true`.

## Definition of Done

- PRs for U1–U5 merged; deploys 1 and 2 healthy; U8 re-dry-runs plan 0; prefetch on with a clean 30-minute watch.
- `AI_WRITE_GATE_ENABLED=true`, no migrations, no HMS writes, no sends, no other flags changed.
- Skills installed and archived; `nava-run` uses `mode:headless`; the nightly retro runs clean; cron not installed.
- Ledger closed: `m1-a..d` as `partial` (session killed, resumed here) and the new run row with `actual_min`, `ratio`, `outcome`, `p1`/`p2`, `luna_issues_found`.
- No abandoned-attempt code in any diff. Lane worktrees cleaned after merge.
- Final report in adhd 10/10 shape: what shipped, kind-drift table, prefetch watch numbers, $ by model, open holds.
