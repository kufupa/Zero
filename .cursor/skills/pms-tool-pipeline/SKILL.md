---
name: pms-tool-pipeline
description: >
  Use when building a new Centurion Infor HMS tool end to end (party lookup,
  quote, create, any new PMS CLI), when asked to "run the pipeline", or when a
  stop-hook follow-up says "pms-pipeline <tool>: verify FAIL".
---

# PMS tool pipeline

Done = `pipeline.mjs verify` PASS. Not the builder's opinion. Not test count.

## Run

1. Start: write `.private/pms-pipeline/ACTIVE.json` = `{"tool":"<tool>","conversationId":"<this chat uuid>"}`. **Required:** pin `conversationId` up front. Hook never first-claims — other chats in same worktree cannot steal the loop.
2. Loop: `node apps/server-pilot/tooling/pms-pipeline/pipeline.mjs next <tool>` → open card it names → do it → stop.
3. `status <tool>` = every check. `verify <tool>` = JSON.
4. Stop hook re-runs verify only when stop `conversation_id` matches ACTIVE. Fail → auto follow-up. PASS → `DONE.md`.
5. End run: delete `ACTIVE.json`.

## Stages

| # | Card | Output in `.private/pms-pipeline/<tool>/` |
|---|---|---|
| 0 | `stages/00-setup.md` | `pipeline.json` |
| 1 | `stages/01-docs.md` + `stages/implications.md` | `01-docs.json`, `implications.json` |
| 2 | `stages/02-corpus.md` | `02-corpus.json` |
| 3 | `stages/03-screen.md` | `03-screen.json` + `png/` |
| 4 | `stages/04-freeze.md` | `field-map.json`, `04-review.json` |
| 5 | `stages/05-build.md` | schema + CLI + tests (repo) |
| 6 | `stages/06-prove.md` | `06-prove.json` + pngs |
| 7 | `stages/07-backtest.md` | `07-backtest.json` |
| 8 | `stages/08-grade.md` | `08-grade.json` |
| 9 | `stages/09-wire.md` | `09-wire.json` |

Tool seed cards: `tools/<tool>.md` (demand, docs URLs, known keys).

## Who

| Job | Who |
|---|---|
| Code, schema, cards, git | This chat. Never clicks HMS |
| Screen walk, real-stay reads | Astra xhigh: `codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh` |
| Map review, final live grade, "not in HMS" search | Astra high, fresh session: `-c model_reasoning_effort=high`. Brief = `grader.md` |
| Png-vs-claim + miss-class review (files, no browser) | `gpt-6-sol` xhigh, fresh. Brief = `grader.md` Sol section |
| Mail → tool input | `gpt-6-luna` effort max, batches of 7 |

Astra = computer use only. Anything that reads files without the live screen is Sol or Luna.

Click rails + traps: `.cursor/skills/building-hms-playwright-tools/` (load at stages 3, 6, 8).

## Stop (write `STOP.md`, first line `reason: <x>`)

| reason | When |
|---|---|
| `dangerous_click` | Next click = Save / Check Availability / Reserve / Shop by Day / charge / cancel on non-lab stay |
| `hms_down` | Maintenance (Wed) or site unreachable |
| `login_dead` | Credentials rejected |
| `model_rejected` | Codex slug refused |
| `human_decision` | Real product choice only user can make |

Hook also stops itself: same failure 3×, or a `stop` check (`corpus.key.min`).

## Safety

- Real stays read-only. Writes only far-future lab stays. One Chromium, one SSM tunnel.
- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests. Never pilot RDS.
- `.private/` never committed. No PII in Astra/Luna briefs: pass file paths.
