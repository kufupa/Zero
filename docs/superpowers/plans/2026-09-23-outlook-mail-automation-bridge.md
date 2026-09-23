# Outlook mail automation bridge implementation plan

## Worktree and repositories

- Root repo: `/tmp/zero-main-split`, branch
  `feat/outlook-mail-automation-bridge`, based on `origin/main`.
- VSTO submodule: `apps/server-pilot/vsto`, same feature branch name based on
  its `origin/main`.
- The user's Centurion worktree is separate and contains pre-existing changes;
  do not edit, clean, reset, or stage it.

## Tasks (test first)

1. Add failing source-contract tests for v3 actions, paged/store-aware IDs,
   draft-only send, permanent-delete confirmation, and strict WebView trust.
2. Add failing TypeScript protocol tests/types for v3, stores/folders, account
   and draft results; update the bridge schema, pass the selected store ID when
   creating a reply draft, and remove the hard-coded Outlook 2016 UI label.
3. Implement the narrow typed COM allowlist and shared ID/folder resolution in
   `apps/server-pilot/vsto/NavaOutlookAddin/OutlookBridgeDispatcher.cs`;
   preserve legacy folder-name payloads and the existing actions. When a
   reply-draft request supplies a store ID, explicitly move the saved draft
   into that store's Drafts folder and return the moved item's current IDs.
4. Fix message-origin validation in `TaskPaneControl.cs`; bump installer,
   assembly, and bridge product versions; update the VSTO README accurately.
5. Run targeted mail protocol/UI tests and the server VSTO source-contract
   suite. Confirm all diffs are in the isolated worktrees.
6. Push the VSTO submodule feature branch and open a PR; run its Windows
   `outlook-vsto.yml` build; collect Greptile review comments and iterate.
7. After submodule review/merge, update the root gitlink and protocol/UI/docs,
   push/open a root PR, run tests and Greptile review, and iterate on agreed
   findings.
8. Merge approved changes to both `main` branches; inspect the deployment
   scripts end-to-end, deploy the pane, transfer the CI EXE artifact through a
   temporary controlled staging path, and atomically replace the hosted file
   with backup/rollback available.
9. Verify local artifact SHA-256 equals the server file and that the public
   installer URL returns HTTP 200 with the same content length/hash where
   practical. Keep the goal active if client Outlook runtime compatibility
   cannot be verified from this host.

### Task 10: Close the selected-store reply-draft handoff

The pane passes the selected email's `storeId` to `CREATE_REPLY_DRAFT`; the
COM bridge moves the saved reply into that store's Drafts folder and returns
the moved item's current IDs. Targeted tests cover both sides of the handoff.

### Task 11: Resolve conversations through Outlook's conversation API

`GET_CONVERSATION_THREAD` accepts a seed message's `entryId` and `storeId`,
uses `MailItem.GetConversation().GetTable()` to enumerate conversation items
across folders/stores, and uses the documented `PR_STORE_ENTRYID` table column
to resolve each item. Do not add `ConversationID` as a Table column: its MAPI
property is binary and Outlook documents binary Table columns as unsupported.
Deleted Items are excluded by Outlook's conversation table but remain directly
readable through the folder enumeration/read operations. Add a source-contract
regression test for this path.

### Task 12: Report the Outlook compatibility boundary truthfully

Default missing product-version telemetry to `unknown`, remove the download
page's hard-coded Outlook 2016 claim, and document the distinction between the
Office 2013/2016 VSTO matrix and unverified later Office 16.0 product/builds.
Include Office LTSC 2024 and Microsoft links for exact product/build checking.

### Task 13: Close bridge review findings before release

- Negotiate `GET_CAPABILITIES` after `PING`; stay connected to a v2 installer,
  but expose only compatible legacy actions and show a clear update warning.
- Replace live offset paging with an immutable, bounded folder snapshot and
  continuation tokens. Bind tokens to store/folder, cap each request at 200,
  cap a snapshot at 5,000 summaries, report truncation, and reject offset-only
  deep paging.
- Require stable `operationId` values for non-idempotent bridge operations;
  return cached successful results for exact retries and reject ID reuse with
  a different action/payload. Keep an in-memory cache of at most 256 entries
  with a 15-minute TTL; operation IDs are non-empty and at most 128 chars.
- Make default-account sending explicit, omit accounts without usable SMTP
  addresses, and describe `SEND_DRAFT` success as submitted to Outlook rather
  than delivered.
- Resolve destination Drafts folders before creating or replying. Create new
  drafts directly in the requested Drafts folder; return a saved reply's real
  location and a placement warning if a later move fails.
- Retain at most 8 folder snapshots for 10 minutes each; each initial read
  captures at most 5,000 summaries plus one lookahead row to report truncation.
- Share default-folder alias mapping, include `depth` in `CREATE_FOLDER`, and
  execute pure policy/snapshot/cache tests in the Windows build workflow.
- Add behavioral tests for capability negotiation, retry IDs, immutable
  snapshot paging, explicit account choice, and the permanent-delete guards.

## Validation commands

- `pnpm --filter @zero/mail exec vitest run --reporter=dot tests/workstation-bridge-protocol.test.tsx`
- `pnpm --filter @zero/server exec vitest run tests/vsto-source-contract.test.ts`
- The `.NET Framework 4.8` VSTO build plus Inno Setup compilation is Windows
  only and must pass the GitHub Actions workflow.
- `git diff --check` in each changed repository.
- Greptile CLI review in each GitHub repository and source/diff review of every
  reported finding before changing code.
- After any Greptile-driven change, rerun its covering tests and review the new
  diff before committing and pushing the next iteration.

## Release/compatibility gates

- The installed Outlook product/build is not queryable from this Linux host.
  `Application.Version = 16.0` is not sufficient to distinguish Office 2016,
  2019, 2021, LTSC, or Microsoft 365. The README must state this precisely.
- New Outlook is unsupported for VSTO/COM. Only Classic Outlook is in scope.
- If no Windows runner artifact, authenticated deployment path, or client
  runtime smoke test is available, report that specific release gate rather
  than claiming the EXE is rebuilt/published/compatible.
