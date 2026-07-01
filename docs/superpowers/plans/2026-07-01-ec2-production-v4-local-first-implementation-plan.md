# EC2 Production V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every dispatched subagent prompt must include: `Use /caveman ultra. Work autonomously. If blocked, do root cause analysis, research best fixes, implement best fix, verify, commit, continue.`

**Goal:** Build, test, and deploy the production-shaped per-mailbox email backend on the real EC2 instance overnight, connect it to the frontend, and prove the app works with fixtures/fakes so real email ingest can be enabled later with confidence.

**Architecture:** One backend on EC2 exposes Hono/tRPC routes used by the existing React SPA. Mail ingest/send code is built behind interfaces and proven with `.eml` fixtures, fake POP3 sessions, and fake SMTP/test transports; real Exchange/mail-server connectivity is explicitly out of scope for this implementation pass. RDS Postgres stores mailbox-scoped rows, S3 stores raw MIME/attachments, and `mailboxAccess` gates every user-facing mail route.

**Tech Stack:** Node.js, Hono, tRPC, Better Auth, Drizzle, PostgreSQL 15+ on RDS, S3, AWS Secrets Manager, AWS SSM, PM2, nginx, fake POP3/SMTP test adapters, streaming `MailParser`, React, TanStack Query, Vitest, Playwright, AWS CLI.

## Global Constraints

- Branch: `EC2-pilot`.
- Primary plan file: `docs/superpowers/plans/2026-07-01-ec2-production-v4-local-first-implementation-plan.md`.
- This V4 supersedes V3 while copying forward V3's per-mailbox isolation, aggregate POP3 ingest, `X-Zero-Mailbox` routing, and shared inbox access model.
- Existing Cloudflare backend in `apps/server/` is reference-only on this branch. It will not be run again for this branch's target deployment.
- Agents may modify frontend code, workspace config, package exports, and server code freely on this branch when that produces the cleanest solution.
- Do not preserve compatibility with the old backend runtime. Preserve user-facing frontend behavior and product semantics, not old backend internals.
- If `apps/server` and `apps/server-pilot` conflict over `@zero/server`, prioritize `apps/server-pilot` as the only runtime `@zero/server` package. It is acceptable to rename, de-scope, or remove old backend workspace participation while keeping old source files for reference.
- Current repo schema is not either old plan's schema. First implementation task must audit current `apps/server/src/db/schema.ts` and migrations before generating production schema.
- Current schema truth at plan time: 17 tables exist, including `user`, `session`, `account`, `connection`, `summary`, `note`, `userSettings`, `writingStyleMatrix`, OAuth tables, and `emailTemplate`; no `mailboxAccess`, `mailboxTransport`, `mailThread`, `message`, `attachment`, `mailIngestMailbox`, or `mailIngestQuarantine` exist yet.
- Final production mail model must use `mailboxAccess` for owner/member/admin access. Do not revert to V4-draft direct-only `mailboxTransport.userId` ownership.
- Shared inboxes are first-class. Personal inbox is one mailbox with one owner row; shared inbox is same mailbox with owner/member/admin rows.
- No `staffMember` table unless implementation audit finds shipped code requiring it and reviewer approves. Default is no `staffMember`.
- No `message_recipient` fan-out. Store one message row per delivered copied mailbox message.
- No separate `mailSnooze` table in default plan. Store snooze on `mailThread.snoozedUntil`.
- No `mailPrompt` table in mail-core rewrite. AI prompt persistence waits for actual AI UX.
- Keep React Query persistence for performance. Fix risk through query keys, auth-boundary clears, mailbox switch invalidation, and tests.
- Do not remove existing logout/account-switch cache clearing; strengthen it where needed.
- Shared-browser stale-cache leak is not the target deployment model, but stale private mail after logout remains a security regression and must be tested.
- Freshness default: no WebSocket. Add real `refetchInterval` only behind config, starting with `30000` ms foreground list polling and focus refetch.
- EC2 is available now and must be used for overnight proof, not deferred to "later".
- EC2 instance: `i-008f737974a9ba9b3`, region `af-south-1`, account `845242190536`, Ubuntu 24.04, `m6i.xlarge`, VPC `vpc-0f078e17a5f0f8599`, subnet `subnet-0e6446aaaeaa8762e`, SG `sg-00190151691bd66fa`.
- Access EC2 through AWS SSM only. No public SSH/RDP assumption.
- RDS is not set up yet. Agents have permission to create RDS, S3, Secrets Manager values, security groups, CloudWatch alarms, and IAM attachments needed for this pilot.
- RDS default: PostgreSQL 15+ or 16+, `db.t4g.medium` minimum, private in the EC2 VPC, SG permits `5432` only from EC2 app SG.
- RDS sizing is easy to change later with `modify-db-instance --db-instance-class ... --apply-immediately` or during a maintenance window. Start `db.t4g.medium` unless cost pressure demands `db.t4g.small`; resize based on load, memory, CPU credits, and pool waits.
- RDS price ballpark in `af-south-1`: `db.t4g.small` about $0.032/hr (~$23/mo), `db.t4g.medium` about $0.065/hr (~$47/mo), plus gp3 storage about $0.115/GB-month (~$11.50/mo for 100GB). Do not enable paid Multi-AZ unless later required.
- S3 default: private bucket in `af-south-1`, SSE enabled, lifecycle configured for raw MIME/attachments.
- VPN status: VPN is not connected for this implementation pass, so it should not affect EC2/RDS/S3/SSM work.
- VPN route validation is deferred until IT provides and starts the real profile. Do not block backend/frontend build on VPN checks.
- Connecting to the real mail server is out of scope for this pass. Build and test POP3/SMTP code with fixtures/fakes only.
- Anything to do with the AI chatbot assistant is out of scope for this pass.
- Anything to do with workflow-use Chromium/API integration is out of scope for this pass.
- Secrets: never commit POP3/SMTP/RDS passwords. Store in AWS Secrets Manager or EC2 env files with locked permissions.
- Database password must be stored in both places for this pilot:
  - AWS Secrets Manager, so automation/runtime can fetch it.
  - Untracked EC2 `.env.production`, owned/readable by `ubuntu`, so user can inspect it via SSM/RDP.
  - Never commit `.env.production` or print it in final summaries.
- Git versioning: commit after each independently verified task. Do not commit unrelated untracked docs/skills/temp research files.
- Overnight autonomy: do not wait for user during implementation. If something breaks, run full root cause analysis, research with Exa/AWS docs if needed, implement best fix, verify, commit, continue.
- Stop only for destructive action outside this plan, AWS account/auth denial, legal/compliance blocker, or a required credential for EC2/RDS/S3/frontend/backend work. Do not stop because real mail/VPN/workflow-use integration is unavailable; those are out of scope.

## Current Scope

In scope:

- Build production-shaped backend.
- Connect backend to the existing frontend app/UX, rewriting frontend integration code where cleaner than preserving old API shapes.
- Rewrite frontend integration code where cleaner than adapter shims.
- Make `apps/server-pilot` the runtime `@zero/server` package for this branch.
- De-scope old `apps/server` from package resolution if it conflicts.
- Run app on EC2.
- Use RDS/S3/Secrets as needed for backend proof.
- Prove schema, auth, mailbox isolation, fixture ingest, fake SMTP send, frontend query behavior, deployment, health, and load tests.
- Leave real ingest/send interfaces ready for later mail-server connection.

Out of scope:

- Connecting to real Exchange/on-prem mail server.
- Starting or configuring VPN.
- Proving POP3/SMTP connectivity to the hotel network.
- AI chatbot assistant features, prompts, or chat UX.
- workflow-use Chromium/API integration.
- Backward compatibility with old Cloudflare backend runtime.

---

## V3/V4 Decision Merge

| Area | Keep From V3 | Keep From Old V4 | New V4 Decision |
|---|---|---|---|
| Mailbox isolation | `mailboxAccess` owner/member/admin; shared inboxes work | none | Use V3 access model. Old V4 direct `mailboxTransport.userId` is too narrow. |
| Aggregate ingest | `nava@` POP3 + `X-Zero-Mailbox` | same | Keep backend shape, but prove with fixtures/fake POP3 now. Real mailbox connection is deferred. |
| Schema | no `staffMember`, no `message_recipient`, no `mailPrompt`, snooze on thread | "17-table" caution | Re-audit actual schema first; target mail schema uses V3 semantics, not stale V4 code block. |
| React Query | cache must not leak after auth boundary | persistence helps performance | Keep persistence, add/scaffold keys as `userId + activeTransportId`, keep logout/account-switch clear. |
| Polling | real 30s query interval | config-gated measured polling | Config-gated `VITE_MAIL_POLL_MS=30000`, foreground only unless tested. |
| Parser | safe POP3 order | streaming `MailParser` | Use streaming `MailParser`, not `simpleParser`, for attachments/PDFs. |
| Execution location | EC2/RDS production proof required | local-first fast feedback | Develop locally when useful, but EC2 is authoritative overnight test/deploy target. |
| Hardware | `m6i.xlarge`, RDS floor | bottleneck is DB/parser, not Hono | Use real EC2 plus RDS `t4g.medium`; gate on pool waits, CPU credits, memory, PDF RSS. |
| Deployment | nginx HTTPS SPA + API proxy | PM2 one HTTP + one worker | Keep. Worker singleton is non-negotiable. |
| Autonomy | not explicit enough | subagent tasks | Add failure loop, root-cause log, commits, and no waiting for asleep user. |

## Current Code Reality

- `apps/server/src/db/schema.ts` is still Cloudflare/connection-centered.
- `apps/mail/providers/query-provider.tsx` persists TanStack Query to IndexedDB under `zero-query-cache` and hashes keys with `connectionId`; current production root may pass `null`, so new backend must supply a mailbox-aware key or provider context.
- `apps/mail/components/ui/nav-user.tsx` already clears `queryClient` and IDB through manual clear and account switch paths; logout currently redirects after `signOut()` and should clear cache before redirect.
- `apps/mail/hooks/use-threads.ts` sets `refetchIntervalInBackground: true` but not `refetchInterval`; therefore no 30-second polling exists yet.
- Old OAuth connection UI is already mostly hidden with `allowConnectionManagement = false`.
- Current frontend still imports `@zero/server/*` and calls old `connections.*` route names in places, but implementation may either provide compatibility adapters or rewrite those frontend callers to mailbox-native routes. Prefer the simpler, cleaner branch-local solution.

## Target Domain Model

```mermaid
flowchart LR
  fixture["Fixture .eml / fake POP3 session"] -->|"X-Zero-Mailbox"| worker["PM2 worker singleton on EC2"]
  worker --> s3["S3 raw MIME + attachments"]
  worker --> rds["RDS Postgres"]
  users["50 users"] --> nginx["nginx HTTPS/static SPA"]
  nginx --> api["Hono/tRPC API on EC2"]
  api --> rds
  api --> s3
  api -->|"fake SMTP/test transport now"| smtp["SMTP adapter interface"]
```

```mermaid
erDiagram
  user ||--o{ session : has
  user ||--o{ account : has
  user ||--o{ mailboxAccess : receives
  mailboxTransport ||--o{ mailboxAccess : grants
  mailboxTransport ||--o{ mailThread : scopes
  mailboxTransport ||--o{ message : scopes
  mailboxTransport ||--o{ mailLabel : owns
  mailboxTransport ||--o{ mailDraft : owns
  mailIngestMailbox ||--o{ message : source
  mailIngestMailbox ||--o{ mailIngestQuarantine : holds
  mailThread ||--o{ message : contains
  message ||--o{ attachment : has
```

## Target Tables

Keep auth/product tables needed by current app, then add mail-core tables. Exact migration must be generated from current schema audit, not pasted blindly.

| Table | Ownership |
|---|---|
| `user` | Better Auth user plus existing profile fields |
| `session` | Better Auth session |
| `account` | Better Auth account/password |
| `verification` | Better Auth verification |
| `note` | `userId`, `threadId` |
| `userSettings` | `userId` |
| `emailTemplate` | `userId` |
| `mailIngestMailbox` | aggregate POP3 source, e.g. `nava@` |
| `mailIngestQuarantine` | unmapped copied mail, never user-visible |
| `mailboxTransport` | mailbox identity/config, owner marker, send-as config |
| `mailboxAccess` | `userId`, `transportId`, `role` = owner/member/admin |
| `mailLabel` | `transportId` |
| `mailThread` | `transportId`, shared/private mailbox state |
| `message` | `transportId`, `threadId`, inbound/outbound data |
| `attachment` | via `messageId`, S3 key metadata |
| `mailDraft` | `transportId`, `threadId`, `createdByUserId` |

Critical indexes:

```typescript
uniqueIndex('mailbox_transport_owner_header_uidx').on(table.ownerHeaderValue);
uniqueIndex('mailbox_access_user_transport_uidx').on(table.userId, table.transportId);
index('mailbox_access_user_role_idx').on(table.userId, table.role);
uniqueIndex('message_ingest_uidl_uidx')
  .on(table.ingestMailboxId, table.pop3Uidl)
  .where(sql`${table.direction} = 'inbound'`);
uniqueIndex('mail_thread_transport_root_uidx').on(table.transportId, table.threadRootId);
index('mail_thread_transport_list_idx').on(table.transportId, table.isArchived, table.latestMessageAt);
index('message_transport_thread_idx').on(table.transportId, table.threadId);
uniqueIndex('mail_label_transport_name_uidx').on(table.transportId, table.name);
index('mail_thread_snooze_wake_idx')
  .on(table.snoozedUntil)
  .where(sql`${table.snoozedUntil} IS NOT NULL`);
```

## AWS/EC2 Operating Commands

Use these variables on laptop:

```bash
export AWS_REGION=af-south-1
export INSTANCE_ID=i-008f737974a9ba9b3
export STACK_NAME=nava-prod-public-ipv4
```

Verify AWS + EC2:

```bash
aws sts get-caller-identity
aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text
```

Expected: `Online`.

Run remote command:

```bash
COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "nava overnight command" \
  --timeout-seconds 900 \
  --parameters '{"commands":["sudo -u ubuntu bash -lc \"hostname && whoami && pwd\""]}' \
  --query 'Command.CommandId' \
  --output text)"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

## Autonomous Overnight Protocol

Every agent and subagent follows this loop:

1. Pull latest branch and inspect `git status --short`.
2. Work one task only.
3. Write/adjust focused tests before implementation where possible.
4. Run smallest relevant test.
5. If failure occurs:
   - capture exact command, stdout/stderr, exit code, env assumptions;
   - identify root cause category: code, test, dependency, AWS, network/VPN, credential, data, resource pressure;
   - inspect local logs and EC2 logs;
   - research best fix using repo search first, then Exa/AWS docs if needed;
   - implement cleanest fix;
   - rerun failing test and surrounding tests;
   - add RCA note to `docs/superpowers/plans/2026-07-01-ec2-production-v4-overnight-rca.md`;
   - continue.
6. Commit after green task with precise message.
7. Push only if explicitly requested by user during execution; otherwise leave commits local.
8. Do not stop for ordinary bugs. User will be asleep; continue until acceptance gates pass or a true human-only blocker appears.

RCA note format:

```markdown
## 2026-07-01 03:10 UTC - ingest parser rss spike

- Task:
- Symptom:
- Command:
- Root cause:
- Options considered:
- Fix chosen:
- Verification:
- Commit:
```

## Task 0: Schema And Plan Reconciliation Audit

**Files:**
- Read: `apps/server/src/db/schema.ts`
- Read: `apps/server/src/db/migrations/**`
- Read: `apps/mail/providers/query-provider.tsx`
- Read: `apps/mail/hooks/use-threads.ts`
- Read: `apps/mail/components/ui/nav-user.tsx`
- Create: `docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md`

**Interfaces:**
- Produces the actual table diff from current code to target V4 mail schema.
- Produces exact decision on whether to create `apps/server-pilot/` or migrate `apps/server/` in place.

- [ ] **Step 1: Confirm current schema exports**

Run:

```bash
rg "export const .* = createTable|export const .* = pgTable" apps/server/src/db/schema.ts
rg "mailboxAccess|mailboxTransport|mailThread|mailIngestMailbox|mailIngestQuarantine|mailSnooze|mailPrompt|staffMember" apps/server apps/mail
```

Expected:

```text
Current schema has connection-era tables.
Target mail-core tables are absent.
```

- [ ] **Step 2: Write schema audit**

Create `docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md` with:

```markdown
# V4 Schema Audit

## Current Tables

- user
- session
- account
- userHotkeys
- verification
- earlyAccess
- connection
- summary
- note
- userSettings
- writingStyleMatrix
- jwks
- oauthApplication
- oauthAccessToken
- oauthConsent
- emailTemplate

## Target Mail Tables To Add

- mailIngestMailbox
- mailIngestQuarantine
- mailboxTransport
- mailboxAccess
- mailLabel
- mailThread
- message
- attachment
- mailDraft

## Tables To Keep For Frontend Compatibility

- user
- session
- account
- verification
- note
- userSettings
- emailTemplate

## Tables Not Part Of Mail-Core Pilot

- summary
- writingStyleMatrix
- oauthApplication
- oauthAccessToken
- oauthConsent
- earlyAccess
- userHotkeys

## Decision

Build `apps/server-pilot/` as the runtime backend for this branch. Keep `apps/server/` on disk only as reference unless package/workspace resolution conflicts, in which case de-scope or rename the old backend package so `apps/mail` resolves to `apps/server-pilot`. Frontend callers may be rewritten to mailbox-native routes instead of preserving old backend API shapes.
```

- [ ] **Step 3: Commit audit**

Run:

```bash
git add docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md
git commit -m "docs: audit v4 schema baseline"
```

## Task 1: EC2, AWS, And Repo Bootstrap

**Files:**
- Create: `apps/server-pilot/deploy/ec2-bootstrap.md`
- Create: `apps/server-pilot/deploy/ssm-run-command.sh`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces repeatable SSM command wrapper.
- Produces verified EC2 baseline for overnight work.

- [ ] **Step 1: Verify SSM access**

Run the AWS commands in "AWS/EC2 Operating Commands".

Expected:

```text
aws sts get-caller-identity succeeds
SSM PingStatus = Online
remote hostname/whoami command returns ubuntu
```

- [ ] **Step 2: Clone or update repo on EC2**

Run through SSM:

```bash
sudo -u ubuntu bash -lc '
set -euo pipefail
mkdir -p ~/repos
if [ ! -d ~/repos/zero/.git ]; then
  git clone https://github.com/kufupa/Zero ~/repos/zero
fi
cd ~/repos/zero
git fetch --all --prune
git checkout EC2-pilot
git pull --ff-only || true
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm --version
node --version
'
```

Expected:

```text
pnpm 10.15.0
node 22.x or compatible installed
```

If Node is missing/wrong, install Node 22 LTS through `nvm` or NodeSource, record RCA, continue.

- [ ] **Step 3: Add SSM wrapper**

Create `apps/server-pilot/deploy/ssm-run-command.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 'hostname && whoami'" >&2
  exit 2
fi

COMMAND_ID="$(
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --timeout-seconds "${SSM_TIMEOUT_SECONDS:-900}" \
    --comment "nava zero command" \
    --parameters "$(node -e 'console.log(JSON.stringify({commands:[`sudo -u ubuntu bash -lc ${JSON.stringify(process.argv[1])}`]}))' "$1")" \
    --query 'Command.CommandId' \
    --output text
)"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

- [ ] **Step 4: Commit**

Run:

```bash
git add pnpm-workspace.yaml apps/server-pilot/deploy/ec2-bootstrap.md apps/server-pilot/deploy/ssm-run-command.sh
git commit -m "chore: add ec2 bootstrap workflow"
```

## Task 2: Provision RDS, S3, Secrets, And Network

**Files:**
- Create: `apps/server-pilot/deploy/aws-resources.md`
- Create: `apps/server-pilot/deploy/rds-smoke.sh`
- Create: `apps/server-pilot/deploy/s3-smoke.sh`
- Create: `apps/server-pilot/deploy/write-ec2-env.sh`
- Create: `apps/server-pilot/src/env.ts`
- Test: `apps/server-pilot/tests/env.test.ts`

**Interfaces:**
- Produces RDS endpoint, DB secret ARN, S3 bucket name, and app env contract.
- Produces Secrets Manager copy of `DATABASE_URL`.
- Produces untracked EC2 env file at `/home/ubuntu/repos/zero/apps/server-pilot/.env.production`.
- RDS is private in same VPC; EC2 can connect.

- [ ] **Step 1: Write env test**

```typescript
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';

describe('env', () => {
  it('parses production AWS mail env', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@example.rds.amazonaws.com:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      POP3_POLL_INTERVAL_MS: '30000',
      SMTP_PORT: '587',
    });

    expect(env.AWS_REGION).toBe('af-south-1');
    expect(env.POP3_MAX_MESSAGES_PER_CYCLE).toBe(500);
  });
});
```

- [ ] **Step 2: Implement env parser**

`apps/server-pilot/src/env.ts` must parse required backend/deploy env:

```typescript
PORT
DATABASE_URL
BETTER_AUTH_URL
BETTER_AUTH_SECRET
AWS_REGION
S3_BUCKET
POP3_POLL_INTERVAL_MS
POP3_MAX_MESSAGES_PER_CYCLE
```

It may parse these deferred real-mail env values when present, but tests must not require them for current scope:

```typescript
POP3_HOST
POP3_PORT
POP3_TLS
POP3_USER
POP3_SECRET_ARN
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_SECRET_ARN
```

- [ ] **Step 3: Create AWS resources and database password**

Default CLI shape:

```bash
export AWS_REGION=af-south-1
export DB_ID=nava-zero-mail-pilot
export DB_NAME=zero
export DB_ADMIN_USER=zero_admin
export DB_ADMIN_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
export DB_SECRET_NAME=nava-zero/server-pilot/database-url
export RDS_SUBNET_IDS="$(
  aws ec2 describe-subnets \
    --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=vpc-0f078e17a5f0f8599" \
    --query 'Subnets | sort_by(@, &AvailabilityZone)[].SubnetId | [0:2] | join(` `, @)' \
    --output text
)"

test "$(wc -w <<< "$RDS_SUBNET_IDS")" -ge 2

export RDS_SG_ID="$(
  aws ec2 create-security-group \
    --region "$AWS_REGION" \
    --group-name nava-zero-rds \
    --description "RDS Postgres for NAVA Zero" \
    --vpc-id vpc-0f078e17a5f0f8599 \
    --query 'GroupId' \
    --output text
)"

aws ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$RDS_SG_ID" \
  --protocol tcp \
  --port 5432 \
  --source-group sg-00190151691bd66fa

aws rds create-db-subnet-group \
  --region "$AWS_REGION" \
  --db-subnet-group-name nava-zero-mail \
  --db-subnet-group-description "NAVA Zero mail pilot" \
  --subnet-ids $RDS_SUBNET_IDS

aws rds create-db-instance \
  --region "$AWS_REGION" \
  --db-instance-identifier "$DB_ID" \
  --db-instance-class db.t4g.medium \
  --engine postgres \
  --engine-version 16 \
  --allocated-storage 100 \
  --storage-type gp3 \
  --storage-encrypted \
  --db-name "$DB_NAME" \
  --master-username "$DB_ADMIN_USER" \
  --master-user-password "$DB_ADMIN_PASSWORD" \
  --vpc-security-group-ids "$RDS_SG_ID" \
  --db-subnet-group-name nava-zero-mail \
  --backup-retention-period 7 \
  --no-publicly-accessible
```

If subnet discovery finds fewer than two subnets, create or identify a second subnet in another AZ before creating RDS:

```bash
aws ec2 describe-subnets --region af-south-1 --filters "Name=vpc-id,Values=vpc-0f078e17a5f0f8599" --output table
```

After RDS is `available`, create the shared `DATABASE_URL` value and store it in AWS Secrets Manager:

```bash
aws rds wait db-instance-available --region "$AWS_REGION" --db-instance-identifier "$DB_ID"

export DB_ENDPOINT="$(
  aws rds describe-db-instances \
    --region "$AWS_REGION" \
    --db-instance-identifier "$DB_ID" \
    --query 'DBInstances[0].Endpoint.Address' \
    --output text
)"

export DATABASE_URL="postgres://${DB_ADMIN_USER}:${DB_ADMIN_PASSWORD}@${DB_ENDPOINT}:5432/${DB_NAME}"

aws secretsmanager create-secret \
  --region "$AWS_REGION" \
  --name "$DB_SECRET_NAME" \
  --description "NAVA Zero server-pilot DATABASE_URL" \
  --secret-string "{\"DATABASE_URL\":\"${DATABASE_URL}\"}" \
  || aws secretsmanager put-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --secret-string "{\"DATABASE_URL\":\"${DATABASE_URL}\"}"

export DB_SECRET_ARN="$(
  aws secretsmanager describe-secret \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --query ARN \
    --output text
)"
```

Create S3 bucket:

```bash
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export NAVA_MAIL_BUCKET="nava-zero-mail-${AWS_ACCOUNT_ID}-af-south-1"

aws s3api create-bucket \
  --region af-south-1 \
  --bucket "$NAVA_MAIL_BUCKET" \
  --create-bucket-configuration LocationConstraint=af-south-1

aws s3api put-bucket-encryption \
  --region af-south-1 \
  --bucket "$NAVA_MAIL_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

- [ ] **Step 4: Write readable locked EC2 env file**

Create `apps/server-pilot/deploy/write-ec2-env.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${DB_SECRET_NAME:=nava-zero/server-pilot/database-url}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${BETTER_AUTH_URL:=http://127.0.0.1:8788}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET required}"

DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --query SecretString \
    --output text \
    | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).DATABASE_URL));'
)"

ENV_PATH="/home/ubuntu/repos/zero/apps/server-pilot/.env.production"
install -o ubuntu -g ubuntu -m 600 /dev/null "$ENV_PATH"

cat > "$ENV_PATH" <<EOF
NODE_ENV=production
PORT=8788
DATABASE_URL=${DATABASE_URL}
BETTER_AUTH_URL=${BETTER_AUTH_URL}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
AWS_REGION=${AWS_REGION}
S3_BUCKET=${S3_BUCKET}
POP3_POLL_INTERVAL_MS=30000
POP3_MAX_MESSAGES_PER_CYCLE=500
EOF

chown ubuntu:ubuntu "$ENV_PATH"
chmod 600 "$ENV_PATH"
echo "Wrote $ENV_PATH owned by ubuntu with mode 600"
```

Run it on EC2 after `S3_BUCKET` and `BETTER_AUTH_SECRET` are set:

```bash
sudo -E bash apps/server-pilot/deploy/write-ec2-env.sh
sudo -u ubuntu bash -lc 'test -r /home/ubuntu/repos/zero/apps/server-pilot/.env.production'
sudo -u ubuntu bash -lc 'grep -E "^(NODE_ENV|PORT|BETTER_AUTH_URL|AWS_REGION|S3_BUCKET)=" /home/ubuntu/repos/zero/apps/server-pilot/.env.production'
```

Expected:

```text
ubuntu can read .env.production
DATABASE_URL exists in file but is not printed by smoke command
file mode is 600
```

- [ ] **Step 5: Verify from EC2**

Run through SSM:

```bash
sudo -u ubuntu bash -lc '
set -euo pipefail
set -a
source /home/ubuntu/repos/zero/apps/server-pilot/.env.production
set +a
psql "$DATABASE_URL" -c "select version();"
aws s3 ls "s3://$S3_BUCKET" --region af-south-1
'
```

Expected:

```text
Postgres version prints.
S3 ls exits 0.
```

- [ ] **Step 6: Resize/downgrade note**

RDS size is easy to change later:

```bash
aws rds modify-db-instance \
  --region af-south-1 \
  --db-instance-identifier nava-zero-mail-pilot \
  --db-instance-class db.t4g.small \
  --apply-immediately
```

Use `db.t4g.small` only if tests show memory/pool waits are fine. Use `db.t4g.large` if CPU credits, memory, or pool waits fail under load.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/env.ts apps/server-pilot/tests/env.test.ts apps/server-pilot/deploy/aws-resources.md apps/server-pilot/deploy/rds-smoke.sh apps/server-pilot/deploy/s3-smoke.sh apps/server-pilot/deploy/write-ec2-env.sh
git commit -m "feat: add aws resource env contract"
```

## Task 3: Package Shell And Runtime Server Switch

**Files:**
- Create: `apps/server-pilot/package.json`
- Create: `apps/server-pilot/tsconfig.json`
- Create: `apps/server-pilot/src/main.ts`
- Create: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/src/lib/auth.ts`
- Create: `apps/server-pilot/src/lib/auth-providers.ts`
- Create: `apps/server-pilot/src/lib/schemas.ts`
- Create: `apps/server-pilot/src/lib/driver/types.ts`
- Test: `apps/server-pilot/tests/package-contract.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces `apps/server-pilot` as runtime `@zero/server` package for this branch.
- Keeps or rewrites `@zero/server/*` exports only where frontend still needs them.
- De-scopes old `apps/server` package resolution if workspace conflict appears.
- Produces `GET /health -> { ok: true, service: "server-pilot" }`.

- [ ] **Step 1: Write package contract test**

```typescript
import { describe, expect, it } from 'vitest';

describe('server-pilot package contract', () => {
  it('exports modules apps/mail imports', async () => {
    await expect(import('@zero/server/trpc')).resolves.toBeDefined();
    await expect(import('@zero/server/auth')).resolves.toBeDefined();
    await expect(import('@zero/server/auth-providers')).resolves.toBeDefined();
    await expect(import('@zero/server/schemas')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Make server-pilot the runtime server package**

Package scripts:

```json
{
  "dev": "tsx watch src/main.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/main.js",
  "worker": "node dist/mail/ingest/worker.js",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "seed:prod": "tsx scripts/seed-prod.ts"
}
```

Workspace rule:

```text
If two packages claim @zero/server, change workspace/package metadata so apps/mail resolves to apps/server-pilot.
Old apps/server may remain on disk for reference, but must not be the runtime package for this branch.
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @zero/server-pilot test tests/package-contract.test.ts
pnpm --filter @zero/server-pilot build
```

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml apps/server-pilot/package.json apps/server-pilot/tsconfig.json apps/server-pilot/src apps/server-pilot/tests/package-contract.test.ts
git commit -m "feat: switch runtime server to server-pilot"
```

## Task 4: Production Mail Schema

**Files:**
- Create: `apps/server-pilot/src/db/schema/auth.ts`
- Create: `apps/server-pilot/src/db/schema/app.ts`
- Create: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/src/db/schema/index.ts`
- Create: `apps/server-pilot/src/db/client.ts`
- Create: `apps/server-pilot/drizzle.config.ts`
- Test: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces target mail-core schema with `mailboxAccess`.
- Produces no `staffMember`, no `mailSnooze`, no `mailPrompt`, no `messageRecipient`.

- [ ] **Step 1: Write schema contract test**

```typescript
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';

describe('v4 production mail schema', () => {
  it('uses mailbox access for owner/member/admin', () => {
    expect(schema.mailboxAccess).toBeDefined();
    expect(schema.mailboxTransport).toBeDefined();
  });

  it('has aggregate ingest and quarantine', () => {
    expect(schema.mailIngestMailbox).toBeDefined();
    expect(schema.mailIngestQuarantine).toBeDefined();
  });

  it('cuts stale table shapes', () => {
    expect((schema as Record<string, unknown>).staffMember).toBeUndefined();
    expect((schema as Record<string, unknown>).mailSnooze).toBeUndefined();
    expect((schema as Record<string, unknown>).mailPrompt).toBeUndefined();
    expect((schema as Record<string, unknown>).messageRecipient).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement schema**

Use Target Tables and Critical Indexes from this plan. Required role type:

```typescript
export const mailboxAccessRoleEnum = pgEnum('mailbox_access_role', ['owner', 'member', 'admin']);
```

Required context columns:

```typescript
mailboxAccess.userId
mailboxAccess.transportId
mailboxAccess.role
mailboxTransport.email
mailboxTransport.ownerHeaderValue
mailboxTransport.mailboxType
mailThread.transportId
mailThread.snoozedUntil
message.transportId
message.ingestMailboxId
message.pop3Uidl
message.ownerHeaderValue
mailDraft.createdByUserId
```

- [ ] **Step 3: Generate and run migration locally**

```bash
pnpm --filter @zero/server-pilot db:generate
pnpm --filter @zero/server-pilot db:migrate
pnpm --filter @zero/server-pilot test tests/schema-contract.test.ts
```

- [ ] **Step 4: Run migration on RDS**

Through EC2 SSM:

```bash
cd ~/repos/zero
pnpm --filter @zero/server-pilot db:migrate
psql "$DATABASE_URL" -c "\dt"
```

Expected: target tables exist on RDS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/db apps/server-pilot/drizzle.config.ts apps/server-pilot/drizzle apps/server-pilot/tests/schema-contract.test.ts
git commit -m "feat: add production mailbox schema"
```

## Task 5: Auth, Mailbox Context, And Seed

**Files:**
- Create: `apps/server-pilot/src/lib/auth.ts`
- Create: `apps/server-pilot/src/trpc/context.ts`
- Create: `apps/server-pilot/scripts/seed-prod.ts`
- Test: `apps/server-pilot/tests/auth-context.test.ts`
- Test: `apps/server-pilot/tests/seed-contract.test.ts`

**Interfaces:**
- Produces `resolveMailboxContext(userId, requestedTransportId?)`.
- Produces seeded `nava@` ingest mailbox and Centurion transport/access rows.

- [ ] **Step 1: Write context tests**

```typescript
import { describe, expect, it } from 'vitest';
import { resolveMailboxContext } from '../src/trpc/context';

describe('mailbox context', () => {
  it('returns owner access for Centurion manager', async () => {
    const ctx = await resolveMailboxContext('user-manager', 'transport-centurion');
    expect(ctx.transportEmail).toBe('centurion@legacyhotel.com');
    expect(ctx.accessRole).toBe('owner');
  });

  it('rejects users without mailboxAccess', async () => {
    await expect(resolveMailboxContext('user-frontdesk', 'transport-centurion')).rejects.toThrow(
      'FORBIDDEN',
    );
  });
});
```

- [ ] **Step 2: Implement context**

```typescript
export type MailboxContext = {
  userId: string;
  activeTransportId: string;
  transportEmail: string;
  accessRole: 'owner' | 'member' | 'admin';
};
```

Every tRPC request loads session user, selected/default mailbox, and proves `mailboxAccess.userId = session.user.id`.

- [ ] **Step 3: Seed production-shaped pilot**

Seed:

```text
mailIngestMailbox: nava@legacyhotel.com
mailboxTransport: transport-centurion, ownerHeaderValue centurion@legacyhotel.com
mailboxAccess: user-manager owner -> transport-centurion
mailboxAccess: user-centurion-worker member -> transport-centurion
mailboxAccess: user-admin admin -> transport-centurion
```

- [ ] **Step 4: Run tests and RDS seed**

```bash
pnpm --filter @zero/server-pilot test tests/auth-context.test.ts tests/seed-contract.test.ts
pnpm --filter @zero/server-pilot seed:prod
```

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/lib/auth.ts apps/server-pilot/src/trpc/context.ts apps/server-pilot/scripts/seed-prod.ts apps/server-pilot/tests/auth-context.test.ts apps/server-pilot/tests/seed-contract.test.ts
git commit -m "feat: add mailbox auth context and seed"
```

## Task 6: Streaming POP3 Ingest

**Files:**
- Create: `apps/server-pilot/src/mail/ingest/pop3-client.ts`
- Create: `apps/server-pilot/src/mail/ingest/parse-message.ts`
- Create: `apps/server-pilot/src/mail/ingest/store.ts`
- Create: `apps/server-pilot/src/mail/ingest/worker.ts`
- Create: `apps/server-pilot/src/storage/s3.ts`
- Test: `apps/server-pilot/tests/ingest-store.test.ts`
- Test: `apps/server-pilot/tests/pop3-worker.test.ts`
- Fixtures: `apps/server-pilot/tests/fixtures/*.eml`

**Interfaces:**
- Produces `parseRawMessage(raw): Promise<ParsedInboundMessage>`.
- Produces `persistInboundMessage(parsed, raw, ingestMeta): Promise<PersistResult>`.
- Produces `ingestOnce(): Promise<IngestCycleResult>`.

- [ ] **Step 1: Write routing/quarantine tests**

```typescript
describe('inbound ingest', () => {
  it('routes stamped Centurion mail to Centurion transport', async () => {
    const parsed = await parseRawMessage(readFixture('centurion-stamped.eml'));
    const result = await persistInboundMessage(parsed, readFixture('centurion-stamped.eml'), {
      ingestMailboxId: 'ingest-nava',
      pop3Uidl: 'uidl-1',
    });
    expect(result.kind).toBe('stored');
    expect(result.transportId).toBe('transport-centurion');
  });

  it('quarantines missing owner marker', async () => {
    const parsed = await parseRawMessage(readFixture('missing-owner.eml'));
    const result = await persistInboundMessage(parsed, readFixture('missing-owner.eml'), {
      ingestMailboxId: 'ingest-nava',
      pop3Uidl: 'uidl-2',
    });
    expect(result.kind).toBe('quarantined');
    expect(result.reason).toBe('missing_owner_header');
  });
});
```

- [ ] **Step 2: Use streaming parser**

Use `MailParser` class, not `simpleParser`.

Attachment handling:

```typescript
parser.on('data', async (part) => {
  if (part.type !== 'attachment') return;
  await putObjectStream({ key, body: part.content, contentType: part.contentType });
  part.release();
});
```

- [ ] **Step 3: Preserve POP3 delete safety**

Worker order:

```text
UIDL -> RETR -> raw MIME S3 PUT -> attachment S3 PUT -> Postgres transaction -> DELE -> QUIT
```

Never `DELE` a message unless S3 and Postgres commit succeed or UIDL is already stored and safe to drain.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @zero/server-pilot test tests/ingest-store.test.ts tests/pop3-worker.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/mail/ingest apps/server-pilot/src/storage apps/server-pilot/tests/ingest-store.test.ts apps/server-pilot/tests/pop3-worker.test.ts apps/server-pilot/tests/fixtures
git commit -m "feat: add streaming pop3 ingest"
```

## Task 7: Mail Router, Access Guards, Drafts, Labels, Attachments

**Files:**
- Create: `apps/server-pilot/src/trpc/router.ts`
- Create: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/src/trpc/routes/connections.ts`
- Create: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Create: `apps/server-pilot/src/trpc/routes/settings.ts`
- Test: `apps/server-pilot/tests/mail-router-isolation.test.ts`
- Test: `apps/server-pilot/tests/attachment-access.test.ts`

**Interfaces:**
- Produces `mail.listThreads`, `mail.get`, `mail.markAsRead`, `mail.toggleStar`, `mail.modifyLabels`, `mail.bulkArchive`, `mail.snoozeThreads`, `mail.send`.
- Produces mailbox list/active-mailbox behavior for the frontend, either through thin `connections.*` compatibility wrappers or by rewriting frontend callers to mailbox-native route names.

- [ ] **Step 1: Write negative isolation tests**

```typescript
describe('mail router isolation', () => {
  it('user without Centurion access cannot list Centurion threads', async () => {
    const result = await callerFor('user-frontdesk').mail.listThreads({ folder: 'inbox' });
    expect(result.threads.every((thread) => thread.transportId !== 'transport-centurion')).toBe(true);
  });

  it('user without Centurion access cannot fetch Centurion thread by id', async () => {
    await expect(callerFor('user-frontdesk').mail.get({ id: 'thread-centurion-1' })).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('user without Centurion access cannot mutate Centurion thread by id', async () => {
    await expect(
      callerFor('user-frontdesk').mail.markAsRead({ threadIds: ['thread-centurion-1'] }),
    ).rejects.toThrow('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Implement guard**

Every mail query/mutation must include:

```typescript
await requireMailboxAccess(ctx.userId, ctx.activeTransportId);
```

Every thread/message lookup must include:

```typescript
eq(mailThread.transportId, ctx.activeTransportId)
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @zero/server-pilot test tests/mail-router-isolation.test.ts tests/attachment-access.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/server-pilot/src/trpc apps/server-pilot/tests/mail-router-isolation.test.ts apps/server-pilot/tests/attachment-access.test.ts
git commit -m "feat: add mailbox-scoped mail router"
```

## Task 8: SMTP Adapter And Fake Send

**Files:**
- Create: `apps/server-pilot/src/mail/send/smtp.ts`
- Test: `apps/server-pilot/tests/mail-send.test.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`

**Interfaces:**
- Produces `mail.send`.
- Rejects arbitrary `fromEmail`.
- Sends through a fake SMTP/test transport in this scope.
- Keeps production SMTP adapter interface ready for later Exchange Send As/service account or SMTP relay.

- [ ] **Step 1: Write send tests**

```typescript
describe('mail.send', () => {
  it('rejects spoofed from address', async () => {
    await expect(
      callerFor('user-centurion-worker').mail.send({
        threadId: 'thread-centurion-1',
        fromEmail: 'frontdesk@legacyhotel.com',
        to: ['guest@example.com'],
        subject: 'Re: booking',
        html: '<p>Hello</p>',
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('sends from selected mailbox and stores outbound row', async () => {
    const result = await callerFor('user-centurion-worker').mail.send(validCenturionReply);
    expect(result.fromEmail).toBe('centurion@legacyhotel.com');
    expect(result.messageId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement sender interface and fake transport**

Default test path uses fake SMTP transport and never connects to the real mail server. Production adapter keeps this shape for later:

```typescript
from: currentTransport.email
inReplyTo: originalMessage.messageId
references: [...originalMessage.references, originalMessage.messageId]
```

- [ ] **Step 3: Verify fake send on EC2**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/mail-send.test.ts
```

Expected: spoof rejection passes, fake send returns a message id, outbound row is stored.

- [ ] **Step 4: Commit**

```bash
git add apps/server-pilot/src/mail/send/smtp.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-send.test.ts
git commit -m "feat: add scoped fake smtp send"
```

## Task 9: Frontend Integration, Persistence, And Polling

**Files:**
- Modify: `apps/mail/providers/query-provider.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/ui/nav-user.tsx`
- Test: `apps/mail/tests/query-cache-policy.test.tsx`
- Test: `apps/mail/tests/thread-polling-policy.test.tsx`
- Test: `apps/mail/tests/logout-cache-clear.test.tsx`

**Interfaces:**
- Allows editing frontend route/hooks/components directly for mailbox-native backend integration.
- Does not require preserving old OAuth `connections.*` APIs if rewriting callers is cleaner.
- Keeps IndexedDB query persistence.
- Query key includes mailbox identity, not `null`.
- Logout/session expiry/account switch clears query client and IDB.
- Real polling can be enabled with `VITE_MAIL_POLL_MS=30000`.

- [ ] **Step 1: Write cache policy tests**

```typescript
describe('query cache policy', () => {
  it('hashes live query keys with active mailbox context', () => {
    expect(makeLiveQueryHashPrefix({ userId: 'u1', activeTransportId: 't1' })).toEqual({
      userId: 'u1',
      activeTransportId: 't1',
    });
  });

  it('clears query cache and idb on logout', async () => {
    const cleared = await runLogoutCleanup({ queryClient: fakeQueryClient, clearIdb: fakeClearIdb });
    expect(cleared.queryClient).toBe(true);
    expect(cleared.idb).toBe(true);
  });
});
```

- [ ] **Step 2: Write polling test**

```typescript
describe('thread polling policy', () => {
  it('uses configured foreground interval', () => {
    expect(resolveThreadPollingMs('30000')).toBe(30000);
  });

  it('disables invalid or too-low intervals', () => {
    expect(resolveThreadPollingMs('1000')).toBe(null);
    expect(resolveThreadPollingMs(undefined)).toBe(null);
  });
});
```

- [ ] **Step 3: Implement helpers**

```typescript
export function resolveThreadPollingMs(value?: string): number | null {
  if (!value) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 15_000) return null;
  return ms;
}
```

Thread query:

```typescript
refetchInterval: threadPollingMs ?? false,
refetchIntervalInBackground: false,
refetchOnWindowFocus: true,
```

- [ ] **Step 4: Replace old connection assumptions**

Search and update frontend code:

```bash
rg "connections\\.|connectionId|defaultConnectionId|useConnections|useActiveConnection" apps/mail
```

Implementation rule:

```text
Use mailbox-native names in new code: activeTransportId, mailboxAccess, mailboxTransport.
Keep a thin compatibility wrapper only if it reduces frontend churn without hiding ownership rules.
Do not preserve old OAuth multi-connection semantics.
```

- [ ] **Step 5: Run tests and build**

```bash
pnpm --filter @zero/mail test:demo tests/query-cache-policy.test.tsx tests/thread-polling-policy.test.tsx tests/logout-cache-clear.test.tsx
pnpm --filter @zero/mail build
```

- [ ] **Step 6: Commit**

```bash
git add apps/mail/providers/query-provider.tsx apps/mail/hooks/use-threads.ts apps/mail/components/ui/nav-user.tsx apps/mail/tests/query-cache-policy.test.tsx apps/mail/tests/thread-polling-policy.test.tsx apps/mail/tests/logout-cache-clear.test.tsx
git commit -m "feat: scope mail query cache and polling"
```

## Task 10: nginx, PM2, Deploy, And Health Checks

**Files:**
- Create: `apps/server-pilot/deploy/nginx.conf`
- Create: `apps/server-pilot/deploy/pm2.config.cjs`
- Create: `apps/server-pilot/deploy/deploy-ec2.sh`
- Create: `apps/server-pilot/tests/deploy-config.test.ts`

**Interfaces:**
- Produces one nginx HTTPS/static SPA host and `/api/*` proxy.
- Produces PM2 apps: one `http`, one `worker`.

- [ ] **Step 1: Write deploy config test**

```typescript
describe('deploy config', () => {
  it('runs exactly one worker', () => {
    const pm2 = loadPm2Config();
    expect(pm2.apps.filter((app) => app.name === 'worker')).toHaveLength(1);
    expect(pm2.apps.find((app) => app.name === 'worker').instances).toBe(1);
  });
});
```

- [ ] **Step 2: Add nginx shape**

```nginx
server {
  listen 443 ssl;
  server_name nava.legacy.local;

  root /var/www/nava-mail;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:8788/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 3: Add PM2 config**

```javascript
module.exports = {
  apps: [
    { name: 'http', script: 'dist/main.js', cwd: '/home/ubuntu/repos/zero/apps/server-pilot', instances: 1 },
    { name: 'worker', script: 'dist/mail/ingest/worker.js', cwd: '/home/ubuntu/repos/zero/apps/server-pilot', instances: 1 },
  ],
};
```

- [ ] **Step 4: Deploy on EC2**

```bash
pnpm install --frozen-lockfile
pnpm --filter @zero/server-pilot build
pnpm --filter @zero/mail build
sudo mkdir -p /var/www/nava-mail
sudo rsync -a apps/mail/build/client/ /var/www/nava-mail/
pm2 start apps/server-pilot/deploy/pm2.config.cjs
pm2 save
curl -fsS http://127.0.0.1:8788/health
```

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/deploy/nginx.conf apps/server-pilot/deploy/pm2.config.cjs apps/server-pilot/deploy/deploy-ec2.sh apps/server-pilot/tests/deploy-config.test.ts
git commit -m "feat: add ec2 deploy config"
```

## Task 11: Deferred Real-Mail Readiness Notes

**Files:**
- Create: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`
- Create: `apps/server-pilot/deploy/vpn-route-check.sh`
- Create: `apps/server-pilot/deploy/exchange-smoke.md`

**Interfaces:**
- Documents that VPN is not connected now and should not block current work.
- Documents future route/mail-server checks for the later real-ingest phase.
- Produces scripts/docs only; no real VPN/mail-server connection is required in this scope.

- [ ] **Step 1: Add deferred readiness doc**

Create `apps/server-pilot/deploy/deferred-real-mail-readiness.md`:

```markdown
# Deferred Real-Mail Readiness

Current scope:

- Backend runs on EC2.
- Frontend connects to backend.
- RDS/S3-backed schema works.
- Fixture ingest works.
- Fake SMTP send works.
- Isolation/load/build tests pass.

Explicitly out of scope for this implementation pass:

- Connecting VPN.
- Connecting to Exchange/on-prem POP3/SMTP.
- Sending real email.
- Receiving/deleting real email from `nava@`.
- AI chatbot assistant work.
- workflow-use Chromium/API integration.

Later real-ingest phase gates:

- Start VPN profile provided by IT.
- Verify SSM, RDS, S3 still work after VPN.
- Verify POP3/SMTP reachability.
- Send test email to Centurion.
- Confirm copied raw mail includes `X-Zero-Mailbox: centurion@legacyhotel.com`.
- Run worker against real `nava@` only after fixture/fake tests are green.
```

- [ ] **Step 2: Add future VPN route check script**

`vpn-route-check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "== identity =="
hostname
whoami

echo "== routes =="
ip route

echo "== aws sts =="
aws sts get-caller-identity --region "${AWS_REGION:-af-south-1}" >/tmp/aws-sts.json
cat /tmp/aws-sts.json

echo "== rds =="
psql "$DATABASE_URL" -c "select 1;"

echo "== s3 =="
aws s3 ls "s3://$S3_BUCKET" --region "${AWS_REGION:-af-south-1}" >/dev/null

echo "== pop3/smtp =="
if [ -n "${POP3_HOST:-}" ] && [ -n "${POP3_PORT:-}" ]; then
  nc -vz "$POP3_HOST" "$POP3_PORT"
else
  echo "POP3_HOST/POP3_PORT unset; skipped because real mail connection is deferred"
fi

if [ -n "${SMTP_HOST:-}" ] && [ -n "${SMTP_PORT:-}" ]; then
  nc -vz "$SMTP_HOST" "$SMTP_PORT"
else
  echo "SMTP_HOST/SMTP_PORT unset; skipped because real mail connection is deferred"
fi
```

- [ ] **Step 3: Document current no-VPN expectation**

Expected:

```text
AWS STS OK
RDS OK
S3 OK
POP3/SMTP skipped or may fail because real mail connection is deferred
```

- [ ] **Step 4: Document future after-VPN expectation**

Expected:

```text
AWS STS still OK
SSM still Online from laptop
RDS still OK
S3 still OK
POP3/SMTP OK
```

Future fix if VPN breaks AWS/SSM/RDS:

- Check `ip route` default route before/after.
- Prefer split tunnel from IT.
- If no split tunnel, add VPC endpoints for `ssm`, `ssmmessages`, `ec2messages`, S3 gateway endpoint, CloudWatch Logs, Secrets Manager where needed.
- Keep RDS in local VPC path; never make RDS public to solve VPN routing.

- [ ] **Step 5: Document future real mail smoke**

When real mail becomes in scope, send test email to Centurion and verify:

```text
raw copy lands in nava@
raw headers include X-Zero-Mailbox: centurion@legacyhotel.com
worker ingests and deletes only after persistence
manager and member can see thread
frontdesk user cannot see thread
reply sends as centurion@legacyhotel.com
```

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/deploy/deferred-real-mail-readiness.md apps/server-pilot/deploy/vpn-route-check.sh apps/server-pilot/deploy/exchange-smoke.md
git commit -m "docs: add deferred real-mail readiness gates"
```

## Task 12: Load, Capacity, Alarms, And Overnight Final Gate

**Files:**
- Create: `apps/server-pilot/scripts/load-50-users.ts`
- Create: `apps/server-pilot/scripts/ingest-benchmark.ts`
- Create: `apps/server-pilot/deploy/cloudwatch-alarms.md`
- Create: `docs/superpowers/plans/2026-07-01-ec2-production-v4-overnight-report.md`

**Interfaces:**
- Produces 50-user HTTP load test.
- Produces 15,000 delivered-copy/day ingest simulation.
- Produces final overnight report.

- [ ] **Step 1: Load script requirements**

Scenario:

```text
50 authenticated sessions
thread list every 30s
10 concurrent thread opens
5 concurrent sends through fake SMTP or test mailbox
worker ingest running
p95 list/get < 1000ms on EC2
0 5xx bursts
no sustained DB pool wait
```

- [ ] **Step 2: Ingest benchmark requirements**

Scenario:

```text
1,000 fixture messages
100 PDF-like attachments
streaming parser enabled
max RSS recorded
15,000 delivered-copy/day extrapolation shows no growing UIDL backlog
```

- [ ] **Step 3: CloudWatch alarms**

Create alarms or document exact CLI for:

```text
EC2 CPU > 80%
EC2 memory > 80% if CloudWatch Agent installed
RDS CPU > 80%
RDS FreeableMemory low
RDS DatabaseConnections high
RDS CPUCreditBalance low for burstable class
worker LastSuccessfulPollAgeSeconds > 900
UIDL backlog grows 3 polls
quarantine count > 0
HTTP 5xx > 0 sustained
```

- [ ] **Step 4: Run final EC2 gate**

```bash
pnpm --filter @zero/server-pilot test
pnpm --filter @zero/server-pilot build
pnpm --filter @zero/mail build
pnpm --filter @zero/server-pilot tsx scripts/ingest-benchmark.ts
pnpm --filter @zero/server-pilot tsx scripts/load-50-users.ts
curl -fsS http://127.0.0.1:8788/health
pm2 status
```

- [ ] **Step 5: Write overnight report**

`docs/superpowers/plans/2026-07-01-ec2-production-v4-overnight-report.md`:

```markdown
# V4 Overnight Report

## Summary

- Completed:
- Not completed:
- Current EC2 URL:
- RDS identifier:
- S3 bucket:

## Verification

- Server tests:
- Frontend build:
- RDS migration:
- Fixture/fake ingest benchmark:
- 50-user load:
- Deferred VPN route check: not run in current scope
- Deferred Exchange POP3/SMTP check: not run in current scope

## RCA Log

- Link to `2026-07-01-ec2-production-v4-overnight-rca.md`

## Remaining Human Steps

- Exchange transport rule confirmation:
- VPN profile/credentials if missing:
- DNS/TLS production hostname:
```

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/scripts/load-50-users.ts apps/server-pilot/scripts/ingest-benchmark.ts apps/server-pilot/deploy/cloudwatch-alarms.md docs/superpowers/plans/2026-07-01-ec2-production-v4-overnight-report.md
git commit -m "test: add ec2 capacity gates"
```

## Acceptance Gates

### Schema Gates

- `mailboxAccess` exists and is used for owner/member/admin.
- No `staffMember`.
- No `mailSnooze`; snooze is `mailThread.snoozedUntil`.
- No `mailPrompt` in mail-core pilot.
- No `messageRecipient`.
- `(ingestMailboxId, pop3Uidl)` inbound unique index exists.

### Isolation Gates

- User without `mailboxAccess` cannot list/get/mutate another mailbox.
- User without `mailboxAccess` cannot fetch attachments for another mailbox.
- Shared inbox owner/member see same thread state.
- Admin access works only through explicit `mailboxAccess.role = admin`.
- SMTP spoofed `fromEmail` is rejected.

### Frontend Gates

- React Query persistence remains enabled.
- Query key/hash includes `userId + activeTransportId` or equivalent live mailbox identity.
- Logout clears query client and IDB before redirect.
- Account/mailbox switch clears query client and invalidates list/get queries.
- `VITE_MAIL_POLL_MS=30000` produces real `refetchInterval`.
- No background polling unless explicitly enabled after load test.

### EC2/RDS Gates

- SSM `PingStatus = Online`.
- RDS private Postgres reachable from EC2.
- S3 bucket reachable from EC2.
- PM2 runs exactly one HTTP process and one worker.
- nginx serves built SPA and proxies `/api/*`.
- RDS backup retention enabled.
- CloudWatch alarms documented or created.

### Fixture/Fake Mail Gates

- Fixture `.eml` with `X-Zero-Mailbox: centurion@legacyhotel.com` ingests into Centurion transport.
- Fixture `.eml` with missing/unknown `X-Zero-Mailbox` quarantines.
- Fake POP3 session deletes only after S3 and RDS persistence.
- Fake SMTP send returns a message id and stores outbound row.
- No test requires VPN, real POP3, real SMTP, or hotel mail-server credentials.

### Deferred Real-Mail Gates

These are not required for current plan completion:

- VPN profile starts and preserves SSM/RDS/S3/AWS reachability.
- POP3 and SMTP reachable from EC2 when VPN/IT config is present.
- Test copy in real `nava@` has `X-Zero-Mailbox: centurion@legacyhotel.com`.
- Worker drains real `nava@`.
- Reply sends through real Exchange/SMTP as `centurion@legacyhotel.com`.

### Load Gates

- 1,000 fixture ingest completes without OOM.
- PDF attachment parsing streams; RSS stays below EC2 memory budget.
- 50-user load passes while worker ingests.
- p95 list/get under 1s on EC2.
- No sustained DB pool waits.
- No growing UIDL backlog under 15,000 delivered-copy/day simulation.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-01-ec2-production-v4-local-first-implementation-plan.md`.

Use **Subagent-Driven Development** for overnight work:

1. Dispatch one fresh subagent per task.
2. Prompt every subagent with `/caveman ultra`.
3. Give each subagent only its task section plus Global Constraints and Autonomous Overnight Protocol.
4. Parent agent reviews diff/tests after each task.
5. Commit every green task.
6. If any task fails, run RCA/research/fix loop and continue.
7. User is asleep; do not wait for prompts unless true human-only blocker.
8. Do not treat VPN, real mail server, AI chatbot assistant, or workflow-use Chromium/API work as blockers. They are out of scope.
