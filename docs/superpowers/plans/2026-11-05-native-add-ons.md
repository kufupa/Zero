# Native Add-Ons Implementation Plan

**Goal:** Provide composable deterministic HRCEN tools to list catalogue options, read reservation Add-Ons, prepare native calculated Add-Ons, and save with independent readback.

**Architecture:** One generic native form workflow handles all Non-Room Items. Callers supply current item codes and requested business fields; HMS supplies descriptions, editable controls, defaults and calculations. Preview and save remain separate, with a page-bound prepared snapshot and explicit authorization for real guests.

**Execution:** Inline in this chat. The owner requested planning followed immediately by implementation. Use the isolated `feat/native-add-ons-20261105` checkout. Preserve the other session's guest-profile files and startup change.

## Constraints

- Follow PRODUCT.md: real guests may be read or staged; agent saves use Proof Labtest with 2027+ arrival and CMS off.
- Validate reservation/property identity, action and business values; do not pin complete native bodies, field-key sets or counts.
- No new tests. Use existing focused checks, native unsaved verification, and an owned Labtest save plus fresh-session readback.
- Never blindly retry an uncertain save. Return a reconciliation outcome and stop that session.
- Keep prices as decimal strings and dates as calendar dates. Preserve HMS rules instead of building pricing maths.

## Implementation

- [x] Repair blank Guest Stay readiness in `hms-cloud/lookup.mjs`: use HMS Ajax completion, visible mask disappearance and blank native form readiness, retaining existing property and dialog checks. Verify guest lookup and native Add-On entry on an unsaved new stay.
- [x] Discover native Add-On list refresh, catalogue coverage, editable dropdown codes, item calculation and Submit behavior using guarded unsaved sessions. Establish a fresh owned Labtest reservation before any Add-On save.
- [x] Replace the prototype with `stay360-addons.mjs`: `readStay360AddOns(page, confirmation)`, `listStay360AddOnItems(page, confirmation)`, `prepareStay360AddOns(page, confirmation, items)` and `saveStay360AddOns(page, confirmation, preparedId, options)`. Return structured outcomes and normalized business values alongside native controls and coverage. The throwaway selection helper is replaced by explicit generic prepare/save.
- [x] Add a JSON/session runner in `stay360-addons-session.mjs` to compose lookup, catalogue, read, prepare and save on one owned page. Resolve item IDs internally from explicit codes. Default writes to verified Labtest; trusted host callbacks own real-guest approval and durable dispatch.
- [x] Verify one owned Labtest Add-On save, then reopen in a fresh browser and compare native row identity, dates, quantity, price, frequency and pricing control. A two-item batch also passed automatic fresh readback. HMS requires a saved confirmation first; booking and Add-On results stay separate.
- [x] Run syntax and existing focused checks for changed helpers, inspect the final diff, and update the existing tool documentation with exact input/output schemas and verified limits.

## Public input contract

`items` is a nonempty array of objects with required `code`; optional `quantity`, `startDate`, `endDate`, `unitPrice`, `frequency`, `pricingControl`, `folio` and `comment`. Omitted fields use verified HMS defaults. Explicit unsupported fields and missing mandatory prices return `needs_input` or `unsupported`; they are never silently discarded. Save consumes the exact page-bound prepared ID after validating the current target and approved values.

The session runner accepts `read`, `list`, `prepare`, `save` and `reconcile` operations. It owns the Playwright page so callers never pass browser objects through JSON. Readback is authoritative only when the correlated native grid contains the saved rows.
