# Pomerado read-stay trial retrospective

Date: 2026-10-27. Owner ask 307. Status: **paused; trial failed, vendor suitability unproven**.

## Goal, plan, actual

The owner asked for Pomerado's documented MCP workflow to build and publish a read-only `hms_read_stay` integration for HRCEN. Its only required input was a confirmation number. The acceptance bar was three generated calls independently compared with the exact corresponding expanded HMS screens, including visible values, blanks, controls and repeated rows. A published artifact, useful comparisons, elapsed time and model costs were the deliverable. The broader goal remains complete new booking and native HMS Add-Ons for HRCEN and HRDAV; this trial would inform that work, not complete it.

| Outcome | Evidence |
|---|---|
| Published integration | None |
| Generated calls and full comparisons | None |
| Independent reference | All three exact confirmations opened; two collapsed panels expanded per case. Full tab and field coverage is not established. |
| Trial window | 14:50:55–18:38:41 UTC, 3 h 47 min 46 s through verified pause. Includes planning, owner-directed pauses and interruptions, not continuous execution. The initial timebox was about one hour; later instructions permitted continued attempts and replanning. |
| Latest pause evidence | At 18:38:41 UTC HRCEN and HRDAV slots were active, both guard status files said `RESTORED`, and named trial advisory-lock holders were zero. The guard11 systemd unit was `failed` despite its restoration status; do not conflate the two. This is a timestamped observation, not a current health check. |

Sources: [trial evidence](../../research/2026-10-27-pomerado-readstay-test.md), [owner asks](../OWNER-ASKS.md), [active context](../ACTIVE.md). Raw guest information and logs remain private. No HMS reservation write was authorized or observed.

## What went wrong

| Category | Evidence | Responsibility and limit |
|---|---|---|
| Environment | Started on VPS although HMS was reachable from Product EC2. Isolated Chromium cache was later installed correctly. `--with-deps` upgraded 17 system packages and restarted HRDAV's slot; it was later active. | Our setup and initial machine choice. The broader system changes were not necessary merely to preserve a separate browser cache, but dependency necessity was not individually established. |
| Compatibility | Azure rejected a Pomerado cache breakpoint at 12 hours; an otherwise equivalent 30-minute request succeeded after an isolated package change. | A real provider/package compatibility problem was demonstrated. A request canary does not prove a complete mint. |
| Job interruption | We cancelled a correct-tenant mint at our own early checkpoint, before its terminal result and before the owner's original deadline. | Our mistake. We lost the possibility that this particular run would succeed; we do not know its counterfactual outcome. |
| Prompt and coordination | A later brief contradicted itself about checking the origin before reading the URL. We invented additional pre-mint, process-wide read-only and outbound-sandbox proof requirements and held an approved run. After the owner removed these additions, a controller asked for already-authorized credentials again; a subsequent controller built an alternate MCP client despite the requested workflow. | Our prompt, planning and orchestration mistakes. The contradictory wording's contribution to login failure is unknown. The initial launcher ownership error also cost a retry. |
| Pomerado sign-in and Guardian | Independent Chromium authenticated. Two completed Pomerado mints reported unconfirmed sign-in and correctable Guardian exploration denials. HRCEN's password-named field is a text input, which one Pomerado check does not recognize as a password input. | Observed compatibility and diagnostic signals, not a proven causal chain. There is no evidence establishing that HMS rejected the credentials or even received them. |
| Controller discovery | A controller invoked native Pomerado MCP tools earlier; a later one said tools were unavailable. A non-hotel diagnostic subsequently emitted `get_job`, but its call failed without a structured response. | The blanket claim that Codex could never emit the native call is false. A successful server response, reliable tool exposure and the reason for the later failure remain unproved. This is distinct from the sign-in problem. |
| Missing outcome visibility | The standalone mint response did not expose the internal diagnostics needed to identify Guardian denials. We added private outcome capture to the isolated install. | This produced useful evidence, but came after several incomplete results and has not led to publication. |

The owner's request was clear about real HRCEN, Pomerado-led login, no custom harness, private data and all three comparisons. Different problems occurred over time. Do not assign every delay to the vendor or claim our errors alone explain all failures.

## Estimates and cost

The original one-hour goal was not met. Later estimates were conditional, not proof: the 50-minute working estimate assumed a successful first mint and straightforward full review, neither measured. An earlier 50-minute review-and-comparison block had no measured split; the later reduction was not supported by a completed review or comparison either. One ledger entry for mint/review estimated 25 minutes and closed partial after 82.28 minutes; another for the full trial estimated 65 minutes and closed partial at the same interval. These overlapping partial outcomes are not completed-work benchmarks. We cannot derive a credible new completion ETA from them.

| Model | Known cost evidence | Missing |
|---|---|---|
| GPT-6.1 Terra | Approximately **$10.22**, illustrative uncached OpenAI Standard list-price estimate for recorded setup, canaries and completed controller turns, including later turns. | Actual Azure tier, contract rates and cache treatment; internal Pomerado roles, interrupted usage and any unrecorded calls. This is not an invoice or total trial cost. |
| GPT-6 Luna | Earlier recorded canary estimate was under $0.01. | Complete Luna use, including retrospective synthesis, is not priced from a billing record. |
| Claude Fable 5.1 | No measured coordinator cost available. | Actual session cost. |

The earlier $17.15 gross through mint10 used Fast-rate assumptions and was not a verified invoice. See the [pricing correction](../../research/2026-10-27-pomerado-readstay-test.md) and [model routing research](../../research/2026-10-27-pomerado-model-routing-research.md). These estimates do not establish whether Pomerado is cheaper than the existing approach.

## Decision and counterargument

**Recommendation:** keep live Pomerado work paused. Do not put it on the immediate booking delivery critical path based on this result. If the owner chooses to continue the experiment, keep the original full HRCEN task and three-case comparison intact, not a public-site substitute. If the owner instead prioritizes the existing deterministic booking path, that is a proposed trade, not permission to silently abandon the Pomerado requirement or its native Add-On goal.

**Strongest counterargument:** we have already paid setup costs, independent Chromium reached HRCEN, and one earlier controller did call native MCP tools. A narrowly diagnosed controller or login issue might make Pomerado viable quickly. But neither cause is established, no generated artifact or fair benchmark exists, and product wiring, native HMS semantics, human approval and proof would remain even after a successful mint. Repeated blind live retries cannot establish a speed or cost advantage.

**95 threshold:** not met for a definitive vendor-suitability or return-on-investment verdict. Missing evidence: a successful published artifact, all three full independent comparisons, actual authoring/runtime time and complete model/provider cost, plus a comparable deterministic baseline. The evidence supports a pause now, not a claim that Pomerado cannot work or is intrinsically slow.

An independent Luna retrospective of the existing trial and control reports reached the same outcome-versus-suitability distinction. It reviewed local documents only, not the private primary logs or live system, so it is a cross-check of the synthesis rather than an independent experiment. Its actual model charge is unknown.

## Ranked changes if the owner resumes

1. **Fix the execution handoff, not the goal.** Keep the actual HRCEN task, native MCP client and already-authorized credential handling; record the native tool definitions and terminal job result. Diagnose the tool failure separately from HMS sign-in. Do not create an alternate client or public example.
2. **Run one coherent trial with the original acceptance bar.** Give Pomerado the confirmed tenant and useful flow details, allow a progressing job to reach its terminal result, retain private diagnostics, then review and compare all three records. Use the real property lock and restore interrupted services. Do not reintroduce the assistant-added prerequisites the owner removed in ask 304.
3. **Measure actual critical-path phases and cost.** Separate setup, mint, review, replay and complete independent comparison. Record actual provider usage where available. Do not treat partial reference captures, lower estimates or the presence of a generated artifact as a passed trial.

Ask 304 retained read authority, Guardian, the approved private route, shared property lock, review before replay, private-data boundaries and cleanup. Guardian is not independently proven to enforce all writes, and its presence is not proof of server-enforced read-only access. Do not infer authorization for real-guest writes or email sends. The owner's ask 307 pauses all mint, browser and hotel work until further direction.

Prior retros observed idle orchestration and optimistic estimates that omitted dependencies: [mh1024](2026-10-25-mh1024-retro.md) and [or2 afternoon](2026-10-26-or2-retro-pm.md). The recurring pattern is unsupported optimistic timing and delay between intent and outcome; the precise mechanisms of those earlier runs are not assumed to be identical to this trial.
