# Outlook pane: install and onboarding

For the founder and the operator running the 08:00 UK call (09:00 in South Africa).

Use test emails and test stays only. Do not use real guest data on the call.

Build for this call: **wave 2** (`7c9a4032`) or later.

---

## What staff will have (on by default)

- **Instant pane.** Luna reads new incoming emails in advance, so results often appear as soon as staff click. Set by `LUNA_ANALYSE_WARMER=on` in `apps/server-pilot/deploy/pm2.config.cjs`.
- **Badges:** Quote, Booking, Change to booking, Cancellation, Other.
- **Change or cancel panel:** what the guest asked, and a **Find this booking in HMS** button. The find is read-only, takes about 1–2 minutes, and shows the booking, a screenshot, and an arrival-mismatch line.
- **Quote:** Run next, the queue and progress line, **See what Luna did in HMS** screenshot, **Prepare quotation PDF**, **Insert draft in Outlook**.
- **Multi-date:** run each option, then **Create one reply with all date options**.
- **Booking card** with Copy buttons.
- **Tell Luna** box and the **This is a quote request** / **This is a booking** (treat-as) buttons.

## Built but OFF (coming soon)

Staff will see these greyed out or as a note. The manager switches them on later.

- **Preview**, **Book in HMS** and **Save draft** on booking emails.
- **Preview cancellation** and **Cancel booking in HMS** on cancellation emails.

The switch is the server setting `RESERVATIONIST_PANE_SAVE`. It must be exactly `on`. Any other value, or no value, keeps it off. Off is the default.

When it is on:

- Book in HMS stays locked until the room has been previewed.
- Cancel commits only for test stays arriving on or after 2027-01-01. For any other stay, staff see: "Cancelling from here only works on test bookings right now."

---

## Before the call: checklist

Tick each line before 08:00. If a line fails, fix it or cut that part of the call.

### Installer

- [ ] Installer: `NavaOutlookSetup.exe`, **version 1.0.14**.
- [ ] Download link: `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`
- [ ] SHA-256 (1.0.14, verified on the server 2026-10-08 05:55 UTC): **`e5e8a99b89f77aa2b88b933e249598afcfd7073c029bfa6ffadb070e9b07b5df`**. Do not use the hash in the 2026-10-02 security record. It is for 1.0.12.
- [ ] The file hash must match the full value before anyone runs it (see Part 1, step 3).

### Staff PC

- [ ] **Classic Outlook only.** New Outlook is not supported. If Outlook looks new, switch back to Classic first.
- [ ] Outlook version and Windows type (32-bit or 64-bit) are written down.
- [ ] **Old 1.0.11 is not in use.** If it is installed, the staff member installs 1.0.14 over it after closing Outlook. Or the operator disables the old client. A website update cannot remove privileges from an old local program.
- [ ] Staff member has saved all drafts in Outlook, and will close Outlook before setup.
- [ ] Outlook can see the shared mailbox, and saved sent copies are visible.
- [ ] **Shared mailbox is the default Drafts store** on that Outlook profile. If it is not, **Insert draft in Outlook is refused**. This is by design (see "Known gaps", item 3). Leave the Insert draft step out of the call in that case.

### Accounts and access (operator checks; do not guess)

- [ ] Named staff account. Email verified.
- [ ] The account has access to the shared mailbox.
- [ ] **Do not run `seed-prod` to add staff.** It can delete other accounts.
- [ ] The operator has the exact Outlook **StoreID** for the staff PC. Get it with the read-only PowerShell check in `apps/server-pilot/src/outlook-security/README.md`. Do not guess it from a folder name.

### IT and security

- [ ] **IT has approved the publisher and certificate** for this installer. Without IT approval, do not run the installer on the call.
- [ ] Nobody turns off antivirus or endpoint protection.

### Operator

- [ ] Operator is online for the whole call, with the restricted operator shell ready (approved database access and the wrapping key in its environment). Never print the key.
- [ ] Operator knows the one-use device code lasts **10 minutes**.
- [ ] Operator has checked `RESERVATIONIST_PANE_SAVE` is not `on` unless the manager has decided otherwise. The call does not rely on it.
- [ ] Operator has checked `LUNA_ANALYSE_WARMER=on` on the server, so the instant pane is on.

### Build and test data

- [ ] The pane build is wave 2 or later, with the note-copy fix. On a change email, the **Find this booking in HMS** button is there, and no amber note says "not supported yet".
- [ ] The test email has synced. Luna says "This email has not finished syncing yet" until it has.
- [ ] Test emails are ready: one quote, one booking, one change email. Use test stays only.
- [ ] Contact placeholders are filled in (see "Who to contact" below).

---

## Part 1. Install on the staff PC

### Step 1. Close Outlook

1. Save all drafts in Outlook.
2. Close Outlook fully. Use File, then Exit.
3. The installer does not close Outlook for you. If it cannot confirm that Outlook has closed, it refuses to replace the add-in files.

### Step 2. Download

1. Open Microsoft Edge.
2. Go to `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`.
3. If Edge says the file "isn't commonly downloaded", click **Keep**.
4. If Edge asks again, click **Keep anyway**.

### Step 3. Check the file (operator or IT)

1. Open Windows PowerShell in the Downloads folder.
2. Run: `Get-FileHash .\NavaOutlookSetup.exe -Algorithm SHA256`
3. Compare the result with the SHA-256 for 1.0.14: `e5e8a99b89f77aa2b88b933e249598afcfd7073c029bfa6ffadb070e9b07b5df`.
4. If the value does not match, **stop**. Do not run the file. Call the founder.

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

The pairing dialog needs a one-use code. The operator makes it.

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
- **One code per Windows user.** Device credentials are per Windows user. If two people use one PC, each needs their own code, from a separate run of the command.

### Step 2. Give the code to the staff member

- Pass the code in person or by phone. Do not send it by chat, email, a ticket, or the pane.
- The code works once.
- The code expires after **10 minutes**. If it expires, the operator runs the command again.

### Step 3. Staff member pairs

1. The pairing dialog asks for the code.
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
5. The staff session lasts 24 hours. Sign in again when asked ("Staff session expired; sign in again").

---

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| The pane is blank | The pane has not loaded. | Close the pane. Reopen it from the Nava tab. Click **Run system check**. Check Classic Outlook and version 1.0.14. If still blank, note the time and what you see (no guest data). Call the operator. |
| Sign-in fails for an existing staff account | An old 1.0.11 client may still be in use. | Close Outlook. Install 1.0.14 over it. Ask the operator to check the old client is disabled. |
| Sign-in fails for a new account | Self sign-up is closed. The account may not be verified, or may have no mailbox access. | Operator checks the account is verified and has mailbox access. Do not run `seed-prod`. |
| Update notice shows in the pane | The installed add-in is old. | Close Outlook. Install 1.0.14. |
| "Staff session expired; sign in again" | The 24-hour session ended. | Sign in again. |
| "1 quote ahead of yours" or "HMS is busy with another run" | Another quote is running. HMS runs one at a time. | Wait. Do not click **Run next** again. Usually about 5 minutes. |
| "HMS is busy with another quote or lookup. Try again in a minute." | A quote or find holds the HMS lock. A find waits up to 20 seconds for it, then gives up. | Wait one minute. Try once. |
| "HMS is not responding. Try again in a few minutes." | A quote run is far too long, or it has waited more than 15 minutes for HMS. | Wait about 5 minutes. Try once. If it happens again, the operator checks HMS. Note the time. |
| "Luna can't reach HMS right now. Tell the Nava team." | HMS or the Nava server is not reachable from the pane. | Tell the operator with the time. |
| Antivirus or endpoint warning on download or install | Endpoint protection blocked the file. | Stop. Do not turn off antivirus. Call IT. |
| Windows "protected your PC" (SmartScreen) | The publisher is not recognised. | Click **More info**, then **Run anyway**, only if the hash matched (Part 1, Step 3) and IT approved it. |
| Installer says Outlook is still open | Outlook is not fully closed. | Close Outlook (File, then Exit). Run the installer again. The installer never closes Outlook for you. |
| Code refused, or code expired | Codes are one use and last 10 minutes. | Operator issues a new code. |
| **Insert draft in Outlook** is greyed out, or refused with an error | The add-in is old, or the shared mailbox is not the default Drafts store. | Do not work around it. Reply by hand in Outlook. The operator decides next steps. |
| "This Outlook add-in is too old to attach the PDF" | The add-in is old. | Install 1.0.14. |
| "Outlook may have created the draft but did not confirm it" | Outlook may have saved the draft already. | Check Outlook **Drafts** before retrying. A retry reuses the same PDF. Do not make two drafts. |
| "This email has not finished syncing yet" | Sync for that email is not done. | Wait a minute. Select the email again. |
| "Luna is not connected to this pane yet. Refresh the pane and try again." | The pane has not linked to Luna yet. | Refresh the pane. If it happens again, call the operator. |
| An amber note "Changing or cancelling a booking is not supported yet." appears next to the change panel | The build is older than the note-copy fix (see "Known gaps", item 5). | Check the build includes the fix. The note should read "Luna can find the booking; make the change in HMS yourself." The **Find this booking in HMS** button works either way. Make every change by hand in HMS. |

---

## Known gaps to tell the founder before the call

These are facts from the repo that differ from, or limit, what the call would otherwise promise.

1. **Installer hash.** The version is 1.0.14. SHA-256 `e5e8a99b89f77aa2b88b933e249598afcfd7073c029bfa6ffadb070e9b07b5df` (verified on the server).
2. **Device code scope.** Device credentials and the one-use code are per Windows user (runbook step 6, and the operator README).
3. **Shared-store reply blocker.** On a shared mailbox that is not the default Drafts store, the add-in refuses to create the reply draft, by design (runbook, order of operations, step 8). **Insert draft in Outlook is refused on non-default shared mailboxes.** Staff must reply by hand in Outlook for those mailboxes.
4. **Book and cancel are off.** Preview and Book in HMS, and Preview and Cancel in HMS, stay off until `RESERVATIONIST_PANE_SAVE=on`. Cancel commits only for test stays (arrival on or after 2027-01-01).
5. **Amber note with the change panel: fixed in code.** The server can set the `amendment_or_cancel` flag on a change or cancel email. While the change panel is on screen, the amber list no longer says "not supported yet". It reads "Luna can find the booking; make the change in HMS yourself." Confirm the build includes this fix before the call.
6. **Multi-date.** The combined reply attaches one PDF per completed option. It is one email draft, not one PDF.
7. **Windows is not tested here.** The repo's own onboarding doc says Linux tests and source reading do not prove Windows Outlook behaviour. The first real PC is the test.
8. **Instant pane depends on a server flag.** `LUNA_ANALYSE_WARMER=on` is set in the pm2 deploy config. Without it, results are not pre-read.

---

## Who to contact

These are placeholders. Replace each one before the call.

| For | Who | Phone |
|---|---|---|
| Operator | **[PLACEHOLDER – operator name]** | **[PLACEHOLDER – operator phone]** |
| Founder | **[PLACEHOLDER – founder name]** | **[PLACEHOLDER – founder phone]** |
| IT | **[PLACEHOLDER – IT contact name]** | **[PLACEHOLDER – IT phone]** |

---

## Sources

- `apps/server-pilot/deploy/outlook-v4-security-release-runbook.md` (order of operations, steps 6 and 7; the shared-store reply blocker and the multi-pane draft check are in step 8)
- `docs/production-readiness/outlook-history-live-sync-onboarding.md` (preparation, staff flow)
- `docs/production-readiness/2026-10-02-outlook-security-deployment.md` (earlier installer record; 1.0.12, and the 1.0.11 upgrade)
- `apps/server-pilot/scripts/outlook-device-operator.ts` (`issue` command and output)
- `apps/server-pilot/src/outlook-security/README.md` (StoreID check, 10-minute code, 24-hour staff session)
- `apps/server-pilot/src/ai/pane-stay-save.ts` and `pane-stay-cancel.ts` (`RESERVATIONIST_PANE_SAVE`, the 2027-01-01 cancel floor)
- `apps/server-pilot/src/hms/property-read-lock.ts` and `apps/server-pilot/src/ai/pane-stay-lookup.ts` (20-second lock wait)
- `apps/server-pilot/src/ai/quote-workflow-warmer.ts` and `apps/server-pilot/deploy/pm2.config.cjs` (`LUNA_ANALYSE_WARMER`)
- `apps/mail/components/settings/outlook-setup-download.tsx` (in-app install steps)
- `apps/mail/app/(routes)/outlook-pane/page.tsx` (pane screens, button labels and draft messages)
