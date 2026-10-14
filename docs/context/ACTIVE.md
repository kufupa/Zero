# Active context (read first, every session)

Auto-loaded via `CLAUDE.md`. Keep under 120 lines. Update at the end of every work block: current focus, next steps, new mistakes. Task history goes in `docs/context/ledger/`, durable lessons in `docs/context/MISTAKES.md`.

**Product spec:** `PRODUCT.md` (owner-edited). This file is the run, not the spec.

## Product in one paragraph
Nava is an AI reservationist for Legacy Hotels' Centurion property. Staff work in classic Outlook. The VSTO add-in (`kufupa/nava-outlook-addin`) hosts a WebView2 side pane served from our EC2 (`apps/mail` route `/outlook-pane`). The pane analyses the selected email (Luna = the model, never shown to staff; staff-facing name is "Nava"). It pre-fills fields and runs deterministic Infor HMS tools through Playwright (`apps/server-pilot/tooling/playwright-quote/`): quote, PDF, party lookup, stay lookup, create (flagged), cancel (lab only). Human in the loop on every write.

## Current focus (2026-10-14 overnight run — results)
- **Scoreboard:** `/tmp/p2/SCOREBOARD.md` on the VPS (outside repo): golden-set score + per-item state, last-good SHA, rollback.
- **Golden set (PRODUCT.md "Done"):** 26 real past emails (quote 12, amend 5, cancel 4, create 0 — no create passed request-linked evidence, skip 5). Answer keys only from staff evidence tied to the request. v1 (stored extractions) 15/26; **v2 (fresh production extraction, deployed 7532bd5) 24/26 (92.3%)**. Scorer PR #218 open (eval tooling; 2 known P1s at golden-set.ts:1879, :2216). Fresh extractor: `scripts/golden-fresh-extract.ts` (#221).
- **Live:** channel skip at the door (#215: Profitroom contact forms stay direct, Tiket.com, H-Pay payment links; Travelit/TBO never skipped; RateTiger has no host); party v2 (0 wrong binds on 95 answer-key emails, 57.9% auto-bind); #211 pane clarity; viewer gate runner fixes (#219, #220).
- **In flight:** #214 dinner + alternatives (11 Greptile rounds, clean at round 11); #222 quote ready on open (`HMS_QUOTE_PREPARE`, default off, stacked on #214); proof set = 4 recent future-dated quote threads with the staff offer PDF.
- **Classifier (feat/action-classifier): not merged.** 400-email EC2 eval vs adjudicated labels: medium effort 77.0% action / 0.5% failures (p50 7 s); max effort 73.9% / 7.25% failures (timeouts). Gate is ≥90% and ≤1%. Next step is the prompt, not budgets.
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
