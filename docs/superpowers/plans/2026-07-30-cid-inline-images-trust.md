# CID Inline Images + Trust Sender Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: `overnight-autonomous-execution` + `overnight-autonomous-zero` (mandate below is binding) and `superpowers:subagent-driven-development`. Execute task-by-task with test-driven development. Do not ask "which approach?"

**Execution posture:** Overnight autonomous — user unavailable; implement-fix-loop until done criteria green.

**Goal:** Render same-message CID banners/GIFs in the email body and make Trust Sender able to load remote images (URLs no longer burned at ingest/wire).

**Architecture:** Keep XSS sanitize everywhere. Stop replacing remote `img src` at storage/wire. At `processEmailContent`, gate remotes with `shouldLoadImages`, rewrite `cid:` to absolute cookie-auth `/inline` URLs, serve bytes via Hono with mailbox_access + raster checks. FE passes `messageId`, bumps cache to `email-content-v2`, and matches trust by email/domain using existing never-spam hotel domains.

**Tech Stack:** Hono, tRPC, sanitize-html, cheerio, Vitest, React Query, Shadow DOM mail viewer.

**Upstream:** `docs/plans/2026-07-30-002-fix-cid-inline-images-and-trust-plan.md` (ce-plan). Overlaps rocketseed Tasks 5–7 in `docs/superpowers/plans/2026-07-30-rocketseed-banner-first-class.md`.

**Branch:** `EC2-pilot`

## Global Constraints

- Never enable JavaScript in email HTML (no iframe `allow-scripts`).
- Never put signed S3 URLs or `contentId` into thread wire types for the FE to rewrite.
- Absolute inline URLs must use origin from `BETTER_AUTH_URL` (relative `/api` breaks under Vite).
- CID images always project when valid; remote http(s) stay trust-gated.
- Reuse `AUTO_TRIAGE_NEVER_SPAM_DOMAINS` — do not create a second hotel-domains module.
- Do not change Rocketseed SMTP / outbound in this plan.

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Tasks 1–4 implemented; all listed vitest targets green locally
- [ ] `pnpm --dir apps/server-pilot build` green
- [ ] Commits pushed to `EC2-pilot`; `ops-deploy.sh` (no migrate unless schema added) succeeded
- [ ] SSM: vitest for cid/inline/process/trust/sanitize suites green on EC2
- [ ] SSM or API proof: `processEmailContent` on a fixture/live message with `cid:` returns `processedHtml` containing `/attachments/.../inline` (not raw `cid:`)
- [ ] Inline route: unauthenticated GET → 401; authorized path covered by tests
- [ ] Handoff report under `docs/superpowers/plans/handoff-reports/` with commit SHAs + gate output
- [ ] Human visual open of branded mail = optional post-overnight note only (not a blocking overnight checkpoint)

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

### Task 1: CID rewrite + raster helpers

**Files:**
- Create: `apps/server-pilot/src/mail/cid-images.ts`
- Create: `apps/server-pilot/src/mail/safe-inline-image.ts`
- Modify: `apps/server-pilot/src/mail/sanitize-email-html.ts`
- Test: `apps/server-pilot/tests/cid-images.test.ts`
- Test: `apps/server-pilot/tests/safe-inline-image.test.ts`
- Modify: `apps/server-pilot/tests/sanitize-email-html.test.ts`

**Interfaces:**
- Consumes: attachment meta `{ attachmentId, contentId, mimeType, sizeBytes }[]`, `origin: string`, `messageId: string`
- Produces: `normalizeContentId(raw: string): string | null`, `projectCidImages(html, meta, opts): { html, hasBlockedImages }`, `assertSafeInlineRaster(bytes, mimeType): void`, exported `BLOCKED_IMAGE_PLACEHOLDER`

- [ ] **Step 1: Write the failing CID tests**

```ts
// apps/server-pilot/tests/cid-images.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeContentId, projectCidImages } from '../src/mail/cid-images.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';

describe('normalizeContentId', () => {
  it('strips cid:, brackets, and lowercases', () => {
    expect(normalizeContentId('CID:Banner%2Egif@Host')).toBe('banner.gif@host');
    expect(normalizeContentId('<banner001@rocketseed>')).toBe('banner001@rocketseed');
  });

  it('rejects path-like ids', () => {
    expect(normalizeContentId('cid:../../etc/passwd')).toBeNull();
    expect(normalizeContentId('cid:a?b')).toBeNull();
  });
});

describe('projectCidImages', () => {
  const meta = [
    {
      attachmentId: 'att-1',
      contentId: '<banner001@rocketseed>',
      mimeType: 'image/gif',
      sizeBytes: 1200,
    },
  ];

  it('rewrites img cid to absolute inline URL', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<p><img alt="b" src="cid:banner001@rocketseed" width="100"></p>',
      meta,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(false);
    expect(html).toContain(
      'src="https://nava.legacy.local/api/mail/messages/msg-1/attachments/att-1/inline"',
    );
    expect(html).toContain('alt="b"');
  });

  it('placeholders missing cid and does not rewrite anchors', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<a href="cid:banner001@rocketseed">x</a><img src="cid:missing@x">',
      meta,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).toContain('href="cid:banner001@rocketseed"');
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/server-pilot exec vitest run tests/cid-images.test.ts`
Expected: FAIL module not found / export missing

- [ ] **Step 3: Export placeholder + implement helpers**

In `sanitize-email-html.ts`, change placeholder to:

```ts
export const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
```

Create `cid-images.ts`:

```ts
import { load } from 'cheerio';
import { BLOCKED_IMAGE_PLACEHOLDER } from './sanitize-email-html.js';

export type CidAttachmentMeta = {
  attachmentId: string;
  contentId: string | null;
  mimeType: string;
  sizeBytes: number;
};

export function normalizeContentId(raw: string): string | null {
  let s = raw.trim();
  if (/^cid:/i.test(s)) s = s.slice(4);
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  s = s.trim().toLowerCase();
  if (!s || /[\u0000-\u001f\\/?#]/.test(s)) return null;
  return s;
}

function isImageMime(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  return m === 'image/png' || m === 'image/jpeg' || m === 'image/gif' || m === 'image/webp';
}

export function projectCidImages(
  html: string,
  attachments: CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  const byCid = new Map<string, CidAttachmentMeta>();
  const ambiguous = new Set<string>();
  for (const a of attachments) {
    if (!a.contentId || !isImageMime(a.mimeType)) continue;
    const id = normalizeContentId(a.contentId);
    if (!id) continue;
    if (byCid.has(id) || ambiguous.has(id)) {
      byCid.delete(id);
      ambiguous.add(id);
      continue;
    }
    byCid.set(id, a);
  }

  const origin = opts.origin.replace(/\/$/, '');
  let hasBlockedImages = false;
  const $ = load(html, null, false);
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!/^cid:/i.test(src.trim())) return;
    const id = normalizeContentId(src);
    const att = id ? byCid.get(id) : undefined;
    if (!att) {
      hasBlockedImages = true;
      $(el).attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      return;
    }
    $(el).attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/inline`,
    );
  });
  return { html: $.html(), hasBlockedImages };
}
```

Create `safe-inline-image.ts` with magic-byte checks (PNG `\x89PNG`, JPEG `\xff\xd8\xff`, GIF `GIF87a`/`GIF89a`, WebP `RIFF....WEBP`), reject if `bytes.length > 5 * 1024 * 1024`, reject non-matching MIME, throw typed errors `InlineImageUnsupportedError` / `InlineImageTooLargeError`. Dimension parsing: minimal header reads; reject width/height > 10000 or width*height > 25_000_000. Full cases in `tests/safe-inline-image.test.ts` mirroring rocketseed Task 5 Step 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/server-pilot exec vitest run tests/cid-images.test.ts tests/safe-inline-image.test.ts tests/sanitize-email-html.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/cid-images.ts apps/server-pilot/src/mail/safe-inline-image.ts apps/server-pilot/src/mail/sanitize-email-html.ts apps/server-pilot/tests/cid-images.test.ts apps/server-pilot/tests/safe-inline-image.test.ts apps/server-pilot/tests/sanitize-email-html.test.ts
git commit -m "feat(mail): project safe inline CID images"
```

---

### Task 2: Authenticated inline HTTP route

**Files:**
- Create: `apps/server-pilot/src/http/inline-attachment.ts`
- Modify: `apps/server-pilot/src/main.ts`
- Test: `apps/server-pilot/tests/inline-attachment-http.test.ts`
- Modify: `apps/server-pilot/tests/attachment-access.test.ts`

**Interfaces:**
- Consumes: Better Auth `getSession`, drizzle DB, `getObjectBounded`
- Produces: `createInlineAttachmentHandler(deps) => (c) => Response` mounted at `GET /api/mail/messages/:messageId/attachments/:attachmentId/inline`

- [ ] **Step 1: Write failing HTTP tests**

```ts
// apps/server-pilot/tests/inline-attachment-http.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createInlineAttachmentHandler } from '../src/http/inline-attachment.js';

const GIF89A = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00', 'binary');

describe('inline attachment route', () => {
  it('returns 401 without session', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => null,
      loadAuthorizedAttachment: async () => null,
      getObjectBounded: async () => null,
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 bytes for authorized gif', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => ({
        s3Key: 'attachments/m1/000-x.gif',
        mimeType: 'image/gif',
        sizeBytes: GIF89A.length,
      }),
      getObjectBounded: async () => ({ body: GIF89A, contentType: 'image/gif' }),
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/gif');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(GIF89A);
  });
});
```

Add cases: 404 cross-mailbox, 415 bad magic, 413 oversize metadata, 404 missing S3.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/server-pilot exec vitest run tests/inline-attachment-http.test.ts`
Expected: FAIL missing module

- [ ] **Step 3: Implement handler + mount before tRPC**

```ts
// apps/server-pilot/src/http/inline-attachment.ts (shape)
export function createInlineAttachmentHandler(deps: {
  getSession: (req: Request) => Promise<{ user: { id: string } } | null>;
  loadAuthorizedAttachment: (args: {
    userId: string;
    messageId: string;
    attachmentId: string;
  }) => Promise<{ s3Key: string; mimeType: string; sizeBytes: number } | null>;
  getObjectBounded: (key: string, maxBytes: number) => Promise<{ body: Buffer; contentType?: string } | null>;
}) {
  const MAX = 5 * 1024 * 1024;
  return async (req: Request, params: { messageId: string; attachmentId: string }) => {
    const session = await deps.getSession(req);
    if (!session?.user?.id) return new Response('Unauthorized', { status: 401 });
    const meta = await deps.loadAuthorizedAttachment({
      userId: session.user.id,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
    });
    if (!meta) return new Response('Not Found', { status: 404 });
    if (meta.sizeBytes > MAX) return new Response('Payload Too Large', { status: 413 });
    const obj = await deps.getObjectBounded(meta.s3Key, MAX);
    if (!obj) return new Response('Not Found', { status: 404 });
    try {
      assertSafeInlineRaster(obj.body, meta.mimeType);
    } catch (e) {
      if (e instanceof InlineImageTooLargeError) return new Response('Payload Too Large', { status: 413 });
      return new Response('Unsupported Media Type', { status: 415 });
    }
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': meta.mimeType,
        'Content-Length': String(obj.body.length),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=300',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
```

`loadAuthorizedAttachment` SQL: join `attachment` → `message` → `mailbox_access` where `mailbox_access.userId = session.user.id` and IDs match. Mount in `main.ts` **before** `/api/trpc/*`:

```ts
app.get('/api/mail/messages/:messageId/attachments/:attachmentId/inline', async (c) => {
  const handler = createInlineAttachmentHandler({ /* wire real auth/db/s3 */ });
  return handler(c.req.raw, {
    messageId: c.req.param('messageId'),
    attachmentId: c.req.param('attachmentId'),
  });
});
```

- [ ] **Step 4: Pass tests**

Run: `pnpm --dir apps/server-pilot exec vitest run tests/inline-attachment-http.test.ts tests/attachment-access.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/http/inline-attachment.ts apps/server-pilot/src/main.ts apps/server-pilot/tests/inline-attachment-http.test.ts apps/server-pilot/tests/attachment-access.test.ts
git commit -m "feat(mail): serve authorized inline images"
```

---

### Task 3: Preserve remote URLs at storage + wire

**Files:**
- Modify: `apps/server-pilot/src/mail/sanitize-email-html.ts`
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
- Modify: `apps/server-pilot/tests/sanitize-email-html.test.ts`
- Modify: `apps/server-pilot/tests/ingest-html-sanitize.test.ts`
- Modify: `apps/server-pilot/tests/mail-html-sanitize.test.ts`

**Interfaces:**
- Consumes: existing `sanitizeEmailHtml`
- Produces: `sanitizeHtmlBodyForStorage` keeps remote img URLs; `toParsedMessage` does not placeholder remotes

- [ ] **Step 1: Write failing characterization then flip**

```ts
it('storage sanitize keeps remote https img src but strips script', () => {
  const html = sanitizeHtmlBodyForStorage(
    '<p><img src="https://branding.legacyhotels.co.za/x.gif"><script>alert(1)</script></p>',
  )!;
  expect(html).toContain('src="https://branding.legacyhotels.co.za/x.gif"');
  expect(html).not.toContain('<script');
});
```

- [ ] **Step 2: Run — expect FAIL** (today storage placeholders remotes)

- [ ] **Step 3: Minimal impl**

```ts
export function sanitizeHtmlBodyForStorage(html: string | null): string | null {
  if (html == null || html === '') return html;
  if (!html.includes('<')) return html;
  // XSS only — remote img URLs preserved; trust gate is processEmailContent.
  return sanitizeEmailHtml(html, { shouldLoadImages: true }).html;
}
```

In `wire-compat.ts` `toParsedMessage`, change to `shouldLoadImages: true` for the sanitize pass (same XSS strip via allowed tags; remotes kept). Document in comment: render trust gate lives in `processEmailContent`.

Keep `processEmailContent` calling `sanitizeEmailHtml(html, { shouldLoadImages: input.shouldLoadImages })` so untrusted remotes still become placeholders at render.

- [ ] **Step 4: Pass tests**

Run: `pnpm --dir apps/server-pilot exec vitest run tests/sanitize-email-html.test.ts tests/ingest-html-sanitize.test.ts tests/mail-html-sanitize.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/sanitize-email-html.ts apps/server-pilot/src/trpc/wire-compat.ts apps/server-pilot/tests/sanitize-email-html.test.ts apps/server-pilot/tests/ingest-html-sanitize.test.ts apps/server-pilot/tests/mail-html-sanitize.test.ts
git commit -m "fix(mail): preserve remote image URLs until render trust gate"
```

---

### Task 4: Trust helper + message-scoped processEmailContent + FE

**Files:**
- Create: `apps/server-pilot/src/mail/trust-sender.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/mail/components/mail/mail-content.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Test: `apps/server-pilot/tests/trust-sender.test.ts`
- Test: `apps/server-pilot/tests/process-email-content.test.ts`
- Modify: `apps/mail/tests/mail-content-fallback.test.ts`
- Modify: `apps/mail/tests/demo-backend-guards.test.ts`

**Interfaces:**
- Consumes: `projectCidImages`, `sanitizeEmailHtml`, `processQuotedContent`, `env.BETTER_AUTH_URL`, attachment rows
- Produces: `isImageTrustedSender({ senderEmail, externalImages, trustedSenders })`, `processEmailContent` requires `messageId`

- [ ] **Step 1: Failing trust + process tests**

```ts
// trust-sender.test.ts
import { describe, expect, it } from 'vitest';
import { isImageTrustedSender } from '../src/mail/trust-sender.js';

describe('isImageTrustedSender', () => {
  it('allows when externalImages true', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'x@evil.test',
        externalImages: true,
        trustedSenders: [],
      }),
    ).toBe(true);
  });

  it('matches exact email and domain entries', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'ops@partner.test',
        externalImages: false,
        trustedSenders: ['ops@partner.test'],
      }),
    ).toBe(true);
    expect(
      isImageTrustedSender({
        senderEmail: 'a@partner.test',
        externalImages: false,
        trustedSenders: ['partner.test'],
      }),
    ).toBe(true);
  });

  it('treats never-spam hotel domains as trusted', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'centurion@legacyhotels.co.za',
        externalImages: false,
        trustedSenders: [],
      }),
    ).toBe(true);
  });
});
```

```ts
// process-email-content.test.ts — authorize message, project cid
it('projects cid after sanitize when messageId in scope', async () => {
  // arrange DB message + attachment contentId; call procedure or extracted fn
  const result = await processEmailHtmlForDisplay({
    html: '<img src="cid:banner001@rocketseed">',
    messageId: 'msg-1',
    shouldLoadImages: false,
    theme: 'light',
    origin: 'https://nava.legacy.local',
    attachments: [
      {
        attachmentId: 'att-1',
        contentId: '<banner001@rocketseed>',
        mimeType: 'image/gif',
        sizeBytes: 10,
      },
    ],
  });
  expect(result.processedHtml).toContain('/attachments/att-1/inline');
  expect(result.processedHtml).not.toContain('cid:');
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`trust-sender.ts`:

```ts
import {
  AUTO_TRIAGE_NEVER_SPAM_DOMAINS,
  normalizeEmailAddress,
} from '../ai/never-spam.js';

export function isImageTrustedSender(input: {
  senderEmail: string;
  externalImages: boolean | undefined;
  trustedSenders: string[] | undefined;
}): boolean {
  if (input.externalImages) return true;
  const email = normalizeEmailAddress(input.senderEmail);
  const at = email.lastIndexOf('@');
  const domain = at === -1 ? '' : email.slice(at + 1);
  if (domain && AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(domain)) return true;
  for (const raw of input.trustedSenders ?? []) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === email) return true;
    const asDomain = entry.startsWith('@') ? entry.slice(1) : entry;
    if (asDomain === domain) return true;
  }
  return false;
}
```

Extract pure `processEmailHtmlForDisplay` used by the tRPC mutation:

```ts
export function processEmailHtmlForDisplay(input: {
  html: string;
  shouldLoadImages: boolean;
  theme: 'light' | 'dark';
  origin: string;
  attachments: CidAttachmentMeta[];
}): { processedHtml: string; hasBlockedImages: boolean } {
  const sanitized = sanitizeEmailHtml(input.html, {
    shouldLoadImages: input.shouldLoadImages,
  });
  const projected = projectCidImages(sanitized.html, input.attachments, {
    messageId: input.messageId, // add to input
    origin: input.origin,
  });
  const processedHtml = processQuotedContent(projected.html, input.theme);
  return {
    processedHtml,
    hasBlockedImages: sanitized.hasBlockedImages || projected.hasBlockedImages,
  };
}
```

Wire `mail.processEmailContent` to require `messageId`, `requireMessageForTransport`, query attachments once, parse origin from `env.BETTER_AUTH_URL`.

FE `mail-content.tsx`:

```ts
const isTrustedSender = useMemo(
  () =>
    isImageTrustedSender({
      senderEmail,
      externalImages: data?.settings?.externalImages,
      trustedSenders: data?.settings?.trustedSenders,
    }),
  [data?.settings, senderEmail],
);

// queryKey: ['email-content-v2', id, isTrustedSender || temporaryImagesEnabled, resolvedTheme]
// processEmailContent({ html, messageId: id, shouldLoadImages: ..., theme })
```

Duplicate the helper logic in FE **or** share via a tiny isomorphic copy under `apps/mail/lib/mail/trust-sender.ts` that hardcodes the same two hotel domains (avoid importing server never-spam into Vite). Prefer a 15-line FE twin with the same domain set constants to keep packages separate.

Img error handler: if `target.src` includes `/attachments/` and `/inline`, set `target.removeAttribute('src')` and return without `setCspViolation` when trusted.

Same `messageId` + `email-content-v2` in `use-threads.ts` prefetch.

- [ ] **Step 4: Pass tests**

Run:

```bash
pnpm --dir apps/server-pilot exec vitest run tests/trust-sender.test.ts tests/process-email-content.test.ts
pnpm --dir apps/mail exec vitest run tests/mail-content-fallback.test.ts tests/demo-backend-guards.test.ts
pnpm --dir apps/server-pilot build
```

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/trust-sender.ts apps/server-pilot/src/trpc/routes/mail.ts apps/mail/components/mail/mail-content.tsx apps/mail/hooks/use-threads.ts apps/mail/lib/mail/trust-sender.ts apps/server-pilot/tests/trust-sender.test.ts apps/server-pilot/tests/process-email-content.test.ts apps/mail/tests/mail-content-fallback.test.ts apps/mail/tests/demo-backend-guards.test.ts
git commit -m "feat(mail): message-scoped CID render and domain image trust"
```

---

### Task 5: Deploy gate + autonomous smoke (no human login)

**Files:**
- Create (optional): `apps/server-pilot/deploy/cid-inline-images-gate.sh` if SSM one-liner gets messy
- Create: `docs/superpowers/plans/handoff-reports/2026-07-30-cid-inline-images-trust.md`

- [ ] **Step 1: Push `EC2-pilot` and deploy**

```bash
# after Tasks 1–4 green + commits
apps/server-pilot/deploy/ops-deploy.sh
```

No `--migrate` unless a schema change slipped in (this plan expects none).

- [ ] **Step 2: SSM vitest gate**

Via `ssm-run-command.sh`, on EC2 repo:

```bash
cd /home/ubuntu/repos/zero
pnpm --dir apps/server-pilot exec vitest run \
  tests/cid-images.test.ts \
  tests/safe-inline-image.test.ts \
  tests/sanitize-email-html.test.ts \
  tests/inline-attachment-http.test.ts \
  tests/process-email-content.test.ts \
  tests/trust-sender.test.ts \
  tests/mail-html-sanitize.test.ts \
  tests/ingest-html-sanitize.test.ts
```

Expected: all PASS. Unicode-safe SSM wrapper required (see `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`).

- [ ] **Step 3: API proof (no browser)**

On EC2 or via SSM: call `processEmailContent` (or unit-equivalent with real message fixture) for a message that has `cid:` + matching `contentId` attachment.

Expected: `processedHtml` contains `/api/mail/messages/.../attachments/.../inline` and does not leave that img as raw `cid:`.

Unauthenticated `curl` to an inline URL → `401`.

- [ ] **Step 4: Health + PM2**

```bash
curl -fsS https://nava.legacy.local/health || curl -fsS http://127.0.0.1:8787/health
pm2 status
```

- [ ] **Step 5: Handoff report**

Write `docs/superpowers/plans/handoff-reports/2026-07-30-cid-inline-images-trust.md` with: commit SHAs, vitest output summary, deploy status, API proof snippet, residuals (historical burned remotes, CSS url()).

```bash
git add docs/superpowers/plans/handoff-reports/2026-07-30-cid-inline-images-trust.md
git commit -m "docs(mail): cid inline images overnight handoff"
```

Human visual of branded banner in SPA is **post-overnight optional** — not a gate.

---

## Self-Review

1. **Spec coverage:** R1–R6 / AE1–AE5 mapped to Tasks 1–4; live AE1 in Task 5.
2. **Placeholders:** none intentional; raster dimension helpers must be fully coded in Task 1 (copy rocketseed Task 5 rejects).
3. **Type consistency:** `CidAttachmentMeta`, `processEmailHtmlForDisplay`, `isImageTrustedSender`, cache `email-content-v2`, route path stable across tasks.

## Flagged extras (not in this plan)

- Historical DB rows with burned remote placeholders — optional MIME reparse follow-up.
- CSS `url()` remote tracking — known residual.
- Outlook “Enable JavaScript” — will not add (correct).
- Rocketseed outbound SMTP cutover — separate plan.
