---
title: Finish raw HMS guest profile creation
date: 2026-11-05
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Finish raw HMS guest profile creation

> Historical plan: the Labtest-only creator and expanded reader were merged in
> [PR #1051](https://github.com/kufupa/Zero/pull/1051). The scope and authority
> statements below describe the original request. Additional profile fields and
> real-guest creation remain separate future work.

## Goal Capsule

Finish the existing HRCEN profile creation tool so a trusted caller can prepare, create and independently verify a new profile, with useful recovery after a failure.
The owner selected separate lookup and creation, restricted this work to raw tools, and approved the preceding implementation outline.
The original request authorized planning only; implementation and merge were authorized later.

- Owner: implementing agent in this chat; no delegated agents.
- Scope: guest profile creation, its exact-ID reader, a concrete Labtest caller adapter and focused verification.
- Completion: working raw tools and adapter, complete supported-field readback, verified duplicate handling, durable attempt recovery and focused checks.
- Authority: latest owner scope wins over earlier plans and PRODUCT.md's deferred automatic-profile UI scope; real-guest Saves remain restricted to a future trusted staff integration.
- Stop conditions during implementation: uncertain dispatch or ambiguous persistence requires reconciliation, not a new Save; preserve other sessions' work.

---

## Product Contract

### Summary

Keep the existing guest lookup and selection tools.
Finish three profile operations: `readGuestProfile`, `prepareGuestProfile` and `createGuestProfile`.
The caller decides whether the person already exists; creation does not search again or require a lookup token.
Prepare stages an unsaved native form; Create restages approved inputs, saves and reopens the returned profile ID in a fresh session.

### Requirements

- R1. Lookup remains separate and unchanged; duplicate names never select an existing person implicitly.
- R2. Prepare verifies the native New form, requested fields, native validation, active status, consent off and an available Save control without dispatching a Save.
- R3. Create binds the prepared business values and duplicate-name decision to a trusted approval and a durable, single-attempt claim before native dispatch.
- R4. Creation waits for actual response, handler completion and native dialog state rather than fixed delays.
- R5. Success requires fresh exact-ID readback of every supported field, including intentionally blank email, ACTIVE status and the consent controls verified during staging.
- R6. Every post-dispatch failure preserves the attempt ID, phase, dispatch state and any known returned native ID.
- R7. A repeat of a completed attempt returns the recorded result; a repeat of an unresolved attempt cannot Save again, including after a process restart.
- R8. Only the observed duplicate-name prompt permits the confirmation step, and only when the reviewed decision explicitly allows it.
- R9. A concrete Labtest-only adapter owns authorization callbacks and private durable attempt storage; caller JSON cannot supply authorization functions or an authorization boolean.
- R10. Verification reuses existing browser steps and the existing lookup for proof; it covers successful creation, duplicate refusal/acceptance and uncertain-write recovery.

### Supported contract

The trusted adapter exposes the same three operation names; factory/configuration functions are infrastructure, not additional HMS tools.

| Operation | Required business input | Optional business input | Result |
|---|---|---|---|
| `readGuestProfile` | `nativeId`: numeric string | `propertyCode`: HRCEN | Read profile with explicit values/coverage, or structured input/unavailable result |
| `prepareGuestProfile` | `guest.firstName`, `guest.lastName`, `guest.mobile`: nonblank strings | `guest.email`; HRCEN property; `confirmDuplicateName` default false | `ready`, normalized fields, preview digest and native validation evidence; otherwise structured failure |
| `createGuestProfile` | Same guest fields; `expectedPreviewDigest`; stable `attemptId` bound by the trusted adapter | Same email/property/duplicate decision | `created` with native ID and fresh readback, `confirmation_required`, `not_dispatched`, `uncertain` or preparation failure |

Keep existing name/mobile limits until native evidence requires a change.
Omitted email has the explicit meaning blank, not unknown.
The preview digest binds business values and the duplicate decision; it is a consistency check, not proof that staff approved or that Prepare ran.
Authorization and the stable attempt identity come from the trusted runtime, not the digest alone.
The low-level browser module may retain internal callback injection for composition and verification; the supplied adapter hides those callbacks from ordinary tool callers.

### Acceptance examples

- AE1. The caller finds an existing person with the existing lookup and uses explicit selection; no creation operation or extra search runs.
- AE2. Prepare returns ready with an intentionally blank email; Create returns created only after a fresh read verifies that blank and all other supported values.
- AE3. HMS returns the known duplicate-name question with confirmation disabled; the tool does not press Yes and returns confirmation_required with its attempt state.
- AE4. The reviewed decision allows the known question; the same attempt permits its confirmation phase once and verifies exactly one created profile.
- AE5. HMS returns a profile ID but readback fails; the tool records that ID and returns uncertain. A later read can reconcile it without another Save.
- AE6. A process stops after claiming or dispatching; another process finds the durable attempt and refuses to create again. Lost response attribution remains unresolved.

### Scope boundaries

No add-on work, existing-profile amendment, pane/route/worker integration, booking ledger migration, new guest search engine, additional profile fields, PR or deployment is included.
This plan completes a raw tool workflow; it does not claim the staff-facing pilot workflow is deployed or enabled.

Deferred TODO: replace fixed waits with response/form/dialog completion checks across the other HMS tools.
Record and prioritize that sweep later; only waits inside this profile workflow are changed here.

---

## Planning Contract

### Decisions and evidence

- KTD1. Reuse the current staging, guarded Save and exact-ID reader in [guest-profile-create.mjs](../../apps/server-pilot/tooling/hms-cloud/guest-profile-create.mjs). The previous Labtest confirmed Save and fresh readback; that is historical evidence, not final-head verification. Keep the three operation names and factor their shared staging into a private helper so Prepare does not contain hidden commit branching.
- KTD2. Keep [guest-profile.mjs](../../apps/server-pilot/tooling/hms-cloud/guest-profile.mjs) unchanged. It already supports separate first-name, surname, email, phone and ID searches and explicit selection. Creation does not need another lookup implementation.
- KTD3. Replace this workflow's fixed waits with bounded promises for native initialization, each authorized response, completed dispatch callbacks and the exact duplicate dialog. Preserve the dedicated guarded context and page-lifetime request fences. Do not remove a guard while a late handler can still run.
- KTD4. Use a small `guest-profile-runner.mjs` adapter for the requested standalone raw-tool use. The existing [hms-labtest-dispatch.ts](../../apps/server-pilot/src/ai/hms-labtest-dispatch.ts) requires reservation operations, existing guest IDs and confirmation-shaped resolution; extending it now would pull unrelated booking integration into this scope. Reuse its write-ahead claim/reconciliation pattern, not its incompatible reservation schema.
- KTD5. The supplied adapter stores a profile-specific attempt journal under a configured private runtime directory outside Git. Use Node filesystem primitives, an exclusive initial claim and synchronized write-ahead records. No new service, database migration, generic ledger framework or property-lock replacement. This provides restart/replay protection on the host sharing that directory; it is not distributed exactly-once delivery.
- KTD6. Bind the trusted Labtest approval to the stable attempt ID, reviewed preview and Proof Labtest fields. Claim before dispatch; record the response and known ID before releasing the intercepted response to the browser. Reject changed input for an existing attempt and refuse automatic Save replay. A new arbitrary ID cannot substitute for reconciling an earlier uncertain attempt.
- KTD7. Recognize only the existing native duplicate-name response and verify the visible dialog before Yes. A declined confirmation is a recorded result. Starting a later confirmed attempt requires explicit new review and evidence that the preceding attempt did not create a profile; do not automatically change the decision or reopen Save. If the native no-create behavior cannot be established, retain uncertainty.
- KTD8. Read and normalize the supported consent values from the native master response, preserving absent/unreadable values as unknown. Do not invent false for missing evidence. Match relevant values and native identities without pinning the entire request field set or count.

### Durable attempt behavior

Store reviewed input/digest, attempt ID, phase, dispatch state, recognized response kind, returned native ID and verification result.
Maintain an exclusive intent claim keyed by the HRCEN property and normalized supported guest values, excluding the duplicate-confirmation decision.
While that intent has an unresolved attempt, changing the attempt ID or duplicate decision cannot bypass the hold.
This groups repeated execution of the same create request; it does not assert that matching guest values identify one person.
Only an explicitly reviewed subsequent attempt after reconciliation may replace a resolved no-create intent.
Use opaque filenames, private directory permissions and private record permissions; store no credentials or token-bearing URLs.
Synchronize the claim and each pre-dispatch phase record before the network request; synchronize response/ID records before proceeding to readback.
A failed or ambiguous journal write never grants permission to continue.
Concurrent claims of the same attempt permit at most one owner.
An incomplete/corrupt journal remains an unresolved hold rather than being overwritten or removed by timeout.
Keep native writes serialized through the existing session/host ownership mechanisms; an attempt journal does not attest ownership of a browser or property lock.

Known ID: reopen that exact ID and compare the recorded approved values; resolve only with positive evidence.
Unknown ID: report reconciliation_required and use the existing lookup/manual review to gather evidence; matching names alone cannot attribute creation to this attempt.
No recovery path dispatches Save automatically.

### Sequence

U1 finishes the native operation and readback contract.
U2 supplies durable execution around that operation.
U3 verifies the assembled workflow and updates the existing tool documentation.
All units belong to the implementing agent in this chat and run sequentially; shared runtime writes remain serialized.
Completion time and changed-line estimates are unmeasured; no numeric estimate is asserted.

---

## Implementation Units

### U1. Finish native preparation, creation and exact-ID verification

- Owner: implementing agent in this chat.
- Goal: complete the three-operation browser contract without duplicating lookup.
- Requirements: R1, R2, R4, R5, R6, R8.
- Dependencies: existing module and guarded Centurion bootstrap; no new upstream work.
- Files: `apps/server-pilot/tooling/hms-cloud/guest-profile-create.mjs`; focused `guest-profile-create.test.mjs` if needed for the behavioral cases below.
- Approach: extract a private staging helper; check Save availability during Prepare; replace native-New and Save delays with bounded completion checks; preserve phase/dispatch/ID evidence through every error; extend master readback to supported consent values and intentional email blanks; report unknown evidence honestly.
- Patterns to follow: existing `prepareGuardedContext`, dedicated `withCenturionStay360Page` lifecycle, strict matching of approved business fields and recognized native prompt. Allow unrelated native form drift.
- Test scenarios: no Save during Prepare; slow response completes successfully; a timed-out late handler cannot gain new authorization; denied confirmation cannot send Yes; changed critical fields/consent are refused; blank-email or consent mismatch prevents created; known ID survives a readback/cleanup failure.
- Verification: syntax checks, focused behavioral checks, private read-only probe of native consent representation and real-email unsaved staging. No real-guest Save.

### U2. Supply the trusted durable Labtest adapter

- Owner: implementing agent in this chat.
- Goal: ordinary raw-tool callers use the three operations without implementing callback plumbing or losing recovery evidence.
- Requirements: R3, R6, R7, R8, R9.
- Dependencies: U1's structured phase/response/ID contract.
- Files: new `apps/server-pilot/tooling/hms-cloud/guest-profile-runner.mjs`; focused `guest-profile-runner.test.mjs`; internal callback extension in `guest-profile-create.mjs` where needed.
- Approach: expose the three methods from a configured trusted runner; reject caller authority fields; default writes to explicit Proof Labtest execution; bind reviewed values and attempt ID; persist exclusive intent/attempt claims and dispatch/response/result records; cache completed outcomes; keep uncertain attempts held and offer fresh-ID read reconciliation through the existing read operation. Strip adapter-only attempt metadata before calling the low-level browser input parser.
- Patterns to follow: write-ahead claim and independent reconciliation from `hms-labtest-dispatch.ts`; existing private runtime storage and browser lifecycle conventions. Keep the implementation specific to this profile workflow.
- Test scenarios: two concurrent callers get one dispatch owner; restart after claim/dispatch does not resave; changed input for the same attempt is refused; a new ID for an unresolved equivalent intent cannot bypass its hold; a completed attempt returns its prior result; persistence failure prevents dispatch; known ID is durably available before readback; malformed journals fail closed; real guest input and JSON authorization flags cannot enable a Labtest Save.
- Verification: use a temporary local directory and simulated browser/dispatch dependencies for restart and concurrency checks; no database or real HMS mutation in local tests.

### U3. Prove the final raw workflow and document the contract

- Owner: implementing agent in this chat.
- Goal: prove the assembled runner and browser operations and give callers exact schemas and recovery behavior.
- Requirements: R1-R10.
- Dependencies: U1 and U2 complete.
- Files: existing `apps/server-pilot/tooling/hms-cloud/guest-profile-create.md`; the two profile modules and focused checks if valid findings require changes.
- Approach: update examples to use the supplied runner; list required/optional fields and every outcome; prove native duplicate refusal with independent before/after lookup evidence where coverage permits; run a serialized fake Proof Labtest Save with explicit duplicate approval and complete fresh readback; reopen the durable result after a runner restart.
- Patterns to follow: existing lookup for proof, private runtime evidence, HMS-derived values, and fresh sessions after uncertain actions. Do not turn proof searches into mandatory production creation logic.
- Test scenarios: current final head stages a real email without Save; denied duplicate confirmation creates no profile when independently verifiable; explicit confirmation creates one profile; full readback including blanks/consent matches; repeating the completed attempt emits no Save.
- Verification: focused checks below and required final-head review. Dispose only processes and throwaway files started by this work; preserve existing private holds and other sessions' files.

---

## Verification Contract

The owner explicitly requested testing and prototyping in this conversation; add only focused behavioral regression checks for external-write correctness and durable restart behavior.
Before any test process, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL`.
Use at most three concurrent test runs across harnesses and preserve the required host headroom.

```bash
node --check apps/server-pilot/tooling/hms-cloud/guest-profile-create.mjs
node --check apps/server-pilot/tooling/hms-cloud/guest-profile-runner.mjs
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL
node --test apps/server-pilot/tooling/hms-cloud/guest-profile-create.test.mjs apps/server-pilot/tooling/hms-cloud/guest-profile-runner.test.mjs
```

The runner and test paths above were planned when this document was written; they landed in PR #1051.
Run required final-head Greptile Apex review; use another available reviewer if it fails/stalls, without spawning agents unless separately authorized.
No local TypeScript check applies to this `.mjs`-only scope; if valid implementation changes touch TypeScript, use the approved remote typecheck on a clean final head.
No broad lint, repo-wide tests, PR, merge, deployment or pane flag changes are part of this plan.
A live result from this worktree is raw-tool evidence; deployment/main proof remains necessary for any future staff-facing rollout.

---

## Definition of Done

- Existing guest search and explicit selection remain separate from creation.
- Prepare checks supported native inputs and never Saves.
- Create uses a concrete trusted Labtest adapter and a durable attempt claim, rather than undocumented caller callbacks.
- Profile-specific fixed waits are replaced by bounded completion checks.
- Created means a returned ID plus fresh independent readback of every supported value, including blank email and consent off.
- Duplicate acceptance/refusal behavior is verified or explicitly reported as unresolved; unresolved required proof prevents claiming completion.
- Every uncertain result retains recovery evidence; restart and repeat calls cannot automatically resave the same attempt.
- Focused checks and final-head review pass; one final-head Labtest creation has a full fresh readback.
- Existing tool documentation matches the final contract; abandoned prototypes are removed; other sessions' lookup/add-on changes and prior private holds remain intact.
- The deferred sweep of fixed waits across other tools remains recorded in this plan and is not executed here.
