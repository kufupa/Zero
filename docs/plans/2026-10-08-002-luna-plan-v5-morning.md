# Luna Plan v5: 2-hour morning sprint (05:55 → 07:40 UTC final deploy)

Status: DRAFT, awaiting user go. Prod `a19a260b` is healthy. Deadline: last deploy finished by **07:40 UTC (08:40 UK)**.

## Evidence (research 05:35–05:55 UTC)

- **Agency/company (R1):**
  - 70% of quote emails and 80% of booking emails name a party: agency 23%/38%, company 27%/27%, government 20%/15%.
  - 91 distinct agencies; the top 10 make up 38% of mentions.
  - `party-lookup.mjs` already returns ALL candidates `{nativeId, displayName, kind}`.
  - `fetch-quote` rateContext already accepts `nativeId`.
  - The Tourvest failure came from name-only exact matching (0 or more than 1 row → CONTEXT_INPUT_GAP).
- **Amend/cancel (R3):** 89% of amend/cancel emails have no HMS-format number, so "Find" is disabled.
  - 23% have a digit-only reference (maybe the HMS number without "-1").
  - 52 of 84 have surname + arrival. `search-guest` mode is live-verified and has a server spawn, but no tRPC route.
- **Quotes (R2, live HMS runs):**
  - 2 rooms × B&B works.
  - DBB fails only because the BAR strategy has no dinner rate. Government has NGOVDB.
  - Staff practice for non-government senders: B&B plus a dinner allowance line (already supported on the PDF, commit 683bed01).
  - The no_match is mislabelled as `native_quote_capture_scope_or_completeness_invalid`.
- **Quote speed:** `QUOTE_TRACE_ASYNC` branch, 4 commits (`5a6a4378..e48ef1e4`), saves about 44s per quote (about 35%). One conflict against main (`reservationist-evaluation-composition.ts`). Untested live.

## ROI ranking

| # | Item | Volume/day | Staff gain | ETA (Haiku lane) | Risk | Decision |
|---|---|---|---|---|---|---|
| A | **Change/cancel: find by guest surname + dates.** tRPC `paneStayLookup.searchGuest` + pane form prefilled from Luna (surname, arrival). Results list → click → open the found stay. Also try the "-1" suffix for digit-only refs | ~8 amend/cancel; ~5 usable | Find works for most change emails, not 11% | 60–75m + 10m live | Low (read-only, proven CLI) | **DO, W6** |
| B | **Agency/company picker.** "Find in HMS" next to the Company/agency field → party-lookup candidates → staff picks → `nativeId` into rateContext (reuse lane A branch plumbing + public-rate fallback). Optional: empty = today's behaviour | 70% of quotes | Contract/agency rates instead of public BAR | 90–110m + 15m live | Medium (touches the quote request; must stay optional) | **DO, W7** (ships only if live-proven by 07:15) |
| C | **DBB without a government rate.** (1) A distinct `no_matching_rate` code + plain copy. (2) A one-click "Quote B&B + dinner allowance" path (staff enter the amount; never invented) | DBB 29% of quotes; most are government (already fine) | No dead end on dinner requests | 45–60m | Low | **DO, W6** |
| D | **Quote ~44s faster.** Rebase `QUOTE_TRACE_ASYNC`, resolve the conflict, ship flag-off in W6; flip it ON in prod env after 2 live quote+PDF runs pass | every quote (~6–16) | 4.5 min → about 3 min each | 30m + 15m live | Medium (PDF waits on the trace) | **DO, W6 code; flag ON only if live passes** |
| E | **Installer SHA-256 in docs.** Download the prod installer, compute the hash, fill the "TBC" in the install doc | each install | Removes an install blocker | 10m | None | **DO (orchestrator)** |
| F | Live API checks: Tell Luna (staffNote), Treat-as, multi-date analysis | ~7 | Proof, not new code | 15m | None | **DO in smoke** |
| — | Windows Outlook path, zero_admin rotation, doc placeholders | — | — | needs you / IT | — | **YOURS** |
| — | Booking-code autofill, Outlook colours, chatbot, venue, parallel HMS | — | — | — | — | **SKIP** (your call) |

## Lanes and timeline (UTC)

| Time | Lane A (Haiku) | Lane B (Haiku) | Lane C (Haiku) | Orchestrator (Opus) |
|---|---|---|---|---|
| 05:58–06:45 | A: searchGuest route + pane form + "-1" retry | B: party-lookup server route (pane spawn env) + pane picker | C: no_match code/copy + B&B + dinner path; then D rebase + conflict | E installer hash; F live API checks |
| 06:45–07:00 | — | B: wire nativeId into rateContext (lane A branch) | — | **W6**: Opus review → PR → merge → deploy (A, C, D flag-off, E) |
| 07:00–07:15 | — | B: finish + tests | — | W6 smoke: searchGuest live, DBB copy; D: 2 live quotes with `QUOTE_TRACE_ASYNC=on` → keep on if quote + PDF pass |
| 07:15–07:35 | — | — | — | **W7** (B, if live party lookup + nativeId quote pass) → deploy → smoke |
| 07:40 | | | | **Freeze**, HANDOFF_DONE, handoff update |

**Cut order if behind:** B (stays as a PR) → C part 2 (keep only the copy) → D flag stays off. Never cut: W6 smoke, rollback readiness.

## Rules (unchanged from v4)

- Haiku implements. Opus reviews once per wave and owns HMS/deploys.
- 2 failed attempts or 20 min without new evidence → park.
- No real-guest writes. `RESERVATIONIST_PANE_SAVE` stays unset. No migrations.
- Run `chmod u+w .husky/_/h` before every deploy. Greptile 1 round; P1s fixed, P2s → handoff.
