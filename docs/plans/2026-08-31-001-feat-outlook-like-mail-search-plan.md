---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
plan_depth: standard
date: 2026-08-31
origin: ce-debug 2026-08-31 NexCT empty search
---

# feat: Outlook-like mail search that finds senders and HTML mail

## Goal Capsule

Make All-folders search find hotel mail the way Outlook Instant Search does: type a brand, domain label, or body word and the thread appears. Keep one Postgres FTS path. Do not add a second search engine, AI, or pg_trgm.

- **Authority:** Pilot-RDS safety overrides tests-against-pilot. Matching correctness for visible (non-trash, non-spam) threads overrides the 2026-07-08 “plainto_tsquery is enough” choice. July 8 Gmail-only operator grammar stays.
- **Execution profile:** TDD on disposable Postgres. Historic `search_vector` needs the existing SSM backfill after the SQL expression changes. No Vitest on `nava-zero-mail-pilot`.
- **Stop conditions:** Missing disposable test DB blocks DB-backed tests. Pilot proof is count-only SQL/API, never seeded fixtures against pilot.
- **Tail ownership:** Implementation owns tests and code. Deploy + backfill need explicit ops authorization (same wrapper as `docs/solutions/workflow-issues/outlook-search-fts-backfill-pilot-deploy.md`).

Product Contract unchanged from this bootstrap (no prior requirements-only artifact).

---

## Product Contract

### Summary

Reservation staff type a sender brand or domain fragment (for example `nexct`) in the Outlook-style search bar and must see those threads. Search must also hit words that exist only in HTML bodies. Typing updates the list after a short pause, like Outlook Instant Search.

### Problem Frame

2026-08-31 diagnosis (read-only pilot counts, totals only):

- 38 visible messages from addresses matching `%nexct%`. All 38 have `text_body` null and HTML that contains the brand. Subject never contains the brand.
- `search_vector @@ plainto_tsquery('simple', 'nexct')` hits **0** of those 38 threads.
- Postgres `ts_debug('simple', 'info@nexct.co')` yields one `email` lexeme `info@nexct.co`. `to_tsvector` of that string does not contain `nexct`.
- Splitting `@` and `.` into spaces makes FTS match `nexct` (synthetic proof).
- The screenshot query was `nextct` (extra `t`). That exact token also misses. Extra-character typos stay out of scope without `pg_trgm` (extension absent on pilot). Prefix search still helps the common “type the start of the brand” path (`nex` → `nexct`).
- Drafts already substring-match subject/body (`buildDraftSearchConditions`). Threads do not. Staff feel threads are “broken” next to drafts.
- `from:nexct` already works via ILIKE. Bare free text does not use that path (`apps/server-pilot/src/mail/search/query.ts` freeText branch).

### Actors

- A1. Hotel mailbox user on the published mail SPA.
- A2. Implementer running disposable-DB Vitest and, after land, SSM backfill.

### Requirements

- R1. Bare free text must match domain labels and local-parts in From over the 20 most recent messages (email `info@acmehotels.test` is found by `acmehotels`). `to:` stays an operator; free text does not index To.
- R2. Bare free text must match words that appear only in HTML when `text_body` is null or blank (HTML-only inbound). Style/script stripped before the 8k cap.
- R3. Free-text tokens use prefix matching when length ≥ 3 (`nexct` and `nex` both hit `nexct`; `n`/`ne`/`co` do not run a prefix query).
- R4. Search list updates while typing after 300ms idle, without writing every keystroke into recent searches. Enter still commits and saves recents.
- R5. All-folders search still excludes Trash and Spam. Empty state stays honest: quoted query, Clear, Try All folders when scoped.
- R6. Existing Gmail operators (`from:`, `to:`, `is:unread`, `has:attachment`, dates, labels, categories) keep current meaning. Unsupported operators still 400.
- R7. No Vitest / test runner against pilot RDS. Backfill is the existing script via SSM. Logs stay totals-only.

### Acceptance Examples

- AE1. Thread whose latest inbound From is `info@acmehotels.test`, subject without that brand, HTML-only body containing “AcmeHotels”: `q=acmehotels` and `q=acme` return that thread; `q=zzzxxyy` does not.
- AE2. Same thread is absent from results when it is trashed or spam and folder is `all`.
- AE3. Typing `acmehotels` in the search box, pausing 300ms, loads results without pressing Enter. Recents do not gain that string until Enter.
- AE4. `from:alice@corp.com` and `is:unread` still filter as today. `kind:email` still 400.

### Flows

- F1. Type brand → debounce → `listThreads` with `q` → FTS prefix on normalized vector → list or empty state.
- F2. Enter → same query + save recent.
- F3. Filters chips / `from:` operator unchanged.

### Scope Boundaries

#### Included

- Normalize FTS source text (punctuation split + HTML fallback) in `threadSearchVectorSourceSql`.
- Replace `plainto_tsquery` with sanitized prefix `to_tsquery`.
- Debounced live search; recents only on explicit commit.
- Remove the dummy “From {whatever you typed}” suggestion (ILIKE `from:` remains under Filters → From).
- Disposable-DB tests for sender-domain and HTML-only cases.
- Plan the existing backfill script after land (ops, not a new tool).

#### Deferred to Follow-Up Work

- Typo / edit-distance (`nextct` vs `nexct`). Needs `pg_trgm` or a did-you-mean index; extension is not on pilot.
- Real people suggestions from mailbox senders.
- Relevance ranking (`ts_rank`) — would break latest-message keyset pagination.
- Outlook operator aliases (`hasattachments:yes`, `read:no`). Staff typed a brand, not Outlook syntax. 2026-07-08 grammar stays.
- Filling `message.text_body` at ingest for snippet display (search_vector HTML fallback covers search).
- Semantic / AI search.

#### Non-Goals

- Dual ILIKE+FTS free-text path (drafts keep substring; threads stay FTS once the vector is honest).
- New search service, extension, or column. Expression + existing GIN only.
- Searching Trash/Spam in All folders.
- Changing folder chip / Views chrome.

---

## Planning Contract

### Assumptions

- Pilot `pg_trgm` stays unavailable; do not plan `CREATE EXTENSION`.
- `simple` FTS config remains (`THREAD_SEARCH_VECTOR_CONFIG`).
- Historic threads keep old vectors until SSM backfill; new ingest refreshes per thread today.
- Dummy From suggestion is not required for AE1 (`from:` chip still exists).

### KTD1. One normalized FTS source, not a second matcher

Put punctuation splitting and HTML-or-text body into `threadSearchVectorSourceSql` so ingest refresh and `backfill-search-vector.ts` stay one expression. Do not OR free text with `LIKE` on `from_address` (that duplicates `from:` and hides indexer bugs).

### KTD2. Prefix `to_tsquery` from a pure tokenizer

`plainto_tsquery` cannot add `:*`. Build `'token1':* & 'token2':*` from `[a-z0-9]+` tokens of length ≥ 3 (quoted lexemes so `and`/`or`/`not` cannot 500). Reject empty/punctuation-only/`co` queries as match-nothing (`false`), not as “no search filter”. Bound `to_tsquery` param; never `sql.raw`.

### KTD3. Live list vs recents

Reuse `useDebouncedValue` (300ms) to copy idle input into `searchValue.value` **and** `highlight`. Live-skip tokens shorter than 3 and unknown operators (`kind:`). Enter flushes immediately and `saveRecentSearch` (unsupported ops still 400). Clear/`resetVersion` beats a pending timer (`debounced !== local` → no write). List queries use `placeholderData: (previousData) => previousData` so `q` changes do not full-spinner.

### KTD4. Ops: expression change then existing backfill

No drizzle migration. After code lands on the deployable ref, run the existing SSM backfill. Verify with count-only SQL: visible From-ILIKE threads missing FTS = 0 (FTS may exceed ILIKE). Trash/spam predicates match `listThreads` folder=all.

### Technical Design

```
search box localSearch
    │ debounce 300ms (no recents)
    │ Enter → commit + recents
    ▼
parseSearchQuery → freeText + operators
    ▼
buildFreeTextTsQuery → `'acmehotels':*`
    ▼
mail_thread.search_vector @@ to_tsquery('simple', ...)  -- bound param
    ▲
to_tsvector('simple', normalize(subject+snippet+from[20]+bodies))
normalize: strip style/script/tags when text empty; then left 8k; replace [@.]+ with space
```

Failure: leftover tsquery operators cannot appear if the builder only emits quoted `[a-z0-9]` lexemes plus `:*` and `&`. Over-long `q` still 512-cap at input schema. Live `kind:` does not fetch.

Performance: GIN already on `search_vector`. Prefix queries use that index. Min token length 3 avoids `co:*`. HTML `regexp_replace` runs at backfill/ingest on `left(html, 200000)`, not per list keystroke.

Security: `listThreads` stays `mailboxProcedure` + `transportId`. Backfill logs counts only.

### Sequencing

U1 tokenizer + vector SQL (tests first) → U2 wire `query.ts` → U3 FE debounce/recents/suggestion + list `placeholderData`/a11y → U4 backfill runbook in the executable plan (ops after land).

### Risks

| Risk | Mitigation |
|------|------------|
| Historic mail still misses until backfill | Ship expression + refresh-on-ingest; ops backfill before claiming pilot green |
| Prefix `co:*` floods GIN | Min token length 3 |
| HTML regexp too greedy | Cap unchanged 8k × 20 messages; strip tags only |
| Live search spams recents | Recents on commit only |
| Live `q` flashes full-list spinner | `placeholderData` on list queries; footer `isFetching` spinner stays |
| `nextct` typo still empty | Deferred; empty state stays honest |

---

## Implementation Units

### U1. Normalized search text + prefix tsquery (server-pilot)

Files: `apps/server-pilot/src/mail/search/search-vector.ts`, `apps/server-pilot/src/mail/search/query.ts` (`buildFreeTextTsQuery` in the same file as the one caller), always-run `apps/server-pilot/tests/mail-search-free-text-tsquery.test.ts` (gate), DB cases in `apps/server-pilot/tests/mail-search-query.test.ts`, `apps/server-pilot/tests/mail-search-fts.test.ts`.

Depends on: none.

Test scenarios: quoted `'and':*`; `co` → null; email From `info@acmehotels.test` matched by `acmehotels`; HTML-only body word matched after fat `<style>` head; `plainto` control that current code misses the email case (write failing first); prefix `acme`/`nex` hits; `zzzxxyy` misses; punctuation-only and `q=co` match nothing; HTML 20/8k caps.

### U2. listThreads uses prefix tsquery

Files: `apps/server-pilot/src/mail/search/query.ts`, contract tests `apps/server-pilot/tests/mail-search-contract.test.ts`.

Depends on: U1.

Test scenarios: `listThreads` AE1 (HTML-only + `info@acmehotels.test`); AE2 folder=`all` omits trash/spam siblings; bound `to_tsquery`; `kind:email` still 400.

### U3. Instant Search UX

Files: `apps/mail/lib/mail/search-list.ts` (`shouldLiveApplySearch`), `apps/mail/components/mail/mail-search-bar.tsx`, `apps/mail/hooks/use-threads.ts` (`placeholderData` on list queries), `apps/mail/components/mail/mail-list.tsx` (a11y + muted miss hint), tests `apps/mail/tests/search-list.test.ts`, `apps/mail/tests/mail-search-bar.test.tsx`, `apps/mail/tests/demo-mail-list-perf-guards.test.ts`. Do not edit `use-search-value.ts`.

Depends on: none (can parallel U1).

Test scenarios: 300ms live write of `value`+`highlight`; tokens shorter than 3 do not live-write; `kind:` does not live-write (Enter still commits); Enter flushes + recents; Clear beats pending timer; dummy From gone; list keeps prior rows while refetching (`placeholderData`); miss headline unchanged.

### U4. Pilot backfill + count proof (ops)

Files: none new. Reuse `apps/server-pilot/scripts/backfill-search-vector.ts` and `docs/solutions/workflow-issues/outlook-search-fts-backfill-pilot-deploy.md`.

Depends on: U1–U2 landed and deployed.

Proof: count-only SSM SQL; `from_ilike_missing_fts = 0`; print ILIKE and FTS totals separately (FTS may be higher). SHA-gate expression fingerprint (`html_body` + strip + `[@.]+`). No PII in stdout.

---

## Verification Contract

- Local: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- Disposable DB: `CONFIRM_DISPOSABLE_TEST_DB=1` + `TEST_DATABASE_URL` not containing `nava-zero-mail-pilot`.
- Commands: `apps/server-pilot/deploy/mail-search-gate.sh` (tokenizer + parser + FTS + contract + query) plus `apps/mail` search-bar, search-list, list-perf, and use-threads ownership unit tests.
- Pilot: health + count-only SQL after backfill. Never Vitest on pilot.
- FE: existing Playwright search-bar empty-state still valid (Enter path). Live timing is unit-tested only.

---

## Definition of Done

- AE1–AE4 have failing-then-passing disposable-DB or unit tests.
- Dummy From suggestion removed; live debounce + recents-on-Enter covered; tokens shorter than 3 and `kind:` skip live; list `placeholderData` so live `q` does not full-spinner.
- AE2: `listThreads({ folder: 'all' })` omits trash/spam.
- `mail-search-gate.sh` green on disposable DB.
- Executable TDD plan executed or queued via `/nava-run`.
- Pilot green only after authorized deploy + backfill + count proof.

## Open Questions

- Q1 (deferred): typo tolerance for extra-character queries (`nextct`). Not blocking.
- Q2 (deferred): real sender autocomplete.

No blocking product questions.

Canonical TDD execution plan: `docs/superpowers/plans/2026-08-31-outlook-like-mail-search.md`.
