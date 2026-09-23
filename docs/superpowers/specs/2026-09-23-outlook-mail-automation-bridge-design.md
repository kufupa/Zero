# Outlook mail automation bridge design

## Goal

Give the Nava VSTO installer a reusable, typed Outlook mail surface so future
reservationist features can inspect and act on mail already available in the
interactive Outlook profile without repeatedly adding one-off COM plumbing.

## Confirmed platform boundary

- The add-in is a .NET Framework 4.8 VSTO add-in compiled against the Office 15
  Outlook PIA with embedded interop types (`TargetOfficeVersion=15.0`). The
  historical project target was Classic Outlook 2016; the exact Outlook
  product/build installed on the user's workstation is not recorded here.
- Microsoft documents VSTO compatibility for Office 2013/2016. The `16.0`
  value reported by Outlook is shared by Office 2016, 2019, 2021, LTSC 2021/2024,
  Office 2024, and Microsoft 365; it cannot identify which product/build is
  installed. Microsoft says add-ins already compatible with Office 2019 or
  LTSC 2021 are likely to work on LTSC 2024 with minimal testing, but this
  specific add-in has not been runtime-verified on those later products. The
  workstation product/build is not observable from this Linux checkout, so
  later Office releases must not be described as runtime-verified.
- Source evidence: [VSTO compatibility matrix](https://learn.microsoft.com/en-us/visualstudio/vsto/running-solutions-in-different-versions-of-microsoft-office?view=vs-2022), [Outlook `Application.Version`](https://learn.microsoft.com/en-us/office/vba/api/outlook.application.version), [Office LTSC 2024 overview](https://learn.microsoft.com/en-us/office/ltsc/2024/overview), and [Microsoft's steps to identify the installed Outlook product/build](https://support.microsoft.com/en-us/outlook/getstarted/what-version-of-outlook-do-i-have).
- This is Classic Outlook for Windows only. New Outlook does not support VSTO
  or COM add-ins. The object model runs in Outlook's interactive profile; it
  is not a background-service or unattended mailbox API.
- COM uses the accounts, stores, folder permissions, and Outlook security
  policy already present on that workstation. No Graph scopes, OAuth consent,
  separate account-password access, or new Windows privilege are introduced.

## Bridge contract

Keep an explicit action allowlist and typed JSON payloads. Never add arbitrary
COM member dispatch, PowerShell, shell, filesystem, or script execution to the
WebView bridge. Increment the protocol to v3 and expose `GET_CAPABILITIES` so
the pane can discover the installed add-in's supported actions and limits.

Add these reusable operations:

- `LIST_STORES`, `LIST_FOLDERS`: enumerate the stores and recursively visible
  folders in the current Outlook profile. Return store ID, folder entry ID,
  parent ID, display path, and default-folder type where available.
- Store-aware `GET_FOLDER_EMAILS` and `GET_EMAIL_BY_ENTRY_ID`: accept stable
  `(entryId, storeId)` / `(folderEntryId, storeId)` addressing; folder listing
  returns immutable, bounded snapshots through opaque continuation tokens.
  Include location IDs in results.
- Store-aware `CREATE_FOLDER`, `MOVE_EMAIL`, and `MOVE_TO_SPAM`; destination
  folder IDs take precedence over legacy names. A move returns the new IDs
  because Outlook can change an EntryID when an item moves.
- `CREATE_DRAFT`, `UPDATE_DRAFT`, `CREATE_REPLY_DRAFT`: handle To/Cc/Bcc,
  subject and body, reply vs. reply-all, saved drafts, and optional explicit
  opening of the Outlook composer. When a source `storeId` is supplied for a
  new/reply draft, move the saved item to that store's Drafts folder and
  return the moved item's current IDs. The pane must forward the selected
  message's store ID when creating a reply draft.
- `LIST_ACCOUNTS`, `SEND_DRAFT`: expose only accounts with usable SMTP
  addresses; allow sending a saved draft using an explicit account, or the
  default account only when `useDefaultAccount` is explicitly true. The action
  only sends an item in a Drafts folder. A success means Outlook accepted the
  send request, not recipient delivery. Outlook policy, Object Model Guard,
  antivirus state, and Exchange Send As/Send on Behalf rights can still block
  or prompt for a send.
- `DELETE_EMAIL` performs Outlook's normal delete/move-to-Deleted-Items
  behavior. `DELETE_EMAIL_PERMANENTLY` is explicit, requires a confirmation
  field, and only operates on items already in that store's Deleted Items.
  Exchange retention/Recoverable Items can still retain deleted content.
  Restore is ordinary `MOVE_EMAIL` to a caller-selected folder; no duplicate
  restore operation is needed.

Existing attachment, category, follow-up, and read-state operations remain in
place and accept optional store IDs where they resolve a mail item. Conversation
reads resolve from a seed message's `(entryId, storeId)` and use Outlook's
`MailItem.GetConversation().GetTable()` across folders/stores; Outlook excludes
items in Deleted Items from this table, but those items remain directly
enumerable/readable through the folder APIs. No separate action is added where
an existing typed operation can cover the use case.

## Identity, scale, and behavior

- Entry IDs are scoped to a store and may change after moves. Every item/folder
  operation therefore accepts a `storeId`; operations returning a moved or
  saved item return its current IDs.
- Folder listing traverses Outlook-visible folders, not hidden server-only
  folders or stores that the current Outlook profile cannot access.
- Folder mail reads are paginated (maximum 200 items per request) from an
  immutable per-folder snapshot capped at 5,000 summaries. Keep at most 8
  snapshots for 10 minutes each. Snapshot tokens are bound to their
  store/folder and expire; the response reports when a folder exceeded the
  cap. Moving an item after page one cannot shift later pages.
  Bodies are fetched separately by item ID, so listing does not load every
  mailbox body in one response. This is a bounded workstation view, not a
  server-side archive/search API.
- Non-idempotent actions require an `operationId`. Successful responses are
  cached in memory (maximum 256 entries, 15-minute TTL) so a client
  timeout/retry does not repeat a send, move, delete, attachment, folder, or
  draft creation. IDs must be non-empty and at most 128 characters. The cache
  is not durable across Outlook/add-in restarts.
- `CREATE_REPLY_DRAFT` saves by default; the pane may request
  `openInComposer: true` to retain its current visible-compose behavior.
- Legacy default-store folder-name payloads remain accepted for compatibility.

## Security boundary

The WebView must have both a trusted current page URL and a trusted message
source before dispatching a COM action. Keep navigation HTTPS and host-locked
to `nava.legacyhotels.co.za`. The typed action allowlist is the capability
boundary; requests cannot name arbitrary COM members.

## Release/documentation changes

- Bump protocol 2 to 3 and coordinate the native app/installer version to
  1.0.9 (assembly 1.0.9.0).
- Update the README's stale claim that the add-in only reads a selected inbox
  item and cannot send. Describe store/folder enumeration, read/draft/move/
  delete/send behaviors and their Outlook-policy caveats.
- Correct product support claims: Classic Outlook only; distinguish the
  documented Office 2013/2016 matrix from later 16.0 products that need a
  workstation runtime smoke test. Do not label the connected product as
  Outlook 2016 based only on `Application.Version`.
- Build the Windows installer through the existing workflow, install/test it
  on the supported Classic Outlook workstation, then atomically publish and
  checksum-verify the download. The Linux runner cannot compile VSTO or verify
  the user's installed Outlook product/build.

## Acceptance criteria

1. Contract tests require the new action cases, bounded snapshot paging, store-aware
   identifiers, draft-only send and explicit permanent-delete confirmation,
   and strict WebView source validation.
2. Mail protocol/UI and pure bridge-policy/snapshot/cache tests pass; the
   server-side VSTO source-contract suite passes.
3. Windows CI compiles the VSTO add-in and installer successfully.
4. Greptile findings are reviewed individually; agreed findings are fixed,
   committed, pushed, and re-reviewed until no actionable agreed finding
   remains.
5. Root and submodule changes are integrated on their respective `main`
   branches only after review. The deployed installer bytes match the
   successful Windows build artifact, verified by SHA-256 and HTTP download.
6. Report the historical project target (Classic Outlook 2016) separately
   from the user's installed product/build, which remains unknown unless a
   workstation query supplies it; do not infer it from `16.0`.
