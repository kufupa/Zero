---
title: Connected Cloud pilot, final parallel plan (v2, after peer review)
type: feat
date: 2026-11-02
status: ready-for-go
supersedes: 2026-11-02-004 (three-connected-workflows worktree), 2026-11-02-003
evidence: docs/research/2026-11-02-connected-lean-plan-004-adversarial-review.md, docs/research/2026-11-02-plan-005-peer-review.md
---

# Connected Cloud pilot: final parallel plan (v2)

**Goal.** Staff in the webmail side pane, and the Outlook pane on the same bundle, can do six things on a selected mail:
1. triage it, keeping a separate ask even inside pre-stay self-mail;
2. quote;
3. create a single booking: existing or new guest, agency/organization, guarantee, CMS recipient;
4. file a voucher or proof-of-payment PDF into HMS;
5. amend dates, occupancy and the retain-rate choice;
6. book several rooms, of one or more room types, with one Go.

Every write goes through Prepare → staff Go → native guard → Save → screenshot → fresh readback.

**Done:** main deployed through the bundle, plus one final fake booking on the deployed code, plus an AI test-walk of each lane in the deployed webmail pane, plus each lane's fake-bridge replay (no Outlook) passing. Owner bar, 2026-11-02. The client tests real Outlook the next day.

**v2 changes:** all 15 peer P1s are accepted, two with a narrower fix. An eighth session (R: replay and new guest) is added. Contract-free work starts at minute 0 rather than after the stubs. G12 moves before the create gate. See §8.

**Execution note, 2026-11-02:** Go was 19:42:15 UK. Shift the §0 clock times forward 12 minutes 15 seconds. The named integrator had diverged from `origin/main` and cannot be fast-forwarded; the run uses a separate clean `pilot-005v2-i-20261102` worktree instead, preserving the original. Follow-up comparison found planned Cloud create code in the old integrator but absent from main, including `paneCreateScopeHold`; its prerequisite integration is held for evidence and normal PR gates. Some old commits may already be squash-merged, so raw divergence is not a count of missing changes. The planner confirmed this prerequisite was omitted from the schedule: selectively port the required net create boundary in one-behavior PRs under the existing product-line and review gates, rather than merge the old branch wholesale. K3 and K7 forecasts need reassessment after the missing slices are sized. C1 also found a possible cross-pane edit after grant consumption and before native dispatch in the old integration code; retain the create hold and do not run fake saves through that path until a fence and tests establish safety. F-1 confirmed both POP3 and Outlook-sync attachments are active and the live bucket has no versioning. During F-1, the filing lane ran two direct read-only SQL queries using production database configuration, contrary to this run’s no-pilot-RDS rule. Both completed with rollback before the second could be cancelled; no database writes were attempted. The other seven lanes reported no direct pilot-database access. Further direct database access is prohibited; use non-database evidence and do not count those queries as tests. Two subsequent read-only HRCEN probes reached HMS without a proven shared property lock; possible browser overlap cannot be ruled out. No HMS save or email was reported. Further HMS probes and staging are held until a supported property-lock-compliant route and session closure are verified. F-src is required for both paths, with message and attachment identity plus fresh byte-hash binding. The plan prices this conditional at +20 minutes for F and K5–K7, before the separately unpriced create prerequisite and race. T5 also exposed mixed-action routing that still prices passive or amendment rows; hold its PR until execution routing and no-action tests are fixed. The AGT-F WIP commit hit the existing lint hook; its staged files remain preserved, and the filing lane will recover the in-scope changes in an isolated branch with the hook enforced. The specified deploy tree has unrelated edits and diverged history, so release is held pending safe preservation and checkout-owner coordination. The main planner declined to commit their filing files without an owner request in that session; those files are held untouched while independent filing work proceeds.

## Plain-language terms

| Term | Means |
|---|---|
| Lane / AI session | One Claude coding session in its own worktree. No humans and no staff work during the run |
| Labtest test booking ("fake save") | A real HMS Save on the fake guest "Proof Labtest", 2027+ dates, HRCEN. Never a real guest. CMS email off |
| Edit without saving ("unsaved staging") | Open a real booking in HMS, type changes, close without Save. Nothing changes in HMS |
| Real read | Looking up real guests, agencies or bookings in HMS. Read-only |
| AI test-walk | A headless browser drives the deployed webmail pane on stored mail. No staff and no send |
| Fake-bridge replay (no Outlook) | Same idea on `/outlook-pane`, with a fake stand-in for the Outlook add-in bridge. No Outlook, mailbox or staff touched. The client tests real Outlook the next day |
| Apex | The Greptile code review required on every PR |
| Checks | Remote typecheck and focused tests on EC2. DB tests are skipped and reported as skipped |

## 0. ETA

Calibration: ledger orchestration median 0.96 (n=46). The 1.11 sensitivity excludes superseded rows. The UK clock column assumes "go" at 19:30. Shift it by the real go time.

| Milestone | Raw | Cal. | 1.11 | UK if go 19:30 | What you can see |
|---|---:|---:|---:|---:|---|
| **K1** Kickoff | 25 | 25 | 28 | 19:55 | Uncommitted work on WIP branches; 8 lanes running; stubs on a branch. C1, Q1, T2a, F-1, A1 and R1 already running since minute 0 |
| **K2** Quote provider settled | 65 | 62 | 72 | 20:32 | One HMS probe compared with the installed quote; PDF label merged. This is not a full pane test yet |
| **K3** First connected fake booking | 75 | 72 | 83 | 20:42 | App-prepared Labtest create saved and read back |
| **K4** Triage merged, amend staged, new guest answered | 205 | 197 | 228 | 22:47 | Voucher, mixed-ask and pre-stay fixes merged; date+occupancy staged unsaved on a real old confirmation; "does HMS need a new profile?" answered |
| **K5** Writes proven | 295 | 283 | 327 | 00:13 | Fake saves read back for two-room, general create (real agency, CMS off), amend and filing |
| **K6** Integrated head green | 320 | 307 | 355 | 00:37 | All lanes merged; remote typecheck, focused suites and Apex on one head; DB suites reported as skipped |
| **K7** Done | **365** | **≈350 (5h50m)** | 405 | **01:20** | Deployed; flags re-read on all 4 PM2 processes; AI webmail test-walks; fake-bridge replay (no Outlook); final Labtest test booking |

Work content is about 1,950 agent-minutes: 8 AI sessions' busy time plus the coordinator. Wall clock is the longest lane plus the serial tail. Human time during the run is zero.

**Conditionals:**

| Condition | Effect |
|---|---|
| F-1 finds the pilot attachments are not on the Outlook-sync path (POP3 bytes) | +20 to F, so K5, K6 and K7 move +20 (K7 ≈ 370 cal) |
| A27b real-modal iteration not needed | −20 on A; does not move K7 (A is not critical) |
| G8a finds no new profile needed | G8b/G8c dropped; R frees up |
| Remote-check lock queue above 10 min at 260–290 | Reforecast at that time; a 10-min buffer is already priced before I20 |

**Vs peer forecast (425 raw):** the peer priced the extra work on 7 lanes, with every lane starting after the stubs. v2 takes the peer's own two suggestions (start contract-free work at 0; move G12 before the create gate), adds the R lane, and puts filing UI into F's wait gap. None of this is measured throughput; it is reforecast at K4.

## 1. Parallelism

```
t(min) 0    25   50   75   100  125  150  175  200  225  250  275  300  320  365
I    S1 S2|A6a A6b A10 A11 A11t|I2 I3a I3b|I6 I17|merge train …… buf|I20a I20b|L2 L3 L4-L8
C/G  C1 C10 C11 C12 C13 C14*|G7a G7b G9a G9b G11a G11c G11b G21 G12a G12b G19r|G19a G19b G20*
Q    Q1 Q3a Q3b Q4 Q7/8|F11b-1 -2 -3 gate|F17a F17b F19 F20 gate
T    T2a T2b T4a T4b T4c T5 T9 T6a T6b T6c T17 T18|A17 A19/21 A20 G18|gate
F    F-1 F0a F0b F7 F8 F9a F9b F9c F13 F14 (F-src)|F21 F22 F22a F28/29 F23 F24 F25*
A    A1 A0 A12a1 A12a2 A12b A12c A12r A12d A15a* A15b A15c A22 A26a A26b A27a* (A27b*) A28
M    M1 M2a M2b M6 M6g|M8a M8b M8c M9 M11a M11b M14 M19 M20 M17**
R    R1 R2 R3a R3b R3c R3d|G8a G8b* G8c G8g| … |R4 (integrated)|R5 deployed fake-bridge
                                                     * = HRCEN fake save
```

**Lane ends (raw):** M 265, C/G 285, A 285, T 285, F 295 (315 with F-src), Q 225, R 300. The last merge is about 285, followed by a 10-min buffer, I20 at 295–320, and the tail at 320–365.

**Why not shorter:**
- The tail (I20, then deploy, flags, AI test-walks and final Labtest booking) is serial after the last merge.
- Each lane ends in dependent code, then check, then Apex, then HMS save.
- A ninth lane would only split T or F, and both touch shared files. Splitting saves at most 15 min, at the cost of merge conflicts.

**Shared resources:**

| Resource | Rule |
|---|---|
| EC2 check lock | One lock covers typecheck and Vitest (`remote-typecheck.sh`/`remote-vitest.sh`, `flock`). Batch the focused suites per head. Gates cluster at 230–290, so 10 min of queue is priced before I20. I measures queue time at each gate |
| HRCEN advisory lock | Fake saves are about 90 s each, in this order: C14 ≈70, G8b ≈150, A15a ≈150 (observe), A27a ≈240, M17 ≈250–265, G20 ≈265, F25 ≈280, final ≈340. On `refused_lock_busy`, wait and re-prepare. **Never** blind-retry a dispatched save |
| Greptile Apex | Every PR head, about 15 min, overlapped with the next piece |

**File ownership and merge order:**

| File | Owner | Order |
|---|---|---|
| `quote-workflow.ts`, `pane-create-cloud-input.ts` | C/G | C12 merges first (~50) |
| `pane-create-scope.ts`, `pane-create-approval.ts`, `hms-batch-*` | M | M6g merges at ~90, then G9a rebases at 110 |
| `create-reservation.mjs` | C/G (guarantee section); R (new-profile section) | G8g merges at ~195. C/G codes G11c at 155 on its branch, rebases once at G19r (235), then runs the final-head gate |
| `booking-card.tsx` | M only | G12 is server-only: the card already renders the CMS recipient (`booking-card.tsx:741`), so C/G does not touch it |
| `nava-pane.tsx` mounts, `booking-voucher-card.tsx` | T for amend; F for the filing mount | F21 touches only the voucher card |
| `mail-triage.ts`, `extract.ts`, `work-items.ts` | T | — |
| `pane-hms-write.ts` | I (amend branch); F (attach branch, F9c) | I's A11t merges at ~110; F9c rebases |
| `nava-preview-run.ts` | R | Other lanes send procedure names to R, never edit it |

## 2. Pieces

Each piece is ≤20 min. P/T = product/test LOC, a judgment. Check = focused suite (legend below) on the remote route, or Replay (§5). HMS = live action.

**Test legend** (paths relative to repo root; the ones marked † include DB-backed cases, which are skipped and reported as skipped):
- **Create:** `CT` = `apps/server-pilot/tests/pane-create-cloud-input.test.ts` · `CA`† = `apps/server-pilot/tests/hms-approval.test.ts` · `CR` = `apps/server-pilot/tests/quote-workflow-router.test.ts` · `CB` = `apps/mail/tests/booking-card.test.tsx` · `CH` = `apps/server-pilot/tests/hitl-tool-runs.test.ts`
- **Quote:** `QS` = `apps/server-pilot/tests/staff-quote-route.test.ts` · `QP` = `apps/server-pilot/tests/party-contract-rates.test.ts` · `QW` = `apps/server-pilot/tests/quote-workbook.test.ts` · `HD`† = `apps/mail/tests/save-reply.test.tsx` + `apps/server-pilot/tests/save-reply-draft.test.ts`
- **Triage:** `TI` = `apps/server-pilot/tests/action-classifier-extraction.test.ts` · `TP` = `apps/server-pilot/tests/prestay-self-mail.test.ts` · `TW` = `apps/server-pilot/tests/work-items.test.ts`
- **Filing:** `FS` = `apps/server-pilot/tests/voucher-filing-service.test.ts` · `FR` = `apps/server-pilot/tests/voucher-filing-router.test.ts` · `FC` = `apps/mail/tests/voucher-filing-client.test.ts` · `FB` = new `apps/server-pilot/tests/voucher-filing-readback.test.ts`
- **Amend:** `AM`† = `apps/server-pilot/tests/cloud-saved-stay-amend-prepare.test.ts` · `AE` = `apps/mail/tests/saved-stay-amend-editor.test.tsx` · `AT` = the tooling node tests next to `labtest-amend-save.mjs`
- **Multi-room:** `MB`† = `apps/server-pilot/tests/hms-batch.test.ts` · `MU` = `apps/mail/tests/batch-booking-review.test.tsx`
- **Bridge:** `HB` = `apps/mail/tests/web-pane-bridge.test.ts` · `WB` = `apps/mail/tests/workstation-bridge-protocol.test.tsx`
- **Contract:** `NT` = new `apps/server-pilot/tests/nava-tool-result.test.ts`

**Trees:** INT = `connected-pilot-integrator-20261102`. AGT-F, AGT-A and AGT-M are the idle agent worktrees `.claude/worktrees/agent-a622b…`, `agent-a58d…` and `agent-a649…`; no live process owns them (checked 11-02 18:55Z).

### I: integrator (kickoff, amend server, host identity, merge train, release)

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | S1 | At go, recheck each AGT tree: no live process, no file changes in the last 30 min, no owning session in `ListAgents`. If all three are clear, commit only the in-scope dirty paths to WIP branches and leave the rest untouched. If any is unclear, ask its owner and start that lane's contract-free pieces meanwhile. Ask the main planner to commit its own `three-connected-workflows` filing files at go | 0/0 | git status | — |
| 10 | S2 | Stubs on branch `stubs/v1` (§4): `NavaToolResult` and an adapter from today's outcomes, `FilingRunner`, `AmendStageInput`, `BatchManifestGrant`. Consumers build against the branch from 25 | 70/30 | NT, typecheck | — |
| 25 | S2g | S2 Apex and merge, overlapped with A6a | 0/0 | Apex | — |
| 25 | A6a | Saved-stay preimage gets native stay ID and child ages (`hms-cloud-saved-stay-find.ts:197`); unknown ages stay `unknown`, never `[]` | 40/0 | AM | read |
| 45 | A6b | Preimage tests (non-DB) | 0/30 | AM | — |
| 55 | A10 | Bind the approved delta to the preimage (`cloud-saved-stay-amend.ts`) | 30/20 | AM | — |
| 70 | A11 | `saveAmend` (`pane-hms-write.ts:778`): legacy runner → Cloud lifecycle under `executeUnderLock`. Map `awaiting_readback`, `uncertain` or any possible dispatch → `UNKNOWN` (no re-approval). `ok` only after fresh readback matches | 40/0 | AM | — |
| 90 | A11t | Cases: not-dispatched → NEEDS_CHECK; uncertain, awaiting and dispatched → UNKNOWN; verified → ok. Apex and merge | 0/35 | AM, Apex | — |
| 110 | I2 | Webmail exact message: `sourceMessageId` (`mail.tsx:756`) → `selectPreviewMessage` (`web-pane-bridge.ts:102`); refuse when missing; key the panel by message | 25/0 | HB | — |
| 130 | I3a | Selection and A/B/A stale tests | 0/40 | HB | — |
| 145 | I3b | Apex and merge | 0/0 | Apex | — |
| 155 | I6 | Outlook-selected attachment: F's server byte read covers the Outlook-sync message (the bridge has metadata only, `bridge-protocol.ts:240`) | 0–20/0–20 | FC | — |
| 170 | I17 | Cross-lane identity and stale-state read of merged heads | 0/0 | read | — |
| 180 | X | Merge train: rebases and conflicts as lanes land; measure EC2 lock queue | ~0 | — | — |
| 285 | buf | Lock/merge buffer | — | — | — |
| 295 | I20a | Integrated head: remote typecheck and all focused suites; DB skips listed | 0/0 | all | — |
| 305 | I20b | Integrated-head Apex and P0/P1 triage | 0/0 | Apex | — |
| 320 | L2 | In `.worktrees/recover-parse-failure`: fast-forward to main; `ops-deploy.sh` (watch for the 24h dead-letter exit 1 and `--migrate`) | 0/0 | health | — |
| 330 | L3 | Reload bundles; verify SHA | 0/0 | bundle SHA | — |
| 335 | L4 | Re-read durable and effective env on `http`, `worker`, `ai-worker` and `remote-http`; record per workflow: on (canary passed), deployed or held | 0/0 | env | — |
| 335 | L6/L7 | Final deployed fake booking: prepare, Save, fresh readback | 0/0 | — | save |
| 355 | L8 | Release note: evidence, skips, holds; ledger close | 0/0 | — | — |

### C/G: create owner

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | C1 | Read only the prepare→commit race window | 0/0 | — | — |
| 10 | C10 | Delete `paneCreateScopeHold()` (`quote-workflow.ts:204`, calls :306/:471/:576); flip `CH:1012`; add roomType/arrival mismatch rows. **Keep** the pane `flushForCreate` guard (`booking-card.tsx:1424,1652`) | 6/26 | CT CA CH | — |
| 25 | C11 | Focused checks | 0/0 | CT CA CR CB CH | — |
| 35 | C12 | Apex and merge | 0/0 | Apex | — |
| 50 | C13 | Fake prepare through the app; screenshot | 0/0 | — | prepare |
| 60 | C14 | Fake Save and fresh readback **(K3)** | 0/0 | — | save |
| 75 | G7a | Guest lookup from the mail name via the 1A/1B/1C tools; replace the hard-coded search (`pane-create-cloud-input.ts:96`). Real profiles may be read | 25/0 | CT | real read |
| 95 | G7b | Pick tests: none, one, many, refuse | 0/30 | CT | — |
| 110 | G9a | Scope accepts `party.kind='selected'` (`pane-create-scope.ts:24`, after M6g); match the agency/org IDs | 25/0 | CA | — |
| 125 | G9b | Party mismatch tests | 0/25 | CA CT | — |
| 135 | G11a | Lift the Labtest-only checks as one set: mapper names and guarantee (`pane-create-cloud-input.ts:43–60`), preview admission (`quote-workflow.ts:455–461`) and the real-guest refusal (`:317–319`). **Saving** a real guest stays refused without session authority | 35/0 | CT CR | — |
| 155 | G11c | Native guarantee select and bind beyond NGI (`create-reservation.mjs:38,387–405`), plus the final guard; refuse unsupported codes | 30/20 | CT | — |
| 175 | G11b | Unsaved draft with the agent guarantee | 0/0 | — | unsaved |
| 185 | G21 | Optional note: one value from prepare to approved request, draft and commit. Real bookings get no invented note. The fake synthetic note is fixed **before** approval and reused at commit (`create-reservation.mjs:432`). Absent-note binding case | 15/20 | CT CR | — |
| 205 | G12a | CMS recipient binding (owner enabled 11-02): the recipient is part of the approved digest | 30/0 | CT CA | — |
| 225 | G12b | CMS tests; `cms.send=false` stays forced in tests | 0/25 | CT CA | — |
| 235 | G19r | Rebase onto main (has G8g; M20 may land later, no shared file) and resolve `create-reservation.mjs` | 0/0 | — | — |
| 240 | G19a | Focused checks on the **rebased final head** | 0/0 | CT CA CR CB CH | — |
| 250 | G19b | Apex on that head and merge. If main moved under a shared file, rebase and re-run G19a (≤10, from I's merge-train budget) | 0/0 | Apex | — |
| 265 | G20 | Labtest create: existing guarantee, #870's agency, CMS recipient bound and send off; readback | 0/0 | — | save |

### Q: quote, then filing runner and readback

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | Q1 | Confirm the installed provider (`fetch-quote.mjs` via `reservationist-evaluation-composition.ts:245`) and runtime `QUOTE_RATE_CONTEXT` | 0/0 | QS | — |
| 5 | Q3a | One probe: the same request, party vs blank, in Hotel Availability vs the installed quote (stock, rate, party, restrictions) | 0/0 | — | real read |
| 25 | Q3b | Decide the PDF "total" label; VAT/levy is already gated by `InclusionPolicy` | 0/0 | — | — |
| 30 | Q4 | (If needed) "sum of displayed nightly rates" label (`proposal-pdf.ts:145`) | 10/10 | QW | — |
| 45 | Q7/8 | Checks, Apex, merge **(K2)** | 0/0 | QS QP QW HD | — |
| 65 | F11b-1 | `FilingRunner` keyed by the **server-owned** run/fence (not a client grant): service workers blocked, consume grant, recheck lease (`hms-approval.ts:620–647`) | 40/0 | FR | — |
| 85 | F11b-2 | Re-read the approved snapshot in the **same** shape; hash the approved source bytes; call `attachLabtestDocument`; any possible dispatch → `uncertain` | 50/0 | FR | — |
| 105 | F11b-3 | Runner tests: stale snapshot, wrong bytes, lease lost, dispatched-then-error | 0/40 | FR | — |
| 125 | F11g | Apex and merge | 0/0 | Apex | — |
| 140 | F17a | `voucher-filing-readback.ts`: fresh preimage correlated to the run, coverage-aware (`complete`, `refreshVerified`) | 40/0 | FB | — |
| 160 | F17b | Fresh post-upload read reusing the attach refresh observer (`stay360-document-attach.mjs:186`); fill `stay360-documents.mjs:45–71` `documentId/complete` | 30/0 | FB | — |
| 180 | F19 | Tests: no marker before; exactly one marker+filename after; incomplete, stale, duplicate, wrong stay → `needs_check` | 0/40 | FB | — |
| 200 | F20 | Marker: keep the existing `NAVA`+32 hex (`voucher-filing.mjs:11,42`) in writer, reconciler and tests. F25 verifies HMS stores it whole; fall back to `NV`+10 only if it is truncated | 5/10 | FB | — |
| 210 | F20g | Apex and merge; the label is "attributed (metadata)", never a byte match | 0/0 | Apex | — |

### T: triage, then amend UI

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | T2a | Voucher rule: `extract.ts:52` vs `:77/:92`. A paid voucher for a new stay is a new booking; a voucher for a confirmed stay is filing | 15/0 | TI | — |
| 15 | T2b | Voucher cases | 0/30 | TI | — |
| 30 | T4a | Generic second non-stay ask; today only parking is caught (`quote-workflow-analyse.ts:166`) | 30/0 | TI | — |
| 50 | T4b | Store and show it outside the quote flow (`review-items.ts:88`) | 25/0 | TW | — |
| 70 | T4c | Tests | 0/30 | TI TW | — |
| 85 | T5 | Read per-stay `stays[].action` (`schema.ts:189`) | 15/10 | TW | — |
| 100 | T9 | Mixed-ask choice in the existing read-as row (`workflow-vocabulary.ts`); no new panel | 20/0 | Replay | — |
| 120 | T6a | Pre-stay triage and extraction (`mail-triage.ts:847`, `extract.ts:686`): keep excluded-internal for the stay itself, but carry a separately extracted eligible ask. Never offer create for the pre-stay | 30/0 | TP | — |
| 140 | T6b | Work items and Needs You (`work-items.ts:1952–2072,2478`): suppress the stay card, surface only the separate ask | 30/0 | TW | — |
| 160 | T6c | Pure pre-stay, mixed and non-self-sent cases | 0/45 | TP TW TI | — |
| 180 | T17 | Focused checks | 0/0 | TI TP TW | — |
| 190 | T18 | Apex and merge **(K4 triage)** | 0/0 | Apex | — |
| 205 | A17 | Mount and wire the AGT-A amend editor | 40/0 | Replay | — |
| 225 | A19/21 | Hide amount inputs (dropped); readback and screenshot slot | 15/0 | Replay | — |
| 240 | A20 | Retain-rate Yes/No choice plus "price effect unverified" label, to `AmendStageInput` | 20/0 | Replay | — |
| 255 | G18 | Pane copy for new create refusal reasons (`pane-stay-bind.ts:60`) | 20/0 | Replay | — |
| 270 | Tg | Checks and Apex in parallel; merge | 0/0 | AE, Apex | — |

### F: filing server and filing UI

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | F-1 | Which ingest path carries pilot attachment bytes: Outlook-sync provenance (`outlook-sync-native.ts`) vs POP3 (`store.ts:873`)? Is object versioning on? | 0/0 | read | — |
| 20 | F0a | Consolidate AGT-F and the planner's service/client; reconcile the two client types and the doubled `voucher-find.ts` `files[]` edit | 20/0 | FS FC | — |
| 40 | F0b | Re-run the moved tests | 0/0 | FS FC | — |
| 45 | F7 | Non-DB source refusal tests | 0/30 | FS | — |
| 60 | F8 | Cloud attach-form binder via the `beforeUpload` preimage hook | 40/25 | FS | — |
| 80 | F9a | Replace route stubs with approval/snapshot deps (`hms-approval.ts:265,378`) | 30/15 | FR | — |
| 100 | F9b | Approval callbacks | 30/15 | FR | — |
| 120 | F9c | `parseHmsWriteForm` (`pane-hms-write.ts:154`) accepts the `cloud-write/v1` attach form (after A11t) | 25/20 | FR | — |
| 140 | F13 | Durable single-dispatch intent in the DB, bound to run, stay snapshot and bytes hash; persisted **before** releasing the upload (today a per-call local file, `stay360-document-attach.mjs:99–124`) | 30/20 | FR | — |
| 160 | F14 | Tests: stale grant, wrong stay, second dispatch, uncertain upload | 0/40 | FR FS | — |
| (180) | F-src | (Only if F-1 says POP3; inserted here and shifts F21 onward +20) equivalent message, attachment and byte-hash binding for POP3 | 20–60/10–30 | FS | — |
| 180 | F21 | Mount the filing form in the work-item-aware `booking-voucher-card.tsx:80` (not the lookup-only `nava-pane.tsx:2375` branch); hide legacy attach | 20/0 | Replay | — |
| 195 | F22 | Session state optional in the client (`voucher-filing-client.ts:50`, `voucher-filing-service.ts:75`); metadata-only and uncertain states | 30/10 | FC | — |
| 215 | F22a | Wire readback into service and routes (rebase on F20g at 225) | 40/20 | FS FR | — |
| 235 | F28/29 | Worker admission plus PM2 env check; guard the legacy `attach-document.mjs` fallback | 20/10 | FR | — |
| 250 | F23 | Focused checks | 0/0 | FS FR FC FB | — |
| 260 | F24 | Apex and merge | 0/0 | Apex | — |
| 275 | F25/26 | One synthetic PDF on a fake stay; fresh readback; evidence level stated **(K5)** | 0/0 | — | save |

### A: amend tooling

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | A1/A4 | Pick an old real confirmation for unsaved staging and a clean Labtest stay for saves | 0/0 | — | real read |
| 10 | A0 | Port AGT-A (editor, prepare, tests) onto INT; fix the `amend-lookup-panel` conflict | 0/0 | AM AE | — |
| 25 | A12a1 | Combined lifecycle, dates part: one page context, one fence | 30/0 | AT | — |
| 45 | A12a2 | Occupancy part: bounded child-age read/validate exceptions (`guest-stay-amend-children.mjs:267–305`) inside the **same** fence; no quarantine between them | 30/0 | AT | — |
| 65 | A12b | Save matcher and validator for the combined form; session-independent identity and age preimage | 40/0 | AT | — |
| 85 | A12c | Combined-stage tests | 0/50 | AT AM | — |
| 105 | A12r | Real-stay staging: a separate path with **no** Save route at all, distinct from `currentLabtestRecord`. The fake guard is unchanged | 30/15 | AT | — |
| 125 | A12d | Live unsaved stage on the old real confirmation; close without Save **(K4)** | 0/0 | — | unsaved |
| 135 | A15a | Observe: one Labtest occupancy Save under the existing fence. Capture the HMS question and the continuation request; release nothing unmatched | 0/0 | — | save |
| 155 | A15b | Matcher for the observed continuation; admit only the staff choice | 40/0 | AT | — |
| 175 | A15c | Continuation, not-dispatched, uncertain and no-retry tests | 0/40 | AT | — |
| 195 | A22 | Stale edit and wrong identity cases | 0/30 | AM | — |
| 210 | A26a | Focused checks | 0/0 | AM AE AT | — |
| 220 | A26b | Apex and merge | 0/0 | Apex | — |
| 240 | A27a | One combined Labtest save: date, occupancy and retain choice | 0/0 | — | save |
| 260 | A27b | (Conditional) one DOM iteration; re-stage on a fresh stay | 0–20/0 | — | save |
| 275 | A28 | Fresh-session readback | 0/0 | — | read |

### M: multi-room

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 10 | M1 | Port the AGT-M manifest schema and `hms-batch-executor.ts` contract | 0/0 | MB | — |
| 25 | M2a | Port the `batch-booking-review.tsx` rows and include toggle; lift `multiRoomHold` (`booking-card.tsx:1540`) | 30/0 | MU | — |
| 45 | M2b | Invalidate the manifest on staff edit | 10/15 | MU | — |
| 55 | M6 | Scope accepts child k of an approved manifest across rows and room types, ≤8 children (`pane-create-scope.ts:57–71`, `quote-workflow.ts:298–310,553–581`). Unsupported shapes stay held, with a reason | 35/25 | CA MB | — |
| 75 | M6g | Checks, Apex and **early merge** (unblocks G9a) | 0/0 | CA MB, Apex | — |
| 90 | M8a | One server-bound immutable manifest: digest of ordered child stay and preview digests; one staff Go | 30/0 | MB | — |
| 110 | M8b | Per-child grant and outcome identity. `hasAnyStayOutcome` (`pane-create-approval.ts:319`) ignores siblings recorded under the same manifest | 30/20 | MB | — |
| 130 | M8c | Revision and expiry: staff edit invalidates, a sibling result does not. Recheck the 5/10-min lifetimes (`:25–26`) before each child; stop for renewed Go rather than extend | 25/20 | MB | — |
| 150 | M9 | Sibling-aware preimage (`labtest-preimage.mjs:205`, `booking-lookup-session.mjs:532`): accept only earlier confirmed siblings from the same manifest; any other match still refuses | 30/20 | MB | — |
| 170 | M11a | Serial dispatch through the single-create commit core | 30/0 | MB CR | — |
| 190 | M11b | Stop at the first uncertain child; partial stays partial; distinct readbacks per child | 15/25 | MB | — |
| 205 | M14 | Per-child result rows (port `batch-booking-evidence.tsx`) | 15/0 | Replay | — |
| 220 | M19 | Focused checks | 0/0 | MB MU CA CB | — |
| 230 | M20 | Apex and merge | 0/0 | Apex | — |
| 245 | M17 | Two Labtest children, different room types, same arrival; each read back **(K5)** | 0/0 | — | 2 saves |

### R: replay harness, then new guest

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | R1 | `nava-preview-run.ts`: a per-procedure prepare/preview allowlist bound to env and identity; fail-closed batch rejection stays; explicit never-commit/never-send list; read the selected message, not the thread | 40/15 | self | real read |
| 25 | R2 | Fixtures: about 3 real threads per workflow chosen from staff outbound, each with an expected outcome | 0/0 | — | — |
| 40 | R3a | Fake `window.chrome.webview`: paired PING, 43-char bootstrap challenge, `REGISTER_NAVIGATION`, ticket and v4 responses. Port the helper from `WB:567` | 40/15 | self | — |
| 60 | R3b | Active mail, capabilities and selection events (A/B/A) | 30/10 | self | — |
| 80 | R3c | Record `CREATE_REPLY_DRAFT`, the returned draft location and `ADD_ATTACHMENT_TO_DRAFT`; the pane reader works on `/outlook-pane` | 40/15 | self | — |
| 100 | R3d | Gate: fail on a wrong outcome, unsynced fixture, missing draft or attachment, or a forbidden batch | 30/20 | self | — |
| 120 | G8a | New guest: unsaved Guest Stay with a new name. Does Save need New Profile, `newprofileclick` or `createinactiveprofileflag` (`guest-profile.mjs:481`)? **(K4)** | 0/0 | — | unsaved |
| 140 | G8b | (If needed) one Labtest profile ("Proof Labtest" variant), a 2027 stay save and readback | 0/0 | — | save |
| 160 | G8c | (If needed) admit the proven path in the new-profile section of `create-reservation.mjs`, behind the same guards | 20/15 | CT | — |
| 180 | G8g | Checks, Apex and merge (before G11c rebases) | 0/0 | CT, Apex | — |
| 200 | R4a | Incremental replay on current main; route breaks to their lanes | 0/0 | Replay | real read |
| 285 | R4b | Replay on the integrated head | 0/0 | Replay | real read |
| 335 | R5 | Deployed replay in fake-bridge mode (`--outlook` flag; no Outlook, no staff) on all fixtures | 0/0 | Replay | real read |

### Final AI test-walks (all AI lanes, in parallel at t ≈ 335)

Each AI lane drives a headless browser through its own lane in the deployed **webmail** pane: selected mail → result, no send. About 15 min. R runs R5 at the same time.

## 3. Cut, and why

| Cut | Why |
|---|---|
| G1–G6, Q2, T1/T3, F1–F6, F15/F16, A2/A3/A5 | Already answered in the audit, or folded into the coding piece that reads the same file |
| Per-host mounts, extra reviews | One shared `<NavaPane>` serves both hosts; each PR gets Apex |
| Golden-set evaluation | Owner removed the gate; evaluation is optional, against staff outbound |
| Amount amend | Dropped by the owner |
| Batch worker lease | The serial inline commit core under the property lock is enough. The sibling census is **kept** (M9; the peer was right) |
| 12 host walks | AI webmail test-walks plus fake-bridge replay (no Outlook); the client checks real Outlook next day |

## 4. Agent-facing tool contract (frozen at S2)

The name differs from the existing `ToolResult` in `draft-evidence.ts:41`, to avoid a clash.

```ts
type NavaToolResult<T> = {
  schema: 'nava.tool/v1';        // additive fields keep v1; a breaking change is v2
  outcome: 'ok' | 'refused' | 'needs_input' | 'uncertain' | 'partial';
  reason?: string;               // stable snake_case code
  field?: string;                // input field behind refused / needs_input
  data?: T;
  children?: { key: string; outcome: NavaToolResult<unknown>['outcome']; reason?: string; confirmation?: string }[];
  evidence?: {
    screenshots?: { runId: string; name: string; sha256: string }[];
    readback?: unknown;          // never drop HMS-read fields
    requestDigest?: string;
    level?: 'readback_verified' | 'attributed_metadata' | 'none';
  };
};
```

**Adapter rules (tested in NT):**
- `committed_unverified`, `awaiting_readback`, and any possibly dispatched write → `uncertain`. `uncertain` always means re-read before any retry.
- `pane_save_unconfirmed` is never mapped to `refused`.
- Batch → `partial` plus `children[]`.

**Inputs:**
- Strict zod; unknown fields are refused.
- New capabilities arrive as optional fields.
- Identity, preimage and grant are **required**, as an opaque server-side `grantRef`. They are never optional client fields.

**Stubs:**
- `FilingRunner.run({grantRef}) → NavaToolResult<{documentCode, documentId?}>`
- `AmendStageInput {grantRef, dates?, occupancy?: {adults, childAges: number[] | 'unknown'}, retainRates?: 'yes' | 'no'}`
- `BatchManifestGrant {manifestId, revision, expiresAt, children: {key, stayDigest, previewDigest}[]}`

## 5. Testing: contract replay, not UI unit tests

| Layer | What | Why |
|---|---|---|
| Trust boundaries | One focused test per boundary (grant, digest, fence, uncertain, refuse), listed per piece | Unsafe writes come from here |
| Replay (R1–R5) | Real threads → real pane (webmail, plus fake-bridge mode: a fake `window.chrome.webview` stands in for the Outlook add-in; no Outlook, no staff) → contract JSON → allowlisted prepare/preview, never commit → `results.json` and screenshots. About 3 threads per workflow, each with an expected outcome. Real-thread booking fixtures that stop at `labtest_guest_required` are labelled as refusals; prepared-create coverage uses Labtest inputs | One run shows what breaks across the frontend→backend seam. Nothing to maintain |
| Live HMS | One fake save per write path (C14, G20, M17, A27, F25, G8b), plus A15a's observation and the final deployed booking | Owner's lean proof bar |
| DB suites | Skipped and reported as skipped | Owner 11-02 |

Fixtures are few. They show the seam works; they do not measure accuracy.

## 6. Safety

- **Reads** of real guests, profiles, agencies and old confirmations are allowed. **Unsaved staging** on real bookings is allowed (A12r has no Save route at all).
- **Saves:** Proof Labtest, 2027+, HRCEN only. A real-guest save needs the owner in session. Neither this plan nor a peer grants it.
- **CMS:** recipient binding is on (owner 11-02). Tests force `cms.send=false`. A real confirmation goes out only on an authorized real-guest save.
- **Never:** accept a penalty dialog, blind-retry an uncertain dispatch, run Vitest against pilot RDS, run local tsc, or send secrets externally.
- **"On"** means: flags re-read after deploy on all 4 PM2 processes (L4), plus a final-SHA canary on HRCEN. Otherwise report "deployed" or "held".
- **Updates:** an event at each K and at each hold, plus a 45-min fallback heartbeat when nothing else has been said.

## 7. Open decisions

None blocking. Defaults:

| Item | Default |
|---|---|
| Amount amend | Dropped |
| Custom rate at create | Backlog |
| New guest | G8a decides; built only if HMS behaviour is clear |
| Real agency on a **saved** Labtest stay | #870's agency; any other real agency stays unsaved |
| Multi-room shapes | Any rows and room types, ≤8 children, one arrival per manifest. Other shapes are held with a reason |
| Outlook | Fake-bridge replay now; client tests real Outlook tomorrow |
| Go time | Clock column assumes 19:30 UK; shift by the real go time |

## 8. Peer review triage (v1 → v2)

| Peer finding | Verdict | Where |
|---|---|---|
| Pre-stay mixed mail suppressed | Accept; source confirmed (`mail-triage.ts:847`) | T6a–c |
| Late changes lack per-PR gate | Accept; round 2: rebase row added | G12 server-only before G19; G19r rebase, then the final-head G19a/b; G8g own gate |
| Multi-room can't reuse core unchanged | Accept; source confirmed (`labtest-preimage.mjs:205`, TTL 5/10 min) | M8a–M9, M11b |
| Multi-row scope and merge order | Accept | M6, M6g early merge, ownership table |
| Guest/guarantee spans more sites | Accept | G11a/G11c split |
| Optional note breaks binding | Accept; source confirmed (`create-reservation.mjs:432`) | G21 |
| Filing attribution tree | Accept. Keep the existing `NAVA`+32 marker; v1's NV+10 was wrong | F17a/b, F19, F20 |
| Filing mount and client | Accept | F21 (voucher card), F22 |
| Filing source narrower | Accept, conditional on F-1 | F-1, F-src |
| Filing fence at the upload | Accept | F11b (server run), F13 |
| Amend may misclassify dispatch | Accept; source confirmed (`pane-hms-write.ts:827`) | A11, A11t |
| Real staging vs fake save | Accept | A12r, A12a1/2 |
| Retain-rate request unobserved | Accept: observe first, then match | A15a–c |
| Fake-bridge replay too thin | Accept; reuse the `WB` helper so it is cheaper | R3a–d |
| Replay allowlist | Accept | R1 |
| Result adapter | Accept; renamed `NavaToolResult` | §4 |
| P2: one EC2 lock | Accept; 10-min buffer priced | §1 |
| P2: flags after deploy | Accept | L4 |
| P2: archive links, deploy tree | **Fixed already**: 107 archive links, 3 inbound links, deploy tree named in `PRODUCT.md` | — |
| P2: piece bounds, legend | Accept | §2 |
| P2: owners confirm dirty work | Accept (round 2): recheck at go and ask any owner; only in-scope paths | S1 |
| P2: start before stubs | Accept; this is most of the ETA gain | §1 |
| P2: K2 name | Accept | §0 |
| P2: heartbeat | Accept, 45 min | §6 |
| ETA 425 raw | **Push back, held after round 2**: 365 raw. The peer found two unscheduled rebases on C/G. Fixed: G12 is server-only, so no M20 wait, and G19r is now explicit. C/G moves to 285, still under F's 295, so the critical path doesn't change. Reforecast at K4 | §0 |
