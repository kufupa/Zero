# Handoff: one Outlook, multiple mailboxes

**Question for next LLM:** How should Nava support one person using one Outlook desktop app with multiple inboxes—specifically Ianda’s mailbox and the Da Vinci mailbox—while switching between them? The Nava side panel must stay usable for the active mailbox. Owner asks whether one Nava login/password can serve both; distinguish that from the mailboxes’ own credentials.

## What happened

- Faith’s Outlook pairing was attempted during a live call. Two copied StoreIDs decoded to PST files (`archive2024.pst`, then a Da Vinci-labelled `Reservations Manager.pst`), not an unambiguous Faith mailbox store.
- The SSM pairing command returned `Invalid operator approval` (response code 1) on both attempts. The first command had a StoreID casing typo; the exact-case retry failed the same way. No enrollment code was issued; no device was paired.
- The call brief says enrollment currently uses one staff/mailbox pair and auto-approves the read root only when the device has exactly one grant. Multi-mailbox behavior is unverified.

## Ask

Inspect current auth, device/grant, Outlook store-root, transport-mailbox, and pane-selection flows. Recommend the smallest safe model for one Nava sign-in with explicit grants to multiple mailboxes and correct active-mailbox switching. Identify what one login/password means (Nava identity vs mailbox credentials), migration implications, and a staff-visible acceptance test. Do not implement, deploy, or issue another pairing code until owner approves the design and the correct mailbox stores are identified.
