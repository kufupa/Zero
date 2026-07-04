# Nava Fixture Loopback Autonomous E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nava ops mailbox wiring, fixture SMTP→POP3 loopback, and fully automated vitest E2E + EC2 SSM deploy gate — zero manual login, zero Mailpit, zero tier5 bug fixes.

**Architecture:** Reuse mailbox transport model + fake SMTP/POP3 adapters. `mail.send` stamps `X-Zero-Mailbox`, enqueues RFC822 to `FixtureLoopbackStore` when recipient is `nava@legacyhotel.com` in fixture mode. `FakePop3Client.connect()` drains loopback queue. Vitest integration tests (`callerFor` + `ingestOnce`) prove send→ingest→inbox/spam/sent. EC2 gate script runs E2E after deploy.

**Tech Stack:** TypeScript, tRPC, Drizzle/Postgres, Vitest, React (`apps/mail`), PM2, AWS SSM/EC2/RDS.

**Spec:** [docs/superpowers/specs/2026-07-03-nava-live-mail-test-harness-design.md](docs/superpowers/specs/2026-07-03-nava-live-mail-test-harness-design.md)

**Branch:** `EC2-pilot`

## Global Constraints

- P1 tier5 bugs: **closed, out of scope** — do not re-litigate.
- `MAIL_TRANSPORT_MODE` default `fixture`; loopback **fixture-only** (never enqueue in `real`).
- No `mimeHeaderLines`, no S3 `getObject` for debug, no quarantine UI/API.
- `X-Zero-Mailbox` stamped **backend only**; FE cannot override.
- `mail.ts` edits **serial only**: Task 2 → Task 4 → Task 6 (no parallel subagents on `mail.ts`).
- Loopback store **starts empty**; existing FakePop3 tests unchanged unless enqueue called.
- Loopback trigger: any `to`/`cc`/`bcc` normalizes to `INGEST_EMAIL` (`nava@legacyhotel.com`).
- E2E = tRPC `callerFor` + `withSeededTestDb` + `ingestOnce` — no Playwright, no manual playbook.
- Gate: `pm2 stop worker` before vitest; `pm2 start worker` after; also `pnpm --filter @zero/mail build`.

## Git Commit Strategy

One atomic conventional commit per completed task (tests green). Linear history for overnight RCA.

| Task | Commit message (after tests pass) | Files scope |
|------|-----------------------------------|-------------|
| 1 | `feat(seed): add nava live-mail ops mailbox` | seed + seed-contract |
| 2 | `feat(mail): stamp mailbox routing header on smtp send` | smtp + mail.ts (send only) + mail-send.test |
| 3 | `feat(ingest): route direct-to mailbox misses into spam` | store + ingest tests |
| 4 | `feat(mail): add nava-only metadata header debug` | wire-compat + mail.ts (get only) + server tests |
| 5 | `feat(mail-ui): hide header debug behind nava transport` | apps/mail FE + header-debug.test |
| 6 | `feat(mail): add fixture smtp-to-pop3 loopback bridge` | fixture-loopback + pop3-client + mail.ts (send hook) |
| 7 | `test(nava-e2e): add fixture loopback integration suite` | fixture-loopback-e2e.test.ts |
| 8 | `feat(deploy): add fixture loopback ec2 gate script` | fixture-loopback-gate.sh + deferred-real-mail-readiness |
| 9 | `docs(nava): write fixture loopback gate report` | handoff-reports |

**Rules:**
- Push `EC2-pilot` after each task OR after Task 3 batch (before `mail.ts` debug wave).
- RCA fixes: separate `fix(nava): <symptom>` commit with body citing root cause `file:line`.
- No amend, no force-push, no `--no-verify`.
- Do not commit `.cursor/`, `.tmp-research/`, skill scaffolding, or secrets.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. Goal = ship R1–R7 green on EC2.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, migrate, seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

```text
FAIL → reproduce minimally → root cause (file:line + mechanism)
  → Exa MCP if unfamiliar → enumerate fixes → smallest correct fix
  → test + commit → resume plan
```

Bar: 95% confident can explain what broke and why. Symptom patches without RCA = loop again.

### Divergence authority

Better path to R1–R7 → take it. Log in gate report (what, why).

### Done criteria

- [ ] Tasks 1–8 implemented + committed
- [ ] `fixture-loopback-e2e.test.ts` green on EC2 via SSM
- [ ] `MAIL_TRANSPORT_MODE=fixture` unchanged on EC2
- [ ] Gate report written (Task 9)
- [ ] No open blockers for fixture E2E goal

---

## File Map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/db/seed.ts` | Nava transport, ops user, SPAM labels |
| `apps/server-pilot/src/mail/send/smtp.ts` | `extraHeaders` on outbound payload |
| `apps/server-pilot/src/trpc/routes/mail.ts` | Stamp, debug headers, loopback enqueue |
| `apps/server-pilot/src/mail/ingest/store.ts` | Direct-To spam routing |
| `apps/server-pilot/src/mail/fixture-loopback.ts` | Loopback store + RFC822 builder |
| `apps/server-pilot/src/mail/ingest/pop3-client.ts` | Drain loopback on FakePop3 connect |
| `apps/server-pilot/tests/fixture-loopback-e2e.test.ts` | Automated E2E |
| `apps/server-pilot/deploy/fixture-loopback-gate.sh` | EC2 autonomous gate |
| `apps/mail/lib/mail/header-debug.ts` | FE gate + preview helpers |

---

### Task 1: Seed Nava Transport, Ops User, Access, And SPAM Labels

**Files:**
- Modify: `apps/server-pilot/src/db/seed.ts`
- Modify: `apps/server-pilot/tests/seed-contract.test.ts`

**Interfaces:**
- Produces: `NAVA_TRANSPORT_ID`, `NAVA_TRANSPORT_EMAIL`, `NAVA_OPS_USER_ID`, `NAVA_OPS_USER_EMAIL`
- Produces DB rows: `transport-nava`, `user-nava`, `mailboxAccess`, `label-spam-transport-nava`, `label-spam-transport-centurion`

- [ ] **Step 1: Write failing seed tests**

Add `mailLabel` to schema import in `seed-contract.test.ts`. Add tests for `transport-nava`, `nava-ops@`, SPAM labels. Change credential account count expectation from `3` to `4`.

```typescript
it('seeds transport-nava and nava-ops with access only to Nava', async () => {
  const result = await withSeededTestDb(async (db) => {
    const transports = await db.select().from(mailboxTransport).where(eq(mailboxTransport.id, 'transport-nava'));
    const access = await db.select({
      userId: mailboxAccess.userId,
      transportId: mailboxAccess.transportId,
      role: mailboxAccess.role,
      isDefault: mailboxAccess.isDefault,
    }).from(mailboxAccess).where(eq(mailboxAccess.userId, 'user-nava'));
    return { transport: transports[0], access };
  });
  expect(result.transport!.email).toBe('nava@legacyhotel.com');
  expect(result.access).toEqual([{
    userId: 'user-nava', transportId: 'transport-nava', role: 'owner', isDefault: true,
  }]);
}, 30000);
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/server-pilot && pnpm test tests/seed-contract.test.ts -t "transport-nava|SPAM|credential"
```

Expected: FAIL — Nava rows missing.

- [ ] **Step 3: Implement seed**

Add constants, `PILOT_USERS` entry, transport upsert, access row, `seedSpamLabel` helper for Centurion + Nava.

- [ ] **Step 4: Run tests**

```bash
cd apps/server-pilot && pnpm test tests/seed-contract.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/db/seed.ts apps/server-pilot/tests/seed-contract.test.ts
git commit -m "feat(seed): add nava live-mail ops mailbox"
```

---

### Task 2: Stamp `X-Zero-Mailbox` On Outbound SMTP

**Files:**
- Modify: `apps/server-pilot/src/mail/send/smtp.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (send mutation only)
- Modify: `apps/server-pilot/tests/mail-send.test.ts`

**Interfaces:**
- `OutboundMailPayload.extraHeaders?: Record<string, string>`
- `mail.send` passes `extraHeaders: { 'X-Zero-Mailbox': ctx.transportEmail }`

- [ ] **Step 1: Write failing tests**

```typescript
expect(fake.sent[0]!.extraHeaders).toEqual({
  'X-Zero-Mailbox': 'centurion@legacyhotel.com',
});
```

Add Nava send test with `callerFor('user-nava', { requestedTransportId: 'transport-nava' })`.

- [ ] **Step 2: Run failing tests**

```bash
cd apps/server-pilot && pnpm test tests/mail-send.test.ts -t "X-Zero-Mailbox|stores outbound"
```

- [ ] **Step 3: Extend `OutboundMailPayload` and merge headers in `RealSmtpTransport`/`FakeSmtpTransport`**

```typescript
extraHeaders?: Record<string, string>;
// in send():
const headers: Record<string, string> = { ...(payload.extraHeaders ?? {}) };
```

- [ ] **Step 4: Stamp in `mail.send`**

```typescript
extraHeaders: { 'X-Zero-Mailbox': ctx.transportEmail },
```

- [ ] **Step 5: Run tests + commit**

```bash
cd apps/server-pilot && pnpm test tests/mail-send.test.ts
git add apps/server-pilot/src/mail/send/smtp.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-send.test.ts
git commit -m "feat(mail): stamp mailbox routing header on smtp send"
```

---

### Task 3: Route Missing-Header Direct-To Mail Into Spam

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts`
- Modify: `apps/server-pilot/tests/ingest-store.test.ts`
- Modify: `apps/server-pilot/tests/pop3-worker.test.ts`

**Interfaces:**
- `findDirectToTransport(db, toAddresses)`
- `ensureSpamLabel(db, transportId)`
- `applyThreadLabels(tx, threadId, labelIds)`

- [ ] **Step 1: Write failing tests** — `missing-owner.eml` → `transport-nava` spam; unknown To → quarantine; worker `uidl-B` → stored on Nava.

- [ ] **Step 2: Run failing tests**

```bash
cd apps/server-pilot && pnpm test tests/ingest-store.test.ts tests/pop3-worker.test.ts -t "direct-To|uidl-B"
```

- [ ] **Step 3: Implement helpers + routing branch in `persistInboundMessage`**

- [ ] **Step 4: Run tests + commit**

```bash
cd apps/server-pilot && pnpm test tests/ingest-store.test.ts tests/pop3-worker.test.ts
git commit -m "feat(ingest): route direct-to mailbox misses into spam"
```

---

### Task 4: Add Nava-Only Metadata Debug Headers (Server)

**Files:**
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (get handler only)
- Modify: `apps/server-pilot/tests/mail-wire-contract.test.ts`
- Modify: `apps/server-pilot/tests/mail-router-isolation.test.ts`

**Interfaces:**
- `buildMetadataDebugHeaders(row, transportEmail): MailDebugHeaderLine[]`
- `ParsedMessageWire.debugHeaders?: MailDebugHeaderLine[]`

- [ ] **Step 1: Write failing wire-contract + isolation tests**

- [ ] **Step 2: Run failing tests**

```bash
cd apps/server-pilot && pnpm test tests/mail-wire-contract.test.ts tests/mail-router-isolation.test.ts -t "debug"
```

- [ ] **Step 3: Add `buildMetadataDebugHeaders` in wire-compat; attach in `mail.get` when `transportId === 'transport-nava'`**

- [ ] **Step 4: Run tests + commit**

```bash
git commit -m "feat(mail): add nava-only metadata header debug"
```

---

### Task 5: Add Hidden Nava Header Debug UI

**Files:**
- Create: `apps/mail/lib/mail/header-debug.ts`
- Create: `apps/mail/tests/header-debug.test.ts`
- Modify: `apps/mail/types/index.ts`, `mail-display.tsx`, `email-composer.tsx`, `create-email.tsx`, `reply-composer.tsx`

- [ ] **Step 1: Create helpers + vitest**

- [ ] **Step 2: Run FE test**

```bash
cd apps/mail && pnpm test tests/header-debug.test.ts
```

- [ ] **Step 3: Wire UI toggle + compose preview**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mail-ui): hide header debug behind nava transport"
```

---

### Task 6: Fixture Loopback Bridge

**Files:**
- Create: `apps/server-pilot/src/mail/fixture-loopback.ts`
- Modify: `apps/server-pilot/src/mail/ingest/pop3-client.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (send hook after SMTP success)
- Create: `apps/server-pilot/tests/fixture-loopback.test.ts`

**Interfaces:**
- `fixtureLoopbackStore.enqueue(raw): string` (returns uidl)
- `fixtureLoopbackStore.drain(): LoopbackMessage[]`
- `resetFixtureLoopbackStoreForTests(): void`
- `buildLoopbackEml(args): Buffer`
- `recipientMatchesIngestEmail(addresses): boolean`
- `maybeEnqueueLoopback(payload, smtpResult, mode): void`

- [ ] **Step 1: Write failing unit tests**

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildLoopbackEml,
  fixtureLoopbackStore,
  recipientMatchesIngestEmail,
  resetFixtureLoopbackStoreForTests,
} from '../src/mail/fixture-loopback';
import { parseRawMessage } from '../src/mail/ingest/parse-message';
import { FakeS3Storage } from '../src/storage/s3';

describe('fixture loopback', () => {
  beforeEach(() => resetFixtureLoopbackStoreForTests());

  it('recipientMatchesIngestEmail matches nava@ case-insensitively', () => {
    expect(recipientMatchesIngestEmail(['Nava@legacyhotel.com'])).toBe(true);
    expect(recipientMatchesIngestEmail(['other@example.com'])).toBe(false);
  });

  it('buildLoopbackEml round-trips through parseRawMessage with X-Zero-Mailbox', async () => {
    const storage = new FakeS3Storage('loopback-test');
    const raw = buildLoopbackEml({
      from: 'nava@legacyhotel.com',
      to: ['nava@legacyhotel.com'],
      subject: 'loop',
      html: '<p>loop</p>',
      text: 'loop',
      messageId: 'loop-1@zero-fake-smtp.local',
      extraHeaders: { 'X-Zero-Mailbox': 'nava@legacyhotel.com' },
    });
    const parsed = await parseRawMessage(raw, { messageId: 'msg-1', storage });
    expect(parsed.ownerHeaderValue).toBe('nava@legacyhotel.com');
    expect(parsed.toAddresses).toContain('nava@legacyhotel.com');
  });

  it('FakePop3Client connect drains loopback queue', async () => {
    const raw = buildLoopbackEml({
      from: 'nava@legacyhotel.com',
      to: ['nava@legacyhotel.com'],
      subject: 'q',
      html: '<p>q</p>',
      text: 'q',
      messageId: 'q@local',
      extraHeaders: { 'X-Zero-Mailbox': 'nava@legacyhotel.com' },
    });
    const uidl = fixtureLoopbackStore.enqueue(raw);
    const pop3 = new FakePop3Client();
    await pop3.connect();
    expect(await pop3.listUidl()).toContain(uidl);
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/server-pilot && pnpm test tests/fixture-loopback.test.ts
```

- [ ] **Step 3: Create `fixture-loopback.ts`**

```typescript
import { INGEST_EMAIL } from '../db/seed.js';
import type { OutboundMailPayload, SmtpSendResult } from './send/smtp.js';
import type { MailTransportMode } from '../env.js';

export interface LoopbackMessage { uidl: string; raw: Buffer; }

class FixtureLoopbackStoreImpl {
  private queue: LoopbackMessage[] = [];
  private seq = 0;
  enqueue(raw: Buffer): string {
    const uidl = `loopback-${++this.seq}`;
    this.queue.push({ uidl, raw });
    return uidl;
  }
  drain(): LoopbackMessage[] {
    const out = [...this.queue];
    this.queue = [];
    return out;
  }
  reset(): void { this.queue = []; this.seq = 0; }
}
export const fixtureLoopbackStore = new FixtureLoopbackStoreImpl();
export function resetFixtureLoopbackStoreForTests(): void { fixtureLoopbackStore.reset(); }

export function recipientMatchesIngestEmail(addresses: string[]): boolean {
  const t = INGEST_EMAIL.toLowerCase();
  return addresses.some((a) => a.toLowerCase() === t);
}

export function buildLoopbackEml(args: {
  from: string; to: string[]; cc?: string[]; bcc?: string[];
  subject: string; html: string; text: string; messageId: string;
  inReplyTo?: string | null; references?: string[];
  extraHeaders?: Record<string, string>;
}): Buffer {
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Subject: ${args.subject}`,
    `Message-ID: <${args.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ];
  if (args.cc?.length) lines.splice(3, 0, `Cc: ${args.cc.join(', ')}`);
  if (args.inReplyTo) lines.push(`In-Reply-To: <${args.inReplyTo}>`);
  if (args.references?.length) {
    lines.push(`References: ${args.references.map((r) => `<${r}>`).join(' ')}`);
  }
  for (const [k, v] of Object.entries(args.extraHeaders ?? {})) lines.push(`${k}: ${v}`);
  lines.push('', args.html || args.text);
  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

export function maybeEnqueueLoopback(
  payload: OutboundMailPayload,
  smtpResult: SmtpSendResult,
  mode: MailTransportMode,
  extraHeaders?: Record<string, string>,
): void {
  if (mode === 'real') return;
  const recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  if (!recipientMatchesIngestEmail(recipients)) return;
  const raw = buildLoopbackEml({
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    messageId: smtpResult.messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    extraHeaders,
  });
  fixtureLoopbackStore.enqueue(raw);
}
```

- [ ] **Step 4: Patch `FakePop3Client.connect()`**

After resetting from `initial`, drain loopback:

```typescript
import { fixtureLoopbackStore } from '../fixture-loopback.js';
// in connect():
for (const m of fixtureLoopbackStore.drain()) {
  this.remaining.set(m.uidl, m);
}
```

- [ ] **Step 5: Hook `mail.send` after SMTP success**

```typescript
import { maybeEnqueueLoopback } from '../../mail/fixture-loopback.js';
// after smtpResult:
maybeEnqueueLoopback(
  { from: ctx.transportEmail, to: input.to, cc: input.cc, bcc: input.bcc,
    subject: input.subject, html: input.html, text: input.text,
    inReplyTo, references },
  smtpResult,
  process.env.MAIL_TRANSPORT_MODE === 'real' ? 'real' : 'fixture',
  { 'X-Zero-Mailbox': ctx.transportEmail },
);
```

- [ ] **Step 6: Run tests + commit**

```bash
cd apps/server-pilot && pnpm test tests/fixture-loopback.test.ts
git commit -m "feat(mail): add fixture smtp-to-pop3 loopback bridge"
```

---

### Task 7: Automated Integration E2E Suite

**Files:**
- Create: `apps/server-pilot/tests/fixture-loopback-e2e.test.ts`

**Dependencies:** Tasks 1–6

- [ ] **Step 1: Write E2E tests**

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { ingestOnce } from '../src/mail/ingest/worker';
import { FakePop3Client } from '../src/mail/ingest/pop3-client';
import { FakeSmtpTransport, __setSmtpTransportForTests } from '../src/mail/send/smtp';
import { resetFixtureLoopbackStoreForTests } from '../src/mail/fixture-loopback';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('fixture loopback e2e', () => {
  beforeEach(() => {
    resetFixtureLoopbackStoreForTests();
    resetS3Storage();
    setS3Storage(new FakeS3Storage('e2e-bucket'));
  });

  it('E2E-1 app-to-self: send to nava@ → ingest → inbox', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const nava = await callerFor('user-nava', { db, requestedTransportId: 'transport-nava' });
        await nava.mail.send({
          to: ['nava@legacyhotel.com'],
          subject: 'self-loop',
          html: '<p>self</p>',
          text: 'self',
        });
        const pop3 = new FakePop3Client();
        await ingestOnce({ pop3, db, ingestMailboxId: 'ingest-nava-legacy', maxMessages: 10 });
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.some((t) => t.subject === 'self-loop')).toBe(true);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 60000);

  it('E2E-2 external-style: missing-owner → Nava spam', async () => {
    await withSeededTestDb(async (db) => {
      const pop3 = new FakePop3Client({
        messages: [{ uidl: 'ext-1', raw: readFixture('missing-owner.eml') }],
      });
      await ingestOnce({ pop3, db, ingestMailboxId: 'ingest-nava-legacy', maxMessages: 10 });
      const nava = await callerFor('user-nava', { db, requestedTransportId: 'transport-nava' });
      const spam = await nava.mail.listThreads({ folder: 'spam' });
      expect(spam.threads.length).toBeGreaterThan(0);
    });
  }, 60000);

  it('E2E-3 app-to-external: sent folder only', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const nava = await callerFor('user-nava', { db, requestedTransportId: 'transport-nava' });
        await nava.mail.send({
          to: ['external@example.com'],
          subject: 'outbound',
          html: '<p>out</p>',
          text: 'out',
        });
        const pop3 = new FakePop3Client();
        await ingestOnce({ pop3, db, ingestMailboxId: 'ingest-nava-legacy', maxMessages: 10 });
        const sent = await nava.mail.listThreads({ folder: 'sent' });
        expect(sent.threads.some((t) => t.subject === 'outbound')).toBe(true);
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'outbound')).toHaveLength(0);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 60000);
});
```

- [ ] **Step 2: Run E2E**

```bash
cd apps/server-pilot && pnpm test tests/fixture-loopback-e2e.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(nava-e2e): add fixture loopback integration suite"
```

---

### Task 8: EC2 Autonomous Gate Script

**Files:**
- Create: `apps/server-pilot/deploy/fixture-loopback-gate.sh`
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`

- [ ] **Step 1: Create gate script**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source apps/server-pilot/.env.production; set +a
export NODE_ENV=test
export MAIL_TRANSPORT_MODE=fixture
pm2 stop worker || true
cd apps/server-pilot
pnpm test tests/fixture-loopback-e2e.test.ts tests/fixture-loopback.test.ts \
  tests/seed-contract.test.ts tests/mail-send.test.ts \
  tests/ingest-store.test.ts tests/pop3-worker.test.ts
cd ../..
pnpm --filter @zero/mail build
pm2 start worker
echo "fixture-loopback-gate: PASS"
```

- [ ] **Step 2: Update deferred-real-mail-readiness.md** — replace manual playbook with automated gate reference.

- [ ] **Step 3: Commit + deploy wave**

```bash
git commit -m "feat(deploy): add fixture loopback ec2 gate script"
# overnight wave:
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
# SSM: source .env → db:migrate → deploy-ec2.sh → fixture-loopback-gate.sh
```

---

### Task 9: Overnight Gate Report

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-07-04-nava-loopback-gate-report.md`

Mirror [2026-07-03-post-audit-tier5-gate-report.md](handoff-reports/2026-07-03-post-audit-tier5-gate-report.md): wave commits, local gates, EC2 gates, RCA notes, deployed SHA.

- [ ] **Step 1: Write report after EC2 gate green**
- [ ] **Step 2: Commit**

```bash
git commit -m "docs(nava): write fixture loopback gate report"
```

---

## Plan Self-Review

| Requirement | Task |
|-------------|------|
| Nava seed + isolation | 1 |
| SMTP stamp | 2 |
| Direct-To spam | 3 |
| Debug headers server | 4 |
| Debug UI | 5 |
| Fixture loopback | 6 |
| Automated E2E | 7 |
| EC2 gate | 8 |
| Gate report | 9 |

Placeholder scan: clean. Type consistency: `{ key: string; line: string }` throughout.
