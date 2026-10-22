> 🧠 **From Hindsight memory (U8 unpaid amend in place)** — the earlier rule was provisional status + zero deposit + non-paying guarantee. #458 changes blank-deposit handling; this checkout predates it, so S2 should use #458’s landed classifier contract.

Startup read, required order: [PRODUCT.md](PRODUCT.md), [ACTIVE.md](docs/context/ACTIVE.md), [OWNER-ASKS.md](docs/context/OWNER-ASKS.md), [research README](docs/research/README.md), [AGENT.md](AGENT.md), [FACTS.md](docs/context/FACTS.md), [CATALOG.md](docs/research/CATALOG.md). `origin/main=db4abaca4`; prod `b11e5ac52` per your note.

CodeGraph index lagged this worktree; findings use its files. Read-only only: no edits, tests, tsc, HMS or prod access.

### 1. Current state

| Finding | Evidence |
|---|---|
| Eligibility | Lookup carries status, guarantee and deposit; current `classifyAmendPayment` allows only Reserved/Provisional + zero deposit + non-paying guarantee; missing values are unknown. [pane-stay-lookup.ts:221](apps/server-pilot/src/ai/pane-stay-lookup.ts:221) |
| Pane | Cancel preview/commit controls exist when `paneSave` is on. They are capability-gated, not eligibility-gated; `unpaidStay`/`CHECK` gate amend only. [amend-lookup-panel.tsx:267](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:267) [amend-lookup-panel.tsx:526](apps/mail/components/quote-workflow/amend-lookup-panel.tsx:526) |
| Server/CLI | Server digest covers confirmation+arrival only. `expectStay` is supported but not passed by the pane; CLI expectation is optional. Cancel snapshot omits `depositReceived`; its existing comparison runs before opening the cancel dialog. [pane-stay-cancel.ts:153](apps/server-pilot/src/ai/pane-stay-cancel.ts:153) [pane-stay-cancel.ts:262](apps/server-pilot/src/ai/pane-stay-cancel.ts:262) [cancel-stay-rules.mjs:179](apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.mjs:179) [cancel-stay.mjs:684](apps/server-pilot/tooling/playwright-quote/cancel-stay.mjs:684) |
| Penalty / note | CLI refuses a visible penalty before OK and checks again before its single OK click. Real note uses the staff-selected HMS reason; CLI defaults to `Test Reservations`, so real CLI commit must require an explicit reason. [cancel-stay-rules.mjs:239](apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.mjs:239) [cancel-stay-rules.mjs:262](apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.mjs:262) |
| TMC | Owner policy and classifier prompt say automated TMC cancellation = no action, person request = cancel. But Travelit stays direct; current folder fallback sends `origin=system_notice, action=cancel` to cancellations. Prompt test is not a routing backstop. [PRODUCT.md:96](PRODUCT.md:96) [extract.ts:71](apps/server-pilot/src/ai/extraction/extract.ts:71) [mail-source.test.ts:225](apps/server-pilot/tests/mail-source.test.ts:225) [workflow-folders.ts:279](apps/server-pilot/src/mail/workflow-folders.ts:279) |
| Rate / proof | Exact current human rate unknown. R3 estimates 57 actionable cancels/75d ≈5.3/week (manual n=16/400; low confidence, ~0.1–10.4/week). L2 has 48 external candidate events in ~76d ≈4.4/week; unadjudicated, may include TMC. Current readiness report: Labtest previews 4 ok/2 failed; 2 commits unconfirmed. [R3:38](docs/research/2026-10-13/r3-workflow-truth.md:38) [L2:49](docs/research/2026-10-20-arch-lanes/l2-amend-payment.md:49) [readiness:20](docs/research/2026-10-22-client-readiness.md:20) |

### 2. Gaps / proposed PR split

| # / behavior | Files; estimated LOC; tests | Dependency, collisions, P1 risk |
|---|---|---|
| 1. Commit safety: server-owned preview snapshot; server requires unpaid classification; CLI rereads status/guarantee/deposit, compares snapshot immediately before OK, refuses drift/unknown/penalty; require explicit real reason. | [`pane-stay-cancel.ts`](apps/server-pilot/src/ai/pane-stay-cancel.ts), [`cancel-stay.mjs`](apps/server-pilot/tooling/playwright-quote/cancel-stay.mjs), [`cancel-stay-rules.mjs`](apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.mjs); product ~+110/−15, tests +150–220 LOC in `pane-stay-cancel.test.ts`, `cancel-stay-rules.test.mjs`. | After #458; reuse its classifier. Cancel-only code; shared payment semantics with amend. P1: missing/misread deposit or stale status can false-allow; keep unknown fail-closed. |
| 2. Pane eligibility: only eligible, found, `CHECK`-clear stays get preview/commit; distinct paid, guaranteed, confirmed/unknown refusal copy. | [`amend-lookup-panel.tsx`](apps/mail/components/quote-workflow/amend-lookup-panel.tsx), [`amend-cancel.ts`](apps/mail/lib/quote-workflow/amend-cancel.ts); product ~+35–55/−5, tests +60–95 LOC in `amend-find-panel.test.tsx`, `amend-cancel-copy.test.ts`. | After #458 and ideally PR 1. Shared amend/cancel panel; touches CHECK gate. Overlay host untouched; no create, DV quote, or multi-stay code. P1: UI is advisory; server/CLI remain authoritative. |
| 3. TMC route fallback: `system_notice + cancel` → not-for-Nava; person-authored TMC cancel stays actionable. | [`workflow-folders.ts`](apps/server-pilot/src/mail/workflow-folders.ts); product ~+2–5/−0, tests +8–15 LOC in `workflow-folders.test.ts`. | Independent. Shared HRCEN/HRDAV mail routing; new-booking→payments stays unchanged. P1: depends on correct `origin`; test automated vs person cases. |

PR 1/2 follow #458; #451 is outbound replay, not inbound cancellation proof. PR 3 is independent. Exact #460 file overlap unknown.

### 3. Test plan

- `cancel-stay-rules.test.mjs`: eligible status/payment matrix, #458 blank-deposit case, paid/guaranteed/confirmed/unknown refusal, deposit/status drift, real commit needs explicit reason, penalty stays open with zero OK clicks.
- `pane-stay-cancel.test.ts`: server rejects ineligible snapshot; owner-scoped one-use preview binds snapshot; commit passes `expectStay`; stale state refuses before click; mode/lock behavior remains.
- `amend-find-panel.test.tsx` + `amend-cancel-copy.test.ts`: preview/commit only when eligible and CHECK clear; paid/guaranteed/confirmed copy; reselecting a stay cannot reuse preview.
- `workflow-folders.test.ts`: automated system cancellation routes away; person-authored TMC request routes to cancellations.
- Replay: no fresh current cancellation gold count is in repo. Read-only replay current inbound corpus with production-equivalent `readQuoteAttachments` → `selectionToAgentPrompt`; count unique `messageId`, and volume by unique `(threadId, action)`, split person/TMC/system. Exact `n` unknown until export; historical R3 is 400 rows/16 cancels, L2 is 76 candidate events/85 messages.
- HMS reads: read-only lookup; count unique `(confirmation, arrival)` and report status/guarantee/deposit coverage. Writes: Labtest only, count unique test stays (not attempts), one browser lock; real-guest writes only after owner enables. No such check run here.

### 4. Scope questions

1. Is `Reserved` provisional? Default: follow #458 classifier (`Reserved`/`Provisional`).
2. Must CHECK block both preview and commit? Default: yes.
3. Real note text? Default: explicit staff-selected HMS reason only; never mail/model text.
4. Route every automated `system_notice + cancel` away, or only TMC? Default: all system notices; person-authored TMC requests stay actionable.