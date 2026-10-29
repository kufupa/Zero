---
title: "Local Pomerado Stay 360 session handoff"
date: 2026-10-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Local Pomerado Stay 360 session handoff

## Goal Capsule

**Objective:** On Product EC2, reuse Nava's deterministic login inside a dedicated local Pomerado browser context. Have Pomerado navigate directly to HRCEN Stay 360, read the whole visible screen, and end exploration immediately. Then run the resulting Pomerado tool in a fresh context and report the screen again.

**Authority:** Owner asks 328, 329 and 331 establish the narrow behavior, login reuse and faster plan. Ask 347 authorizes execution of the next screen-read checkpoint. Product hard rules, the real HRCEN lock and private-data boundaries remain. Implementation-ready describes the proposed design, not verified hybrid feasibility or a promise of publication.

**Stop conditions:** Stop further exploratory browser actions when the requested screen has been read. Do not cancel an unpublished mint merely to end exploration: native cancellation can remove its reserved artifact. Stop all HMS work on lost lock, wrong or unverified property, write request, unexpected data disclosure, or an actual unrecoverable error. Preserve private evidence, terminate trial-owned processes, and restore any paused HRCEN slot. Never declare publication or replay based only on a screen read.

---

## Product Contract

### Problem frame

Nava's existing Playwright helper has authenticated Centurion independently. Prior local Pomerado login attempts were incomplete, and Cloud recorded a verified login but later returned to a login page. Neither establishes the cause of the failure or this integration's feasibility. Local Pomerado's standalone host rejects attachment to an existing CDP browser and normally creates a new page and context. The useful experiment is the owner's proposed combination, not another independent login-only mint.

### Requirements

- R1. Use the existing deterministic Nava login against the exact Centurion tenant URL on Pomerado's dedicated page, and independently verify authenticated tenant and HRCEN identity before exploration.
- R2. Give Pomerado the minimal read-only request: open Stay 360 and read everything currently visible. Stop exploration as soon as this one screen is read. Do not search for or open guest records or other pages.
- R3. Capture the entire visible screen privately, including labels, controls, text and any visible values. Give the owner a complete sanitized description in chat. Keep guest personal data, raw screenshots, generated private artifacts, credentials and raw logs only in the Product EC2 worktree under `.private/pomerado-readstay/`.
- R4. Run the actual generated local Pomerado tool once in a **fresh context**, with deterministic authentication again. Report this separately from the first exploration. Do not substitute a second run of Nava's helper or a hand-written script and call it generated-tool replay.
- R5. Use the real HRCEN property lock throughout each active browser phase. Keep its actual connection alive and stop browser work if it is lost. Restore any interrupted slot and release the lock after browser work ends.
- R6. Keep the trial read-only. Keep Guardian and the approved private model route. Refuse a switch to write. Review the generated tool's actual source before the fresh run. Never create, edit, cancel, save, send, or accept a penalty dialog.
- R7. Use GPT-6 Luna with max effort for the controller and every local Pomerado model role. Never silently fall back. The separately requested Grok 4.7 xhigh plan review is not a trial role.
- R8. Distinguish verified login and hotel, screen read, tool artifact, fresh replay and cleanup. Failure at any one is not a pass for the later milestones.
- R9. The original ask required a read-only Grok 4.7 xhigh plan review with anchored sources and no private data. The earlier draft received it. The later fixed-host and speed revisions were not part of that Grok review; do not represent them as reviewed by Grok.

### Scope boundaries

This is one HRCEN read-only capability proof. It does not replace the originally requested selected screenshot and three-case read-stay proof. Those remain outstanding. It does not implement a booking or Add-On, deploy product code, change flags, send mail or authorize real-guest writes. No public smoke test, speculative role-proof or process-wide sandbox-proof gate is added.

### Acceptance examples

- AE1. Given the correct HRCEN authenticated shell in the Pomerado-owned page, when the model navigates to Stay 360, it returns a private full visible-screen capture and stops exploring.
- AE2. Given a successfully produced and privately reviewed Pomerado tool, when it runs in a new browser context with Nava authentication, it opens the same screen and produces the corresponding private capture.
- AE3. If Pomerado reads the screen but cannot produce a tool without further unauthorized exploration, record the first milestone as passed and the tool/replay milestones as blocked. Do not silently relax the stop or fabricate a replay.
- AE4. If authentication, property verification or the lock fails, no guest-screen exploration starts or continues; cleanup still runs.

---

## Planning Contract

### Ask 351: allow read-only clicks and scrolling

**Owner correction:** Ask 351 supersedes the no-click restriction in ask 350. Pomerado may navigate to Stay 360, scroll, and click relevant read-only tabs, menus and sections needed to understand the screen. This is planning only, not authorization to launch. The existing prohibition on real-guest writes, sends and cancellation-penalty acceptance remains. Screen contents may be reported in chat as requested in ask 350; never repeat the supplied API key or login credentials.

**Revised mint intent:**

> Open Stay 360. Read and return its visible text, labels, controls and displayed values. Click, scroll and open relevant tabs or sections as needed to understand the screen. Do not create, edit, save, cancel, send or make any other changes. If anything cannot be read, say so. Stop when you have read the screen.

Use the existing self-deployed native `read` mint, login-enabled build, Guardian, Luna max and property lock. The mint returns a build/job outcome, not necessarily the screen: if needed, inspect its generated source once for read-only behavior, then run that actual tool in a fresh authenticated context to obtain its output. The prompt is not a technical no-write guarantee, and the denied combined-build check remains denied. The fresh replay and original selected example and three-case comparison remain distinct and outstanding.

### Ask 350: no-click current-screen mint, planning only

**Owner request:** Check Pomerado README and examples for a better minimal mint. Plan “read everything on the screen click nothing repeat back everything”. The owner wants screen content in chat and says not to execute. This explicitly permits reporting the screen in this chat; do not reveal the Pomerado API key, HMS credentials or other secrets. Existing local handling of logs and artifacts does not require additional privacy machinery.

**Assumption:** “Current screen” is the page left open after the existing deterministic HRCEN login. No clicks, typing or navigation by the generated tool after login. The login helper itself still navigates and submits credentials. This proves a Pomerado read of the authenticated page, **not** necessarily Stay 360. Reaching Stay 360 requires it already be open or a separate navigation step. The original screen proof, generated-tool fresh replay, selected screenshot and three-case comparison remain outstanding.

**Proposed mint:** Self-deployed Pomerado on EC2, fresh tool name, existing Centurion tenant entry URL, `effect: read`, no user inputs. Reuse the compiled login handoff, Guardian, Luna max and the property lock. The [vendor's simple read-only example](../research/2026-10-28-pomerado-noclick-mint.md) uses `name`, `url`, a brief `intent`, `effect: read` and `input: {}`. Its example is a reference, not a proposed public test. Recommended intent:

> Read the current authenticated screen. Return all visible text, labels, controls and displayed values in order. Do not click, type, navigate, search, save or change anything. If anything cannot be read, say so. Stop browser interaction once the screen is read.

**Existing fresh-run hook:** A read-only EC2 source inspection on 2026-10-28 found the already-compiled `run-operation.js` calls `navaLogin` after the fresh page start and requires a read effect. This is wiring evidence only; neither the native mint nor the generated-tool replay has been proven on HMS.

**Execution proposal if later authorized:** Have Nava's helper log in and verify HRCEN in Pomerado's own page. Start the native mint and monitor the native job. A mint returns a job/build outcome, not a guaranteed screen transcript. If the actual outcome provides the screen, relay it; otherwise, if Pomerado publishes a tool, inspect its generated source once for read-only behavior, then run that actual tool once in a fresh authenticated context and report its output in chat. This is the requested generated-tool replay, not a handwritten replacement. If publication or output is incomplete or screened, say so rather than inventing contents; distinguish screen read, publication, replay and cleanup. Reuse existing guard/credential cleanup without adding a separate per-action model reviewer, source rewrite or public smoke test. Do not cancel a progressing mint merely because an estimate elapsed.

**Honest limits:** The no-click/no-navigation requirement is a prompt, not a verified runtime prohibition. Native authoring can reset or observe the page, and job polling does not prove the exact last action. A screenshot or accessibility snapshot may omit visible values, and terminal output may screen observations. If actual Pomerado behavior requires another navigation or the screen cannot be retrieved, report the actual partial result instead of silently widening scope. The hook-denied combined-build typecheck remains denied; the older compiled build does not contain the stop gate and must not be described as if it does.

**Timing:** The previous 20-minute conditional outcome scenario concerned a different Stay 360 task and is superseded. No comparable successful no-click mint has been timed, so do not present it as an evidence-backed completion prediction.

### Ask 349: shortest native-prompt checkpoint option

**Decision and scope:** Planning only. The existing ask 347 permits the previously specified immediate-stop checkpoint, not a silent waiver. The fastest alternative would remove the assistant-added per-dispatch reviewer and use the existing compiled login-enabled native mint. This trades an enforced dispatch stop for a request to Pomerado to stop immediately; native job polling cannot guarantee that no later action occurs. Ask 349 does not itself approve that trade or another launch. The owner retains read-only HMS, Guardian, Luna max, privacy and the shared property lock. Guardian plus read intent is not an independent technical write barrier.

**Observed starting point:** The Pomerado-owned executor and Nava helper authenticated HRCEN at checkpoint 343. A read-only EC2 source inspection on 2026-10-28 found the separately compiled native mint host calls `navaLogin` after `state.start.enter` and before `runMint`; the mint itself has not been live-proven. This build predates the stop gate. The hook-denied check applies to the unbuilt combined source; do not bypass the denial or misrepresent the older build as containing the stop.

**Smallest proposed sequence, if that stop trade is approved:**

1. Reuse the isolated EC2 executor, one-use credential handoff and two-key guard from the passed login checkpoint. Check the property identity, current lock ownership, private Luna-max routing and Guardian. Do not install, rebuild, restart hotel slots or add a new test harness.
2. Start one native `read` mint using the compiled login-enabled host and a fresh name. Prompt it: “Open Stay 360. Read the visible screen. Do not change anything, search for a guest, or open another page. Stop browser interactions after reading.” Keep credentials and raw screen output private. Do not substitute a separate scripted screen scrape for Pomerado’s own read.
3. Request the screen result in the native mint and monitor its status privately. [Pinned source review](../research/2026-10-28-pomerado-early-screen-evidence.md) found no supported controller path to its in-memory Guardian capture while the job runs. Terminal output may itself be screened, so a complete screen is not guaranteed even then. Inspect the actual result before claiming the checkpoint. Report whether the screen is complete, whether the stop was observed or only instructed, and whether a tool was published. Do not cancel a progressing mint simply because the ETA has elapsed; cancellation can remove its unpublished tool.
4. Close its own browser and credential, release both held keys, check cleanup and deliver a sanitized screen description. If publication fails, report the screen separately. Later private artifact review, a real fresh-context replay, the selected screenshot and original three-case comparison remain outstanding.

**Conditional outcome estimate:** About 20 minutes to the first terminal outcome and cleanup after approval and workable setup, only if a comparable run proceeds without extra blockers. Basis: the nearest earlier native login-first attempt ended incomplete and reached cleanup in 24m44s; the mandatory live-HMS ledger median is 0.8, yielding ~20 minutes from a rounded 25-minute raw reference. This is a low-confidence planning extrapolation from a **failed different run**, not a measured successful screen ETA. The earlier login-only executor check took 86 seconds including cleanup, but did not run the native mint. Unknown hook/permission or human-decision wait, retries, publication and fresh replay are excluded. Do not stop a progressing mint at the estimate. No defensible success-probability or full-proof ETA is available.

### Checkpoint 2 speed plan — ask 346

**Scope and authority:** Owner ask 347 authorizes execution of the ask 346 checkpoint after planning. Aim for one real model-driven read of the HRCEN Stay 360 landing screen and immediately stop further exploration. A screen-read pass is not publication or fresh replay. The original selected-screenshot and three-case proof remains later scope.

1. Obtain a genuinely allowed EC2 verification/build route for the already-staged private combined source. The host hook denied the attempted EC2 typecheck because its command matched the local rule; the standard remote typecheck covers committed Zero mail/server-pilot code, not this private Pomerado overlay. Do not route around that denial or run the stale build as though it contains the stop gate.
2. Reuse the existing login handoff, isolated browser and the two-key HRCEN guard that passed the login checkpoint. Check effective private Luna-max routing and Guardian for the actual mint. Correct the staged stop gate before using it: a rejected proposal currently leaves the gate open, and final-read classification depends on a pre-execution review. Make an unauthorized or ambiguous dispatch stop the attempt and prevent queued work from running. Verify which native dispatch produces the complete first observation: the gate must not close on navigation before the required automatic observation, or stay open after the first complete read. Confirm the combined source is what becomes runnable.
3. Give the native self-deployed mint a minimal read-only goal: open Stay 360, capture all visible labels, controls and values privately, then stop. The gate must close on the first complete screen read before a later queued browser dispatch; the normal automatic post-execution observation must be accounted for. Reject writes, extra navigation and ambiguous bundled actions. No guest searches. Preserve the accepted receipt and permit offline publication if possible; do not cancel just because the scheduling estimate elapsed.
4. Report the sanitized screen description and whether stop and cleanup were verified. A private complete capture is the evidence; a truncated snapshot is not a pass. If publication requires more browser work, report it blocked rather than silently continuing. Later source review, fresh-context generated-tool replay and three-case comparison are not dropped.

**Known speed trade-off:** The staged gate currently depends on a separate Luna review for individual proposed actions and final observation. It is not vendor-native and may add latency. Changing that review approach is not proven faster or equally effective. Reuse the existing seam, with the small stop fixes above, rather than invent another controller. Fail closed on an incomplete screen, wrong hotel, loss of either lock, unauthorized write or privacy violation. A pre-execution classification can miss a complete read, and the latch cannot undo extra actions bundled inside a dispatch.

**Verification:** Existing private checks include `.private/pomerado-readstay/stop-overlay/stop-gate.test.mjs`, `.private/pomerado-readstay/stop-overlay/trial-review.test.mts`, `.private/pomerado-readstay/trial334-coordinator-overlay/typescript/tests/trial/executor-gate.test.mjs`, and `.private/pomerado-readstay/trial334-coordinator-overlay/control/review-loop.test.mjs`. Prior synthetic passes are not combined-build or live-screen proof. On the permitted route check rejection followed by a queued action, first-read classification, bundled action refusal, the native observation sequence, reset/marker/live-test routes, and whether the final receipt survives without another browser action. For the actual result verify the complete screen, no subsequent exploratory dispatch, browser closure, guard-owned lock/session release, credential cleanup and hotel service state. Publication remains blocked if receipt preservation is not established.

**ETA:** No reliable checkpoint completion ETA is established. Withdraw the 28-minute scenario: scaling invented stage durations with an unrelated ledger median repeats the earlier rejected method. The native login-first mint ended incomplete after 20m29s, and the successful deterministic login checkpoint took 86 seconds through cleanup. Neither measures a successful model-driven screen read. The approval/hook delay and the newly identified stop-fix work are unsized.

### Key technical decisions

- KTD1. **Reuse Nava's existing `login(page, secret, {})` unchanged.** First try a small fixed, host-authored call through Pomerado's existing `browser.execute`: its worker already executes code with its own Playwright `page`, `context` and `browser`. Call the helper after `state.start.enter` and before minting. Reuse the same hook after an actual clearing reset and, for cold replay, on the operation's own fresh page after `runOperation` calls `startPage` and before the generated tool. Verify the requested tenant and HRCEN each time. An earlier offline probe was followed by a real EC2 checkpoint: Pomerado’s compiled executor opened its own browser, and the helper verified HRCEN. This does not prove native mint or fresh replay. This is a host integration change, not a supported stock callback. Add a dedicated worker request only as a fallback if the smaller route cannot meet the credential or lifecycle requirements. Never attach the shared production browser by CDP or remove the standalone rejection.
- KTD2. Deliver credentials to the fixed host call without embedding values in its code string, model prompts, generated source, execution receipts, ordinary logs or public artifacts. The simplest candidate is a unique, one-use mode-0600 credential file under `.private/pomerado-readstay/`, read by the trusted call and removed immediately in `finally` before model-authored execution; recreate only when the separate fresh run needs login. A crash must trigger cleanup of that trial-owned file; if removal fails, do not start generated execution. This is a candidate, not proven private delivery: the worker and model-generated code share an OS user, so file permissions do not isolate them from each other. If that residual access cannot meet the approved boundary, use the prior dedicated worker-request fallback rather than silently leak credentials. Scope references to login and do not claim guaranteed JavaScript memory zeroing. Pass `{}` as the helper env to avoid shared slot-cache writes. Do not capture the page before login is verified and the visible text-type password control is gone.
- KTD3. The smallest source-supported candidate is a **per-mint dispatch latch**, not a general browser-control framework. Bind it to the session used by the mint. Accept only a verified HRCEN Stay 360 observation with complete visible contents; atomically close the latch in the same dispatch synchronization domain before another queued call can proceed. Cover host browser execution, credential, reset, live-test, marker and snapshot paths; queued calls recheck after acquiring the permit. Leave the finished observation receipt intact, refuse later live actions explicitly, and let authoring, `finish_build`, Guardian and packaging proceed without further browser work. A fresh replay has its own scope and does not inherit the mint latch. Do not cancel the job or treat host-unavailable as the stop: either may lose the artifact. A latch cannot undo bundled actions, unawaited work, timers, page-side activity or arbitrary process/network activity; pre-dispatch inspection must reject writes, extra navigation and ambiguous scripts, and stop if the actual one-screen boundary cannot be established. Pomerado normally calls `context.observe` after a live script and before recording its receipt. Account for that call when identifying the final permitted screen read: if the script already completed the requested read, do not silently allow another browser observation. A snapshot may truncate or omit content and alone does not prove a complete screen. Offline contract execution is not an OS sandbox. The candidate is staged and its executor queue behavior passed synthetic tests. The combined source is not built after the hook-denied check, and real-screen coverage and publication remain unproved.
- KTD4. Pomerado job completion, `build: published`, a screen-read result, and a cold replay are distinct. `mint-publication.ts` can retain a completed explore result with the required matching entrypoint and result reference; the vendor sign-in test asserts publication from an explore after a subsequent verified sign-in. Separately, the harness `publishableReceipt` predicate used when closing an unavailable host accepts completed example/act receipts, not explore alone. Neither proves a one-screen host-login mint will publish. If more site exploration is required, stop and report the conflict; never substitute a handwritten script.
- KTD5. A new Pomerado context does not necessarily inherit cookies, local storage, session storage or Pomerado's native sign-in proof. A served run can replay a recorded login and then reset to the site root; a host login is not automatically a native sign-in recipe. Integrate deterministic login at the correct fresh-run/reset boundary and verify HRCEN in the same context. Check the actual start URL and later root/reset behavior; do not assert those caused Cloud failure.
- KTD6. Stay 360 content and local source can expose guest data to model execution. Use only the previously approved private route and keep trial evidence private. `effect: read` and Guardian are not by themselves a hard runtime write barrier; review generated actions before replay.
- KTD7. Reuse the existing Product EC2 isolated checkout, browser and approved private Azure setup. A rebuild can overwrite generated JavaScript. Check and, if needed, apply Luna max to every trial role and restore the isolated provider/cache compatibility settings. Historical overrides used Terra; they are not evidence that current Luna routing is effective. Capture pre-redaction execution errors privately so another screened final ledger does not hide the failure; do not treat local settings as a per-call provider receipt.

### Existing Nava login to reuse

The hotel login is **already implemented**. `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:162` accepts a Playwright page plus the selected hotel's secret, navigates to its `loginUrl`, fills and submits the existing form, and checks the expected tenant and property. `apps/server-pilot/tooling/playwright-quote/hms-slot-lease.mjs:108` reuses an authenticated page or calls that helper under the property lock. The quote workflow already consumes this shared lease and property-specific credential configuration.

Do not implement another HMS login or copy a Da Vinci URL into the Centurion test. Select the correct property's existing URL, credential reference and expected identity from its configuration. The requested test remains HRCEN; HRDAV has its own tenant, browser slot and credential reference and is not evidence of HRCEN success. Stock Pomerado standalone does not consume Nava's authenticated page: it creates its own context. Its lower-level CDP executor can adopt only a compatible browser-default-context page, whereas Nava's borrowed-page helper creates another context. The lower-level operation test is not a native mint. Therefore the default is the fixed host call on Pomerado's own page; direct same-page reuse and fresh replay remain unproved.

### Revised critical path: no reliable ETA yet

The earlier **36-minute coding line and ~90-minute total are withdrawn as estimates**. Their inputs were judgment calls, not measured durations of this Pomerado integration. Applying cross-task ledger medians to unmeasured inputs did not make them evidence-backed. A tenfold faster controlled-work target is worth trying, but neither success within that target nor impossibility is proven.

The speed change is real sequencing, not removal of the requested replay:

1. Start EC2 setup in parallel. In the isolated mint build, add only the existing login handoff and the minimum job-scoped stop required for the first screen. Run a targeted check and review those changes before minting.
2. Start the native mint as soon as those prerequisites pass. In parallel, prepare and review the fresh-run hook and its focused check in an isolated source/build area; do not rebuild, mutate or restart the running mint's files. Use the same existing login helper. Resolve any shared-interface dependency against the frozen mint build.
3. Once the screen is read, stop further exploration but preserve the completed receipt. If the mint publishes, privately review the actual artifact; run it once in a new authenticated context after the replay hook and checks are ready. If publication requires more live actions, report partial rather than claiming replay passed.
4. Clean up and verify the real property lock and any interrupted slot. The screenshot and original three-case proof remain outstanding.

Use one small focused test file or existing tests for the changed seams rather than mandating three new test files. Test the stop and auth before mint. Test the cold-run seam before replay. Extra protocol, sandbox-proof, public smoke or full-suite work is not a prerequisite; a necessary fix discovered at runtime remains necessary. Source review supports this opportunity but not its duration or success.

### High-level flow

```text
HRCEN property lock held
  -> dedicated Pomerado context/page
  -> trusted Nava deterministic login
  -> verify expected tenant + HRCEN in that same context
  -> inspect each proposed live script; reject writes and off-task actions
  -> Pomerado read-only navigation -> Stay 360 full-screen observation
  -> stop further exploration -> retain private evidence
  -> only if native artifact actually exists: private source review
  -> new context + run startPage -> Nava login on that page
  -> one generated-tool replay -> verify output
  -> terminate owned processes -> restore slot -> release actual lock
```

First screen observation can pass without a published artifact. A replay pass requires the artifact and the independent fresh run. An abort that prevents publication is a partial result, not a fresh-run pass.

### Assumptions and research limits

- Source review snapshot: Zero worktree `92be0e5d2`, Pomerado clone `7349a1c2`; `origin/main` was `3a5b3f315`. Current EC2 checkout, build and model settings are historical observations, not freshly checked in planning. The focused stop-seam source review did not run tests, the real worker, a browser or HMS.
- How to inject trusted login into the worker context without exposing secrets or defeating Pomerado's reset/sign-in tracker requires exact implementation against the pinned source. It is a proposed integration, not a built-in supported standalone flag.
- A `storageState` transfer is a fallback only if shown to preserve the actual HMS session requirements. The stock `--endpoint` creates a fresh context and is not a same-page handoff. CDP attachment to a shared slot is not a shortcut.
- A successful time or cost for this specific hybrid proof is not measured. Earlier failed mints are not success-duration estimates. Do not turn an ETA into a stop timer.

### Decision checkpoints

| Topic | Decision or honest limit |
|---|---|
| Property | HRCEN only. Never fall back to another property. |
| Live canary | One full visible Stay 360 read, then one fresh generated-tool run on HRCEN. |
| Configuration | No product flag flips or deployment. Existing isolated model and browser setup is checked at execution. |
| Retry | Do not blindly remint. An actual failure gets private evidence and a specific diagnosis before any retry. |
| Freshness | Verify against the exact isolated build used in both stages. No product-deploy claim. |
| Staff-facing error | No staff UI is changed. Give the owner a plain-language failure and which stage failed. |
| Build choice | Narrow Pomerado-context authentication adapter, not a Nava stack replacement or shared-browser rewrite. |
| Product scoreboard | Capability experiment only. Golden-set and full three-case product bars remain unscored. |
| Holds | No writes, sends, flag flips, unsolicited install, public example, or unapproved scope extension. |

---

## Implementation Units

### U1. Reuse the existing login in Pomerado

**Goal:** Place the proven Nava login in a dedicated Pomerado-owned execution context, without handing secrets to the model or compromising the shared HMS slot.

**Requirements:** R1, R5, R6, R7. **Dependencies:** None.

**Files:** Zero `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs` and `apps/server-pilot/src/hms/property-read-lock.ts` are reused references. Initial Pomerado touchpoints: `typescript/src/standalone/mint-host.ts`, `typescript/src/standalone/run-operation.ts`, and `typescript/src/runtime/start-state.ts`. Do not change the worker protocol unless the fixed-call path fails the credential/lifecycle requirements. Use an existing focused test or a single trial seam test such as `typescript/tests/unit/nava-session-trial.test.ts`; do not require a separate test file for each hook.

**Approach:** Reuse the complete existing helper, not just its selectors. Make the existing host executor run a fixed trusted helper call on its own page, using the credential candidate in KTD2. Place the initial hook after `state.start.enter`, handle a clearing reset if it happens, and use the same hook after `runOperation`'s `startPage` for cold replay. The existing executor and worker already serialize calls. Use an empty slot-cache environment. Scope changes to the isolated trial build. Confirm the actual EC2 Node 24 load, secret delivery and Pomerado sign-in tracking; none is proven by the local module-load check.

**Execution note:** Keep characterization at the changed seam. Review mint authentication and stop changes before a live mint. Prepare and review the independent fresh-replay change while that mint runs, without touching its active build.

**Test scenarios:** Actual EC2 worker can load the unchanged helper; correct tenant and property permit exploration; login shell or wrong property refuses it. Missing credentials or failed login ends without exploring. One-use credential file is private, never enters model/source/output, and is removed on success or failure before authored execution. A reset/new context causes reauthentication where required. Password and guest data never appear in model prompt, generated source or ordinary logs. Loss of the real lock ends browser work.

**Verification:** Same dedicated Pomerado page shows the expected tenant and HRCEN after deterministic sign-in. The lock holder is alive throughout active HMS work.

### U2. Screen-only Pomerado exploration and artifact

**Goal:** Prove Pomerado can navigate and read Stay 360, with no uncontrolled exploration.

**Requirements:** R2, R3, R6, R8. **Dependencies:** U1.

**Files:** Pomerado `typescript/src/standalone/pomerado.ts`, `typescript/src/execution/playwright-execute.ts`, `typescript/src/standalone/mint-execution.ts`, `typescript/src/standalone/mint-live-tests.ts`, `typescript/src/standalone/mint-publication.ts` and `typescript/src/mint/harness.ts` identify candidate binding, dispatch and publication paths, not an instruction to edit all of them. Use the same focused trial seam test or an existing test; reuse existing publication tests as references rather than expanding several vendor suites for this one-off trial.

**Approach:** Use native local read mint with a fresh tool name, tenant URL and no guest inputs. Prompt: “Open Stay 360, read all visible labels, controls and text, then stop browser interaction. Read-only; do not search for a guest or open another page.” Keep credentials out of that prompt. Host-reject write authority and write-switch answers. Check each proposed browser script for actions outside that task before dispatch; a script that both reads and then opens another page fails the stop. Close the job-scoped latch atomically with acceptance of the complete screen observation; queued calls recheck it before dispatch. Preserve the receipt and allow offline finalization only without further browser work. Inspect authored code and process behavior; host-only offline checks are not a general-purpose sandbox. Record the actual artifact and `published` status, or report replay blocked.

**Test scenarios:** A correct, complete screen read closes the latch before queued calls can dispatch; wrong-screen or incomplete capture does not pass. Reject a bundled read-plus-extra-navigation script before dispatch. Subsequent execute, credential, live-test, reset, marker and snapshot routes are refused while the observation receipt and offline finishing remain usable. Exercise concurrent queued calls and a separate unfenced fresh replay. Test the limit: a latch cannot undo already-started or unawaited work. Refuse write-effect and write-switch requests. If publication requires another live action or is incomplete, preserve the screen outcome and hold replay. Keep guest data private.

**Verification:** Same-session evidence shows Stay 360 and private full-screen contents. Public/chat result is sanitized. Further exploratory actions do not occur after the screen read.

### U3. Fresh generated-tool replay and cleanup

**Goal:** Establish whether the generated tool works from a cold context under the same deterministic authentication contract.

**Requirements:** R3–R8. **Dependencies:** The fresh-run hook and its check can be prepared alongside U2 after the shared login interface is settled. Actual replay requires U2 to produce a real Pomerado artifact; otherwise it is blocked.

**Files:** Pomerado `typescript/src/standalone/mcp-server.ts`, `typescript/src/standalone/run-operation.ts`, `typescript/src/runtime/start-state.ts`. Use the same focused trial seam test or an existing test to exercise the actual start/login/operation ordering; do not require another new test file. Private artifact and output remain in the approved private workspace.

**Approach:** Review the actual generated tool for all actions, targets and data handling before running it. Retain Guardian and the existing lock. Create a new context; let the operation establish its start page; then run trusted Nava authentication and verify HRCEN on that same page. If the site-root start fails before the hook, diagnose the actual failure and adapt the isolated replay start to the tenant entry URL; never reuse the warm mint context. Invoke the generated tool once and report its visible screen privately with a sanitized result in chat. Capture the pre-redaction execution failure privately rather than relying on the screened final ledger. Clean up on native terminal result, not only controller exit.

**Test scenarios:** Fresh context authenticates and the generated tool reads Stay 360; an old browser session alone cannot satisfy the test. A site-root failure before login is surfaced and the tenant-entry fallback is exercised only in the isolated replay. Incorrect tenant/property, missing artifact, login failure, lock loss or any write behavior prevents replay and triggers cleanup. Both hotel slots return to their pretrial intended states; no trial lock holder or trial-owned process remains.

**Verification:** Private evidence identifies the new context, authenticated HRCEN, actual generated tool, full screen output and cleanup. An incomplete build or a host-written replacement is not a fresh generated-tool pass.

---

## Verification Contract

- Focused seam tests cover context/reset/sign-in boundaries, event-based stop, secret non-disclosure and fresh replay. A mock alone does not establish a real fresh HMS context; the actual generated-tool replay remains required. Run appropriate tests on Product EC2, never the coding VPS. Before Vitest unset the project-specified database variables; never test on pilot RDS.
- Establish actual running build and existing model/cache settings before execution. Luna max applies to every trial role; retain Guardian, approved private data routing and the shared HRCEN property lock. No separate pre-mint role or public smoke gate is invented.
- Report each milestone as pass, fail, inconclusive or blocked: login plus HRCEN identity; first screen read and stop; artifact publication; fresh tool replay; slot/process/lock cleanup.
- Hold the real HRCEN advisory lock on its dedicated PostgreSQL connection while the separate Pomerado browser does HMS work. Monitor the holder; stop browser work if the database connection or lock is lost. Do not confuse the database lock connection with a shared browser or attach to the slot by CDP. When finished or interrupted, stop owned processes, restore any paused slot, verify the actual holder is gone, and report any failure without claiming restoration.
- The earlier draft received the requested Grok 4.7 xhigh review; the later ask 329 fixed-host-call revision and ask 331 speed revision were not reviewed by Grok. Review implementation changes and the generated artifact before use. Exclude credentials and guest data from reviewers outside the approved private route.

---

## Definition of Done

The complete proof requires all milestones below. The experiment can finish with an explicitly reported partial outcome if publication or replay is blocked; partial completion is not a pass for the full proof.

- Authenticated HRCEN in the Pomerado-owned page is evidenced.
- Pomerado reads all visible Stay 360 content once and ends exploration immediately.
- A Pomerado-produced artifact is privately reviewed and run once from a fresh authenticated context, returning the screen again.
- Full raw screen content remains private; the owner receives a sanitized description and the separate outcomes.
- The browser, slot and actual property lock are verified clean after the final active run.
- Any blocked milestone remains explicitly blocked. This proof is not the original three-case proof or a product release.

---

## Sources

- Owner's original asks 328, 329, 330 and 331: `docs/context/OWNER-ASKS.md`.
- Existing login, per-hotel selection and handoff alternatives: `docs/research/2026-10-27-pomerado-login-reuse-scope.md`.
- Owner challenge and critical-path correction: `docs/research/2026-10-27-pomerado-estimate-critique.md`.
- Smallest candidate stop seam and its limits: `docs/research/2026-10-27-pomerado-fast-stop.md`.
- Cloud evidence and local integration boundaries: `docs/research/2026-10-27-pomerado-auth-diagnosis.md`.
- Pinned native MCP contract and output privacy: `docs/research/2026-10-27-pomerado-native-mcp.md`.
- Prior local attempt and missing execution failure detail: `docs/context/ledger/2026-10-27-pomerado-login-first-retro.md`.
- Pomerado local setup: `README.md`, `docs/agent-setup.md`, `docs/getting-started.md`, `docs/how-it-works.md` in the Pomerado repository at the pinned source revision. Native host/publication evidence: `typescript/src/standalone/mint-host.ts`, `typescript/src/standalone/mint-publication.ts`, `typescript/src/standalone/mcp-jobs.ts`, `typescript/src/mint/harness.ts`.
- Historic generated-build overrides: `docs/research/2026-10-27-pomerado-main-update.md`.
- Grok 4.7 plan review and source-backed adjudication: `docs/research/2026-10-27-pomerado-handoff-grok-review.md`.
