# Thread Draft at Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the saved thread draft stack (manual then AI) from below all emails to above the newest email, Outlook-style, without changing draft chrome or composer hide rules.

**Architecture:** FE-only. Keep `threadDraftSection` construction. Rename MessageList slot `trailing` → `leading` and mount it after linked-banner + attachments, before `displayMessages.map`. Contract tests lock DOM order via source scan.

**Tech Stack:** React, Tailwind, Vitest (no DB).

**Spec:** [docs/superpowers/specs/2026-09-07-thread-draft-at-top-design.md](../specs/2026-09-07-thread-draft-at-top-design.md)

**Branch:** current working branch (do not create a new branch unless already on `main`).

## Global Constraints

- Never run Vitest with `DATABASE_URL` pointing at `nava-zero-mail-pilot`; always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- No new draft UI chrome; reuse `ThreadDraftCard` / `ThreadAiMailsSection`.
- Do not change `orderMessagesNewestFirst`, `mail.get` order, or print HTML order.
- Do not show draft stack while any compose `mode` is set (existing hide).
- Manual draft card before AI candidate cards (existing section order).
- YAGNI: no sticky draft, no synthetic message injection, no slots helper beyond prop rename.
- Standard non-fast subagents only; if unavailable, execute inline.

## Review disposition

| Gate | Verdict | Folded into this plan |
|------|---------|------------------------|
| gstack-plan-eng-review | READY | Leading after attachments; hide-on-mode kept; live proof DoD; FE-only |
| ponytail-review | Lean already. Ship. | No slots helper; prop rename + mount move only; one source contract test |

**Conflict:** none.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), read-only SSM checks, PM2 logs, health curl, and tests against a disposable non-production database.

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

This is Cursor's agent tool bridge, not Zero app/AWS/RDS. Full playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

**Required agent behavior:**
1. Do **not** ask the user to wait or re-invoke.
2. Backoff-retry Shell/Write/StrReplace (≈5s → 15s → 45s) until `echo shell_ok` works or three attempts fail.
3. On recovery: `git status`, read `.superpowers/sdd/*progress*`, resume mid-task (resume subagent or re-dispatch with existing uncommitted work).
4. Only if retries exhaust **and** Shell still dead after ~5 minutes: record blocker in handoff with evidence; still do not invent an app RCA.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Decision authority

- Choose best safe reversible option without asking.
- Preserve requirements. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.

### Verification loop

Implement → focused tests → relevant broader tests/build → `ops-deploy` to pilot → health curl → live DOM/order proof → fix any red → repeat.

### Done criteria

- [x] `leading` draft stack mounts after attachments and before newest message in `MessageList`
- [x] Call sites pass `leading={threadDraftSection}`; no `trailing` draft mount remains
- [x] Manual-then-AI order + hide-on-`mode` / optimistic-hide unchanged
- [x] Contract Vitest green with `DATABASE_URL` unset
- [x] Changes committed (conventional commits)
- [x] Deployed to pilot EC2 via `ops-deploy.sh`; health `8788`/`8789` ok
- [x] Live proof: thread with saved draft shows draft card above newest email; composer open hides card
- [x] No unresolved blocker affecting plan goal

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict, or external outage that prevents required proof.

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## File map

| File | Responsibility |
|------|----------------|
| `apps/mail/components/mail/thread-display.tsx` | Rename MessageList slot; mount draft leading; update call sites |
| `apps/mail/tests/thread-draft-leading-contract.test.ts` | Source-contract: leading before messages, after attachments |
| `docs/superpowers/specs/2026-09-07-thread-draft-at-top-design.md` | Locked design (already written) |

---

### Task 1: Contract test for leading draft placement (TDD)

**Files:**
- Create: `apps/mail/tests/thread-draft-leading-contract.test.ts`
- Modify (later Task 2): `apps/mail/components/mail/thread-display.tsx`

**Interfaces:**
- Consumes: on-disk source of `thread-display.tsx`
- Produces: failing assertions until `leading` exists and post-map `trailing` draft mount is gone

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const threadDisplaySource = readFileSync(
  new URL('../components/mail/thread-display.tsx', import.meta.url),
  'utf8',
);

const messageListSource = () => {
  const listStart = threadDisplaySource.indexOf('const MessageList =');
  const listEnd = threadDisplaySource.indexOf('\n};', listStart);
  if (listStart < 0 || listEnd <= listStart) {
    throw new Error('Could not locate MessageList');
  }
  return threadDisplaySource.slice(listStart, listEnd + '\n};'.length);
};

describe('thread draft leading placement contract', () => {
  it('MessageList accepts leading (not trailing) for the draft stack', () => {
    const list = messageListSource();
    expect(list).toContain('leading');
    expect(list).toMatch(/leading\s*[,}]/);
    expect(list).not.toMatch(/\btrailing\b/);
  });

  it('mounts leading after attachments and before displayMessages.map', () => {
    const list = messageListSource();
    const attachments = list.indexOf('ThreadAttachments');
    const leadingMount = list.indexOf('{leading ?');
    const messagesMap = list.indexOf('displayMessages.map');
    expect(attachments).toBeGreaterThan(-1);
    expect(leadingMount).toBeGreaterThan(attachments);
    expect(messagesMap).toBeGreaterThan(leadingMount);
  });

  it('ThreadDisplay call sites pass leading={threadDraftSection}', () => {
    expect(threadDisplaySource).toContain('leading={threadDraftSection}');
    expect(threadDisplaySource).not.toContain('trailing={threadDraftSection}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd /home/ubuntu/projects/zero
pnpm --filter @zero/mail exec vitest run tests/thread-draft-leading-contract.test.ts
```

Expected: FAIL (still `trailing`).

- [ ] **Step 3: Commit failing test only**

```bash
git add apps/mail/tests/thread-draft-leading-contract.test.ts
git commit -m "$(cat <<'EOF'
test(mail): add failing contract for draft stack above newest email

EOF
)"
```

---

### Task 2: Flip trailing → leading in MessageList

**Files:**
- Modify: `apps/mail/components/mail/thread-display.tsx` (`MessageListProps`, `MessageList`, both `MessageList` call sites)

**Interfaces:**
- Consumes: existing `threadDraftSection` ReactNode
- Produces: `leading?: ReactNode` rendered after attachments / before messages

- [ ] **Step 1: Implement minimal change**

In `MessageListProps` / destructuring: rename `trailing` → `leading`.

Both call sites:

```tsx
leading={threadDraftSection}
```

Inside `MessageList`, **move** the leading block from after `displayMessages.map` to immediately after the attachments block and **before** `displayMessages.map`:

```tsx
{allThreadAttachments && allThreadAttachments.length > 0 ? (
  <div className="min-w-0 w-full max-w-full px-4">
    <ThreadAttachments attachments={allThreadAttachments} />
  </div>
) : null}
{leading ? (
  <div className={cn('duration-200', displayMessages.length > 0 && 'border-border border-b')}>
    {leading}
  </div>
) : null}
{displayMessages.map((message, index) => {
  // ... unchanged
})}
```

Notes:
- Prefer `border-b` under the draft stack (draft above messages) instead of the old trailing `border-t`.
- Do not alter `threadDraftSection` construction, hide rules, or card components.

- [ ] **Step 2: Run contract + related tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run \
  tests/thread-draft-leading-contract.test.ts \
  tests/thread-display-order.test.ts \
  tests/reply-composer-viewport-contract.test.ts \
  tests/thread-pane-layout-contract.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/components/mail/thread-display.tsx apps/mail/tests/thread-draft-leading-contract.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): show thread draft stack above newest email

EOF
)"
```

---

### Task 3: Deploy + live proof on pilot

**Files:** none (ops only). Optional handoff under `docs/superpowers/plans/handoff-reports/` if useful.

- [ ] **Step 1: Push branch if remote tracking requires it, then deploy**

```bash
# from repo root; use existing branch
apps/server-pilot/deploy/ops-deploy.sh
```

- [ ] **Step 2: Verify health + SHA**

Via SSM / ops wrappers: confirm EC2 HEAD matches commit; curl health on `8788`/`8789`; stamp `NAVA_BUILD_COMMIT` if deploy left it stale (same pattern as scrollbar deploy).

- [ ] **Step 3: Live proof**

Playwright or operator check on pilot mail UI:

1. Open a thread that already has a saved reply draft (or create Reply → type → leave so draft saves).
2. Assert draft card (`Draft` badge / unsent notice) is **above** the newest non-draft email and **below** attachments/banner if present.
3. Click Reply → draft card hidden while composer open.
4. Close composer without send → draft card returns at top.

- [ ] **Step 4: Handoff (short)**

Write brief evidence (SHA, health, proof steps) to  
`docs/superpowers/plans/handoff-reports/2026-09-07-thread-draft-at-top.md`  
and commit if the plan requires durable evidence.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Draft above newest email, below banner/attachments | Task 2 mount order |
| Manual then AI | Unchanged `threadDraftSection` order |
| Hide on compose mode | Unchanged; not regress |
| Approach 1 leading slot | Tasks 1–2 |
| Contract Vitest, no pilot RDS | Task 1–2 commands |
| Pilot live proof | Task 3 |

No placeholders. Scope = FE placement only.
