# Outlook v4 security release — supervised operator handoff

Status: code/Windows CI evidence **is not a deployment**. This runbook authorizes no
production action by itself. Obtain named operator, change window, backup, IT
signing/trust approval and staff-PC owners before proceeding. Do not run
Vitest, test migrations or `seed-prod` against the pilot RDS. Do not run this
release's `write-ec2-env.sh` or an EC2/AWS write during code verification.

## Artifacts and independent gates

- Expected root gitlink: `apps/server-pilot/vsto` at
  `0125d13ff5d06e094b834e5a0f31fc660324e7bd`; private Windows CI run
  `36508701341` succeeded. Its private `NavaOutlookSetup.exe` artifact was
  reported as **4,247,892 bytes**, SHA-256
  `5a2c01e02dacbd8d94d5a809e3ffeb1018558c862939ca87bc7f360016ab52b5`.
  Re-fetch from the exact run, verify local hash/size, x86/x64 builds, manifest
  signatures and chain under supervised IT policy before distributing. Do not
  equate a CI self-signed VSTO manifest with a publisher-trusted setup EXE or
  the separate HTTPS site certificate. Do not claim this artifact was published.
- Before production: complete a disposable staging Nginx syntax, alias,
  regex, headers and `script-src` hash test on the *built* `/outlook-pane`;
  no Nginx binary is installed on the development host. Test both page and
  asset versions, blocked injection, staff sign-in, buttons, PDF drafting and
  bridge-free screenshot popouts. The earlier built Chromium test used fake
  sign-in and did not exercise Outlook, real PDF or screenshot popouts.
- Record real TLS/Outlook/IT results for every enrolled Windows user and
  workstation separately; Linux source contracts and the native CI cannot
  prove this. Keep guest mail and credentials out of the release record.

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
   `PILOT_SIGNUP_ALLOWLIST`; explicitly verify blocked self-signup and
   existing named sign-in. Keep remote-admin's separate 12-hour session.
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
   Nginx syntax and the exact `/outlook-pane` URL, final response headers,
   cache/asset behavior, blocked inline injection and non-pane web-mail route
   policy. Never publish an index with mismatched script hashes or a stale
   fallback. Use a staged staff sign-in and purpose-built read-only health/API
   checks (not real guest emails or pilot-RDS tests).
6. Each supervised staff Windows install: verify the *exact* artifact hash,
   Classic Outlook version/bitness and runtime; have staff save drafts and
   close Outlook voluntarily before setup. Installer never `taskkill`s
   Outlook. IT must approve VSTO TrustedPublisher/Inclusion List in HKCU,
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
   Today's native consent dialog lists exact Outlook EntryIDs and destination
   EntryID, not readable message subjects or folder names: IT/staff must judge
   its usability in a real Windows pilot before treating it as informed approval.
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

Native Send/Delete removal does **not** eliminate Send/Delete via same-origin
server web-mail `mail.send`, `mail.delete` and `mail.bulkDelete`. An attacker
executing script under an authenticated staff session (e.g. a web-mail raw-HTML
pane XSS) could invoke those routes. This release keeps legitimate web-mail
functionality intact; assign an urgent separately approved web-mail HTML
sanitization/CSP/session-boundary review with owner and due date. Pane-only CSP
does not fix other web routes. Do not claim this risk closed at v4 rollout.
