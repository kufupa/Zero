> 🧠 **From Hindsight memory (U8 unpaid amend in place)** — U8’s field set is arrival/departure, room type, adults and children; payment fields gate writes, and live amend proof is still open.

TL;DR — Amend code exists; CHECK leaks into cancel, voucher lacks the same explicit pick flow, and R5 field/email evidence plus one Labtest amend remain.

Scope: worktree HEAD stays `db4abaca4`; local `origin/main` now reads `2dc887b7e` (+3, including #451/#458/#460). I stayed on the requested worktree; #458 is assumed for R7, and those PRs are not replanned. Startup docs read: `PRODUCT.md`, `ACTIVE.md`, `WORKSTREAMS.md`, `OWNER-ASKS.md`, research `README.md`, `FACTS.md`, `CATALOG.md`, `AGENT.md`. Worktree clean. No tests, typecheck, prod or HMS touched.

### 1. Current state

| Area | What exists now |
|---|---|
| CHECK | Missing/not-found/ambiguous/suspect sets `checkReason`; amend is hidden during CHECK. Amend/cancel share the embedded guest-search panel; candidate click exact-finds the selected confirmation. [amend-lookup-panel.tsx:211](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:211) [amend-lookup-panel.tsx:541](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:541) |
| Cancel gap | Cancel section and its preview/commit guards omit `checkReason`; current CHECK test covers amend, not cancel. P1: cancel can appear/action under CHECK. [amend-lookup-panel.tsx:274](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:274) [amend-lookup-panel.tsx:526](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:526) [amend-find-panel.test.tsx:1983](apps/mail/tests/amend-find-panel.test.tsx:1983) |
| Voucher | Separate card. A sole exact-surname row becomes `singleMatch`; candidate rows otherwise offer copy/open, not the same click-then-exact-find action. [voucher-find-card.tsx:107](apps/mail/components/quote-workflow/voucher-find-card.tsx:107) [voucher-find-card.tsx:379](apps/mail/components/quote-workflow/voucher-find-card.tsx:379) |
| R7 amend | Writer is Labtest-only, re-reads under the property lock, and fails closed on payment evidence. Five fields: arrival, departure, room type, adults, children. Existing-stay controls still carry a live-probe TODO; no amend commit yet. [pane-hms-write.ts:88](apps/server-pilot/src/ai/pane-hms-write.ts:88) [pane-hms-write.ts:120](apps/server-pilot/src/ai/pane-hms-write.ts:120) [amend-stay.mjs:22](apps/server-pilot/tooling/playwright-quote/amend-stay.mjs:22) |
| R5 create/record | First pane Create Save passed for `25526053-1`; R5 field values and `send_on_save` remain pending. [ACTIVE.md:8](docs/context/ACTIVE.md:8) [build plan R5:51](docs/plans/2026-10-20-006-stay-request-build-plan-v2.md:51) |

### 2. Gaps to fully built

1. R6: gate cancel render, preview and commit on `!checkReason`. Share a small candidate-list/pick leaf across amend, cancel and voucher; keep each workflow wrapper separate. Require staff click, then exact confirmation re-read before any action. This reuses the existing amend/cancel flow without building a new state machine.
2. R7: after #458, allow blank deposit only for provisional + non-paying; paid/unknown stay banner/Infor. Supported amend fields remain the five above. Nights come from dates; name, rate and rate plan are not amendable here.
3. R5: record actual guarantee, deposit, A/R, agency and company values; verify native HMS email-on-save. Raw reader allowlists A/R, agency, company, caller and note, but pane result has no distinct A/R/caller/note; raw reader lacks `udfchar06` booker contact. Pane create input omits A/R, billing reference and profile ID; child ages are refused. A/R may be folded into company by the reader. [read-reservation-fields.mjs:10](apps/server-pilot/tooling/playwright-quote/read-reservation-fields.mjs:10) [pane-stay-lookup.ts:25](apps/server-pilot/src/ai/pane-stay-lookup.ts:25) [commercial-fields.mjs:162](apps/server-pilot/tooling/playwright-quote/commercial-fields.mjs:162) [quote-workflow.ts:61](apps/server-pilot/src/trpc/routes/quote-workflow.ts:61) [pane-stay-save.ts:167](apps/server-pilot/src/ai/pane-stay-save.ts:167)
4. Real-guest amend switch stays later and owner-authorized. Do not widen today. Nava never sends mail; observe only HMS’s Save side effect.

### 3. Proposed split and estimates

| Change | Proposed files | Product / test LOC | Tests; P1-likely risk |
|---|---|---:|---|
| PR1 — cancel blocked during CHECK | `amend-lookup-panel.tsx`; `amend-find-panel.test.tsx` | +3–6 / +25–35 | Add cancel CHECK/no-preview/no-commit case. P1: cancellation against suspect or ambiguous stay. |
| PR2 — shared explicit pick → exact read | `amend-lookup-panel.tsx`, `voucher-find-card.tsx`, new `hms-candidate-picker.tsx` | +45–80 net / +40–70 | Change `amend-find-panel.test.tsx`, `voucher-find-card.test.tsx`. P1: selected row and exact re-read must stay bound to same confirmation. |
| R7 proof — no new product PR expected after #458 | None expected | 0 / 0 expected | Existing `pane-stay-amend.test.ts`, `pane-hms-write.test.ts`; #458 owns blank-deposit tests. P1: paid/unknown must never pass. |
| R5 field record — evidence only | Proposed `docs/research/2026-10-22-sr3-r5-field-record.md` | 0 product / 0 test; +20–30 doc | No tests. P1: A/R/company confusion or unverified party binding. |
| Conditional A/R create support | `quote-workflow.ts`, `pane-stay-save.ts`, `booking-card.tsx`, create/read parser tests | Unknown / unknown until record + requirement | Separate one-behavior PR only if needed. P1: wrong bill-to. |
| Later real-guest amend switch | `pane-hms-write.ts`, `pane-stay-amend.ts`, `amend-stay-rules.mjs` and tests | Unknown / unknown | Separate owner-authorized design/PR. P1: real-guest write/payment gate. |

PR1 before PR2: both touch the amend panel. R5 record precedes any A/R expansion. Code PRs stay below 500 product LOC and one behavior each; do not open the unknown-scope follow-ons before scoping them.

### 4. File collisions

| Files | Colliding areas |
|---|---|
| `amend-lookup-panel.tsx` | AMEND, CANCEL, CHECK, multi-stay actions; serialize PR1/2. No DV quote route change proposed. |
| `voucher-find-card.tsx` / shared picker | Voucher flow and its quote/overlay surface. |
| `pane-stay-lookup.ts`, `pane-hms-write.ts` | #458 payment gate, AMEND, CANCEL and voucher/read callers. |
| `booking-card.tsx`, `quote-workflow.ts` | CREATE plus shared quote/overlay surface; coordinate with DV quote work. |

### 5. Test and evidence plan

- `apps/mail/tests/amend-find-panel.test.tsx`: cancel CHECK hides Preview; preview/commit calls stay inert; candidate click exact-finds before action.
- `apps/mail/tests/voucher-find-card.test.tsx`: singleton still needs explicit pick; exact selected confirmation is re-read; mismatch/failure never becomes matched.
- `apps/server-pilot/tests/pane-stay-amend.test.ts`, `pane-hms-write.test.ts`: post-#458 blank deposit only passes provisional + non-paying; paid, guaranteed, unknown refuse; fresh re-read; five-field allowlist.
- R5 if code changes: `pane-stay-save.test.ts`, `create-lab-stay.test.mjs`, `commercial-fields.test.mjs`: distinct A/R/company, optional party readback, child refusal.
- Replay: use current HRCEN mail + staff-sent HRCEN letters as truth; run production-path U11b (`readQuoteAttachments` → `selectionToAgentPrompt`). Include golden amend rows and every current corpus amend missing a conf# or ambiguous. `n` = distinct inbound message × intended stay cases, not HMS attempts; report n and pass counts. #451 fixture mode alone is not this proof; no accuracy rate if holdout n < 100.
- Read-only live: current HRCEN booking reads only; count unique exact confirmations and report found/not-found/ambiguous. R5 field snapshot: `25526053-1`, n=1, via read-only reservation-field reader. No reads were run here.
- One future write proof, Labtest only: read `25526053-1`; verify Labtest identity, eligible status and post-#458 unpaid state; snapshot fields. Preview departure +1 night only; staff review screenshots. Commit once with same digest and `SAVE=lab`; verify `amended`, exact confirmation, changed-field readback and unchanged other fields. One browser lock; no retry if outcome unknown; abort on any penalty/charge/rate dialog. No write was run here.
- `send_on_save`: inspect Centurion mailbox/outgoing log for the original Save event, exact conf# and timestamp; n=1 Save event. If source/retention incomplete, result stays unknown. Nava sends nothing.

### 6. Open questions

1. Voucher singleton: require staff click too? Default: yes, per R6.
2. Does base real-guest create need distinct A/R? Default: no universal blocker; block/manual-handle cases that require A/R until mapped.
3. Did HMS email on the existing Save? Default: unknown until n=1 mailbox evidence; never infer or send through Nava.
4. Expand amend to name/rate or real guests? Default: no; keep five Labtest fields and handle other changes in Infor.