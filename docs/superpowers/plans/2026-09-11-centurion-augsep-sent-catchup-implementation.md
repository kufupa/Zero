# Centurion Aug–Sep Sent Catchup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or execute inline when SDD unavailable. Checkbox (`- [x]`) per step. `/autonomous-plan` + `/continue-autonomously` binding.

**Goal:** Ingest all Aug–Sep 2026 Centurion Sent from PST extract into pilot RDS (~1076 new outbound), keep existing catchup/live dups, preserve real Message-IDs, recompute conversation links with current gates, re-enqueue `inbound_triage` on affected inbound-bearing threads.

**Architecture:** Evolve `ingest-centurion-catchup-gold.ts` (MID preserve + skip-fp lists). Build filtered STORE manifest from `.private/backup-zip-2026-09-10/eml-full` (exclude catchup day+norm overlap, day-only 24 SKIP, TZ bodyhash 4). Stage eml → S3 → EC2 → dry-run → write. Then `recomputeConversationLinksForTransport` + enqueue script. No gate loosening. No Vitest against pilot RDS.

**Tech Stack:** TypeScript, Drizzle/Postgres, existing persist/link/AI ledger, AWS SSM/S3, EC2 `i-008f737974a9ba9b3`.

**Design:** `docs/superpowers/specs/2026-09-11-centurion-augsep-sent-catchup-design.md`

**Execution posture:** Autonomous overnight. Choose safest reversible path. Commit code fixes; do not commit `.private/` mail.

## Global Constraints

- Scope: Aug–Sep 2026 Sent only (`2026-08-01`…`2026-09-30`).
- Direction `outbound`, transport `transport-centurion`, uidl `catchup-gold-<fp>`.
- Preserve real MIME Message-ID when present; synthesize `catchup-gold-<fp>@catchup.legacyhotels.co.za` only when absent.
- Keep existing `catchup-gold-*` rows; skip PST twins via uidl + subject+minute + locked skip lists.
- Day-only SKIP fps: `.private/backup-zip-2026-09-10/augsep-dayonly-verdict.json` (`skip_fps`, n=24).
- TZ bodyhash SKIP fps: `.private/backup-zip-2026-09-10/augsep-tz-bodyhash-skip.json` (n=4).
- Blind body-sha SKIP forbidden.
- Conversation links: existing `recomputeConversationLinksForTransport` only — no gate changes.
- Re-triage: inbound-bearing threads only; idempotency `inbound-triage:catchup-augsep-2026:<threadId>`.
- Outbound rows: `skipAiEnqueue: true` at persist (hotel-sent never auto-triages anyway).
- Pilot RDS safety: never Vitest with pilot `DATABASE_URL`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before any local Vitest; source `.env.production` only for approved EC2 operator scripts, then unset.
- Never commit mail bodies / `.private/` extracts; never print secrets/DB URLs.

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy** (`/autonomous-plan` + `/continue-autonomously`). No blocking questions. No "which approach?" pause. Continue until done criteria evidenced or a true blocker.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking. Log divergences. Do not cut scope.
- Standard non-fast models only; Fast forbidden. If subagent unavailable, work inline.
- Better route to accepted goal may be taken; log in handoff.

### Continue-autonomously loop

Inspect state first (plan checkboxes, git, dry-run/ingest evidence). Resume first incomplete/failed task. Never redo verified work.

```text
implement → dry-run/gate → red? RCA + smallest correct fix → retest
          → green? record evidence → next incomplete task
… after ingest:
          link recompute → re-triage enqueue → read-only verify → handoff
```

Not valid stops: failed script/SSM/deploy, reversible approach choice, larger-than-expected work, user might want status ping, prior agent summarized.

### RCA loop (mandatory on any red)

FAIL → reproduce minimally → root cause (file:line) → smallest correct fix → re-run gate → resume. Symptom patches, skipped gates, and “user can finish later” are not completion.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **operator scripts only, never Vitest** |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Primary deploy | `apps/server-pilot/deploy/ops-deploy.sh` (only if code must ship to EC2 for scripts) |
| Ops | SSM + `tmp/operator/*` cleanup after runs |

**Allowed:** SSM operator scripts sourcing `.env.production`, read-only SQL verification, S3 staging of eml+manifest under `tmp/operator/`, bundle sync / ops-deploy if EC2 lacks script changes.

**Forbidden:** force-push main, `--no-verify`, destructive git, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into a Vitest process, loosening conversation-link gates, blind body-hash skip of confirmation templates, committing `.private/` mail.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

before every local/EC2 Vitest. This plan’s gates are dry-run counts + read-only SQL/API — not Vitest-on-pilot.

### Cursor execution-backend flake

Exact string `Execution backend unavailable…` → backoff-retry Shell/Write/StrReplace; see `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`. Not a human gate.

### Done criteria

- [x] Ingest script preserves real Message-ID when MIME has one; synthesizes only when missing
- [x] Dry-run store-candidate count within ~5% of ~1076 (or explained divergence logged)
- [x] New outbound rows written for STORE set; skip lists honored (day-only 24 + TZ 4 + catchup overlap + subj+minute dups)
- [x] Existing catchup-gold / live Nava MIDs not overwritten
- [x] `recomputeConversationLinksForTransport('transport-centurion')` completed; no mega-merge of handover/Nedbank/generic quotation in spot-check
- [x] `inbound_triage` enqueued (or already present via idempotency) for inbound-bearing threads that gained new catchup outbound
- [x] Handoff report with counts under `docs/superpowers/plans/handoff-reports/`
- [x] No unresolved blocker affecting plan goal
- [x] S3 `tmp/operator/augsep-*` staging cleaned up

### True blockers

Missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict, or external outage preventing required proof.

## Execution Mode

Autonomous overnight — no user checkpoint. Resume from first incomplete task. Prefer inline execution for this ops-heavy plan; use SDD subagents only if a clean code-unit boundary appears.

---

## File map

| File | Role |
|------|------|
| `apps/server-pilot/scripts/ingest-centurion-catchup-gold.ts` | MID preserve; optional `--skip-fps` JSON; recursive dir support if needed |
| `apps/server-pilot/scripts/recompute-centurion-conversation-links.ts` | Thin CLI wrapping `recomputeConversationLinksForTransport` (or reuse/extend `backfill-centurion-conversation-links.ts`) |
| `apps/server-pilot/scripts/enqueue-centurion-augsep-retriage.ts` | Enqueue inbound_triage for affected inbound threads |
| `.private/backup-zip-2026-09-10/augsep-store-manifest.json` | Filtered STORE manifest (local, not committed) |
| `docs/superpowers/plans/handoff-reports/2026-09-11-centurion-augsep-sent-catchup.md` | Evidence |

---

### Task 1: Preserve real Message-ID + skip-fps CLI

**Files:**
- Modify: `apps/server-pilot/scripts/ingest-centurion-catchup-gold.ts`
- Test: disposable-DB unit if feasible; else dry-run proof on EC2 only (no pilot Vitest)

- [x] **Step 1:** Change MID assignment so parsed real Message-ID wins; synthetic only when missing/empty
- [x] **Step 2:** Add `--skip-fps PATH` loading `{ skip_fps: string[] }` or bare string[]; skip those fps before store (count as `skippedFp`)
- [x] **Step 3:** Support nested eml paths in manifest (`eml` may include subdirs) OR flatten staging — pick one and document in handoff
- [x] **Step 4:** Commit script change (no `.private/`)

### Task 2: Build STORE manifest + stage to EC2

- [x] **Step 1:** Build Aug–Sep Sent manifest from `eml-full` with fp=`sha1(day|norm|basename)[:12]`
- [x] **Step 2:** Exclude: catchup day+norm overlap; day-only `skip_fps`; TZ `skip_fps`
- [x] **Step 3:** Stage flat eml dir + manifest → S3 → EC2 `/tmp/augsep-catchup/`
- [x] **Step 4:** Dry-run ingest; record wouldStore / dups; expect ~1076 ±5% after content-dup

### Task 3: Write ingest

- [x] **Step 1:** Run ingest without `--dry-run`
- [x] **Step 2:** Read-only SQL: new `catchup-gold-*` count since batch; Aug–Sep outbound total
- [x] **Step 3:** Spot-check: sample Nava AI Sent with real MID retained; TZ-4 fps absent as new uidls

### Task 4: Link recompute

- [x] **Step 1:** Run `recomputeConversationLinksForTransport` for `transport-centurion`
- [x] **Step 2:** Spot-check: no absurd mega-cluster on handover / Nedbank / generic quotation norms

### Task 5: Re-triage enqueue

- [x] **Step 1:** Identify inbound-bearing threads per design (own thread with inbound+new outbound, or active link to new outbound thread)
- [x] **Step 2:** `enqueueAiRun` with key `inbound-triage:catchup-augsep-2026:<threadId>`
- [x] **Step 3:** Count inserted vs already-present

### Task 6: Handoff + cleanup

- [x] **Step 1:** Write handoff report with all counts + divergences
- [x] **Step 2:** Clean S3 `tmp/operator/augsep-*` and EC2 `/tmp/augsep-catchup`
- [x] **Step 3:** Mark plan checkboxes complete

## Progress ledger

Track live state in `.superpowers/sdd/augsep-catchup-progress.md` (create/update each task).
