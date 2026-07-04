# Nava Fixture Loopback Gate Report (2026-07-04)

Branch: `EC2-pilot`  
EC2 instance: `i-008f737974a9ba9b3` (`af-south-1`)  
Deployed SHA: `c59fba8e` (`fix(mail): tighten inbox listing and quarantine test fixtures`)

## Wave commits (U1–U8 + overnight fixes)

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
| — | `38e6c734` | fix(deploy): harden ssm poll and gate vitest reporter |
| — | `c59fba8e` | fix(mail): tighten inbox listing and quarantine test fixtures |

## Local gates (pre-push)

| Check | Result |
|-------|--------|
| server-pilot unit tests | skipped off-VPC (RDS timeout) |
| `@zero/mail` tests | 167 pass (Task 5 subagent) |
| `tsc` server-pilot | clean per task reports |

## EC2 / RDS gates

| Check | Result |
|-------|--------|
| Bundle sync | `sync-ec2-git-bundle.sh` → `c59fba8e` |
| Deploy | `deploy-ec2.sh` — health green |
| **Full gate script** | `fixture-loopback-gate.sh` — **SSM Success** (~12m wave) |
| Health | `{"ok":true,"service":"server-pilot"}` |
| PM2 | `http` + `worker` online after gate |
| Vitest gate suite | 6 files, **40/40 pass** (prior partial run had 3 fails — fixed in `c59fba8e`) |
| Transport | `MAIL_TRANSPORT_MODE=fixture` on EC2 |

## RCA notes

1. **First combined SSM wave failed** (`bc5cbede`) — wrong filter `@zero/server-pilot` for migrate; package is `@zero/server`.
2. **SSM client poll false negatives** — empty Status polls while invocation still running; fixed in `38e6c734` (retry before abort).
3. **Gate 3 test failures on EC2** (`c59fba8e` fix):
   - **E2E-3**: outbound-only threads appeared in inbox — `listThreads(inbox)` now requires inbound message.
   - **ingest quarantine tests**: `missing-owner.eml` replace left `Delivered-To: nava@` — mailparser still routed to Nava spam; tests now use `unknownToEml()` helper.
4. **Windows AWS CLI unicode** — vitest box-drawing breaks stdout capture; gate uses `--reporter=dot`.

## Divergence log

- **Inbox semantics tightened** (`c59fba8e`): inbox requires inbound + excludes SPAM label. Outbound-only compose threads show in `sent` only. Aligns with E2E-3 plan intent.

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
