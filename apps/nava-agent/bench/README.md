# Historical replay bench

Replay scores the draft produced on historical mail with dated HMS reads. It
does not run the pane API, Prepare, Go, or Save. Use the deployed scoreboard
for staff completion and native write/readback accuracy.

From `apps/nava-agent`:

```bash
npx tsx bench/cli.ts run --cases holdout-v3 --property HRCEN --concurrency 10 \
  --model gpt-6-luna --reasoning low --out /tmp/nava-replay
npx tsx bench/cli.ts rescore /tmp/nava-replay --gold-file /path/to/gold.json \
  --out /tmp/nava-rescore
env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS -u TEST_DATABASE_URL \
  npx tsx --test bench/bench-honesty.test.ts
```

Both modes accept `--cases-dir`, `--gold-file`, `--world-dir`, `--skills-dir`,
`--out`, `--model`, `--reasoning`, `--concurrency`, `--case-ids id,id`, and
`--property`. Use `--exclude-labtest` for production-mail scoring; it filters only
the selected message. Custom sets need a gold file. Named sets use the v5 overlay by
default. Rescore preserves recorded inference provenance and cannot repair
what the model saw in a historical run.

The default world is `$NAVA_BENCH_DATA_ROOT/world` (under
`~/.local/share/zero/bench/replay-bench-20261119/` if unset). A custom world
takes an `anchors.jsonl` and optional dated `profiles.json` and `catalog.json`.
Use `AZURE_FOUNDRY_API_KEY` for Azure Responses. Luna uses the existing replay
price estimate; set `NAVA_BENCH_USD_PER_MTOK=input,cached,output` to price
another deployment in USD per million tokens. Unknown prices stay null.

`scoreboard.json` has micro and workflow macro ROI, knowable field accuracy,
safety counts, and coverage. `gepa_feedback.jsonl` has one row per case. A
missing dated HMS record means unobserved coverage; it does not prove the
booking or document was absent. Case cards and gold still require human
adjudication where mail, staff outcome, and expected action disagree.
