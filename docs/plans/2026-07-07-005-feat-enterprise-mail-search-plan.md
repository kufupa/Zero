<!-- /autoplan restore point: ~/.gstack/projects/kufupa-Zero/EC2-pilot-autoplan-restore-20260707-225803.md -->

# Plan: Enterprise mail search (Outlook/Gmail parity)

**Branch:** `feat/mail-search` @ `~/.config/superpowers/worktrees/zero/feat-mail-search` (12 commits)
**Status:** IMPLEMENTED — migration 0010, 203 unit tests pass; DB contract tests need RDS
**Design doc:** `~/.gstack/projects/kufupa-Zero/gamin-EC2-pilot-design-20260707-225724.md`

## Summary

Ship honest Gmail/Outlook-level search for enterprise Outlook replacement. Backend owns query parsing + Postgres FTS; frontend owns UX, highlight, cache. Re-enable grammar UI only when contract tests pass. AI/vector search deferred.

## Goals

1. **Parity:** `from:`, `to:`, `cc:`, `bcc:`, `subject:`, free text, `is:read/unread/starred/important`, `has:attachment`, `after:`/`before:`, `label:`, category scoping.
2. **Correctness:** No silent misses when users type operator strings.
3. **Performance:** GIN indexes; keyset pagination preserved.
4. **Tests:** `server-pilot` contract tests per operator + FE capability gate tests + E2E palette search.

## Non-goals (tier 2+)

- AI natural language → query (`ai.generateSearchQuery`)
- Vector / semantic search
- Saved search sync across devices
- Outlook-only niceties (`kind:`, Teams chat) unless client requests

## Architecture

```
Command palette / mail list
        │  q + filters
        ▼
  apps/mail (use-threads.ts)
        │  trpc.mail.listThreads
        ▼
  apps/server-pilot/src/mail/search/
    parseSearchQuery(q) → ParsedSearchQuery (flat filters + freeText)
    buildThreadListQuery(parsed, filters, folder) → SQL + FTS
        ▼
  Postgres (mail_thread, message, labels, attachments)
```

### New / modified components

| Component | Action |
|-----------|--------|
| `apps/server-pilot/src/mail/search/parse.ts` | NEW — tokenize operators + alias spellings inline |
| `apps/server-pilot/src/mail/search/query.ts` | NEW — parsed query → Drizzle + FTS conditions |
| `apps/server-pilot/src/db/schema/mail.ts` | ADD — `searchVector` generated column + GIN index |
| `apps/server-pilot/src/mail/ingest/store.ts` | UPDATE — populate FTS fields |
| `apps/server-pilot/src/trpc/routes/mail.ts` | UPDATE — wire parser, remove raw ILIKE |
| `apps/server-pilot/src/trpc/routes/drafts.ts` | UPDATE — same parser for drafts |
| `apps/mail/lib/pilot/capabilities.ts` | UPDATE — flip `gmailSearchGrammar` when tests green |
| `apps/mail/components/context/command-palette-context.tsx` | UPDATE — structured + raw q alignment |
| `apps/mail/hooks/use-threads.ts` | MINOR — normalize query key |
| `apps/server-pilot/tests/mail-search-*.test.ts` | NEW — operator contract suite |
| `apps/mail/tests/search-filter-contract.test.ts` | EXTEND |
| `packages/testing/e2e/search-bar.spec.ts` | EXTEND — assert search results |

## Implementation phases

### Phase 0 — Query model + tests (no UI change)
- Define `ParsedSearchQuery` Zod schema (flat struct, not AST).
- Fixture DB seeds with known threads per operator.
- Contract tests fail against current ILIKE (baseline).

### Phase 1 — FTS foundation
- Migration: `search_vector tsvector` on `mail_thread` (+ message join path for from/to/body excerpt).
- GIN index; backfill script for existing rows.
- Plain free-text uses `@@ plainto_tsquery` with ranking.

### Phase 2 — Operator parser (parity core)
- Implement parsers for address, subject, is:*, has:attachment, date, label.
- Wire `listThreads` + `drafts.list`.
- Remove misleading whole-string ILIKE on `from:foo`.

### Phase 3 — FE honesty + re-enable
- Turn on `gmailSearchGrammar` when operator groups pass tests.
- Palette quick-filter uses same `executeSearch` path.
- Document supported grammar in pilot help.

### Phase 4 — E2E + perf
- Playwright search asserts.
- Explain analyze on hot queries; tune indexes.

## FE vs BE responsibilities

**Backend must implement:** every operator that affects membership in result set; pagination; cross-folder `all` semantics; attachment EXISTS; date parsing (`yyyy/mm/dd`, `yyyy-mm-dd`, relative).

**Frontend may implement:** highlight, debounce (300ms), recent/saved searches (localStorage), command palette views, React Query cache, loading/empty states, "unsupported operator" toast if server returns 400.

**Frontend must NOT:** filter full mailbox client-side; send `is:unread` only in `q` without server parse; enable grammar UI before capability flag.

## Test plan (sketch)

| Case | Type | Location |
|------|------|----------|
| `from:user@corp.com` | contract | server-pilot |
| `has:attachment` | contract | server-pilot |
| `is:unread` + folder inbox | contract | server-pilot |
| `after:2025/01/01` | contract | server-pilot |
| free text FTS | contract | server-pilot |
| `label:foo` | contract | server-pilot |
| capability gate off/on | unit | apps/mail |
| palette search shows results | e2e | packages/testing |

## Risks

| Risk | Mitigation |
|------|------------|
| Parser bugs → wrong results | Golden-file tests per operator |
| FTS migration slow | Background backfill; reject search until backfill done for mailbox |
| FE cache stale after search | `queryKey` includes normalized `q` (trim + lowercase) |
| Scope creep to AI search | Explicit non-goals; separate plan |

## Rollout

1. Merge to worktree branch; run tests locally.
2. Enable `gmailSearchGrammar` in staging after contract green.
3. Client UAT with parity operator set (Gmail + Outlook spellings, same semantics).

---

## /autoplan amendments (from review, revised per user)

### Trust layer (ships with parser PR)
- Unsupported operator token → 400 + FE toast (no silent ILIKE miss).
- Wire palette quick filters → structured `filters.*` where BE already supports (unread/starred/important).

### Operator aliases (inline in parser, not a separate layer)
- Same SQL for equivalent spellings: `is:unread` / `read:no`, `has:attachment` / `hasattachment:yes`, `label:` / `category:` (category joins `mail_thread_category`).
- No Outlook-vs-Gmail product fork — one parser, both spellings accepted.

### Revised ship order
1. Contract test fixtures + `ParsedSearchQuery` schema
2. FTS migration + ingest sync
3. Parser (regex-per-operator) + trust layer + structured filter wiring
4. Flip `gmailSearchGrammar`
5. E2E + EXPLAIN

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Block impl until client top-10 | **REJECTED** | — | User: ship parity now | — |
| 2 | CEO | Add Outlook synonym layer | **REJECTED** | — | User: inline aliases, no layer | Separate dialect module |
| 8 | User | Inline alias spellings in parser | Mechanical | P5 | `read:no` same as `is:unread` | Outlook dialect layer |
| 9 | User | No AI/semantic in v1 | Mechanical | P3 | Explicit non-goals | — |
| 10 | Ponytail | Flat parser not AST | Mechanical | P5 | One struct, regex tokens | MailSearchAst |
| 11 | Ponytail | 2 search files not 3 | Mechanical | P5 | parse.ts + query.ts | parser/build/fts split |
| 3 | Eng | Kill inline snooze UPDATE on list | Mechanical | P5 explicit | Write amplification at scale | Keep as-is |
| 4 | Eng | `z.string().max(512)` on q | Mechanical | P1 | DoS + perf | Unbounded q |
| 5 | Eng | Debounce before TRPC | Mechanical | P3 | RQ storm on keystroke | Instant query |
| 6 | Eng | Shared parser for drafts+threads | Mechanical | P4 DRY | Plan already says; enforce | Separate parsers |
| 7 | CEO | Phase 0.5 structured filters before AST | Taste | P5 | Faster win, Jul-06 aligned | Full AST first |

## GSTACK REVIEW REPORT

### CEO (subagent-only; codex available, not run this session)
- **Verdict:** Problem real (silent wrong results). Wedge risky (Gmail grammar for Outlook client).
- **Critical:** Demand evidence thin — need client top-10 before APPROVED impl. Body search scope must lock before FTS. Outlook dialect ≠ Gmail dialect.
- **10x gap:** Category-aware search (`category:urgent`) underweighted vs commodity operators.
- **Consensus:** 4/6 dimensions flagged — scope calibration and premises need tightening.

### Design (UI scope: yes)
- **Score:** 6/10 completeness — loading/empty/error for search specified partially; palette quick results misleading at scale.
- **Auto-fix:** Gate quick results when live search active; single `buildSearchQuery` helper.
- **Skipped dual voices** — primary review only.

### Eng (subagent)
- **Verdict:** Plan direction OK; code not ready (ILIKE stub, no tests, FE/BE filter split).
- **Critical:** Seq scan ILIKE; snooze write-on-read; zero mail-search tests.
- **Architecture:** Parser + FTS + ingest denorm for from/to on messages.

### DX (scope: yes — TRPC API)
- **Score:** 7/10 — shared `MailSearchAst` type helps; need error messages for unsupported operators (problem+cause+fix).

### Cross-phase themes
- **Silent wrong results** — CEO + Eng + prior audit.
- **FE/BE filter channel duplication** — Eng + Design.

### NOT in scope (deferred)
- Vector/semantic search, Copilot-class NL, OpenSearch (until trigger: p95 SLO miss at N threads).

### What already exists
- `listThreads` structured filters (unread/starred/categoryIds/labelIds)
- FE command palette + utils (gated)
- Demo local search (richer than live — don't copy semantics)

### User challenge — RESOLVED
- **You said:** Feature parity with Gmail/Outlook; don't care about naming layers; skip AI/semantic v1.
- **Decision:** One server parser accepts both spellings inline (`read:no` = `is:unread`). No separate synonym module. No block on client top-10 before impl — contract tests use standard operator matrix from Gmail/Outlook docs.

### Taste decisions (remaining)
1. **Body search: excerpt vs full decodedBody** — recommend excerpt + sender fields v1; full body tier 1.5 if UAT needs it.

---

## Implementation Units (ce-plan)

### U1. ParsedSearchQuery schema + parse skeleton
- **Goal:** Shared flat query model + token parser entrypoint; contract tests fail on current ILIKE.
- **Requirements:** R-parity operators, correctness (no silent miss).
- **Dependencies:** none
- **Files:** `apps/server-pilot/src/mail/search/parse.ts`, `apps/server-pilot/src/mail/search/types.ts`, `apps/server-pilot/tests/mail-search-parse.test.ts`
- **Approach:** Zod `ParsedSearchQuery` — `freeText`, `from[]`, `to[]`, `subject`, `isRead`, `isStarred`, `isImportant`, `hasAttachment`, `after`, `before`, `labelIds`, `categorySlugs`, `unsupportedTokens[]`. `parseSearchQuery(q)` returns parsed or throws `SearchParseError` with token.
- **Test scenarios:** `from:a@b.com`; `read:no` → unread; `hasattachment:yes`; unknown `foo:bar` → error; bare text → freeText only.
- **Verification:** `vitest mail-search-parse.test.ts` green for parse-only; listThreads still ILIKE until U5.

### U2. FTS column + migration
- **Goal:** `search_vector tsvector` on `mail_thread` with GIN index.
- **Dependencies:** U1
- **Files:** `apps/server-pilot/src/db/schema/mail.ts`, drizzle migration, `apps/server-pilot/scripts/backfill-search-vector.ts`
- **Approach:** Generated column or trigger from subject + snippet + denormalized from/to excerpt on thread; `plainto_tsquery` helper in `query.ts`.
- **Test scenarios:** Migration applies; backfill sets non-null vector for seeded rows.
- **Verification:** schema-contract + manual EXPLAIN shows index use.

### U3. Ingest maintains search_vector
- **Goal:** New/updated messages refresh thread search fields.
- **Dependencies:** U2
- **Files:** `apps/server-pilot/src/mail/ingest/store.ts`
- **Test scenarios:** Ingest message updates thread vector; subject change reflected in FTS match.
- **Verification:** `ingest-store.test.ts` extended or `mail-search-fts.test.ts`.

### U4. Operator SQL builder
- **Goal:** `buildThreadSearchConditions(parsed, folder)` → Drizzle fragments.
- **Dependencies:** U1, U2
- **Files:** `apps/server-pilot/src/mail/search/query.ts`, `apps/server-pilot/tests/mail-search-query.test.ts`
- **Approach:** EXISTS for attachment; message join for from/to; category slug → id join; label: via labelIds jsonb.
- **Test scenarios:** Each operator isolated with fixture DB (pattern: `mail-category-filter.test.ts`).
- **Verification:** integration tests with `withSeededTestDb`.

### U5. Wire listThreads + drafts + trust layer
- **Goal:** Replace ILIKE; `q.max(512)`; 400 on unsupported; shared parser for drafts.list.
- **Dependencies:** U4
- **Files:** `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/src/trpc/routes/drafts.ts`
- **Test scenarios:** `from:foo` no longer ILIKE whole string; unsupported operator 400; debounce stays FE-only.
- **Verification:** `mail-search-contract.test.ts` full operator matrix.

### U6. FE honesty + capability flip
- **Goal:** Enable `gmailSearchGrammar` when server tests green; palette uses structured filters + `q`.
- **Dependencies:** U5
- **Files:** `apps/mail/lib/pilot/capabilities.ts`, `apps/mail/components/context/command-palette-context.tsx`, `apps/mail/tests/search-filter-contract.test.ts`
- **Approach:** Remove FE `parseNaturalLanguageSearch` when grammar on; toast on TRPC 400.
- **Verification:** unit + manual palette search.

### U7. E2E search
- **Goal:** Playwright asserts search returns expected thread.
- **Dependencies:** U6
- **Files:** `packages/testing/e2e/search-bar.spec.ts`
- **Verification:** e2e green in CI script.

