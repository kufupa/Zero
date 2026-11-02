---
title: Connected Cloud pilot, final parallel plan
type: feat
date: 2026-11-02
status: ready-for-go (pending peer adversarial review)
supersedes: 2026-11-02-004 (three-connected-workflows worktree), 2026-11-02-003
evidence: docs/research/2026-11-02-connected-lean-plan-004-adversarial-review.md
---

# Connected Cloud pilot: final parallel plan

**Goal.** Staff in the webmail side pane, and the Outlook pane on the same bundle, can do six things on a selected mail:
1. triage it;
2. quote;
3. create a single booking: existing guest, agency/organization, guarantee, CMS recipient;
4. file a voucher or proof-of-payment PDF into HMS;
5. amend dates, occupancy and the retain-rate choice;
6. book several rooms with one Go.

Every write goes through Prepare → staff Go → native guard → screenshot → fresh readback.

**Done:** main deployed through the bundle, plus one final fake booking on the deployed code, plus each lane walked in the deployed webmail pane, plus each lane's Outlook-mode replay passing. The owner confirmed this bar on 2026-11-02. The client tests real Outlook the next day.

## 0. ETA

Calibration: ledger orchestration median 0.96 (n=46); the 1.11 sensitivity excludes superseded rows.

| Milestone | Raw wall min from "go" | Calibrated | 1.11 sens. | What you can see |
|---|---:|---:|---:|---|
| **K1** Kickoff | 25 | 25 | 28 | Uncommitted work safeguarded; 7 lanes running; interface stubs merged |
| **K2** First qualified quote | 85 | 80 | 95 | One HMS probe matches the installed quote; PDF label settled |
| **K3** First connected fake booking | 95 | 90 | 105 | App-prepared Labtest create saved and read back |
| **K4** Triage done, amend staged, multi-room built | 175 | 170 | 195 | Voucher and mixed-ask fixes merged; amend date+occupancy staged unsaved on a real old confirmation |
| **K5** Writes proven | 275 | 265 | 305 | Two-room, general-create (real agency), amend and filing fake saves read back |
| **K6** Integrated head green | 310 | 300 | 345 | All lanes merged; typecheck, suites and Apex pass on one head |
| **K7** Done | **355** | **≈340 (5h40m)** | 395 | Deployed; webmail walks; Outlook-mode replay; final fake booking |

Work content: about 1,700 agent-minutes, i.e. the sum of the 7 AI sessions' busy time. Wall clock is the longest lane plus the serial tail, not the sum. Human time: none during the run; the client's Outlook test is the next day.

## 1. Parallelism

Seven AI sessions plus the coordinator (me). Each lane runs on its own Orca worktree. Lanes block on each other only at the four interface stubs (§4) and three merge points.

```
t(min)  0    25   50   75   100  125  150  175  200  225  250  275  300  325  355
I    [S1-S2]A6 A10 A11 |I2 I3 webmail-msg|I6|I17| merge-train/conflicts |I20|L2 L3 L6/7 L8
C/G       C1 C10 C11 C12 C13 C14*|G7 G7b G9 G9b G11 G11b G21 G18 G19 G20*
Q         Q1 Q3a Q3b Q4 Q7/8*|F11b-1 -2 -3 (runner)|F17 F19 F20|R1 R2 R3 R4 (replay+shim)
T         T2 T2b T4a T4b T4c T5 T9 T6 T17/18|F21 F22|A17 A19/21 A20|G12
F         F0 F7 F8 F9a F9b F9c F13 F14 (wait) F22a F28/29 F23/24 F25/26*
A         A0 A1 A12a A12a' A12b A12c A12d|A15a A15b|tests A26|A27* (A27b) A28
M         M1 M2a M2b M6 M8a M8b M11a M11b M14 M19/20 M17*|G8a G8b (G8c)
                                                     * = HRCEN fake save
```

**Changes from 004:**
- Filing and amend are no longer serial single-owner chains. Q builds the filing runner and readback; T builds the filing and amend UI; I builds the amend server wiring. Each works against stubs frozen at kickoff.
- New-guest exploration goes to M after M17, and the CMS recipient goes to T. That evens the lane ends at 260–285.

**Why not shorter:**
- The tail (I20 25, then deploy, walks and final booking 45) is serial after the last merge.
- Each lane's longest chain is dependent code → check → review → HMS save.
- An eighth lane would save about 10 minutes. Not worth it.

**Shared resources:**

| Resource | Rule |
|---|---|
| EC2 check lock | Owner cap is 3 concurrent tests; checks take ~1 min, so the queue is small. |
| HRCEN advisory lock | Saves are about 90 s, on different fake stays, in this order: C14 ≈90, M17 ≈210, A27 ≈215–250, G20 ≈230, G8b ≈250, F25 ≈260, final ≈330. On `refused_lock_busy`, wait and retry the prepare. **Never** blind-retry a dispatched save. |
| Greptile | 15 min per head, in parallel. |

**Shared files:**
- `pane-create-scope.ts`: M6 merges before G9a rebases.
- `nava-pane.tsx` mounts: T owns them all.
- `booking-card.tsx`: M owns it.
- `quote-workflow.ts`: C owns it until C12 merges.

## 2. Pieces

Each piece is ≤20 min. Columns: P/T = product/test LOC, a judgment. Check = focused suite on the remote route, or the Replay harness (§5). HMS = live action.

Tree notes:
- INT: `connected-pilot-integrator-20261102`.
- AGT-F, AGT-A, AGT-M: uncommitted agent worktrees `.claude/worktrees/agent-a622b…`, `agent-a58d…` and `agent-a649…`.

### I: integrator (kickoff, amend server, host identity, merge train, release)

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 0 | S1 | Commit AGT-F, AGT-A, AGT-M and the planner's dirty filing files to WIP branches; nothing is lost | 0/0 | git status | — |
| 10 | S2 | Interface stubs, merged first: `FilingRunner`, `AmendStageInput/Result`, `BatchManifestGrant`, `ToolResult<v1>` (§4); dispatch 6 lanes | 60/0 | typecheck | — |
| 25 | A6a | Saved-stay preimage gets the native stay ID and child ages from the tooling snapshot (`children.mjs:56`) | 40/0 | AM-lite | read |
| 45 | A6b | Preimage tests (non-DB) | 0/30 | AM | — |
| 55 | A10 | Bind the approved amend delta to the preimage (`cloud-saved-stay-amend.ts`) | 30/20 | AM | — |
| 70 | A11 | `saveAmend` (`pane-hms-write.ts:778`): legacy `amend-stay.mjs` → Cloud runner under `executeUnderLock` | 40/0 | AM | — |
| 90 | A11t | A11 tests and merge | 0/30 | AM, Apex | — |
| 100 | I2 | Webmail exact message: `sourceMessageId` from `mail.tsx:756` → `selectPreviewMessage` (`web-pane-bridge.ts:102`); refuse when missing; key the panel by message | 25/0 | HB | — |
| 120 | I3 | Selection and A/B/A stale tests; merge | 0/45 | HB, Apex | — |
| 140 | I6 | Outlook-selected attachment: confirm F's server-side byte read covers Outlook mail (the bridge has metadata only, `bridge-protocol.ts:240`) | 0–20/0–20 | FC | — |
| 160 | I17 | Cross-lane identity and stale-state review | 0/0 | read | — |
| 170 | X1–X3 | Merge train: rebase or conflict pieces as lanes land (3 × 20 reserved) | ~0 | — | — |
| 285 | I20a | Integrated head: remote typecheck and all focused suites; report DB skips | 0/0 | all | — |
| 295 | I20b | Integrated-head Apex and P0/P1 triage | 0/0 | Apex | — |
| 310 | L2 | Fast-forward the deploy tree to main; `ops-deploy.sh` bundle sync. Watch for the 24h dead-letter exit 1 and `--migrate` | 0/0 | health | — |
| 320 | L3 | Reload both bundles; verify the SHA | 0/0 | bundle SHA | — |
| 325 | L6/L7 | Final deployed fake booking: prepare, Save, fresh readback | 0/0 | — | save |
| 345 | L8 | Release note: evidence, skips, holds; ledger close | 0/0 | — | — |

### C/G: create owner

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | C1 | Read only the prepare→commit race window; the binding itself is already verified | 0/0 | — | — |
| 35 | C10 | Delete `paneCreateScopeHold()` (`quote-workflow.ts:204`, calls :306/:471/:576); flip `hitl-tool-runs.test.ts:1012`; add roomType/arrival mismatch rows | 6/26 | CT CA | — |
| 50 | C11-12 | Checks, Apex, merge (unblocks M6) | 0/0 | CT CA CR CB | — |
| 70 | C13 | Fake prepare through the app; screenshot | 0/0 | — | prepare |
| 80 | C14 | Fake Save and fresh readback **(K3)** | 0/0 | — | save |
| 95 | G7a | Guest lookup from the mail name through the 1A/1B/1C lookup tools; replace the hard-coded `Proof/Labtest` search (`pane-create-cloud-input.ts:96`). Real profiles may be looked up | 25/0 | CT | real read |
| 115 | G7b | Pick tests: none, one, many, refuse | 0/30 | CT | — |
| 125 | G9a | Scope accepts `party.kind='selected'` (`pane-create-scope.ts:24`); match agency/org IDs (already mapped and digested) | 25/0 | CA | — |
| 140 | G9b | Party mismatch tests | 0/25 | CA CT | — |
| 150 | G11a | Guarantee beyond NGI (`create-reservation.mjs:38`); refuse unsupported | 30/20 | CT | — |
| 170 | G11b | Unsaved draft on a real or Labtest stay: agent guarantee choice | 0/0 | — | unsaved |
| 180 | G21 | `reservationNote` optional (`cloud-input.ts:58`) | 5/10 | CT | — |
| 190 | G18 | Pane copy for new refusal reasons (`pane-stay-bind.ts:60`) | 20/0 | Replay | — |
| 205 | G19 | Checks, Apex, merge | 0/0 | CT CA CR | — |
| 225 | G20 | Labtest create with an existing guarantee and the agency used in #870's proofs; readback | 0/0 | — | save |

### Q: quote, then filing runner and readback, then the replay harness

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | Q1 | Confirm the installed provider (`fetch-quote.mjs` via `reservationist-evaluation-composition.ts:245`) and `QUOTE_RATE_CONTEXT` at runtime | 0/0 | QS | — |
| 30 | Q3a | One probe: the same request with party and blank in Hotel Availability vs the installed quote (stock, rate, party, restrictions) | 0/0 | — | real read |
| 50 | Q3b | Decide the PDF "total" label. VAT/levy are already gated by `InclusionPolicy` against the terms letter | 0/0 | — | — |
| 55 | Q4 | (If needed) label the total as a "sum of displayed nightly rates" (`proposal-pdf.ts:145`) | 10/10 | QW | — |
| 65 | Q7-8 | Checks, Apex **(K2)** | 0/0 | QS QP QW HD | — |
| 85 | F11b-1 | Filing runner: page with service workers blocked, `currentLabtestRecord`, consume the grant (to the `FilingRunner` stub) | 40/0 | FR | — |
| 105 | F11b-2 | Runner: read the approved source bytes, call `attachLabtestDocument`, map the outcome | 50/0 | FR | — |
| 125 | F11b-3 | Runner tests | 0/40 | FR | — |
| 145 | F17 | `voucher-filing-readback.ts`: metadata / bytes / uncertain contract plus a pure review function | 50/0 | new | — |
| 165 | F19 | Readback tests: incomplete, duplicate, wrong stay | 0/40 | new | — |
| 180 | F20 | Attribution: document code `NV`+10 hex of the run ID. Absent before, unique after, and the tree not partial means "attributed (metadata)" | 10/10 | new | — |
| 190 | R1 | Replay harness: extend `scripts/nava-preview-run.ts` to allowlist prepare/preview mutations (never commit) and dump the contract JSON per thread | 30/10 | self | real read |
| 210 | R2 | Fixtures: about 3 real threads per workflow, chosen from staff outbound (quote, booking, party, voucher, amend, multi-room, pre-stay, mixed) | 0/0 | — | — |
| 225 | R3 | Outlook mode: `--outlook` injects a fake `window.chrome.webview` that answers `GET_ACTIVE_EMAIL` from the thread and records `CREATE_REPLY_DRAFT` | 40/0 | self | — |
| 245 | R4 | First full replay on the integrated preview; file the breaks to their lanes | 0/0 | Replay | real read |

### T: triage, then filing UI, amend UI and CMS recipient

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | T2a | Voucher rule: `extract.ts:52` vs `:77/:92`. Paid voucher for a new stay = new booking (owner ask 83); voucher for a confirmed stay = filing | 15/0 | TI | — |
| 40 | T2b | Voucher cases | 0/30 | TI | — |
| 55 | T4a | Generic second non-stay ask; today only parking is caught (`quote-workflow-analyse.ts:166`) | 30/0 | TI | — |
| 75 | T4b | Store and show it outside the quote flow (`review-items.ts:88`) | 25/0 | TW | — |
| 95 | T4c | Tests | 0/30 | TI TW | — |
| 110 | T5 | Read the per-stay `stays[].action` (stored, never read; `schema.ts:189`) | 15/10 | TW | — |
| 125 | T9 | Mixed-ask choice in the existing read-as row (`workflow-vocabulary.ts`); no new panel | 20/0 | Replay | — |
| 145 | T6 | Pin pre-stay + separate-ask behaviour with one test | 0/10 | TP | — |
| 150 | T17-18 | Checks, Apex on two PRs **(K4 part)** | 0/0 | TI TP TW | — |
| 175 | F21 | Mount the AGT-F filing card at `nava-pane.tsx:2375`; hide legacy attach | 20/0 | Replay | — |
| 190 | F22 | Metadata-only and uncertain states | 25/0 | Replay | — |
| 210 | A17 | Mount and wire the AGT-A amend editor | 40/0 | Replay | — |
| 230 | A19/21 | Hide amount inputs (dropped); readback and screenshot slot | 15/0 | Replay | — |
| 245 | A20 | Retain-rate Yes/No choice plus "price effect unverified" label (to the `AmendStageInput` stub) | 20/0 | Replay | — |
| 260 | G12 | CMS recipient binding (owner enabled 11-02). Tests keep `cms.send=false`; real send only on an authorized real-guest save | 30/20 | CT CA | — |

### F: filing server

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | F0a | Consolidate AGT-F and the planner's dirty service/client; reconcile the two client types and the doubled `voucher-find.ts` `files[]` edit | 20/0 | FS FC | — |
| 45 | F0b | Re-run the moved tests | 0/0 | FS FC | — |
| 50 | F7 | Non-DB source refusal tests (AGT's use a DB helper, which is skipped) | 0/30 | FS | — |
| 65 | F8 | Cloud attach-form binder using AGT's `beforeUpload` preimage hook | 40/25 | FS | — |
| 85 | F9a | Replace route stubs (`unavailableFilingRead`) with approval/snapshot deps (`hms-approval.ts:265,378`) | 30/15 | FR | — |
| 105 | F9b | Approval callbacks | 30/15 | FR | — |
| 125 | F9c | `parseHmsWriteForm` (`pane-hms-write.ts:154`) accepts the `cloud-write/v1` attach form | 25/20 | FR | — |
| 145 | F13 | Persist dispatch intent to the DB (today a local JSON file); fence `beforeRelease` on it | 30/20 | FR | — |
| 165 | F14 | Tests: stale grant, wrong stay, uncertain upload | 0/40 | FR FS | — |
| 190 | F22a | Wire the readback into the service and routes | 40/20 | FS FR | — |
| 210 | F28/29 | Worker admission plus PM2 env check (http, worker, ai-worker, remote-http); guard the legacy `attach-document.mjs` fallback | 20/10 | FR | — |
| 230 | F23-24 | Checks, Apex | 0/0 | FS FR FC | — |
| 255 | F25/26 | One synthetic PDF upload on a fake stay; fresh readback with the evidence level stated | 0/0 | — | save |

### A: amend tooling

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | A0 | Port AGT-A (editor, prepare, tests) onto INT; fix the `amend-lookup-panel` conflict | 0/0 | AM AE | — |
| 40 | A1/A4 | Pick an old real confirmation for unsaved staging and a clean Labtest stay for the save; confirm retain-prompt evidence (`guest-stay-amend-adults.md:56`) | 0/0 | — | real read |
| 50 | A12a | **Combined** date+occupancy stage on one page. Today each stage handles one field and refuses Save; a page context can be used once | 50/0 | AM | — |
| 90 | A12b | Save matcher and validator for the combined form | 40/0 | AM | — |
| 110 | A12c | Combined-stage tests | 0/50 | AM | — |
| 130 | A12d | Live unsaved stage on the old real confirmation; close without Save **(K4 part)** | 0/0 | — | unsaved |
| 140 | A15a | Retain-rate continuation: one guarded second slot in `saved-stay-save-route-chain.mjs` for the staff choice. Today exactly one Save is allowed and any dialog stops the lifecycle (`labtest-amend-save.mjs:15,83`) | 40/0 | AM | — |
| 160 | A15b | Continuation tests | 0/30 | AM | — |
| 170 | A22-25 | Stale edit, wrong identity, uncertain and no-retry cases | 0/35 | AM | — |
| 190 | A26 | Checks, Apex | 0/0 | AM AE | — |
| 210 | A27a | One combined Labtest save: date + occupancy + retain choice | 0/0 | — | save |
| 230 | A27b | (Conditional) one DOM iteration on the real modal; re-stage on a fresh stay | 0–20/0 | — | save |
| 250 | A28 | Fresh-session readback | 0/0 | — | read |

### M: multi-room, then new guest

| t | ID | What | P/T | Check | HMS |
|---:|---|---|---|---|---|
| 25 | M1 | Port the AGT-M manifest schema (`hms-batch-manifest.ts`) | 0/0 | MB | — |
| 40 | M2a | Port the `batch-booking-review.tsx` rows and include toggle; lift `multiRoomHold` (`booking-card.tsx:1540`) | 30/0 | Replay | — |
| 60 | M2b | Invalidate the manifest on edit | 10/15 | MU | — |
| 75 | M6 | Scope accepts child k of n (row `count=n`, `roomIndex` 1..n, ≤8; `pane-create-scope.ts:58`) | 25/20 | CA MB | — |
| 95 | M8a | Manifest grant = digest of ordered child stay and preview digests; one staff Go | 30/0 | MB | — |
| 115 | M8b | Per-child claims derived from it | 20/20 | MB | — |
| 135 | M11a | Serial dispatch through the existing single-create commit core | 30/0 | MB CR | — |
| 155 | M11b | Stop on the first uncertain child; partial stays partial | 15/25 | MB | — |
| 170 | M14 | Per-child result rows (port `batch-booking-evidence.tsx`) | 15/0 | Replay | — |
| 185 | M19-20 | Checks, Apex | 0/0 | MB MU | — |
| 205 | M17 | Two Labtest child saves, each read back **(K5 part)** | 0/0 | — | 2 saves |
| 225 | G8a | New guest: on an unsaved Guest Stay, type a new name. Record whether Save needs New Profile / `newprofileclick` / `createinactiveprofileflag` (`guest-profile.mjs:481`) | 0/0 | — | unsaved |
| 245 | G8b | If a profile is needed: one Labtest profile ("Proof Labtest" variant) plus a 2027 stay save and readback | 0/0 | — | save |
| 265 | G8c | (Conditional) admit the proven new-guest path in the create tool, behind the same guards | 20/15 | CT | — |

### Final walks (all owners, in parallel at t ≈ 325)

- Each owner walks their own lane in the deployed **webmail** pane: selected mail → result, no send. 15 min.
- Q runs **Replay + `--outlook`** against the deployed bundle on the fixture threads. 15 min.

## 3. Cut from 004, and why

| Cut | Why |
|---|---|
| G1–G6, Q2, Q4-as-probe, T1/T3, F1–F6, F15/F16, A2/A3/A5 | Trace or inspect rows already answered in the audit, or folded into the coding piece that reads the same file |
| I8–I12 per-host mounts, I14–I16 reviews | One shared `<NavaPane>` serves both hosts. Each PR already gets Apex |
| T13–T15 evaluation | Owner removed the golden-set gate; evaluation is optional and uses staff outbound |
| A16 and the amount half of A19, A29/A30 | Amount dropped by the owner; one representative save |
| M10/M16 preimage census, batch worker lease | Each child gets its own preview and readback; the inline commit core is enough |
| 12 × 20-min host walks | Replaced by webmail walks plus Outlook-mode replay; the client checks real Outlook the next day |
| K heartbeat every 45 min | Event-driven checkpoints K1–K7 |

## 4. Agent-facing tool contract (frozen at S2)

Every tool these lanes add or touch returns:

```ts
type ToolResult<T> = {
  schema: 'nava.tool/v1';                     // bump the minor version only when a field is added
  outcome: 'ok' | 'refused' | 'needs_input' | 'uncertain';
  reason?: string;                            // stable snake_case code
  field?: string;                             // the input field that caused refused or needs_input
  data?: T;                                   // tool-specific; adding fields is backward-compatible
  evidence?: { screenshot?: string; readback?: unknown; requestDigest?: string };
};
```

**Inputs:**
- Strict zod objects.
- New capabilities arrive as new optional fields. A caller that omits them gets today's behaviour.
- Unknown fields are refused, so an agent cannot believe it set something that was ignored.

**Outputs:**
- Never drop HMS-read fields (memory: never discard HMS data).
- `uncertain` always means: re-read before any retry.

**Stubs (S2), so producers and consumers build in parallel:**
- `FilingRunner.run(grant) → ToolResult<{documentCode, evidenceLevel}>`
- `AmendStageInput {dates?, occupancy?, retainRates?: 'yes' | 'no'}`
- `BatchManifestGrant {children: {allocationId, stayDigest, previewDigest}[]}`

## 5. Testing: contract replay, not UI unit tests

| Layer | What | Why |
|---|---|---|
| Trust boundaries | One focused test per boundary: grant, digest, fence, uncertain, refuse. Already listed per piece | These are where unsafe writes come from |
| Replay harness (R1–R4) | Real threads → real pane (webmail, plus `--outlook` fake bridge) → contract JSON → backend prepare/preview, never commit → `results.json` + screenshots. About 3 threads per workflow, chosen from staff outbound | One run shows what breaks across the frontend → backend seam. No mock matrices, and no UI snapshot tests to maintain |
| Live HMS | One representative fake save per write path (C14, G20, M17, A27, F25, G8b), plus the final deployed booking | Owner's lean proof bar |
| DB suites | Skipped and reported as skipped (owner 11-02) | — |

UI work is limited to mounting existing components and adding states. There are no new panels.

## 6. Safety (unchanged unless noted)

- **Reads** of real guests, profiles, agencies and old confirmations: allowed. **Unsaved staging** on real bookings: allowed (owner 11-02).
- **Saves:** Proof Labtest, 2027+, HRCEN only. Saving a real guest needs the owner in session.
- **CMS:** recipient binding enabled (owner 11-02). Tests use `cms.send=false`. A real confirmation goes out only on an authorized real-guest save.
- **Never:** accept a penalty dialog, blind-retry an uncertain dispatch, run Vitest against pilot RDS, run local tsc, or send secrets externally.
- **PII:** PIA/NDA/ZDR cover the VPS, prod EC2 and LLMs, so no redaction work (owner 11-02).
- **Deploy:** main through the `ops-deploy.sh` bundle (owner 11-02).

## 7. Open decisions

None blocking. Recorded defaults:

| Item | Default |
|---|---|
| Amount amend | Dropped |
| Custom rate at create | Backlog. The quote flow already has one-off rates with "Authorised by" |
| New guest | Explored in G8a; built only if the HMS behaviour is clear |
| Real agency on a **saved** Labtest stay | Use the agency from #870's earlier proofs; any other real agency stays unsaved |
| Outlook | Fake-bridge replay now; the client tests real Outlook tomorrow |

## 8. Context-doc cleanup (do at "go", by the coordinator, ≤20 min)

| File | Cut or replace |
|---|---|
| `PRODUCT.md` | Workflows ROI list and "voucher after 1–4" → current pilot scope. Hard rules `RESERVATIONIST_PANE_SAVE` / `PANE_WRITE_CREATE=lab` → §6 above. Deploy tree `.worktrees/recover-parse-failure` → main via bundle. "Done = golden set on prod" → §0 Done bar. Add PIA/NDA/ZDR. Keep the safety lines |
| `docs/context/PRODUCT-DETAIL.md` | Remove the "Done" golden-set section and its 10-14 pass-bar table (move to the archive). "Vouchers are parked" → filing in scope. "Attachments: download only" → filing exists |
| `docs/context/RUN-CONTRACT.md` | Remove the Baseline/Pass-bar golden-set fields and the 10-14 retro framing; keep the `/goal`/`/loop` table |
| `docs/context/START-HERE.md` | Replace the HRDAV, Pomerado and agent-setup pointers with this plan |
| `docs/context/ACTIVE.md` (461 lines, 10-27/28 runs) | Move to `docs/context/archive/`; not loaded at startup |
| `AGENTS.md` | Add: DB suites skipped; deploy main; owner decisions file. Otherwise fine |
| Plans 001–004 (11-02) | Add a "superseded by 005" header line |
