# Enterprise Mail Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Gmail/Outlook-parity mail search on server-pilot with Postgres FTS, inline operator aliases, honest FE capability gating. No AI/semantic v1.

**Architecture:** `parseSearchQuery(q)` → flat `ParsedSearchQuery` → `buildThreadSearchConditions` + FTS on `mail_thread.search_vector`. FE sends `q` + structured `filters.*`; no client-side mailbox filtering.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres tsvector/GIN, Vitest, tRPC, React Query, Playwright.

**Worktree:** `feat/mail-search` at `~/.config/superpowers/worktrees/zero/feat-mail-search`

## Global Constraints

- No AI search, vector search, or `parseNaturalLanguageSearch` on live path when grammar enabled.
- Unsupported operator → TRPC 400 with `{ code, token, message }`; FE toast, no silent ILIKE.
- `q` max 512 chars on `listThreads` and `drafts.list`.
- Shared parser for threads + drafts.
- Inline aliases only: `read:no`=`is:unread`, `hasattachment:yes`=`has:attachment`, `category:` joins `mail_thread_category`.
- Body search v1: subject + snippet + message from/to addresses (not full HTML body).

---

### Task 1: ParsedSearchQuery types + parse unit tests

**Files:**
- Create: `apps/server-pilot/src/mail/search/types.ts`
- Create: `apps/server-pilot/src/mail/search/parse.ts`
- Create: `apps/server-pilot/tests/mail-search-parse.test.ts`

**Interfaces:**
- Produces: `ParsedSearchQuery`, `SearchParseError`, `parseSearchQuery(q: string): ParsedSearchQuery`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/mail/search/parse.js';
import { SearchParseError } from '../src/mail/search/types.js';

describe('parseSearchQuery', () => {
  it('parses from: operator', () => {
    expect(parseSearchQuery('from:alice@corp.com')).toMatchObject({
      from: ['alice@corp.com'],
      freeText: '',
    });
  });

  it('maps read:no to unread', () => {
    expect(parseSearchQuery('read:no')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
  });

  it('maps hasattachment:yes', () => {
    expect(parseSearchQuery('hasattachment:yes')).toMatchObject({ hasAttachment: true });
    expect(parseSearchQuery('has:attachment')).toMatchObject({ hasAttachment: true });
  });

  it('keeps bare text as freeText', () => {
    expect(parseSearchQuery('hotel invoice')).toMatchObject({ freeText: 'hotel invoice' });
  });

  it('throws on unsupported operator', () => {
    expect(() => parseSearchQuery('kind:email')).toThrow(SearchParseError);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd apps/server-pilot && pnpm exec vitest run tests/mail-search-parse.test.ts`
Expected: module not found / parseSearchQuery undefined

- [ ] **Step 3: Implement types + parse**

Implement `ParsedSearchQuery` Zod schema and regex token scanner. Quoted values supported. Multiple `from:` tokens accumulate. Unknown `word:value` where word is known-prefix list miss → `SearchParseError` with `.token`.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/search/types.ts apps/server-pilot/src/mail/search/parse.ts apps/server-pilot/tests/mail-search-parse.test.ts
git commit -m "feat(server-pilot): add mail search query parser skeleton"
```

---

### Task 2: FTS migration + search_vector column

**Files:**
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Create: drizzle migration under `apps/server-pilot/drizzle/`
- Create: `apps/server-pilot/scripts/backfill-search-vector.ts`

**Interfaces:**
- Consumes: none
- Produces: `mailThread.searchVector` column, GIN index `mail_thread_search_vector_idx`

- [ ] **Step 1:** Add `searchVector` tsvector column to `mail_thread` in schema.
- [ ] **Step 2:** Generate migration; add GIN index.
- [ ] **Step 3:** Backfill script: `UPDATE mail_thread SET search_vector = to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(snippet,''))`.
- [ ] **Step 4:** Run schema-contract tests.
- [ ] **Step 5: Commit** `feat(server-pilot): add mail_thread search_vector FTS column`

---

### Task 3: Ingest updates search_vector

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts`
- Test: `apps/server-pilot/tests/mail-search-fts.test.ts` (new)

- [ ] **Step 1:** Failing test — ingest message, assert thread `search_vector` matches subject/snippet/from.
- [ ] **Step 2:** Implement denorm helper called from ingest store after thread upsert.
- [ ] **Step 3:** Pass tests; commit.

---

### Task 4: buildThreadSearchConditions + DB integration tests

**Files:**
- Create: `apps/server-pilot/src/mail/search/query.ts`
- Create: `apps/server-pilot/tests/mail-search-query.test.ts`

**Interfaces:**
- Consumes: `ParsedSearchQuery`, `parseSearchQuery`
- Produces: `buildThreadSearchConditions(parsed, ctx): SQL[]`

- [ ] **Step 1:** Fixture tests per operator using `withSeededTestDb` (copy pattern from `mail-category-filter.test.ts`).
- [ ] **Step 2:** Implement conditions + FTS `@@ plainto_tsquery` for freeText.
- [ ] **Step 3:** Commit.

---

### Task 5: Wire listThreads + drafts + trust layer

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (remove ILIKE block ~293-298, add parser)
- Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Create: `apps/server-pilot/tests/mail-search-contract.test.ts`

- [ ] **Step 1:** Add `q: z.string().max(512).optional()` if missing.
- [ ] **Step 2:** Contract tests for full operator matrix.
- [ ] **Step 3:** Wire parser + query builder; map `SearchParseError` → TRPC BAD_REQUEST.
- [ ] **Step 4:** Commit.

---

### Task 6: FE capability + palette honesty

**Files:**
- Modify: `apps/mail/lib/pilot/capabilities.ts`
- Modify: `apps/mail/components/context/command-palette-context.tsx`
- Modify: `apps/mail/tests/search-filter-contract.test.ts`

- [ ] **Step 1:** Flip `gmailSearchGrammar: true` in capabilities + pilot package contract mirror.
- [ ] **Step 2:** On search TRPC error, toast unsupported operator.
- [ ] **Step 3:** Skip FE `parseNaturalLanguageSearch` when grammar on.
- [ ] **Step 4:** Commit.

---

### Task 7: E2E search-bar

**Files:**
- Modify: `packages/testing/e2e/search-bar.spec.ts`

- [ ] **Step 1:** Extend e2e to type query, assert thread visible in list.
- [ ] **Step 2:** Commit.
