---
title: Pilot body FTS backfill via SSM, not Vitest
date: 2026-08-25
category: workflow-issues
module: server-pilot mail search
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Shipping Outlook header search body FTS to the EC2 pilot
  - Recomputing mail_thread.search_vector after expression-only FTS changes
  - Primary main worktree is dirty and cannot be the deployable checkout
tags:
  - fts
  - backfill
  - ops-deploy
  - pilot-rds
  - search_vector
---

# Pilot body FTS backfill via SSM, not Vitest

## Context

Body FTS extends `threadSearchVectorSourceSql` with truncated recent `message.text_body`. Historic threads keep the old subject/snippet/sender vector until a one-shot script recomputes `mail_thread.search_vector`. That write must never go through Vitest against `nava-zero-mail-pilot`.

## Guidance

1. Land the reviewed feature onto a deployable git ref. If the primary `main` worktree has unrelated dirt, merge on a `land/*` branch in a clean worktree and pass `GIT_BRANCH=<land-branch>` to `apps/server-pilot/deploy/ops-deploy.sh`.
2. Deploy **without** `--migrate` when the change is expression-only (column + GIN already exist).
3. SHA-gate: EC2 `git rev-parse HEAD` must equal the landed SHA; confirm `MAIL_SEARCH_BODY_MESSAGE_LIMIT = 20` and `BACKFILL_BATCH_SIZE = 200`.
4. Run backfill **only** via laptop `ssm-run-command.sh` with NVM + `set -a` + `source .env.production` + `pnpm exec tsx scripts/backfill-search-vector.ts` from `apps/server-pilot`. Raise `SSM_EXECUTION_TIMEOUT_SECONDS=3600`. Never run that script on the laptop with a sourced production URL.
5. Treat Postgres NOTICE `word is too long to be indexed` / `Words longer than 2047 characters are ignored` as success noise. The script still exits 0 and updates rows.
6. Re-run is a full-table rewrite (idempotent). Intra-run `id > lastId` is not a cross-run checkpoint.
7. Verify with health curls and published SPA (`mail-search` in `/var/www/nava-mail`). Authenticated UI body-term smoke needs hotel VPN; skip with reason if the agent host has no tunnel.

## Why This Matters

Vitest against pilot RDS has wiped live mail. Backfill is a purpose-built UPDATE of a derived column only. A dirty `main` checkout must not block deploy: bundle ships `refs/heads/$GIT_BRANCH`, not uncommitted files.

## When to Apply

- After body-FTS SQL lands and before expecting historic body-only terms to hit.
- Whenever ops-deploy would otherwise run from a dirty primary `main` worktree.

## Examples

Verified 2026-08-25: land SHA `1a7db667`, EC2 match, backfill `2391` rows updated / `2391` threads with `search_vector`, health `{"ok":true,"service":"server-pilot"}` on `:8788` and `:8789`. UI body-term skipped: `https://nava.legacyhotels.co.za` unreachable from the agent browser (VPN).

## Related

- `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`
- `docs/solutions/workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md`
- `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
- `docs/superpowers/plans/2026-08-25-outlook-search-fts-backfill-deploy.md`
