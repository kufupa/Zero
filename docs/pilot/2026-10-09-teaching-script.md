# Teaching call: Nava in Outlook (15 minutes)

For the owner, on a call with the Centurion reservationist. Plain words. Read the lines marked **Say** out loud. The rest is for you.

Status: labels and messages checked against main on 2026-10-09 (commit 31ae92cb4). Items marked **TODO(owner)** need you before the call.

**Roles.** The owner talks and shows. The reservationist uses the keyboard. One person at a time.

**Test data only.** Use test emails and test stays. No real guest names, emails or phone numbers on screen.

**Words used on the call.** HMS is the hotel booking system. Nava is the helper inside Outlook.

---

## Before the call (owner, not read aloud)

- [ ] Two test emails ready: one quote and one booking. A change or cancellation test email is a bonus.
- [ ] The PC has **Classic** Outlook. New Outlook is not supported.
- [ ] IT has approved the installer, and the file has been checked before the call by IT or the operator. The reservationist does not check files. If IT has not approved it, cut the install and book a follow-up.
- [ ] Decide whether the booking card is on for this call. The operator sets the server switch `RESERVATIONIST_PANE_SAVE`: unset means off, `lab` shows the booking card for lab stays only, `on` is for real guests. If it is off, skip the booking card in section 7.
- [ ] Check that the shared mailbox is the default Drafts folder. If it is not, **Insert draft in Outlook** is refused, so skip that step and say why.
- [ ] Support contact for the call: **TODO(owner)**.

---

## Timeline

| Time | Length | What happens |
|---|---|---|
| 0:00 | 1 min | Open. The three rules. |
| 0:01 | 4 min | Install and sign in. |
| 0:05 | 2 min | Pre-filled details on a test quote email. |
| 0:07 | 2 min | Company or agency, and the rate. |
| 0:09 | 2 min | Extras and notes. |
| 0:11 | 2 min | Run next, then the PDF, the Excel file and the draft. |
| 0:13 | 1.5 min | Booking card, finding a booking, and cancelling (explain; show if there is time). |
| 0:14:30 | 30 sec | If something looks wrong. Close. |

**Owner note:** A real run takes about five minutes. Start it early and keep talking while it runs. HMS runs one quote or find at a time, so do not start a find while a quote is running.

---

## 1. Open (1 minute)

**Say:**

> Nava is a helper inside Outlook. It reads the email you have open and helps you prepare a quote. It uses HMS to look up rooms and rates.
>
> Three rules. One: Nava never sends an email. You press Send. Two: Nava does not book, change or cancel on its own. You press each booking button yourself. Three: Nava does not make up prices. The prices come from HMS.
>
> Some buttons are switched off for now. Your manager will switch them on later.

---

## 2. Install and sign in (4 minutes)

**Say:**

> We are installing the newest Nava for Outlook, version 1.0.17. First, close Outlook. Save your drafts, then click File, then Exit.

The reservationist does this:

1. Close Outlook fully: File, then Exit. Save drafts first.
2. Open Microsoft Edge. Go to `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`.
3. If Edge says the file is not commonly downloaded, click **Keep**. If it asks again, click **Keep anyway**.
4. Open Downloads. Double-click **NavaOutlookSetup.exe**.
5. If Windows says it protected your PC, stop and call the owner. Click **More info**, then **Run anyway**, only if IT has approved the file.
6. If Windows asks about a publisher, click **Yes** only if IT has approved it. If not, stop.
7. Wait for the installer to finish.
8. Open **Classic** Outlook. Click the **Nava** tab, then **Nava Assistant**.

**Say:**

> If anything asks you to approve the file and IT has not approved it, stop. Do not turn off antivirus.

Then sign in:

1. Click **Sign in**. Use your own account. Never use a shared login.
2. If the pane shows **Detected Outlook Account**, check the email and the property. Click **Confirm Account & Connect**.
3. Click **Run system check**. Wait for it to finish.

**Say:**

> Each person signs in with their own account. The pane asks you to sign in again about once a day.

**Owner note:** If the pairing box asks for a code, the operator gives you a one-use code, in person or by phone. It works once and lasts 10 minutes. Do not put it in chat or email.

---

## 3. Pre-filled details (2 minutes)

**Say:**

> Open the test quote email. Nava fills in what it can from that email. Check every box before you press Run next. If something is wrong, fix it by hand.

**Owner note:** the viewer check passed: on a real booking request Nava pre-filled dates, adults, meal plan and company (13 fields). Pre-fill depends on what the email says; always check.

---

## 4. Company or agency, and the rate (2 minutes)

**Say:**

> Type the agency name in the **Agency** box. Press **Find in HMS** under it. Pick the right match. It shows as a chip. Press **Clear** to change it.
>
> For the rate, leave **Rate type** on **BAR (best available rate)**.

**Owner note:** **Find in HMS** is on main (#61, wired by #82). The contract-rate option and the "No contract rate found" message come from #79, which is still open. Contract rates (#79) are merged: when a company or agency is picked, the quote uses the rates HMS marks as contract; if none, it says "No contract rate found for <party>; this quote uses our best available rate." This was not proven end to end tonight, so try one quote together first.

---

## 5. Extras and notes (2 minutes)

**Say:**

> Each extra has its own box. Put each amount in its own box. Do not type extras into Notes.

- **Dinner allowance (R per person per night):** enter the rand amount per person per night.
- **Lunch allowance (R per person per night):** the same.
- **Office transfer (R per person per day):** leave **Office transfer days** blank to use the nights of the stay.
- **Shuttle:** tick **Shuttle requested**, then enter **Shuttle trips** and **Shuttle amount**.
- **Other amount:** anything else with a price.
- **Notes for the quote:** only words for the quote. No prices here.

**Owner note:** These labels are on main (#60, with the layout in #82). Check them on the build you use before the call.

---

## 6. Run next, then the outputs (2 minutes, plus the wait)

**Say:**

> Press **Run next**. Press it once. Do not press it again while it runs.
>
> A normal run takes about five minutes. The progress line shows what it is doing. While it runs, check the dates and room types against the email.
>
> When it finishes, check the room option Nava chose.
>
> Press **Prepare quotation PDF**. Then press **Download Excel**.
>
> Press **Insert draft in Outlook**. This puts a reply in your Drafts. If there are several date options, press **Create one reply with all date options** instead.
>
> Check the draft. Do not press Send today. Today we stop here.

**Owner note:** The button says **Run next**. Teach that name. Under the run there is a link, **See what Nava did in HMS**. It opens the HMS screenshot. If **Insert draft in Outlook** is refused, skip it and say why. It is refused when the shared mailbox is not the default Drafts folder.

---

## 7. Booking card, finding a booking, and cancelling (1.5 minutes)

**Booking card.** Only if it is on.

**Say:**

> On a booking email, the booking card shows the stay. Use **Copy** next to any field you need.
>
> Press **Preview in HMS** first. It checks the room in HMS. **Book in HMS** stays locked until you have previewed.
>
> Do not book a real guest. Press Book only when I say, and only on a test stay.

**Owner note:** The booking card shows only when the server switch is `lab` or `on`. It is unset (off) today, and the owner decides. In `lab` mode the button reads **Book (lab test only)**. Test stays only.

**Finding a booking.**

**Say:**

> On a change or cancellation email, press **Find this booking in HMS**. It only looks. It takes about one to two minutes. Do not start a quote while it runs.
>
> For a voucher or a proof of payment, press **Find the booking in HMS** on that email.
>
> When a confirmation number shows, press **Copy confirmation** to copy it. Press **Open HMS** to open the HMS sign-in page in your browser, then find the booking by that number.

**Owner note:** **Open HMS** goes to the HMS sign-in page only. It does not open the booking. **Find the booking in HMS** for voucher and proof-of-payment mail is merged (#73), and the live viewer shows the card on real voucher emails (with "Save attachment"). If the voucher PDF is a scan, Nava says so and asks staff to search HMS by name.

**Cancelling.**

**Say:**

> On a cancellation email, press **Preview cancellation** first. Nothing is cancelled yet.
>
> Press **Cancel booking in HMS** only when I say. Charges are not set in Nava. If HMS shows a cancellation charge, Nava stops. You cancel that booking in HMS yourself.

**Owner note:** Cancelling is off unless the server switch is set. Do not cancel a real guest on this call.

---

## 8. If something looks wrong, and close (30 seconds)

**Say:**

> If something looks wrong, read the status line under the quote header. Write down what it says and the time. Do not write down guest names.
>
> If it still looks wrong, press the three dots (⋯) at the bottom of the pane, then **Check connection**. If that does not help, press the three dots again and choose **Feedback by email** or **Feedback on WhatsApp**. Then tell me.
>
> Do not keep pressing **Run next**.

**Owner note:** The ⋯ menu and its items are on main (#76). Check the wording on screen before the call.

Messages you may see. They are copied from the server and the pane. Check the wording on screen before the call.

| On screen | What to do |
|---|---|
| 1 quote ahead of yours, with a wait time | Wait. Do not press **Run next** again. |
| HMS is busy with another quote or lookup. Try again in a minute. | Wait one minute. Try once. |
| HMS is not responding. Try again in a few minutes. | Wait about five minutes. Try once. Then tell me. |
| Staff session expired; sign in again | Sign in again. |
| This email has not finished syncing yet | Wait a minute. Select the email again. |
| Outlook may have created the draft but did not confirm it | Check Outlook **Drafts** before you try again. Do not make two drafts. |
| Update notice in the pane | Close Outlook. Install 1.0.17 again. |

**Say (close):**

> You have seen the whole flow. Next time, you do it yourself on a real email, and you press Send yourself. What is the one thing you want fixed first?

**Owner note:** **TODO(owner):** agree the follow-up date.

---

## Do not on the call

- Do not use real guest names, emails or phone numbers.
- Do not press **Send**.
- Do not press **Book in HMS** or **Cancel booking in HMS** on a real guest.
- Do not switch booking or cancelling on during the call.
- Do not use New Outlook.
- Do not share a one-use code in chat or email.
- Do not turn off antivirus or endpoint protection.

---

## After the call (owner)

- [ ] Write down what was unclear, in the reservationist's own words. No guest data.
- [ ] Note any message on screen that was wrong or hard to read.
- [ ] Book the follow-up.
- [ ] Delete the test drafts from Outlook.
