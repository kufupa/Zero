# Plan 005 adversarial peer review

Scope: review [plan 005](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md) once, without changing it or the [004 audit](/home/ubuntu/projects/zero/docs/research/2026-11-02-connected-lean-plan-004-adversarial-review.md). This report is in the reviewer's worktree because the shared-checkout write was blocked by the worktree guard. The source examples below are from `/home/orca/orca/workspaces/zero/connected-pilot-integrator-20261102`; they establish source behavior, not live-runtime results. No tests, live HMS actions, deploys or flag changes were run.

The review accepts the owner's current scope: amount amendment dropped; real-guest reads and unsaved staging allowed; CMS recipient enabled under the stated send rules; fake-bridge Outlook replay for this pilot; contract replay preferred; and DB suites may be skipped and reported as skipped. This review is not authority for a real-guest write, a send or a deployment.

Plan file SHA-256 observed during review: `c6fc7971389c7e70ecdd3babe20369b7ee4a465b15373523bf31ebe74c385eca`. Audit file SHA-256: `9ee09b176208140ee7a336d01522becdd9f73fb1f92fe94ddbb22319d50f57c2`. For the mixed pre-stay finding, source SHA-256 prefixes were `13634e45d13a` for extraction, `ddf141ef039b` for triage and `320d662916b1` for work items. These identify observed files; they are not Git head attestations. Create's pane already calls `flushForCreate` before preview and commit (`apps/mail/components/quote-workflow/booking-card.tsx:1424–1455,1652–1671`); the flush checks pending and failed edits and the acknowledged revision (`apps/mail/lib/quote-workflow/use-work-item.ts:803–837`). Preserve this guard when removing the route hold; the server revision alone is not an edit flush.

## P0

None confirmed. The multi-room failures are P1 plan blockers: current guards refuse the writes rather than proving a live critical incident.

## P1

### Mixed self-sent pre-stay mail is still suppressed

**Evidence.** Plan 005 [T4–T6](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L156) adds general separate-ask handling but gives pre-stay just one test. `apps/server-pilot/src/ai/existing-stay-information.ts:3–25` matches the mailbox sender, pre-stay subject and a confirmation. `apps/server-pilot/src/ai/extraction/extract.ts:686–694` forces its extracted kind to `other`. `apps/server-pilot/src/ai/workflows/mail-triage.ts:847–869` unconditionally returns excluded-internal, no human action and no suggested tools for a matching mail. `apps/server-pilot/src/ai/work-items.ts:1952–1963,1999–2005,2030–2072,2478–2490` suppresses the work item, HMS card and Needs You entry.

**Failure.** If that mail also contains a genuinely separate actionable request, the existing early overrides remove it before T4's generic handling can surface it. A test alone cannot change those overrides.

**Change.** Add bounded implementation pieces for triage, stored/open work and Needs You that preserve the existing-stay and never-offer-create rules while retaining a separately identified eligible ask. Add focused pure-pre-stay and mixed-request regression cases. Do not convert pre-stay mail itself into a new booking.

### Late changes do not have a final per-PR gate or affected proof in the schedule

**Evidence.** [G19/G20](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L127) checks, reviews, merges and proves general create before [G12](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L168) changes CMS recipient binding. [M19–20](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L219) precedes conditional G8c new-guest code. [K6](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L35) assumes everything merged, but no later per-PR same-head check, Apex and merge is scheduled. `AGENTS.md:23–25` requires applicable checks and Apex on each final PR head; an integrated-head check does not replace that gate.

**Failure.** The recorded general-create proof can precede the recipient change it is supposed to cover, or later code reaches K6 without the required final-head PR evidence.

**Change.** Move G12 and any needed G8c before their affected PR's last gate, or add explicit final-head checks, Apex, merge and the affected fake no-send proof after those edits. Recompute the critical path and keep DB skips explicitly marked skipped.

### One-Go multi-room cannot reuse the single-create core unchanged

**Evidence.** [M11a and the cut of M10/M16](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L216) assume serial children with no sibling-aware census. The native `tooling/hms-cloud/labtest-preimage.mjs:193–209` returns `existing_matches` for any Proof Labtest stay with the same arrival, and `booking-lookup-session.mjs:532–538` refuses a non-clear preimage. The create path then returns `labtest_preimage_not_clear` (`create-reservation.mjs:511–518`). Separately, `src/ai/pane-create-approval.ts:319–329,450–501` treats any recorded stay outcome as blocking another create, and binds preparation to a form digest and revision. Its current preview and approval lifetimes are 10 and 5 minutes respectively (`:25–26`).

**Failure.** After room one is saved, room two on the same arrival hits both the duplicate census and single-room approval assumptions. A digest of child previews alone does not change those existing checks. A long serial batch can also outlive its existing grant or preview, even when every native Save is individually fast. The plan's two-room Labtest proof cannot pass unchanged; this is a release-blocking plan omission, not a current production P0 incident.

**Change.** Before M17, extend the existing core with one server-bound immutable manifest and per-child identities/outcomes. Take a fresh, session-bound single-use preimage for each child and allow only earlier independently confirmed siblings from that same manifest, never arbitrary pre-existing matches. The [AGT-M worktree](/home/ubuntu/projects/zero/.claude/worktrees/agent-a649800c980aff834) `apps/server-pilot/src/ai/hms-batch-executor.ts:6–27,36–46` describes this contract but explicitly says the Cloud wrapper does not implement it. Keep actual staff edits invalidating approval while child result recording does not invalidate authorized remaining children. Recheck grant and preview lifetime during serial dispatch; stop for renewed approval rather than silently extending expired authority. Distinguish readbacks for otherwise identical siblings and stop/reconcile any uncertain child before retry. Add focused same-date two-child, unrelated-match and changed-manifest cases. Do not imply native association or atomicity.

### Multi-room scope and shared-file order leave requested cases uncovered

**Evidence.** [M2a/M6](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L210) lift the multi-room hold and describe one row with count `n`. Current `src/ai/pane-create-scope.ts:57–71` also rejects multiple rows or stays. `quote-workflow.ts:298–310` and `:553–581` contain further one-room/parent checks. [Shared-file order](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L73) requires M6 to merge before G9a rebases, but G9a is scheduled at minute 125 and M's listed check/review is at minute 185.

**Failure.** A request with two room types can expose Go but still be refused by the server, and the stated shared-file merge ordering cannot occur as timed.

**Change.** Define and implement the approved manifest across each included row and room, with identity and scope reconciliation at every existing one-room guard. Keep unsupported shapes honestly held until implemented rather than treating them as done. Add an actual early M6 gate/merge or a coordinated alternative, then schedule G9a's rebase. Assign exclusive ownership or a merge order for `pane-create-approval.ts`, `quote-workflow.ts` and G12's card edits.

### Existing-guest and guarantee work spans more than its named sites

**Evidence.** [G7a/G11](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L119) name the hard-coded profile search and one guarantee constant. `src/ai/pane-create-cloud-input.ts:43–60` independently refuses non-Labtest names and non-NGI guarantees; `quote-workflow.ts:455–461` rejects non-Labtest previews and `:317–319` reports real-guest booking unsupported. Native guarantee staging and binding also have their own guarded paths in `tooling/hms-cloud/create-reservation.mjs:387–405`.

**Failure.** Replacing the search alone can find a real profile but still refuse its approved create preview. Changing one guarantee constant cannot establish selection, request binding and the Save guard. This does not mean a real-guest Save is authorized.

**Change.** List and update the mapper, preview admission, native select/bind and final guard together, with the owner-approved separation between real unsaved staging and an authorized real Save. Use real profile/agency reads and unsaved staging only where allowed, and keep Labtest proof no-send. If native capability remains unproven, show the correct refusal and hold the affected scope rather than claiming general create complete.

### Making the create note optional breaks prepare-to-save binding

**Evidence.** [G21](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L125) only removes the required-note check. With no note, `tooling/hms-cloud/create-reservation.mjs:432–439` leaves it absent during prepare but generates a random Labtest note on commit. `src/ai/pane-create-cloud-input.ts:112–145` binds the native note to the reviewed stay, and `quote-workflow.ts:621–628` checks the commit proof against the prepared grant after setting `authorizationAttempted`.

**Failure.** A no-note request can prepare successfully but fail the later proof comparison and be treated as an unconfirmed write rather than completing the booking.

**Change.** Carry one consistent optional-note value through prepare, approved request, native draft and commit. Do not invent a staff note on real bookings. If fake proof needs a synthetic distinguishing note, establish it before approval and reuse it on commit. Add a focused absent-note prepare/commit binding case.

### Filing attribution lacks a proven fresh, complete document tree

**Evidence.** [F20](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L139) treats a unique marker, absent before and present after in a tree that is not partial, as metadata attribution. In the [AGT-F worktree](/home/ubuntu/projects/zero/.claude/worktrees/agent-a622b74da134a5ced), `apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs:45–71` currently returns `documentId:null`, `refreshVerified:false` and `complete:null`; `voucher-filing.mjs:92–116` refuses a filed result unless both reads are verified complete and fresh and IDs are known. The attach adapter has an exact refresh observer in `stay360-document-attach.mjs:186–195`, but the reader does not currently claim that evidence. The existing `voucher-filing.mjs:11,42` generates and validates `NAVA` plus 32 hex characters; plan F20 instead specifies `NV` plus 10 hex characters.

**Failure.** Today the current reconciler cannot return filed from that reader. Conversely, weakening it to 'not partial' can mistake a stale or incompletely loaded tree for a valid before/after comparison. Metadata cannot prove stored-byte equality.

**Change.** Implement a fresh, correlated and coverage-aware preimage and fresh post-upload readback; require no marker before, exactly one matching marker and filename after, and verified coverage on both. Reuse the existing native refresh observer where it actually proves the reader's result. Align the persisted marker, writer, reconciler and tests on one format, and verify that HMS accepts it rather than guessing. Show `attributed (metadata)` only for that evidence level; otherwise `needs_check` and no blind retry. Preserve screenshot evidence and never call metadata proof a byte match.

### Filing's planned mount and session client do not compose

**Evidence.** [F21/F22](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L163) mount at `nava-pane.tsx:2375`, but that lookup-only branch has neither work-item identity nor write-enabled props. The AGT-F card requires both plus a filing client (`apps/mail/components/quote-workflow/voucher-find-card.tsx:489–491`); the existing `booking-voucher-card.tsx:80–89` has those props. In the planner worktree, `voucher-filing-client.ts:50–62` returns null without all six routes, and `voucher-filing-service.ts:75–100` rejects undefined session state.

**Failure.** The staff-facing filing form can stay invisible or become unusable even if the backend upload path is built. A metadata-only outcome also lacks an explicit presentation level in the existing service shape.

**Change.** Mount and wire the filing client in the existing work-item-aware card on both surfaces, without introducing another panel. Reconcile the two client contracts: either make the session feature consistently optional and remove its UI dependency, or implement its state and routes. Carry metadata-only versus uncertain evidence through the service and use compatible screenshot references. Verify the actual selected-mail flow in contract replay.

### Filing source and write guard are narrower than the advertised workflow

**Evidence.** In AGT-F, `apps/server-pilot/src/ai/voucher-filing-source.ts:53–87` requires an Outlook-sync provenance record and corresponding original-artifact receipt. In the integrator tree, POP3 ingestion stores a different provenance shape or null (`apps/server-pilot/src/mail/ingest/store.ts:873–887`). The planned runner uses the fake-only `currentLabtestRecord`; `tooling/hms-cloud/labtest-record.mjs:30–45,71–78` requires Proof Labtest and other fake-stay invariants. Plan 005 hides the legacy attach UI at [F21](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L163).

**Failure.** A POP3-ingested attachment can be rejected even in webmail, and the new native path cannot file on a real reservation merely because a fake save passed. The active pilot ingest path and object-version availability were not verified here.

**Change.** At kickoff identify the pilot's actual ingest and byte-storage path. Support each in-scope source with equivalent message, attachment and exact-byte hash binding, or report the unsupported source as a hold. Keep unauthorized real-stay writes refused; make the eventual authorized real-stay path explicit rather than claiming fake-only proof establishes it. Never infer new real-write authority from this plan.

### Bind the filing snapshot and dispatch fence at the actual upload

**Evidence.** [F11b/F13](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L139) propose a runner, DB intent and a `beforeRelease` fence. In AGT-F, `stay360-document-attach.mjs:99–124,178–182` runs the callback, then writes a local exclusive intent in a new per-call directory before continuing the request. The existing `src/ai/hms-approval.ts:620–647` separately requires an unchanged approved HMS snapshot and live run/lease at the write boundary. The proposed `FilingRunner.run(grant)` stub does not state how it retrieves the server-owned grant, retains the matching snapshot shape, checks approved bytes or binds this durable intent.

**Failure.** A local per-call intent does not establish cross-run uniqueness, and an unintegrated runner can either reject the unchanged stay because it hashes a different read shape or skip the prior-state check. A native 200 or `awaiting_readback` is not filed.

**Change.** Freeze the runner interface around the server-owned run/fence, not an arbitrary client-supplied grant. Read and compare the same approved snapshot shape, recheck the consumed grant and lease, bind the exact approved source bytes, and persist the single-dispatch intent durably before releasing the matching native upload. Reuse existing approval/run storage where sufficient. Treat possible dispatch as uncertain until fresh readback. Keep the planned fake write under the actual property lock.

### Cloud amendment can classify a possible Save as safe to reapprove

**Evidence.** [A11](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L96) replaces the legacy amendment runner under the existing write path. `apps/server-pilot/src/ai/pane-hms-write.ts:820–832` maps an amend to `UNKNOWN` only when `saveAttempted === true`; otherwise it returns `NEEDS_CHECK`, for which reapproval is allowed. The Cloud lifecycle at `tooling/hms-cloud/labtest-amend-save.mjs:12–19,48–75,154–180` returns `awaiting_readback`, `uncertain` or `not_dispatched` rather than the legacy `amended`/`saveAttempted` shape. It uses internal dispatch flags to choose that outcome but does not expose those flags in its standard diagnostics.

**Failure.** If A11 passes the Cloud outcome through without explicitly mapping dispatch evidence, a Save that may have reached HMS can be classified as nothing written and approved again. This is an integration risk, not a claim that the unbuilt A11 already behaves that way.

**Change.** In A11, map any possible dispatch and uncertain outcome to `UNKNOWN`, blocking reapproval. Return success only after fresh independent readback verifies the requested result. Add focused cases for not-dispatched, uncertain, awaiting-readback and verified outcomes.

### The amendment plan needs separate real-staging and native-save contracts

**Evidence.** [A12d](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L192) calls for a combined unsaved stage on a real old confirmation. The existing `tooling/hms-cloud/labtest-record.mjs:30–45,71–78` requires a 2027+ Proof Labtest stay and other fake-record invariants, so the existing guarded path cannot stage that real stay. `guest-stay-amend-children.mjs:57–74` can report valid counts with unknown ages; `src/ai/hms-cloud-saved-stay-find.ts:197–219` does not project native stay ID or child ages. The existing route chain at `saved-stay-save-route-chain.mjs:94–123` admits one exact Save candidate and aborts other mutations. The child adapter installs separate exact read/validation exceptions and quarantines its page fence on exit (`guest-stay-amend-children.mjs:267–305,492–498`); the fence cannot reopen while quarantined (`page-request-fence.mjs:9–25`).

**Failure.** Reusing the fake-only guarded stage directly fails the real-stay milestone. A combined child/date stage also cannot be assumed to work by chaining today's independent adapters, and unknown child ages cannot prove an approved preimage or readback.

**Change.** Specify a separate, strictly no-Save real-staging path that cannot weaken the fake or authorized-write guard. For the fake write, compose one lifecycle with explicitly matched, bounded child-age read/validate and Save routes, a session-independent identity and age preimage, and fresh readback. Treat unknown ages as unknown, not an empty list. Preserve no-save/close-without-save authority. Estimate and test the combined path rather than assuming the existing adapters compose unchanged.

### Retain-rate continuation is still an unobserved native request

**Evidence.** [A15a and A27](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L198) assume a guarded second request and allow one later modal iteration. `tooling/hms-cloud/guest-stay-amend-adults.md:55–82` records an HMS Yes/No/Cancel question, but neither its actual continuation request nor a reliable real-modal selector was captured. The existing lifecycle counts visible windows within the record frame and decides from response status (`labtest-amend-save.mjs:154–170`); the route chain blocks nonmatched mutations.

**Failure.** An apparently successful first Save can be awaiting a native question, while the planned matcher has no observed second request to bind. Staged changes or HTTP 200 do not prove persistence or pricing behavior.

**Change.** Treat the first Labtest Save and prompt as an observation under the existing fence. Detect the actual question/response, capture the selected continuation without releasing an unverified request, and admit only the matched choice. If dispatch or outcome is uncertain, use a fresh readback before retry. State the resulting rate and pricing evidence honestly; do not accept a penalty dialog or require per-field saves.

### Outlook replay cannot be a two-command shim or an unasserted screenshot

**Evidence.** [R3 and the replay gate](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L145) name `GET_ACTIVE_EMAIL` and `CREATE_REPLY_DRAFT`, but the real `apps/mail/lib/workstation/use-outlook-bridge.ts:339–395,901–908` requires a paired identity, bootstrap and navigation registration first. The current runner classifies `workstation.bridgeTicket` as a blocked mutation (`apps/server-pilot/scripts/nava-preview-run.ts:130–154`) and its DOM reader expects `data-preview-*` markers at `:365–373`; `/outlook-pane/page.tsx:1–6` supplies none. A reply with PDFs also needs a returned draft location and `ADD_ATTACHMENT_TO_DRAFT` (`apps/mail/components/nava-pane/use-insert-ai-draft.ts:418–461`). The runner's current `gateFailures` at `nava-preview-run.ts:813–826` fails timeout, pane error or blocked write, but does not require the expected workflow, successful preparation or a recorded draft. The preview page passes a thread ID rather than a selected message (`apps/mail/app/(routes)/nava-preview/page.tsx:87–97`).

**Failure.** The fake may never reach an actionable pane, or an unsynced/refused fixture can be counted as passing without proving the requested contract. An Outlook reply could omit the PDF while the two named commands still appear to work.

**Change.** Build a test-only fake that satisfies the real paired PING, 43-character bootstrap challenge, registration, ticket and versioned response contract without invoking native Outlook. Supply selection events and record draft plus attachment commands. Read the actual Outlook pane, pass selected message identity and attach explicit expected outcomes to fixtures; fail mismatches, unsynced cases and missing required draft/attachment records. Use staff outbound as comparison evidence, not future context in a selected inbound's replay; note that a few fixtures do not establish accuracy. Q owns the shared runner and coordinates added procedure names with F/T/M. This preserves the owner's fake-bridge decision; it does not require a real Outlook test now.

### Replay prepare allowlisting must preserve the no-commit boundary

**Evidence.** [R1](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L145) says to allow prepare/preview mutations, never commit. `quote-workflow.ts:455–474,479–490,513–523` shows `previewStay` currently requires Labtest, takes the property lock, invalidates an earlier preparation and records a new one; it is not a pure read. The existing runner's batch classifier at `nava-preview-run.ts:176–193` checks every named procedure, allowing a batch only if none is blocked.

**Failure.** Broadly promoting mutation names to reads can affect live work items or accidentally admit a batched commit. Real-thread booking fixtures may only exercise `labtest_guest_required`, not the prepared-create path. R4 also overlaps the planned fake saves, so its preparation can contend for HRCEN.

**Change.** Define a small per-procedure allowlist with explicit environment and identity constraints; retain fail-closed whole-batch rejection and an explicit never-commit/never-send list. Use appropriately isolated Labtest input for actual create preparation and label real-thread refusal as such. Name and verify R4's app, non-pilot test database and property-lock route. Schedule it around saves or measure contention. No DB-backed test suite is newly required.

### Freeze a result adapter that preserves uncertainty and per-child evidence

**Evidence.** [ToolResult/v1](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L242) defines a new four-outcome shape, optional single screenshot and a literal `nava.tool/v1`, while saying to bump a minor version. A different `ToolResult<T>` already exists in `src/ai/draft-evidence.ts:41–47`. A possibly written create uses `status:'refused'`, `reason:'pane_save_unconfirmed'`, `outcome:'committed_unverified'` in `quote-workflow.ts:671–682`. Batch can be partial, and existing screenshot structures carry multiple references and hashes.

**Failure.** Mapping only the existing status would translate a possibly dispatched Save to `refused` rather than `uncertain`, defeating the re-read-before-retry rule. An underspecified partial batch or screenshot representation can hide which child committed or which evidence was retained.

**Change.** Freeze a distinctly named contract and an explicit tested adapter at S2. Map `committed_unverified` and any possibly dispatched write to `uncertain`; preserve all existing screenshot references/hashes and per-child statuses. Freeze the identity/preimage and grant bindings in the input or an opaque server-side reference rather than making them optional. Define version compatibility consistently with the actual literal and existing callers. No broad framework replacement is needed.

## P2

### The shared remote-check lock is not a three-test pool

**Evidence.** Plan 005 [line 69](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L65) infers a small EC2 queue from the owner's three-local-test allowance. `AGENTS.md:15` instead directs use of Product EC2 while the local shared cap remains uncoordinated. `/home/orca/bin/remote-typecheck.sh:159–161` and `/home/orca/bin/remote-vitest.sh:13–27` use the same single EC2 lock; Vitest ordinarily runs typecheck first.

**Failure.** Several final-head checks may serialize, missing the plan's milestone even when all feature owners finish on time. Actual queue and service times were not measured in this review.

**Change.** Schedule the remote lock as one shared resource. Batch focused suites by committed head where practical, overlap coding and Apex, and measure actual queue and run times. Do not add DB suites or claim skipped suites passed.

### Recheck effective flags after deployment before calling a workflow on

**Evidence.** [F28/29](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L184) schedules the four-process PM2 environment check before [L2/L3](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L105) deploy and reload. `AGENTS.md:17` requires durable and effective flags in every affected process before enqueuing work, plus property-specific readiness and a final-SHA canary before calling a workflow on.

**Failure.** An earlier environment snapshot is not evidence that the post-deploy processes have the expected configuration. A deployed bundle or successful Labtest write alone does not establish that a real workflow is enabled.

**Change.** Keep the earlier pre-write check, then verify the durable source and the effective environment of all affected PM2 processes after the final deployment. Report each workflow as on only with its required property-specific final-SHA readiness and canary; otherwise say deployed or held. This does not authorize a flag flip or a real-guest write.

### Context archive move left broken links; deploy needs both facts

**Evidence.** The main checkout has already moved `docs/context/ACTIVE.md` to `docs/context/archive/ACTIVE-2026-10.md`. The archive's line 8 links `../research/...`, which now resolves under `docs/context/research`, not `docs/research`. A read-only link scan found 108 unresolved local-link occurrences in the archive; 107 resolve from its former directory, consistent with the move breaking them. This checks file targets, not heading anchors. Inbound links still name `ACTIVE.md` in `docs/context/ledger/2026-10-28-pomerado-comprehensive-retro.md:72`, `docs/context/ledger/2026-10-27-pomerado-trial-retro.md:17`, `docs/plans/2026-11-02-002-feat-three-connected-workflows-plan.md:37` and `docs/plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md:54`. Historical Pomerado stop remains at `docs/context/archive/ACTIVE-2026-10.md:30–32`. Plan 005 [line 307](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L303) replaces the deploy-worktree wording, but `apps/server-pilot/deploy/ops-deploy.sh:41–73` still guards the recover worktree.

**Failure.** Historical evidence becomes harder to find, and an otherwise correct main-via-bundle deploy can be refused from the wrong checkout.

**Change.** Preserve anchor-compatible inbound links or update them, and fix archive-relative links. Preserve historical stop records. Document both compatible facts: deploy main through the bundle from `.worktrees/recover-parse-failure`. Inspect current edits before cleanup instead of repeating the move.

### Workpiece boundaries and test shorthand are not fully executable

**Evidence.** Plan 005 [line 81](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L79) promises pieces of at most 20 minutes, but A12a begins at 50 and A12b at 90. The chart mentions A12a′, while [the table](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L192) does not define that separate piece. T17–18 spans 25 minutes and F23–24 spans 25 minutes. Test names such as CT, CA, AM-lite, FS and FR lack an inline path/runner legend; [004's legend](/home/ubuntu/projects/zero/.claude/worktrees/three-connected-workflows/docs/plans/2026-11-02-004-feat-connected-cloud-lean-plan.md#L22) supplies many exact paths but not every 005 shorthand.

**Failure.** The executor cannot report the promised bounded progress or know exactly which focused test command each abbreviation names. Splitting an estimate does not itself shorten the critical path.

**Change.** Specify A12a and A12a′ separately, each with result, approximate LOC, check and dependencies. Split combined check/review rows into bounded pieces, and add a compact suite-path and runner legend. Preserve the owner's contract-replay preference.

### Safeguard other sessions' dirty work with their owners

**Evidence.** [S1](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L91) assigns committing several dirty trees to the integrator in 10 minutes. The [004 audit](/home/ubuntu/projects/zero/docs/research/2026-11-02-connected-lean-plan-004-adversarial-review.md#L311) describes the then-dirty files and explicitly calls for owners' agreement. `AGENTS.md:7` requires ownership coordination and preservation of other sessions' work. Those audit statuses are historical, not a new status check.

**Failure.** Committing an actively changing or unrelated file can capture an incomplete snapshot or another session's work.

**Change.** Have each owner confirm a settled, scoped snapshot and perform or authorize its own safeguard. Start truly independent read-only or coding work meanwhile. Never reroute a previously denied operation through a peer.

### Start independent work before the stub gate

**Evidence.** Plan 005 [S1–S2](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L89) starts the six lanes at minute 25 after the four stubs merge. Yet C1 is a read-only race check, Q1 is a provider/config check and T2a changes the voucher extraction rule; none names a new stub as an input. S1 still needs owner-coordinated settled snapshots before touching those owners' files.

**Failure.** The timetable serializes contract-independent analysis and code behind stub completion, leaving useful capacity idle even when safe work is available.

**Change.** Dispatch these independent pieces from a known base at kickoff. Let only consumers of the new contracts wait for the appropriate stub and its final-head gate. S2 lists typecheck but does not explicitly budget its Apex result and required applicable checks; show them, overlapping where possible. Coordinate shared files and other owners' work. Reclaim elapsed time only if measured startup and ownership actually permit it; the ETA below conservatively keeps the planned kickoff.

### Checkpoint names overstate early proof

**Evidence.** [K2](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L28) is named first qualified quote, but Q3 and Q7–8 describe a provider comparison, label decision and checks, not a selected-mail-to-quote, document and unsent-draft walkthrough. [R4](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L145) runs before late G12 and possible G8c; the plan separately schedules deployed replay.

**Failure.** A provider probe may be reported as a completed staff-facing quote, and the earlier replay may be mistaken for final-head coverage.

**Change.** Call K2 a quote-provider comparison unless it also proves the selected-mail output and unsent draft. Label R4 incremental; replay the final integrated head when practical and retain the specified deployed Outlook-mode replay. Identify the authorized app, non-pilot test database and property-lock route for C13–C14 at kickoff; their availability is not independently established here.

### Preserve progress updates during quiet gaps

**Evidence.** Plan 005 [line 240](/home/ubuntu/projects/zero/docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md#L230) removes periodic heartbeat in favor of K1–K7. Long code, review or wait intervals need not produce a milestone event.

**Failure.** The owner receives no update during a long delay even when work is running or a hold appears between milestones.

**Change.** Keep event-triggered updates and add a modest fallback heartbeat when no milestone or hold has been reported. Use a 45-minute interval as a proposal, not an owner-set rule.

## ETA

**Revised conditional scenario:** 425 raw wall-clock minutes, approximately 410 minutes after the mandatory 0.96 ledger calibration, or 470 minutes at the 1.11 sensitivity. This supersedes the earlier 400- and 410-raw scenarios: source inspection found missing multi-room binding plus filing source/session and readback integration work. It assumes two of four added batch pieces run concurrently with M on available I/coordinator capacity, with coordinated ownership, and that the filing lane fits four additional 20-minute pieces. If the batch pieces must be serial on M, the modeled chain is 450 raw, approximately 430 calibrated or 500 at the 1.11 sensitivity. If filing's extra work is unnecessary or completes in parallel and its lane finishes by minute 340, the faster conditional scenario is 410 raw, approximately 395 calibrated or 455 at the 1.11 sensitivity. None is a measured lower bound, percentile or guarantee. All assume no unpriced HMS, authority, integration or remote-check queue hold.

**Batch lane:** M1–M14 reach minute 185 as in plan 005. Four additional 20-minute pieces follow. In the 410-minute scenario two run in parallel with the other two; in the 450-minute fallback all four run serially. These are starting budgets and provisional changed-line judgments, not measured completed implementations.

| Batch workpiece | Minutes | Product/test LOC; check; HMS |
|---|---:|---|
| Sibling-aware fresh preimage | 20 | 30–60/10–20; confirmed-sibling and unrelated-match cases; none. |
| Child grant and outcome identity | 20 | 40–80/10–25; one-Go child authorization and possible-write cases; none. |
| Revision, digest and expiry binding | 20 | 30–60/10–25; staff edit invalidates, sibling outcome does not; none. |
| Multiple rows and distinct readbacks | 20 | 30–60/15–30; different room types and sibling evidence; none. |
| M19/20 final checks and Apex | 15 | 0/0; exact-head focused checks and Apex overlap; none. |
| M19/20 merge | 5 | 0/0; required gate and source merge; none. |
| M17 | 20 | 0/0; two child saves and separate fresh readbacks; fake Saves. |
| G8a | 20 | 0/0; new-profile exploration; unsaved staging. |
| G8b | 20 | 0/0; conditional fake profile and stay proof; fake Save. |
| G8c | 20 | 20/15; conditional create support and focused checks; none. |
| M/G8 final-head gate | 15 | 0/0; focused checks and Apex overlap; none. |
| I20a | 10 | 0/0; integrated remote checks, DB skips reported; none. |
| I20b | 15 | 0/0; integrated-head Apex and triage; none. |
| L2 | 10 | 0/0; deploy and health; none. |
| L3 | 5 | 0/0; reload and bundle SHA; none. |
| L6/L7 | 20 | 0/0; final deployed fake booking, screenshot and readback; fake Save. |
| L8 | 10 | 0/0; release evidence and skips; none. |

The G8b/G8c pieces are conditional on the new-guest exploration. If not needed, remove them and recalculate the actual longest lane. An available owner must take the parallel batch pieces without modifying another active owner's files; do not count hypothetical capacity or unverified merges as realized savings.

**Filing lane:** F0–F28/29 reach minute 230 as in plan 005. The following four extra budgets precede the existing final-head check and fake upload, moving its finish from minute 275 to 355. Source support is conditional on the actual mailbox and storage evidence; reassign independent parts earlier when an owner and nonconflicting files are available. The budgets and LOC are judgments, not measured delivery times.

| Filing workpiece | Minutes | Product/test LOC; check; HMS |
|---|---:|---|
| Identify ingest path and immutable byte receipt | 20 | 0/0; verify mailbox source, object versioning and runtime configuration; no HMS. |
| Support the actual source if missing | 20 | 20–60/10–30; source ownership and approved-byte hash cases; no HMS. |
| Reconcile optional session client and stored state | 20 | 20–50/10–25; mounted client and state contract; no HMS. |
| Complete fresh readback and dispatch integration | 20 | 30–60/10–25; refreshed coverage and prior-state/fence cases; no HMS. |
| F23 focused checks | 10 | 0/0; exact-head remote suites; no HMS. |
| F24 Apex and merge | 15 | 0/0; exact-head review and P0/P1 triage; no HMS. |
| F25/26 | 20 | 0/0; one synthetic PDF upload and fresh metadata readback; fake Save. |

With F ending at 355, I20 adds 25 and the release tail adds 45, giving 425 raw minutes. If the native refresh or source implementation does not fit these budgets, or the needed environment is unavailable, reforecast instead of marking the lane passed.

**Parallel T lane:** the following work ends at minute 330 under the stated assumptions. It includes the three added pre-stay pieces and is not summed onto the batch lane.

| T workpiece | Raw minutes | Product/test LOC; check; HMS |
|---|---:|---|
| S1 | 10 | 0/0; settled snapshots; none. |
| S2 | 15 | 60/0; interface typecheck; none. |
| T2a | 15 | 15/0; TI; none. |
| T2b | 15 | 0/30; TI; none. |
| T4a | 20 | 30/0; TI; none. |
| T4b | 20 | 25/0; TW; none. |
| T4c | 15 | 0/30; TI/TW; none. |
| T5 | 15 | 15/10; TW; none. |
| T9 | 20 | 20/0; replay; none. |
| Pre-stay triage and extraction overrides | 20 | Provisional 20–40/0; preserve no-create, focused pure/mixed cases; none. |
| Stored/open work and Needs You | 20 | Provisional 20–60/0; preserve eligible separate request, targeted work-item cases; none. |
| Pre-stay regression cases | 20 | Provisional 0/30–60; focused remote tests; none. DB suites may remain skipped. |
| T17 check | 10 | 0/0; focused remote suites; none. |
| T18 review | 15 | 0/0; Apex on affected heads; none. |
| F21 | 15 | 20/0; replay; none. |
| F22 | 20 | 25/0; replay; none. |
| A17 | 20 | 40/0; replay; none. |
| A19/21 | 15 | 15/0; replay; none. |
| A20 | 15 | 20/0; replay; none. |
| Final T-head gate | 15 | 0/0; focused checks and Apex in parallel, P0/P1 triage; none. |

Webmail walks and Outlook-mode replay overlap the final booking when feasible. All LOC figures above are planning judgments. Existing row checks use plan 005's shorthand; the missing legend is called out above.

**Parallel assignment:** after G20, C/G takes G12 if the CMS binding can be isolated or file ownership coordinated. Finish its final-head gate and the affected no-send proof in parallel with T. Keeping G12 on T instead moves T's finish from minute 330 to 350. That does not change the 425-raw scenario while F finishes at 355, or the 450-raw scenario while M finishes at 380. If filing finishes by 340 and batch work is parallel, T retaining G12 instead makes the scenario 420 raw, approximately 405 calibrated and 465 at the 1.11 sensitivity. This assumes the affected fake no-send proof overlaps integrated-head checks after the G12 PR gate; otherwise add its actual elapsed time. These triage piece budgets and LOC are judgments, not observed implementation times. Splitting A12a and combined gate rows alone adds no assumed elapsed time.

**Replay lane sensitivity:** retain R1 and R2 at minutes 190–225. Replace the 20-minute R3 with the four conditional pieces below, then run incremental R4 at minutes 305–320. This lane still finishes before T at minute 330 and the batch lane at minute 340 or 380, so it does not by itself add to either revised scenario. These are unmeasured budgets, not established throughput. Deployed final replay remains required after the final head and may overlap the final booking only when its environment is stable.

| Replay piece | Minutes | Provisional product/test LOC; check; HMS |
|---|---:|---|
| Paired identity, bootstrap, registration and ticket fake | 20 | 30–60/10–20; bridge handshake contract; none. |
| Active mail, capabilities and selection events | 20 | 20–40/10–20; selected message and A/B/A contract; none. |
| Reply draft, PDF attachment and pane reader | 20 | 30–60/10–20; recorded draft and attachment; none. |
| Fixture outcomes and fail-closed gate | 20 | 30–60/20–30; wrong outcome, unsynced and forbidden-batch cases; no HMS write. |

The amendment composition, retain-rate native request, filing integration, S2 bindings, fake app environment and remote lock remain unmeasured. The stated scenario assumes they fit in their parallel slots. If any overruns its slot, a required authority/environment is unavailable, or the replay requires more than these budgets, reforecast; do not present 410 or 430 minutes as a verified delivery promise.

**Basis and limits.** The [004 plan's recent evidence](/home/ubuntu/projects/zero/.claude/worktrees/three-connected-workflows/docs/plans/2026-11-02-004-feat-connected-cloud-lean-plan.md#L277) reports 26 tools-only PRs over 3h52m and an 11.8-minute median open-to-merge window. That excludes pre-open work, pane integration, saved stays and deployment. A broader 19h31m Cloud run left the connected workflow undeployed, but had different scope and staffing. The 90.3-second native save/readback omitted application setup and integration. None measures this pilot's end-to-end throughput. The ledger's orchestration cohort has 46 ratios, median 0.96; the non-superseded 1.11 sensitivity has 39 rows, including 19 partial and 7 unlabeled outcomes. Neither multiplier establishes a percentile or reliable Cloud-pilot delivery distribution. The 95 evidence threshold for full-pilot throughput is not met. Measure the remote-check queue, fake-proof environment, final-head gates and actual workpiece pace at kickoff; reforecast from the actual critical path.
