---
name: building-hms-playwright-tools
description: Build or extend deterministic PMS Playwright readers, native preparation, writes and reconciliation, especially Infor HMS Stay 360. Use existing proven flows and current PMS behavior.
---

# Building deterministic PMS tools

Build the smallest native workflow that performs the owner's task and returns evidence another caller can use. Reuse current tools and discoveries before rebuilding. Let the PMS supply catalogue identity, editable controls, validation and calculations. Follow the owner's current scope and workspace authority; this skill does not authorize implementation, publishing or live writes on its own.

## Start from what exists

Read current project instructions and the relevant implementation, schema documentation and prior proof. Separate verified behavior, code-only capability, historical observation and unknown behavior. Preserve other sessions' work; use an isolated checkout for concurrent changes.

Inspect the live surface when existing evidence cannot answer a consequential question. Prefer headless Chromium, using screenshots or headed inspection when useful. Verify the available action and its side effects; an enabled control, catalogue entry or reader field does not prove a supported write. Missing packages, browsers or login are setup failures, not PMS results.

For Zero module locations and established capability limits, read [references/existing-tools.md](references/existing-tools.md) when choosing what to reuse. For a relevant native behavior or pitfall, consult [references/native-observations.md](references/native-observations.md). Do not load every historical observation for an unrelated task.

## Design a small, composable contract

Expose useful reads and native actions separately where callers need them: lookup/list, read detail, prepare without saving, approved Save, and independent reconciliation. Compose these through an owning session when page state must persist. Keep helpers shared internally; avoid per-catalogue-item tools, parallel implementations or a general workflow framework without a demonstrated need.

Use explicit business inputs and structured JSON results:

- Return current codes, names, native IDs, distinguishing fields and coverage so an agent or human can choose explicitly. A catalogue item ID identifies a type; a saved row ID identifies the particular record to change. A name or matching value is not identity.
- Keep browser objects, native request bodies and authorization callbacks out of the JSON interface. The trusted host supplies authority, property configuration and ownership; caller-provided booleans or tokens do not grant write permission.
- Require the target and requested operation. Reject unsupported or contradictory fields instead of silently ignoring them. Return choices for ambiguity, `needs_input` for missing decisions, and `unsupported` for unproven capabilities.
- Return effective fields, editable/required controls, native options, calculated values and validation in preparation. A prepared ID binds an immutable target, operation, before-state and approved after-state to its originating session; it is not authorization.
- Distinguish omitted, explicit blank, explicit zero/false and unknown. For inserts, omissions may use verified native defaults. For edits, omissions preserve the existing value. Never infer a commercial default such as a free price or a quantity of one from missing information.
- Preserve decimal values without introducing floating-point pricing maths. Treat arrival, departure and service dates as calendar days; avoid local-time-to-UTC shifts.

Preserve existing public contracts when extending a working tool. Introduce a new operation discriminator or narrowly scoped function only when it makes the contract clearer. Do not silently widen an insert tool into permission to update or delete.

## Stage and approve native behavior

Verify the property, reservation/record identity, selected row and native action. Resolve current catalogue identities through the existing lookup; resolve existing records by their verified row IDs. Read detail after row selection when the native form depends on it.

Apply requested controls in the native order and let the PMS recalculate. After all dependent changes settle, compare every requested field with the final form, then return the full effective result for approval. A later recalculation can undo an earlier value. Preserve untouched edit fields unless the PMS explicitly changes a dependent value, which must be included in the preview.

Immediately before dispatch, run writes to the same reservation/record one at a time and obtain a fresh, complete relevant before-state. Compare it with the approved preparation and refuse a stale target or changed record. Re-stage/recalculate and compare the approved values again. An earlier preview is not the dispatch baseline; serialization in one process does not coordinate other processes or staff editing directly in the PMS.

Use only the native operation whose semantics have been established. Editing is not delete-and-recreate; removal is not quantity zero unless native behavior proves that is the intended action. Posted charges, cancellation penalties and bundle side effects require their own evidence, not a local accounting engine.

## Bind the write without pinning the whole form

Keep a page-owned guard active for the session lifetime. Initialize shared state synchronously before the first await so concurrent first calls cannot install independent authority. Serialize actions on one page and writes to the same record; reads may use separate sessions under project rules. Block service workers when relying on Playwright routing.

Permit only a correlated request matching the method, origin, endpoint, property, record identity, operation and approved business values. Validate conflicting action or identity values in both query and body when native HMS uses both. Enforce the intended insert/update/remove identity: a blank/new key must not update a saved row, and an existing key must not become a new insert. Allow unrelated form-field drift; do not pin complete request bodies, field counts or key sets.

An unsaved field change or picker selection can issue a server POST. Classify and guard those actions explicitly instead of assuming everything before Save is local. Later Playwright routes must preserve earlier fences with `route.fallback()` rather than bypassing them with `route.continue()`. Scope retained guards to their owning page and fail closed when ownership is unknown.

Check current authority and known form state before triggering the action, then match the paused request synchronously. Reading the page from a paused handler can deadlock while the PMS awaits that request. Approve only a positively identified native prompt with the decision required by the current owner/workspace rules; an unexpected dialog is not an invitation to click through.

## Wait for business evidence and drain late work

Register response listeners before the action and correlate the exact request. Use bounded waits for the required condition: matching response, ready form, cleared native Ajax/masks, expected dialog or verified readback. Bound response-body reads as well as response headers. Fixed sleeps, `networkidle` and HTTP 200 alone do not prove completion; a 200 can contain a login page or native validation error.

A timeout revokes pending authority but does not cancel a request already sent. Quarantine the page, preserve guards and dialog tracking, and recheck quarantine/authority immediately before forwarding a paused request. Drain any running dispatch callbacks before releasing record ownership or shutting down. The host owns callback deadlines; a timed-out UI wait must not let its still-running callback outlive ownership.

## Verify persistence and attribute the attempt

Record possible dispatch before consuming its response. Preserve the operation, phase, requested values, before-state, known ID, receipts and uncertainty even if response parsing fails. Reconcile an uncertain result before retrying; changing an attempt ID must not bypass an unresolved logical intent.

Independently reopen the intended native record and compare all supported effective fields, including explicit blanks and flags. Capture identity from the response or a verified native grid; Submit may clear the form instead of retaining the saved ID.

Use evidence appropriate to the operation:

- **Insert:** if the response ID is lost, recover only an unambiguous new identity outside a complete fresh dispatch baseline, then compare its full detail. Matching an earlier or another session's row does not attribute this insert.
- **Edit:** read the same native row identity and compare the approved final fields, including fields that should remain unchanged. Distinguish an observed desired state from proof of this attempt when dispatch attribution is incomplete.
- **Remove:** verify the native terminal state or absence under a complete relevant read, using the semantics established for that operation. A missing row in a stale/capped grid does not prove removal, reversal or cleared charges. An already absent row is not proof this attempt removed it.

For dynamic grids, correlate the current response and rows and report loaded/total/completeness. Resolve conflicting counts rather than treating a store total of zero as empty. Prefer an exact-ID lookup when it can establish the required scope; fetch all pages only when the task needs a complete census.

Sequential writes are not atomic. Preserve a result for each attempted item, identify partial completion, stop after an uncertain write and reconcile before retrying. Do not blindly replay a batch, or promise rollback the native system does not provide.

## Prove the requested scope and capture useful lessons

Follow the workspace's permitted proof and release checks. Reuse existing focused checks; do not create tests, plans, release rituals or approval gates contrary to the owner's request. Where authorized, verify unsaved preparation and one owned fake write with independent readback. Select meaningful additional safety probes from the actual risks: stale previews, duplicate-looking rows, slow/lost responses, callbacks completing late, native prompts, partial persistence and replay.

Report what worked and what remains unverified. Reader metadata does not prove stored bytes; a calculated price does not prove inventory; a cancellation status does not prove no fee. Report backend proof, integration, merge and production enablement as separate facts.

After material building work, briefly discuss the useful decisions, failures and fixes. Update this skill for reusable principles and the relevant reference for concrete examples or module coverage. Preserve current authority, concurrent changes and existing metadata; avoid turning a property-specific probe into a universal requirement. The older [references/traps.md](references/traps.md) is historical evidence, not current model-routing or authorization policy.
