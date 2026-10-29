# Grok adversarial review of Pomerado fast proof

Date: 2026-10-27. Owner ask 311. The user requested Grok 4.7 xhigh via Grok Build CLI, with exact paths and prior context. The CLI was invoked with `--model grok-4.7 --reasoning-effort xhigh` in plan mode, web and nested agents disabled, with read/search tools and no permitted private files in the brief. The actual provider-side model/effort receipt and review charge were not retained. The first launch failed before review because this CLI rejected `--add-dir`; the successful retry embedded pinned public vendor excerpts. No mint, browser operation, model-configuration change, live-service check or product change occurred. The reviewed plan hash was `3dfccf9632816e4cc20246837a0981979507e4dcdb58b7b6e95e344d8866da31`.

## Adjudication

| Finding | Grok | Coordinator disposition |
|---|---|---|
| Luna max routing | P0 | **P1, confirmed plan gap.** Historic EC2 generated output was Terra/xhigh; vendor source has distinct model/effort settings and a Guardian specialized override. Plan names the intent but does not name the six previously patched files or exact future check. Do not infer a current outage or that the TypeScript effort union prevents a generated JavaScript change. [Plan](../plans/2026-10-27-008-pomerado-fast-proof.md#L9) · [prior update](2026-10-27-pomerado-main-update.md#L8). |
| 25/40/65 forecasts | P1 | **P1, valid calibration objection.** A failed old mint and untimed assumptions cannot support a success midpoint. The plan discloses this, so Grok overstates that it hides uncertainty; its main concern about numerical authority remains. The mixed 0.88 ledger multiplier is a user rule and cannot simply be omitted from a quoted estimate. Withdraw these as reliable success forecasts; retain only as illustrative no-failure scenarios until a successful trial measures the phases. No execution has started. |
| Read-to-write switch | P1 | **P1, concrete ambiguity.** [Vendor README](https://github.com/Pomerado/pomerado/blob/7349a1c2/README.md#L115-L120) says a read mint can ask to switch and a write mint acts during authoring. The plan already says never write, but should explicitly say decline any switch. This is an existing owner boundary, not a new gate. |
| Property lock holder | P1 | **P1, confirmed omission of operational detail.** The fast plan says hold and release the lock but omits the previous plan's instruction to keep the actual database holder alive and stop hotel work if it is lost. PostgreSQL lock acquisition uses a dedicated connection in `apps/server-pilot/src/hms/property-read-lock.ts:254-301`. Restore that operational detail without inventing another pre-mint proof. |
| Tenant-root wording | P1 | **P2, plausible clarification, not confirmed failure.** The fast plan already says use the supplied tenant URL; its prompt does not explicitly say use it for both login and every lookup. [Vendor source](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/how-it-works.md#L16) says live examples start at root; a prior root 404 is historical. Specify the tenant path more plainly; the new prompt has not been tested. |
| Native protocol details | P2 | **P2, partially valid.** Put all required mint fields and question/job expiration details next to the fast steps. The plan already tells the controller to keep the session alive and distinguishes `published` from `incomplete`; do not claim those are missing. [Native source review](2026-10-27-pomerado-native-mcp.md#L7-L11). |
| One-case scope | P2 | **P2, useful presentation clarification.** A selected-case publication or partial comparison should be reported separately from a complete selected-case match and the original full three-case pass. Preserve the full requested field coverage; do not redefine missing fields as a complete match. |

Grok endorsed the owner's minimal setup, existing lock and human-approved boundaries, preserved the three-case goal, and did not recommend a public example, extra sandbox proof, new credential approval, alternate client, telemetry gate or Terra fallback. It agreed that Mastra compatibility is generic until Nava integration is tested, and that vendor speed claims compare pre-minted integrations with computer use.

The review was requested as assessment only. The target plan was not modified. The trial remains paused. No new reliable execution-time estimate exists.

## Grok's review

Review is read-only. I will read the named sources in order and judge the plan against those excerpts only.Required docs are in. Next I read the native-MCP note, main-update note, and plan 007 only where the original bar or timeline is stated.Plan 007’s bar and the two research notes are in. I will check only the named code ranges the findings depend on.**Not suitable as written** for a future authorized attempt. The one-case scope is right. Four sentence-level fixes make it executable. Trial stays paused. This review used only the named documents and pinned excerpts. Live model, lock, and services were not checked. The Terra/xhigh note is historic only.

| Kind | What |
|---|---|
| Factual error | 25/40/65 treats a failed mint plus a mixed-history shrink factor as a working ETA |
| Execution risk | Luna patch, write-switch, lock connection, site-root intent |
| Owner choice, keep | Luna max, one private case first, no sandbox/smoke/re-approval, pause |

### 1. P0 — Luna max cannot be applied as written
- **Where:** plan:9; `models.ts:6-9`; `mint/openai.ts:565,1266,1864`; `guardian/model.ts:7-12`; `guardian/openai.ts:719-725`; `outcome-review-openai.ts:175-183`; `mint-host.ts:68`; main-update:8-9.
- **Quote:** "Upstream model aliases and effort defaults alone do not enforce this."
- **Failure:** Historic dist is Terra/xhigh. The minter hardcodes `solModel` and types effort `low|medium`. Guardian `specialize` can replace effort. The outcome reviewer hardcodes medium and a 12-hour breakpoint. A clean rebuild restores the 12-hour breakpoint Azure already rejected. A literal start either stops or improvises and can run Terra, xhigh, or medium.
- **Why:** Step 1 is the authorized start. Improvised patches are how the last trial drifted.
- **Fix:** Name the six dist files. Reapply the Luna model id, effort `max`, and 30-minute breakpoints together. Do not rebuild unless that patch is reapplied. If `specialize` or the effort union cannot express `max`, stop and report. No telemetry gate.
- **Confidence:** confirmed gap. Azure Luna-max acceptance unverified.

### 2. P1 — 25/40/65 hides the uncertainty
- **Where:** plan:29-33; retro:35; plan 007:91,97; research speed:11-12; README:125; `how-it-works.md:17-18`.
- **Quote:** "5 min setup allowance + 22 min prior incomplete mint = 27 min; 27 × 0.88 = 23.76, rounded to 25."
- **Failure:** 22 minutes is an incomplete actual from the older package, not a success estimate. The ledger factor is for uncalibrated guesses. Retro:35 says no credible ETA can be derived from those overlapping partials. The new build has never minted. Signed-in live tests can consume the 20-minute active cap and refuse `finish_build`. An executor will still treat 25 as the publication target. 40 and 65 repeat the same base. 65 also assumes the screenshot stay is one of the three.
- **Why:** This is the optimistic-timing pattern the retro already marked.
- **Fix:** Drop the 0.88 product. Keep the component list and state that the success time is unknown. Label 40 and 65 as cumulative from start, and only if the first mint publishes.
- **Confidence:** confirmed.

### 3. P1 — A read mint can ask to become a write
- **Where:** plan:15,41; README:119-120.
- **Quote:** "Answer requested inputs from already authorized access."
- **Failure:** A read mint that "needs a change" asks to switch to write. The agent's answer decides. A write mint performs the action once while building. "Already authorized access" can be read as permission to approve that switch on the real booking.
- **Why:** The owner kept read-only. This is that boundary, not a sandbox proof.
- **Fix:** If the job asks to switch to write, decline.
- **Confidence:** confirmed vendor behavior; misread is credible.

### 4. P1 — "Retain the lock" has no holder check
- **Where:** plan:11,17; `property-read-lock.ts:3-6,91-98`; plan 007:58.
- **Quote:** "Acquire and retain the existing shared HRCEN property lock."
- **Failure:** The advisory lock lives on one dedicated connection and drops when that session ends. Pomerado's browser does not hold it. A closed connection leaves the hotel browser running with no lock.
- **Why:** Ask 304 kept this lock. Plan 007 had the check. The fast plan dropped it.
- **Fix:** Keep that connection alive. Stop hotel work if the holder is lost. Release the real holder on every exit.
- **Confidence:** confirmed mechanism; missed check is credible.

### 5. P1 — The intent no longer carries the known tenant path
- **Where:** plan:13-15; `how-it-works.md:16`; native-mcp:13; plan 007:30.
- **Quote:** "open the exact matching booking using the supplied tenant application URL."
- **Failure:** A live example starts over at the site root. The prior independent check saw that root 404, while the tenant URL worked. The fast intent dropped that instruction. Source review happens only after publication, so a root 404 can spend the active mint and end incomplete.
- **Why:** This is an observed navigation fact, not a guessed login cause.
- **Fix:** Add one intent clause: use the supplied tenant URL for sign-in and every lookup. The host root is not the application.
- **Confidence:** confirmed for live-example start. Published-run root behavior is credible from native-mcp:13.

### 6. P2 — Native call details were compressed
- **Where:** plan:13-16; native-mcp:9-11; README:110-112.
- **Failure:** Step 3 names name, effect, and example, but not required `url`. Input requests expire after 10 minutes. Finished in-memory jobs expire after 15 minutes. `completed` can still be `build: incomplete`. A slow or restarted session loses the prompt or the published-vs-incomplete status.
- **Why:** These can block or blur the first call. They are not new gates.
- **Fix:** Mint with a fresh name, tenant `url`, intent, `effect: read`, and confirmation-only `input`. Answer before 10 minutes. Capture the terminal build status before 15 minutes. Do not restart the server.
- **Confidence:** confirmed protocol. Miss under the compressed steps is credible.

### 7. P2 — "Full coverage" can re-expand the first milestone
- **Where:** plan:7,17; plan 007:69.
- **Quote:** "full requested field/section coverage" and "compare against the exact independently observed record."
- **Failure:** Prior captures are partial and skip checkbox and radio controls. Overlap with the three stays is unknown. An executor can block the first milestone on a three-case-grade answer key.
- **Why:** The steps themselves keep the three cases later. This sentence can undo that.
- **Fix:** The first answer key is the selected visible record. Missing sections stay missing. Publication, first-case match, and the three-case pass stay separate results.
- **Confidence:** credible.

**What survives.** The milestone does not require the three-case pass, a package install, or both-surface proof. Mastra MCP is a later route. `@mastra/mcp` is absent from `package.json:43-60`. The pane path (`pane-stay-lookup.ts:437-453`, `hms-jobs.ts:1-11`) and the agent tools (`reservationist-agent.ts:108-156`, `candidate-draft-agent.ts:387-409`) are different consumers. The vendor speed page compares pre-minted tools with computer use. The same-booking Nava baseline stays the right comparison, and only before an advantage claim.

**Strongest counterargument.** The linked research already names the six dist files, the 12-hour Azure failure, and the weak 0.88 factor. A careful executor who opens those links can patch and run. The owner said plans are what LLMs execute. The last controllers did not follow linked caveats. Those sentences belong in this plan.

**Do not add.** Sandbox, role, or outbound proof. Public smoke. A second credential approval. An alternate client. A telemetry gate. A pre-mint capture hook. A second hotel browser. A login-cause theory. A Terra reversal. A 15-minute success claim. Treating one-case success as the three-case proof.

**Missing evidence.** A successful publication time. Whether this build enforces the 20-minute active cap. Whether Azure accepts Luna max on these patched calls. Whether the screenshot stay is one of the three. The login root cause. Do not infer that cause.
