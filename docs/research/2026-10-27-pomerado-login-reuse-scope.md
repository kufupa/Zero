# Existing Nava hotel login and Pomerado handoff scope

2026-10-27, owner ask 329. Read-only source and plan investigation. No live hotel, browser, trial, product build or secret retrieval.

## What already exists

| Capability | Source | What it establishes |
|---|---|---|
| Deterministic login | `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:162-183` | Existing `login(page, secret, env)` navigates to the selected login URL, fills credentials, submits and waits for the authenticated shell. It can use either property's supplied configuration. |
| Property verification | Same file `:89-102` | Shell check compares expected tenant, property code and property name. |
| Existing page reuse | `apps/server-pilot/tooling/playwright-quote/hms-slot-lease.mjs:108-131` | The page lease finds an authenticated page or creates a page and calls that same helper, then hands the page to its callback. |
| Actual production consumer | `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:11-19,29-42,962-993` | Quote code imports the shared helper, validates the selected property's secret, and uses the leased page. This is source evidence, not a fresh live execution. |
| Property separation | `apps/server-pilot/src/hms/hms-read-target.ts:44-58,96-100`; `apps/server-pilot/tooling/playwright-quote/property-registry.mjs:46-78` | HRCEN and HRDAV have separate property registrations, browser slots and credential references. The same helper is parameterized; the Da Vinci URL does not authenticate Centurion. Do not print credentials. |
| Lock qualification | `apps/server-pilot/tooling/playwright-quote/read-cli-lease.mjs:77-100,128-148` | The lease can use the actual Postgres property lock or a real parent holder, but can also fall back to a process-local development lock. The real lock remains required for this hotel trial. |
| Existing session-transfer probe | `apps/server-pilot/tooling/playwright-quote/session-reuse-probe.mjs:29-72` | Existing code tests restoring storage state into a new context; its existence alone does not prove that the current HRCEN session or Pomerado can use it. |

The earlier 43-minute line was poorly named: the plan already proposed reusing `login`, so it was a rough allowance for the **Pomerado handoff and checks**, not time to invent a new login. No implementation time for that handoff was measured. The previous 135-minute total therefore did not separately include a second 43-minute login implementation, and a 50-minute saving is not established by the login helper's existence alone.

## Pomerado handoff

The pinned Pomerado standalone host rejects CDP attachment (`typescript/src/standalone/session.ts:10-18`) and its worker creates its own page (`typescript/src/execution/playwright-worker.ts:407-421`). Passing Nava's already-authenticated borrowed page straight to the native mint is therefore not a stock feature. The lower-level CDP executor can adopt a compatible **default-context** page, while Nava's `attachBorrowedSession` creates a different context; the vendor's operation test does not prove minting (`typescript/tests/browser/native-cdp-attach.spec.ts:196`). Do not attach the shared production browser.

A smaller candidate than the previous new-worker-message design is to use Pomerado's existing host `browser.execute`, which already runs code against the worker's `page` (`typescript/src/execution/playwright-execute.ts:77-88,411-415,435-443`; `playwright-worker.ts:223-267`). On the coding VPS, an offline `node:vm` `compileFunction` probe with an empty environment used `createRequire` to load the unchanged `.mjs` helper and returned `login: function` and `propertyCheck: function`. This was Node 22.23.1, did not launch a browser or read secrets, and does not prove the actual Pomerado worker, credentials, Product EC2 Node 24 or live login. The last EC2 build historically used Node 24.22.1; current runtime is unverified.

Plan the smallest fixed host-authored helper call after the mint's `state.start.enter`, plus the same call after `startPage` in the actual fresh replay. The model does not receive login values. One candidate for secret delivery is a uniquely created mode-0600 one-use file inside `.private/pomerado-readstay/`, removed on success or failure before generated code runs. This is **not** a same-user sandbox; the same OS user can read the file while it exists. If the approved boundary cannot be met, fall back to the earlier dedicated worker-message design. Neither option has been implemented or timed.

A `storageState` probe is available in Nava but does not prove portable HRCEN authentication in Pomerado. Fresh contexts, reset behavior, native artifact publication and full one-screen stop still need their own proof. The requested experiment remains HRCEN unless the owner chooses otherwise; its private data and actual property lock remain.

## Revised conditional timing

The previous 43-minute label was misleading because the helper was already included as reusable. The new source finding removes a *proposed new worker protocol* from the default path; it does not prove zero handoff work. The previous 43-minute line is reassessed as an 18-minute working allowance for a fixed host call and check. This is a judgment informed by source and the offline module-load probe, not a measured implementation duration. The total working estimate changes from about 135 to about 110 minutes; no successful hybrid benchmark or measured saving exists. This estimate excludes the original screenshot and three-case proof.

