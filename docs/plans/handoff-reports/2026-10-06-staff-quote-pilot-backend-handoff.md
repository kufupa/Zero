# Staff quote pilot backend contract

Status: backend/UI implemented and bounded combined checks completed (2026-10-06 12:11 UTC). Integrated server typing, 89 focused mail tests, eight thin-router tests, authentic-recorded browser and local HTTP source/analysis checks passed. Not deployed; Windows acceptance and full mail build remain unverified. See `2026-10-06-staff-quote-pilot-verification.md` for exact boundaries.

## U1: exact actions

`drafts` review-summary and `toDraftWire` carry optional `staffActions: ReservationistStaffAction[]` (exported from `src/trpc/routes/drafts.ts`). Fields: `id`, `kind: unanswered_question|business_document_failure|pricing_fact`, `text`, `sourceRef`, `sourceHash`, optional `messageId`, `filename`, `sourceKind: message|attachment`, `reason`, `blockingQuote`, `status: open`. Actual validated question clause; never generated reply text. Existing fields remain.

## U2: actual authorized staff-edited quote

- `workstation.staffQuoteSource({internetMessageId})` -> `status:ready,messageId,threadId,sourceHash` or `message_not_synced`. Hash is opaque server-resolved selection identity, not UI-computed email text hash.
- `workstation.executeStaffQuote(input)` accepts strict input below. Real native read, exact party lookup, full selected allocation/revision. No UI prices/party IDs/qualified flags. Executes whole quote step, including prerequisite party lookup; do not route corrections through `ai.enqueueHmsRead`.
- Input: `{messageId,sourceHash,selectionEpoch,inputRevision,groups:[{id,arrivalDate,departureDate,quantity,adults,childrenAges,board:'room_only'|'bb'|'dinner_bb',roomCodes?:string[]}],salesStrategy:'BAR'|'Government',company?,agency?,attention?,clientEmail?,clientTelephone?}`.
- One date range per execution. Different dates need separate execution; do not silently collapse groups. Unknown room preference must not become an invented native code.
- Return: `{status:'ready',workflowRunId,revisionRef,messageId,threadId,factRefs:[],selectionEpoch,inputRevision,inputDigest,totalMinor,currency,arrivalDate,departureDate,description}`. This is one selected allocation, not an alternative menu. UI must reject results with stale source/input revision/selection.
- `workstation.qualifiedQuoteProposalPdf({workflowRunId,revisionRef,messageId,outlookEmail,factRefs:[],attention,company,clientEmail,clientTelephone,agency})` returns real `revisionId,pdfHash,fileName,pdfBase64,totalMinor`. No old typed-rate PDF route.
- Existing `qualifiedProposalChoices({internetMessageId})` remains available for hydration. Staff-approved qualification is server-owned persisted workflow metadata, scoped to source/message/user/transport and authentic revision authorization. Secondary action handling is not price authority.

## Installation (backend owner)

`RESERVATIONIST_STAFF_QUOTE_CONFIGURATION` points to trusted absolute JSON: `{tenantId,owner:{cdpUrl,browserOwnership:'borrowed',propertyCode,secretPath},outputDir,ratePolicyConfigurationPath}`. `tenantId` is the actual installed HMS tenant used by the existing read worker (not a mailbox ID), so both paths use the same lock. Reuses current native Hotel Availability tool, current source policy reader and existing borrowed owner; output stays private. Route holds existing property-scoped PostgreSQL advisory lock. No new browser owner, no model per quote step, no PMS writes/holds/send.

Runtime prerequisites: Node 22.18+ with the existing child TypeScript loader, pinned Playwright 1.63 under `tooling/stagehand/node_modules`, installed private policy/corpus/acquisition bytes and the existing sandboxed PDF extraction image. No private files or node_modules are in the public snapshot. Revision PDF conversion requires the full `gotenberg/gotenberg:8.36.0` image; the former LibreOffice-only image returns 404 for Chromium HTML conversion. The compose image is corrected locally, not deployed. Existing local full converter is available at port 39180 for acceptance.

Approval freshness: each new submitted approval revokes older results, even if it later fails. The existing generation ledger uses `clock_timestamp()` to order approvals independently of transaction-start time. PDF conversion checks latest approval/source/party both before and after rendering; the UI also discards results after local edits.

Request deadlines: UI execution uses a 20-minute limit and qualified PDF a 60-second limit, matched by exact procedure name in the request URL rather than request-body text. Both backend nginx `/api/` locations are patched locally to 1,250 seconds. The deployment-only delta is `.private/playwright-quote/staff-pilot-deployment-config.patch`; production converter/nginx configuration has not changed. The separate remote-admin ALB still has a 60-second idle timeout; staff public direct-nginx traffic does not imply the same ALB dependency.

## UI ownership

Map real action DTO into the existing top Items for you list; retain partial/manual edits; exact full edited reply and actual PDF to existing unsent insertion. Thin UI `quoteWorkflow.runStep` binding may call this public route/composition; no guessed service contracts or fixture-as-live response. Existing component owner handles mapping and browser acceptance. Backend published a 149-file public dependency snapshot and hash manifest under `.private/playwright-quote/staff-pilot-backend-snapshot.tgz`; use an isolated integration tree, not either dirty worktree. No secrets, private corpus/configuration or node_modules are included.

Final corrected combined tree: `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-integration`, base `a6a5de05935052cf835b17719d63e8547fe57c01`. Final combined archive: `.private/playwright-quote/staff-pilot-final-integration-snapshot.tgz`, manifest/files list with the same prefix. Use this corrected scoped overlay or the combined tree; the older backend-only archive removed newer base history/admission/stream/read-root/session and Outlook-sync additions when copied wholesale. Those additions are restored in the combined tree. Root lockfile and exact client/proxy deadlines are included. The real pane directly calls `workstation.executeStaffQuote`; legacy `quoteWorkflow.runStep` stays explicitly unavailable and cannot initiate native work. No production installation paths or private rate policy are embedded in the archive.
