# Outlook Search FTS Backfill + Pilot Deploy Plan

> **For agentic workers:** Execute as an ops checklist. Reuse existing deploy wrappers and the batched backfill script. Do not invent new tooling. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land already-shipped Outlook mail search (`feat/outlook-mail-search-20260824`) onto the deployable git ref, deploy to pilot EC2 with no schema migration, then recompute `mail_thread.search_vector` so historic message bodies become searchable.

**Architecture:** Feature code already includes body FTS SQL + batched backfill. This plan owns land → `ops-deploy.sh` (no `--migrate`) → SHA gate → one SSM-hosted `backfill-search-vector.ts` → health + one UI body-term smoke. New ingest keeps calling `refreshThreadSearchVector`; backfill only repairs historic rows.

**Tech Stack:** `ops-deploy.sh`, `sync-ec2-git-bundle.sh` (`GIT_BRANCH` default `main`), `ssm-run-command.sh`, existing `apps/server-pilot/scripts/backfill-search-vector.ts`, Postgres `tsvector`.

**Origin:** Task 7 of `docs/superpowers/plans/2026-08-24-outlook-mail-search-bar.md` + 2026-08-25 production-write proposal. Feature head at plan time: `d032c70b` on `feat/outlook-mail-search-20260824`.

## Global Constraints

- Explicit user authorization required before production writes A (deploy) and B (backfill). This plan is not a silent green light.
- Never Vitest / any test runner against `nava-zero-mail-pilot` or production. Never `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production` into a test process.
- Before any local Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- No drizzle migration. Column + GIN already exist; body FTS is expression-only.
- Backfill runs **only** via laptop → `ssm-run-command.sh` on EC2. Forbidden: laptop-local `tsx` with sourced `.env.production` / pilot `DATABASE_URL`.
- Production DB writes limited to batched `UPDATE mail_thread SET search_vector = …`. No DELETE. No writes to `message`, labels, folders, users, auth, attachments, transports.
- Deploy may replace EC2 app artifacts and bounce PM2 (executable write, not mail-row write).
- Logs: totals only. Never print subjects, bodies, addresses, or `DATABASE_URL`.
- Do not force-push `main`. Do not `--no-verify`. Do not wipe/rotate pilot seed.
- Unrelated dirty files in the primary `main` worktree must not be staged into the land/merge.
- Standard (non-fast) subagents only.

---

## Problem frame

`threadSearchVectorSourceSql` now includes up to 20 newest `message.text_body` values (each `left(..., 8000)`). Threads ingested after deploy get the new vector via `refreshThreadSearchVector`. Historic threads keep the old subject/snippet/sender-only vector until backfill recomputes them.

## Production write inventory (locked)

| Write | Target | Changes | Does not change |
|-------|--------|---------|-----------------|
| A. Code deploy | EC2 repo + `/var/www/nava-mail/` + PM2 | Built server + mail SPA; process restart | Mail row contents |
| B. FTS backfill | RDS `mail_thread.search_vector` | Derived `tsvector` only, batches of 200 | Bodies, subjects, labels, folders, users, auth, attachments, transports |
| C. Verify | HTTP / UI | Reads only | — |

**Idempotent:** re-running backfill recomputes every row again from current source text. Intra-run cursor (`id > lastId`) is **not** a cross-run checkpoint — a killed SSM run does not resume mid-table; re-run walks the full table again (safe, just slower).

## Decisions (locked)

1. **Land before deploy.** Bundle ships `refs/heads/$GIT_BRANCH` tip only (default `main`). Feature must be an ancestor of that tip before `ops-deploy`.
2. **No `--migrate`.**
3. **Healthy deploy + SHA match before backfill.** Failed health/VPN/launch-readiness → stop; never run write B.
4. **One canonical backfill invoke:** laptop SSM with NVM + `set -a` + `source .env.production` + `pnpm exec tsx scripts/backfill-search-vector.ts` from `apps/server-pilot`, with raised SSM timeouts.
5. **No automatic rollback** of body FTS expression. On bad deploy: stop, capture PM2 logs, re-bundle last known-good SHA or abort for human restore. Vector expression rollback is out of scope.

## File map

| Path | Role |
|------|------|
| `apps/server-pilot/src/mail/search/search-vector.ts` | Body caps (already shipped; must be on box) |
| `apps/server-pilot/scripts/backfill-search-vector.ts` | Batched UPDATE (already shipped; run on EC2) |
| `apps/server-pilot/deploy/ops-deploy.sh` | Primary deploy (no `--migrate`) |
| `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` | Bundle sync |
| `apps/server-pilot/deploy/ssm-run-command.sh` | SSM host for SHA gate + backfill + health |
| `docs/solutions/workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md` | Operator front door |
| `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md` | `set -a` / SSM quoting |
| `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md` | Why Vitest on pilot is forbidden |

## Preconditions

- [ ] User explicitly authorizes production writes A+B.
- [ ] Feature branch still green if HEAD moved since `d032c70b` (local disposable-DB / mail suite only — never pilot).
- [ ] AWS credentials can SSM `i-008f737974a9ba9b3` (`af-south-1`).
- [ ] EC2 has `apps/server-pilot/.env.production` (never print it).

---

### Task 1: Land feature onto deployable ref

**Files:** git only. No app code edits.

- [ ] Confirm feature worktree clean at reviewed HEAD.
- [ ] In primary repo: do **not** stage unrelated dirty files into the land/merge.
- [ ] Merge (or cherry-pick) `feat/outlook-mail-search-20260824` onto deployable branch (`main` unless operator chooses another `GIT_BRANCH`).
- [ ] Record `LAND_SHA=$(git rev-parse refs/heads/$GIT_BRANCH)`.
- [ ] Confirm `git merge-base --is-ancestor <feature-head> refs/heads/$GIT_BRANCH`.

**Done when:** Deployable tip contains feature; `LAND_SHA` recorded; working tree dirt (if any) is unrelated and unstaged.

---

### Task 2: Deploy to pilot EC2 (no migrate)

**Commands (laptop, deployable checkout):**

```bash
# record tip being shipped
git rev-parse HEAD   # must equal LAND_SHA

# default: GIT_BRANCH=main
bash apps/server-pilot/deploy/ops-deploy.sh
# non-main only:
# GIT_BRANCH=<local-branch-name> bash apps/server-pilot/deploy/ops-deploy.sh
```

- [ ] Run **without** `--migrate`.
- [ ] Require full `ops-deploy ok` (includes `:8788` + `:8789` health, remote-admin readiness, VPN assert).
- [ ] On failure: stop. Capture PM2 logs via existing ops path. Re-bundle last known-good SHA or abort for human restore. **Do not** start Task 3.

**Done when:** `ops-deploy ok`.

---

### Task 3: SHA gate (before any DB write)

**Commands (laptop):**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; cd /home/ubuntu/repos/zero && git rev-parse HEAD && grep -n "MAIL_SEARCH_BODY_MESSAGE_LIMIT\|BACKFILL_BATCH_SIZE" apps/server-pilot/src/mail/search/search-vector.ts apps/server-pilot/scripts/backfill-search-vector.ts'
```

- [ ] EC2 `HEAD` must equal `LAND_SHA`.
- [ ] Grep must show body limit `20` and batch size `200`.
- [ ] Mismatch → stop. Re-deploy or re-land. Never backfill.

**Done when:** SHA + constants match.

---

### Task 4: Run batched FTS backfill (write B)

**Canonical command (laptop only — never local tsx):**

```bash
SSM_EXECUTION_TIMEOUT_SECONDS=3600 SSM_MAX_POLL_SECONDS=3900 \
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"; cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm exec tsx scripts/backfill-search-vector.ts'
```

Quoting rules: outer single quotes on the SSM argument; `set -a` before `source`; never expand `$DATABASE_URL` on the laptop; never print the URL.

- [ ] Prefer off-peak (row locks vs concurrent ingest `refreshThreadSearchVector`).
- [ ] Expect stdout: `backfill complete: <N> row(s) updated; <M> thread(s) with search_vector`.
- [ ] Confirm logs contain **no** mail PII.
- [ ] If SSM TimedOut / cancel: re-run the **same** command (full-table idempotent rewrite). Do not invent DELETE recovery.

**Done when:** Script exits 0 and prints `N` / `M`.

---

### Task 5: Read-only verify + close-out

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'curl -fsS http://127.0.0.1:8788/health && curl -fsS http://127.0.0.1:8789/health'
```

- [ ] Health green.
- [ ] Authenticated UI: header `#mail-search` present; one operator-chosen historic body-term search succeeds (do not paste PII into git/logs).
- [ ] Record in execution ledger only: `LAND_SHA`, backfill `N`/`M`, health PASS. No secrets. No raw PII.
- [ ] Mark parent Outlook search Task 7 complete only after Tasks 2–5 pass.

**Done when:** Health PASS + UI body smoke PASS (or documented operator skip with reason) + ledger line written.

---

## Risks

| Risk | Mitigation |
|------|------------|
| SSM 900s default kills long backfill | Raise to 3600s execution / 3900s poll (Task 4) |
| False “resume from lastId” | Document: re-run = full walk; idempotent only |
| Dirty main / wrong tip shipped | Land gate + post-deploy SHA match before write B |
| Bad deploy leaves broken UI | Stop; restore last known-good SHA; never backfill |
| Laptop backfill footgun | Forbid; SSM-only command block |
| RDS CPU/WAL + row locks | Batch 200; off-peak preferred |
| Vitest wipe of pilot | Hard refuse; script ≠ test runner |

## Out of scope

- Re-implementing MailSearchBar or body SQL (already done on feature branch).
- Attachment-content indexing; HTML-only empty `text_body` search.
- Automatic rollback to pre-body vector SQL.
- Disposable-DB `mail-search-gate.sh` on EC2 (local only if needed; never pilot URL).
- Force-landing unrelated dirty `main` files; PR/push unless user asks.

## Review disposition (applied 2026-08-25)

**Eng (`APPROVE-WITH-EDITS`)** — applied: NVM + raised SSM timeouts; kill false cross-run resume claim; LAND_SHA ↔ EC2 HEAD gate; deploy-fail stops before backfill / restore prior good SHA.

**Ponytail (`CUT-THEN-SHIP`)** — applied: ops checklist (not SDD mandate); drop disposable-gate path, optional SQL recount, Cmd+K recheck, separate ledger task, duplicate local Vitest wall, speculative rollback prose. Retained eng SHA/constants gate (safety > ceremony).

**DevEx TRIAGE (`FIX-THEN-PASS`)** — applied: locked laptop `ssm-run-command.sh` blocks; canonical `pnpm exec tsx` from `apps/server-pilot`; forbid laptop-sourced backfill; timeout env vars; quoting rules.

**Accepted gaps:** no auto vector-expression rollback; no migrate; HTML-only bodies unsearchable; explicit auth before A+B.

**Design review:** skipped (no new UI; feature UI already shipped).

**Unresolved blockers:** none for planning. Execution still blocked until user authorizes production writes A+B.
