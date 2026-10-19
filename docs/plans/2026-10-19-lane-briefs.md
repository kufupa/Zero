# 2026-10-19 lane briefs (afternoon)

Coordinator: the Opus main chat (`oct18-c1-classify`). Every lane reads this file, then its own plan file. Owner approvals come from the owner in the coordinator chat and are relayed here; a lane never deploys.

## Rules for every lane

- Read `PRODUCT.md`, `AGENTS.md` (Limits, VPS resources, Gates), `docs/context/MISTAKES.md`, then your plan. Don't re-research settled facts (`docs/context/FACTS.md`). Da Vinci HMS secret exists: `nava-zero/server-pilot/infor-hms-read-davinci`.
- **Start coding at once.** The plan is approved. List unchecked facts as assumptions in your PR body instead of stopping to verify them.
- **Never on this VPS:** `tsc`, `tsgo`, any typecheck script, Vitest or any test runner (it froze the box twice). Typecheck: `bash /home/orca/bin/remote-typecheck.sh <worktree>`. Targeted Vitest: `bash /home/orca/bin/remote-vitest.sh <worktree> <test files>` (EC2). `node --test` on a single `.mjs` file is OK. Before any Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`.
- **Never:** drive live HMS, SSM changes, deploy, flag/env change, email, HMS write, `--no-verify`, `git stash`, `pkill -f`, new GitHub workflow. Live probes and deploys are the coordinator's.
- One behaviour per PR, ≤ ~500 product lines. Branch from `origin/main`.
- Gate before you report "ready": commit → `greptile review` in the repo checkout → fix or validate every P1 (2 rounds max; round 3 with a fresh adjacent P1 = split or redesign). Push, open the PR, say "READY #<n>" with the Greptile result and what's still unproven. The coordinator merges.
- No PII in git, PR text or prompts to outside services (guest/staff names, emails, confirmation numbers → roles or hashes).
- Report in plain words: what shipped, what's left, the next check.

## Lanes

| Lane | Worktree | Agent | Plan | Done = |
|---|---|---|---|---|
| E add-in 1.0.18 | `oct19-addin-1018` + clone `/home/orca/work/nava-outlook-addin-1018` | Grok 4.6 high (Cursor) | `docs/superpowers/plans/2026-10-19-outlook-addin-1-0-18-lee-hardening.md` + `docs/plans/2026-10-19-lane-addin-1018-haiku-plan.md` (its amendments 1–12 are approved) | add-in PR green on the Windows installer build, then Zero pin PR READY |
| F HMS session reuse | `oct19-hms-reuse` | Grok 4.6 high (Cursor) | `docs/plans/2026-10-19-hms-session-reuse.md` slices 1–3 | F1 PR READY + a read-only probe script the coordinator runs on EC2; then F2, then F3 |
| G Da Vinci slot | `oct19-hrdav-slot` | Grok 4.6 high (Cursor) | same plan, slice 4 | PR READY (cherry-picks of `feat/oct18-hms-slots` 4a) + an `hms-slot@hrdav` env/unit change written as a script for the coordinator to run |
| B party eval | `oct19-party-eval` | Grok 4.6 high (Cursor) | `docs/plans/2026-10-19-lane-party-eval-haiku-plan.md` | wrong-bind count + miss-cause table in `docs/research/` |
| C ship small | `oct19-ship-small` | Luna max (Claude Code, sonnet slot) | `docs/plans/2026-10-19-lane-ship-small-haiku-plan.md` | W PR READY (remote-http `HMS_QUOTE_PREPARE`); S waits for owner decision 118 |
| D triage holdout | `oct19-triage-gepa` | Luna max (Claude Code, sonnet slot) | `docs/research/2026-10-19-chat-d-triage-gepa-plan.md`, picks `1B 2A 3A 4A`, budget ≤ $26 | gate result on the Aug–Sep holdout; PR only if it beats v4 outside the noise band with zero actionable→no_action on quote/new_booking |

Shared file: F2 and G both touch `pane-party-lookup.ts`. G merges first; F2 rebases on it.
