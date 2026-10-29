---
title: Reusable Infor session continuity for Pomerado mints and tools
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reusable Infor session continuity for Pomerado mints and tools

**Target repo:** Pomerado. Zero paths refer to the separate Zero repo.

## Goal Capsule

Enable one reviewed Infor reservation-read tool through this Codex, minting
with a verified authenticated page and proving a fresh replay. Reuse the same
session handling for later Infor tools. The owner authorized execution following
this plan and prefers a quick first proof. Do not substitute a handwritten
browser read for a published tool, change HMS records, send messages, or treat
the aspirational speed target as a deadline to cancel progressing work.

## Product Contract

### Requirements

- **R1.** Use self-hosted Pomerado, the already configured Azure model route,
  native sign-in and the correct tenant/property.
- **R2.** Avoid host-initiated direct navigation after successful Infor sign-in;
  reach task screens through HMS controls. Support mint checks and fresh runs.
- **R3.** Publish a read-only Stay 360 tool, review it, invoke it freshly from
  an independent context and compare the exact record's visible fields and
  repeated rows with the captured reference.
- **R4.** Keep native sign-in tracking, credential handling and Guardian review
  truthful. Handle expired sessions or a wrong property explicitly.
- **R5.** Make the fix reusable for later Infor tools; demonstrate a second
  workflow after the first proof. Preserve private data and existing work.

## Planning Contract

The exact failed-mint transition remains unknown. Use existing recovery tests
and trace the installed runtime before committing to a narrow change. An
Infor-specific session mode must account for marker verification as well as
mint resets and fresh runs: `standalone/signed-in-marker.ts` can reload the
page while verifying sign-in. Preserve meaningful marker verification; never
pretend a skipped check passed. The host's existing marker-preflight unavailable
result can avoid its destructive diagnostic load, but native sign-in must still
compare the signed-out snapshot and verify a current-page marker without an
`openPath`. Before execution require positive current-page evidence of the
expected tenant and property; an unknown, unavailable or absent marker is not
verification and must fail safely. Update
authoring guidance so the minter understands the limitation. Guardian's
`startsOnFreshPage` must describe the actual page in normal execution and batch
live tests, and page identity/property must be checked. The installed
canary and source checkout have different package versions; pin and check the
actual fork and Azure adapter instead of overwriting the npm cache or weakening
the adapter's version guard silently. Generated artifact launchers must point to
the same verified runtime used to mint them and receive the same selected
session mode. A running MCP server does not pick up a changed runtime: verify
the replacement process before minting and retain a rollback route.

```mermaid
flowchart LR
  A[Fresh owned page] --> B[Native sign-in and property check]
  B --> C[Marker verification without losing page]
  C --> D[Mint examples and tests via HMS UI]
  D --> E[Publish and review]
  E --> F[Fresh page and sign-in]
  F --> G[Run generated read and compare fields]
```

## Goal and current state

Create multiple read tools in self-hosted Pomerado from ordinary task prompts,
using one reusable Infor session setup that preserves a verified authenticated
page through mint checks and fresh tool execution. Infor is the target; a
general multi-site framework is not a goal. A prior native mint reached the
requested Stay 360 record but ended incomplete and published no tool. The owner
asked for a plan before further live trials. Preserve Pomerado's native input,
sign-in tracking, Guardian and artifact publication. Research:
`docs/research/2026-10-28-pomerado-hms-session-continuity.md`.

No claim is made that the internal reason for Centurion's visible login screen
after navigation is known. The owner has now authorized implementation and a
read-only proof; the older research-only hold is historical.

Previous work proposed and tried handing the existing login to Pomerado's own
page; the login check passed in some attempts, but no tool was published or
freshly replayed. Its host-only login was not registered in native Pomerado's
sign-in tracker, and source had a later reset refusal for that state; whether
the refusal caused those outcomes is unknown. The current proposal uses the
newer native sign-in that reached the requested record and specifically tests
tracker compatibility and page continuity through publication and a fresh run.
An owned page lasts for a job/call, not forever across all future calls.

## Proposed architecture

1. **Decide from a controlled characterization.** Reuse Pomerado's existing
   `lostOnLoad` unit cases and bounded automatic-sign-in fixtures; extend them
   only if needed to cover the observed document-bound Infor behavior across
   mint checks and fresh operations.
   If the existing path meets every acceptance criterion reliably, prefer it.
   Otherwise make the smallest Infor-specific session-start change at the host
   boundary, version-pinned to the installed Pomerado source. Existing
   `navigateRoot` hooks run too late to preserve a page; changing only that hook
   is insufficient. No generic multi-site framework is required.
2. **Configure the Infor session once.** Own a dedicated browser/page per Pomerado
   job or served call; use native sign-in and input if they can satisfy the
   contract. Verify tenant and property using existing Zero shell checks or
   the same logic under test. After sign-in, stay on the authenticated page;
   reach a verified neutral start using HMS controls. Do not use `goto`, reload,
   direct screen URLs, tab replacement or browser-data clearing for a normal
   authenticated start. Existing Zero `login()` itself calls `goto`: reuse it
   only at initial authentication if its secret boundary and Pomerado sign-in
   tracking are proven compatible. Prefer reusing its property verifier.
3. **Apply it at both boundaries.** Examples/tests in a mint and a newly
   launched generated tool must use the same policy, including the correct
   sign-in recipe, tracking, origin guards, property, and page identity. Put
   the session behavior in the actual configured Pomerado launcher or package,
   not a transient workspace or an untracked edit to `node_modules`. Establish
   whether the public core exposes a sufficient supported seam; otherwise keep
   a small host fork and record upstream revision and patch ownership. The host
   must itself preserve the page; also check generated and exploratory code for
   direct post-login navigation via supported execution controls or review and
   deterministic checks. Document any enforcement gap. Do not blanket-block
   navigation caused by a legitimate UI click or claim Guardian is a sandbox.
4. **Make state and isolation explicit.** UI navigation must reach a known
   neutral state and every tool must set and verify its own inputs and exact
   record, so previous filters, tabs and guest details do not leak into a new
   result. Start new jobs/calls in fresh contexts; within a job retain only its
   owned page. On timeout, missing shell or wrong property, fail clearly or
   re-authenticate in a fresh owned context with bounded retry for safe reads;
   no implicit retry of writes. Never attach the product's live browser by
   default. Concurrent requests must be isolated and property-checked without
   adding an unrequested global staff lock or killing unrelated browsers.
5. **Keep read boundaries intact.** This booking operation requests `read`;
   typing credentials is authentication, not an authorized reservation edit.
   Keep Guardian, sign-in origin checks, native credential handling and source
   review. Avoid edits and don't assume every UI click is harmless. Credentials
   must not appear in prompts, generated source, diagnostics or Git.

The session setup is reusable configuration plus host behavior, not only prose in
the prompt. The mint request describes the particular task:

> Use the Infor session setup. Sign in through the native credential prompt.
> Once signed in, navigate with HMS menus, buttons and tabs only; do not reload,
> open direct screen URLs or replace the tab. Verify the property and the exact
> requested reservation. Return every visible labelled field, blank values and
> all repeated rows; report missing sections or ambiguous matches. Read only;
> stop if the session is lost or the property cannot be verified.

This prompt is a proposed future usage, not a feature already installed.

## Work sequence and decision gates

### 1. Characterize without a live hotel

- Pin and inspect the actual server package and launcher; avoid assuming the
  separate Pomerado checkout is the executing server. Map mint reset,
  `signedInAtEntry`, authentication recording, served operation startup and
  publication. Compare with the earlier report, not an unrelated version.
- Start with `typescript/tests/unit/session-sign-in.test.ts:357-420` (which
  already simulates a session lost on load) and the browser sign-in/start-state
  fixtures. Extend an existing fixture only if it lacks coverage of two mint
  checks and a fresh run under the observed Infor behavior. Add value-free
  state tracing: phase, page identity, reset kind, sign-in cause, counter and
  `lostOnLoad` status. Do not log contents, guest data or secrets.
- Choose the native recovery only if all checks pass with an authenticated
  page, exact property, repeatable neutral start, ordinary sign-in tracking and
  no browser-initiated reset, `goto` or reload after successful authentication.
  Recovery that repeatedly resets and signs back in does not meet the owner's
  click-only contract. Otherwise implement the earlier host session-start change.
  Preserve sign-in, isolation and publication checks needed by this workflow.

### 2. Implement and validate the chosen seam

- Candidate Pomerado paths: `typescript/src/standalone/mint-state.ts`,
  `typescript/src/runtime/start-state.ts`, `typescript/src/runtime/session-sign-in.ts`,
  `typescript/src/standalone/run-operation.ts`; keep Infor UI logic in one
  reusable place. Determine artifact/config lifecycle
  and supported hook shape from the actual code before committing the design.
- Existing relevant tests include `typescript/tests/unit/start-state.test.ts`,
  `typescript/tests/unit/session-sign-in.test.ts`,
  `typescript/tests/browser/standalone-start-state.spec.ts`,
  `typescript/tests/browser/standalone-sign-in.spec.ts`, and
  `typescript/tests/unit/standalone-artifact.test.ts`. Add focused coverage for
  multiple checks, fresh served run, exact property verification, expired
  session, page ownership, and secret handling.
- Exercise two different records sequentially, a missing/ambiguous record,
  wrong property, two concurrent requests, and an expired session in the
  fixture. A read may retry in a fresh page only if the starting conditions
  are verified; a write cannot be repeated implicitly. Confirm no generated
  code bypasses Guardian or origin checks.
- Zero tests and typechecks run on the approved Product EC2, never this VPS;
  clean up every process started. Arrange Pomerado fixture execution without
  impacting the hotel browser or other running services.

### 3. End-to-end acceptance

- Mint the read-only tool through native Pomerado. Require a complete published
  artifact and Guardian receipt; inspect source for navigation and write risk.
- Launch it freshly with the same session policy, independently reauthenticate,
  verify tenant/property and the exact requested record, and compare the
  returned visible fields, blanks and nightly rows with the private capture.
  Report UI fields not reached; do not silently treat missing as empty.
- Verify a second distinct tool/workflow against a fixture or an appropriately
  authorized record to show the session setup is reusable. Check no cross-record
  leakage or unrelated clicks. Register/refresh the generated integration for
  Codex only after publication and review; whether a client restart is needed
  depends on the final registration mechanism and must be verified then.
- Record measured elapsed time and reliability. The prior attempt took roughly
  14 minutes and did not publish; no successful end-to-end estimate or savings
  is evidenced yet.

## Conditional working allowance

The following are uncalibrated planning judgments, not measured completion
times or a guarantee: (1) reuse existing test cases and identify the missing
recovery boundary, 20–45 minutes; (2) implement and verify a small host change,
1–3 hours; (3) mint, review, register and freshly replay one tool, 45–120
minutes. Serial total is approximately 2–6 hours if the host change is small,
tests and publication work, and no significant wait occurs. User input/restart
waits and repeated failed mints are excluded; complications can extend it.
Earlier attempts took roughly 14 minutes and 82 minutes respectively without
publication, so they cannot calibrate a successful full-path estimate. Update
the forecast after the first actual characterization.

## Alternatives and tradeoffs

| Approach | Assessment |
| --- | --- |
| Better mint prompt alone | Useful guidance; cannot stop a host reset before a generated step. |
| Existing recovery only | Lowest maintenance if the controlled characterization and both mint/run acceptance gates pass; not yet demonstrated. |
| Small Infor-specific host change | Recommended if native behavior fails the contract; supports many Infor tools, at the cost of maintaining a small pinned Pomerado change. |
| Share an already-running product page | Stock standalone refuses CDP attachment; introduces page ownership and interference problems. Not the default. |
| Restore cookies/storage state | A possible optimization only after separate proof; it cannot be assumed to restore a live app's in-memory state. |

## Implementation Units

### U1. Characterize the actual session lifecycle

**Goal:** Establish the smallest missing behavior for R1–R4.

**Files:** Pomerado `typescript/src/standalone/mint-state.ts`,
`typescript/src/standalone/signed-in-marker.ts`,
`typescript/src/standalone/run-operation.ts`,
`typescript/src/standalone/mint-live-tests.ts`,
`typescript/authoring/auth/SKILL.md`,
`typescript/tests/unit/session-sign-in.test.ts`,
`typescript/tests/browser/standalone-sign-in.spec.ts`,
`typescript/tests/browser/standalone-start-state.spec.ts`.

**Approach:** Reuse the existing synthetic cases and exact prior observations.
Trace the native sign-in, marker, reset, Guardian metadata, artifact runtime and
cold-run sequence. Add or extend a focused synthetic case only for the missing
behavior. Determine whether the checked-out source matches the installed canary
in relevant paths. Do not repeat live root/reload diagnostics.

**Test scenarios:** A page-bound authenticated fixture loses its state when
directly navigated; multiple mint checks and a fresh run retain a verified
signed-in page without a post-auth host navigation. Missing or wrong markers and
expired sessions fail clearly. Existing ordinary startup behavior remains
honest to Guardian. Verify the negative case before changing production code.

**Verification:** The relevant test/trace identifies the failing boundary;
no claim is made about the missing historical mint trace.

### U2. Implement and activate the narrow host change if needed

**Goal:** Satisfy R1, R2, R4 and R5 in the actual mint and run paths.

**Dependencies:** U1.

**Files:** Pomerado `typescript/src/standalone/mint-state.ts`,
`typescript/src/standalone/signed-in-marker.ts`,
`typescript/src/standalone/run-operation.ts`,
`typescript/src/standalone/mint-live-tests.ts`,
`typescript/src/standalone/session-sign-in.ts`,
`typescript/src/runtime/sign-in-replay.ts`,
`typescript/src/destinations/autofill-step.ts`,
`typescript/authoring/auth/SKILL.md`, affected runtime/contracts and the focused
tests identified in U1, especially `typescript/tests/unit/mint-review-context.test.ts`,
`typescript/tests/unit/mint-live-tests.test.ts` and
`typescript/tests/browser/standalone-live-tests.spec.ts`. Azure launcher and MCP
registration are local operational configuration, not committed upstream source.

**Approach:** If U1 finds that native behavior already meets every requirement,
reuse it; otherwise keep the change scoped to the selected session behavior. Preserve
real signed-in validation, native tracker state, correct Guardian context and
clean job/call ownership. Pin the built source and verify the Azure model and
endpoint adapter remain intact. Ensure the artifact's runtime can start from
the same tested package and selected mode, including after Codex restart. Verify
the actual connected process uses the new build before minting. Keep a rollback
route. Use an isolated worktree; do not patch an active npm cache or restart an
in-flight mint.

**Test scenarios:** Multiple examples preserve the page and report the correct
fresh-page status; Guardian receives current-page context for ordinary execution
and live batches; marker verification cannot claim a login that was absent;
wrong property and expiry refuse or reauthenticate safely; a fresh served run
signs in and starts without reloading; `openPath` cannot reintroduce a later
navigation via the confirmation, replay or automatic-recovery paths; separate
requests do not share guest state. A marker found on a signed-out page is
rejected; unknown, unavailable, signed-out and wrong-property states cannot
start the operation. Necessary reauthentication uses a fresh context.
Unselected site/start behavior remains consistent with its existing contract.

**Verification:** Focused synthetic tests pass on Product EC2, the build and
relevant checks pass, and source review confirms native auth and Guardian remain.

### U3. Publish and prove the requested read

**Goal:** Satisfy R3 with a real Pomerado artifact.

**Dependencies:** U2.

**Files:** Pomerado integration output under the configured private root;
Zero private reference `.private/pomerado-readstay/codex-centurion-20261028/`.

**Approach:** Start one native read mint using click-only task guidance. Preserve
its diagnostic receipts. Require `build: published`, review its actual source,
register it, and use a fresh context to read the exact requested record.
Compare every captured field and repeated row; report missing coverage. A Codex
restart may be needed after registration and is requested only when necessary.

**Test scenarios:** Correct match and property return the visible fields;
missing/ambiguous result and wrong property stop without returning another
guest. Verify no unintended write and no model-generated credential leakage.

**Verification:** Published artifact, fresh invocation, field comparison and
owned-process cleanup are recorded. Incomplete publication is a partial result.

### U4. Demonstrate reuse

**Goal:** Satisfy R5 after the first proof, using a second Infor workflow.

**Dependencies:** U3.

**Files:** Existing session runtime and focused synthetic/browser fixtures;
additional private integration output only if a live second workflow is needed.

**Test scenarios:** A second workflow starts with the correct property, reaches
its screen by HMS controls and does not inherit another record's state.

**Verification:** A fixture or an authorized real record proves the same session
handling supports another workflow; otherwise report the remaining limitation.

## Verification Contract

Zero tests and all test runners/typechecks run only on Product EC2, not the
coding VPS. Stage the exact Pomerado patch in an isolated EC2 workspace; use
Node 24.21–24.x and pnpm 10.34.5 with frozen dependencies, building before
browser tests. Existing Zero-only remote wrappers do not test this repo.
Pomerado browser tests use a built package and synthetic sites.
Preserve the Azure route and native auth/Guardian; report any failed check,
missing receipt or restart still required. Preserve the historical reference
and unrelated work. Track each process started and clean it up by PID.

## Definition of Done

One published, reviewed read tool succeeds from a fresh Codex invocation with
the correct property, exact record, visible fields and repeated rows; a second
workflow demonstrates the same session setup; synthetic expiry and isolation
checks pass. Until then the 95% confidence bar for a working
fix is not met.
