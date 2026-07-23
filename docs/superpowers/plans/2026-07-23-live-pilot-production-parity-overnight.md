# Live Pilot Production Parity Overnight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every** Task/subagent dispatch MUST set `model: "cursor-grok-4.5-high"` (Grok 4.5 High, slow — never `*-fast*`, never omit model / inherit).

**Goal:** Make EC2 `EC2-pilot` a production hotel mailbox: auth, near-realtime UI, attachments, undo/schedule, inbox-first+AI folders, honesty/safeties, plus Playwright real-mail UI gate (browser login → compose self → reply self → see without F5 via poll + Force Sync).

**Architecture:** Keep `apps/mail` FE + `apps/server-pilot` POP3/SMTP. Fix Better Auth trustedOrigins for nginx SPA. Default 15s list poll + real `forceSync` → `ingestOnce`. Outbound queue with undo window; gate uses `UNDO_SEND_SECONDS=0` (same queue + sync flush). Direct-To → Inbox then AI triage. Ephemeral Playwright on EC2 against `https://nava.legacy.local` / `https://127.0.0.1`.

**Tech Stack:** TypeScript, tRPC, Better Auth, Drizzle/Postgres, Vitest, Playwright, React Router mail SPA, PM2, AWS SSM/EC2/RDS/S3.

**Spec / decisions:** [docs/plans/2026-07-23-001-feat-live-pilot-production-parity-plan.md](../../plans/2026-07-23-001-feat-live-pilot-production-parity-plan.md) (ce-plan + eng-review + Terra outside voice). This file = executable overnight task breakdown.

**Branch:** `EC2-pilot`

## Global Constraints

- Real mail stays `MAIL_TRANSPORT_MODE=real` on EC2 for UI gate. Do not flip to fixture for U9.
- Primary deploy: `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema). Bounce: `ops-restart.sh`.
- **All subagents (implementer + reviewer + fix + whole-branch review): model slug `cursor-grok-4.5-high` only.** That is Grok 4.5 High (slow / non-fast). Forbidden: `cursor-grok-4.5-high-fast`, any `*-fast*`, Composer Fast, omit `model` (no inherit).
- Execution path: **subagent-driven-development** (locked — not inline executing-plans unless hard BLOCKED and logged).
- Orchestrator + every subagent: respond `/caveman ultra`. Technical terms exact.
- `mail.ts` edits **serial only** across Tasks that touch it (Tasks 2, 4, 6, 7) — never parallel two subagents on `mail.ts`.
- No force-push main, no `--no-verify`, no destructive git, no IT Exchange/VPN cred rotation.
- Decision policy: safe > unsafe; do work > skip; no trivia blocks — log + continue.
- PartyKit / full AI chat / Centurion multi-user / Rocketseed / long-term CI Playwright suite = out of scope.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause. Ship Tasks 1–12 green on EC2.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- **Subagent model (mandatory, non-negotiable):** `cursor-grok-4.5-high` — Grok 4.5 High, **slow version only**. Implementer, task-reviewer, fix agent, and whole-branch reviewer all use this slug.
- **Forbidden model slugs:** any `*-fast*` (including `cursor-grok-4.5-high-fast` if it exists), Composer Fast, or omitting `model` so the child inherits a fast default.

### Subagent-Driven Development (locked)

Likely / required path for this overnight wave: **superpowers:subagent-driven-development**.

```text
Per task:
  1. Dispatch implementer  model=cursor-grok-4.5-high
  2. If questions → answer from this plan / ce-plan; never block human
  3. Implementer: TDD → green → commit → self-review
  4. Dispatch task-reviewer model=cursor-grok-4.5-high on the diff
  5. Critical/Important findings → fix subagent (same model) → re-review
  6. Mark task done → next task immediately (no human checkpoint)
After all tasks: whole-branch review (cursor-grok-4.5-high) → EC2 deploy → U9 gate → handoff report
```

Pass each implementer: task section verbatim + Global Constraints + relevant Interfaces from prior tasks + research facts below.

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, Playwright on-box, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [x] Tasks 1–11 implemented + committed on `EC2-pilot`
- [x] Task 12: EC2 `ops-deploy` + Playwright AE1/AE7/AE8/AE9 green via SSM
- [x] Handoff report under `docs/superpowers/plans/handoff-reports/`
- [x] No open blockers for R1–R11 / AE1–AE9 from ce-plan
- [x] Every Task tool call used `model: "cursor-grok-4.5-high"` (no fast)

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?". **Every** subagent: `model: "cursor-grok-4.5-high"` (Grok 4.5 High slow — never fast). Continuous until Done criteria or hard BLOCKED.

## Research Facts (95% — do not rediscover)

| Fact | Location |
|------|----------|
| No `trustedOrigins` in pilot | `apps/server-pilot/src/lib/auth.ts` `createAuth` L75–121 |
| Cloudflare server has pattern | `apps/server/src/lib/auth.ts` L358+ |
| `BETTER_AUTH_URL` default wrong | `write-ec2-env.sh` L11 → `http://127.0.0.1:8788` |
| `mail.send` returns `{sent:true,...}` | `mail.ts` ~L1047; no attachments forwarded to SMTP |
| `OutboundMailPayload` has no attachments | `smtp.ts` L12–34 |
| `forceSync` stub | `mail.ts` L1084–1086 `{triggered:true}` |
| Real ingest | `ingestOnce` in `worker.ts` L101+ |
| Poll: unset → null | `thread-polling-policy.ts`; test expects null |
| Direct-To → spam | `store.ts` `findDirectToTransport` + `spamAt` when no `X-Zero-Mailbox` |
| FE download `atob(body)` | `mail-display.tsx`; `getMessageAttachments` returns `body:''`; use `getAttachment` |
| Playwright gate defaults frontend-only=1 | `playwright-ec2-gate.sh` |
| Vitest | `pnpm -C apps/server-pilot test` / `pnpm -C apps/mail test` |
| FakeSmtp | `FakeSmtpTransport` + `__setSmtpTransportForTests` in `mail-send.test.ts` |
| `sendInput` has attachments keys, **no** inReplyTo/references/headers/replyToMessageId | `wire-compat.ts` L38–52; attachments: name/type/size/lastModified/base64 |
| FE reply sends `headers: { In-Reply-To, References }` | `reply-composer.tsx` L179–202 — **stripped** by pilot zod |
| Server rebuilds reply from **latest** thread msg | `mail.ts` ~L855–873 |
| FE expects `{queued\|scheduled:true, messageId, sendAt?}` | `email-utils.ts` L225–235 |
| Message schema has `sentAt` only — **no** outbound queue cols | `db/schema/mail.ts` L249–291 |
| Direct-To spamAt | `store.ts` L174–185 → L220–234 |
| `shouldShowSupportLinks` = `!isFrontendOnlyDemo` | `support-links.ts` L9–13 — shows Live Support on live pilot |
| Print XSS: subject unescaped | `mail-display.tsx` `printMail`; `thread-display.tsx` `printThread` (escapePrintHtml exists but unused on subject) |
| CategoryDropdown → `labelIds` not `categoryIds` | `mail.tsx` CategoryDropdown → `use-threads.ts` L139–141 |
| `ingestOnce` safe to import from tRPC | `worker.ts` CLI-guarded; no cycle into routes |

## File Map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/lib/auth.ts` | trustedOrigins + env CSV |
| `apps/server-pilot/deploy/write-ec2-env.sh` | BETTER_AUTH_URL, UNDO_SEND_SECONDS, AI_WRITE_GATE |
| `apps/server-pilot/src/trpc/routes/mail.ts` | send/unsend/forceSync/attachments |
| `apps/server-pilot/src/mail/send/smtp.ts` | nodemailer attachments |
| `apps/server-pilot/src/mail/send/outbound-queue.ts` | NEW queue claim/flush (or under `mail/send/`) |
| `apps/server-pilot/src/mail/ingest/store.ts` | inbox-first (no spamAt on direct-To) |
| `apps/server-pilot/src/mail/ingest/worker.ts` | export/use ingestOnce from forceSync |
| `apps/mail/lib/mail/thread-polling-policy.ts` | default 15000 |
| `apps/mail/hooks/use-attachments.ts` / `mail-display.tsx` | signed URL download |
| `apps/mail/lib/demo/support-links.ts` | hide Live Support |
| `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh` | NEW real-mail gate |
| `apps/mail/tests/e2e/real-mail-*.spec.ts` | browser login / compose / reply / forceSync |

## Git Commit Strategy

| Task | Commit message |
|------|----------------|
| 1 | `fix(auth): trustedOrigins + BETTER_AUTH_URL for nava.legacy.local` |
| 2 | `feat(mail): default 15s thread poll + real forceSync ingestOnce` |
| 3 | `feat(deploy): playwright real-mail UI gate + browser login/compose/forceSync specs` |
| 4 | `fix(mail): reply headers from selected message + reply-all proof` |
| 5 | `test(e2e): real-mail reply loopback after header fix` |
| 6 | `feat(mail): SMTP attachments + FE getAttachment download` |
| 7 | `feat(mail): undo/schedule outbound queue with UNDO_SEND_SECONDS` |
| 8 | `fix(ingest): inbox-first direct-To; AI degraded containment` |
| 9 | `fix(mail-ui): hide dead support/fake saves; Nava login copy` |
| 10 | `fix(security): print XSS escape + seed/wipe gates` |
| 11 | `feat(mail-ui): hotel folder colors + categoryIds filter` |
| 12 | `docs(pilot): overnight parity handoff report` |

Rules: one commit per task after green tests; RCA = separate `fix(...):` commit; no amend/force-push/`--no-verify`.

---

### Task 1: Auth trustedOrigins + deploy BETTER_AUTH_URL + Nava login copy

**Files:**
- Modify: `apps/server-pilot/src/lib/auth.ts`
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`
- Create: `apps/server-pilot/tests/auth-trusted-origins.test.ts` (or extend existing auth test)
- Modify: `apps/mail/app/(auth)/login/login-client.tsx` and/or `apps/mail/app/(auth)/zero/login/page.tsx` — replace user-facing "Zero" with "Nava" where login headings say Zero

**Interfaces:**
- Consumes: `createAuth(opts?)`, env `BETTER_AUTH_URL`, optional `BETTER_AUTH_TRUSTED_ORIGINS` (CSV)
- Produces: betterAuth config with `trustedOrigins: string[]` including `https://nava.legacy.local`, `https://127.0.0.1`, and CSV extras; deploy default `BETTER_AUTH_URL=https://nava.legacy.local`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server-pilot/tests/auth-trusted-origins.test.ts
import { describe, expect, it } from 'vitest';

/** Pure helper — extract from auth.ts for unit test without booting betterAuth DB */
import { resolvePilotTrustedOrigins } from '../src/lib/auth';

describe('resolvePilotTrustedOrigins', () => {
  it('includes nava.legacy.local and 127.0.0.1 by default', () => {
    const origins = resolvePilotTrustedOrigins({});
    expect(origins).toContain('https://nava.legacy.local');
    expect(origins).toContain('https://127.0.0.1');
  });

  it('merges BETTER_AUTH_TRUSTED_ORIGINS CSV', () => {
    const origins = resolvePilotTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://extra.example, http://localhost:3000',
    });
    expect(origins).toContain('https://extra.example');
    expect(origins).toContain('http://localhost:3000');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (helper missing)

```bash
pnpm -C apps/server-pilot exec vitest run tests/auth-trusted-origins.test.ts
```

- [ ] **Step 3: Implement helper + wire createAuth**

```typescript
// in auth.ts — add before createAuth
export function resolvePilotTrustedOrigins(
  env: Record<string, string | undefined>,
): string[] {
  const base = [
    'https://nava.legacy.local',
    'https://127.0.0.1',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ];
  const extra = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...base, ...extra])];
}

// inside betterAuth({...}):
trustedOrigins: resolvePilotTrustedOrigins(env),
```

- [ ] **Step 4: write-ec2-env.sh**

Change default:
```bash
: "${BETTER_AUTH_URL:=https://nava.legacy.local}"
: "${UNDO_SEND_SECONDS:=30}"
```
Always write `UNDO_SEND_SECONDS` into `.env.production` heredoc (gate will override to `0` later).

- [ ] **Step 5: Nava login copy** — grep auth pages for "Zero"; replace user-visible product name with Nava (keep route `/zero/login` if provider id).

- [ ] **Step 6: Tests green + commit**

```bash
pnpm -C apps/server-pilot exec vitest run tests/auth-trusted-origins.test.ts
git add apps/server-pilot/src/lib/auth.ts apps/server-pilot/deploy/write-ec2-env.sh apps/server-pilot/tests/auth-trusted-origins.test.ts apps/mail/app/\(auth\)
git commit -m "fix(auth): trustedOrigins + BETTER_AUTH_URL for nava.legacy.local"
```

---

### Task 2: Default 15s poll + real forceSync (mailbox lock)

**Files:**
- Modify: `apps/mail/lib/mail/thread-polling-policy.ts`
- Modify: `apps/mail/tests/thread-polling-policy.test.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (`forceSync`)
- Modify: `apps/server-pilot/deploy/deploy-ec2.sh` or FE build env — bake `VITE_MAIL_POLL_MS=15000`
- Create/extend: `apps/server-pilot/tests/force-sync.test.ts`
- Modify: sync indicator consumers (`nav-user.tsx` / `use-do-state.ts`) so "Syncing…" not stuck forever when Do_State empty — drive from forceSync mutation `isPending` + last success

**Interfaces:**
- Consumes: `ingestOnce` from `apps/server-pilot/src/mail/ingest/worker.ts`
- Produces: `forceSync` → `{ triggered: true, processed: number, listed: number, deled?: number, cycleError?: string }`
- Produces: `resolveThreadPollingMs(undefined) === 15000`

- [ ] **Step 1: Flip poll policy test (characterization → new contract)**

```typescript
// thread-polling-policy.test.ts
it('defaults to 15000 when unset', () => {
  expect(resolveThreadPollingMs(undefined)).toBe(15000);
});
it('rejects below 15s', () => {
  expect(resolveThreadPollingMs('1000')).toBe(null);
});
```

- [ ] **Step 2: Implement default**

```typescript
export function resolveThreadPollingMs(value?: string): number | null {
  if (!value) return 15_000;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 15_000) return null;
  return ms;
}
```

- [ ] **Step 3: forceSync failing test**

```typescript
// force-sync.test.ts — use FakePop3 + withSeededTestDb pattern from mail-send.test.ts
it('forceSync runs ingestOnce and returns processed counts', async () => {
  // arrange FakePop3 with 1 message; stub getSmtp not needed
  const result = await caller.mail.forceSync();
  expect(result.triggered).toBe(true);
  expect(result.processed).toBeGreaterThanOrEqual(0);
  expect(typeof result.listed).toBe('number');
});
```

- [ ] **Step 4: Implement forceSync**

Replace stub with:
```typescript
forceSync: mailboxProcedure.mutation(async ({ ctx }) => {
  // mailbox-scoped in-memory lock (module Map) — if held, wait up to 30s or return cycleError
  const { ingestOnce } = await import('../../mail/ingest/worker');
  const cycle = await ingestOnce({ /* maxMessages from env */ });
  return {
    triggered: true,
    processed: cycle.processed,
    listed: cycle.listed,
    deled: cycle.deled,
    cycleError: cycle.cycleError,
  };
}),
```

FE: on Force Sync click, await mutation → invalidate `mail.listThreads` queries.

- [ ] **Step 5: Green + commit**

```bash
pnpm -C apps/mail exec vitest run tests/thread-polling-policy.test.ts
pnpm -C apps/server-pilot exec vitest run tests/force-sync.test.ts
git commit -m "feat(mail): default 15s thread poll + real forceSync ingestOnce"
```

---

### Task 3: Playwright real-mail UI gate (U9a — login, compose, forceSync)

**Files:**
- Create: `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh`
- Create: `apps/mail/tests/e2e/real-mail-browser-login.spec.ts`
- Create: `apps/mail/tests/e2e/real-mail-compose-self-loopback.spec.ts`
- Create: `apps/mail/tests/e2e/real-mail-force-sync-loopback.spec.ts`
- Reuse mint helpers from `playwright-ec2-gate.sh` but **refuse** if `ZERO_DEMO_FRONTEND_ONLY=1`

**Interfaces:**
- Consumes: Task 1 auth, Task 2 poll/forceSync, PM2 with `UNDO_SEND_SECONDS=0` (current send already `{sent:true}` until Task 7)
- Produces: SSM-runnable gate exit 0 for AE1, AE7, AE9

- [ ] **Step 1: Gate script skeleton**

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"
# HARD REFUSE demo mode
if [ "${ZERO_DEMO_FRONTEND_ONLY:-0}" = "1" ] || [ "${VITE_FRONTEND_ONLY:-0}" = "1" ]; then
  echo "refusing: frontend-only demo mode on for real-mail gate" >&2
  exit 2
fi
export ZERO_DEMO_FRONTEND_ONLY=0 VITE_FRONTEND_ONLY=0
export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-https://127.0.0.1}"
export PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1
# SPA freshness: index.html mtime must be recent OR document skip with warning
# Ensure UNDO_SEND_SECONDS=0 in apps/server-pilot/.env.production then ops-restart if needed
# Mint optional cookies for non-login specs; login.spec MUST use UI form
pnpm install --frozen-lockfile
cd packages/testing
pnpm exec playwright test \
  ../../apps/mail/tests/e2e/real-mail-browser-login.spec.ts \
  ../../apps/mail/tests/e2e/real-mail-compose-self-loopback.spec.ts \
  ../../apps/mail/tests/e2e/real-mail-force-sync-loopback.spec.ts
```

- [ ] **Step 2: Browser login spec** — navigate `/login` or `/zero/login`, fill `navaai@legacyhotels.co.za` + password from env/SM, submit, expect inbox visible. **No curl-only success.**

- [ ] **Step 3: Compose spec** — unique subject `OVN-${Date.now()}`, To self, Send, **no page.reload**, wait ≥60s OR click Force Sync, assert subject in list.

- [ ] **Step 4: Force Sync spec** — after send, pause/disable poll if possible, click Force Sync, wait for network response with `processed`, assert marker (KTD12).

- [ ] **Step 5: Commit scripts (local). EC2 run is Task 12.

```bash
git add apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh apps/mail/tests/e2e/
git commit -m "feat(deploy): playwright real-mail UI gate + browser login/compose/forceSync specs"
```

---

### Task 4: Reply selected-message headers + reply-all proof

**Files:**
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts` (`sendInput` at L38–65)
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (reply header block ~L852–873; keep draft stale checks)
- Modify: `apps/mail/components/mail/reply-composer.tsx` (~L179–202 send payload)
- Extend: `apps/server-pilot/tests/mail-send.test.ts`
- Keep green: `apps/mail/tests/reply-recipients.test.ts`

**Interfaces:**
- Consumes: FE today sends `headers: { 'In-Reply-To', References }` which **zod strips** (not in `sendInput`)
- Produces: `sendInput` gains optional:
  ```typescript
  replyToMessageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  ```
- Produces: SMTP/`buildReplyHeaders` uses **selected** message when `replyToMessageId` set; else `inReplyTo`/`references` if provided; else latest-thread fallback (current behavior)

- [ ] **Step 1: Write failing FakeSmtp test**

```typescript
// apps/server-pilot/tests/mail-send.test.ts — add case using existing seeded DB helpers
it('uses selected message Message-ID for In-Reply-To when replyToMessageId set', async () => {
  // Seed thread with olderMsg.messageIdHeader = '<old@x>' and newerMsg = '<new@x>'
  // (newer has later receivedAt so "latest" path would pick <new@x>)
  const fake = new FakeSmtpTransport();
  __setSmtpTransportForTests(fake);
  try {
    await caller.mail.send({
      threadId,
      to: ['a@example.com'],
      subject: 'Re: x',
      html: '<p>hi</p>',
      text: 'hi',
      replyToMessageId: olderMsg.id, // DB message.id, not RFC id
    });
    expect(fake.sent[0].inReplyTo).toBe('<old@x>');
  } finally {
    __setSmtpTransportForTests(null);
  }
});

it('reply-all cc envelope matches input.cc', async () => {
  const fake = new FakeSmtpTransport();
  __setSmtpTransportForTests(fake);
  try {
    await caller.mail.send({
      threadId,
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Re: x',
      html: '<p>hi</p>',
      text: 'hi',
      replyToMessageId: olderMsg.id,
    });
    expect(fake.sent[0].to).toEqual(expect.arrayContaining(['a@example.com']));
    expect(fake.sent[0].cc).toEqual(expect.arrayContaining(['b@example.com']));
  } finally {
    __setSmtpTransportForTests(null);
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (zod rejects `replyToMessageId` OR still uses latest `<new@x>`)

```bash
pnpm -C apps/server-pilot exec vitest run tests/mail-send.test.ts
```

Expected: FAIL mentioning unknown key / wrong `inReplyTo`.

- [ ] **Step 3: Extend sendInput**

```typescript
// wire-compat.ts — inside sendInput object schema, before .transform:
replyToMessageId: z.string().optional(),
inReplyTo: z.string().optional(),
references: z.array(z.string()).optional(),

// and pass through in transform:
replyToMessageId: input.replyToMessageId,
inReplyTo: input.inReplyTo,
references: input.references,
```

- [ ] **Step 4: Resolve headers in mail.send**

```typescript
// Replace "latest only" block (~L855–873) with:
if (threadId) {
  await requireThreadForTransport(db, threadId, transportId);
  if (input.replyToMessageId) {
    const selected = await db
      .select({
        messageIdHeader: message.messageIdHeader,
        references: message.references,
      })
      .from(message)
      .where(
        and(
          eq(message.id, input.replyToMessageId),
          eq(message.threadId, threadId),
          eq(message.transportId, transportId),
        ),
      )
      .limit(1);
    if (!selected[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'REPLY_TO_MESSAGE_NOT_FOUND' });
    }
    const headers = buildReplyHeaders(selected[0]!);
    inReplyTo = headers.inReplyTo;
    references = headers.references;
  } else if (input.inReplyTo) {
    inReplyTo = input.inReplyTo;
    references = input.references ?? [];
  } else {
    const prior = await db
      .select({
        messageIdHeader: message.messageIdHeader,
        references: message.references,
      })
      .from(message)
      .where(and(eq(message.threadId, threadId), eq(message.transportId, transportId)))
      .orderBy(desc(message.receivedAt))
      .limit(1);
    if (prior[0]) {
      const headers = buildReplyHeaders(prior[0]!);
      inReplyTo = headers.inReplyTo;
      references = headers.references;
    }
  }
}
```

- [ ] **Step 5: FE reply-composer** — add `replyToMessageId: replyToMessage?.id` on send payload (keep existing `headers` for forward-compat; pilot may ignore headers until optional later).

```typescript
await sendEmail({
  threadId,
  to: ...,
  cc: ...,
  subject: ...,
  message: emailBody,
  attachments: await serializeFiles(data.attachments),
  fromEmail,
  draftId: draftId ?? undefined,
  replyToMessageId: replyToMessage?.id,
  headers: {
    'In-Reply-To': replyToMessage?.messageId ?? '',
    References: [ ... ],
  },
});
```

- [ ] **Step 6: Green + commit**

```bash
pnpm -C apps/server-pilot exec vitest run tests/mail-send.test.ts
pnpm -C apps/mail exec vitest run tests/reply-recipients.test.ts
git add apps/server-pilot/src/trpc/wire-compat.ts apps/server-pilot/src/trpc/routes/mail.ts apps/mail/components/mail/reply-composer.tsx apps/server-pilot/tests/mail-send.test.ts
git commit -m "fix(mail): reply headers from selected message + reply-all proof"
```

---

### Task 5: Playwright reply loopback (U9b)

**Files:**
- Create: `apps/mail/tests/e2e/real-mail-reply-loopback.spec.ts`
- Modify: `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh` (add spec path)

**Interfaces:**
- Consumes: Task 4 `replyToMessageId`; Task 3 gate env (`ZERO_DEMO_FRONTEND_ONLY=0`, `PLAYWRIGHT_BASE_URL`)
- Produces: AE8 covered on EC2 in Task 12

- [ ] **Step 1: Write spec**

```typescript
// apps/mail/tests/e2e/real-mail-reply-loopback.spec.ts
import { test, expect } from '@playwright/test';

test('reply self appears without full page reload', async ({ page }) => {
  // Login via UI (same helpers as real-mail-browser-login) OR storageState from gate
  const marker = `REPLY-${Date.now()}`;
  // Open an existing self-thread OR compose first then open it
  // Click Reply; fill body with marker; Send
  // Do NOT page.reload()
  // Prefer Force Sync click; also allow poll wait up to 90_000
  await expect(page.getByText(marker)).toBeVisible({ timeout: 90_000 });
});
```

- [ ] **Step 2: Wire into gate script** — append path to `pnpm exec playwright test ...` list in `playwright-real-mail-ui-gate.sh`.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/tests/e2e/real-mail-reply-loopback.spec.ts apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh
git commit -m "test(e2e): real-mail reply loopback after header fix"
```

---

### Task 6: Attachment send + download

**Files:**
- Modify: `apps/server-pilot/src/mail/send/smtp.ts` — `OutboundMailPayload` + FakeSmtp + RealSmtp
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` — map `input.attachments` (stop `attachments: []` on draft revision ~L1029; pass buffers to SMTP)
- Modify: `apps/mail/components/mail/mail-display.tsx` — `downloadAttachment` when `!attachment.body`
- Extend: `apps/server-pilot/tests/mail-send.test.ts`

**Interfaces:**
- Consumes: `serializedAttachmentInput` `{ name, type, size, lastModified, base64 }` already on `sendInput`
- Consumes: `getAttachment` query `{ messageId, attachmentId }` → `{ url, filename, ... }` (already implemented L1181+)
- Produces: SMTP payload `attachments?: { filename: string; content: Buffer | string; contentType?: string }[]`

- [ ] **Step 1: Extend FakeSmtp + failing test**

```typescript
// smtp.ts FakeSmtpTransport — push full payload including attachments into this.sent
it('forwards one PDF attachment to SMTP', async () => {
  const fake = new FakeSmtpTransport();
  __setSmtpTransportForTests(fake);
  const pdfB64 = Buffer.from('%PDF-1.4').toString('base64');
  try {
    await caller.mail.send({
      to: ['a@example.com'],
      subject: 'with pdf',
      html: '<p>x</p>',
      text: 'x',
      attachments: [
        { name: 'a.pdf', type: 'application/pdf', size: 8, lastModified: 0, base64: pdfB64 },
      ],
    });
    expect(fake.sent[0].attachments?.[0]?.filename).toBe('a.pdf');
    expect(fake.sent[0].attachments?.[0]?.content).toBeTruthy();
  } finally {
    __setSmtpTransportForTests(null);
  }
});
```

- [ ] **Step 2: Run — FAIL** (attachments ignored / undefined)

```bash
pnpm -C apps/server-pilot exec vitest run tests/mail-send.test.ts
```

- [ ] **Step 3: Implement SMTP types + nodemailer**

```typescript
// OutboundMailPayload add:
attachments?: { filename: string; content: Buffer | string; contentType?: string }[];

// RealSmtpTransport sendMail({
//   ...,
//   attachments: payload.attachments?.map((a) => ({
//     filename: a.filename,
//     content: a.content,
//     contentType: a.contentType,
//   })),
// })
```

- [ ] **Step 4: mail.send mapping**

```typescript
const smtpAttachments = (input.attachments ?? []).map((a) => ({
  filename: a.name,
  content: Buffer.from(a.base64, 'base64'),
  contentType: a.type,
}));
// pass smtpAttachments into transport.send(...)
// draft revision attachments: store metadata [{ name, type, size }] not empty []
```

- [ ] **Step 5: FE download**

```typescript
// mail-display.tsx downloadAttachment — when !attachment.body:
const { url } = await trpcClient.mail.getAttachment.query({
  messageId: emailData.id, // message id in scope
  attachmentId: attachment.attachmentId,
});
const res = await fetch(url);
const blob = await res.blob();
const objectUrl = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = objectUrl;
a.download = attachment.filename;
a.click();
URL.revokeObjectURL(objectUrl);
```

- [ ] **Step 6: Green + commit**

```bash
pnpm -C apps/server-pilot exec vitest run tests/mail-send.test.ts
git add apps/server-pilot/src/mail/send/smtp.ts apps/server-pilot/src/trpc/routes/mail.ts apps/mail/components/mail/mail-display.tsx apps/server-pilot/tests/mail-send.test.ts
git commit -m "feat(mail): SMTP attachments + FE getAttachment download"
```

---

### Task 7: Undo / schedule outbound queue (`UNDO_SEND_SECONDS`)

**Files:**
- Create: migration under `apps/server-pilot/src/db/` for table `outbound_send_queue`
- Create: `apps/server-pilot/src/mail/send/outbound-queue.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (`send`, `unsend`)
- Modify: `apps/server-pilot/src/mail/ingest/worker.ts` (or POP3 cycle) — call `flushDue()` each tick
- Create: `apps/server-pilot/tests/outbound-queue.test.ts`
- Confirm: `write-ec2-env.sh` writes `UNDO_SEND_SECONDS` (Task 1)

**Interfaces:**
- `getUndoSendSeconds(): number` ← `Number(process.env.UNDO_SEND_SECONDS ?? '30')`
- Table columns (exact):
  - `id` text PK
  - `transportId` text
  - `messageId` text (FK to message.id)
  - `sendAt` timestamptz
  - `status` text — `'pending' | 'sending' | 'sent' | 'cancelled'`
  - `smtpPayload` jsonb — full snapshot incl attachments as base64
  - `attempts` int default 0
  - `lastError` text null
  - `claimedAt` timestamptz null
  - `createdAt` / `updatedAt` timestamptz
- Return shapes (must match `apps/mail/lib/email-utils.ts`):
  ```typescript
  { queued: true, messageId: string, sendAt: number }      // ms epoch
  { scheduled: true, messageId: string, sendAt: number }
  { sent: true, messageId, threadId, fromEmail, smtpMessageId } // after sync flush when undo=0
  ```
- FE field: `scheduleAt?: string` (ISO) from `create-email.tsx` / `reply-composer.tsx` — add to `sendInput` in Task 7 if not already present
- `unsend({ messageId })` → cancel if `status==='pending' && now < sendAt`; else honest error (do not silent-delete sent)

- [ ] **Step 1: Failing tests**

```typescript
// apps/server-pilot/tests/outbound-queue.test.ts
describe('outbound queue', () => {
  it('undo before sendAt → no SMTP', async () => {
    process.env.UNDO_SEND_SECONDS = '30';
    const fake = new FakeSmtpTransport();
    __setSmtpTransportForTests(fake);
    const r = await caller.mail.send({ to: ['a@example.com'], subject: 'u', html: '<p>x</p>', text: 'x' });
    expect(r).toMatchObject({ queued: true });
    await caller.mail.unsend({ messageId: r.messageId });
    expect(fake.sent).toHaveLength(0);
  });

  it('after sendAt flush → SMTP once', async () => {
    process.env.UNDO_SEND_SECONDS = '30';
    // send with sendAt forced past via queue helper or clock stub
    await flushDue();
    expect(fake.sent).toHaveLength(1);
    await flushDue();
    expect(fake.sent).toHaveLength(1); // idempotent
  });

  it('UNDO_SEND_SECONDS=0 → sync flush → sent:true', async () => {
    process.env.UNDO_SEND_SECONDS = '0';
    const fake = new FakeSmtpTransport();
    __setSmtpTransportForTests(fake);
    const r = await caller.mail.send({ to: ['a@example.com'], subject: 'now', html: '<p>x</p>', text: 'x' });
    expect(r).toMatchObject({ sent: true });
    expect(fake.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
pnpm -C apps/server-pilot exec vitest run tests/outbound-queue.test.ts
```

Expected: FAIL (module/table missing or still immediate `{sent:true}` without queue).

- [ ] **Step 3: Schema + `outbound-queue.ts`**

```typescript
// outbound-queue.ts public API
export function getUndoSendSeconds(): number;
export async function enqueueOutbound(args: {
  transportId: string;
  messageId: string;
  sendAt: Date;
  smtpPayload: OutboundMailPayload;
}): Promise<void>;
export async function cancelOutbound(messageId: string, transportId: string): Promise<boolean>;
export async function flushDue(opts?: { limit?: number }): Promise<{ flushed: number }>;
export async function flushOne(messageId: string, transportId: string): Promise<void>;
```

Claim pattern: `UPDATE ... SET status='sending', claimedAt=now() WHERE status='pending' AND sendAt<=now() RETURNING *` then SMTP then `status='sent'`. On crash mid-send, status stays `sending` with `claimedAt` older than N minutes → reclaimable (document N=5 in code).

- [ ] **Step 4: Wire mail.send** — insert outbound message row + enqueue; if `getUndoSendSeconds()===0` call `flushOne` before return `{sent:true}`; if FE `scheduleAt` (ISO string on create-email / reply-composer) present → `{scheduled:true, sendAt}`.

- [ ] **Step 5: Wire unsend** — `cancelOutbound`; only delete/cancel pending queue row + message if still pending.

- [ ] **Step 6: Worker tick** — after each POP3 `ingestOnce` cycle (or dedicated interval in worker), `await flushDue()`.

- [ ] **Step 7: Green + commit**

```bash
pnpm -C apps/server-pilot exec vitest run tests/outbound-queue.test.ts tests/mail-send.test.ts
git add apps/server-pilot/src/db apps/server-pilot/src/mail/send/outbound-queue.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/mail/ingest/worker.ts apps/server-pilot/tests/outbound-queue.test.ts
git commit -m "feat(mail): undo/schedule outbound queue with UNDO_SEND_SECONDS"
```

**Gate note:** Task 12 must set **PM2** `UNDO_SEND_SECONDS=0` (write `.env.production` + `ops-restart`), not shell-only export.

---

### Task 8: Inbox-first ingest + AI degraded containment

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts` (~L174–185, ~L220–234) — on direct-To match do **not** `ensureSpamLabel` / do **not** set `spamAt`; still persist + enqueue triage
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh` — emit `AI_WRITE_GATE_ENABLED=true` for real-mail env
- Create/extend: store/ingest unit test colocated with existing ingest fixtures
- Degraded (minimal YAGNI): when `AI_WRITE_GATE_ENABLED` is not `'true'`, after persist apply soft label `soft-quarantine` for From domains outside transport/allowlist — healthy path stays inbox-first

**Interfaces:**
- Produces: direct-To without `X-Zero-Mailbox` → thread `spamAt === null`

- [ ] **Step 1: Failing test**

```typescript
it('direct-To transport email without owner header lands with spamAt null', async () => {
  // use persistInboundMessage / store fixture: To = transport email, no X-Zero-Mailbox
  // expect resulting thread.spamAt toBeNull()
  // expect triage enqueue called or AI run row present if gate on
});
```

- [ ] **Step 2: Run FAIL → patch store → PASS**

```bash
pnpm -C apps/server-pilot exec vitest run tests/
# narrow to the ingest/store test file name once created
```

- [ ] **Step 3: Commit**

```bash
git add apps/server-pilot/src/mail/ingest/store.ts apps/server-pilot/deploy/write-ec2-env.sh apps/server-pilot/tests/
git commit -m "fix(ingest): inbox-first direct-To; AI degraded containment"
```

---

### Task 9: Honesty — hide Live Support / fake Saves

**Files:**
- Modify: `apps/mail/lib/demo/support-links.ts`
- Modify: `apps/mail/tests/support-links.test.ts` (existing — update expectations)
- Modify: `apps/mail/components/ui/nav-main.tsx` (call site already uses `shouldShowSupportLinks()`)
- Modify: settings notifications/security Save buttons — disable or hide when no persistence backend (grep toast-only Save; disable those)

**Interfaces:**
- Today: `shouldShowSupportLinks = !isFrontendOnlyDemo` → **shows** Live Support on live pilot
- No Intercom env in `SupportLinksEnv` today — honesty fix: hide on live until a real provider exists:

```typescript
export function shouldShowSupportLinks(
  env: SupportLinksEnv = import.meta.env as unknown as SupportLinksEnv,
): boolean {
  if (isFrontendOnlyDemo(env)) return false;
  // Pilot honesty: no wired support provider → hide
  return false;
}
```

(If Intercom lands later, gate on that env; until then always false.)

- [ ] **Step 1: Update failing/characterization tests**

```typescript
it('hides support links on live pilot without support provider', () => {
  expect(
    shouldShowSupportLinks({
      ZERO_DEMO_MODE: '0',
      VITE_FRONTEND_ONLY: '0',
    }),
  ).toBe(false);
});
```

Flip old tests that expected `true` outside frontend-only.

- [ ] **Step 2: Implement + disable fake Saves**

- [ ] **Step 3: Commit**

```bash
git add apps/mail/lib/demo/support-links.ts apps/mail/tests/support-links.test.ts apps/mail/components/ui/nav-main.tsx
git commit -m "fix(mail-ui): hide dead support/fake saves; Nava login copy"
```

---

### Task 10: Safeties — print XSS + seed/wipe gates

**Files:**
- Modify: `apps/mail/components/mail/mail-display.tsx` — `printMail` title ~L893 and `<h1>` subject: wrap with existing `escapePrintHtml`
- Modify: `apps/mail/components/mail/thread-display.tsx` — same for `printThread` subject
- Create: `apps/mail/tests/print-escape.test.ts`
- Modify: `apps/server-pilot/scripts/seed-prod.ts` + `apps/server-pilot/deploy/pilot-db-wipe.sh` — require confirm env

**Interfaces:**
- `escapePrintHtml` already exists in both files; subject currently interpolated raw → XSS

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, it } from 'vitest';

const escapePrintHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

it('print subject escapes script tags', () => {
  const subject = '<script>alert(1)</script>';
  const title = `Print Email - ${escapePrintHtml(subject)}`;
  expect(title).not.toContain('<script>alert(1)</script>');
  expect(title).toContain('&lt;script&gt;');
});
```

- [ ] **Step 2: Wire subject through `escapePrintHtml` in both print builders**

```typescript
<title>Print Email - ${escapePrintHtml(emailData.subject || 'No Subject')}</title>
<h1>${escapePrintHtml(emailData.subject || 'No Subject')}</h1>
```

- [ ] **Step 3: seed/wipe gate**

```bash
# pilot-db-wipe.sh near top:
if [ "${CONFIRM_PILOT_WIPE:-}" != "1" ]; then
  echo "refusing wipe: set CONFIRM_PILOT_WIPE=1" >&2
  exit 2
fi
```

```typescript
// seed-prod.ts main:
if (process.env.CONFIRM_PILOT_SEED !== '1') {
  throw new Error('refusing seed: set CONFIRM_PILOT_SEED=1');
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/mail/components/mail/mail-display.tsx apps/mail/components/mail/thread-display.tsx apps/mail/tests/print-escape.test.ts apps/server-pilot/scripts/seed-prod.ts apps/server-pilot/deploy/pilot-db-wipe.sh
git commit -m "fix(security): print XSS escape + seed/wipe gates"
```

---

### Task 11: Hotel folder colors + categoryIds filter

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx` `CategoryDropdown` (~L711–823) — stop writing hotel chips into `useSearchLabels` / `labelIds`
- Modify: `apps/mail/hooks/use-threads.ts` (~L139–143) — already maps `routeFilter.filters.categoryIds`; chip UI must set that path
- Modify: `apps/mail/lib/mail/route-filter.ts` / navigation category settings — colors from `category.color` or fixed palette
- Create/extend: `apps/mail/tests/search-filter-contract.test.ts` (already has categoryIds example)

**Interfaces:**
- Bug: `handleLabelChange(category.searchValue)` → `setLabels` → `labelIds` in `use-threads.ts`
- Server listThreads category join expects `filters.categoryIds`
- Fix: category chip toggles `categoryIds: string[]` (use category **id**, not searchValue string-as-label)

- [ ] **Step 1: Failing test**

```typescript
// extend search-filter-contract.test.ts or new category-dropdown-filter.test.ts
it('hotel chip selection yields categoryIds not labelIds', () => {
  // Pure helper preferred — extract toggleCategoryChip(selectedIds, categoryId) → nextIds
  // And assert buildListThreadsInput({ categoryIds: ['cat-travel'], labels: [] })
  // matches { filters: { categoryIds: ['cat-travel'] }, labelIds: [] } shape used by useThreads
});
```

- [ ] **Step 2: Implement CategoryDropdown**

Replace `useSearchLabels` usage for hotel categories with a dedicated category-id store (URL query `categoryId` already exists in `route-filter.ts` — prefer that):

```typescript
// Prefer: navigate / set search params categoryId=cat.id
// Do not call setLabels(category.searchValue) for hotel folders
```

Apply `colors` / `style` from category settings onto chip icons (field `colors?: string` already on `CategoryItem`).

- [ ] **Step 3: Green + commit**

```bash
pnpm -C apps/mail exec vitest run tests/search-filter-contract.test.ts
git add apps/mail/components/mail/mail.tsx apps/mail/hooks/use-threads.ts apps/mail/lib/mail/route-filter.ts apps/mail/tests/
git commit -m "feat(mail-ui): hotel folder colors + categoryIds filter"
```

---

### Task 12: EC2 deploy + full U9 gate + handoff

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-07-23-live-pilot-parity-overnight.md`

**Interfaces:**
- Consumes: Tasks 1–11 green on branch `EC2-pilot`
- Produces: SSM gate exit 0; handoff report committed

- [ ] **Step 1: Push branch**

```bash
git push -u origin EC2-pilot
```

- [ ] **Step 2: Deploy with gate env**

```bash
# On write-ec2-env / .env.production before restart:
# BETTER_AUTH_URL=https://nava.legacy.local
# UNDO_SEND_SECONDS=0
# AI_WRITE_GATE_ENABLED=true
# FE build: VITE_MAIL_POLL_MS=15000
./apps/server-pilot/deploy/ops-deploy.sh --migrate
./apps/server-pilot/deploy/ops-restart.sh
```

- [ ] **Step 3: SSM gate**

```bash
./apps/server-pilot/deploy/ssm-run-command.sh \
  "bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh"
```

Expected: exit 0 (AE1, AE7, AE8, AE9).

- [ ] **Step 4: On red — RCA loop; fix; commit; redeploy; re-run. Do not stop.**

- [ ] **Step 5: Write handoff + commit + push**

Handoff must include: commits shipped, gate log excerpt, divergence log, residuals, PM2 env snapshot (`UNDO_SEND_SECONDS`, `BETTER_AUTH_URL`).

```bash
git add docs/superpowers/plans/handoff-reports/2026-07-23-live-pilot-parity-overnight.md
git commit -m "docs(pilot): overnight parity handoff report"
git push origin EC2-pilot
```

---

## Self-Review (writing-plans checklist)

| Spec item | Task |
|-----------|------|
| R1 auth / AE1 | 1, 3, 12 |
| R5 near-realtime / AE4 | 2, 3, 12 |
| R11 / AE7–AE9 | 3, 5, 12 |
| R3 attachments | 6 |
| R4 undo/schedule | 7 |
| R6–R7 folders | 8, 11 |
| R2 reply headers | 4, 5 |
| R8 honesty | 9 |
| R9 safeties | 10 |
| Terra harden (browser login, ≥60s, forceSync correlate, PM2 UNDO=0, queue) | 1–3, 7, 12 |
| `cursor-grok-4.5-high` all agents (slow, never fast) | Global Constraints + Overnight Mandate + Execution Mode |
| SDD locked (not inline) | Overnight Mandate / Execution Mode |
| FE `headers` vs zod gap | Task 4 (`replyToMessageId`) |
| Schema needs queue table | Task 7 |
| CategoryDropdown labelIds bug | Task 11 |
| Support links always-on live | Task 9 (`shouldShowSupportLinks` → false) |
| Print subject XSS | Task 10 |

Placeholder scan: none. Type consistency: `replyToMessageId` / undo return shapes / forceSync counts / `getAttachment({messageId,attachmentId})` aligned.

## Progress Ledger (orchestrator — fill at execution time)

| Task | Status | Commit | Notes |
|------|--------|--------|-------|
| 1 Auth | pending | | |
| 2 Poll+forceSync | pending | | |
| 3 U9a gate specs | pending | | |
| 4 Reply headers | pending | | |
| 5 U9b reply e2e | pending | | |
| 6 Attachments | pending | | |
| 7 Undo queue | pending | | |
| 8 Inbox-first | pending | | |
| 9 Honesty | pending | | |
| 10 Safeties | pending | | |
| 11 Folder colors | pending | | |
| 12 EC2+handoff | pending | | |

---

## Execution Mode (locked — end of plan)

Autonomous overnight via **subagent-driven-development**. No "which approach?" pause.

**Every** subagent Task call: `model: "cursor-grok-4.5-high"` (Grok 4.5 High, slow — never fast).

See mandate + Execution Mode sections after Global Constraints. Start Tasks 1–12 when orchestrator begins overnight wave.
