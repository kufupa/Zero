# HANDOFF: EC2 Production V4 — Cursor → Claude Code

> **Read this entire document before touching anything.** It is the single source of truth for resuming the overnight implementation on Claude Code, then handing back to Cursor for review.

---

## 0. What this is

A coding agent (Cursor, GLM 5.2) has been executing the **EC2 Production V4 Implementation Plan** overnight using **subagent-driven development** (SDD). Tasks 0–7 of 13 are complete and review-clean. The user wants **Claude Code** to finish Tasks 8–12 autonomously, then hand back to Cursor for the final whole-branch review.

The goal: keep two different coding agents productive on the same branch without losing state, duplicating work, or trampling each other's commits.

---

## 1. One-line state

| Field | Value |
|-------|-------|
| Branch | `EC2-pilot` |
| Base plan | `docs/superpowers/plans/2026-07-01-ec2-production-v4-local-first-implementation-plan.md` |
| SDD progress ledger | `.superpowers/sdd/progress.md` |
| Last Cursor HEAD | `6a8fbf99` — `feat(trpc): add requireMailboxAccess facade + correct task-7 report` |
| Tasks complete | 0, 1, 2, 3, 4, 5, 6, 7 (8 of 13) |
| Tasks remaining | 8, 9, 10, 11, 12 |
| Commits this session | 18 (see §4) |
| Merge base | `d6a0fd05` (pre-session tip) |
| Repo | `C:/Users/gamin/Desktop/projs/emails hotels uis/zero` |
| Remote | `https://github.com/kufupa/Zero` — **push OK and encouraged** after each verified task (see §6–7) |
| EC2 repo path | `/home/ubuntu/repos/zero` on `EC2-pilot` (synced via git bundle, see §6) |

---

## 2. What to give Claude Code (the handoff bundle)

Hand over these five things. Everything is already in the repo except item (e).

1. **This handoff doc** — `docs/superpowers/plans/2026-07-01-ec2-production-v4-HANDOFF-TO-CLAUDECODE.md` (tracked, will be committed).
2. **The plan file** — already tracked: `docs/superpowers/plans/2026-07-01-ec2-production-v4-local-first-implementation-plan.md`. Claude Code reads this for the task definitions of 8–12.
3. **The EC2 access doc** — already tracked: `docs/superpowers/EC2-ACCESS.MD`. AWS identifiers, SSM commands.
4. **The SDD progress ledger + all per-task reports (Tasks 0-7) + all per-task briefs (0-12)** — Cursor snapshots these into a tracked handoff directory so Claude Code reads them straight from the repo: `docs/superpowers/plans/handoff-reports/`. Contents:
   - `progress-ledger.md` — the SDD ledger (Tasks 0-7 done).
   - `task-0-report.md` through `task-7-report.md` — implementer/fix reports with RCA notes, verification results, concerns, and gotchas. Read these for recent context and known quirks (especially task-6-report for ingest UUID-threading fix, task-7-report for the mail router + the thread-cascade note, task-4-report for schema design notes).
   - Claude Code appends its own Task 8-12 report lines to `.superpowers/sdd/task-N-report.md` (gitignored) as it works — it does not need to update the tracked snapshot dir, that's Cursor's review artifact only.
5. **A short kickoff prompt** for Claude Code — template in §8 (copy-paste ready).

**Not needed:** Cursor's exported chat transcript (`.jsonl`). It is huge, mostly tool I/O, and the actionable state is already captured in the ledger + reports + git history. Skip it unless debugging a specific past decision; if needed, it lives at `C:\Users\gamin\.cursor\projects\c-Users-gamin-Desktop-projs-emails-hotels-uis-zero\agent-transcripts\<uuid>.jsonl`.

---

## 3. The SDD scratch directory (`.superpowers/sdd/`)

Gitignored (`*` in `.gitignore`). Contents:

| File | Purpose |
|------|---------|
| `progress.md` | **THE LEDGER.** Append one line per completed task. Claude Code must read this first and append to it. |
| `task-N-brief.md` | Per-task requirements extracted from the plan by `scripts/task-brief`. Claude Code regenerates these (§5). |
| `task-N-report.md` | Implementer/fix subagent reports. Cursor's review memory. Claude Code should write its own as it completes tasks. |
| `review-<base>..<head>.diff` | Review packages for each task gate. Cursor's artifact. Claude Code does not need old ones. |
| `sync-ec2-*.log` | Bundle sync log. Throwaway. |

**Critical rule:** the ledger (`progress.md`) is the recovery map. After any context compaction or restart, Claude Code must read it and `git log` — never re-dispatch tasks the ledger marks complete.

---

## 4. Commit history this session (do not re-do any of this)

```
6a8fbf99 feat(trpc): add requireMailboxAccess facade + correct task-7 report
b59b1d48 fix: include tRPC code in error messages for regex-based test assertions
f3da76f7 fix(tests): return sub-router callers + short-circuit injected ctx
2993c5d2 fix(tests): use __setDbForTests instead of monkey-patching ESM binding
faf4ca3e feat: add mailbox-scoped mail router
bfc06a74 fix(ingest): thread one message id through parse + store, rename quarantine helper
8329e865 feat: add streaming pop3 ingest
b92ee32f feat: add mailbox auth context and seed
7156f885 fix: enable RDS SSL and harden SSM command quoting
cd2ed2ea feat: add production mailbox schema
2ffa3d59 feat: switch runtime server to server-pilot
afdd5e42 fix: join broken aws iam line and align vitest to 3.2.4
7fa42ab1 feat: add aws resource env contract
64695dbf fix(deploy): use instance-profile S3 access and preserve node_modules on sync
e042f530 fix: ec2 git bundle sync and ssm poll loop
ee9275da chore: add ec2 bootstrap workflow
75f11df6 docs: classify jwks/connection and add table action matrix
c717de16 docs: audit v4 schema baseline
```

All authored by `kufupa <aroransh17@gmail.com>` (the Cursor session identity). Claude Code's commits will have a different author — that is fine and helps distinguish the two agents' work in `git log`. **Do not amend or rewrite Cursor's commits.**

---

## 5. How SDD works here (Claude Code must follow this)

The plan mandates `superpowers:subagent-driven-development`. Cursor used it; Claude Code should too (or follow the same gate structure manually if SDD isn't installed there).

**Per task:**
1. Generate brief: `scripts/task-brief` from the superpowers skill (or just read the task section from the plan).
2. Dispatch implementer subagent with brief path + global constraints + report file path. Tell it: `Use /caveman ultra. Work autonomously. If blocked, do root cause analysis, research best fixes, implement best fix, verify, commit, continue.`
3. After implementer DONE: generate review package (`scripts/review-package BASE HEAD`), dispatch task reviewer (readonly) with brief + report + diff file.
4. If reviewer finds Critical/Important: dispatch fix subagent, re-review.
5. On clean review: append one line to `.superpowers/sdd/progress.md`:
   `Task N: complete (commits <base7>..<head7>, review clean <note>)`
6. Advance to next task. **Do not pause to ask the user between tasks** — overnight autonomy is the explicit instruction.

**Final task (12):** dispatch a broad whole-branch reviewer (`scripts/review-package MERGE_BASE HEAD` where `MERGE_BASE=d6a0fd05`), covering all 18+ Claude Code + Cursor commits, on the most capable model.

Model selection (from SDD skill): mechanical 1-2 file tasks → fast/cheap; integration/judgment → standard; architecture + final review → most capable. Cursor used `composer-2.5` for implementers and `composer-2.5-fast` for simple fixes/reviews. Claude Code should pick its own equivalent tiers.

---

## 6. EC2 sync workflow (push + optional bundle)

The repo is on **private GitHub**. **Push `EC2-pilot` after each verified commit** so Cloud Agents and other machines can clone latest state. Cursor also built a git-bundle-over-S3 sync as a **backup** when push is slow or EC2 needs in-place reset without a full fetch:

```bash
cd /path/to/zero
export AWS_REGION=af-south-1
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```

What it does: `git bundle create` → upload to private S3 `nava-zero-bootstrap-845242190536/git-bundles/zero-EC2-pilot.bundle` → SSM tells EC2 to `aws s3 cp` (instance-profile S3 access, no presigned URL), then in-place `git fetch <bundle> +refs/heads/*:refs/remotes/bundle/*` + `git reset --hard bundle/EC2-pilot` (preserves untracked `node_modules`).

**After push,** EC2 can `git pull --ff-only` on `EC2-pilot`. Run the bundle script when you need the S3/SSM path instead (or in addition). Bundle takes ~30–40s (83MB).

To run a command on EC2:
```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'your remote command here'
```
The wrapper polls SSM to terminal status. Caveats see §11.

---

## 7. Hard constraints (from plan Global Constraints — binding)

- **Branch:** `EC2-pilot`. Do not create a new branch.
- **`git push origin EC2-pilot`** after each verified task commit (user approved push; required for Cloud Agents).
- **No real mail server connection.** POP3/SMTP code proven with `.eml` fixtures + fake transports only. `POP3_HOST` may be unset; worker skips gracefully.
- **No VPN.** VPN not connected; do not block on VPN/Exchange checks.
- **No AI chatbot assistant features.**
- **No workflow-use Chromium/API integration.**
- **Old `apps/server` is reference-only** (renamed `@zero/server-legacy`). Do not run it. `apps/server-pilot` is the runtime `@zero/server`.
- **No `staffMember`, no `mailSnooze`, no `mailPrompt`, no `message_recipient`** schema. Snooze is `mailThread.snoozedUntil`.
- **Secrets:** never commit POP3/SMTP/RDS passwords. EC2 `.env.production` is untracked, `chmod 600`, owned by `ubuntu`. RDS password in AWS Secrets Manager `nava-zero/server-pilot/database-url`.
- **Commit after each independently verified task.** Do not commit unrelated untracked files (there are many: `.claude/`, `.tmp-research/`, `docs/superpowers/plans/2026-06-30-*`, skills, etc. — leave them alone).
- **Autonomous overnight:** if something breaks, do full RCA, research best fix (Exa/web/AWS docs OK), implement, verify, commit, continue. Do not stop for ordinary bugs. Stop only for: destructive out-of-plan action, AWS auth denial, legal/compliance blocker, or a credential you cannot obtain.
- **`/caveman ultra`** style for all subagents and for your own narration unless doing security warnings or irreversible actions.

---

## 8. Kickoff prompt for Claude Code (paste this)

```
You are resuming an overnight autonomous implementation of the EC2 Production V4 plan.

Read these first, in order:
1. docs/superpowers/plans/2026-07-01-ec2-production-v4-HANDOFF-TO-CLAUDECODE.md  (this handoff — your operating manual)
2. docs/superpowers/plans/2026-07-01-ec2-production-v4-local-first-implementation-plan.md  (the plan; your task defs for 8-12)
3. docs/superpowers/plans/handoff-reports/progress-ledger.md  (the SDD ledger — Tasks 0-7 done, DO NOT re-do them)
4. docs/superpowers/plans/handoff-reports/task-7-report.md  (most recent shipped task — mail router state)
5. docs/superpowers/plans/handoff-reports/task-6-report.md  (ingest state + UUID-threading fix)
6. docs/superpowers/plans/handoff-reports/task-4-report.md  (schema design notes for downstream awareness)
7. (optional) task-0 through task-5 reports in same dir if you hit a question about earlier state
8. docs/superpowers/EC2-ACCESS.MD  (AWS/EC2/SSM identifiers)

State: branch EC2-pilot, HEAD 6a8fbf99, 8/13 tasks complete and review-clean.
Remaining: Task 8 (SMTP fake send), Task 9 (frontend integration + polling), Task 10 (nginx/PM2/deploy), Task 11 (deferred real-mail readiness notes), Task 12 (load/capacity/alarms/final gate + overnight report).

Rules (non-negotiable):
- Use /caveman ultra for you and every subagent you dispatch.
- subagent-driven-development: implementer + task reviewer per task, fix loop on Critical/Important findings, append to .superpowers/sdd/progress.md on clean review (create the .superpowers/sdd/ dir if missing — it's gitignored scratch).
- PUSH after each verified commit: `git push origin EC2-pilot`. Optionally sync EC2 via bundle script or `git pull` on EC2.
- NO real mail/VPN/AI/workflow-use — fixtures and fakes only.
- NO re-doing Tasks 0-7. Trust the ledger + git log over your own recollection.
- If blocked: root cause analysis, research best fix (Exa/AWS docs OK), implement, verify, commit, continue. User asleep — no stopping for ordinary bugs.
- Commit only task-owned files. Never commit unrelated untracked files (.claude/, .tmp-research/, docs/superpowers/plans/2026-06-30-*, skills, .env.production, secrets).
- Run tests on EC2 with env sourced: `set -a && . ./.env.production && set +a && pnpm test` (vitest does not auto-load .env.production; DB-backed tests skip without it — this is a known harness quirk, not a bug).

Start at Task 8. Work autonomously through Task 12. When all done, dispatch the final whole-branch reviewer against merge base d6a0fd05, fix any findings in ONE fix subagent, then write the overnight report (Task 12 Step 5) and stop.
```

---

## 9. Current architecture state (what shipped in Tasks 0-7)

- **`apps/server-pilot/`** is the runtime `@zero/server` package (name `@zero/server`). Old `apps/server` renamed `@zero/server-legacy`, kept on disk for reference.
- **Exports:** `./trpc` (`AppRouter` type + full router), `./auth` (Better Auth instance + `Auth` type), `./auth-providers` (`EnvVarInfo` + Google provider), `./schemas` (zod: userSettings, defaultMailCategories, etc.). `apps/mail` depends on these four.
- **Schema (Drizzle + RDS Postgres 16):** 17 tables — auth (user/session/account/verification), app-compat (note/userSettings/emailTemplate/jwks), mail-core (mailIngestMailbox, mailIngestQuarantine, mailboxTransport, mailboxAccess, mailLabel, mailThread, message, attachment, mailDraft). `mailboxAccessRoleEnum` = owner/member/admin. All critical indexes present. Migration applied to RDS.
- **Auth:** Better Auth wired with drizzle adapter on RDS, email/password + optional Google (disabled in pilot). `/api/auth/*` + `/api/public/providers` mounted. `/health` returns `{ok:true,service:"server-pilot"}`.
- **Mailbox context:** `resolveMailboxContext(userId, transportId?, db)` (3-arg DI form) + 2-arg facade `requireMailboxAccess(userId, transportId)`. FORBIDDEN on no access.
- **Seed:** nava@ ingest mailbox, transport-centurion (personal, ownerHeaderValue centurion@legacyhotel.com), 3 mailboxAccess (user-manager owner, user-centurion-worker member, user-admin admin), 3 pilot users with hashed passwords (plaintext in Secrets Manager `nava-zero/server-pilot/pilot-users`).
- **POP3 ingest:** streaming `MailParser`, fake POP3 adapter, fixture-driven, S3 raw-mime + attachments, POP3 delete-safety order enforced. `ingestOnce()` cycles. Worker entry at `src/mail/ingest/worker.ts`.
- **Mail router:** `mail.listThreads/get/markAsRead/toggleStar/modifyLabels/bulkArchive/snoozeThreads/send` (send is stub), `drafts.*`, `labels.*`, `settings.*`, `connections.*` compat wrappers. All transport-scoped via `mailboxProcedure`. Isolation tests prove user-frontdesk cannot touch Centurion.
- **S3 mail bucket:** `nava-zero-mail-845242190536-af-south-1` (SSE, lifecycle: raw-mime 30d, attachments 90d).
- **EC2 instance role inline policies:** `NavaZeroBootstrapBundleRead` (s3 GetObject git-bundles), `NavaZeroMailBucketAccess` (s3 mail bucket), `NavaZeroSecretsRead` (secretsmanager), `NavaZeroRDSConnect` (rds-db:connect), `NavaZeroPilotUsersSecretWrite` (added Task 5 — not yet documented in aws-resources.md; Claude Code should add it).

---

## 10. Known quirks / gotchas (Claude Code will hit these)

1. **Windows AWS CLI charmap crash on unicode stdout.** SSM `get-command-invocation` `--output json` crashes the Windows-side AWS CLI when stdout contains `✓` (vitest) or other non-codepage chars. Workarounds: (a) strip on EC2 with `sed "s/[^\x00-\x7F]//g"` or `tr -d '\200-\377'`, (b) `--output text` + `tr -d '\200-\377'` on the Windows side, (c) base64-encode on EC2 then decode locally. Do NOT pipe raw vitest output through SSM json.
2. **`pnpm test` skips DB-backed tests on EC2** unless `DATABASE_URL` is in the process env. Run `set -a && . ./.env.production && set +a && pnpm test`. The deployed worker (PM2) sources env itself; only the test harness has this gap.
3. **`apps/server-pilot` package name is `@zero/server`** (not `@zero/server-pilot`) since Task 3's runtime switch. Filter with `pnpm --filter @zero/server ...`. The folder is `apps/server-pilot`.
4. **EC2 full `pnpm install` exceeds SSM 900s timeout.** Use scoped: `pnpm --filter @zero/server... install` or install on EC2 once and reuse. The bundle sync preserves `node_modules`.
5. **Amend rule:** never amend a commit you didn't author in this session. Cursor's commits are `kufupa <aroransh17@gmail.com>`. Claude Code's commits will differ — if a fix is needed, create a NEW commit.
6. **`rejectUnauthorized: false`** on RDS SSL in `db/client.ts` (pilot-acceptable; pin RDS CA for prod — noted, not a Task 8-12 blocker).
7. **`mailDraft.threadId` cascades on thread delete** (real behavior, documented in Task 7 report). Don't casually delete threads in new routes.
8. **`mailboxTransport.mailboxType` defaults `'shared'`** — set `'personal'` explicitly when creating personal inboxes.

---

## 11. SSM command execution notes

- Wrapper: `bash apps/server-pilot/deploy/ssm-run-command.sh 'command'` — polls to terminal.
- For long test runs the wrapper can appear to hang; check `aws ssm list-command-invocations --instance-id i-008f737974a9ba9b3` directly.
- SSM `--timeout-seconds 600` max per command. Long installs/builds: split or background.
- EC2 shell is non-interactive via SSM; nvm is wired into `.profile` but always source explicitly: `export NVM_DIR=/home/ubuntu/.nvm && . /home/ubuntu/.nvm/nvm.sh`.

---

## 12. What Cursor will do when handed back (review mode)

After Claude Code signals Task 12 complete + overnight report written + final whole-branch review dispatched, the user brings the branch back to Cursor. Cursor will:
1. Read `.superpowers/sdd/progress.md` (now includes Claude Code's Task 8-12 lines).
2. Run `git log d6a0fd05..HEAD` to see Claude Code's commits (distinguishable by author).
3. Run `scripts/review-package d6a0fd05 HEAD` for the whole-branch diff.
4. Dispatch the final whole-branch reviewer (most capable model) with the full diff + plan + ledger, covering BOTH Cursor's and Claude Code's work.
5. Fix any Critical/Important findings in one fix subagent (Cursor-side, since it has SDD).
6. Report to the user.

Claude Code should NOT do the final whole-branch review itself unless the plan's Task 12 explicitly requires it for the overnight report — Cursor's review is the authoritative gate before the user declares done.

---

## 13. Quick sanity check Claude Code should run on startup

Before starting Task 8, verify nothing drifted overnight:

```bash
git rev-parse --abbrev-ref HEAD          # expect: EC2-pilot
git rev-parse --short HEAD               # expect: 6a8fbf99 (or a Claude Code commit if resuming mid-run)
git log --oneline -1                     # expect: feat(trpc): add requireMailboxAccess facade...
cat .superpowers/sdd/progress.md | tail  # expect Task 7 last line
aws sts get-caller-identity              # expect account 845242190536
aws ssm describe-instance-information --region af-south-1 --filters "Key=InstanceIds,Values=i-008f737974a9ba9b3" --query 'InstanceInformationList[0].PingStatus' --output text  # expect Online
```

If any of these fail, investigate before touching code. If HEAD is past `6a8fbf99` with an author other than `kufupa`, Claude Code already ran a partial session — trust the ledger for what's done.

---

*Authored by Cursor (GLM 5.2) on 2026-07-01 as the handoff artifact for Claude Code to complete Tasks 8-12 of the EC2 Production V4 plan.*