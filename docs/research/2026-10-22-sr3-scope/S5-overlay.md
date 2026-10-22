> 🧠 **From Hindsight memory (U2 BAR grid before room pick)** — Reuse `rateScope` from the existing read; a rate code alone cannot prove a contract. BAR-only must say “contract not checked.” Worktree code confirms the tags exist, but not that one search returns every strategy.

### 1) Current state

| Fact | Evidence |
|---|---|
| #441’s tagged grid and #422’s Dinner B&B → Government behavior are already in this base. Grid is read-only. | [tag logic](apps/mail/components/quote-workflow/quote-workflow-panel.tsx:392), [grid](apps/mail/components/quote-workflow/quote-workflow-panel.tsx:823), [prepared rule](apps/server-pilot/src/ai/quote-ready.ts:241) |
| Search is still singular: request has one `salesStrategy`; a bound party changes non-Government search to `Preset`. The service reads a summary, then a full result for the selected quote. | [request type](apps/server-pilot/src/ai/reservationist-business-services.ts:14), [Preset rule](apps/server-pilot/src/ai/reservationist-business-services.ts:152), [HMS selector](apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:200) |
| Returned rows preserve `rateScope`; code does **not** prove that a BAR/Preset search returns Government too. Current tests construct mixed rows; that is not live HMS proof. | [rate scope](apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:519), [grid test](apps/mail/tests/rate-cards.test.tsx:281) |
| Prepared quote defaults Government only for all-DBB rows; the pane uses Government party/all-DBB. A separate quote path already detects explicit “government rate” text. | [prepared rule](apps/server-pilot/src/ai/quote-ready.ts:241), [pane default](apps/mail/lib/quote-workflow/session.ts:921), [text rule](apps/server-pilot/src/ai/reservationist-business-services.ts:61) |
| Typed company/agency is PDF text, not HMS identity; only a picked native party is sent. No party means no contract read; current UI already signals unchecked contract and offers Find in HMS. | [party bind](apps/mail/lib/quote-workflow/staff-quote-bind.ts:962), [lookup boundary](apps/server-pilot/src/ai/reservationist-business-services.ts:132), [notice](apps/mail/components/quote-workflow/quote-workflow-panel.tsx:823) |
| Truth pool: 24 candidate rows → ~12 threads; scored gold n=8: Government 4, contract 1, BAR 3. Historical baseline: Government hit 2/4, contract 0/1; 5/8 class+board+room, 2/8 exact price. It is not a current `b11e5ac52` score; n<10 bar. | [pool counts](docs/research/2026-10-20-quote-backtest-pool.md:5), [scoreboard](docs/research/2026-10-20-quote-backtest-pool.md:37) |

### 2–3) Gaps, changes, files, estimates

| # / PR | Change | Product files; estimated product LOC | Tests; estimated test LOC | P1-likely risk |
|---|---|---|---|---|
| 1 / R9a | Carry explicit Government-rate intent separately from board and party; preserve B&B as B&B. Use it in prepared and interactive defaults; keep manual override. | `apps/server-pilot/src/ai/extraction/{schema.ts,extract.ts}`, `quote-ready.ts`, `reservationist-decision.ts`, `quote-workflow-llm.ts`; `apps/mail/lib/quote-workflow/{types.ts,session.ts}`; `apps/mail/components/quote-workflow/quote-workflow-panel.tsx`. **+35–65** | `extraction-schema.test.ts`, `quote-ready.test.ts`, `quote-workflow-llm.test.ts`, `quote-workflow-session.test.ts`, `quote-workflow-panel.test.tsx`. **+60–95** | False Government classification. Require explicit rate evidence; do not mutate board or infer party. |
| 2 / R9b | Compare per stay: BAR without party, Government, and Preset with verified party. Merge rows/options with strategy provenance and `rateScope`; show side-by-side tags and let staff pick, then rerun the exact choice through the existing full quote path. No party: “contract not checked” + Find in HMS; no implicit bind. | `apps/server-pilot/src/ai/{reservationist-business-services.ts,hms-availability.ts,rate-options.ts}`; `apps/mail/lib/quote-workflow/{types.ts,staff-quote-bind.ts}`; `apps/mail/components/quote-workflow/{rate-cards.tsx,quote-workflow-panel.tsx}`. **+140–240** | `reservationist-business-services.test.ts`, `hms-availability-probe.test.ts`, `staff-quote-job.test.ts`, `staff-quote-job-bind.test.ts`, `rate-cards.test.tsx`, `quote-workflow-panel.test.tsx`. **+180–280** | Wrong-source pick/dedup, false contract tag, stale partial result, or comparison failure blocking the primary quote. Keep source strategy in row identity; secondary failure must remain visibly incomplete, not “no rate.” |

LOC are semantic-addition estimates from the current functions/types; keep the compact `reservationist-business-services.ts` formatting. **One search has one strategy.** For a guaranteed overlay, unbound adds one summary read; bound adds up to two, serially under the existing single property lock ([lock](apps/server-pilot/src/ai/staff-quote-run.ts:718)). Each added HMS read has an observed 12–413s range, plus unknown queue wait. Do not widen `fetch-quote.mjs`/`quote-contract.mjs` to a multi-strategy API.

### 4) PR split and collisions

| PR | Dependency / collision |
|---|---|
| R9a → R9b | Soft dependency: both change quote panel/session. Land sequentially; each stays under 500 product LOC and one behavior. #441/#422 are already in base. Treat #458/#460/#461/#462/#451 as landing; do not re-plan them. |
| Scope | Extraction schema/prompt is shared with create/cancel/amend: new signal must be optional and quote-only. `reservationist-business-services.ts` / `hms-availability.ts` also serve DV quote and CHECK: fan-out only in staff-approved quote flow. Panel/session overlap quote overlay and multi-stay: keep rows per date/stay, never merge stays. Do not change create/cancel/amend writes or DV/CHECK read behavior. Exact incoming-PR file overlap is unknown from this base. |

### 5) Test and replay plan

| Gate | Scenario / proof |
|---|---|
| Unit: R9a | `quote-ready.test.ts`: “government rate B&B” selects Government, board stays B&B; no explicit plan keeps existing default. `quote-workflow-llm.test.ts` + `extraction-schema.test.ts`: signal survives both inputs. Session/panel tests: All rates and manual override preserve the chosen default. |
| Unit: R9b | `reservationist-business-services.test.ts`: applicable strategies searched serially, party context only for Preset. `hms-availability-probe.test.ts`/`rate-cards.test.tsx`: preserve source and scope; same code from two searches stays distinct. Panel/job-bind tests: staff pick reruns exact strategy/rate; no-party never tags contract; secondary failure/late result cannot invalidate primary quote or another stay. |
| Replay | After #451 U11b lands, use the 2026-10-20 pool’s original inbound inputs and staff PDF/reply truth; require attachment/input parity (`readQuoteAttachments → selectionToAgentPrompt`). Count unique threads, not rows: exclude duplicate-thread rows, the complimentary confirmation, and groups; current scored n=8. Truth positives: Government 4/8, contract 1/8; historical output hits 2/4 and 0/1. Re-filter arrivals against current date; current eligible n and `b11e5ac52` hits are **unknown until replay**. #451 is incoming; current checked-in U11a runner is fixture-only ([runner](apps/server-pilot/scripts/outbound-gold-backtest.ts:1)). Verify its report scores rate-grid rows; current quote-outcome evaluator does not prove nightly-grid pricing. |
| Live | Later, Product EC2, read-only staff quote per applicable strategy/stay under the one browser lock. No writes, so no Labtest; any write check must use Labtest. No live check belongs in this lane. |

### 6) Open questions

| Question | Recommended default |
|---|---|
| Run comparisons on background prefill or staff action? | Staff-initiated Search only; serialize reads; show partial status on timeout. |
| One strategy for final mail quote, or per group/stay? | Compare all; keep final selection mail-wide to match current request contract. Mixed Government asks require staff choice. |
| No party picked: auto-bind? | Use only existing exact/high-confidence V2 bind; otherwise Find in HMS. Never infer native identity from typed text. |
| Is n=8 enough to call R9 done? | No; directional only. Require ≥10 distinct truth threads for a pass. |

No files edited; no tests, typecheck, Vitest, replay, prod, or HMS touched.