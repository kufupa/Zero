# PRODUCT.md — Nava reservationist (Centurion)

Pilot-now scope, rewritten 2026-11-04 by owner direction: the staff pilot is late, so ship the core workflows. The owner's latest message wins over this file, plans, retros and [asks history](PRODUCT-ASKS-HISTORY.md#asks-logged).

Staff-facing name: **Nava**. Never show the model name (Luna) to staff.

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
3. **Create**: uses an existing HMS guest profile.
   - Staff confirm stay, room, rate plan, meal plan, booking agency/organization, A/R account / billing reference, guarantee, note and CMS.
   - HMS prices the stay (Check Availability), and Nava shows that price before Go.
   - Missing profile → never blindly auto-create duplicate Guest Profiles on Save; rank top existing matches and prefill clean hints (staff create in HMS or via an explicit later staged action).
   - Multi-room = sequential single-room creates (1–8 rooms) under one Go.
4. **Amend**: find the confirmation, then change what the guest asked for: dates/nights, room type, room type for charge, adults/children and ages, rate plan, booking agency/organization, reservation note, billing reference, guest/booker details, and CMS. HMS reprices, and Nava shows the new price and the common rate options before Go.
5. **Cancel**: find the confirmation and cancel with a reason. If HMS shows a penalty or charge, show it to staff; staff decide with a second Go.
6. **Filing**: file the selected voucher/POP PDF into the stay's Documents. Staff can search for and choose the stay when extraction misses it.

**CMS confirmation (Create and Amend)** is a staff control: a tick box (default on), a CMS message ID and a recipient email, all editable. HMS sends its confirmation only when staff leave it ticked. Nava never sends email itself; it saves unsent drafts.

**Deferred (later scope):** blind/automatic New Profile creation on Save, typed numeric rate overrides (comps), folio billing/refunds and an Auto-Transfer Playwright writer (surface memory hint badge only), native groups and XLSX imports, new OCR.

HMS supplies live booking, rate, and availability facts, and staff decide. Don't invent fake rate math or credit-eligibility rules; DO deterministically prefill Organization/Agency -> A/R Account, billing reference, guarantee, and Reservation Note payer routing from verified HMS memory and directories (never prefill a post-checkout `Refund Account` on new stays).

## Front door

- **Skip** OTA, channel, automated and spam mail. Travel-agent mail stays in scope.
- Generalise; don't overfit. Owner exact-host exclusions (Profitroom, Tiket.com, RateTiger, H-Pay `hospitality.cloud`) are in the [asks log](PRODUCT-ASKS-HISTORY.md#asks-logged), 2026-10-14. Travelit and TBO stay in scope.

**Pre-stay self-mail (owner rule):** mail the hotel's own mailbox sends to itself, titled "Pre Stay : Property … Confirmation No <conf> <name>", is about an **existing** booking. Never offer Create for it. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match. Keep any separate current ask in the same mail.

## Pane

One primary action per step. No dead controls. Use Infor HMS field labels across panes, contracts, and prompts (`Organization`, `Meal Plan`, `Room Type for Charge`, `Primary Booking Agency`). The layout may be redesigned (see `AGENTS.md`).

## Rules

- **Privacy:** guest data may be stored, logged, and used in tests and LLM chats (PIA/GDPR, NDAs and zero-retention providers cover this). Never send credentials or secrets to external services.
- **Real-guest writes:** the owner (2026-11-04) approves turning every HRCEN pane write flag (Create, Amend, Cancel, Filing) from `lab` to `on` as soon as that workflow works.
  - Each real write happens only on staff Go in the pane.
  - Agents never Save on a real guest themselves.
- **HMS reads and unsaved staging** on real guests and bookings are always allowed. This is how tools are proven on real email: run the real tool on a real email's details and stop before Save.
- **Labtest writes** (Proof Labtest guest, 2027+ stays) are always allowed; never ask. Keep CMS send off on Labtest.
- **Uncertain write:** never blind-retry; re-read HMS first. This prevents double bookings.
- **Deploy main:** from a clean worktree at fetched `origin/main`, run that checkout's `apps/server-pilot/deploy/ops-deploy.sh`. Verify the runtime SHA, effective flags on all PM2 processes, and health.

Engineering and verification rules live in `AGENTS.md`.
DB-backed Vitest suites may be skipped on the VPS; report skips honestly and run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` before tests. Never run local `tsc`/`tsgo`; use `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app <mail|server-pilot>`. Never use `--no-verify` or fabricate canary passes, read-role proofs, or real-email intent.

## Done

A workflow is done when deployed main runs it for real guests. That means:

- its flag is `on` in every PM2 process;
- the tool has correctly prepared a real email's stay (unsaved);
- one Labtest Save has a fresh readback;
- staff can Go from the pane.

Merged code or green checks alone is progress, not done.
