# Cancel and Amend audit

**Verdict: Cancel was cut from M1, not abandoned as a product workflow. Agent plan made optional launch cut; current owner scope excludes it from M1, not forever.**

Read-only audit: deployed snapshot `/tmp/advrev-main` = `1e2b2f7a0`; candidate worktrees read only. No tests, HMS, EC2, or worktree changes. Local evidence only.

## 1. Cancel left first tranche by scope, not impossibility

| When | Evidence | Finding |
|---|---|---|
| Historical owner contract | [`PRODUCT-ASKS-HISTORY.md:21–25`](</home/ubuntu/projects/zero/PRODUCT-ASKS-HISTORY.md#L21>) says Cancel was “lab only until owner says otherwise.” | Not a forever product rejection. |
| Nov 3, plan 002 | [`plan 002:33,47,56`](</home/ubuntu/projects/zero/docs/plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md#L33>) put Unpaid Cancel in Tranche 1; R6 said connect it, while never accepting a penalty dialog. Contract note says owner approved “Unpaid Cancel.” | Earlier plan included it; it did not fail because no native cancel existed. Exact NGI/folio criteria are not an owner quote. |
| Nov 3, Option A handoff | [`ship-now-steer.md:4–5,13–14`](</home/ubuntu/projects/zero/docs/context/HANDOFF-2026-11-03-option-a-ship-now-steer.md#L4>) calls its steer “recommended” and “Not yet sent”; proposes freezing Cancel NGI-only. | Agent recommendation, not fresh owner authorization. |
| Nov 3, plan 003 | [`plan 003:16,43,48`](</home/ubuntu/projects/zero/docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md#L16>) narrows M1 to Quote/Create/Filing/prefill; says Cancel may continue after Filing. Exact sentence: **“This is an optional launch scope cut, not evidence that cancellation is inherently difficult or impossible.”** | Agent-authored plan language cut it from launch scope. |
| Current owner scope | [`PRODUCT.md:19,27–28`](</home/ubuntu/projects/zero/PRODUCT.md#L19>) now says keep Amend/Cancel out of M1 resources/dependencies; Cancel is “optional follow-on.” | Owner’s current M1 boundary is binding. Does not drop Cancel forever. |

**Attribution:** original optional cut was made in plan 003; current owner scope adopts the M1 exclusion. No source says owner rejected Cancel as a future product capability.

## 2. Deployed main has Cancel UI/route, but HRCEN path hard-refuses

| Layer | Deployed main (`1e2b2f7a0`) | Meaning |
|---|---|---|
| Pane UI | [`amend-lookup-panel.tsx:668–681`](</tmp/advrev-main/apps/mail/components/quote-workflow/amend-lookup-panel.tsx#L668>) mounts Cancel section; existing Preview/reason/Go controls are in `:1210–1275`. | UI exists; same shared pane path. |
| Route | [`pane-stay-cancel.ts:49–76`](</tmp/advrev-main/apps/server-pilot/src/trpc/routes/pane-stay-cancel.ts#L49>) exposes `previewCancel`, `commitCancel`, screenshot. | Route exists. |
| HRCEN refusal | [`pane-stay-cancel.ts:301–303`](</tmp/advrev-main/apps/server-pilot/src/ai/pane-stay-cancel.ts#L301>): “This legacy path has no durable target hold”; line 303 returns `refused_legacy_cancel_unavailable`. Queue path also refuses at [`pane-hms-write.ts:986–990`](</tmp/advrev-main/apps/server-pilot/src/ai/pane-hms-write.ts#L986>). | Deliberate target-write safety hold; no HRCEN native Cancel dispatch on main. |
| Native code | Old Playwright cancel CLI exists. HMS Cloud `guest-stay-cancel.mjs` is fake Labtest contract: [`guest-stay-cancel.md:1–24`](</tmp/advrev-main/apps/server-pilot/tooling/hms-cloud/guest-stay-cancel.md#L1>). | Native mechanics exist, but Cloud tool on main authorizes fake test stay only. |
| Cloud preflight | [`cancellation-preflight-session.md:19–28`](</tmp/advrev-main/apps/server-pilot/tooling/hms-cloud/cancellation-preflight-session.md#L19>) allows read + pure prepare only; says it is **not wired** into provider/pane. | Not a hidden working HRCEN cancel route. |

## 3. 22ad Cloud Cancel candidate has Save/readback code, no candidate success receipt

| Snapshot | Head / last Cancel commit | Dirty paths |
|---|---|---:|
| `22ad` integration | HEAD `258e671f0`; latest Cancel commit `453a8930a` (“bind unpaid Cancel dispatch and durable pane outcomes”) | **42** |
| `810e` U2 clean candidate | HEAD `64d1caf57` (“bind unpaid Cancel dispatch and durable pane outcomes”) | **0** |

Candidate core in [`22ad`](</home/orca/.codex/worktrees/22ad/zero/apps/server-pilot/src/ai/pane-cloud-cancel.ts>):

| File | LOC | Role |
|---|---:|---|
| `src/ai/pane-cloud-cancel.ts` | 406 | Source-bound preview, staff Go/queue, exact target approval, dispatch/outcome. |
| `src/ai/pane-cloud-cancel-recovery.ts` | 110 | Uncertain-save recovery/readback. |
| `tooling/hms-cloud/pane-cancel-session.mjs` | 205 | Native session, protected Save and fresh readback. |
| `tooling/hms-cloud/cancel-association-scope.mjs` | 247 | Whole-stay/associated reservation scope check. |
| `tooling/hms-cloud/cancel-payment-preflight.mjs` | 409 | **Untracked in 22ad**; added finance/folio/organization eligibility proof. |

UI/source and route edits exist in dirty `22ad`; `pane-stay-cancel.ts` calls Cloud preview/commit. Native runner makes one guarded Save and reads status/reason/note fresh ([`pane-cancel-session.mjs:126–205`](</home/orca/.codex/worktrees/22ad/zero/apps/server-pilot/tooling/hms-cloud/pane-cancel-session.mjs#L126>)). This is substantial code, not a missing-button problem. Still **not ship-proven**: 22ad has 42 dirty paths, and no successful fake Save receipt for this Cloud candidate was found. Nov 3 `/tmp/u2-all-scoped-cancel-native-20261103.json` says `preview_ok`, `requestDispatched:false`; retro says final Cancel effect proof missing ([`REPORT.md:105`](</home/ubuntu/projects/zero/docs/research/2026-11-03-option-a-deep-retro/REPORT.md#L105>).

**Fake Cancel did succeed historically:** HRCEN Labtest DoD5 on old SHA `7dd78a67b`; [`/tmp/mh1024/evidence/dod5-hrcen.md:19–24`](</tmp/mh1024/evidence/dod5-hrcen.md#L19>) records native Cancel + fresh status readback, penalty text recorded but **not accepted**. This proves native cancellation is possible; it does not prove today’s Cloud route. HRDAV DoD5 accepted its test penalty dialog; do not reuse that behavior ([`dod5-hrdav.md:24–25`](</tmp/mh1024/evidence/dod5-hrdav.md#L24>)).

## 4. Financial gates are engineering policy; R10 penalty approval conflicts with PRODUCT

| Gate | Where / measured size | Proven owner ask? |
|---|---|---|
| Unpaid classifier: provisional/reserved + zero deposit + non-paying guarantee | Main [`pane-stay-lookup.ts:180–248`](</tmp/advrev-main/apps/server-pilot/src/ai/pane-stay-lookup.ts#L180>), **69 LOC** incl parse helpers; comment calls it “R7 unpaid amend.” Cancel reuses it at [`pane-stay-cancel.ts:339–366`](</tmp/advrev-main/apps/server-pilot/src/ai/pane-stay-cancel.ts#L339>). | No exact owner quote found for formula. Plan 002 records high-level owner approval of “Unpaid Cancel,” not this classifier’s details. |
| NGI + zero deposit; unlinked/whole-stay scope | Candidate [`guest-stay-cancel.mjs:63–86`](</home/orca/.codex/worktrees/22ad/zero/apps/server-pilot/tooling/hms-cloud/guest-stay-cancel.mjs#L63>); association verifier **247 LOC**. | Fail-closed engineering guards; no direct owner ask found. |
| Folio/deposit/account/organization “unpaid” proof | Candidate `cancel-payment-preflight.mjs`, **409 LOC**, `verifyCancellationUnpaid` at `:301–409`; added as untracked 22ad expansion. | Deep probe/research work, not an explicit owner requirement. Retro says broadening wasn’t needed for narrow launch ([`filing-release-findings.md:19–26`](</home/ubuntu/projects/zero/docs/research/2026-11-03-option-a-deep-retro/filing-release-findings.md#L19>)). |

Current product says HMS supplies financial facts and staff decide; do not build separate accounting eligibility engine ([`PRODUCT.md:32`](</home/ubuntu/projects/zero/PRODUCT.md#L32>)).

**R10 is a direct contradiction/new policy scope:** recovery plan says “A shown cancellation charge requires a second staff approval in Nava before accepting the native dialog” ([`plan 004:52`](</home/ubuntu/projects/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md#L52>)); PRODUCT says **“Never accept a cancellation-penalty dialog”** ([`PRODUCT.md:54`](</home/ubuntu/projects/zero/PRODUCT.md#L54>)). A second Go cannot override that hard rule. Show charge; refuse/manual. If charge appears only after reason Save, effect may already have happened: report uncertain, fresh-read HMS, never click penalty dialog.

## 5. Amend is also held on main; U3 candidate remains dirty

| Area | Finding |
|---|---|
| Main | Amend UI/route exist, but HRCEN preview refuses at [`pane-hms-write.ts:868–872`](</tmp/advrev-main/apps/server-pilot/src/ai/pane-hms-write.ts#L868>) and commit refuses at `:1013–1017`. Reason: legacy UI path lacks Cloud dispatch/recovery guard. |
| Candidate | `ee01` U3 branch: HEAD `b44f134fe`, **73 dirty paths**. `22ad` integration: 42 dirty paths. Candidate modules include `pane-cloud-amend.ts` (301 LOC), runner (281), dispatch (139), `pane-amend-session.mjs` (639), `guest-stay-amend-adults.mjs` (444), `guest-stay-amend-date-room-rate.mjs` (589); shared pane editor is existing. |
| Native proof | Adult-only Save/readback passed on fake three-night stay. Date+adult earlier returned UNKNOWN; 4→3 shortening had positive readback but uncertain result. Same-night-count shift is **not established**; extension probe added night with amount unknown. No deployed UI→route Amend proof ([`REPORT.md:103,117`](</home/ubuntu/projects/zero/docs/research/2026-11-03-option-a-deep-retro/REPORT.md#L103>); [`plan 003:67`](</home/ubuntu/projects/zero/docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md#L67>)). |

## Minimum paths

**MIN CANCEL PATH — estimate 700–900 LOC backend/native if porting from deployed main; reuse UI/route, don’t build finance policy.** Reuse 22ad’s source-bound preview/approval/target hold, exact native Cancel reason request, one Save, and fresh readback (`pane-cloud-cancel.ts`, `pane-cloud-cancel-recovery.ts`, `pane-cancel-session.mjs`, existing `guest-stay-cancel.mjs`). Keep whole-stay scope guard. Drop 409-LOC finance-eligibility module. Existing-pane UI/route need no second panel. Estimate is based on candidate’s ~711 LOC dedicated orchestration/session core plus glue; not completion ETA. Refuse/manual on any penalty dialog; re-read after uncertainty.

**MIN AMEND PATH — adult-only thin slice already has native proof; date scope has no honest LOC estimate yet.** Reuse existing Amend pane, `pane-cloud-amend.ts` + runner/dispatch, `pane-amend-session.mjs`, and `guest-stay-amend-adults.mjs`; keep protected native Save + fresh readback. Existing candidate core ≈1,804 LOC across those listed modules; incremental LOC unknown because date Save contract is unproven. Adult-only is not full M2. Next minimum date slice: prove one supported native date change, wire same approved path, else manual; do not call Amend complete until Product’s date/occupancy/room/rate-plan scope is covered.

**95 threshold:** met for scope, refusal reason, candidate state and historic fake proof; not met for current Cloud Cancel/Amend runtime success. No live/runtime checks allowed or run. Evidence route: local repository/docs/receipts only.

**VERDICT: cancel dropped because agent cut first launch scope; current owner adopted M1 exclusion, not permanent removal (agent → owner).**