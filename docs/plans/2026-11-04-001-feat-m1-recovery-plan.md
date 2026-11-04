---
title: HRCEN four-workflow autonomous recovery
date: 2026-11-04
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md
---

# HRCEN recovery — execution plan

## Goal Capsule

Selected inbound email/PDF → editable staff inputs → native HMS Prepare and facts/price → staff Go → protected Save → independent fresh readback. Ship Create, Filing, Cancel, Amend independently on deployed main with workflow admission `on` in all four PM2 processes. Preserve Quote/triage and existing multi-room Create. Merged code, enabled flags without proof, and adult-only Amend primitives are insufficient.

Execution began 2026-11-04 03:17:06 UTC. +210 min checkpoint 06:47:06 UTC; no hard stop. Owner approved planning, implementation, PR/review/merge/deploy, unsaved real staging, Labtest writes and proven workflow flags. Original shared plan/candidate worktrees remain untouched; this isolated copy supersedes their contradicted implementation decisions for this run.

## Product Contract

Product Contract preservation: existing R1–R11 IDs retained. R6 now includes all owner-approved supported Amend fields; R3/R6 CMS follows current PRODUCT.md rather than earlier manual-CMS cut. Current owner rules override stale plan wording.

| ID | Required behavior |
|---|---|
| R1 | Selected email/PDF prefill, supported edits, invalidate stale source/results/approvals. |
| R2 | Preserve existing HMS Quote/prefill; no replacement provider or pricing engine. |
| R3 | Existing-profile Create: stay/party/guarantee/note/CMS → Check Availability → HMS price → staff Go → native Save → fresh confirmation/readback. Missing profile remains manual HMS. |
| R4 | Preserve sequential 1–8-room Create, saved confirmations/partial/uncertain outcomes. |
| R5 | PDF Filing to exact verified stay; editable surname/arrival search + ambiguous-row selection; fresh Documents readback. |
| R6 | Supported dates/nights, room, adults/children/ages, rate plan, guest details and CMS Amend; native repricing/options → staff Go → fresh requested-field readback. |
| R7 | Exact current source/target/authorization, duplicate protection, durable target hold, once-only dispatch, truthful uncertainty. |
| R8 | Both shared pane surfaces; existing controls/plain-language results; no terminal tasks for staff; Nava only saves unsent drafts. |
| R9 | HMS supplies prepared/final price; no numeric overrides/accounting or exact-price eligibility engine. |
| R10 | Cancel reason/native facts; charge/penalty shown; accepting native charge requires separately bound second staff Go. No NGI/deposit/payment-classifier veto. |
| R11 | Release each proven workflow independently; unfinished lane does not hold an already-ready lane. |

CMS is editable/default on for real staff Create/Amend: send flag, message ID, recipient. Proof Labtest always off. Normal email/A/R/guarantee-card values and blank track are legitimate real booking data.

## Planning Contract

### Verified baseline and corrections

- Fetched origin/main `70f42e7c8c563f92ed99ad13b4d15e8634730853`. Root is dirty at `6bb282a`, 44 behind; no product/deploy execution from it.
- PR #1000 `ea70d728381f32228e617c510e264eb7768ee3a8` open: reuse startup wait + scoped one-shot availability; delete count/body enumeration.
- 810e clean `64d1caf57`: port connected Cloud Cancel, strip native and TS payment vetoes. ee01 `b44f134fe` has 73 dirty paths: port relevant dirty Amend implementation, original preserved.
- Durable create/saved target keys already exist. Caller adoption remains work; no new concurrency-fence design.
- Create average-rate hard refusal already main; Check Availability is required staging, not a hypothesis.
- Adults-only DTO omits empty childAges; real unsaved preview wrongly depends on Create write flag `on`. Fix both before live proof; do not bypass canary by enabling flags first.
- Shared saved-record email/CMS/A/R/card/track guards and whole-record/request equality reject real inputs/vendor refresh. Replace with business-field/identity checks; keep meaningful source/approval binding.
- Current-main writer supports `--m1-only`, genuine per-workflow deployed-SHA canary. Current-main ops-deploy requires clean HEAD=origin/main. Stale root scripts are not runtime authority.

### Ownership and dependencies

| Owner/model | Worktree and exclusive seams |
|---|---|
| Coordinator/current | `/home/orca/.codex/worktrees/b984/zero`; labtest-record/party-fields, pane-hms-write, ai+hms-approval route, worker/ledger/dispatch integration, shared amend-find if needed; plan/check/review/merge/deploy/proof/flags. |
| A Create/Terra max | `/home/orca/.codex/worktrees/5651/zero`; pane-stay-bind/booking-card, Create mapper/preview/batch, guest-stay-save/request-binding/readback/rate-plan/lookup guard; pane-stay-save price types. |
| B Filing/Terra max | `/home/orca/.codex/worktrees/b46e/zero`; voucher-find-card, actual nava-pane/blocks/booking-voucher-card, pane-attach-session, pane-cloud-attach-recovery. |
| C Cancel/Terra max | `/home/orca/.codex/worktrees/8208/zero`; Cloud Cancel/session/native/recovery/association/route, mail amend-cancel; shared client approve-card and hms-write (other lanes request edits through C). |
| D Amend/Terra max | `/home/orca/.codex/worktrees/33e5/zero`; Cloud Amend/runners/session/native/preimage/save-route-chain; saved-stay editor/amend-lookup. Shared server routes through coordinator, shared native Create Save through A, client approval through C. |
| Research/Luna max | Read-only runtime/source/proof-command audit; no independent deployment/write owner. |

Four lanes run concurrently; coordinator fixes shared record contract once. Land prerequisite with first ready connected Create/Filing PR, share exact prerequisite commits/contracts across dependent branches without competing writers. Separate connected workflow PRs; bundle coincident ready slices, otherwise release first ready slice. Reads/previews in separate sessions; serialize same-stay writes.

### Targets and reforecast

These are checkpoint targets, not calibrated P50/P80 completion estimates: +15 min plan/contracts/worktrees; +30 min shared prerequisite + candidate code progress; +60 min first priced real Prepare and connected candidates; +90/+120 min first independent release/proof; +150/+180 min follow-on release/proof; +210 min full-scope completion audit or missed-target retro. Native full-delivery ETA remains unknown until first observed current integration proof. State actual elapsed/milestone, external queue and revised critical path; never invent forecast precision.

## Global Constraints

No new tests, whole-body/key/count pins, field-mapping campaigns, accounting eligibility, numeric overrides, admin clicking, new OCR/profile flow, broad refactor, Actions, hooks bypass, destructive Git/DB/volumes. No pilot RDS tests. Agents never Save real guests or send mail. Preserve existing other-session changes and old uncertain holds.

## Autonomous Execution Mandate

Binding launch brief: `/home/orca/zero-recovery-2026-11-04-0303/GOAL.md`. Continue implement → RCA → focused checks/review → gate → deploy → proof → canary → effective flags until all four actual done criteria hold. Ordinary reversible decisions need no further approval. Missing human-only access/safety conflict/external outage can block affected work; ordinary code/test/deploy failures trigger RCA. No clock-based completion or narrowing scope.

Coordinator updates `/home/orca/zero-recovery-2026-11-04-0303/STATE.md` every ~10 min/after milestones/before compact. Every +30 min compare actual vs plan; missed milestone → short cause/assumption/correction/reforecast retro + continue. Early verified finish → report. After compact re-read brief/state/plan and verify real Git/PR/process/write state before first incomplete action. Caveman Ultra everywhere except code/PR text.

## Implementation Units

### U1. Pin release, sources, ownership and common guards

- Owner: coordinator. Requirements: R1/R7/R11. Dependencies: none.
- Files: shared labtest-record/party-fields, current runtime/PR/worktree inventory, this plan.
- Approach: exact target/native IDs; real email/CMS/parties/blank-track accepted; Labtest admission/CMS-off retained. Replace full body/record equality with relevant business fields/requested changes. Shared contract includes preserved CMS flag/message/recipient/email. Own shared files once.
- Patterns: main hms-dispatch-target + advisory/sealed-intent dispatcher; existing record reader.
- Test expectation: no new tests; existing shared-record/body/guarantee checks only. Verification: syntax/focused checks, contracts sent to dependent lanes, old hold retained.

### U2. Finish connected Create

- Owner: A. Requirements: R1/R3/R4/R7–R9/R11. Dependencies: stable U1 contract; independent UI/native coding starts now.
- Files: A ownership table/brief. Approach: childAges always array; lab permits unsaved real preview with trusted Prepare context; #1000 availability gate/startup only; staff CMS end-to-end; no SHA/body pins; native average/total shown.
- Patterns: proven legacy startup → guest/dates/occupancy/parties/rate → availability → business validation → Save/readback.
- Test expectation: no new tests; existing changed Create/session/guard checks. Verification: actual real-email priced Prepare unsaved; U5/U6 deployed Labtest Create + independent confirmation readback.

### U3. Finish connected Filing

- Owner: B; shared approval/schema coordinator+C. Requirements: R1/R5/R7/R8/R11. Dependencies: U1 boolean CMS snapshot.
- Files: B ownership. Approach: editable surname/arrival, existing search/find, verified row selection, sourceHash/selectionEpoch key, current bind gate/uncertain freeze. Preserve actual CMS boolean and recovery compat (old hold defaults false), never globally require CMS off for real stays.
- Patterns: existing amend-find/search, attach/PDF-source binding/ApproveCard/Documents.
- Test expectation: no new tests; existing voucher/approval/attach checks. Verification: real PDF/target unsaved preview; deployed one Labtest upload + fresh Documents exact target/document.

### U4. Resolve normal-source proof inputs and independent promotion

- Owner: coordinator + researcher. Requirements: R7/R11. Dependencies: existing runtime/source access; no new deploy framework.
- Files: existing backend runners/operator helpers/writer/ops wrappers; no new product framework.
- Approach: derive exact final-candidate argv/payload/session from real entrypoints; use actual inbound email/PDF and existing profile/stay. Inspect a290e545 held date/work item; choose distinct 2027 Labtest targets. Confirm installed SHA/health/flags before writes. Resolve helper command gaps before invoking them; never invent CLI flags or receipts.
- Test expectation: none—read-only setup. Verification: each lane has exact normal-source Prepare and eligible Labtest operation command; flags gated independently.

### U5. Check/review/land/deploy each ready workflow

- Owner: coordinator + independent reviewer. Requirements: R7/R11. Dependencies: corresponding U2/U3/U7/U8 final candidate, U1 shared integration.
- Files: included diff/current-main merge-gate/ops-deploy. Approach: inspect final diff; affected final clean-head remote typecheck; existing focused checks; Apex final PR head/fallback promptly if stalled; fix valid P0/P1. Merge exact head via current-main gate, deploy clean fetched main using its own bundle wrapper.
- Test expectation: no new tests. Verification: actual commands green, final-head review, merge/runtime/Mail identities/health. Do not repeat identical passing checks without a changed source/dependency/concern.

### U6. Deployed persistence proof and workflow flags

- Owner: coordinator, lane owner assists RCA. Requirements: R1/R3–R11. Dependencies: deployed corresponding U5 slice; U4 verified source/target.
- Approach: real inbound Prepare without Save; one deployed Proof Labtest operation + fresh independent readback. Then genuine deployed-SHA CANARY PASS receipt, supported writer/restart, effective admission all four PM2 processes. No real agent Save, fake/stale canary, blind uncertain retry, or numbered probes.
- Test expectation: existing targeted checks only. Verification: exact outcome and readback, live SHA, all-process flags, staff Go connected. Each completed workflow promotes independently.

### U7. Finish connected Cancel including second Go

- Owner: C; shared server integration coordinator. Requirements: R1/R7/R8/R10/R11. Dependencies: U1 shared record, U4 proof setup.
- Files: C ownership + requested coordinator hunks from 810e. Approach: adopt existing durable-target/session path; remove TS/native NGI/deposit/apply-policy vetoes; native facts/penalty text and separate dialog/target-bound charge approval. Native status can change before penalty dialog: preserve hold/truthful status/reconcile, never silently accept/retry.
- Test expectation: no new tests; existing Cancel/approval/native checks. Verification: real unsaved cancellation input; deployed one Labtest cancellation/fresh status; charge second-Go path verified by applicable existing/native evidence, unexercised native branch disclosed.

### U8. Finish connected supported Amend

- Owner: D; shared server coordinator/client C/native Save A. Requirements: R1/R6–R9/R11. Dependencies: U1/U4; own code parallel.
- Files: relevant dirty ee01 + D ownership. Approach: preserve native target/preimage; expected business fields instead of whole-key draft equality; allow tax/rate refresh; supported requested fields/CMS/native price/options/approval/save continuations/readback.
- Test expectation: no new tests; existing Amend/editor/native/save-route checks. Verification: actual real-email supported Prepare unsaved; deployed representative date/room/rate/occupancy amendment/fresh requested fields. Adult-only success insufficient.

## Verification Contract

Before tests: unset DATABASE_URL, VITEST_ALLOW_PILOT_RDS, TEST_DATABASE_URL. At most three local runs across harnesses; ~20% headroom. DB-backed checks without safe disposable DB report skipped. No local tsc/tsgo or broad lint/format.

- Remote typecheck: `bash /home/orca/bin/remote-typecheck.sh <clean-worktree> --app <mail|server-pilot>` on final affected head. Same SHA/app evidence reusable; SKIP_TYPECHECK=1 only after matching pass for duplicate remote-vitest.
- Create CLI: `node apps/server-pilot/tooling/hms-cloud/create-reservation.mjs < reviewed-request.json > result.json`, mode prepare unsaved, mode commit Labtest-only. U4 resolves authenticated final contract/input.
- Filing/Cancel/Amend: U4 records exact existing programmatic/session/route runners from final source before writes. Missing normal entrypoint is implementation/setup work, not permission to substitute legacy bypass.
- Review/gate: Apex each final PR head or independent fallback; current-main `bash scripts/orch/merge-gate.sh <pr-number>` exact-head merge. Current gate checks unresolved P0/P1 threads; no obsolete private gate-receipt assumption.
- Deploy: clean fetched origin/main `apps/server-pilot/deploy/ops-deploy.sh`; bundle backend+Mail; verify SHA/Mail identity/health.
- Canary: `CANARY PASS <create|attach|cancel|amend> HRCEN <40-char-deployed-sha>` only after deployed Labtest persistence+fresh readback. Default /tmp/mh1024/CANARY.txt; inspect actual writer transport. `write-ec2-remote-env.sh --m1-only` + ops-restart. Inspect unified/paid/unpaid consumers; verify flags in http/worker/ai-worker/remote-http. Preserve unrelated env.

## Definition of Done

All four current PRODUCT workflows: real inbound unsaved Prepare correct; deployed main persistence/readback proven via eligible Labtest; intended flags on all four processes; shared pane staff Go reaches protected native workflow. Required supported fields/CMS/price/target/second-Go behavior complete; exact uncertainty/partial results preserved. Required final-head checks/reviews pass. Report skipped checks and material evidence limits; never label unexercised Outlook host or charge path as observed.

Delivery report: elapsed/forecast delta, installed SHA/Mail identity, PR links, each workflow Prepare/readback/flags, state/plan links, metered model $ if available, exact remaining blocker if incomplete. Missing 210-min target produces short RCA retro + revised plan and continued autonomous execution.
