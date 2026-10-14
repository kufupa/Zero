# Active context (read first, every session)

Auto-loaded via `CLAUDE.md`. Keep under 120 lines. Update at the end of every work block: current focus, next steps, new mistakes. Task history goes in `docs/context/ledger/`, durable lessons in `docs/context/MISTAKES.md`.

**Product spec:** `PRODUCT.md` (owner-edited). This file is the run, not the spec.

## Product in one paragraph
Nava is an AI reservationist for Legacy Hotels' Centurion property. Staff work in classic Outlook. The VSTO add-in (`kufupa/nava-outlook-addin`) hosts a WebView2 side pane served from our EC2 (`apps/mail` route `/outlook-pane`). The pane analyses the selected email (Luna = the model, never shown to staff; staff-facing name is "Nava"). It pre-fills fields and runs deterministic Infor HMS tools through Playwright (`apps/server-pilot/tooling/playwright-quote/`): quote, PDF, party lookup, stay lookup, create (flagged), cancel (lab only). Human in the loop on every write.

## Current focus (2026-10-14 overnight run)
- **Scoreboard:** `/tmp/p2/SCOREBOARD.md` on the VPS (outside repo): golden-set score + per-item state, last-good SHA, rollback.
- Items: #214 dinner + alternatives; #211 pane clarity; channel skip (Profitroom, Tiket.com, H-Pay); party v2 live-picker eval (0 wrong binds, 57.9% auto-bind on 95 emails); quote ready on open (`HMS_QUOTE_PREPARE`); Luna-max classifier budget fix + 400-email eval; golden set v1 (~30 real emails, PRODUCT.md "Done").
- Research library: `docs/research/2026-10-13/README.md`. Do not redo it.
- Prod flags on: `PARTY_MATCH_V2`. Owner rules 2026-10-13/14: never Nova Lite; OTA/channel/system skipped at the door; travel agents stay in scope.

## Non-negotiable rules
- Never ask client staff to run scripts, PowerShell or terminals. Fix it in the product.
- Diagnostics first: for remote failures, ship error visibility before a fix. No fix without a confirmed causal chain.
- No real-guest HMS writes unless `RESERVATIONIST_PANE_SAVE=on` was set by the owner. The bot never accepts cancellation penalty dialogs.
- Before vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never run tests against pilot RDS. Never print secrets or `postgres://` URLs.
- One HMS browser owner at a time (property lock). Subagents never run live HMS.
- P0/P1 review findings are fixed before merge. Check the latest Greptile run is on the PR head SHA.
- Deploy only from `.worktrees/recover-parse-failure` (`git pull --ff-only origin main`), via `apps/server-pilot/deploy/ops-deploy.sh`.
- Every pane change is checked in a real browser (viewer run), not only with fake-client unit tests.
- A pane deploy reaches staff only when the pane reloads. Check her bundle load in nginx before claiming a fix is live.
- Never use `--no-verify`. A failing hook is a signal to fix, not skip.
- Unit tests cannot see the HMS DOM. Live-probe every HMS runner on EC2 before calling it done.

## Models
- Opus drives: briefs, merges, deploys, live HMS steps, user-facing claims, review of write paths, migrations and auth.
- GPT-6 Luna max implements in separate worktrees (codex exec); Haiku 5.5 max or Opus reviews critical hunks; Greptile on every PR.

## Where things are
| Thing | Path |
|---|---|
| Pane route | `apps/mail/app/(routes)/outlook-pane/page.tsx` (being extracted to `apps/mail/components/nava-pane/`) |
| Quote workflow UI/state | `apps/mail/components/quote-workflow/`, `apps/mail/lib/quote-workflow/` |
| Server routes | `apps/server-pilot/src/trpc/routes/{quote-workflow,workstation}.ts` |
| HMS runners | `apps/server-pilot/tooling/playwright-quote/*.mjs` |
| Deploy + SSM | `apps/server-pilot/deploy/{ops-deploy.sh,ssm-run-command.sh}` |
| Gotchas | `docs/solutions/` |
| Vocabulary | `CONCEPTS.md` |

## Next steps
The overnight scoreboard (`/tmp/p2/SCOREBOARD.md`) is the working queue until the owner reviews it on 2026-10-14. The 2026-10-09 v8 handoff is history.
