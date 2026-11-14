# DaVinci Infor HMS Cloud Migration — Empirical Audit, P0 Labtest Results & 10/10 Architecture

> **Status:** `P0` Control Experiments (`E1`–`E5`) **COMPLETE** (`2026-11-14`, zero errors, zero orphaned active stays). Paused before `P1`–`P4` implementation.
> **Reference Trunk:** [`origin/main` `44a180be7`](../../../../PRODUCT.md) (`apps/server-pilot` + `apps/mail`), Playwright `1.63.0`.
> **Local Probe Artifacts:** `~/.local/share/zero/research/davinci-hms-tools-20261114/terra-probe/` (`compare-and-p0.json`, `p0-clean.json`, `e5-verified.json`, `e4-finish-report.json`, `e1-child14-and-verify.json`).

---

## 1. TL;DR — What Changed & Fact-Check vs Assumptions

1. **DaVinci is already on Infor HMS Cloud SaaS:** `DAVINCI_PRD` runs at `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp?tenant=DAVINCI_PRD` (Ext JS `4.2.2.1144`), NOT on-prem `appsrv-1.legacyhotels.co.za`. No UI framework rewrite is needed.
2. **Multi-property tenant (`HRDAV` + `HRDAVS`):** `DAVINCI_PRD` exposes `button.switchproperty` switching between **`HRDAV` (`Davinci Hotel`, default)** and **`HRDAVS` (`Davinci Suites`)**. Even better: `EAM.Ajax.rest` `inquiryForGrid` accepts `propertyCodes: "HRDAVS"` **without clicking the UI property switcher** (`HTTP 200`, `410ms`).
3. **Hypothesis fact-check (`HRCEN` vs `HRDAV`):**
   - **`guestoptin4` (`Terms and Conditions`):** Present and `visible: true` on **both** `HRCEN` and `HRDAV`. Centurion left `allowBlank: null` and `create-reservation.mjs:52` blocked `true` (`opt_in_not_supported`); `HRDAV`/`HRDAVS` set `allowBlank: false`. Live `E1` + `E4` Saves proved HMS accepts **both** `guestoptin4='0'` (`false`) and `guestoptin4='-1'` (`true`).
   - **`child1..3` & `OSCRCS` child bands:** **Owner was right.** Both `HRCEN` and `HRDAV` define **3 Active child categories** in `OSCRCS` (`CHILD1` `0–2`, `CHILD2` `3–12`, `CHILD3` `13–17`; `CHILD4..6` `Inactive`), and Centurion tools already used `Enter Child Ages` (`OSRESV.HDR.validateChildAgeDetails`). On `HRDAV`, `[14]` computes `{"CHILD3": 1}` with `activeChildCategories: 3`, **but `HRDAV`/`HRDAVS` Screen Designer hides `child3` (`visible: false, readOnly: false`)**, breaking DOM-visibility assertions in `guest-stay-form.mjs:650-659`, `guest-stay-save.mjs:253,264`, and `guest-stay-amend-children.mjs:129,137`.
   - **`channel = 'HMS'`:** Identical on `HRCEN` and `HRDAV` (`visible: false, allowBlank: false, value: 'HMS'`) — NOT unique to DaVinci.
   - **Migrate once vs fork:** Parameterize the existing `hms-cloud/` + V2 stack via a narrow `HmsPropertyContext` (forcing explicit `propertyCode` on cross-hotel callers between `HRCEN` and `HRDAV` — reject if omitted or unknown — while defaulting intra-DaVinci switching between `HRDAV` (`Davinci Hotel`) and `HRDAVS` (`Davinci Suites`) to **`HRDAV`**). **Do not duplicate files.**
   - **Locks & `HRCEN` checks:** Keep PostgreSQL advisory locks keyed on `(tenantId, propertyCode)` (`property-read-lock.ts:76-80`); fix `pane-stay-save.ts:635` env-derived `tenantId` & `:663` `HRCEN`-only check, and remove scattered `propertyCode !== 'HRCEN'` guards across `206` non-`test`-path files (`85` `src`, `104` `tooling`, `17` `mail`) in favor of entrypoint resolution.
   - **Pilot RDS testing rule (`AGENTS.md` / `PRODUCT.md`):** Never insert, mutate, or delete test rows in pilot RDS (`DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, `TEST_DATABASE_URL` stay unset in checks). Run `Prepare` on already-ingested real emails (stop before Save) + `Proof Labtest` (`2027+`, `udfchkbox04=false`) on live HMS.

---

## 2. Live Empirical Comparison: `HRCEN` vs `HRDAV` vs `HRDAVS`

Verified side-by-side against live `THECENTURION_PRD` and `DAVINCI_PRD` sessions (`compare-and-p0.json`, `e1-e5-part1.json`, `e5-verified.json`, `p0-clean.json`):

| Dimension | `HRCEN` (`THECENTURION_PRD`) | `HRDAV` (`DAVINCI_PRD`) | `HRDAVS` (`Davinci Suites`) | Action Needed |
|---|---|---|---|---|
| **Host & Framework** | `hmsweb.hms.eu1.inforcloudsuite.com`, ExtJS `4.2.2.1144` | `hmsweb.hms.eu1.inforcloudsuite.com`, ExtJS `4.2.2.1144` (`Legacy_Davinci SAAS`) | Same `DAVINCI_PRD` session via `switchproperty` (`loadmain?...&defaultproperty=HRDAVS`) | Fix `browser-artifacts.ts:57` & `property-registry.mjs:61-79` (`appsrv-1`/`HMS_DAVINCI` -> SaaS/`DAVINCI_PRD`). |
| **`NAVAAI` Permissions** | `can_insert: true`, `can_update: true`, `can_delete: false` | `can_insert: true`, `can_update: true`, `can_delete: false` | Same `NAVAAI` login | Identical. Assert header property === expected before writes. |
| **Core Menu Screens** | `BSSCSL`, `OSRESS`, `OSNRAV`, `OSMPAV`, `OSRESV`, `OSCRCS` | All 6 present | Same shell | Identical. |
| **Blank `OSRESV.HDR` Keys** | `1,111` keys (`0` exclusive) | `1,111` keys (`0` exclusive) | Identical subset schema to `HRDAV` | Zero structural form drift; stop hashing all `1,111` keys (`guest-stay-save.mjs`). |
| **`channel`** | `'HMS'`, `visible: false`, `allowBlank: false` | `'HMS'`, `visible: false`, `allowBlank: false` | `'HMS'`, `visible: false`, `allowBlank: false` | Identical; do not treat as a DaVinci-only delta. |
| **`guestoptin4` (`Terms & Conditions`)** | `visible: true`, `allowBlank: null` (`create-reservation.mjs:52` blocked `true`) | `visible: true`, **`allowBlank: false`** (Save accepts BOTH `'0'` & `'-1'`) | `visible: true`, `allowBlank: false` | Support both `false` and `true` (`-1`) across `create-reservation.mjs` & `guest-stay-save.mjs`. |
| **Child Bands (`OSCRCS` & `OSRESV.HDR`)** | `CHILD1..3` Active (`0-2, 3-12, 13-17`); all 3 `visible: true, readOnly: true` | `CHILD1..3` Active (`activeChildCategories: 3`, `[14]->CHILD3:1`), **`child3` `visible: false, readOnly: false`** | **`child3` `visible: false, readOnly: false`** | Read child band counts from ExtJS record/component model + `validateChildAgeDetails` instead of asserting visible DOM on `child3`. |
| **`reservationnote`** | `allowBlank: true` | **`allowBlank: false`** | `allowBlank: false` | Enforce non-empty note in `HRDAV` `createContract` (already noted in `HRDAV.json`). |
| **`guaranteetype`** | `allowBlank: true`, `10` codes | **`allowBlank: false`**, **`11` codes** (adds `CCIATA`) | `allowBlank: false` | Parameterize guarantee list per `property-profiles/<CODE>.json`. |
| **`confidentialratecb`** | Default `false` (`'0'`) | Default **`true` (`'-1'`)** | Default `true` (`'-1'`) | Capture explicit default in profile; preserve staff choice cleanly. |
| **Availability (`inquiryForGrid`)** | `9` rooms (`EXKNG, LUXKNG, SUITE, STQN, STWN, DLXKNG, DLXQN, DLXTWN, SKNG`) | `8` unres (`ACCES, DLXKNG, DLXPAT, EXKNGB, EXKNGR, EXKNGS, JNRSUI, STKNG`), `9` res (`+STWN`) | `4` unres (`1BLX, 2BLX, 3BLX, PENT`), plans `DEF, BLRB, BARRO` | UI restricted click in `T2` hit server `hmsintg-temp` HTTP `500`; `EAM.Ajax.rest` with `showRestrictedSellOptions: true` succeeded (`200`). Default `includeRestricted: false` in UI flows or query via REST. |
| **Grids & Popups** | `stay360-confirmation.mjs:101-102` uses `+1`/`+3` offsets | `Guest Stay List` has `33` cols / `53` dataspies; col positions differ | Shared grid layout | Replace `+1`/`+3` cell offsets with column `dataIndex` / header binding. |
| **Transports & Secret** | 1 mailbox transport | **5 transports** (`davinci`, `fkhumalo`, `adladla`, `epick`, `kmgidi`) vs `runtime.ts:1661` single `mailboxTransportId` | Future scope (separate E5 follow-up) | Support `mailboxTransportIds: string[]` in `hmsSecretSchema` (`runtime.ts:38-49,1661`) + `import-hms-secret.sh`. |

---

## 3. P0 Control Experiment Results (`E1`–`E5` on Live `DAVINCI_PRD`)

All `P0` tests ran cleanly under request-fenced Playwright guards (`NAVAAI`, `Proof Labtest` `2027+` only, `udfchkbox04 = false` CMS OFF, zero real-guest mutations, existing stay `95557926-1` untouched).

| Experiment | Target & Scope | Key Measured Result | Artifact Proof |
|---|---|---|---|
| **E1: Blank Create, `guestoptin4`, Child `[5]` & `[14]`** | New Labtest stay `9740432137-1` (`stayId=103943`, guest `93881`, `2027-08-10`->`11`, `2A+1C[5]`, `STKNG/BAR`, `NGG`, `WLKIN`, `udfchkbox04=0`) | **`guestoptin4='0'` Saved HTTP `200`!** `7iosress_getstaydata.jsp` (`200`, `285ms`, `17` sections) + `rateDetails` (`5,956.50` ZAR = room + `Bed & Breakfast R`: `564` adult + `141` child + `12` net). Separate `[14]` age check returned `activeChildCategories: 3`, `childCategoryCounts: {"CHILD3": 1}` while `child3.vis === false`. | `e4-finish-report.json`, `e1-child14-and-verify.json` |
| **E2: `EAM.Ajax.rest` Quote & Meal Plans** | `internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false` (`2027-06-15`, `2A`) | `HRDAV BAR` unres **`1,082ms`** (`8` rooms; `STKNG/BAR` `5,820` ZAR, `Bed & Breakfast R`); `HRDAV BAR` res **`2,080ms` / `470ms`** (`9` rooms `+STWN`); `HRDAV WS` **`1,089ms`** (`8` rooms); `HRDAV PRESET WSG5DB` **`482ms`** (`3` rooms, `Wholesale Dinner, Bed & breakfast - NR`); `HRCEN BAR` **`497ms`** (`9` rooms). | `p0-clean.json`, `p0-followup.json`, `e1-e5-part1.json` |
| **E3: Readback REST/JSP Contract** | `95557926-1` (`stayId=102615`, read-only) & `9740432137-1` (`103943`) | `POST /web/jsp/7iosress_getstaydata.jsp`: `200`, **`285–480ms`**, `17` keys (`global`, `STAYDETAILS`, `ASSOCIATEDRESERVATIONS`, etc.). **Session quirk discovered:** succeeds right after `BSSTRT` login, returns `{"Error": "No session found."}` (`25ms`) while `OSRESV.HDR` is open. `GET .../rateshop/rateDetails` works everywhere (`200`, `592ms`). | `p0-clean.json`, `e4-finish-report.json` |
| **E4: Full Amend -> Upload -> Cancel Lifecycle** | Created `2027-08-10` stay `9740432137-1` (`stayId=103943`) | **Amend (`E4-a`):** `departuredate -> 12-AUG-2027`, `guestoptin4 -> true`, `Retain the current rates? -> Yes` -> `200`, `grandtotal: 11,913`, `guestoptin4: -1`, `rateDetails` shows `2027-08-10` & `2027-08-11` (`5,956.50` each). **Docs (`E4-b`):** `OSRESV.DOC` -> `BSUPLD.upload` `p0-e4-labtest-proof.pdf` -> `200`, tree updated (`48360: P0 E4 Labtest proof upload`). **Cancel (`E4-c`):** `OSCNRS` (`13` reasons, `TEST`) -> `"Cancellation Penalty of 11913.00 may be added to account. OK"` -> `CANCELED` (`200`) -> post-login `7iosress_getstaydata.jsp` verified `status: "Cancelled"` (`0` stray active stays). | `e4-finish-report.json`, `e4-finish-audit.jsonl`, `e1-child14-and-verify.json` |
| **E5: `HRDAVS` Property Switcher** | `button.switchproperty` -> `HRDAVS` -> revert `HRDAV` | Popup `gridpopup-1145` lists `HRDAV` (`Davinci Hotel`) & `HRDAVS` (`Davinci Suites`). Switch calls `loadmain?...&defaultproperty=HRDAVS` (`200`), header `HRDAVS`, blank `OSRESV.HDR` matches `HRDAV` config (`child3` hidden, `guestoptin4`/`reservationnote`/`guaranteetype` `allowBlank: false`, `channel='HMS'` hidden). Reverted cleanly to `HRDAV`. Direct `inquiryForGrid` (`propertyCodes: "HRDAVS"`) works without switching (`200`, `410ms`, `4` rooms). | `e5-verified.json`, `p0-clean.json` |

---

## 4. Codebase Audit: Reuse vs Duplicate & Distributed Gates

Direct inventory measured on `origin/main` (`44a180be7`):
- **`apps/server-pilot/tooling/hms-cloud/`:** `137` `.mjs` files (`101` non-test, `36` `*.test.mjs`; only `6` non-test scripts currently have zero static references: `create-reservation-rate-override.mjs`, `hms-guest-memory.mjs`, `native-create-body-digest.mjs`, `quote-view-cli.mjs`, `read-hotel-availability-ui.mjs`, `stay360-folio.mjs`).
- **`apps/server-pilot/tooling/playwright-quote/`:** `69` non-test `.mjs`/`.ts` files (including `property-registry.mjs` and `property-profiles/{HRCEN,HRDAV}.json`).
- **Scattered `HRCEN|THECENTURION_PRD` references:** `206` non-`test`-path files (`85` `apps/server-pilot/src`, `104` `apps/server-pilot/tooling`, `17` `apps/mail`).

### Key Hardcoded Choke Points Found
- **Config / Slot / Secret:** `apps/server-pilot/src/hms/browser-artifacts.ts:55-68` (`DAVINCI_HMS_PRODUCTION_ORIGIN = 'https://appsrv-1.legacyhotels.co.za'`), `apps/server-pilot/tooling/playwright-quote/property-registry.mjs:61-79` (`expectedTenant: 'HMS_DAVINCI'`), `apps/server-pilot/src/hms/runtime.ts:38-49,1661` (single `mailboxTransportId` vs 5 DaVinci transports), `apps/server-pilot/deploy/import-hms-secret.sh`.
- **Legacy Card & V2 Panel Gates:**
  - Frontend: `apps/mail/lib/reservation-workflow/client.ts:356` (`draft.propertyCode === 'HRCEN'`), `apps/mail/components/quote-workflow/booking-card.tsx:1159-1160`, `apps/mail/components/quote-workflow/voucher-find-card.tsx:122-123`, `apps/mail/components/reservation-pane/editors/quote-editor.tsx:59-63,94-95`, `apps/mail/components/nava-pane/nava-pane.tsx:2723`.
  - Backend TRPC / AI: `apps/server-pilot/src/trpc/routes/reservation-workflow-v2.ts:95,110`, `apps/server-pilot/src/trpc/routes/hms-approval.ts:91,106,153,169`, `apps/server-pilot/src/trpc/routes/quote-workflow.ts`, `apps/server-pilot/src/ai/pane-stay-save.ts:635,663`, `apps/server-pilot/src/ai/pane-cloud-preview.ts:541`, `apps/server-pilot/src/ai/reservation-workflow-v2-prefill-service.ts:133`, `apps/server-pilot/src/ai/reservation-workflow-v2-cancel.ts:121`, `apps/server-pilot/src/ai/reservation-workflow-v2-filing.ts:601`, `apps/server-pilot/src/ai/reservation-workflow-v2-addon-check.ts:276,367` (direct import of `centurion-stay360.mjs`), `apps/mail/lib/quote-workflow/staff-quote-bind.ts:513` (`dinner_bb`).
- **Cloud Drivers (`hms-cloud/`):** `create-reservation.mjs:30,52`, `guest-stay-form.mjs:144,160,650-659`, `guest-stay-save.mjs:244,253,264,549-565`, `guest-stay-amend-children.mjs:104-137`, `guest-stay-amend-date-room-rate.mjs:46`, `guest-stay-cancel.mjs:189,374,417`, `guest-stay-rate-plan.mjs:69,379`, `guest-stay-room-rate.mjs:186`, `saved-stay-nightly-rates.mjs:12,169,206,249`, `saved-stay-save-route-chain.mjs:16`, `stay360-confirmation.mjs:101-102`.

---

## 5. Architecture: From `Shape 3` (`9/10`) to `10/10` (Ponytail Hybrid)

| Option | Verdict | Why |
|---|---|---|
| **Shape 1: Duplicate Centurion Tools for `HRDAV`** | Reject (`5/10`) | Doubles maintenance, fractures fixes (`child3`, `guestoptin4`, `dataIndex` grid reads) across two trees. |
| **Shape 2: Full Raw HTTP Write Rewrite** | Reject (`5/10`) | EAM ExtJS writes (`OSRESV.HDR`, `OSCNRS`, `BSUPLD`) depend on server-stateful `requesttoken`, `LOVPOP` validation callbacks, and modal prompts (`Retain current rates?`, `Cancellation Penalty`). |
| **Shape 3 (`9/10`): Parameterized Single Stack** | Good base | Unifies `property-registry.mjs` + `property-profiles/<CODE>.json` + narrow `HmsPropertyContext` (explicit `HRCEN`/`HRDAV` arg, intra-DaVinci default `HRDAV` over `HRDAVS`), retires legacy `HMS_DAVINCI_CREATE=lab`, keeps ExtJS Playwright for everything. |
| **Shape 3+ / `10/10`: Ponytail Hybrid (REST/JSP Reads + Thin ExtJS Writes)** | **Recommended (`10/10`)** | Adds **empirical `E2`/`E3` fast paths + Ponytail deletion**: **(1) Read & Quote over `EAM.Ajax.rest` / `7iosress_getstaydata.jsp` (`0.3–1.1s`)** using the authenticated slot session (`inquiryForGrid` handles `HRDAV`, `HRCEN`, AND `HRDAVS` with zero UI switch; `7iosress_getstaydata.jsp` + `rateDetails` runs cleanly on a non-`OSRESV` session); **(2) Thin ExtJS Playwright ONLY for stateful Writes (`OSRESV.HDR`, `OSCNRS`, `BSUPLD`)**; **(3) Delete full `1,111`-key digest pinning** (`native-create-body-digest.mjs` / full-model SHA checks) and assert only business fields before Save + fresh readback after (`AGENTS.md`). |

### Concrete Structural Rules for `10/10`
1. **Single Authoritative Contract (No Split Ownership):**
   - `property-registry.mjs` owns runtime binding (`propertyCode`, `tenant`, `cloudOrigin`, `browserSlot`, `credentialSecretRef`, `mailboxTransportIds[]`, `defaultPropertySwitch: 'HRDAV'`).
   - `property-profiles/<CODE>.json` owns domain/UI policy (`rooms`, `rates`, `boards`, `guarantees`, `cms`, `createContract: { requiredFields, guestOptIn4Policy, defaultChannel, confidentialRateDefault, childCategoriesFromOSCRCS }`). Serve this read-only to `apps/mail` so frontend cards stop hardcoding `HRCEN`/`HRDAV`.
2. **Postgres Advisory Locks (Keep, Fix Boundary):**
   - Keep Postgres advisory locks via `propertyReadLockKey(tenantId, propertyCode)` (`apps/server-pilot/src/hms/property-read-lock.ts:76-80`) so `http`, `worker`, `ai-worker`, and `remote-http` never collide on a shared CDP slot.
   - Fix `pane-stay-save.ts:635` (derive `tenantId` from the resolved `HmsReadTarget`, not `process.env`) and remove `HRCEN`-only checks (`:663`).
   - Remove redundant inner `propertyCode !== 'HRCEN'` guards once entrypoints (`hmsReadTargetForTransport`, `quoteTargetForTransport`, `paneStayHmsTargetForTransport`) resolve and freeze `HmsPropertyContext`.
3. **Retire Two Ways as Each Wave Ships:**
   - Replace `centurion-stay360.mjs` import in `reservation-workflow-v2-addon-check.ts:276`.
   - Retire legacy `HMS_DAVINCI_CREATE=lab` (`create-lab-stay.mjs:79`) once Wave 3 (`V2 Create`) passes `E4` on `HRDAV`.
   - Clean out the `6` dead `.mjs` files (`native-create-body-digest.mjs`, etc.) once verified unused.

---

## 6. Verification Guardrails (`verify-hms-property`) & Rollout Roadmap (`P0`–`P4`)

### Proposed `.claude/skills/verify-hms-property` Gate Checks
1. **Static Property-Pin Diff Check + Remote Typecheck:** Fail if new raw `'HRCEN'`/`'THECENTURION_PRD'`/`'appsrv-1'` literals are added outside registry/profile configs; run typecheck exclusively via `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app <mail|server-pilot>` (`AGENTS.md`).
2. **Focused Tests (Pilot RDS Blocked):** Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, `TEST_DATABASE_URL`; run targeted `node --test` (`hms-cloud/*.test.mjs`, `playwright-quote/*.test.mjs`) and targeted `Vitest` specs (`<= 3` concurrent runs).
3. **Read-Only Live Schema Probe (`sentMutations === 0`):** Assert `document.title === Infor HMS - <PROP>` & `button.switchproperty` === `<PROP>`, then diff live blank `OSRESV.HDR` + `OSCRCS` + `inquiryForGrid` against `property-profiles/<CODE>.json`.
4. **Canary Attestation:** Prepare on real email (stop before Save), then execute one `Proof Labtest` (`2027+`, `udfchkbox04=false`) Save + fresh readback (+ clean Cancel on scratch stays), emitting `CANARY PASS <workflow> HRDAV <sha>` for `apps/server-pilot/deploy/write-ec2-remote-env.sh`.

### Rollout Waves (`P0` Complete, `P1`–`P4` Queued)
- **`P0` (DONE):** Empirical `E1`–`E5` control experiments on live `DAVINCI_PRD` + cross-check vs `THECENTURION_PRD`.
- **`P1` (Infra, Registry & Contract Foundation):** Update `browser-artifacts.ts:57`, `property-registry.mjs`, `HRDAV.json`, `runtime.ts:38-49,1661` (`mailboxTransportIds[]`), `pane-stay-save.ts:635,663`, `write-ec2-remote-env.sh` per-property flags, AWS secret `nava-zero/server-pilot/infor-hms-read-davinci`, provision `hms-slot@hrdav` (`:19225` / `HMS_STAGEHAND_CDP_URL_DAVINCI`).
- **`P2` (Read + Quote + `10/10` REST/JSP Fast Path):** Enable `EAM.Ajax.rest` `inquiryForGrid` + `7iosress_getstaydata.jsp` + `rateDetails` parameterized by `propertyCode`; replace `stay360-confirmation.mjs:101-102` offsets with `dataIndex`; enable `staff-quote-bind.ts:513` (`dinner_bb` / `WSG5DB`), `quote-editor.tsx`, `booking-card.tsx`, and `HMS_DAVINCI_READS=on` / `HMS_DAVINCI_MAKE_QUOTE=on` across all 5 DaVinci mailboxes -> `CANARY PASS quote HRDAV <sha>`.
- **`P3` (V2 Create + Guest Profile + Filing + Default `HRDAV` Switcher Check):** Unlock `client.ts:356`, `reservation-workflow-v2.ts:95`, `prefill-service.ts:133`, `filing.ts:601`, `voucher-find-card.tsx:122`, and `hms-cloud` Create (`guestoptin4` both values, `child3` ExtJS model fix, `reservationnote` required, `channel='HMS'`); retire `HMS_DAVINCI_CREATE=lab` -> `E4` Create + Filing Canaries.
- **`P4` (V2 Amend + Cancel + Add-Ons & Assoc. Reservations; Later `HRDAVS`):** Parameterize `guest-stay-amend-*`, `guest-stay-cancel.mjs` (surfacing `"Cancellation Penalty of ... may be added"` safely for real guests), `addon-check.ts:276` (drop `centurion-stay360.mjs` import), `hms-approval.ts` -> `E4` Amend + Cancel Canaries; schedule `HRDAVS` onboarding after `HRDAV` is live in production.

### Execution Model & Skill Routing (`~/.cursor/rules/pstack-models.mdc` + `codex`)
- **Review / Architecture / Cross-Check:** `architect`, `arena`, `interrogate` using `gemini-4-carbon-medium` (or `gemini-4-hydrogen`/`argon`) + **`gpt-6.1-sol`** (`gpt-6.1-sol-medium` / Codex CLI `-m gpt-6.1-sol`; never `gpt-5.6-sol`).
- **Implementation & Code Edits:** `feature`, `refactoring`, `bug-fix`, `swarm workers` using **`gpt-6.1-sol`** (`ponytail` rules enforced), plus `codex` CLI (`gpt-6-luna` cheap read fan-outs).
- **Owner Approvals Recorded (2026-11-14):**
  - **Go** on `P1`–`P4` under `10/10` Ponytail Hybrid (`architect` -> `arena` -> `interrogate` run autonomously).
  - **Secrets Updated:** `nava-zero/server-pilot/infor-hms-read-davinci` updated to `DAVINCI_PRD`/`HRDAV` (`AWSCURRENT` `VersionId` `a4e6feb3-50a4-499f-96ee-161be1f2106c`, `view_only` schema).
  - **Autonomous Flag Flips Pre-Approved:** Agent handles all code, `remote-typecheck.sh`, focused tests, `ops-deploy.sh`, EC2 flag updates (`write-ec2-remote-env.sh --m1-only` + `ops-restart.sh`), real-email Prepare probes, `Proof Labtest` Canaries, **and flipping verified DaVinci workflow flags `on` autonomously without extra owner sign-off** (escalating only if an external/hardware blocker stops progress).
