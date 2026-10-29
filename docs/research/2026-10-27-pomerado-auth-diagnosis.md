# Pomerado authentication diagnosis and local session reuse

2026-10-27. Ask 327. Diagnosis only; no live browser, mint, production change, tool publication or new test. Vendor source inspected at `7349a1c2`; Nava worktree at `92be0e5d2`; `origin/main` at `3a5b3f315`. The earlier [local login-first retro](../context/ledger/2026-10-27-pomerado-login-first-retro.md) and [native MCP source review](2026-10-27-pomerado-native-mcp.md) did not establish a local login cause or an authenticated-page integration seam, respectively. This report adds the Cloud job and saved-login metadata and a focused source trace, not another HMS trial.

## Cloud observations and limits

| Observation | Evidence and limit |
|---|---|
| Cloud entered checking-login, then exploration | Job started 21:54:06Z; user answered secure login 21:55:45Z; checking-login completed 21:56:19Z; exploration completed 21:59:35Z. Protected response retained under `.private/pomerado-readstay/`; no raw credentials or guest data in this report. |
| Cloud reported its login was verified and saved | Origin-scoped login metadata returned `verified`, verified at 21:56:23.677Z, and `locked`; terminal job's `login_save.status` was `saved`. Vendor reports verification; actual authenticated tenant/property was not independently established. The stored login was neither changed nor deleted. |
| A later fresh run did not continue as expected | At 22:13:45Z Pomerado asked for a stable launch route and reported that the supplied tenant login worked but a fresh run returned to the generic login page. We said no separate launch route was known and directed it to the supplied tenant URL, without inventing one. This is vendor-reported behavior, not a captured browser trace. |
| Build failed | At 22:23:28Z the job returned `website_sign_in_unavailable`, `retryable: true`, with empty details. No published tool or Stay 360 screen resulted. Vendor reports it stopped before changes; this is not an independent audit of every HMS operation. |
| Cloud traces not available through this account | Read-only build activity request returned HTTP 403 `business_account_required`. The specific transition and actual site/page state remain unknown. The [sign-in guide](https://docs.pomerado.ai/guides/build/sign-in-during-a-build) distinguishes `credentials_rejected`; this job did not return that error. It does not prove that credentials were never rejected internally. |

The [Cloud build API](https://docs.pomerado.ai/api-reference/builds/build-a-tool) documents `start_url` as preserving the supplied path, query and fragment on the initial start page, while `site_url` is an origin. These inputs were supplied appropriately. This does **not** establish what later fresh-run navigation did. Do not transfer local source behavior to Cloud without version and trace evidence.

The saved login remains in the owner's Pomerado account. [Vendor documentation](https://docs.pomerado.ai/guides/logins/give-a-job-a-login) says Personal accounts lock the username after first verified sign-in. No conclusion about who chose the saved-login option or why it was saved is established. Do not delete or modify it without owner direction.

## Local integration: source observations

- Nava's `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:162` accepts a Playwright page, uses the named Infor fields, submits, and checks the authenticated tenant/property. The earlier independent login is a separate success, not Pomerado proof. Saved storage is not a full in-memory page snapshot.
- Stock Pomerado standalone refuses Chromium DevTools Protocol attachment: `/home/orca/pomerado/typescript/src/standalone/session.ts:10`; existing unit contract at `/home/orca/pomerado/typescript/tests/unit/standalone-cdp.test.ts:5`. This is intentional, because reset can close tabs and clear data.
- The documented standalone `--endpoint` is a Playwright websocket, not a CDP page handoff; the worker still creates a new context and page: `/home/orca/pomerado/docs/getting-started.md:221`, `/home/orca/pomerado/typescript/src/execution/playwright-worker.ts:407`.
- A lower-level executor can use an existing default-context CDP page, sometimes via a target ID, but rejects pages in another client's created context: `/home/orca/pomerado/typescript/src/execution/playwright-execute.ts:22`, `/home/orca/pomerado/typescript/src/execution/playwright-worker.ts:57`. It is not wired into standalone mint. Removing the prohibition alone does not make shared-slot resets safe.
- Mint starts by navigating; later runs can reset to the site root, close other tabs and, in some unverified-login cases, clear storage: `/home/orca/pomerado/typescript/src/standalone/mint-state.ts:55`, `/home/orca/pomerado/typescript/src/runtime/start-state.ts:428`. A logged-in page is not sufficient evidence that the login survives these stages.
- Served tool operations create fresh contexts. A long-lived library scope can instead share a context across its runs: `/home/orca/pomerado/typescript/src/standalone/run-operation.ts:22`, `/home/orca/pomerado/docs/how-it-works.md:230`. Pomerado's sign-in tracker separately requires its own identifier and submission proof: `/home/orca/pomerado/typescript/src/runtime/start-state.ts:102`. External login is not automatically a verified native recipe.

## Candidate routes, not fixes

1. **Preferred candidate:** have trusted host code run Nava's existing deterministic login on Pomerado's own dedicated page, then let Pomerado explore it. This needs an explicit host/worker initialization integration and private credential access; the worker does not inherit the host environment. The design must address later navigation, resets, verification, and login on each fresh generated-tool run. Treat this as a bypass experiment for the failure, not a proven root-cause fix or an existing supported standalone option.
2. **State transfer:** inject Nava's protected Playwright storage state into a fresh Pomerado context. This may be smaller, but cookies/local storage alone are not proof of complete HMS session transfer. Session storage, page memory, expiry, identity and server binding remain untested.
3. **Attach existing browser:** wire the lower-level CDP executor into a dedicated compatible page and redesign ownership/reset behavior. Existing default-context restrictions and potential tab/data destruction make this more invasive than passing an endpoint. Never experiment on the shared live slot without an appropriate property lock and ownership design.

Credentials must remain in the trusted private path, never in model prompts, generated source, ordinary logs or this report. The trial remains read-only, with the existing HRCEN property lock and private-data boundaries. User-selected Luna-max role routing applies to any future local trial. None of the three routes is proven to work end to end.

## Falsifiable leads

| Possible explanation | Grounding | Discriminating observation |
|---|---|---|
| Later navigation omits the tenant route or query | Vendor reported a fresh run reached generic login; local source contains origin resets, but Cloud internals/version are unknown. | Cloud trace shows the tenant URL/query present after initial sign-in but missing at the failed transition. If retained, the missing-query theory is weakened. |
| Fresh context or reset loses needed session data | Vendor reported an earlier verified login and a later fresh run at login. | Compare redacted context/page identity and non-secret storage presence after login and after reset. If the same required state persists, look elsewhere. Never capture token values. |
| Sign-in detection misclassifies the screen | Upstream [#391](https://github.com/Pomerado/pomerado/issues/391) and [#437](https://github.com/Pomerado/pomerado/issues/437), with proposed [#438](https://github.com/Pomerado/pomerado/pull/438), report other classification cases. | Compare visible login controls and tenant/property shell with the classifier result at the failure point. These public reports do not establish that Cloud hit either bug. |

The Cloud root cause is unconfirmed. If the owner chooses to pursue Cloud, the vendor can inspect the private internal trace for the job; we did not contact them. If the owner authorizes a local experiment, the discriminating first milestone is same dedicated page, verified tenant/property, read-only Stay 360; then independently verify fresh-context replay. Preserve the selected screenshot case and original three-case read proof as separate outstanding scope.

No solution was implemented or verified; `ce-compound` was invoked for lane close but no solved-problem solution document is warranted.
