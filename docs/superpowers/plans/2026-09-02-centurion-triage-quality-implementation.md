# Centurion Triage Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Centurion folder-mix quality — routine OTA/SynXis/channel → `automated-channel`, promo/cold-sales/FortiMail digests → spam (`spam_at`) with Quarantine label on digests, then re-backfill with fail-closed Automate/spam recall floors.

**Architecture:** Extract shared refine predicates; extend `refineWorkflowTriageOutput` with ordered force-spam / force-automate / series-release; apply attaches/removes user label `Quarantine` only with FortiMail digest spam; FE Quarantine nav uses `folder=spam`+`labelIds`; extend existing retag audit with quality floors; re-backfill via forceUnsettle.

**Tech Stack:** server-pilot TypeScript, Vitest (disposable DB only), Mastra mail-triage prompt, Centurion snapshot/retag/audit scripts, mail route-filter.

**Product SoT:** `docs/plans/2026-09-02-002-feat-centurion-triage-quality-plan.md`

**Execution posture:** TDD for refine/apply/nav; characterization before retag script changes; operator dry-run before `--apply`.

## Global Constraints

- Never run Vitest with pilot/production `DATABASE_URL`; never set `VITEST_ALLOW_PILOT_RDS=1`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest.
- Preserve R16 (`spam_at` sole spam truth), R22/R23 never-spam, `spam_user_locked_at`.
- Never `primaryFolder: 'spam'`. Never `fileThreads` for Quarantine.
- No HMS/draft activation. No pilot-RDS Vitest.
- Standard non-fast subagents only.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** Activates on `/nava-run` (or explicit execute). No blocking questions overnight. No manual login. No "which approach?" pause. Until execute: plan-only.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve Q1–Q10 locks (Automate force, spam restore, Quarantine spam-scoped nav). Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), read-only SSM checks, PM2 logs, health curl, disposable non-production DB tests, Centurion snapshot/retag/audit ops with pilot `DATABASE_URL` for **ops scripts only**.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, any Vitest/test command pointed at pilot or production RDS, setting `VITEST_ALLOW_PILOT_RDS=1`, or sourcing `.env.production` into a test process.

### Pilot RDS safety (overrides autonomy)

Never run Vitest against `nava-zero-mail-pilot` or any production database. No overnight escape hatch exists.

Before every local or EC2 Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test requires Postgres, use a disposable test database. If none exists, use read-only SQL/API health checks where they prove the requirement; otherwise report a safety blocker. Never weaken this rule to make a gate green.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Cursor execution-backend flake (not a human gate)

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`

Playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`. Backoff-retry Shell/Write/StrReplace; do not invent app RCA.

### Verification loop

Implement → focused Vitest (disposable DB) → spam-fp-v6 → contract → route-filter → deploy if needed → dry-run retag → quality audit floors → cohort apply → restore on fail → live spot-check.

### Done criteria

- [ ] Routine SynXis/OTA fixtures → `automated-channel` via workflow refine
- [ ] Promo + FortiMail digest fixtures → `isSpam` + `spam_at`; FortiMail also has `Quarantine` label
- [ ] Quarantine nav lists spam+label threads (not archive-only)
- [ ] spam-fp-v6 protected regressions = 0
- [ ] Re-backfill quality floors: Automate recall ≥80% on routine gold; spam recall ≥90% on promo/FortiMail gold; neverSpamInSpam=0
- [ ] Live spot-check Automate non-zero, Spam restored, Quarantine digests visible
- [ ] All plan tasks complete; no unresolved blocker affecting plan goal

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict (incl. missing disposable DB for Vitest), or external outage that prevents required proof.

## Execution Mode

Plan-only until `/nava-run`. Then autonomous overnight: resume first incomplete task; TDD + subagent-driven development; no routine user checkpoints.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/ai/triage.ts` | Shared predicates; workflow refine order; apply Quarantine label |
| `apps/server-pilot/src/ai/workflows/mail-triage.ts` | Prompt Q1 alignment |
| `apps/mail/lib/mail/route-filter.ts` | Quarantine → spam+labelIds |
| `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` | `--quality` floors |
| `apps/server-pilot/tests/ai-triage-refine.test.ts` | Force automate/spam/series |
| `apps/server-pilot/tests/spam-fp-v6.test.ts` + fixtures | FP gate |
| `apps/server-pilot/tests/ai-triage-contract.test.ts` | Prompt/schema |
| mail route-filter / apply tests | Nav + label lifecycle |

---

## Task 1: Shared predicates + workflow force Automate + series-release

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('workflow: routine SynXis confirm → automated-channel', () => {
  const refined = refineTriageOutput(
    { from: 'noreply@synxis.com', subject: 'SynXis Res Confirmed', body: 'Reservation confirmed.' },
    { primaryFolder: 'bookings', isSpam: false, /* minimal valid workflow fields */ },
  );
  expect(refined.primaryFolder).toBe('automated-channel');
  expect(refined.policyFlags).toContain('refine:system-mail-automated');
});

it('workflow: SynXis with reply-within-12h stays out of automated-channel', () => { /* … */ });

it('workflow: held series release → exceptions-recovery before automate', () => { /* … */ });

it('workflow: internal property never stays automated-channel', () => { /* … */ });
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run tests/ai-triage-refine.test.ts
```

- [ ] **Step 3: Extract shared predicates; implement KTD1/KTD1b order in `refineWorkflowTriageOutput`**

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/ai/triage.ts apps/server-pilot/tests/ai-triage-refine.test.ts
git commit -m "$(cat <<'EOF'
fix(triage): force routine channel mail into automated-channel

Workflow refine lacked legacy system-mail promote; SynXis/OTA dumped into Bookings.
EOF
)"
```

---

## Task 2: Workflow force spam (promo + FortiMail digest)

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`, `apps/server-pilot/tests/spam-fp-v6.test.ts`
- Fixtures as needed under `apps/server-pilot/tests/fixtures/`

- [ ] **Step 1: Write failing tests** — FortiMail digest → `isSpam` + `refine:fortimail-spam`; promo salesSignal → `refine:promo-spam`; LH From promo body not spam; “quarantine room” booking not spam; workflow empty-body/short-personal not spam.

- [ ] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run tests/ai-triage-refine.test.ts tests/spam-fp-v6.test.ts
```

- [ ] **Step 3: Implement KTD2** — digest detector `fortimail|quarantine digest|quarantine summary`; reuse `salesSignal`; order after R22 clear.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(triage): restore workflow force-spam for promo and FortiMail digests

Prompt-only spam left live Spam≈9; port deterministic refine with narrow digest matcher.
EOF
)"
```

---

## Task 3: Apply Quarantine label + spam-scoped nav

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts` (`applyDurableTriageResult`)
- Modify: `apps/mail/lib/mail/route-filter.ts` (+ callers if needed)
- Test: apply/label tests; `apps/mail/tests/` route-filter contract tests

- [ ] **Step 1: Write failing tests** — FortiMail spam apply → `spam_at` set + `Quarantine` in `labelIds`; promo spam → no Quarantine; re-apply without fortimail flag strips Quarantine; route-filter Quarantine label → `{ folder: 'spam', filters: { labelIds: [...] } }`.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement ensure-by-name + merge/remove; nav exception KTD3a**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(mail): quarantine digests get Quarantine label under spam folder

Hard-rule FortiMail spam stays in spam_at and is filterable via My Folder nav.
EOF
)"
```

---

## Task 4: Prompt + contract alignment

**Files:**
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

- [ ] **Step 1: Failing contract assertions** for Q1 routine system → automated-channel wording; AE2-style OTA-new→Bookings only when human work.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update prompt**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs(triage): align mail-triage prompt with automated-channel lock

Routine channel notices belong in Automate; Bookings reserved for human work.
EOF
)"
```

---

## Task 5: Quality floors on audit + gold fixtures + re-backfill

**Files:**
- Modify: `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`
- Add: private gold JSON (`.private/…`) + committed opaque hash/stub if needed
- Test: audit script unit tests if present pattern exists
- Note: supersede AE2 routine-system reading in handoff / prior plan footnote

- [ ] **Step 1: Write failing quality-floor tests / dry CLI expectations**

- [ ] **Step 2: Implement `--quality` re-refine floors (Automate ≥80%, spam ≥90%, neverSpamInSpam=0)

- [ ] **Step 3: Disposable Vitest green; document ops sequence**

```text
quiesce → snapshot + KEY_PREFIX → dry-run retag → restore drill →
cohort 50 → quality audit → 250 → remainder → final quality audit →
live spot-check Automate/Spam/Quarantine
```

- [ ] **Step 4: When executing: run ops sequence; abort+restore on floor fail**

- [ ] **Step 5: Commit scripts + fixtures (no raw PII in git)**

```bash
git commit -m "$(cat <<'EOF'
feat(ops): add Centurion triage quality floors to retag audit

Coverage-only green hid empty Automate and wiped spam; fail closed on recall floors.
EOF
)"
```

---

## Task 6 (optional fold-in): 40mail → Automate

- [ ] Discover From/domain via read-only Centurion sample
- [ ] One refine fixture + predicate branch
- [ ] Commit when fingerprint known; do not block Tasks 1–5 DoD

---

## Review gates during execution

- After each task: per-task review (correctness)
- After Task 3: `gstack-plan-design-review` / design check for Quarantine spam-scoped nav
- Final: `ce-code-review` before declaring complete
- Ponytail: no new schema field; shared predicates; no second audit driver

## Final verification (execution)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run \
  tests/ai-triage-refine.test.ts \
  tests/spam-fp-v6.test.ts \
  tests/ai-triage-contract.test.ts
# + mail route-filter / apply label tests
```

Ops quality audit + live spot-check required for Done criteria.
