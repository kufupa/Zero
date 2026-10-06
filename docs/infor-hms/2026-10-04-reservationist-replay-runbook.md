# Reservationist replay operator runbook

Run from the Zero checkout. The commands below default to local replay, never live PMS. Existing [dashboard operations guidance](dashboard-tools-pilot-runbook.md) remains authoritative for borrowed browser ownership. No reservation create/save/update/cancel, payment mutation, email sending, deployment, migration or production test database access is authorized.

## Safe first run: executed 2026-10-04

```bash
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts --help
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts plan
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec vitest run tests/reservationist-run-provenance.test.ts tests/reservationist-replay.test.ts tests/reservationist-runner-contract.test.ts
```

Preflight prints aggregates only: 846 inbound cases, 172 paired, 674 no gold, zero fixtures; `qualificationEligible: false`, `costEstimateAvailable: false`. It displays operator defaults of eight hours/USD25, 45-minute case and 15-minute native deadlines, eight model turns, 24 tool calls and at most two additional transient retries. The eight-hour/USD25 ceiling was explicitly authorized for this task; deadlines and per-case limits are implementation bounds. The initial paid cap began on 2026-10-04 for generated synthetic PDFs only. Seven inference calls returned token usage (12,238 input / 38,030 output; conservative USD0.0378984 estimate). An additional schema-validation response returned no usage, so the run checkpointed with unknown spend and stopped paid continuation. These failures remain private; they do not qualify authentic source or holdout completion.

Private inputs live under `.private/reservationist-backtest/corpus/`. Preserve the original corpus and older thread reports. Replay fixtures must bind exact request hash/property/original source observation/tool version. No gold-derived fixture construction is allowed. Missing contemporaneous evidence is unavailable coverage, not success or a model failure. Current-reader and synthetic observations cannot qualify reconstructed historical state.

## Implemented commands and outputs

Safe preflight and the no-resolver current-read run described below were executed. Default deterministic fixture mode has no paid adapter and fails before transport; authoritative execution needs independently approved source records and a configured, budgeted shared factory.

```bash
# New development replay; refuses absent cost evidence and does not install a paid factory.
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts run --phase a --mode replay --run-id development-20261004
# Compatible unfinished checkpoint only; preserves failed attempts.
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts run --phase a --mode replay --run-id development-20261004 --resume
# Local deterministic scoring of compatible first-attempt traces.
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts score --run-id development-20261004
# Reports unavailable review rows unless a trusted budgeted reviewer is supplied programmatically.
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx scripts/run-reservationist-backtest.ts review --run-id development-20261004
```

The programmatic `runReservationistReview` uses the admitted judge route, bounded input/output/cost and abortable calls. It keeps workflow, money, artifact, extraction and style verdicts separate and preserves deterministic failures. The CLI has no installed paid reviewer; unavailable rows retain all declared cases.

`--phase b` declares every inbound. `--dry-tools` and export are rejected. Current-read uses a separate manifest and score command; its results never establish historical price truth. New output directory collisions require a new ID; traversal IDs are refused. `--resume` checks exact manifest, corpus, fixture, cost, split, prompt/model/tool/scorer versions. `manifest.json`, append-only `attempts.jsonl` and `traces.jsonl`, `coverage.jsonl`, `checkpoint.json`, `l1.jsonl` and `summary.json` remain private. First-attempt scores are never replaced by best-of retries; all-three consistency has its own denominator.

The separate current-read runner calls the same execution factory against independently admitted current sources. `run --phase a|b --mode current-read` and `score --mode current-read --run-id X` keep original causal messages, current source time, each failed or unavailable case, and first-attempt versus three-attempt consistency separate. An explicit trusted installed resolver is required for source/model actions. With no resolver, every declared case is reported unavailable and no source/model call starts. Synthetic current-read results never qualify historical or authentic completion. Resolver release, source provenance, exact requested room/read scope, finite reserves and reported cost must validate before qualification.

The final local no-resolver check used run ID `current-read-unavailable-20261004-handoff` with `--phase b --mode current-read`, explicitly removing `RESERVATIONIST_CURRENT_READ_RESOLVER`. It declared 846 cases, including 155 predeclared repeat cases, and recorded 1,156 unavailable attempts, zero passes and USD0. No source/model action began. This verifies denominator preservation and unavailable-source containment; it does not establish authentic current-reader or historical qualification. Implementation changes invalidate old run manifests, so start a new ID after a code change rather than overwrite a prior report.

The operator supplies a private `azure-cost-estimate.json` with `version`, positive `inputUsdPerMillion`, `outputUsdPerMillion`, and conservative `caseReserveUsd` below 25. These are a dated Azure provider estimate, never legacy Bedrock pricing. The original rule required stopping paid work on unknown usage. The authorized recovery rule below supersedes that rule for requests with validated finite reservations. Credential variable names are `AZURE_OPENAI_BASE_URL` and `AZURE_FOUNDRY_API_KEY`; do not print values or place them in Git. The shared factory enforces abort signals and model/tool call caps. The admitted text adapter also enforces input/output and reserve bounds. PDF admission now requires an explicit source/version/hash/time-bound provider ceiling: Azure GPT-6 Luna accepts at most 922,000 processed input tokens. Reserve the full input ceiling plus configured output ceiling for every allowed call, independently cap request bytes, and validate actual usage/protocol afterward. Missing or mutated quota still refuses PDF transport. A file byte count never estimates PDF tokens. The explicit Azure adapter owns its SDK endpoint, requires complete responses and reported usage, and retains store:false/max reasoning. No route, source grant, release, quota or factory is installed by default.

## Three recoveries

1. `missing_cost_estimate` or missing fixture/assertion coverage: obtain approved independent provenance privately, validate versions and preflight again. Never fill from gold or fabricate successful tools.
2. `Incompatible or legacy manifest` / collision: preserve the existing report. Start a new run ID after freezing a new manifest. Do not overwrite or mix old scores.
3. `checkpoint_budget_exhausted`, timeout, auth or permission failure: inspect the private ledger. Exhaustion is incomplete. Existing CLI does not automatically retry; transient-only retry helper permits at most two additional attempts, while auth/permission/business-invalid/missing fixture never retry. Budget renewal requires explicit operator authorization and a newly frozen run/cap; elapsed/failed costs remain visible.

All current corpus cases are conservatively development because prior inspection is not independently tracked. No untouched holdout or three-fresh-attempt qualification is claimed. Freeze duplicate conversation/business case groups and copy/clause versions before a genuinely untouched holdout. Report missing/unadjudicated/unprocessed cases and per-family denominators; none inherit pooled qualification.

## Provider evidence and synthetic checkpoint

The official [Microsoft reasoning model limits](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) publish the GPT-6 Luna input ceiling. The Azure pricing page links to the [Microsoft launch pricing table](https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/). The synthetic diagnostic reserved the maximum published Standard EU long-context cache-write/input rate USD0.30 and output rate USD0.90 per million as conservative estimates across Standard tiers; these are not invoice charges or a deployment policy. The configured host Responses endpoint lists exact Luna, while its input-token counting endpoint rejects this model. Published maximum accepted processed input provides the conservative alternative.

Actual synthetic calls exposed incomplete reasoning-only output, a loose model-facing schema, and a provider-incompatible fixed-region tuple. Every failed attempt and usage record remains visible. The initial USD25 cap remains unchanged. The authorized recovery below replaces the old unknown-usage rule; its paid continuation window has now expired. Local SDK tests prove physical file transport, complete-response rejection and budget containment; they cannot establish authentic PDF/scan accuracy or untouched-holdout qualification.


## Authorized recovery and current checkpoint — 2026-10-05

This section supersedes the original unknown-usage paid blocker above; the original record is retained for provenance. A dispatched request failing without usage keeps actual usage and cost unknown, and debits its full validated finite per-request maximum. All earlier failed attempts and unresolved/unused held reservations count toward the same cumulative USD25 cap. Absent a defensible finite maximum, refuse dispatch. No billing-access prerequisite is imposed when this conservative accounting is valid.

The approved continuation ran2026-10-04T22:08:43.575659Z–2026-10-05T06:08:43.575659Z. It has expired. Conservative cumulative accounting is USD5.854539 with413 entries:406 provider-reported,3 failed-unknown and4 retained full-maximum unused reservations. Invoice cost remains unknown. Do not renew descriptors/timestamps to enable more paid calls; a new paid window requires explicit authorization and never increases the cumulative cap automatically. Safe local/disposable implementation and authorized read-only discovery continue independently.

The actual installed CLI lane is `causal-local`, selected with `RESERVATIONIST_LOCAL_EVALUATION_ADAPTER`: a private JSON descriptor containing an absolute module path and a truthful user-authorized local evaluation release. Module and release identity must match; exact owner/thread/property/causal source/attachments and execution guards still apply. `RESERVATIONIST_EXPOSURE_MANIFEST` supplies frozen recorded development exposure. No tenant policy or production release is implied. The private paid adapter separately enforces its finite reserve and expired paid window. The final development descriptor is now expired and must not be rerun as paid work.

The following recipe was actually executed before expiry. It is a historical command receipt, not an instruction to dispatch now:

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx ../../.private/reservationist-recovery-20261004/launch-development-final-v35.mts development-final-v35
```

Its private installed module composes acquired original attachments, the actual Azure adapter, existing execution factory, code-owned reply rendering, applicable current recipient services and independent evaluation. Expectations are parsed only after execution; future outbound messages/attachments never enter execution. Preserve the original adapter, sealed inputs, all raw responses and terminal manifest even after fixing failures. A local unpaid replay of frozen actual extracted plans may verify new downstream wiring; label it replay, never fresh model qualification.

Actual byte acquisition obtained158 causal descriptor occurrences:25 original development,8 expanded development and125 provisional blind, with owner/message/thread/time/S3/hash binding and zero acquisition failures. Unsupported/encrypted/malformed/CID dispositions remain explicit. Independent standard AI reviewers adjudicated13 real development cases/28 obligations; their provenance and disagreements are private, and are not human approval. Final development35 actually executed26 model requests:11/13 response-complete,26/28 response obligations,0 source-work completion. A separate repaired two-case run scored2/2 responses and5/5 obligations after4 real requests; it never replaces the13-case parent score.

A separately frozen provisional blind run actually executed8 cases/16 requests:4/8 responses,4/15 response obligations and0 work. All142 frozen source/harness hashes matched through terminal. Complete historical actor exposure is unavailable, so this is provisional blind evidence and verified untouched holdout is unavailable. No heldout content/gold enters the implementation/tuning loop. A separate evaluator-only review inspected all original failures: three pre-runtime source/fact validation rejects and one runtime obligation-coverage nonpass, with no identified unauthorized effects. Its private case diagnostics are isolated from editors. Postblind local fixes cannot inherit qualification from that original run. Three fresh stratified repeat attempts and both95% eligible end-to-end targets remain unmet.

Keep lanes separate: causal selection/extraction/reply, deterministic exact cents/dates/quantity/selection and actual PDF, fresh current read-only results, historical state/price only with contemporaneous evidence, and frozen development versus verified untouched holdout. Current read no-match supplies no reservation/ledger facts; missing historical assertions remain unavailable with their coverage, never passes. Source-only tasks require no unrelated PMS fixture. No save/send/hold/payment/production draft/deployment/migration/restart/bucket mutation is enabled.


Current reservation integration now also installs a private capture-backed service through the existing factory and `executeRead`. A source-owned receipt binds a text-verified original customer reference/task/scope to a canonical facade-issued opaque handle, genuine capture/row/audit/trace hashes, independent authorization and explicit freshness. Original customer facts remain unchanged. Both dispatch and promotion require that receipt for opaque targets, including when optional fact markers are removed; current status/date facts must match the retained typed read result. Payment joins remain separate and strict. The actual v7 read returned no match; three unpaid downstream lookups using its authentic captured result yielded only unverified-negative clarifications, no handle/facts/packets/artifacts. Positive status/date controls are synthetic. The capture expired2026-10-05T06:23:53.882Z and cannot be readmitted as fresh by changing clocks.

Source-only customer arrival acknowledgements now survive worker/storage/promotion without unrelated HMS evidence, retaining exact causal task/time/hash/owner/thread/property and customer_claim/hotelPermission unverified. Live source rederivation, attachment hashes, worker result seal, current thread state and all existing financial/native/read/document/pending/recipient exclusions remain mandatory. This local integration change does not regrade prior model runs or qualify the postblind source using the old blind result.
