# Reservationist MVP — evidence ledger (Oct 6 2026)

> Correction 22:45: `rate-check.ts` is on main (`0a924c0c`), not parked-branch-only. See `2026-10-06-003-case-coverage-gap-audit.md`.

Source of truth for the retro + sprint plan (`2026-10-06-002-reservationist-mvp-retro-and-sprint-plan.md`).
Every claim: locator + status (supported / disputed / unresolved). No raw PII here.

## Sources

| ID | Source | Locator |
|---|---|---|
| H1 | Luda6 retro handoff | `/home/orca/.codex/attachments/reservationist-quote-booking-retro-handoff-2026-10-06.md` |
| T* | Condensed transcripts (prompts + final answers + 15-min activity bins) | `/tmp/retro/codex-*.md`, `/tmp/retro/cursor-*.md` (script `/tmp/retro/condense.py`) |
| A | Codex timeline retro (subagent) | `/tmp/retro/out-A-codex-timeline.md` |
| B | Cursor chats + volume counts (subagent) | `/tmp/retro/out-B-cursor-volumes.md` |
| C | Code inventory / wiring map (subagent) | `/tmp/retro/out-C-code-inventory.md` |
| D | Datasets, backtest cost, plans audit (subagent) | `/tmp/retro/out-D-data-plans.md` |
| X1 | Exa Agent run, effort high, 60 searches, $0.50 | `agent_run_76412b7f2ecc414ab25266e6d332aa86`; raw JSON `/tmp/retro/exa-run.json` |

## Claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 1 | Shipped pane (main `5568ea18`) classifies with regex, not Luna | Codex `01a10e41` 13:46 UTC assistant: "Mailbox-side regex classifier… This is not the reservationist agent" (`apps/server-pilot/src/ai/quote-workflow-analyse.ts:76`) | supported |
| 2 | User defined MVP = Luna reservationist + quote tool + HITL prefill/flags | Codex `01a10e41` 13:47 user: "if we're not using AI then thats short of an MVP we do need a luna reservationist with quote tool and HITL" | supported |
| 3 | Luna extractor `extractReservationistPlan` exists, unwired to pane | Codex `01a10e41` 13:48 assistant | to verify (C) |
| 4 | Agent ETA for Luna+HITL wiring: 60–90 min (+30–60 PDF content) | Codex `01a10e41` 13:48 | estimate, not measured |
| 5 | Backend thread `01a1073a` consumed ~33h of active 15-min bins, 9,212 tool calls | `/tmp/retro/codex-2026-10-04T14-03-30-01a1073a-*.md` activity section | supported (bin method overcounts sparse bins) |
| 7 | Codex coding threads were driven by the cheap Luna model | `turn_context` per thread: `01a10401` 59× gpt-6.1-sol/high; `01a1073a` 97× sol/high + 3× medium; `01a10e41` 52× sol/high; `01a10e49` 21× sol/medium. Only Oct 2 `01a0fe7d` had 4 luna turns | **disputed → false**; slowness not explained by weak coding model |
| 8 | Product Luna adapter runs `reasoningEffort: 'max'` | `apps/server-pilot/src/ai/bedrock/luna.ts:10` (main) | supported; latency/cost driver to measure |
| 9 | Live HMS quote ≈ 3m40s per run after trace fix (was ~16 min) | `docs/solutions/logic-errors/hms-contextual-quote-partial-and-slow-trace.md` Verification | supported; PMS must be out of the classify/extract backtest loop |
| 19 | Luna single structured classify+extract call latency: low 3.8s (317 reasoning tok), medium 6.1s, high 7.2s, **max 22.7s (3,799 reasoning tok)**; all classified `quote` correctly | Measured 2026-10-06 ~20:20 UTC, synthetic email, script `/tmp/retro/luna_latency.py` (n=1 per effort; indicative only) | supported; `max` effort + multi-call extractor explains ~100s/case, model itself is fast & cheap (~$0.0005/call) |
| 20 | Schema ambiguity: `adults` per-room vs total flipped (low/medium=2 per room, high/max=8 total) | same run | supported → schema must name `adults_per_room` explicitly |
| 10 | External: well-defined classify/extract → one schema-constrained LLM call inside deterministic workflow beats agent loop | [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) "workflows… predictability and consistency for well-defined tasks" | supported (Exa X1) |
| 11 | External: eval sizes — 100 traces for error discovery, ≥30 self-annotated; code evals for objective fields; LLM judge needs 100–200 labels per failure mode | [Husain & Shankar, 2026-09-01](https://hamel.dev/blog/posts/evals-faq/how-many-examples-do-i-need-for-an-eval.html) fetched directly | supported |
| 12 | External: 20 cases = smoke only; 50–100 before defining criteria; small splits diverge | [Eugene Yan, AlignEval](https://eugeneyan.com/writing/aligneval/); [Anthropic stats for evals](https://www.anthropic.com/research/statistical-approach-to-model-evals) | supported |
| 13 | External: exact-match/function-call accuracy for structured fields; judges only for semantic criteria | [OpenAI eval best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | supported |
| 14 | External: native PDF input (text+page images) fastest baseline; tables are a known weakness | [OpenAI PDF files](https://developers.openai.com/api/docs/guides/pdf-files/); [OmniDocBench](https://arxiv.org/abs/2412.07626) | supported |
| 15 | External: HITL = approve/edit/reject over actual tool args | [LangChain HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) | supported |
| 16 | Counter: reviewers over-rely on AI suggestions; explanations alone don't fix it | [Buçinca et al. CSCW 2021](https://dl.acm.org/doi/abs/10.1145/3449287) | supported → per-field source quotes + missing/conflict flags + explicit confirm of critical booking fields |
| 17 | Counter: complex taxonomies needed hierarchical prompting (SIXT 70→90% L1) | [SIXT/AWS deck](https://pages.awscloud.com/rs/112-TZM-766/images/GAI215-Hamburg-EN.pdf) | supported; our taxonomy is 3 classes so one call OK |
| 18 | Hospitality analog: email classify/extract/suggest for hotel booking specialists (30 min → 15 s on a task) | [STX Next / Tour Partner Group](https://www.stxnext.com/case-study/tour-partner-group) | supported (vendor PoC) |
| 21 | Time split Oct 2–6: 44.5 wall-clock active h = 13.75 useful-now / 8.5 long-term / 14.25 overbuilt / 8.0 steering | A §1–2 (15-min tool-call bins + labelled blocks) | supported (labelling is judgement) |
| 22 | Pane attachments hard-coded `bytesPresent:false` → route returns `missing_source` → emails with attachments skip analysis | main `quote-workflow-synced-selection.ts:113`, `trpc/routes/quote-workflow.ts:54` (verified directly) | supported |
| 23 | Main has compact Luna agent `reservationist-agent.ts` (decision schema quote/create/skip/spam/other + `CENTURION_HOTEL_RULES`), used only by backtest; main worker has no reservationist | C; verified lines 27–58 | supported |
| 24 | ~~Azure Luna adapter only uncommitted in feature worktree~~ **Corrected 23:15:** `createAzureLunaModel` (`luna.ts:90`) + `LunaModelAdapter` (`:106`) ARE on main; only the reasoning-effort option (`lunaProviderOptions`) is uncommitted in `luna-mvp`. Main default factory `createLunaModel` uses Bedrock (payment errors per docs/solutions) | C, D, direct `git show HEAD:` check | supported (corrected) |
| 25 | Create reservation is lab-only (`create-lab-stay.mjs` saves then cancels; `--stop-before` dry-run); needs roomType/ratePlan/track/sourceOfBusiness/guaranteeType that emails rarely carry | C, B | supported |
| 26 | Volume per working day: inbound ~150–180; quote requests in ~6 (4–8); new-booking requests ~10 (8–14); confirmations sent 13.4; quotes sent 3.8. "~10 quotes/day" unsupported | B (Oct 3 22:34–22:57 Cursor `d2499be3`/`74b47470` table + 846-week AI review) | supported ±40%, not human-adjudicated |
| 27 | Phase B create 0/10 causes: ~5 mislabelled; PMS codes absent from email; agent asked customers for codes; no voucher PDFs; lenient scorer | B | supported |
| 28 | Sep 18–23 Luna extraction lab: 0 invented money/occupancy over 252 rows; schema-valid 355/355; abandoned for agent-loop design | B | supported (no accuracy % measured) |
| 29 | Luna-only extraction ≈ 8s median/case; with live PMS 237.5s median | D (Phase B summary) | supported |
| 30 | Plans: ~31.5k words in 4 days; 10-04 plan 15.5k words, 7 gates; eval/provenance 18–31% of text | D | supported |
| 6 | Staff installer 1.0.13 blocked by Edge "Virus detected"; Defender CI scan clean; unresolved | Codex `01a10e41` 14:11–19:58 | supported; deployment risk |
