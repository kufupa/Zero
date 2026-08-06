# Task 11E Report — Evidence-key bootstrap, asm-exec, deploy wiring

**Status:** DONE (local GREEN + Step 6 provision/doctor GREEN).  
**BASE_BEFORE_THIS_TASK:** `731ae669`  
**Commits:**
- `d25c754b` — `feat(hms): provision Phase B evidence HMAC bootstrap`
- `3fd67793` — `fix(hms): strip CRLF when installing pinned asm-exec`  
**Slice:** vendored process-replacing `asm-exec`, provision script, PM2/install/env/IAM wiring, scoped doctor grammar  
**Out of scope:** full live operator (Task 12), registry cutover (Task 13)

---

## What landed

| Area | Files | Behavior |
|------|-------|----------|
| Patched asm-exec | `deploy/vendor/asm-exec` + `.gitattributes -text` | `os.execvpe` process replace; pinned SHA-256 `5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f` (CRLF bytes preserved in vendor) |
| Install path | install + provision remote | `tr -d '\r'` before `/usr/local/bin/asm-exec` so Linux shebang works; pin checks vendor SRC |
| Provision | `deploy/provision-hms-evidence-key.sh` | umask 077, 0600 temp key, create-or-describe, Windows `cygpath` for `file://`, IAM `NavaZeroSecretsRead` + `hms-evidence-hmac-*`, SSM metadata-only `/etc/nava/hms-evidence-hmac.env`; never fetch secret payload |
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

| Step | Result | Notes |
|------|--------|-------|
| Default `ops-deploy.sh` | OK (health) | Bundles `GIT_BRANCH=EC2-pilot` (stale tip) — agent-owned; re-synced `phase-b-autonomous-read-expansion` via bundle + EC2 checkout |
| Branch sync | OK | EC2 at `3fd67793` after pathspec fix (create local branch once) |
| `provision-hms-evidence-key.sh --json` | OK | `secretMetadataReady:true`, `instanceMetadataInstalled:true`, `asmExecPinned:true`; `secretCreated:false` (existing secret describe path); no key bytes |
| Windows `file://` | Fixed | `cygpath -m` for AWS CLI on Git Bash |
| CRLF shebang | Fixed | strip CR on install (vendor pin unchanged) |
| Scoped doctor | OK | `HMS_OK code=DOCTOR_OK`; `evidenceBootstrapReady:true`, `asmExecPinned:true` |

Classification: early Step 6 friction was **agent-owned setup** (wrong default bundle branch; Windows file://; CRLF shebang), not external access denied. Final provision + doctor GREEN.

---

## Commit scope

Staged Task 11E sources + tests + this report + `.gitattributes`.  
Excluded: plan file `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`.

---

## Concerns

- Default `ops-deploy` / `sync-ec2-git-bundle` uses `GIT_BRANCH=EC2-pilot`; Phase B worktree must set `GIT_BRANCH=phase-b-autonomous-read-expansion` (or merge) before EC2 has Task 11E files.
- Vendor asm-exec stays CRLF for pin; installed binary is LF — both digests now pinned (`ASM_EXEC_INSTALLED_SHA256`); see follow-up below.
- First Windows create attempt failed on `file://` before cygpath fix; secret may have been created on a later retry (this run used describe-only path).

---

## Follow-up: installed LF digest pin (Task 11E review Important)

**Problem:** After `tr -d '\r'`, `/usr/local/bin/asm-exec` SHA ≠ vendor CRLF pin. Doctor/provision only hashed vendor SRC.

**Fix commit:** `fix(hms): pin installed LF asm-exec digest after CRLF strip`

| Pin | Constant | Digest |
|-----|----------|--------|
| Vendor SRC (CRLF) | `ASM_EXEC_PIN` / `DEFAULT_PIN` | `5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f` |
| Installed (LF) | `ASM_EXEC_INSTALLED_SHA256` | `81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65` |

Updated: `install-hms-browser.sh`, provision remote, doctor SSM probe, `deploy-config.test.ts`, `aws-resources.md` digests section. Both pins verified post-install / in doctor.
