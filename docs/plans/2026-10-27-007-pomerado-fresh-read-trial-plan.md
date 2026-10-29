# Fresh Pomerado read-stay trial

Created: 2026-10-27

**Status: historical planning only.** Ask 310 supersedes this plan’s Terra routing and 105-minute active forecast with [plan 008](2026-10-27-008-pomerado-fast-proof.md). The original three-case acceptance remains. Ask 309 requested a plan, not a trial launch. The owner’s pause remains in force. This plan supersedes the trial method in plan 006 where it conflicts with the owner’s subsequent control decision, without shrinking the original acceptance bar.

## 1. Goal and assumption

Use the latest Pomerado source build to mint a reusable **read-only HRCEN Guest Stay lookup**. The only required runtime input is a confirmation number. Then run it on the three previously specified stays and independently compare each result with the corresponding expanded HMS screen.

“Booking example” is interpreted as reading an existing booking, the original `hms_read_stay` proof. This does not create a reservation or prove new booking, Add-Ons, HRDAV or product integration. Those remain the broader goal, not silent substitutions for this trial. If the owner instead means a Labtest create as the first proof, that is a different operation and approval, not an assumption to execute.

## 2. What we provide

| Essential | Provide once | Do not add |
|---|---|---|
| Real target | The exact configured HRCEN tenant login URL, not the site root. | A separate public-site example or manual login exercise. |
| Access | Existing authorized account credentials through Pomerado’s requested private input flow; the approved Azure route and `.private/pomerado-readstay/` for generated artifacts, screenshots, temporary files and logs. | Credentials in the task text, generated source, public logs, chat or a new client. |
| Read authority | Pomerado’s read authority and Guardian; no real-guest write, cancellation or email send. | Assistant-added role-proof expiry, process-wide sandbox proof, outbound-sandbox proof or a new approval for credentials already authorized. |
| Job | The short intent below and one private representative confirmation as the authoring example. | Selectors, a click-by-click script, contradictory browser instructions or all three answers embedded in the code. |
| Client and models | The updated EC2 source-built MCP server and the approved Terra configuration. Keep the MCP session alive until the job is terminal; answer its actual questions. | A custom MCP client, undocumented harness, provider swap or premature cancellation of a progressing mint. |
| Shared hotel | The existing HRCEN property lock; stop only a conflicting slot if required and restore what was interrupted. | A blanket interruption of unrelated services or another concurrent HRCEN browser owner. |

The build and offline CLI help passed at source revision `7349a1c2`. That is not an end-to-end Pomerado, login or hotel proof. The old npm package and logs remain. Terra/xhigh defaults and Azure 30-minute cache settings were patched into generated output; a rebuild replaces them. Some specialized Guardian calls can override default effort, and the static patch does not prove the effective model or effort on each call. Check the effective approved route and available per-call evidence during execution without inventing a telemetry gate. The earlier custom private outcome-capture hook was not ported, so failure detail on the new version is not guaranteed. Check what actually exists at execution, without making a new capture hook a prerequisite.

## 3. The mint

**Suggested intent:**

> Build a reusable, read-only lookup for an existing HRCEN guest stay. Use the supplied tenant application URL for authentication and every lookup, rather than assuming the host root is the HMS login. Given a confirmation number, find and open the exact matching reservation in Guest Stay, adjusting any search date window as needed. Return the displayed fields and their values from the accessible record sections, including blank fields, visible checkbox or radio states, and repeated rows. Preserve which section and row each value belongs to. If the confirmation is missing, ambiguous, or a section cannot be read, report that rather than guessing. Do not create, change or cancel a reservation, send a message, or perform another write.

The native `mint` call requires `name`, `url`, `intent` and `effect`. Use a fresh name, the exact tenant URL, the short intent above and `effect: read`. Supply the single private confirmation example in the optional `input` value. Set `authenticationOrigins` only when the site’s sign-in flow needs additional origins. Do not put credentials in the intent or URL. Let Pomerado discover login and navigation.

| Native mint field | Value for this trial |
|---|---|
| `name` | A fresh lower-case integration name, for example `hms_read_stay_fresh`. Choose another name if its folder is already reserved; do not delete prior artifacts. |
| `url` | The exact private HRCEN tenant application URL, without credentials. |
| `intent` | The short task above, without a real confirmation number or credential. |
| `effect` | `read`. |
| `input` | One private example containing only a confirmation number. The eventual integration must accept a confirmation number as its only required input. |
| `authenticationOrigins` | Optional additional sign-in origins only if needed for this site. |

The intent is saved in the integration deployment configuration and exposed as the tool description. Do not put secrets or guest details there. The example, native answers, run output and controller logs can contain private data and remain inside the authorized private workspace; vendor documentation says run output is not redacted. Give the already-observed text-type password-field hint **only if it needs help**; it is not an established cause of failure. The date-window hint reflects the prior independent searches, where two cases were initially missed without date hints. It is not a proven fix for Pomerado login. A private date hint may help authoring if needed, but it is not proof of arrival and must not become a required runtime input. Exact confirmation, not a date or guest-name guess, identifies the record.

**Controller instruction:** use the registered Pomerado MCP tools directly. No custom MCP client or integration harness. Mint returns a job; call `get_job` and use `provide_input` with the returned job ID, request ID and answers when it asks a question. Answer all requested questions from already-authorized private access; do not ask the owner again for credentials already authorized. Input requests expire after ten minutes, so answer promptly. Pomerado documents that integration runs can request login again, so respond to those prompts too. Preserve private controller logs because responses pass through the client and model. The precise credential answer wire shape is not yet verified.

Keep the native MCP server and job session alive while the mint is active: mint jobs are stored in memory and do not survive a server restart. Do not restart the server to fix a progressing job. Let it reach a terminal result unless an actual error or the owner’s overall timebox requires a stop. A completed job can still report `build: incomplete`; only `build: published` is publication. Capture the terminal result promptly: completed in-memory jobs expire after fifteen minutes. Failed and cancelled jobs are not published results. If the client reports missing tools, diagnose that actual client/session failure; do not invent a second client or assume it explains HMS sign-in.

The intent is intentionally similar to earlier prompts. `mint7`, `mint9` and `mint10` already contained the core task. Simpler wording and updated Pomerado do **not** establish a fix for the earlier login failures.

The vendor documents that generated runs start at the site root, even if mint was given a deeper URL. HRCEN’s root previously returned 404. The intent therefore names the tenant application as the target for every lookup, and source review must check how the generated integration reaches that tenant path. This is a documented runtime behavior and an observed earlier root 404, not proof that the new build will fail.

The newer upstream code includes [key-by-key retyping when a sign-in submit stays disabled](https://github.com/Pomerado/pomerado/commit/207083e6) and [a delayed-screen handling change during sign-in replay](https://github.com/Pomerado/pomerado/commit/d6877e1e). Both landed after the earlier package, but whether either affects HRCEN or explains our failure is unverified. They are a reason to test the updated version, not a claim that login is fixed.

## 4. Run sequence, if the owner resumes

1. **Use the prepared setup.** On Product EC2, use the updated isolated Pomerado executable, private workspace, configured tenant and approved model/provider route. Provide one real private confirmation example. No public demo, reinstall, fresh role-proof exercise or additional sandbox gate.
2. **Let Pomerado author.** Acquire the shared HRCEN property lock, pause the conflicting HRCEN slot only if needed, and start one native read mint. Keep the actual lock-holding database connection alive throughout browser work; verify it remains held before each browser phase and stop hotel work if it is lost. A parent token alone does not prove the lock is held. Let Pomerado handle the site and login. Answer legitimate credential or site questions from existing authorized private access; escalate only an actually unavailable factor or changed authorization.
3. **Prepare proof without a second hotel browser.** While minting runs, organize the existing partial private references and the three-case comparison template offline. No second HRCEN browser owner and no claim that the existing snapshots cover everything.
4. **After publication, overlap the safe work.** Review the private generated source and runtime behavior before replay, including how it reaches the tenant path from the runtime’s site-root start. In parallel, the single browser owner completes independent reference capture, including every accessible tab, blank, checkbox/radio state and repeated row. A reviewer may use the approved Azure route with credentials and unnecessary guest content removed. Do not send private artifacts to Greptile. Guardian remains on; read mint authority is not a technical guarantee that generated execution cannot write.
5. **Replay and compare.** Execute the generated operation on each of the three specified confirmations as its only required input. Compare each result against its independently captured exact record. Preserve section and row identity. Report missing, extra, incorrect, inaccessible or unchecked fields; no invented pass and no substitution of the existing reader for Pomerado output. Keep only one HRCEN browser actor at a time.
6. **Recover only from observed failures.** A tool-discovery issue, credential prompt, Guardian denial, provider error, login failure or wrong result is reported as its own event. Inspect native job results and private logs, make one evidence-backed change at a time, and keep Pomerado’s regular flow. Add diagnostic instrumentation only if an actual failure requires it. A user-set timebox applies to the overall run, not an invented coordinator cutoff for a progressing mint. Vendor source has a 20-minute active-work default, but its effective configuration on this build is unverified; a real vendor deadline is not the same as a coordinator cancellation.
7. **Clean up on every exit.** Preserve private output and logs, stop trial-started processes, restore the HRCEN slot if interrupted, and release the actual advisory-lock holder after browser work ends. Report restored service and lock evidence separately. Do not claim the trial or product passed unless the corresponding acceptance does.

## 5. Proof and safety boundaries

**Trial passes only if:** Pomerado publishes its own reusable integration; each of the three specified confirmation-only calls runs; each matches a complete, independently captured record including accessible sections and repeated controls; the artifact review finds no unacceptable side effect; and interrupted services and the property lock are restored. A missing field or an unverified required reference means incomplete, not pass. Sections inaccessible to the authorized account are recorded as exclusions rather than filled in from assumptions.

The independently verified reference screens matched all three confirmations previously, but captured only partial sections. The existing snapshot helper skips checkbox and radio controls. Thus previous captures help locate the records but do not substitute for the complete answer key.

The owner removed the extra pre-mint process-wide read-only, outbound sandbox and expired role-proof prerequisites in ask 304. Do not restore them via a renamed gate. Still retain read authority, Guardian, the approved private route, the existing lock, source review before replay and cleanup. Guardian is model review, not proof of server-enforced read-only rights or an outbound privacy guarantee. Vendor documentation says generated code is not sandboxed and has the executing user’s file and network access. The owner removed the additional sandbox proof requirement, not the read-only and private-data boundaries.

### Return and alternatives

- **Direct HRCEN read:** tests the actual integration path and keeps all three cases, without making a live reservation write. Its speed and cost advantage are unproven.
- **Public-site smoke:** rejected; it would not answer the owner’s HRCEN question.
- **Labtest booking mint:** closer to the end goal, but may write during authoring and is outside this paused, read-only plan.
- **Existing deterministic tools:** remain a product-delivery alternative and eventual same-task baseline, not a substitute for this requested Pomerado proof.

### Connection to new booking

A passed read proof is evidence that Pomerado can author this lookup, not the end-to-end booking feature. A later, separately directed write trial could ask Pomerado to create one fake Labtest provisional reservation, then read back its confirmation and native status. A write mint can perform its write while authoring, so it must never be run on a real guest under this read-only trial. Continue from there to HRCEN and HRDAV booking completeness, native Add-Ons, pane wiring and staff approval under the existing product rules. None of that is included in this proof or its time estimate.

## 6. Time and cost

**Conditional working midpoint: about 105 minutes after a future authorized start.** This assumes the job can publish after at most one contained diagnosis/retry and the full comparisons reveal no major redesign. It is not a success guarantee or a measured p50. It is not a per-mint deadline or a retry cap. The time is for the complete three-case proof, not full booking or Add-Ons.

| Component on the critical path | Minutes | Basis |
|---|---:|---|
| Reuse setup and acquire the hotel | 5 | Planning allowance; current live readiness is not reverified. |
| First Pomerado mint | 22 | Prior `mint8` ran about 22 minutes but did not publish; new version may differ. |
| Private source review and complete reference capture in parallel | 15 | Planning allowance; prior three-record partial capture was under one minute, but complete capture and review were not timed. |
| Three generated calls and exact comparisons | 25 | Planning allowance; no successful call or full comparison exists. |
| Restore slot and release lock | 5 | Planning allowance. |
| One diagnosis and one retry | 45 | Allowance, not a demonstrated resolution time. The earlier Azure diagnosis was about 12 minutes and the longest noted completed mint about 22 minutes. |
| **Raw chain** | **117** | Add the longer overlapping branch once. |
| **Calibrated working midpoint** | **105** | `117 × 0.88 = 102.96`, rounded to five minutes. The ledger’s `live-hms` median covers 40 mixed historical rows, including incomplete outcomes, so it is weak calibration for this task. |

Repeated login, MCP, Guardian, provider or field-coverage failures can exceed this allowance or prevent completion altogether. No successful full-trial duration is available. Earlier partial trial and mint forecasts closed after 82.28 minutes without a completed proof; they overlapped and are not separate elapsed benchmarks. The earlier 50-minute estimate assumed a successful first mint and lacked timed review/comparison phases; do not repeat it as measured evidence. The forecast is logged under `pomerado-fresh-read-projection-20261027T190509Z-2829282`; its execution clock begins only if the owner later authorizes and starts the run.

Actual Azure costs remain unknown. The earlier incomplete run has about **$10.22 Terra** in recorded illustrative uncached OpenAI Standard list-price estimates, excluding unmeasured Pomerado roles and other usage. This is not an Azure invoice or a forecast for the new run. Luna and coordinator usage were not fully measured. Record actual usage by model where the provider exposes it, and report unknowns rather than guessing. A passed lookup alone does not prove a speed or cost advantage: compare against a measured deterministic baseline for the same task before making that claim.

## 7. Sources and open evidence

- [Owner wording](../context/asks/2026-10-27-pomerado-fresh-plan-owner-voice.md), [trial retrospective](../context/ledger/2026-10-27-pomerado-trial-retro.md), [trial chronology](../research/2026-10-27-pomerado-readstay-test.md), [current source update](../research/2026-10-27-pomerado-main-update.md) and [native MCP source review](../research/2026-10-27-pomerado-native-mcp.md).
- [Prior direct-trial plan](2026-10-27-006-pomerado-read-trial-model-plan.md), subject to the later [owner control decision](../research/2026-10-27-pomerado-review-speed.md).
- Existing reference patterns: `apps/server-pilot/tooling/playwright-quote/quick-search.mjs`, `apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.mjs`, and `apps/server-pilot/src/hms/property-read-lock.ts`.
- [Vendor README](https://github.com/Pomerado/pomerado/blob/7349a1c2/README.md), [how it works](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/how-it-works.md), [agent setup](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/agent-setup.md), and [native MCP tools](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-server.ts). Source cross-check is static; SDK behavior, credential wire format, effective deadline and the updated build’s live behavior remain unverified.
