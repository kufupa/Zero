# T3MP3ST XAI cli-swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: overnight-autonomous-execution. Steps use checkbox syntax.

**Goal:** Run T3MP3ST cli-swarm overnight on EC2-pilot code using XAI grok-4.3 (no Codex), read-only, PR-ready wrapper.

**Architecture:** Minimal patch to vendored `cli-swarm.mjs` adds `--backend xai`; repo-owned `xai-repo-agent.mjs` implements read-only tool loop; `overnight-swarm.mjs` drives progressive markdown report.

**Tech Stack:** T3MP3ST (AGPL vendored), Node ESM, xAI chat completions + tools, bash wrapper scripts.

## Global Constraints

- No edits to `apps/server-pilot` or `apps/mail` production code from audit
- No production AWS / live network probes in cli-swarm path
- `XAI_API_KEY` from repo root `.env`
- Vendor stays gitignored under `tools/t3mp3st/.vendor/`

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. RCA on failure → fix → resume.

### Done criteria

- [ ] `pnpm t3mp3st:swarm:test` green
- [ ] `pnpm t3mp3st:test-llm` green
- [ ] `pnpm t3mp3st:swarm:overnight` running or completed with report
- [ ] Gate report written

---

### Task 1: xAI repo agent

**Files:** `tools/t3mp3st/scripts/lib/xai-repo-agent.mjs`, `scope-allowlist.mjs`, selftest, `fixtures/mini-repo/`

- [x] Read-only tools + scope allowlist
- [x] Selftest offline

### Task 2: cli-swarm patch

**Files:** `patches/cli-swarm-xai-backend.patch`, `install.sh`

- [x] `--backend xai` + `T3MP3ST_WRAPPER_ROOT`
- [x] `test:swarm` passes

### Task 3: Overnight orchestrator

**Files:** `scripts/overnight-swarm.mjs`, `package.json` scripts

- [x] Progressive report path
- [ ] Full overnight run

### Task 4: Docs

- [x] README, missions, `.env.example`
- [ ] Gate report
