# Quote UI test receipts

Distinguish **earlier green** from **latest** fail/green. Do not treat a prior pass as current status.

| When (UTC) | What | Result |
| --- | --- | --- |
| 2026-10-05T23:38:36Z | `quote-workflow-scenarios` + pane tests (cached transform) | **FAIL** 1/60 — `getByText(/Selected allocation total R2,140.00/i)` vs en-ZA `R2 140,00` / stale cache showing old assertion |
| 2026-10-05T23:40:02Z | focused `does not sum RO` (stale vitest cache) | **FAIL** — stack still pointed at `getByText` after source change |
| 2026-10-05T23:40:38Z | `quote-workflow-scenarios.test.tsx --no-cache` | **PASS** 19 |
| 2026-10-05T23:40:57Z | 10 mail files (workflow + outlook-pane render/pdf/onboarding/auth) | **PASS 94** — *earlier green; RATE_TABLE native PDF fallback still present; not proof of later HEAD* |
| 2026-10-05T23:40:05Z | `@zero/server` `quote-workflow-router.test.ts` | **PASS** 6 (then 7 after default-loader test) |
| 2026-10-06T00:07Z | lucide import briefly broken (`Building2` cut mid-import) during interrupt | page.tsx syntax risk; restored before this receipt |
| 2026-10-06T00:23:04Z | mail pane+workflow after RATE_TABLE cut | **FAIL 4 / 81 passed (85)** in 8 files — `refuses convert…mailbox` missing `Run next`; three render tests expected extra `CREATE_REPLY_DRAFT` after selection change without HITL. **This is the latest visible fail the 23:42 ledger did not record.** |
| 2026-10-06T00:55:09Z | same set + backend-bind + narrow-html | **FAIL 4 then 1** (bounds expired 259 vs 258) — untracked-outcome confirm cleared then reviewed-draft gate; then in-flight click after 258th timeout |
| 2026-10-06T01:02:45Z | `outlook-pane-render` bounds expired | **PASS** 1 (29 skipped) after wait for Insert enabled + HITL before 999 confirm |
| 2026-10-06T01:04:06Z | 10 mail files (include backend-bind + narrow-html) | **PASS 94** — *latest green on this HEAD; same count as 23:40:57 but different tests/HEAD* |
| 2026-10-06T01:04:07Z | `@zero/server` `quote-workflow-router.test.ts` | **PASS 7** |
| 2026-10-06T01:10:00Z | Chromium-1243 `narrow-pane-380.png` | **captured** production `QuoteWorkflowPanel` markup at 380×900. Playwright 1.52 `chromium_headless_shell-1169` missing. Not Windows Outlook. |
| 2026-10-06T02:07:31Z | mail 10 files after leftover screenshot still present / preview generic wrapper gone | **FAIL 1 / 94 passed (95)** — `outlook-pane-quote-pdf` waited for generic `Please see attached quotation.` |
| 2026-10-06T02:08:47Z | same set after regex preview text | **FAIL 1 / 94** — reviewed HTML also lives in DocumentReview, so preview-clear assertion stayed true. Switched sentinel to `Attached: Quote-fixture-not-live-hms.pdf` |
| 2026-10-06T02:09:50Z | mail 10 files (include narrow-quoting + backend-bind) | **PASS 95** — *latest mail green after sample-UI strip; not live-ready* |
| 2026-10-06T02:09:17Z | `@zero/server` quote-workflow-router + synced-selection + workstation-router-contract | **PASS 13 / 2 skipped (15)** |
| 2026-10-06T02:13:38Z | `pnpm --filter @zero/mail build` then `pnpm --filter @zero/server build` (`tsc`) | **exit 0**. Mail `✓ built in 1m 5s`. Server tsc silent. |
| 2026-10-06T02:15:44Z | Chromium-1243 `mounted-pane-380.png` | **captured** production `OutlookPanePage` after HITL at 380×900. Tailwind CSS not loaded in dump (unstyled). No September/NCOR/`quote-rate-proof` image. Not Windows Outlook. |
| 2026-10-06T02:21:47Z | new no-fake-evidence / provenance / fixture-native tests | **FAIL 6 / 19 passed (25)** — production still synthesized fixture offers (RED). |
| 2026-10-06T02:35:30Z | mail 12 files after no-synthesize | **PASS 102** |
| 2026-10-06T02:37:38Z | `@zero/server` quote-workflow + workstation-contract | **PASS 13 / 2 skipped (15)** |
| 2026-10-06T02:42:42Z | styled pane Chromium-1243 + built `server-build-E6_kdtzl.css` | overflowX 0, paneWidth 380, Arrival 2026-11-12, Adults 2, no Allocation, unavailable copy present |
| 2026-10-06T02:52:40Z | session + stale-pdf-admission + no-fake-evidence + quote-pdf | **PASS 30 / 4 files** — late PDF after edit/offer-change rejected; late unavailable after edit rejected |
| 2026-10-06T02:54:41Z | 10 mail files (workflow + pane render/pdf/narrow/native/bind + stale admission) | **PASS 97** — *latest mail green on this HEAD; includes 2 new session + 3 deferred pane tests. Not the 02:35 102-file set.* |
| 2026-10-06T02:56:27Z | `apps/mail` `tsc --noEmit` | **pre-existing errors** (react-router `+types`, unrelated threads/admin). Not used as this branch’s type gate. |
| 2026-10-06T02:58:52Z | `pnpm --filter @zero/mail build` | **exit 0**. Client `✓ built in 1m 3s`. SSR `✓ built in 47.80s`. Oxlint 0. CSS hash `server-build-z2y6fotO.css` (screenshot still `E6_kdtzl` from 02:42). |
| 2026-10-06T03:13:35Z | session/panel/bind/step-runner/stale-pdf/no-fake/quote-pdf | **PASS 51 / 7 files** |
| 2026-10-06T03:14:07Z | `@zero/server` `quote-workflow-router.test.ts` | **PASS 8** — runStep accepts inputRevision+inputs, still unavailable, no HMS |
| 2026-10-06T03:15:08Z | `quote-workflow-scenarios.test.tsx` | **PASS 19** |
| 2026-10-06T03:17:50Z | `pnpm --filter @zero/mail build` | **exit 0**. CSS `server-build-Bzu3NXo3.css` |
| 2026-10-06T03:18:06Z | styled pane Chromium-1243 + `server-build-Bzu3NXo3.css` | overflowX 0, paneWidth 380, Arrival 2026-11-12, Adults 2, no Allocation, unavailable copy present. **Dump + DOM events, not hydrated React.** |
| 2026-10-06T03:40:07Z | session/panel/bind/step-runner/scenarios/stale-pdf/no-fake/quote-pdf/fixtures/render/narrow | **PASS 114 / 11 files** — group coverage + typed DTO + lookup≠offers. Screenshot still dump, not React. No server-pilot edits. |
| 2026-10-06T03:54:18Z | joined 12 mail files (session/bind/native-draft/panel/scenarios/fixtures/step-runner/stale-pdf/no-fake/quote-pdf/render/narrow) | **PASS 122 / 12 files** — rejected mutate, PDF DTO, exact coverage, partyRef. No failures to preserve. |
| 2026-10-06T03:57:00Z | `pnpm --filter @zero/mail build` then `@zero/server` `tsc` | **MAIL_BUILD_EXIT:0** CSS still `server-build-Bzu3NXo3.css`. **SERVER_BUILD_EXIT:0**. No server-pilot source edits. |

All Vitest runs: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Failure artifacts: `/tmp/quote-ui-vitest-latest.txt` (overwritten by later green) and this table. No silent rewrite of failing logs.
