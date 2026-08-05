# Live reservation shadow runbook (HRCEN Guest Stay)

**Scope:** Manual EC2 proof of read-only `hms_find_reservation` `1.1.0` in shadow mode.  
**Not in scope:** write adapters, auto-enqueue, quote/docs/folio/group tools, `enabled` mode.

## Install (before first canary)

1. Stage role proof at `/etc/nava/hms-read-role-proof.v1.json`, root-owned mode `0444` (hotel-admin **or** operator-observed runtime attestation). Required: `propertyCode=HRCEN`, `allowedSurfaces` includes `Guest Stay`, full `deniedActions` list, TTL ≤30d, `evidenceRef` without credentials/guest data. Installer refuses legacy app-writable proof at `/opt/nava/shared`; operator must remove it after securely staging the root-owned copy.
2. Bootstrap browser deps:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/install-hms-browser.sh'
```

Expected: `HMS_DEPENDENCIES_OK` (Playwright `1.52.0`, Chromium revision `1169`, Playwright video smoke, active `nava-hms-artifact-purge.timer`).

3. Confirm HMS off + defaults healthy:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh status'
```

Expected: `HMS_OFF_READY`. Confirm `AI_DRAFTS_ENABLED=false`, no `hms-ai-worker` PM2 app, http/ai-worker healthy.

## Live sequence

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh canary'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh start'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh status'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh stop'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh rearm'
```

Expected tokens (stop at first `HMS_WAIT` / `HMS_FAIL`):

```text
HMS_DEPENDENCIES_OK          # install
HMS_OFF_READY                # status (off)
HMS_LIVE_NOT_FOUND_OK
HMS_LIVE_ROW_FINGERPRINT_OK
HMS_LIVE_ROW_OK
HMS_SHADOW_OK                # start
HMS_SHADOW_VERIFIED          # status (running)
HMS_ROLLBACK_OK              # stop
HMS_SHADOW_REARMED           # rearm (before next intentional canary/start)
```

Proof mail = server-selected from at most 5,000 authorized Centurion rows: exact `n°########-#` candidates first, oldest-first within rank, at most 24 attempts. No argv lookup values.

## After stop — rearm before next run

`stop` writes `/opt/nava/shared/hms-runtime/hms-shadow-disabled` so an accidental `start` fails with `RUN_ISOLATION_BLOCKED`. That latch stays until ops clears it.

After a normal DoD `stop` (or before the next intentional shadow wave):

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh rearm'
```

Expected: `HMS_SHADOW_REARMED`. Leave the flag in place if you want HMS start locked off.

## Mid-proof asset ship (http stays online)

`ops-deploy.sh --quiesced` rebuilds/syncs assets **without** bouncing PM2. Online `http` / `ai-worker` is OK. Full bounce still uses plain `ops-deploy.sh`.

Mutable proof files stay under `/opt/nava/shared`; credential-grade browser artifacts use the `0700` `hms-browser-artifacts` child. Role proof stays separately root-owned under `/etc/nava`.

## Lifecycle rules

| Action | Behavior |
| --- | --- |
| Generic deploy / restart / reboot | Starts default apps only; deletes `hms-ai-worker`; invalidates canary/shadow proof files; exports `NAVA_BUILD_COMMIT` |
| `ops-deploy.sh --quiesced` | Assets only; no PM2 mutation; online `http` OK |
| `ops-hms-shadow.sh start` | **Sole** HMS starter; requires fresh canary proof; refuses any nonterminal HMS-lane run; claims only `hms-proof:<proofAttemptId>:`; refuses if `hms-shadow-disabled` present |
| `hms-ai-worker` PM2 | `autorestart: false` — permanent failure quiesces |
| `nava-hms-artifact-purge.timer` | Runs hourly even while HMS runtime is off; removes expired finalized and stale partial captures |
| `stop` | Sets disable flag, dead-letters proof-attempt nonterminal rows, deletes HMS PM2, verifies defaults |
| `rearm` | Clears `hms-shadow-disabled` after intentional stop |

## Failure recovery (fixed codes)

| Code | Exit | Recovery |
| --- | --- | --- |
| `HMS_WAIT code=NO_EXACT_CANDIDATE` | 3 | No eligible Centurion exact candidate; do not broaden lookup |
| `HMS_WAIT code=HMS_OFF` | 3 | Off-state wait (safe) |
| `ROLE_PROOF_*` / `ROLE_SCOPE_INVALID` | 10 | Re-stage root-owned `/etc/nava/hms-read-role-proof.v1.json` (path printed) |
| `DEPENDENCY_MISMATCH` | 10 | Re-run `install-hms-browser.sh` |
| `BUILD_MISMATCH` / `MANIFEST_MISMATCH` / `FINGERPRINT_MISMATCH` | 10 | Redeploy matching build; re-run canary |
| `RUN_ISOLATION_BLOCKED` | 10 | Clear nonterminal HMS runs **or** `ops-hms-shadow.sh rearm` after intentional stop |
| `FORBIDDEN_PERSISTENCE` | 10 | Abort; investigate Centurion transport draft/generation delta |
| `ROLLBACK_INCOMPLETE` | 20 | Manually `pm2 delete hms-ai-worker`; restore http/ai-worker; re-run `stop` |
| Other `HMS_FAIL code=…` | 10 | See operator fail enum; never bypass policy |

## Proof files (digests only)

- `/opt/nava/shared/hms-runtime/hms-reservation-canary-proof.v1.json` mode `0600`
- `/opt/nava/shared/hms-runtime/hms-reservation-shadow-proof.v1.json` mode `0600`

TTL ≤24h. Never store candidate, thread, message, guest, email, HMS row, model, or evidence values.

Use `ops-hms-proof.sh fetch-artifact <uuid> <receipt|video>` for digest-checked retrieval. Trace retrieval additionally requires `trace --confirm-sensitive`. Fetch refuses expired receipts and applies restrictive local ACLs before downloading.

## Deferred

Artifact/PDF, quote, document-list, folio/sent-email, group/event/company/preferences, auto-enqueue, write adapters, literal `enabled` mode, live PMS writes.
