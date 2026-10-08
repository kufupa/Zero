# Outlook pane: install and onboarding

For the founder and the operator running the 08:00 UK call (09:00 in South Africa).

Do not use real guest data on the call. Use test emails only.

---

## Before the call: checklist

Tick each line before 08:00. If a line fails, fix it or cut that part of the call.

### Staff PC

- [ ] **Classic Outlook only.** New Outlook is not supported. If Outlook looks new, switch back to Classic first.
- [ ] Outlook version and Windows type (32-bit or 64-bit) are written down.
- [ ] Outlook can see the shared mailbox, and saved sent copies are visible.
- [ ] **Old 1.0.11 is not in use.** If 1.0.11 is installed, the staff member installs 1.0.14 over it (after closing Outlook). Or the operator disables the old client. A website update cannot remove privileges from an old local program.
- [ ] Staff member has saved all drafts in Outlook. They will close Outlook before setup.

### Accounts and access (operator checks; do not guess)

- [ ] The staff member has a named account. The account email is verified.
- [ ] The account has access to the shared mailbox.
- [ ] **Do not run `seed-prod` to add staff.** It can delete other accounts.
- [ ] The operator has the exact Outlook **StoreID** for the staff PC. Get it with the read-only PowerShell check in `apps/server-pilot/src/outlook-security/README.md`. Do not guess it from a folder name.

### Installer

- [ ] Installer URL: `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`
- [ ] Installer version: **1.0.14** (the version for this call).
- [ ] Get the SHA-256 for 1.0.14 from the release record and write it down before the call.
  - The last hash in the repo (`docs/production-readiness/2026-10-02-outlook-security-deployment.md`) is for **1.0.12**. Do not use it for 1.0.14.
- [ ] After download, check the file hash matches. The runbook requires this.

### IT and security (runbook, order of operations, step 6)

- [ ] **IT has approved the publisher and certificate** for this installer. Without IT approval, do not run the installer on the call.
- [ ] IT knows which PC is being set up.
- [ ] Nobody turns off antivirus or endpoint protection. Ever.

### Operator

- [ ] Operator is online for the whole call, with the restricted operator shell ready. The shell has the approved database access and the wrapping key in its environment. Only the operator uses it. Never print the key.
- [ ] Operator knows the one-use code lasts **10 minutes**.

### Sync and drafts (check before promising anything)

- [ ] **Shared mailbox is the default Drafts store** on that Outlook profile. If it is not, the pane refuses to make reply drafts, and this is by design. Staff must reply by hand in Outlook. The runbook calls this the "shared-store reply blocker". If this is the case, leave "Insert draft in Outlook" out of the call.
- [ ] The test email shows as synced. Luna says "This email has not finished syncing yet" until it does.
- [ ] **Build check:** the pane build includes change and cancel lookup (branch `feat/luna-v4-a`). If not, staff will see "Changing or cancelling a booking is not supported yet." Skip the change-email part of the call.

---

## Part 1. Install on the staff PC

### Step 1. Close Outlook

1. Save all drafts in Outlook.
2. Close Outlook fully. Use File, then Exit.
3. The installer will not close Outlook for you. If it cannot confirm that Outlook has closed, it refuses to replace the add-in files.

### Step 2. Download

1. Open Microsoft Edge.
2. Go to `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`.
3. If Edge says the file "isn't commonly downloaded", click **Keep**.
4. If Edge asks again, click **Keep anyway**.

### Step 3. Check the file (operator or IT)

1. Open Windows PowerShell in the Downloads folder.
2. Run: `Get-FileHash .\NavaOutlookSetup.exe -Algorithm SHA256`
3. Compare the result with the SHA-256 for 1.0.14 from the release record.
4. If they do not match, **stop**. Do not run the file. Call the founder.

### Step 4. Run the installer

1. Open Downloads. Double-click **NavaOutlookSetup.exe**.
2. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.
   - Only do this after Step 3 matched and IT has approved the installer.
3. If Windows asks about a publisher or certificate, click **Yes** only if IT has approved it.
   - If IT has not approved it, stop. Do not click Yes.
4. Wait for the installer to finish.

### Step 5. Open Outlook

1. Open **Classic** Outlook.
2. Click the **Nava** tab, then **Nava Assistant**.

---

## Part 2. Device code (one code per Windows user)

The native pairing dialog needs a one-use code. The operator makes it.

### Step 1. Operator issues the code

Run this in the restricted operator shell, with the environment loaded:

```sh
pnpm --dir apps/server-pilot exec tsx scripts/outlook-device-operator.ts issue --store-id '<exact StoreID>' --staff-email '<verified staff email>' --transport-email '<shared mailbox email>'
```

The output looks like this:

```text
one-use enrollment code (valid 10 minutes): <code>
```

Notes:

- Use the exact StoreID from the PC. Do not type one from memory.
- For a second staff member on the same shared mailbox, run the command again with their own staff email.
- **One code per Windows user.** The runbook says per Windows user, not per PC. If two people use one PC, each needs their own code.

### Step 2. Give the code to the staff member

- Pass the code in person or by phone. Do not send it by chat, email, a ticket, or the pane.
- The code works once.
- The code expires after **10 minutes**. If it expires, the operator runs the command again.

### Step 3. Staff member pairs

1. The Nava pairing dialog asks for the code.
2. Staff member pastes the code and confirms.
3. The operator records the device ID and the StoreID. **Do not write down the code or the device secret.**

### What the operator does next

The read-root and folder approvals are separate operator commands. They are in `docs/production-readiness/outlook-history-live-sync-onboarding.md` and `apps/server-pilot/src/outlook-security/README.md`. They are not part of the 15-minute call. Ask the operator to confirm the test email syncs before the call.

---

## Part 3. Sign in

1. Open the **Nava** pane in Outlook (Nava tab, then Nava Assistant).
2. Click **Sign in**. Use your own approved account. Do not use a shared login.
3. If the pane shows **Detected Outlook Account**, check the email and property. Click **Confirm Account & Connect**.
4. Click **Run system check**. It checks that Outlook, the selected email and the Nava server all respond.
5. The staff session lasts 24 hours. Sign in again when asked.

---

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| The pane is blank | The pane has not loaded. | Close the pane. Reopen it from the Nava tab. Click **Run system check**. Check Classic Outlook and version 1.0.14. If still blank, note the time and what you see (no guest data). Call the operator. |
| Sign-in fails for an existing staff account | An old 1.0.11 client may still be in use. | Close Outlook. Install 1.0.14 over it. Ask the operator to check the old client is disabled. |
| Sign-in fails for a new account | Self sign-up is closed. The account may not be verified, or may have no mailbox access. | Operator checks the account is verified and has mailbox access. Do not run `seed-prod`. |
| Update notice shows in the pane | The installed add-in is old. | Close Outlook. Install 1.0.14. |
| "Staff session expired; sign in again" | The 24-hour session ended. | Sign in again. |
| "HMS is busy" or "1 quote ahead" | Another quote is running. HMS runs one at a time. | Wait. Do not click **Run next** again. Usually about 5 minutes. |
| "HMS is not responding. Try again in a few minutes." | A run is taking far too long, or it has waited more than 15 minutes. | Wait about 5 minutes. Try once. If it happens again, the operator checks HMS. Note the time. |
| Antivirus or endpoint warning on download or install | Endpoint protection blocked the file. | Stop. Do not turn off antivirus. Call IT. |
| Windows "protected your PC" (SmartScreen) | The publisher is not recognised. | Click **More info**, then **Run anyway**, only if the hash matched (Step 3) and IT approved it. |
| Installer says Outlook is still open | Outlook is not fully closed. | Close Outlook (File, then Exit). Run the installer again. The installer never closes Outlook for you. |
| Code refused, or code expired | Codes are one use and last 10 minutes. | Operator issues a new code. |
| **Insert draft in Outlook** is greyed out | The add-in is old, or the mailbox is not the default Drafts store. | Do not work around it. Operator decides. |
| "Outlook may have created the draft but did not confirm it" | Outlook may have saved the draft already. | Check Outlook **Drafts** before retrying. A retry reuses the same PDF. Do not make two drafts. |
| "This email has not finished syncing yet" | Sync for that email is not done. | Wait a minute. Select the email again. |

---

## Known gaps to tell the founder before the call

These are facts from the repo that differ from, or limit, what the call would otherwise promise.

1. **Installer version.** The brief says 1.0.14. The last recorded release in the repo (2026-10-02) is 1.0.12. Confirm the 1.0.14 file and hash before the call.
2. **Device code scope.** The runbook says one code per Windows user, not per PC.
3. **Shared-store reply blocker.** On a shared mailbox that is not the default Drafts store, reply drafts are refused on purpose (runbook, order of operations, step 8). "Insert draft in Outlook" may not work for those staff.
4. **Change and cancel.** Only in branch `feat/luna-v4-a`. Cancelling from the pane is switched off, or works only on test bookings.
5. **Multi-date quotes.** The pane blocks one combined PDF. Luna's own note says "quote the first, add the others by hand."
6. **Badges.** The code shows only Quote, Booking and Other labels. It has no Change or Cancel label.
7. **Windows is not tested here.** The repo's own onboarding doc says Linux tests and source reading do not prove Windows Outlook behaviour. The first real PC is the test.

---

## Sources

- `apps/server-pilot/deploy/outlook-v4-security-release-runbook.md` (order of operations, steps 6 and 7; the shared-store reply blocker and the multi-pane draft check are in step 8)
- `docs/production-readiness/outlook-history-live-sync-onboarding.md` (preparation, staff flow)
- `docs/production-readiness/2026-10-02-outlook-security-deployment.md` (installer hash, 1.0.11 upgrade)
- `apps/server-pilot/scripts/outlook-device-operator.ts` (`issue` command and output)
- `apps/server-pilot/src/outlook-security/README.md` (StoreID check, 10-minute code, 24-hour staff session)
- `apps/mail/components/settings/outlook-setup-download.tsx` (in-app install steps)
- `apps/mail/app/(routes)/outlook-pane/page.tsx` (pane screens and button labels)
