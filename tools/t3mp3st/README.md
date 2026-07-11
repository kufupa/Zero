# T3MP3ST (red-team harness) — EC2-pilot

Isolated wrapper around [T3MP3ST](https://github.com/elder-plinius/T3MP3ST). Does **not** join the pnpm workspace or modify `apps/server-pilot`.

## LLM backbone

| Setting | Value |
|---------|--------|
| Provider | `xai` (`XAI_API_KEY` in repo `.env` or `tools/t3mp3st/.env`) |
| Model | `grok-4.5` (1M ctx) |
| Reasoning | `reasoning_effort=high` |

Patches applied on `pnpm t3mp3st:install`:
- `patches/reasoning-effort.patch` — War Room / decompose
- `patches/cli-swarm-xai-backend.patch` — `--backend xai` for cli-swarm (no Codex required)

## Quick start

```bash
pnpm t3mp3st:install
pnpm t3mp3st:configure
pnpm t3mp3st:test-llm          # xAI smoke test
pnpm t3mp3st:swarm:test        # offline self-tests + cli-swarm self-test
pnpm t3mp3st:swarm:overnight   # full EC2-pilot code audit (hours)
```

Overnight report: `docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md`

**Codex not required.** cli-swarm uses `scripts/lib/xai-repo-agent.mjs` (read-only `read_file` / `grep` / `glob` tools + grok-4.5).

## War Room (separate session)

Runtime / black-box probes against local API — use a different overnight run if desired:

```bash
pnpm t3mp3st:server   # → http://127.0.0.1:3333/ui/
pnpm dev:backend      # optional :8787 target
```

Scope: `missions/ec2-pilot-scope.md`

## Manual cli-swarm

```bash
export T3MP3ST_WRAPPER_ROOT="$(pwd)/tools/t3mp3st"
node tools/t3mp3st/.vendor/T3MP3ST/scripts/cli-swarm.mjs \
  --repo . --backend xai --model grok-4.5 --effort high \
  --solo --rounds 1 --budget-min 10
```

## Files

| Path | Purpose |
|------|---------|
| `.vendor/T3MP3ST/` | gitignored upstream clone |
| `scripts/lib/xai-repo-agent.mjs` | xAI read-only repo agent for cli-swarm |
| `scripts/overnight-swarm.mjs` | progressive markdown + cli-swarm driver |
| `patches/*.patch` | vendored T3MP3ST tweaks |

## License

T3MP3ST is **AGPL-3.0**. Vendored copy stays under `tools/t3mp3st/.vendor/` only.
