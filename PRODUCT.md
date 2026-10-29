# PRODUCT.md — Nava reservationist (Centurion)

Owner-edited. Agents read this before planning or coding. When assessing, planning, implementing or evaluating product behavior, also read the relevant sections of [product details](docs/context/PRODUCT-DETAIL.md). Do not invent requirements. Treat this spec as a product baseline, not proof of current implementation or adoption; check the owner’s current priority when it matters. Preserve original wording in a durable record when needed for continuity or when requested, not for every prompt. Make ordinary reversible interpretations within existing scope and authority without waiting; stop and ask when material product decisions, safety or authority are ambiguous. Follow the owner’s current scoped instructions without inferring broader authorization.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion. Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`). Same pane in webmail. Nava reads the selected email, pre-fills fields, and runs **deterministic** Infor HMS tools via Playwright. Infor HMS is the system of record. Human in the loop on every write.

The client environment was recorded as live on 2026-10-14. The owner confirmed on 2026-10-29 that staff are not using Nava because the product is not complete. Never call it a demo. Deploys and flag flips can affect the client environment; bundle loads alone do not prove staff adoption. There is no staff-hours deployment window or advance-warning requirement. Any pane feature ships on both surfaces (Outlook pane and the webmail panel at nava-admin).

## Who it is for

Centurion reservations staff. Never ask them to run scripts, PowerShell, or terminals. Never show raw technical errors. If something takes >30s, say so in plain language.

## Workflows (ROI order)

Finish one before starting the next. Reads may be automatic. Writes are Prepare → Queue → Act → Review, with a screenshot.

1. **Quote** — company/agency contract rates (majority of bookings). Cover email + PDF. BAR B&B; dinner is an add-on, hotel-specific. Staff never name the company in the reply body. When fully booked, the default reply is a one-line decline. Alternatives may appear in the pane; include one in the reply only if staff select “Use this”.
2. **Create reservation** — after quote, staff approve; Nava does the HMS create. Not typed by staff.
3. **Amend**
4. **Cancel** (lab only until owner says otherwise)
5. Payment proof / voucher, billing, group/event — after 1–4 actually work on real mail.

Quote-ready on open: prepare priced quotes in the background using reads only. A staff click to generate the PDF is acceptable; the reply remains unsent.

## Front door

Classify every inbound mail. **Skip** OTA / channel / automated / spam at the door. Travel-agent mail **stays in scope**. Examples in chats are examples — generalise the class, do not overfit the three live quote threads that happened to be open.

Specific classification and vendor-exclusion rules, including an unresolved policy conflict, are in [product details](docs/context/PRODUCT-DETAIL.md#front-door-specifics). Consult them before changing those paths.

**Owner hard rule — pre-stay self-mail:** mail the hotel's own mailbox sends to itself (e.g. centurion@ → centurion@) titled "Pre Stay : Property … Confirmation No <conf> <name>" carries pre-arrival details for an **existing** booking. Read it as existing stay / pre-arrival info, never as a new booking, and never offer create. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match.

## Pane (staff)

Keep the V1 look, one primary action per step, and no dead controls. Nava never sends. Before changing the pane, read [pane details](docs/context/PRODUCT-DETAIL.md#pane-staff).

## Hard rules

- Preserve guest privacy and credentials.
- No real-guest HMS writes unless the owner set `RESERVATIONIST_PANE_SAVE=on`. Bot never accepts cancellation-penalty dialogs. The later testing direction forbids automatic real-guest bookings and recorded `PANE_WRITE_CREATE=lab`; verify current authority and runtime before acting.
- An AI agent may drive live HMS (owner 2026-10-25), read-only on real guests; writes only on Labtest.
- Labtest (fake "Proof Labtest" guest, 2027+ stays) writes are always allowed on any hotel; never ask (owner 2026-10-25).
- Never Nova Lite. Choose other models for the task under current owner guidance; do not apply stale run-specific assignments.
- Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never test against pilot RDS. Never print secrets or `postgres://`.
- Deploy only from `.worktrees/recover-parse-failure` via `apps/server-pilot/deploy/ops-deploy.sh`. A pane fix is live only after staff’s bundle reloads.
- P0/P1 review findings fixed before merge. No `--no-verify`.

## Done (this is the overnight gate)

The golden-set scoreboard is an overnight and product-workflow evaluation gate, not a requirement for unrelated questions. A product slice is **done** only when its applicable bar passes on prod after the last fix. Distinguish proposed bars from owner-confirmed targets, and verify their scope. Merged, deployed or "tests green" is progress, not done. See [evaluation details](docs/context/PRODUCT-DETAIL.md#done-this-is-the-overnight-gate) for the golden set, proposed bars, and the quote-recall target confirmed for the 2026-10-20 plan.

## Working with this spec

Consult current context and previous evidence when relevant. Do not write a ledger entry, research file, or handoff for a routine question. Record decisions, evidence and open holds when needed for continuity or explicitly requested. Historical approvals never authorize a new run.

One product workflow is in progress at a time; other lanes may run evals, research or fixes that do not touch its files. Scope changes to a running plan remain trades approved by the owner. Overnight additions need an existing pass/fail check. Run contracts: `docs/context/RUN-CONTRACT.md`.

## Asks logged

[Historical product and owner-ask snapshot](PRODUCT-ASKS-HISTORY.md#asks-logged) preserves the original wording, scoped approvals, holds, and pre-cleanup line numbers through ask 399. The archive includes the earlier spec for historic line citations. Consult it when relevant; it is not an automatic startup import. Do not append every prompt here.
