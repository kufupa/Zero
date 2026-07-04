# Nava Fixture Loopback Gate Report (2026-07-04)

Branch: `EC2-pilot`  
EC2 instance: `i-008f737974a9ba9b3` (`af-south-1`)  
Deployed SHA: `31cb23d9` (`feat(deploy): add fixture loopback ec2 gate script`)

## Wave commits (U1–U8)

| Wave | Commit | Message |
|------|--------|---------|
| U1 | `4d07626c` | feat(seed): add nava live-mail ops mailbox |
| U2 | `96c51392` | feat(mail): stamp mailbox routing header on smtp send |
| U3 | `6eb35dd7` | feat(ingest): route direct-to mailbox misses into spam |
| U4 | `f8c28636` | feat(mail): add nava-only metadata header debug |
| U5 | `b4828251` | feat(mail-ui): hide header debug behind nava transport |
| U6 | `3b7aebc5` | feat(mail): add fixture smtp-to-pop3 loopback bridge |
| U7 | `c6bcd114` | test(nava-e2e): add fixture loopback integration suite |
| U8 | `31cb23d9` | feat(deploy): add fixture loopback ec2 gate script |

## Local gates (pre-push)

| Check | Result |
|-------|--------|
| server-pilot unit tests | skipped off-VPC (RDS timeout) |
| `@zero/mail` tests | 167 pass (Task 5 subagent) |
| `tsc` server-pilot | clean per task reports |

## EC2 / RDS gates

| Check | Result |
|-------|--------|
| Bundle sync | `sync-ec2-git-bundle.sh` → `31cb23d9` |
| Health | `{"ok":true,"service":"server-pilot"}` |
| PM2 | `http` online |
| `fixture-loopback.test.ts` | **4/4 pass** (SSM `8215c491` predecessor unit run) |
| `fixture-loopback-e2e.test.ts` | **Success** (SSM `8215c491`, ~3.3s) |
| Focused gate suite | **Success** seed + mail-send + ingest + pop3-worker (SSM `d76a8133`, ~7s) |
| Transport | `MAIL_TRANSPORT_MODE=fixture` on EC2 |

## RCA notes

1. **First combined SSM wave failed** (`bc5cbede`) — used wrong filter `@zero/server-pilot` for migrate; package is `@zero/server`. Deploy from prior sync still healthy; re-synced to `31cb23d9`.
2. **SSM client poll false negatives** — `ssm-run-command.sh` hit `SSM_MAX_EMPTY_POLLS=120` while AWS invocation still `InProgress`; verify with `aws ssm get-command-invocation` before treating as failure.
3. **Windows AWS CLI unicode** — vitest box-drawing breaks `get-command-invocation` stdout on laptop; use `--reporter=dot` + grep on EC2 or query `Status`/`ResponseCode` only.
4. **Tests skip locally** — expected without VPC route to RDS; EC2 is source of truth for E2E green.

## Divergence log

None. Plan path (Nava seed → stamp → spam → debug → loopback → E2E → gate) executed as written.

## Remaining blockers (out of scope)

- Real Exchange POP3/SMTP (IT creds, VPN)
- Mailpit wire-fidelity follow-up
- Manual real-mail playbook (superseded by automated fixture E2E for pre-IT confidence)

## Verification commands

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```
