# T3MP3ST War Room overnight — EC2-pilot full audit

> **Superseded for full stress execution by:** [2026-07-09-t3mp3st-warroom-full-stress.md](./2026-07-09-t3mp3st-warroom-full-stress.md) (all 8 operators, grok-4.5, 8h budget). This file remains historical reference for the 2026-07-08 run.

> **For agentic workers:** REQUIRED SUB-SKILL: overnight-autonomous-execution + overnight-autonomous-zero overlay. **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development only if tooling RCA needs code in `tools/t3mp3st` (never `apps/**`).

**Execution posture:** Overnight autonomous — user unavailable; implement-fix-loop until done criteria green.

**Goal:** Run full T3MP3ST War Room + cli-swarm against EC2-pilot production surfaces with XAI (`XAI_API_KEY` from repo `.env`). Document all findings in progressive markdown. **Do not modify production application code** (`apps/server-pilot`, `apps/mail`).

**Architecture:** Local War Room (`:3333`) + xAI grok-4.3 backbone; SSH/SSM tunnel or loopback target to EC2 server-pilot (`:8788`) + frontend (`:3000`); parallel read-only `cli-swarm --backend xai` on monorepo scope.

**Tech Stack:** T3MP3ST vendored AGPL, Node ESM, xAI grok-4.3, AWS SSM, EC2 pilot.

## Global Constraints

- **No production code edits** in `apps/server-pilot/**` or `apps/mail/**`
- Tooling-only fixes allowed under `tools/t3mp3st/**` if War Room / swarm fail to start
- `XAI_API_KEY` from repo `.env` (already present)
- Authorized target: **own** EC2 pilot (`i-008f737974a9ba9b3`) — user explicitly authorized overnight War Room against production pilot
- No force-push, no `--no-verify`, no destructive git
- Do not print secrets (DB URLs, auth secrets) into reports

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |
| Backend (prod) | `http://127.0.0.1:8788` on EC2 (PM2 `http`) |
| Frontend | `http://127.0.0.1:3000` on EC2 (start if down) |
| War Room | `http://127.0.0.1:3333/ui/` (local) |

**Allowed:** SSM health, start/restart PM2/nginx FE if down, local War Room server, approve War Room mission receipts for **own** pilot loopback/tunnel targets, cli-swarm + decompose, progressive markdown reports.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, modifying `apps/**` production code, attacking third-party hosts.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix (**tooling only**) → test → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [x] EC2 server-pilot healthy (`curl http://127.0.0.1:8788/health` via SSM / tunnel :18788 → 200)
- [x] Frontend reachable on EC2 `:3000` (tunnel :13000 → 200)
- [x] War Room server up locally (`:3333`) with XAI configured
- [x] Live War Room mission launched — **SHADOW MERIDIAN** (Admiral LIVE) against tunnel targets
- [x] cli-swarm Pass 1 complete — **CLEAN** (10 specialists, 2 rounds, 10.7min)
- [x] cli-swarm Pass 2 deep sweep — **CLEAN** (10 specialists, 2 rounds, 7.3min) + decompose regression complete
- [x] Progressive findings markdown written for morning review
- [x] Handoff report under `docs/superpowers/plans/handoff-reports/`
- [x] **Zero** production app code modifications (`apps/**` untouched)
- [x] Overnight-continue: executive OPEN/FIXED table distilled; AgentLoop maxIterations 15→40; focused relaunch; decompose report path fixed to 2026-07-08

## Execution Mode

Autonomous overnight — no user checkpoint. Do not ask "which approach?"

## Report paths

| Artifact | Path |
|----------|------|
| Progressive War Room findings | `docs/superpowers/plans/handoff-reports/2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md` |
| cli-swarm audit | `docs/superpowers/plans/handoff-reports/2026-07-08-ec2-pilot-t3mp3st-cli-swarm-audit.md` |
| Morning handoff | `docs/superpowers/plans/handoff-reports/2026-07-08-t3mp3st-warroom-handoff.md` |

## Wave

```text
1. Restore tools/t3mp3st wrapper if missing (stash/tooling only)
2. configure.sh + test-llm (XAI)
3. SSM: ensure PM2 http :8788 + FE :3000
4. SSH/SSM tunnel or local proxy → 127.0.0.1:8788/3000
5. Start War Room server; approve mission; launch recon/scanner/analyst
6. Parallel: overnight-swarm.mjs full squad (pass1 + pass2)
7. Poll findings APIs; append markdown progressively
8. Handoff report when green / budget exhausted
```
