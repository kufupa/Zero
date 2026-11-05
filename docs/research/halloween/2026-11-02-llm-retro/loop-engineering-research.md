# Loop engineering: source note (2026-11-02)

**Bottom line:** Cherny posts = personal workflow, not controlled proof ([2026-01-02](https://x.com/bcherny/status/2007179832300581177); [2026-03-30](https://x.com/bcherny/status/2038454336355999749)). Anthropic’s long-run recipe = durable state + one increment/session + executable checks + review ([2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). “Max tokens → better code” unsupported; API defines cap as output ceiling ([undated docs; checked 2026-11-02](https://platform.claude.com/docs/en/api/messages)).

## 1. Cherny’s published workflow

- Likely “Boris Chunbi” means Boris Cherny (@bcherny). **2025-10-09:** points readers to Claude Code’s `feature-dev` multi-agent workflow ([primary Threads post](https://www.threads.com/@boris_cherny/post/DPmMRkekgub)). **2026-01-02:** reports 5 terminal + 5–10 cloud sessions; Plan-first; commands, subagents, formatting hook; long tasks → background verifier, Stop hook, or Ralph Wiggum loop ([primary X post](https://x.com/bcherny/status/2007179832300581177); [mirror transcript, same date](https://teapawt.org/bcherny/status/2007179832300581177)).
- Same Jan 2 post: normally avoids `--dangerously-skip-permissions`, pre-allowing known-safe commands; for hands-off runs, mentions `dontAsk` or bypass-permissions **in a sandbox**. Claims verification feedback yields “2–3x” quality; prefers Opus 4.5 with thinking. No sample/control/method → anecdote, not measured effect ([X, 2026-01-02](https://x.com/bcherny/status/2007179832300581177)).
- **2026-03-30:** `/loop` + `/schedule` for recurring prompts (up to a week); Git worktrees for parallel sessions; `/batch` fan-out for large parallelizable changes ([primary X post](https://x.com/bcherny/status/2038454336355999749); [mirror transcript, same date](https://xcancel.com/bcherny/status/2038454336355999749)). Workflow/product tips—not evidence for unchecked loops or better outcomes from “dozens/hundreds/thousands” of workers.

## 2. Anthropic: bounded long-run pattern

**2025-11-26** internal web-app experiment: compaction alone failed; sessions left partial work, lost state, or declared done early. Fix: initializer writes `init.sh`, feature list, progress log, initial Git commit; each resumed session rereads state, handles one feature, end-to-end tests, leaves clean commit + progress note. Practical guidance, not controlled multi-domain comparison ([primary engineering report](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).

Current Claude Code docs are **undated** (checked 2026-11-02): Manual mode asks before edits/commands; `bypassPermissions` only for isolated container/VM; built-in sandbox limits shell, not file tools/MCP/hooks; user owns review of code/commands ([security](https://code.claude.com/docs/en/security/), [permission modes](https://code.claude.com/docs/en/permission-modes), [sandbox scope](https://code.claude.com/docs/en/sandboxing)).

## 3. Independent evidence (early, bounded)

| Topic | Finding | Limit |
|---|---|---|
| Evals / review | **TestJack**, arXiv preprint (2026-10; day not exposed by fetched record): across 6 backends / 5 benchmarks, requirement-grounded audits refuted 1,545/4,487 trials marked correct (34.4%) ([paper](https://arxiv.org/abs/2610.10619)). **c-CRAB** (2026-03-24): review agents incl. Claude Code, Codex, Devin, PR-Agent collectively solved ~40% of tasks built from human PR reviews ([paper](https://arxiv.org/abs/2603.23448)). | Fixed tests and AI review miss requirements in these sets. Not universal production rates; does not prove human review suffices. |
| Loops / checkpoints | **Looping Is Not Reliability** (arXiv, 2026-07-27): 30 HumanEval repairs / 900 three-revision trajectories; forced revision: current correctness 82.0% after revision 1 → 67.3% after revision 2 ([paper](https://arxiv.org/abs/2607.24604)). **RippleCP** (2026-10-06): matched pilot, 12 SWE-bench Verified tasks / 106 recovery branches; first checkpoint saved 100 sec, next one step later lost 1.1 sec net ([paper](https://arxiv.org/abs/2610.09088)). | Revision can regress; checkpoint value depends on placement. Small benchmark pilots—not proof all loops/checkpoints help or harm. |
| Security / permissions | Microsoft-authored arXiv preprint (v2, 2025-08-23): 12,000+ OpenHands actions, 93 setup tasks, 5 backends incl. Claude variants; 21% trajectories had an insecure action; detector recall 61.1% ([paper](https://arxiv.org/abs/2507.09329)). | Supports least privilege, isolation, review; not Claude Code’s or all coding agents’ general safety rate. |

## 4. Token-maxing: unsupported

No source here isolates raising token cap as a coding-quality intervention. Anthropic defines API `max_tokens` as an **absolute output ceiling**; model may stop sooner—not a quality knob ([Messages API, undated; checked 2026-11-02](https://platform.claude.com/docs/en/api/messages)). Long-run article instead cuts rediscovery via setup scripts, state, small increments, tests ([2025-11-26 report](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). Cherny’s speed/quality preference remains anecdotal.

**Evidence class:** primary = Cherny’s posts, Anthropic docs/report, author-posted arXiv studies. Papers are preprints; findings early and scope-bound. Secondary mirrors (Teapawt, XCancel) supplied X text/date where direct fetch failed; substantive claims link originals. No secondary article used as experimental evidence.
