# Adversarial Override & Execution Handoff (Option A — Real-Email Pilot ASAP)

- **Date:** 2026-11-03
- **Target Audience:** Codex 6.1 Sol Ultra (author of `docs/research/2026-11-03-plan001-adversarial-systems-review.md` & `docs/plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md`)
- **Inspected Git Refs:**
  - `origin/main` = `0da451edd5cbc6188d45fb05e619d5e2e12c97e0` (deployed on EC2)
  - Open PR `#987` = `19c0cf1860bc11fadc138f779a1fe5dc20c2d156` (`feat(hms-cloud): add single-room pane amend session`)
  - Policy patch worktree = `/home/ubuntu/projects/zero/.claude/worktrees/agent-a8d639a6e94efe62b`
- **Owner Authority & Mode:**
  - Owner approved **Option A**: Execute **Tranche 1 (`U0 → U1/U2/U3 → U4`, 120–165m wall clock)** to strip all `Proof Labtest` / `>= 2027-01-01` production blocks across Create (single + multi-room), Filing, and Amend (`#987`), rescope the hotel-wide dispatch lock to per-target, deploy to EC2, and enable real-email production flags (`on`). Then execute **Tranche 2 (`U5` new guest profile creation, `U6` saved-stay Room/Rate Shop picker)**.
  - Owner authorized stripping poison ceremony (500-line cap, `.ok` gate files, blocking Greptile status check, `/proc` bootId/pidNamespace proofs, private-socket PG abort harnesses, PM2 `axm_monitor` freeze scripts).
  - Do **not** rely on Hindsight (stale/out-of-date per owner warning). Ground solely in the exact `file:line` citations below.

---

## 1. Where Sol's Review (`2026-11-03-plan001-adversarial-systems-review.md`) & `Plan 002` Were Right vs. Wrong

### Right (Keep):
1. **Amend `#987` P1 is real:** `apps/server-pilot/tooling/hms-cloud/pane-amend-session.mjs:329-332` takes a fresh `snapshot(prepared.frame)` after the rate-retention popup and checks the second `Save` against `retained` without verifying `retained` still matches `postAvailability` and `input.approvedPrices`. Fix is ~15 lines.
2. **Mounted Quote is still native:** `apps/server-pilot/src/ai/staff-quote-installation.ts:34-43` runs `tooling/playwright-quote/fetch-quote.mjs`. **Decision:** Keep `fetch-quote.mjs` for pilot launch; do **not** burn hours cutting over to `tooling/hms-cloud/quote-read.mjs`.
3. **Preview driver blocks Go by design:** `apps/server-pilot/src/ai/pane-cloud-preview.ts` is preview/commit driver plumbing; real staff `Go` routes through `apps/server-pilot/src/trpc/routes/hms-approval.ts` → `apps/server-pilot/src/ai/pane-hms-write.ts`.

### Wrong / Over-Indexed (Override):
1. **360-minute budget (`P1–P12`) for 1 fake Create (`Proof Labtest`):** Unacceptable. `P1–P12` leaves real guest names and `< 2027-01-01` arrivals blocked in 20+ places.
2. **Missed catastrophic production lock bug in `hms-labtest-dispatch.ts`:**
   - `apps/server-pilot/src/ai/hms-labtest-dispatch.ts:18-25` hardcodes `firstName: z.literal('Proof'), lastName: z.literal('Labtest')`.
   - `apps/server-pilot/src/ai/hms-labtest-dispatch.ts:101-102, 124, 158` scans **all** `work_event` rows where `field_path = 'nava.hms.labtest.dispatch.v1'`. If **any** active/uncertain row exists (`history.active.length > 0`), it returns `occupied` (`hms_labtest_dispatch_active`) across **all of HRCEN globally**. One timed-out write bricks the entire hotel.
3. **Over-engineering in `Plan 002` Phases 1–4:**
   - Do **not** build byte-level PDF re-download verification in Filing (`stay360-document-attach.mjs:318-337` already verifies multipart upload POST + grid row count + filename/docType readback).
   - Do **not** block Tranche 1 on new-guest profile creation (`U5`) or Amend Room/Rate Shop popup (`U6`); ship Tranche 1 (`U0–U4`) first, then run `U5–U6` immediately as Tranche 2.

---

## 2. Complete `file:line` Inventory of Hardcoded `Proof Labtest` / `2027-01-01` Production Locks to Parameterize

### A. Shared Durable Dispatch & Target Lock (`U0`)
1. `apps/server-pilot/src/ai/hms-labtest-dispatch.ts`:
   - `L18-25`: `claimSchema` hardcodes `propertyCode: z.literal('HRCEN'), firstName: z.literal('Proof'), lastName: z.literal('Labtest')`.
     - **Fix:** Replace literal `'Proof'` / `'Labtest'` with `z.string().trim().min(1)` when `allowRealGuest` is true (or for all valid guest names on `HRCEN`).
   - `L101-102, 124, 158`: `readHistory` treats `active` globally across all `work_event` rows.
     - **Fix:** Scope `active` conflict check and `epoch` to target key `(propertyCode, confirmation ?? stayId ?? workItemId)` (or `(propertyCode, guestLastName, arrival)` for new creates) so unrelated bookings/staff never block each other, while same-booking / same-target writes remain strictly serialized.

### B. Single-Room & Multi-Room Create (`U1`)
1. `apps/server-pilot/src/ai/pane-cloud-preview.ts`:
   - `L88`: `const labDate = isoDate.refine((value) => value >= '2027-01-01')` → allow `>= todayIso` when `allowRealGuest` (`PANE_WRITE_CREATE === 'on'`).
   - `L298-303`: `createRecoveryEvidence` hardcodes `arrival: labDate, departure: labDate` and `sameArrival` rows `firstName: z.literal('Proof'), lastName: z.literal('Labtest')` → accept the target guest's `firstName`/`lastName` and real arrival/departure dates.
   - `L340-342` (`previewPaneCloud`) & `L423` (`commitPaneCloud`): `if (input.stay.firstName !== 'Proof' || input.stay.lastName !== 'Labtest' || input.stay.arrival < '2027-01-01') return refused('cloud_preview_labtest_only');` → gate on `allowRealGuest` (`PANE_WRITE_CREATE === 'on'`); when `on`, allow real guest names and `arrival >= todayIso`.
2. `apps/server-pilot/src/ai/pane-create-cloud-input.ts`:
   - `L42-46`: `guaranteeCode()` only maps `'Non-Guaranteed Individual' -> 'NGI'` and `'Guaranteed By Agent' -> 'GTDAGT'`. Expand to all HRCEN guarantee codes (`NGI`, `GTDAGT`, `CC`, `6PM`, `COMP`, `PREPAID`, etc.).
   - `L86-88`: `if (mode === 'commit' && (stay.firstName !== 'Proof' || stay.lastName !== 'Labtest')) return { outcome: 'refused', reason: 'labtest_guest_required', field: 'guest' };` → allow real guest when `allowRealGuest` (`PANE_WRITE_CREATE === 'on'`).
   - `L59-61, L152, L206`: keep `sendHmsConfirmation: { kind: 'never' }` / `cms.send: false` as safe default so HMS never auto-emails guests behind staff's back (staff sends templated Outlook reply).
3. `apps/server-pilot/tooling/hms-cloud/create-reservation.mjs`:
   - `L50, L55, L467, L482`: relax `isSupportedLabtestGuarantee` when `allowRealGuest` is true.
   - `L60-63`: `REAL_GUEST_CREATE_AUTHORIZATION_HOLD` when `lastName !== 'Labtest'` → allow when `input.allowRealGuest === true`.
   - `L94`: `if (date(stay.arrival) && stay.arrival < '2027-01-01') return { outcome: 'refused', issue: 'labtest_arrival_required' };` → when `input.allowRealGuest === true`, enforce `stay.arrival >= todayIso` instead of `'2027-01-01'`.
   - `L397`: only require `Proof Labtest` note format when guest is `Proof Labtest` (or allow standard reservation note for real guests).
   - `L465-467`: `labtestDraft` check (`firstName === 'Proof' && lastName === 'Labtest' && stay.arrival >= '2027-01-01'`) currently gates staging `guaranteeType` during `prepare` (`L482-485` `requires_verified_labtest_draft`)! Change to `verifiedDraft` parameterized by the target guest's `(firstName, lastName, arrival)`.
   - `L628, L647`: pass `{ firstName, lastName, arrival: stay.arrival, departure: stay.departure, allowRealGuest: Boolean(input.allowRealGuest) }` into preimage and save calls.
4. `apps/server-pilot/tooling/hms-cloud/guest-profile.mjs`:
   - `L90-91` (`profileRecordMatches`): hardcodes `exact('firstname', 'Proof') && exact('lastname', 'Labtest') && current('firstname', 'Proof') && current('lastname', 'Labtest')`! Parameterize with `proof.firstName` and `proof.lastName`.
   - `L542` & `L587-600` (`selectGuestProfile`): only captures `draft = await profileDraft(page)` and sets `verifiedLabtestProfiles.set(page, id)` / `verifiedGuaranteeProfiles.set(page, proof)` when `candidates[0].firstName === 'Proof' && candidates[0].lastName === 'Labtest'`! Parameterize to bind `firstName: candidates[0].firstName, lastName: candidates[0].lastName` for any uniquely selected guest profile on `HRCEN`.
5. `apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs`:
   - `L413-415` & `L543-550`: pass `firstName`, `lastName`, `allowRealGuest` into `searchLabtestPreimage(page, labtestDates)`.
6. `apps/server-pilot/tooling/hms-cloud/labtest-preimage.mjs`:
   - `L111-112`: `searchRequest` hardcodes `exact('MADDON_FILTER_VALUE_5', 'Labtest')` → use `expectedLastName` (defaulting to `'Labtest'` only when not provided).
   - `L160`: `arrival < '2027-01-01'` → allow `arrival >= todayIso` when `allowRealGuest` is true.
   - `L175`: `await search.fill('Labtest')` → `await search.fill(expectedLastName)`.
   - `L205-206`: filter by `row.firstName.toLowerCase() === expectedFirstName.toLowerCase() && row.lastName.toLowerCase() === expectedLastName.toLowerCase()`.
7. `apps/server-pilot/tooling/hms-cloud/guest-stay-save.mjs`:
   - `L558`: `matchesSave` hardcodes `firstname: 'Proof', lastname: 'Labtest'` → parameterize with `expected.firstName`, `expected.lastName`.
   - `L581, L709`: works automatically once `guest-profile.mjs` (`isVerifiedLabtestProfileCurrent` / `verifiedLabtestProfileToken`) is parameterized for any selected guest profile.
   - `L620`: `dates(arrival, departure)` enforces `>= '2027-01-01'` → allow `>= todayIso` when `allowRealGuest` is true.
8. `apps/server-pilot/tooling/hms-cloud/labtest-create-readback.mjs`:
   - `L34`: `compareRecord` hardcodes `['firstName', 'firstname', 'Proof'], ['lastName', 'lastname', 'Labtest']` → use `expected.firstName`, `expected.lastName`.
   - `L55`: `guestName: 'Proof Labtest'` → `${expected.firstName} ${expected.lastName}`.
   - `L65`: check `native.firstName === expected.firstName && native.lastName === expected.lastName`.
9. `apps/server-pilot/tooling/hms-cloud/batch-sibling-readback.mjs`:
   - `L23-28`: replace hardcoded `'Proof'`, `'Labtest'`, `< '2027-01-01'` with `request.guest.firstName`, `request.guest.lastName`, and `allowRealGuest` date check.
10. `apps/server-pilot/tooling/hms-cloud/create-positive-recovery.mjs`:
    - `L25-26, L29-30, L51, L68-69`: parameterize `'Proof'` / `'Labtest'` and `< '2027-01-01'` with `request.guest.firstName`, `request.guest.lastName`, and `allowRealGuest`.

### C. Filing / Document Attachment (`U2`)
1. `apps/server-pilot/src/ai/run-ledger.ts`:
   - `L52-54`: `labtestAttachEnabled` checks `env.PANE_HMS_LAB_ATTACH_WORKER === 'on' && env.PANE_WRITE_ATTACH === 'lab'`.
   - **Fix:** Accept `env.PANE_WRITE_ATTACH === 'lab' || env.PANE_WRITE_ATTACH === 'on'`.
2. `apps/server-pilot/src/ai/pane-hms-write.ts`:
   - `L1450, 1459-1461`: `const allowRealGuest = form.action === 'attach_document' && attachMode === 'on';` followed by `if (isCloudAttach && (!labtestAttachEnabled(env) || allowRealGuest || !parsedFiling?.success)) return endRun(..., 'refused_cloud_upload_unavailable')`.
   - **Fix:** Remove `|| allowRealGuest` from the refusal condition and pass `allowRealGuest` + `guestName` into `runCloudPaneAttach`.
3. `apps/server-pilot/tooling/hms-cloud/pane-attach-session.mjs`:
   - `L104` (`provePositiveAttachRecovery`): replace `'Proof Labtest'` with `recovery.guestName`.
   - `L130` (`runCloudPaneAttach`): remove `|| input.allowRealGuest` from the refusal check; require `input.arrival >= '2027-01-01'` only when `!input.allowRealGuest`.
   - `L152` (`runCloudPaneAttach`): replace `{ guestName: 'Proof Labtest', arrivalDate: input.arrival }` with `{ guestName: input.guestName, arrivalDate: input.arrival }`.
4. `apps/server-pilot/tooling/hms-cloud/labtest-record.mjs`:
   - `L36-71` (`currentLabtestDocumentRecord`): parameterize `expectedFirstName`, `expectedLastName`, and `allowRealGuest` (`L42` `arrival >= '2027-01-01'`, `L66-70` `'Proof'`/`'Labtest'`).

### D. Amend (`U3` — starting from PR `#987` head `19c0cf1860bc11fadc138f779a1fe5dc20c2d156`)
1. `apps/server-pilot/tooling/hms-cloud/pane-amend-session.mjs`:
   - `L329-332` (**P1 second-Save bug**): Before `const secondSave = await saveAmendedLabtestStay(..., retainRate.matches)`, verify `unchangedLabtestRecord(postAvailability, retained, allowedRetainDelta)` and `oneNightRetainReadbackMatches(input.approvedPrices, retained, selected, changes)` (generalized to multi-night `retainReadbackMatches`).
   - `L354-360` (`admitsCloudPaneAmend`):
     - Remove `selected.firstName === 'Proof' && selected.lastName === 'Labtest'` when `input.allowRealGuest === true`.
     - Replace `isOneNightRetainAmend` (`departure - arrival === 86_400_000`) with multi-night support (`departure > arrival`, checking `nightlyPrices` across all stay nights).
     - Generalize `matchesCloudPaneAmendSave` and `unchangedLabtestRecord` to use `selected.firstName` and `selected.lastName` instead of hardcoded `'Proof'` / `'Labtest'`.
2. `apps/server-pilot/src/ai/pane-cloud-amend.ts`:
   - `L95-101` (`cloudAmendPreimage`): when `allowRealGuest` (`PANE_WRITE_AMEND === 'on'`), allow real guest names and `arrival >= todayIso` (instead of `'Proof'`/`'Labtest'` and `'2027-01-01'`).
   - `L105-115` (`cloudAmendFirstPilotScopeSupported`): allow multi-night stays (`departure > arrival`) and real arrival dates when `allowRealGuest` is true.
3. `apps/server-pilot/src/ai/pane-cloud-amend-readiness.ts` (`L10-12`) & `apps/server-pilot/src/ai/pane-cloud-amend-runner.ts` (`L16, 174`):
   - Allow `env.PANE_WRITE_AMEND === 'lab' || env.PANE_WRITE_AMEND === 'on'`.

---

## 3. Execution DAG, Parallelism & Calibrated ETAs

### Tranche 1: Real-Email Pilot Launch (120–165 min wall clock)
```
U0 (20m): Merge policy patch (.claude/worktrees/agent-a8d639a6e94efe62b) + rescope hms-labtest-dispatch.ts to per-target lock & real guest names
   ├──► U1 (65m): Create (Single + Multi-room) real-guest & real-date cutover + guarantee expansion
   ├──► U2 (45m): Filing (attach_document) real-guest & PANE_WRITE_ATTACH=on cutover
   └──► U3 (65m): Amend (#987) 15-line second-Save P1 fix + multi-night + real-guest/PANE_WRITE_AMEND=on cutover
           │
           ▼
U4 (35m): Merge U1+U2+U3 -> 1 remote-typecheck.sh (mail + server-pilot) -> ops-deploy.sh -> set PM2 prod flags -> 1 live canary proof
```

### Tranche 2: Fast-Follow Coverage Expansion (run immediately after U4)
- **U5 (75–90m):** New Guest Profile creation inside `guest-profile.mjs` (`New` button in `LVGUESTS` picker when `searchGuestProfiles` returns `no_match`). Unblocks first-time guests who don't yet have an `HRCEN` profile ID.
- **U6 (90–120m):** Saved-stay Room/Rate Shop popup in `pane-amend-session.mjs` (per `apps/server-pilot/tooling/hms-cloud/guest-stay-amend-date-room-rate.md`). Unblocks rate-plan / room-rate re-shopping on saved stays without `retainRates=yes`.

### Production PM2 Flag Cutover in `U4` (`http`, `worker`, `ai-worker`, `remote-http`):
- **Prefill / Lookup / Quote / Party:**
  - `HMS_PREFETCH_ENABLED=1`
  - `HMS_JOB_QUEUE=on`
  - `HMS_AVAILABILITY_PREFETCH=on`
  - `HMS_QUOTE_PREPARE=true`
  - `PARTY_MATCH_V2=true`
  - `HMS_PREFETCH_PER_HOUR=60`
  - `HMS_GUEST_PREFETCH_PER_HOUR=60`
  - `HMS_AVAILABILITY_PER_HOUR=60`
  - `HMS_QUOTE_PREPARE_PER_HOUR=60`
- **Human-in-the-loop Writes (after `Go` click):**
  - `PANE_WRITE_CREATE=on`, `PANE_HMS_LAB_CREATE_WORKER=on`
  - `PANE_WRITE_ATTACH=on`, `PANE_HMS_LAB_ATTACH_WORKER=on`
  - `PANE_WRITE_AMEND=on`, `PANE_HMS_LAB_AMEND_WORKER=on`
  - `PANE_WRITE_CANCEL_UNPAID=on`
