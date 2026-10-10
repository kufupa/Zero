---
title: Outlook Pane Quote Routes Empty Because tRPC Client Fails typeof Object Guard
date: 2026-10-08
category: integration-issues
module: outlook-pane
problem_type: integration_issue
component: frontend_stimulus
severity: critical
symptoms:
  - "Outlook side pane shows 'Luna cannot read emails in this pane yet. Refresh the pane and try again.'"
  - "Quote panel shows 'Quoting is not connected to this pane yet' and 'PDF creation is not connected to this pane yet'"
  - "Bridge grants requests (200 on bridgeTicket and native authorize) but zero quoteWorkflow.analyseSelection requests reach the server"
root_cause: wrong_api
resolution_type: code_fix
tags: [trpc, typeof-guard, proxy, outlook-pane, quote-workflow, client-binding]
---

# Outlook Pane Quote Routes Empty Because tRPC Client Fails typeof Object Guard

## Problem

In the Outlook side pane, Luna could not read the selected email, and the quote, PDF and change/cancel features were disabled. This happened even though the add-in bridge and authorization succeeded. The pane never sent its analysis request, and the quote, PDF and change/cancel routes were never bound.

## Symptoms

- Pane: "Luna cannot read emails in this pane yet. Refresh the pane and try again."
- Quote panel: "Quoting is not connected to this pane yet" and "PDF creation is not connected to this pane yet".
- Bridge ticket and `/api/outlook/native/authorize` returned 200.
- Server access log showed zero `quoteWorkflow.analyseSelection` requests from the pane.
- Served page chunk (pre-fix build) contained `typeof t!="object"?{}` and `if(!t.mutate)return{kind:"unavailable",reason:"Luna cannot read emails in this pane yet..."}`.

## What Didn't Work

- Reading "cannot read emails" as an Outlook add-in or Office.js read failure. The wording points there. Bridge grants and authorization returned 200, which ruled the add-in out. The text was a client-side fallback, not an Outlook or server error.
- Attributing the symptom to other fixes in the same window. Add-in 1.0.16 (UI-thread fix), PR #55 (canonical Message-ID) and PR #56 (follow after draft writes) were real, separate bugs. None of them touches the pane's tRPC binding.
- Trusting the existing unit tests. `apps/mail/tests/quote-workflow-backend-bind.test.ts` builds plain objects such as `{ quoteWorkflow: { analyseSelection: { mutate } } }`. Plain objects pass a `typeof === 'object'` check, so the suite stayed green while production received `{}`.
- Spending time on the add-in because its generic "Native request denied" message hid the real reasons. Diagnostics had to be added first (session history).
- What worked: counting server-side route calls. Successful grants plus zero `analyseSelection` calls means the request was never sent, so the fault is client wiring. Then search the served JS for the fallback reason string. It exists only in the branch where `mutate` is missing. Search the string, not minified function names, which change per build.

## Solution

Accept function-backed clients in the six `*FromTrpc` guards. The guard still refuses falsy input (`null`, `undefined`).

Before (same guard in all six; only the fallback value differs):

```ts
if (!trpc || typeof trpc !== 'object') return {};
```

After:

```ts
if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return {};
```

| Helper | File (`apps/mail/lib/quote-workflow/`) | Fallback |
| --- | --- | --- |
| `quoteWorkflowFromTrpc` | `backend-bind.ts` | `{}` |
| `staffQuoteFromTrpc` | `staff-quote-bind.ts` | `{ workstation: {}, drafts: {} }` |
| `amendFindClientFromTrpc`, `amendSearchClientFromTrpc` | `amend-find.ts` | `null` |
| `amendCapabilitiesFromTrpc`, `amendCancelClientFromTrpc` | `amend-cancel.ts` | `null` |

Regression test: `apps/mail/tests/trpc-client-route-binding.test.ts` (new). It builds the real client with `createTRPCClient<AppRouter>` and `httpBatchLink` (url plus superjson transformer). Cases: quote route binds; staff quote and drafts bind; stay find, search, cancel and capabilities bind; a missing client is refused. Verified: with the fix, all four pass. Verified: reverting only the `backend-bind.ts` guard fails the analyse case. The other cases were not re-run against the old guard.

Status:
- Merged: PR #57 as merge commit `e103f54e` (branch commit `2cbceac3`, which is contained in `main`).
- Deployed: main `9ce614ad`, about 13:24 UTC on 2026-10-08. Production health ok, pane 200.
- **Live confirmation pending.** It needs the first `quoteWorkflow.analyseSelection` request from the pane after a reload, which requires an email click in Outlook. As of the last check (access log, since the 00:00 rotation) there were zero such requests. Do not treat the fix as live-verified until the server log shows one.

## Why This Works

- The `*FromTrpc` helpers detect a missing client with `typeof trpc !== 'object'`, which assumes a plain object.
- The pane passes the real client from `apps/mail/providers/query-provider.tsx` (`trpcClient`, built with `createTRPCClient`, `@trpc/client` 11.4.3). tRPC builds that client as a proxy whose target is a function, so `typeof client === 'function'`. Verified in Node: `typeof client`, `typeof client.quoteWorkflow` and `typeof client.quoteWorkflow.analyseSelection.mutate` were all `'function'`.
- The old guard treated the real client as missing and returned an empty route set. Property reads still work through the proxy once the guard accepts it, so `quoteWorkflow.analyseSelection.mutate` resolves to a callable.
- The page calls `quoteWorkflowFromTrpc(trpcClient)` and passes `workflow.analyseSelection?.mutate`. With `{}`, that value is `undefined`. `bindAnalyseSelection` (`backend-bind.ts`) then takes its `!args.mutate` branch and returns `unavailable` with the "cannot read emails" reason, without sending a request. That is why the server saw zero analyse calls.
- The other guards had the same effect: the "not connected" messages appeared and the change/cancel features stayed off.
- The guard came in with PR #29 (commits `ced2d249` and `9cd62026`). PR #38 (`fea95bed`) copied the same check into the amend and cancel helpers. Both predate the pilot and were not caught by their tests, which used plain objects.
- The fallback text is client-side. Nothing in Outlook or on the server failed, so searching the add-in could not find the cause.

## Prevention

- Test library-built clients with their real constructor, not plain-object mocks. Pattern: `apps/mail/tests/trpc-client-route-binding.test.ts`. Building the client and reading routes makes no network call.
- Assert that the bound member is callable, for example `expect(typeof route.mutate).toBe('function')`. Do not rely on `toBeTruthy()` for a container. The existing checks for `paneStayFromTrpc` and staff drafts assert only truthiness, so they would miss a broken binding. Tighten them.
- Do not guard library-created clients with `typeof === 'object'`. Proxy-based clients report `'function'`. Check the member the caller uses (optional chaining), and reject only `null` and `undefined` at the top.
- Audit after any change: `grep -rn "typeof trpc" apps/mail/lib/quote-workflow/` should list six guards, each with a `function` branch.
- Give the missing-binding fallback its own diagnostic (recommended, not yet done). When `mutate` is absent, `bindAnalyseSelection` and the other bind fallbacks should record a distinct reason, such as `client_binding_missing`. Keep the user-facing text unchanged. A binding fault then does not read as an Outlook failure.
- Use a server-side route count as the end-to-end check after deploy. Load the pane, click an email, and confirm one `quoteWorkflow.analyseSelection` request in the server log. If the pane loads and grants succeed but there are zero analyse calls, check client wiring first.

## Related Issues

- PR #57 (kufupa/Zero): this fix, merged as `e103f54e`.
- PR #29 (kufupa/Zero): introduced the object-only guard in the quote helpers.
- PR #38 (kufupa/Zero): copied the guard into the amend and cancel helpers.
- PR #56 (kufupa/Zero): pane follow after draft writes and other-mailbox selections. Its P1 recovery test is still pending.
- PR #55 (kufupa/Zero): canonical Message-ID for quotes and lookups. Separate bug, same window.
- PR #54 (kufupa/Zero): pins add-in 1.0.16. Add-in PRs kufupa/nava-outlook-addin #6 (denial reason) and #7 (UI-thread fix).
- PR #53 (kufupa/Zero): logs native bridge refusals that the server cannot otherwise see.
- See also `docs/solutions/integration-issues/fe-pilot-trpc-wire-contract-drift.md`. Same surface and the same lesson (tests must use the real client), but a different root cause (405 and payload drift).
