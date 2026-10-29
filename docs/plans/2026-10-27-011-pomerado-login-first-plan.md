# Pomerado HRCEN login-first plan

Created: 2026-10-27. Owner ask 319. **Planning only; the trial remains paused until owner direction.**

## Goal and decision

Use Pomerado's own native, read-only mint and browser to sign in to the real HRCEN tenant and establish that it reached the expected authenticated hotel. Make that the first, separately reported milestone. This is not a Nava login-helper test, a guest lookup, a product integration, or proof that the original trial has passed. Preserve the selected screenshot booking and all three original comparison cases as later scope. If the screenshot case differs from the original three, it is an additional case. [Original proof scope](2026-10-27-008-pomerado-fast-proof.md).

Pomerado has a native mint, not a documented standalone login-only command. Recommend a tiny useful task: read the signed-in tenant and hotel identity. This tests authentication without adding a confirmation number or guest record as another uncertain variable. A mint can still involve authoring and its normal live tests; it is not guaranteed to finish immediately after login. Publication of this small tool is not the goal or proof of login. Native mint may publish a local artifact as part of its normal operation; source review remains necessary before any subsequent replay.

## Why this differs from the failed runs

- [Latest retro](../context/ledger/2026-10-27-pomerado-run2-retro.md): the first mint ended incomplete; the retry was paused. The retry's first answer omitted a known required field. No native sign-in was verified.
- [Earlier retro](../context/ledger/2026-10-27-pomerado-trial-retro.md): blind retries and coordination errors obscured the actual failure.
- The existing [Nava login helper](../../apps/server-pilot/tooling/playwright-quote/session-reuse.mjs) previously authenticated HRCEN in independent Chromium. It fills the password by name and checks the tenant and property. It is evidence and a diagnostic reference, not a replacement for Pomerado's native login.
- HRCEN's password-named control was observed as HTML type `text`. One Pomerado signed-in safeguard checks password-type controls. That is a compatibility concern, not a proven failure cause. A previous mint already used the text-field hint and still did not publish.

## Execution after a future owner go

1. **Reuse the existing setup.** Use Product EC2's existing isolated Pomerado build, Chromium, approved private Azure route, native MCP server and existing private outcome capture. Do not reinstall or run a public example. Configure the controller and all Pomerado trial model roles for GPT-6 Luna max. The prior run had static settings but no per-call proof; check available configuration and report any actual routing error without a silent fallback or new telemetry gate. Do not rebuild unless the existing model and 30-minute cache settings are reapplied.
2. **Own the hotel.** Acquire the existing shared HRCEN property lock on its actual database connection and keep it alive while the single Pomerado browser actor works. Stop hotel work if the holder is lost. Pause a conflicting HRCEN slot only if needed; restore anything interrupted. No other HRCEN browser actor runs concurrently.
3. **Ask Pomerado to do the real login.** Send a native `mint` with a fresh name, the exact tenant application URL, `effect: read`, and this intent. Do not supply a guest confirmation or pre-authenticate with the Nava helper.

   > Open the supplied HRCEN tenant application URL. Sign in with the supplied credentials. The username control is named `userid` or `username`; the password control is named `password` even though its HTML type is `text`. Click **Sign in**, or press Enter. Return the observed signed-in tenant and hotel identity. Read only: do not create, change, cancel or send anything.

   These field names are factual hints from the existing helper, not a replacement for Pomerado's own sign-in. A similar password hint did not establish a fix on an earlier run. Supply credentials only through the native input request, not inside the intent. Have the configured answer ready privately and answer as soon as the actual question arrives; no human reapproval, screenshot lookup, reinstall, parallel review, extra model call or separate exploratory browser is on the login critical path.
4. **Answer the actual native request.** Retain the original MCP session and job. Use `get_job` and `provide_input` with the returned job ID, request ID and actual question IDs. For the normal credential question, provide username and password plus the mandatory `saveLogin: false`; do not repeat the previous schema error or ask for already-approved credentials again. Adapt only to the actual question presented. Credential answers are visible to the MCP client and its model provider, so use only the previously approved private route and private logging. Credentials, guest information, screenshots, raw logs and generated private source stay under the worktree's `.private/` directory. Input requests expire after ten minutes; completed in-memory jobs expire after fifteen minutes. Do not turn these protocol facts into arbitrary early-stop deadlines.
5. **Separate evidence from assumptions.** Let the native job complete or expose a real failure; do not stop a progressing run at an estimated checkpoint. The native job status can show `running`, `input_required`, `completed` or failure. It does not by itself expose a live authenticated milestone. Inspect the already-ported private outcome capture after the native mint returns; pinned vendor source records authenticated, verified sign-in in execution evidence when its submitted-login and signed-in checks pass. The hook's availability and the actual outcome must be checked during execution, not assumed. Compare an identity observation or screenshot from Pomerado's own authenticated session with the expected tenant and HRCEN property. A visible login page is not an authenticated shell. If the same-session identity evidence is not retained or accessible, report the login/property result as inconclusive rather than inventing a second browser or claiming a pass. No new capture patch is a prerequisite for starting the mint.
6. **Diagnose real failures, not theories.** If an actual error occurs, use the private outcome and relevant existing helper behavior to distinguish field discovery, credential response, submit, authenticated marker and hotel identity. Fix or adjust only the evidenced cause and retry within the approved read-only scope. Guardian remains enabled; decline any request to change the mint to a write. A credential response accepted by MCP is not an HMS login. Do not assume the vendor selector caused failure or that HMS rejected credentials.
7. **Clean up on every exit.** Retain private evidence, stop trial-started processes, restore any interrupted slot, and release the actual advisory-lock holder after browser work ends. Report separately: login evidence, tenant/property evidence, publication status, elapsed time, cost where known, and cleanup. A failed or inconclusive outcome remains failed or inconclusive even if the job status is `completed`.

## Acceptance and later scope

| Observation | Meaning |
|---|---|
| MCP accepted credential answer | Input format accepted; login **not established**. |
| Pomerado authenticated evidence but no same-session HRCEN identity | Sign-in may be established; correct hotel **not established**. |
| Pomerado's own sign-in is verified and same-session evidence confirms expected tenant and HRCEN property | **Login-first milestone passed.** |
| A small integration is published | Separate native build outcome; not the three-case proof. |
| Build incomplete after verified sign-in | Login may pass if same-session hotel evidence also exists; publication did not pass. |

After a successful first milestone, the original selected screenshot and three-case read-stay proof remain outstanding. Establish the screenshot field identity and overlap privately before using it. Review generated source before any replay, then compare output against independently captured references. A go limited to the login-first milestone does not silently authorize additional guest-case work.

## Time and cost

There is **no measured time-to-success**: Pomerado has not yet demonstrated a successful HRCEN sign-in. The prior 35-minute allowance mixed a setup error and retry preparation into a supposedly lean first attempt; it is superseded. For a no-extra-problem **first terminal result and cleanup**, use about **10 minutes as a low-confidence scheduling allowance**, not an ETA for confirmed login: five minutes of unmeasured setup allowance, an earlier correct-tenant mint's four minutes 22 seconds to an incomplete result on an older build, and two minutes 42 seconds from the last incomplete mint's result to reported cleanup. The raw 12.07 minutes × the required mixed `live-hms` ledger median 0.81 is about 9.8 minutes, rounded to 10. This combines different runs, builds and models; the result was not a success, and the calibration includes partial and failed work. The actual login-first mint could finish faster, run longer or fail. Two minutes is an aspiration, not an evidence-backed end-to-end forecast. Neither time is a timeout, retry cap or reason to cancel a progressing job. Check and answer native input promptly; report real status without waiting for the allowance to expire.

The latest run's known GPT-6 Luna **$0.101794** is an illustrative partial list-price calculation, not the Azure invoice or full trial cost. It excludes Pomerado's internal roles and interrupted work. Earlier GPT-6.1 Terra controller and canary estimates totaled **$15.916666**, also incomplete. No measured full cost per successful login exists. [Latest cost limits](../context/ledger/2026-10-27-pomerado-run2-retro.md) · [earlier cost evidence](../research/2026-10-27-pomerado-readstay-test.md).

## Alternatives and risks

- **Reuse the full guest-lookup mint now:** avoids a separate small mint, but mixes the unresolved login issue with guest navigation and the disputed screenshot identifier. Keep it as the later original proof.
- **Run the existing Nava helper instead:** already showed independent login, but does not test Pomerado. Use it as a reference, not the result.
- **Trust the model summary or accepted credential answer:** fastest, but neither establishes the correct authenticated hotel.
- **Privacy and write risk:** read-only intent and Guardian are not a hard process-wide sandbox. Keep the owner's read-only boundary, approved private route, private files, shared lock, write-switch refusal and source review. Do not reintroduce removed sandbox, role-proof, public-smoke or repeat-approval prerequisites.

## Source anchors

- [Native mint and job response, vendor revision 7349a1c2](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-server.ts): native MCP output is narrower than its internal mint result.
- [Sign-in execution evidence](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mint-execution.ts): verified authentication is recorded after the recorder and submitted-login checks.
- [Native credential contract and price limitations](../research/2026-10-27-pomerado-speed-mastra.md).
- [Previous attempts and private capture](../research/2026-10-27-pomerado-readstay-test.md).

**Planning state:** No new mint, browser, trial model call, service interruption, real-guest write, deployment, flag change or mail send was performed for this plan. The last observed restored slots and released lock are historical, not a fresh runtime check.
