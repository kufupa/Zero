# Adversarial review: connected Cloud lean plan 004

**Date:** 2026-11-02 (17:50 UTC). **Reviewer:** Claude Opus 5.5, adversarial session.
**Target:** `.claude/worktrees/three-connected-workflows/docs/plans/2026-11-02-004-feat-connected-cloud-lean-plan.md` (430 lines, 16:50).
**Method:** five read-only code audits, one per lane group, against:
- the integrator tree `connected-pilot-integrator-20261102` @ `90319e290`, which is 53 commits ahead of `origin/main`;
- `main`;
- the planner's dirty tree;
- three uncommitted agent worktrees.

I spot-checked the four claims that matter most in source myself (§6). I did not edit or run anything, did no HMS work and did not contact the planner.

## 0. Answer

**The plan is roughly 2× too big. 3,620 AI-agent-minutes falls to about 1,750, and the wall clock falls from 625 raw (600 calibrated) to about 410 raw (≈395 calibrated, 455 under the 1.11 sensitivity).**

Three causes:
1. **Every row is priced at 15–20 minutes regardless of content.**
   - 80 of 198 rows add no code, and they are worth 1,395 min (36%).
   - "Trace X" rows are billed separately from the coding row, which has to read the same file anyway.
   - Review is billed three times: each lane, then I14–I16, then I20b and L1c.
2. **Much of the work already exists and the plan does not see it.**
   - The create hold is a single always-refuse function.
   - Most of the create proof binding is already merged.
   - Quote PDF, Excel, unsent reply and one-line decline are already built.
   - The quote VAT and levy text is checked against the hotel terms letter by policy code.
   - About 4,000 LOC of filing, amend and batch work sits **uncommitted** in three agent worktrees.
3. **Per-host "mounting" is not real work.** Both hosts render the same `<NavaPane>`, and the cards call tRPC, not the host bridge.

The plan also **underprices or omits real work**:
- the amend retain-rate continuation request;
- a combined date+occupancy stage;
- the filing `cloud-write/v1` form schema;
- a three-tree filing merge;
- create's required `reservationNote`;
- the triage voucher-rule contradiction.

These are added in below.

"3,620" is summed agent work, not elapsed time. **Actual elapsed time is ~6.5–7 h** with six feature lanes, an integrator and a coordinator. Human time is approvals plus whatever Outlook walk needs a human (§5).

## 1. ETA

Calibration source: `~/.claude/eta-ledger.jsonl`, orchestration median **0.96** (n=46). For reference: code-server 0.85, live-hms 0.67, review 0.87. One factor is applied to the whole graph.

| Milestone | Plan raw | Audit raw | Audit calibrated (×0.96) | 1.11 sensitivity |
|---|---:|---:|---:|---:|
| First qualified quote (one P-Q probe, label decision) | 170 | 95 | **≈90** | 105 |
| First connected fake booking (hold removed, Save + readback) | 170 | 105 | **≈100** | 115 |
| Full pilot: six feature lanes, integrator and coordinator | 625 | 410 | **≈395** | 455 |
| Full pilot: five feature lanes | 765 | 470 | **≈450** | 520 |

| Lane | Plan agent-min | Audit agent-min | Δ | Main reason |
|---|---:|---:|---:|---|
| S kickoff | 100 | 30 | −70 | Worktrees don't need `pnpm install`; checks run on EC2 from a bundle |
| C fake create | 135 | 75 | −60 | Hold is one function plus 3 call sites; mismatch tests already exist |
| G general create | 410 | 165 | −245 | G13–G15 done; G9 and G10 are one binding; traces answered; new guest out of scope (D2) |
| Q quote | 155 | 65 | −90 | Output already built; Q2–Q4 become one probe; VAT/levy gated by policy |
| T triage | 355 | 145 | −210 | Eval T13–T15 optional; tests fold into PRs; T6–T8 have no case evidence |
| F filing | 570 | 420 | −150 | F1–F6 and F15–F16 done or padding; +90 for missing work |
| A amend | 580 | 330 | −250 | A2/A3/A5/A29/A30 probes cut; preimage is one piece; amount cut (D1) |
| M multi-room | 430 | 170 | −260 | Thin wrapper over the existing commit core; no preimage census; batch code reusable |
| I integration | 420 | 140 | −280 | One shared pane; I14–I16 duplicate per-PR Apex |
| L release tail | 340 | 180 | −160 | Outlook smokes take 8 min each; L1 runs in parallel |
| K heartbeat | 65 | 30 | −35 | Event-driven checkpoints (§4) |
| **Total** | **3,620** | **≈1,750** | **−1,870** | |

### 1.1 Critical path (six feature owners)

| Owner | Work | Ends (raw min) |
|---|---|---:|
| C/G | Kickoff 30 → C 75 → G 165 | 270 |
| M | M1–M4 UI port during C → M6–M20 after C10 merges (~75) | ≈200 |
| Q | Q 65 → filing readback F17–F20 (50) | ≈145 |
| T | T 145 → filing UI F21/F22 + session store (65) | ≈240 |
| F | Core: consolidate → binder → routes → runner → fence → tests → upload (≈285 after helpers) | **≈315** |
| A | Core ≈265; C/G owner or T takes the editor UI (≈65) | ≈295 |
| I | Kickoff, I-pieces 140; final integrated check on the merged head | 170, then +25 at the end |

`max(F 315, A 295, G 270) + I20 25 + tail 70 = 410 raw`.

The tail is 70 rather than 180 because its pieces run in parallel:
- L1 checks: 10 wall (typecheck, vitest and Apex together).
- L2 deploy: 10.
- L3 reload: 5.
- Walks plus the final fake booking: 30, with each owner walking their own lane while I runs L6/L7.
- L8: 10.

**Biggest live risks on the path:**
1. A15/A27 retain-rate continuation. The real HMS modal's DOM is unproven, so expect one live iteration (+20–30).
2. F11b. No `src/` caller of the attach adapter exists yet.
3. No automated Outlook route. If one person must do every Outlook smoke in sequence, that adds +40.

## 2. Pieces (≤20 min each)

Columns: **P/T** = product/test LOC (judgment). **Test** uses the plan's shorthand. **HMS** = live action. **Par** = how it parallelises, or why it can't.

### S kickoff, 30 (integrator)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| S1 | Safeguard the three uncommitted agent worktrees (§3.1) onto WIP branches via their owners; assign files | 0/0 | git status | — | First. Everything reuses this code |
| S2 | Dispatch lanes and contracts; confirm `remote-typecheck`/`remote-vitest` route; DB suites marked skipped (owner 11-02) | 0/0 | wrapper dry check | — | After S1 |
| S3 | `orca worktree create` × 6, ~2 min each, no install | 0/0 | clean head | — | Parallel across owners |

### C fake create, 75 (C/G owner)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| C1 | Read-only check of the prepare→commit race window only. The binding is already verified (scope digest, grant recheck, Save fence) | 0/0 | — | — | Serial start |
| C10 | Delete `paneCreateScopeHold()` (`quote-workflow.ts:204`) and its calls at :306/:471/:576; flip `hitl-tool-runs.test.ts:1012-1026`; add roomType/arrival mismatch rows | 6/26 | CT, CA, hitl | — | Serial: the core change |
| C11 | Remote typecheck and focused vitest | 0/0 | CT CA CR CB | — | EC2 lock shared |
| C12 | Greptile Apex, triage P0/P1 | 0/0 | Apex | — | Waits on the reviewer |
| C13 | Fake prepare through the app; inspect screenshot | 0/0 | — | P-C prepare | HRCEN save queue |
| C14 | One fake Save and fresh readback | 0/0 | — | P-C Save | HRCEN save queue, ~90 s native |

### G general create, 165 (C/G owner after C)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| G7a | Search existing guest from the mail name; replace the hard-coded `Proof/Labtest` search (`pane-create-cloud-input.ts:96`) | 25/0 | CT | unsaved read | Serial in G |
| G7b | Guest-pick tests: none, one, many, refuse | 0/30 | CT | — | Same PR |
| G9a | Accept `party.kind==='selected'` (`pane-create-scope.ts:24`); match the stay's agency or org ID. IDs are already mapped and digested (`cloud-input.ts:66-83,148-157`) | 25/0 | CA CT | — | Coordinate the file with M6 |
| G9b | Party mismatch tests | 0/25 | CA CT | — | Same PR |
| G11a | Map guarantee beyond NGI (only NGI today, `create-reservation.mjs:38-40`); reject unsupported | 30/20 | CT | — | After G9 |
| G11b | One unsaved-draft check of the agent-guarantee choice | 0/0 | — | unsaved draft | HRCEN queue |
| G21 (new) | Make `reservationNote` optional. It refuses with `staff_note_required` (`cloud-input.ts:58-60`), and real mail often has no note | 5/10 | CT | — | Any time |
| G18 | Pane copy for the new refusal reasons (`pane-stay-bind.ts:60`) | 20/15 | CB | — | Parallel with G11 |
| G19a | Typecheck and focused suites | 0/0 | CT CA CR CB | — | EC2 lock |
| G19b | Apex and P0/P1 | 0/0 | Apex | — | Reviewer wait |
| G20 | Fake create: existing guest, party and guarantee; fresh readback | 0/0 | — | P-C Save | HRCEN queue |

Removed from G:
- G1–G5 traces: answered by this audit.
- G6: HRCEN actor and property already bound.
- G13–G15: done.
- G16/G17: in the PRs.
- G8 new guest: D2.
- G12 real recipient: authority hold (D4).

### Q quote, 65 (Q owner)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| Q1 | Confirm the installed provider and `QUOTE_RATE_CONTEXT` on runtime | 0/0 | QS | — | Start at once |
| Q3a | One P-Q probe: the same request with party and blank in Hotel Availability vs the installed quote (stock, rate, party, restrictions) | 0/0 | — | P-Q read | Read only; parallel with the save queue |
| Q3b | Record the comparison; decide the "total" label | 0/0 | — | — | After Q3a |
| Q4 | If needed, relabel the PDF total as the sum of displayed nightly rates, not the HMS payable total (`proposal-pdf.ts:145-158`) | 10/10 | QW | — | Only if Q3b says so |
| Q7 | Focused suites | 0/0 | QS QP QW HD | — | EC2 lock |
| Q8 | Apex, only if Q4 changed code | 0/0 | Apex | — | Reviewer wait |

The plan targets the wrong reader:
- Staff quotes use `fetch-quote.mjs`, which has the party pickers (`:236-293`), through `reservationist-evaluation-composition.ts:245`.
- The Cloud availability reader, whose total and tax are unknown, only feeds the prefetch (`hms-jobs.ts:4143`).
- VAT and levy are gated by `InclusionPolicy` (`quote-revision.ts:62-72`), which requires the terms letter's wording (`reservationist-rate-policy-source.ts:104`).
- Staff's own Excel template prints the same lines.

### T triage, 145 (T owner)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| T2a | Fix the voucher rule contradiction. `extract.ts:52` says voucher-only → `voucher_pop`; `:77`/`:92` say → `new_booking`. Follow owner ask 83: a paid voucher for a new stay = new booking; a voucher for a confirmed stay = filing | 15/0 | TI | — | Start at once |
| T2b | Voucher cases | 0/30 | TI | — | Same PR |
| T4a | Generic second non-stay ask. Today only parking is caught (`quote-workflow-analyse.ts:166`) | 30/0 | TI | — | Parallel with T2 |
| T4b | Store and surface it on the work item outside the quote flow (`review-items.ts:88`) | 25/0 | TW | — | After T4a |
| T4c | Tests | 0/30 | TI TW | — | Same PR |
| T5 | Consumer for the per-stay `stays[].action`, which is stored and never read (`schema.ts:189`) | 15/10 | TW | — | Same PR as T4 |
| T9 | Mixed-ask task choice in the existing pane (`workflow-vocabulary.ts:40-110`) | 25/15 | CB | — | After T4/T5 |
| T6 | Pin current pre-stay + separate-ask behaviour with one test. There is no real mixed case in the corpus, so stop and reforecast if one appears | 0/10 | TP | — | Any time |
| T17 | Focused suites | 0/0 | TI TP TW | — | EC2 lock |
| T18 | Apex on two PRs | 0/0 | Apex | — | Reviewer wait |

Cut from T:
- T13–T15 evaluation: the owner removed the prod golden-set gate. It stays optional and uses staff outbound.
- T10–T12: fold into the PRs.
- T16: becomes L4t/L5t.
- T7/T8: speculative.

### F filing, 420 (F owner + Q helper + T helper)

The base code is uncommitted in `.claude/worktrees/agent-a622b74da134a5ced` (AGT) and in the planner's dirty tree (PEER):
- **AGT:** contract (43), source (155), `voucher-filing.tsx` (445), tests (743), and diffs to the attach tool and documents reader.
- **PEER:** service (169), client (83), and stubbed routes.

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| F0a | Consolidate AGT and PEER onto one branch; reconcile `VoucherFilingClient` with `PaneVoucherFilingClient` and the double `voucher-find.ts` `files[]` edit | 20/0 | FS FC | — | First; serial |
| F0b | Re-run the moved tests remotely | 0/0 | FS FC | — | After F0a |
| F7 | Non-DB source refusal tests. AGT's three tests use a DB helper, and DB suites are skipped | 0/30 | FS | — | Parallel with F8 |
| F8 | Cloud attach-form binder; reuse AGT's `beforeUpload` preimage hook | 40/25 | FS | — | After F0 |
| F9a | Replace PEER's route stubs (`unavailableFilingRead`) with real approval/snapshot deps (`hms-approval.ts:265,378`) | 30/15 | FR | — | After F8 |
| F9b | Wire approval callbacks | 30/15 | FR | — | After F9a |
| F9c (new) | Teach `parseHmsWriteForm` (`pane-hms-write.ts:154`) the `cloud-write/v1` attach form | 25/20 | FR | — | Parallel with F9b |
| F11b-1 | Runner: open the page with service workers blocked, `currentLabtestRecord`, consume the grant | 40/0 | FR | — | Serial core |
| F11b-2 | Runner: read the approved source, call `attachLabtestDocument`, map the outcome (absorbs F10/F11a/F12) | 50/0 | FR | — | After -1 |
| F11b-3 | Runner tests | 0/40 | FR | — | After -2 |
| F13 | Persist pre-dispatch intent to the DB (today a local JSON file) and fence `beforeRelease` against it | 30/20 | FR | — | After F11b |
| F14 | Stale grant, wrong stay, uncertain upload | 0/40 | FR FS | — | After F13 |
| F17a | Q: `voucher-filing-readback.ts`, metadata/bytes/uncertain contract plus a pure review function (absorbs F18) | 50/0 | new | — | Q helper, parallel |
| F17b | Q: wire export | 0/0 | new | — | — |
| F19 | Q: incomplete, duplicate and wrong-stay tests | 0/40 | new | — | Q helper |
| F20 | Q: document code `NV`+10 hex of the run ID. Rule: absent in baseline, present after, unique, tree not partial ⇒ "attributed (metadata)". The adapter already refuses duplicate codes (`stay360-document-attach.mjs:199`); code persistence was seen once (#862 handoff) | 10/10 | new | — | Q helper |
| F21 | T: mount AGT's card at `nava-pane.tsx:2375`; hide legacy attach | 20/10 | FC | — | T helper |
| F22 | T: metadata-only and uncertain states | 25/20 | FC | — | T helper |
| F27 (new) | T: persist `filingSession`/`filingFinish` states, or descope the session UI | 30/15 | FR | — | T helper; descoping saves 35 |
| F22a | Integrate the readback export into the service and routes | 40/20 | FS FR | — | After F17, F14 |
| F28 (new) | Admit filing on the worker lane; check effective PM2 env (http, worker, ai-worker, remote-http) | 10/0 | — | — | Before deploy |
| F29 (new) | Guard or retire the legacy `attach-document.mjs`/`hms-attach-once.ts` fallback | 10/10 | FR | — | Any time |
| F23 | Focused suites; report DB skips | 0/0 | FS FR FC | — | EC2 lock |
| F24 | Apex and one small fix | 0–20/0–20 | Apex | — | Reviewer wait |
| F25 | One synthetic PDF upload on a fake stay; screenshot | 0/0 | — | P-F upload | HRCEN queue |
| F26 | Fresh-session readback; report the evidence level | 0/0 | — | P-F read | After F25 |

Cut from F:
- F1–F6: done in AGT, or inspect-only.
- F10, F11a, F12, F13b, F18: merged into their function's piece.
- F15, F16: padding, already answered (`stay360-documents.mjs:65-66`).

### A amend, 330 (A owner + UI helper)

Base: merged #839/#860/#873/#876/#882. The AE/AM sibling is uncommitted in `.claude/worktrees/agent-a58d477dbd18020f4`: ~600 untracked LOC plus a 317-line diff, 9 commits behind main.

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| A0 | Port the sibling's uncommitted editor, prepare and tests onto the INT head; fix the `amend-lookup-panel` conflict | 0/0 | AM AE | — | First |
| A1 | Pick a clean fake stay (`labtest-preimage.mjs:158`) | 0/0 | — | read | Parallel with A0 |
| A4 | Confirm retain-rate evidence (`guest-stay-amend-adults.md:56-82`) | 0/0 | — | — | 5 min |
| A6a | Preimage gap: add native stay ID and child ages from the tooling snapshot (`children.mjs:56`) to the #882 reader | 40/0 | AM | read | After A0 |
| A6b | Preimage tests (non-DB) | 0/30 | AM | — | Same PR |
| A10 | Bind the approved delta to the preimage (`cloud-saved-stay-amend.ts:17-55`) | 30/20 | AM | — | After A6 |
| A11 | Swap `saveAmend` (`pane-hms-write.ts:778-792`) from legacy `amend-stay.mjs` to the Cloud runner under `executeUnderLock` | 40/30 | AM | — | After A10 |
| A12a | **Combined** date+occupancy stage on one page. Today each stage handles one field and refuses Save (`prepareOnly:true`); a page context can be used once | 50/0 | AM | unsaved stage | Serial core |
| A12b | Save matcher and validator for the combined form | 40/0 | AM | — | After A12a |
| A12c | Combined-stage tests (absorbs A24) | 0/50 | AM | — | After A12b |
| A15a | **Retain-rate continuation (new).** The route chain lets exactly one Save through (`saved-stay-save-route-chain.mjs:1`), and the lifecycle treats any dialog as stop (`labtest-amend-save.mjs:15,83`). Add one guarded second slot for the staff-chosen Yes/No | 40/0 | AM | — | After A12 |
| A15b | Continuation tests | 0/30 | AM | — | Same PR |
| A17 | Helper: wire `saved-stay-amend-editor.tsx` to the server and mount it | 40/30 | AE | — | Parallel with A12/A15 |
| A19 | Helper: hide the amount inputs as unsupported (D1) | 5/5 | AE | — | Same PR |
| A20 | Helper: retain-rate choice plus a "price effect unverified" label | 20/15 | AE | — | After A15a contract |
| A21 | Helper: readback and screenshot slot (`editor.tsx:103-113`) | 10/10 | AE | — | Same PR |
| A22 | Stale edit invalidates review | 0/15 | AM | — | Same PR |
| A23/A25 | Identity case plus uncertain/no-retry case (`resolveHmsNeedsCheck`) | 0/20 | AM | — | Same PR |
| A26 | Focused suites and Apex | 0/0 | AM AE | — | EC2 lock |
| A27a | One combined fake Save: date, occupancy and retain-rate choice | 0/0 | — | P-A Save | HRCEN queue |
| A27b | Expect one DOM iteration on the real modal; fix and re-stage on a fresh stay | 0–20/0 | — | P-A | Only if needed |
| A28 | Fresh-session independent readback | 0/0 | — | P-A read | After A27 |

Cut from A:
- A2, A3, A5: price shows only on Save, so they fold into A27.
- A16 and the amount half of A19: D1.
- A29/A30: the owner wants one representative save; re-run only if A27 ends uncertain.
- A6–A9 as four pieces: now one piece.
- A24: folded into A12c.

### M multi-room, 170 (M owner)

Base: uncommitted batch code (~1,550 LOC) in `.claude/worktrees/agent-a649800c980aff834`, based on #878, before #880/#884/#886. Its executor says it is an "Integration contract, NOT a Cloud implementation" (`hms-batch-executor.ts:37-48`).

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| M1 | Confirm reuse with that worktree's owner; port the manifest schema (`hms-batch-manifest.ts`) | 0/0 | MB | — | During C |
| M2a | Port `batch-booking-review.tsx` rows and the include toggle; lift `multiRoomHold` (`booking-card.tsx:1540`) | 30/20 | MU | — | During C |
| M2b | Invalidate the reviewed manifest on edit | 10/15 | MU | — | During C |
| M6 | Scope accepts child k of n: row `count=n`, `roomIndex` 1..n, max 8 (`pane-create-scope.ts:58-62`); keep `parentStayId` refusal semantics | 25/20 | CA MB | — | After C10 merges; coordinate with G9a |
| M8a | Manifest grant = digest of ordered child stay digests + preview digests, one staff Go | 30/0 | MB CA | — | After M6 |
| M8b | Derive per-child claims from it; no click per room | 20/20 | MB | — | After M8a |
| M11a | Serial dispatch through the existing single-create commit core | 30/0 | MB CR | — | After M8 |
| M11b | Stop on the first uncertain child; partial stays partial | 15/25 | MB | — | After M11a |
| M14 | Per-child result rows (port `batch-booking-evidence.tsx`) | 15/15 | MU | — | Parallel with M11 |
| M17 | Two fake child saves, each with its own readback, no send | 0/0 | — | P-M ×2 | HRCEN queue |
| M19 | Focused suites | 0/0 | MB MU | — | EC2 lock |
| M20 | Apex | 0/0 | Apex | — | Reviewer wait |

Cut from M:
- M10/M16 sibling preimage census and unsaved-draft census: each child already gets its own preview and readback.
- Separate worker lease: the inline commit core suffices.
- Native linking: not asked for.

### I integration, 140 (integrator)

| ID | What | P/T | Test | HMS | Par |
|---|---|---|---|---|---|
| I2 | Webmail exact message: thread `sourceMessageId` through `mail.tsx:756` → `WebPanePanel` → `selectPreviewMessage` (`web-pane-bridge.ts:102-117`, today latest inbound); refuse a missing ID; key the panel by message (`mail.tsx:757`) | 25/0 | HB HM | — | After kickoff |
| I3 | Selection and A/B/A stale tests | 0/45 | HB | — | Same PR |
| I6 | Outlook attachment-bytes parity. Only `GET_ATTACHMENT_METADATA` is in `bridge-protocol.ts:240`; confirm F's server-side byte read covers Outlook-selected mail | 0–20/0–20 | FC | — | Parallel with F |
| I17 | Review the identity and stale seam across lanes | 0/0 | — | — | After lane merges |
| I18 | Outlook: selected message → unsent reply (`CREATE_REPLY_DRAFT`) | 0/0 | — | P-H | Needs an Outlook route (§5) |
| I19 | Webmail: exact message → `drafts.saveReply` | 0/0 | — | P-H | Chromium |
| I20a | Integrated-head typecheck and suites | 0/0 | HB HM HD | — | EC2 lock |
| I20b | Integrated-head Apex | 0/0 | Apex | — | Reviewer wait |

Cut from I:
- I8–I12 per-host mounts: one shared `<NavaPane>` serves both `/outlook-pane` (`page.tsx:6`) and webmail (`web-pane-panel.tsx:72`). Real mounts (filing card, amend editor, batch review) live in the F/A/M pieces.
- I14–I16: duplicate per-PR Apex.
- I5: done.

### L release tail, 180 agent-min, 70 wall

| ID | What | Min | HMS | Par |
|---|---|---:|---|---|
| L1 | Final head: remote typecheck (41 s), focused vitest, Apex/P0-P1, `merge-gate.sh` | 15 | — | Run together |
| L2 | Fast-forward the deploy tree to main; `ops-deploy.sh` bundle sync (median 4–7 min; traps: 24 h dead-letter exit 1, `--migrate`) | 10 | — | Serial |
| L3 | Reload both bundles; verify the bundle SHA | 5 | — | Serial |
| L4 ×6 | Outlook smoke per lane: bundle SHA, selected mail, card state, screenshot, no send | 8 each | P-H | One per owner, in parallel |
| L5 ×6 | Webmail walk per lane: selected mail → result | 10 each | P-H | One per owner, in parallel |
| L6/L7 | Final deployed fake booking: prepare, Save, readback | 30 | P-C | Integrator, parallel with walks |
| L8 | Release note: evidence, skips, holds | 10 | — | Last |

## 3. What the plan misses

### 3.1 Uncommitted work: biggest saving and biggest loss risk

| Worktree | Contents | Base | Status |
|---|---|---|---|
| `.claude/worktrees/agent-a622b74da134a5ced` | Filing contract, source, card, tests, adapter diffs (18 dirty paths) | `d59655245`, 16 h old | No commit |
| `.claude/worktrees/agent-a58d477dbd18020f4` | Amend editor and prepare, AE/AM tests (12 dirty paths) | `d59655245` | No commit |
| `.claude/worktrees/agent-a649800c980aff834` | Batch manifest, events, executor, review, UI, tests (20 dirty paths, ~1,550 LOC) | `d59655245` | No commit |
| `three-connected-workflows` (planner) | Filing service, client, stubbed routes | `d59655245` | No commit |

The plan cites none of these paths. **S1 must safeguard them first**, with their owners' agreement, because the nightly Orca cleanup preserves dirty work but Orca lanes are not covered. The savings above assume reuse.

### 3.2 Underpriced or omitted work (now in the pieces)

| Item | Evidence | Added |
|---|---|---:|
| Amend retain-rate continuation request | `saved-stay-save-route-chain.mjs:1` allows one Save | A15a/b, 40 |
| Combined date+occupancy stage | Stages are single-field, `prepareOnly:true` | A12a–c, 50 |
| Preimage lacks native stay ID and child ages | #882 reader | A6a/b, 30 |
| Filing `cloud-write/v1` form schema | `pane-hms-write.ts:154` rejects it | F9c, 20 |
| Filing three-tree merge, session store, worker env, legacy fallback | AGT/PEER/INT divergence | F0, F27–F29, 85 |
| Create `reservationNote` required | `cloud-input.ts:58-60` | G21, 10 |
| Triage voucher rule contradiction | `extract.ts:52` vs `:77/:92` | T2, 30 |
| Outlook attachment-bytes parity | `bridge-protocol.ts:240` metadata only | I6, 20 |

### 3.3 Factual errors in plan 004

1. **Quote reader.** The plan says the installed reader leaves total and tax unknown. That is the Cloud availability reader, which feeds the prefetch only. Staff quotes use `fetch-quote.mjs`, and VAT/levy is policy-gated. The remaining question is only whether the PDF "total" should be labelled as a sum of displayed rates.
2. **"Quote, triage, create, filing, amend components already mount."** Filing (only `VoucherFindCard`) and amend (editor unmounted) do **not** mount. Quote, create and triage do.
3. **G2 "new guest without a profile write".** The create tool stops with `guest_not_found` (`create-reservation.mjs:166-168`), and the profile guard requires `newprofileclick` blank (`guest-profile.mjs:475-491`). There is no new-guest path, and adding one means a shared-profile write. The owner put that out of scope on 2026-11-01.
4. **Kickoff.** Worktrees don't install; EC2 runs checks from a git bundle (`remote-typecheck.sh:12`). 10 min per worktree is wrong.
5. **"Five-lane fallback = 765".** It inherits all the padding. Re-derived: ≈470.

## 4. Order, ROI and checkpoints

**Order is right with one change.** Run all lanes in parallel from minute 30. If capacity drops, cut in this order:
1. Multi-room M.
2. Triage T4/T5/T9.
3. Guarantee G11.
4. Filing session store F27.

| ROI rank | Lane | Why |
|---|---|---|
| 1 | C | Smallest change, unlocks G and M, gives the first fake booking at ~105 |
| 2 | Q | Majority of bookings; one probe; nearly built |
| 3 | F | Owner said voucher filing may jump the queue; the code mostly exists uncommitted |
| 4 | G | Party and existing guest = real corporate mail |
| 5 | A | Real gap, but the slowest and riskiest live path |
| 6 | T | Mostly built; fixes are correctness polish |
| 7 | M | Thin wrapper; lowest frequency |

**Checkpoints:** event-driven, not every 45 min.

| # | Event | ~Raw min | Decision it gates |
|---|---|---:|---|
| K1 | Worktrees safeguarded, lanes dispatched | 30 | Go |
| K2 | P-Q probe result | 60 | Label change or no-op |
| K3 | First fake booking read back | 105 | Unblock M6/G |
| K4 | A12 combined stage staged unsaved | ~180 | Amend path viable or reforecast |
| K5 | F11b runner first fake upload | ~250 | Attribution level |
| K6 | A27 retain-rate save read back | ~280 | Biggest risk retired |
| K7 | All lanes merged, I20 green | 340 | Deploy |
| K8 | Deploy, walks, final fake booking | 410 | Done (owner's bar) |

Each checkpoint reports: elapsed, original ETA, prior ETA, revised remaining ETA (calibrated once), critical path, and holds. A checkpoint is also triggered by any hold or by a critical-path piece running more than 50% over.

## 5. Human hours

- AI agent work: ≈1,750 agent-min ≈ **29 agent-hours** across 8 sessions, giving **≈6.5–7 h wall**.
- Owner and human time: answer D1–D4 (5 min). The Outlook smokes need a human only if no remote Windows/Outlook route exists; the repo has no Outlook automation (`use-outlook-bridge.ts:805` is inert outside WebView2). Six smokes at 8 min each comes to about 50 min of human time. There are no real-guest approvals: all writes are Labtest.

## 6. Spot-checks I ran myself

| Claim | Verified |
|---|---|
| Create hold is one constant function, 3 call sites | `quote-workflow.ts:204,306,471,576` ✅ |
| Webmail picks the latest inbound message, not the selected one | `web-pane-bridge.ts:102-117` ✅ |
| Create scope refuses any party | `pane-create-scope.ts:24` ✅ |
| `reservationNote` required; Labtest search hard-coded | `pane-create-cloud-input.ts:50,60,96` ✅ |
| Three agent worktrees dirty, last commit 16 h ago | `git status` 18/12/20 paths ✅ |

Everything else is subagent judgment from reading the code. LOC and minutes are estimates, not measurements.

## 7. Decisions for the owner

| # | Decision | Recommendation | Effect |
|---|---|---|---|
| D1 | **Manual "amount" amend.** No owner ask found; it first appears in agent plans 002/003 | Drop. Show it as unsupported; rate-plan change already has staging tools | −40 min and removes an "incomplete" hold |
| D2 | **New-guest create.** Needs an HMS profile write, which the owner put out of scope on 11-01 | Pilot = existing guest only; a new guest shows "needs a profile in HMS first" | Removes G8 (unbounded) |
| D3 | **Outlook proof.** No automation; owner said each lane on both hosts | Six 8-min smokes, plus one full native reply walk | Keeps the owner's bar at −72 min |
| D4 | **Real CMS recipient (G12).** Needs real-guest authority | Defer to the go-live step; fake/test CMS stays off | No build now |

Not decisions, just do them:
- safeguard the uncommitted worktrees;
- reuse the batch, filing and amend code;
- DB suites reported as skipped;
- deploy main via the bundle;
- staff outbound as eval truth.
