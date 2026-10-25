---
date: 2026-10-24
lane: P2 sizing (multi-hotel ce-plan)
model: GPT-6 Luna max (Sonnet slot)
method: read-only code read; no tests, prod or HMS
base: origin/main 1656bca50
---

# P2 — S4 pane config + S8 quote identity

**Verdict:** S4 splits cleanly into quote-fields and create-fields PRs; both depend on shared property registry/context first. S8 is independently sliceable after that contract settles.

**Evidence footing [V]:** read PRODUCT, ACTIVE, OWNER-ASKS, FACTS, research README/CATALOG, AGENT, requested plan/S1/A1; `origin/main=1656bca50`; `.codegraph/` absent; read-only only (no edits, tests, tsc, prod, or HMS).

## 1. Slice sizing [I]

| Slice | Modify (repo-relative) | Tests; new files; size/dependencies |
|---|---|---|
| **S4 quote fields** | `apps/server-pilot/src/trpc/routes/quote-workflow.ts`, `src/hms/rate-catalogue.ts`; `apps/mail/components/nava-pane/nava-pane.tsx`; `components/quote-workflow/{quote-workflow-panel,requirement-card,rate-controls}.tsx`; `lib/quote-workflow/{types,room-types,staff-quote-bind}.ts` | Change tests: `apps/server-pilot/tests/{quote-rate-catalogue,room-types-parity}.test.ts`; `apps/mail/tests/staff-quote-bind.test.ts`, `apps/mail/tests/{requirement-card,rate-controls}.test.tsx`. **140–220 product LOC + 100–160 test LOC.** Registry/context prerequisite; complete DV plan/board data also needs read-only HMS evidence/S6. |
| **S4 create fields** | `apps/server-pilot/src/ai/booking-draft.ts`, `src/trpc/routes/workstation.ts`; `apps/mail/lib/quote-workflow/types.ts`; `apps/mail/components/quote-workflow/booking-card.tsx` | Change tests: `apps/server-pilot/tests/booking-draft.test.ts`; `apps/mail/tests/booking-card.test.tsx`; add route contract coverage if none asserts active-mailbox options. **110–170 product LOC + 80–140 test LOC.** Registry/context prerequisite; DV create lists/requiredness need DOM evidence. |
| **S8 brand/PDF/workbook/reply** | `apps/server-pilot/src/quote-proposal/{filename,description,proposal-pdf,quote-workbook}.ts`, `src/trpc/routes/workstation.ts`; `apps/mail/lib/quote-proposal/copy.ts`; `apps/mail/components/nava-pane/nava-pane.tsx` | Change tests: `apps/server-pilot/tests/{quote-pdf-filename,quote-proposal-pdf,quote-workbook,quote-proposal-render}.test.ts`; `apps/mail/tests/{quote-proposal.test.ts,outlook-pane-quote-pdf.test.tsx}`. **120–200 product LOC + 80–140 test LOC.** Needs registry identity/copy fields and approved property brand data. |

**New runtime files:** none assumed in S4/S8 if Slice 1 supplies one validated registry/resolver + pane DTO. That registry is new foundation work (shape estimate 150–220 LOC); keep `HRFAKE`/no-fallback contract fixture in planned Slice 10, not duplicated per slice.

## 2. Property path and current list sources [V]

- Frontend active mailbox: `nava-pane.tsx:446` gets `useActiveConnection()`; `:575` stores `activeConnection.id` as `QuoteSelectionBinding.transportId`. Both Outlook `app/(routes)/outlook-pane/page.tsx:4-6` and webmail `components/nava-pane/web-pane-panel.tsx:34-37,72-78` render same `NavaPane`.
- tRPC mailbox scope: `apps/server-pilot/src/trpc/trpc.ts:4-17,108-118` reads `x-zero-active-transport`; `context.ts:37-71` resolves access and sets `ctx.activeTransportId`.
- Create options already use active mailbox server-side: `workstation.ts:923-980,993-1033,1143-1147` → `hmsReadTargetForTransport(ctx.activeTransportId)` → `createRequestFieldOptions` (`ai/booking-draft.ts:263-301`). That helper gives room codes from HRCEN/HRDAV profile, but source/track/guarantee from shared schema enums; it returns no required-fields metadata. `BookingDraftReady.options` only has four lists (`apps/mail/lib/quote-workflow/types.ts:713-720`).
- Quote lists do not: `quoteWorkflow.rateCatalogue` is `privateProcedure` returning `CENTURION_RATE_PLANS` (`routes/quote-workflow.ts:155-156`); `nava-pane.tsx:469-486` queries a route that ignores mailbox context and passes catalogue at `:2246-2249`. `requirement-card.tsx:340-344` imports CEN `ROOM_TYPE_CODES`; `rate-controls.tsx:123,128,863` hardcodes override codes/event hint; meal choices `requirement-card.tsx:192-209` are fixed canonical labels.
- **Smallest safe pass-through [I]:** Slice 1 adds one `mailboxProcedure` pane-config read; resolve `ctx.activeTransportId` to a registry entry server-side, return typed `PropertyPaneConfig`, and feed it from `NavaPane` to `QuoteWorkflowPanel`/`StayCard`/rate controls. Keep caller transport out of trust boundary. Extend create draft options with required-field metadata, or source from same DTO; stop local transport→hotel maps.
- **Additional quote bug [V]:** `staff-quote-bind.ts:42-44,422-445` defaults omitted `propertyCode` to CEN. Main/manual, auto, retry, and eligibility calls in `nava-pane.tsx:1404-1413,1588-1598,1618-1628,1757-1764` omit it. Quote PR must pass resolved registry/property context on every path, not only change displayed lists.

## 3. Split, current DV support, and test pins

- **S4 split: yes [I].** Quote PR seam = quote config/read + room/board/rate UI + every quote bind call. Create PR seam = `BookingDraftReady.options`/requiredness + `BookingCards`; it already receives property-specific options from workstation. Each stays below 500 product LOC (repo limit excludes tests). Land registry DTO first; `types.ts` and `nava-pane.tsx` overlap, so sequence those edits rather than parallel-editing shared files.
- Existing tests pin or consume current hotel values: `quote-rate-catalogue.test.ts:19-40` (CEN codes); `room-types-parity.test.ts:8-67` (CEN map/matcher); `staff-quote-bind.test.ts:27-100` (HRDAV vs CEN fallback, boards); `requirement-card.test.tsx:82-91` (fixed board labels); `booking-draft.test.ts:173-184` (HRCEN/HRDAV room lists); `booking-card.test.tsx:114-119,245-254` (sample create option values).
- Copy/PDF tests to revise for registry: `apps/mail/tests/quote-proposal.test.ts:19-56` (CEN room descriptions, two-hotel transport/copy, unknown→HRCEN); `apps/server-pilot/tests/quote-pdf-filename.test.ts:52+` (only HRCEN/HRDAV identity); `quote-proposal-pdf.test.ts:80-108` and `quote-workbook.test.ts:111-145` (DV removes Centurion brand elements, HRCEN retains them). `rate-controls.test.tsx` also exercises `NCOR1B`; add an exact registry-driven choice test.
- **Already DV-aware [V]:** `HRDAV.json` has 9 rooms, 5 observed rate plans, 9 sales strategies, `dinnerAddOn:false`; PDF identity/description and workbook handle HRDAV; reply helper recognizes five DV transports. **Not hotel-agnostic [V]:** HRDAV/ HRCEN are hardcoded pairs; no third-property data path.
- **HRCEN fallbacks [V]:** `quotePropertyCodeForTransport` unknown/empty→HRCEN (`copy.ts:11-16`); static quote catalogue; `createRequestFieldOptions` non-HRDAV→HRCEN; omitted `staff-quote-bind` property→CEN; legacy PDF builder/workbook default missing property to HRCEN (`proposal-pdf.ts:39-49`, `quote-workbook.ts:520`); legacy workstation PDF maps every non-DV transport to HRCEN (`workstation.ts:1633-1637`). Qualified revision PDF/workbook is safer: property comes from revision and unknown codes refuse (`quote-workbook.ts:95-107`; `proposal-pdf.ts:211,230`).
- **S8 existing DV limits [V]:** identity has name + “Sandton”, no telephone, website label, or approved letterhead (`filename.ts:29-38`); PDF/workbook strip Centurion branding rather than use DV logo. File names are generic, not property-branded. Mail reply name mapping is two-hotel-only and silently treats unknown property as Centurion.

## 4. Unproven DV values — read-only HMS evidence needed

- **Create source/track/guarantee:** global schema enums exist, but HRDAV profile has no property-specific lists or proof every enum is valid there. Read-only create-form DOM read should record selectable values and required markers; do not infer from schema alone.
- **Boards/rates:** HRDAV `boardCodes:[]`; only “Bed & Breakfast R/NR” labels observed, with NR and some BARRO boards unresolved. Five rate plans/nine strategies are observed, not proven exhaustive or entitled; use read-only HMS DOM/shop to capture exact strategy, plan, and board options. Live price completeness remains S6, not UI-list evidence.
- **Room list:** nine HRDAV profile codes derive from two D0 BAR reads; enough to replace CEN list provisionally, not proof of exhaustive selectable room types. Verify via read-only DOM if claim must be complete.
- **Branding:** no approved Da Vinci letterhead/logo, street address, or telephone source in inspected evidence. Need owner-approved brand assets/data; HMS DOM will not establish these.

**Status [V]:** no code changed; no tests/typecheck; no prod or HMS touched.
