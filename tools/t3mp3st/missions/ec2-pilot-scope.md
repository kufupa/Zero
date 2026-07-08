# EC2-pilot red-team scope (authorized local / staging only)

**Branch:** `EC2-pilot`  
**Codebase root:** monorepo root (this repo)  
**Primary surface:** `apps/server-pilot/**` (Hono + tRPC + mail ingest + auth)

## Authorized targets

| Target | URL / path | Notes |
|--------|------------|-------|
| Local API | `http://127.0.0.1:8787` (or `ZERO_EC2_PILOT_TARGET_URL`) | Only when you started server-pilot locally |
| Source review | `apps/server-pilot/src/**` | Static analysis, no prod |
| Prior audit | `docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md` | Regression check |

## Out of scope (do not probe)

- Production EC2 / RDS / real mailboxes unless explicitly authorized in writing
- Third-party hosts, customer data, unrelated `apps/server` Cloudflare worker prod
- Credential stuffing, destructive writes, or exfil of real secrets

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

T3MP3ST `cli-swarm` + xAI grok-4.3: specialists → skeptic → triage. Read-only. Report appends to `docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md`.

### 2. War Room (runtime probes — separate session)

1. `pnpm t3mp3st:server` → open http://127.0.0.1:3333/ui/
2. New operation → add target `http://127.0.0.1:8787` (type `api`, zone `internal`) if API is up
3. Mission objectives: paste objectives 1–4 above
4. Spawn **RECON** + **SCANNER** + **ANALYST** first; keep intrusive operators gated

## Reference

- T3MP3ST LLM backbone: provider `xai`, model `grok-4.3`, `reasoning_effort=high` via `tools/t3mp3st/.env`
- xAI docs: https://docs.x.ai/developers/model-capabilities/text/reasoning
