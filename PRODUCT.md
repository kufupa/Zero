# PRODUCT.md — Nava reservationist (Centurion)

Owner-edited. Agents read this before planning or coding. Rewritten 2026-11-02 after the HMS Cloud rewrite; older rules live in [the asks history](PRODUCT-ASKS-HISTORY.md#asks-logged) and `docs/context/archive/`, and are history, not constraints. Do not invent requirements. Make ordinary reversible calls within scope without waiting; ask only when a material product, safety or authority question is genuinely open. Historical approvals never authorize a new run.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion (HRCEN; Da Vinci HRDAV next). Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`); the same `NavaPane` renders in the webmail panel at nava-admin. Every pane feature ships on both surfaces. Nava reads the selected email, pre-fills, and runs **deterministic** HMS Cloud tools (Playwright, `apps/server-pilot/tooling/hms-cloud/`) built as reusable modular tools for other agents. Infor HMS Cloud is the system of record. Human in the loop on every write.

Staff are not yet using Nava because it is incomplete (owner 2026-10-29). There is no staff-hours deployment window. Never call it a demo.

## Who it is for

Centurion reservations staff. Never ask them to run scripts, PowerShell or terminals. Never show raw technical errors. If something takes >30s, say so in plain language.

## Workflows (current pilot scope)

Workflows proceed in parallel when scoped, evidence-backed and safe. Current plan: [`docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md`](docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md).

Reads may be automatic. Writes are Prepare → staff Go → native guard → Save → screenshot → fresh readback.

1. **Triage** — classify every inbound mail; per-stay actions and genuine second asks are kept, not dropped.
2. **Quote** — company/agency contract rates (majority of bookings). Cover email + PDF + Excel. BAR B&B; dinner is an add-on, hotel-specific. Staff never name the company in the reply body. Fully booked → one-line decline by default; an alternative goes in the reply only if staff select “Use this”. Quote-ready on open: price in the background with reads only.
3. **Create** — single stay after staff approve: existing guest lookup, agency/organization, guarantee, CMS recipient. **Multi-room** = several single-room creates under one staff Go; partial success stays partial; no native linking assumed.
4. **Filing** — voucher / proof-of-payment attachment filed into the HMS stay's Documents, with readback.
5. **Amend** — dates, occupancy, rate-plan, retain-rate choice. Manual amount entry is dropped (owner 2026-11-02).
6. **Cancel** — lab only until the owner says otherwise.

Backlog: custom rate typed at create, billing, groups/XLSX, OCR/POP intake.

## Front door

**Skip** OTA / channel / automated / spam at the door. Travel-agent mail **stays in scope**. Chat examples are examples — generalise the class, do not overfit. Details and an unresolved vendor-exclusion conflict: [product details](docs/context/PRODUCT-DETAIL.md#front-door-specifics).

**Owner hard rule — pre-stay self-mail:** mail the hotel's own mailbox sends to itself titled "Pre Stay : Property … Confirmation No <conf> <name>" carries pre-arrival details for an **existing** booking. Never treat it as a new booking or offer create. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match.

## Pane (staff)

Keep the V1 look, one primary action per step, no dead controls. Nava never sends; it saves unsent drafts. Prefer mounting existing components over new panels. [Pane details](docs/context/PRODUCT-DETAIL.md#pane-staff).

## Hard rules

- **Privacy:** PIA/GDPR approval covers storage on the Lightsail VPS and prod EC2; NDAs are signed and LLM providers are zero-data-retention. Guest data may be stored, logged, used in tests and in LLM chats. Never send credentials or secrets to external services.
- **HMS reads** of real guests, profiles, agencies and bookings: allowed. **Unsaved staging** on real bookings (open, edit, close without Save): allowed.
- **Fake writes:** "Proof Labtest" guest, 2027+ stays, any hotel — always allowed; never ask.
- **Real-guest writes** (create, amend, cancel, file, profile change) need owner authority in the executing session. Pane writes are also gated by runtime flags; verify the effective env of every PM2 process before claiming a workflow is on.
- **CMS confirmation:** on a real-guest create, HMS may email the guest confirmation (owner 2026-11-02). Tests always keep CMS send off. Nava never sends mail itself.
- Never accept a cancellation-penalty dialog. Never blind-retry an uncertain write; re-read HMS first.
- Never Nova Lite.
- Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never test against pilot RDS. DB-backed suites may be skipped; report them as skipped, never passed. Typecheck only via `remote-typecheck.sh`.
- **Deploy main:** fast-forward the deploy tree (`.worktrees/recover-parse-failure`; `ops-deploy.sh` refuses other checkouts) to `main`, then `apps/server-pilot/deploy/ops-deploy.sh` (git-bundle sync). A pane fix is live only after the bundle reloads.
- P0/P1 review findings fixed before merge. No `--no-verify`.

## Done

A pilot workflow is **done** when main is deployed, the workflow is walked end to end on the deployed pane, and one final fake booking succeeds on the deployed code (owner 2026-11-02). Merged or "tests green" is progress. Real-mail evaluation is optional; when run, truth = staff outbound, and any pass bar is labelled a proposal unless the owner confirmed it. The old golden-set gate is archived in `docs/context/archive/`.

## Working with this spec

Record decisions, evidence and holds only when needed for continuity or asked. Don't write ledgers or handoffs for routine questions. Scope changes to a running plan are owner trades. Run contracts: `docs/context/RUN-CONTRACT.md`.

## Asks logged

[Historical product and owner-ask snapshot](PRODUCT-ASKS-HISTORY.md#asks-logged) — original wording and scoped approvals through ask 399. Consult when relevant; not a startup import.
