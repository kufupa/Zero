# Replay bench (offline HMS twin)

- **Twin** = reads + unsaved `hms_prepare` only. No cassette. No Save/readback simulation.
- **LLM** = Azure `gpt-6-luna` only (no Haiku).
- **Gold** = every pane field + all 118 Stay360 record-view fields + all 65 guest-profile fields; each `expected` / `not_expected` / `no_gold` with basis. Omit only via `omitted[]` + reason.
- **Score** = prefill pane fields + Prepare inputs + tool-call quality. Keep leak guard + cross-thread precision report.

```bash
# samples (Create + Amend cards)
cd apps/nava-agent/bench/cases && python3 rebuild_samples.py

# full 200 (parallel workers)
BENCH_CASE_WORKERS=24 python3 rebuild_all.py

# run
cd apps/nava-agent && BENCH_CONCURRENCY=20 npm run bench
```

Data root: `~/.local/share/zero/bench/replay-bench-20261119/` (gitignored dumps).
