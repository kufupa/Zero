# Handoff: Centurion Outlook pane, 2026-10-08 (13:35 UTC)

For: the next LLM taking over. The human (Pilot Lead) drives. Write short, use tables, no staff tech steps.

## 1. Goal

Centurion's reservationist (paired device on the `transport-centurion` mailbox, add-in 1.0.16) must be able to:
open the Nava side pane, click an email, run a quote, get the PDF, and insert a draft into Outlook.
Staff steps are install, click and sign in only. Never ask staff to run PowerShell, scripts or helper files.

## 2. Where things stand

| Item | State |
|---|---|
| `main` / prod server | `9ce614ad` (healthy: 8788 and 8789 ok, pane 200, VPN ok) |
| Centurion add-in | 1.0.16 (installed by her). Her pairing is kept |
| Centurion pane | Reloads and bridge grants succeed. **Not yet proven**: zero `quoteWorkflow.analyseSelection` calls since the deploy. That call only fires when she clicks an email after a pane reload |
| Pane fixes merged | #52 (clock), #53 (diagnostics), #54 (pin 1.0.16), #55 (Message-ID canonical), #56 (follow clicks after writes, other-mailbox handling), #57 (route binding) |
| Root cause of "Luna cannot read emails" | #57: the `*FromTrpc` helpers returned `{}` because the real tRPC client is a function (`typeof` = `'function'`) and the guard required an object. Only the pane's analyse/quote/stay calls were affected |

Open PRs:

| PR | What | Status |
|---|---|---|
| nava-outlook-addin #8 | Add-in 1.0.17 (STA for sync, `sourceKind`, reply placement, selection lease, other-store clicks) | CI and Greptile clean. **Held, not published.** Needs a Windows build artifact, then publish. Her install is 1.0.16 |
| Zero #48 | Agency/company picker | Draft, parked. HMS "Tourvest" is a company profile (#206); agency search must cover both kinds |
| Zero #2, #3 | Old front-end work | Out of scope |

Pending follow-ups:
- Recovery test for the #56 P1 (two failures, then a successful read clears `authorizationUnavailable`). Owned by the **plan fix para** session. It was merged before the Greptile P1 cleared; the code path looks correct but is untested.
- Install doc and server pin: 1.0.16 hash `7b8f97ffc5484a83112a8b688b7ba3d7267e203c3d5a3538eb35611145d4e4c4` (already in `docs/pilot/2026-10-08-install-and-onboarding.md`). Update again when 1.0.17 is published.
- Mail routing for the five new mailboxes (`missing_owner_header`, ~31% of today's mail held). RCA: `docs/plans/2026-10-08-005-ingest-routing-rca.md`. Not started.
- Quote speed flag `QUOTE_TRACE_ASYNC`: still OFF. Needs 2 live quotes plus PDF before turning on.
- Hindsight retro not yet saved. Full retro and plan v7: `/home/orca/.claude/plans/humming-inventing-glacier.md`.

## 3. Deploying

- Deploy only from the shared checkout `/home/ubuntu/projects/zero/.worktrees/recover-parse-failure` (`git pull --ff-only origin main` first), via `bash apps/server-pilot/deploy/ops-deploy.sh`.
- Before every deploy: `bash apps/server-pilot/deploy/ssm-run-command.sh 'chmod u+w /home/ubuntu/repos/zero/.husky/_/h'`.
- Exit 1 at `launch-readiness NOT_READY outboundBacklogEmpty` is pre-existing. Verify with health curls on 127.0.0.1:8788 and 8789, the pane URL with `--resolve nava.legacyhotels.co.za:443:127.0.0.1`, and `vpn-health-assert.sh`.
- Publishing the installer: download the CI artifact (`gh run download <id> -R kufupa/nava-outlook-addin -n NavaOutlookSetup`), check its SHA against `build-manifest.json`, upload to the bootstrap bucket, presign, and install into `/var/www/nava-mail/downloads/NavaOutlookSetup.exe` on EC2. Back up the old file first. Then check the served SHA.
- Rollback targets are listed in `docs/plans/handoff-reports/2026-10-08-luna-pilot-morning.md` (Runbook D).

## 4. Watching Centurion (read-only, no staff action needed)

All via `ssm-run-command.sh` on EC2. Redact `postgres://` strings in any output.

| Signal | Where | Meaning |
|---|---|---|
| `analyseSelection` in nginx | `sudo -n cat /var/log/nginx/access.log \| grep analyseSelection` | Pane is calling the analyse route. The fix is working |
| `bridgeTicket` / `native/authorize` 200 | same log | Add-in grants are flowing |
| `outlook_bridge_native_failure` | `/home/ubuntu/.pm2/logs/http-*.log` | Add-in refused a command. The message holds the real reason (EntryID-like tokens masked) |
| `outlook_folder_auto_approved`, `outlook_native_authorize` | same | Folder approvals and grant decisions |
| `ACTIVE_EMAIL_EMPTY`, `ACTIVE_EMAIL_NO_MESSAGE_ID`, `GET_ACTIVE_EMAIL` schema | `http-error-*.log` (console.warn) | Diagnostics from #56. Field paths only, no values |
| `workstation.reportBridgeFailure` count | nginx log | Rough failure rate |

A pane reload is the only way she gets new JS. If a fix is deployed and nothing changes, ask her to close and reopen the pane (no reinstall).

## 5. Rules (non-negotiable)

- Never ask client staff to run PowerShell, a terminal, scripts or helper files. Fix in product code.
- No real-guest HMS writes. `RESERVATIONIST_PANE_SAVE` stays unset. Bot never accepts cancellation penalty dialogs.
- Before vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. No migrations. No pilot-RDS tests.
- Never print secrets or `postgres://` URLs.
- Diagnostics first. No fix without a confirmed causal chain. For remote failures, ship error visibility before fixes.
- P0 and P1 review comments are fixed **before** merge. Check the latest Greptile comment's commit against the PR head.
- Haiku implements from exact file:line briefs in disjoint worktrees. Opus reviews, merges and deploys.

## 6. Other sessions on this machine

They are separate Claude instances. Coordinate by message only. They have not been read in full.

| Session | Last known state | Owns |
|---|---|---|
| plan fix para | Idle. Deployed #56 + #57. Will add the #56 recovery test | pane `use-outlook-bridge.ts`, bridge tests |
| Outlook side pane UI iteration | Idle, background. UI copy PR, no PR open | pane UI copy, `amend-find-panel.test.tsx`. Agreed to stay out of `quote-workflow/*.ts` |

Do not let peers deploy. The user wants a single driver.

## 7. Worktrees (do not edit the others)

- Shared checkout (git and deploy): `/home/ubuntu/projects/zero/.worktrees/recover-parse-failure`
- This session's worktree: `/home/ubuntu/projects/zero/.claude/worktrees/fix-pane-trpc-client-guard` (branch `worktree-fix-pane-trpc-client-guard`, #57 merged)
- Add-in source: `/home/ubuntu/projects/zero/.worktrees/v6-addin/apps/server-pilot/vsto` (branch `fix/1.0.17-final` lives on the add-in repo as PR #8)
