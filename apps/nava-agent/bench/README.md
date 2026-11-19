# Nava replay bench

Offline e2e bench: real nava-agent Azure/Luna loop + HMS twin. Zero live HMS.

## Data (gitignored / outside repo)

`/home/orca/.local/share/zero/bench/replay-bench-20261119/`

## Commands

```bash
cd apps/nava-agent
NAVA_AGENT_RUNTIME=azure NAVA_HMS_MODE=twin \
  pnpm bench --cases all --concurrency 20
```

Env: `AZURE_OPENAI_API_KEY` (never commit). Optional `BENCH_LIMIT`, `NAVA_BENCH_DATA_ROOT`.
