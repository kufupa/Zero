# Nava Live Mail Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Nava ops mailbox in the existing mail UI so a human can manually test real Zimbra self-send, external inbound, and external outbound flows.

**Architecture:** Reuse the existing mailbox transport model, mail UI, SMTP send path, POP3 ingest path, inbox/spam/sent folders, and message metadata. Add a dedicated `transport-nava`, stamp `X-Zero-Mailbox` on backend SMTP sends, route missing-header direct-To mail to spam, and expose metadata-only debug headers only for Nava.

**Tech Stack:** TypeScript, tRPC, Drizzle/Postgres, Nodemailer, MailParser, React, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-nava-live-mail-test-harness-design.md`

## Global Constraints

- Ponytail: no quarantine UI/API, no schema migration for header copies, no raw MIME S3 read for header debug.
- Staff must not see debug headers; server returns debug metadata only when `ctx.activeTransportId === 'transport-nava'`.
- `X-Zero-Mailbox` is stamped only by the backend SMTP path.
- Human runs real-mail manual tests; agents add unit/contract coverage only.
- Reuse existing inbox/spam/sent/compose UI and existing seed/test helpers.

---

## What Already Exists

- `mailboxTransport`, `mailboxAccess`, `connections.getDefault`, and the active transport request header already model switchable mailboxes.
- `mail.send` already resolves mailbox context, rejects spoofed `fromEmail`, calls SMTP, and stores outbound rows.
- `persistInboundMessage` already parses `X-Zero-Mailbox`, stores raw MIME in S3, stores messages, and quarantines bad input.
- `mail.listThreads({ folder: 'spam' })` already filters by the transport-local `SPAM` label.
- `message.ownerHeaderValue`, `message.messageIdHeader`, `message.inReplyTo`, and `message.references` already contain enough metadata for the debug headers needed by this harness.
- `mail-display.tsx` already has a details popover and three-dot menu, so header debug does not need a new page or route.

## NOT In Scope

- Quarantine release/list routes: true junk stays in `mailIngestQuarantine`; no staff ops surface.
- `mimeHeaderLines` column: duplicates raw MIME and edits message schema for a debug feature.
- `S3Storage.getObject` for debug headers: full raw MIME is not needed for the three manual pass/fail checks.
- `mail.getMessageHeaders` tRPC route: `mail.get` can carry Nava-only metadata debug lines without another endpoint.
- Admin-role gating: `user-admin` is still Centurion staff; transport gate is narrower.
- Browser automation for live mail: tester runs the UI playbook manually.

## Ponytail Review Of Prior Plan

`docs/superpowers/plans/2026-07-03-nava-live-mail-test-harness.md:L688-1051: delete: S3 getObject + getMessageHeaders route + raw MIME header parser. Metadata debug from existing message columns replaces it.`

`L1055-1336: shrink: separate message-header fetch state. Existing mail.get payload already contains per-message data; render optional debug lines from that.`

`L623-670: shrink: resolveThreadId branch refactor. Add one post-resolution label merge helper instead.`

`net: -1 API route, -1 S3 method, -1 backend helper file, -1 server test file possible.`

---

## File Map

| File | Responsibility |
| --- | --- |
| `apps/server-pilot/src/db/seed.ts` | Add Nava ops user, transport, access, and SPAM labels |
| `apps/server-pilot/tests/seed-contract.test.ts` | Prove seed contract and staff isolation |
| `apps/server-pilot/src/mail/send/smtp.ts` | Add SMTP extra headers and pass them to Nodemailer |
| `apps/server-pilot/src/trpc/routes/mail.ts` | Stamp outbound header; attach Nava-only metadata debug headers in `mail.get` |
| `apps/server-pilot/src/mail/ingest/store.ts` | Missing-header direct-To fallback into spam |
| `apps/server-pilot/tests/ingest-store.test.ts` | Prove direct-To spam and quarantine fallback |
| `apps/server-pilot/tests/pop3-worker.test.ts` | Update worker expectation for missing-owner fixture |
| `apps/server-pilot/tests/mail-send.test.ts` | Prove SMTP header stamp |
| `apps/server-pilot/tests/mail-wire-contract.test.ts` | Prove debug header metadata mapping |
| `apps/mail/types/index.ts` | Add optional debug header type on `ParsedMessage` |
| `apps/mail/lib/mail/header-debug.ts` | FE gate, localStorage helper, outbound preview helper |
| `apps/mail/components/mail/mail-display.tsx` | Add Nava-only hidden debug toggle and read-only debug display |
| `apps/mail/components/create/email-composer.tsx` | Render optional read-only "Headers on send" preview |
| `apps/mail/components/create/create-email.tsx` | Pass new-message header preview |
| `apps/mail/components/mail/reply-composer.tsx` | Pass reply header preview |
| `apps/mail/tests/header-debug.test.ts` | Prove FE gate and preview helper |
| `apps/server-pilot/deploy/deferred-real-mail-readiness.md` | Add manual activation/playbook note |

---

### Task 1: Seed Nava Transport, Ops User, Access, And SPAM Labels

**Files:**
- Modify: `apps/server-pilot/src/db/seed.ts`
- Modify: `apps/server-pilot/tests/seed-contract.test.ts`

**Interfaces:**
- Produces constants: `NAVA_TRANSPORT_ID`, `NAVA_TRANSPORT_EMAIL`, `NAVA_OPS_USER_ID`, `NAVA_OPS_USER_EMAIL`
- Produces DB rows: `transport-nava`, `user-nava`, one `mailboxAccess`, `label-spam-transport-nava`, `label-spam-transport-centurion`

- [ ] **Step 1: Write failing seed tests**

In `apps/server-pilot/tests/seed-contract.test.ts`, add `mailLabel` to the schema import:

```typescript
import {
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
  mailLabel,
} from '../src/db/schema/mail';
```

Add these tests inside the seeded describe block:

```typescript
it(
  'seeds transport-nava and nava-ops with access only to Nava',
  async () => {
    const result = await withSeededTestDb(async (db) => {
      const transports = await db
        .select()
        .from(mailboxTransport)
        .where(eq(mailboxTransport.id, 'transport-nava'));
      const access = await db
        .select({
          userId: mailboxAccess.userId,
          transportId: mailboxAccess.transportId,
          role: mailboxAccess.role,
          isDefault: mailboxAccess.isDefault,
        })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.userId, 'user-nava'));
      return { transport: transports[0], access };
    });

    expect(result.transport).toBeDefined();
    expect(result.transport!.email).toBe('nava@legacyhotel.com');
    expect(result.transport!.ownerHeaderValue).toBe('nava@legacyhotel.com');
    expect(result.access).toEqual([
      {
        userId: 'user-nava',
        transportId: 'transport-nava',
        role: 'owner',
        isDefault: true,
      },
    ]);
  },
  30000,
);

it(
  'seeds SPAM labels for Centurion and Nava transports',
  async () => {
    const labels = await withSeededTestDb(async (db) =>
      db
        .select({
          id: mailLabel.id,
          transportId: mailLabel.transportId,
          name: mailLabel.name,
        })
        .from(mailLabel),
    );

    expect(labels).toContainEqual({
      id: 'label-spam-transport-centurion',
      transportId: 'transport-centurion',
      name: 'SPAM',
    });
    expect(labels).toContainEqual({
      id: 'label-spam-transport-nava',
      transportId: 'transport-nava',
      name: 'SPAM',
    });
  },
  30000,
);
```

Change the credential account test expectation from `3` to `4`.

- [ ] **Step 2: Run failing seed tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/seed-contract.test.ts -t "transport-nava|SPAM|credential accounts"
```

Expected: fails because Nava seed rows and SPAM labels do not exist yet.

- [ ] **Step 3: Update seed imports and constants**

In `apps/server-pilot/src/db/seed.ts`, add `mailLabel` to the mail schema import:

```typescript
import {
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
  mailLabel,
} from './schema/mail.js';
```

Add constants after the Centurion constants:

```typescript
export const NAVA_TRANSPORT_ID = 'transport-nava';
export const NAVA_TRANSPORT_EMAIL = 'nava@legacyhotel.com';
export const NAVA_OPS_USER_ID = 'user-nava';
export const NAVA_OPS_USER_EMAIL = 'nava-ops@legacyhotel.com';
```

Add Nava to `PILOT_USERS`:

```typescript
{ id: NAVA_OPS_USER_ID, name: 'Nava Ops', email: NAVA_OPS_USER_EMAIL },
```

- [ ] **Step 4: Insert Nava transport**

After the Centurion transport upsert in `seedAll`, add:

```typescript
await db
  .insert(mailboxTransport)
  .values({
    id: NAVA_TRANSPORT_ID,
    email: NAVA_TRANSPORT_EMAIL,
    ownerHeaderValue: NAVA_TRANSPORT_EMAIL,
    mailboxType: 'personal',
    displayName: 'Nava Ops Transport',
    isActive: true,
  })
  .onConflictDoUpdate({
    target: mailboxTransport.ownerHeaderValue,
    set: {
      email: NAVA_TRANSPORT_EMAIL,
      mailboxType: 'personal',
      displayName: 'Nava Ops Transport',
      isActive: true,
      updatedAt: new Date(),
    },
  });
```

- [ ] **Step 5: Insert Nava access and SPAM labels**

After the Centurion access loop, add:

```typescript
await db
  .insert(mailboxAccess)
  .values({
    id: `access-${NAVA_OPS_USER_ID}-${NAVA_TRANSPORT_ID}`,
    userId: NAVA_OPS_USER_ID,
    transportId: NAVA_TRANSPORT_ID,
    role: 'owner',
    isDefault: true,
  })
  .onConflictDoUpdate({
    target: [mailboxAccess.userId, mailboxAccess.transportId],
    set: { role: 'owner', isDefault: true, updatedAt: new Date() },
  });

await seedSpamLabel(db, TRANSPORT_ID);
await seedSpamLabel(db, NAVA_TRANSPORT_ID);
```

Add this helper near the bottom of `seed.ts`:

```typescript
async function seedSpamLabel(db: DB, transportId: string): Promise<void> {
  await db
    .insert(mailLabel)
    .values({
      id: `label-spam-${transportId}`,
      transportId,
      name: 'SPAM',
      color: null,
    })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
}
```

- [ ] **Step 6: Run seed tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/seed-contract.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/db/seed.ts apps/server-pilot/tests/seed-contract.test.ts
git commit -m "feat(seed): add nava live-mail ops mailbox"
```

---

### Task 2: Stamp `X-Zero-Mailbox` On Outbound SMTP

**Files:**
- Modify: `apps/server-pilot/src/mail/send/smtp.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/tests/mail-send.test.ts`

**Interfaces:**
- `OutboundMailPayload.extraHeaders?: Record<string, string>`
- `mail.send` passes `extraHeaders: { 'X-Zero-Mailbox': ctx.transportEmail }`

- [ ] **Step 1: Write failing send assertions**

In `apps/server-pilot/tests/mail-send.test.ts`, extend `"sends from selected mailbox and stores outbound row"`:

```typescript
expect(fake.sent[0]!.extraHeaders).toEqual({
  'X-Zero-Mailbox': 'centurion@legacyhotel.com',
});
```

Add a Nava send test:

```typescript
it('stamps X-Zero-Mailbox from the active Nava transport', async () => {
  await withSeededTestDb(async (db) => {
    const fake = new FakeSmtpTransport();
    __setSmtpTransportForTests(fake);
    try {
      const caller = await callerFor('user-nava', {
        db,
        requestedTransportId: 'transport-nava',
      });
      const result = await caller.mail.send({
        to: ['nava@legacyhotel.com'],
        subject: 'loopback',
        html: '<p>loopback</p>',
        text: 'loopback',
      });

      expect(result.fromEmail).toBe('nava@legacyhotel.com');
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]!.extraHeaders).toEqual({
        'X-Zero-Mailbox': 'nava@legacyhotel.com',
      });
    } finally {
      __setSmtpTransportForTests(null);
    }
  });
}, 30000);
```

- [ ] **Step 2: Run failing send tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/mail-send.test.ts -t "X-Zero-Mailbox|stores outbound"
```

Expected: fails because `extraHeaders` is not on `OutboundMailPayload`.

- [ ] **Step 3: Extend SMTP payload**

In `apps/server-pilot/src/mail/send/smtp.ts`, add:

```typescript
extraHeaders?: Record<string, string>;
```

to `OutboundMailPayload`.

Change:

```typescript
const headers: Record<string, string> = {};
```

to:

```typescript
const headers: Record<string, string> = { ...(payload.extraHeaders ?? {}) };
```

Keep existing `In-Reply-To` and `References` assignments after that line.

- [ ] **Step 4: Stamp from `mail.send`**

In `apps/server-pilot/src/trpc/routes/mail.ts`, add `extraHeaders` to the SMTP send payload:

```typescript
extraHeaders: { 'X-Zero-Mailbox': ctx.transportEmail },
```

Do not store this header blob on `message`.

- [ ] **Step 5: Run send tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/mail-send.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
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
- Private helper: `findDirectToTransport(db, toAddresses)`
- Private helper: `ensureSpamLabel(db, transportId)`
- Private helper: `applyThreadLabels(tx, threadId, labelIds)`
- `persistInboundMessage`: no header + direct `To` match stores message with SPAM label

- [ ] **Step 1: Write failing ingest tests**

In `apps/server-pilot/tests/ingest-store.test.ts`, add `mailThread` to the schema import:

```typescript
import {
  mailIngestQuarantine,
  message,
  attachment,
  mailThread,
} from '../src/db/schema/mail';
```

Replace `"quarantines missing owner marker"` with:

```typescript
it(
  'routes missing-header direct-To Nava mail to Nava spam',
  async () => {
    const storage = withFakeS3();
    const raw = readFixture('missing-owner.eml');
    const { result, stored, thread } = await withSeededTestDb(async (db) => {
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      expect(parsed.ownerHeaderValue).toBeNull();
      expect(parsed.toAddresses).toContain('nava@legacyhotel.com');

      const r = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-direct-nava',
          messageId,
        },
        { db, storage },
      );

      if (r.kind !== 'stored') return { result: r, stored: undefined, thread: undefined };
      const messages = await db.select().from(message).where(eq(message.id, r.messageId));
      const threads = await db.select().from(mailThread).where(eq(mailThread.id, r.threadId));
      return { result: r, stored: messages[0], thread: threads[0] };
    });

    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe('transport-nava');
    expect(stored!.ownerHeaderValue).toBeNull();
    expect(thread!.labelIds).toContain('label-spam-transport-nava');
  },
  30000,
);
```

Add a fallback test:

```typescript
it(
  'still quarantines missing-header mail with no known To address',
  async () => {
    const storage = withFakeS3();
    const raw = Buffer.from(
      readFixture('missing-owner.eml')
        .toString('utf-8')
        .replace('To: nava@legacyhotel.com', 'To: unknown@example.com'),
      'utf-8',
    );

    const result = await withSeededTestDb(async (db) => {
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      return persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-no-direct-match',
          messageId,
        },
        { db, storage },
      );
    });

    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('missing_owner_header');
  },
  30000,
);
```

In `apps/server-pilot/tests/pop3-worker.test.ts`, update the `uidl-B` expectation from quarantined to stored on `transport-nava`:

```typescript
if (itemB!.status === 'ok') {
  expect(itemB!.result.kind).toBe('stored');
  if (itemB!.result.kind === 'stored') {
    expect(itemB!.result.transportId).toBe('transport-nava');
  }
}
```

- [ ] **Step 2: Run failing ingest tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/ingest-store.test.ts tests/pop3-worker.test.ts -t "direct-To|no known To|uidl-B|drives UIDL"
```

Expected: direct-To and worker tests fail because missing-header mail still quarantines.

- [ ] **Step 3: Add private helpers in `store.ts`**

Add `mailLabel` to the schema import.

Add helpers below `findExistingQuarantine`:

```typescript
async function findDirectToTransport(
  db: DB,
  toAddresses: string[],
): Promise<{ id: string; email: string } | null> {
  if (toAddresses.length === 0) return null;
  const directTo = new Set(toAddresses.map((email) => email.toLowerCase()));
  const transports = await db
    .select({ id: mailboxTransport.id, email: mailboxTransport.email })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  return (
    transports.find((transport) =>
      directTo.has(transport.email.toLowerCase()),
    ) ?? null
  );
}

async function ensureSpamLabel(db: DB, transportId: string): Promise<string> {
  const id = `label-spam-${transportId}`;
  await db
    .insert(mailLabel)
    .values({ id, transportId, name: 'SPAM', color: null })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
  return id;
}

async function applyThreadLabels(
  tx: DB,
  threadId: string,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  const rows = await tx
    .select({ labelIds: mailThread.labelIds })
    .from(mailThread)
    .where(eq(mailThread.id, threadId))
    .limit(1);
  const current = rows[0]?.labelIds ?? [];
  const next = [...new Set([...current, ...labelIds])];
  await tx
    .update(mailThread)
    .set({ labelIds: next, updatedAt: new Date() })
    .where(eq(mailThread.id, threadId));
}
```

- [ ] **Step 4: Change routing in `persistInboundMessage`**

Replace the current missing-header quarantine block and transport lookup setup with:

```typescript
let spamLabelId: string | null = null;
let transport: { id: string; email: string } | null = null;

if (!parsed.ownerHeaderValue) {
  transport = await findDirectToTransport(db, parsed.toAddresses);
  if (!transport) {
    return quarantineUnrouted({
      db,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'missing_owner_header',
    });
  }
  spamLabelId = await ensureSpamLabel(db, transport.id);
} else {
  const transportRows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
    })
    .from(mailboxTransport)
    .where(
      and(
        eq(mailboxTransport.ownerHeaderValue, parsed.ownerHeaderValue),
        eq(mailboxTransport.isActive, true),
      ),
    )
    .limit(1);

  if (transportRows.length === 0) {
    return quarantineUnrouted({
      db,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'unknown_transport',
    });
  }

  transport = transportRows[0]!;
}
```

Inside the transaction, after `resolveThreadId`, add:

```typescript
await applyThreadLabels(
  tx as unknown as DB,
  threadId,
  spamLabelId ? [spamLabelId] : [],
);
```

Keep the message insert field as:

```typescript
ownerHeaderValue: parsed.ownerHeaderValue,
```

- [ ] **Step 5: Run ingest and worker tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/ingest-store.test.ts tests/pop3-worker.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/mail/ingest/store.ts apps/server-pilot/tests/ingest-store.test.ts apps/server-pilot/tests/pop3-worker.test.ts
git commit -m "feat(ingest): route direct-to mailbox misses into spam"
```

---

### Task 4: Add Nava-Only Metadata Debug Headers

**Files:**
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/tests/mail-wire-contract.test.ts`
- Modify: `apps/server-pilot/tests/mail-router-isolation.test.ts`

**Interfaces:**
- `ParsedMessageWire.debugHeaders?: { key: string; line: string }[]`
- `buildMetadataDebugHeaders(row, transportEmail): { key: string; line: string }[]`
- `mail.get` includes `debugHeaders` only when `ctx.activeTransportId === 'transport-nava'`

- [ ] **Step 1: Write failing wire-contract test**

In `apps/server-pilot/tests/mail-wire-contract.test.ts`, import `buildMetadataDebugHeaders` and add:

```typescript
it('builds metadata debug headers without raw MIME reads', () => {
  const debug = buildMetadataDebugHeaders(
    {
      ...GOLDEN_MESSAGE_ROW,
      transportId: 'transport-nava',
      direction: 'inbound',
      ownerHeaderValue: 'nava@legacyhotel.com',
      messageIdHeader: 'raw-1@example.com',
      inReplyTo: 'parent@example.com',
      references: ['root@example.com', 'parent@example.com'],
    },
    'nava@legacyhotel.com',
  );

  expect(debug).toEqual([
    { key: 'x-zero-mailbox', line: 'X-Zero-Mailbox: nava@legacyhotel.com' },
    { key: 'message-id', line: 'Message-ID: raw-1@example.com' },
    { key: 'in-reply-to', line: 'In-Reply-To: parent@example.com' },
    { key: 'references', line: 'References: root@example.com parent@example.com' },
  ]);
});

it('marks missing inbound X-Zero-Mailbox explicitly', () => {
  const debug = buildMetadataDebugHeaders(
    {
      ...GOLDEN_MESSAGE_ROW,
      transportId: 'transport-nava',
      direction: 'inbound',
      ownerHeaderValue: null,
    },
    'nava@legacyhotel.com',
  );

  expect(debug[0]).toEqual({
    key: 'x-zero-mailbox',
    line: 'X-Zero-Mailbox: (missing)',
  });
});
```

- [ ] **Step 2: Write failing route isolation assertions**

In `apps/server-pilot/tests/mail-router-isolation.test.ts`, add a Nava message fixture inside a new test and assert Nava gets `debugHeaders` while Centurion does not:

```typescript
it('returns debug headers only on the Nava transport', async () => {
  await withSeededTestDb(async (db) => {
    await db.insert(mailThread).values({
      id: 'thread-nava-debug-1',
      transportId: 'transport-nava',
      threadRootId: 'nava-debug-root-1',
      subject: 'debug',
      snippet: 'debug',
      isArchived: false,
      isStarred: false,
      isRead: false,
      labelIds: [],
      latestMessageAt: new Date(),
    });
    await db.insert(message).values({
      id: 'msg-nava-debug-1',
      transportId: 'transport-nava',
      threadId: 'thread-nava-debug-1',
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['nava@legacyhotel.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'debug',
      textBody: 'debug',
      ownerHeaderValue: 'nava@legacyhotel.com',
      messageIdHeader: 'debug-1@example.com',
      receivedAt: new Date(),
    });

    const nava = await callerFor('user-nava', {
      db,
      requestedTransportId: 'transport-nava',
    });
    const navaThread = await nava.mail.get({ id: 'thread-nava-debug-1' });
    expect(navaThread.messages[0]!.debugHeaders).toContainEqual({
      key: 'x-zero-mailbox',
      line: 'X-Zero-Mailbox: nava@legacyhotel.com',
    });

    await seedFrontdeskFixture(db);
    await db.insert(message).values({
      id: 'msg-centurion-debug-1',
      transportId: 'transport-centurion',
      threadId: 'thread-centurion-1',
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['centurion@legacyhotel.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'centurion debug',
      textBody: 'centurion debug',
      ownerHeaderValue: 'centurion@legacyhotel.com',
      messageIdHeader: 'centurion-debug-1@example.com',
      receivedAt: new Date(),
    });
    const centurion = await callerFor('user-manager', {
      db,
      requestedTransportId: 'transport-centurion',
    });
    const centurionThread = await centurion.mail.get({ id: 'thread-centurion-1' });
    expect(centurionThread.messages[0]!.debugHeaders).toBeUndefined();
  });
}, 30000);
```

Add `message` to the schema import in this test file.

- [ ] **Step 3: Run failing debug tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/mail-wire-contract.test.ts tests/mail-router-isolation.test.ts -t "debug headers|Nava transport"
```

Expected: fails because debug helpers and fields do not exist.

- [ ] **Step 4: Extend wire type and helper**

In `apps/server-pilot/src/trpc/wire-compat.ts`, add:

```typescript
export type MailDebugHeaderLine = { key: string; line: string };
```

Add to `ParsedMessageWire`:

```typescript
debugHeaders?: MailDebugHeaderLine[];
```

Add helper below `toParsedMessage`:

```typescript
export function buildMetadataDebugHeaders(
  row: Pick<
    MessageRow,
    'direction' | 'ownerHeaderValue' | 'messageIdHeader' | 'inReplyTo' | 'references'
  >,
  transportEmail: string,
): MailDebugHeaderLine[] {
  const xZeroMailbox =
    row.direction === 'outbound'
      ? transportEmail
      : row.ownerHeaderValue ?? '(missing)';

  const lines: MailDebugHeaderLine[] = [
    { key: 'x-zero-mailbox', line: `X-Zero-Mailbox: ${xZeroMailbox}` },
  ];

  if (row.messageIdHeader) {
    lines.push({ key: 'message-id', line: `Message-ID: ${row.messageIdHeader}` });
  }
  if (row.inReplyTo) {
    lines.push({ key: 'in-reply-to', line: `In-Reply-To: ${row.inReplyTo}` });
  }
  if (row.references?.length) {
    lines.push({ key: 'references', line: `References: ${row.references.join(' ')}` });
  }

  return lines;
}
```

- [ ] **Step 5: Attach debug headers in `mail.get`**

In `apps/server-pilot/src/trpc/routes/mail.ts`, import:

```typescript
buildMetadataDebugHeaders,
```

from the existing `../wire-compat.js` import.

Replace the `parsedMessages` mapping with:

```typescript
const parsedMessages = messages.map((m) => {
  const parsed = toParsedMessage(m, attachmentsByMessage.get(m.id) ?? []);
  if (transportId !== 'transport-nava') return parsed;
  return {
    ...parsed,
    debugHeaders: buildMetadataDebugHeaders(m, ctx.transportEmail),
  };
});
```

- [ ] **Step 6: Run debug tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/mail-wire-contract.test.ts tests/mail-router-isolation.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/trpc/wire-compat.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-wire-contract.test.ts apps/server-pilot/tests/mail-router-isolation.test.ts
git commit -m "feat(mail): add nava-only metadata header debug"
```

---

### Task 5: Add Hidden Nava Header Debug UI

**Files:**
- Modify: `apps/mail/types/index.ts`
- Create: `apps/mail/lib/mail/header-debug.ts`
- Modify: `apps/mail/components/mail/mail-display.tsx`
- Modify: `apps/mail/components/create/email-composer.tsx`
- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/components/mail/reply-composer.tsx`
- Create: `apps/mail/tests/header-debug.test.ts`

**Interfaces:**
- `canShowHeaderDebug(transportId): boolean`
- `isHeaderDebugEnabled(): boolean`
- `setHeaderDebugEnabled(on): void`
- `buildOutboundHeaderPreview(args): HeaderDebugLine[]`
- `EmailComposer.headerPreview?: HeaderDebugLine[]`

- [ ] **Step 1: Add FE types**

In `apps/mail/types/index.ts`, add:

```typescript
export interface HeaderDebugLine {
  key: string;
  line: string;
}
```

Add to `ParsedMessage`:

```typescript
debugHeaders?: HeaderDebugLine[];
```

- [ ] **Step 2: Create helper and tests**

Create `apps/mail/lib/mail/header-debug.ts`:

```typescript
import type { HeaderDebugLine } from '@/types';

export const NAVA_TRANSPORT_ID = 'transport-nava';
export const HEADER_DEBUG_STORAGE_KEY = 'zero-dev-show-headers';

export function canShowHeaderDebug(
  transportId: string | null | undefined,
): boolean {
  return transportId === NAVA_TRANSPORT_ID;
}

export function isHeaderDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(HEADER_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHeaderDebugEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HEADER_DEBUG_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    return;
  }
}

export function buildOutboundHeaderPreview(args: {
  transportEmail: string | null | undefined;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
}): HeaderDebugLine[] {
  if (!args.transportEmail) return [];
  const refs = Array.isArray(args.references)
    ? args.references
    : args.references?.split(/\s+/).filter(Boolean) ?? [];
  const lines: HeaderDebugLine[] = [
    { key: 'x-zero-mailbox', line: `X-Zero-Mailbox: ${args.transportEmail}` },
  ];
  if (args.messageId) lines.push({ key: 'message-id', line: `Message-ID: ${args.messageId}` });
  if (args.inReplyTo) lines.push({ key: 'in-reply-to', line: `In-Reply-To: ${args.inReplyTo}` });
  if (refs.length) lines.push({ key: 'references', line: `References: ${refs.join(' ')}` });
  return lines;
}
```

Create `apps/mail/tests/header-debug.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildOutboundHeaderPreview,
  canShowHeaderDebug,
  NAVA_TRANSPORT_ID,
} from '@/lib/mail/header-debug';

describe('header debug helpers', () => {
  it('allows only the Nava transport', () => {
    expect(canShowHeaderDebug(NAVA_TRANSPORT_ID)).toBe(true);
    expect(canShowHeaderDebug('transport-centurion')).toBe(false);
    expect(canShowHeaderDebug(null)).toBe(false);
  });

  it('builds deterministic outbound routing and threading preview lines', () => {
    expect(
      buildOutboundHeaderPreview({
        transportEmail: 'nava@legacyhotel.com',
        messageId: 'smtp-1@example.com',
        inReplyTo: 'parent@example.com',
        references: 'root@example.com parent@example.com',
      }),
    ).toEqual([
      { key: 'x-zero-mailbox', line: 'X-Zero-Mailbox: nava@legacyhotel.com' },
      { key: 'message-id', line: 'Message-ID: smtp-1@example.com' },
      { key: 'in-reply-to', line: 'In-Reply-To: parent@example.com' },
      { key: 'references', line: 'References: root@example.com parent@example.com' },
    ]);
  });
});
```

- [ ] **Step 3: Run helper test**

Run:

```bash
cd apps/mail && pnpm test tests/header-debug.test.ts
```

Expected: pass after helper exists.

- [ ] **Step 4: Add optional preview prop to `EmailComposer`**

In `apps/mail/components/create/email-composer.tsx`, import:

```typescript
import type { HeaderDebugLine } from '@/types';
```

Add prop:

```typescript
headerPreview?: HeaderDebugLine[];
```

Destructure:

```typescript
headerPreview = [],
```

Render after the hidden `fromEmail` input:

```tsx
{headerPreview.length > 0 ? (
  <div className="border-t bg-[#FFFFFF] px-3 py-2 text-xs dark:bg-[#202020]">
    <p className="mb-1 font-medium text-[#8C8C8C]">Headers on send</p>
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-5 dark:bg-white/[0.06]">
      {headerPreview.map((line) => line.line).join('\n')}
    </pre>
  </div>
) : null}
```

- [ ] **Step 5: Pass preview from new compose**

In `apps/mail/components/create/create-email.tsx`, import:

```typescript
import {
  buildOutboundHeaderPreview,
  canShowHeaderDebug,
  isHeaderDebugEnabled,
} from '@/lib/mail/header-debug';
```

Add:

```typescript
const headerPreview = useMemo(() => {
  if (!canShowHeaderDebug(activeConnection?.id) || !isHeaderDebugEnabled()) return [];
  return buildOutboundHeaderPreview({
    transportEmail: activeConnection?.email,
  });
}, [activeConnection?.email, activeConnection?.id]);
```

Pass:

```tsx
headerPreview={headerPreview}
```

to `EmailComposer`.

- [ ] **Step 6: Pass preview from reply composer**

In `apps/mail/components/mail/reply-composer.tsx`, import the same helpers.

Add:

```typescript
const headerPreview = useMemo(() => {
  if (!canShowHeaderDebug(activeConnection?.id) || !isHeaderDebugEnabled()) return [];
  return buildOutboundHeaderPreview({
    transportEmail: activeConnection?.email,
    inReplyTo: replyToMessage?.messageId,
    references: replyToMessage?.references,
  });
}, [
  activeConnection?.email,
  activeConnection?.id,
  replyToMessage?.messageId,
  replyToMessage?.references,
]);
```

Pass:

```tsx
headerPreview={headerPreview}
```

to `EmailComposer`.

- [ ] **Step 7: Add hidden toggle and debug display in `mail-display.tsx`**

Add `type MouseEvent` to the React import:

```typescript
import { memo, useEffect, useMemo, useState, useRef, useCallback, type MouseEvent } from 'react';
```

Import helpers:

```typescript
import {
  canShowHeaderDebug,
  isHeaderDebugEnabled,
  setHeaderDebugEnabled,
} from '@/lib/mail/header-debug';
```

Add state inside `MailDisplay`:

```typescript
const canDebugHeaders = canShowHeaderDebug(activeConnection?.id);
const [headerDebugEnabled, setHeaderDebugEnabledState] = useState(false);

useEffect(() => {
  setHeaderDebugEnabledState(isHeaderDebugEnabled());
}, []);

const toggleHeaderDebug = useCallback((e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  const next = !headerDebugEnabled;
  setHeaderDebugEnabled(next);
  setHeaderDebugEnabledState(next);
}, [headerDebugEnabled]);
```

Add a menu item after Print:

```tsx
{canDebugHeaders ? (
  <DropdownMenuItem onClick={toggleHeaderDebug}>
    {headerDebugEnabled ? 'Disable header debug' : 'Enable header debug'}
  </DropdownMenuItem>
) : null}
```

Render debug lines inside the details popover after the existing `signedBy` row:

```tsx
{canDebugHeaders && headerDebugEnabled && emailData.debugHeaders?.length ? (
  <div className="mt-3 border-t pt-3">
    <p className="mb-2 text-xs font-medium text-gray-500">Debug headers</p>
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-5 dark:bg-white/[0.06]">
      {emailData.debugHeaders.map((line) => line.line).join('\n')}
    </pre>
  </div>
) : null}
```

- [ ] **Step 8: Run FE tests**

Run:

```bash
cd apps/mail && pnpm test tests/header-debug.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add apps/mail/types/index.ts apps/mail/lib/mail/header-debug.ts apps/mail/components/mail/mail-display.tsx apps/mail/components/create/email-composer.tsx apps/mail/components/create/create-email.tsx apps/mail/components/mail/reply-composer.tsx apps/mail/tests/header-debug.test.ts
git commit -m "feat(mail-ui): hide header debug behind nava transport"
```

---

### Task 6: Focused Verification And Manual Playbook Docs

**Files:**
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`
- Modify: `docs/superpowers/specs/2026-07-03-nava-live-mail-test-harness-design.md`

**Interfaces:**
- No runtime interface changes.
- Produces final verification commands and human playbook.

- [ ] **Step 1: Add real-mail activation note**

Append to `apps/server-pilot/deploy/deferred-real-mail-readiness.md`:

```markdown
## Nava Live-Mail Manual Harness

When VPN and POP3/SMTP credentials are ready:

1. Run `pnpm --filter @zero/server seed:prod` so `nava-ops@legacyhotel.com` exists.
2. Enable existing real transport env: `MAIL_TRANSPORT_MODE=real`, POP3 env, SMTP env.
3. Login as `nava-ops@legacyhotel.com`.
4. Optional debug reveal: open DevTools console and run `localStorage.setItem('zero-dev-show-headers', '1')`, or use the Nava-only message menu toggle after opening a message.
5. App-to-self test: send from app to `nava@legacyhotel.com`; pass when the looped-back thread appears in Nava inbox.
6. External-to-Nava test: send from an external mailbox to `nava@legacyhotel.com`; pass when the thread appears in Nava spam.
7. App-to-external test: send from app to an external mailbox; pass when the external inbox receives it and app sent folder records it.
```

- [ ] **Step 2: Run focused server tests**

Run:

```bash
cd apps/server-pilot && pnpm test tests/seed-contract.test.ts tests/mail-send.test.ts tests/ingest-store.test.ts tests/pop3-worker.test.ts tests/mail-wire-contract.test.ts tests/mail-router-isolation.test.ts
```

Expected: pass.

- [ ] **Step 3: Run focused frontend test**

Run:

```bash
cd apps/mail && pnpm test tests/header-debug.test.ts
```

Expected: pass.

- [ ] **Step 4: Run type/build checks**

Run:

```bash
cd apps/server-pilot && pnpm build
cd apps/mail && pnpm build
```

Expected: both pass. If a build is too slow for the current agent session, record it as not run and keep focused tests as the minimum evidence.

- [ ] **Step 5: Commit docs**

```bash
git add apps/server-pilot/deploy/deferred-real-mail-readiness.md docs/superpowers/specs/2026-07-03-nava-live-mail-test-harness-design.md
git commit -m "docs: document nava live-mail manual playbook"
```

---

## Test Coverage Diagram

```text
CODE PATHS                                             TESTS
seedAll()
  ├── Centurion users unchanged                         seed-contract.test.ts existing
  ├── Nava user + credential                            Task 1 seed test
  ├── Nava access only transport-nava                   Task 1 seed test
  └── SPAM labels per transport                         Task 1 seed test

mail.send()
  ├── spoofed from rejected                             mail-send.test.ts existing
  ├── fake SMTP receives X-Zero-Mailbox                 Task 2 send test
  ├── outbound row still stores metadata                mail-send.test.ts existing
  └── reply headers still derive from DB                mail-send.test.ts existing

persistInboundMessage()
  ├── stamped Centurion -> inbox                        ingest-store.test.ts existing
  ├── no header + To nava -> Nava spam                  Task 3 direct-To test
  ├── no header + unknown To -> quarantine              Task 3 fallback test
  ├── unknown X-Zero-Mailbox -> quarantine              ingest-store.test.ts existing
  └── duplicate UIDL safe                               ingest-store.test.ts existing

ingestOnce()
  ├── stamped fixture -> Centurion stored               pop3-worker.test.ts existing
  ├── missing-owner fixture -> Nava spam stored         Task 3 worker update
  └── persist error -> no DELE                          pop3-worker.test.ts existing

mail.get()
  ├── Centurion transport -> no debugHeaders            Task 4 route test
  ├── Nava transport -> metadata debugHeaders           Task 4 route test
  └── cross-transport thread -> NOT_FOUND               mail-router-isolation.test.ts existing

FE header debug
  ├── gate only transport-nava                          Task 5 helper test
  ├── new compose preview shows X-Zero-Mailbox          Task 5 helper test + manual UI check
  ├── reply preview shows threading headers             Task 5 helper test + manual UI check
  └── details popover renders debug lines               Manual UI check
```

## Failure Modes

| Path | Failure | Handling |
| --- | --- | --- |
| SMTP relay strips custom header | App-to-self returns without `X-Zero-Mailbox` | Direct-To fallback stores it in Nava spam; manual inbox test fails visibly |
| Header UI leakage | Staff toggles localStorage manually | Server never returns `debugHeaders` outside `transport-nava` |
| Missing SPAM seed | Label absent at ingest | `ensureSpamLabel` creates idempotently |
| Direct-To address casing differs | `To: Nava@legacyhotel.com` | Lowercase comparison in `findDirectToTransport` |
| No matching `To` transport | Unknown recipient direct mail | Existing quarantine path remains |
| Reply preview missing future SMTP Message-ID | Message-ID only known after send | Preview omits Message-ID before send; sent row debug shows it after SMTP result |

## Parallelization

Sequential implementation. Tasks 1-4 touch shared server seed/routes/wire contracts, and Task 5 depends on Task 4 response shape. Splitting into worktrees creates more merge risk than speed.

## Plan Self-Review

| Requirement | Task |
| --- | --- |
| Nava ops login and transport | Task 1 |
| Staff unchanged | Task 1 and Task 4 tests |
| App stamps routing header | Task 2 |
| App-to-self can route back to inbox | Tasks 1-2 plus existing header ingest path |
| External direct Nava goes spam | Task 3 |
| No quarantine UI/API | No task; explicitly out of scope |
| No header schema column | Task 4 uses existing metadata |
| No raw MIME S3 read | Task 4 uses existing metadata |
| Header debug hidden | Tasks 4-5 |
| Reply and new compose header preview | Task 5 |
| Manual playbook | Task 6 |

Placeholder scan: no TBD / TODO / "implement later" placeholders.

Type consistency:

- Server debug line: `{ key: string; line: string }`
- FE debug line: `{ key: string; line: string }`
- `ParsedMessageWire.debugHeaders` maps to `ParsedMessage.debugHeaders`

---

**Plan saved to `docs/superpowers/plans/2026-07-03-nava-live-mail-test-harness.md`.**

**Recommended execution:** sequential task-by-task. Ship Tasks 1-3 first if time is tight; Tasks 4-5 are useful debug UX but not required for the three manual pass/fail checks.
