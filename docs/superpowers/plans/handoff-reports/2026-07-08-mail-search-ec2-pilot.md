# Mail Search EC2-Pilot Handoff — 2026-07-08

**Branch:** `EC2-pilot` @ `0453b86b`
**Merge:** `489e2f3e` — `feat/mail-search` → `EC2-pilot` (16 commits, clean merge)

## Done

| Step | Status | Notes |
|------|--------|-------|
| Merge to EC2-pilot | ✅ | No conflicts |
| Local unit tests | ✅ | 29 server-pilot + 7 mail |
| Local builds | ✅ | tsc + mail SPA |
| Push + bundle sync | ✅ | EC2 @ `0453b86b` |
| RDS migrate 0009/0010 | ✅ | Applied via drizzle-kit |
| search_vector backfill | ✅ | 4 rows updated |
| EC2 mail-search-gate | ✅ | **36/36** vitest on RDS |
| deploy-ec2.sh | ✅ | build + PM2 reload |
| /health | ✅ | 200 |

## RCA fixes this wave

1. **Contract tests 4/4 fail on EC2** — `source .env.production` left `NODE_ENV=production`; `callerFor` auth bypass requires `NODE_ENV=test`. Fix: `mail-search-gate.sh` exports `NODE_ENV=test` (same pattern as `fixture-loopback-gate.sh`).

2. **Draft subject: contract 1 fail** — decoy subject `subject:invoice` legitimately matches `subject:invoice` operator (`%invoice%`). Fix: decoy invoice only in `textBody`, not subject (`0453b86b`).

## Production state

- Canonical Gmail grammar live (`gmailSearchGrammar: true`)
- Outlook spellings (`read:no`, `hasattachment:yes`, etc.) → TRPC 400
- FTS on `mail_thread.search_vector` (subject + snippet + sender)
- Migrations applied; backfill run

## Gate command (repeatable)

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/mail-search-gate.sh'
```

## Stash note

Pre-merge EC2-pilot WIP (t3mp3st etc) stashed as:
`wip: isolate non-search EC2-pilot dirt before mail-search merge`

Restore when ready: `git stash pop`

## Known gaps (tier 2+)

- Playwright E2E search-bar not run on EC2 this wave
- AI/semantic search deferred
- Full HTML body search not in v1
