# Outlook history and live sync onboarding

This is candidate preparation and supervised acceptance guidance for [the implementation plan](../superpowers/plans/2026-10-04-outlook-history-and-live-sync.md). It does not record a production migration, published installer, hotel profile acceptance, or retirement of any existing macro. Linux tests and source inspection do not establish Windows Outlook behavior. Release follows the [security release runbook](../../apps/server-pilot/deploy/outlook-v4-security-release-runbook.md).

## Prepare one authorized PC

1. Use Classic Outlook for Windows with the actual shared mailbox account and accessible saved sent copies. New Outlook is unsupported. Record Outlook version, Windows architecture, mailbox StoreID, approved real root EntryID, named verified staff account, and enrolled device UUID. Obtain IDs from native Outlook inventory; a folder display name is insufficient.
2. In the already approved operator environment, issue enrollment with the existing tool and let native pairing consume the short-lived code. Keep the device secret and server wrapping key out of logs, screenshots and this document. Upgrading the candidate must preserve enrollment and the stable wrapping key.

   ```sh
   pnpm --dir apps/server-pilot exec tsx scripts/outlook-device-operator.ts issue --store-id '<exact StoreID>' --staff-email '<verified staff email>' --transport-email '<shared mailbox email>'
   ```

3. Approve the exact real read root for this staff/device/mailbox tuple, then read it back. These grants permit reading descendants; they do not add sending, deletion, or arbitrary move permission. Keep existing Inbox/Drafts/triage destination approvals separate.

   ```sh
   pnpm --dir apps/server-pilot exec tsx scripts/outlook-device-operator.ts approve-read-root --device-id '<device UUID>' --staff-email '<verified staff email>' --transport-email '<shared mailbox email>' --store-id '<exact StoreID>' --root-entry-id '<exact root EntryID>' --policy-version 1
   pnpm --dir apps/server-pilot exec tsx scripts/outlook-device-operator.ts inventory-read-roots --device-id '<device UUID>' --staff-email '<verified staff email>' --transport-email '<shared mailbox email>' --store-id '<exact StoreID>'
   ```

Operator commands above require separately authorized live access. This implementation session did not execute them against production.

## Staff flow

Open the Nava pane and sign in with the approved staff account. Once native capability, enrollment, mailbox and read root are confirmed, sync activates automatically. The pane passes a short-lived activation ticket to native; original message bytes and the protected source handle stay outside JavaScript. An older installer shows an update notice.

The compact status chip opens keyboard-accessible details without blocking drafting, attachments, PDF preview or manual sending. History freezes one calendar month before first native activation in Africa/Johannesburg; live capture and catch-up use their own coverage. Closing or navigating the pane leaves an authorized background source running while Outlook is open. Closing Outlook stops native capture; reopening can resume with a still-live staff session.

“Copied” counts committed canonical ingestion with all required original receipts. Uploaded or retained originals can still be pending ingestion. Unavailable, protected, unknown-date and ambiguous items remain visible gaps; a discovery count or latest upload time does not establish complete coverage. “Last synced” uses contiguous committed coverage. Zero messages is a valid result only after complete discovery without gaps.

Pause is durable across remount, Outlook restart and login rebind. Only explicit Resume clears it; Sync now stays disabled while paused. Already accepted server copies may finish ingestion. Offline capture retries when connectivity returns. Low disk space requires freeing space and rechecking; a copy-limit pause requires the operator contact shown in the pane. Neither resource recovery nor automatic activation overrides user Pause. Expired staff authority, logout, account switch or revoked approval stops new grants and requires authorized sign-in/rebind; it does not delete accepted copies.

## Acceptance evidence before publication or macro retirement

Record the exact Zero review commit, native gitlink/commit, Windows CI run, x86/x64 artifact manifest, installer SHA256, and later served installer hash. Use one candidate installer for history, restart catch-up and live capture; do not claim a client-ready release from source checks.

Run the required disposable PostgreSQL gate with production database variables absent, plus existing ingestion/migration, server and hosted build, bridge/draft/PDF and native installer/source compatibility checks. The required gate must fail rather than skip missing database or native prerequisites.

```sh
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL='<local disposable PostgreSQL URL>' CONFIRM_DISPOSABLE_TEST_DB=1 OUTLOOK_SYNC_TEST_REQUIRED=1 pnpm --dir apps/server-pilot run test:outlook-sync
```

On each representative authorized profile, record evidence for month-end history, an absence longer than one month, pane close/navigation, Outlook restart, expiry/rebind, persistent Pause/Resume, zero/protected items, moved/backdated items, and concurrent incoming/saved outbound copies. Verify global newest-first metadata ordering, honest gaps, and no repeated logical mail or AI effects for established POP3/native twins. Check original MSG/body/header/attachment fidelity, including missing transport headers with an independent Internet-ID, zero-byte attachments, all attachment pages, and at least 100 MiB upload with interruption/renewal over the actual hotel proxy. Measure foreground STA responsiveness and large SaveAs stalls on Windows; these measurements are unavailable in this Linux workspace.

Read back private S3 staging cleanup and immutable-original retention using the [additive retention procedure](../../apps/server-pilot/deploy/aws-resources.md). Accepted originals must have no overlapping expiration/noncurrent deletion rules. Preserve database receipts, accepted original keys and wrapping key during rollback.

For each PC, verify Outlook's Save Sent Copies policy and actual destination inside the approved root. Compare saved outbound copies against the existing BCC feed and prove canonical dedup without repeated AI effects. Only after supervised evidence identifies a working native replacement may the authorized operator remove that PC's known outbound BCC macro/rule. Leave unrelated rules and source mail unchanged. A missing or inaccessible saved copy remains a limitation.

## Remove read access

Use the exact approved tuple and explicit revocation confirmation, then verify new reads/grants fail. Existing issued leases/URLs have bounded residual validity; revocation is not an instantaneous cancellation of bytes already authorized.

```sh
pnpm --dir apps/server-pilot exec tsx scripts/outlook-device-operator.ts revoke-read-root --device-id '<device UUID>' --staff-email '<verified staff email>' --transport-email '<shared mailbox email>' --store-id '<exact StoreID>' --root-entry-id '<exact root EntryID>' --confirm-revoke 1
```

The supervised acceptance record, production retention/migration readback and served artifact hash are still required before release. No Windows/profile/proxy or production acceptance is asserted by this document.
