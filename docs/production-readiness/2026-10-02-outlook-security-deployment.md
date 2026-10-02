# Outlook security deployment — 2 October 2026

## Production state

Authorized by Ansh in the release conversation; no additional change-manager
approval is needed for the completed server/installer publication below. Windows
installation and pairing still require the actual staff Windows profile.

- EC2: `i-008f737974a9ba9b3`, AWS region `af-south-1`.
- Server checkout: `/home/ubuntu/repos/zero`, main `88943d74` initially deployed.
  This includes the production ingestion/schema-loss prevention repairs; do not
  roll back to the previous `cd682d39` checkout or older HTTP artifact.
- Installed HTTP, remote HTTP, ingestion worker and AI worker passed health
  probes. Migration compatibility passed with all 33 ledger entries present.
- Applied only additive migrations 0029–0032. Exact message/attachment ID
  inventories were unchanged: 10,758 messages and 39,155 attachment rows.
- RDS snapshot `nava-zero-mail-pilot-before-outlook-v4-20261002-2230` was available
  before activation. Private rollback files are in
  `/home/ubuntu/nava-outlook-v4-backup.0HnIeh` on EC2. Retain these during rollout.
- Capped legacy hotel sessions to an absolute 24 hours from creation without
  deleting accounts or changing remote-admin sessions. Verified named staff
  login and 24-hour expiry; self-signup returned 403.
- Immutable web release and matching Nginx CSP hashes published together.
  HTTPS `/outlook-pane` returned 200; trailing slash canonicalized; unapproved
  subpaths and case variants returned 404. Unsigned authorization returned 403.
- Staff download is **published**, not merely built:
  <https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe>.
  Version **1.0.12**, size **4,252,091 bytes**, SHA-256
  `e8c4602a9f5c1e65092aa4ad564ebd434f55a352bbcc8f6bcb186415f3e752aa`.
  Retrieved over HTTPS on EC2 and independently hashed after publication.
  GitHub native CI run `36566979908`, artifact `11032985592`, commit `d6a3a354`;
  complete source tree matches the root's VSTO gitlink `0f2d0853`.
  x86/x64 builds, manifest checks and native hardening tests passed in Windows CI.

## Stable key and authorized LLM access

- Created `nava-zero/server-pilot/outlook-device-wrapping-key` in Secrets Manager.
  It contains canonical Base64 of 32 random bytes. EC2 has narrowly scoped read
  access; the environment writer loads it as `NAVA_OUTLOOK_DEVICE_WRAPPING_KEY`
  in the protected production environment (mode 0600).
- This server AES key protects stored device HMAC secrets. It is not the website
  TLS certificate, a paid publisher certificate or a JavaScript secret.
- Keep its value identical across deploys/restarts. Do not regenerate it as part
  of installation or UI updates. Unplanned rotation requires device recovery or
  re-enrollment.
- Ansh explicitly permits authorized NDA/ZDR LLM sessions on this VPS to retrieve
  credentials. A future authorized chat can read it using:

  ```bash
  aws secretsmanager get-secret-value --region af-south-1 \
    --secret-id nava-zero/server-pilot/outlook-device-wrapping-key \
    --query SecretString --output text
  ```

  Do not put the value in Git, skills, browser JavaScript or public tickets.
  The original AWS secret remains the recovery source; no extra plaintext copy
  is required on the development VPS.

## Environment-writer incident resolved

The first deploy attempt stopped at the migration guard because Secrets Manager's
`database-url` contained an obsolete password while the previous EC2 environment
contained a working connection. No database credential rotation was performed.
Restored the verified working URL, confirmed schema compatibility, synchronized
that same URL into its existing Secrets Manager entry, and removed the temporary
exact-secret write policy. The device wrapping key was not changed. Preserve
the existing workflow/AI flags when refreshing the environment.

## Onboarding fix discovered during release

A real production browser exposed a mailbox query before login that redirected
the exact pane to `/zero/login`, blocked by native navigation policy. The hosted
fix gates connection queries on a staff session and keeps expired-session
re-login on `/outlook-pane`; normal web-mail redirects remain unchanged. The
browser regression now uses an actual tRPC UNAUTHORIZED envelope and checks no
mailbox requests happen before sign-in. This fix does not change native binaries.

## Next supervised staff session

1. Have staff save work, close Classic Outlook and install the published 1.0.12
   EXE once. Existing 1.0.11 clients must be upgraded or disabled; a website
   deployment cannot remove privileges from an old local binary.
2. Open Outlook and the Nava pane. Staff sign in using their individual account.
   Do not run `seed-prod` to add users: it can remove unrelated accounts. Confirm
   the account is verified and already has the intended mailbox grant.
3. Read the exact Outlook StoreID and Inbox/Drafts/triage folder EntryIDs using
   the read-only PowerShell inventory in
   `apps/server-pilot/src/outlook-security/README.md`. Do not infer identities
   from folder names or from another person's Outlook profile.
4. An authorized operator/LLM runs the existing enrollment CLI on EC2 with
   `.env.production` loaded. Issue a one-use, 10-minute code for that exact store,
   staff account and mailbox. Staff paste it in the **native pairing dialog**.
   The native secret is protected by Windows DPAPI CurrentUser, outside the pane.
5. Use the same CLI's `approve-folder` operation for the exact Inbox, Drafts and
   triage destinations. Approval changes are server-side, without another EXE.
6. Verify authorized reads, attachments, draft+PDF creation, screenshot popout,
   an approved same-store move and blocked Delete/Send/Deleted Items/Outbox moves
   using authorized test mail. Batch confirmation starts at 10 items or more
   than 25 moves/minute; normal approved single moves remain automatic.

Operator CLI: `apps/server-pilot/scripts/outlook-device-operator.ts`; exact
commands and inventory script: `apps/server-pilot/src/outlook-security/README.md`.
No production devices were enrolled during the server rollout: staff/profile
identities cannot be invented from Linux.

## Remaining limitations — not hidden release guarantees

- Linux/browser checks cannot prove a real Windows install, self-signed VSTO
  publisher trust, local Outlook COM behavior or staff endpoint policy. No paid
  code-signing purchase was made or added as a requirement here.
- **Nondefault shared-store reply drafting is blocked in this native version**:
  Outlook may save replies into the profile-default Drafts. Native refuses before
  side effects when approved store Drafts differs. Check each staff profile;
  manual Outlook Reply remains available. Do not promise automated reply/PDF
  drafting for affected profiles until the native behavior is safely corrected.
- Multiple simultaneous panes and uncertain draft timeouts need actual Outlook
  validation. Do not call the fleet fully onboarded before those staff checks.
- Staff send manually in Outlook; native automated Send/Delete is removed.
  Legitimate server-side web-mail/forwarding APIs were not removed.
- Routine screens are centrally updated. Native capability changes may require
  a future installer; this release does not promise never needing another update.
