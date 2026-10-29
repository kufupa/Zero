# Pomerado model routing research

Created: 2026-10-27

**Scope:** Source and document research only. No model invocation, new mint, browser login, runtime reconfiguration, deployment or live test. Prior trial evidence: [read-stay report](2026-10-27-pomerado-readstay-test.md). Target plan: the complete read-only HRCEN trial, not booking or Add-Ons.

## Official model facts

| Model | Official ID | Documented effort | Official short-context Standard pricing |
|---|---|---|---|
| GPT-6 Luna | `gpt-6-luna` | Includes `max` | $0.10 fresh input, $0.01 cached input, $0.50 output per million |
| GPT-6.1 Terra | `gpt-6.1-terra` | Includes `xhigh` and `max` | $1.00 fresh input, $0.05 cached input, $5.00 output per million |

Sources: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [pricing](https://developers.openai.com/api/docs/pricing). `max` is a reasoning effort, not a separate Luna model. These are OpenAI list prices, not the Azure invoice or contract. Long-context, cache-write, regional and service-tier terms can change cost. Higher effort may spend more and run slower; no same-task Luna-versus-Terra trial has been performed.

[Microsoft Azure's Luna announcement](https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/) separately publishes the same Luna short-context Global Standard fresh-input, cache-hit and output rates, with a separate cache-write charge and different regional rates. This does not identify the actual Azure deployment, contract or bill. A first-party numerical Azure Terra price was not verified here.

Both model pages say to use the Responses API for function calling with the proposed reasoning settings. Microsoft lists both models in its [Azure Responses documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses); that does not prove this Azure account has both deployments, accepts the desired effort, or routes every Pomerado role correctly. Verify that with non-sensitive evidence after approval.

## Pomerado mechanics and limitations

- [Setup guide](https://raw.githubusercontent.com/Pomerado/pomerado/main/docs/agent-setup.md): the local MCP server exposes `mint`, `get_job`, `provide_input`, and `cancel_job`. Its public read example was suggested as a setup smoke, but the owner rejected that extra step; the next example must be the actual HRCEN task.
- [Pinned package README](https://unpkg.com/pomerado@0.4.0-canary.399/README.md): the minter explores and authors, Guardian reviews, and a generated local integration runs deterministically without its own model call. A controller can still cost money. A successful job status is not itself a successful published build.
- Local source shows Nava's `installReadOnlyGuard` applies to the Playwright context to which it is explicitly attached in `apps/server-pilot/tooling/playwright-quote/stay-lookup.mjs`. The Pomerado standalone browser is separate. The reference screen's guard is not proof the Pomerado browser inherited it. The local package documentation says generated runs do not enforce mint-time authority; inspect an artifact before use and establish the actual read-only controls without assuming the account's `view_only` label proves enforcement.
- Pomerado Cloud docs describe a `force_sign_in` option. They do not establish that the installed local `.399` MCP server supports the same option. Do not assume cloud parameters, managed login pages, automatic repair or hosting apply to the self-hosted trial.
- Current upstream [architecture guide](https://github.com/Pomerado/pomerado/blob/main/docs/how-it-works.md) says a signed-in read is judged on its single example rather than an automatically designed multi-case test set. This strengthens the need for our independent three-case comparison, but the guide is for current `main`; confirm `.399` behavior before asserting it applies to the installed package.
- Upstream [architecture](https://github.com/Pomerado/pomerado/blob/main/docs/how-it-works.md) says some live examples and tests reset to the site root. The HRCEN tenant has a specific login URL and the prior host root returned 404. This is a plausible testable concern, not proof that the latest failed mint hit that issue. Current upstream docs may differ from `.399`; inspect that version before using this claim operationally.
- An [open model backend proposal](https://github.com/Pomerado/pomerado/issues/513) describes separate minter, Guardian and outcome-review provider hooks but says their requests use OpenAI Responses shapes. This is not evidence that Azure caused our Guardian denials and is not a reason to change providers or install another backend.

## Independent comparison at the proposed efforts

[Artificial Analysis](https://artificialanalysis.ai/models/comparisons/gpt-6-1-terra-xhigh-vs-gpt-6-luna) reports the following for Terra xhigh and Luna max, respectively. These are independent benchmark results, not measurements of Pomerado or HMS. Pomerado-specific confidence intervals were not established here.

| Comparison | Terra xhigh | Luna max | Relevance and limits |
|---|---:|---:|---|
| Terminal-Bench 4.0 | 46% | 13% | Agentic terminal tasks; 66 tasks, three repeats; directional support for Terra as the authoring minter. |
| AutomationBench-AA | 60% | 53% | Mean objective completion on 657 simulated REST API workflows, with zero credit for any task with a guardrail violation. Not a complete-task success rate or the actual HMS screens. |
| SciCode | 53% | 55% | Luna can be competitive on other coding tasks; do not treat one benchmark as a universal ranking. |
| Weighted Intelligence Index cost per task | $0.19 | $0.07 | Different benchmark workload and public pricing; not a Pomerado price. |

[Terminal-Bench methodology](https://artificialanalysis.ai/evaluations/terminalbench-4-0) uses pass-at-one averaged over three runs per task. [AutomationBench methodology](https://artificialanalysis.ai/evaluations/automationbench-aa) measures average objective completion in simulated API environments, not the fraction of entire workflows completed. The publisher's measured output rate is higher for Luna, but its weighted task time includes substantially different reasoning behavior and does not predict this trial. Higher max reasoning can add delay. No result here demonstrates lower Guardian false-denial rates, a successful Pomerado login, or lower cost per successful HMS mint.

## Trial evidence and model comparison

- Recent private outcomes show correctable Guardian refusals of broad exploration and unconfirmed sign-in. Whether HMS received credentials and why the steps were proposed remain unknown. The latest actual task included a contradictory URL-check instruction, so changing the instruction and model together cannot isolate which changed the result.
- Recommend Terra xhigh for all roles, including the outer controller, for the first recovery trial. It preserves the prior model family while the contradictory prompt is removed, avoiding an added model-switch variable. Independent agentic coding and workflow benchmarks favor Terra for the difficult authoring step, but do not measure Pomerado. Luna as outer controller, or the owner’s Luna-minter/Terra-review split, remains a reasonable lower-list-price alternative. Neither routing is a proven winner on this task; compare successful publication, verified field correctness, elapsed time and total cost.
- The earlier Terra estimate of $17.147336 used OpenAI short-context Fast rates without proving the actual tier. At illustrative short-context Standard rates, applying half those historical gross charges gives $8.573668 before cache adjustments. Neither number is an invoice or total: Azure terms, cache writes, long-context rates, interrupted usage and Pomerado's internal usage remain unverified.

## Installed-role audit, read-only

A read-only audit of the isolated `0.4.0-canary.399` installation and private controller configuration reported the following. No model call, mint, HMS connection or edit was made by that audit.

| Role | Reported configuration | Evidence limit |
|---|---|---|
| Outer MCP controller | Azure Responses, `gpt-6.1-terra`, xhigh | Configuration is not a per-response model or effort receipt. |
| Internal minter | Large-model setting patched to Terra; standalone mint host passes xhigh | Per-call model ID, effort, service tier and usage were not retained. |
| Guardian | Small-model setting patched to Terra, xhigh configured | Some reviews can override effort; effective per-review settings are unproved. |
| Outcome reviewer | Small-model setting patched to Terra, xhigh configured | No retained evidence establishes that this role ran during the read-only attempts. |

The controller and Pomerado default provider point to the same Azure OpenAI host and Responses path. The normal local MCP host does not pass separate role-specific providers. The installed package couples Guardian and outcome reviewer to the small-model setting; separating them would require additional isolated source changes. Seven inspected installed files differed by hash from the vendor `.399` tarball. A private cache-compatibility backup covers three files, not every model or effort file. The vendor tarball is the source for original files without a private backup.

SDK tracing was disabled and the retained MCP output omitted internal model runtime records. Per-role usage, actual Azure service tier and invoice remain unknown. Earlier direct Azure canaries returned for Terra xhigh and Luna medium, not Luna max; these are not evidence of a successful Pomerado mint.
