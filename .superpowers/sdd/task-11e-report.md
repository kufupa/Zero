# Task 11E Report — Evidence-key bootstrap, asm-exec, deploy wiring

**Status:** DONE (local GREEN). Step 6 AWS provision attempted separately below.  
**BASE_BEFORE_THIS_TASK:** `731ae669`  
**Commit:** (see git log after commit) — `feat(hms): provision Phase B evidence HMAC bootstrap`  
**Slice:** vendored process-replacing `asm-exec`, provision script, PM2/install/env/IAM wiring, scoped doctor grammar  
**Out of scope:** full live operator (Task 12), registry cutover (Task 13)

---

## What landed

| Area | Files | Behavior |
|------|-------|----------|
| Patched asm-exec | `deploy/vendor/asm-exec` + `.gitattributes -text` | `os.execvpe` process replace; pinned SHA-256 `5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f` (CRLF bytes preserved) |
| Provision | `deploy/provision-hms-evidence-key.sh` | umask 077, 0600 temp key, create-or-describe, IAM `NavaZeroSecretsRead` + `hms-evidence-hmac-*`, SSM metadata-only `/etc/nava/hms-evidence-hmac.env`, pin install; never fetch secret payload |
| Install | `deploy/install-hms-browser.sh` | root-owned `0755` `/usr/local/bin/asm-exec` after pin check |
| Env writer | `deploy/write-ec2-env.sh` | sources metadata file → ARN + KEY_VERSION only |
| PM2 | `deploy/pm2.config.cjs` | `hms-ai-worker` → `asm-exec -- /usr/bin/env HMS_EVIDENCE_HMAC_KEY={{resolve:...}} /usr/bin/node dist/ai/worker.js` |
| Live-proof drift | `src/ops/hms-live-proof.ts` | expected `pm_exec_path` = `/usr/local/bin/asm-exec` |
| Doctor grammar | `deploy/ops-hms-proof.sh` | `doctor [--tool <id> --action <action>] [--json]` → SSM metadata + asm-exec sentinel probe |
| IAM docs | `deploy/aws-resources.md` | `hms-evidence-hmac-*` on `NavaZeroSecretsRead` |

---

## Tests / local verify

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run \
  tests/deploy-config.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/hms-live-proof.test.ts \
  tests/hms-production-boundary.test.ts
pnpm build
bash -n deploy/provision-hms-evidence-key.sh
printf '%s  %s\n' \
  5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f \
  deploy/vendor/asm-exec | sha256sum -c -
```

**Result:** suites GREEN; build exit 0; bash -n OK; sha256 pin OK. No pilot-RDS. No secret value reads in tests.

---

## Step 6 outcome

Recorded after attempt (ops-deploy → provision → scoped doctor). Classify failures as agent-owned setup vs true external access denied.

---

## Commit scope

Staged Task 11E sources + tests + this report + `.gitattributes`.  
Excluded: plan file `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`.

---

## Concerns

- asm-exec pin is CRLF-byte-exact; `.gitattributes -text` required so Linux EC2 checkout keeps pin.
- Scoped doctor SSM path needs AWS/SSM from operator host; offline `doctor [--json]` unchanged.
- Existing secret path uses describe + list-version-ids only (no payload fetch).
