# Outlook v4 security release — supervised operator handoff

Status: code/Windows CI evidence **is not a deployment**. This runbook authorizes no
production action by itself. Obtain named operator, change window, backup, IT
signing/trust approval and staff-PC owners before proceeding. Do not run
Vitest, test migrations or `seed-prod` against the pilot RDS. Do not run this
release's `write-ec2-env.sh` or an EC2/AWS write during code verification.

## Artifacts and independent gates

- Expected root gitlink: `apps/server-pilot/vsto` at
  `0f2d0853074f241da4a4d846076f6358720956b1`; private Windows CI run
  `36566979908` succeeded at commit `d6a3a3545b7b90acad1e1df43f1cbfff971c1e83`,
  whose complete source tree (`26172351ca4798e753529efcf65ca10e1625ae8a`)
  matches that gitlink. The locally downloaded, uninstalled
  `NavaOutlookSetup.exe` artifact is **4,252,091 bytes**, SHA-256
  `e8c4602a9f5c1e65092aa4ad564ebd434f55a352bbcc8f6bcb186415f3e752aa`.
  This build retains successful Outlook COM results even if the signed
  authorization lease expires after dispatch. Distribute only this exact run
  and hash; build output bytes can differ even when the source tree is identical.
  Re-fetch from the exact run, verify local hash/size, x86/x64 builds, manifest
  signatures and chain under supervised IT policy before distributing. Do not
  equate a CI self-signed VSTO manifest with a publisher-trusted setup EXE or
  the separate HTTPS site certificate. Do not claim this artifact was published.
- Before production: complete a disposable staging Nginx syntax, alias,
  regex, headers and `script-src` hash test on the *built* `/outlook-pane`;
  verify `/outlook-pane/` redirects to that canonical URL and unknown
  `/outlook-pane/...` paths and case variants (`/OUTLOOK-PANE`) return 404 rather
  than the permissive SPA fallback;
  no Nginx binary is installed on the development host. Test both page and
  asset versions, blocked injection, staff sign-in, buttons, PDF drafting and
  bridge-free screenshot popouts. The earlier built Chromium test used fake
  sign-in and did not exercise Outlook, real PDF or screenshot popouts.
- The new deploy preflights every web-root ancestor, root-owns the release
  parents, then refuses to publish if *any* non-download legacy file or
  directory is a symlink, app-owned or group/world writable. Prior flat
  web builds and shared hashed assets may need a **one-time supervised**
  ownership/legacy-file inventory and repair on EC2, with backup and
  checksums. Do not remove unknown files or blindly chown the separately
  managed installer download. Later UI-only releases remain centralized.
  Root ownership cannot isolate a compromised `ubuntu` PM2 process if that
  runtime user has unrestricted passwordless `sudo`; inspect EC2 sudoers and
  keep deploy privilege separate before claiming OS-level isolation.
- Record real TLS/Outlook/IT results for every enrolled Windows user and
  workstation separately; Linux source contracts and the native CI cannot
  prove this. Keep guest mail and credentials out of the release record.
- Root PR CI requires `NAVA_OUTLOOK_READ_SSH_KEY`: a dedicated read-only deploy
  key installed on the private `kufupa/nava-outlook-addin` repo, with its
  private half stored as a Zero Actions secret. It checks out this exact
  gitlink and fails if source is missing or mismatched. Do not use a broad
  personal token or downgrade CI to its old source-contract warning/skip
  behavior.

## Order of operations — all production steps require a separate approval

1. Record rollback owner, DB snapshot/backup and current server/web releases,
   session count, env file checksum (never its contents), current Nginx config,
   existing installer hash and every installed 1.0.11 user/workstation. Check
   exact named staff `user.id`, `email_verified=true`, active
   `mailbox_transport.id` and `mailbox_access(user_id,transport_id)` for each
   Centurion/DaVinci shared mailbox. A shared mailbox address or Windows
   workstation name is not an identity. Existing approved/verified accounts
   may continue signing in even though new self-service signup is closed.
   `scripts/seed-prod.ts` calls `seedAll`, deletes users outside `PILOT_USERS`
   and rewrites the password map: **do not run it to add staff**. If a named
   staff account or mailbox grant is absent, stop and arrange a reviewed,
   non-destructive, per-user/per-mailbox provisioning operation first.
2. Provision once, via a separately authorized operator action, a dedicated
   AWS Secrets Manager *plain SecretString* whose contents are canonical
   base64 of exactly 32 cryptographically random bytes, at
   `nava-zero/server-pilot/outlook-device-wrapping-key` (or set
   `OUTLOOK_DEVICE_WRAPPING_KEY_SECRET_NAME` to the operator-approved dedicated
   secret ID). Limit IAM to the EC2 instance role and restricted operators;
   encrypt at rest, keep it outside Git, shell history, CI and the hosted pane.
   Back it up securely and retain the identical value across restarts and
   rollback. Never derive it from `DATABASE_URL` or `BETTER_AUTH_SECRET`, or
   regenerate/rotate it on deploy: an unplanned rotation or missing key
   irrecoverably breaks existing device credentials and requires re-enrollment.
3. During approved cutover, apply additive Outlook DB migrations to the live
   DB *only after* verified backup and preflight, using the operator-managed
   migration procedure (no test runner). Then refresh the server env separately:
   `ops-deploy.sh` does **not** call `write-ec2-env.sh`. With approved EC2 IAM
   and the existing writer prerequisites, run the env writer in its intended
   production context, review owner/mode 0600 and presence of the key by
   redacted checks only, and restart server processes through an approved
   change. Writer fails closed before replacing the previous env on missing,
   malformed or inaccessible wrapping key. Never print the key or run `bash -x`.
   `PILOT_OPEN_SIGNUP='0'` now overrides even a stale
   `PILOT_SIGNUP_ALLOWLIST`; Google OAuth also disables new registrations
   unless `PILOT_OPEN_SIGNUP='1'`, without blocking existing linked-account sign-in. Explicitly
   verify blocked self-signup and existing named sign-in. Keep remote-admin's
   separate 12-hour session.
   In the legacy HTTP process, a capped hourly pass removes tickets expired
   more than one day ago, move receipts older than one day and 256-bit random
   navigation replay markers older than 30 days. Migration `0032` supplies
   the cleanup indexes; cleanup does not touch active device enrollments,
   current grants or guest-mail content. Monitor its generic failure log.
4. Controlled legacy-session invalidation: after verifying the new 24-hour
   absolute (not sliding) hotel profile, identify previously issued long-lived
   rows in the legacy `session` table by creation/expiry, get change-manager
   approval for a scoped session invalidation and tell named staff to sign in
   again. Do not touch `remote_session`, silently delete all user accounts, or
   treat new 24-hour policy as proof that old 400-day rows were revoked. Test
   logout, 24-hour expiry, stale-ticket denial and device revocation.
5. With old 1.0.11 installed clients identified and their native privileges
   disabled by an independently verified mechanism, deploy the
   matching server, hosted mail build and Nginx pane policy as one approved
   release. `deploy/deploy-ec2.sh` computes an ID from the complete client
   tree; immutable `/releases/<id>` and matching Nginx script hashes switch
   together; prior hashed chunks stay available to open tabs. Check actual
   EC2 web-root ancestry, all retained legacy files and old `/assets` for
   trusted ownership and non-writable modes, and supervise any one-time repair
   before Nginx activation. Never bypass the new fail-closed ownership check.
   Check Nginx syntax and the exact `/outlook-pane` URL, final response headers,
   cache/asset behavior, blocked inline injection and non-pane web-mail route
   policy. Never publish an index with mismatched script hashes or a stale
   fallback. Use a staged staff sign-in and purpose-built read-only health/API
   checks (not real guest emails or pilot-RDS tests).
6. Each supervised staff Windows install: verify the *exact* artifact hash,
   Classic Outlook version/bitness and runtime; have staff save drafts and
   close Outlook voluntarily before setup. Installer never `taskkill`s
   Outlook; if it cannot positively check that Outlook has closed (tasklist
   fails or has unreadable/empty output), it refuses to replace add-in files.
   IT must approve VSTO TrustedPublisher/Inclusion List in HKCU,
   evaluate publisher warnings and verify manifest chain; never silently trust
   the self-signed certificate as a Root CA or bypass endpoint protection.
   Native 1.0.12/v4 requires a one-use code within 10 minutes per Windows
   user and stores the device secret in DPAPI CurrentUser. Record each device
   UUID and exact COM-observed Outlook `StoreID`, not the secret or code.
7. Restricted operator shell only, with approved DB access and wrapping key
   in its environment, uses `pnpm --dir apps/server-pilot exec tsx
   scripts/outlook-device-operator.ts issue --store-id '<COM StoreID>'
   --staff-email '<verified staff account>' --transport-email '<shared mailbox>'`.
   Repeat the staff/transport pair for additional approved grants; confirm
   existing `mailbox_access` first. Transfer the one-use code to that user's
   native pairing dialog privately; never enter it in page JavaScript or a
   ticket. For each active transport and exact observed store, separately
   approve its real Inbox and Drafts folder EntryIDs using `approve-folder
   --store-id '<COM StoreID>' --transport-email '<shared mailbox>'
   --folder-id '<COM Folder EntryID>' --kind inbox|drafts`; approve only
   reviewed triage destinations with `--kind triage` (and `spam` only when
   explicitly approved). Inventory folder EntryIDs from *that* Outlook store;
   never infer them from display names, another store or test data. Drafts
   approval permits read/reply/update/PDF attachment, **not** move into Drafts;
   Deleted Items, Outbox and descendants are forbidden move destinations.
   New folders need separate approval before moving into them.
8. With a test-only, authorized mailbox and consent, check fresh auth, exact
   mailbox/store/folder scope, read/attachments/templates, quote PDF reply
   draft and attachment in approved Drafts, screenshot popout isolation,
   category/flag/read and one approved same-store triage move. Observe native
   exact-item/destination confirmation for batches of 10+ or >25/min; deny
   wrong store/folder, revoked device, expired ticket and old v2/v3 client.
   The native-only consent dialog shows the actual Outlook destination folder,
   message subjects, senders and exact EntryIDs. IT/staff must still verify it
   with a real Windows profile before treating it as informed approval.
   **Shared-store reply blocker:** Outlook `Reply().Save()` can write first to
   the profile-default Drafts. This version refuses reply creation *before*
   any side effect unless the exact approved store Drafts is also the
   profile-default Drafts. On a nondefault Centurion/DaVinci shared mailbox,
   reply+PDF draft automation is intentionally unavailable: staff must use
   manual Outlook Reply pending a supervised, separately validated native COM
   solution. Check every target profile/store before promising that workflow;
   do not silently weaken this guard or publish the installer as feature-complete.
   **Multiple-pane draft verification:** an uncertain reply's retry ID and
   Drafts warning live in the initiating pane's WebView context. A second
   inspector/pane may not see that warning and may initiate a new reply to
   the same message. Before declaring automated drafting ready, exercise two
   simultaneous panes on the real staff profile, including a native timeout
   and pane close/reopen. If duplicate creation remains possible, keep
   automated reply drafting disabled for those profiles until a separately
   verified cross-pane idempotency boundary or supervised user workflow is in
   place; do not claim that the single-pane confirmation solves this case.
   Native `SEND_DRAFT`, `DELETE_EMAIL` and permanent delete must stay denied;
   staff Send/Delete is *manual in Outlook*. Separately verify legitimate
   server web-mail `mail.send`, `mail.delete`, `mail.bulkDelete` still work
   under approved users, without sending real guest traffic. Record that **all**
   old 1.0.11 clients are upgraded or disabled before declaring fleet cutover.
   A previously installed v3 binary remains locally present and outside v4's
   native guard until specifically upgraded/disabled; publishing the site by
   itself cannot remove that local risk.

## Failure and rollback (fail closed)

- On any store mismatch, key absence, Windows trust warning, unsaved drafts,
  session-policy discrepancy or nginx CSP mismatch: stop enrollment and
  distribution. Restore the last validated server+immutable web release and
  *its matching* Nginx pane policy from the recorded snapshot; do not restore
  v3/native unauthenticated COM fallback or reactivate old 1.0.11 devices.
  Keep the v4 deny policy while investigating and disable native pane access
  if a matching v4 server cannot run. DB migrations are additive; do not
  blindly revert schema with enrolled devices present. Keep the same wrapping
  key for compatible v4 rollbacks, and never log it.
- Revoke a compromised/retired device from the restricted shell using
  `revoke --device-id '<device UUID>' --confirm-revoke`; for a folder use
  `revoke-folder --store-id '<COM StoreID>' --transport-email '<mailbox>'
  --folder-id '<COM Folder EntryID>' --confirm-revoke`. Inspect the approved
  exact scope first and record affected staff. Native revoked read leases may
  last up to 60 seconds; mutations are max 15 seconds and bound to an
  operation. After server revocation IT may remove the user's DPAPI credential
  file as documented in the native README; uninstall alone does not revoke.

## Urgent separate security decision

Native Send/Delete removal does **not** disable legitimate server web-mail
`mail.send`, `mail.delete` and `mail.bulkDelete`. The previously identified
raw-email fallback XSS path now has a client-side allowlist sanitizer plus a
final DOMPurify boundary, while retaining normal web-mail functionality. This
mitigation still requires real-browser/WebView2 payload and editor/history
smoke tests; the generic web-mail CSP review is separate. Track that remaining
verification in the
[`outlook-web-mail-html-xss-follow-up.md`](../../../docs/production-readiness/outlook-web-mail-html-xss-follow-up.md)
before pilot sign-off. Pane-only CSP does not govern other web routes. Do not
claim generic web-mail CSP review or browser verification is complete.
