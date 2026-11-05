---
title: Connected Pilot Recovery - Plan
type: feat
date: 2026-11-03
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md
---

# Connected Pilot Recovery - Plan

## Goal Capsule

- Deliver all six staff workflows on deployed main: triage, quote, single create, filing, amend and separate multi-room create. Verify webmail and the fake Outlook bridge; finish with a deployed Proof Labtest booking and fresh readback.
- Run shape: **4-hour target, 6-hour hard cap**, with the concrete hourly targets below. These are scheduling targets from the adversarial review, not a high-confidence delivery ETA. Completion time remains unknown.
- Lead with selected email → staff Go → guarded fake booking → screenshot → fresh readback. Verify the installed quote path in parallel. Filing can prove against an existing eligible fake stay; otherwise it depends on create.
- Readiness means safe implementation can start. Release, live probes and real staff use remain subject to the holds below. This plan alone does not authorize launching a run, commits, pushes or deployment.
- Authority: current owner instructions, `PRODUCT.md` and `AGENTS.md`. Fake Proof Labtest writes for 2027+ stays are allowed; CMS send stays off in tests. Real-guest writes and sends require authority in the executing session.
- At 360 minutes stop starting work and report. If a dispatched write is still in flight, finish safe settlement or reconciliation without interrupting it; record any overrun. Preserve other sessions, worktrees and uncommitted files.

---

## Product Contract

### Summary

Preserve the product contract from [plan 005](2026-11-02-005-feat-connected-pilot-final-plan.md) and this plan's R1–R10. Ship working staff paths, not disconnected helpers. Proof on a fake stay establishes integration, not staff adoption or ROI.

### Requirements

- R1. Triage each inbound request; preserve per-stay actions and separate asks, including a genuine second ask in self-sent pre-stay mail. Never offer create for that pre-stay booking.
- R2. Quote using company/agency contract rates, availability and correct party. Cover email, PDF and Excel; obey BAR B&B, dinner add-on, fully booked alternative selection and no company name in the reply body. Save drafts unsent.
- R3. Create a single stay from the exact selected email, with guest lookup/new guest, agency or organization, guarantee and CMS recipient. Bind staff Go to the approved intent and native save.
- R4. File the selected voucher or proof-of-payment attachment into the selected stay, with fresh Documents readback.
- R5. Amend dates, occupancy, rate plan and retain-rate choice. Manual amount entry remains out of scope.
- R6. Create multiple separate single-room bookings under one staff Go; show individual outcomes and preserve partial or uncertain results.
- R7. Each write follows Prepare → staff Go → native guard → Save → screenshot → fresh readback. Never accept a cancellation penalty or blind-retry an uncertain write.
- R8. Preserve both pane surfaces, fail closed on ambiguous source identity, and avoid raw technical errors or dead controls.
- R9. Complete the product bar: main deployed through the approved bundle path, each workflow walked on the deployed pane, and a final fake booking. Plan 005 also calls for fake Outlook-bridge replays; actual Outlook client validation is separate.
- R10. Measure prospective staff value using paired manual/assisted effort, adoption, rework/errors and operating/build costs. A fake booking, a merge or an exploratory case does not prove ROI.

### Scope and examples

- All six workflows remain in scope. Cancel remains lab-only; groups, billing, OCR/POP intake and manually entered create rates follow `PRODUCT.md` backlog boundaries.
- A/B/A message navigation preserves the selected message and drafts. A stale explicit source must not silently resolve to another email. Normal thread navigation must still let staff select an inbound message.
- A changed source, form, actor or approved digest invalidates the old Go. Double Go, concurrent edit, lost lease or an uncertain native dispatch must not produce a duplicate.
- Two rooms produce separate confirmations. If room two is uncertain, preserve room one's result and stop; selection changes must not erase recovery.

---

## Planning Contract

### Evidence and design

- Audited GitHub main was `611054da09b4` at 02:56 UTC on 2026-11-03. Recheck and pin actual main at execution. Shared root and the approved deploy worktree have unrelated changes; do not reset, stash, overwrite or copy them into a release.
- Use outside-in slices: mount a staff control and route to the real HMS adapter in the same reviewable behavior. Reuse existing guards, approval, sessions and readbacks where their contracts fit. Do not add a guard-only or uncalled helper PR as a substitute for a path.
- Prefer one self-contained PR per workflow, based on current main; no stacked branches. Shared source and deploy fixes may need separate PRs; quote needs a PR only for a reproduced defect. Seven or more PRs are possible. If a safe vertical slice exceeds the approximately 500 gross-product-line gate, split into the minimum independent, safe, live-caller behaviors on successive main heads. Never bypass the gate.
- Start fresh lanes from current main. Do not port `5dee03dc`, `873b18df`, `75aef65e`, `8ceea94d`, `a6c4d7b8b` or `0bee62ec2`: their navigation, refusal or unmounted-route approaches do not provide the connected paths. Preserve equivalent authority, preimage and uncertainty protections in the new live paths. The separately reviewed triage and amend candidates below remain options.
- Candidate `159207fe` has two commits: `63661548` carries the pre-stay change; `159207fe` adds bounded pagination. Integrate the verified net behavior from both if it passes review; cherry-picking only the latter misses the triage fix.
- Candidate `8ceea94d` changes `hms-cloud/hotel-availability.mjs`; the installed staff quote reader invokes `tooling/playwright-quote/fetch-quote.mjs`. Compare the installed route before changing providers.
- The review's approximate dormant-code percentage is not established. Several paths are disconnected, but one listed Cloud module was unchanged across the audited run and is imported elsewhere. A helper may still contain needed safety behavior.
- [Opportunity data](../research/halloween/b2b-dashboard/2026-11-02-inbound-led-report.md): model labels marked 367 voucher-filing and 138 quote cases potentially supported among 1,361 actionable inbounds over about 34 days. Labels overlap and use broad assumptions; they do not measure staff use or ROI.
- Sources: [independent retrospective](../research/halloween/2026-11-02-llm-retro/2026-11-03-k-chain-independent-retrospective.md), [adversarial review](../research/2026-11-03-plan-001-adversarial-review.md), [runtime handoff](../context/HANDOFF-2026-11-03-kchain-runtime.md), [planning evidence](../research/halloween/2026-11-02-llm-retro/2026-11-03-next-pilot-planning-notes.md).

### Size and time evidence

Reviewer figures below are unvalidated product-line hypotheses, not measured remaining work. The merge gate counts additions plus deletions, excluding tests, fixtures and Markdown. Tests, integration, review repairs and existing candidate commits are extra unless stated.

| Unit | Review hypothesis | Known counterevidence |
|---|---:|---|
| U2 source | ~50 P | Normal list clicks do not set a message ID; exact-ID-only plumbing also needs a usable selection path. |
| U3 create | ~180 P | Server-owned Go/fence, native authorization callbacks, party/recipient and outcome settlement are not connected. |
| U4 quote | 0–25 P | Installed path exists; parity and output behavior are unproved. |
| U5 triage | ~210 P net | Candidate diff is 331 P / 373 test lines gross against audited main; parent and follow-up both matter. |
| U6 filing | ~50 P | Native tool needs a page, verified bytes, approval at dispatch and fresh reconciliation; existing binder rejects missing stored hashes. |
| U7 amend | ~180 P additional | UI candidate `3a59e1338` is 251 P gross; `ffeffe93` adds 34 P gross. Native saves remain prepare-only. |
| U8 multi-room | ~60 P | Existing loop uses parent linking; native preimage requires empty matches and has no wired batch exception. |
| U9 release | ~10 P | Approved deploy and restart scripts also have the stale build-marker fallback. Actual deployed artifact and release tree are unresolved. |

The review's listed numbers add to roughly 740–765 P before the two U7 candidate commits and before replacing U5's net figure with gate-measured gross. They are hypotheses with overlapping changes, not an additive forecast or a lower bound. Measure actual diffs and test lines per final head.

Last run: 36 main PRs that merged had median 21.4 minutes and P75 40.3 minutes from opening to merge; this excludes coding before PR. Of 70 opened PRs, 33 were still open at pause, all at least 79 minutes old. The first fake create was still unproved after about 5h38. These cohorts do not predict this run's completion time. Review, rework, shared test queue, deploy and native proof tails are not priced well enough for a credible ETA.

Four hours is the requested stretch target; six hours is the cap. At each hourly checkpoint report actual deliverables, elapsed coding, waiting, tests, review, HMS proof, remaining dependencies and any evidence-based reforecast. Do not convert a missed target into a false success or skip gates.

### Dependency and ownership

The critical proof path is selected source → approved single create → separate multi-room creates → integrated main → deploy → final fake readback. Triage, quote, filing and amend coding can start in parallel; their selected-source proof waits for U2. Filing and amend need an eligible existing fake stay or U3's result.

Aim for four to five workflow workers plus one integrator when the active harnesses have capacity. The current Codex harness has four total slots: run the integrator plus three workers and rotate the fourth lane as capacity frees, unless another authorized harness actually supplies additional slots. Coordinate file ownership and the shared local-test cap across harnesses; do not claim capacity that does not exist. Workers:

| Lane | Owns first | Then / dependency |
|---|---|---|
| Source + triage | U2 mail selection and bridge | U5 triage after source work; shared UI handed to integrator. |
| Filing + quote | U6 filing adapter and card | U4 installed quote comparison; both begin independently of U3 when an eligible fake stay exists. |
| Create + multi-room | U3 Cloud create | U8 after U3's approved create and native preimage contract. |
| Amend | U7 Cloud amend and editor | Merge shared UI/write changes through integrator. |
| Integrator | U1, shared files, gate queue, U9 release | Read every product diff, coordinate overlap and collect proof. |

`work-items.ts`, `pane-hms-write.ts`, `nava-pane.tsx` and shared pane snapshot tests require explicit integrator ownership or a sequential handoff. Workers may work in isolated trees on disjoint files while the integrator combines the live route. Do not overwrite another lane's edits.

Routing proposal, subject to actual model availability and price: use `gpt-6-luna` at max effort for bounded source UI or read-only quote comparisons; use `gpt-6.1-terra` at max effort for the integrator and create, filing authority, amend and batch dispatch. The higher-risk filing boundary needs review even if a cheaper worker prepared the UI. Record actual model, effort and cost; do not treat a model choice as proof.

Run focused Vitest and `node --test` locally under the owner-approved three-run cross-harness cap and at least 20% CPU and available-memory headroom. Check resource use and active tests first; bound test workers. Typechecks still use the single-checkout EC2 route. Batch focused files per app and final head; run review and independent coding in parallel. Read-only HMS lookups and unsaved prepare previews may use separate verified browser sessions concurrently without a policy-level property lock; installed routes may still enforce one. Do not bypass it. Serialize conflicting writes and preserve atomic duplicate/preimage checks through Save.

Workers send completion, blocker or risk events. Use a supported event wait, such as `orca orchestration check --wait --timeout-ms 60000 --json` when the run is bound; process and acknowledge the full FIFO batch. `orca orchestration wait` is not an installed command. No repeated 15-minute screen or PR polling. Fifteen-minute work slices below are planning granularity, not required status posts.

### Hourly deliverable targets

Targets are conditional on safe checks and available runtime. If a target is missed, state exactly what is missing, keep independent safe work moving, and reforecast only from observed evidence.

| Checkpoint | Target deliverables |
|---:|---|
| 0–15 min | Pin main and roles; verify runner and property ownership; start source, create, filing/quote and amend lanes as capacity allows. Do not spend a full slot repeating the retrospective inventory. |
| 60 min | Source and filing vertical PRs checked, reviewed and merged; one installed quote compared with HMS and document outputs; triage and create PRs in checks/review. |
| 120 min | Triage and create PRs merged. Prove selected email → Go → fake filing → fresh Documents readback and selected email → Go → fake single create → screenshot + fresh readback. Amend and multi-room PRs in checks/review. |
| 180 min | Amend and multi-room merged. Prove one Labtest amend with dates, occupancy and rate/retain choice; prove two separate Labtest creates with two fresh readbacks. |
| 240 min | Release identity fix merged, final main checked and deployed through `ops-deploy.sh`; verify actual artifact and four affected PM2 processes. Walk six workflows in deployed webmail and fake Outlook bridge; finish one deployed fake booking + fresh readback. |
| 240–360 min | Resolve real failed checks, valid review findings, property/DOM issues and deployment holds. Do not presume two hours covers them. Stop at the cap as stated above. |

---

## Implementation Units

Numbered actions are work packets sized to be attempted or checkpointed within about 15 minutes, not duration forecasts. Split further as needed. Start the next packet when its prerequisites hold; do not create a meeting or polling loop for each packet.

### U1. Pin baseline and measurement

- **Goal:** Begin vertical work immediately from a safe, known baseline.
- **Requirements:** R7–R10. **Dependencies:** none. **Owner:** integrator.
- **Files:** `PRODUCT.md`, `AGENTS.md`, `docs/context/HANDOFF-2026-11-03-kchain-runtime.md`, approved runner scripts.
- **Approach:** 1. In a short preflight, pin current main, existing worker/checkout ownership, available slots, local test capacity and the remote typecheck lock. 2. Confirm the allowed property, isolated browser sessions, existing write locks and fake-stay proof route; start independent code lanes while any live route is held. 3. Record per-head implementation, queue, check, review and proof times; assign shared files.
- **Patterns to follow:** Existing worktrees are evidence, not permission to modify them. Do not disable shared Hindsight hooks; avoid repeated calls if unavailable.
- **Test scenarios:** Test expectation: none; preflight is read-only. Do not update snapshots until U5 verifies the actual failure.
- **Verification:** Exact baseline, lane ownership, safe-test route, live holds and start time recorded; no other session interrupted.

### U2. Bind the selected message

- **Goal:** The pane and downstream work item use the exact inbound message staff selected.
- **Requirements:** R1, R3, R8. **Dependencies:** U1. **Owner:** source worker.
- **Files:** `apps/mail/components/mail/mail.tsx`, `mail-list.tsx`, `thread-display.tsx`, `apps/mail/components/nava-pane/web-pane-panel.tsx`, `apps/mail/lib/workstation/web-pane-bridge.ts`, targeted mail tests.
- **Approach:** 1. Carry the existing `sourceMessageId` from selection state through `WebPanePanel` and `useWebPreview`; distinguish stored `message.id` from the Internet Message-ID. 2. Make ordinary list, keyboard, linked-thread and within-thread navigation establish or visibly request a real inbound selection; clear stale IDs when changing threads. 3. Resolve an explicit ID only within the correct thread and mailbox; refuse missing, duplicate or foreign identities. Never substitute latest inbound for a stale explicit ID. 4. Preserve draft flush and source state on A/B/A navigation; keep `use-mail-navigation.ts` unchanged unless a demonstrated defect requires it.
- **Patterns to follow:** Prefer the existing mail/pane bridge. Do not port `5dee03dc` or `873b18df` or add their SQL changes merely to carry the ID.
- **Test scenarios:** Two inbound messages in one thread, A/B/A, ordinary thread with no URL source, keyboard and linked-thread navigation, missing/wrong ID, late response, unsaved drafts, Outlook bridge parity.
- **Verification:** Targeted mail tests and typecheck on final head; staff can choose the intended message on ordinary and workflow-folder routes. Review the actual product diff.

### U3. Connect one approved create

- **Goal:** One selected source and staff Go authorize exactly one guarded Cloud create with truthful settlement.
- **Requirements:** R3, R7, R8. **Dependencies:** U1 for coding; U2 for source-bound proof. **Owner:** create worker; integrator owns shared state.
- **Files:** `apps/server-pilot/src/trpc/routes/quote-workflow.ts`, `apps/server-pilot/src/ai/pane-create-scope.ts`, `pane-create-dispatch-fence.ts`, `pane-stay-preview-persist.ts`, `pane-stay-save.ts`, `work-items.ts`, `apps/server-pilot/tooling/hms-cloud/create-reservation.mjs` and focused tests.
- **Approach:** 1. Wire existing card → `previewStay`/`commitStay` → `createReservation` and adapt results to the pane's existing contract; refuse missing work-item/source identity. 2. Bind server-owned actor, transport, source, stay, selected party, approved fields and digest. In one row-locked transaction consume the Go and begin the fence; refactor the existing preview-consume transaction if needed. 3. Supply both native `authorizeCandidate` and `dispatchCandidate` callbacks; recheck ownership and the exact approved request at dispatch after asynchronous waits. No browser-supplied authority. 4. Persist dispatched/uncertain/confirmed per stay with screenshot and fresh readback. A failed outcome persist after possible Save stays uncertain; do not return success or retry. 5. Add verified agency/organization, guarantee and CMS-recipient mapping. Scope validation must cover selected parties; the present validator also permits only one active stay/row/room. Keep CMS send off for fake proof. 6. Investigate first-time guest behavior from an unsaved, allowed probe; implement only the verified path with the same authority and proof.
- **Patterns to follow:** `createReservation` accepts `prepare`/`commit` but its callbacks are optional at the native boundary; the pane path must require them. `cms.recipient` is currently unsupported. `stageUnresolvedGuestName` does not create a profile or authorize Save. The old `commitStay` catches persistence failure; do not inherit a false-success path.
- **Test scenarios:** selected vs wrong mail/party; changed form, actor or recipient; missing callback; expired/replayed/double Go; concurrent edit and lease loss; unsupported guest or guarantee; save and persistence failure after dispatch; readback mismatch; send off. Report skipped DB-backed tests.
- **Verification:** Same-head focused checks and Apex. Then an allowed Labtest create through the actual pane route with screenshot and fresh readback. The first fake proof may cover a supported subset; do not call R3 complete until all required fields and new-guest behavior are proved.

### U4. Verify quote value

- **Goal:** Prove the existing staff quote path against HMS and fix reproduced gaps.
- **Requirements:** R2, R8, R10. **Dependencies:** U1; U2 for selected-message proof. **Owner:** filing/quote worker.
- **Files:** `apps/server-pilot/src/trpc/routes/workstation.ts`, `apps/server-pilot/src/ai/staff-quote-workflow.ts`, `reservationist-evaluation-composition.ts`, `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs`, quote/PDF/Excel components and tests.
- **Approach:** 1. Trace `executeStaffQuote` and queued behavior, current `HMS_JOB_QUEUE`, `HMS_QUOTE_PREPARE` and `QUOTE_RATE_CONTEXT` from durable config and effective processes. `HMS_QUOTE_PREPARE` controls background preparation, so do not blindly enable or equalize it. 2. Use an approved HMS read-only probe with identical property, dates, occupancy and selected agency/company; compare one installed quote against an independent fresh HMS read. 3. Inspect email, PDF and Excel; patch only a reproduced discrepancy. 4. Exercise contract and BAR, dinner, unavailable/selected alternative, correct party, currency and unsent draft cases.
- **Patterns to follow:** Keep the installed provider; do not port `8ceea94d`. The HMS comparison can be read-only while `executeStaffQuote` records application ledger state. Tests must not use pilot RDS.
- **Test scenarios:** Wrong/blank party, stale source, unavailable rooms, selected vs unselected alternative, dinner, currency, no company name in reply, PDF/Excel consistency, no send.
- **Verification:** Targeted same-head tests plus one live comparison with source, inputs and output recorded. One comparison diagnoses a case; it does not establish general rate parity or ROI.

### U5. Preserve all triage asks

- **Goal:** Surface a genuine second request without offering a new booking for pre-stay self-mail.
- **Requirements:** R1, R8. **Dependencies:** U1; U2 for source proof. **Owner:** source/triage worker; integrator owns shared files.
- **Files:** `apps/server-pilot/src/ai/workflows/mail-triage.ts`, `extraction/extract.ts`, `work-items.ts`, `work-items-list-pages.ts`, `apps/mail/components/nava-pane/nava-pane.tsx`, related tests.
- **Approach:** 1. Compare both commits through `159207fe` against current main; inspect the earlier pagination P1 and its follow-up. 2. Port the minimum complete behavior, including candidate pagination if needed; keep active per-stay and separate asks visible in the mounted pane. 3. Run the actual failing tests on the final head. Inspect the four reported snapshot diffs and wait failure; update snapshots or waits only after verifying expected behavior. 4. Recheck front-door exclusions and travel-agent scope.
- **Patterns to follow:** Generic own-mailbox + pre-stay subject + confirmation rule; no property-specific string. Preserve the pre-stay exclusion while routing a grounded separate request.
- **Test scenarios:** Pure pre-stay, pre-stay plus genuine second ask, quoted history, different sender, multiple stay actions, passive/amend rows, pagination with invalid rows before valid rows.
- **Verification:** Focused server/mail tests, exact-head Apex and validated P0/P1s; DB-backed suites skipped only as permitted and reported as skipped.

### U6. Connect filing

- **Goal:** File the exact approved attachment into the exact stay, then reconcile.
- **Requirements:** R4, R7, R8. **Dependencies:** U1; U2 for source proof; an eligible fake stay or U3. **Owner:** filing/quote worker; integrator owns shared write file.
- **Files:** `apps/server-pilot/src/trpc/routes/hms-approval.ts`, `apps/server-pilot/src/ai/pane-hms-write.ts`, `voucher-filing-pop3-source.ts`, `apps/server-pilot/tooling/hms-cloud/stay360-document-attach.mjs`, `stay360-documents.mjs`, existing voucher card and focused tests.
- **Approach:** 1. Mount the smallest `bindAttach` route using existing `bindAttachDocumentForm` and `prepareHmsWriteSnapshot`, with selected message, attachment and target stay. 2. Hash bounded current bytes before approval and re-read/revalidate them for dispatch, including POP3 rows with null metadata hashes and Outlook-sync; reuse the narrow source helper where needed. 3. Replace the legacy attach runner with an adapter that opens the verified guarded page/session, passes the exact bytes and private evidence root, and verifies the server-owned Go and current stay at the native upload fence. 4. Persist screenshot evidence and map `not_dispatched`, `awaiting_readback` and `uncertain` correctly. Reopen the stay in a fresh session and confirm the named document with sufficient refresh/coverage evidence before marking success.
- **Patterns to follow:** `attachLabtestDocument` is a page function, not a drop-in CLI; its screenshot names differ from the old runner's `before.png`/`after.png` filter. `readDocumentsFromStay360` returns loaded names only, with refresh/complete coverage unverified; it does not download or hash stored bytes. Do not port `a6c4d7b8b`; its durable-authority and preimage hold must be replaced by equivalent proof in the new path. Do not port the entire unmounted filing stack by default.
- **Test scenarios:** Both mail sources, missing stored hash, changed bytes after Go, wrong stay/mail, duplicate or stale grant, page/context violation, upload possibly dispatched, missing screenshot, incomplete/stale Documents tree and failed persistence.
- **Verification:** Approved same-head tests and review, then selected email → staff Go → allowed fake-stay upload → screenshot → fresh Documents readback. Report byte-upload proof separately from Documents-name readback.

### U7. Connect amendment

- **Goal:** Staff approve and safely save the selected dates, occupancy and rate/retain choice.
- **Requirements:** R5, R7, R8. **Dependencies:** U1; U2 for source proof; eligible fake stay or U3; shared-file handoff. **Owner:** amend worker.
- **Files:** `apps/mail/components/quote-workflow/saved-stay-amend-editor.tsx`, `saved-stay-amend-choices.tsx`, `amend-lookup-panel.tsx`, `apps/mail/components/nava-pane/nava-pane.tsx`, `apps/server-pilot/src/ai/pane-hms-write.ts`, `apps/server-pilot/tooling/hms-cloud/saved-stay-agent-session.mjs`, `labtest-amend-save.mjs`, amendment adapters and tests.
- **Approach:** 1. Inspect and selectively integrate UI candidate `3a59e1338` and lifecycle fix `ffeffe93`; both are separate children of audited main. Preserve dirty candidate trees. 2. Bind selected-stay preimage, editable fields and rate/retain choice to the existing server approval. 3. Compose date/occupancy/rate staging into one guarded native Save through the saved-stay session; implement exact native request matching and availability recalculation evidence before allowing dispatch. 4. Adapt `previewAmend`/`saveAmend`, screenshot and fresh saved-stay readback to the existing pane outcomes.
- **Patterns to follow:** Current date/rate and adult adapters are `prepareOnly` with `matches: () => false`; flipping a save flag alone cannot safely enable them. Preserve rate-choice semantics and never accept a penalty.
- **Test scenarios:** Wrong or changed stay, stale preimage, selection switch, date/occupancy with rate/retain choice, paid/unpaid behavior, penalty dialog, lease loss, partial/uncertain dispatch and readback mismatch.
- **Verification:** Targeted approved tests and review; then one allowed fake amendment with screenshot and independent readback of all approved values.

### U8. Complete separate multi-room creates

- **Goal:** One staff Go starts separate creates and durable per-room outcomes.
- **Requirements:** R6–R8. **Dependencies:** U1; U2 source; U3 guarded create. **Owner:** create/multi-room worker.
- **Files:** `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/server-pilot/src/ai/hms-batch-manifest.ts`, `hms-batch-preimage.ts`, `pane-create-dispatch-fence.ts`, `apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs`, related tests.
- **Approach:** 1. Reuse the existing `bookThisStay` serial loop; stop passing `parentStayId` so rooms do not become native associated reservations. 2. Bind one server-owned immutable ordered manifest and one Go to each child; persist each result independently. 3. Connect the trusted native census to `checkBatchPreimage` or an equivalent proof: only confirmed, independently read-back siblings of this exact manifest may explain existing same-arrival matches. 4. Scope and evidence-close the create fence per child or the whole batch while preserving work-item mutation exclusion; uncertain children remain fenced until reconciliation. 5. Preserve partial results across selection changes and restart.
- **Patterns to follow:** The TS `checkBatchPreimage` is not wired into the Cloud session; current native code refuses any non-clear census. A client-provided same-work-item confirmation is not sufficient proof. Do not port `0bee62ec2` or invent its unmounted batch client as the default path.
- **Test scenarios:** Two rooms and distinct confirmations, edited/reordered manifest, foreign sibling, duplicate Go, same-arrival census, incomplete proof, partial success, selection change, timeout after possible dispatch, recovery without duplicate Save.
- **Verification:** Same-head tests and review; then two allowed fake creates under one Go, two separate fresh readbacks and a demonstrated partial/uncertain recovery case.

### U9. Integrate, release and measure

- **Goal:** Deploy the actual integrated code, prove each staff path, and separate technical completion from ROI.
- **Requirements:** R7–R10. **Dependencies:** U1–U8 for full technical pilot. **Owner:** integrator.
- **Files:** `scripts/orch/merge-gate.sh`, `apps/server-pilot/deploy/ops-deploy.sh`, `deploy-ec2.sh`, `pm2-boot.sh`, `ops-restart.sh`, deploy tests and the approved deploy tree.
- **Approach:** 1. Read each product diff; obtain exact-head applicable checks, one final-head Apex review and validated P0/P1 resolution; merge through the gate. 2. Fix stale `NAVA_BUILD_COMMIT` propagation on the actual `ops-deploy.sh` → `deploy-ec2.sh` path and boot/restart paths as warranted; verify `--update-env` behavior with targeted tests. Determine whether stale env caused the observed mismatch; do not assume it did. 3. Permit a clean, verified `origin/main` worktree in the bundle deploy guard and product instructions, preserving the other checkout untouched; independently verify the actual bundled branch and same script/working tree. Until that change is merged, the existing designated-checkout rule still applies. 4. Scope the deploy dead-letter gate to failures after this restart, retaining historical counts as visible information; capture a validated EC2-host boundary before reload so early failures are not missed. Use failure time, not row creation time, so older queued work that newly fails still counts. 5. When authorized, deploy main through the approved bundle path. Verify bundle/build artifact, checkout, process markers and durable/effective flags for `http`, `worker`, `ai-worker`, `remote-http`; confirm property readiness and final-SHA canary before enabling any workflow. 6. Walk all six on deployed webmail and fake Outlook bridge, then perform a final fake booking and fresh readback. 7. Before actual staff use, validate the real Outlook client and obtain executing-session real-guest authority; measure adoption, manual vs assisted time, errors, rework and costs.
- **Patterns to follow:** `deploy-ec2.sh` and `pm2-boot.sh` already use PM2 start with `--update-env`; a claimed marker alone is not deployed-artifact proof. Do not blanket-align flags across unrelated roles. Do not use `PURE_MOVE=1` for deleting dormant code; that exception is only for authorized pure moves.
- **Test scenarios:** Clean exact-main vs dirty, stale, mismatched-script or wrong-branch deploy tree; pre-restart vs post-restart dead letters, including an older job newly failed; inherited stale SHA in deploy, boot and restart; actual build identity; each process flag; webmail and Outlook source identity; six deployed flows; screenshot/readback; partial and uncertain recovery; no send.
- **Verification:** Same-head targeted tests and remote typechecks, exact-head Apex and valid P0/P1 resolution, gated merges, verified deployment and per-workflow evidence. State DB skips and any unmet staff/ROI conditions.

---

## Verification Contract

- Before Vitest or `node --test`, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, `TEST_DATABASE_URL`. Never test against pilot RDS, bypass git/test hooks, run repo-wide lint/format or alter the mandatory typecheck wrapper. Limit local test runs to three across harnesses with at least 20% CPU and available-memory headroom; coordinate the cap, check current load and bound workers.
- For each final head and app, run the remote typecheck once and focused tests locally. Recheck HEAD before and after; a new commit invalidates the evidence. Example for U2, with `ZERO_PILOT_WT` set to its clean committed worktree and dependencies available:

```bash
ZERO_PILOT_SHA="$(git -C "$ZERO_PILOT_WT" rev-parse HEAD)"
if bash /home/orca/bin/remote-typecheck.sh "$ZERO_PILOT_WT" --app mail; then
  test "$ZERO_PILOT_SHA" = "$(git -C "$ZERO_PILOT_WT" rev-parse HEAD)" || exit 1
  if ! (cd "$ZERO_PILOT_WT/apps/mail" && \
    env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS -u TEST_DATABASE_URL \
      pnpm exec vitest run --maxWorkers=1 tests/web-pane-bridge.test.ts tests/use-mail-navigation.test.tsx); then
    printf '%s\n' 'Vitest failed; do not claim a pass.' >&2
    exit 1
  fi
  test "$ZERO_PILOT_SHA" = "$(git -C "$ZERO_PILOT_WT" rev-parse HEAD)" || exit 1
else
  printf '%s\n' 'Typecheck failed; do not skip or claim a pass.' >&2
  exit 1
fi
```

- Select the full focused test set for each change; the example is not U2's complete suite. If the remote Vitest route is needed, use `SKIP_TYPECHECK=1` only after a passing independent typecheck for the same SHA and app. The typecheck and Vitest still take the EC2 lock once each; preserve both results.
- Cloud `.test.mjs` uses `node:test`, not Vitest. Run focused suites locally with `node --test --test-concurrency=1` and the same environment/resource checks, or use a verified remote route if capacity is tight. A prior isolated EC2 archive (`169b9ddd-4d25-4cd5-aa05-0395a3810bfd`) may need extra dependencies for other suites.
- Record final head, app, command, queue/start/end, exit, failures and skips. The merge script checks for a gate file but does not validate its contents: independently verify remote evidence, exact-head Apex and all P0/P1 findings before `scripts/orch/merge-gate.sh`.
- Live HMS reads require a supported read-only probe, current property, separate verified browser session and no-send path; a policy-level property lock is not required for independent reads or unsaved previews. Installed routes may still enforce one. A product route may write application ledger data even if HMS is read-only; tests need a non-pilot database. Fake writes require Proof Labtest, 2027+ and CMS send off. Serialize conflicting writes; never blind-retry an uncertain dispatch.
- Verify target and executing-session owner authority before schema pushes, destructive DB actions or volume deletion. No production write or send by inference.
- Deployed evidence records actual artifact SHA, pane surface, selected source, staff-visible result, screenshots/readback and relevant flag state. A process environment marker alone is insufficient.

---

## Definition of Done

- **Hourly checkpoint:** Report named target outcomes as complete or missing, exact blockers and measured elapsed/queue/rework. Continue independent safe work until the 360-minute cap; do not fabricate a revised ETA.
- **First create proof:** Exact selected email → approved intent → native guarded fake Save → screenshot → fresh independent readback, with truthful uncertain-outcome handling.
- **Full technical pilot:** Every R1–R9 behavior meets the applicable proof bar on deployed main, with all six workflow walks and final fake booking. No unvalidated P0/P1, fabricated test pass or unverified deployment claim.
- **Staff/ROI:** Actual Outlook client verified, real-guest authority obtained in executing session, staff using the product. Report eligible cases, uptake, manual vs assisted effort including failures/rework, error rates and model, infrastructure, training and development costs for a stated period. Net benefit = staff time saved × loaded hourly cost − total costs; ROI = net benefit ÷ total costs. Return remains unknown until measured.

