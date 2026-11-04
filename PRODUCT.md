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
2. **Quote**: company/agency contract rates, which cover most bookings.
   - Output is a cover email + PDF + Excel. BAR B&B; dinner is a hotel-specific add-on.
   - Never name the company in the reply body.
   - Fully booked → one-line decline. Offer an alternative only if staff pick "Use this".
   - Price in the background when the email opens (reads only).
3. **Create**: uses an existing HMS guest profile.
   - Staff confirm stay, room, rate plan, agency/organization, guarantee, note and CMS.
   - HMS prices the stay (Check Availability), and Nava shows that price before Go.
   - Missing profile → staff create it in HMS, then resume.
   - Multi-room = sequential single-room creates (1–8 rooms) under one Go.
4. **Amend**: find the confirmation, then change what the guest asked for: dates/nights, room type, adults/children and ages, rate plan, guest details, CMS. HMS reprices, and Nava shows the new price and the common rate options before Go.
5. **Cancel**: find the confirmation and cancel with a reason. If HMS shows a penalty or charge, show it to staff; staff decide with a second Go.
6. **Filing**: file the selected voucher/POP PDF into the stay's Documents. Staff can search for and choose the stay when extraction misses it.

**CMS confirmation (Create and Amend)** is a staff control: a tick box (default on), a CMS message ID and a recipient email, all editable. HMS sends its confirmation only when staff leave it ticked. Nava never sends email itself; it saves unsent drafts.

**Deferred:** automatic New Profile, typed numeric rate overrides, billing/refunds, native groups and XLSX imports, new OCR.

HMS supplies booking, rate and financial facts, and staff decide. Don't build pricing or accounting eligibility engines.

## Front door

- **Skip** OTA, channel, automated and spam mail. Travel-agent mail stays in scope.
- Generalise; don't overfit. [Details](docs/context/PRODUCT-DETAIL.md#front-door-specifics).

**Pre-stay self-mail (owner rule):** mail the hotel's own mailbox sends to itself, titled "Pre Stay : Property … Confirmation No <conf> <name>", is about an **existing** booking. Never offer Create for it. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match. Keep any separate current ask in the same mail.

## Pane

Keep the V1 look: one primary action per step and no dead controls. Prefer mounting existing components. [Details](docs/context/PRODUCT-DETAIL.md#pane-staff).

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

## Done

A workflow is done when deployed main runs it for real guests. That means:

- its flag is `on` in every PM2 process;
- the tool has correctly prepared a real email's stay (unsaved);
- one Labtest Save has a fresh readback;
- staff can Go from the pane.

Merged code or green checks alone is progress, not done.
