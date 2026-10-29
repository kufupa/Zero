# Pomerado artifact review options

Created: 2026-10-27

Scope: planning and public documentation only. No Greptile review, model invocation, generated artifact, guest data or HMS access occurred.

## Findings

- The installed Greptile CLI identifies itself as version 3.7.0. Its local `review --help` states that review uses committed changes from the merge base through HEAD and excludes uncommitted and binary changes. The local CLI accepts `--apex`.
- The [official Greptile CLI documentation](https://www.greptile.com/docs/code-review/greptile-cli) likewise says the CLI reviews committed branch changes, not uncommitted files. It says CLI reviews default to Base unless the tier flag is passed; `--apex` may fail if the organization does not have the tier enabled. Availability for this account was not tested.
- [Greptile's MCP documentation](https://www.greptile.com/docs/mcp-v2/tools) describes a PR review trigger and retrieval of existing reviews. This check did not establish a supported arbitrary private-file review path.
- A normal CLI review sends eligible committed changes to Greptile. Its documented sensitive-file filter is not proof that guest data or every credential would be detected. Never bypass that filter for this trial. The generated artifact may contain private data or credentials and is not available yet for inspection.
- The owner has not requested a commit or authorized disclosure of private data to Greptile. Do not commit the generated artifact or send it to Greptile as a shortcut. The suggestion to use Greptile or an equivalent does not waive the private-data boundary.
- For this isolated trial, a bounded private source review using the already-approved Azure/Terra route can start as soon as the artifact exists. Exclude credentials and unnecessary guest data. An operator still checks the code and runtime boundary before invocation. This is not an Apex review and does not prove either safety or field correctness by itself.
- If sanitized, non-private integration code is later committed as product work, the usual Apex review can apply to that real diff. The trial does not require creating a PR or commit merely to make a review tool eligible.
- Source review and independent screen capture can run in parallel after minting. Only the screen capture owns the hotel browser; the source reviewer uses saved source and does not access that browser. An Azure model review still uses the network. Do not run generated calls until the safety review and runtime read-only checks pass. All three generated calls and independent exact-record comparisons remain required.

## Open evidence

Artifact size, actual review duration, complete screen inventory time and end-to-end success time are unknown. Earlier independent snapshots match the requested records but do not establish complete displayed-field coverage. This research did not measure Greptile or Azure reviewer latency, or prove the current account's effective HMS permissions.

## Actual prompt and timing evidence

A read-only comparison of the actual intents in the private Product EC2 logs found the core read-only confirmation lookup, expanded Record View and repeated-row task in mint7, mint9 and mint10. Mint9 already included the password-named control's text-input detail. Mint10 already included tab restrictions and exact-match language, plus the contradictory origin/URL instruction. The full intents remain private in `.private/pomerado-readstay/mint7.jsonl`, `mint9.jsonl` and `mint10.jsonl`; no credential or guest value belongs in this report. These observations do not prove why sign-in was unconfirmed or whether HMS received credentials.

The earlier plan allocated 35 raw minutes to three calls and comparisons. The later 50-minute block added artifact review but did not record a measured split or explain the increase. The active reference run was observed at 17:05:08 UTC and finished at 17:06:01 UTC. It located three exact confirmations and expanded two panels per case. Those are partial captures, not a timed complete independent comparison. The timestamped session records are lines 5681 and 5744 of the private session transcript. No generated artifact, generated call or full field comparison has completed, so none has a measured success time.

The current source in `apps/server-pilot/tooling/playwright-quote/quick-search.mjs` treats arrival as a date-window hint and identifies the reservation by exact confirmation. `apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.mjs` skips checkbox and radio inputs, so its existing inventory alone cannot prove complete displayed-control coverage.

## Targeted plan review

Feasibility and security reviews identified missing explicit redaction, full-process read-only and private-data coverage, and lock-holder continuity. The plan now calls for verification of these boundaries, credential and unnecessary guest-data redaction before model review, restrictive private storage and the existing production PostgreSQL property lock throughout browser phases. No runtime control was checked or changed by the review. The 50-minute estimate assumes those controls are already verifiable; it does not include installing a new enforcement mechanism.

The original operation accepts a confirmation number as its only required input. Date hints may help authoring or independent reference capture, but requiring a date hint at runtime or hard-coding the examples fails the trial's confirmation-only acceptance.

## Control review requested by owner

Ask 303 requests a control-by-control assessment, not an automatic waiver. The assistant added the plan's requirement to verify process-wide read-only enforcement and outbound destination confinement during its own document-review pass. The owner approved the plan afterward, but did not originally ask for those exact mechanisms. Earlier Pomerado trials proceeded without proof of those added controls; that does not demonstrate those trials were risk-free. The earlier role-proof files belong to a separate Nava runtime and are expired, not automatically a Pomerado prerequisite.

Recommendations for owner decision: remove the added pre-mint requirement for an unexpired role-proof and process-wide outbound sandbox; do not change unrelated proof files. Preserve the original no-real-guest-write objective, `read` mint authority, Guardian, existing private handling and approved Azure route, one shared HRCEN property lock, and restoration of any interrupted service. Review generated source before replay; retain all three independent comparisons as trial acceptance rather than pre-mint gates. Drop the separate public smoke, blanket service interruption, repeated approval and invented early mint cutoff. Allow optional date hints for investigation, reporting a required hint as a limitation against the original confirmation-only goal.

Risk remains: Pomerado executes code during mint; Guardian is model review, not independently proven complete technical write protection. The pinned package README says generated runs do not check authority, and website scripts may transmit typed data beyond the form destination. Removing extra preconditions does not make those risks zero. Recommendations are not an owner approval and do not authorize a mint, modify policy, or alter existing enforcement.

**Ask 304 decision:** The owner approved the recommended removals and the direct trial. The preceding control assessment records the historical recommendation, not a continuing approval hold.
