# PRODUCT.md — Nava reservationist (Centurion)

Ship mode (owner, 2026-11-18): working product end to end, fast. The owner's latest message wins over this file.

Staff-facing name: **Nava**. Never show the model name to staff.

## What this is

Nava is an AI reservationist for Legacy Hotels Centurion (HRCEN). Da Vinci (HRDAV) comes later.

- Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`), and the same `NavaPane` renders in the nava-admin webmail panel. Every pane feature ships on both surfaces.
- Nava reads the selected email, prefills, and runs deterministic Infor HMS Cloud tools (Playwright, `apps/server-pilot/tooling/hms-cloud/`).
- HMS is the system of record. Staff approve every write.

## Who it is for

Centurion reservations staff.

- Never ask them to run scripts or terminals.
- Never show raw technical errors.
- If something takes more than 30 s, say so in plain language.

## Core workflows (all in scope now, built in parallel)

Recreate what a reservationist does in HMS, field for field, and nothing more. Every write workflow follows the same steps:

1. Nava prefills from the email.
2. Staff can edit every field Nava has a tool for.
3. **Prepare** stages the change in HMS and shows HMS's result without saving.
4. Staff **Go** → Save → fresh readback.

The workflows:

1. **Triage**: classify inbound mail. Keep per-stay actions and genuine second asks.
2. **Quote**: organization/agency contract rates, which cover most bookings.
   - Output is a cover email + PDF + Excel. BAR B&B; dinner is a hotel-specific add-on.
   - Never name unrelated third-party organizations in a reply body; confirming the requesting client's own verified `Organization` back to a direct corporate booker is allowed.
   - Fully booked → one-line decline. Offer an alternative only if staff pick "Use this".
   - Price in the background when the email opens (reads only).
3. **Create**: uses an existing HMS guest profile, or creates one when the guest has none.
   - Staff confirm stay, room, rate plan, meal plan, booking agency/organization, A/R account / billing reference, guarantee, note and CMS.
   - HMS prices the stay (Check Availability), and Nava shows that price before Go.
   - Missing profile → Nava prefills a new Guest Profile from the email and creates it from the pane on the staff's own click (the same click that checks the price). Staff never go to HMS for a profile.
     - When HMS has likely matches, or raises its duplicate question, Nava ranks the matches and staff pick one or choose New. It never creates a duplicate silently.
   - Typed nightly rate: on the property's override rate codes staff may type the nightly rate, and a quote row staff priced by hand carries its rate into Create. Nava stages it, shows HMS's total before Go, requires a note saying who approved it, and reads the rate back after Save.
   - Multi-room = sequential single-room creates (1–8 rooms) under one Go.
4. **Amend**: find the confirmation, then change what the guest asked for: dates/nights, room type, room type for charge, adults/children and ages, rate plan, booking agency/organization, reservation note, billing reference, guest/booker details, and CMS. HMS reprices, and Nava shows the new price and the common rate options before Go.
5. **Cancel**: find the confirmation and cancel with a reason. Show HMS cancellation policy details before Go when available. If HMS reports a fee after Save, show the amount and tell staff to post it in HMS if the hotel charges it. Nava does not post the fee.
6. **Filing**: file the selected voucher/POP PDF into the stay's Documents. Staff can search for and choose the stay when extraction misses it.

**CMS confirmation (Create and Amend)** is a staff control: a tick box (default on), a CMS message ID and a recipient email, all editable. HMS sends its confirmation only when staff leave it ticked. Nava never sends email itself; it saves unsent drafts.

**Deferred (later scope):** typed rates on Amend and complimentary (zero-rate) stays until typed rates on Create are proven live, folio billing/refunds and an Auto-Transfer Playwright writer (surface memory hint badge only), native groups and XLSX imports, new OCR.

HMS supplies live booking, rate, and availability facts, and staff decide. Don't invent fake rate math or credit-eligibility rules; DO deterministically prefill Organization/Agency -> A/R Account, billing reference, guarantee, and Reservation Note payer routing from verified HMS memory and directories (never prefill a post-checkout `Refund Account` on new stays).

## Front door

- **Skip** OTA, channel, automated and spam mail. Travel-agent mail stays in scope.
- Generalise; don't overfit. Owner exact-host exclusions (Profitroom, Tiket.com, RateTiger, H-Pay `hospitality.cloud`) are in the [asks log](PRODUCT-ASKS-HISTORY.md#asks-logged), 2026-10-14. Travelit and TBO stay in scope.

**Pre-stay self-mail (owner rule):** mail the hotel's own mailbox sends to itself, titled "Pre Stay : Property … Confirmation No <conf> <name>", is about an **existing** booking. Never offer Create for it. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match. Keep any separate current ask in the same mail.

## Pane

One primary action per step. No dead controls. Use Infor HMS field labels across panes, contracts, and prompts (`Organization`, `Meal Plan`, `Room Type for Charge`, `Primary Booking Agency`). The layout may be redesigned (see `AGENTS.md`).

## Rules

- **Privacy:** guest data may be stored, logged and used in tests and LLM chats (PIA/GDPR, NDAs and zero-retention providers cover this). Never send credentials or secrets to external services.
- **Writes:** real-guest writes happen only when staff click Go in the pane, and agents never press Go on a real guest. Labtest writes (Proof Labtest guest, 2027+ stays, CMS off) and HMS reads/unsaved staging on real guests are always allowed. No write flags or canary gates: once a workflow is deployed, staff can use it.
- **Uncertain Save:** never blind-retry. Re-read HMS first.

Everything else on how to work is in `AGENTS.md` (ship mode).

## Done

The product is done when staff can do all six workflows from the pane on deployed main, and the scoreboard (real corpus emails replayed through the pane API path) shows, per workflow: e2e completion %, field accuracy against what staff did, p50/p95 latency and $/email. Accuracy improves after launch. Working e2e comes first.
