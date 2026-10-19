# 2026-10-19 party v3 lane briefs

Coordinator: Opus chat "B2 party design" (worktree `oct19-party-eval`). Plan: [party v3](2026-10-19-party-lookup-v3.md). Evidence: [party evidence](../research/2026-10-19-party-lookup-evidence.md). **Read only this file + your lane section. Do not read other docs unless your section names them.** The facts below are settled; don't re-verify them.

## Rules (every lane)

- Own worktree, own branch from `origin/main`, only your listed files. One behaviour per PR, ≤ ~500 product lines.
- **Never on this VPS:** `tsc`/`tsgo`/typecheck scripts, Vitest or any test runner. Typecheck: `bash /home/orca/bin/remote-typecheck.sh <worktree>`. Tests: `bash /home/orca/bin/remote-vitest.sh <worktree> <test files>` (EC2). `node --test` on one `.mjs` file is OK. First `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`.
- **Never:** live HMS, SSM, deploy, env/flag change, email, `--no-verify`, `git stash`, `pkill -f`, new GitHub workflow. No PII in git/PR text (hash names of guests/staff).
- Gate: commit → `greptile review` (`--apex` if > 500 lines) → fix or validate each P1 (2 rounds max) → push → `gh pr create` → reply `READY #<n>` + Greptile result + what's unproven. Coordinator merges.
- Start coding at once. Unchecked facts go in the PR body as assumptions. Timebox = your section; at the box, push what's green and say what's left.

## Settled facts

- F2 #390 (`bc856082c`) merged: `party-lookup.mjs` takes `{searches:[{kind,name}], stopOnFirstHit}` = one CDP connect + one login + one screen; `findPartyJob(searches, …)` in `pane-party-lookup.ts` = one spawn, one lock hold; per-search `phaseMs`. Cost ≈ 16 s fixed + 4–10 s per search (HRDAV probe 14:40Z).
- HMS party grid columns: Booking Agency Name / Name, IATA/Reference Number, Address, City, Country, External ID (`GRID_HEADER_RE` in `party-lookup.mjs`). Results keep only `{kind,nativeId,name}` today.
- HMS returns duplicate copies in a stable order not sorted by id or name (Tourvest ×13: 280, 543, 6, 123, …). Copies seen: Tourvest Travel Services 13, Travel With Flair 3, Rennies/Flight Centre/WebBeds/Cullinan/BCD ×2.
- Quote rate search (`fetch-quote.mjs` `pickerFilter`/`matchReference`): `agency` has no `idFilter`, so it matches by name and throws `AMBIGUOUS_REFERENCE` on duplicates; `codeFilter` is `ff_iatanumber`.
- Reservation read (`commercial-fields.mjs` `party()`): keeps an id only when the field value ≠ the name; prod agency always loses its id.
- Bind rule today: `applyPartyBindRule` in `party-match-v2.ts` (high confidence, untruncated, unique strongest claim). Candidate builder `buildPartyMatchCandidates`; V2 job `runPartyMatchV2` area in `hms-jobs.ts` (~line 2280–2430).
- Prod misses since 10-14 (153 V2 lookups, 24 bound): SynXis/channel notices 53 (0 bound), duplicate ties 43, no rows 24, junk terms ("South Africa", "For", disclaimers) fill the 25-row cap.

## Lane P2 — no party lookup on booking-system notices (Luna max, 40 min)

- Files: `apps/server-pilot/src/ai/hms-jobs.ts` (party prefetch gate, the function that calls `selectPartyMatchV2PrefetchRequest`, ~line 1800–1850), `apps/server-pilot/tests/hms-jobs.test.ts`.
- Do: return 0 (no party job) when the extraction payload has `origin === 'system_notice'`, or the source is not direct / the thread is an automated channel. Reuse the existing helpers the quote-prep path uses (`sourceClassification`, `threadIsAutomatedChannel`, ~line 2050). No sender-name or "synxis" string rule.
- Tests: notice → no job; direct agent quote → job; automated-channel thread → no job.

## Lane P3 — keep the data HMS already shows (Grok 4.6 high, 50 min)

- Files: `apps/server-pilot/tooling/playwright-quote/party-lookup.mjs`, `party-lookup.schema.json`, `party-lookup.test.mjs`; `apps/server-pilot/src/ai/pane-party-lookup.ts` + `tests/pane-party-lookup.test.ts`; `apps/server-pilot/tooling/playwright-quote/commercial-fields.mjs` + its test; `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs` + `fetch-quote.test.mjs`.
- Do:
  1. Each result row also carries the optional `iata`, `city`, `address`, `country` and `externalId` taken from the store record, and they survive through `pane-party-lookup.ts`.
  2. In `commercial-fields.mjs`, keep the agency/company id from the id field even when its value equals the name only if it's numeric; otherwise read the id from the select's value. Add a test with a fixture.
  3. In `fetch-quote.mjs`, when an agency reference has an `iata`/`code`, use `codeFilter` so duplicates resolve to one row. Unchanged when absent.
- Tests: a row keeps its columns; two same-name agencies + iata → one match; no iata → `AMBIGUOUS_REFERENCE` (unchanged).

## Lane P5 — the reservationist loop (Grok 4.6 high, 60 min; flag `PARTY_MATCH_V3`, default off)

- Files: new `apps/server-pilot/src/ai/party-match-v3.ts`, new `apps/server-pilot/tests/party-match-v3.test.ts`; `apps/server-pilot/src/ai/hms-jobs.ts`, only the V2 run branch: if `PARTY_MATCH_V3` is on, call v3 instead. Same result shape as V2 plus `matchVersion: 3`, so the pane and quote-ready keep working.
- Loop (directional):
  1. **Round 1:** the LLM reads the email context (`partyMatchEmailContext` + extraction + `buildPartyMatchCandidates` as hints) and proposes ≤ 5 `{kind, term}` it would type. One `findPartyJob` batch.
  2. The LLM sees all rows with columns. It returns `{pick: nativeId|null, kind, confidence, reason, nextTerms?}`.
  3. **Round 2** runs only if there's no pick and `nextTerms` is set: ≤ 3 terms, one more batch. Then stop.
  4. Guard: drop empty or 1–2-character terms and dedupe. Never more than 2 batches.
  5. Model unavailable → fall back to the V2 deterministic picker on the rows.
- Bind: reuse `applyPartyBindRule`, plus a duplicate rule. When ≥ 2 rows share the picked name, bind only if a column in the email matches exactly one copy (city or IATA) or the sender history (`party_sender_map`) names that id. Otherwise `needs_pick` with all copies first. Resolve company and agency separately when the email has both.
- Tests: 13 same-name rows, no column → needs_pick listing all; email says "Cape Town" + one Cape Town copy → bind that copy; round 1 empty → round 2 runs ≤ 3 terms, then stops; model throws → V2 fallback; flag off → V2 path unchanged.
- A coordinator message with the step-0 duplicate rule may arrive mid-lane. Fold it in if it lands before READY.

## Lane S0a — where the reservation screen holds the agency id (Sol high, computer use, read-only, 20 min)

Run by the coordinator, not a coding lane.
