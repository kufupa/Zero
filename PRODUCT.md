# PRODUCT.md — Nava reservationist (Centurion)

Current owner scope, updated 2026-11-03 after the [Option A retro](docs/research/2026-11-03-option-a-deep-retro/REPORT.md). Follow the owner's current request; historical plans and [asks](PRODUCT-ASKS-HISTORY.md#asks-logged) remain evidence, not new-run requirements. Make ordinary reversible choices without waiting. Explicit scoped authorization in the executing session remains valid; do not ask again for the same approved action. A historical approval alone does not authorize a new session.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion (HRCEN; Da Vinci HRDAV next). Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`); the same `NavaPane` renders in the webmail panel at nava-admin. Every pane feature ships on both surfaces. Nava reads the selected email, pre-fills, and runs **deterministic** HMS Cloud tools (Playwright, `apps/server-pilot/tooling/hms-cloud/`) built as reusable modular tools for other agents. Infor HMS Cloud is the system of record. Human in the loop on every write.

Current goal: make the core pilot usable on real emails. Verify actual deployment/capabilities rather than importing an old readiness claim. There is no staff-hours deployment window.

## Who it is for

Centurion reservations staff. Never ask them to run scripts, PowerShell or terminals. Never show raw technical errors. If something takes >30s, say so in plain language.

## Workflows (current pilot scope)

**First milestone M1:** Quote + Create with an existing HMS guest profile + supported PDF Filing + automatic selected-email prefill and staff overrides. Current [plan](docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md) and [M1 execution prompt](docs/context/PROMPT-2026-11-03-m1-ship.md). Owner's launch budget is about 100–125 minutes; operating target 120 minutes, not a guaranteed ETA. Run independent baseline lanes; keep Amend/New Profile/Cancel work out of M1's resources and release dependencies.

Reads may start automatically on email selection. Writes are Prepare → staff Go → protected native Save → fresh readback. Retain existing automatic evidence; do not add manual screenshot/admin-navigation proof requirements.

1. **Triage** — classify every inbound mail; per-stay actions and genuine second asks are kept, not dropped.
2. **Quote** — company/agency contract rates (majority of bookings). Cover email + PDF + Excel. BAR B&B; dinner is an add-on, hotel-specific. Staff never name the company in the reply body. Fully booked → one-line decline by default; an alternative goes in the reply only if staff select “Use this”. Quote-ready on open: price in the background with reads only.
3. **Create** — use a selected existing HMS profile after staff approve stay, agency/organization, guarantee and CMS recipient. If the profile is missing, staff creates it in HMS and resumes Nava. **Multi-room** = supported sequential 1–8 single-room creates under one staff Go; list confirmations and partial/unknown results; no native linking assumed.
4. **Filing** — file the selected supported voucher/POP PDF into the exact stay's Documents, with fresh readback. Reuse source/hash binding and the existing native uploader; no second PDF loader or byte-redownload proof project.
5. **Amend (M2)** — dates, occupancy, room type, rate-plan and native retain/reprice choice. Exploration/code/checks start after verified M1, never hold its deployment. Manual numeric amount entry remains deferred.
6. **Cancel** — optional follow-on; no M1 research, code, flag widening or release dependency.

Deferred: automatic New Profile creation, custom numeric rates, billing/refunds, native groups/large XLSX imports and new OCR/POP intake. Existing supported attachment parsing and PDF Filing remain in M1.

HMS supplies booking, rate and financial facts; staff make business decisions. Do not build a separate pricing/accounting eligibility engine to launch M1. Model routing follows current owner preferences and the actual task, not historical run-wide model bans.

## Front door

**Skip** OTA / channel / automated / spam at the door. Travel-agent mail **stays in scope**. Generalise examples rather than overfit them. Consult [product details](docs/context/PRODUCT-DETAIL.md#front-door-specifics) when relevant; historical vendor discussions are not an extra M1 launch gate.

**Owner hard rule — pre-stay self-mail:** mail the hotel's own mailbox sends to itself titled "Pre Stay : Property … Confirmation No <conf> <name>" carries pre-arrival details for an **existing** booking. Never treat it as a new booking or offer create. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match.

Keep a distinct, source-grounded current ask when present; existing-booking context must not discard that ask.

## Pane (staff)

Keep the V1 look, one primary action per step, no dead controls. Nava never sends; it saves unsent drafts. Prefer mounting existing components over new panels. [Pane details](docs/context/PRODUCT-DETAIL.md#pane-staff).

## Hard rules

- **Privacy:** PIA/GDPR approval covers storage on the Lightsail VPS and prod EC2; NDAs are signed and LLM providers are zero-data-retention. Guest data may be stored, logged, used in tests and in LLM chats. Never send credentials or secrets to external services.
- **HMS reads** of real guests, profiles, agencies and bookings: allowed. **Unsaved staging** on real bookings (open, edit, close without Save): allowed.
- **Fake writes:** "Proof Labtest" guest, 2027+ stays, any hotel — always allowed; never ask.
- **Real-guest writes** (create, amend, cancel, file, profile change) need owner authority in the executing session. Pane writes are also gated by runtime flags; verify the effective env of every PM2 process before claiming a workflow is on.
- **M1 authorization:** when the owner submits the M1 execution prompt, its scoped implementation/merge/deploy/flag/service authorization is the current session's authority. Verification commits remain fake; real guest commits require staff Go through the approved flow. A prompt file read without owner submission is not itself approval.
- **CMS confirmation:** on a real-guest create, HMS may email the guest confirmation (owner 2026-11-02). Tests always keep CMS send off. Nava never sends mail itself.
- Never accept a cancellation-penalty dialog. Never blind-retry an uncertain write; re-read HMS first.
- **Deploy main:** from an owned clean worktree whose HEAD matches fetched `origin/main`, run that checkout's `apps/server-pilot/deploy/ops-deploy.sh` (git-bundle sync). Script and cwd must belong to the same checkout. Use current-main scripts; the older root checkout may contain obsolete gates. Verify shipping/runtime SHA, effective capabilities and service health. Prefer one baseline bundle; no fixed deploy-tree requirement.

Engineering, resource, review and verification rules live in `AGENTS.md`; do not add a second launch checklist here.

## Done

**M1 is done** when current main is deployed, its effective processes admit Quote/Create/Filing/prefill, selected real-email output shows editable details and automatic reads, and installed fake Create and Filing operations have fresh native readback. Use the shipped shared pane path; disclose unexercised host interactions. Merged code or green checks alone is progress. Unimplemented/manual-only in-scope behavior remains a gap.

The M1 goal ends there. Full Amend is later M2, not a condition for core delivery. Real-mail evaluation is optional; when used, truth is staff outbound and unconfirmed pass bars are proposals. Small proof samples do not establish universal accuracy.

## Asks logged

[Historical product and owner-ask snapshot](PRODUCT-ASKS-HISTORY.md#asks-logged) — original wording and scoped approvals through ask 399. Consult when relevant; not a startup import.
