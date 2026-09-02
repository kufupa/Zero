---
title: "feat: Nava dash live Hermes chat handoff"
date: 2026-08-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Nava dash live Hermes chat handoff

## Goal Capsule

After the fake analysis replay + dashboard, open **live chat inside Nava TUI** (dashboard stays above). Backend is Hermes `zero` profile (`gpt-5.6-luna`) via a **new seeded session** carrying the Nava dashboard context pack — not the giant 871-msg corpus resume (too heavy / wrong posture). Original Hermes session remains available for later forensics.

## Product Contract

### Requirements

- **R1.** After dash, Enter opens chat mode with dashboard still visible.
- **R2.** Chat replies come from live Hermes (`HERMES_HOME=.../profiles/zero`), branded as Nava in prompts/UI.
- **R3.** Seed session with crumpled corpus/dashboard context; persist session id under `.private/connected-mailbox-corpus/nava-hermes-session.id`.
- **R4.** Type + Enter asks; Esc clears draft; q quits when draft empty.
- **R5.** Do not resume `corpus_24491985_resume` for investor chat by default.

### Scope Boundaries

- In: bridge, context pack, TUI chat phase, smoke script, tests.
- Out: Hermes skin fork UI, Prime Gemini, renaming Hermes binary, full session DB fork tool.

## Planning Contract

### Key Technical Decisions

- **KTD1 — New seeded session, not full resume.** Verified live: seed + `--resume` retains context; full corpus session is 127+ msgs / wrong coding posture.
- **KTD2 — Embed chat in Nava TUI.** Same-terminal Hermes REPL would lose Nava chrome; quiet `hermes chat -Q` under Nava keeps dashboard + Nava branding.
- **KTD3 — zero profile via HERMES_HOME.** Fastest path; tools/model already configured; works as orca.

## Autonomous Execution Mandate

Execute this plan without routine user checkpoints. Prefer standard non-fast subagents; if unavailable, implement inline. Pilot-RDS safety overrides all test instructions. Do not force-push, amend pushed history, or bypass credentials. Goal complete only with evidence: unit tests green + hermes smoke seed/ask OK.

## Implementation Units

### U1. Context pack + Hermes bridge

Files: `apps/server-pilot/src/ops/nava-live-context.ts`, `apps/server-pilot/src/ops/nava-hermes-bridge.ts`, `apps/server-pilot/tests/nava-live-context.test.ts`

### U2. TUI chat phase

Files: `apps/server-pilot/src/ops/nava-demo-script.ts`, `scripts/nava-dashboard-tui.ts`, launcher/demo tests

### U3. Smoke

Files: `scripts/nava-hermes-smoke.ts`

## Verification Contract

- Vitest: live-context, demo-script, launcher
- `pnpm exec tsx scripts/nava-hermes-smoke.ts` → SEED_OK + ASK_OK
- Manual: `./scripts/nava` → Enter analysis → Enter chat → ask quarantine question

## Definition of Done

Investor can finish fake analysis, keep dashboard on screen, and chat live as Nava powered by Hermes zero profile.
