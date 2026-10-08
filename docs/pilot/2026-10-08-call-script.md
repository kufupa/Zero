# Onboarding call script: Luna in Outlook (15 minutes)

For the founder running the call at about 08:00 UK (09:00 in South Africa).

**Roles**

- **Founder:** runs the call and talks.
- **Operator:** on standby. Issues the device code. Watches for HMS problems.
- **Staff member:** hands on the keyboard. One person at a time.
- **Note-taker:** writes down the feedback answers.

**Before the call:** finish the checklist in `2026-10-08-install-and-onboarding.md`. This includes the full SHA-256 for installer 1.0.14 (still TBC), and filling in the contact placeholders. Send the staff guide (`2026-10-08-staff-guide.md`) to the staff member beforehand.

**Test data only.** Use test emails and test stays. Agree with the hotel before the call that test quote runs in HMS are acceptable. Each quote run and each find uses HMS.

---

## Timeline (15 minutes)

| Time | Length | What happens |
|---|---|---|
| 0:00 | 1 min | **Open.** Say the three rules (below). |
| 0:01 | 5 min | **Install.** Staff follows Part 1 of the install doc. The operator issues the device code when the pairing dialog appears. |
| 0:06 | 3 min | **Sign in.** Staff follows Part 3 of the install doc. |
| 0:09 | 5 min | **One quote, together.** One person clicks **Run next**. Everyone watches the progress line. Ask the feedback questions while it runs. |
| 0:14 | 1 min | **Close.** Ask the closing question. Say what happens next. |

**Optional, only if time allows:** the change lookup (1–2 minutes) and the booking copy (1 minute). If the call runs short, move them to a 10-minute follow-up.

---

## 1. Open (1 minute)

Say this:

> Luna is a helper inside Outlook. It reads the email you have open and sets up the quote. It has three rules.
> One: Luna never sends email. You press Send.
> Two: Luna never books, changes or cancels in HMS on its own. You make every change by hand in HMS.
> Three: Luna never invents prices. The prices come from HMS.
> Some buttons are coming soon. Preview and Book in HMS, and cancelling from the pane, are switched off. Your manager will switch them on later.

Hand out the staff guide. Say: "You do not need to memorise it. Keep it open."

---

## 2. Install (5 minutes)

- Staff closes Outlook. Staff saves drafts first.
- Staff downloads the installer, following Part 1 of the install doc.
- Before anyone runs the file, the operator or IT checks its SHA-256 against the **full** 1.0.14 value. If it does not match, stop.
- If Windows or antivirus blocks the file, **stop**. Call IT. Do not turn off antivirus.
- When the pairing dialog appears, the operator issues the one-use code. The code lasts 10 minutes.
- The operator gives the code to the staff member in person or by phone. Not in chat.

**If the install is not possible in 5 minutes:** say so. Note the blocker. Book a follow-up. Do not install a file that IT has not approved.

---

## 3. Sign in (3 minutes)

- Staff opens the Nava pane. Clicks **Sign in**.
- If the pane shows **Detected Outlook Account**, staff checks the details and clicks **Confirm Account & Connect**.
- Staff clicks **Run system check**. Outlook, the selected email and the Nava server should all respond.

Say: "Each person signs in with their own account. The pane asks you to sign in again about once a day."

---

## 4. One quote, together (5 minutes)

**Rule: one person clicks at a time.** HMS runs one quote at a time, and a quote takes about 5 minutes. A change lookup also uses HMS, so it cannot run at the same time.

1. Staff opens a **quote** test email in Outlook. If you see "Luna is reading the email…", wait.
2. Staff checks the stay details and the **Quote header** with the group. Fix anything wrong.
3. If the test email has more than one date option, staff clicks the option first, under **Date options**. Each option needs its own run and PDF.
4. Staff clicks **Run next**, once.
5. Everyone watches the progress line. Use the wait for the feedback questions (below).
6. When the run finishes, staff clicks a room option under **Results**.
7. Staff opens **See what Luna did in HMS**.
8. Staff clicks **Prepare quotation PDF**. For more than one option, staff clicks **Prepare PDF for option A** instead.
9. Staff clicks **Insert draft in Outlook**. For more than one option with a PDF, staff clicks **Create one reply with all date options** instead.
10. Staff checks the draft in Outlook. **Do not press Send on the call.** Say: "This is where you would press Send. Today we stop here."

**Check first:** if **Insert draft in Outlook** is greyed out or refused, skip step 9 and say why. The shared mailbox may not be the default Drafts store (see "Known gaps" in the install doc).

---

## 5. Booking copy (1 minute, optional)

1. Staff opens a **booking** test email. Luna reads it as **Booking**.
2. Under **Booking draft**, staff clicks **Copy** next to **Arrival**. Then **Copy** next to **Last name**.
3. Staff pastes each one into a plain text box on screen. Not into HMS.
4. Say: "Preview, Book in HMS and Save draft are coming soon. For now, copy is how the fields go into HMS."

---

## 6. Change lookup (1–2 minutes, optional)

Only if there is time. The lookup is read-only.

1. Staff opens a **change** test email. The label reads **Change to booking**. The panel reads **Change to an existing booking**.
2. Staff clicks **Find this booking in HMS**. It takes about 1–2 minutes. Do not start a quote while it runs.
3. Show **What the guest asked** and **Booking in HMS now**. If the test has a different arrival, point to the amber Arrival box and the line that starts "The guest mentioned…".
4. Say: "Luna only looks. You make the change in HMS." Do not cancel anything.
5. If the cancel note appears on a cancellation test: say that cancelling from the pane is coming soon. Show the manual steps: open the booking number, Actions, Cancel Reservation.

If there is no time, say: "We will do this part in the follow-up."

---

## What to say when it is slow

Use these lines in order. Do not fill the silence with apologies.

- "HMS runs one quote at a time. Ours is in line. A normal run is about 5 minutes."
- "The progress line shows the steps: searching rates, checking the rules, saving the quote."
- "Nothing is sent while you wait. The draft stays in Outlook until you press Send."
- "Use the wait. Check the dates and the room types against the email."
- If it says **1 quote ahead of yours**: "Someone else's quote is first. Wait. Do not click again."
- If it says **HMS is busy with another quote or lookup. Try again in a minute.**: "Something else holds HMS. Wait a minute, then try once."
- If it says **HMS is not responding**: "We wait about five minutes, then try once. If it fails again, the operator checks HMS."

Do not:

- Click **Run next** again while a run is going.
- Blame the system or the staff member when something is slow or fails.
- Promise a time you cannot keep.

---

## Feedback questions

Ask these while the quote is running. Write down the answers.

1. Before I said anything, what did you think **Run next** would do?
2. Which word or line made you stop?
3. Did you feel in control, or did Luna do things you did not expect?
4. What would you check before you pressed Send on a real quote?
5. If an email has several date options, is one reply with all of them what you expected?
6. Which part of the guide is missing, or too long?
7. Which of the greyed-out buttons do you expect to need first?
8. What would make you stop using this on a busy shift?

Close with: "What is the one thing to fix before next week?"

---

## After the call

- [ ] Note-taker sends the answers to the founder the same day.
- [ ] Operator records: device ID, StoreID, Outlook version, installer version. **Not the code and not the device secret.**
- [ ] Any blocker goes on the list with an owner and a date.
- [ ] Book the 10-minute follow-up for the change lookup and the first real quote.
- [ ] Remove any test data made in the pane or in Outlook drafts.

---

## Do not on the call

- Do not use real guest names, emails or phone numbers. Not in the pane, not in Outlook, not on screen.
- Do not press **Send**.
- Do not switch on Preview, Book or Cancel during the call.
- Do not run `seed-prod`.
- Do not use New Outlook.
- Do not send the one-use code in chat or in a ticket.
- Do not turn off antivirus or endpoint protection.
