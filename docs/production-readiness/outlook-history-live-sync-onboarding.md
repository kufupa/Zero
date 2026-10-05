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

## Mailbox isolation operator audit (read-only)

This section supports mailbox-isolation release review. It does **not** authorize running these queries against pilot RDS from CI, Vitest, or this implementation session. Operators run them manually under a later release instruction with read-only database access.

### Ownership and provisioning rules

- Confirmed Centurion history stays on the Centurion transport; do not reassign Centurion threads because a message was seen on a shared PC or in a pane session.
- `navaai@legacyhotels.co.za` is an ingest route and service identity, not the owner of every delivered message. Nava transport rows are not a substitute for Centurion or property-specific transports.
- PMBobo ownership follows its trusted configured ingest route and transport mapping, not sender or recipient headers alone.
- Unresolved legacy ownership stays quarantined or held for an operator decision. Never auto-retag from mailbox-looking headers, uploader identity, or staff role.
- Da Vinci (and similar multi-inbox sites): create one `mailbox_transport` per real reservations inbox, grant each reservationist only their transport via `mailbox_access`, and keep one Outlook device/store root per authorized tuple. Admins receive multiple `mailbox_access` rows only for mailboxes they should access.

### Read-only SQL checklist

Replace placeholders before execution. Use a read-only role; do not run updates from this checklist.

List active transports and display metadata:

```sql
SELECT id, email, owner_header_value, mailbox_type, is_active, display_name
FROM mailbox_transport
ORDER BY id;
```

List explicit grants (no inferred ownership):

```sql
SELECT ma.id, ma.user_id, u.email AS user_email, ma.transport_id, mt.email AS transport_email, ma.role, ma.is_default
FROM mailbox_access AS ma
INNER JOIN "user" AS u ON u.id = ma.user_id
INNER JOIN mailbox_transport AS mt ON mt.id = ma.transport_id
ORDER BY ma.user_id, ma.transport_id;
```

List Outlook sync sources bound to transports:

```sql
SELECT oss.id, oss.device_id, oss.transport_id, mt.email AS transport_email, oss.user_id, oss.store_id, oss.root_entry_id, oss.status
FROM outlook_sync_source AS oss
INNER JOIN mailbox_transport AS mt ON mt.id = oss.transport_id
ORDER BY oss.transport_id, oss.device_id;
```

List trusted ingest mailboxes (service routes, not universal message owners):

```sql
SELECT id, email, display_name, is_active
FROM mail_ingest_mailbox
ORDER BY email;
```

Find message/thread transport mismatches (should return zero rows in a healthy corpus):

```sql
SELECT m.id AS message_id, m.transport_id AS message_transport_id, t.id AS thread_id, t.transport_id AS thread_transport_id
FROM message AS m
INNER JOIN mail_thread AS t ON t.id = m.thread_id
WHERE m.transport_id <> t.transport_id
ORDER BY m.id
LIMIT 200;
```

List quarantined ingest rows awaiting operator ownership decisions:

```sql
SELECT q.id, q.ingest_mailbox_id, q.reason, q.created_at
FROM mail_ingest_quarantine AS q
ORDER BY q.created_at DESC
LIMIT 200;
```

Hold unresolved quarantine rows for manual adjudication; do not bulk-retag into Centurion, Nava, or PMBobo based on headers alone.
