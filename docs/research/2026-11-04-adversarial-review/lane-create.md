# Create audit — 2026-11-04

**Verdict:** Go does not reuse Prepare’s HMS form. Create batch is wired, but main Create is not price-ready; PR #1000 adds that path with a broken request matcher. Static audit only.

- Baseline: clean snapshot `/tmp/advrev-main` at `1e2b2f7a0`; PR #1000 ref `ea70d728`.
- No code edits, tests, HMS/EC2/browser access, or PR actions. Every finding below is static code/doc evidence.

## 1. Prepare → Go opens a fresh draft; it does not reuse Prepare’s form

| Step | Finding | Evidence |
|---|---|---|
| Prepare | `previewPaneCloud` calls Create loader in prepare mode, then stores approval grant, request digest and screenshot—not a browser/page handle. | `apps/server-pilot/src/ai/pane-cloud-preview.ts:497-574` |
| Go | `commitPaneCloud` validates grant then invokes Create loader again in commit mode. | `apps/server-pilot/src/ai/pane-cloud-preview.ts:583-754` |
| Browser | Each Create call uses `withBookingLookupSession`; it opens a new Guest Stay page, reselects guest and restages fields. | `apps/server-pilot/tooling/hms-cloud/create-reservation.mjs:368-405`; `booking-lookup-session.mjs:558-589` |
| Save | Commit stages, rereads form, checks approved request digest, then calls protected Save and does fresh readback. | `create-reservation.mjs:531-597,628-678,685-738` |

**Meaning:** approval binds request intent, not a persistent HMS draft. Go replays it in a fresh browser session. Save/readback is still protected. `pane-cloud-preview.ts:632-650,728-745`.

## 2. Availability seam exists, but production Create does not use it

- `saved-stay-save-route-chain.mjs` has optional `availability` phase, exact request/frame/scope checks, one continuation, and `waitForAvailability`. `:25-40,103-135,198-207,298-304`.
- Production callers are Create Save, Amend, and shared Amend Save (including contact amend); none passes `availability`. The similarly named `guest-stay-amend-availability.mjs` is separate. `guest-stay-save.mjs:733-741`; `guest-stay-amend.mjs:73-82`; `guest-stay-amend-contact.mjs:10-12`; `labtest-amend-save.mjs:109-120`; `guest-stay-amend-availability.mjs:52-66`.
- Only test configures the optional phase. `saved-stay-save-route-chain-dispatch.test.mjs:167-205`.
- Main Create never clicks Check Availability. Blank `averagerate` blocks commit; Prepare returns `needs_input` for `room.ratePlanAvailability`. `create-reservation.mjs:591-597`.
- PR #1000 clicks it in rate-plan selection, captures result, and requires that result for Prepare. `@PR #1000 guest-stay-rate-plan.mjs:435-448,486-520`; `create-reservation.mjs:398-400,532-568`.

**Can Go-time replace Prepare-time check?** Yes, but it does not remove the shared read-only guard exception: availability path is classified as blocked. It only moves one exact, one-shot authorization into Go’s fresh session. The existing save-chain phase alone cannot override the earlier shared guard; its fence also currently covers Save path only. `playwright-quote/hms-read-only-guard.mjs:39-45,52-63`; `guest-stay-save.mjs:729-741`.

- Rough cost using save-chain seam: **40–70 LOC** across `create-reservation.mjs`, `guest-stay-save.mjs`, and route-chain/fence wiring. Need invoke availability after rate-plan stage, allow exact request on same active frame, read fresh rate, then build/check Save body against post-availability form. Existing chain has dispatch guard but no production caller. `create-reservation.mjs:531-597,638-665`; `saved-stay-save-route-chain.mjs:103-135,198-207`; `guest-stay-save.mjs:730-741`.
- Price tradeoff: Go-time means no HMS-rated nightly/total visible before Go/Save. Quote comparison table has nightly/total, but Create card’s rate chip is status/claim only—not the fresh HMS rate. `quote-workflow-panel.tsx:1319-1344`; `booking-card.tsx:173-195,1841-1846`.
- Safer staff choice: keep price in Prepare, or if rate check moves to Go, pause before Save and let staff review new HMS price. One-shot path gate must bind active frame/session + staged guest/dates/room/rate and consume exact request once; path-only allow is too broad. `saved-stay-save-route-chain.mjs:103-135,198-207`.

## 3. PR #1000: Create behavior vs guard/matcher burden

| PR #1000 files | Diff | Create relevance |
|---|---:|---|
| `guest-stay-rate-plan.mjs` | +172/−4 | Availability click/result is core; giant request-shape matcher is brittle. |
| `booking-lookup-session.mjs` | +37/−4 | Scoped one-shot authority is needed if shared guard remains; startup/session checks are useful. |
| `create-reservation.mjs` | +30/−4 | Stage, invoke and require verified rate; core. |
| shared read-only guard | +13/−1 | Exact one-shot exception needed for blocked POST; scope must stay narrow. |
| `lookup.mjs` | +8 | Startup settled/page-property assertions; robustness, not rate behavior. |
| **Total** | **+260/−13** | `git diff --stat` at PR ref. |

- Candidate matcher hardcodes **112** request fields and case-folds field names for uniqueness. `@PR #1000 guest-stay-rate-plan.mjs:13-15,247-286`.
- Recovery plan records actual request has **1,112 pairs** and two case-variant pairs. Thus 112 rejects actual request; correcting count alone still rejects valid case variants. `docs/plans/2026-11-04-001-feat-m1-recovery-plan.md:85-99`.
- Guard exception is a one-use WeakSet of exact Request objects, restricted to POST, exact HMS origin/path, no query/hash. That is materially different from approving every Check Availability POST. `@PR #1000 hms-read-only-guard.mjs:53-65`; `booking-lookup-session.mjs:557-584,608-611`.
- **Keep:** rate-check action + response/rate readback; a narrow exact-request authorization; fresh Save-body verification after rate updates. **Cut/replace:** fixed 112 count and case-insensitive uniqueness rule. A staged-form-bound, one-shot gate is smaller than enumerating 1,112 pairs, but still must validate active form context and returned rate. `@PR #1000 guest-stay-rate-plan.mjs:247-286,435-448,486-520`; `guest-stay-save.mjs:733-741`.

## 4. Refusal/guard grep and likely booking blockers

Broad lexical grep hits across requested files: **91 lines** total. Counts are hits, not unique branches; `reason:` values and guard prose also match.

| File | Hits |
|---|---:|
| `create-reservation.mjs` | 11 |
| `pane-cloud-preview.ts` | 44 |
| `pane-create-cloud-input.ts` | 33 |
| `guest-stay-save.mjs` | 3 |
| **Total** | **91** |

| Rank | Likely blocker or gap | Evidence / distinction |
|---:|---|---|
| 1 | Real guest Create needs mode `on` and `PANE_WRITE_CREATE=on`; plan records installed mode `lab` (not live-verified here). | `pane-cloud-preview.ts:115-124`; recovery plan `:77` |
| 2 | Childless stays: pane omits empty `childAges`; mapper requires array, likely universal adults-only refusal. | `pane-stay-bind.ts:400-403,420-444`; `pane-create-cloud-input.ts:85-96` |
| 3 | No HMS average rate: Prepare asks for `room.ratePlanAvailability`; commit stops. | `create-reservation.mjs:591-597` |
| 4 | Guest profile missing/ambiguous: commit needs explicit native profile ID. | `pane-cloud-preview.ts:522-535`; `create-reservation.mjs:187-199` |
| 5 | Required source/guarantee/adult fields absent or unsupported. | `pane-create-cloud-input.ts:85-96` |
| 6 | Company/agency booking lacks selected native party ID/name. | `pane-create-cloud-input.ts:103-122` |
| 7 | Display label supplied where native room/rate codes required. | `pane-create-cloud-input.ts:95-96` |
| 8 | Required reservation note absent/invalid; pane only sends nonblank note. | `pane-create-cloud-input.ts:91-96`; `pane-stay-bind.ts:427-444` |
| 9 | Invalid stay dates / arrival not before departure. | `pane-create-cloud-input.ts:85-96`; `create-reservation.mjs:532-538` |
| 10 | Approved HMS confirmation-on case is impossible today: pane forces send off; mapper refuses `true`. Create may proceed, but requested guest CMS send will not happen. | `booking-card.tsx:990-991,1075,1347-1367`; `pane-create-cloud-input.ts:56-57,148-149,205-206` |

## 5. CMS confirmation enablement

**Estimate: 35–60 production LOC across 4 files.** Owner approval for real creates is supplied in task context; keep tests off.

| File | Change | Rough LOC |
|---|---|---:|
| `apps/mail/components/quote-workflow/booking-card.tsx` | Stop forcing Cloud send false; retain staff choice and make “HMS sends confirmation” state explicit. | 3–8 |
| `apps/server-pilot/src/ai/pane-create-cloud-input.ts` | Accept true only with valid recipient; map approved CMS send intent. | 8–12 |
| `apps/server-pilot/tooling/hms-cloud/create-reservation.mjs` | Permit true, toggle/verify send checkbox, keep recipient binding. | 12–20 |
| `apps/server-pilot/tooling/hms-cloud/guest-stay-save.mjs` | Match/read back checkbox-on Save body; preserve no-send path. | 12–20 |

Existing pane payload and route already carry `confirmationSendMail`; no new schema or binding file expected. `pane-stay-bind.ts:132-152,404-442`; `quote-workflow.ts:314-320,358-372`. Current backend forces CMS false and Save matcher expects `udfchkbox04:'0'`. `create-reservation.mjs:40,45-49,510`; `guest-stay-save.mjs:315-316,549-579,621-637`. Tests must keep send off per product rule.

## 6. Sequential 1–8-room Create is wired on main

- Pane commits rooms serially; batch starts only for 2–8 rooms. `booking-card.tsx:1571-1625`.
- Route passes `batch` into `commitPaneCloud`; server validates batch size/manifest and verifies earlier confirmations for continuation. `quote-workflow.ts:358-372`; `pane-cloud-preview.ts:103-105,355-430`.
- Each room is still an individual fresh-session Create/Save/readback, not one native linked group transaction. Stop/report on partial or uncertain result; no blind retry. `pane-cloud-preview.ts:632-650,728-745`; `booking-card.tsx:1619-1625`.

## FASTEST PATH TO WORKING CREATE

1. Fix empty `childAges` binding/validation mismatch. **~3–8 LOC.** `pane-stay-bind.ts:400-403`; `pane-create-cloud-input.ts:85-96`.
2. Fix rate availability matcher: 1,112 actual pairs; accept legitimate case variants; retain exact one-shot, active-form-bound guard. **~20–40 LOC** focused matcher/guard adjustment. `@PR #1000 guest-stay-rate-plan.mjs:247-286`; recovery plan `:85-99`.
3. Run Check Availability in Prepare and verify returned rate; keep rate visible before staff Go. **~20–35 LOC** in rate helper/Create mapping, excluding matcher fix. `@PR #1000 guest-stay-rate-plan.mjs:435-448,486-520`; `create-reservation.mjs:591-597`.
4. Show numeric HMS nightly/total on Create card and bind it to approved draft. **~10–20 LOC.** `booking-card.tsx:173-195,1841-1846`; quote table reference `quote-workflow-panel.tsx:1319-1344`.
5. Enable approved CMS confirmation path and preserve off in tests. **~35–60 LOC / 4 files** listed above.
6. Verify current deployed mode and effective process flags before claiming real Create enabled; installed mode claim is plan-only, not runtime proof. **No LOC; runtime check required.** `pane-cloud-preview.ts:115-124`; recovery plan `:77`.

### CUT — plan U2 items not needed for working Create

- **U2.2 same-draft inputs:** cut; Prepare and Go deliberately use fresh sessions; digest + restaging/readback is current model. `pane-cloud-preview.ts:564-574,640`; `create-reservation.mjs:368-405`.
- **U2.3 replacement availability provider / exhaustive 1,112-field matcher:** cut; use native button + narrowly scoped one-shot gate, but fix actual matcher. `@PR #1000 guest-stay-rate-plan.mjs:247-286,435-448`.
- **U2.4 new quote/pricing engine:** cut; display returned HMS rate/total; do not calculate separate pricing eligibility. `create-reservation.mjs:591-597`; `PRODUCT.md` (pricing/source-of-truth rule).
- Keep only U2's necessary Create result: verified HMS rate visible before Go and bound to exact approved request. Recovery plan `docs/plans/2026-11-04-001-feat-m1-recovery-plan.md:156-170`.

**95 threshold:** met for static code control flow and wiring; runtime flags, installed pane interaction, and live HMS Save/readback remain unverified by design. **Route:** local repository snapshot + PR ref; no web or live systems.
