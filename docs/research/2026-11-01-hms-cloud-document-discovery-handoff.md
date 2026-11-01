# HMS Cloud document discovery handoff

Date: 2026-11-01. Scope: one synthetic file on an exclusively assigned HRCEN Labtest stay. This is discovery evidence, not authorization for another upload or a claim that the document workflow is complete.

## Reconciliation status

**Uncertain. Do not retry the upload.** The prior session dispatched one synthetic 64-byte text file and received HTTP 200. A separately launched browser session reverified the fake stay and found one matching filename and document code in the loaded Documents tree. That establishes observed metadata, not server-side byte equality, full tree coverage or a successful end-to-end workflow. The prior baseline also had unverified tree completeness, so an empty baseline did not prove absence.

The post-upload `POST /web/base/OSRESV.DOC` was blocked by the discovery fence. The application then showed a dialog containing `0` and a stale empty tree. The request's semantics and the dialog's cause were not established. The separate readback reported `refreshVerified: false` and `complete: null`. No download or stored-byte comparison was performed.

## Observed request sequence

- A display request to `POST /web/base/BSUPLD` was bound to the verified record frame, origin, exact fields and fake-stay target.
- `POST /web/base/BSUPLD.checkfile` matched a captured 35-field validation body and returned HTTP 200. Its response body was not independently interpreted.
- `POST /web/base/BSUPLD.upload` was a multipart navigation in an `about:blank` child of the record frame. The one-off fence checked origin, method, frame relationship, target values, filename, multipart parts and the exact synthetic bytes.
- The upload request token differed from the record-frame URL token. The one-off fence checked format only, not provenance or a trusted session binding. One observed child-frame relationship and one exact request baseline are not a reusable cross-session contract.
- The original context had no service workers at its action checks and observed no new worker event, but it was not created with service workers blocked. That observation does not establish interception coverage for future sessions.

## Why no adapter was built

A reusable document write adapter must safely bind the target, current request token, exact child frame, file bytes and request sequence while retaining all shared safety guards. Existing evidence does not establish the token's provenance or meaning, and the post-upload request remains unexplained. A successful response and matching metadata cannot replace those bindings.

The shared bootstrap creates its own context without `serviceWorkers: 'block'` in [`centurion-stay360.mjs`](../../apps/server-pilot/tooling/playwright-quote/centurion-stay360.mjs). A dedicated context configured before any page or worker exists is preferable, but configuration and interception need verification. Also, [`stay360-record-tabs.mjs`](../../apps/server-pilot/tooling/hms-cloud/stay360-record-tabs.mjs) installs a context guard whose allowed requests use `route.continue()` in [`hms-read-only-guard.mjs`](../../apps/server-pilot/tooling/playwright-quote/hms-read-only-guard.mjs). Route ordering therefore matters: a later guard can short-circuit an earlier context fence. Do not assume stacking guards automatically preserves document-specific interception.

The existing [`stay360-documents.mjs`](../../apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs) explicitly reports unknown completeness. Reconciliation must retain that uncertainty, refuse automatic retry and separately report metadata observation, target verification, byte verification and tree coverage.

## Evidence and next safe checks

The prior private discovery report is `/tmp/hms-document-discovery-LpkgU3uG/report.md`. Its directory contains the dispatch result, fresh-session readback, request-binding observations and screenshots. It is private temporary evidence, not durable storage; it can disappear and must not be committed wholesale. This note deliberately excludes guest identifiers, token values and full request payloads.

Before implementing, establish a trustworthy token binding and safe isolated context with service-worker and route-order interception tests. Investigate the blocked follow-on request without permitting an unexplained write, and independently reconcile stored bytes and tree coverage where a verified read-only method exists. Preserve uncertainty if those checks cannot prove the result. Any new live write must follow current `PRODUCT.md` authority, including the standing Labtest exception. This historical proof does not authorize real-guest writes.

This handoff adds no adapter, changes no shared guard and performs no live action, local test, typecheck, commit or deployment. The pre-existing untracked discovery fence and test draft were left untouched.
