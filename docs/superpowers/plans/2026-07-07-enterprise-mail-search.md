# Enterprise Mail Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Gmail-parity mail search on server-pilot with Postgres FTS, canonical operator grammar, honest FE capability gating. No AI/semantic v1.

**Architecture:** `parseSearchQuery(q)` → flat `ParsedSearchQuery` → `buildThreadSearchConditions` + FTS on `mail_thread.search_vector`. FE sends `q` + structured `filters.*`; no client-side mailbox filtering.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres tsvector/GIN, Vitest, tRPC, React Query, Playwright.

**Branch:** `EC2-pilot` (merge `feat/mail-search` first; post-merge test/fix on this branch only)

## Global Constraints

- No AI search, vector search, or `parseNaturalLanguageSearch` on live path when grammar enabled.
- **Canonical grammar only (Gmail operators).** Outlook spellings → `SearchParseError` → TRPC 400 + FE toast. No alias layer.
- Unsupported operator → TRPC 400 with `{ code, token, message }`; FE toast, no silent ILIKE.
- `q` max 512 chars on `listThreads` and `drafts.list`.
- Shared parser for threads + drafts.
- Body search v1: subject + snippet + message from/to addresses (not full HTML body).
- **No pre-merge gate.** Merge to `EC2-pilot` first; all validation + fixes happen on `EC2-pilot` after merge.

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
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, migrate, seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2, backfill script.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Done criteria

- [x] `feat/mail-search` merged into `EC2-pilot`
- [x] Local vitest green (parse/parity/input/date + FE contract)
- [x] `pnpm --filter @zero/server build` + `pnpm --filter @zero/mail build` green
- [ ] RDS migrations `0009` + `0010` applied on EC2
- [ ] `backfill-search-vector.ts` run on EC2 RDS
- [ ] DB-backed vitest green on EC2 via SSM
- [ ] `deploy-ec2.sh` green; `/health` 200
- [ ] Handoff report: `docs/superpowers/plans/handoff-reports/2026-07-08-mail-search-ec2-pilot.md`

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

## Post-merge integration wave (Tasks 8–12)

### Task 8: Merge + local reconcile — DONE (2026-07-08)

### Task 9: Push + EC2 sync

### Task 10: RDS migrate + backfill (`set -a` before `db:migrate`)

### Task 11: EC2 DB-backed vitest (`mail-search-query`, `mail-search-contract`, `mail-search-fts`)

### Task 12: Deploy + smoke + handoff

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

  it('rejects Outlook spellings', () => {
    expect(() => parseSearchQuery('read:no')).toThrow(SearchParseError);
    expect(() => parseSearchQuery('hasattachment:yes')).toThrow(SearchParseError);
  });

  it('accepts canonical operators', () => {
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
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
