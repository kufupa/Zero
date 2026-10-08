# Onboarding call script: Luna in Outlook (15 minutes)

For the founder running the call at about 08:00 UK (09:00 in South Africa).

**Roles**

- **Founder:** runs the call and talks.
- **Operator:** on standby. Issues the device code. Watches for HMS problems.
- **Staff member:** hands on the keyboard. One person at a time.
- **Note-taker:** writes down the feedback answers.

**Before the call:** finish the checklist in `2026-10-08-install-and-onboarding.md`. Send the staff guide (`2026-10-08-staff-guide.md`) to the staff member beforehand.

**Test data only.** Use test emails and test stays. Agree with the hotel before the call that a test quote in HMS is acceptable. Each quote run uses HMS.

---

## Minute by minute

| Time | Length | What happens |
|---|---|---|
| 0:00 | 1 min | **Open.** Say the three promises (below). |
| 0:01 | 5 min | **Install.** Staff follows Part 1 of the install doc. Operator gets ready to issue the code. |
| 0:06 | 3 min | **Sign in.** Staff follows Part 3 of the install doc. |
| 0:09 | 5 min | **One quote, together.** One person clicks **Run next**. Everyone watches the progress line. Ask the feedback questions while it runs. |
| 0:14 | 1 min | **Booking copy.** Open a booking test email. Click **Copy** on two fields. Then ask the closing question and say what happens next. |

If you run late, cut the booking copy to a 30-second walkthrough. Move the change-email try to a 10-minute follow-up call.

---

## 1. Open (1 minute)

Say this:

> Luna is a helper inside Outlook. It reads the email you have open and sets up the quote. It has three rules.
> One: Luna never sends email. You press Send.
> Two: Luna never books or cancels on its own. You make every change in HMS.
> Three: Luna never invents prices. The prices come from HMS.

Hand out the staff guide. Say: "You do not need to memorise it. Keep it open."

---

## 2. Install (5 minutes)

- Staff closes Outlook. Staff saves drafts first.
- Staff downloads and runs the installer, following Part 1 of the install doc.
- If Windows or antivirus blocks the file, **stop**. Call IT. Do not turn off antivirus.
- When the pairing dialog appears, the operator issues the one-use code. The code lasts 10 minutes.
- The operator gives the code to the staff member in person or by phone. Not in chat.

**If the install is not possible in 5 minutes:** say so. Note the blocker. Book a follow-up. Do not install a file that IT has not approved.

---

## 3. Sign in (3 minutes)

- Staff opens the Nava pane. Clicks **Sign in**.
- If the pane shows **Detected Outlook Account**, staff checks the details and clicks **Confirm Account & Connect**.
- Staff clicks **Run system check**. Everything should respond.

Say: "Each person signs in with their own account. The pane asks you to sign in again about once a day."

---

## 4. One quote, together (5 minutes)

**Rule: one person clicks at a time.** HMS runs one quote at a time. A second click waits in line. A run takes about 5 minutes.

1. Staff opens a **quote** test email in Outlook. Waits for Luna to read it.
2. Staff checks the stay details and the Quote header with the group. Fix anything wrong.
3. Staff clicks **Run next**, once.
4. Everyone watches the progress line. Use the wait for the feedback questions (below).
5. When it finishes, staff clicks the room option under **Results**.
6. Staff looks at **See what Luna did in HMS**.
7. Staff clicks **Prepare quotation PDF**, then **Insert draft in Outlook**.
8. Staff checks the draft in Outlook. **Do not press Send on the call.** Say: "This is where you would press Send. Today we stop here."

**Check first:** if **Insert draft in Outlook** is greyed out, skip step 7 and say why. (See "Known gaps" in the install doc.)

---

## 5. Booking copy (1 minute)

1. Staff opens a **booking** test email. Luna reads it as **Booking**.
2. Under **Booking draft**, staff clicks **Copy** next to **Arrival**. Then **Copy** next to **Last name**.
3. Staff pastes each one into a plain text box on screen (not into HMS).
4. Say: "For now, copy is how the fields get into HMS. The **Book in HMS** and **Save draft** buttons are greyed out."

---

## 6. Change email (not on the 15-minute plan)

Only if there is time, and only if the build has change lookup (branch `feat/luna-v4-a`).

1. Staff opens a change test email.
2. Staff clicks **Find this booking in HMS**. Wait for it to finish. Do not run it during a quote run.
3. Show the two columns: **What the guest asked** and **Booking in HMS now**.
4. Say: "Luna only looks. You make the change in HMS." Do not cancel anything.

If there is no time, say: "We will do this part in the follow-up."

---

## What to say when it is slow

Use these lines in order. Do not fill silence with apologies.

- "HMS runs one quote at a time. Ours is in line. A normal run is about 5 minutes."
- "The progress line shows the steps: searching rates, checking the rules, saving the quote."
- "Nothing is sent while you wait. The draft stays in Outlook until you press Send."
- "Use the wait. Check the dates and the room types against the email."
- If it says **1 quote ahead of yours**: "Someone else's quote is first. Wait. Do not click again."
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
5. Which part of the guide is missing, or too long?
6. What would make you stop using this on a busy shift?
7. If HMS is slow on a busy day, what would you need to be told?

Close with: "What is the one thing to fix before next week?"

---

## After the call

- [ ] Note-taker sends the answers to the founder the same day.
- [ ] Operator records: device ID, StoreID, Outlook version, installer version. **Not the code and not the device secret.**
- [ ] Any blocker goes on the list with an owner and a date.
- [ ] Book the 10-minute follow-up for change emails and the first real quote.
- [ ] Remove any test data that was made in the pane or in Outlook drafts.

---

## Do not on the call

- Do not use real guest names, emails or phone numbers. Not in the pane, not in Outlook, not on screen.
- Do not press **Send**.
- Do not run `seed-prod`.
- Do not use New Outlook.
- Do not send the one-use code in chat or in a ticket.
- Do not turn off antivirus or endpoint protection.
