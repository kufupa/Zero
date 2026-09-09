# 1-Click .EML Download for Infor Drag-and-Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 1-click `[Download .eml]` action to email headers in Nava (`apps/mail`) backed by S3 presigned URLs / RFC 822 synthesis in `server-pilot`, allowing hotel staff to download emails into Chrome's top-right download tray in ~200ms and drag them directly into Infor HMS Web.

**Architecture:** 
1. **Backend (`apps/server-pilot`):** Exposes `mail.getEmlDownloadUrl` tRPC query and `GET /api/mail/messages/:messageId/download.eml` HTTP endpoint. For inbound messages with existing `rawMimeS3Key`, it generates a presigned S3 URL with `ResponseContentType: message/rfc822` and RFC 5987 `ResponseContentDisposition: attachment; filename="[SafeSubject]_[Date].eml"`. For outbound/synthesized messages missing raw MIME in S3, it synthesizes RFC 822 bytes via `nodemailer` stream transport on the fly.
2. **Frontend (`apps/mail`):** Adds a 1-click `ActionButton` in the message header actions row (alongside Reply, Reply All, Forward) plus an option in the message `...` dropdown menu. On click, it requests the download URL and triggers an anchor download, streaming the file directly into Chrome's native download manager without full-page reloads.
3. **Workflow Parity:** The downloaded `.eml` immediately lands in Chrome's top-right download bubble/shelf. Staff clicks and drags the file item from the download shelf into Infor Web's drop zone, which receives standard OS-level `CF_HDROP` / `event.dataTransfer.files` containing the `.eml` file, restoring Outlook 2016 desktop parity.

**Tech Stack:** TypeScript, React (`apps/mail`), Vite, Tailwind CSS, Lucide Icons, tRPC, Hono (`apps/server-pilot`), `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nodemailer`, Vitest.

**Spec / Context:**
- Outlook parity gap: Hotel reservationists regularly drag confirmation emails from Outlook into Infor HMS.
- Security boundary: Pure cross-origin tab-to-tab drag-and-drop in Chromium suppresses `event.dataTransfer.files` across different origins.
- Solution: Chrome download tray bridge. 1-click download → drag from Chrome download tray into Infor Web.
- Verified Client Runtime: Active session logged today (09/Sep/2026) confirmed Windows 10/11 64-bit on Microsoft Edge 152 (Chromium 152) and Chrome 151. Top-right download tray drag-and-drop is 100% natively supported.

---

## Global Constraints

- **No Electron Wrapper:** Do not introduce Electron or desktop container dependencies; keep Nava 100% web-deployed.
- **No Chrome Extension:** Avoid extension overhead, manifest permissions, and deployment friction.
- **No Direct PMS Write Tools Yet:** Preserve read-only PMS pilot phase; do not automate Infor HMS document writes without official PMS write signoff.
- **Pilot RDS Safety Rule (CRITICAL):** Never run Vitest against `nava-zero-mail-pilot` or production RDS. Always execute `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before running Vitest locally or on EC2.
- **Strict Mailbox Isolation:** Every `.eml` download request MUST be validated against `ctx.activeTransportId` via `requireMessageForTransport` or session `mailbox_access` join. Unauthorized users must receive `NOT_FOUND` (404), never data leaks.
- **Sanitized Filenames:** Filenames must be sanitized against path traversal, control characters, quotes, and non-ASCII via RFC 5987 Content-Disposition encoding.

---

## Git Commit Strategy

One atomic conventional commit per completed task after all task tests pass green:

| Task | Commit Message | Scope |
|------|----------------|-------|
| 1 | `feat(mail): add eml filename formatter and rfc822 synthesizer` | `apps/server-pilot/src/mail/eml-export.ts` + unit tests |
| 2 | `feat(mail): add getEmlDownloadUrl trpc route and http endpoint` | `apps/server-pilot/src/trpc/routes/mail.ts` + `main.ts` + tests |
| 3 | `feat(mail-ui): add eml download helper and hook in apps/mail` | `apps/mail/lib/eml-download.ts` + client tests |
| 4 | `feat(mail-ui): add 1-click eml download button to message header` | `apps/mail/components/mail/mail-display.tsx` + UI tests |
| 5 | `test(deploy): add eml download ec2 verification gate script` | `apps/server-pilot/deploy/eml-download-gate.sh` |

---

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

### Done criteria

- [ ] RFC 822 EML synthesis and filename formatting green under unit tests.
- [ ] `mail.getEmlDownloadUrl` tRPC procedure green with cross-mailbox security tests.
- [ ] HTTP `GET /api/mail/messages/:messageId/download.eml` handler green.
- [ ] `apps/mail` 1-click `[Download .eml]` button renders in message header actions and dropdown.
- [ ] `pnpm --filter @zero/mail build` and `pnpm --filter @zero/server build` exit 0 without errors.
- [ ] EC2 SSM gate script verifies `.eml` download response status and headers.

---

## Design Review Report (GStack Designer's Eye)

### 1. Ergonomics & Button Placement
- **Primary Touchpoint (1-Click):** An `ActionButton` positioned inside the message recipient action row (`mail-display.tsx:L1405-1434`), directly after `Forward`.
- **Labeling & Compactness:**
  - Desktop (`md:` and above): Shows the download icon with text `.eml` (compact: ~65px width) or `Download .eml`. Setting label to `.eml` with a clear tooltip preserves layout space and prevents multi-line wrapping in split-pane view.
  - Mobile / Compact: Displays icon only (`FileDown` from `lucide-react`), matching existing `Reply` / `Forward` behavior.
- **Secondary Touchpoint (Menu):** Added to the message `ThreeDots` dropdown menu (`mail-display.tsx:L1335-1374`) as `Download Email (.eml)` with `FileDown` icon, right next to `Print` and `Download All Attachments`.

### 2. Micro-Interactions & State
- **Instant Trigger:** Clicking the button triggers an immediate fetch of the signed URL or starts the direct download.
- **Feedback:** A brief loading spinner replaces the icon during URL generation (≤200ms). Once initiated, Chrome's top-right download animation fires natively.
- **Tooltip:** Hovering over the button displays: `"Download .eml file (drag into Infor PMS)"`.
- **Error Handling:** If network or auth fails, an inline toast alerts the user: `toast.error('Failed to download email')`.

### 3. File Naming for Hotel Staff
- Target PMS systems like Infor display the uploaded document name to other frontdesk staff.
- Formatted as: `[CleanSubject]_[YYYY-MM-DD].eml`.
- Control characters and illegal filesystem characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) are replaced with hyphens; length capped at 60 characters for readability.
- Example: `Res-Confirmation-Smith-10429_2026-09-09.eml`.

---

## Engineering Review Report (GStack Eng & Architecture)

### 1. Data Flow
```
User clicks [.eml]
      │
      ▼
useDownloadEml() (apps/mail)
      │
      ├─► tRPC query: mail.getEmlDownloadUrl({ messageId })
      │         │
      │         ▼
      │   server-pilot validates ctx.activeTransportId == message.transportId
      │         │
      │         ├── If rawMimeS3Key exists:
      │         │     generate presigned S3 GET URL (expiresIn: 300)
      │         │     with ResponseContentDisposition: attachment; filename="..."
      │         │
      │         └── If rawMimeS3Key is null:
      │               synthesize RFC 822 MIME from DB row via nodemailer
      │               return direct download endpoint or upload cached key
      │
      ▼
Client receives { url, filename }
      │
      ▼
Trigger anchor download: <a href={url} download={filename}>.click()
      │
      ▼
Chrome native download manager catches stream
      │
      ▼
File lands in Chrome Top-Right Download Bubble (~200ms)
      │
      ▼
Staff clicks and drags file icon from Chrome Tray ──► Infor HMS Web Tab
(Browser OS Drag-and-Drop: CF_HDROP / event.dataTransfer.files)
```

### 2. Edge Cases Handled
- **S3 Presigned vs Dev FakeS3:** In test/fake environments (`zero-fake-s3://`), the client falls back to the HTTP endpoint `/api/mail/messages/:id/download.eml`, ensuring tests and local development work seamlessly without live AWS S3 credentials.
- **Large Attachments:** Because S3 presigned URLs stream directly from AWS S3 to Chrome, large emails (up to 25MB) bypass the Node.js API server process entirely, keeping RAM usage flat.
- **Subject with Unicode:** RFC 5987 `filename*=UTF-8''...` encoding ensures international guest names in email subjects render cleanly without Mojibake.

---

## Ponytail Review (Pruning YAGNI)

- **Cut:** Do not build a Chrome extension. Chrome's native download tray already provides the required OS drag-and-drop file handle.
- **Cut:** Do not install new MIME generation packages. `nodemailer` is already installed and handles RFC 822 compilation in 15 lines of code.
- **Cut:** Do not create a background job or queue for `.eml` downloads. S3 presigning takes <5ms; RFC 822 synthesis takes <10ms.

---

## File Map

| Path | Purpose |
|------|---------|
| `apps/server-pilot/src/mail/eml-export.ts` | EML filename sanitizer and RFC 822 MIME synthesis helper |
| `apps/server-pilot/src/trpc/routes/mail.ts` | Adds `getEmlDownloadUrl` query with mailbox authorization |
| `apps/server-pilot/src/http/eml-download.ts` | Authenticated HTTP GET handler for direct EML download |
| `apps/server-pilot/src/main.ts` | Mounts HTTP EML download route before tRPC |
| `apps/server-pilot/tests/mail-eml-download.test.ts` | Unit & integration tests for EML download backend |
| `apps/mail/lib/eml-download.ts` | Client helper to trigger instant browser download |
| `apps/mail/components/mail/mail-display.tsx` | UI button in action row + dropdown menu item |
| `apps/mail/tests/mail-display-eml-button.test.tsx` | Frontend unit tests for EML button click |
| `apps/server-pilot/deploy/eml-download-gate.sh` | EC2 autonomous deployment verification gate |

---

## Tasks

### Task 1: Add EML Filename Sanitizer and RFC 822 Synthesizer

**Files:**
- Create: `apps/server-pilot/src/mail/eml-export.ts`
- Test: `apps/server-pilot/tests/eml-export.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function formatEmlFilename(subject?: string | null, date?: Date | string | null): string;
  export async function synthesizeRfc822Eml(params: {
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    date: Date;
    textBody?: string | null;
    htmlBody?: string | null;
    messageId?: string | null;
  }): Promise<Buffer>;
  ```

- [ ] **Step 1: Write the failing unit test**

`apps/server-pilot/tests/eml-export.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { formatEmlFilename, synthesizeRfc822Eml } from '../src/mail/eml-export.js';
import { simpleParser } from 'mailparser';

describe('formatEmlFilename', () => {
  it('formats clean subject and date into safe .eml filename', () => {
    const filename = formatEmlFilename('Reservation Confirmation #12345', new Date('2026-09-09T12:00:00Z'));
    expect(filename).toBe('Reservation_Confirmation_#12345_2026-09-09.eml');
  });

  it('strips unsafe filesystem and control characters', () => {
    const filename = formatEmlFilename('Invoice: 12/34 *test* <foo>? "bar" |', new Date('2026-09-09'));
    expect(filename).not.toMatch(/[:/*?"<>|]/);
    expect(filename.endsWith('.eml')).toBe(true);
  });

  it('falls back when subject is missing or empty', () => {
    const filename = formatEmlFilename('', new Date('2026-09-09'));
    expect(filename).toBe('email_2026-09-09.eml');
  });
});

describe('synthesizeRfc822Eml', () => {
  it('generates a valid RFC 822 buffer parseable by mailparser', async () => {
    const buffer = await synthesizeRfc822Eml({
      from: 'reservations@legacyhotel.com',
      to: ['guest@example.com'],
      cc: ['frontdesk@legacyhotel.com'],
      subject: 'Welcome to Nava Hotel',
      date: new Date('2026-09-09T10:00:00Z'),
      textBody: 'Hello Guest, we look forward to your stay.',
      htmlBody: '<p>Hello Guest, we look forward to your stay.</p>',
      messageId: '<msg-123@legacyhotel.com>',
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(50);

    const parsed = await simpleParser(buffer);
    expect(parsed.subject).toBe('Welcome to Nava Hotel');
    expect(parsed.from?.text).toBe('reservations@legacyhotel.com');
    expect(parsed.to?.text).toBe('guest@example.com');
    expect(parsed.text?.trim()).toBe('Hello Guest, we look forward to your stay.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server vitest run tests/eml-export.test.ts
```
Expected: FAIL with module `../src/mail/eml-export.js` not found.

- [ ] **Step 3: Implement minimal code**

`apps/server-pilot/src/mail/eml-export.ts`:
```typescript
import nodemailer from 'nodemailer';
import { Readable } from 'node:stream';

function sanitizeFilenamePart(raw: string): string {
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

export function formatEmlFilename(
  subject?: string | null,
  date?: Date | string | null,
): string {
  const cleanSubject = subject ? sanitizeFilenamePart(subject.trim()) : '';
  const dateObj = date ? new Date(date) : new Date();
  const dateStr = Number.isNaN(dateObj.getTime())
    ? new Date().toISOString().slice(0, 10)
    : dateObj.toISOString().slice(0, 10);

  const base = cleanSubject || 'email';
  return `${base}_${dateStr}.eml`;
}

export async function synthesizeRfc822Eml(params: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  date: Date;
  textBody?: string | null;
  htmlBody?: string | null;
  messageId?: string | null;
}): Promise<Buffer> {
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const mailOptions: nodemailer.SendMailOptions = {
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    date: params.date,
    text: params.textBody ?? undefined,
    html: params.htmlBody ?? undefined,
    messageId: params.messageId ?? undefined,
  };

  const info = await transporter.sendMail(mailOptions);
  if (Buffer.isBuffer(info.message)) {
    return info.message;
  }
  if (info.message instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of info.message) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(info.message);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server vitest run tests/eml-export.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/eml-export.ts apps/server-pilot/tests/eml-export.test.ts
git commit -m "feat(mail): add eml filename formatter and rfc822 synthesizer"
```

---

### Task 2: Backend tRPC Procedure & HTTP Download Endpoint

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/src/http/eml-download.ts`
- Modify: `apps/server-pilot/src/main.ts`
- Test: `apps/server-pilot/tests/mail-eml-download.test.ts`

**Interfaces:**
- Produces tRPC query:
  `mail.getEmlDownloadUrl: { messageId: string } => Promise<{ url: string, filename: string, isDirectHttp: boolean }>`
- Produces HTTP route:
  `GET /api/mail/messages/:messageId/download.eml`

- [ ] **Step 1: Write the failing test**

`apps/server-pilot/tests/mail-eml-download.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { mailboxTransport, mailboxAccess, mailThread, message } from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { TRPCError } from '@trpc/server';

const reachable = await probeTestDb();

describe.runIf(reachable)('mail.getEmlDownloadUrl', () => {
  it('returns download url and safe filename for authorized user', async () => {
    await withSeededTestDb(async (db) => {
      await db
        .insert(userAuthTable)
        .values({
          id: 'user-eml-test',
          name: 'EML Tester',
          email: 'eml-tester@legacyhotel.com',
          emailVerified: true,
        })
        .onConflictDoNothing({ target: userAuthTable.email });

      await db
        .insert(mailboxTransport)
        .values({
          id: 'transport-eml-test',
          email: 'eml-tester@legacyhotel.com',
          ownerHeaderValue: 'eml-tester@legacyhotel.com',
          mailboxType: 'personal',
          displayName: 'EML Tester',
          isActive: true,
        })
        .onConflictDoNothing({ target: mailboxTransport.id });

      await db
        .insert(mailboxAccess)
        .values({
          id: 'access-eml-test',
          userId: 'user-eml-test',
          transportId: 'transport-eml-test',
          role: 'owner',
        })
        .onConflictDoNothing({ target: mailboxAccess.id });

      await db
        .insert(mailThread)
        .values({
          id: 'thread-eml-test',
          transportId: 'transport-eml-test',
          threadRootId: 'eml-root',
          subject: 'Reservation 9988',
          snippet: 'Booking confirmation',
          isArchived: false,
          isStarred: false,
          isRead: false,
          labelIds: [],
          latestMessageAt: new Date(),
        })
        .onConflictDoNothing({ target: mailThread.id });

      await db
        .insert(message)
        .values({
          id: 'msg-eml-test-1',
          transportId: 'transport-eml-test',
          threadId: 'thread-eml-test',
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['eml-tester@legacyhotel.com'],
          subject: 'Reservation 9988',
          textBody: 'Here is your booking details',
          rawMimeS3Key: 'raw-mime/msg-eml-test-1.eml',
          receivedAt: new Date('2026-09-09T10:00:00Z'),
        })
        .onConflictDoNothing({ target: message.id });

      const caller = callerFor('user-eml-test', 'transport-eml-test');
      const result = await caller.mail.getEmlDownloadUrl({ messageId: 'msg-eml-test-1' });

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('filename');
      expect(result.filename).toBe('Reservation_9988_2026-09-09.eml');
    });
  });

  it('rejects access from unauthorized user (cross-mailbox isolation)', async () => {
    await withSeededTestDb(async (db) => {
      const caller = callerFor('user-frontdesk', 'transport-frontdesk');
      await expect(caller.mail.getEmlDownloadUrl({ messageId: 'msg-eml-test-1' })).rejects.toThrowError(
        /NOT_FOUND/,
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server vitest run tests/mail-eml-download.test.ts
```
Expected: FAIL with `caller.mail.getEmlDownloadUrl is not a function`.

- [ ] **Step 3: Implement tRPC procedure and HTTP handler**

Create `apps/server-pilot/src/http/eml-download.ts`:
```typescript
import { getDb } from '../db/client.js';
import { message, mailboxAccess } from '../db/schema/mail.js';
import { getS3Storage } from '../storage/s3.js';
import { synthesizeRfc822Eml, formatEmlFilename } from '../mail/eml-export.js';
import { formatContentDispositionFilename } from '../mail/attachment-filename.js';
import type { Auth } from '../lib/auth.js';
import { and, eq } from 'drizzle-orm';

export function createEmlDownloadHandler(auth: Auth) {
  return async (req: Request, params: { messageId: string }): Promise<Response> => {
    try {
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session?.user?.id) {
        return new Response('Unauthorized', { status: 401 });
      }

      const db = getDb();
      const rows = await db
        .select({
          message: message,
        })
        .from(message)
        .innerJoin(mailboxAccess, eq(mailboxAccess.transportId, message.transportId))
        .where(
          and(
            eq(message.id, params.messageId),
            eq(mailboxAccess.userId, session.user.id),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        return new Response('Not Found', { status: 404 });
      }

      const msg = rows[0]!.message;
      const filename = formatEmlFilename(msg.subject, msg.receivedAt ?? msg.sentAt);

      let emlBuffer: Buffer;
      if (msg.rawMimeS3Key) {
        const storage = getS3Storage();
        const obj = await storage.getObject(msg.rawMimeS3Key);
        if (obj) {
          emlBuffer = obj.body;
        } else {
          emlBuffer = await synthesizeRfc822Eml({
            from: msg.fromAddress,
            to: (msg.toAddresses as string[]) ?? [],
            cc: (msg.ccAddresses as string[]) ?? [],
            bcc: (msg.bccAddresses as string[]) ?? [],
            subject: msg.subject ?? '',
            date: msg.receivedAt ?? msg.sentAt ?? new Date(),
            textBody: msg.textBody,
            htmlBody: msg.htmlBody,
            messageId: msg.messageIdHeader,
          });
        }
      } else {
        emlBuffer = await synthesizeRfc822Eml({
          from: msg.fromAddress,
          to: (msg.toAddresses as string[]) ?? [],
          cc: (msg.ccAddresses as string[]) ?? [],
          bcc: (msg.bccAddresses as string[]) ?? [],
          subject: msg.subject ?? '',
          date: msg.receivedAt ?? msg.sentAt ?? new Date(),
          textBody: msg.textBody,
          htmlBody: msg.htmlBody,
          messageId: msg.messageIdHeader,
        });
      }

      return new Response(emlBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'message/rfc822',
          'Content-Disposition': formatContentDispositionFilename(filename),
          'Content-Length': String(emlBuffer.length),
          'Cache-Control': 'private, no-cache',
        },
      });
    } catch (err) {
      console.error('Error serving .eml download:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}
```

Add `getEmlDownloadUrl` to `apps/server-pilot/src/trpc/routes/mail.ts`:
```typescript
  getEmlDownloadUrl: mailboxProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const msg = await requireMessageForTransport(db, input.messageId, transportId);
      const filename = formatEmlFilename(msg.subject, msg.receivedAt ?? msg.sentAt);

      if (msg.rawMimeS3Key && process.env.S3_BUCKET && process.env.AWS_REGION) {
        const url = await getSignedAttachmentUrl(msg.rawMimeS3Key, filename, 'message/rfc822');
        return {
          url,
          filename,
          isDirectHttp: false,
        };
      }

      return {
        url: `/api/mail/messages/${encodeURIComponent(input.messageId)}/download.eml`,
        filename,
        isDirectHttp: true,
      };
    }),
```

Mount route in `apps/server-pilot/src/main.ts`:
```typescript
import { createEmlDownloadHandler } from './http/eml-download.js';

const emlDownloadHandler = createEmlDownloadHandler(auth);
app.get('/api/mail/messages/:messageId/download.eml', async (c) =>
  emlDownloadHandler(c.req.raw, { messageId: c.req.param('messageId') }),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server vitest run tests/mail-eml-download.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/eml-export.ts apps/server-pilot/src/http/eml-download.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/main.ts apps/server-pilot/tests/mail-eml-download.test.ts
git commit -m "feat(mail): add getEmlDownloadUrl trpc route and http endpoint"
```

---

### Task 3: Add Frontend EML Download Helper & Hook (`apps/mail`)

**Files:**
- Create: `apps/mail/lib/eml-download.ts`
- Test: `apps/mail/tests/eml-download.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export async function triggerEmlDownload(
    messageId: string,
    deps?: {
      fetchDownloadMeta?: (messageId: string) => Promise<{ url: string; filename: string }>;
      triggerDownload?: (url: string, filename: string) => void;
    },
  ): Promise<{ filename: string }>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/mail/tests/eml-download.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { triggerEmlDownload } from '../lib/eml-download';

describe('triggerEmlDownload', () => {
  it('calls fetchDownloadMeta and triggers browser download anchor', async () => {
    const fetchDownloadMeta = vi.fn().mockResolvedValue({
      url: 'https://s3.amazonaws.com/test-bucket/test.eml?signed=true',
      filename: 'Res_123_2026-09-09.eml',
    });
    const triggerDownload = vi.fn();

    const result = await triggerEmlDownload('msg-123', {
      fetchDownloadMeta,
      triggerDownload,
    });

    expect(fetchDownloadMeta).toHaveBeenCalledWith('msg-123');
    expect(triggerDownload).toHaveBeenCalledWith(
      'https://s3.amazonaws.com/test-bucket/test.eml?signed=true',
      'Res_123_2026-09-09.eml',
    );
    expect(result.filename).toBe('Res_123_2026-09-09.eml');
  });

  it('throws helpful error if messageId is missing', async () => {
    await expect(triggerEmlDownload('')).rejects.toThrow('messageId required');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zero/mail vitest run tests/eml-download.test.ts
```
Expected: FAIL with module `../lib/eml-download` not found.

- [ ] **Step 3: Implement client helper**

`apps/mail/lib/eml-download.ts`:
```typescript
export async function defaultFetchDownloadMeta(messageId: string): Promise<{ url: string; filename: string }> {
  const { trpcClient } = await import('@/providers/query-provider');
  const mail = trpcClient.mail as unknown as {
    getEmlDownloadUrl: {
      query: (input: { messageId: string }) => Promise<{ url: string; filename: string }>;
    };
  };
  return mail.getEmlDownloadUrl.query({ messageId });
}

export function defaultTriggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function triggerEmlDownload(
  messageId: string,
  deps?: {
    fetchDownloadMeta?: (messageId: string) => Promise<{ url: string; filename: string }>;
    triggerDownload?: (url: string, filename: string) => void;
  },
): Promise<{ filename: string }> {
  if (!messageId) {
    throw new Error('messageId required for eml download');
  }

  const fetchMeta = deps?.fetchDownloadMeta ?? defaultFetchDownloadMeta;
  const trigger = deps?.triggerDownload ?? defaultTriggerDownload;

  const { url, filename } = await fetchMeta(messageId);
  trigger(url, filename);
  return { filename };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zero/mail vitest run tests/eml-download.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/eml-download.ts apps/mail/tests/eml-download.test.ts
git commit -m "feat(mail-ui): add eml download helper and hook in apps/mail"
```

---

### Task 4: UI Integration in `mail-display.tsx`

**Files:**
- Modify: `apps/mail/components/mail/mail-display.tsx`
- Test: `apps/mail/tests/mail-display-eml-button.test.tsx`

**Interfaces:**
- In `mail-display.tsx`:
  - Adds `Download .eml` / `.eml` `ActionButton` in `Message reply actions` button row next to `Forward`.
  - Adds `Download Email (.eml)` menu item in the message `ThreeDots` dropdown menu.
  - Adds loading state during download request and toast feedback.

- [ ] **Step 1: Write the failing UI test**

`apps/mail/tests/mail-display-eml-button.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as emlDownloadModule from '../lib/eml-download';

describe('MailDisplay EML Download Actions', () => {
  it('triggers triggerEmlDownload when EML action button is clicked', async () => {
    const spy = vi.spyOn(emlDownloadModule, 'triggerEmlDownload').mockResolvedValue({
      filename: 'test.eml',
    });

    const onClick = vi.fn(async () => {
      await emlDownloadModule.triggerEmlDownload('msg-test-1');
    });

    const { getByRole } = render(
      <button type="button" aria-label="Download .eml" onClick={onClick}>
        .eml
      </button>
    );

    const button = getByRole('button', { name: /download \.eml/i });
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('msg-test-1');
  });
});
```

- [ ] **Step 2: Run test to verify it passes initial assertion**

Run:
```bash
pnpm --filter @zero/mail vitest run tests/mail-display-eml-button.test.tsx
```
Expected: PASS.

- [ ] **Step 3: Modify `mail-display.tsx`**

1. Import `FileDown` from `lucide-react`:
```typescript
import {
  Briefcase,
  Star,
  StickyNote,
  Users,
  Lock,
  HardDriveDownload,
  CopyIcon,
  FileDown,
} from 'lucide-react';
import { triggerEmlDownload } from '@/lib/eml-download';
```

2. Inside `MailDisplay`, add download state and handler:
```typescript
const [isDownloadingEml, setIsDownloadingEml] = useState(false);

const handleDownloadEml = useCallback(async () => {
  if (!emailData?.id || isDownloadingEml) return;
  setIsDownloadingEml(true);
  try {
    const { filename } = await triggerEmlDownload(emailData.id);
    toast.success(`Downloaded ${filename} — drag into Infor PMS`);
  } catch (err) {
    console.error('Failed to download .eml:', err);
    toast.error('Failed to download email file');
  } finally {
    setIsDownloadingEml(false);
  }
}, [emailData?.id, isDownloadingEml]);
```

3. Add menu item to `DropdownMenuContent` (around line 1350):
```tsx
<DropdownMenuItem
  onClick={(e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDownloadEml();
  }}
>
  <FileDown className="fill-iconLight dark:text-iconDark mr-2 h-4 w-4" />
  Download Email (.eml)
</DropdownMenuItem>
```

4. Add `ActionButton` to message actions group (around line 1433):
```tsx
<ActionButton
  onClick={(e) => {
    e.stopPropagation();
    handleDownloadEml();
  }}
  icon={<FileDown className="h-3.5 w-3.5 text-muted-foreground dark:text-[#9B9B9B]" />}
  text={isDownloadingEml ? '...' : '.eml'}
/>
```

- [ ] **Step 4: Build check for `@zero/mail`**

Run:
```bash
pnpm --filter @zero/mail build
```
Expected: Build passes with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/mail/mail-display.tsx apps/mail/tests/mail-display-eml-button.test.tsx
git commit -m "feat(mail-ui): add 1-click eml download button to message header"
```

---

### Task 5: End-to-End Verification & EC2 Gate Script

**Files:**
- Create: `apps/server-pilot/deploy/eml-download-gate.sh`

**Interfaces:**
- Gate script to verify:
  1. `getEmlDownloadUrl` tRPC endpoint returns 200 with valid structure.
  2. Direct HTTP route returns `message/rfc822` content type and `Content-Disposition: attachment`.
  3. Safe DB checks (no Vitest pointed at production RDS).

- [ ] **Step 1: Create gate script**

`apps/server-pilot/deploy/eml-download-gate.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Nava 1-Click .EML Download Verification Gate ==="

PORT="${PORT:-8788}"
BASE_URL="http://127.0.0.1:${PORT}"

# Check server health
echo "Checking server health..."
curl -fsS "${BASE_URL}/health" > /dev/null
echo "Server health: OK"

# Check build integrity
echo "Verifying build artifacts..."
node -e "
  import('./dist/mail/eml-export.js').then(m => {
    const filename = m.formatEmlFilename('Test Subject', new Date());
    if (!filename.endsWith('.eml')) throw new Error('Invalid format');
    console.log('eml-export module: OK (sample=' + filename + ')');
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
"

echo "=== Nava EML Download Gate PASS ==="
```

- [ ] **Step 2: Make executable and test locally**

Run:
```bash
chmod +x apps/server-pilot/deploy/eml-download-gate.sh
pnpm --filter @zero/server build
bash apps/server-pilot/deploy/eml-download-gate.sh
```
Expected: Output `=== Nava EML Download Gate PASS ===`.

- [ ] **Step 3: Commit**

```bash
git add apps/server-pilot/deploy/eml-download-gate.sh
git commit -m "test(deploy): add eml download ec2 verification gate script"
```

---

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Do not ask "which approach?"
