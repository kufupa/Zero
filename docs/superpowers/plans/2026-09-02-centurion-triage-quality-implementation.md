# Centurion Triage Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Centurion folder-mix quality for reservationists — routine OTA/SynXis/channel → `automated-channel` (not Urgent), promo/cold-sales → spam, FortiMail quarantine digests → spam + Quarantine My Folder, then re-backfill with fail-closed recall floors + Un/Rsp WINDOW volume sanity.

**Architecture:** Shared refine predicates; ordered `refineWorkflowTriageOutput` forces (series-release → force-spam → force-automate → internal demotion); apply attaches/strips `Quarantine` label on spam early-return; FE reserved Quarantine is spam-scoped across archive-like surfaces; extend existing retag audit with `--quality` + Q11 volume; re-backfill via `forceUnsettle`.

**Tech Stack:** server-pilot TypeScript, Vitest (disposable DB only), Mastra mail-triage, Centurion snapshot/retag/audit, mail route-filter + My Folder chrome.

**Product SoT:** `docs/plans/2026-09-02-002-feat-centurion-triage-quality-plan.md`

**Execution posture:** TDD for refine/apply/nav; extend existing audit tests (no second characterization suite); operator dry-run before `--apply`.

**Parallel overnight with conversation-link (binding):** Sibling agent on `feat/centurion-link-precision` worktree `/home/orca/orca/workspaces/zero/wrasse` owns pilot EC2/RDS tonight (Tasks 0–3 already deployed; wrap-up may still touch `worker.ts` / `triage-input.ts` / `mail-triage.ts` + redeploy). This plan **must not** dual-mutate pilot. See **Wave A / Wave B** under the mandate.

## Global Constraints

- Never run Vitest with pilot/production `DATABASE_URL`; never set `VITEST_ALLOW_PILOT_RDS=1`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest.
- Preserve R16 (`spam_at` sole spam truth), R22/R23 never-spam, `spam_user_locked_at`.
- Never `primaryFolder: 'spam'`. Never `fileThreads` for Quarantine.
- No HMS/draft activation. Standard non-fast subagents only.
- Locks: Q1 Automate; Q2 urgent clear on forced paths; Q3 promo spam (incl. bookings→spam flip); Q4 Quarantine spam-scoped; Q11 WINDOW volume.
- **Shared-infra fence:** one writer to EC2 `i-008f737974a9ba9b3` / pilot RDS at a time. Conversation-link agent has priority until fence clears. No competing `ops-deploy`, `ops-restart`, retag `--apply`, or Centurion pilot mutation while link owns the box.

## Overnight Autonomous Execution Mandate

**User granted full autonomy for Wave A immediately.** Wave B only after fence clear. No blocking questions overnight. No manual login. No "which approach?" pause.

### Parallel waves (elegant split — do not skip)

| Wave | When | Allowed | Forbidden |
|------|------|---------|-----------|
| **A — code quality** | Now / overnight, parallel with link agent | Tasks **0–3** in worktree `phase-1-fix` / branch `fix/phaseone`: fixtures, refine forces, Quarantine FE, Vitest on **disposable DB only**, commits on this branch | `ops-deploy`, `ops-restart`, `ops-reboot`, bundle sync that resets EC2 checkout, retag/snapshot `--apply`, any pilot `DATABASE_URL` write, SSM mutate, competing with wrasse deploy |
| **B — pilot re-backfill** | After **fence monitor CLEAR** (or morning after cap deferred) | Task **4**: rebase/merge latest link+main as needed → deploy this branch → snapshot → dry-run → cohorts → quality+Q11 → restore-on-fail → live spot-check | Starting B while link still deploying/backfilling; dual retag; ignoring `mail-triage.ts` / `worker.ts` drift from link branch; starting B without monitor CLEAR/cap path |

**Fence clear (all must hold — poll read-only):**

1. Wrasse / link agent: no active `ops-deploy` / link `--apply` / PM2 restart in flight (SSM idle; or handoff says COMPLETE / CE review done).
2. EC2 `/home/ubuntu/repos/zero` not mid-reset by another agent’s bundle sync.
3. Optional lock file if present: `/home/ubuntu/repos/zero/.private/ops-writer.lock` absent or held by `triage-quality` after link released it.
4. Soft code: wrasse must not have uncommitted edits to `worker.ts` / `mail-triage.ts` with mtime newer than ~20m (implies another deploy coming) — if dirty+recent, wait one more tick.
5. If unclear → **wait**; do not guess.

### Wave B fence monitor (binding after Wave A)

After Tasks 0–3 are green + committed, **must** arm an autonomous fence monitor. Do not end the overnight run waiting for a human or “next session” if the session can still loop.

**Arm:** `/loop 15m` (or equivalent Cursor subscription / monitored-shell tick) with this exact tick prompt:

```text
Fence poll for Centurion triage-quality Wave B.
Plan: docs/superpowers/plans/2026-09-02-centurion-triage-quality-implementation.md
Worktree: /home/orca/orca/workspaces/zero/phase-1-fix (fix/phaseone)
Sibling: /home/orca/orca/workspaces/zero/wrasse (feat/centurion-link-precision)
1) Run read-only fence checklist below. 2) If CLEAR: unsubscribe this loop, then start Task 4 Wave B. 3) If NOT CLEAR and under cap: do nothing else; wait for next tick. 4) If CAP HIT: unsubscribe, write handoff “Wave B deferred — fence cap”, stop (Wave A still success). Never deploy/retag while NOT CLEAR.
```

**Each tick — read-only poll commands (adapt paths; never mutate pilot):**

```bash
# Link worktree status + hot-file mtimes
git -C /home/orca/orca/workspaces/zero/wrasse status -sb
stat -c '%Y %n' \
  /home/orca/orca/workspaces/zero/wrasse/apps/server-pilot/src/ai/worker.ts \
  /home/orca/orca/workspaces/zero/wrasse/apps/server-pilot/src/ai/workflows/mail-triage.ts \
  2>/dev/null || true
# Handoff / progress COMPLETE signals
rg -n 'COMPLETE|Task 4|CE review|Wave B|done criteria' \
  /home/orca/orca/workspaces/zero/wrasse/.superpowers/sdd/progress.md \
  /home/orca/orca/workspaces/zero/wrasse/docs/superpowers/plans/handoff-reports/2026-09-02-centurion-link-precision.md \
  2>/dev/null | tail -40
# EC2 quiet? read-only SSM — list recent ops / no in-flight deploy (no apply/retag)
# Example: ssm-run-command.sh 'pgrep -af "ops-deploy|retag-centurion|backfill-centurion-conversation" || true; test -f /home/ubuntu/repos/zero/.private/ops-writer.lock && cat /home/ubuntu/repos/zero/.private/ops-writer.lock || echo no_lock'
```

**CLEAR** = all fence bullets pass. Then: unsubscribe loop → rebase/merge link/`main` into `fix/phaseone` as needed (preserve `conversationResponded`) → Task 4.

**CAP** = stop polling at the earlier of **12h after monitor arm** or **08:00 UTC next calendar day**. On cap: unsubscribe; handoff note under `.superpowers/sdd/` or plan checkbox comment: “Wave B deferred — fence cap / link still owns pilot.” Wave A remains success.

**Backup if `/loop` dies:** queued `/continue-autonomously` (or overnight-continue) re-loads this mandate, re-runs one fence poll, re-arms loop if under cap, or starts Task 4 if CLEAR.

**If fence never clears under cap:** stop after Wave A. Leave Task 4 unchecked. Not a failure of Wave A.

### Soft code conflicts (handle in Wave A / before B)

- Link already changed `apps/server-pilot/src/ai/workflows/mail-triage.ts` and may still dirty `worker.ts`, `triage-input.ts`.
- This plan’s primary edits: `triage.ts`, mail route-filter/archive-like, retag audit, gold fixtures — mostly disjoint.
- Prompt one-liner in `mail-triage.ts`: apply only after rebasing onto latest `feat/centurion-link-precision` or `main` that contains link’s prompt/metrics wire — **never** overwrite link’s `conversationResponded` wiring.
- Before Wave B deploy: `git fetch` + rebase/merge so EC2 does not thrash between branches.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve Q1–Q11 locks. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.
- **Prefer delay Wave B over parallel pilot mutation.** Waiting until morning for Task 4 is authorized and preferred over fighting link for EC2.

### AWS / infra (use freely — Wave B only for writes)

| Resource | ID / path |
|----------|-----------|
| This worktree | `/home/orca/orca/workspaces/zero/phase-1-fix` (`fix/phaseone`) |
| Sibling link worktree | `/home/orca/orca/workspaces/zero/wrasse` (`feat/centurion-link-precision`) — do not edit |
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed Wave A:** local/worktree edits, disposable-DB Vitest, read-only SSM/SQL for gold sampling (no writes).

**Allowed Wave B (fence clear):** ops wrappers, bundle sync, deploy, migrate if needed, Centurion snapshot/retag/audit with pilot `DATABASE_URL` for **ops scripts only**.

**Forbidden always:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into a test process, editing wrasse worktree, deploying while link agent owns EC2.

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

**Wave A:** Implement Tasks 0–3 → focused Vitest (disposable DB) → spam-fp-v6 → apply/label + archive-like nav → commit on `fix/phaseone` → **arm Wave B fence monitor** (`/loop 15m`).

**Wave B (entered only via fence monitor CLEAR, or morning manual if cap deferred):** rebase as needed → deploy → dry-run retag → quality audit floors + Q11 → cohort apply → restore on fail → live spot-check.

### Done criteria

**Wave A overnight success (required):**

- [ ] Tasks 0–3 complete + committed on `fix/phaseone`
- [ ] Routine SynXis/OTA fixtures → `automated-channel`, `urgent=false`
- [ ] Promo fixtures flip `bookings`+`isSpam:false` → spam; FortiMail digests → spam + Quarantine label path tested
- [ ] Quarantine My Folder spam-scoped tests green; U3 design-plan review recorded
- [ ] spam-fp-v6 protected regressions = 0
- [ ] No pilot mutation performed during Wave A
- [ ] Fence monitor armed (`/loop 15m` or documented continue-autonomously backup) after Wave A

**Full plan success — exactly one of:**

- [ ] **Wave B complete:** Automate recall ≥80%; spam recall ≥90%; neverSpamInSpam=0; Q11 volume band vs WINDOW Un201/Rsp282/Act483; live Automate ≫0, Spam ≫9, Quarantine visible, channel notices not Urgent; all tasks complete
- [ ] **Monitor cap deferred:** handoff note recorded (“Wave B deferred — fence cap / link still owns pilot”); Task 4 left unchecked; Wave A criteria still green — **counts as overnight success**

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict (incl. missing disposable DB for Vitest), external outage that prevents required proof, or **Wave B fence cap** (then stop after Wave A + deferred handoff — not a hard fail).

## Execution Mode

**Autonomous overnight Wave A now.** Resume Task 0 → finish Tasks 0–3 → **must arm Wave B fence monitor** (`/loop 15m`). Wave B starts only on monitor CLEAR (same night) or via morning resume if cap deferred — no routine user checkpoint either way. TDD + subagent-driven development.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/ai/triage.ts` | Shared predicates; workflow refine order; apply Quarantine on spam early-return |
| `apps/server-pilot/src/ai/workflows/mail-triage.ts` | Optional one-line Q1 prompt align (fold into Task 1) |
| `apps/mail/lib/mail/route-filter.ts` + archive-like helpers | Quarantine → spam+labelIds; not archive-like |
| `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` | `--quality` floors + Q11 volume |
| `apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json` | Synthetic gold min-N |
| `apps/server-pilot/tests/ai-triage-refine.test.ts` | Force automate/spam/series/urgent |
| `apps/server-pilot/tests/spam-fp-v6.test.ts` + fixtures | FP gate |
| mail route-filter / archive-like / apply tests | Nav + label lifecycle |

---

### Task 0: Discovery + gold fixtures

**Files:**
- Create: `apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json`
- Optional private samples under `.private/` (mode 0600, not git)

**Interfaces:**
- Produces: gold cohorts with min N (Automate ≥25, promo ≥25, FortiMail ≥10, never-spam negatives ≥15); optional `40mail` fingerprint note for Task 1

- [ ] **Step 1: Read-only SSM/SQL sample** Centurion subjects/From shapes for SynXis/OTA/promo/FortiMail/40mail (no PII into git)

- [ ] **Step 2: Write synthetic gold JSON** (opaque ids + subject/body snippets sufficient for refine) documenting methodology

- [ ] **Step 3: Commit fixture only** (no raw PII)

```bash
git add apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json
git commit -m "$(cat <<'EOF'
test(triage): add Centurion quality gold fixtures for Automate/spam floors

Coverage-only audit hid empty Automate; gold min-N enables fail-closed recall.
EOF
)"
```

---

### Task 1: Shared predicates + force Automate + series-release + urgent clear

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Optional: `apps/server-pilot/src/ai/workflows/mail-triage.ts` (one-line Q1 align)
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`

**Interfaces:**
- Consumes: Task 0 gold / 40mail fingerprint when present
- Produces: shared `isRoutineSystemMail`, `hasRevenueRisk`, …; `refine:system-mail-automated`; `urgent=false` on force-automate

- [ ] **Step 1: Write failing tests**

```ts
it('workflow: routine SynXis confirm → automated-channel, not urgent', () => {
  const refined = refineTriageOutput(
    { from: 'noreply@synxis.com', subject: 'SynXis Res Confirmed', body: 'Reservation confirmed.' },
    {
      primaryFolder: 'bookings',
      isSpam: false,
      urgent: true,
      priority: 'P2',
      overlays: { booking: false, quote: false, payment: false },
      suggestedTools: [],
      sourceScope: 'external',
      automationState: 'candidate',
      humanAction: 'none',
      confidence: 0.5,
      rationale: 'test',
      policyFlags: [],
      abstainReason: null,
    },
  );
  expect(refined.primaryFolder).toBe('automated-channel');
  expect(refined.urgent).toBe(false);
  expect(refined.policyFlags).toContain('refine:system-mail-automated');
});

it('workflow: SynXis with reply-within-12h stays out of automated-channel', () => { /* … */ });
it('workflow: held series release → exceptions-recovery before automate', () => { /* … */ });
it('workflow: internal property never stays automated-channel', () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run tests/ai-triage-refine.test.ts
```

- [ ] **Step 3: Extract shared predicates; implement KTD1/KTD1b force-automate + urgent clear; fold 40mail if known; optional prompt one-liner**

- [ ] **Step 4: Run — expect PASS**

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

### Task 2: Workflow force spam (promo + FortiMail digest)

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`, `apps/server-pilot/tests/spam-fp-v6.test.ts`
- Fixtures under `apps/server-pilot/tests/fixtures/` as needed

**Interfaces:**
- Consumes: shared `salesSignal`, `isFortiMailQuarantineDigest` from Task 1
- Produces: `refine:promo-spam`, `refine:fortimail-spam`; `urgent=false`

- [ ] **Step 1: Write failing tests** — bookings+`isSpam:false`+salesSignal → spam; FortiMail digest → `refine:fortimail-spam`; LH From not spam; “quarantine room” not spam; empty-body/short-personal not spam; forced paths `urgent=false`.

- [ ] **Step 2: Run — expect FAIL**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run tests/ai-triage-refine.test.ts tests/spam-fp-v6.test.ts
```

- [ ] **Step 3: Implement KTD2** after R22 clear in refine order

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(triage): restore workflow force-spam for promo and FortiMail digests

Prompt-only spam left live Spam≈9; flip bookings/non-spam model output on salesSignal.
EOF
)"
```

---

### Task 3: Apply Quarantine label + spam-scoped My Folder chrome

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts` (`applyDurableTriageResult` spam early-return)
- Modify: `apps/mail/lib/mail/route-filter.ts` + archive-like helpers (`isArchiveLikeMailFolder`, filing snapshots, action availability)
- Test: apply/label tests; mail route-filter + archive-like contract tests

**Interfaces:**
- Consumes: `refine:fortimail-spam` policy flag
- Produces: `labelIds` includes Quarantine UUID with `spam_at` set; reserved Quarantine resolves `folder=spam`+`labelIds`

- [ ] **Step 1: Write failing tests** — FortiMail spam apply → `spam_at` + Quarantine in `labelIds` same txn; promo spam → no Quarantine; re-apply strips Quarantine; route-filter + archive-like treat Quarantine as spam-scoped not archive.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement ensure-by-name + merge/strip; KTD3a across chrome; wire name→UUID for callers**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Design-plan review for spam-scoped My Folder** — record disposition before merge

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(mail): quarantine digests get Quarantine label under spam folder

Hard-rule FortiMail spam stays in spam_at and is filterable via My Folder nav.
EOF
)"
```

---

### Task 4: Quality floors + Q11 volume + re-backfill (**Wave B only**)

**Precondition:** Entered via **Wave B fence monitor CLEAR** (see mandate), or morning manual resume after monitor **cap deferred** handoff. If fence NOT CLEAR and under cap → do not start; leave monitor running. If cap hit without CLEAR → leave this task unchecked; do not start.

**Entry steps before Step 1:**

- [ ] Confirm fence CLEAR (re-run checklist once)
- [ ] Unsubscribe fence `/loop` if still armed
- [ ] `git fetch` + rebase/merge latest link/`main` into `fix/phaseone` without clobbering `conversationResponded`

**Files:**
- Modify: `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` (+ import shared refine — no duplicated heuristics)
- Use: `apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json`
- Test: extend `apps/server-pilot/tests/centurion-triage-audit.test.ts` (or existing audit test pattern)
- Note: handoff footnote AE2 routine-system reading superseded

**Interfaces:**
- Consumes: gold fixtures; live folder counts / actionable Un/Rsp band
- Produces: `--quality` fail-closed; Q11 WINDOW band check

- [ ] **Step 1: Write failing quality-floor / Q11 CLI expectations**

- [ ] **Step 2: Implement `--quality`** — Automate ≥80%, spam ≥90%, neverSpamInSpam=0, staffOutboundInSpam=0, Q11 volume band (Automate ≫0 toward ~SynXis cohort; Spam ≫9; actionable Un/Rsp/Act vs WINDOW Un201/Rsp282/Act483 — Automate class excluded from Act)

- [ ] **Step 3: Disposable Vitest green; document ops sequence**

```text
quiesce → snapshot + KEY_PREFIX → dry-run retag → restore drill →
cohort 50 → quality+Q11 audit → 250 → remainder → final quality+Q11 →
live spot-check Automate/Spam/Quarantine/Urgent
```

- [ ] **Step 4: When executing: run ops sequence; abort+restore on floor fail**

- [ ] **Step 5: Commit scripts + fixtures (no raw PII in git)**

```bash
git commit -m "$(cat <<'EOF'
feat(ops): add Centurion triage quality floors and WINDOW volume sanity

Coverage-only green hid empty Automate and wiped spam; fail closed on recall + Q11.
EOF
)"
```

---

## Review gates during execution

- After each task: per-task correctness review
- After Task 3: design-plan review for Quarantine spam-scoped My Folder (DoD)
- Final: `ce-code-review` before complete
- Ponytail: no new schema field; shared predicates; no second audit driver

## Final verification

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server-pilot exec vitest run \
  tests/ai-triage-refine.test.ts \
  tests/spam-fp-v6.test.ts \
  tests/centurion-triage-audit.test.ts
# + mail route-filter / archive-like / apply label tests
```

Ops quality audit + Q11 + live spot-check required for Done criteria.
