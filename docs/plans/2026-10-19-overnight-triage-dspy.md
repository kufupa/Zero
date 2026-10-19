# Overnight 2026-10-19: leak-free triage prompt → ship → Da Vinci check

Owner asleep. One Opus orchestrator, Luna workers. Ship fast; measure before optimising. Read this file, `PRODUCT.md`, `AGENTS.md` (gates + VPS limits), `docs/context/MISTAKES.md` once. No other startup reading.

## Done (all must print in the final message)

1. Frozen test set built from Centurion 2026-09-09 10:00Z → 2026-10-16 14:00Z, inbound-only input, silver labels from outbound evidence.
2. Score table: current prod C prompt (leak-free input, run ×2) vs new prompt, per class, on the same frozen test rows.
3. Best prompt so far merged (see Ship rule: beats baseline = ship, then keep improving). One deploy at the end, plus any mid-run deploy that a prod backtest needs. Owner's deploy approval comes in the executing chat.
4. Live proof after deploy: new extractor version on new Centurion inbound; one quote-class inbound gets a prepared `read_tool` that succeeded.
5. Da Vinci transfer score (ayanda + faith mailboxes) with the shipped prompt, report only.
6. ETA ledger row closed. `ACTIVE.md` updated. Disagreement file listed for the owner.

## Facts (checked 2026-10-19 ~02:20Z, read-only)

- Centurion `message`: 9,637 inbound / 3,830 outbound, 2026-07-27 → now. `message_id_header`, `references` on ~all rows; `in_reply_to` on ~36% inbound.
- Da Vinci ingested so far: `transport-ayanda` 68 in / 9 out, `transport-faith` 75 in / 27 out, from 2026-10-16. `davinci@`, kmgidi, epick: no transport seen.
- Labels: owner 12, agent ~398, model ~423. Owner gold = spot check only (owner, 2026-10-19).
- `MAIL_ACTIONS` (9): no_action, quote_availability, new_booking, amend, cancel, payment_proof, billing, group_event, other_actionable. **Freeze for tonight.**
- Leak: `ACTION_CLASSIFICATION_RULES` (`src/ai/extraction/extract.ts:68`) + schema read "prior and next" thread messages (`extract.ts:191`, `schema.ts:34`). Must become prior-only.
- No DSPy in repo or Python env. `/home/orca/Documentation-Agent/data/centurion-corpus-threads.json` = Aug 30 snapshot, no direction/dates → **do not use**.
- Prod: `HMS_QUOTE_PREPARE=true`, `HMS_JOB_QUEUE=on`; HMS browser on 127.0.0.1:19223 (nohup, not systemd); 64 `read_tool` succeeded since 00:09Z. ~813 `inbound_extraction` queued/retry.
- PR #364 P1 confirmed: gold window + staff-outbound filter applies to every transport → Da Vinci workflow folders empty.

## Method (why it's fast)

- **Silver labels = owner rule 2026-10-14**: outbound first, else two models agree, disagreements to owner.
  - Deterministic first: next staff outbound attachment `HRCEN_confirmation*` → booking exists (new_booking if no prior confirmation in ancestors, amend if there is); quote xlsx/pdf and no confirmation → quote_availability; POP in inbound → payment_proof; >12 guests → group_event (owner 2026-10-19).
  - Then Luna and Sol each label with full evidence (ancestors + inbound + attachments + next staff reply ≤7 days). Agree → silver. Disagree → out of train/test, into `disagreements.jsonl`.
- **Inference input = prod input**: target inbound + attachment text via prod `readQuoteAttachments` (skip `image0xx` etc.) + RFC ancestors (`in_reply_to`/`references`) received before the target, earlier staff mail included. Never the reply. Never later messages.
- **Size, not 10k**: sample ~1,200 inbound (cap 3 per thread, all rare-class rows). Frozen test 400 stratified (≥25 per class or all). Val 200. Train pool rest. Learning curve at 100/200/400 train; stop adding data when flat.
- **Secondary field `response_mode`** (excel_quote | pdf_quote | inline_text_quote | hms_proforma | hms_confirmation | none) from outbound. Predict it inbound-only as a second output. If ≥90% on test, it becomes the sub-route (Excel vs HMS-provisional). Owner's quote-xl / quote-hms split gets decided by data, not argument.
- **Measure first**: if the leak-free baseline plus quote-feedback rules already clears the bar, skip DSPy.

## Ship rule (owner 2026-10-19: ship decent, then improve; Da Vinci = reward, not filler)

- **Ship first, always.** Ship the first working leak-free prompt even if it misses the bar or doesn't beat baseline (the old prompt leaks future mail, so its score is inflated). Only hard blocker: parse failures >1% or a crash. Then keep shipping each improved round. Never stall in an improve loop.
- **Score changes the next steps, not whether we ship**: big gap on a class → that class's errors first; near target → small prompt rules; at target → Da Vinci.
- **Target bar** (money classes quote, new_booking, amend, cancel, payment_proof): ≥90% precision each; quote + new_booking recall ≥95%. Owner scale 80 decent / 90 good / 95 production.
- **Below target → improve loop, not stop.** Each round: confusion matrix on val → read 20 worst errors → name the cause, then fix the cheapest matching thing:
  - silver label wrong → fix the labeling rule, relabel the affected rows
  - missing input (attachment text, ancestors) → fix the context builder
  - class boundary unclear → add a rule or example to the prompt
  - genuinely ambiguous → mark needs_you overlay, drop from precision scoring
  then rerun DSPy. Ship each round that improves.
- **Round budget = stop rule, not a count.** Stop optimising when: target met, OR 2 rounds in a row gain <1pt macro-F1 on val (plateau), OR the 7h wall clock leaves only enough time for deploy + proof. One round ≈15 min (D3 measures the first one and re-quotes the ETA).
- **Da Vinci starts only after Centurion hits target or plateaus.** At plateau-below-target, report the top error causes instead of moving on.

## Lanes (disjoint files, own worktree from `origin/main` each)

| Lane | Who | Files | Starts | Raw est. |
|---|---|---|---|---|
| D1 dataset export (EC2 via SSM, read-only, JSONL to S3 private prefix → VPS; PII local only, never git) | Opus | `apps/server-pilot/scripts/triage-dataset/*` (new) | t0 | 35m |
| D2 silver labels (Luna + Sol, parallel, 15M TPM) | Luna workers | `.scratch/triage/*` (data, untracked) | after D1 | 20m |
| D3 baseline ×2 + DSPy (GEPA or MIPROv2, ≤4 rounds × ~15m) | Opus driver | `evals/triage-dspy/*` (new, uv venv) | after D2 | 75m |
| C1 prior-only context builder + drop "next messages" | Luna max | `extract.ts`, `inbound-run.ts`, `schema.ts` + tests | t0 | 45m |
| C2 #364 P1: gold window + outbound filter only for `transport-centurion` | Luna max | `workflow-folders.ts` + tests | t0 | 25m |
| C3 port winning prompt → `ACTION_CLASSIFICATION_RULES`, bump extractor version | Luna max | `extract.ts` | after C1 + D3 | 30m |
| R deploy + flags + proof (end only) | Opus | ops | after C2 + C3 merged | 40m |
| V Da Vinci transfer score | Opus | evals | after C3 | 20m |

Gates per PR: remote typecheck, targeted tests on EC2 (never VPS Vitest), `greptile review --apex`, **max 3 rounds** (aim 1–2); after that validate each P1 (real prod path today?) and fix or note it. Never merge with an unvalidated P1. Bigger PR by accident is fine.

**Git hygiene (owner 2026-10-19):** commit + push every green step; PR → merge as soon as gates pass; several merges per deploy fine. After merge: `git worktree remove <path>` + delete the local branch. Every worktree branches from fresh `origin/main`. Never stash on the shared stack. End of run: `git worktree list` shows only `oct18-c1-classify`, `oct18-c2-hms`, `ec2-disk-retention`.

**Deploy:** only when it helps (backtest on prod data, or the end). Merged-but-undeployed is fine overnight.

**LLM concurrency:** one shared async runner (asyncio semaphore, start 32 in flight, raise until 429s or ~12M TPM of the 15M Luna cap). Batch by row, retry on 429 with backoff, write JSONL as results land so a crash resumes. No queue infra. DSPy: `num_threads` = same semaphore budget.

## Quote feedback → rules tonight (classifier only)

- Child ages missing → needs_action overlay, still quote_availability.
- Discount codes / corporate-rate elevation / tagging a colleague → needs_you overlay, class unchanged (owner case 4 stays no_action if the owner set it).
- Forward to a group colleague ≠ group by itself; >12 guests = group_event.
- One gold row per latest inbound; whole thread is context.
- Staff price errors (e.g. the shuttle 3 nights vs 2) don't affect action labels. Never use outbound prices as a price answer key.
- Logged as asks, **not built tonight**: inline-text rates reply as a quote output; party lookup for "do we have a corporate rate".

## End-of-run deploy (only if the owner approved it in the executing chat)

Record last-good SHA → `ops-deploy.sh` (exit 1 on the dead-letter gate is expected; prove with SHA + `/health` + pm2) → `INBOUND_TRIAGE_CLASSIFIER` off (A) + `PANE_PRECLASSIFY` unset (D) on http/worker/ai-worker/remote-http with `/proc/<pid>/environ` checks → install `hms-slot@hrcen` systemd unit for the 19223 browser → live proof (Done #4).

## Stop rules

- **Timebox every step at its raw estimate ×1.5.** At the timebox, stop and ask: why is this slow? Am I over-engineering (extra infra, tests, abstractions)? What's the cheapest path that ships? Cut scope, log the cut in the run notes, keep going.
- Every number in this plan (1,200 / 400 / 32 in flight / 15 min rounds) is a starting guess. Change it the moment data says otherwise and note why.
- Any step blocked >20 min: write it down, skip to the next lane.
- Round 3 with a fresh adjacent P1 = split or strip, no 4th round.
- No HMS writes. No email sends. Kill by PID only. No `pkill -f`.
