---
name: centurion-email-refresh
description: >-
  Refresh Centurion mailbox corpus from pilot RDS (SSM dump → S3 → local),
  regroup by thread, and regenerate PMS tool-demand analysis docs. Use when
  user asks to refresh Centurion emails/dump, re-pull mailbox markdown,
  regroup centurion threads, re-analyse PMS tool demand, or update
  centurion-emails-*.md / centurion-*-YYYY-MM-DD.md.
disable-model-invocation: true
---

# Centurion email corpus refresh

Read-only mailbox pull + local analysis. Do **not** mutate pilot RDS, run Vitest against pilot, or paste guest bodies / addresses / DB URLs into chat.

Canonical long-form handoff: `docs/infor-hms/centurion-email-tool-demand-handoff-2026-08-03.md` (§4).

## Guardrails

- Dump script = **read-only** SQL. OK.
- Never Vitest / test runner with pilot `DATABASE_URL`. Never `VITEST_ALLOW_PILOT_RDS`.
- Source `.env.production` **only on EC2** inside SSM. Never echo secrets.
- Full bodies stay in **gitignored** dumps. Tracked docs = aggregates + subjects only.
- Do not commit `centurion-emails-*.md`.

## Checklist

```
- [ ] 1. SSM dump + S3 upload (STAMP)
- [ ] 2. Download → centurion-emails-dump.md
- [ ] 3. Regroup → centurion-emails-by-thread.md
- [ ] 4. Bump analyse script output dates to today
- [ ] 5. Run analyse → docs/infor-hms/centurion-*-YYYY-MM-DD.md
- [ ] 6. Optional: slim index + handoff snapshot row
- [ ] 7. Report corpus facts (counts only; no PII)
```

## Step 1 — Dump on pilot (SSM)

From **repo root** on laptop:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
echo "STAMP=$STAMP"
bash apps/server-pilot/deploy/ssm-run-command.sh "
  export NVM_DIR=/home/ubuntu/.nvm
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  export PATH=\"\$HOME/.local/share/pnpm:\$PATH\"
  cd /home/ubuntu/repos/zero/apps/server-pilot
  ENV_FILE=.env.production
  [ -f \"\$ENV_FILE\" ] || ENV_FILE=/home/ubuntu/.env.production
  set -a; source \"\$ENV_FILE\"; set +a
  unset VITEST_ALLOW_PILOT_RDS
  OUT=/tmp/centurion-emails-dump-${STAMP}.md
  node scripts/dump-centurion-emails-md.mjs --out \"\$OUT\"
  head -n 8 \"\$OUT\"
  aws s3 cp \"\$OUT\" \
    s3://nava-zero-mail-845242190536-af-south-1/ops/centurion-email-analysis/centurion-emails-dump-${STAMP}.md \
    --region af-south-1
  echo S3_KEY=ops/centurion-email-analysis/centurion-emails-dump-${STAMP}.md
"
```

Expect stdout JSON like `count` / `inbound` / `outbound` plus `S3_KEY=...`. Save `STAMP`.

Script: `apps/server-pilot/scripts/dump-centurion-emails-md.mjs`

## Step 2 — Download local dump

```bash
aws s3 cp \
  "s3://nava-zero-mail-845242190536-af-south-1/ops/centurion-email-analysis/centurion-emails-dump-<STAMP>.md" \
  "centurion-emails-dump.md" \
  --region af-south-1
head -n 8 centurion-emails-dump.md
```

Overwrite in place. Confirm header `Total messages` matches SSM count.

## Step 3 — Regroup by thread

```bash
node scripts/regroup-centurion-by-thread.mjs
```

→ `centurion-emails-by-thread.md` (gitignored). Confirm thread/multi counts in script stderr JSON.

## Step 4 — Bump analyse output paths

`scripts/analyse-centurion-pms-tools.mjs` hardcodes dated outputs. Before run, set **today's UTC date** (`YYYY-MM-DD`):

- `ANALYSIS_OUT` → `docs/infor-hms/centurion-pms-tool-demand-YYYY-MM-DD.md`
- `OUTBOUND_OUT` → `docs/infor-hms/centurion-outbound-index-YYYY-MM-DD.md`
- `THREAD_OUT` → `docs/infor-hms/centurion-thread-collation-summary-YYYY-MM-DD.md`
- Title / “RDS read-only DATE” / prior-dumps narrative in the same file → same date
- Delta line: vs **previous** dump counts (keep prior dated analysis files; do not delete)

## Step 5 — Analyse

```bash
node scripts/analyse-centurion-pms-tools.mjs
```

Writes three tracked docs under `docs/infor-hms/`. Stderr JSON lists `wrote` paths. Classifier scores = demand **signals** (recall-oriented; `new_booking` overcounts).

## Step 6 — Optional hygiene

**Slim index** (gitignored) from dump header only — subjects/from/when, no bodies.

**Handoff snapshot:** append row to corpus table in `docs/infor-hms/centurion-email-tool-demand-handoff-2026-08-03.md` §5; point related-artifact links at latest dated analysis files.

## Step 7 — Report to user

Minimal bullets, **no PII**:

- msgs / inbound / outbound / threads / multi-msg / threads-with-outbound
- window (first→last when from dump index)
- vs prior dump deltas
- outbound shape (Confirmation Letter / Payment Confirmation vs other subject classes — counts only)
- paths: gitignored dumps, new `docs/infor-hms/centurion-*-YYYY-MM-DD.md`, S3 key

## Artifacts

| Path | Role | Git |
| --- | --- | --- |
| `centurion-emails-dump.md` | Flat dump | ignore |
| `centurion-emails-by-thread.md` | Thread collation | ignore |
| `centurion-emails-index.md` | Slim index | ignore |
| `docs/infor-hms/centurion-pms-tool-demand-YYYY-MM-DD.md` | Analysis | track |
| `docs/infor-hms/centurion-outbound-index-YYYY-MM-DD.md` | Outbound subjects | track |
| `docs/infor-hms/centurion-thread-collation-summary-YYYY-MM-DD.md` | Thread histograms | track |
| S3 `ops/centurion-email-analysis/centurion-emails-dump-<STAMP>.md` | Durable dump | remote |

## Cadence

Re-run every few days as mailbox grows. Keep prior dated analysis files.
