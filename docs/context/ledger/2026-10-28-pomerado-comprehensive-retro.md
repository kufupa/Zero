# Pomerado testing retrospective

**Outcome: the requested Pomerado booking-read proof did not pass.** Codex reached self-hosted Pomerado, the existing login helper returned after its own checks, and diagnostics improved. No exact selected booking, published integration, fresh replay, or independent field comparison was verified. The reasons for the failed mints remain unproved. This is not proof that Pomerado cannot work or is intrinsically slow.

**Scope:** The testing history from the 2026-10-27 retrospectives through the 2026-10-28 06:00 UK run close, plus the subsequent stop-hook loop and owner interruption. This synthesis uses existing reports and a bounded independent comparison, not a new live run. [Original trial retro](2026-10-27-pomerado-trial-retro.md) · [login-first retro](2026-10-27-pomerado-login-first-retro.md) · [06:00 closeout](2026-10-28-pomerado-run-close-retro.md) · [native trial evidence](../../research/2026-10-28-pomerado-native-codex-trial.md).

## Goal, plan, actual

The owner wanted Pomerado working with Codex and the actual Centurion HMS, not a public example. The approved self-hosted proof was native login first, existing login helper as a labelled fallback, then an exact prior booking read, a generated and reviewed tool, fresh replay, and comparison against the same reference. The original three-case comparison remained later scope. Reads only; Guardian, privacy, the real property lock, and cleanup remained.

| Stage | Actual result | What it proves |
|---|---|---|
| Environment and connectivity | Native Codex called the self-hosted MCP on Product EC2. | Connectivity, not a booking read. Earlier work initially chose the wrong machine and made avoidable system changes. |
| Native sign-in | A native mint ended incomplete and reported difficulty safely filling a text-type password control. | The reported difficulty, not that HMS rejected credentials or that the control caused every failure. |
| Existing login fallback | The helper returned after same-browser readiness and origin checks. An earlier isolated login checkpoint succeeded. | Useful baseline, not proof that later native auth tracking, property identity, and the session stayed valid. |
| Exploration | Some captured observations contained a Stay 360 anchor or wording. The latest complete observation lacked the selected confirmation token. | The wording was present, not that the screen or the booking opened. |
| Publication and replay | Earlier jobs ended `build: incomplete`. The final deadline-stopped job had no captured terminal build outcome. | Neither a published integration nor fresh replay is established. |
| Cleanup | The final independent audit found owned control groups empty, one-use credentials absent, and no named guard sessions or granted locks. | Scoped cleanup passed. This is not a current check of unrelated services. |

The full three-case comparison, publication and fresh replay remain open. The selected reference and identifier exist, but inputting an identifier is not evidence that the mint found it.

## What went wrong, and ownership

| Area | Evidence | Assessment |
|---|---|---|
| **Coordinator: wrong setup and extra work** | The first retro records the initial VPS choice, package changes and an HRDAV slot restart. It also records an assistant-cancelled mint before terminal output. | Our setup and premature cancellation. The cancellation lost a possible result, not a proven success. The HRDAV restriction came later and was respected in the subsequent Centurion-only goal. |
| **Coordinator: invented restrictions** | We added process-wide proof gates that the owner later removed. In a later fallback we added a no-credential restriction that the owner had not requested. | Those were our additions, not missing owner instructions. The later restriction's causal effect is unknown; a corrected retry also ended incomplete. |
| **Coordinator: known handoff missed** | A retry's first credential answer omitted a documented required boolean. It succeeded at the MCP-input level after correction. | Our handoff missed an existing contract; accepted input does not prove HMS accepted login. |
| **Coordinator: diagnostics arrived late** | Prior retros recommended capturing actual failed execution details. In diag3 our clean executor stripped the diagnostic destination, preventing intended capture. | This is a verified instrumentation defect, not the root cause of the failed mint. Later runs captured observations and errors. [Forwarding lesson](../../solutions/runtime-errors/clean-executor-diagnostic-environment-forwarding.md). |
| **Coordinator: privacy scope** | A watcher scanned process environments too broadly for the Centurion-only restriction. It was stopped and replaced by a scoped check. | Our scope mistake. No other hotel's process was stopped by this lane. |
| **Model and tool behavior** | Captured failures included a JavaScript execution-context error, navigation-context destruction, Guardian denials and a later `OperationFailure`. | Real signals, but their attempted actions and causal impact are not fully established. Do not blame all failures on Pomerado or Guardian. |
| **Orchestration after deadline** | Session metadata shows 11 stop-hook feedback events between 06:02:40 and 06:04:41 UTC after the unmet-goal close. The assistant repeatedly reported the same stopped state. | Loop wasted attention. Internal hook cause is unproved. The later time gap is not proven active loop time. |
| **Owner inputs** | The owner supplied the real task, preferred setup, boundaries, and later removed the extra preconditions. | No owner decision gap caused the evidence shortage. Native authoring was more involved than direct manual login, but that does not excuse the failed proof. |

Earlier cloud testing happened before the later self-hosted-only goal. The later goal did not authorize Pomerado Cloud or Da Vinci.

## Repeat failures and what improved

| Earlier instruction | Later outcome |
|---|---|
| Capture per-operation errors before another blind retry. | Followed late and only partly. Diag3 lost intended diagnostics; subsequent runs captured errors, but the final attempt had no terminal result. |
| Verify actual authenticated property, screen, and booking. | Not met. A helper return, generated script, menu label, and identifier in input were all weaker than the requested proof. |
| Keep the native flow and remove assistant-added prerequisites. | The original extra gates were removed. A different unrequested credential restriction later appeared, then was removed. |
| Measure complete authoring, review, replay and comparison. | Partial measurements exist. No successful full-path duration or complete Azure cost was captured. |

The retrospectives identified these issues before the final run, but recommendations were not consistently converted into the next attempt's actual setup. The plan correctly preserved the real task, independent reference and safety boundaries. It underweighted observability and native-versus-helper authentication, while an assistant-added per-action stop reviewer introduced non-native overhead for an earlier checkpoint. That reviewer's impact on overall elapsed time was not measured.

## Time and cost

| Measurement | Estimate or cost | Observed result and limitation |
|---|---:|---|
| Isolated helper login checkpoint | 12 min estimate | 86 sec to cleanup. Login only, not a complete mint or replay. |
| Native login-first result | 10 min scenario | 24 min 44 sec to failed cleanup. Not time to successful login. |
| Earlier mint and review | 25 min estimate | 82.28 min to a partial, paused result with no publication. Not a success benchmark. |
| GPT-6.1 Terra, earlier recorded turns | ~$10.22 | Illustrative uncached OpenAI Standard list-price estimate, not an Azure bill or total. |
| GPT-6 Luna, a separate earlier run | $0.101794 | Illustrative list-price estimate for recorded completed turns only, not a total or Azure bill. |
| Public-only Exa Agent | $0.5001 | Reported research charge. |
| Azure trial models, Fable coordinator and review subagent | Unknown | No complete model usage or billing records; the historical estimates may overlap and must not be added as a total. |

No defensible ETA for a successful full proof exists. Four older Pomerado-related ETA entries lacked verified close times; no actuals were invented.

## Ranked improvements

1. **Observe the actual failing operation first.** Use retained private receipts to compare the native authentication sequence and the helper's verified path. Record the exact result and first failed action. Treat the native auth-tracker mismatch, text-type password field, Guardian decisions and page-context errors as hypotheses until evidence distinguishes them.
2. **Make the next attempt one coherent experiment.** Retain the owner's native/self-hosted, read-only task and real property lock. Give the known input schema and existing flow context, change only what the captured evidence supports, and allow a progressing job to reach its terminal result within the applicable authorized window. Review any artifact and replay the same booking. Do not add removed gates or downgrade the three-case goal. Guardian is model review, not independently proven complete technical write protection.
3. **Measure real stages and terminal handling.** Track setup, mint, source review, replay, field comparison and provider spend separately. A failed, paused or login-only result is not a full-proof benchmark. For future timed autonomous goals, design and test a terminal failure/cleanup outcome so an expired window does not cause repeated stop feedback; no hook change is made by this retrospective.

**Decision assessment:** Keep the existing deterministic HMS path as the product baseline. Do not make Pomerado a booking-delivery dependency until an apples-to-apples read and replay passes. That is an evidence-based sequencing recommendation, not a claim that Pomerado is unsuitable or permission to drop the requested proof.

## Extension and hold

At 08:37:41 UK the owner selected a one-hour extension with the existing read-only, Guardian, privacy and lock boundaries. At 08:38:10 UK the owner interrupted for this retrospective. A conservative wall-clock interpretation ends at about 09:37:41 UK; whether retrospective time pauses that window was not stated. No new mint or hotel browser trial was launched after the selection. [Owner ask](../OWNER-ASKS.md) · [active context](../ACTIVE.md).

## Correction after the retrospective

After this retro, the assistant wrongly resumed a Centurion mint after the HRDAV coordinator reported the deploy gap clear. The coordinator's report was not an owner request to resume. The owner corrected this: “no don't continue i said retro it”. The assistant stopped only the owned trial and guard. SSM reported the guard `failed` with `Result=exit-code`, the trial inactive and both owned control groups empty. A separate SSM Success/0 audit verified both one-use credentials absent, zero named guard sessions and zero granted named advisory locks. Post-stop private classification found no recorded terminal build outcome and two complete observations without the selected confirmation. Neither observation proves booking access. Both session cron jobs were canceled and the trial monitor stopped. No more live Pomerado or hotel browser work without new owner direction.
