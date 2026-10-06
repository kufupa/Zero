# Staff-reviewed quote pilot: bounded verification

Status at 2026-10-06 12:11 UTC: backend and UI implemented; bounded combined tests, backend typing, recorded-artifact browser and local HTTP source/analysis acceptance completed. Not deployed. Windows Classic Outlook insertion remains unverified. Full mail typecheck has generated-artifact and other diagnostics; no passing full mail build, full-corpus or universal accuracy claim.

## Delivered backend

- Exact unanswered source clauses and named failed business documents projected as additive `staffActions`, with source identity and quote-blocking distinction. No generic warning on a clean result; positively identified signature noise suppressed only.
- Authorized staff source identity and strict edited-input execution through the existing borrowed native PMS owner. Server-resolved party/rate context; no caller-supplied money or native party IDs.
- Selected accommodation qualification and PDF independent of unresolved secondary questions. Existing tax/levy, eligibility, inventory, exact cents and revision freshness checks retained.
- New submitted approvals revoke old quotes/PDFs even if the newer execution fails. PDF checks latest approval, source and company/agency both before and after conversion.
- Deployment compose image corrected from LibreOffice-only to full Gotenberg 8.36.0, required by the existing Chromium HTML PDF builder. Repository change only; production unchanged.
- Actual nginx configuration has no `proxy_read_timeout`, hence its default 60-second upstream wait is shorter than the measured native quote. Repository `/api/` locations now use 1,250 seconds, just above the application's 20-minute bound. UI owner fixes exact route-based request deadlines (20-minute quote, 60-second PDF); no global slow-call exemption. Production nginx remains unchanged.

## Fresh verification receipts

| Check | Result | Boundary |
|---|---|---|
| Review summary | 34/34 | Exact source clauses, failed documents and signature-noise distinction |
| Selected policy source | 49/49 | Source-backed applicable inclusions/eligibility |
| Business services | 131/131 | Canonical request, selected allocation and public/party/government pricing paths |
| Revision/line/render | 48/48 | 33 revision, 5 line, 10 render tests; exact money, multiple quantities/date runs, overflow and currencies |
| Staff workflow + ledger | 11/11 | Four workflow and seven ledger tests |
| Real router/disposable DB | 7/7, zero skipped | Corrected inputs, overlapping approvals, newer failure, stale PDF, mailbox/source/party isolation, exact missing-tax action and source mutation during conversion; native read/conversion mocked |
| Runtime admission/parity/execution | 343/343 | 45 admission, 29 parity, 269 execution; one old exact recovery expectation updated to explicitly assert all additive source fields |
| Backend TypeScript | Passed | Entire server `tsc --noEmit`; unrelated full-mail typecheck not rerun |
| Real native government quote | Completed | Original request from corpus, actual party lookup, summary then selected full read with all five nightly prices and complete audit |
| Actual PDF conversion and text | Passed | Local full Gotenberg 8.36.0; parsed and visually inspected actual PDF |
| Complete unsent draft persistence | Passed | Real `drafts.create`, disposable DB readback, exact full HTML and PDF byte comparison; local artifact adapter, no production S3 write |
| Browser pane with authentic recorded artifact | Passed | Real Chromium panel/reducer/adapter; exact 850,000 cents/PDF hash/full reply, no overflow; not a fresh browser-to-PMS roundtrip |
| Windows Outlook insertion | Not available here | Existing protocol tests are not target-host acceptance |
| Deployment-config targeted checks | 2/2 selected checks | Full Chromium/LibreOffice image and both native-quote API upstream timeouts; 151 unrelated tests filtered intentionally, not counted as passes |
| Nginx route checks | 3/3 | Full focused routing file, including both 1,250-second native-quote upstream limits; passed at 11:16 UTC |
| Client route deadlines | 6/6 | Exact request-URL procedure matching: 20-minute native execution, 60-second qualified/legacy PDF, 5-second ordinary queries; encoded batches and misleading query text covered. Passed at 11:37 UTC |

262 + 18 + 343 = 623 distinct backend tests passed. Final touched route checks (seven router, four staff workflow, seven ledger) passed at 11:03 UTC after the specific-error-label refinement; the execution file passed 269/269 at 11:06 after fixing its outdated exact recovery expectation. Server typecheck and formatting checks also passed after the route change. These are relevant deterministic tests, not 623 corpus emails or a model-accuracy percentage.

### Real quote/PDF example

- Corpus source: inbound `c154acc5-4f46-44cd-888e-fe1af07f96d9`, explicit government quotation.
- Staff-approved scope: 11–16 October 2026, one standard room, one adult, dinner/bed/breakfast.
- Actual selected native product: STWN / NGOVDB; five dated amounts of R1,700.00. Total: 850,000 cents = R8,500.00.
- VAT/levy: included, retained applicable original source hash `1969936b49b8892bbe50da863eb504136c92cf4ac3a2c871cd770fbd3079ac0d`; no added tax arithmetic.
- First live route attempt reached qualification, then failed with converter HTTP 404 because the production converter image has no Chromium route. That failure is retained; it is not called a passing end-to-end attempt.
- Continuation reused the exact completed native captures with original observation time and audit/tool hashes; no new PMS call, changed source clock or fabricated freshness. Latest public native resolver and policy/qualification code executed again, then actual PDF route and actual draft persistence.
- Native observation: `2026-10-06T10:56:43.345Z`; continuation finished `2026-10-06T11:00:53.243Z`. Existing current-read freshness is 15 minutes; three-day guest-offer validity is a different retained policy. Do not relabel an expired capture as fresh for later browser testing.
- PDF text: rate R1,700.00, five nights, line/final total R8,500.00, correct Standard Twin/one-adult/DBB description, VAT/levy included, no hold/no booking.
- Actual PDF hash: `6cc25d0e5a94065c4b76b211d14639f9560807bed03444ec0cd0ab9d313e9df4`.
- Private receipts: `.private/playwright-quote/staff-pilot-connected-result.json`, `staff-pilot-connected.pdf`, `staff-pilot-connected-preview.png`, native output under `staff-pilot-20261006/`. Disposable proof rows removed by their unique test scope; artifacts retained.

## UI handoff and acceptance boundary

Public contracts and installation instructions are in `2026-10-06-staff-quote-pilot-backend-handoff.md`. A hashed public dependency closure is published under `.private/playwright-quote/staff-pilot-backend-snapshot.tgz` with a sibling manifest/base SHA; no secrets, private policy files or node_modules included. It is for the UI owner's isolated integration tree, not for overwriting either dirty checkout.

UI owner is fixing real binding defects: force-BAR/blank-agency defaults, source-bound action retention on partial analysis, stale results and multi-date overwrites. One execution supports multiple room/occupancy/meal groups for a single date range. Distinct date ranges must remain visible and be quoted separately; never silently collapse or replace them.

Independent UI check at 11:25 UTC, UI commit `a6a5de05`: `pnpm exec vitest run tests/quote-workflow-session.test.ts tests/quote-workflow-native-draft.test.ts tests/quote-workflow-backend-bind.test.ts tests/quote-workflow-panel.test.tsx` passed 69/69 (38 session, 4 native protocol, 15 backend binding, 12 panel). This verifies that checkpoint, not the subsequent pending timeout/room-code/PDF-byte/late-analysis corrections or connected browser. The native tests use protocol doubles, not Windows Outlook.

To shorten integration, the backend owner separately implemented the client deadline helper and the two-line query-provider binding without touching the UI owner's pane/session work. Scoped patch: `.private/playwright-quote/staff-pilot-client-timeout.patch`, including its six passing focused tests. Apply with the UI snapshot to the isolated integration tree; it is not part of the earlier 149-file backend archive.

Later independent source-UI pass at 11:51 UTC: session 41/41, binding 15/15, native protocol 4/4 and panel 12/12 passed. Full pane/PDF file failed 10/11 while waiting for an authorized allocation after Run next (overall 73 passed, 10 failed, 83). This failure is retained and sent to the UI owner for the current seam/helper repair; it is not called a completed connected UI check. The isolated integration tree did not yet expose a `vitest` binary, so the independent pass used the source UI's installed dependencies.

UI owner subsequently fixed the genuine staff-input test journey (adult occupancy, quantity, native room choice, current route, automatic selection and full reply) without weakening the production guard. Reported 83/83 focused mail tests passed at 11:57:52 UTC and 8/8 quote-workflow router tests passed at 11:56:24. Named unread-document metadata is now returned by the UI-owned thin source route.

At 12:00 UTC, the backend owner independently read `/tmp/staff-quote-recorded-pane-result.json` and visually inspected `/tmp/staff-quote-recorded-pane.png`: real Chromium panel/reducer and adapter with authentic recorded government PDF; total 850,000 cents; exact PDF hash `6cc25d0e5a94065c4b76b211d14639f9560807bed03444ec0cd0ab9d313e9df4`; full two-paragraph staff reply retained; native eligibility true; no horizontal overflow at 380px. This is recorded-adapter browser acceptance, not a new live server roundtrip or Windows native insertion. The screenshot was captured before the later room-selector presentation cleanup.

Current UI receipt: `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui/docs/plans/handoff-reports/2026-10-06-ui-integration-bounded-checkpoint.md`. The UI owner fixed owned adapter narrowing/test typing diagnostics and reconciled its 19 scoped UI/source-route files into the isolated integration tree. Its final focused source pass was 83/83. The bounded integration results below supersede the earlier pending dependency/build status; no dirty checkout was copied wholesale.

### Final combined-tree checks and snapshot correction

Integration tree: `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-integration`, base `a6a5de05935052cf835b17719d63e8547fe57c01`.

- Dependencies: exact already-tested root lockfile restored from the backend source (`4ca5f2dca37b1dac8349f79694998d54832497341dedc94f3e48f88bf6959050`); `pnpm install --offline --frozen-lockfile --ignore-scripts` passed. No package-version decision or network download.
- Independent integrated mail pass at 12:04 UTC: `pnpm exec vitest run tests/quote-workflow-session.test.ts tests/quote-workflow-backend-bind.test.ts tests/quote-workflow-native-draft.test.ts tests/quote-workflow-panel.test.tsx tests/outlook-pane-quote-pdf.test.tsx tests/trpc-request-timeout.test.ts` passed 89/89: 41 session, 15 binding, four native protocol, 12 panel, 11 pane/PDF and six exact-deadline tests. These are tests, not corpus cases.
- Initial combined backend typecheck failed because the earlier full-file dependency snapshot removed newer integration-base mail history/admission columns, stream hashing, read-root helpers and ledger fields. This is an integration defect, not an excuse to ignore unrelated errors. Restored those exact base additions, preserved base session-revocation/read-root authorization and Outlook-sync route/export, retained the quote seam, and applied the same purpose/protocol narrowing for the local-only worker adapter. No functionality was deleted to make the check pass.
- Entire corrected integrated server `pnpm exec tsc --noEmit` passed after the final preservation changes at 12:10 UTC. `pnpm exec vitest run tests/quote-workflow-router.test.ts` passed 8/8 at 12:10:42. `git diff --check` passed.
- Real loopback HTTP smoke at 12:09:21: actual integrated `appRouter`, HTTP/SuperJSON adapter, disposable PostgreSQL and mailbox resolver. Authorized source identity/hash and thin analysis returned ready; cross-mailbox access returned HTTP 403; the old thin `runStep` remained explicitly unavailable, preventing accidental alternate execution. Zero PMS/model calls. Test-only session injection is explicit; this does not prove production login or Windows host authentication. Test rows and temporary legacy-fixture DDL rolled back; owned HTTP server closed.
- HTTP command: from integration `apps/server-pilot`, `NODE_ENV=test CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55579/reservationist_checkpoint_verify_20261005 pnpm exec tsx .private/staff-quote-http-smoke.mts`. Receipt: `.private/staff-quote-http-smoke-result.json`. First two smoke attempts failed on incomplete test seeding (missing mailbox-access ID, legacy fixture missing thread-history column); retained outputs, corrected fixture only, then passed.
- One complete integrated mail `pnpm exec tsc --noEmit` finished at 12:09 UTC with exit 2. Missing generated Paraglide/React Router types and pre-existing admin/thread/formatter/server-tool/test/Env diagnostics remain. The snapshot-induced missing Outlook-sync export/route diagnostics were then repaired, not suppressed. An inherited Azure draft-approval versus send-wire type mismatch remains outside quote-only unsent insertion. No owned quote UI/adapter diagnostic was emitted; this is still not a passing full mail build. No repeated broad build-repair loop was started.
- The final public combined snapshot is `.private/playwright-quote/staff-pilot-final-integration-snapshot.tgz`, with `staff-pilot-final-integration-manifest.json` and `staff-pilot-final-integration-files.txt`. It includes preserved integration-base shared helpers/authorization plus exact root lockfile, both backend/UI quote code and timeouts. It contains no private policy/corpus/configuration, credentials, node_modules or authentic private artifacts. Treat this as a scoped dependency overlay against its stated base, not an instruction to overwrite a newer dirty checkout. The older backend-only archive remains intact but must not be replayed wholesale over the newer integration base.
  Final archive SHA-256: `09166598288329449b227e6b4126fa5b1c1f70ab4f3e308c1f671090fb8db05b`; 175 explicitly listed public dependency/UI files.

Before staff rollout: provision the existing trusted owner/policy paths in the authorized deployed stack and verify the existing Windows native **unsent** insertion path with a fresh approved quote. The correct local handoff label is “quote-pilot candidate; authentic-recorded browser and local HTTP acceptance passed; Windows Outlook acceptance pending”—not “deployed”, “fresh full browser-to-PMS roundtrip”, or a passing full mail build.

Deployment dependencies are concrete, not new implementation projects: apply the full converter image and nginx timeout alongside the integrated code; provision the existing trusted owner/policy paths and pinned browser dependency. The remote admin ALB also currently has a 60-second idle timeout (read-only AWS attribute verified); an admin path carrying synchronous native quotes needs an appropriate separately authorized timeout change. The staff public hostname uses direct nginx TLS; do not infer the admin ALB setting is its routing path.

No PMS save/hold/create, email send or production draft write was enabled. Both task-owned SSM native/Gotenberg tunnels were terminated successfully at 11:14 UTC after the UI owner confirmed it could use recorded artifacts. The UI-owned browser/Vite and bounded HTTP smoke server are closed. Existing borrowed browser and converter containers were not stopped. All task-started native/model/check processes are terminal; no new model requests were made for this staff-approved seam.

## Short rollout/host acceptance checklist

This is the remaining acceptance procedure, not a completed deployment receipt:

1. Start from the corrected combined integration tree/snapshot, preserving its base's existing history/admission/read-root/session-revocation/Outlook-sync functionality and the quote pane, adapters and routes. Do not re-overlay the older backend-only archive or either dirty source tree. Provision the trusted existing native/policy configuration at its actual installed paths and the pinned native browser dependency. Generate normal mail build artifacts and resolve relevant build diagnostics before rollout; do not call the recorded panel proof a passing whole-app build.
2. After separate rollout authorization, run the corrected full converter and apply the native-search nginx deadline. Check converter health includes Chromium and use the staff public routing path; an admin ALB check does not prove the public path. Do not turn on PMS-write or email-send capabilities.
3. In supported Windows Classic Outlook, select one synced genuine quotation request. Confirm displayed dates, quantity, adults/children, meal plan and company/agency before clicking the quote step. Verify those exact edited inputs, the returned room/board description and the selected subtotal. Correcting an input must disable the previous PDF until a fresh quote succeeds.
4. Prepare the quotation PDF and compare its dates, room quantities, prices, total and inclusion wording with the selected backend result. Non-pricing staff questions must remain visible without blocking this qualified PDF. An unread business source must identify the source and ask for manual review, not pretend extraction succeeded.
5. Edit the complete reply, explicitly insert the unsent reply, then inspect Outlook: every edited paragraph present, the exact selected PDF attached, correct recipient/thread, no send. If the native result is uncertain, inspect Outlook before retrying; do not create blind duplicate drafts.

The immediate pilot permits staff-confirmed/manual facts and consumes available backend review output. This work does not by itself prove new automatic PDF-agent extraction, exhaustive question inventory or broad-corpus AI accuracy. Source-linked action acknowledgments use the existing UI session; any persistence limitation belongs in the UI owner's final handoff.

