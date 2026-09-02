# Centurion Workflow Triage + Full Durable Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship locked workflow-folder + P0–P5 Mastra triage, frontend nav/Urgent, spam R22/R23 ReserveCloud hardening, suggested-tool **tags** (drafting infra only — no draft AI), and durable backfill of **all eligible Centurion threads**. **Evidence dashboard is Phase 2** — after backfill green + nav flip ([`2026-09-01-centurion-evidence-dashboard-implementation.md`](2026-09-01-centurion-evidence-dashboard-implementation.md)).

**Architecture:** Extend `categories` + `triage` + Mastra `mail-triage` to workflow schema; persist fat metrics on `ai_workflow_run`; write one primary + urgent to `mail_thread_category`; promote true Penny ReserveCloud quarantine as outbound; snapshot→retag unsettle→worker→audit→restore for full Centurion universe. Tools = tags only.

**Tech Stack:** TypeScript, Zod, Vitest, Mastra workflows, Centurion retag CLIs, React mail nav.

**Grounded plan (product SoT):** [`docs/plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md`](../../plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md)

**Calibration:** `.private/connected-mailbox-corpus/follow-up/_work/penny-reservecloud-gold-calibration-2026-09-01.json`

**Supersedes:** shadow-only stop in `docs/superpowers/plans/2026-08-31-centurion-workflow-triage-and-tools.md`; prior thin pointer version of this file.

**Execution posture:** test-first for schema/refine/planner/UI; characterization before retag/promote script changes; operator dry-run before `--apply`.

## Global Constraints

- Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV`
- Never `VITEST_ALLOW_PILOT_RDS=1`; never source `.env.production` into test shells
- Disposable DB only when DB required
- No auto-close / suppress / send / archive by source
- No fake response-rate / revenue / hours-saved copy
- Chart **1,042 / 37.1% of 2,810** — never publish 1,079/38.4% as external
- Internal domains never `automated-channel`
- `suggestedTools` = read tags only; never write tool ids; **tag ≠ invoke**; do not activate HMS tools or draft agent
- Spam = `spam_at` via `isSpam`; honor `spam_user_locked_at`
- Never-spam: Legacy domains + exact `pmbobo@eu.mail.reservecloud.com` — **not** `*.reservecloud.com`
- R24: templated ≠ automated; wrappers ≠ outbound gold
- Flags: durable/schema ≠ nav (`WORKFLOW_NAV_V6` off until backfill green)
- Raw PII out of Git; `.private/` for snapshots
- User-selected execution model: `gpt-5.6-luna` with `max` reasoning for the orchestrator and every subagent/reviewer/fixer; use the same choice for all subsequent dispatches and continuations of this plan.
- Model lock: use `gpt-5.6-luna` with `max` reasoning exclusively; do not dispatch `gpt-5.6-terra`, any other model, or a silently inherited default.

## Autonomous Execution Mandate

**User granted full autonomy for Phase 1.** Continue until the Phase 1 goal and every done criterion are evidenced. Do not pause for routine choices or progress approval.

### Decision authority

- Choose the safest reversible implementation and operator path without asking.
- A better route to the accepted goal is authorized; record the divergence and reason in the ledger/handoff.
- Preserve all locked requirements and scope boundaries. Do not silently defer plan-owned work.
- Use `gpt-5.6-luna` with `max` reasoning for every subagent/reviewer/fixer. If dispatch cannot honor this lock, do not dispatch an alternate model; continue inline under the Luna-Max orchestrator.

### RCA loop

FAIL -> reproduce minimally -> identify root cause and mechanism -> choose smallest correct fix -> test -> resume the plan. Do not paper over red gates, skip tests, or hand routine choices back to the user.

### Communication

- Orchestrator + subagents: **`/caveman ultra`**. Technical terms exact.

### AWS / infra

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Deploy | `apps/server-pilot/deploy/ops-deploy.sh` |
| Restart | `apps/server-pilot/deploy/ops-restart.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** ops wrappers, Centurion snapshot/retag/audit/restore, promote-quarantine dry-run then apply, disposable-DB tests.

**Forbidden:** force-push main, `--no-verify`, Vitest against pilot RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into test shells.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

Operator scripts may use pilot `DATABASE_URL` for authorized runbook only — not Vitest.

### Verification loop

Implement -> focused RED/GREEN tests -> relevant broader tests/build/lint -> required operator dry-runs and read-only pilot gates -> inspect evidence -> fix any red -> repeat. Fresh verification is required after review, compounding, or any material change.

### Cursor execution-backend flake

`Execution backend unavailable...` → `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`

### Done criteria

- [x] Workflow primaries, Urgent overlay, P0-P5 schema, `isSpam`, and presentation/nav contracts are implemented and tested.
- [x] R22/R23 never-spam, staff-response, ReserveCloud discriminator, quarantine promotion, and spam-FP regression gates are green.
- [x] Suggested tools are deterministic read-only tags only; no HMS activation, write IDs, or draft AI.
- [x] Full eligible Centurion universe is promoted/snapshotted/retagged/applied/audited with explicit residual counts and 100% eligible coverage.
- [x] `WORKFLOW_NAV_V6` flips only after backfill audit green; Phase 2 dashboard remains unimplemented.
- [x] All plan tasks and acceptance criteria have recorded evidence, with no unresolved blocker affecting Phase 1.

### True blockers

Stop only for inaccessible credentials/access, required human-only interaction, destructive ambiguity, safety-policy conflict, or an external outage that prevents required proof. Test failures, deploy errors, flaky gates, unfamiliar code, and reversible approach choices require RCA and retry.

### Execution mode

Autonomous Phase 1 execution. Resume from the first incomplete task, use test-driven and subagent-driven development, and continue without routine checkpoints. Phase 2 starts only after Task 12 Step 9 and the backfill audit are green.

---

## File map

| Path | Role |
|------|------|
| `apps/server-pilot/src/ai/categories.ts` | Workflow + legacy slug sets |
| `apps/server-pilot/src/ai/never-spam.ts` | + RC Penny exact email |
| `apps/server-pilot/src/ai/triage.ts` | Schema, shared not-spam, refine, apply |
| `apps/server-pilot/src/ai/workflows/mail-triage.ts` | Mastra v6 prompt/schemas/budgets |
| `apps/server-pilot/src/ai/suggested-tools.ts` | Deterministic tag planner (new) |
| `apps/server-pilot/src/ai/quality-eval.ts` | Protected spam regressions |
| `apps/server-pilot/src/ai/worker.ts` | Consumers |
| `apps/server-pilot/src/env.ts` | Durable + nav flags |
| `apps/server-pilot/src/db/seed.ts` | Seed workflow categories |
| `apps/server-pilot/src/mail/ingest/promote-quarantine.ts` | RC true-staff promote + outbound override |
| **Phase 2:** `apps/server-pilot/src/ops/nava-evidence-dashboard*.ts` | Evidence board — see dashboard plan |
| `apps/server-pilot/scripts/retag-centurion-triage.mjs` | v6 unsettle + enqueue |
| `apps/server-pilot/scripts/snapshot-centurion-triage.mjs` | Snapshot + targets |
| `apps/server-pilot/scripts/restore-centurion-triage-snapshot.mjs` | Rollback |
| `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` | Post-apply audit |
| `apps/server-pilot/scripts/promote-quarantine.ts` | Promote CLI |
| `apps/server-pilot/scripts/dump-centurion-spam-audit.mjs` | Spam audit |
| `apps/mail/lib/mail/hotel-folder-presentation.ts` | Titles/subtitles |
| `apps/mail/config/navigation.ts` | Exclusive nav filter |
| `apps/mail/lib/demo/folder-map.ts` | Demo folders |
| Matching `tests/*` | Contract / refine / planner / UI / retag / promote |

---

### Task 1: Workflow slug + presentation contract (U1)

**Files:**
- Modify: `apps/server-pilot/src/ai/categories.ts`
- Modify: `apps/mail/lib/mail/hotel-folder-presentation.ts`
- Modify: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/config/navigation.ts`
- Test: `apps/mail/tests/hotel-folder-presentation.test.ts`

**Interfaces:**
- Produces: `AI_WORKFLOW_PRIMARY_SLUGS`, `isHotelWorkflowPrimarySlug`, presentation titles for 11 + urgent

- [x] **Step 1: Write failing presentation test**

```ts
it('workflow folders are managed primaries and urgent stays overlay', () => {
  expect(isHotelWorkflowPrimarySlug('bookings')).toBe(true);
  expect(isHotelWorkflowPrimarySlug('groups-events')).toBe(true);
  expect(isHotelWorkflowPrimarySlug('unknown-review')).toBe(true);
  expect(isHotelPrimaryCategorySlug('urgent')).toBe(false);
  expect(isHotelWorkflowPrimarySlug('spam')).toBe(false);
  expect(getHotelFolderPresentation('bookings')).toEqual({
    title: 'Bookings',
    subtitle: 'New bookings + quotes',
  });
  expect(getHotelFolderPresentation('unknown-review').title).toMatch(/Unknown|Needs Review/i);
});
```

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/mail exec vitest run tests/hotel-folder-presentation.test.ts
```

- [x] **Step 3: Implement slugs + presentation**

Locked slugs: `bookings | groups-events | manage-stay | confirm-reconcile | money-billing | documents-delivery | exceptions-recovery | guest-experience | internal-partner | automated-channel | unknown-review` + overlay `urgent`. Keep legacy set for dual-read.

- [x] **Step 4: Run — expect PASS**

---

### Task 2: Never-spam + ReserveCloud email (U2 partial / R23)

**Files:**
- Modify: `apps/server-pilot/src/ai/never-spam.ts`
- Test: `apps/server-pilot/tests/never-spam.test.ts`

**Interfaces:**
- Produces: `isAutoTriageNeverSpam('Penny <pmbobo@eu.mail.reservecloud.com>') === true`
- Does not: treat `noreply@noreply.reservecloud.com` or random `@reservecloud.com` as never-spam

- [x] **Step 1: Failing tests**

```ts
expect(isAutoTriageNeverSpam('pmbobo@eu.mail.reservecloud.com')).toBe(true);
expect(isAutoTriageNeverSpam('noreply@noreply.reservecloud.com')).toBe(false);
expect(isAutoTriageNeverSpam('other@eu.mail.reservecloud.com')).toBe(false);
expect(isAutoTriageNeverSpam('jvermaak@legacyhotels.co.za')).toBe(true);
```

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/never-spam.test.ts
```

- [x] **Step 3: Add exact email to `AUTO_TRIAGE_NEVER_SPAM_EMAILS`**

- [x] **Step 4: Run — expect PASS**

---

### Task 3: Workflow triage schema + isSpam (U2)

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Interfaces:**
- Produces: validated payload `{ primaryFolder, priority P0–P5, urgent, overlays: {booking?, quote?, payment?}, isSpam, suggestedTools, sourceScope, automationState, humanAction, confidence, rationale, policyFlags, abstainReason }`
- Rejects: `primaryFolder: 'spam'`; write tool ids in suggestedTools

- [x] **Step 1: Failing contract tests for AE1 + isSpam + reject spam primary**

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts
```

- [x] **Step 3: Implement schema + `validateTriageOutput`**

- [x] **Step 4: Run — expect PASS**

---

### Task 4: Exception-first refine + R22/R23 + apply Layer-3 fix (U2)

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts` (`refineTriageOutput`, `applyDurableTriageResult`, shared `staffConversationNotSpam`)
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`

**Interfaces:**
- Consumes: never-spam, threadSignals `{ legacyHotelsOutboundResponse?, reserveCloudStaffOutbound? }`
- Produces: remaps; clears unlocked spam_at + writes primary on never-spam/R22 apply (no bare early return)

- [x] **Step 1: Failing tests AE3–AE6, AE9–AE19**

Cover: Layer 0 never-spam From; AE15 staff outbound; AE16 RC + external To → staff; AE17 RC + To only Penny Legacy → not staff-outbound flag but isSpam false; AE12 apply path clears spam_at + joins `internal-partner`.

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-refine.test.ts
```

- [x] **Step 3: Implement shared not-spam + refine + apply clear+join**

Do not expand never-spam domains. Groups prompt threshold stays R9 (10+), not old 2+.

- [x] **Step 4: Run — expect PASS**

---

### Task 5: Mastra mail-triage v6 (U3)

**Files:**
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- promptVersion → `triage-v6`

**Interfaces:**
- Produces: `TRIGGER_BODY_LIMIT ≥ 8192`, `CONTEXT_BODY_LIMIT = 2000`, threadSignals in user prompt; full body to refine

- [x] **Step 1: Failing prompt/schema tests — P0–P5, isSpam, workflow folders, R22/R23 bullets, no teaching `ops` as primary, groups 10+**

- [x] **Step 2: Run — expect FAIL**

- [x] **Step 3: Rewrite system/user prompt + response schemas; stamp metrics field list**

- [x] **Step 4: Run — expect PASS**

---

### Task 6: Suggested-tool planner tags only (U4)

**Files:**
- Create: `apps/server-pilot/src/ai/suggested-tools.ts`
- Create: `apps/server-pilot/tests/suggested-tools.test.ts`

**Interfaces:**
- Produces: `suggestReadTools(folder, overlays, humanAction): string[]`
- Must not change: `DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS` / candidate-draft activation

| Folder | Tags |
|--------|------|
| bookings + quote | `hms_quote_stay` |
| bookings + booking | `hms_find_reservation` |
| groups-events | `hms_group_block_read`, `hms_quote_stay` |
| manage-stay / confirm-reconcile | `hms_find_reservation` |
| money-billing | `hms_read_folio`, `hms_find_reservation` |
| documents-delivery | `hms_list_documents`, `mail_read_artifact` |
| automated-channel / unknown-review / internal-partner | `[]` unless exception |
| isSpam | `[]` |

- [x] **Step 1: Failing tests AE1–AE5 + never `reservation_create` + isSpam empty**

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/suggested-tools.test.ts
```

- [x] **Step 3: Implement pure planner; call after refine**

- [x] **Step 4: Run — expect PASS**

- [x] **Step 5: Characterization — candidate-draft active set unchanged**

---

### Task 7: Nav flag + exclusive sidebar + Urgent pill (U5)

**Files:**
- Modify: `apps/mail/config/navigation.ts`, presentation, route-filter
- Modify: `apps/server-pilot/src/env.ts` — `WORKFLOW_NAV_V6` default false; durable flag separate
- Tests: mail nav / pill tests

- [x] **Step 1: Failing tests — flag off = legacy 4; flag on = 11 exclusive; spam not in Folders; Urgent route shows primary pill; Unknown review styling**

- [x] **Step 2: Implement exclusive filter + flags**

- [x] **Step 3: Tests PASS**

---

### ~~Task 8~~ Evidence dashboard — **MOVED to Phase 2**

**Do not implement in Phase 1.** After Task 12 Step 9 (nav flip) + backfill audit green, run:

[`docs/superpowers/plans/2026-09-01-centurion-evidence-dashboard-implementation.md`](2026-09-01-centurion-evidence-dashboard-implementation.md)

---

### Task 8: Seed + durable apply accepts workflow slugs (U7)

**Files:**
- Modify: `seed.ts`, `categories.ts`, `applyDurableTriageResult`

- [x] **Step 1: Characterization — settled → urgency_only; unsettled → full**

- [x] **Step 2: Seed workflow rows; durable writer accepts new primaries**

- [x] **Step 3: Disposable-DB or mocked tests PASS**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
# If DB required: TEST_DATABASE_URL=... CONFIRM_DISPOSABLE_TEST_DB=1
```

---

### Task 9: Promote true Penny ReserveCloud (U11) — before snapshot

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/promote-quarantine.ts`
- Modify: `apps/server-pilot/scripts/promote-quarantine.ts`
- Test: `apps/server-pilot/tests/promote-quarantine.test.ts`

**Interfaces:**
- Filter: From exact `pmbobo@eu.mail.reservecloud.com`
- True staff: recipients not solely `pmbobo@legacyhotels.co.za` → promote with **direction=outbound** override
- Skip: wrappers (To only Penny Legacy), noreply, other quarantine reasons/rows

- [x] **Step 1: Failing unit tests for discriminator + outbound override + skip wrappers/noreply**

- [x] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/promote-quarantine.test.ts
```

- [x] **Step 3: Implement filter + direction override**

- [x] **Step 4: Unit tests PASS**

- [x] **Step 5: EC2 dry-run — class counts recorded in Task 12 handoff (ops; not Vitest)**

---

### Task 10: Retag / snapshot / restore / audit v6 (U8)

**Files:**
- Modify four Centurion scripts + tests

- [x] **Step 1: Characterization — clearSpamAt already; managed slugs 4+urgent**

- [x] **Step 2: Extend managed/unsettle to legacy∪workflow∪urgent; defaults triage-v6 + new key-prefix; `clearSpamAt` AND `spam_user_locked_at IS NULL`**

- [x] **Step 3: Audit — `asOf=createdAt`; spam approved → spam_at set + no primary; non-spam → spam_at null + workflow primary**

- [x] **Step 4: Script unit tests PASS (no pilot Vitest)**

---

### Task 11: Spam FP regression harness (U10)

**Files:**
- Create: `apps/server-pilot/tests/fixtures/spam-fp-v6.jsonl`
- Create: `apps/server-pilot/tests/spam-fp-v6.test.ts`
- Modify: `apps/server-pilot/src/ai/quality-eval.ts`

- [x] **Step 1: Failing test — fixture batch protectedRegressions for legitimate-mail-marked-spam = 0 after pipeline (fake adapter)**

Fixtures: AE12–AE19 shapes + newsletter stays spam.

- [x] **Step 2: Run — expect FAIL**

- [x] **Step 3: Wire fixtures through classify+refine+apply (mocked DB/apply)**

- [x] **Step 4: Run — expect PASS**

**Gate:** Task 12 Step 0 blocks until green.

---

### Task 12: Full-universe Centurion durable backfill (U9)

**Ops only — not Vitest**

Universe: all Centurion-transport threads with inbound trigger. Residuals logged: spam locks, block/allow skips, outbound-only no trigger.

- [x] **Step 0: Tasks 4–5 + 9–11 green (layers + promote + FP suite)**

- [x] **Step 0b: Quality eval / spam-fp-v6 — `legitimate-mail-marked-spam` = 0**

- [x] **Step 1: U11 promote `--apply` after dry-run counts OK; verify message RC outbound > 0**

- [x] **Step 2: Snapshot Centurion → `.private/` (0600); emit targets for **full eligible universe****

- [x] **Step 3: Retag dry-run — mutate 0**

- [x] **Step 4: Restore drill dry-run (incl. spam columns)**

- [x] **Step 5: Cohort `--apply` 50 → drain → audit**

- [x] **Step 6: Cohort 250 → drain → audit; pause on Bedrock throttle**

- [x] **Step 7: Remainder → drain → audit; eligible applied = 100% − residuals**

- [x] **Step 8: `dump-centurion-spam-audit` + never-spam / staff-outbound in spam = 0 (AE14/AE19)**

- [x] **Step 9: Flip `WORKFLOW_NAV_V6` on**

- [x] **Step 10: Handoff under `docs/superpowers/plans/handoff-reports/`**

---

## Review disposition (nava-plan 2026-09-01 re-run)

| Gate | Result |
|------|--------|
| eng | MUST-FIX universe/cohorts/U11 outbound/flags/metrics/apply Layer-3/audit asOf → absorbed CE + Tasks |
| ponytail | Shared not-spam; thin overlays; TRIGGER over quoted-tail helper; keep suggested-tools seam → absorbed |
| design | Exclusive nav; split flags; Unknown; Urgent pill → Task 7. Dashboard → Phase 2 plan |

## Decisions locked this pipeline

1. Triage + FE + drafting **infra tags** only — **no** drafting AI / HMS activation
2. Backfill **all eligible** Centurion threads (cohorted), not sample-only
3. R22/R23 ReserveCloud with recipient discriminator
4. Promote before snapshot
5. Nav flag last
6. **Evidence dashboard after Phase 1** — not parallel with backfill

## True blockers

None known for Phase 1 planning. Phase 2 blocked until Phase 1 DoD (minus dashboard) green.

## Phase Handoff

**Phase 1:** `/nava-run` on this plan (Tasks 1–7, 8–12). U1→U2/U11→U3→U4–U7→U10→U8→U9.

**Phase 2:** After Task 12 Step 9 + audit green → `/nava-run` on [`2026-09-01-centurion-evidence-dashboard-implementation.md`](2026-09-01-centurion-evidence-dashboard-implementation.md).

## Execution ledger — 2026-09-02 continuation

- Model lock held: `gpt-5.6-luna` with `max` reasoning; no Terra or alternate model dispatch.
- Remote source verified at `142e218addb0ba17459ea227c45578353b5ee659`; `worker` online, `ai-worker` stopped, and `hms-ai-worker` absent.
- Frozen cohorts passed: c50 `50/50`, c250 `250/250`, remainder `2520/2520`; eight non-spam approved-manifest reconciliation repairs were applied and metrics serialization was corrected to JSON objects.
- Post-ingest residual scope: two new eligible threads were retagged, directly drained (`processed=2`, `remainingNonterminal=0`), and strictly audited (`checkedTargets=2`, `errors=[]`).
- Final live coverage: eligible `2822`, locked `2`, blocked `0`, allowed `7`, outbound-only `467`; manifest union `2822`, overlap `0`, eligible coverage `100%`.
- Spam gate: `threads=3298`, `spam=4`, `neverSpamInSpam=0`, `staffOutboundInSpam=0`; `spam-fp-v6` protected regression remains `legitimate-mail-marked-spam=0`.
- Nav was flipped last via quiesced SPA build with `VITE_WORKFLOW_NAV_V6=1`, followed by HTTP-only restarts. Dashboard, draft AI, tool invocation, and HMS activation remain out of scope.
- Full evidence and reconciliation details: [`2026-09-01-centurion-task-12.md`](handoff-reports/2026-09-01-centurion-task-12.md).
