---
title: "Stagehand-assisted folio completion"
type: feat
date: 2026-09-16
deepened: 2026-09-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-directed-read-tool-takeover
execution: code
origin: docs/superpowers/plans/2026-09-15-centurion-read-tools-leftovers-to-yes.md
---

# Stagehand-assisted folio completion

## Goal Capsule

Finish **hms_read_folio**, including deposit facts, to its full existing business contract. Preserve verified balances, All Folios transactions, reservation identity and notes/traces. Stagehand assists development; delivered tools remain deterministic and model-free.

**Current authorization, 2026-09-17:** the user permits read-only access to **every PMS screen**, including Account / Advance Deposit / Deposit Schedule. This supersedes the inherited blanket ban on the Advance Deposit screen, not any mutation ban. Explore only screens relevant to the folio goal. Do not change hotel permissions or pretend an internal policy block is a PMS role denial.

**This revision is a plan, not a completion report.** Resume execution when the user launches the revised goal. The previous goal remains incomplete; its overnight evidence is a baseline, not work to repeat wholesale.

**Fixed choices:** existing Stagehand 4.1.0 bridge; approved Azure GPT-6 Astra/high for discovery; GPT-5.6 Luna with reasoning effort max for implementation, tests and bounded independent reviews. Root coordinates, resolves architecture/financial-semantics questions and verifies acceptance rather than doing all coding. No paid Browserbase hosting/Gateway; PMS browser remains on the PMS-connected EC2 host.

**Scope:** one completed folio tool through its existing reusable typed/receipt execution path, with regression checks for notes/traces and find/detail. No write tools, dummy reservations, email agent, worker, DB changes, deployment or whole-portfolio migration. The October 2028 create/cancel pilot remains parked.

## Baseline: preserve, do not rebuild

Authoritative prior handoff: .private/stagehand-trial-20260917/trial-handoff.md. Full chronology and old checkpoints: .private/stagehand-trial-20260917/progress.md. This revision replaces obsolete active-plan descriptions, not those historical records.

| Capability | Verified baseline / remaining gap |
|---|---|
| Identity | OSRESS opaque row ID resolved through OSRESV.LST; exact property/stay binding preserved through HDR/FOL. Null room has explicit empty-wire handling. |
| Folio balances / transactions | Two real stays; 96 / 47 All Folios postings, bounded continuation, signed amounts/currencies; independently compared with captured source tuples. Keep this path. |
| Deposits | Bound normal driver still returns unavailable. Configuration, ordinary bank-payment postings and null untransferred fields do not establish deposit lifecycle. |
| Notes / traces | Real notes on both cases; a genuine open trace on one. Audience/state/paging checks passed; completed nonempty trace edge covered by fixtures, not claimed live. Regression only. |
| Packaging / proof | Final bundle 22ef07f3… passed A→B→A with 38/38 contexts closed and fresh-process proof with 4/4 closed. Normal closure excludes model SDKs. |
| Session readiness | Intermittent 813-byte language-bootstrap HTML remains causally unresolved. Later green runs and reverting login changes did not establish a fix. |
| Stagehand / spending | 4.1.0 installed and used: eight calls, one synthetic plus seven discovery observations; $0.14 published-rate estimate, zero reserved at handoff. |

Baseline source SHA-256: 8e4342758a61393fc1af957cc682acf10026ce7e8de597ae15e0470e648695ec.
Baseline bundle SHA-256: 22ef07f3c620899346552fd40e8e6dc7bf4c37d51b69bdf4d1fb0f9ad3ea5446.
Private proof files: aba-final-22ef07f3.json, aba-final-22ef07f3.evidence-report.json, fresh-final-22ef07f3.json and associated case outputs/logs under the same private directory.

Previous local gates were 471 tests/33 files plus 116 tests/seven distinct files and an additional overlapping null-room check; TypeScript passed. These are historical results, not verification of the forthcoming changes. The prior proof checker explicitly excluded the missing deposit source and full shipping acceptance.

One runtime/browser did **not** mean one authentication: normal proof contexts logged in separately; discovery reused one authenticated context. Process-local egress sentinels did **not** attest browser/host-wide egress. Preserve those distinctions.

## Product Contract

### Requirements and preservation

- **R1 — Complete folio:** preserve balance, deposits and bounded/paged transaction sections, signed money, currency, exact parent/account scope, unknown/partial states and disclosure restrictions. Deposits include due, paid, refunded, forfeited, transferred and untransferred, with source-backed semantics. Preserve compatible legacy fields rather than silently changing their meanings.
- **R2 — Preserve notes/traces:** the prior completed sources and audience/state/paging behavior are regression obligations, not a new discovery project.
- **R3 — Connected provenance:** acceptance starts from authorized incoming-message packets or preceding tool results, not gold replies or manually injected reservation IDs. UI/manual source reconnaissance is allowed but labelled diagnostic until replayed through the actual typed tool.
- **R4 — Deterministic delivery:** normal execution uses reviewed requests/DOM parsing only; zero Stagehand/model inference, model-supplied scripts/URLs/selectors or runtime self-healing. Complete driver, facade, policy, receipt and actual provider wiring together.
- **R5 — Honest development comparison:** reuse the pre-Stagehand and final overnight baselines. Record new discovery/coding/packaging time separately. Do not credit inherited fixes to Stagehand or repeat the whole comparison to manufacture a speedup claim.
- **R6 — Read-only/privacy:** any relevant screen may be inspected read-only; mutations, report/document generation, sends and permission changes remain prohibited. User-authorized client data may enter the approved Azure model route and private evidence; never credentials, public web research, Git, unapproved providers or command/SSM logs.
- **R7 — Reliable, truthful failures:** bootstrap HTML, stale records, incomplete windows, parser errors and access denial remain distinguishable. No unbound or unknown data can become a successful financial answer.

R1/R3/R4 retain the original full financial/provenance contract. R2 narrows remaining work to regression because its implementation is now evidenced. R5 reuses completed baseline work. R6 implements the user's explicit new screen permission. R7 makes the known unresolved readiness obligation explicit. U1–U4 IDs remain stable; U5/U6 add the newly authorized source and readiness work.

### Why deposits belong here

The canonical catalog already required the six lifecycle facts: docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md, inherited by A2 in docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md.

Private demand evidence: .private/gold-reanalysis-2026-09-10/lane-pay-quote.md classifies 565 payment-lane items, including 222 deposit/POP chases, 148 POP-only acknowledgements and nine refund promises. These are distinct primary classes, not additive tool execution counts. The broader 763 folio tags are **not** 763 requests for deposit history. A POP acknowledgement alone need not query PMS; whether a deposit was posted, remains due, was refunded or moved does.

The deliverable is **bounded source-backed financial facts**, not unlimited transaction-history export, bank reconciliation, or proof that funds cleared externally.

### Financial source contract

| Fact | Acceptable evidence | Never substitute |
|---|---|---|
| Due | Bound deposit schedule/current outstanding obligation; any derivation must have verified allocation/status/as-of semantics. | Original configured deposit amount, whole-folio balance, guessed requirement-minus-paid. |
| Paid | Bound posted Advance Deposit receipts/authoritative received total; documented treatment of reversals/refunds. | Email POP, card authorization, ordinary folio payment merely resembling a deposit. |
| Refunded | Explicit bound refund activity/total with reversal semantics and coverage. | Negative posting with an unexplained code, absence from a short date window. |
| Forfeited | Explicit bound forfeit activity/total. | Cancellation status or an assumed fee. |
| Transferred | Bound transfer-to-guest-ledger facts, excluding unrelated group/company/AR transfers and double counting. | Any generic account transfer. |
| Untransferred | Explicit bound source total or fully reconciled documented lifecycle calculation. | Null FOL field, assumed paid-minus-transferred without accounting for refunds/forfeits/reversals. |

Every money fact carries currency, provenance/as-of scope and known/unknown state according to existing typed interfaces. Do not combine currencies. Preserve sign semantics internally; do not take absolute values to force a closed unsigned legacy schema to accept an unexplained posting. Missing/masked/malformed/source-incomplete values stay unknown/partial.

A known zero requires authoritative complete coverage for that field, not an empty first page. A currently complete per-account total may be authoritative without downloading all historical rows; otherwise page the explicitly bounded relevant lifecycle and disclose gaps. Unsettled meanings are research tasks, not permission to invent a formula.

At least one final case must have a genuine nonzero posted deposit. Other lifecycle fields may be source-authoritative zero; unavailable rare nonzero variants use labelled fixtures. Do not manufacture live financial events to satisfy tests.

## Global Constraints

- Read permission is screen-wide; request authority is still **operation-specific**. GET is not inherently safe and POST is not inherently a write. Review function, body/query, origin, parent, date/page scope and observed effect.
- Unknown business requests are blocked **before dispatch** and captured privately for review. Add only demonstrated read shapes; never a blanket endpoint/origin wildcard. A guard blocks a request, not proof that the PMS role denied access.
- Keep Save/Submit/Create/Cancel/Post/Pay/Refund/Forfeit/Transfer/Complete/Delete/Send/Print/Export/document-generation/card operations blocked, including encoded/nested forms. No business-field editing, autosave, card entry or fee actions. Navigation, search and date filters are allowed only where shown inert. Never use CRS Check Availability as a read shortcut.
- Preserve popup/download/WebSocket/page-service-worker/new-page and redirect protections. Add observed exact inert static image requests if needed; no broad images-path allowlist. Capture/flush failure video before teardown when safe.
- Customer prose/DOM is data, not agent instructions. Deterministic controller actions remain closed, token-protected commands; Stagehand observations are suggestions checked against this policy.
- Evidence capture preserves authorized customer facts but scrubs credentials before persistence: cookies/Authorization headers, passwords, session/CSRF tokens and payment-card secrets, including nested request/response fields. Reuse/extend existing redaction helpers and synthetic secret-leak tests; do not store raw authenticated traces and sanitize them only at handoff. Keep recording post-authentication and avoid secret/card panes. Private browser authentication state is runtime state, not an evidence artifact to export or send to a model.
- Existing production checkout and mail services remain untouched. Stage isolated artifacts only; preserve inherited dirty files and private evidence. No commit/push/PR unless separately requested.
- Tests remain DB-free: do not load production env, access pilot/production RDS, run migrations or enable VITEST_ALLOW_PILOT_RDS.
- One live PMS/browser owner at a time, coordinating through the existing remote .hms-live-operation.v2.lock. Offline agents do not share or steal its contexts. Never terminate another agent's processes/session.

## Autonomous Execution Mandate

This mandate becomes active when the user launches the revised goal. Execute U1–U6 unattended within the scope above; choose ordinary implementation details without routine approval questions.

- **Delegation:** Luna max performs the coding, focused tests and independent reviews using disjoint ownership packets below. Root handles coordination and final acceptance; it may intervene on demonstrated integration/semantic blockers. No automatic escalation of every small task to Astra.
- **Models / spending:** preserve the approved Azure Astra/high discovery callback and existing serial persisted meter at .private/stagehand-trial-20260917/spend.json. Resume its cumulative balance; never reset it. $25 target / $50 aggregate Stagehand inference ceiling is a **published-rate estimate**, not an Azure invoice guarantee; Codex/subagent usage and infrastructure are outside it. Before each call reserve bounded usage durably; retain ambiguous reservations, disable hidden retries and stop inference at the cap. No unmetered/provider fallback.
- **Infrastructure:** reuse installed Stagehand 4.1.0, isolated Playwright 1.63/Chromium1243 discovery stack and proven Playwright1.52/Chromium1169 normal stack. No upgrades absent a reproduced compatibility need. Controller/key stay on this VPS; Chromium/extension/guards/video stay on PMS-connected EC2 via private SSM CDP. No Browserbase hosting.
- **Persistence:** twenty minutes without new evidence triggers a concise mechanism summary, bounded independent review and a changed approach. Meaningful progress may continue; do not loop over unchanged nulls or guessed requests. Advance independent safe work while live proof is blocked.
- **Checkpoint:** seven hours from the new execution start, report completed gates, current evidence, spend, blockers and next action; it is not a deadline or permission to lower DoD. Continue while meaningful in-scope progress remains.
- **Blockers:** a genuinely missing PMS role, absent qualifying data, unresolved financial meaning, unavoidable unsafe action or external outage can block acceptance. Exhaust safe relevant alternatives, preserve video/request evidence and report the exact unmet gate. Follow the platform's blocked-goal threshold; do not mark complete for partial work or stop solely because the checkpoint elapsed.
- **Cleanup:** close only owned contexts/processes/tunnels, settle/retain meter reservations correctly, and preserve reproducibility/evidence. Model-budget exhaustion stops inference, not safe deterministic implementation.

## Technical Approach

Use the existing bound folio path:

Incoming-message packet → find/detail binding → typed read service/receipt → bound folio driver → reviewed facade requests → deterministic facts.

The current normal callback in apps/server-pilot/scripts/hms-standalone-connected-read.ts calls observeBoundFolio, **not merely observeFolioBalance**. That bound driver already handles FOL / All Folios and hardcodes missing deposits. Add the deposit provider at that seam; changing only the legacy observeDepositSummary method will not finish the actual tool.

### Source discovery order

1. Resolve the stay's actual linked guest account, with property + reservation/account binding; do not assume search row ID, stay ID and account ID are interchangeable.
2. Read Account → Advance Deposit and Actions → Deposit Schedule where inert, capturing the painted UI and exact requests/responses in one pass.
3. Corroborate with bound Guest Stay Guarantee/received values and FOL untransferred amount where meaningful.
4. Use Property Ledger → date → Deposit Ledger rows as a valid alternative/corroboration if they expose bound confirmation/account/activity and complete required coverage. The existing legacy reader caps its date list at seven rows and aggregate work at five seconds; this cannot establish absence across longer history. Do not do an unbounded property-wide crawl.

Official docs identify the UI and business meaning, **not a verified internal Advance Deposit endpoint/body**. Exact live contracts are U5's first execution deliverable. Inspect observed client request construction if needed; do not brute-force guessed write endpoints. Source failure remains evidence, not a reason to force the primary route when another authorized read source suffices.

### Minimal implementation, not a platform rewrite

Add the smallest typed facade operation(s) justified by observed requests, then a pure parser/projection and bound driver integration. Keep existing closed contracts, receipt validation and disclosure. Preserve the current folio_summary branch if the new source fits its exact lease; add a branch only if actual source scope requires one. Reconcile active runtime, handler version/digest, manifests and role/release evidence together.

Known policy sites include folio-read-contract.ts, read-tools.ts, live-read-manifest.ts, folio-manifest.ts, emit-finance-manifests.ts/generated request manifests, discovery command unions/helpers, release-kernel.ts and phase-b-read-preflight.ts. Changing one deny-array is insufficient. Role-proof files attest observed access and enforcement, not permission to grant a PMS role; never fabricate a proof or edit hotel roles.

Do not add a service, generic browser agent, new queue, schema migration or parallel live-account pool. Do not optimize login latency or rewrite session reuse unless required for correctness.

## Implementation Units

Execution order: U1 → U5 → U2 → U4. U6's offline work can run alongside U5/U2, with all live checks serialized; U3 runs after shared changes. U4 depends on U2, U3 and U6.

### U1 — Reconcile baseline and preflight once

**Requirements:** R3–R6. **Dependencies:** none. **Owner:** Luna integration owner.

**Files:** existing scripts/hms-stagehand-bundle.mjs, hms-stagehand-preflight.mjs, hms-stagehand-read-trial.ts; tooling/stagehand; source/bundle helpers and existing stagehand tests, all under apps/server-pilot. Change only if preflight reveals a real defect.

1. Read repo safety guidance and private final handoff; inventory dirty ownership, current source/manifest hashes, exact runner entry and spend state without printing secrets.
2. Confirm no other live owner; reuse the existing lock and private host/tunnel recipe. Verify short private TMPDIR, pinned dependencies, complete public Playwright files, imported CLI isolation, guard installation before navigation, post-auth recording and owner-safe teardown.
3. Reuse existing synthetic/model/meter tests. Do not repeat paid setup calls or reinstall working dependencies merely to establish activity.
4. Build/preflight one coherent source set; safe smoke must refuse live calls without explicit live arguments. Open a fresh private evidence subdirectory for this continuation while keeping the same spend ledger.

**Acceptance:** trusted baseline and reproduction command recorded; no unreviewed overlay/entrypoint divergence; meter resumed; local safety preflight passes. Old live results remain labelled historical.

### U5 — Open the read surface safely and capture the actual source

**Requirements:** R1, R3, R6. **Dependency:** U1. **Owner:** Luna discovery/policy owner; sole live owner.

**Files:** apps/server-pilot/src/hms/{stagehand-discovery,folio-read-contract,read-tools,live-read-manifest,folio-manifest,folio-read-facade}.ts; scripts/hms-stagehand-read-trial.ts, hms-stagehand-action.mjs and emit-finance-manifests.ts; reviewed generated manifests and role/release evidence where affected. U1 hands the trial owner script to this owner before U5 changes it.

1. Write failing policy tests showing allowed relevant read navigation but still blocked Save/Post/Refund/Transfer and encoded/nested mutations. Replace blanket advance_deposit_form denial with explicit read surfaces/commands, not wildcard network permission. Extend the existing trial owner's deterministic action dispatch and owner-manifest/dependent-rule lifecycle alongside the command helper; test both dispatch and capture behavior.
2. Keep unknown business requests fail-closed. The current guard may close the context on rejection: capture only the attempted scrubbed signature, review native client construction/docs for read-only effect offline, then replay in a fresh guarded session with the reviewed rule. Never hot-widen a live manifest to get past a rejection. Successful UI + response + video capture can share one replay pass; an initially unknown route legitimately needs this extra discovery/replay boundary. Add endpoint-specific negative tests for autosave, receipt generation/download and encoded/nested actions; absence of a mutation-looking name alone is insufficient evidence. During replay verify no such side-effect request is dispatched. Batch verified inert assets to avoid one-icon rebuild cycles.
3. Use Stagehand observe only if it helps locate the source. Through guarded deterministic actions, navigate the exact linked account and record video plus request/response evidence once, after authentication. Capture binding, currency, totals, lifecycle rows, schedule, pagination and actual empty/denied states.
4. Produce a private source contract: endpoint/method/function/shape, parent/account fields, response mapping, lifecycle/reversal semantics, authoritative zero conditions, row/time/byte limits and coverage. Record the selected branch/surface IDs. Propagate that decision through ROLE_SURFACE_IDS, DISCOVERY_OPERATION_IDS, the folio registry branches, role-proof v2, emitted manifests/digests, runtime authorization, handler digest and connected/release tests. Share sanitized fixtures or authorized private paths with offline coders.
5. Update manifest/proof digests and required role-surface evidence honestly. If source is truly role-gated, preserve a video showing actual navigation/denial plus request evidence; generic bootstrap HTML is not role denial. If recording fails, retain usable request evidence and repair recording separately under the twenty-minute no-new-evidence rule. Resume coding from the retained capture; recapture visuals in the next necessary live/final pass instead of repeating source discovery, staging or login solely to rebuild already captured evidence. A missing required video stays an explicit gap.

**Tests:** existing hms-stagehand-discovery, hms-live-read-manifest, hms-folio-manifest, hms-folio-read-facade, hms-folio-read and hms-read-tools-registry suites, with new exact-read and mutation-rejection cases.

**Acceptance:** a verified per-stay/account deposit source contract and usable capture, or a precise evidenced blocker after safe alternatives. No guessed endpoint declared verified.

### U2 — Complete the actual folio provider and financial projection

**Requirements:** R1, R3–R4, R6–R7. **Dependency:** U5 source contract; offline contract tests may begin earlier. **Owners:** Luna driver/parser and integration owners.

**Files:** apps/server-pilot/src/hms/{live-folio-read-driver,folio-read-facade,read-service-contracts,active-read-runtime,read-handler-index,read-service}.ts; scripts/hms-standalone-connected-read.ts; affected receipt/projection and handler/manifest bindings only.

**Exclusive ownership:** A retains facade/manifest edits; B owns live-folio-read-driver, financial projection and read-service-contracts plus their tests; C alone owns standalone provider, active-read-runtime, read-handler-index and read-service wiring. C requests any receipt-schema change from B rather than editing the same file. U2's combined file list is not permission for either owner to edit all of it.

1. Add failing sanitized tests from U5 captures before implementation. Implement deterministic source parsing at the existing bound observer seam, preserving proven All Folios balance/transaction behavior.
2. Fill all six deposit facts with verified semantics and source coverage. Review richDepositSection's existing untransferred calculation; retain it only if source semantics prove it correct. Legacy total/depositSummary fields require explicit compatibility mapping, not invented totals.
3. Carry actual account/stay IDs through facade, provider, evidence merging and receipt binding. Validate requested balance/deposit/transaction combinations, default behavior, projection and partial/error propagation through the real reusable tool path.
   Check the actual normal-entry authorization boundary: loaded role-proof bytes must match the expected authorization/release digest and property/actor/evidence scope before a context is created. Reuse existing release checks; close any bypass in the affected folio path and add a changed-proof negative test rather than a new authorization framework.
4. Preserve per-request five-second bounds and the current ten-second aggregate bound-folio budget initially. Before finalizing integration, measure the complete combined deposit + FOL + All Folios/page chain and record one accepted aggregate deadline/byte/row budget. If adjustment is necessary, update driver abort/deadline handling, response-bound calculation, receipt duration validation and timeout/byte/row tests together before widening. No unbounded scan/retry. Existing 256KiB/row/page caps remain unless a specific reviewed need is recorded.
5. Test lifecycle reversals, exact duplicate-looking legitimate rows, currency separation, wrong parent/account, missing identity/currency, masked/null/malformed money, truncated pages, continuation scope and complete empty vs unknown. Every unavailable source must propagate honestly.

**Tests:** hms-bound-folio-read, hms-live-folio-read, hms-folio-fol-parse, hms-folio-read-facade, hms-folio-transactions-contract, hms-read-service, hms-read-service-folio-paging, hms-connected-runner-contract and relevant release/receipt tests.

**Acceptance:** normal typed tool actually consumes the new source; all required financial fields are known on qualifying cases, without model extraction or fallback-to-balance success.

### U6 — Contain bootstrap failures; repair a reproduced acceptance blocker

**Requirements:** R3–R4, R7. **Dependency:** U1. **Owner:** Luna readiness owner, offline in parallel; coordinate any live work with the sole live owner.

**Files:** apps/server-pilot/src/hms/{runtime,live-guest-stay-driver,reservation-detail-facade}.ts only where causal evidence warrants; scripts/hms-single-context-normal-diagnostic.ts, hms-connected-folio-source-diagnostic.ts, hms-diagnostic-read-shapes.ts and focused tests.

1. Reuse existing failing/successful controls: an 813-byte loadLocalizedPage/langform/ewslanguage body is bootstrap HTML, never a reservation/not-found result. Old login rollback and short-TMPDIR repair did not resolve this cause.
2. First verify folio-path classification and exact binding with retained failing captures and focused tests. If 813 reproduces in the current connected path and blocks acceptance, compare minimal readiness/request context differences with one variable at a time; reuse existing diagnostic helpers rather than another CLI wrapper. Capture status/content type/body classification and parent-binding state without secrets. Do not start a general session rewrite when the current path is passing.
3. Implement a specific evidenced readiness condition or safe bounded reinitialization only if justified. A retry is allowed only for a proven read, within a defined attempt/deadline bound and followed by exact record revalidation. No random sleeps, cross-client replay, generic retries or guessed header fix.
4. Test forced bootstrap, stale/mismatched record and expired session; test recovery exhaustion if recovery is implemented. Either readiness/recovery establishes correct binding or returns a typed unavailable/error; never false success.
5. Require safe typed failure tests and fresh final connected acceptance. Any implemented recovery needs a reproduced or controlled failure demonstrating its bounded behavior. If the failure does not recur in final execution, do not make indefinite root-cause investigation a separate shipping project: retain the unresolved intermittent cause as an explicit limitation and never claim it was fixed. A recurring failure that prevents required final proofs still blocks DoD.

**Tests:** hms-json-response-diagnostics, hms-runtime-post-json, hms-single-context-normal-diagnostic, hms-connected-folio-source-diagnostic, hms-live-guest-stay and reservation-detail regression suites.

**Acceptance:** truthful bootstrap classification/binding and required fresh connected proof; a claimed recovery is independently evidenced. Later passing runs prove those runs, not a causal fix. No unrelated session-performance project.

### U3 — Preserve proven notes/traces and identity

**Requirements:** R2–R4, R6. **Dependencies:** U2/U5/U6 shared changes settled. **Owner:** Luna integration owner.

Reuse existing notes/traces, audience/state/paging and find/detail tests. Preserve nonempty staff notes/open trace, customer withholding and completed-state fixture semantics. Do not rebuild these providers or search for extra live traces merely to repeat prior discovery.

**Files/tests:** existing notes-inquiry/notes-traces drivers and facades only if regressed; hms-notes-traces-read, hms-notes-traces-facade, hms-notes-traces-paging, hms-notes-traces-sections, hms-reservation-detail-facade and connected variant tests.

**Acceptance:** no regression caused by shared policy/runtime changes; final artifact's connected notes/identity checks pass, with unsupported live variants still labelled fixture-only.

### U4 — Final same-artifact verification and reproducible handoff

**Requirements:** R1–R7. **Dependencies:** U2, U3, U6. **Owner:** Luna integration/live owner plus independent Luna reviewer; root accepts evidence.

1. Perform focused integration, financial-semantics, security and simplicity review. Reviewer checks the actual normal entry/receipt path and effective manifests, not only parser tests.
2. Build one final immutable normal bundle after review fixes; safe smoke, source/manifest/handler digests and dependencies must match. Keep Stagehand/model SDK closure out of that artifact.
3. Choose two authorized connected folio cases with meaningful financial coverage; at least one genuine nonzero deposit. Existing A/B may be reused when they qualify, otherwise select bounded additional incoming-message packets and retain old A/B as regression oracles. Do not inject manually discovered IDs into acceptance packets.
4. Read required financial fields and applicable transaction continuations through actual typed calls. Compare returned facts independently against painted UI plus captured read evidence, not parser output compared with itself. Include per-field source/coverage and live/fixture/synthetic evidence labels.
5. Run record A→B→A, then a separate fresh-authentication process on the **same final artifact**. Verify cross-record isolation and stable business facts, tolerating only explicitly explained real PMS changes—not reference/provenance token differences. Run notes/find/detail regression in the final evidence set.
6. Record zero runtime inference with closure inspection and available sentinels; state their limits. Verify guarded browser requests independently; do not call a Node-only sentinel host-wide egress proof.
7. Publish private reproduction commands, outputs, request/painted-video oracles, field matrix, digests, spend, development timings, review disposition and remaining caveats. A colleague must be able to repeat the typed calls without a model. Close owned runtime resources.

**Acceptance:** every DoD item below is proven on the delivered source; no substitute of diagnostic UI success for tool success.

## Delegation and Development-Speed Contract

Use at most three active Luna max workers alongside root. Assign disjoint files before dispatch; sharing a repo does not permit concurrent edits to the same file. Sequence owners at shared seams rather than introducing abstraction solely for parallelism.

| Packet | Owner / work | Boundaries |
|---|---|---|
| A: source + policy | Luna max: U5 discovery commands, exact facade/manifest shapes, policy/registry and generated proof updates | Sole live owner; owns these files until capture contract and reviewed changes handed off. |
| B: financial driver | Luna max: U2 driver, pure projection, read-service-contracts compatibility and focused tests | Offline; consumes A's capture contract; requests facade changes through A; owns receipt-schema edits requested by C. |
| C: readiness then integration | Luna max: U6 diagnostics/runtime, then exclusively standalone provider, active-read-runtime, read-handler-index and read-service wiring; U3/U4 integration | Offline first; live probes via A or explicit ownership transfer. Request schema changes through B; no concurrent ownership of A/B files. |
| Review | Reuse a free Luna slot for an independent author-excluding review | Read-only review; no extra live browser or broad rewrite. |

Every task packet includes: U/R IDs; exact objective; verified baseline and unresolved facts; owned/read-only files; source-capture paths and interface assumptions; financial/record/privacy invariants; specific failing tests and commands; live permission yes/no; stop/handback conditions. Ask for changed paths, test results, evidence, remaining failures and next action. Supply compact targeted context, not the entire chat/tool log. If actual Luna max is unavailable, report it; do not silently run all coding on Astra.

Batch related fixes and focused tests before rebuilding. Run small affected tests during development; full connected variants once on a meaningful integrated/final artifact, not after every icon/parser edit. Preserve raw private observations so subsequent coding need not repeat live exploration. Review with source-hash consistency; do not restart all staging every time a single file changes.

## Verification Commands and Evidence

Run from apps/server-pilot with production DB variables absent. Begin with the exact affected files, then the integrated families; these commands are for execution, not a claim they ran during planning.

~~~sh
env -u DATABASE_URL -u DATABASE_URL_UNPOOLED -u PILOT_DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm exec vitest run tests/hms-bound-folio-read.test.ts tests/hms-live-folio-read.test.ts tests/hms-folio-read-facade.test.ts tests/hms-folio-transactions-contract.test.ts tests/hms-folio-manifest.test.ts tests/hms-live-read-manifest.test.ts tests/hms-read-tools-registry.test.ts tests/hms-connected-runner-contract.test.ts
env -u DATABASE_URL -u DATABASE_URL_UNPOOLED -u PILOT_DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm exec tsc -p tsconfig.json --noEmit
~~~

Expected: new test fails for the targeted missing behavior before implementation; affected and integrated suites pass afterward; TypeScript clean. Include remaining U2/U3/U6/release/Stagehand tests whenever touched; do not run an indiscriminate app/DB suite. Use the existing safe-smoke/immutable staging and live recipes from the private handoff, updating case allowlists/hashes explicitly rather than copying stale arguments.

Evidence matrix columns: requirement/field, typed output, binding, independent UI/request source, window/page coverage, expected/actual, evidence level, artifact digest, verdict. Keep recordings post-authentication, private and readable. For access restrictions, show the actual failed navigation/denial; for internal guard refusal, show the distinct policy finding. No screenshots of a spinner presented as proof of inaccessible deposits.

## Definition of Done

- [ ] R1: balance, deposits and bounded/paged transactions are complete through the normal typed tool/receipt. Due/paid/refunded/forfeited/transferred/untransferred each have verified meaning, currency and coverage; no unknown→zero conversion.
- [ ] Two meaningful connected folio cases, at least one real nonzero posted deposit; required fields independently verified. Source-authoritative zero is valid; fixture-only rare lifecycle branches are explicitly labelled.
- [ ] Correct exact property/stay/account binding; defaults, section selection, paging, negative/partial cases and disclosure pass. Existing 96/47 transaction evidence is preserved as regression, not blindly assumed current forever.
- [ ] Notes/traces and find/detail regressions pass; no whole-portfolio scope expansion.
- [ ] U6 bootstrap/binding failures return honest typed errors; final connected proofs pass. Any new recovery has controlled-failure/exhaustion evidence. An unproved intermittent cause remains disclosed, not labelled fixed.
- [ ] Final-source A→B→A and fresh-process proof pass; actual tool calls, painted UI and network evidence agree.
- [ ] No runtime model calls, mutation, production DB test, worker/app deployment or unauthorized data egress.
- [ ] Paid discovery stayed on approved Astra/high within the same cumulative $50 estimate meter; no invoice-cap or orchestration-cost claim.
- [ ] Final source, dependency, manifest/role/release/handler bindings and private evidence agree. Review findings resolved; another operator can reproduce. Owned resources closed; final report names Stagehand's real contribution and limitations.

“100%” means **this bounded tool contract and these acceptance gates**, not all possible PMS configurations, guaranteed future uptime, or the entire AI reservationist. Any missing required source, financial meaning, qualifying case or reliability gate leaves the tool/goal incomplete. Do not waive a gate to make a dashboard green.

## Risks and Execution-Time Decisions

- **Public docs are not internal API specs.** Exact Advance Deposit contracts and tenant role availability still need live observation. That is planned work, not already-verified knowledge.
- **Read permission is not no-side-effects permission.** A mixed read/write screen can issue autosaves or generate receipts; guards remain necessary even with broad screen access.
- **Financial meaning is harder than clicking.** Correct account association, schedule obligations, reversal semantics and source coverage determine whether the returned money is trustworthy.
- **813 remains unresolved.** Its old successes do not prove a fix. U6 is scoped reliability work; do not waste another night on unchanged speculative probes.
- **Development speed is the priority.** Reuse installed stack, stable source evidence and batch staging; do not optimize seconds of tool latency at the expense of hours of unnecessary rewrites.
- **A true external block needs evidence, not fabricated success.** Capture a denial video when possible, isolate missing access/data/meaning and make the next human action specific.

## Sources and Durable Learnings

- Baseline/origin: docs/superpowers/plans/2026-09-15-centurion-read-tools-leftovers-to-yes.md; canonical A2 contract: docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md.
- Private authoritative handoff, progress, spend and final proof: .private/stagehand-trial-20260917/.
- [Infor Accounts](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571440.html) and [Advance Deposits](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html): account selection, Advance Deposit tab, lifecycle activities, Deposit Schedule; Save posts and may trigger receipts/tax invoices.
- [Infor dated Deposit Ledger details](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579271.html) and [dated ledger summary](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579193.html): dated rows can expose confirmation/activity/amount, not merely property aggregates.
- [Guest Stay Guarantee](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573093.html) and [Folio](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861-2.html): distinguish configured requirements, received deposits and untransferred values.
- Existing Stagehand references: [v4 models](https://docs.stagehand.dev/v4/configuration/models), [migration limitations](https://docs.stagehand.dev/v4/migrations/playwright), [Playwright extension requirements](https://playwright.dev/docs/chrome-extensions). Reuse proven installed versions rather than treating public latest as an upgrade mandate.
- docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md.
- docs/solutions/workflow-issues/hms-wave-a-read-tool-proof-three-gates-playbook.md.
- docs/solutions/workflow-issues/hms-hitl-ui-first-playwright-recorder-build.md.
- docs/solutions/workflow-issues/infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md.
- docs/solutions/conventions/live-negative-result-verification-gate.md.
- docs/solutions/runtime-errors/chromium-launcher-long-tmpdir.md.

Planning used local code/learning research by Luna max and official Infor documentation. The locally referenced ponytail-review skill is unavailable; bounded completeness/security and simplicity reviews substitute, not a claim that the missing formal gate ran.
