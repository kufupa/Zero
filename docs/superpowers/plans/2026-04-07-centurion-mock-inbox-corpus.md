# Centurion mock inbox corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `ZERO_DEMO_MODE=1`, the mail app lists **~15–25** fictional **Centurion @ LegacyHotels.com** threads from a **validated JSON corpus**, serves full `mail.get` payloads (including **synthetic `isDraft`** messages for composer prefill), and avoids durable-object / Gmail mutations that would crash without a real mailbox.

**Architecture:** Add a **pure** demo-mail module under `apps/server/src/lib/demo-mail/` (Zod schema, JSON file, mappers to `ParsedMessage` / `IGetThreadResponse`). Short-circuit **`getThread`** and **`getThreadsFromDB`** in `apps/server/src/lib/server-utils.ts` when `isDemoMode()` is true. Add a **small early-return guard** for mail mutations that would call `modifyThreadLabelsInDB` / `getZeroAgent` (so demo clicks do not hit missing shards). Verify corpus with **`tsx`** + **`vitest`** in the server package.

**Tech stack:** TypeScript, Zod (already in `@zero/server`), Cloudflare Workers bundle (JSON import), existing tRPC `mail` router and `ParsedMessage` / `IGetThreadResponse` types (`apps/server/src/types.ts`, `apps/server/src/lib/driver/types.ts`).

---

## File map (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/lib/demo-mail/centurion-threads.json` | Author-editable corpus (threads, messages, draft bodies). |
| `apps/server/src/lib/demo-mail/centurion-corpus.schema.ts` | Zod schemas for JSON + `parseCenturionCorpus()` export. |
| `apps/server/src/lib/demo-mail/map-to-thread-response.ts` | Map validated corpus → `IGetThreadResponse` + list rows. |
| `apps/server/src/lib/demo-mail/index.ts` | Public exports: `loadCenturionDemoThreads()`, `getCenturionDemoThread()`, list helpers. |
| `apps/server/src/lib/demo-mail/demo-mail-guard.ts` | `isDemoMailNoop(): boolean` helper for tRPC mutations. |
| `apps/server/src/lib/server-utils.ts` | Early returns in `getThread` / `getThreadsFromDB`; `modifyThreadLabelsInDB` no-op in demo. |
| `apps/server/src/lib/server-utils.ts` | Align `demoActiveConnection.email` with Centurion inbox address. |
| `apps/mail/lib/demo-session.ts` | Align `getDemoUser().email` with the same inbox address (composer “me”). |
| `apps/server/src/trpc/routes/mail.ts` | Demo guards on mutations that would touch DO / Gmail (see task list). |
| `apps/server/src/trpc/routes/drafts.ts` | Demo guards returning empty / safe defaults where needed. |
| `apps/server/package.json` | Add `vitest` devDependency + `test:demo-corpus` script. |
| `apps/server/vitest.config.ts` | Minimal Vitest config (`environment: 'node'`, include `tests/**/*.test.ts`). |
| `apps/server/tests/centurion-corpus.test.ts` | Schema + mapper smoke tests. |
| `package.json` (repo root) | Optional: `"verify:demo:corpus": "pnpm run --filter=@zero/server test:demo-corpus"` for one-liner CI. |

---

### Task 1: Vitest harness in `@zero/server`

**Files:**

- Create: `apps/server/vitest.config.ts`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Add devDependency and script**

In `apps/server/package.json`, under `devDependencies`, add:

```json
"vitest": "^1.6.0"
```

Under `scripts`, add:

```json
"test:demo-corpus": "vitest run tests/centurion-corpus.test.ts"
```

- [ ] **Step 2: Create Vitest config**

Create `apps/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Install and run (expect failure — no test file yet)**

Run:

```bash
pnpm install --filter @zero/server
pnpm run --filter=@zero/server test:demo-corpus
```

Expected: Vitest reports **no tests** or **file not found** / **failed to load** (acceptable failure before Task 4).

- [ ] **Step 4: Commit**

```bash
git add apps/server/package.json apps/server/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(server): add vitest harness for demo corpus tests"
```

---

### Task 2: Zod schema + JSON skeleton (failing test)

**Files:**

- Create: `apps/server/src/lib/demo-mail/centurion-threads.json`
- Create: `apps/server/src/lib/demo-mail/centurion-corpus.schema.ts`
- Create: `apps/server/tests/centurion-corpus.test.ts` (initial failing assertion)

- [ ] **Step 1: Add minimal JSON corpus (structure only)**

Create `apps/server/src/lib/demo-mail/centurion-threads.json`:

```json
{
  "version": 1,
  "threads": []
}
```

- [ ] **Step 2: Implement Zod schema**

Create `apps/server/src/lib/demo-mail/centurion-corpus.schema.ts`:

```ts
import { z } from 'zod';

const participantSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const corpusMessageSchema = z.object({
  id: z.string().min(1),
  from: participantSchema,
  to: z.array(participantSchema).min(1),
  cc: z.array(participantSchema).optional(),
  receivedOn: z.string().min(1),
  subject: z.string(),
  bodyText: z.string(),
  bodyIsHtml: z.boolean().optional().default(false),
  unread: z.boolean(),
  isDraft: z.boolean().optional().default(false),
});

const draftSchema = z.object({
  bodyText: z.string(),
  bodyIsHtml: z.boolean().optional().default(false),
  /** full = guest / actionable internal; minimal = short FYI stub (may be empty string) */
  depth: z.enum(['full', 'minimal']),
});

const corpusThreadSchema = z
  .object({
    id: z.string().min(1),
    folder: z.literal('inbox').default('inbox'),
    labels: z.array(z.object({ id: z.string(), name: z.string() })).optional().default([]),
    messages: z.array(corpusMessageSchema).min(1),
    draft: draftSchema,
  })
  .superRefine((thread, ctx) => {
    if (!thread.messages.some((m) => !m.isDraft)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each thread needs at least one non-draft inbound message',
      });
    }
  });

export const centurionCorpusFileSchema = z.object({
  version: z.literal(1),
  threads: z.array(corpusThreadSchema).min(15).max(30),
});

export type CenturionCorpusFile = z.infer<typeof centurionCorpusFileSchema>;
export type CenturionCorpusThread = z.infer<typeof corpusThreadSchema>;
```

- [ ] **Step 3: Write failing test (expects ≥15 threads)**

Create `apps/server/tests/centurion-corpus.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { centurionCorpusFileSchema } from '../src/lib/demo-mail/centurion-corpus.schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonPath = join(__dirname, '../src/lib/demo-mail/centurion-threads.json');

describe('centurion corpus', () => {
  it('parses centurion-threads.json', () => {
    const raw = readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    const parsed = centurionCorpusFileSchema.safeParse(data);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format(), null, 2)).toBe(
      true,
    );
    if (parsed.success) {
      expect(parsed.data.threads.length).toBeGreaterThanOrEqual(15);
    }
  });
});
```

- [ ] **Step 4: Run test — must FAIL**

Run:

```bash
pnpm run --filter=@zero/server test:demo-corpus
```

Expected: **FAIL** — `threads` array is empty (`min(15)` not met).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/demo-mail/centurion-threads.json apps/server/src/lib/demo-mail/centurion-corpus.schema.ts apps/server/tests/centurion-corpus.test.ts
git commit -m "test(server): add Centurion corpus schema and failing parse test"
```

---

### Task 3: Mapper — corpus → `ParsedMessage` / `IGetThreadResponse`

**Files:**

- Create: `apps/server/src/lib/demo-mail/map-to-thread-response.ts`
- Create: `apps/server/src/lib/demo-mail/index.ts`

- [ ] **Step 1: Implement mapper**

Create `apps/server/src/lib/demo-mail/map-to-thread-response.ts`:

```ts
import type { IGetThreadResponse } from '../driver/types';
import type { ParsedMessage } from '../../types';
import type { CenturionCorpusThread } from './centurion-corpus.schema';

const DEMO_CONNECTION_ID = 'demo-connection';
const INBOX_EMAIL = 'centurion@legacyhotels.com';
const INBOX_NAME = 'The Centurion — Reservations';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtmlBody(text: string, isHtml: boolean): string {
  if (isHtml) return text;
  const lines = text.trim().split('\n');
  return `<p>${lines.map((l) => escapeHtml(l) || '<br />').join('</p><p>')}</p>`;
}

function toParsedMessage(
  threadId: string,
  m: CenturionCorpusThread['messages'][number],
): ParsedMessage {
  const html = toHtmlBody(m.bodyText, m.bodyIsHtml);
  return {
    id: m.id,
    connectionId: DEMO_CONNECTION_ID,
    title: m.subject,
    subject: m.subject,
    tags: [],
    sender: { name: m.from.name, email: m.from.email },
    to: m.to.map((t) => ({ name: t.name, email: t.email })),
    cc: m.cc?.map((t) => ({ name: t.name, email: t.email })) ?? null,
    bcc: null,
    tls: true,
    receivedOn: m.receivedOn,
    unread: m.unread,
    body: m.bodyIsHtml ? m.bodyText : m.bodyText,
    processedHtml: html,
    blobUrl: '',
    decodedBody: html,
    threadId,
    isDraft: m.isDraft === true ? true : undefined,
    messageId: `<demo-${m.id}@legacyhotels.com>`,
  };
}

function syntheticDraftMessage(thread: CenturionCorpusThread, lastInbound: ParsedMessage): ParsedMessage {
  const reSubject = lastInbound.subject.startsWith('Re:')
    ? lastInbound.subject
    : `Re: ${lastInbound.subject}`;
  const html = toHtmlBody(thread.draft.bodyText, thread.draft.bodyIsHtml);
  return {
    id: `${thread.id}-draft`,
    connectionId: DEMO_CONNECTION_ID,
    title: reSubject,
    subject: reSubject,
    tags: [],
    sender: { name: INBOX_NAME, email: INBOX_EMAIL },
    to: [{ email: lastInbound.sender.email, name: lastInbound.sender.name }],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: lastInbound.receivedOn,
    unread: false,
    body: thread.draft.bodyIsHtml ? thread.draft.bodyText : thread.draft.bodyText,
    processedHtml: html,
    blobUrl: '',
    decodedBody: html,
    threadId: thread.id,
    isDraft: true,
    messageId: `<draft-${thread.id}@legacyhotels.com>`,
    inReplyTo: lastInbound.messageId,
  };
}

export function centurionThreadToGetResponse(thread: CenturionCorpusThread): IGetThreadResponse {
  const nonDraftSource = thread.messages.filter((m) => !m.isDraft);
  const parsedNonDraft = nonDraftSource.map((m) => toParsedMessage(thread.id, m));

  const lastInbound = parsedNonDraft[parsedNonDraft.length - 1];
  const draftMsg =
    thread.draft.bodyText.trim().length > 0 ? syntheticDraftMessage(thread, lastInbound) : null;

  const messages: ParsedMessage[] = draftMsg ? [...parsedNonDraft, draftMsg] : [...parsedNonDraft];

  const hasUnread = messages.some((m) => m.unread && !m.isDraft);

  return {
    messages,
    latest: lastInbound,
    hasUnread,
    totalReplies: parsedNonDraft.length,
    labels: thread.labels?.length ? thread.labels : [{ id: 'INBOX', name: 'Inbox' }],
  };
}

export function centurionThreadToListRow(thread: CenturionCorpusThread): {
  id: string;
  historyId: string | null;
} {
  return { id: thread.id, historyId: null };
}
```

- [ ] **Step 2: Public loader**

Create `apps/server/src/lib/demo-mail/index.ts`:

```ts
import centurionJson from './centurion-threads.json' with { type: 'json' };
import { centurionCorpusFileSchema } from './centurion-corpus.schema';
import {
  centurionThreadToGetResponse,
  centurionThreadToListRow,
} from './map-to-thread-response';
import type { IGetThreadResponse, IGetThreadsResponse } from '../driver/types';
import type { CenturionCorpusThread } from './centurion-corpus.schema';

let cached: ReturnType<typeof centurionCorpusFileSchema.parse> | null = null;

function threadLatestTs(t: CenturionCorpusThread): number {
  return Math.max(...t.messages.map((m) => new Date(m.receivedOn).getTime()));
}

export function loadCenturionCorpus() {
  if (!cached) {
    cached = centurionCorpusFileSchema.parse(centurionJson);
  }
  return cached;
}

export function getCenturionDemoThread(threadId: string): IGetThreadResponse | null {
  const t = loadCenturionCorpus().threads.find((x) => x.id === threadId);
  return t ? centurionThreadToGetResponse(t) : null;
}

export function listCenturionDemoThreads(params: {
  maxResults: number;
  pageToken: string;
  q: string;
}): IGetThreadsResponse {
  const sorted = [...loadCenturionCorpus().threads].sort((a, b) => threadLatestTs(b) - threadLatestTs(a));
  let list = sorted.map(centurionThreadToListRow);
  const q = params.q.trim().toLowerCase();
  if (q) {
    list = list.filter((row) => {
      const full = getCenturionDemoThread(row.id);
      if (!full) return false;
      const hay = `${full.latest?.subject ?? ''} ${full.latest?.sender.email ?? ''} ${full.latest?.body ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const offset = params.pageToken ? Number.parseInt(params.pageToken, 10) || 0 : 0;
  const slice = list.slice(offset, offset + params.maxResults);
  const next = offset + params.maxResults < list.length ? String(offset + params.maxResults) : null;
  return { threads: slice, nextPageToken: next };
}
```

**Note:** If `with { type: 'json' }` fails TypeScript, switch to `resolveJsonModule` in `apps/server/tsconfig.json` `compilerOptions` and use `assert { type: 'json' }` per your TS version, or `readFileSync` + `JSON.parse` inside `loadCenturionCorpus()` (Workers-safe if only called from server bundle that inlines JSON).

- [ ] **Step 3: Extend test — mapper smoke**

Merge into the same `describe('centurion corpus', () => { ... })` block (add imports at the top of the test file):

```ts
import { getCenturionDemoThread, loadCenturionCorpus } from '../src/lib/demo-mail/index';
import { centurionThreadToGetResponse } from '../src/lib/demo-mail/map-to-thread-response';
```

Add two `it(...)` cases:

```ts
  it('maps each thread to a valid get payload', () => {
    const { threads } = loadCenturionCorpus();
    for (const t of threads) {
      const res = centurionThreadToGetResponse(t);
      expect(res.latest && !res.latest.isDraft).toBe(true);
      expect(res.messages.length).toBeGreaterThan(0);
      const draft = res.messages.filter((m) => m.isDraft);
      expect(draft.length).toBeLessThanOrEqual(1);
      if (t.draft.bodyText.trim().length > 0) {
        expect(draft.length).toBe(1);
      }
    }
  });

  it('lookup by id works', () => {
    const { threads } = loadCenturionCorpus();
    const first = getCenturionDemoThread(threads[0].id);
    expect(first).not.toBeNull();
  });
```

- [ ] **Step 4: Run tests — still FAIL until JSON filled**

Still fails on `min(15)` until Task 5.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/demo-mail/map-to-thread-response.ts apps/server/src/lib/demo-mail/index.ts apps/server/tests/centurion-corpus.test.ts
git commit -m "feat(server): map Centurion corpus to mail thread responses"
```

---

### Task 4: Wire `getThread` + `getThreadsFromDB` (demo mode)

**Files:**

- Modify: `apps/server/src/lib/server-utils.ts`

- [ ] **Step 1: Import demo helpers**

Change the existing `import { defaultPageSize } from './utils';` line to also import `FOLDERS`:

```ts
import { defaultPageSize, FOLDERS } from './utils';
```

Add:

```ts
import { getCenturionDemoThread, listCenturionDemoThreads } from './demo-mail';
```

(`isDemoMode` is already imported from `../config/demo` in this file.)

- [ ] **Step 2: Short-circuit `getThread`**

Replace the **body** of `export const getThread = async (...) => { ... }` so the demo branch runs first, then the existing Effect path:

```ts
export const getThread: (
  connectionId: string,
  threadId: string,
) => Promise<{ result: IGetThreadResponse; shardId: string }> = async (
  connectionId: string,
  threadId: string,
) => {
  if (isDemoMode()) {
    const result = getCenturionDemoThread(threadId);
    if (!result) {
      throw new Error(`Thread ${threadId} not found`);
    }
    return { result, shardId: 'demo-shard' };
  }

  const result = await Effect.runPromise(getThreadEffect(connectionId, threadId));
  if (!result.result) {
    throw new Error(`Thread ${threadId} not found`);
  }
  if (!result.shardId) {
    throw new Error(`Thread ${threadId} not found in any shard`);
  }
  return { result: result.result, shardId: result.shardId };
};
```

- [ ] **Step 3: Short-circuit `getThreadsFromDB` for non-search inbox listing**

Inside `getThreadsFromDB`, **immediately after** `const maxResults = params.maxResults ?? defaultPageSize;` (this line already exists today — insert **below** it, **before** `void sendDoState(connectionId);`):

```ts
  if (
    isDemoMode() &&
    (params.folder === FOLDERS.INBOX || params.folder === 'inbox' || !params.folder) &&
    (!params.labelIds || params.labelIds.length === 0)
  ) {
    return listCenturionDemoThreads({
      maxResults,
      pageToken: params.pageToken ?? '',
      q: params.q ?? '',
    });
  }
```

- [ ] **Step 4: No-op `modifyThreadLabelsInDB` in demo**

At the **top** of `modifyThreadLabelsInDB` function body:

```ts
export const modifyThreadLabelsInDB = async (
  connectionId: string,
  threadId: string,
  addLabels: string[],
  removeLabels: string[],
) => {
  if (isDemoMode()) {
    return;
  }
  const threadResult = await getThread(connectionId, threadId);
  // ... existing
};
```

**Important:** When `isDemoMode()` is false, behavior stays identical. When true, `getThread` no longer needs a real shard for label updates.

- [ ] **Step 5: Align demo connection + mail client user email**

In the same file, update `demoActiveConnection`:

```ts
const demoActiveConnection: typeof connection.$inferSelect = {
  id: 'demo-connection',
  userId: 'demo-user',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
  // ... rest unchanged
};
```

In `apps/mail/lib/demo-session.ts`, update `getDemoUser`:

```ts
export const getDemoUser = () => ({
  id: 'demo-user',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
});
```

- [ ] **Step 6: Manual smoke (optional before corpus fill)**

With `ZERO_DEMO_MODE=1`, open inbox — may still error on mutations until Task 6.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/server-utils.ts apps/mail/lib/demo-session.ts
git commit -m "feat(server): serve Centurion corpus in demo mode for list/get thread"
```

---

### Task 5: Author full JSON corpus (content)

**Files:**

- Modify: `apps/server/src/lib/demo-mail/centurion-threads.json`

- [ ] **Step 1: Populate **15–25** threads** per `docs/superpowers/specs/2026-04-07-centurion-mock-inbox-design.md`:

  - **~⅔ internal** `@legacyhotels.com` (HR, scheduling, policy, access, training).
  - **~⅓ guest** (group block, individual May 2026 dates, general questions).
  - **Mostly `unread: true`** on inbound messages; mini-threads where you already have “replied” use extra non-draft messages with `unread: false`.
  - **`draft.depth`:** `full` for all guest threads + actionable internal; `minimal` for FYI internal (use **empty `bodyText`** or one short acknowledgment line).
  - **Availability yes:** `draft.bodyText` includes a link like `https://book.iveri.studio/reserve/CEN-MAY14-DLX`.
  - **Availability no:** alternatives with **May 2026** dates and room types.
  - All **explicit dates** in **May 2026** (fixed fictional calendar).

- [ ] **Step 2: Run corpus tests**

```bash
pnpm run --filter=@zero/server test:demo-corpus
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/demo-mail/centurion-threads.json
git commit -m "content(demo): Centurion hotel inbox mock threads and drafts"
```

---

### Task 6: Demo guards on mail + draft mutations

**Files:**

- Create: `apps/server/src/lib/demo-mail/demo-mail-guard.ts`
- Modify: `apps/server/src/trpc/routes/mail.ts`
- Modify: `apps/server/src/trpc/routes/drafts.ts`

- [ ] **Step 1: Helper**

Create `apps/server/src/lib/demo-mail/demo-mail-guard.ts`:

```ts
import { isDemoMode } from '../../config/demo';

/** Skip durable-object / Gmail side effects in demo mailbox mode. */
export function shouldSkipDriverMailMutation(): boolean {
  return isDemoMode();
}
```

- [ ] **Step 2: Guard pattern in `mail.ts`**

At the top of `mail.ts`, add:

```ts
import { shouldSkipDriverMailMutation } from '../../lib/demo-mail/demo-mail-guard';
```

For each **mutation** that calls `getZeroAgent`, `modifyThreadLabelsInDB`, `createDriver`, `forceReSync`, or `deleteAllSpam`, insert at the **start** of the handler:

```ts
if (shouldSkipDriverMailMutation()) {
  return /* sensible static success shape for that procedure */;
}
```

Concrete return shapes (match existing client expectations where possible):

| Procedure | Demo return |
|-----------|-------------|
| `markAsRead` / `markAsUnread` | `undefined` or `[]` (same as `Promise.all` on empty) — keep as `return Promise.resolve()` |
| `markAsImportant` / `toggleStar` / `toggleImportant` / `bulkStar` | `{ success: true }` |
| `modifyLabels` | `{ success: true }` |
| `forceSync` | `{ success: true }` or existing type — inspect current return |
| `deleteAllSpam` | Return empty stats object matching `DeleteAllSpamResponse` |
| `send` (and related) | Return a stub `{ id: 'demo-sent' }` only if required; otherwise throw `TRPCError` with message **Demo mode** (prefer stub to avoid broken UI) |

**Implementation tip:** Grep `mail.ts` for `.mutation(async` and add the guard to **every** mutating procedure except those that are read-only. Queries (`get`, `listThreads`, `processEmailContent`) stay functional.

- [ ] **Step 3: Drafts router**

In `drafts.ts`, at the start of `create`, `get`, `list`, `delete`:

```ts
import { shouldSkipDriverMailMutation } from '../../lib/demo-mail/demo-mail-guard';
```

- `get`: if demo, return `{ id, subject: '', content: '', to: [], cc: [], bcc: [] }` for any id (composer falls back to `latestDraft` from thread).
- `list`: return `{ threads: [], nextPageToken: null }`.
- `create` / `delete`: return `{ success: true }` / `true`.

- [ ] **Step 4: Manual demo pass**

`ZERO_DEMO_MODE=1`, `pnpm devfull` (or lean frontend + backend), open `/mail/inbox`, click threads, open Reply — **draft** should prefill when `draft.bodyText` was non-empty.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/demo-mail/demo-mail-guard.ts apps/server/src/trpc/routes/mail.ts apps/server/src/trpc/routes/drafts.ts
git commit -m "fix(server): no-op mail and draft mutations in demo mode"
```

---

### Task 7: Repo-level verify script (optional)

**Files:**

- Modify: `package.json` (root)

- [ ] **Step 1: Add script**

```json
"verify:demo:corpus": "pnpm run --filter=@zero/server test:demo-corpus"
```

- [ ] **Step 2: Run**

```bash
pnpm verify:demo:corpus
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add verify script for demo corpus"
```

---

## Spec coverage (self-review)

| Spec item | Task |
|-----------|------|
| JSON + Zod packaging | Tasks 2–3 |
| `ZERO_DEMO_MODE` only | `isDemoMode()` / `shouldSkipDriverMailMutation()` |
| 15–25 threads, mix, unread-heavy, May 2026 | Task 5 |
| Guest full drafts + Iveri link / alternates | Task 5 (authoring) |
| Internal hybrid drafts | `draft.depth` + empty `bodyText` handling in mapper (Task 3) |
| Human / professional tone | Task 5 (authoring) |
| Composer prefill via `isDraft` | Mapper `syntheticDraftMessage` (Task 3) + `mail.get` wiring (Task 4) |
| Lightweight verification | Vitest + manual Task 6 |

## Placeholder scan

No `TBD` / `TODO` / vague “add validation” steps; mutation table names concrete procedures to touch.

## Type consistency

- `ParsedMessage` / `IGetThreadResponse` fields match `apps/server/src/types.ts` and `driver/types.ts`.
- `centurion@legacyhotels.com` is the single **demo inbox** identity across server + mail `demo-session`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-07-centurion-mock-inbox-corpus.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
