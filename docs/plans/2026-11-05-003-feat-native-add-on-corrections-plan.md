---
title: Native Add-On Corrections - Plan
type: feat
date: 2026-11-05
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Native Add-On Corrections - Plan

## Goal Capsule

Add deterministic preparation, native edit/removal and independent readback for existing HRCEN Non-Room Item rows, reusing the merged Add-On implementation.
This plan covers raw tools and their JSON session contract; UI, bundles, financial reversals and deployment are outside this request.
The owner authorized deepening and executing this plan autonomously in a fresh managed worktree. Use owned Proof Labtest writes only; no deployment is requested.
Implementation and proof are proposed for one inline lane, with writes serialized to an owned Labtest confirmation.
Stop a write sequence after uncertain persistence, an unapproved native prompt, a changed target or a changed prepared row; preserve attempts and reconcile before retry.

## Product Contract

### Summary

An agent reads a booking's Add-Ons, chooses a saved row ID, requests changed fields or removal, reviews a native preparation, then invokes an authorized Save and receives independent readback.
A catalogue code identifies the kind of Add-On; multiple rows can share that code.
Corrections identify the particular saved row, never the first matching name/code.

### Requirements

**Read and select**

- R1. Preserve current Add-On catalogue, read, add preparation and add-save contracts. Add normalized saved-row summaries and expose existing exact-ID detail reads through JSON for prefetching and selection.
- R2. Return current row identity, known fields, native options/editability and coverage. Unknown capability and incomplete reads remain explicit. Lookup ambiguity returns candidates rather than selecting a guest or row by name.

**Correct native rows**

- R3. Prepare edits by exact saved row ID and a nonempty partial patch. Omitted fields preserve their existing values; explicit empty comments and explicit zero prices remain meaningful. Expose dependent changes in the native preview.
- R4. Prepare removal of an exact saved row without dispatching the destructive native action. Report known warnings and unknown financial effects. Native removal is not quantity zero, a refund or delete-and-recreate.
- R5. Bind Save to the approved operation, property, reservation, row and effective fields. Re-read the row immediately before dispatch in the serialized session, refuse stale preparations and preserve existing add-only authority boundaries.
- R6. Verify edits on the same native row ID and removals by the proved native terminal state or complete relevant absence. Record outcome per attempt; desired state alone does not establish this attempt changed it.

**Compose and recover**

- R7. Accept a sequence of edits/removals with one operation per native row ID, retain ordered partial results and stop after uncertain dispatch. Do not claim atomicity or replay the batch blindly.
- R8. Keep trusted host authorization outside wire JSON. Do not introduce a new journal, distributed lock, simulator or mandatory logging system; execute operations one by one and retain returned in-memory attempts for reconciliation. Default agent saves remain verified Proof Labtest, 2027+ arrival, CMS off. Real-guest Saves require the existing trusted-host boundary and staff approval.

### Scope and acceptance examples

- AE1. Two Dinner rows exist. Editing quantity and comment on one row changes only that ID; the other row retains its identity and business fields.
- AE2. An edit omits dates and price. Native preparation preserves those values unless a dependency changes them, in which case the complete effective preview must expose that change before approval.
- AE3. Another session changes the target after preparation. Save returns `needs_input` with a stale-record issue and fresh fields, without dispatching this correction.
- AE4. Removal is acknowledged but a fresh read is incomplete. The result remains uncertain; absence in the loaded page is insufficient.
- AE5. A response is lost after dispatch. Reconciliation reads the exact target ID and reports the observed final state plus dispatch attribution; it never substitutes a different same-code row or claims an already absent row was removed by this attempt.
- AE6. A later operation fails after an earlier operation persisted. Return the earlier verified result, the uncertain attempt and unattempted operations; do not restart the sequence automatically.

Changing the catalogue code on an existing row is unsupported in the inspected form and is not part of the patch contract.
Bundle/activity edits, accounting eligibility rules, posted-charge reversals and new booking creation are excluded.
These boundaries do not impose a new hotel business rule; unproved financial side effects remain unknown and native refusals/warnings are surfaced.

### Evidence and remaining discovery

- [Current Add-On schemas](../../apps/server-pilot/tooling/hms-cloud/stay360-addons.md) describe the generic current-catalogue implementation, native controls, attempts and independent readback merged in PR #1047 (`67e3ab84a`).
- [Core implementation](../../apps/server-pilot/tooling/hms-cloud/stay360-addons.mjs) already selects saved rows for full detail, but its native request matcher and staging enforce inserts. Reuse form helpers without relaxing that insert guard globally.
- [Session implementation](../../apps/server-pilot/tooling/hms-cloud/stay360-addons-session.mjs) serializes JSON calls and keeps trusted callbacks outside wire input. JSON `read` currently does not forward `detailIds`; that is a small missing read seam.
- A fresh read on 2026-11-05 found five complete Labtest rows. One selected manual Dinner row had code read-only, all eight proposed patch fields editable, and Submit/Remove Record enabled. `can_update` and `can_delete` were null; those flags cannot prove permission.
- Previous Add-On proofs covered distinct row identities, sequential writes, response loss, late callbacks and an intervening identical insert. They do not prove edit/remove behavior.
- Native update identity/action, deletion action, prompt timing, persistence semantics and financial side effects remain to be discovered. U1 establishes these before their write guard is enabled; there is no unresolved owner decision preventing U1.

## Planning Contract

### Decisions

1. Extend the current Add-On module/session rather than create a separate implementation or a generic CRUD framework. Share row selection, form reading, field setting, native waits and the guarded executor internally.
2. Preserve existing `prepareStay360AddOns`/`saveStay360AddOns` as add-only. Add a corrections preparation/Save pair with explicit `edit`/`remove` operations. A prepared token has a kind; one Save path cannot consume another kind.
3. Use saved `nativeId` for corrections. Native primary-key/request fields must come from verified row selection, not arbitrary wire values or an assumed mapping between `recordid` and row ID.
4. Use a patch for edits: quantity, startDate, endDate, unitPrice, frequency, pricingControl, folio and comment. HMS supplies options and recalculated totals. Preserving an existing zero price is different from inventing a zero insert default.
5. Serialize the owning session, fresh-read the relevant target row(s), compare their full supported business before-state with preparation, re-stage and compare the approved after-state, then dispatch. An unrelated new row need not invalidate a targeted edit, but removal readback still needs sufficient coverage.
6. Confirm the native removal semantics before defining its verification predicate. If it removes the row, require a complete relevant read and preserved untargeted IDs; if it changes status, read the exact terminal state. Do not equate either with a cleared folio.
7. Keep sequential execution and per-operation results. Identical requested edits may report `unchanged` with no dispatch; a missing row returns explicit absence/stale-target evidence rather than a successful removal attributed to this attempt.

### Proposed exported and wire contracts

All low-level functions take an authenticated owning `page` and `confirmation` as separate required arguments.
Session `confirmation` is required on every JSON request; optional initial `guestName` and `arrivalDate` are lookup hints, not identity substitutes.
Prepared IDs are session-bound and a newer preparation invalidates earlier IDs.

```ts
type AddOnPatch = {
  quantity?: string | number;      // positive decimal
  startDate?: string;              // YYYY-MM-DD
  endDate?: string;                // YYYY-MM-DD
  unitPrice?: string | number;     // nonnegative decimal
  frequency?: string;              // current native option code
  pricingControl?: string;         // current native option code
  folio?: string;                  // current native option code
  comment?: string;                // explicit "" clears the comment
};

type AddOnChange =
  | { operation: "edit"; nativeId: string; patch: AddOnPatch }
  | { operation: "remove"; nativeId: string };

// Required: page, confirmation. Optional: detailIds, as today.
readStay360AddOns(page, confirmation, { detailIds?: string[] });

// Required: page, confirmation, changes (1..100, unique nativeId).
prepareStay360AddOnChanges(page, confirmation, changes: AddOnChange[]);

// Required: page, confirmation, originating preparedId, authorize callback.
// The session supplies fresh readers and serial execution.
// Corrections require trusted authorization; dispatch callbacks are optional.
// Existing add-session authorization requirements remain compatible.
saveStay360AddOnChanges(page, confirmation, preparedId, options);

// Extend existing reconciliation to understand the retained operation envelope.
reconcileStay360AddOns(saveResult, { withPage?, target? });
```

`AddOnPatch` must contain at least one supported key. Nulls, empty/duplicate IDs, unknown operations/fields, invalid calendar dates and contradictory native values are rejected before write dispatch.
For `remove`, `patch` is not accepted. A catalogue code or catalogue `itemId` cannot replace a saved `nativeId`.

| Wire request | Additional required fields | Additional optional fields | Result |
| --- | --- | --- | --- |
| `tool:"read"` | None | `detailIds` | Existing rows/columns/coverage plus normalized known summaries and requested full details |
| `tool:"list"` | None | None | Existing current catalogue result |
| `tool:"prepareChanges"` | `changes` | None | Corrections preparation below; no Save |
| `tool:"saveChanges"` | `preparedId` | None | Verified `saved`, partial/uncertain result, or refusal/needs-input |
| `tool:"reconcile"` | A retained prior Save in this session | None | Existing `verified`/`uncertain` result with operation-specific evidence |

Existing wire `prepare` and `save` retain their add-only meanings.
No wire `authorize`, write flags, raw request keys or executable callbacks are accepted.

```ts
type CorrectionsPreview = {
  outcome: "prepared";
  preparedId: string;
  confirmation: string;
  propertyCode: string;
  saved: false;
  changes: Array<{
    index: number;
    operation: "edit" | "remove";
    nativeId: string;
    before: AddOnDetail;           // identity + complete supported fields
    after: AddOnDetail | null;     // null denotes requested removal, not zero cost
    changedFields: string[];
    warnings: NativeWarning[];     // only observed native warnings
    financialEffect: "unknown";   // this contract does not prove reversals
  }>;
};

// AddOnDetail uses existing normalized AddOnPreview fields/controls,
// with saved nativeId; summary fields unavailable from a grid remain unknown.
// NativeWarning preserves a native kind/message when available.

type CorrectionReceipt = {
  index: number;
  operation: "edit" | "remove";
  nativeId: string;
  status: "updated" | "removed" | "unchanged" | "uncertain" | "not_attempted";
  dispatched: boolean;
  attribution: "verified" | "unknown";
  before: AddOnDetail;
  expectedAfter: AddOnDetail | null;
  observedAfter: AddOnDetail | null;
};
```

The low-level Save reports `awaiting_readback` or `uncertain` and retains attempts/receipts, operation, native IDs and fresh before-state before response consumption.
The session can report `saved` only when every dispatched operation satisfies its operation-specific verification and attribution requirements, and any no-op is explicitly marked `unchanged`.
If every requested patch is already satisfied, return `outcome:"unchanged"` with no dispatch; this is observed state, not an attributed write.
A missing row at preparation returns `needs_input` with `ADDONS_RECORD_NOT_FOUND`; a row changed or removed after preparation returns `ADDONS_RECORD_CHANGED` without dispatch.
Its result retains `requestedCount`, ordered operation results, reconciliation and a next action such as `fresh_session` or `reconcile_before_retry`.
Use existing `needs_input`, `unsupported`, `refused` and `execution_failure` envelopes with `issue` and relevant context; add a stable stale-record issue rather than silently overwriting concurrent changes.

Example: prefetch details, prepare one correction and one removal, then Save the returned token in that same session.

```json
{"tool":"read","confirmation":"<saved confirmation>","detailIds":["<row A ID>","<row B ID>"]}
{"tool":"prepareChanges","confirmation":"<saved confirmation>","changes":[{"operation":"edit","nativeId":"<row A ID>","patch":{"quantity":"2","comment":"Dinner for two"}},{"operation":"remove","nativeId":"<row B ID>"}]}
{"tool":"saveChanges","confirmation":"<saved confirmation>","preparedId":"<returned token>"}
```

### Deepened execution design

Use a fresh exclusively owned Labtest stay rather than modifying the previous Add-On proof fixture used by parallel chats. Copy this plan and supporting skill files into the managed child worktree; reuse the Add-On modules from that worktree's main baseline. Never edit or replace the source checkout during execution.

The correction matcher has three positive native phases: selected-row detail, selected-row recalculation, and selected-row edit/removal dispatch. Shared helpers take an explicit native row identity for corrections; add paths retain their existing blank/new-record checks. Removal preparation reads the selected row and its available action but does not click Remove. Save observes only the positively established native confirmation, if any, with the target already approved.

Every correction operation obtains a fresh full detail of its own native ID immediately before re-staging. Compare normalized supported business fields, not volatile timestamps or the complete native body. Capture the current row census for removal verification, keep the original ID for edits, and retain ordered attempted/unattempted results. After a possible dispatch, seal the page and reopen independently; never infer a complete deletion from a capped list.

Read prefetching needs no new search framework: forward `detailIds`, return normalized known summaries alongside existing raw rows, and use the existing reservation lookup for unresolved confirmation identity. `authorizeChanges` is a trusted function, not JSON. No mandatory `beforeDispatch`, journal or distributed lock is added for corrections; optional callbacks stay available for hosts that already need them.

All local checks are existing focused tests only. Native refusal and recovery cases use private one-off proof scripts outside Git, not a simulator framework. Final code review checks backward compatibility and matched existing-row actions.

### Execution design

Corrections reuse the existing session with a separate trusted `authorizeChanges` callback and optional correction dispatch callbacks. They do not force the add-only journaling/lock callback contract on new callers. Existing add-session `authorize` behavior is preserved. The owning page queue executes one correction at a time; caller-managed separate processes must also serialize writes to the same booking. A fresh pre-dispatch row read detects stale preparation, but is not an atomic compare-and-set against direct HMS edits.

### Sequence and estimate limits

U1 precedes native writes in U3; U2 establishes the reusable read/selection seam and can follow U1 in the same inline lane.
U3 depends on U1 and U2; U4 integrates its contract; U5 verifies the connected raw workflow.
The shared module, session and owned Labtest stay have one writer; no parallel agents are planned.
No elapsed or line estimate is asserted: the exact native deletion/prompt behavior is not yet measured, and a guessed estimate would hide that dependency.

## Implementation Units

### U1. Establish native correction semantics

- Owner: inline implementer.
- Goal: determine the actual selected-row edit and Remove Record flows before permitting either write.
- Requirements: R2-R6.
- Dependencies: merged Add-On tool and a working Stagehand bootstrap.
- Files: existing tool code/schema as read-only references; private discovery scripts outside Git.
- Approach: use an owned Proof Labtest stay, inspect detailed controls/identity and guard proposed write requests. Establish method/action, exact native row-key semantics, validation, prompt timing and potential prior persistence. Do not weaken the add-only guard to collect evidence.
- Patterns to follow: bounded correlated responses, page-lifetime fence, private capture, no page evaluation from a paused request handler.
- Test scenarios: duplicate-looking rows, native refusal, enabled action with unknown permission flags, prompt before or after possible persistence.
- Verification: report established edit/remove request identity and postconditions; unproven native behavior remains unsupported. No product test files added.

### U2. Expose exact saved-row reads

- Owner: inline implementer.
- Goal: make deterministic prefetch and detail selection available to JSON callers.
- Requirements: R1-R2.
- Dependencies: current reader; U1 informs capability output.
- Files: `apps/server-pilot/tooling/hms-cloud/stay360-addons.mjs`, `stay360-addons-session.mjs`, `stay360-addons.md`.
- Approach: factor existing exact row-selection/detail logic into a shared internal helper; add normalized known summaries without removing raw fields; forward `detailIds` from JSON `read`.
- Patterns to follow: selected native row identity, immutable results, explicit unknown/coverage.
- Test scenarios: missing row, repeated code/name, incomplete grid, summary fields unavailable until detail selection.
- Verification: fresh read resolves requested IDs without Save; existing read/list/add contracts remain compatible. No new tests.

### U3. Prepare and execute native corrections

- Owner: inline implementer.
- Goal: support generic partial edits and exact-row removal with scoped native guards.
- Requirements: R3-R7.
- Dependencies: U1, U2.
- Files: `apps/server-pilot/tooling/hms-cloud/stay360-addons.mjs`, existing shared read guard only if the proved native action requires an additional matched exception.
- Approach: add corrections preparation/Save exports with discriminated operation state; reuse native fields/options/recalculation; compare fresh target-row before-state immediately before dispatch and approved after-state; match the proved native edit/removal request; retain attempts before reading a response.
- Patterns to follow: current add-only guard remains strict, no whole-body/key-count pinning, new vs existing identity distinction, optional callback drain/quarantine.
- Test scenarios: untouched fields, explicit blank/zero, stale preparation, wrong row/operation, changed native price, unknown warning, possible dispatch with lost response.
- Verification: safe unsaved preparation and one owned native correction with independent readback per operation. No new tests.

### U4. Integrate session and reconciliation

- Owner: inline implementer.
- Goal: expose the proposed wire interface and safe partial results to agents.
- Requirements: R1, R5-R8.
- Dependencies: U3.
- Files: `apps/server-pilot/tooling/hms-cloud/stay360-addons-session.mjs`, `stay360-addons.md`.
- Approach: add `prepareChanges`/`saveChanges`, token-kind checks and exact trusted-host ownership; extend reconciliation by operation while retaining legacy add receipts; verify the same ID for edits and proved terminal state/complete absence for removal.
- Patterns to follow: immutable request cloning, session queue, fresh read in the serialized session, optional host callbacks and reconcile-before-retry.
- Test scenarios: wire authorization rejection, wrong token kind, first write succeeds/later write uncertain, missing target before dispatch, another session already applied the desired state.
- Verification: run the raw JSON tool sequence; ensure no wrong-row attribution or duplicate retries and expose unattempted operations. No new tests.

### U5. Prove and document the complete raw scope

- Owner: inline implementer; release/deployment owner unassigned and outside this request.
- Goal: prove both correction paths and preserve the existing Add-On workflow.
- Requirements: R1-R8 and AE1-AE6.
- Dependencies: U4.
- Files: changed tool/schema documentation and existing focused checks only.
- Approach: create/use an exclusively owned future Proof Labtest fixture with CMS off and two similar Add-On rows; edit one and remove the other, independently reopening after each; verify untouched rows. Run material refusal/recovery probes, focused checks, final remote typecheck and project-required review if code is prepared for merge.
- Patterns to follow: serialized writes, no blind retries, separate backend proof and production enablement.
- Test scenarios: AE1-AE6; existing add-only behavior, full-field readback, complete removal evidence and native unknown financial effects.
- Verification: evidence of edit and removal on the exact intended IDs, no unapproved native write, compatible existing tools. No new tests.

## Verification Contract

Before any tests, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL`.
Run existing focused `node --test` checks for touched lookup/session/read guards; no repo-wide tests/lint, no new test files and no local TypeScript compiler.
On the clean committed final code head, run the approved remote server-pilot typecheck and required review.
The native proof must show unsaved corrections, exact-ID edit persistence, removal postcondition with adequate coverage, unchanged untargeted records, and preserved receipts after a lost/uncertain response.
Read/unsaved staging on real records follows project authority; agent Saves use only owned Proof Labtest, 2027+ stays and CMS off.
Native removal must never be auto-confirmed from a generic dialog match; establish the prompt and the authorized decision first.
Commit the verified implementation as required for the final remote typecheck. Preserve the isolated worktree; no deployment or write-flag changes are requested. Report raw-tool completion independently of production integration.

## Definition of Done

The raw Add-On tools expose compatible read/list/add behavior plus exact-row edit/remove preparation, guarded native execution and independently verified operation-specific results through the JSON session.
Schemas document required/optional fields, stale-target refusal, partial outcomes, attribution and financial evidence limits.
Both correction paths pass owned Labtest proof and existing focused/final checks.
No native operation remains enabled solely because a button was visible or because another operation used a similar request shape.
Production workflow completion remains separate: trusted-host integration, deployment, real-email unsaved preparation and a deployed-main canary are not claimed by this raw-tool milestone.
