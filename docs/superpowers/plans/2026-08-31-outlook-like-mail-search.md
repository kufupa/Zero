# Outlook-like mail search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare search finds sender domain labels and HTML-only bodies the way Outlook Instant Search finds people and message words, using one Postgres FTS path.

**Architecture:** Normalize `mail_thread.search_vector` source (split `@.` so `info@acmehotels.test` yields `acmehotels`; strip style/script/tags then `left(8000)` HTML when `text_body` empty). Index subject, snippet, From over the same 20-message window, and recent bodies — not To. Replace `plainto_tsquery` with sanitized quoted prefix `to_tsquery` (`'token':*`, min length 3) from `buildFreeTextTsQuery` in `query.ts`. Bound param only, never `sql.raw`. Debounce the header box 300ms into `listThreads` without writing recents until Enter. List queries keep prior rows via `placeholderData`. Historic rows need the existing SSM backfill after land.

**Tech Stack:** TypeScript, Drizzle SQL fragments, Postgres `simple` FTS + existing GIN, Vitest, React Testing Library fake timers.

**Origin:** `docs/plans/2026-08-31-001-feat-outlook-like-mail-search-plan.md` (ce-plan). Diagnosis 2026-08-31: 38 visible From-ILIKE threads for a live brand, 0 FTS hits; email lexeme is the whole address; those messages are HTML-only.

## Global Constraints

- Never Vitest (or any test runner) against `nava-zero-mail-pilot`. Never `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production` into tests.
- Before local Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- DB tests: `TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1`, hostname must not contain `nava-zero-mail-pilot`. Missing disposable DB is a safety blocker, not permission to use pilot.
- No new Postgres extension (`pg_trgm` is absent). No new column. Expression + existing GIN only.
- No dual free-text ILIKE+FTS on threads. No Outlook operator alias layer. No AI/semantic search. No `ts_rank` (keeps latest-message keyset).
- Extra-character typos (`nextct` vs `nexct`) stay out of scope.
- Logs and SSM stdout: totals only. No subjects, bodies, addresses, or `DATABASE_URL`.
- Unrelated dirty files (`apps/mail/components/ui/nav-user.tsx`, deploy script noise) stay unstaged.
- Pilot backfill uses `docs/solutions/workflow-issues/outlook-search-fts-backfill-pilot-deploy.md` (SSM, not Vitest).

## Review disposition

- **gstack-plan-eng-review:** Applied P1: quoted `'token':*` (so `and`/`or`/`not` cannot 500); min prefix length **3** (no `co:*` TLD flood); HTML strip style/script/tags **then** 8k; `nullif` empty `text_body`; From over 20-message window not LIMIT 1; `sql\`false\`` not omit; bound `to_tsquery`; AE1+AE2 via `listThreads`; HTML-only cap tests; live skip unknown `kind:` (Enter still 400); ILIKE ⊆ FTS count-only proof; no-DB tokenizer file in the gate; `threadSearchVectorText` is not the oracle. Rejected: indexing To (ponytail).
- **ponytail-review:** Applied: no To in the vector (inbox To is the hotel mailbox); punct class `[@.]+` only; `buildFreeTextTsQuery` lives in `query.ts` (one caller, no new impl file); no `use-search-value` edits; no extra Playwright timing. Kept prior cuts: no operator aliases, people API, pg_trgm, dual ILIKE+FTS, ranking, AI. Design later added list `placeholderData` + miss hint as Task 4 (headline unchanged).
- **gstack-plan-design-review:** Applied P1: invert Enter-only test; live write `value`+`highlight`; Enter flushes; Clear/resetVersion beats debounce; live skip short tokens; `placeholderData` on list queries (no full-list spinner); over-limit live silent; dummy From gone + nonempty input no listbox; skip equal writes; IME skip; no extra Playwright. P2 same-branch: muted miss hint, settle `aria-live`, `min-h-11` on Clear/Try All/Retry. Reuse bar chrome.
- **Conflict (ponytail vs eng To):** Eng asked From+To over 20 messages. Ponytail: inbox To is the hotel mailbox. Resolution: **do not index To**. Aggregate **From** over the same 20-message window (not LIMIT 1 inbound). `to:` stays the operator.
- **Conflict (min token 2 vs 3):** Design live-gated at length ≥ 2. Eng: `co:*` floods GIN. Resolution: FTS and live gate both require some `[A-Za-z0-9]+` token length ≥ **3** (`nex` still prefixes `nexct`). Enter on `co` still commits (honest empty).
- **Conflict (ponytail vs design copy):** Ponytail cut mail-list copy. Design P2 needs one muted miss hint + 44px empty actions + live region. Resolution: keep e2e headline; add muted hint + a11y on `mail-list.tsx` (completeness). No new chrome, no did-you-mean.
- **Conflict (grammar vs matching):** 2026-07-08 `plainto_tsquery` + reject Outlook spellings vs staff need to find brands. Resolution: keep Gmail operators; change free-text matching + live apply only.

## File map

| Path | Role |
|------|------|
| `apps/server-pilot/src/mail/search/query.ts` | Modify — quoted `buildFreeTextTsQuery` + bound `to_tsquery` + match-nothing |
| `apps/server-pilot/src/mail/search/search-vector.ts` | Modify — strip-then-8k HTML; `[@.]+`; From over 20 msgs, not To |
| `apps/server-pilot/tests/mail-search-free-text-tsquery.test.ts` | Create — always-run tokenizer (no DB) |
| `apps/server-pilot/deploy/mail-search-gate.sh` | Modify — add tokenizer file |
| `apps/server-pilot/tests/mail-search-query.test.ts` | Modify — domain + HTML-only + HTML cap DB cases |
| `apps/server-pilot/tests/mail-search-contract.test.ts` | Modify — listThreads AE1 + AE2 (all + trash/spam) |
| `apps/mail/lib/mail/search-list.ts` | Modify — `shouldLiveApplySearch` |
| `apps/mail/tests/search-list.test.ts` | Modify — live-apply gate |
| `apps/mail/components/mail/mail-search-bar.tsx` | Modify — debounce apply; recents only on commit; drop dummy From; IME; ArrowDown |
| `apps/mail/tests/mail-search-bar.test.tsx` | Modify — invert Enter-only; recents; live gates |
| `apps/mail/hooks/use-threads.ts` | Modify — `placeholderData` on live+demo list queries |
| `apps/mail/tests/use-threads-content-query-ownership.test.ts` | Modify — assert list `placeholderData` |
| `apps/mail/components/mail/mail-list.tsx` | Modify — `aria-busy`, settle live region, muted miss hint, `min-h-11` empty/error actions |
| `apps/mail/tests/demo-mail-list-perf-guards.test.ts` | Modify — miss hint; empty vs miss; `min-h-11` |
| `apps/server-pilot/scripts/backfill-search-vector.ts` | Unchanged — already uses `threadSearchVectorSourceSql` |

---

### Task 1: Prefix tsquery builder

**Files:**
- Modify: `apps/server-pilot/src/mail/search/query.ts`
- Create: `apps/server-pilot/tests/mail-search-free-text-tsquery.test.ts`
- Modify: `apps/server-pilot/deploy/mail-search-gate.sh` (add the new test file to the vitest list)

**Interfaces:**
- Consumes: raw `parsed.freeText` string
- Produces: `export function buildFreeTextTsQuery(freeText: string): string | null` in `query.ts` (same module as the one caller). `null` when no token has length ≥ 3; otherwise `'token1':* & 'token2':*` — tokens `[a-z0-9]+` lowercased, **single-quoted lexemes**, order preserved, duplicates kept. Never unquoted (`and:*` is a Postgres operator). Do not create `src/mail/search/free-text-tsquery.ts`.

- [ ] **Step 1: Write failing tests**

Create `apps/server-pilot/tests/mail-search-free-text-tsquery.test.ts` (no DB, no `skipIf`):

```typescript
import { describe, expect, it } from 'vitest';
import { buildFreeTextTsQuery } from '../src/mail/search/query.js';

describe('buildFreeTextTsQuery', () => {
  it('builds quoted prefix conjuncts from words and email punctuation', () => {
    expect(buildFreeTextTsQuery('AcmeHotels')).toBe("'acmehotels':*");
    expect(buildFreeTextTsQuery('info@acmehotels.test')).toBe(
      "'info':* & 'acmehotels':* & 'test':*",
    );
    expect(buildFreeTextTsQuery('acme hotels')).toBe("'acme':* & 'hotels':*");
    expect(buildFreeTextTsQuery('nex')).toBe("'nex':*");
    expect(buildFreeTextTsQuery('info@nexct.co')).toBe("'info':* & 'nexct':*");
  });

  it('returns null for empty, punctuation-only, or tokens shorter than 3', () => {
    expect(buildFreeTextTsQuery('')).toBeNull();
    expect(buildFreeTextTsQuery('   ')).toBeNull();
    expect(buildFreeTextTsQuery('!!!')).toBeNull();
    expect(buildFreeTextTsQuery('a')).toBeNull();
    expect(buildFreeTextTsQuery('co')).toBeNull();
    expect(buildFreeTextTsQuery('a b')).toBeNull();
    expect(buildFreeTextTsQuery('uk za')).toBeNull();
  });

  it('drops short tokens but keeps longer ones', () => {
    expect(buildFreeTextTsQuery('a acme')).toBe("'acme':*");
    expect(buildFreeTextTsQuery('co nexct')).toBe("'nexct':*");
  });

  it('quotes lexemes so and/or/not and user punctuation cannot break to_tsquery', () => {
    expect(buildFreeTextTsQuery('and or not')).toBe("'and':* & 'or':* & 'not':*");
    expect(buildFreeTextTsQuery('foo & bar | baz')).toBe("'foo':* & 'bar':* & 'baz':*");
    expect(buildFreeTextTsQuery('foo:*')).toBe("'foo':*");
    expect(buildFreeTextTsQuery('foo:(bar)')).toBe("'foo':* & 'bar':*");
  });
});
```

Add `tests/mail-search-free-text-tsquery.test.ts` to the `pnpm exec vitest run` list in `apps/server-pilot/deploy/mail-search-gate.sh` (before or after parse tests).

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/mail-search-free-text-tsquery.test.ts
```

Expected: FAIL — `buildFreeTextTsQuery` is not exported.

- [ ] **Step 3: Implement**

Add to `apps/server-pilot/src/mail/search/query.ts` (near the top, after imports):

```typescript
const TOKEN_RE = /[a-z0-9]+/gi;
const MIN_TOKEN_LENGTH = 3;

/** Safe prefix tsquery for mail_thread.search_vector (simple config). Quoted lexemes only. */
export function buildFreeTextTsQuery(freeText: string): string | null {
  const tokens: string[] = [];
  for (const match of freeText.toLowerCase().matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length >= MIN_TOKEN_LENGTH) tokens.push(token);
  }
  if (tokens.length === 0) return null;
  return tokens.map((token) => `'${token}':*`).join(' & ');
}
```

Tokens are `[a-z0-9]+` so quotes cannot inject. Do not change `buildThreadSearchConditions` yet.

- [ ] **Step 4: Run test — expect PASS**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/search/query.ts apps/server-pilot/tests/mail-search-free-text-tsquery.test.ts apps/server-pilot/deploy/mail-search-gate.sh
git commit -m "$(cat <<'EOF'
feat(search): add allowlisted prefix tsquery builder

EOF
)"
```

---

### Task 2: Normalize search_vector + wire listThreads

**Files:**
- Modify: `apps/server-pilot/src/mail/search/search-vector.ts`
- Modify: `apps/server-pilot/src/mail/search/query.ts`
- Modify: `apps/server-pilot/tests/mail-search-query.test.ts`
- Modify: `apps/server-pilot/tests/mail-search-contract.test.ts`

**Interfaces:**
- Consumes: `buildFreeTextTsQuery` from Task 1 (same `query.ts`); `THREAD_SEARCH_VECTOR_CONFIG`; `threadSearchVectorSourceSql`
- Produces: `threadSearchVectorSourceSql` whose `to_tsvector('simple', …)` includes domain labels from **From over the 20-message window** (not To) and words from stripped HTML when text is empty; `buildThreadSearchConditions` uses **bound** `to_tsquery(${config}, ${tsQuery})` — never `sql.raw`. `threadSearchVectorText` JS helper stays subject+snippet+from only; **do not** assert it equals the SQL vector.

- [ ] **Step 1: Extend the query-test seeder and write failing cases**

In `apps/server-pilot/tests/mail-search-query.test.ts`, add `htmlBody?: string | null` to `seedThreadWithMessage` opts. Insert `htmlBody: opts.htmlBody ?? null`. Allow `textBody` to be explicitly `null` (do not coerce `null` to snippet):

```typescript
textBody: opts.textBody === undefined ? (opts.snippet ?? null) : opts.textBody,
htmlBody: opts.htmlBody ?? null,
```

Add these tests inside the existing `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)` block:

```typescript
  it('matches a domain label in from_address that is not a standalone word', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'Cancellation of voucher',
        snippet: 'Cancellation of voucher',
        fromAddress: 'info@acmehotels.test',
        textBody: null,
        htmlBody: '<html><body><p>Please review the attached voucher</p></body></html>',
      });
      await seedThreadWithMessage(db, {
        subject: 'Other',
        snippet: 'Other',
        fromAddress: 'ops@unrelated.example',
      });

      expect(await listThreadIdsForQuery(db, 'acmehotels')).toEqual([threadId]);
      expect(await listThreadIdsForQuery(db, 'acme')).toEqual([threadId]);
    });
  });

  it('matches a token that exists only in html_body when text_body is null', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'Housekeeping',
        fromAddress: 'sender@example.com',
        textBody: null,
        htmlBody: '<html><body><p>uniquehtmlbodytoken in the guest bathroom</p></body></html>',
      });
      await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'Housekeeping',
        fromAddress: 'sender@example.com',
        textBody: null,
        htmlBody: '<html><body><p>minibar restock only</p></body></html>',
      });

      expect(await listThreadIdsForQuery(db, 'uniquehtmlbodytoken')).toEqual([threadId]);
    });
  });

  it('still matches a brand after a large HTML head once style/script are stripped', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'Housekeeping',
        fromAddress: 'sender@example.com',
        textBody: null,
        htmlBody: `<html><head><style>${'x'.repeat(9000)}</style></head><body><p>fatheadhtmltoken</p></body></html>`,
      });
      expect(await listThreadIdsForQuery(db, 'fatheadhtmltoken')).toEqual([threadId]);
    });
  });

  it('does not match a token beyond the 20-message cap when only html_body is set', async () => {
    await withSeededTestDb(async (db) => {
      const receivedAt = new Date('2026-07-06T12:00:00Z');
      const { threadId } = await seedThreadWithMessage(db, {
        messageId: '20000000-0000-0000-0000-000000000001',
        subject: 'Housekeeping',
        snippet: 'See note',
        textBody: null,
        htmlBody: '<p>htmlmessagecapboundarytoken</p>',
        latestMessageAt: receivedAt,
        refreshSearchVector: false,
      });
      await db.insert(message).values(
        Array.from({ length: 20 }, (_, index) => ({
          id: `20000000-0000-0000-0000-${String(index + 2).padStart(12, '0')}`,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound' as const,
          fromAddress: 'sender@example.com',
          toAddresses: ['nava@example.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Housekeeping',
          textBody: null,
          htmlBody: `<p>recent html ${index}</p>`,
          receivedAt,
        })),
      );
      await refreshThreadSearchVector(db, threadId);
      expect(await listThreadIdsForQuery(db, 'htmlmessagecapboundarytoken')).toEqual([]);
    });
  });

  it('does not match a token after 8,000 stripped HTML characters', async () => {
    await withSeededTestDb(async (db) => {
      await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'See note',
        fromAddress: 'sender@example.com',
        textBody: null,
        htmlBody: `<p>${'a '.repeat(4000)}htmlcharcapboundarytoken</p>`,
      });
      expect(await listThreadIdsForQuery(db, 'htmlcharcapboundarytoken')).toEqual([]);
    });
  });

  it('does not return the mailbox for a two-character TLD query', async () => {
    await withSeededTestDb(async (db) => {
      await seedThreadWithMessage(db, {
        subject: 'Hotel invoice',
        snippet: 'Please review',
        fromAddress: 'ops@unrelated.example',
      });
      expect(await listThreadIdsForQuery(db, 'co')).toEqual([]);
    });
  });

  it('matches nothing for punctuation-only free text', async () => {
    await withSeededTestDb(async (db) => {
      await seedThreadWithMessage(db, {
        subject: 'Hotel invoice',
        snippet: 'Please review',
      });
      expect(await listThreadIdsForQuery(db, '!!!')).toEqual([]);
    });
  });
```

In `apps/server-pilot/tests/mail-search-contract.test.ts`, add (same skipIf wrapper):

```typescript
    it('listThreads free text matches a from_address domain label', async () => {
      await withSeededTestDb(async (db) => {
        const matchingId = 'thread-search-domain-match';
        const decoyId = 'thread-search-domain-decoy';

        await seedInboxThread(db, {
          threadId: matchingId,
          transportId: TRANSPORT_ID,
          transportEmail: 'centurion@legacyhotel.com',
          subject: 'Voucher notice',
          snippet: 'Voucher notice',
          fromAddress: 'info@acmehotels.test',
          textBody: '',
        });
        await db
          .update(message)
          .set({
            textBody: null,
            htmlBody: '<p>Please review the attached voucher</p>',
          })
          .where(eq(message.threadId, matchingId));
        await refreshThreadSearchVector(db, matchingId);

        await seedInboxThread(db, {
          threadId: decoyId,
          transportId: TRANSPORT_ID,
          transportEmail: 'centurion@legacyhotel.com',
          subject: 'Breakfast',
          snippet: 'Breakfast',
          fromAddress: 'ops@unrelated.example',
        });
        await refreshThreadSearchVector(db, decoyId);

        const caller = await callerFor('user-navaai', { db });
        const result = await caller.mail.listThreads({
          folder: 'inbox',
          q: 'acmehotels',
        });
        const ids = result.threads.map((t) => t.id);
        expect(ids).toContain(matchingId);
        expect(ids).not.toContain(decoyId);
      });
    });

    it('listThreads folder=all omits trashed and spam siblings for the same free-text hit', async () => {
      await withSeededTestDb(async (db) => {
        const visibleId = 'thread-search-all-visible';
        const trashedId = 'thread-search-all-trashed';
        const spamId = 'thread-search-all-spam';

        for (const threadId of [visibleId, trashedId, spamId]) {
          await seedInboxThread(db, {
            threadId,
            transportId: TRANSPORT_ID,
            transportEmail: 'centurion@legacyhotel.com',
            subject: 'Voucher notice',
            snippet: 'Voucher notice',
            fromAddress: 'info@acmehotels.test',
            textBody: '',
          });
          await db
            .update(message)
            .set({
              textBody: null,
              htmlBody: '<p>Please review the attached voucher</p>',
            })
            .where(eq(message.threadId, threadId));
        }

        await db
          .update(mailThread)
          .set({ trashedAt: new Date() })
          .where(eq(mailThread.id, trashedId));
        await db
          .update(mailThread)
          .set({ spamAt: new Date() })
          .where(eq(mailThread.id, spamId));

        await refreshThreadSearchVector(db, visibleId);
        await refreshThreadSearchVector(db, trashedId);
        await refreshThreadSearchVector(db, spamId);

        const caller = await callerFor('user-navaai', { db });
        const result = await caller.mail.listThreads({
          folder: 'all',
          q: 'acmehotels',
        });
        const ids = result.threads.map((t) => t.id);
        expect(ids).toContain(visibleId);
        expect(ids).not.toContain(trashedId);
        expect(ids).not.toContain(spamId);
      });
    });
```

Contract file already imports `message`? If not, add:

```typescript
import { eq } from 'drizzle-orm';
import { mailDraft, mailThread, message } from '../src/db/schema/mail.js';
```

(`mailDraft` is already imported — merge `mailThread` and `message` into that line. Add `eq` from `drizzle-orm`.)

- [ ] **Step 2: Run tests — expect FAIL for the right reason**

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
# Tokenizer still passes:
pnpm exec vitest run tests/mail-search-query.test.ts
```

If disposable DB is configured:

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
CONFIRM_DISPOSABLE_TEST_DB=1 pnpm exec vitest run tests/mail-search-query.test.ts tests/mail-search-contract.test.ts
```

Expected with disposable DB: new cases FAIL (`ids` empty / not containing matching thread) because `plainto_tsquery` + email lexeme + ignored HTML. Existing `invoice` / `uniquebodytoken` tests must still be considered — they should keep passing after the implementation.

If `TEST_DB_AVAILABLE` is false: tests skip. That is a **safety blocker** for Task 2, not a pass. Do not point Vitest at pilot.

- [ ] **Step 3: Implement search_vector normalize**

Replace `threadSearchVectorSourceSql` in `apps/server-pilot/src/mail/search/search-vector.ts`. Order: pick `nullif(btrim(text_body),'')` else `html_body`; `left(..., 200000)` then strip `<style>`/`<script>` (flag `gis`) then tags; then `left(..., 8000)`. Never `left(html, 8000)` then strip. Punctuation class stays `[@.]+` (ponytail). From = `string_agg(from_address)` over the same 20-message window — **not** LIMIT 1 inbound, **not** `to_addresses`.

```typescript
function mailSearchStripHtmlSql(source: SQL): SQL {
  return sql`regexp_replace(regexp_replace(regexp_replace(${source}, '<style[^>]*>.*?</style>', ' ', 'gis'), '<script[^>]*>.*?</script>', ' ', 'gis'), '<[^>]+>', ' ', 'g')`;
}

function mailSearchNormalizeSql(source: SQL): SQL {
  return sql`regexp_replace(${mailSearchStripHtmlSql(source)}, '[@.]+', ' ', 'g')`;
}

function mailSearchIndexedBodySql(): SQL {
  return sql`left(${mailSearchStripHtmlSql(sql`
    left(
      coalesce(
        nullif(btrim(coalesce("text_body", '')), ''),
        coalesce("html_body", '')
      ),
      200000
    )
  `)}, ${MAIL_SEARCH_BODY_CHAR_LIMIT})`;
}

export const threadSearchVectorSourceSql: SQL = mailSearchNormalizeSql(sql`
  coalesce("subject", '') || ' ' || coalesce("snippet", '') || ' ' || coalesce((
    SELECT string_agg(coalesce("from_address", ''), ' ' ORDER BY "received_at" DESC NULLS LAST, "id" DESC)
    FROM (
      SELECT "from_address", "received_at", "id"
      FROM "message"
      WHERE "message"."thread_id" = "mail_thread"."id"
        AND "message"."transport_id" = "mail_thread"."transport_id"
      ORDER BY "received_at" DESC NULLS LAST, "id" DESC
      LIMIT ${MAIL_SEARCH_BODY_MESSAGE_LIMIT}
    ) AS recent_from
  ), '') || ' ' || coalesce((
    SELECT string_agg(
      ${mailSearchIndexedBodySql()},
      ' '
      ORDER BY "received_at" DESC NULLS LAST, "id" DESC
    )
    FROM (
      SELECT "text_body", "html_body", "received_at", "id"
      FROM "message"
      WHERE "message"."thread_id" = "mail_thread"."id"
        AND "message"."transport_id" = "mail_thread"."transport_id"
      ORDER BY "received_at" DESC NULLS LAST, "id" DESC
      LIMIT ${MAIL_SEARCH_BODY_MESSAGE_LIMIT}
    ) AS recent_bodies
  ), '')
`);
```

`mailSearchNormalizeSql` / strip helpers may stay unexported.

Keep `refreshThreadSearchVector` as `to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, ${threadSearchVectorSourceSql})`. Do not teach `threadSearchVectorText` as the indexer.

- [ ] **Step 4: Wire query.ts**

In `apps/server-pilot/src/mail/search/query.ts`, `buildFreeTextTsQuery` is already in this file from Task 1. Replace the freeText branch:

```typescript
  const freeText = parsed.freeText.trim();
  if (freeText) {
    const tsQuery = buildFreeTextTsQuery(freeText);
    if (tsQuery) {
      conditions.push(
        sql`${mailThread.searchVector} @@ to_tsquery(${THREAD_SEARCH_VECTOR_CONFIG}, ${tsQuery})`,
      );
    } else {
      conditions.push(sql`false`);
    }
  }
```

Do not change `from:` ILIKE, dates, or other operators. `${tsQuery}` must remain a bound parameter (same as today’s `${freeText}`). Builder output is quoted `[a-z0-9]` lexemes plus `:*` and `&` only.

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/mail-search-free-text-tsquery.test.ts tests/mail-search-query.test.ts tests/mail-search-parse.test.ts tests/mail-search-parity.test.ts tests/mail-search-input.test.ts
```

Expected: PASS (no DB).

With disposable DB:

```bash
cd apps/server-pilot && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
CONFIRM_DISPOSABLE_TEST_DB=1 pnpm exec vitest run \
  tests/mail-search-free-text-tsquery.test.ts \
  tests/mail-search-query.test.ts \
  tests/mail-search-contract.test.ts \
  tests/mail-search-fts.test.ts
```

Expected: PASS, including existing body-cap tests.

Or run `bash apps/server-pilot/deploy/mail-search-gate.sh` when `TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1` are set.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/mail/search/search-vector.ts apps/server-pilot/src/mail/search/query.ts apps/server-pilot/tests/mail-search-query.test.ts apps/server-pilot/tests/mail-search-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(search): index HTML and email labels in thread FTS

EOF
)"
```

---

### Task 3: Instant Search bar (debounce, recents, drop dummy From)

**Files:**
- Modify: `apps/mail/lib/mail/search-list.ts`
- Modify: `apps/mail/tests/search-list.test.ts`
- Modify: `apps/mail/components/mail/mail-search-bar.tsx`
- Modify: `apps/mail/tests/mail-search-bar.test.tsx`

**Interfaces:**
- Consumes: `useDebouncedValue` from `apps/mail/hooks/use-debounce.ts` (default 300ms); `saveRecentSearch`; `getMainSearchTerm`; `MAX_EFFECTIVE_SEARCH_LENGTH`
- Produces: `shouldLiveApplySearch(raw: string, filters: ActiveSearchFilter[]): boolean`; live idle write of `{ value, highlight }` with filters/scope/`resetVersion` preserved; recents only from `commitSearch`; nonempty input → no listbox

Replace `it('keeps typed text local until Enter', …)`. Keep Enter commit. Fake timers. `afterEach` must call `vi.useRealTimers()`.

Live write **only when idle**: `debouncedLocalSearch === localSearch`. That is how Clear wins: after reset, `localSearch` is `''` while debounce still holds the old string — skip until they match.

`shouldLiveApplySearch`:
- `trim() === ''` → true (restore folder list)
- `mergeSearchQuery` length > 512 → false (no toast on live)
- any `prefix:` whose prefix is **not** in `{from,to,cc,bcc,subject,after,before,label,category,is,has}` → false (`kind:` mid-type must not 400 the list)
- `is:` unless value is `unread|read|starred|important` → false
- `has:` unless value is `attachment` → false
- else true iff some `[A-Za-z0-9]+` token has length ≥ **3** (align with FTS; `n`/`ne`/`co` stay folder list)

Enter/`commitSearch`: immediate write even for 1-char / `kind:email`; toast on over-limit; `saveRecentSearch` if trim nonempty. Unsupported operators still 400 on Enter (existing list error).

- [ ] **Step 1: Write failing tests**

In `apps/mail/tests/search-list.test.ts`:

```typescript
  it('gates live search so short tokens and unknown operators do not run', () => {
    expect(shouldLiveApplySearch('', [])).toBe(true);
    expect(shouldLiveApplySearch('n', [])).toBe(false);
    expect(shouldLiveApplySearch('ne', [])).toBe(false);
    expect(shouldLiveApplySearch('!!!', [])).toBe(false);
    expect(shouldLiveApplySearch('nex', [])).toBe(true);
    expect(shouldLiveApplySearch('acme', [])).toBe(true);
    expect(shouldLiveApplySearch('from:x', [])).toBe(true);
    expect(shouldLiveApplySearch('is:unread', [])).toBe(true);
    expect(shouldLiveApplySearch('kind:', [])).toBe(false);
    expect(shouldLiveApplySearch('kind:email', [])).toBe(false);
    expect(shouldLiveApplySearch('x'.repeat(513), [])).toBe(false);
  });
```

Export `shouldLiveApplySearch` from `search-list.ts` (test fails until exported).

In `apps/mail/tests/mail-search-bar.test.tsx`, replace the Enter-only case and add:

```typescript
  it('applies typed text to the list after 300ms without saving recents', () => {
    vi.useFakeTimers();
    setMailScope();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.change(input, { target: { value: 'deposit' } });
    expect(screen.getByTestId('committed').textContent).toBe('');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('committed').textContent).toBe('deposit');
    expect(loadRecentSearches()).toEqual([]);

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(loadRecentSearches()).toEqual(['deposit']);
  });

  it('flushes search on Enter before 300ms and saves recents', () => {
    vi.useFakeTimers();
    setMailScope();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'acmehotels' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toBe('acmehotels');
    expect(loadRecentSearches()).toEqual(['acmehotels']);
  });

  it('does not live-apply a one-character query', () => {
    vi.useFakeTimers();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'n' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('committed').textContent).toBe('');
  });

  it('commits a one-character query on Enter', () => {
    setMailScope();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'n' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toBe('n');
    expect(loadRecentSearches()).toEqual(['n']);
  });

  it('does not live-apply a two-character query', () => {
    vi.useFakeTimers();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'ne' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('committed').textContent).toBe('');
  });

  it('does not live-apply an unknown operator prefix', () => {
    vi.useFakeTimers();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'kind:' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('committed').textContent).toBe('');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toBe('kind:');
  });

  it('does not resurrect a cleared query when the debounce fires', () => {
    vi.useFakeTimers();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'deposit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('committed').textContent).toBe('');
  });

  it('does not toast on over-limit live debounce', () => {
    vi.useFakeTimers();
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'x'.repeat(513) } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.getByTestId('committed').textContent).toBe('');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Search query must be 512 characters or fewer.',
    );
  });

  it('does not suggest From {typed term} while typing', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'deposit' } });
    fireEvent.focus(input);
    expect(screen.queryByRole('option', { name: 'From deposit' })).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not open an empty listbox on ArrowDown while typing', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'deposit' } });
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Filters From still adds a from chip for the typed local text', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    fireEvent.change(input, { target: { value: 'alice@corp.com' } });
    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitem', { name: 'From' }));
    expect(screen.getByRole('button', { name: 'Remove From: alice@corp.com' })).toBeTruthy();
  });
```

Import `loadRecentSearches`. In the existing `afterEach`, add `vi.useRealTimers()` so a failed fake-timer test cannot leak.

IME: `compositionstart` on the input must block live apply; `compositionend` then 300ms idle applies. Add `fireEvent.compositionStart(input)` / `compositionEnd` around a change if the first IME case is cheap; skip a dedicated IME test only if happy-dom drops those events — then still wire `onCompositionStart`/`onCompositionEnd` in the component.

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/search-list.test.ts tests/mail-search-bar.test.tsx
```

Expected: FAIL — `shouldLiveApplySearch` missing; committed still empty after 300ms; `From deposit` may still exist.

- [ ] **Step 3: Implement**

Add to `apps/mail/lib/mail/search-list.ts`:

```typescript
const LIVE_SEARCH_OPERATOR_PREFIXES = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'after',
  'before',
  'label',
  'category',
  'is',
  'has',
]);

function isLiveSafeOperatorQuery(raw: string): boolean {
  for (const token of raw.match(/[^\s]+/g) ?? []) {
    const colon = token.indexOf(':');
    if (colon <= 0) continue;
    const prefix = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (!LIVE_SEARCH_OPERATOR_PREFIXES.has(prefix)) return false;
    if (
      prefix === 'is' &&
      !['unread', 'read', 'starred', 'important'].includes(value.toLowerCase())
    ) {
      return false;
    }
    if (prefix === 'has' && value.toLowerCase() !== 'attachment') return false;
  }
  return true;
}

export function shouldLiveApplySearch(
  raw: string,
  filters: ActiveSearchFilter[],
): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (mergeSearchQuery(trimmed, filters).length > MAX_EFFECTIVE_SEARCH_LENGTH) return false;
  if (!isLiveSafeOperatorQuery(trimmed)) return false;
  if (trimmed.includes(':')) return true;
  return /[a-z0-9]{3,}/i.test(trimmed);
}
```

In `mail-search-bar.tsx`:

1. Import `useDebouncedValue` and `shouldLiveApplySearch`.
2. Suggestions: empty `localSearch.trim()` → recents as today; nonempty → `[]` (no `{ kind: 'from' }`).
3. Track composing:

```typescript
  const [isComposing, setIsComposing] = useState(false);
  const debouncedLocalSearch = useDebouncedValue(localSearch, 300);
```

4. Live apply effect (one copy — do not keep alternate snippets):

```typescript
  useEffect(() => {
    if (isComposing) return;
    if (debouncedLocalSearch !== localSearch) return;
    if (!shouldLiveApplySearch(debouncedLocalSearch, searchValue.filters)) return;
    const highlight = getMainSearchTerm(debouncedLocalSearch);
    if (
      debouncedLocalSearch === searchValue.value &&
      highlight === searchValue.highlight
    ) {
      return;
    }
    setSearchValue({
      value: debouncedLocalSearch,
      highlight,
      scope: searchValue.scope,
      filters: searchValue.filters,
      resetVersion: searchValue.resetVersion,
    });
  }, [
    debouncedLocalSearch,
    isComposing,
    localSearch,
    searchValue.filters,
    searchValue.highlight,
    searchValue.resetVersion,
    searchValue.scope,
    searchValue.value,
    setSearchValue,
  ]);
```

Do not `saveRecentSearch` here. Do not toast here.

5. `commitSearch` stays immediate + `saveRecentSearch`.
6. Input: `onCompositionStart={() => setIsComposing(true)}` `onCompositionEnd={() => setIsComposing(false)}`.
7. `handleInputKeyDown` ArrowDown: if `localSearch.trim()`, return (no popup). Empty input: keep recents behavior.
8. Clear still `resetSearchValue()`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/mail-search-bar.test.tsx tests/search-list.test.ts tests/focus-search-shortcut.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/search-list.ts apps/mail/tests/search-list.test.ts apps/mail/components/mail/mail-search-bar.tsx apps/mail/tests/mail-search-bar.test.tsx
git commit -m "$(cat <<'EOF'
feat(mail): apply Outlook search as you type

EOF
)"
```

---

### Task 4: Keep prior rows while search refetches + empty a11y

**Files:**
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Modify: `apps/mail/tests/use-threads-content-query-ownership.test.ts` (source contains `placeholderData`)
- Modify: `apps/mail/tests/demo-mail-list-perf-guards.test.ts`

**Interfaces:**
- Consumes: existing footer `isFetching` spinner in `mail-list.tsx`; `placeholderData` pattern already on `useThread`
- Produces: live `listThreads`, demo `listThreads`, live `drafts.list`, and demo drafts infinite queries all set `placeholderData: (previousData) => previousData`. Search miss heading unchanged. Muted hint only under miss. `aria-live` settle. `min-h-11` on Clear / Try All folders / Retry search. First-paint spinner `role="status"` `aria-label="Loading mail"`. List host `aria-busy={Boolean(activeSearch && isFetching)}`.

- [ ] **Step 1: Write failing tests**

In `apps/mail/tests/use-threads-content-query-ownership.test.ts` (it already reads `use-threads.ts` source), assert:

```typescript
    expect(selectAllSource).toContain('placeholderData: (previousData) => previousData');
```

Count: at least two list-query option blocks (live threads + demo threads). Drafts list options too if those objects are in the same file.

In `apps/mail/tests/demo-mail-list-perf-guards.test.ts`, keep:

```typescript
expect(screen.getByText('No emails match “deposit is:unread”')).toBeTruthy();
```

Add (search-miss branch only):

```typescript
expect(screen.getByText('Check the spelling, or try All folders.')).toBeTruthy();
```

When rendering All-folders miss (`scope: 'all'`), expect `Check the spelling. Trash and Spam are not included.` and **not** the folder-scope hint.

Folder-empty (`activeSearch` empty): still `It's empty here`, no miss headline, no miss hint.

Assert Clear / Try All folders / Retry search have class `min-h-11` (or computed minHeight ≥ 44).

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/use-threads-content-query-ownership.test.ts tests/demo-mail-list-perf-guards.test.ts
```

Expected: FAIL — list queries lack `placeholderData`; hint text missing.

- [ ] **Step 3: Implement**

On `demoThreadsQuery`, `demoDraftsQuery`, `liveDraftsQueryOptions`, and `liveThreadsQueryOptions` in `use-threads.ts`, add:

```typescript
placeholderData: (previousData) => previousData,
```

Do not add a “Searching…” label. Keep footer spinner.

In `mail-list.tsx` first-paint spinner wrapper: `role="status"` `aria-label="Loading mail"`.

On the scroll parent `div` (the one with `hide-link-indicator`): `aria-busy={Boolean(activeSearch && isFetching)}`.

Add sr-only live region, speak only when `!isFetching && !isLoading`:

```tsx
<p className="sr-only" aria-live="polite" aria-atomic="true">
  {!isFetching && !isLoading && activeSearch
    ? items.length === 0
      ? `No emails match “${activeSearch}”`
      : `${items.length} emails`
    : ''}
</p>
```

Under the miss headline, muted `p` `text-sm text-muted-foreground`:

- `searchValue.scope !== 'all'`: `Check the spelling, or try All folders.`
- else: `Check the spelling. Trash and Spam are not included.`

Add `min-h-11` to Clear, Try All folders, Retry search buttons (keep `size="sm"`).

Copy locked: `No emails match “{activeSearch}”` with Unicode quotes; error `Unable to load search results. Please retry.`; folder empty `It's empty here`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/use-threads-content-query-ownership.test.ts tests/demo-mail-list-perf-guards.test.ts tests/mail-search-bar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/hooks/use-threads.ts apps/mail/components/mail/mail-list.tsx apps/mail/tests/use-threads-content-query-ownership.test.ts apps/mail/tests/demo-mail-list-perf-guards.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): keep thread list visible while search refetches

EOF
)"
```

---

### Task 5: Ops proof after land (no product code)

**Files:** none to create. Follow `docs/solutions/workflow-issues/outlook-search-fts-backfill-pilot-deploy.md`.

**Interfaces:**
- Consumes: landed SHA containing Tasks 1–4; `apps/server-pilot/scripts/backfill-search-vector.ts` (already binds `threadSearchVectorSourceSql`)
- Produces: count-only verification that every visible From-ILIKE thread for a chosen domain label is also an FTS prefix hit (ILIKE ⊆ FTS). FTS count may be **higher** (HTML body mentions). Never print addresses/bodies.

Do not run this task without explicit deploy/backfill authorization. Do not Vitest on pilot.

- [ ] **Step 1: Confirm disposable tests already green on the landed SHA** (Task 2 gate). If no disposable DB, stop — safety blocker.

- [ ] **Step 2: After authorized `ops-deploy.sh` (no `--migrate`; expression-only), SHA-gate:** EC2 `git rev-parse HEAD` equals land SHA. Deployed `apps/server-pilot/src/mail/search/search-vector.ts` contains `html_body`, style/script strip, `[@.]+`, and `MAIL_SEARCH_BODY_MESSAGE_LIMIT = 20`. Confirm `BACKFILL_BATCH_SIZE = 200`. Do not treat a noisy NOTICE log as failure.

- [ ] **Step 3: SSM backfill** as in the 2026-08-25 solution (laptop `ssm-run-command.sh`, NVM, `set -a`, source `.env.production` **on EC2 only**, `pnpm exec tsx scripts/backfill-search-vector.ts`, `SSM_EXECUTION_TIMEOUT_SECONDS=3600`). Expect `backfill complete: N row(s) updated`. NOTICE `word is too long to be indexed` / `Words longer than 2047 characters are ignored` is success noise (HTML may increase volume). Re-run is a full-table rewrite.

- [ ] **Step 4: Count-only read-only SQL on EC2** (never print addresses/bodies). `:label` is `[a-z0-9]+` length ≥ 3. Quoted tsquery matches the builder (`'label':*`). Pass when `from_ilike_missing_fts = 0`. Print the two totals separately (FTS ≥ ILIKE is OK).

```sql
-- bind :label to a domain label ([a-z0-9]+, length >= 3). Totals only.
SELECT
  (SELECT COUNT(DISTINCT t.id)::int
     FROM mail_thread t
     JOIN message m ON m.thread_id = t.id AND m.transport_id = t.transport_id
    WHERE lower(m.from_address) LIKE '%' || :label || '%'
      AND t.trashed_at IS NULL AND t.spam_at IS NULL) AS from_ilike_threads,
  (SELECT COUNT(*)::int
     FROM mail_thread t
    WHERE t.search_vector @@ to_tsquery('simple', '''' || :label || ''':*')
      AND t.trashed_at IS NULL AND t.spam_at IS NULL) AS fts_prefix_threads,
  (SELECT COUNT(DISTINCT t.id)::int
     FROM mail_thread t
     JOIN message m ON m.thread_id = t.id AND m.transport_id = t.transport_id
    WHERE lower(m.from_address) LIKE '%' || :label || '%'
      AND t.trashed_at IS NULL AND t.spam_at IS NULL
      AND NOT (t.search_vector @@ to_tsquery('simple', '''' || :label || ''':*'))) AS from_ilike_missing_fts;
```

- [ ] **Step 5: No commit** unless verification notes belong in a handoff report the user asked for.

---

## Self-review

- R1–R3 → Task 2 (R1 = From over 20 msgs, not To; R3 min token 3). R4 dummy From + debounce + live `kind:` skip → Task 3. R5 → AE2 contract + miss headline. R6 operators unchanged. R7 → Global Constraints + Task 5 (ILIKE ⊆ FTS counts).
- AE1 → query + contract tests. AE2 → `listThreads` folder=all trash/spam. AE3 → mail-search-bar fake timers. AE4 → existing parse tests still run in Task 2 Step 5; live `kind:` does not fetch.
- No TBD. `buildFreeTextTsQuery` / `mailSearchNormalizeSql` names match across tasks. Quoted lexemes `'token':*`.
- Existing `keeps typed text local until Enter` is explicitly replaced.
- Playwright search-bar spec stays Enter-based; live apply is unit-tested only.

Next step: `/nava-run`.
