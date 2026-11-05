# Pane audit — 2026-11-04

**Answer:** Shared pane routes actionable guest mail into Quote/Booking tools; writes remain Labtest-only under supplied flags. Runtime run state proves quote queue is on: two deployed-SHA completions at 22:35 and 23:24; native Quote done, R5,800.

- Audited clean snapshot `/tmp/advrev-main`, SHA `1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746`.
- Source default for `HMS_JOB_QUEUE` is off; observed completions override missing env receipt for deployed state. Auto-quote still requires eligible quote analysis, bound selected source, ready inputs and no suppression.
- Supplied flags: create/attach `lab`, create dispatch on, attachment worker on, Amend/Cancel writes off. No tests, deployment, HMS or EC2 access.

## 1. Email type → pane route

| Email type | What renders | Staff can do / gates |
|---|---|---|
| Quote | Shared Quote workflow: details, HMS rates, PDF, reply review | Auto HMS quote read; choose rates, prepare quote PDF, edit unsent reply. |
| New booking | Quote/Booking card plus contact/profile fields | Select existing profile, preview, then Book; current `lab` allows Proof Labtest 2027+ only. |
| Amendment | Booking lookup, search, HMS facts; HRCEN local comparison | Read/review requested fields. Current flags block Amend writes; local HRCEN review saves nothing. |
| Cancellation | Booking lookup and cancel review | Lookup/review only; cancel preview/commit capability off. Never accept penalty dialog. |
| Payment / POP | No-action/payment notice can coexist with Voucher Find | Search booking; select eligible PDF; prepare/review/file only on exact supported match. Attach writes Labtest-only. |
| Own-mailbox pre-stay self-mail | Existing Stay Information card; confirmation number; separate ask retained | Review existing stay and separate ask. Never routes as new booking/Create. |
| OTA/channel/automated/spam | No-action card; quote workspace suppressed. Payment-class mail may keep read-only voucher lookup. | No quote/Create. Travel-agent mail stays actionable/in scope. |
| Group, billing, other, unknown | Non-quote task/review items or unsupported list in shared panel | Handle displayed staff tasks; no general group/billing automation implied. |

Source: `apps/mail/components/nava-pane/nava-pane.tsx:1468-1487,2364-2391`; `apps/mail/lib/quote-workflow/workflow-vocabulary.ts:4-41,57-144`; pre-stay rule `apps/server-pilot/src/ai/existing-stay-information.ts:5-35`.

## 2. Visible controls and dead/lab gates

| Control | Current behavior | Staff-visible limitation |
|---|---|---|
| Create Preview → Book | `PANE_WRITE_CREATE=lab`, cloud dispatch on | Labtest stays only; explicit copy says book real guest in HMS. |
| HMS confirmation | Checkbox visible in cloud preview, disabled | Confirmation sending off for these test bookings. |
| Amend / Cancel | Find/search remain; write capability is fetched and gates preview/commit | Supplied Amend/Cancel modes off; no pane write. HRCEN amend remains unsaved local review. |
| PDF Filing | Existing Voucher Find/prepare/review path; worker requires worker `on` and attach mode `lab|on` | Supplied lab mode means test-only filing, not real-stay filing. |

Sources: `apps/mail/components/quote-workflow/booking-card.tsx:1741-1757,1836-1840`; `apps/server-pilot/src/ai/pane-stay-save.ts:123-132,253-292`; `apps/server-pilot/src/ai/run-ledger.ts:48-54`.

## 3. Quote and reply wiring

| Step | What happens |
|---|---|
| Auto quote | Queue enabled in deployed run state. Source auto-start also requires quote intent, current bound message/source, ready quote step, inputs and no suppression (`use-staff-quote-autostart.ts:70-129`). Observed 22:35 + 23:24 completions; native Quote R5,800. |
| Quote result | Staff sees rates/totals and alternatives; “Make quote” prepares PDF. Queue UI gives state, elapsed time and ETA/position when available. |
| Reply | Staff edits/reviews reply. Outlook inserts unsent draft; webmail saves unsent draft. PDF attaches for quote; nothing is sent by Nava. Request/decline replies can be text-only. |

Source: `apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1076-1114,1534-1554`; `apps/mail/components/nava-pane/reply-body.tsx:75-138,190-225`.

## 4. Create details and Go under `lab`

| Staff inputs / price | Action and gate |
|---|---|
| Stay dates, guest/party/occupancy and child ages; existing guest profile; agency/company, guarantee, CMS recipient; room/rate plan; source, track, market segment, terms and reservation note. | Preview each room in HMS; Book after preview is ready. Supported multi-room path is sequential 1–8 single-room creates under one staff Go; partial/unknown outcomes shown. |
| Price comes from selected HMS rate/plan and preview; no manual numeric-rate entry. | `PANE_WRITE_CREATE=lab` + create dispatch on admits Labtest only. Real guest is refused; missing profile means staff creates it in HMS, then resumes. |

Sources: `apps/mail/components/quote-workflow/booking-card.tsx:1736-1757,1931-2169,2223-2291`; `apps/server-pilot/src/ai/pane-cloud-preview.ts:57-65,115-124`.

## 5. Amend / Cancel

| Workflow | Staff sees / can do now |
|---|---|
| Amend | Find/search HMS booking; HRCEN local editor compares requested dates/occupancy and rate-plan/retain-rate choice. Copy says no availability or new-price check; nothing saved. Amend commit remains off. |
| Cancel | Find booking and review cancel request; current capability off, so no authorized commit. No penalty dialog accepted. |

Source: `apps/mail/components/quote-workflow/amend-lookup-panel.tsx:138-186,668-735,1023-1087`; `apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx:86-105`.

## 6. Top 15 raw/technical strings found fast

Not exhaustive count. Some are diagnostics/internal wording; dynamic fields can carry backend text.

| # | Staff-visible text / raw field | File:line |
|---:|---|---|
| 1 | `System check failed: ${err.message}` | `apps/mail/components/nava-pane/use-system-check.ts:93` |
| 2 | `Could not create the draft: ${err.message}` | `apps/mail/components/nava-pane/use-insert-ai-draft.ts:554` |
| 3 | `Not analysable: this guest email has no Message-ID, so Nava cannot bind it.` | `apps/mail/components/nava-pane/web-pane-panel.tsx:13-15` |
| 4 | `ERROR` | `apps/mail/components/nava-pane/screens/diagnostics.tsx:63-65` |
| 5 | `Pinging server from ${detectedEmail}…` | `apps/mail/components/nava-pane/screens/diagnostics.tsx:70` |
| 6 | `API server pinged at ${serverPingTimeStr} · Active` | `apps/mail/components/nava-pane/screens/diagnostics.tsx:68-70` |
| 7 | `Waiting to initiate handshake…` | `apps/mail/components/nava-pane/screens/diagnostics.tsx:72` |
| 8 | `HMS lookup failed: ${safeReason}` | `apps/mail/components/quote-workflow/hms-job-notices.tsx:195-200` |
| 9 | `HMS access needs attention. Check the HMS session and retry.` | `apps/mail/components/quote-workflow/hms-job-notices.tsx:106-107` |
| 10 | `Nava could not queue the lookup. Try again.` | `apps/mail/components/quote-workflow/hms-job-notices.tsx:104-105` |
| 11 | `session.errorMessage` rendered verbatim | `apps/mail/components/quote-workflow/pane-status-line.tsx:19-24` |
| 12 | `findRun.message` rendered verbatim | `apps/mail/components/quote-workflow/amend-lookup-panel.tsx:303-305` |
| 13 | `run.message` rendered verbatim | `apps/mail/components/quote-workflow/voucher-find-card.tsx:613-614` |
| 14 | `item.reason` rendered verbatim | `apps/mail/components/quote-workflow/quote-workflow-panel.tsx:743-752`; `items-for-you.tsx:49-52` |
| 15 | `reading.message` rendered verbatim | `apps/mail/components/quote-workflow/rate-controls.tsx:919` |

## 7. Long operations and progress copy

| Operation | Progress shown | Gap |
|---|---|---|
| Queued HMS quote/read/search | Queued/running state, elapsed time, queue position/ETA when available; “Still working — you can keep going” after 30s. | Good plain-language progress. |
| PDF preparation | Button says “Preparing PDF…” | No elapsed timer or >30s reassurance. |
| Create preview/Book | Preview/Book action and pending state | No shared elapsed timer or keep-working message found. |
| Translation | “Translating…” | No elapsed timer or long-wait reassurance. |

Source: `apps/mail/components/quote-workflow/hms-queue-status.tsx:29-94,209-228`; `document-review.tsx:143-151`; `blocks/translation-box.tsx:95-103`.

## TOP 10 STAFF-VISIBLE GAPS ranked by pilot impact

| Rank | Gap / impact | Fix estimate + file |
|---:|---|---|
| 1 | Real-guest Create blocked: deployed create mode is Labtest-only. | Config-only to change mode; policy/canary still required. `apps/server-pilot/src/ai/pane-stay-save.ts`; UI `apps/mail/components/quote-workflow/booking-card.tsx`. |
| 2 | Real-stay Filing blocked: attachment mode/worker only admits Labtest. | ~30–60 LOC plus guarded rollout. `apps/server-pilot/src/ai/run-ledger.ts`; `apps/mail/components/quote-workflow/voucher-find-card.tsx`. |
| 3 | Amend remains review-only; no availability/new price check or save in HRCEN path. | M2; ~40–80 LOC to complete gated workflow. `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`. |
| 4 | Cancel write unavailable under current flags. | Config + ~20–40 LOC for staff-safe enabled state. `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`; `apps/server-pilot/src/ai/pane-stay-save.ts`. |
| 5 | Missing guest profile stops pane Create; staff must create in HMS and resume. | New Profile is deferred; ~50–90 LOC for a bounded handoff/resume improvement. `apps/mail/components/quote-workflow/booking-card.tsx`. |
| 6 | PDF preparation gives no elapsed/30s progress if it runs long. | ~10–20 LOC. `apps/mail/components/quote-workflow/document-review.tsx`. |
| 7 | Create Preview/Book gives no elapsed/30s reassurance during long HMS operations. | ~15–25 LOC. `apps/mail/components/quote-workflow/booking-card.tsx`. |
| 8 | Translation gives “Translating…” only; no long-wait update. | ~10–20 LOC. `apps/mail/components/nava-pane/blocks/translation-box.tsx`. |
| 9 | Several failure paths render dynamic `reason`/`message` verbatim; opaque backend text can reach staff. | ~25–45 LOC for shared safe mapping. `pane-status-line.tsx`, `amend-find.ts`, `rate-controls.tsx`, `voucher-find-card.tsx`. |
| 10 | Unsupported group/billing/other asks may end in task list or manual handling, not a complete workflow. | Deferred scope; ~20–40 LOC for clearer next-step handoff. `apps/mail/components/quote-workflow/quote-workflow-panel.tsx`. |

