# Audit HTML Sanitize Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two static XSS seams from the T3MP3ST audit — unsanitized inbound `htmlBody` at ingest and unsanitized `htmlBody` fallback in draft wire — using the existing `sanitizeEmailHtml` rules, with no runtime PoC or transport work.

**Architecture:** Add one shared storage-boundary helper in `sanitize-email-html.ts`. Call it from `persistInboundMessage` (write path) and `toDraftWire` (htmlBody fallback only). Keep read-path sanitization in `wire-compat.ts` as belt-and-suspenders. Raw MIME stays in S3; DB `html_body` becomes sanitized HTML.

**Tech Stack:** TypeScript, Vitest, `sanitize-html` (via `sanitizeEmailHtml`), Drizzle + `withSeededTestDb` for ingest integration tests.

## Global Constraints

- **Package:** `@zero/server` (`apps/server-pilot`)
- **Sanitizer:** `sanitizeEmailHtml(html, { shouldLoadImages: false })` for all storage-boundary calls
- **Do not sanitize** draft `textBody` at wire time (holds user/AI TipTap HTML; formatting risk)
- **Do not change** X-Zero-Mailbox, demo `resolveMailHtml`, audit docs, or T3MP3ST tooling in this plan
- **Origin audit:** `docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md` (Pass 3 storage OPEN + verification F14)

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/mail/sanitize-email-html.ts` | Add `sanitizeHtmlBodyForStorage` — single storage-boundary API |
| `apps/server-pilot/src/mail/ingest/store.ts` | Sanitize before `message` insert |
| `apps/server-pilot/src/trpc/routes/draft-wire.ts` | Sanitize `htmlBody` when `textBody` is nullish |
| `apps/server-pilot/tests/sanitize-email-html.test.ts` | Unit tests for new helper |
| `apps/server-pilot/tests/ingest-html-sanitize.test.ts` | DB integration: persisted `htmlBody` sanitized |
| `apps/server-pilot/tests/draft-wire-sanitize.test.ts` | Unit tests for wire fallback |
| `apps/server-pilot/tests/mail-html-sanitize.test.ts` | Regression: double-sanitize read path still safe |

---

### Task 1: Storage-boundary helper

**Files:**
- Modify: `apps/server-pilot/src/mail/sanitize-email-html.ts`
- Modify: `apps/server-pilot/tests/sanitize-email-html.test.ts`

**Interfaces:**
- Produces: `sanitizeHtmlBodyForStorage(html: string | null): string | null`

- [ ] **Step 1: Write the failing test**

Append to `apps/server-pilot/tests/sanitize-email-html.test.ts`:

```typescript
import { sanitizeEmailHtml, sanitizeHtmlBodyForStorage } from '../src/mail/sanitize-email-html.js';

describe('sanitizeHtmlBodyForStorage', () => {
  it('returns null for null', () => {
    expect(sanitizeHtmlBodyForStorage(null)).toBeNull();
  });

  it('returns plain text unchanged when no angle brackets', () => {
    expect(sanitizeHtmlBodyForStorage('plain booking text')).toBe('plain booking text');
  });

  it('strips script and handlers from HTML', () => {
    const raw = '<img src=x onerror=alert(1)><script>alert(1)</script><p>ok</p>';
    const stored = sanitizeHtmlBodyForStorage(raw);
    expect(stored).not.toContain('<script');
    expect(stored).not.toMatch(/onerror/i);
    expect(stored).toContain('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root:

```bash
pnpm --filter=@zero/server exec vitest run tests/sanitize-email-html.test.ts -t sanitizeHtmlBodyForStorage
```

Expected: FAIL — `sanitizeHtmlBodyForStorage` is not exported / not defined

- [ ] **Step 3: Write minimal implementation**

Add to `apps/server-pilot/src/mail/sanitize-email-html.ts` after `sanitizeEmailHtml`:

```typescript
/** Sanitize HTML before persisting to Postgres. Raw MIME remains in S3. */
export function sanitizeHtmlBodyForStorage(html: string | null): string | null {
  if (html == null || html === '') return html;
  if (!html.includes('<')) return html;
  return sanitizeEmailHtml(html, { shouldLoadImages: false }).html;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter=@zero/server exec vitest run tests/sanitize-email-html.test.ts
```

Expected: PASS (all tests in file)

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/sanitize-email-html.ts apps/server-pilot/tests/sanitize-email-html.test.ts
git commit -m "feat(server-pilot): add sanitizeHtmlBodyForStorage helper"
```

---

### Task 2: Sanitize inbound htmlBody at persist

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts:252`
- Create: `apps/server-pilot/tests/ingest-html-sanitize.test.ts`

**Interfaces:**
- Consumes: `sanitizeHtmlBodyForStorage` from `../../mail/sanitize-email-html.js`

- [ ] **Step 1: Write the failing integration test**

Create `apps/server-pilot/tests/ingest-html-sanitize.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { message } from '../src/db/schema/mail.js';
import { generateMessageId, parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';

const reachable = await probeTestDb();

const MALICIOUS_HTML =
  '<img src=x onerror=alert(1)><script>alert(1)</script><p>booking</p>';

function centurionHtmlEml(html: string): Buffer {
  return Buffer.from(
    [
      'From: guest@example.com',
      'To: centurion@legacyhotel.com',
      'Subject: HTML persist sanitize',
      'X-Zero-Mailbox: centurion@legacyhotel.com',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].join('\r\n'),
    'utf-8',
  );
}

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'persistInboundMessage sanitizes htmlBody at storage',
  () => {
    it('stores sanitized htmlBody without script or onerror', async () => {
      const storage = withFakeS3();
      const raw = centurionHtmlEml(MALICIOUS_HTML);

      const { result, row } = await withSeededTestDb(async (db) => {
        const messageId = generateMessageId();
        const parsed = await parseRawMessage(raw, { messageId, storage });
        const r = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `uidl-html-${randomUUID()}`,
            messageId,
          },
          { db, storage },
        );
        if (r.kind !== 'stored') return { result: r, row: undefined };
        const rows = await db
          .select()
          .from(message)
          .where(eq(message.id, r.messageId));
        return { result: r, row: rows[0] };
      }, 30000);

      expect(result.kind).toBe('stored');
      expect(row?.htmlBody).toBeDefined();
      expect(row!.htmlBody!).not.toContain('<script');
      expect(row!.htmlBody!).not.toMatch(/onerror/i);
      expect(row!.htmlBody!).toContain('booking');
    });
  },
);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@zero/server exec vitest run tests/ingest-html-sanitize.test.ts
```

Expected: FAIL — `htmlBody` still contains `<script` (stored raw today)

Skip if no `DATABASE_URL`: test file uses `describe.skipIf` — note in PR if skipped locally.

- [ ] **Step 3: Wire helper into store**

In `apps/server-pilot/src/mail/ingest/store.ts`:

1. Add import:

```typescript
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
```

2. Replace line 252:

```typescript
htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter=@zero/server exec vitest run tests/ingest-html-sanitize.test.ts tests/ingest-store.test.ts
```

Expected: PASS (ingest-html-sanitize + existing ingest-store unchanged)

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/ingest/store.ts apps/server-pilot/tests/ingest-html-sanitize.test.ts
git commit -m "fix(server-pilot): sanitize inbound htmlBody at ingest"
```

---

### Task 3: Sanitize draft wire htmlBody fallback

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/draft-wire.ts`
- Create: `apps/server-pilot/tests/draft-wire-sanitize.test.ts`

**Interfaces:**
- Consumes: `sanitizeHtmlBodyForStorage` from `../../mail/sanitize-email-html.js`
- Produces: `toDraftWire` unchanged signature; `content` sanitized when sourced from `htmlBody`

- [ ] **Step 1: Write the failing test**

Create `apps/server-pilot/tests/draft-wire-sanitize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { mailDraft } from '../src/db/schema/mail.js';
import { toDraftWire } from '../src/trpc/routes/draft-wire.js';

const MALICIOUS = '<script>alert(1)</script><p>draft</p>';

function draftRow(
  overrides: Partial<typeof mailDraft.$inferSelect>,
): typeof mailDraft.$inferSelect {
  return {
    id: 'draft-1',
    transportId: 'transport-centurion',
    threadId: 'thread-1',
    createdByUserId: 'user-manager',
    toAddresses: [],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: test',
    textBody: null,
    htmlBody: MALICIOUS,
    attachments: [],
    isSent: false,
    status: 'active',
    origin: 'ai',
    replyToMessageId: null,
    generationId: null,
    sentMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('toDraftWire htmlBody fallback', () => {
  it('sanitizes htmlBody when textBody is null', () => {
    const wire = toDraftWire(draftRow({ textBody: null, htmlBody: MALICIOUS }));
    expect(wire.content).not.toContain('<script');
    expect(wire.content).toContain('draft');
  });

  it('does not sanitize textBody when present', () => {
    const userHtml = '<p class="tiptap">user</p>';
    const wire = toDraftWire(
      draftRow({ textBody: userHtml, htmlBody: MALICIOUS }),
    );
    expect(wire.content).toBe(userHtml);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@zero/server exec vitest run tests/draft-wire-sanitize.test.ts
```

Expected: FAIL — `content` contains `<script`

- [ ] **Step 3: Implement wire sanitization**

Replace `apps/server-pilot/src/trpc/routes/draft-wire.ts` with:

```typescript
import type { mailDraft } from '../../db/schema/mail.js';
import { sanitizeHtmlBodyForStorage } from '../../mail/sanitize-email-html.js';

export function toDraftWire(r: typeof mailDraft.$inferSelect, isStale = false) {
  return {
    id: r.id,
    threadId: r.threadId,
    replyToMessageId: r.replyToMessageId,
    to: r.toAddresses,
    cc: r.ccAddresses,
    bcc: r.bccAddresses,
    subject: r.subject,
    content: r.textBody ?? sanitizeHtmlBodyForStorage(r.htmlBody),
    updatedAt: r.updatedAt.toISOString(),
    status: r.status,
    origin: r.origin,
    generationId: r.generationId,
    isStale,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter=@zero/server exec vitest run tests/draft-wire-sanitize.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/draft-wire.ts apps/server-pilot/tests/draft-wire-sanitize.test.ts
git commit -m "fix(server-pilot): sanitize draft wire htmlBody fallback"
```

---

### Task 4: Read-path double-sanitize regression

**Files:**
- Modify: `apps/server-pilot/tests/mail-html-sanitize.test.ts`

**Interfaces:**
- Consumes: `sanitizeHtmlBodyForStorage`, `toParsedMessage`

- [ ] **Step 1: Write the failing test**

Append to `apps/server-pilot/tests/mail-html-sanitize.test.ts`:

```typescript
import { sanitizeHtmlBodyForStorage } from '../src/mail/sanitize-email-html.js';

it('toParsedMessage stays safe when htmlBody was pre-sanitized at ingest', () => {
  const malicious = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const stored = sanitizeHtmlBodyForStorage(malicious)!;
  const parsed = toParsedMessage({
    id: 'm3',
    transportId: 't1',
    threadId: 'th1',
    direction: 'inbound',
    fromAddress: 'a@b.com',
    toAddresses: ['c@d.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'x',
    textBody: null,
    htmlBody: stored,
    messageIdHeader: null,
    inReplyTo: null,
    references: [],
    isRead: true,
    isStarred: false,
    receivedAt: new Date(),
    sentAt: null,
    ingestMailboxId: null,
    pop3Uidl: null,
    ownerHeaderValue: null,
    rawMimeS3Key: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  expect(parsed.processedHtml).not.toContain('<script');
  expect(parsed.processedHtml).not.toMatch(/onerror/i);
});
```

- [ ] **Step 2: Run test**

```bash
pnpm --filter=@zero/server exec vitest run tests/mail-html-sanitize.test.ts
```

Expected: PASS immediately (read path already safe; this is a guard against future regressions)

- [ ] **Step 3: Commit**

```bash
git add apps/server-pilot/tests/mail-html-sanitize.test.ts
git commit -m "test(server-pilot): guard double-sanitize read path"
```

---

### Task 5: Full server-pilot test sweep

**Files:** (none — verification only)

- [ ] **Step 1: Run full server test suite**

```bash
pnpm --filter=@zero/server test
```

Expected: PASS

- [ ] **Step 2: Commit** (only if hook/format changed files)

If clean, no commit.

---

## Self-review

| Spec requirement | Task |
|------------------|------|
| R1 ingest sanitize | Task 2 |
| R2 raw MIME in S3 unchanged | Task 2 (no S3 changes) |
| R3 draft wire htmlBody fallback | Task 3 |
| R4 read path regression | Task 4 |
| Shared helper DRY | Task 1 |

Placeholder scan: none.

## Research notes (95% confidence)

- **Ingest:** `store.ts:252` writes raw `parsed.htmlBody`; `rawMimeS3Key` preserved separately.
- **Read path:** `wire-compat.ts:176-181` already sanitizes; `mail-content.tsx` calls `processEmailContent` in prod.
- **Draft wire:** `textBody ?? htmlBody` — manual drafts use `textBody` (TipTap HTML); only nullish `textBody` hits `htmlBody` (AI/orphan rows). Sanitize `htmlBody` branch only.
- **Exa / OWASP alignment:** sanitize-at-store + sanitize-at-serve = standard defense-in-depth for stored HTML email content.
- **Out of scope confirmed:** X-Zero-Mailbox PoC, demo `resolveMailHtml`, draft `textBody` sanitization, audit report edits.
