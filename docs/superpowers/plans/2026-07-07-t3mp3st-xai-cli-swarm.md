# T3MP3ST XAI cli-swarm — autonomous execution

> **For agentic workers:** REQUIRED SUB-SKILL: overnight-autonomous-execution + overnight-autonomous-zero overlay.

**Goal:** Ship XAI-backed cli-swarm wrapper and run overnight EC2-pilot code audit without Codex.

**Architecture:** Patch vendored cli-swarm (`--backend xai`) + `xai-repo-agent.mjs` read-only tool loop + `overnight-swarm.mjs` progressive report.

**Tech Stack:** T3MP3ST (vendored AGPL), Node ESM, xAI grok-4.3, bash wrappers.

## Global Constraints

- No production code edits in `apps/server-pilot` / `apps/mail`
- No AWS prod probes in cli-swarm path
- `XAI_API_KEY` from repo `.env`
- Agent babysits T3MP3ST only — does not manually audit

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions. RCA → fix → resume.

### Communication

Orchestrator + subagents: terse; technical terms exact.

### Done criteria (binary)

- [x] U1 xai-repo-agent + selftests
- [x] U2 cli-swarm patch + install.sh
- [x] U3 overnight-swarm.mjs
- [x] U4 package.json / README / missions
- [x] `pnpm t3mp3st:swarm:overnight` completes (pass 1 + pass 2 full squad)
- [x] Gate report: `docs/superpowers/plans/handoff-reports/2026-07-07-t3mp3st-cli-swarm-gate-report.md`

---

## Execution log

- Pass 1: 5 specialists, CLEAN, 6.6min
- RCA: tool rounds 20→35 after authz cap hit
- Pass 2: 10 specialists full squad, CLEAN, 13.4min
