# Luna MVP stretch specs (U0b)

Written T0+ after U0. Orchestrator. No PII.
Plan: `docs/plans/2026-10-06-002-reservationist-mvp-retro-and-sprint-plan.md`.
Hard stop stretch: **14:00 UTC wall clock**. Start only after D1–D10 verified or blocked-with-evidence.
Census may reorder S1–S3; log reorder in ledger.
Deploy: Runbook B + Runbook C; health fail → Runbook D and stop further deploys.
Safety: no send, no HMS save/cancel, no Vitest vs pilot RDS, `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` before tests.

## Review (inline, both lenses)

- **Completeness:** S1–S3 have files, verified line refs (2026-10-06 23:37 UTC tree `70d85df0`+partials), contracts, tests, commit messages. S4–S5 goal-level as planned.
- **Simplicity:** reuse stored revisions / existing quote loop; no agent tool loop; no new infra; S4 flag stays off.

---

### S1. Booking accepts our earlier quote (A3)

**Goal:** booking email in a thread that already holds a staff quote revision → prefill groups/party from that revision and feed `prepareBookingDraft` **without** a new HMS quote, if still fresh; else ask for a re-quote.
**P50:** 45m–1h. **No HMS writes.**

**Verified files (read 23:37):**
- Stored revisions: [`apps/server-pilot/src/trpc/routes/workstation.ts`](apps/server-pilot/src/trpc/routes/workstation.ts) `:415-435` writes `metrics.reservationistResult.quoteRevisions: [revision]` on `executeStaffQuote`.
- Reload: same file `resolveLedgerProposal` ~`:145-172` finds `quoteRevisions` by `revisionRef`, freshness via `assertReservationistResultFreshForAction`.
- U7 (must already be merged): `prepareBookingDraft` takes `workflowRunId` + `revisionRef`. S1 adds a **finder**, not a second quote.

**Contract:**
```ts
// directional
listThreadQuoteRevisions({ threadId, transportId }) →
  { revisions: Array<{ workflowRunId, revisionRef, createdAt, expiresAt, roomCodes, rateCodes, partyName }> }
usePriorQuoteForBooking({ workflowRunId, revisionRef, analysis }) →
  { status: 'ready', draft } | { status: 'unavailable', reason: 'expired' | 'not_found' | 'scope_mismatch' }
```

**Approach:**
- Server query: `aiWorkflowRun` for `ctx.activeTransportId` + `threadId`, `state='succeeded'`, `metrics.reservationistResult.quoteRevisions` non-empty, newest first, cap 5.
- Freshness: reuse `assertReservationistResultFreshForAction` / existing 15 min staff-quote window. Expired → pane copy "This quote expired — run Quote again".
- Pane: if `luna.workflow==='create_booking'` and a fresh prior revision exists, skip `executeStaffQuote`, call `prepareBookingDraft` with that `workflowRunId`/`revisionRef`.
- Do **not** invent party/room/rate from Luna; still K8 (HMS names from revision context).
- Dates in the booking email that disagree with the revision → `unavailable` + missing question, no silent shift.

**Tests:**
- Thread with one fresh revision → finder returns it; draft rooms use `roomCode`/`rateCode` from revision.
- Expired revision → `unavailable`/`expired`; pane does not call prepare.
- Other transport's run → not returned.
- Date mismatch vs analysis.groups[0] → `unavailable`/`scope_mismatch`.

**Verification:** server tests green; mail test that booking card still Save-disabled.
**Commit:** `feat(reservationist): reuse prior staff quote for booking drafts`

---

### S2. Multi-date quotes (B1)

**Goal:** remove one-date guards, loop ≤5 date sets serially, one merged PDF with per-date sections. Pane runs K14 `quote` tasks in order (first N≤5).
**P50:** 1–1.25h. **1 live read-only multi-date quote as proof; HMS probe first.**

**Verified files:**
- Pane guard: [`apps/mail/lib/quote-workflow/staff-quote-bind.ts`](apps/mail/lib/quote-workflow/staff-quote-bind.ts) `:201-204` (`dates.size !== 1` → Distinct stays error).
- Server guard: [`apps/server-pilot/src/ai/staff-quote-workflow.ts`](apps/server-pilot/src/ai/staff-quote-workflow.ts) `:115` `staff_quote_separate_stay_required`.
- Budget pattern: [`apps/server-pilot/src/ai/reservationist-execution.ts`](apps/server-pilot/src/ai/reservationist-execution.ts) `:330` (alternatives bound: `requests.length>5` throw, `toolCalls+requests.length*6>24` throw). Copy **bounds only**, not the agent path.

**Approach:**
- Group stay groups by `arrivalDate/departureDate`. Each unique pair = one `executeStaffQuote` input (existing native request shape).
- Cap 5 date sets. 6th → review item "quote the first 5; remaining dates manual".
- Serial HMS (one CDP owner). Merge PDFs with existing converter if a merge helper exists; else concatenate in order with page-break. Do not add a new PDF engine.
- Pane: drop Distinct-stays hard error; show progress per date set; one "Quote all dates" button still maps to sequential server calls **or** one server mutation that loops. Prefer **one server mutation** `executeStaffQuoteMulti` that loops internally so the pane stays simple. If that fights `staffQuoteInput` strictness, loop from pane with existing mutation (N≤5) and merge client-side only if server merge is a timebox miss — log divergence.
- Live proof: one synthetic 2-date request through `fetch-quote.mjs` twice (read-only), not pane. Copy evidence to `.private/luna-mvp/proofs/multi-date/`.

**Tests:**
- Two date sets → two revisions, merged PDF non-empty, no `staff_quote_separate_stay_required`.
- Six date sets → first 5 quoted, 6th flagged.
- Single date → unchanged path (regression).

**Verification:** tests + tsc; live proof or HMS-down note.
**Commit:** `feat(reservationist): multi-date staff quotes up to five stays`

---

### S3. Extras lines (B2)

**Goal:** dinner allowance (client-stated amount only) and shuttle → `AuthorizedProposalFacts.extras` on the **staff** path. Today `proposalFacts: []` at [`workstation.ts:433`](apps/server-pilot/src/trpc/routes/workstation.ts). Shown on PDF. Model never prices.
**P50:** 45m.

**Approach:**
- Staff path currently skips `resolveProposalFacts`. Wire extras from **staff-approved analysis.missing / luna.rateClaims is wrong** — extras come from `luna.missing` questions answered in pane OR from `luna.flags` including `extras` plus a staff-typed amount field.
- Simplest: pane fields `dinnerAllowanceMinor?` and `shuttle: boolean` on staff header, passed into `executeStaffQuote` only if staff confirmed. Server maps to `AuthorizedProposalFacts.extras` using existing extra-line types (find `deriveAuthorizedExtraLines`).
- Invented-price rule: dinner amount digits must appear in the masked email or in the staff-typed field (staff-typed is allowed; Luna-typed is not). Reject if Luna emitted an extras amount not in source (U5 check already).
- If `AuthorizedProposalFacts` extras shape is missing a shuttle boolean, store shuttle as a labelled extra line with amount 0 and description "Airport shuttle (as requested)" — do not invent a shuttle price.

**Tests:**
- Staff dinner R450 + shuttle true → extras on facts; PDF contains both labels; `proposalFacts` length 1.
- Luna-only amount not in source → extras omitted + missing question.
- Default path still `proposalFacts: []` when no extras.

**Commit:** `feat(reservationist): staff-confirmed extras on quote PDF`

---

### S4. Save from pane — code only, flag off (A1)

**Goal:** implement create spawn + guard + duplicate check + readback behind `RESERVATIONIST_PANE_SAVE=off` (default). Route refuses when off. Save button stays disabled. **Never enable. Never live save.** Tests with fakes only.

**Guard:** staff-approved quote **or** (`Labtest` in guest last name AND arrival ≥ 2027-01-01). Duplicate: reservation search by guest+dates (read-only tool if already exists; otherwise skip search and still refuse when flag off).

**Commit if reached:** `feat(reservationist): pane save route behind off flag`

---

### S5. Research docs (B3 + B4)

Timebox 1h each. Aggregates only. Output:
- `docs/plans/2026-10-07-002-confirmation-letter-and-proforma-sizing.md`
- `docs/plans/2026-10-07-003-conference-quote-sizing.md`
Counts from census flags `amendment_or_cancel` / `conference_or_group` plus existing gap audit `[G]`. No PII.

---

## Stretch run order

S1 → S2 → S3 → S4 → S5, unless U5 census reorders S1–S3.
Skip an item if P80 + 1h checkpoint would land after 14:00 UTC; skip to S5 docs (no deploy).
