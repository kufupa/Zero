# EC2-pilot red-team scope (authorized local / staging only)

**Branch:** `EC2-pilot`  
**Codebase root:** monorepo root (this repo)  
**Primary surface:** `apps/server-pilot/**` (Hono + tRPC + mail ingest + auth)

## Authorized targets

| Target | URL / path | Notes |
|--------|------------|-------|
| Local API | `http://127.0.0.1:8787` (or `ZERO_EC2_PILOT_TARGET_URL`) | Only when you started server-pilot locally |
| EC2 pilot API (authorized overnight) | SSM tunnel → `http://127.0.0.1:18788` → EC2 `:8788` | Own instance `i-008f737974a9ba9b3` — user-authorized 2026-07-08 |
| EC2 pilot FE (authorized overnight) | SSM tunnel → `http://127.0.0.1:13000` → EC2 `:3000` | Start FE if down; no third-party hosts |
| Source review | `apps/server-pilot/src/**` | Static analysis / white-box |
| Prior audit | `docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md` | Regression check |

## Out of scope (do not probe)

- Third-party hosts, customer data, unrelated `apps/server` Cloudflare worker prod
- Credential stuffing, destructive writes, or exfil of real secrets
- RDS direct attacks / S3 bucket dumps outside app-mediated paths

## Mission objectives

1. Re-validate P2/P3 findings from the EC2-pilot security audit (HTML XSS seam, mailbox header trust, RDS TLS, auth shortcuts).
2. Trace trust boundaries: ingest → store → tRPC → signed URLs → auth middleware.
3. Document findings with file:line evidence; prefer read-only / local tools.
4. Cross-check new AI mail pipeline hooks (`apps/server-pilot/src/ai/**`, ingest enqueue) for scope leaks.

## Suggested flows

### 1. Overnight code audit (primary — no Codex)

```bash
pnpm t3mp3st:swarm:overnight
```

T3MP3ST `cli-swarm` + xAI grok-4.5: specialists → skeptic → triage. Read-only. Report appends to `docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md`.

### 2. War Room (runtime probes — separate session)

1. `pnpm t3mp3st:server` → open http://127.0.0.1:3333/ui/
2. New operation → add target `http://127.0.0.1:8787` (type `api`, zone `internal`) if API is up
3. Mission objectives: paste objectives 1–4 above
4. Spawn **RECON** + **SCANNER** + **ANALYST** first; keep intrusive operators gated

### 3. Full stress (all 8 operators — overnight autonomous)

```bash
pnpm t3mp3st:warroom:full-stress
```

- Objectives: `tools/t3mp3st/missions/ec2-pilot-full-stress-objectives.md`
- Plan: `docs/superpowers/plans/2026-07-09-t3mp3st-warroom-full-stress.md`
- Spawns all 8 archetypes (recon, scanner, analyst, exploiter, infiltrator, exfiltrator, ghost, coordinator) + Admiral LIVE
- Targets: SSM tunnels `127.0.0.1:18788` (BE) + `127.0.0.1:13000` (FE)
- Model: grok-4.5 + `reasoning_effort=high`; `TEMPEST_AGENT_MAX_ITERATIONS=80`
- Reports: `docs/superpowers/plans/handoff-reports/2026-07-09-*`

## Reference

- T3MP3ST LLM backbone: provider `xai`, model `grok-4.5`, `reasoning_effort=high` via `tools/t3mp3st/.env`
- xAI docs: https://docs.x.ai/developers/model-capabilities/text/reasoning
