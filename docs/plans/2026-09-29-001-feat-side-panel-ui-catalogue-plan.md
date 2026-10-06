---
title: "Side Panel UI Catalogue - Plan"
type: feat
date: 2026-09-29
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
plan_depth: standard
---

# Side Panel UI Catalogue - Plan

## Goal Capsule

- **Objective:** Add a Side Panel UI destination to the authenticated production dashboard that presents the real Outlook pane screens beside concise descriptions of what each flow does, why it exists, what kind of preview it is, and its separately verified rollout state.
- **Authority:** The user-approved production-dashboard scope; merged Zero source at `9221c1700`; and `apps/server-pilot/deploy/outlook-v4-security-release-runbook.md` for security-release and deployment claims.
- **Stop when:** The catalogue is reachable independently of dashboard metrics, shares presentation components with `/outlook-pane`, previews only synthetic local state, and passes the UI test/build gates below. Do not deploy to the pilot or claim v4 is available to staff as part of this work.
- **Tail ownership:** This plan covers application code and verification. The v4 production cutover and any hosted release remain separately approved operational work.

---

## Product Contract

### Summary

Add a curated, navigable Side Panel UI catalogue to the production dashboard. Each selection shows the pane UI on the right and client-readable context on the left, with separate facts for existing UI, sample behavior, future concepts, and rollout state.

### Problem Frame

The merged v4 security work adds visible states around sign-in, add-in version, device pairing, and approved Outlook folders, but the existing onboarding sequence and narrow pane remain in the same large page component. The standalone design pages are not an integrated product catalogue, and the 65-artboard index is too sprawling for the intended dashboard.

The v4 changes are merged but the pilot server and staff PCs have not completed the supervised cutover. A page that says “shipped” or “connected” based only on merged code would overstate what staff can use. The catalogue must show what the preview represents separately from web deployment and Outlook-PC rollout.

The current Admin Dashboard displays “Dashboard unavailable” when its aggregate metrics query fails. That branch does not explain the underlying service failure. Side Panel UI must be a sibling destination so a metrics error cannot hide it; diagnosing that metrics failure is not part of this plan.

The old design demo contains connected/live claims and sample-looking guest, rate, and contact details. Treat it as visual reference only; do not reuse its data or embed the live Outlook pane.

### Actors

- A1. Signed-in hotel staff member exploring the production dashboard or presenting it to a client. Client review is staff-led; no independent client account or new access model is assumed.
- A2. Nava product/operations maintainer curating screen descriptions and implementation status.

### Key Flows

- F1. A1 opens Side Panel UI from the existing settings/admin navigation, lands on Welcome by default, chooses a named flow or state, and sees the narrow pane preview beside its “what / why / status” explanation.
- F2. A1 clicks a preview control; it produces an explicit synthetic outcome (such as sample availability results or a non-persisted draft preview) and cannot sign in, access Outlook, create a real draft, send or delete mail, or move a message.
- F3. A2 updates the catalogue registry when a screen becomes implemented or a separately verified rollout changes its status; code merge alone never marks a feature pilot-verified.

### Requirements

#### Navigation and access

- R1. Add a `Side Panel UI` destination at `/settings/side-panel-ui`, adjacent to the existing Admin Dashboard in the signed-in settings navigation, and make it available in both Nava Admin and Nava Legacy through the shared application.
- R2. Keep this destination independent of the Admin Dashboard metrics query so it renders when the metrics page reports “Dashboard unavailable”; do not change the existing metrics error or stale-data behavior.
- R3. Follow the production dashboard’s current signed-in access model for this MVP. This page is not an operator-only developer dashboard, and it must not be labelled “admin-only.”

#### Faithful, inert preview

- R4. Render the same pane presentation components used by `/outlook-pane` so pane UI changes flow into the catalogue without maintaining a second screenshot or copied implementation.
- R5. Keep live session, bridge, mail, and mutation logic in the production pane wrapper; the catalogue uses local synthetic fixtures and presentation-only callbacks.
- R6. Do not iframe or mount the live `/outlook-pane` in the catalogue. Preview interactions must not post native bridge messages, request Outlook tickets, invoke workstation/mail APIs, submit real credentials, or write onboarding completion to shared browser storage.
- R7. Use obviously synthetic mail and hotel data, and make the preview state visible. Pairing codes, real mailbox contents, guest PII, native dialog contents, and production screenshots must never enter the catalogue fixtures.

#### Screen inventory and status honesty

- R8. Include the current pane path—Welcome, Connection, the three-slide Tour, and Quote Tool—plus v4 sign-in/re-login, old-add-in update-required, device-pairing, and approved-folder authorization states.
- R9. Show the quote/reply lifecycle honestly: the availability search is sample-backed, the reply/PDF draft can create a real Outlook draft in the live pane, staff send manually in Outlook, and an uncertain result requires checking Drafts before retrying.
- R10. Show v4 native batch-move confirmation only as a labelled Windows-dialog preview or planned pane flow; the current pane does not expose a bulk-move UI. Do not add native Send/Delete controls. Existing web-mail Send/Delete are outside this pane scope and remain unchanged.
- R11. Correct pane copy that conflicts with the merged behavior: “sign in once,” “Detected Outlook Account” for the active Nava mailbox connection, and claims of live HMS availability/actions where the current screen uses sample data. Keep copy hotel-facing rather than developer-oriented.
- R12. Curate the existing Flow C concepts as clearly marked future screens rather than copying the old 65-artboard index wholesale. The 11 boards in the Flow C design spec are the bounded concept seed for this MVP.
- R13. Represent preview type and rollout as separate facts: preview type is `Existing pane UI`, `Sample only`, or `Concept`; rollout is `Deployment not verified`, `Merged — rollout pending`, `Web deployed — Outlook rollout pending`, or `Pilot verified` when applicable. Concepts are `Not built`; sample-only screens must not imply live behavior. Each manually curated rollout state records a last-reviewed date and concise evidence/source note, without exposing staff, mailbox, or device identifiers. Only mark a capability pilot-verified after the supervised evidence required by the release runbook exists.
- R14. Select `Welcome` on first load. If a selected registry ID is missing, return to `Welcome`; if the registry is empty, show a clear “No screens available” state instead of a blank preview. The catalogue is a synchronous local registry, so it has no loading state.
- R15. Give every enabled preview control a defined local result: sample search displays synthetic rates, quote selection updates the synthetic quote, draft/PDF shows an unsaved sample preview, and pairing and move consent show explanatory synthetic dialogs. Do not render a native Send control; explanatory copy may state that staff manually send the created draft in Outlook. No preview action performs or persists a production operation; controls without a useful local result are disabled with an explanation.
- R16. Make screen selection keyboard and screen-reader usable: use a labelled navigation list of native buttons, visibly indicate the selected screen and focus, and announce the selected screen title and status when selection changes. Keep the selected preview operable at narrow viewport widths.

### Acceptance Examples

| ID | Given / When | Then | Covers |
|---|---|---|---|
| AE1 | A signed-in user opens `/settings/side-panel-ui` while the metrics query is failing | Side Panel UI renders and the Admin Dashboard metrics error behavior is unchanged | R1, R2 |
| AE2 | A user selects the v4 pairing state in the catalogue | The preview explains that a supervised Windows-only dialog handles pairing; it shows no code-entry form and opens no native dialog | R5, R6, R8 |
| AE3 | A user clicks every visible control in the preview | Only local presentation state changes; bridge, ticket, sign-in, mail, PDF, draft, send/delete, and move spies remain untouched | R5, R6, R7 |
| AE4 | A user views the quote/reply flow | Sample rates are labelled as sample; a draft is distinct from sending; manual Outlook Send and the conditional shared-mailbox Drafts limitation are clear | R9, R11 |
| AE5 | The merged v4 source is present but the runbook says the server and staff PCs are not yet rolled out | v4 states show their preview type separately from `Merged — rollout pending`, with a review date; they are not labelled `Web deployed` or `Pilot verified` | R13 |
| AE6 | A user opens the catalogue or a previously selected registry ID is no longer present | Welcome is selected, or an explicit empty state is shown if the registry has no entries; no blank preview or loading spinner appears | R14 |
| AE7 | A keyboard or screen-reader user changes the selected flow and activates its preview controls | Focus and selected state are visible, the new screen title/status are announced, and each enabled control shows its defined synthetic result without calling production integrations | R15, R16 |
| AE8 | A user views the catalogue below 380px viewport width | The page itself has no unintended horizontal overflow; the preview retains its Outlook width inside a horizontally scrollable preview frame, and its controls remain reachable | R16 |
| AE9 | A reviewer unfamiliar with the catalogue completes a short staff-led walkthrough | They can find onboarding, identify quoting as sample-backed, and explain that the live pane creates a draft for manual Outlook Send; note any confusing label and fix it before client presentation | R8, R9, R11, R13 |

### Scope Boundaries

#### Deferred for later

- The developer dashboard, internal-only authorization model, trace history, and screenshot/run-log viewer.
- A bulk-move pane workflow, live guest lookup, folios, reservation creation or amendment, and live HMS availability.
- Dynamic release/device-enrollment status ingestion; this MVP uses a curated source registry and must be updated when rollout evidence changes.
- Production deployment of the v4 security release, native add-in installation, device enrollment, and target-PC acceptance testing.

#### Outside this plan

- Root-cause diagnosis or repair of the current Admin Dashboard metrics request failure. This plan only keeps the new route reachable when that failure occurs.
- Changes to web-mail Send/Delete, generic web-mail CSP, or the separate web-mail HTML/XSS follow-up.
- Rebuilding all 65 screens from the old decision-matrix page or claiming every hypothetical future feature is implemented.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Use a sibling settings route, not a section nested inside the metrics page.** The Admin Dashboard can return its error state before rendering dashboard content; a sibling route preserves access without coupling this UI catalogue to metrics availability.
- KTD2. **Share presentation components; do not embed the live pane.** `/outlook-pane` owns the native bridge, server authorization, real sign-in, and draft side effects. A pure presentation boundary allows both the production wrapper and fixture preview to render the same UI without granting the dashboard a bridge path.
- KTD3. **Keep preview actions local and data synthetic.** Backend fixture/transport modes are not a presentation-only safety boundary. A local fixture adapter avoids mail writes, bridge messages, credential capture, and test-data persistence.
- KTD4. **Separate preview type from rollout state.** `Existing pane UI`, `Sample only`, and `Concept` describe what the preview represents; rollout labels describe release evidence. “Merged” never means deployed or enrolled. The v4 rollout label starts at `Merged — rollout pending`.
- KTD5. **Reuse the current production dashboard session policy.** The catalogue is part of the production-facing dashboard and the developer dashboard is deferred. Do not add an operator allowlist to this MVP. The Legacy Outlook pane’s 24-hour staff session and the Remote Admin host’s 12-hour session remain separate existing policies.
- KTD6. **Do not ship the catalogue as an isolated production release.** The shared SPA release also carries the merged v4 pane/bridge and pane-CSP changes; any production publication from this source must follow the v4 runbook’s approved cutover gates. This plan neither deploys v4 nor creates a rollback to the old unrestricted bridge.

### High-Level Technical Design

```mermaid
flowchart LR
  A[Settings navigation] --> B[/settings/side-panel-ui]
  B --> C[Catalog registry + local fixtures]
  C --> D[Shared pane presentation]
  E[/outlook-pane runtime wrapper] --> F[Session + v4 bridge + live actions]
  F --> D
  C -. no bridge, no mail APIs, no writes .-> G[Preview-only interactions]
```

The shared presentation layer receives display state and callbacks. The live pane wrapper supplies authorized state and real handlers; the catalogue supplies synthetic data and local-only handlers. Keep the catalogue route on the ordinary authenticated SPA path, not the `/outlook-pane` document origin or an iframe.

The canvas is intentionally curated: flow navigation and “what / why / status” context on the left; a roughly 380px Outlook-width preview on the right. On wide desktop layouts, use a flexible flow/context column beside a fixed 380px preview. Below the width where both columns fit comfortably, stack them; below 380px, keep the preview at its real width inside its own horizontal scroll frame so the document itself does not overflow. Do not add free-form board editing or trace capture.

The catalogue registry is synchronous: Welcome is selected on entry, unknown selection IDs fall back to Welcome, and an empty registry shows an explicit empty state. Use native buttons in a labelled flow-navigation list for selection; expose the selected state and visible focus, and announce the new screen title/status in a polite live region. Each preview control either changes fixture-backed local state or is disabled with an explanation. For example, Quote Tool search reveals labelled sample rates, choosing a rate updates the synthetic quote, draft/PDF shows an unsaved sample preview, and native-only Pair/Move approval controls open explanatory synthetic dialogs. Do not render a Send button; explain that the live workflow hands the draft to Outlook for staff to send manually.

| Field | Value | Meaning |
|---|---|---|
| Preview type | Existing pane UI | The screen/behavior exists in application source; this alone does not claim deployment |
| Preview type | Sample only | Local fixtures or a non-live presentation; no HMS or Outlook operation occurs |
| Preview type | Concept | A future flow represented as a design, not an implemented capability |
| Rollout | Deployment not verified | There is no evidence in the catalogue that the relevant hosted release is live |
| Rollout | Merged — rollout pending | Code is merged, but the relevant hosted release and/or supervised Outlook-PC rollout is incomplete; this is the v4 security state now |
| Rollout | Web deployed — Outlook rollout pending | The hosted web release is verified, but required native-PC installation/enrollment or target-PC checks remain |
| Rollout | Pilot verified | The runbook’s supervised host/device checks have evidence; show a last-reviewed date and non-sensitive source note |
| Rollout | Not built | The entry is a future concept, not a released capability |

### System-Wide Impact

- The Settings layout already requires a signed-in session. The catalogue adds no new API, database, auth session, device credential, or bridge action.
- Nava Legacy and Nava Admin serve the same application build through separate host planes. The page is host-neutral; each host continues to apply its existing session policy.
- The v4 Outlook pane requires a 24-hour hotel session, protocol v4, a paired Windows user, and approved mailbox/store/folder authorization. The catalogue only previews those states; it does not change dashboard sessions or satisfy enrollment.
- The route uses normal SPA CSP and does not expand the bridge-enabled `/outlook-pane` document, iframe policy, or native popup surface.

### Risks & Dependencies

- The implementation target is merged `origin/main` at `9221c1700`; the current CodeGraph/worktree snapshot is pre-v4. Rebase or start from current main before implementation and inspect the merged files, not the stale pane snapshot.
- `apps/server-pilot/deploy/outlook-v4-security-release-runbook.md` requires approved backup/change window, IT trust approval, exact Windows artifact verification, real Classic Outlook testing, and supervised per-device enrollment. A catalogue build or routine SPA deployment does not satisfy those gates.
- There is no catalogue-only production deployment from the merged source: a shared SPA release also changes the live pane’s v4 behavior and CSP. Keep implementation verification local/CI; publish only with the separately approved v4 cutover, after the runbook gates. Never restore the old unrestricted bridge as a catalogue rollback.
- Pane extraction can regress onboarding persistence, auth gates, or uncertain-draft handling. Preserve the live adapter and existing pane regression tests; preview mode must never call them.
- Reply/PDF drafting is not available for every shared mailbox profile: the native path refuses creation unless the approved Drafts folder is also the profile-default Drafts folder. Label this as a target-PC condition, not a universal promise.
- The public design references include unverified “connected/live” claims and realistic-looking guest/contact data. Reuse layout inspiration only; build clean synthetic fixtures.

### Sources / Research

- Zero PR [#24](https://github.com/kufupa/Zero/pull/24) is merged at `9221c1700`; this source has bridge protocol v4 and pins `apps/server-pilot/vsto` to `0f2d0853074f241da4a4d846076f6358720956b1`. The native PR [#3](https://github.com/kufupa/nava-outlook-addin/pull/3) and the user-provided Windows artifact details are corroborated by the pinned source and release runbook.
- `apps/server-pilot/deploy/outlook-v4-security-release-runbook.md` is the release authority. It says the current code/CI artifact is not a deployment and records rollout, shared-Drafts, Windows trust, and dual-pane verification gates.
- `apps/mail/app/(routes)/outlook-pane/page.tsx` owns the four pane steps, static `RATE_TABLE` sample search, reply/PDF behavior, manual-send copy, and update/pairing/authorization banners. `apps/mail/lib/workstation/use-outlook-bridge.ts` gates mailbox access on session/device/transport authorization. `apps/mail/lib/workstation/bridge-protocol.ts` defines v4 actions without native Send/Delete.
- `apps/mail/app/(routes)/settings/[...settings]/page.tsx`, `apps/mail/config/navigation.ts`, and `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx` establish the sibling-route/nav pattern and the metrics “Dashboard unavailable” branch. `apps/mail/lib/admin-dashboard/access.ts` and `apps/mail/tests/admin-dashboard/access.test.ts` show the current signed-in visibility model.
- `docs/superpowers/specs/2026-09-23-centurion-flow-c-shotgun-design.md` is the bounded source for the 11 planned Flow C boards. `docs/solutions/security-issues/outlook-webview2-no-autoauth.md` and `docs/solutions/architecture-patterns/infor-hms-outlook-sidepane-onboarding-and-quote-ergonomics.md` inform safe identity, narrow-pane, and copy choices.
- User-provided visual references: [narrow pane demo](https://hermes.trynava.io/designs/outlook-side-pane-demo.html) and [old 65-artboard index](https://hermes.trynava.io/designs/index.html). They are references only, not runtime inputs or truth about deployed behavior.

---

## Implementation Units

### U1. Extract a reusable pane presentation boundary and correct misleading copy

- **Goal:** Let the real pane and the fixture preview share display components while the real wrapper retains every live security and mail operation.
- **Requirements:** R4–R6, R8–R11.
- **Files:** `apps/mail/app/(routes)/outlook-pane/page.tsx`; `apps/mail/app/(routes)/outlook-pane/outlook-pane-sign-in.tsx`; new `apps/mail/components/outlook-pane/pane-presentation.tsx`; `apps/mail/tests/outlook-pane-render.test.tsx`; `apps/mail/tests/outlook-pane-onboarding.test.tsx`.
- **Approach:** Move only presentational shell and screen rendering behind explicit display state and callbacks. Keep `useOutlookBridge`, session checks, native pairing, authorization, `trpcClient` calls, draft retries, and production local-storage behavior in the live wrapper. Update stale sign-in, account-label, tour, and quote-search wording without changing bridge behavior.
- **Test scenarios:** (1) Unauthenticated and expired-session users still get the real sign-in gate. (2) Old protocol, unpaired device, and unavailable-folder states render correctly. (3) Welcome, diagnostics, tour, and quote navigation still work in `/outlook-pane`. (4) Copy does not imply sign-in lasts indefinitely, that the app mailbox is the Outlook account, or that the static rate lookup is live HMS availability. (5) Existing uncertain-draft “check Drafts before retrying” behavior remains intact.
- **Verification:** Extend existing pane render/onboarding tests; keep v4 bridge-protocol tests passing without modifying bridge authorization behavior.

### U2. Add the metrics-independent Side Panel UI destination

- **Goal:** Make the catalogue discoverable from the signed-in production dashboard on both host planes.
- **Requirements:** R1–R3.
- **Files:** `apps/mail/app/(routes)/settings/[...settings]/page.tsx`; new `apps/mail/app/(routes)/settings/side-panel-ui/page.tsx`; `apps/mail/config/navigation.ts`; new `apps/mail/tests/side-panel-ui-catalog.test.tsx`.
- **Approach:** Add a `side-panel-ui` entry to the existing settings catch-all page map and add a navigation item adjacent to Admin Dashboard. Reuse the existing authenticated Settings layout and session visibility model. Do not import `useAdminDashboardData` or nest the catalogue within `AdminDashboardPage`.
- **Test scenarios:** (1) A signed-in user reaches `/settings/side-panel-ui` from navigation. (2) An unauthenticated user follows the existing Settings redirect. (3) With the metrics query failing, the metrics route still shows its current error state while Side Panel UI renders independently. (4) Side Panel UI is visible under the same signed-in navigation policy on both host profiles.
- **Verification:** Route test uses a failing metrics mock and proves the catalogue does not depend on the metrics hook.

### U3. Populate the flow catalogue with safe fixture previews and rollout labels

- **Goal:** Give staff and client reviewers a compact, navigable inventory of the current pane, v4 readiness states, and explicitly planned flows.
- **Requirements:** R4–R16.
- **Files:** new `apps/mail/lib/outlook-pane/side-panel-ui-catalog.ts`; new `apps/mail/components/outlook-pane/side-panel-ui-preview.tsx`; new `apps/mail/tests/side-panel-ui-preview.test.tsx`; `apps/mail/tests/side-panel-ui-catalog.test.tsx`; read-only design source `docs/superpowers/specs/2026-09-23-centurion-flow-c-shotgun-design.md`.
- **Approach:** Seed groups for onboarding, v4 readiness, quote/reply, native batch-move consent, and the 11 Flow C concept boards. Each entry carries its purpose, preview type, rollout state when applicable, last-reviewed date, and a concise non-sensitive evidence/source note. Select Welcome by default; a stale selection falls back to Welcome, while an empty registry shows an explicit empty state. Render the shared pane presentation at Outlook width with synthetic values. Pairing and move consent are explanatory local states; draft/PDF preview controls do not invoke production handlers, and no Send button is rendered. Quote search, rate selection, draft preview, and other enabled controls each produce a specific local-only result; live-only actions without a useful demonstration are disabled with an explanation. Keep concept boards concise rather than copying the old 65-artboard layout. The flow selector is a labelled navigation list of native buttons with visible selection/focus and a polite announcement of the selected screen title/status. At narrow widths, stack the context and pane; below 380px, horizontally scroll the fixed-width preview frame without causing page-level overflow.
- **Test scenarios:** (1) Every seeded screen has a valid preview type and rollout combination, an accessible label, and a non-sensitive evidence/source note plus review date when rollout is stated. (2) Initial selection is Welcome; a removed selection falls back to Welcome, and an empty registry renders its empty state without a loading state. (3) Selecting a screen updates the preview and its “what / why / status” detail, exposes visible focus/selection, and announces the new screen title/status. (4) Pairing and native move-consent previews never call the bridge. (5) Quote preview identifies sample data, manual Send, conditional shared-mailbox Drafts behavior, and uncertain outcomes; each enabled control produces its documented local result. (6) Clicking all visible preview actions causes zero sign-in, bridge, ticket, workstation, mail, PDF, draft, send/delete, or move calls and does not write onboarding storage. (7) No real mailbox, guest, pairing-code, operator, or device identifier data is present in fixture snapshots. (8) Below 380px, the preview frame scrolls horizontally, the document has no horizontal overflow, and keyboard users can reach every preview control.
- **Verification:** Mock all native and tRPC entry points and assert they remain untouched throughout catalogue navigation.

---

## Verification Contract

Run the targeted UI regressions and full mail frontend suite in a local/CI test environment with no pilot `DATABASE_URL` or production credentials:

```bash
pnpm --dir apps/mail exec vitest run tests/side-panel-ui-catalog.test.tsx tests/side-panel-ui-preview.test.tsx tests/outlook-pane-render.test.tsx tests/outlook-pane-onboarding.test.tsx
pnpm --dir apps/mail test
pnpm --dir apps/mail build
```

The browser review must cover the desktop dashboard composition and a 380px pane preview, initial/empty/missing-selection states, keyboard selection and visible focus, selected-state and status announcements, local-only outcomes for enabled controls, visible rollout labels, and the stacked layout below 380px without page-level horizontal overflow. Verify both `nava.legacyhotels.co.za` and `nava-admin.trynava.io` through local/staging host profiles or after a separately approved release; do not perform a production deploy as part of implementation verification.

The catalogue must remain useful with the Admin Dashboard metrics query mocked as failed. Do not use the live Outlook host, pilot RDS, real guest messages, the VSTO installer, or EC2/AWS writes for these tests. Any eventual production publication must follow the full v4 security release runbook and its IT/Windows gates.

---

## Definition of Done

- The signed-in settings navigation reaches Side Panel UI on either host profile, regardless of Admin Dashboard metrics availability.
- The right-hand pane preview and live `/outlook-pane` consume shared presentation components; there is no iframe or duplicate screenshot-only implementation.
- The catalogue contains current onboarding, v4 readiness, quote/reply, native move-consent, and curated Flow C concept states with separate preview-type and rollout labels, review dates/evidence notes, and synthetic data.
- The catalogue has a deterministic default/empty state, accessible flow selection, explicit local outcomes for preview controls, and reachable 380px pane controls on narrow viewports.
- A reviewer unfamiliar with the catalogue can complete the short staff-led walkthrough and correctly explain the sample-backed quote path, manual Outlook Send, and current v4 rollout status.
- Preview interactions are locally simulated and tests prove they cannot call real auth, Outlook bridge, mail, PDF, draft, send/delete, or move operations.
- The live pane's security gates and draft safety remain unchanged, and its stale claims about one-time sign-in, detected Outlook identity, and live sample rates are corrected.
- Targeted tests, the full `apps/mail` suite, and the frontend build pass without connecting to pilot RDS.
- The page does not claim that the security release is deployed or that a staff PC is enrolled. Production deployment remains gated by the existing runbook and separate approval.
