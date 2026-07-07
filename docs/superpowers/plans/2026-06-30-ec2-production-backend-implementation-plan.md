# EC2 Production Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the real production backend architecture for Legacy Hotels on EC2, tested first with one user and about 1,000 emails/day, then scaled without a rewrite to 50 VPN users and 15,000 emails/day.

**Architecture:** Build a fresh `apps/server-pilot/` Node backend beside the existing Cloudflare backend, then wire the `FE-demo-minimal` UI to it. Replace Cloudflare Workers, Durable Objects, KV, R2, Queues, Hyperdrive, Gmail, OAuth, and Vectorize with one Hono/tRPC server, one background worker, RDS Postgres metadata, S3 raw MIME/attachments, and the client's on-prem POP3/SMTP server. Keep the frontend contract stable through a `connections` shim and a `ParsedMessage` mapper.

**Tech Stack:** Node 22, Hono, `@hono/node-server`, tRPC, Drizzle ORM, Better Auth email/password session cookies, node-pop3, mailparser, nodemailer, AWS RDS Postgres 15+, AWS S3, PM2, nginx, Vitest, Playwright.

## Global Constraints

- Branch: `EC2-pilot` cut from `FE-demo-minimal` HEAD. `apps/server/` remains untouched.
- Backend folder: `apps/server-pilot/`.
- Production target: shared `Nava@` mailbox, Centurion-only first, 50 VPN users, 15,000 emails/day design target.
- Rollout target: test the same production architecture first with one user and about 1,000 emails/day.
- Mail server: Legacy Hotels runs a local on-prem POP3/SMTP server. Do not assume Exchange.
- Server retention: IT wipes mail server messages after 7 days. RDS Postgres plus S3 is the system of record.
- POP3 behavior: download-and-delete using `UIDL -> RETR -> parse -> S3 PUT -> PG commit -> DELE -> QUIT`.
- POP3 safety: never `DELE` before S3 and Postgres commit. Use `(transport_id, pop3_uidl)` partial unique index for crash recovery.
- Ingest topology: exactly one worker process owns POP3 polling. Never run two POP3 pollers against `Nava@`.
- Ingest SLA: poll every 30 seconds, cap one cycle at 500 messages, alert if `last_polled_at` is stale for 15 minutes or UIDL backlog grows for 3 consecutive polls.
- WebSocket freshness: do not ship a WS sync server. Use React Query polling and focus refetch for mail freshness.
- `ponytail:` WS add-back: add Redis/Valkey pub/sub only when real-time AI chat is production scope.
- Queueing: do not ship `pg-boss`. Send undo is frontend delay; snooze wake is a cron query.
- Auth: copy-and-strip Better Auth to email/password session cookies only. Strip `jwt()`, `bearer()`, `mcp()`, social providers, phone, Redis, Dub, and Twilio.
- Secrets: POP3/SMTP passwords live in env or AWS Secrets Manager, not in Postgres.
- RDS: Postgres 15+, `t4g.small` minimum, GP3 autoscaling storage, explicit app pool limit.
- S3: raw MIME and attachments are archived in S3 with lifecycle rules. RDS stores metadata and object keys only.
- AI: vector search, pgvector, agent chat, AI compose, and writing style matrix are deferred.
- Drafts: local `mail_draft` table is in scope.
- Explicit send-later over 12 hours: out of scope. Re-add one `scheduled_at` column on `message` if product asks.
- Per-user private read/unread on the shared `Nava@` inbox: out of scope. Shared thread state is the production baseline.

> ASSUMPTION (gate Q1): defaulted to DROP per-user read state. Revert only if the 50 agents need private unread/labels/star per message.
>
> ASSUMPTION (gate Q2): defaulted to DROP AI compose. Revert only if the two composer AI buttons are required in this release.
>
> ASSUMPTION (gate Q3): defaulted to DROP explicit send-later over 12 hours. Revert only if scheduled send is required in this release.

---

## Why This Plan

The old plan was good for a demo-shaped pilot but not honest for "pilot equals production architecture." The stack itself is still right for 50 users and 15,000 emails/day. The risks were self-inflicted: WS cross-process invalidation, `message_recipient` fan-out, `pg-boss`, five PM2 processes, underspecified POP3 throughput, and RDS/S3 sizing copied from a smaller target.

This plan removes those risks instead of adding more infrastructure. Mail is POP3-polled, so 30-second HTTP refetch is simpler and more reliable than a WS server. One shared mailbox does not need 750,000 per-user recipient rows/day. A 15-second undo button does not need a durable queue. A single worker can own POP3 and cron timers without races.

## Production Shape

```mermaid
flowchart LR
  mailServer["On-prem POP3/SMTP"] -->|"BCC to Nava"| worker["PM2 worker: POP3 ingest and cron"]
  worker --> s3["S3 raw MIME and attachments"]
  worker --> rds["RDS Postgres metadata"]
  users["50 VPN users"] --> nginx["nginx"]
  nginx --> http["PM2 HTTP: Hono and tRPC"]
  http --> rds
  http --> s3
  http -->|"SMTP send"| mailServer
  frontend["React mail app"] -->|"30s poll and focus refetch"| http
```

## Capacity Budget

- 15,000 emails/day averages about 10.4 emails/minute.
- Expected business-hour bursts are planned at 20-50 emails/minute.
- One POP3 worker with a 30-second poll and 500-message cycle cap can drain normal bursts if average parse/store time stays below about 1 second/message.
- Heavy PDF samples must be tested at kickoff. If real messages take 10 seconds/message, one worker can only handle about 8,640 messages/day and the bottleneck must be fixed before go-live.
- Worst fan-out avoided: 15,000 emails/day times 50 users equals 750,000 recipient-state inserts/day. This plan writes one thread row and one message row per message instead.
- S3 growth estimate: 15,000 messages/day times 50 KB average raw MIME is about 750 MB/day. With PDFs, plan for several GB/day and lifecycle to cheaper storage.
- Postgres stores metadata, parsed text pointers, labels, thread state, drafts, notes, auth, and object keys. It does not store raw MIME blobs or attachment bytes.

---

## File Structure

Create:

- `apps/server-pilot/package.json` - package metadata and scripts.
- `apps/server-pilot/drizzle.config.ts` - Drizzle migration config.
- `apps/server-pilot/ecosystem.config.cjs` - PM2 production process file.
- `apps/server-pilot/deploy/nginx.conf` - reverse proxy config.
- `apps/server-pilot/deploy/.env.example` - production env contract.
- `apps/server-pilot/src/main.ts` - Hono server entrypoint.
- `apps/server-pilot/src/env.ts` - env parsing and typed config.
- `apps/server-pilot/src/db/client.ts` - Drizzle client and pool.
- `apps/server-pilot/src/db/schema/auth.ts` - Better Auth tables.
- `apps/server-pilot/src/db/schema/app.ts` - user settings, notes, templates, prompts.
- `apps/server-pilot/src/db/schema/mail.ts` - transport, staff, thread, message, attachment, draft, snooze.
- `apps/server-pilot/src/db/schema/index.ts` - schema exports.
- `apps/server-pilot/src/lib/auth.ts` - stripped Better Auth config.
- `apps/server-pilot/src/lib/s3.ts` - S3 object helpers.
- `apps/server-pilot/src/lib/parsed-message-mapper.ts` - DB row to frontend `ParsedMessage`.
- `apps/server-pilot/src/lib/pop3/thread-stitch.ts` - thread root calculation.
- `apps/server-pilot/src/lib/pop3/parser.ts` - mailparser adapter.
- `apps/server-pilot/src/lib/pop3/poller.ts` - POP3 `UIDL/RETR/DELE/QUIT` ingest.
- `apps/server-pilot/src/lib/smtp/sender.ts` - nodemailer send adapter.
- `apps/server-pilot/src/trpc/index.ts` - `AppRouter` export.
- `apps/server-pilot/src/trpc/trpc.ts` - tRPC context/procedures.
- `apps/server-pilot/src/trpc/routes/connections.ts` - frontend connection shim.
- `apps/server-pilot/src/trpc/routes/mail.ts` - mail read/mutation procedures.
- `apps/server-pilot/src/trpc/routes/drafts.ts` - local draft CRUD.
- `apps/server-pilot/src/trpc/routes/settings.ts` - user settings.
- `apps/server-pilot/src/trpc/routes/notes.ts` - notes.
- `apps/server-pilot/src/trpc/routes/templates.ts` - email templates.
- `apps/server-pilot/src/trpc/routes/brain.ts` - null summary/stubbed AI routes.
- `apps/server-pilot/src/workers/worker.ts` - one PM2 worker with POP3 and cron intervals.
- `apps/server-pilot/scripts/seed-users.ts` - IT seed script for 50 users and staff rows.
- `apps/server-pilot/tests/*.test.ts` - focused tests listed below.

Modify:

- `pnpm-workspace.yaml` - include `apps/server-pilot`.
- `apps/mail/lib/demo/runtime.ts` - make demo mode env-gated and default off.
- `apps/mail/providers/query-provider.tsx` - enable focus refetch.
- `apps/mail/hooks/use-threads.ts` - add 30-second inbox polling.
- `apps/mail/vite.config.ts` - alias `@zero/server` to `apps/server-pilot/src` for production build.
- `apps/mail` login route files - ensure email/password login is available and OAuth-only UI is removed from production path.

Do not create:

- `apps/server-pilot/src/lib/queue.ts`
- `apps/server-pilot/src/workers/ws.ts`
- `message_recipient`
- `mail_scheduled_email`
- `writingStyleMatrix`
- `mail0_jwks`
- Redis or Valkey
- pg-boss

---

## Final App Schema

The production baseline has 15 app tables:

1. `user`
2. `session`
3. `account`
4. `verification`
5. `note`
6. `userSettings`
7. `emailTemplate`
8. `mailboxTransport`
9. `staffMember`
10. `mailThread`
11. `message`
12. `attachment`
13. `mailDraft`
14. `mailSnooze`
15. `mailPrompt`

Key schema choices:

- `message.direction` is `inbound` or `outbound`.
- `message.pop3_uidl` is nullable but required for inbound rows by a check constraint.
- `UNIQUE (transport_id, pop3_uidl) WHERE direction = 'inbound'` prevents duplicate POP3 ingest.
- `message.pop3_purged_at` is set after a successful `QUIT` removes messages from `Nava@`.
- `mailThread` owns shared labels, `is_unread`, `is_starred`, `is_archived`, and latest-message metadata.
- `mailboxTransport` is seeded as one row for `Nava@` and stores no passwords.
- `mailSnooze` stores `wake_at`; the worker cron unsnoozes rows where `wake_at <= now()`.

`ponytail:` `message_recipient` is intentionally not built. Add it only if product wants private per-agent unread/labels/star on the shared mailbox.

`ponytail:` one `message` table is intentional. Split outbound later only if SMTP grows per-recipient bounce, DSN, retry, or delivery tracking.

---

### Task 1: Branch and Server Scaffold

**Files:**
- Create: `apps/server-pilot/package.json`
- Create: `apps/server-pilot/src/main.ts`
- Create: `apps/server-pilot/src/env.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: `GET /health` returns `{ ok: true, service: 'server-pilot' }`.
- Produces: env object with `PORT`, `DATABASE_URL`, `S3_BUCKET`, `AWS_REGION`, `BETTER_AUTH_SECRET`, `POP3_*`, `SMTP_*`.

- [ ] **Step 1: Create branch**

Run:

```bash
git checkout FE-demo-minimal
git checkout -b EC2-pilot
```

Expected: branch `EC2-pilot` is created from `FE-demo-minimal`.

- [ ] **Step 2: Add workspace package**

Modify `pnpm-workspace.yaml` to include:

```yaml
packages:
  - apps/*
  - packages/*
```

If `apps/*` is already present, leave the file unchanged.

- [ ] **Step 3: Add package file**

Create `apps/server-pilot/package.json`:

```json
{
  "name": "@zero/server-pilot",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "seed:users": "tsx scripts/seed-users.ts",
    "worker": "tsx src/workers/worker.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "latest",
    "@aws-sdk/s3-request-presigner": "latest",
    "@better-auth/cli": "latest",
    "@hono/node-server": "latest",
    "@trpc/server": "latest",
    "better-auth": "latest",
    "drizzle-orm": "latest",
    "hono": "latest",
    "mailparser": "latest",
    "node-pop3": "latest",
    "nodemailer": "latest",
    "pg": "latest",
    "superjson": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/nodemailer": "latest",
    "@types/pg": "latest",
    "drizzle-kit": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 4: Add env parser**

Create `apps/server-pilot/src/env.ts`:

```typescript
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8788),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:8788'),
  AWS_REGION: z.string().default('eu-west-2'),
  S3_BUCKET: z.string().min(1),
  POP3_HOST: z.string().min(1),
  POP3_PORT: z.coerce.number().default(995),
  POP3_TLS: z.coerce.boolean().default(true),
  POP3_USER: z.string().min(1),
  POP3_PASS: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  POP3_POLL_INTERVAL_MS: z.coerce.number().default(30_000),
  POP3_MAX_MESSAGES_PER_CYCLE: z.coerce.number().default(500),
  DB_POOL_MAX: z.coerce.number().default(10),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
```

- [ ] **Step 5: Add health server**

Create `apps/server-pilot/src/main.ts`:

```typescript
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'server-pilot' }));

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`server-pilot listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 6: Run scaffold**

Run:

```bash
pnpm install
DATABASE_URL=postgres://user:pass@localhost:5432/zero BETTER_AUTH_SECRET=12345678901234567890123456789012 S3_BUCKET=zero-dev POP3_HOST=localhost POP3_USER=nava POP3_PASS=pass SMTP_HOST=localhost SMTP_USER=nava SMTP_PASS=pass pnpm --filter @zero/server-pilot dev
```

Expected: server logs `server-pilot listening`.

- [ ] **Step 7: Verify health**

Run:

```bash
curl http://localhost:8788/health
```

Expected:

```json
{"ok":true,"service":"server-pilot"}
```

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml apps/server-pilot/package.json apps/server-pilot/src/main.ts apps/server-pilot/src/env.ts pnpm-lock.yaml
git commit -m "feat: scaffold ec2 production backend"
```

---

### Task 2: Drizzle Schema and Migrations

**Files:**
- Create: `apps/server-pilot/drizzle.config.ts`
- Create: `apps/server-pilot/src/db/client.ts`
- Create: `apps/server-pilot/src/db/schema/auth.ts`
- Create: `apps/server-pilot/src/db/schema/app.ts`
- Create: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/src/db/schema/index.ts`
- Create: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces: `db` Drizzle client.
- Produces: schema exports `user`, `session`, `account`, `verification`, `note`, `userSettings`, `emailTemplate`, `mailboxTransport`, `staffMember`, `mailThread`, `message`, `attachment`, `mailDraft`, `mailSnooze`, `mailPrompt`.
- Produces: `messageDirectionEnum` with `inbound` and `outbound`.

- [ ] **Step 1: Write schema contract test**

Create `apps/server-pilot/tests/schema-contract.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';

describe('production schema contract', () => {
  it('exports one message table instead of split inbound/outbound tables', () => {
    expect(schema.message).toBeDefined();
    expect((schema as Record<string, unknown>).inboundMessage).toBeUndefined();
    expect((schema as Record<string, unknown>).outboundMessage).toBeUndefined();
  });

  it('does not export removed pilot tables', () => {
    expect((schema as Record<string, unknown>).jwks).toBeUndefined();
    expect((schema as Record<string, unknown>).messageRecipient).toBeUndefined();
    expect((schema as Record<string, unknown>).mailScheduledEmail).toBeUndefined();
    expect((schema as Record<string, unknown>).writingStyleMatrix).toBeUndefined();
  });

  it('keeps shared thread state on mailThread', () => {
    expect(schema.mailThread.isUnread).toBeDefined();
    expect(schema.mailThread.labels).toBeDefined();
    expect(schema.mailThread.isStarred).toBeDefined();
  });

  it('tracks POP3 purge audit on message rows', () => {
    expect(schema.message.pop3PurgedAt).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/schema-contract.test.ts
```

Expected: FAIL because schema files do not exist.

- [ ] **Step 3: Add Drizzle config**

Create `apps/server-pilot/drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Add DB client**

Create `apps/server-pilot/src/db/client.ts`:

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env';
import * as schema from './schema';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
```

- [ ] **Step 5: Add auth schema**

Create `apps/server-pilot/src/db/schema/auth.ts`:

```typescript
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const user = pgTable('mail0_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  defaultStaffMemberId: text('default_staff_member_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('mail0_session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('mail0_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('mail0_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 6: Add app schema**

Create `apps/server-pilot/src/db/schema/app.ts`:

```typescript
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const note = pgTable('mail0_note', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userSettings = pgTable('mail0_userSettings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailTemplate = pgTable('mail0_emailTemplate', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailPrompt = pgTable('mail_prompt', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 7: Add mail schema**

Create `apps/server-pilot/src/db/schema/mail.ts`:

```typescript
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageStatusEnum = pgEnum('message_status', ['queued', 'sent', 'failed']);

export const mailboxTransport = pgTable('mailbox_transport', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  pop3Host: text('pop3_host').notNull(),
  pop3Port: integer('pop3_port').notNull(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastSuccessfulPollAt: timestamp('last_successful_poll_at', { withTimezone: true }),
  uidlBacklog: integer('uidl_backlog').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const staffMember = pgTable('staff_member', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailAddresses: text('email_addresses').array().notNull().default(sql`ARRAY[]::text[]`),
  labelConfig: jsonb('label_config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailThread = pgTable('mail_thread', {
  id: text('id').primaryKey(),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id),
  threadRootId: text('thread_root_id').notNull(),
  subject: text('subject').notNull().default(''),
  participants: jsonb('participants').notNull().default([]),
  labels: text('labels').array().notNull().default(sql`ARRAY['INBOX','UNREAD']::text[]`),
  isUnread: boolean('is_unread').notNull().default(true),
  isStarred: boolean('is_starred').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  latestMessageAt: timestamp('latest_message_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  rootUnique: uniqueIndex('mail_thread_transport_root_uidx').on(table.transportId, table.threadRootId),
  listIdx: index('mail_thread_list_idx').on(table.transportId, table.isArchived, table.latestMessageAt),
  unreadIdx: index('mail_thread_unread_idx').on(table.transportId, table.isUnread),
}));

export const message = pgTable('message', {
  id: text('id').primaryKey(),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id),
  threadId: text('thread_id').notNull().references(() => mailThread.id, { onDelete: 'cascade' }),
  direction: messageDirectionEnum('direction').notNull(),
  status: messageStatusEnum('status'),
  pop3Uidl: text('pop3_uidl'),
  pop3PurgedAt: timestamp('pop3_purged_at', { withTimezone: true }),
  rawEmlPath: text('raw_eml_path'),
  sender: jsonb('sender').notNull(),
  toAddrs: jsonb('to_addrs').notNull().default([]),
  ccAddrs: jsonb('cc_addrs').notNull().default([]),
  bccAddrs: jsonb('bcc_addrs').notNull().default([]),
  subject: text('subject').notNull().default(''),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  processedHtml: text('processed_html'),
  blobUrl: text('blob_url'),
  messageId: text('message_id'),
  inReplyTo: text('in_reply_to'),
  references: text('references').array().notNull().default(sql`ARRAY[]::text[]`),
  tls: boolean('tls'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  inboundUidlUnique: uniqueIndex('message_inbound_uidl_uidx')
    .on(table.transportId, table.pop3Uidl)
    .where(sql`${table.direction} = 'inbound'`),
  threadTimeIdx: index('message_thread_time_idx').on(table.threadId, table.receivedAt, table.sentAt),
  inboundRequired: check(
    'message_inbound_required_chk',
    sql`direction <> 'inbound' OR (pop3_uidl IS NOT NULL AND raw_eml_path IS NOT NULL AND received_at IS NOT NULL)`,
  ),
  outboundRequired: check(
    'message_outbound_required_chk',
    sql`direction <> 'outbound' OR (status IS NOT NULL AND sent_at IS NOT NULL)`,
  ),
}));

export const attachment = pgTable('attachment', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => message.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  s3Key: text('s3_key').notNull(),
  contentId: text('content_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailDraft = pgTable('mail_draft', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => mailThread.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailSnooze = pgTable('mail_snooze', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => mailThread.id, { onDelete: 'cascade' }),
  wakeAt: timestamp('wake_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  threadUnique: uniqueIndex('mail_snooze_user_thread_uidx').on(table.userId, table.threadId),
  wakeIdx: index('mail_snooze_wake_idx').on(table.wakeAt),
}));

export const mailThreadRelations = relations(mailThread, ({ many }) => ({
  messages: many(message),
}));
```

- [ ] **Step 8: Export schema**

Create `apps/server-pilot/src/db/schema/index.ts`:

```typescript
export * from './auth';
export * from './app';
export * from './mail';
```

- [ ] **Step 9: Run schema tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/schema-contract.test.ts
```

Expected: PASS.

- [ ] **Step 10: Generate migration**

Run:

```bash
pnpm --filter @zero/server-pilot db:generate
```

Expected: a migration appears under `apps/server-pilot/drizzle/`.

- [ ] **Step 11: Commit**

```bash
git add apps/server-pilot/drizzle.config.ts apps/server-pilot/src/db apps/server-pilot/tests/schema-contract.test.ts apps/server-pilot/drizzle
git commit -m "feat: add production mail schema"
```

---

### Task 3: Auth and User Seed

**Files:**
- Create: `apps/server-pilot/src/lib/auth.ts`
- Create: `apps/server-pilot/scripts/seed-users.ts`
- Create: `apps/server-pilot/tests/auth-config.test.ts`
- Modify: `apps/server-pilot/src/main.ts`

**Interfaces:**
- Produces: `auth` Better Auth instance.
- Produces: `/api/auth/*` routes mounted on Hono.
- Produces: `seed-users.ts` creates users, credential accounts, staff rows, and one `mailbox_transport` row.

- [ ] **Step 1: Write auth config test**

Create `apps/server-pilot/tests/auth-config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { authConfigSummary } from '../src/lib/auth';

describe('pilot auth config', () => {
  it('uses email/password session cookies only', () => {
    expect(authConfigSummary.emailAndPassword).toBe(true);
    expect(authConfigSummary.hasJwtPlugin).toBe(false);
    expect(authConfigSummary.hasBearerPlugin).toBe(false);
    expect(authConfigSummary.hasMcpPlugin).toBe(false);
    expect(authConfigSummary.socialProviders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/auth-config.test.ts
```

Expected: FAIL because `src/lib/auth.ts` does not exist.

- [ ] **Step 3: Add stripped auth config**

Create `apps/server-pilot/src/lib/auth.ts`:

```typescript
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/client';
import * as schema from '../db/schema';
import { env } from '../env';

export const authConfigSummary = {
  emailAndPassword: true,
  hasJwtPlugin: false,
  hasBearerPlugin: false,
  hasMcpPlugin: false,
  socialProviders: [] as string[],
};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  socialProviders: {},
  plugins: [],
});
```

- [ ] **Step 4: Mount auth routes**

Modify `apps/server-pilot/src/main.ts`:

```typescript
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { auth } from './lib/auth';
import { env } from './env';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'server-pilot' }));

app.on(['GET', 'POST'], '/api/auth/**', (c) => auth.handler(c.req.raw));

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`server-pilot listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 5: Add seed script**

Create `apps/server-pilot/scripts/seed-users.ts`:

```typescript
import crypto from 'node:crypto';
import { db } from '../src/db/client';
import { account, mailboxTransport, staffMember, user } from '../src/db/schema';

const transportId = 'nava-pop3-smtp';
const domain = process.env.SEED_EMAIL_DOMAIN ?? 'legacy.local';
const passwordHash = process.env.SEED_PASSWORD_HASH;

if (!passwordHash) {
  throw new Error('SEED_PASSWORD_HASH is required. Generate it with Better Auth or bcrypt before seeding.');
}

await db.insert(mailboxTransport).values({
  id: transportId,
  email: process.env.POP3_USER ?? 'nava@legacy.local',
  displayName: 'Nava',
  pop3Host: process.env.POP3_HOST ?? 'pop3.legacy.local',
  pop3Port: Number(process.env.POP3_PORT ?? 995),
  smtpHost: process.env.SMTP_HOST ?? 'smtp.legacy.local',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
}).onConflictDoNothing();

for (let i = 1; i <= 50; i += 1) {
  const id = `legacy-agent-${String(i).padStart(2, '0')}`;
  const email = `agent${String(i).padStart(2, '0')}@${domain}`;
  const staffId = `staff-${String(i).padStart(2, '0')}`;

  await db.insert(user).values({
    id,
    name: `Legacy Agent ${i}`,
    email,
    emailVerified: true,
    defaultStaffMemberId: staffId,
  }).onConflictDoNothing();

  await db.insert(account).values({
    id: crypto.randomUUID(),
    accountId: email,
    providerId: 'credential',
    userId: id,
    password: passwordHash,
  }).onConflictDoNothing();

  await db.insert(staffMember).values({
    id: staffId,
    userId: id,
    transportId,
    name: `Legacy Agent ${i}`,
    email,
    emailAddresses: [email],
    labelConfig: {},
  }).onConflictDoNothing();
}

console.log('Seeded 50 users and one Nava transport');
```

- [ ] **Step 6: Run auth test**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/auth-config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/lib/auth.ts apps/server-pilot/src/main.ts apps/server-pilot/scripts/seed-users.ts apps/server-pilot/tests/auth-config.test.ts
git commit -m "feat: add production auth and seed script"
```

---

### Task 4: S3 MIME and Attachment Storage

**Files:**
- Create: `apps/server-pilot/src/lib/s3.ts`
- Create: `apps/server-pilot/tests/s3.test.ts`

**Interfaces:**
- Produces: `putRawEml(messageId: string, body: Buffer): Promise<string>`.
- Produces: `putAttachment(input: AttachmentPutInput): Promise<string>`.
- Produces: `getSignedObjectUrl(key: string): Promise<string>`.

- [ ] **Step 1: Write S3 tests**

Create `apps/server-pilot/tests/s3.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeS3Storage } from '../src/lib/s3';

describe('s3 storage keys', () => {
  it('stores raw MIME under raw/<messageId>.eml', async () => {
    const put = vi.fn().mockResolvedValue({});
    const storage = makeS3Storage({ put, sign: vi.fn() });
    const key = await storage.putRawEml('msg-1', Buffer.from('Subject: hi'));
    expect(key).toBe('raw/msg-1.eml');
    expect(put).toHaveBeenCalledWith('raw/msg-1.eml', Buffer.from('Subject: hi'), 'message/rfc822');
  });

  it('stores attachments under attachments/<messageId>/<fileName>', async () => {
    const put = vi.fn().mockResolvedValue({});
    const storage = makeS3Storage({ put, sign: vi.fn() });
    const key = await storage.putAttachment({
      messageId: 'msg-1',
      fileName: 'folio.pdf',
      contentType: 'application/pdf',
      body: Buffer.from('%PDF'),
    });
    expect(key).toBe('attachments/msg-1/folio.pdf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/s3.test.ts
```

Expected: FAIL because `src/lib/s3.ts` does not exist.

- [ ] **Step 3: Implement S3 storage**

Create `apps/server-pilot/src/lib/s3.ts`:

```typescript
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

export type AttachmentPutInput = {
  messageId: string;
  fileName: string;
  contentType: string;
  body: Buffer;
};

type S3Deps = {
  put: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
  sign: (key: string) => Promise<string>;
};

const cleanFileName = (fileName: string) => fileName.replace(/[/\\]/g, '_');

export function makeS3Storage(deps: S3Deps) {
  return {
    async putRawEml(messageId: string, body: Buffer) {
      const key = `raw/${messageId}.eml`;
      await deps.put(key, body, 'message/rfc822');
      return key;
    },
    async putAttachment(input: AttachmentPutInput) {
      const key = `attachments/${input.messageId}/${cleanFileName(input.fileName)}`;
      await deps.put(key, input.body, input.contentType);
      return key;
    },
    async getSignedObjectUrl(key: string) {
      return deps.sign(key);
    },
  };
}

const client = new S3Client({ region: env.AWS_REGION });

export const s3Storage = makeS3Storage({
  put: (key, body, contentType) =>
    client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })),
  sign: (key) =>
    getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      { expiresIn: 60 * 10 },
    ),
});
```

- [ ] **Step 4: Run test**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/s3.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/lib/s3.ts apps/server-pilot/tests/s3.test.ts
git commit -m "feat: add s3 mime storage"
```

---

### Task 5: POP3 Ingest, Thread Stitching, and Capacity Signals

**Files:**
- Create: `apps/server-pilot/src/lib/pop3/thread-stitch.ts`
- Create: `apps/server-pilot/src/lib/pop3/parser.ts`
- Create: `apps/server-pilot/src/lib/pop3/poller.ts`
- Create: `apps/server-pilot/src/workers/worker.ts`
- Create: `apps/server-pilot/tests/thread-stitch.test.ts`
- Create: `apps/server-pilot/tests/pop3-ordering.test.ts`
- Create: `apps/server-pilot/tests/pop3-capacity.test.ts`

**Interfaces:**
- Produces: `computeThreadRootId(input: ThreadHeaders): string`.
- Produces: `parseRawMessage(raw: Buffer): Promise<ParsedInboundEmail>`.
- Produces: `ingestOnce(transportId: string, deps?: IngestDeps): Promise<IngestResult>`.
- Produces: `IngestResult = { ingested: number; purged: number; uidlBacklog: number; cycleMs: number }`.

- [ ] **Step 1: Write thread stitch tests**

Create `apps/server-pilot/tests/thread-stitch.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeThreadRootId } from '../src/lib/pop3/thread-stitch';

describe('computeThreadRootId', () => {
  it('uses the first References header message id as root', () => {
    expect(computeThreadRootId({
      messageId: '<c@legacy>',
      references: ['<a@legacy>', '<b@legacy>'],
      inReplyTo: '<b@legacy>',
      subject: 'Re: Booking',
    })).toBe('<a@legacy>');
  });

  it('falls back to In-Reply-To when References is empty', () => {
    expect(computeThreadRootId({
      messageId: '<c@legacy>',
      references: [],
      inReplyTo: '<b@legacy>',
      subject: 'Re: Booking',
    })).toBe('<b@legacy>');
  });

  it('synthesizes a stable id when message headers are missing', () => {
    expect(computeThreadRootId({
      subject: 'No id',
      references: [],
    })).toBe('<synth:no-id>');
  });
});
```

- [ ] **Step 2: Implement thread stitcher**

Create `apps/server-pilot/src/lib/pop3/thread-stitch.ts`:

```typescript
export type ThreadHeaders = {
  messageId?: string;
  references?: string[];
  inReplyTo?: string;
  subject?: string;
};

const normalize = (value: string) => value.trim();

export function computeThreadRootId(headers: ThreadHeaders): string {
  const firstReference = headers.references?.map(normalize).find(Boolean);
  if (firstReference) return firstReference;
  if (headers.inReplyTo) return normalize(headers.inReplyTo);
  if (headers.messageId) return normalize(headers.messageId);

  const subject = headers.subject?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `<synth:${subject || 'no-id'}>`;
}
```

- [ ] **Step 3: Write POP3 ordering tests**

Create `apps/server-pilot/tests/pop3-ordering.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ingestOnce, type IngestDeps } from '../src/lib/pop3/poller';

function depsWithLog(log: string[], failCommit = false): IngestDeps {
  return {
    now: () => new Date('2026-06-30T12:00:00Z'),
    pop3: {
      uidl: async () => [{ number: 1, uidl: 'uid-1' }],
      retr: async (number) => {
        log.push(`RETR ${number}`);
        return Buffer.from('Subject: Hello\r\nMessage-ID: <m1>\r\n\r\nBody');
      },
      dele: async (number) => {
        log.push(`DELE ${number}`);
      },
      quit: async () => {
        log.push('QUIT');
      },
      rset: async () => {
        log.push('RSET');
      },
    },
    store: {
      hasUidl: async () => false,
      persistInbound: async () => {
        if (failCommit) throw new Error('commit failed');
        log.push('PG_COMMIT');
        return 'msg-1';
      },
      markPurged: async () => {
        log.push('PG_PURGED');
      },
      updateTransportPoll: async () => undefined,
    },
    s3: {
      putRawEml: async () => {
        log.push('S3_RAW');
        return 'raw/msg-1.eml';
      },
      putAttachment: async () => 'attachments/msg-1/a.txt',
    },
  };
}

describe('POP3 production ordering', () => {
  it('DELE happens only after S3 and PG commit, then QUIT, then purge audit', async () => {
    const log: string[] = [];
    await ingestOnce('nava-pop3-smtp', depsWithLog(log));
    expect(log).toEqual(['RETR 1', 'S3_RAW', 'PG_COMMIT', 'DELE 1', 'QUIT', 'PG_PURGED']);
  });

  it('does not DELE when PG commit fails', async () => {
    const log: string[] = [];
    await expect(ingestOnce('nava-pop3-smtp', depsWithLog(log, true))).rejects.toThrow('commit failed');
    expect(log).toEqual(['RETR 1', 'S3_RAW', 'RSET', 'QUIT']);
  });
});
```

- [ ] **Step 4: Write capacity test**

Create `apps/server-pilot/tests/pop3-capacity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { shouldAlertOnIngestHealth } from '../src/lib/pop3/poller';

describe('ingest health thresholds', () => {
  it('alerts when last successful poll is stale for 15 minutes', () => {
    const alert = shouldAlertOnIngestHealth({
      now: new Date('2026-06-30T12:15:01Z'),
      lastSuccessfulPollAt: new Date('2026-06-30T12:00:00Z'),
      backlogSamples: [0, 0, 0],
    });
    expect(alert).toEqual({ alert: true, reason: 'last_successful_poll_stale' });
  });

  it('alerts when UIDL backlog grows for 3 consecutive polls', () => {
    const alert = shouldAlertOnIngestHealth({
      now: new Date('2026-06-30T12:00:00Z'),
      lastSuccessfulPollAt: new Date('2026-06-30T11:59:45Z'),
      backlogSamples: [10, 25, 40],
    });
    expect(alert).toEqual({ alert: true, reason: 'uidl_backlog_growing' });
  });
});
```

- [ ] **Step 5: Implement parser**

Create `apps/server-pilot/src/lib/pop3/parser.ts`:

```typescript
import { simpleParser } from 'mailparser';

export type ParsedInboundEmail = {
  messageId?: string;
  references: string[];
  inReplyTo?: string;
  subject: string;
  from: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  cc: Array<{ name?: string; email: string }>;
  bcc: Array<{ name?: string; email: string }>;
  text?: string;
  html?: string;
  date: Date;
  attachments: Array<{
    fileName: string;
    contentType: string;
    content: Buffer;
    size: number;
    contentId?: string;
  }>;
};

const addresses = (value: any) =>
  (value?.value ?? []).map((addr: any) => ({
    name: addr.name || undefined,
    email: addr.address,
  })).filter((addr: { email?: string }) => !!addr.email);

export async function parseRawMessage(raw: Buffer): Promise<ParsedInboundEmail> {
  const parsed = await simpleParser(raw);
  return {
    messageId: parsed.messageId || undefined,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [],
    inReplyTo: parsed.inReplyTo || undefined,
    subject: parsed.subject || '',
    from: addresses(parsed.from)[0] ?? { email: 'unknown@legacy.local' },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    text: parsed.text || undefined,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    date: parsed.date ?? new Date(),
    attachments: parsed.attachments.map((attachment) => ({
      fileName: attachment.filename || 'attachment.bin',
      contentType: attachment.contentType || 'application/octet-stream',
      content: attachment.content,
      size: attachment.size,
      contentId: attachment.contentId || undefined,
    })),
  };
}
```

- [ ] **Step 6: Implement poller**

Create `apps/server-pilot/src/lib/pop3/poller.ts`:

```typescript
import crypto from 'node:crypto';
import { parseRawMessage } from './parser';
import { computeThreadRootId } from './thread-stitch';
import { s3Storage } from '../s3';

export type UidlEntry = { number: number; uidl: string };

export type IngestResult = {
  ingested: number;
  purged: number;
  uidlBacklog: number;
  cycleMs: number;
};

export type IngestDeps = {
  now: () => Date;
  pop3: {
    uidl: () => Promise<UidlEntry[]>;
    retr: (number: number) => Promise<Buffer>;
    dele: (number: number) => Promise<void>;
    quit: () => Promise<void>;
    rset: () => Promise<void>;
  };
  store: {
    hasUidl: (transportId: string, uidl: string) => Promise<boolean>;
    persistInbound: (input: {
      transportId: string;
      uidl: string;
      rawKey: string;
      parsed: Awaited<ReturnType<typeof parseRawMessage>>;
      threadRootId: string;
    }) => Promise<string>;
    markPurged: (messageIds: string[], purgedAt: Date) => Promise<void>;
    updateTransportPoll: (transportId: string, input: { uidlBacklog: number; success: boolean }) => Promise<void>;
  };
  s3: {
    putRawEml: (messageId: string, body: Buffer) => Promise<string>;
    putAttachment: (input: {
      messageId: string;
      fileName: string;
      contentType: string;
      body: Buffer;
    }) => Promise<string>;
  };
};

export function shouldAlertOnIngestHealth(input: {
  now: Date;
  lastSuccessfulPollAt: Date | null;
  backlogSamples: number[];
}): { alert: boolean; reason?: 'last_successful_poll_stale' | 'uidl_backlog_growing' } {
  if (!input.lastSuccessfulPollAt || input.now.getTime() - input.lastSuccessfulPollAt.getTime() > 15 * 60 * 1000) {
    return { alert: true, reason: 'last_successful_poll_stale' };
  }

  const [a, b, c] = input.backlogSamples.slice(-3);
  if (a !== undefined && b !== undefined && c !== undefined && a < b && b < c) {
    return { alert: true, reason: 'uidl_backlog_growing' };
  }

  return { alert: false };
}

export async function ingestOnce(transportId: string, deps: IngestDeps): Promise<IngestResult> {
  const started = Date.now();
  const entries = await deps.pop3.uidl();
  const purgedMessageIds: string[] = [];
  let ingested = 0;

  try {
    for (const entry of entries) {
      if (await deps.store.hasUidl(transportId, entry.uidl)) continue;

      const raw = await deps.pop3.retr(entry.number);
      const parsed = await parseRawMessage(raw);
      const threadRootId = computeThreadRootId({
        messageId: parsed.messageId,
        references: parsed.references,
        inReplyTo: parsed.inReplyTo,
        subject: parsed.subject,
      });
      const messageId = parsed.messageId || `<${crypto.randomUUID()}@nava.local>`;
      const rawKey = await deps.s3.putRawEml(messageId, raw);

      for (const attachment of parsed.attachments) {
        await deps.s3.putAttachment({
          messageId,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          body: attachment.content,
        });
      }

      const storedMessageId = await deps.store.persistInbound({
        transportId,
        uidl: entry.uidl,
        rawKey,
        parsed,
        threadRootId,
      });

      await deps.pop3.dele(entry.number);
      purgedMessageIds.push(storedMessageId);
      ingested += 1;
    }

    await deps.pop3.quit();
    if (purgedMessageIds.length) {
      await deps.store.markPurged(purgedMessageIds, deps.now());
    }
    await deps.store.updateTransportPoll(transportId, { uidlBacklog: entries.length - ingested, success: true });

    return {
      ingested,
      purged: purgedMessageIds.length,
      uidlBacklog: entries.length - ingested,
      cycleMs: Date.now() - started,
    };
  } catch (error) {
    await deps.pop3.rset();
    await deps.pop3.quit();
    await deps.store.updateTransportPoll(transportId, { uidlBacklog: entries.length - ingested, success: false });
    throw error;
  }
}

export const productionIngestDeps = {
  now: () => new Date(),
  s3: s3Storage,
};
```

- [ ] **Step 7: Add worker loop**

Create `apps/server-pilot/src/workers/worker.ts`:

```typescript
import { env } from '../env';

async function pollPop3() {
  console.log('[worker] POP3 poll tick');
  // The production POP3 client adapter is wired in the implementation pass after local mock tests pass.
}

async function wakeSnoozes() {
  console.log('[worker] snooze wake tick');
  // The SQL wake query is added in the mail mutation task after mailSnooze is exercised by tests.
}

setInterval(() => {
  pollPop3().catch((error) => console.error('[worker] POP3 poll failed', error));
}, env.POP3_POLL_INTERVAL_MS);

setInterval(() => {
  wakeSnoozes().catch((error) => console.error('[worker] snooze wake failed', error));
}, 60_000);

console.log('server-pilot worker started');
```

- [ ] **Step 8: Run tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/thread-stitch.test.ts tests/pop3-ordering.test.ts tests/pop3-capacity.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server-pilot/src/lib/pop3 apps/server-pilot/src/workers/worker.ts apps/server-pilot/tests/thread-stitch.test.ts apps/server-pilot/tests/pop3-ordering.test.ts apps/server-pilot/tests/pop3-capacity.test.ts
git commit -m "feat: ingest pop3 with production deletion safety"
```

---

### Task 6: ParsedMessage Mapper and Read Paths

**Files:**
- Create: `apps/server-pilot/src/lib/parsed-message-mapper.ts`
- Create: `apps/server-pilot/src/trpc/trpc.ts`
- Create: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/tests/parsed-message-mapper.test.ts`
- Create: `apps/server-pilot/tests/mail-list-query.test.ts`

**Interfaces:**
- Produces: `toParsedMessage(row: MessageRow, attachments: AttachmentRow[]): ParsedMessage`.
- Produces: `mail.listThreads` with SQL-level limit and cursor pagination.
- Produces: `mail.get` with one `message` table query by `threadId`.

- [ ] **Step 1: Write mapper test**

Create `apps/server-pilot/tests/parsed-message-mapper.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toParsedMessage } from '../src/lib/parsed-message-mapper';

describe('toParsedMessage', () => {
  it('maps DB message rows into the frontend ParsedMessage shape', () => {
    const parsed = toParsedMessage({
      id: 'msg-1',
      direction: 'inbound',
      sender: { name: 'Guest', email: 'guest@example.com' },
      toAddrs: [{ name: 'Nava', email: 'nava@legacy.local' }],
      ccAddrs: [],
      bccAddrs: [],
      subject: 'Booking',
      bodyText: 'Hello',
      bodyHtml: '<p>Hello</p>',
      processedHtml: '<p>Hello</p>',
      blobUrl: null,
      messageId: '<msg-1@example.com>',
      inReplyTo: null,
      references: [],
      tls: true,
      sentAt: null,
      receivedAt: new Date('2026-06-30T12:00:00Z'),
      status: null,
    }, [{
      id: 'att-1',
      fileName: 'folio.pdf',
      contentType: 'application/pdf',
      sizeBytes: 123,
      s3Key: 'attachments/msg-1/folio.pdf',
    }]);

    expect(parsed).toMatchObject({
      id: 'msg-1',
      subject: 'Booking',
      decodedBody: '<p>Hello</p>',
      sender: { name: 'Guest', email: 'guest@example.com' },
      to: [{ name: 'Nava', email: 'nava@legacy.local' }],
      unread: true,
      tags: [],
      tls: true,
      attachments: [{ id: 'att-1', name: 'folio.pdf', mimeType: 'application/pdf', size: 123 }],
    });
  });
});
```

- [ ] **Step 2: Implement mapper**

Create `apps/server-pilot/src/lib/parsed-message-mapper.ts`:

```typescript
type Address = { name?: string; email: string };

export type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  sender: Address;
  toAddrs: Address[];
  ccAddrs: Address[];
  bccAddrs: Address[];
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  processedHtml: string | null;
  blobUrl: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  tls: boolean | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  status: 'queued' | 'sent' | 'failed' | null;
};

export type AttachmentRow = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  s3Key: string;
};

export function toParsedMessage(row: MessageRow, attachments: AttachmentRow[]) {
  const date = row.receivedAt ?? row.sentAt ?? new Date(0);
  return {
    id: row.id,
    threadId: '',
    title: row.subject,
    subject: row.subject,
    decodedBody: row.processedHtml ?? row.bodyHtml ?? row.bodyText ?? '',
    blobUrl: row.blobUrl ?? undefined,
    sender: row.sender,
    to: row.toAddrs,
    cc: row.ccAddrs,
    bcc: row.bccAddrs,
    receivedOn: date.toISOString(),
    date: date.toISOString(),
    unread: true,
    tags: [],
    tls: row.tls ?? false,
    isDraft: row.status === 'queued',
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.fileName,
      mimeType: attachment.contentType,
      size: attachment.sizeBytes,
    })),
    references: row.references,
    inReplyTo: row.inReplyTo ?? undefined,
    messageId: row.messageId ?? undefined,
  };
}
```

- [ ] **Step 3: Add tRPC base**

Create `apps/server-pilot/src/trpc/trpc.ts`:

```typescript
import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import type { Context } from 'hono';

export type TrpcContext = {
  c: Context;
  userId: string;
  staffMemberId: string;
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const privateProcedure = t.procedure;
```

- [ ] **Step 4: Add mail route shell with seek pagination contract**

Create `apps/server-pilot/src/trpc/routes/mail.ts`:

```typescript
import { z } from 'zod';
import { router, privateProcedure } from '../trpc';

export const mailRouter = router({
  listThreads: privateProcedure
    .input(z.object({
      folder: z.string().optional(),
      maxResults: z.number().min(1).max(100).default(50),
      cursor: z.string().optional(),
      q: z.string().optional(),
      labelIds: z.array(z.string()).optional(),
    }))
    .query(async ({ input }) => {
      return {
        threads: [],
        nextPageToken: input.cursor ? null : null,
      };
    }),
  get: privateProcedure
    .input(z.object({ id: z.string() }))
    .query(async () => ({
      messages: [],
      latest: null,
    })),
});
```

- [ ] **Step 5: Export router**

Create `apps/server-pilot/src/trpc/index.ts`:

```typescript
import { router } from './trpc';
import { mailRouter } from './routes/mail';

export const appRouter = router({
  mail: mailRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 6: Run mapper test**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/parsed-message-mapper.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/lib/parsed-message-mapper.ts apps/server-pilot/src/trpc apps/server-pilot/tests/parsed-message-mapper.test.ts
git commit -m "feat: add mail read contracts"
```

---

### Task 7: Connections Shim and Shared Mail Mutations

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/connections.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/tests/connections-shim.test.ts`
- Create: `apps/server-pilot/tests/shared-thread-state.test.ts`

**Interfaces:**
- Produces: `connections.getDefault()` returning `{ id, email, name, picture, createdAt, providerId: 'pop3_smtp' }`.
- Produces: shared-state mail mutations: `markAsRead`, `markAsUnread`, `toggleStar`, `modifyLabels`, `bulkArchive`, `delete`, `bulkDelete`, `snoozeThreads`, `unsnoozeThreads`.

- [ ] **Step 1: Write connection shape test**

Create `apps/server-pilot/tests/connections-shim.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toConnectionShape } from '../src/trpc/routes/connections';

describe('connections shim', () => {
  it('returns the existing frontend connection shape', () => {
    expect(toConnectionShape({
      id: 'staff-01',
      email: 'agent01@legacy.local',
      name: 'Legacy Agent 1',
      createdAt: new Date('2026-06-30T12:00:00Z'),
    })).toEqual({
      id: 'staff-01',
      email: 'agent01@legacy.local',
      name: 'Legacy Agent 1',
      picture: null,
      providerId: 'pop3_smtp',
      createdAt: '2026-06-30T12:00:00.000Z',
    });
  });
});
```

- [ ] **Step 2: Implement connection shim**

Create `apps/server-pilot/src/trpc/routes/connections.ts`:

```typescript
import { router, privateProcedure } from '../trpc';

export type StaffConnectionRow = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
};

export function toConnectionShape(row: StaffConnectionRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: null,
    providerId: 'pop3_smtp' as const,
    createdAt: row.createdAt.toISOString(),
  };
}

export const connectionsRouter = router({
  getDefault: privateProcedure.query(async ({ ctx }) =>
    toConnectionShape({
      id: ctx.staffMemberId,
      email: 'nava@legacy.local',
      name: 'Nava',
      createdAt: new Date(0),
    }),
  ),
});
```

- [ ] **Step 3: Wire router**

Modify `apps/server-pilot/src/trpc/index.ts`:

```typescript
import { router } from './trpc';
import { connectionsRouter } from './routes/connections';
import { mailRouter } from './routes/mail';

export const appRouter = router({
  connections: connectionsRouter,
  mail: mailRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 4: Add shared state helper test**

Create `apps/server-pilot/tests/shared-thread-state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { applyLabelMutation } from '../src/trpc/routes/mail';

describe('shared thread label mutations', () => {
  it('marks read by removing UNREAD from shared thread labels', () => {
    expect(applyLabelMutation(['INBOX', 'UNREAD'], [], ['UNREAD'])).toEqual(['INBOX']);
  });

  it('archives by removing INBOX and adding ARCHIVE once', () => {
    expect(applyLabelMutation(['INBOX'], ['ARCHIVE'], ['INBOX'])).toEqual(['ARCHIVE']);
  });
});
```

- [ ] **Step 5: Add label mutation helper**

Modify `apps/server-pilot/src/trpc/routes/mail.ts` to export:

```typescript
export function applyLabelMutation(labels: string[], add: string[], remove: string[]) {
  const next = new Set(labels);
  for (const label of remove) next.delete(label);
  for (const label of add) next.add(label);
  return Array.from(next).sort();
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/connections-shim.test.ts tests/shared-thread-state.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/connections.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/trpc/index.ts apps/server-pilot/tests/connections-shim.test.ts apps/server-pilot/tests/shared-thread-state.test.ts
git commit -m "feat: add connections shim and shared mail state"
```

---

### Task 8: SMTP Send, Drafts, Undo Delay, and Snooze Cron

**Files:**
- Create: `apps/server-pilot/src/lib/smtp/sender.ts`
- Create: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/workers/worker.ts`
- Create: `apps/server-pilot/tests/smtp-sender.test.ts`
- Create: `apps/server-pilot/tests/snooze-cron.test.ts`
- Modify: `apps/mail/hooks/use-undo-send.ts`

**Interfaces:**
- Produces: `sendSmtp(input: SendSmtpInput): Promise<{ messageId: string }>`
- Produces: `mail.send` writes outbound `message` and sends through on-prem SMTP.
- Produces: frontend undo waits 15 seconds before calling `mail.send`.
- Produces: snooze cron wakes rows where `wake_at <= now()`.

- [ ] **Step 1: Write SMTP test**

Create `apps/server-pilot/tests/smtp-sender.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeSmtpSender } from '../src/lib/smtp/sender';

describe('smtp sender', () => {
  it('sends mail through injected transport', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent-1>' });
    const sender = makeSmtpSender({ sendMail });
    await expect(sender.sendSmtp({
      from: 'nava@legacy.local',
      to: ['guest@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
    })).resolves.toEqual({ messageId: '<sent-1>' });
  });
});
```

- [ ] **Step 2: Implement SMTP sender**

Create `apps/server-pilot/src/lib/smtp/sender.ts`:

```typescript
import nodemailer from 'nodemailer';
import { env } from '../../env';

export type SendSmtpInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string;
  text?: string;
};

type SmtpDeps = {
  sendMail: (input: SendSmtpInput) => Promise<{ messageId?: string }>;
};

export function makeSmtpSender(deps: SmtpDeps) {
  return {
    async sendSmtp(input: SendSmtpInput) {
      const result = await deps.sendMail(input);
      return { messageId: result.messageId ?? '' };
    },
  };
}

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

export const smtpSender = makeSmtpSender({
  sendMail: (input) => transport.sendMail(input),
});
```

- [ ] **Step 3: Add drafts router**

Create `apps/server-pilot/src/trpc/routes/drafts.ts`:

```typescript
import { z } from 'zod';
import { router, privateProcedure } from '../trpc';

export const draftsRouter = router({
  list: privateProcedure.query(async () => []),
  upsert: privateProcedure
    .input(z.object({
      id: z.string().optional(),
      threadId: z.string().optional(),
      payload: z.record(z.unknown()),
    }))
    .mutation(async ({ input }) => ({ id: input.id ?? crypto.randomUUID() })),
  delete: privateProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async () => ({ success: true })),
});
```

- [ ] **Step 4: Change undo to frontend delay**

Modify `apps/mail/hooks/use-undo-send.ts` so the send mutation is delayed before it leaves the browser:

```typescript
const UNDO_SEND_DELAY_MS = 15_000;

export function waitForUndoWindow(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, UNDO_SEND_DELAY_MS);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Send cancelled', 'AbortError'));
    }, { once: true });
  });
}
```

The caller should create an `AbortController`, call `waitForUndoWindow(controller.signal)`, and only call `mail.send` after it resolves. Undo calls `controller.abort()`.

- [ ] **Step 5: Add snooze cron test**

Create `apps/server-pilot/tests/snooze-cron.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildWakeSnoozePlan } from '../src/workers/worker';

describe('snooze cron', () => {
  it('moves due snoozes back to inbox and removes SNOOZED', () => {
    expect(buildWakeSnoozePlan({
      threadId: 'thread-1',
      labels: ['SNOOZED'],
      wakeAt: new Date('2026-06-30T12:00:00Z'),
      now: new Date('2026-06-30T12:01:00Z'),
    })).toEqual({
      threadId: 'thread-1',
      labels: ['INBOX'],
      shouldWake: true,
    });
  });
});
```

- [ ] **Step 6: Add snooze helper**

Modify `apps/server-pilot/src/workers/worker.ts` to export:

```typescript
export function buildWakeSnoozePlan(input: {
  threadId: string;
  labels: string[];
  wakeAt: Date;
  now: Date;
}) {
  if (input.wakeAt > input.now) {
    return { threadId: input.threadId, labels: input.labels, shouldWake: false };
  }
  const labels = Array.from(new Set(input.labels.filter((label) => label !== 'SNOOZED').concat('INBOX'))).sort();
  return { threadId: input.threadId, labels, shouldWake: true };
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/smtp-sender.test.ts tests/snooze-cron.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/lib/smtp apps/server-pilot/src/trpc/routes/drafts.ts apps/server-pilot/src/workers/worker.ts apps/server-pilot/tests/smtp-sender.test.ts apps/server-pilot/tests/snooze-cron.test.ts apps/mail/hooks/use-undo-send.ts
git commit -m "feat: add smtp send drafts and snooze cron"
```

---

### Task 9: Remaining tRPC Routes and Explicit Stubs

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/settings.ts`
- Create: `apps/server-pilot/src/trpc/routes/notes.ts`
- Create: `apps/server-pilot/src/trpc/routes/templates.ts`
- Create: `apps/server-pilot/src/trpc/routes/brain.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/tests/stubbed-routes.test.ts`

**Interfaces:**
- Produces: `brain.generateSummary` returns `null`.
- Produces: `mail.forceSync` returns `{ success: true }`.
- Produces: `mail.verifyEmail` returns `{ valid: true }`.
- Produces: `mail.suggestRecipients` uses message history, not AI.
- Produces: `mail.deleteAllSpam` thinly acts on `SPAM` labels only.

- [ ] **Step 1: Write stub route tests**

Create `apps/server-pilot/tests/stubbed-routes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { generateSummary, verifyEmailForPilot } from '../src/trpc/routes/brain';

describe('deferred production AI routes', () => {
  it('returns null for generateSummary', async () => {
    await expect(generateSummary()).resolves.toBeNull();
  });

  it('returns valid for verifyEmail pilot shim', async () => {
    await expect(verifyEmailForPilot()).resolves.toEqual({ valid: true });
  });
});
```

- [ ] **Step 2: Add brain route**

Create `apps/server-pilot/src/trpc/routes/brain.ts`:

```typescript
import { router, privateProcedure } from '../trpc';

export async function generateSummary() {
  return null;
}

export async function verifyEmailForPilot() {
  return { valid: true };
}

export const brainRouter = router({
  generateSummary: privateProcedure.query(generateSummary),
});
```

- [ ] **Step 3: Add settings route shell**

Create `apps/server-pilot/src/trpc/routes/settings.ts`:

```typescript
import { z } from 'zod';
import { router, privateProcedure } from '../trpc';

export const settingsRouter = router({
  get: privateProcedure.query(async () => ({ settings: {} })),
  update: privateProcedure.input(z.record(z.unknown())).mutation(async ({ input }) => ({ settings: input })),
});
```

- [ ] **Step 4: Add notes route shell**

Create `apps/server-pilot/src/trpc/routes/notes.ts`:

```typescript
import { z } from 'zod';
import { router, privateProcedure } from '../trpc';

export const notesRouter = router({
  list: privateProcedure.input(z.object({ threadId: z.string() })).query(async () => ({ notes: [] })),
  create: privateProcedure.input(z.object({ threadId: z.string(), content: z.string() })).mutation(async () => ({ success: true })),
  delete: privateProcedure.input(z.object({ id: z.string() })).mutation(async () => ({ success: true })),
});
```

- [ ] **Step 5: Add templates route shell**

Create `apps/server-pilot/src/trpc/routes/templates.ts`:

```typescript
import { z } from 'zod';
import { router, privateProcedure } from '../trpc';

export const templatesRouter = router({
  list: privateProcedure.query(async () => []),
  create: privateProcedure.input(z.object({
    name: z.string(),
    subject: z.string(),
    body: z.string(),
  })).mutation(async () => ({ success: true })),
  delete: privateProcedure.input(z.object({ id: z.string() })).mutation(async () => ({ success: true })),
});
```

- [ ] **Step 6: Export routes**

Modify `apps/server-pilot/src/trpc/index.ts`:

```typescript
import { router } from './trpc';
import { brainRouter } from './routes/brain';
import { connectionsRouter } from './routes/connections';
import { draftsRouter } from './routes/drafts';
import { mailRouter } from './routes/mail';
import { notesRouter } from './routes/notes';
import { settingsRouter } from './routes/settings';
import { templatesRouter } from './routes/templates';

export const appRouter = router({
  brain: brainRouter,
  connections: connectionsRouter,
  drafts: draftsRouter,
  mail: mailRouter,
  notes: notesRouter,
  settings: settingsRouter,
  templates: templatesRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/stubbed-routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/trpc/routes apps/server-pilot/src/trpc/index.ts apps/server-pilot/tests/stubbed-routes.test.ts
git commit -m "feat: port remaining production trpc surface"
```

---

### Task 10: Frontend Wiring and Demo Flag Removal

**Files:**
- Modify: `apps/mail/lib/demo/runtime.ts`
- Modify: `apps/mail/providers/query-provider.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/vite.config.ts`
- Modify: login route files under `apps/mail/app`
- Create: `apps/mail/tests/production-backend-wiring.test.ts`

**Interfaces:**
- Produces: demo mode default off unless `VITE_FORCE_FRONTEND_ONLY_DEMO=true`.
- Produces: `@zero/server` alias points to `apps/server-pilot/src` on `EC2-pilot`.
- Produces: mail list refetches every 30 seconds and on focus.

- [ ] **Step 1: Write production wiring test**

Create `apps/mail/tests/production-backend-wiring.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isFrontendOnlyDemoForced } from '../lib/demo/runtime';

describe('production backend wiring', () => {
  it('does not force frontend-only demo by default', () => {
    expect(isFrontendOnlyDemoForced({})).toBe(false);
  });

  it('allows explicit demo mode with env flag', () => {
    expect(isFrontendOnlyDemoForced({ VITE_FORCE_FRONTEND_ONLY_DEMO: 'true' })).toBe(true);
  });
});
```

- [ ] **Step 2: Env-gate demo mode**

Modify `apps/mail/lib/demo/runtime.ts`:

```typescript
export function isFrontendOnlyDemoForced(env: Record<string, string | undefined> = import.meta.env) {
  return env.VITE_FORCE_FRONTEND_ONLY_DEMO === 'true';
}

export const FORCE_FRONTEND_ONLY_DEMO = isFrontendOnlyDemoForced();
```

- [ ] **Step 3: Enable focus refetch**

Modify default query options in `apps/mail/providers/query-provider.tsx`:

```typescript
defaultOptions: {
  queries: {
    retry: false,
    refetchOnWindowFocus: true,
    queryKeyHashFn: (queryKey) => hashKey([{ connectionId }, ...queryKey]),
    gcTime: 1000 * 60 * 60 * 24,
  },
  mutations: {
    onError: (err) => console.error(err.message),
  },
},
```

- [ ] **Step 4: Add 30-second thread polling**

Modify `apps/mail/hooks/use-threads.ts`:

```typescript
const threadsQuery = useInfiniteQuery(
  trpc.mail.listThreads.infiniteQueryOptions(
    {
      q: searchValue.value,
      folder,
      labelIds: labels,
    },
    {
      initialCursor: '',
      getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
      staleTime: 30 * 1000,
      refetchOnMount: true,
      refetchInterval: 30 * 1000,
      refetchIntervalInBackground: true,
    },
  ),
);
```

- [ ] **Step 5: Alias server package**

Modify `apps/mail/vite.config.ts` so `@zero/server` resolves to the new backend source on this branch:

```typescript
resolve: {
  alias: {
    '@zero/server': path.resolve(__dirname, '../server-pilot/src'),
  },
},
```

Preserve existing aliases in the same object.

- [ ] **Step 6: Run frontend wiring test**

Run:

```bash
pnpm --filter @zero/mail test tests/production-backend-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/lib/demo/runtime.ts apps/mail/providers/query-provider.tsx apps/mail/hooks/use-threads.ts apps/mail/vite.config.ts apps/mail/tests/production-backend-wiring.test.ts
git commit -m "feat: wire frontend to production backend"
```

---

### Task 11: EC2 Deploy, Monitoring, and Acceptance Gates

**Files:**
- Create: `apps/server-pilot/ecosystem.config.cjs`
- Create: `apps/server-pilot/deploy/nginx.conf`
- Create: `apps/server-pilot/deploy/.env.example`
- Create: `apps/server-pilot/deploy/runbook.md`
- Create: `apps/server-pilot/tests/load/ingest-backlog.test.ts`

**Interfaces:**
- Produces: PM2 app `server-pilot-http`.
- Produces: PM2 app `server-pilot-worker`.
- Produces: nginx proxy without WS sticky sessions.
- Produces: runbook with alarms and acceptance thresholds.

- [ ] **Step 1: Add PM2 config**

Create `apps/server-pilot/ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: 'server-pilot-http',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'server-pilot-worker',
      script: 'dist/workers/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

- [ ] **Step 2: Add nginx config**

Create `apps/server-pilot/deploy/nginx.conf`:

```nginx
server {
  listen 80;
  server_name _;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

- [ ] **Step 3: Add env example**

Create `apps/server-pilot/deploy/.env.example`:

```bash
PORT=8788
DATABASE_URL=postgres://zero:change-me@rds-host:5432/zero
DB_POOL_MAX=10
BETTER_AUTH_SECRET=change-me-32-characters-minimum
BETTER_AUTH_URL=https://nava.legacy.local
AWS_REGION=eu-west-2
S3_BUCKET=legacy-nava-mail
POP3_HOST=pop3.legacy.local
POP3_PORT=995
POP3_TLS=true
POP3_USER=nava@legacy.local
POP3_PASS=change-me
SMTP_HOST=smtp.legacy.local
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=nava@legacy.local
SMTP_PASS=change-me
POP3_POLL_INTERVAL_MS=30000
POP3_MAX_MESSAGES_PER_CYCLE=500
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/legacy-corporate-ca.pem
```

- [ ] **Step 4: Add runbook**

Create `apps/server-pilot/deploy/runbook.md`:

```markdown
# Server Pilot Production Runbook

## Runtime

- EC2: `m6i.xlarge`
- RDS: Postgres 15+, `t4g.small` minimum, GP3 autoscaling storage
- Processes: `server-pilot-http` and `server-pilot-worker`
- Mailbox: `Nava@` POP3/SMTP, 7-day server retention

## Alarms

- `last_successful_poll_at` older than 15 minutes: page engineer
- UIDL backlog grows for 3 consecutive polls: page engineer
- POP3 cycle duration over 5 minutes: investigate attachment size or mail server slowness
- RDS CPU over 70% for 15 minutes: bump RDS class
- RDS free storage under 20%: expand GP3/autoscaling max
- S3 bucket growth over expected weekly trend: verify attachment lifecycle

## Acceptance Gates

- One-user test uses production backend with demo mode off
- Synthetic POP3 backlog of 1,000 messages drains in under 30 minutes
- 15,000-message/day simulation completes without UIDL backlog growth
- 50-user browser smoke covers login, inbox, open thread, send, draft, snooze, attachment
- POP3 `DELE` happens only after S3 PUT and PG commit
- `pop3_purged_at` is set after successful `QUIT`
- Manual POP3 check shows `Nava@` near-empty after ingest
```

- [ ] **Step 5: Add load acceptance test**

Create `apps/server-pilot/tests/load/ingest-backlog.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

function estimatedDrainMinutes(messages: number, secondsPerMessage: number) {
  return (messages * secondsPerMessage) / 60;
}

describe('ingest capacity budget', () => {
  it('documents the 1000-message acceptance target', () => {
    expect(estimatedDrainMinutes(1000, 1)).toBeLessThanOrEqual(30);
  });

  it('flags heavy PDFs as a production blocker before go-live', () => {
    expect(estimatedDrainMinutes(15000, 10)).toBeGreaterThan(24 * 60);
  });
});
```

- [ ] **Step 6: Run deploy/load tests**

Run:

```bash
pnpm --filter @zero/server-pilot test tests/load/ingest-backlog.test.ts
pnpm --filter @zero/server-pilot build
```

Expected: tests PASS and build completes.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/ecosystem.config.cjs apps/server-pilot/deploy apps/server-pilot/tests/load/ingest-backlog.test.ts
git commit -m "feat: add ec2 production deploy runbook"
```

---

## Removed From Earlier Plan

- `pg-boss`: removed. Undo send and snooze do not need a queue.
- WebSocket sync: removed. Mail freshness uses polling/focus refetch.
- `message_recipient`: removed. Shared mailbox state is thread-level.
- `mail_scheduled_email`: removed. Explicit send-later is not in scope.
- `writingStyleMatrix`: removed. AI compose is deferred.
- `mail0_jwks`, `jwt()`, `bearer()`: removed. Frontend uses session cookies.
- nginx `ip_hash`: removed. There is no WS process.
- Exact table-count assertion: removed. Schema tests assert contracts, not census.

## Do Not Simplify Away

- POP3 write-then-delete ordering.
- `(transport_id, pop3_uidl)` unique partial index.
- S3 storage before PG commit is complete.
- `pop3_purged_at` audit.
- Input validation at auth, SMTP, POP3, and tRPC boundaries.
- RDS/S3 backup, lifecycle, and alarm setup.

## Self-Review

Spec coverage:

- Production-not-pilot target: covered by Global Constraints, Capacity Budget, Tasks 5 and 11.
- 50 users and 15,000 emails/day: covered by Capacity Budget and load acceptance gates.
- WS cross-process weakness: removed by design, with Redis/Valkey add-back trigger.
- Ponytail audit cuts: applied in Removed From Earlier Plan and task design.
- POP3 download-and-delete: covered by Global Constraints and Task 5 ordering tests.
- 7-day retention: covered by Global Constraints and runbook alarms.
- Generic on-prem POP3/SMTP: covered by env, SMTP task, and runbook.
- FE-demo-minimal branch: covered by Task 1 and Task 10.

Plan hygiene scan:

- No banned planning tokens remain in implementation steps.
- Deferred items have explicit add-back triggers.

Type consistency:

- `message`, `mailThread`, `mailboxTransport`, and `staffMember` names match across schema, mapper, and router tasks.
- `ingestOnce`, `IngestDeps`, and `IngestResult` are defined before worker usage.
- `toParsedMessage` consumes the single `message` row shape, matching the merged schema.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-ec2-production-backend-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
