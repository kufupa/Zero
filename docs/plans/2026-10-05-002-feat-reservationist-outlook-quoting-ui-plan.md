# Staff-facing Outlook quoting UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **REQUIRED SUB-SKILL:** overnight-autonomous-execution (mandate below is binding). Use standard non-fast subagents only; if unavailable, execute inline.

**Execution posture:** Overnight autonomous — user unavailable; implement-fix-loop until done criteria green or deadline. Do not pause for routine approval.

**Goal:** A staff member selecting an inbound email in Classic Outlook can complete a human-in-the-loop quoting workflow in the Nava side pane: analyse the selection without PMS tools, edit requirements, approve serial read-only tool steps, inspect authentic results/evidence, choose an offer, review an accurate PDF and complete reply, then explicitly create an unsent Outlook reply. Staff send in Outlook.

**Architecture:** Keep native Outlook bridge, mailbox isolation, and unsent-reply machinery on `origin/main`. Replace the live `RATE_TABLE` quoting surface with a UI-owned quote session (pure TS reducer + presentational components + thin tRPC adapter). Analysis loads authorised mail/attachment bytes and never executes PMS. Tool execution is staff-gated and serial. Overnight this branch does not take the PMS/browser owner; fixtures prove UI; live HMS enqueue stays an explicit unverified integration seam. Do not import sibling-worktree files.

**Tech Stack:** React pane (`apps/mail`), tRPC `workstation` + new `quoteWorkflow` router (`apps/server-pilot`), existing v4 bridge (`CREATE_REPLY_DRAFT`, `ADD_ATTACHMENT_TO_DRAFT`), Vitest + happy-dom, existing Gotenberg PDF path only after selected evidence exists.

## Global Constraints

- Work only in `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui` on `feat/reservationist-quote-ui`.
- Treat `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` as read-only. No branch switch, reset, stash, commit, format, or install there.
- Linked worktrees share Git refs. No force-push, no protected-branch edits, no hook bypass.
- Do not copy the sibling working tree or cherry-pick its unrelated history. Do not `import` sibling paths in committed code.
- Do not rewrite reservationist runtime, pricing, extraction, composer, or native protocol in the other branch.
- Analysis must not execute PMS tools. Never label `enqueueHmsRead` / reservationist runtime as analysis-only.
- Overnight: do not enqueue live `hms_quote_stay` or acquire a second PMS/browser owner.
- Client `workstation.quoteProposalPdf` with staff-typed or `RATE_TABLE` rates is not a live quoting path. Disable it for staff proposal creation.
- No editable invented room prices. No demo screenshot as proof. No Send. No reservation creation. No automatic sending.
- Dates include month and year. No September-only calendar. No sample CIDB/NCOR rates as pricing authority.
- Preserve mailbox isolation, history/live-sync, and native uncertain-outcome behaviour from main (PR #28 is already merged).
- Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. No `.env.production`. No pilot RDS.
- Do not merge to main or deploy. Do not mutate production buckets, restart services, or write production drafts.
- Visual language from https://hermes.trynava.io/designs/outlook-side-pane-demo.html and existing pane chrome. Not its sample rates, screenshot, guest data, or 7-day validity copy.
- `docs/plans/2026-09-29-001-feat-side-panel-ui-catalogue-plan.md` is not the critical path. Share presentational components only.
- Main `proposalDescription` maps `SKNG`→Suite and `EXKNG`→Single. Do not use those labels as live room names; display evidence `roomLabel`.

---

## Product requirements

### A. Selected-email analysis

- Bind work to authorised mailbox, selected message, thread, and selection revision (`scopeEpoch` / `selectionEpoch` already on the pane).
- Auto-analyse a stable selection; cache by binding digest; do not rerun expensive work on every click of the same selection.
- Do not run PMS tools during analysis.
- Load preceding in-thread messages and authorised attachment **bytes** via existing mail services. Filenames are not document content.
- States: analysing, unsynced, missing-source, failed, unsupported. Non-quote messages must not open a fake quoting workflow.
- Preserve secondary questions and requested alternatives on the analysis record.

### B. Editable requirements

- One editable card per room/stay group.
- Fields: dates (Y-M-D), quantity, room preference, adults, children/ages when needed, board, organisation/agency, special requests.
- Distinguish extracted vs staff-corrected vs missing.
- Staff edits mint a new `inputRevision` and invalidate downstream results/PDFs. They must not mutate stored quote evidence.

### C. Human-approved tool steps

- Readable steps: editable inputs, dependencies, status, results.
- Organisation/agency lookup only when applicable; reuse a verified shared result.
- Same-date occupancy groups may share one supported quote request. Different date ranges require distinct requests.
- “Run next” plus per-step approve. No tool-console UI.
- PMS ops serial. Queued / running / succeeded / failed / cancelled + retry guidance.
- Never generate PDF before required selections/evidence exist.

### D. Results and evidence

- Actual room/rate/board options, exact stay totals, source timestamp, freshness.
- Expand nightly breakdown when prices vary.
- Alternatives vs rooms inside one selected allocation. Never sum alternatives as if booked. Never imply separately searched inventory proves joint availability.
- Surface mismatches, restrictions, missing authority.
- Screenshots only if authorised and tied to the exact tool run; otherwise honest unavailable.

### E. PDF, reply, native Outlook draft

- Reuse backend exact-money/PDF services when an adapter exists; no client pricing engine.
- Show actual PDF and complete prepared reply, including secondary answers.
- Protect staff edits/attachments via existing hydration/autosave/refetch where those hooks exist on this branch; otherwise bind to current drafts routes and report gaps.
- Explicit staff action creates an **unsent** native reply with reviewed HTML and exact selected PDF bytes.
- Revalidate source message, mailbox, recipients, reply context.
- Handle A→B and A→B→A, retries, unknown native outcomes. Never blindly retry uncertain creation. Preserve “check Outlook Drafts”. Never announce completion until native reply/attachment verified. Never Send.

### Non-goals

- Reservation creation, holds, save-and-cancel, automatic send.
- Workflow builder / arbitrary tool console.
- Dashboard catalogue as a ship gate.
- Rewriting sibling reservationist runtime.
- Overnight production deploy, installer rebuild, native protocol change (document only if unavoidable).
- Universal accuracy claims or invented confidence percentages.

## Existing seams to reuse (verified on this worktree / main)

| Seam | Path | Use |
| --- | --- | --- |
| Selected email + epochs | `apps/mail/app/(routes)/outlook-pane/page.tsx` | Binding, A→B suppression |
| Bridge | `apps/mail/lib/workstation/use-outlook-bridge.ts`, `bridge-protocol.ts` | `GET_ACTIVE_EMAIL`, `CREATE_REPLY_DRAFT`, `ADD_ATTACHMENT_TO_DRAFT`; no Send |
| Unsent reply cache | same page: `createOperationId`, unresolved marker, 15min TTL | Keep behaviour; feed reviewed HTML + selected PDF |
| Mailbox + quote email match | `workstation.quoteProposalPdf` + `emailsMatch` | Keep mailbox guard; stop using client rates |
| HMS read enqueue | `ai.enqueueHmsRead` (`hms_quote_stay`) | Documented integration only; **do not call overnight** |
| Drafts | `drafts.list` / `get` / `ensureEditableForReply` | Review/edit persisted drafts when present |
| Wrapper copy | `apps/mail/lib/quote-proposal/copy.ts` | Not the complete reviewed reply |

## Sibling worktree (read-only; not on main)

Present only under `centurion-dashboard-tools` (often uncommitted): `reservationist-draft-card.tsx`, `quote-proposal/admission.ts`, `reservationist-{installed-configuration,provider,runtime}.ts`, `quote-revision.ts`, `quote-lines.ts`, `workstation.qualifiedProposalChoices` / `qualifiedQuoteProposalPdf`.

**Adapter map (explicit):**

| Needed UI seam | On main tonight | Adapter behaviour |
| --- | --- | --- |
| Analyse-only | No reservationist extraction module | New `quoteWorkflow.analyseSelection`: mailbox-scoped mail+attachment load + conservative quote-intent parse. Never calls runtime/PMS. |
| Save requirement revision | None | Session-local revision + server echo when DB available; invalidate results |
| Approve/run step | `enqueueHmsRead` executes PMS | UI steps + fixture/local executor. Live enqueue returns `integration_unavailable` unless a later authorised owner-free adapter exists |
| Result read | No `qualifiedProposalChoices` | Fixture results + typed `QuoteOffer[]`. Optional later bind to sibling ledger |
| Evidence-backed PDF | Client-rate `quoteProposalPdf` only | Block PDF until selected evidence exists. Fixture PDF bytes for UI. Live Gotenberg from rates stays disabled |
| Native draft | Implemented | Reuse; htmlBody = reviewed reply, not `quoteWrapperHtml` |

Receipts at last inspection (`reusable-product-20261005/quote-checkpoint-results.json`, 2026-10-05T22:48:59Z): 28 terminal frozen cases, 1/21 completed accommodation quote, extraction/alternatives/secondary-ask gaps, Classic Outlook unverified, `productionReady: false`.

## Ownership

- This branch owns pane quoting UX, session model, presentational components, fixture matrix, and UI-owned tRPC adapter.
- Sibling branch owns reservationist runtime, exact-money revision, live quote PDF from evidence.
- Shared-core follow-on (after their land): swap fixture result/PDF adapters for `qualifiedProposalChoices` + `qualifiedQuoteProposalPdf` without rewriting UI contracts.

## File map

- Create: `apps/mail/lib/quote-workflow/types.ts`
- Create: `apps/mail/lib/quote-workflow/session.ts`
- Create: `apps/mail/lib/quote-workflow/fixtures.ts`
- Create: `apps/mail/lib/quote-workflow/native-draft.ts` (pure helpers extracted from pane)
- Create: `apps/mail/components/quote-workflow/quote-workflow-panel.tsx` (+ cards)
- Create: `apps/mail/tests/quote-workflow-session.test.ts`
- Create: `apps/mail/tests/quote-workflow-panel.test.tsx`
- Create: `apps/mail/tests/quote-workflow-scenarios.test.tsx`
- Create: `apps/server-pilot/src/trpc/routes/quote-workflow.ts`
- Create: `apps/server-pilot/tests/quote-workflow-router.test.ts`
- Modify: `apps/server-pilot/src/trpc/router.ts` (mount `quoteWorkflow`)
- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx` (replace live RATE_TABLE tool with panel; keep onboarding/diagnostics/native draft engine)
- Modify: existing `outlook-pane-*.test.tsx` so live quoting no longer asserts sample rates

---

## Autonomous Execution Mandate

**User granted autonomous execution for this plan.** Continue until the plan goal and done criteria are verified or a true blocker / deadline is reached. Do not pause for routine choices.

Window: start **2026-10-05T23:16:12Z**, deadline **2026-10-06T07:16:12Z**, stop launching long tasks **2026-10-06T07:01:12Z**. Deadline exhaustion is not completion.

Progress file (every ~30 min): `docs/plans/handoff-reports/reservationist-quote-ui-progress.md`.

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve requirements. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.
- First useful UI slice (selected-email analysis + editable groups visible; sample rates not live) targeted within 60–90 minutes of execution start.

### RCA loop

FAIL → reproduce minimally → identify root cause and mechanism → smallest correct fix → test → resume plan.

### Safety (overrides Zero overnight overlay deploy defaults)

Allowed: this worktree code/docs/tests/commits; synthetic fixtures; disposable DB/draft writes; read-only inspection of sibling source/evidence.

Forbidden:

- PMS writes, holds, save-and-cancel, second PMS/browser owner
- Emails sent or production draft writes
- Deployments, migrations, restarts, production/bucket mutations
- Weakening auth, mailbox grants, source ownership, freshness, or money checks
- Destructive Git, force-push, hook bypass, secret/PII leakage to external channels
- Vitest against production/pilot RDS; sourcing `.env.production`; `VITEST_ALLOW_PILOT_RDS`
- Changing installed native protocol or rebuilding installer unless necessary (then document only)

Before every Vitest:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

DB tests require an independently verified disposable non-production endpoint. If none, skip DB integration and report it — do not fail closed into pilot RDS.

Cursor execution-backend flake (`Execution backend unavailable…`): backoff-retry Shell/Write/StrReplace; not an app RCA.

### Verification loop

Implement → focused tests → relevant broader tests/build → browser at narrow pane width → inspect evidence → fix red → repeat.

Report separately: (1) verified UI behaviour (2) verified real backend integration (3) native Windows acceptance still required (4) production deployment still required (5) unresolved backend defects.

No mocked pass as live-tool or production qualification.

### Done criteria

- [ ] Isolated worktree/branch used; sibling tree unmodified by this agent
- [ ] One plan in this worktree `docs/plans/`; eng + ponytail findings addressed
- [ ] Live pane quoting no longer uses `RATE_TABLE` / September-only calendar / client-invented rates
- [ ] Analysis binds mailbox+selection+revision, caches stable selections, never calls PMS
- [ ] Non-quote / unsynced / missing-source / failed / unsupported states visible
- [ ] Editable stay-group cards; staff edits mint input revision and invalidate results
- [ ] Human-approved serial tool steps with status/retry; Run next; no tool console
- [ ] Results distinguish allocations vs alternatives; no summed alternatives; honest screenshots
- [ ] PDF generation blocked until selection/evidence ready; displayed PDF is the selected bytes
- [ ] Reviewed reply (including secondary answers) is what native insert uses — not generic wrapper-only
- [ ] Native unsent draft keeps existing uncertain-outcome / A→B / no-Send behaviour
- [ ] Scenario matrix covered by deterministic fixture tests (list in Task 8)
- [ ] Focused + relevant broader tests and mail/server builds; narrow-pane browser or documented substitute
- [ ] Progress file, scoped commits, overlapping-path integration order, staff walkthrough
- [ ] Handoff separates UI / live integration / Windows / production / backend defects
- [ ] No merge to main, no deploy

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction (Classic Outlook on Windows), destructive ambiguity, safety-policy conflict, or external outage that prevents required proof. Live PMS unavailability is **not** a full-project stop — continue UI and mark integration unverified.

## Execution Mode

Autonomous. Resume from first incomplete task and continue without routine checkpoints. TDD per task. Commit after each green task in this worktree only.

---

### Task 1: Quote session contracts and reducer

**Files:**
- Create: `apps/mail/lib/quote-workflow/types.ts`
- Create: `apps/mail/lib/quote-workflow/session.ts`
- Test: `apps/mail/tests/quote-workflow-session.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `QuoteSession`, `reduceQuoteSession(state, action)`, `selectionDigest(binding)`, `applyStaffGroupPatch`, `canRunPdf`, `canCreateNativeDraft`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  reduceQuoteSession,
  initialQuoteSession,
  selectionDigest,
} from '../lib/quote-workflow/session';
import type { QuoteSelectionBinding } from '../lib/quote-workflow/types';

const bind = (over: Partial<QuoteSelectionBinding> = {}): QuoteSelectionBinding => ({
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  internetMessageId: '<a@x>',
  selectionEpoch: 1,
  scopeEpoch: 1,
  ...over,
});

describe('quote session', () => {
  it('reuses analysis for an unchanged selection digest', () => {
    const a = reduceQuoteSession(initialQuoteSession(), {
      type: 'selection',
      binding: bind(),
    });
    const analysing = reduceQuoteSession(a, { type: 'analysis_started' });
    const ready = reduceQuoteSession(analysing, {
      type: 'analysis_ready',
      analysis: { intent: 'quote', groups: [{ id: 'g1' }], secondaryAsks: ['parking?'], alternatives: ['RO'] },
    });
    const same = reduceQuoteSession(ready, { type: 'selection', binding: bind() });
    expect(same.phase).toBe('requirements');
    expect(same.analysis).toBe(ready.analysis);
    expect(selectionDigest(bind())).toBe(selectionDigest(bind({ selectionEpoch: 1 })));
  });

  it('does not open a quoting workflow for non-quote intent', () => {
    const s = reduceQuoteSession(
      reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() }),
      { type: 'analysis_ready', analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [] } },
    );
    expect(s.phase).toBe('non_quote');
  });

  it('staff edits mint inputRevision and invalidate results/pdf', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, {
      type: 'analysis_ready',
      analysis: { intent: 'quote', groups: [{ id: 'g1', arrivalDate: '2026-11-12', departureDate: '2026-11-14' }], secondaryAsks: [], alternatives: [] },
    });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [{ id: 'o1', kind: 'allocation', stayTotalMinor: 272000, nightly: [] }],
    });
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(s.inputRevision).toBe(2);
    expect(s.offers).toEqual([]);
    expect(s.pdf).toBeNull();
    expect(s.phase).toBe('requirements');
  });

  it('refuses PDF before a selected allocation with evidence', () => {
    const s = initialQuoteSession();
    expect(s.canCreatePdf).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/quote-workflow-session.test.ts
```

Expected: FAIL module not found.

- [ ] **Step 3: Minimal implementation** — types + reducer covering selection cache, phases, patch invalidation, PDF/native gates. No PMS. No pricing math beyond storing `stayTotalMinor` from evidence.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit** `feat(quote-ui): add quote session reducer`

---

### Task 2: Deterministic scenario fixtures

**Files:**
- Create: `apps/mail/lib/quote-workflow/fixtures.ts`
- Test: `apps/mail/tests/quote-workflow-session.test.ts` (extend)

**Produces:** `loadQuoteFixture(id)` for: `public-single`, `agency-contract`, `mixed-same-dates`, `staggered-dates`, `varying-nights`, `ro-vs-bb`, `attachment-dependent`, `missing-fields`, `unsupported`, `source-failure`, `selection-change`, `staff-invalidate`, `failed-run`, `uncertain-native`.

Each fixture is static JSON-shaped TS. Alternatives have `kind:'alternative'` and `combinable:false`. Mixed same-date groups share `quoteRequestKey`. Staggered dates have distinct keys. Varying nights have ≥2 distinct `amountMinor`. Screenshot-unavailable uses `{ unavailable: true, reason }`. No Hermes demo rates as totals.

- [ ] Failing test: mixed-same-dates shared key; staggered distinct keys; summing alternatives forbidden helper `allocationTotal` ignores alternatives.
- [ ] Implement fixtures + `allocationTotal`.
- [ ] Commit `feat(quote-ui): add quoting scenario fixtures`

---

### Task 3: Analysis adapter (no PMS)

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/quote-workflow.ts`
- Modify: `apps/server-pilot/src/trpc/router.ts`
- Test: `apps/server-pilot/tests/quote-workflow-router.test.ts`
- Create: `apps/mail/lib/quote-workflow/analyse-client.ts` if needed for types-only

**Produces:** `quoteWorkflow.analyseSelection`

Input: `{ internetMessageId, storeId, entryId, folderEntryId, selectionEpoch }` via `mailboxProcedure`.

Behaviour:

1. Reject mailbox mismatch / missing session (`FORBIDDEN`).
2. Lookup message on `ctx.activeTransportId` by `messageIdHeader`. Missing → `{ status: 'unsynced' }`.
3. Load thread messages with `receivedAt <= selected` (causal preceding only).
4. For each attachment: persist identity `{ attachmentId, filename, byteSize, sourceHash }`. Load bytes through existing authorised artifact reader when present; if bytes missing → `{ status: 'missing_source', missing: [...] }`. Never treat filename as body.
5. Classify intent conservatively from body+decoded attachment text: quote-like vs other. Other → `{ status: 'ready', intent: 'other' }`.
6. Extract stay groups with ISO dates (include year). Missing dates stay missing; do not default September 2026.
7. Return `{ status:'ready', intent, groups, secondaryAsks, alternatives, sourceRevision, attachmentAdmissions }`.
8. **No** `enqueueHmsRead`, **no** reservationist runtime import.

If disposable DB is unavailable, router unit tests mock `getDb`/readers. Do not point Vitest at pilot RDS.

- [ ] Failing tests: unsynced; filename-only attachment is missing_source; non-quote intent; no PMS mock called.
- [ ] Implement router; mount on `appRouter`.
- [ ] Commit `feat(quote-ui): add analyse-only quoteWorkflow route`

---

### Task 4: Requirement cards and tool-step UI

**Files:**
- Create: `apps/mail/components/quote-workflow/requirement-card.tsx`
- Create: `apps/mail/components/quote-workflow/tool-step-list.tsx`
- Create: `apps/mail/components/quote-workflow/quote-workflow-panel.tsx`
- Test: `apps/mail/tests/quote-workflow-panel.test.tsx`

Visual: existing pane tokens (`bg-[#f1f3f6]`, slate, lucide). Month+year date fields (`<input type="date">` or month/year selects). Provenance chips: Extracted / Staff / Missing.

Tool list: Run next + per-step Run. Status text. No free-form console.

- [ ] Tests: edit adults → `onPatchGroup`; missing field labelled; Run next disabled while running; failed step shows retry guidance.
- [ ] Implement.
- [ ] Commit `feat(quote-ui): add requirement and tool-step cards`

---

### Task 5: Results, evidence, PDF/reply review

**Files:**
- Create: `apps/mail/components/quote-workflow/results-list.tsx`
- Create: `apps/mail/components/quote-workflow/document-review.tsx`
- Extend panel tests

Rules encoded in helpers already: `allocationTotal`, `jointAvailabilityUnknown`. Selecting an alternative does not add it to allocation total. Screenshot placeholder must say unavailable when no authorised artifact. PDF button disabled until `canCreatePdf`. Reply textarea is the prepared complete reply; native insert reads that string.

- [ ] Tests for RO vs BB alternatives not summed; staggered dates both shown; varying nights expandable; unavailable screenshot copy.
- [ ] Commit `feat(quote-ui): add results and document review`

---

### Task 6: Native unsent draft uses reviewed content

**Files:**
- Create: `apps/mail/lib/quote-workflow/native-draft.ts` — extract payload builders from pane without behaviour change except `htmlBody` source
- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx` — `handleInsertAiDraft` requires session `canCreateNativeDraft`, uses reviewed HTML + selected PDF bytes, keeps operation-id / unknown-outcome / GET_ACTIVE_EMAIL revalidation
- Modify: `apps/mail/tests/outlook-pane-quote-pdf.test.tsx` and `outlook-pane-render.test.tsx`

`quoteWrapperHtml` must not be the only body when a reviewed reply exists. Client `quoteProposalPdf` must not run for the live quoting path.

Preserve: no Send; confirm-after-uncertain; A→B abort; attachment after confirmed location.

- [ ] Tests: htmlBody contains reviewed secondary answer; does not contain only generic wrapper when review exists; RATE_TABLE rates not posted; unknown timeout still asks to check Drafts.
- [ ] Commit `feat(quote-ui): insert reviewed unsent Outlook reply`

---

### Task 7: Replace live RATE_TABLE tool surface

**Files:**
- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx`
- Modify pane tests

Keep welcome/tour/diagnostics. Tool screen renders `QuoteWorkflowPanel`. Search Availability becomes Run next (or labelled equivalent). Calendar demo may remain inside a collapsed “visual reference” details **disabled** from creating proposals (`canCreatePaneProposal` false / no RATE_TABLE mutate).

`handleExecuteSearch` timeout+toast of NCOR must die.

- [ ] Render tests: no “R2,150.00” as live offer; analysing/non-quote/missing copy present for fixtures.
- [ ] Commit `feat(quote-ui): replace sample-rate pane with quote workflow`

---

### Task 8: Scenario matrix on production components

**Files:**
- Test: `apps/mail/tests/quote-workflow-scenarios.test.tsx` rendering `QuoteWorkflowPanel` + reducer, not a duplicate harness

Matrix:

1. public single room
2. organisation/agency contract
3. mixed occupancy same dates (shared request key)
4. staggered dates (distinct requests)
5. varying nightly prices
6. RO versus BB alternatives
7. attachment-dependent + missing_source
8. missing fields / unsupported / source failure
9. selection change during slow run (epoch mismatch discards)
10. staff edits invalidate results
11. failed run + retry guidance
12. PDF review + uncertain native outcome copy

Browser: narrow width ~320–380px using existing mail test environment or a small Playwright pane fixture if already available. Keyboard: date field, Run next, Insert draft focus order. If no headed browser, record substitute (happy-dom + computed styles) and remaining Windows gap.

- [ ] Commit `test(quote-ui): cover quoting scenario matrix`

---

### Task 9: Builds, handoff, integration order

**Files:**
- Modify: progress + create `docs/plans/handoff-reports/reservationist-quote-ui-handoff.md`

Commands:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/mail exec vitest run tests/quote-workflow-session.test.ts tests/quote-workflow-panel.test.tsx tests/quote-workflow-scenarios.test.tsx tests/outlook-pane-render.test.tsx tests/outlook-pane-quote-pdf.test.tsx tests/outlook-pane-auth.test.tsx tests/outlook-pane-onboarding.test.tsx
pnpm --filter @zero/server-pilot exec vitest run tests/quote-workflow-router.test.ts tests/workstation-router-contract.test.ts
pnpm --filter @zero/mail build
pnpm --filter @zero/server-pilot build
```

Handoff must list overlapping paths vs sibling (`outlook-pane/page.tsx`, `workstation.ts`, drafts, quote-proposal) and integration order:

1. Keep UI contracts stable.
2. After sibling `quote-revision` + `qualifiedProposalChoices` merge, replace fixture result/PDF adapters only.
3. Staff-approved live `enqueueHmsRead` only with a single PMS owner.
4. Do not merge either branch to main in this window.

- [ ] Commit docs handoff. No deploy.

---

## Engineering review (orchestrator, 2026-10-05T23:20Z)

Completeness floor:

- Analysis-only vs PMS execute is an explicit adapter table — pass.
- Native uncertain outcomes reused, not rewritten — pass.
- Backend incompleteness remains visible via `integration_unavailable` / fixture labels — pass.
- Scenario matrix listed as tests on production components — pass.
- Safety overrides overlay deploy permission — pass.

Findings fixed in-plan:

1. **Do not overnight-call `enqueueHmsRead`.** Competing PMS owner. Fixture executor only.
2. **Do not port sibling runtime files.** Adapter, not copy.
3. **Do not keep client-rate PDF as fallback.** Disabled live path; missing evidence stays missing.
4. **Do not use wrong SKNG/EXKNG labels from main `proposalDescription`.** Evidence labels only.
5. **Catalogue plan is not a gate.**

## Ponytail review (orchestrator)

- `yagni:` no workflow-builder, plugin registry, or multi-plan framework. One reducer, one panel, one router.
- `delete:` live `RATE_TABLE` search success path. Replacement: workflow panel.
- `yagni:` no new design system. Reuse pane classes.
- `shrink:` extract native-draft helpers from 1900-line page rather than duplicate.
- net: target smaller `page.tsx` live-quote section, not extra abstraction layers.

Lean enough to ship this shape.

## Git Commit Strategy

Atomic commit per task in this worktree. Never commit `.env`, secrets, sibling files, or `.private` receipts.
