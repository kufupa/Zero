# Active context (read first, every session)

Auto-loaded via `CLAUDE.md`. Keep under 120 lines. Update at the end of every work block: current focus, next steps, new mistakes. Task history goes in `docs/context/ledger/`, durable lessons in `docs/context/MISTAKES.md`.

## Product in one paragraph
Nava is an AI reservationist for Legacy Hotels' Centurion property. Staff work in classic Outlook. The VSTO add-in (`kufupa/nava-outlook-addin`) hosts a WebView2 side pane served from our EC2 (`apps/mail` route `/outlook-pane`). The pane analyses the selected email (Luna = the model, never shown to staff; staff-facing name is "Nava"). It pre-fills fields and runs deterministic Infor HMS tools through Playwright (`apps/server-pilot/tooling/playwright-quote/`): quote, PDF, party lookup, stay lookup, create (flagged), cancel (lab only). Human in the loop on every write.

## Current focus (2026-10-09, pilot call 2026-10-10)
- Pilot call tomorrow, 2026-10-10 (08:00 UK, 09:00 SA). Teaching guide: `docs/pilot/2026-10-09-teaching-script.md`. Install and checklist: `docs/pilot/2026-10-08-install-and-onboarding.md`.
- Pilot user: one Centurion reservationist, installing add-in 1.0.17 (SHA verified on EC2 downloads). Pilot day 1 (10-08) failed: her pane never loaded the fixed bundle (last load 12:56 UTC, fix deployed 13:22).
- Live on EC2 (run ledger): rateshop reads (03:07 UTC), Labtest create saved and cancelled (03:14), party lookups 360, Woolworths and Tourvest (04:35, fix build). Not proven yet: two full quotes with PDF and Excel (V3), and a clean viewer gate run (V1).
- Owner flags: `RESERVATIONIST_PANE_SAVE` unset (off; `lab` or `on` is the owner's call). `HITL_LEDGER` off, migration 0046 applied, can go `on`. `QUOTE_TRACE_ASYNC` stays off until V3 passes.
- Still open: #79 contract rates, #84 party typeahead (stacked on #79), D3 deploy result (31ae92cb4), party index sweep. Handoff: `docs/plans/handoff-reports/2026-10-09-overnight-v8.md`.
- Overnight plan: `docs/plans/2026-10-08-007-feat-overnight-v8-nava-pane-plan.md`. Earlier run ledger: `docs/context/ledger/2026-10-08-overnight.md`. Tonight's run ledger is outside the repo (not committed): `.superpowers/sdd/v8-progress.md` in the centurion-dashboard-tools worktree.

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
- Haiku 5.5 (effort max) implements from file:line briefs in separate worktrees, and a second Haiku reviews each PR.

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
The handoff's "Still open at handoff" section and its "Next steps" list are the working queue: `docs/plans/handoff-reports/2026-10-09-overnight-v8.md`.
