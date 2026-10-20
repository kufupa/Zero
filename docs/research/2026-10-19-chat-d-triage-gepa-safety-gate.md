# 2026-10-19 Chat D triage holdout — preflight and execution status

**Status:** owner authorized D0–D6 on 2026-10-19 after correcting an accidental Pause selection. This is a preflight/status note, not a holdout result.

**Owner picks:** 1B (GEPA only if a gap remains after a hand-rule round), 2A (timebox through 13:15Z), 3A (Aug 1–Sep 8 holdout), 4A (>12 guests → `group_event` first). Budget: **stop before $26 at API price**.

## Owner clarification

The AskUserQuestion response “Pause at safety gate” was an accidental keystroke, not an owner decision. The owner explicitly authorized D0–D6 afterward. The “no PII to outside services” rule means third parties (Greptile, Exa, web, GitHub); the approved internal Luna/Sol gateway is in scope for this run. Mail content must not go to third parties or Git/PR text.

## Preflight facts

- Before the owner’s clarification, D0–D6 had not started: no classifier/GEPA inference calls and no EC2, SSM, or RDS calls. No code or production behavior changed.
- The frozen 431-row test has already been used to assess v5; it is not the clean Aug–Sep holdout required here. The Aug 1–Sep 8 thread-disjoint holdout remains to be generated and scored.
- No repository script implements Lane D D0–D6 end to end. The `triage-v5` runner evaluates a different workflow-category/urgency task, loads a production environment, and mutates a side checkout; it is not a substitute. The archived Luna launcher is a separate shard workflow, has no aggregate dollar cap, and uses an unsafe approvals bypass. Neither was run.
- `triage-dataset/export.ts` is a partial D0 component. It issues SELECT queries and writes compressed exports; the code does not declare an explicit read-only transaction or role. Execute only through the owner-approved remote path, with private output; do not load production env locally.
- `build-prompts.ts` and private Lane D scripts do not redact PII. Their use is authorized only for the internal Luna/Sol path in this run; do not send prompt/mail content to third parties or include it in Git/PR text.
- Private `llm.py` logs actual token usage but has no dollar cap. Use the owner’s prices and meter the logs during execution; stop before cumulative Lane D spend reaches $26.

## Spend accounting

For logged usage rows, calculate:

- Luna: `input_tokens × $0.10 / 1,000,000 + output_tokens × $0.50 / 1,000,000`.
- Sol: `input_tokens × $2 / 1,000,000 + output_tokens × $10 / 1,000,000`.

Before any Lane D inference call, spend was $0.00. The tool receipts for earlier bulk reads do not expose model route and input/output price splits, so this note does not claim an all-in session cost below $26.

## Execution status and limits

- D0 remote thread export completed: 3,083 threads, 4,802 messages, 712 labels, 0 extraction rows. Files were stored in private S3 with AES256 and copied to the private research directory.
- D0 header probe checked 45 broad local candidates (outbound messages with quote text in subject/filename and a PDF). All 45 existed as outbound PDFs in RDS; none had an inbound with the same thread ID in the queried window, only one had a non-empty `in_reply_to`/`references` field, and none linked to an inbound message ID among 3,609 inbound rows checked. This does **not** reproduce the plan’s exact 43-row target set, so treat linkage as unresolved rather than claiming 43/43 verified.
- D3 sample built from the Aug–Sep 8 export: 3,882 inbound candidates, 3,177 after thread cap, 977 rare rows, 1,500 sampled; 83 had a following outbound in the same thread. Selection export succeeded for 1,500/1,500 (no missing or failed rows).
- D3 prompt build succeeded on the approved EC2 checkout at `57b23c9659b`; the remote `build-prompts.ts` SHA-256 (`57f73121ea8c67f093a48e1f04a610cf1ad2c027ccadf56da5dffd0e5f6575f6`) matches local. Builder reported 1,500 prompts. Private download validation found 1,500 unique rows, exact ID parity with the sample, no schema errors, and valid prompt parts; data remains outside Git.
- A seeded, thread-disjoint split was prepared before labels: test 477 rows / 385 threads, validation 206 / 170, train 817 / 672. Scoring will intersect each split with labeled rows; test remains untouched.
- D3 labeling completed at concurrency 32: 1,500 Luna + 1,500 Sol rows; 1,374 silver labels and 126 disagreements. Luna had one JSON parse error; there were no API errors or 429s. Logged Lane D spend: Luna **$0.561841**, Sol **$9.179280**, total **$9.741121** at the owner's rates.
- D5 was not run because this prompt build omits production vision-image payloads (`EXTRACTION_VISION` is on in the overnight runtime record). The test split contains 436 silver labels from 477 sampled rows; 43 target rows have non-inline image-file attachments, across 51 image-bearing test threads. Excluding those threads leaves 359 silver rows but only 7 `quote_availability` labels, below the plan's expected ~10 quote targets in the holdout. The parity-clean subset is too small to support the planned quote-recall check, so no production classifier score or pass claim is valid from this run.
- D1, D2 adjudication, D4 hand-rule classifier round, D5 scoring and GEPA were not run. D4's owner rule is present in the label specification; this sample had zero deterministic quote-file / two-model `group_event` conflicts requiring a precedence override. GEPA remains conditional and is outside the remaining gate.
- Ledger-scaled estimates from 12:12:55Z: 56 minutes for the no-GEPA path; 96 minutes for the conditional GEPA path. The latter projects beyond the 13:15Z cutoff. The timebox takes precedence; GEPA will run only if a gap remains and the remaining time and budget allow.
- D0 export, selections and prompt construction used the overnight command family in `/home/orca/nava-research/triage-20261019/RUNLOG.md` on the approved remote EC2 path. The production environment was sourced only on EC2; local inference used the private Lane D virtualenv, never a production-env wrapper.
- No deployment, flag/env change, HMS write, email, or GitHub Actions run is authorized by this lane.

## Evidence reviewed

Prior evaluation and holdout context: [2026-10-19 leak-free triage eval](2026-10-19-leak-free-triage-eval.md) and [Lane D plan](2026-10-19-chat-d-triage-gepa-plan.md). Evaluator-path exclusions: `apps/server-pilot/scripts/triage-v5-run-stage-eval.sh:9-34,46-63,86-100` and `archive/lab-scratch/apps/server-pilot/scripts/centurion-eval-launch-luna.sh:17-38`. Exporter and prompt-building behavior: `apps/server-pilot/scripts/triage-dataset/export.ts:42-88,153-182` and `apps/server-pilot/scripts/triage-dataset/build-prompts.ts:73-89`. Private runner/logging behavior was checked in the Lane D `work/*.py` scripts.
