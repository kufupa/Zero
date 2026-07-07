# EC2 Production Backend Implementation Plan

> SUPERSEDED: This v2 plan assumed one shared `Nava@` inbox and shared thread state. User clarified production needs 50 independent user inboxes with private mail state, private drafts, and sends from each user's mailbox. Use `docs/superpowers/plans/2026-06-30-ec2-production-per-user-mailbox-plan-v3.md` instead.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the real Legacy Hotels production backend on EC2, test it first with one user and about 1,000 emails/day, then scale the same architecture to 50 VPN users and 15,000 emails/day without a second engineering phase.

**Architecture:** Build `apps/server-pilot/` beside the existing Cloudflare backend and wire `FE-demo-minimal` to it. Replace Cloudflare Workers, Durable Objects, KV, R2, Queues, Hyperdrive, Gmail, OAuth, and Vectorize with one Hono/tRPC HTTP server, one PM2 worker, RDS Postgres metadata, S3 raw MIME and attachments, and the client's on-prem POP3/SMTP server. Keep the existing frontend contract by exporting the same `@zero/server/*` subpaths and the same `AppRouter` procedure surface, with real bodies for mail and safe no-op bodies for deferred AI.

**Tech Stack:** Node 22, Hono, `@hono/node-server`, tRPC, Drizzle ORM, Better Auth email/password session cookies, node-pop3, mailparser, nodemailer, AWS RDS Postgres 15+, AWS S3, CloudWatch, PM2, nginx, Vitest, Playwright.

## Global Constraints

- Branch: `EC2-pilot` cut from `FE-demo-minimal` HEAD. `apps/server/` remains untouched.
- Backend folder: `apps/server-pilot/`.
- Production target: shared `Nava@` mailbox, Centurion first, 50 VPN users, 15,000 emails/day.
- Rollout target: test the same production architecture first with one user and about 1,000 emails/day.
- Mail server: Legacy Hotels runs a local on-prem POP3/SMTP server. Do not assume Exchange.
- Server retention: IT wipes mail server messages after 7 days. RDS Postgres plus S3 is the system of record.
- POP3 behavior: download-and-delete using `UIDL -> RETR -> parse -> S3 PUT -> PG commit -> DELE -> QUIT`.
- POP3 safety: never `DELE` before S3 and Postgres commit. Use `(transport_id, pop3_uidl)` partial unique index for crash recovery.
- POP3 session: one TCP connection per `ingestOnce` cycle. Map node-pop3 `UIDL()` tuples `[msgNum, uid]` to `{ number: Number(msgNum), uidl: uid }`; convert `RETR(number)` string output to `Buffer.from(str, 'binary')`.
- POP3 cycle cap: process at most `POP3_MAX_MESSAGES_PER_CYCLE=500` UIDLs per session, then `QUIT` and let the next poll continue.
- POP3 partial failure: a per-message failure skips `DELE` for that message and continues the batch; do not `RSET` after successful `DELE`s unless aborting the whole session before `QUIT`.
- Ingest topology: exactly one PM2 worker process owns POP3 polling. Never run two pollers against `Nava@`.
- Ingest SLA: poll every 30 seconds, alert if `last_successful_poll_at` is stale for 15 minutes or UIDL backlog grows for 3 consecutive polls.
- WebSocket freshness: do not ship a WS sync server. Mail freshness uses React Query polling and focus refetch.
- `ponytail:` WS add-back: add Redis or Valkey pub/sub only when real-time AI chat is production scope.
- Queueing: do not ship `pg-boss`. Send undo is a frontend delay; snooze wake is one cron query.
- Auth: Better Auth email/password session cookies only. Strip `jwt()`, `bearer()`, `mcp()`, social providers, phone, Redis, Dub, and Twilio.
- Secrets: POP3/SMTP passwords live in env or AWS Secrets Manager, not in Postgres.
- RDS: Postgres 15+, `t4g.small` minimum, GP3 autoscaling storage, explicit app pool limit.
- S3: raw MIME and attachments are archived in S3 with lifecycle rules. RDS stores metadata, parsed body fields, and object keys.
- AI: vector search, pgvector, agent chat, AI compose, writing style matrix, and web search are deferred as product features, but their tRPC procedures still exist as safe stubs.
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

Claude rejected v1 for the right reason: the cuts were good, but the surviving core was not fully specified. This v2 keeps the lazy architecture and fills the runtime holes.

The frontend is typed against `@zero/server`. If `apps/server-pilot` misses a subpath export or procedure, `apps/mail` fails before a user sees the inbox. So the first rule is contract parity: export the same modules and routers, then make core mail procedures real and deferred AI procedures safe.

The production failure modes are data loss and silent staleness. POP3 deletion happens only after S3 and Postgres commit. S3 keys use DB ids, not `Message-ID` headers. Ingest has a batch cap, metrics, and a real worker loop. Mail list and thread reads hit Postgres with seek pagination. No WebSocket, no queue, no per-user fan-out.

## Production Shape

```mermaid
flowchart LR
  mailServer["On-prem POP3/SMTP"] -->|"BCC to Nava"| worker["PM2 worker: POP3 ingest and cron"]
  worker --> s3["S3 raw MIME and attachments"]
  worker --> rds["RDS Postgres metadata and parsed bodies"]
  users["50 VPN users"] --> nginx["nginx"]
  nginx --> http["PM2 HTTP: Hono and tRPC"]
  http --> rds
  http --> s3
  http -->|"SMTP send"| mailServer
  frontend["React mail app"] -->|"30s list/get polling and focus refetch"| http
```

## Capacity Budget

- 15,000 emails/day averages about 10.4 emails/minute.
- Expected business-hour bursts are planned at 20-50 emails/minute.
- One POP3 worker with a 30-second poll and 500-message cycle cap can drain normal bursts if average parse/store time stays below about 1 second/message.
- Heavy PDF samples must be tested at kickoff. If real messages take 10 seconds/message, one worker can only handle about 8,640 messages/day and the bottleneck must be fixed before go-live.
- Worst fan-out avoided: 15,000 emails/day times 50 users equals 750,000 recipient-state inserts/day. This plan writes one thread row and one message row per email.
- S3 growth estimate: 15,000 messages/day times 50 KB average raw MIME is about 750 MB/day. With PDFs, plan for several GB/day and lifecycle to cheaper storage.
- Postgres stores parsed `body_text`, `body_html`, and optionally `processed_html`; this is not metadata-only. Keep RDS storage autoscaling on and measure table size during the 1,000-email test.

---

## File Structure

Create:

- `apps/server-pilot/package.json` - package metadata, exports, scripts.
- `apps/server-pilot/tsconfig.json` - build config and declaration output.
- `apps/server-pilot/drizzle.config.ts` - Drizzle migration config.
- `apps/server-pilot/ecosystem.config.cjs` - PM2 config with one HTTP app and one worker app.
- `apps/server-pilot/deploy/nginx.conf` - plain reverse proxy, no WS sticky sessions.
- `apps/server-pilot/deploy/.env.example` - production env contract.
- `apps/server-pilot/deploy/runbook.md` - alarms, restore, and acceptance gates.
- `apps/server-pilot/src/main.ts` - Hono HTTP entrypoint.
- `apps/server-pilot/src/env.ts` - env parsing.
- `apps/server-pilot/src/auth.ts` - public `@zero/server/auth` subpath export.
- `apps/server-pilot/src/auth-providers.ts` - public `@zero/server/auth-providers` subpath export.
- `apps/server-pilot/src/schemas.ts` - public `@zero/server/schemas` subpath export.
- `apps/server-pilot/src/types.ts` - deep-import compatibility for `ParsedMessageSchema`, `EPrompts`, and `Tools`.
- `apps/server-pilot/src/lib/driver/types.ts` - deep-import compatibility for `IGetThreadResponse`, `IGetThreadsResponse`, and `ParsedDraft`.
- `apps/server-pilot/src/lib/brain.fallback.prompts.ts` - prompt constants used by the prompts dialog.
- `apps/server-pilot/src/lib/cookies.ts` - cookie preference types and helpers.
- `apps/server-pilot/src/trpc.ts` - public `@zero/server/trpc` subpath export.
- `apps/server-pilot/src/db/client.ts` - Postgres pool and Drizzle client.
- `apps/server-pilot/src/db/schema/auth.ts` - Better Auth tables.
- `apps/server-pilot/src/db/schema/app.ts` - settings, notes, templates, prompts.
- `apps/server-pilot/src/db/schema/mail.ts` - transport, staff, thread, message, attachment, draft, snooze, labels.
- `apps/server-pilot/src/db/schema/index.ts` - schema exports.
- `apps/server-pilot/src/lib/auth-config.ts` - stripped Better Auth config.
- `apps/server-pilot/src/lib/s3.ts` - S3 storage helpers with collision-proof keys.
- `apps/server-pilot/src/lib/parsed-message-mapper.ts` - `message` row to frontend `ParsedMessage`.
- `apps/server-pilot/src/lib/html/process-email-content.ts` - copied sanitizer path for `mail.processEmailContent`.
- `apps/server-pilot/src/lib/pop3/client.ts` - node-pop3 adapter.
- `apps/server-pilot/src/lib/pop3/thread-stitch.ts` - thread root calculation.
- `apps/server-pilot/src/lib/pop3/parser.ts` - mailparser adapter.
- `apps/server-pilot/src/lib/pop3/store.ts` - transaction-backed ingest store.
- `apps/server-pilot/src/lib/pop3/poller.ts` - batch-capped POP3 ingest orchestration.
- `apps/server-pilot/src/lib/smtp/sender.ts` - nodemailer SMTP adapter.
- `apps/server-pilot/src/trpc/context.ts` - Hono/tRPC context.
- `apps/server-pilot/src/trpc/index.ts` - internal app router export.
- `apps/server-pilot/src/trpc/routes/*.ts` - route files listed in Task 8.
- `apps/server-pilot/src/workers/worker.ts` - POP3 and snooze cron loop.
- `apps/server-pilot/scripts/seed-users.ts` - one transport, 50 users, 50 staff rows.
- `apps/server-pilot/tests/**` - contract, unit, integration, and load tests.

Modify:

- `pnpm-workspace.yaml` - include `apps/server-pilot` if needed.
- `apps/mail/lib/demo/runtime.ts` - env-gate demo mode, default off.
- `apps/mail/providers/query-provider.tsx` - focus refetch on.
- `apps/mail/hooks/use-threads.ts` - 30-second polling for list and thread.
- `apps/mail/vite.config.ts` - route `@zero/server` subpaths to `apps/server-pilot/src`.
- `apps/mail/hooks/use-undo-send.ts` and send call sites - browser-side 15-second undo delay.

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

## Frontend Compatibility Surface

The new backend must satisfy these module imports:

- `@zero/server/trpc` exports `AppRouter`, `Inputs`, `Outputs`, and `appRouter`.
- `@zero/server/auth` exports type `Auth`.
- `@zero/server/schemas` exports `defaultUserSettings`, `userSettingsSchema`, `UserSettings`, `defaultMailCategories`, `createDraftData`.
- `@zero/server/auth-providers` exports type `EnvVarInfo`.
- Deep imports must also resolve for `apps/mail` until the frontend is cleaned up: `@zero/server/src/types`, `@zero/server/src/lib/driver/types`, `@zero/server/src/lib/brain.fallback.prompts`, and `@zero/server/src/lib/cookies`.

The new `AppRouter` must include these routers:

- `ai`
- `bimi`
- `brain`
- `categories`
- `connections`
- `cookiePreferences`
- `drafts`
- `labels`
- `logging`
- `mail`
- `meet`
- `notes`
- `shortcut`
- `settings`
- `templates`
- `user`

Core real procedures:

- `connections.list`, `connections.getDefault`, `connections.setDefault`, `connections.delete`
- `labels.list`, `labels.create`, `labels.update`, `labels.delete`
- `settings.get`, `settings.save`
- `drafts.create`, `drafts.get`, `drafts.list`, `drafts.delete`
- `notes.list`, `notes.create`, `notes.update`, `notes.delete`, `notes.reorder`
- `templates.list`, `templates.create`, `templates.delete`
- `mail.suggestRecipients`, `mail.forceSync`, `mail.get`, `mail.listThreads`, `mail.markAsRead`, `mail.markAsUnread`, `mail.toggleStar`, `mail.toggleImportant`, `mail.modifyLabels`, `mail.bulkDelete`, `mail.delete`, `mail.bulkArchive`, `mail.snoozeThreads`, `mail.unsnoozeThreads`, `mail.send`, `mail.unsend`, `mail.getEmailAliases`, `mail.getMessageAttachments`, `mail.processEmailContent`, `mail.getRawEmail`, `mail.verifyEmail`, `mail.deleteAllSpam`

Safe stub procedures:

- `ai.generateSearchQuery`, `ai.compose`, `ai.generateEmailSubject`, `ai.webSearch`
- `brain.generateSummary`, `brain.getState`, `brain.getLabels`, `brain.updateLabels`, `brain.getPrompts`, `brain.updatePrompt`, `brain.enableBrain`, `brain.disableBrain`
- `bimi.getByEmail`
- `categories.defaults`
- `cookiePreferences.getPreferences`, `cookiePreferences.updatePreferences`
- `meet.create`
- `logging` and `shortcut` as empty router roots
- `user.getIntercomToken`, `user.delete`

Safe stub means the procedure exists, validates input, returns the existing frontend-safe shape, and performs no external AI or OAuth call.

---

## Final App Schema

The production baseline has 16 app tables:

1. `user`
2. `session`
3. `account`
4. `verification`
5. `note`
6. `userSettings`
7. `emailTemplate`
8. `mailboxTransport`
9. `staffMember`
10. `mailLabel`
11. `mailThread`
12. `message`
13. `attachment`
14. `mailDraft`
15. `mailSnooze`
16. `mailPrompt`

Why 16, not 15: Claude correctly flagged `labels.*` as a live frontend dependency. User labels need a small `mailLabel` table. This is not per-message fan-out; it is a tiny config table.

Key schema choices:

- `message.direction` is `inbound` or `outbound`.
- `message.pop3_uidl` is nullable but required for inbound rows by a check constraint.
- `UNIQUE (transport_id, pop3_uidl) WHERE direction = 'inbound'` prevents duplicate POP3 ingest.
- `message.pop3_purged_at` is set after successful `QUIT`.
- `message.raw_eml_key` and `attachment.s3_key` use DB ids, not `Message-ID` headers.
- `mailThread` owns shared `labels[]`, `is_unread`, `is_starred`, `is_important`, `is_archived`, latest-message metadata.
- `mailboxTransport` is seeded as one row for `Nava@` and stores no passwords.
- `mailSnooze` stores `wake_at`; the worker cron unsnoozes rows where `wake_at <= now()`.

`ponytail:` `message_recipient` is intentionally not built. Add it only if product wants private per-agent unread/labels/star.

`ponytail:` one `message` table is intentional. Split outbound later only if SMTP grows per-recipient bounce, DSN, retry, or delivery tracking.

---

### Task 1: Branch, Package, and Public Export Shell

**Files:**
- Create: `apps/server-pilot/package.json`
- Create: `apps/server-pilot/tsconfig.json`
- Create: `apps/server-pilot/src/main.ts`
- Create: `apps/server-pilot/src/env.ts`
- Create: `apps/server-pilot/src/auth.ts`
- Create: `apps/server-pilot/src/auth-providers.ts`
- Create: `apps/server-pilot/src/schemas.ts`
- Create: `apps/server-pilot/src/trpc.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: package `@zero/server`.
- Produces: public subpaths `@zero/server/trpc`, `@zero/server/auth`, `@zero/server/schemas`, `@zero/server/auth-providers`.
- Produces: `GET /health -> { ok: true, service: 'server-pilot' }`.

- [ ] **Step 1: Create branch**

Run:

```bash
git checkout FE-demo-minimal
git checkout -b EC2-pilot
```

Expected: branch `EC2-pilot` is created from `FE-demo-minimal`.

- [ ] **Step 2: Add package**

Create `apps/server-pilot/package.json`:

```json
{
  "name": "@zero/server",
  "private": true,
  "type": "module",
  "exports": {
    "./trpc": "./src/trpc.ts",
    "./auth": "./src/auth.ts",
    "./schemas": "./src/schemas.ts",
    "./auth-providers": "./src/auth-providers.ts",
    "./src/types": "./src/types.ts",
    "./src/lib/driver/types": "./src/lib/driver/types.ts",
    "./src/lib/brain.fallback.prompts": "./src/lib/brain.fallback.prompts.ts",
    "./src/lib/cookies": "./src/lib/cookies.ts"
  },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "worker": "tsx src/workers/worker.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "seed:users": "tsx scripts/seed-users.ts"
  },
  "dependencies": {
    "@aws-sdk/client-cloudwatch": "latest",
    "@aws-sdk/client-s3": "latest",
    "@aws-sdk/s3-request-presigner": "latest",
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

- [ ] **Step 3: Add TS config**

Create `apps/server-pilot/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Add env parser**

Create `apps/server-pilot/src/env.ts`:

```typescript
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8788),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().default(10),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:8788'),
  AWS_REGION: z.string().default('eu-west-2'),
  S3_BUCKET: z.string().min(1),
  POP3_HOST: z.string().min(1),
  POP3_PORT: z.coerce.number().default(995),
  POP3_TLS: z.coerce.boolean().default(true),
  POP3_USER: z.string().min(1),
  POP3_PASS: z.string().min(1),
  POP3_POLL_INTERVAL_MS: z.coerce.number().default(30_000),
  POP3_MAX_MESSAGES_PER_CYCLE: z.coerce.number().default(500),
  POP3_COMMAND_TIMEOUT_MS: z.coerce.number().default(120_000),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1)
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
```

- [ ] **Step 5: Add public schema exports**

Create `apps/server-pilot/src/schemas.ts`:

```typescript
import { z } from 'zod';

export const mailCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  searchValue: z.string(),
  color: z.string().optional()
});

export type MailCategory = z.infer<typeof mailCategorySchema>;

export const defaultMailCategories: MailCategory[] = [
  { id: 'inbox', name: 'Inbox', searchValue: 'in:inbox' },
  { id: 'sent', name: 'Sent', searchValue: 'in:sent' },
  { id: 'draft', name: 'Drafts', searchValue: 'in:draft' },
  { id: 'snoozed', name: 'Snoozed', searchValue: 'in:snoozed' }
];

export const userSettingsSchema = z.object({
  language: z.string().default('en'),
  timezone: z.string().default('UTC'),
  colorTheme: z.string().default('system'),
  externalImages: z.boolean().default(false),
  trustedSenders: z.array(z.string()).default([]),
  undoSendEnabled: z.boolean().default(false),
  defaultEmailAlias: z.string().default(''),
  categories: z.array(mailCategorySchema).default(defaultMailCategories)
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: UserSettings = {
  language: 'en',
  timezone: 'UTC',
  colorTheme: 'system',
  externalImages: false,
  trustedSenders: [],
  undoSendEnabled: false,
  defaultEmailAlias: '',
  categories: defaultMailCategories
};

export const senderSchema = z.object({
  name: z.string().optional(),
  email: z.string().email()
});

export const createDraftData = z.object({
  to: z.array(senderSchema).default([]),
  cc: z.array(senderSchema).optional(),
  bcc: z.array(senderSchema).optional(),
  subject: z.string().default(''),
  message: z.string().default(''),
  threadId: z.string().optional(),
  fromEmail: z.string().optional()
});

export type CreateDraftData = z.infer<typeof createDraftData>;
```

- [ ] **Step 6: Add auth public exports**

Create `apps/server-pilot/src/auth.ts`:

```typescript
import type { auth } from './lib/auth-config';

export type Auth = typeof auth;
```

Create `apps/server-pilot/src/auth-providers.ts`:

```typescript
export interface EnvVarInfo {
  name: string;
  source: string;
  required?: boolean;
}
```

- [ ] **Step 7: Add minimal server**

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

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml apps/server-pilot/package.json apps/server-pilot/tsconfig.json apps/server-pilot/src/env.ts apps/server-pilot/src/main.ts apps/server-pilot/src/auth.ts apps/server-pilot/src/auth-providers.ts apps/server-pilot/src/schemas.ts pnpm-lock.yaml
git commit -m "feat: scaffold production server package"
```

---

### Task 2: Frontend Contract Snapshot

**Files:**
- Create: `apps/server-pilot/tests/frontend-contract.test.ts`
- Create: `apps/server-pilot/src/trpc/context.ts`
- Create: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/src/trpc.ts`
- Create: `apps/server-pilot/src/trpc/routes/compat.ts`

**Interfaces:**
- Produces: `appRouter` with every router name the frontend references.
- Produces: initial safe procedure surface before route bodies are filled.
- Consumes: `@zero/server/*` subpaths from Task 1.

- [ ] **Step 1: Write contract test**

Create `apps/server-pilot/tests/frontend-contract.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc';
import { defaultMailCategories, defaultUserSettings, userSettingsSchema } from '../src/schemas';

const requiredRouters = [
  'ai',
  'bimi',
  'brain',
  'categories',
  'connections',
  'cookiePreferences',
  'drafts',
  'labels',
  'logging',
  'mail',
  'meet',
  'notes',
  'shortcut',
  'settings',
  'templates',
  'user'
];

describe('frontend contract', () => {
  it('exports all frontend router roots', () => {
    const record = appRouter._def.record;
    for (const key of requiredRouters) expect(record[key]).toBeDefined();
  });

  it('exports settings values used by apps/mail', () => {
    expect(defaultUserSettings.categories).toEqual(defaultMailCategories);
    expect(userSettingsSchema.parse(defaultUserSettings)).toEqual(defaultUserSettings);
  });
});
```

- [ ] **Step 2: Add tRPC context**

Create `apps/server-pilot/src/trpc/context.ts`:

```typescript
import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

export type TrpcContext = {
  userId: string;
  staffMemberId: string;
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const privateProcedure = t.procedure;
```

- [ ] **Step 3: Add compatibility route shells**

Create `apps/server-pilot/src/trpc/routes/compat.ts`:

```typescript
import { z } from 'zod';
import { defaultMailCategories, defaultUserSettings, userSettingsSchema } from '../../schemas';
import { privateProcedure, publicProcedure, router } from '../context';

const labelInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string().optional(),
  color: z.object({ backgroundColor: z.string(), textColor: z.string() }).optional()
});

export const categoriesRouter = router({
  defaults: publicProcedure.query(() => defaultMailCategories)
});

export const settingsRouter = router({
  get: publicProcedure.query(() => ({ settings: defaultUserSettings })),
  save: privateProcedure.input(userSettingsSchema.partial()).mutation(({ input }) => ({
    settings: { ...defaultUserSettings, ...input }
  }))
});

export const labelsRouter = router({
  list: privateProcedure.query(() => [] as Array<{ id: string; name: string; type: string; color?: { backgroundColor: string; textColor: string } }>),
  create: privateProcedure.input(labelInput).mutation(({ input }) => ({ ...input, id: input.id ?? crypto.randomUUID(), type: 'user' })),
  update: privateProcedure.input(labelInput.extend({ id: z.string() })).mutation(({ input }) => input),
  delete: privateProcedure.input(z.object({ id: z.string() })).mutation(() => true)
});

export const aiRouter = router({
  generateSearchQuery: privateProcedure.input(z.object({ query: z.string().optional() }).passthrough()).mutation(() => ({ query: '' })),
  compose: privateProcedure.input(z.object({}).passthrough()).mutation(() => ({ text: '' })),
  generateEmailSubject: privateProcedure.input(z.object({}).passthrough()).mutation(() => ({ subject: '' })),
  webSearch: privateProcedure.input(z.object({}).passthrough()).mutation(() => ({ results: [] }))
});

export const bimiRouter = router({
  getByEmail: privateProcedure.input(z.object({ email: z.string() })).query(() => null)
});

export const brainRouter = router({
  enableBrain: privateProcedure.mutation(() => true),
  disableBrain: privateProcedure.mutation(() => true),
  generateSummary: privateProcedure.input(z.object({ threadId: z.string() })).query(() => null),
  getState: privateProcedure.query(() => ({ enabled: false })),
  getLabels: privateProcedure.query(() => [] as Array<{ name: string; usecase: string }>),
  updateLabels: privateProcedure.input(z.object({ labels: z.array(z.object({ name: z.string(), usecase: z.string() })) })).mutation(() => ({ success: true })),
  getPrompts: privateProcedure.query(() => []),
  updatePrompt: privateProcedure.input(z.object({ promptType: z.string(), content: z.string() })).mutation(() => ({ success: true }))
});

export const cookiePreferencesRouter = router({
  getPreferences: privateProcedure.query(() => ({})),
  updatePreferences: privateProcedure.input(z.record(z.unknown())).mutation(({ input }) => input)
});

export const meetRouter = router({
  create: privateProcedure.input(z.object({}).passthrough()).mutation(() => ({ success: false }))
});

export const loggingRouter = router({});
export const shortcutRouter = router({});

export const userRouter = router({
  getIntercomToken: privateProcedure.query(() => null),
  delete: privateProcedure.mutation(() => ({ success: false, message: 'Account deletion is disabled for this deployment.' }))
});
```

- [ ] **Step 4: Add router export**

Create `apps/server-pilot/src/trpc/index.ts`:

```typescript
import {
  aiRouter,
  bimiRouter,
  brainRouter,
  categoriesRouter,
  cookiePreferencesRouter,
  labelsRouter,
  loggingRouter,
  meetRouter,
  shortcutRouter,
  settingsRouter,
  userRouter
} from './routes/compat';
import { router } from './context';

const emptyRouter = router({});

export const appRouter = router({
  ai: aiRouter,
  bimi: bimiRouter,
  brain: brainRouter,
  categories: categoriesRouter,
  connections: emptyRouter,
  cookiePreferences: cookiePreferencesRouter,
  drafts: emptyRouter,
  labels: labelsRouter,
  logging: loggingRouter,
  mail: emptyRouter,
  meet: meetRouter,
  notes: emptyRouter,
  shortcut: shortcutRouter,
  settings: settingsRouter,
  templates: emptyRouter,
  user: userRouter
});

export type AppRouter = typeof appRouter;
```

Create `apps/server-pilot/src/trpc.ts`:

```typescript
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from './trpc/index';

export { appRouter } from './trpc/index';
export type { AppRouter } from './trpc/index';
export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;
```

- [ ] **Step 5: Run contract test**

Run:

```bash
pnpm --filter @zero/server test tests/frontend-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/trpc apps/server-pilot/src/trpc.ts apps/server-pilot/tests/frontend-contract.test.ts
git commit -m "feat: add frontend contract surface"
```

---

### Task 3: Production Schema and Migration

**Files:**
- Create: `apps/server-pilot/drizzle.config.ts`
- Create: `apps/server-pilot/src/db/client.ts`
- Create: `apps/server-pilot/src/db/schema/auth.ts`
- Create: `apps/server-pilot/src/db/schema/app.ts`
- Create: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/src/db/schema/index.ts`
- Create: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces: Drizzle `db`.
- Produces: the 16 app tables listed above.
- Produces: partial unique index for inbound POP3 UIDL.
- Produces: `mailThread` shared state fields.

- [ ] **Step 1: Write schema contract test**

Create `apps/server-pilot/tests/schema-contract.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';

describe('production schema contract', () => {
  it('uses one message table for inbound and outbound mail', () => {
    expect(schema.message).toBeDefined();
    expect((schema as Record<string, unknown>).inboundMessage).toBeUndefined();
    expect((schema as Record<string, unknown>).outboundMessage).toBeUndefined();
  });

  it('does not export deleted overbuilt tables', () => {
    expect((schema as Record<string, unknown>).jwks).toBeUndefined();
    expect((schema as Record<string, unknown>).messageRecipient).toBeUndefined();
    expect((schema as Record<string, unknown>).mailScheduledEmail).toBeUndefined();
    expect((schema as Record<string, unknown>).writingStyleMatrix).toBeUndefined();
  });

  it('keeps shared thread state on mailThread', () => {
    expect(schema.mailThread.isUnread).toBeDefined();
    expect(schema.mailThread.labels).toBeDefined();
    expect(schema.mailThread.isImportant).toBeDefined();
    expect(schema.mailThread.isStarred).toBeDefined();
  });

  it('tracks POP3 purge audit and safe S3 keys on message rows', () => {
    expect(schema.message.pop3PurgedAt).toBeDefined();
    expect(schema.message.rawEmlKey).toBeDefined();
  });
});
```

- [ ] **Step 2: Add schema files**

Implement schema with these exact table exports:

```typescript
export {
  user,
  session,
  account,
  verification
} from './auth';
export {
  note,
  userSettings,
  emailTemplate,
  mailPrompt
} from './app';
export {
  mailboxTransport,
  staffMember,
  mailLabel,
  mailThread,
  message,
  attachment,
  mailDraft,
  mailSnooze
} from './mail';
```

Critical `message` constraints in `mail.ts`:

```typescript
inboundUidlUnique: uniqueIndex('message_inbound_uidl_uidx')
  .on(table.transportId, table.pop3Uidl)
  .where(sql`${table.direction} = 'inbound'`),
inboundRequired: check(
  'message_inbound_required_chk',
  sql`direction <> 'inbound' OR (pop3_uidl IS NOT NULL AND raw_eml_key IS NOT NULL AND received_at IS NOT NULL)`
),
outboundRequired: check(
  'message_outbound_required_chk',
  sql`direction <> 'outbound' OR (status IS NOT NULL AND sent_at IS NOT NULL)`
)
```

Critical `mailThread` indexes:

```typescript
rootUnique: uniqueIndex('mail_thread_transport_root_uidx').on(table.transportId, table.threadRootId),
listIdx: index('mail_thread_list_idx').on(table.transportId, table.isArchived, table.latestMessageAt),
unreadIdx: index('mail_thread_unread_idx').on(table.transportId, table.isUnread)
```

- [ ] **Step 3: Add Drizzle config and DB client**

Create `apps/server-pilot/drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!
  }
});
```

Create `apps/server-pilot/src/db/client.ts`:

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env';
import * as schema from './schema';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
```

- [ ] **Step 4: Run schema tests and generate migration**

Run:

```bash
pnpm --filter @zero/server test tests/schema-contract.test.ts
pnpm --filter @zero/server db:generate
```

Expected: tests PASS and one migration appears under `apps/server-pilot/drizzle/`.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/drizzle.config.ts apps/server-pilot/src/db apps/server-pilot/tests/schema-contract.test.ts apps/server-pilot/drizzle
git commit -m "feat: add production postgres schema"
```

---

### Task 4: Auth and Seed Data

**Files:**
- Create: `apps/server-pilot/src/lib/auth-config.ts`
- Create: `apps/server-pilot/src/routes/auth.ts`
- Create: `apps/server-pilot/scripts/seed-users.ts`
- Create: `apps/server-pilot/tests/auth-config.test.ts`
- Modify: `apps/server-pilot/src/main.ts`

**Interfaces:**
- Produces: `auth` Better Auth instance.
- Produces: `/auth/*` handler, matching the frontend auth client base URL.
- Produces: `/api/public/providers`, returning provider metadata for the login page.
- Produces: one seeded `mailbox_transport`, 50 users, 50 staff rows.

- [ ] **Step 1: Write auth test**

Create `apps/server-pilot/tests/auth-config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { authConfigSummary } from '../src/lib/auth-config';

describe('auth config', () => {
  it('uses email/password session cookies only', () => {
    expect(authConfigSummary).toEqual({
      emailAndPassword: true,
      hasJwtPlugin: false,
      hasBearerPlugin: false,
      hasMcpPlugin: false,
      socialProviders: []
    });
  });
});
```

- [ ] **Step 2: Implement auth config**

Create `apps/server-pilot/src/lib/auth-config.ts`:

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
  socialProviders: [] as string[]
};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false
  },
  socialProviders: {},
  plugins: []
});
```

- [ ] **Step 3: Mount auth**

Modify `apps/server-pilot/src/main.ts`:

```typescript
import { auth } from './lib/auth-config';
import { publicProviders } from './routes/auth';

app.on(['GET', 'POST', 'OPTIONS'], '/auth/**', (c) => auth.handler(c.req.raw));
app.get('/api/public/providers', publicProviders);
```

- [ ] **Step 4: Implement provider metadata route**

Create `apps/server-pilot/src/routes/auth.ts`:

```typescript
import type { Context } from 'hono';

export function publicProviders(c: Context) {
  return c.json({
    allProviders: [],
    isProd: process.env.NODE_ENV === 'production'
  });
}
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
  throw new Error('SEED_PASSWORD_HASH is required');
}

await db.insert(mailboxTransport).values({
  id: transportId,
  email: process.env.POP3_USER ?? 'nava@legacy.local',
  displayName: 'Nava',
  pop3Host: process.env.POP3_HOST ?? 'pop3.legacy.local',
  pop3Port: Number(process.env.POP3_PORT ?? 995),
  smtpHost: process.env.SMTP_HOST ?? 'smtp.legacy.local',
  smtpPort: Number(process.env.SMTP_PORT ?? 587)
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
    defaultStaffMemberId: staffId
  }).onConflictDoNothing();

  await db.insert(account).values({
    id: crypto.randomUUID(),
    accountId: email,
    providerId: 'credential',
    userId: id,
    password: passwordHash
  }).onConflictDoNothing();

  await db.insert(staffMember).values({
    id: staffId,
    userId: id,
    transportId,
    name: `Legacy Agent ${i}`,
    email,
    emailAddresses: [email],
    labelConfig: {}
  }).onConflictDoNothing();
}

console.log('Seeded 50 users and one Nava transport');
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @zero/server test tests/auth-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/lib/auth-config.ts apps/server-pilot/src/main.ts apps/server-pilot/scripts/seed-users.ts apps/server-pilot/tests/auth-config.test.ts
git commit -m "feat: add production auth"
```

---

### Task 5: S3 Storage With Collision-Proof Keys

**Files:**
- Create: `apps/server-pilot/src/lib/s3.ts`
- Create: `apps/server-pilot/tests/s3.test.ts`

**Interfaces:**
- Produces: `putRawEml(messageDbId: string, body: Buffer): Promise<string>`.
- Produces: `putAttachment(input): Promise<string>`.
- Rule: never key S3 by email `Message-ID` header.

- [ ] **Step 1: Write collision tests**

Create `apps/server-pilot/tests/s3.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeS3Storage } from '../src/lib/s3';

describe('S3 storage', () => {
  it('keys raw MIME by DB message id', async () => {
    const put = vi.fn().mockResolvedValue({});
    const storage = makeS3Storage({ put, sign: vi.fn() });
    const key = await storage.putRawEml('db-msg-1', Buffer.from('Subject: hi'));
    expect(key).toBe('raw/db-msg-1.eml');
  });

  it('prefixes attachment filenames with attachment DB id to avoid overwrite', async () => {
    const put = vi.fn().mockResolvedValue({});
    const storage = makeS3Storage({ put, sign: vi.fn() });
    const first = await storage.putAttachment({
      messageDbId: 'db-msg-1',
      attachmentId: 'att-1',
      fileName: 'folio.pdf',
      contentType: 'application/pdf',
      body: Buffer.from('%PDF')
    });
    const second = await storage.putAttachment({
      messageDbId: 'db-msg-1',
      attachmentId: 'att-2',
      fileName: 'folio.pdf',
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-2')
    });
    expect(first).toBe('attachments/db-msg-1/att-1-folio.pdf');
    expect(second).toBe('attachments/db-msg-1/att-2-folio.pdf');
  });
});
```

- [ ] **Step 2: Implement S3 helper**

Create `apps/server-pilot/src/lib/s3.ts`:

```typescript
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

type S3Deps = {
  put: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
  sign: (key: string) => Promise<string>;
};

export type PutAttachmentInput = {
  messageDbId: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  body: Buffer;
};

const cleanName = (value: string) => value.replace(/[/\\]/g, '_');

export function makeS3Storage(deps: S3Deps) {
  return {
    async putRawEml(messageDbId: string, body: Buffer) {
      const key = `raw/${messageDbId}.eml`;
      await deps.put(key, body, 'message/rfc822');
      return key;
    },
    async putAttachment(input: PutAttachmentInput) {
      const key = `attachments/${input.messageDbId}/${input.attachmentId}-${cleanName(input.fileName)}`;
      await deps.put(key, input.body, input.contentType);
      return key;
    },
    getSignedObjectUrl(key: string) {
      return deps.sign(key);
    }
  };
}

const client = new S3Client({ region: env.AWS_REGION });

export const s3Storage = makeS3Storage({
  put: (key, body, contentType) =>
    client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType
    })),
  sign: (key) =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: 600 })
});
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/s3.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/s3.ts apps/server-pilot/tests/s3.test.ts
git commit -m "feat: add collision-safe s3 storage"
```

---

### Task 6: POP3 Client Adapter Spike and Implementation

**Files:**
- Create: `apps/server-pilot/src/lib/pop3/client.ts`
- Create: `apps/server-pilot/tests/pop3-client.test.ts`
- Modify: `apps/server-pilot/deploy/runbook.md`

**Interfaces:**
- Produces: `Pop3Session` with `uidl`, `retr`, `dele`, `quit`, and `rsetBeforeQuitOnly`.
- Confirms node-pop3 `UIDL()` returns `[msgNum, uid]` rows and `RETR(msgNum)` returns a message string.

- [ ] **Step 1: Write adapter tests**

Create `apps/server-pilot/tests/pop3-client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makePop3Session } from '../src/lib/pop3/client';

describe('POP3 client adapter', () => {
  it('normalizes UIDL rows into message numbers and UIDLs', async () => {
    const raw = { UIDL: vi.fn().mockResolvedValue([['1', 'uid-a'], ['2', 'uid-b']]) };
    const session = makePop3Session(raw);
    await expect(session.uidl()).resolves.toEqual([
      { number: 1, uidl: 'uid-a' },
      { number: 2, uidl: 'uid-b' }
    ]);
  });

  it('converts RETR string output to Buffer', async () => {
    const raw = { RETR: vi.fn().mockResolvedValue('Subject: Hi\r\n\r\nBody') };
    const session = makePop3Session(raw);
    await expect(session.retr(1)).resolves.toEqual(Buffer.from('Subject: Hi\r\n\r\nBody', 'binary'));
  });
});
```

- [ ] **Step 2: Implement adapter**

Create `apps/server-pilot/src/lib/pop3/client.ts`:

```typescript
import Pop3Command from 'node-pop3';
import { env } from '../../env';

export type UidlEntry = { number: number; uidl: string };

export type Pop3Session = {
  uidl: () => Promise<UidlEntry[]>;
  retr: (number: number) => Promise<Buffer>;
  dele: (number: number) => Promise<void>;
  rsetBeforeQuitOnly: () => Promise<void>;
  quit: () => Promise<void>;
};

type RawPop3 = {
  UIDL?: () => Promise<Array<[string, string]>>;
  RETR?: (number: number) => Promise<string>;
  DELE?: (number: number) => Promise<unknown>;
  RSET?: () => Promise<unknown>;
  QUIT?: () => Promise<unknown>;
};

export function makePop3Session(raw: RawPop3): Pop3Session {
  return {
    async uidl() {
      const rows = await raw.UIDL!();
      return rows.map(([number, uidl]) => ({ number: Number(number), uidl }));
    },
    async retr(number: number) {
      const value = await raw.RETR!(number);
      return Buffer.from(value, 'binary');
    },
    async dele(number: number) {
      await raw.DELE!(number);
    },
    async rsetBeforeQuitOnly() {
      await raw.RSET!();
    },
    async quit() {
      await raw.QUIT!();
    }
  };
}

export async function connectPop3(): Promise<Pop3Session> {
  const raw = new Pop3Command({
    user: env.POP3_USER,
    password: env.POP3_PASS,
    host: env.POP3_HOST,
    port: env.POP3_PORT,
    tls: env.POP3_TLS,
    timeout: env.POP3_COMMAND_TIMEOUT_MS
  });
  if (typeof raw.connect === 'function') await raw.connect();
  return makePop3Session(raw);
}
```

- [ ] **Step 3: Add kickoff runbook checks**

Add to `apps/server-pilot/deploy/runbook.md`:

```markdown
## POP3 Kickoff Check

- Confirm `UIDL()` returns stable unique ids and message numbers.
- Confirm `RETR(number)` returns the full RFC822 message.
- Confirm `DELE(number)` marks a message and `QUIT()` permanently removes it.
- Confirm `RSET()` clears deletion marks before `QUIT()`.
- Confirm the server allows a 500-message session without idle timeout.
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/pop3-client.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/pop3/client.ts apps/server-pilot/tests/pop3-client.test.ts apps/server-pilot/deploy/runbook.md
git commit -m "feat: add pop3 client adapter"
```

---

### Task 7: POP3 Parser, Thread Stitcher, and Store Transaction

**Files:**
- Create: `apps/server-pilot/src/lib/pop3/parser.ts`
- Create: `apps/server-pilot/src/lib/pop3/thread-stitch.ts`
- Create: `apps/server-pilot/src/lib/pop3/store.ts`
- Create: `apps/server-pilot/tests/thread-stitch.test.ts`
- Create: `apps/server-pilot/tests/ingest-store.test.ts`

**Interfaces:**
- Produces: `parseRawMessage(raw: Buffer): Promise<ParsedInboundEmail>`.
- Produces: `computeThreadRootId(headers): string`.
- Produces: `createIngestStore(db, s3): IngestStore`.
- Produces: `createProductionIngestStore(): IngestStore`.
- Produces: `persistInbound` transaction: thread upsert, message insert, raw MIME S3 key, attachment insert.

- [ ] **Step 1: Write thread tests**

Create `apps/server-pilot/tests/thread-stitch.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeThreadRootId } from '../src/lib/pop3/thread-stitch';

describe('computeThreadRootId', () => {
  it('uses first References id as thread root', () => {
    expect(computeThreadRootId({
      messageId: '<c@legacy>',
      references: ['<a@legacy>', '<b@legacy>'],
      inReplyTo: '<b@legacy>',
      subject: 'Re: Booking'
    })).toBe('<a@legacy>');
  });

  it('falls back to Message-ID before synthesized subject', () => {
    expect(computeThreadRootId({
      messageId: '<m@legacy>',
      references: [],
      subject: 'Booking'
    })).toBe('<m@legacy>');
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

export function computeThreadRootId(headers: ThreadHeaders): string {
  const firstReference = headers.references?.map((value) => value.trim()).find(Boolean);
  if (firstReference) return firstReference;
  if (headers.inReplyTo) return headers.inReplyTo.trim();
  if (headers.messageId) return headers.messageId.trim();
  const subject = headers.subject?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `<synth:${subject || 'no-id'}>`;
}
```

- [ ] **Step 3: Implement parser**

Create `apps/server-pilot/src/lib/pop3/parser.ts`:

```typescript
import { simpleParser } from 'mailparser';

export type EmailAddress = { name?: string; email: string };

export type ParsedInboundEmail = {
  messageId?: string;
  references: string[];
  inReplyTo?: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  text?: string;
  html?: string;
  date: Date;
  tls: boolean;
  attachments: Array<{
    fileName: string;
    contentType: string;
    content: Buffer;
    size: number;
    contentId?: string;
    headers: Array<{ name?: string | null; value?: string | null }>;
  }>;
};

const addresses = (value: any): EmailAddress[] =>
  (value?.value ?? [])
    .map((addr: any) => ({ name: addr.name || undefined, email: addr.address }))
    .filter((addr: EmailAddress) => !!addr.email);

export async function parseRawMessage(raw: Buffer): Promise<ParsedInboundEmail> {
  const parsed = await simpleParser(raw);
  return {
    messageId: parsed.messageId || undefined,
    references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
    inReplyTo: parsed.inReplyTo || undefined,
    subject: parsed.subject || '',
    from: addresses(parsed.from)[0] ?? { email: 'unknown@legacy.local' },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    text: parsed.text || undefined,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    date: parsed.date ?? new Date(),
    tls: true,
    attachments: parsed.attachments.map((attachment) => ({
      fileName: attachment.filename || 'attachment.bin',
      contentType: attachment.contentType || 'application/octet-stream',
      content: attachment.content,
      size: attachment.size,
      contentId: attachment.contentId || undefined,
      headers: Array.from(attachment.headers.entries()).map(([name, value]) => ({ name, value: String(value) }))
    }))
  };
}
```

- [ ] **Step 4: Write store transaction tests**

Create `apps/server-pilot/tests/ingest-store.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeIngestStoreForTest } from '../src/lib/pop3/store';

describe('ingest store', () => {
  it('uses DB row id for S3 raw MIME key', async () => {
    const putRawEml = vi.fn().mockResolvedValue('raw/db-msg-1.eml');
    const store = makeIngestStoreForTest({ putRawEml });
    const result = await store.persistInbound({
      transportId: 'nava-pop3-smtp',
      uidl: 'uid-1',
      raw: Buffer.from('Subject: A'),
      parsed: {
        subject: 'A',
        from: { email: 'guest@example.com' },
        to: [],
        cc: [],
        bcc: [],
        references: [],
        date: new Date('2026-06-30T12:00:00Z'),
        tls: true,
        attachments: []
      },
      threadRootId: '<root-1>'
    });
    expect(result.messageId).toBe('db-msg-1');
    expect(putRawEml).toHaveBeenCalledWith('db-msg-1', Buffer.from('Subject: A'));
  });
});
```

- [ ] **Step 5: Implement store interface**

Create `apps/server-pilot/src/lib/pop3/store.ts`:

```typescript
import crypto from 'node:crypto';
import type { ParsedInboundEmail } from './parser';

export type PersistInboundInput = {
  transportId: string;
  uidl: string;
  raw: Buffer;
  parsed: ParsedInboundEmail;
  threadRootId: string;
};

export type IngestStore = {
  hasUidl: (transportId: string, uidl: string) => Promise<boolean>;
  persistInbound: (input: PersistInboundInput) => Promise<{ messageId: string; alreadyStored: boolean }>;
  markPurged: (messageIds: string[], purgedAt: Date) => Promise<void>;
  updateTransportPoll: (transportId: string, input: { uidlBacklog: number; success: boolean }) => Promise<void>;
};

export function makeIngestStoreForTest(deps: {
  putRawEml: (messageDbId: string, raw: Buffer) => Promise<string>;
}): IngestStore {
  const seen = new Set<string>();
  return {
    async hasUidl(transportId, uidl) {
      return seen.has(`${transportId}:${uidl}`);
    },
    async persistInbound(input) {
      const key = `${input.transportId}:${input.uidl}`;
      if (seen.has(key)) return { messageId: 'db-msg-1', alreadyStored: true };
      const messageId = 'db-msg-1';
      await deps.putRawEml(messageId, input.raw);
      seen.add(key);
      return { messageId, alreadyStored: false };
    },
    async markPurged() {},
    async updateTransportPoll() {}
  };
}

export function createMessageDbId() {
  return crypto.randomUUID();
}
```

Add the real `createProductionIngestStore()` in the same file. Its `hasUidl` queries `message` by `(transportId, uidl, direction='inbound')`. Its `persistInbound` creates `messageId` before S3 writes, stores raw MIME and attachments under that id, then runs one Postgres transaction that upserts `mailThread`, inserts `message` with `ON CONFLICT DO NOTHING`, and inserts `attachment` rows. Its `markPurged` updates `message.pop3PurgedAt`. Its `updateTransportPoll` updates `mailboxTransport.lastPolledAt`, `lastSuccessfulPollAt`, and `uidlBacklog`.

Implementation note for the real DB store:

```typescript
// Transaction order:
// 1. create messageDbId
// 2. S3 put raw under raw/<messageDbId>.eml
// 3. S3 put attachments under attachments/<messageDbId>/<index>-<name>
// 4. db.transaction: upsert mailThread, insert message ON CONFLICT DO NOTHING, insert attachments
// 5. return { messageId, alreadyStored }
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/thread-stitch.test.ts tests/ingest-store.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/pop3/parser.ts apps/server-pilot/src/lib/pop3/thread-stitch.ts apps/server-pilot/src/lib/pop3/store.ts apps/server-pilot/tests/thread-stitch.test.ts apps/server-pilot/tests/ingest-store.test.ts
git commit -m "feat: add ingest parser and store contract"
```

---

### Task 8: Batch-Capped POP3 Poller

**Files:**
- Create: `apps/server-pilot/src/lib/pop3/poller.ts`
- Create: `apps/server-pilot/tests/pop3-ordering.test.ts`
- Create: `apps/server-pilot/tests/pop3-cap.test.ts`

**Interfaces:**
- Produces: `ingestOnce(transportId, deps): Promise<IngestResult>`.
- Enforces: `DELE` only after store success.
- Enforces: at most 500 UIDLs per session.
- Fixes: already-stored UIDLs still get `DELE` so crash replays drain the server.

- [ ] **Step 1: Write ordering and replay tests**

Create `apps/server-pilot/tests/pop3-ordering.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ingestOnce, type IngestDeps } from '../src/lib/pop3/poller';

function deps(log: string[], alreadyStored = false): IngestDeps {
  return {
    now: () => new Date('2026-06-30T12:00:00Z'),
    maxMessagesPerCycle: 500,
    pop3: {
      uidl: async () => [{ number: 1, uidl: 'uid-1' }],
      retr: async (number) => {
        log.push(`RETR ${number}`);
        return Buffer.from('Subject: Hi\r\nMessage-ID: <m1>\r\n\r\nBody');
      },
      dele: async (number) => {
        log.push(`DELE ${number}`);
      },
      rsetBeforeQuitOnly: async () => {
        log.push('RSET');
      },
      quit: async () => {
        log.push('QUIT');
      }
    },
    store: {
      hasUidl: async () => alreadyStored,
      persistInbound: async () => {
        log.push('STORE_COMMIT');
        return { messageId: 'db-msg-1', alreadyStored: false };
      },
      markPurged: async () => {
        log.push('MARK_PURGED');
      },
      updateTransportPoll: async () => undefined
    }
  };
}

describe('POP3 ingest ordering', () => {
  it('deletes only after store commit', async () => {
    const log: string[] = [];
    await ingestOnce('nava-pop3-smtp', deps(log));
    expect(log).toEqual(['RETR 1', 'STORE_COMMIT', 'DELE 1', 'QUIT', 'MARK_PURGED']);
  });

  it('deletes already-stored UIDLs so replayed messages drain after crash before QUIT', async () => {
    const log: string[] = [];
    await ingestOnce('nava-pop3-smtp', deps(log, true));
    expect(log).toEqual(['DELE 1', 'QUIT', 'MARK_PURGED']);
  });

  it('continues after a per-message failure without resetting previous deletes', async () => {
    const log: string[] = [];
    const testDeps = deps(log);
    testDeps.pop3.uidl = async () => [
      { number: 1, uidl: 'uid-1' },
      { number: 2, uidl: 'uid-2' },
      { number: 3, uidl: 'uid-3' }
    ];
    testDeps.pop3.retr = async (number) => {
      log.push(`RETR ${number}`);
      if (number === 2) throw new Error('bad message');
      return Buffer.from(`Subject: ${number}\r\n\r\nBody`);
    };
    await ingestOnce('nava-pop3-smtp', testDeps);
    expect(log).toEqual([
      'RETR 1',
      'STORE_COMMIT',
      'DELE 1',
      'RETR 2',
      'RETR 3',
      'STORE_COMMIT',
      'DELE 3',
      'QUIT',
      'MARK_PURGED'
    ]);
  });
});
```

- [ ] **Step 2: Write cap test**

Create `apps/server-pilot/tests/pop3-cap.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ingestOnce, type IngestDeps } from '../src/lib/pop3/poller';

describe('POP3 cycle cap', () => {
  it('processes only maxMessagesPerCycle messages', async () => {
    let deletes = 0;
    const entries = Array.from({ length: 1500 }, (_, index) => ({ number: index + 1, uidl: `uid-${index + 1}` }));
    const deps: IngestDeps = {
      now: () => new Date('2026-06-30T12:00:00Z'),
      maxMessagesPerCycle: 500,
      pop3: {
        uidl: async () => entries,
        retr: async () => Buffer.from('Subject: Hi\r\n\r\nBody'),
        dele: async () => {
          deletes += 1;
        },
        rsetBeforeQuitOnly: async () => undefined,
        quit: async () => undefined
      },
      store: {
        hasUidl: async () => false,
        persistInbound: async () => ({ messageId: crypto.randomUUID(), alreadyStored: false }),
        markPurged: async () => undefined,
        updateTransportPoll: async () => undefined
      }
    };
    const result = await ingestOnce('nava-pop3-smtp', deps);
    expect(deletes).toBe(500);
    expect(result.uidlBacklog).toBe(1000);
  });
});
```

- [ ] **Step 3: Implement poller**

Create `apps/server-pilot/src/lib/pop3/poller.ts`:

```typescript
import { parseRawMessage } from './parser';
import { computeThreadRootId } from './thread-stitch';
import type { IngestStore } from './store';
import type { Pop3Session, UidlEntry } from './client';

export type IngestDeps = {
  now: () => Date;
  maxMessagesPerCycle: number;
  pop3: Pop3Session;
  store: IngestStore;
};

export type IngestResult = {
  ingested: number;
  purged: number;
  failed: number;
  uidlBacklog: number;
  cycleMs: number;
};

export async function ingestOnce(transportId: string, deps: IngestDeps): Promise<IngestResult> {
  const started = Date.now();
  const entries = await deps.pop3.uidl();
  const batch = entries.slice(0, deps.maxMessagesPerCycle);
  const purgedMessageIds: string[] = [];
  let ingested = 0;
  let failed = 0;
  let hasDeletionMarks = false;

  try {
    for (const entry of batch) {
      try {
        if (await deps.store.hasUidl(transportId, entry.uidl)) {
          await deps.pop3.dele(entry.number);
          hasDeletionMarks = true;
          purgedMessageIds.push(`${transportId}:${entry.uidl}`);
          continue;
        }

        const raw = await deps.pop3.retr(entry.number);
        const parsed = await parseRawMessage(raw);
        const threadRootId = computeThreadRootId({
          messageId: parsed.messageId,
          references: parsed.references,
          inReplyTo: parsed.inReplyTo,
          subject: parsed.subject
        });
        const stored = await deps.store.persistInbound({
          transportId,
          uidl: entry.uidl,
          raw,
          parsed,
          threadRootId
        });

        await deps.pop3.dele(entry.number);
        hasDeletionMarks = true;
        purgedMessageIds.push(stored.messageId);
        if (!stored.alreadyStored) ingested += 1;
      } catch (error) {
        failed += 1;
        continue;
      }
    }

    await deps.pop3.quit();
    await deps.store.markPurged(purgedMessageIds, deps.now());
    await deps.store.updateTransportPoll(transportId, {
      uidlBacklog: Math.max(0, entries.length - batch.length),
      success: true
    });

    return {
      ingested,
      purged: purgedMessageIds.length,
      failed,
      uidlBacklog: Math.max(0, entries.length - batch.length),
      cycleMs: Date.now() - started
    };
  } catch (error) {
    if (!hasDeletionMarks) await deps.pop3.rsetBeforeQuitOnly();
    await deps.pop3.quit();
    await deps.store.updateTransportPoll(transportId, {
      uidlBacklog: entries.length,
      success: false
    });
    throw error;
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/pop3-ordering.test.ts tests/pop3-cap.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/pop3/poller.ts apps/server-pilot/tests/pop3-ordering.test.ts apps/server-pilot/tests/pop3-cap.test.ts
git commit -m "feat: add safe batch-capped pop3 poller"
```

---

### Task 9: ParsedMessage Mapper With Real Frontend Shape

**Files:**
- Create: `apps/server-pilot/src/lib/parsed-message-mapper.ts`
- Create: `apps/server-pilot/tests/parsed-message-mapper.test.ts`
- Read fixture: `apps/mail/lib/demo-data/centurion-threads.json`

**Interfaces:**
- Produces: `toParsedMessage(row, attachments, thread): ParsedMessage`.
- Must match `apps/mail/types/index.ts` exactly: `body`, `processedHtml`, `blobUrl`, attachment keys.

- [ ] **Step 1: Write full-shape mapper test**

Create `apps/server-pilot/tests/parsed-message-mapper.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toParsedMessage } from '../src/lib/parsed-message-mapper';

describe('toParsedMessage', () => {
  it('emits the frontend ParsedMessage shape', () => {
    const message = toParsedMessage({
      row: {
        id: 'msg-1',
        threadId: 'thread-1',
        direction: 'inbound',
        sender: { name: 'Guest', email: 'guest@example.com' },
        toAddrs: [{ name: 'Nava', email: 'nava@legacy.local' }],
        ccAddrs: [],
        bccAddrs: [],
        subject: 'Booking',
        bodyText: 'Hello',
        bodyHtml: '<p>Hello</p>',
        processedHtml: '<p>Hello</p>',
        blobUrl: '',
        messageId: '<msg-1@example.com>',
        inReplyTo: null,
        references: [],
        tls: true,
        sentAt: null,
        receivedAt: new Date('2026-06-30T12:00:00Z'),
        status: null
      },
      thread: {
        labels: ['INBOX', 'UNREAD'],
        isUnread: true
      },
      attachments: [{
        id: 'att-1',
        fileName: 'folio.pdf',
        contentType: 'application/pdf',
        sizeBytes: 123,
        s3Key: 'attachments/msg-1/0-folio.pdf',
        headers: [{ name: 'Content-Type', value: 'application/pdf' }]
      }]
    });

    expect(message).toEqual({
      id: 'msg-1',
      threadId: 'thread-1',
      title: 'Booking',
      subject: 'Booking',
      tags: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'UNREAD', name: 'UNREAD', type: 'system' }],
      sender: { name: 'Guest', email: 'guest@example.com' },
      to: [{ name: 'Nava', email: 'nava@legacy.local' }],
      cc: [],
      bcc: [],
      tls: true,
      receivedOn: '2026-06-30T12:00:00.000Z',
      unread: true,
      body: '<p>Hello</p>',
      processedHtml: '<p>Hello</p>',
      blobUrl: '',
      decodedBody: '<p>Hello</p>',
      references: '',
      inReplyTo: undefined,
      messageId: '<msg-1@example.com>',
      isDraft: false,
      attachments: [{
        attachmentId: 'att-1',
        filename: 'folio.pdf',
        mimeType: 'application/pdf',
        size: 123,
        body: '',
        headers: [{ name: 'Content-Type', value: 'application/pdf' }]
      }]
    });
  });
});
```

- [ ] **Step 2: Implement mapper**

Create `apps/server-pilot/src/lib/parsed-message-mapper.ts`:

```typescript
type Sender = { name?: string; email: string };

type MessageRow = {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  sender: Sender;
  toAddrs: Sender[];
  ccAddrs: Sender[];
  bccAddrs: Sender[];
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

type AttachmentRow = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  s3Key: string;
  headers: Array<{ name?: string | null; value?: string | null }>;
};

export function labelsToTags(labels: string[]) {
  return labels.map((label) => ({ id: label, name: label, type: label === label.toUpperCase() ? 'system' : 'user' }));
}

export function toParsedMessage(input: {
  row: MessageRow;
  thread: { labels: string[]; isUnread: boolean };
  attachments: AttachmentRow[];
}) {
  const date = input.row.receivedAt ?? input.row.sentAt ?? new Date(0);
  const html = input.row.processedHtml ?? input.row.bodyHtml ?? input.row.bodyText ?? '';

  return {
    id: input.row.id,
    threadId: input.row.threadId,
    title: input.row.subject,
    subject: input.row.subject,
    tags: labelsToTags(input.thread.labels),
    sender: input.row.sender,
    to: input.row.toAddrs,
    cc: input.row.ccAddrs,
    bcc: input.row.bccAddrs,
    tls: input.row.tls ?? false,
    receivedOn: date.toISOString(),
    unread: input.thread.isUnread,
    body: html,
    processedHtml: html,
    blobUrl: input.row.blobUrl ?? '',
    decodedBody: html,
    references: input.row.references.join(' '),
    inReplyTo: input.row.inReplyTo ?? undefined,
    messageId: input.row.messageId ?? undefined,
    isDraft: input.row.status === 'queued',
    attachments: input.attachments.map((attachment) => ({
      attachmentId: attachment.id,
      filename: attachment.fileName,
      mimeType: attachment.contentType,
      size: attachment.sizeBytes,
      body: '',
      headers: attachment.headers
    }))
  };
}
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/parsed-message-mapper.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/parsed-message-mapper.ts apps/server-pilot/tests/parsed-message-mapper.test.ts
git commit -m "feat: map messages to frontend contract"
```

---

### Task 10: DB-Backed Mail Read Paths

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/tests/mail-read-path.test.ts`
- Modify: `apps/server-pilot/src/trpc/index.ts`

**Interfaces:**
- Produces: `mail.listThreads` with seek pagination from `mailThread`.
- Produces: `mail.get` with full `IGetThreadResponse`: `messages`, optional `latest`, `hasUnread`, `totalReplies`, `labels`.

- [ ] **Step 1: Write response shape test**

Create `apps/server-pilot/tests/mail-read-path.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeThreadResponse } from '../src/trpc/routes/mail';

describe('mail read response contract', () => {
  it('returns required IGetThreadResponse fields', () => {
    const response = makeThreadResponse({
      messages: [],
      labels: ['INBOX'],
      hasUnread: false
    });
    expect(response).toEqual({
      messages: [],
      latest: undefined,
      hasUnread: false,
      totalReplies: 0,
      labels: [{ id: 'INBOX', name: 'INBOX' }]
    });
  });
});
```

- [ ] **Step 2: Implement mail route read helpers**

Create `apps/server-pilot/src/trpc/routes/mail.ts`:

```typescript
import { z } from 'zod';
import { privateProcedure, router } from '../context';

export function makeThreadResponse(input: { messages: any[]; labels: string[]; hasUnread: boolean }) {
  return {
    messages: input.messages,
    latest: input.messages.at(-1),
    hasUnread: input.hasUnread,
    totalReplies: input.messages.length,
    labels: input.labels.map((label) => ({ id: label, name: label }))
  };
}

export const mailRouter = router({
  listThreads: privateProcedure
    .input(z.object({
      folder: z.string().optional(),
      maxResults: z.number().min(1).max(100).default(50),
      cursor: z.string().optional(),
      q: z.string().optional(),
      labelIds: z.array(z.string()).optional()
    }))
    .query(async () => ({
      threads: [] as Array<{ id: string; historyId: string | null; $raw?: unknown }>,
      nextPageToken: null as string | null
    })),
  get: privateProcedure.input(z.object({ id: z.string() })).query(async () =>
    makeThreadResponse({ messages: [], labels: [], hasUnread: false })
  )
});
```

- [ ] **Step 3: Replace route shell in appRouter**

Modify `apps/server-pilot/src/trpc/index.ts` so `mail: mailRouter` imports from `./routes/mail` instead of `emptyRouter`.

- [ ] **Step 4: Implement DB query bodies**

Replace `listThreads` and `get` empty bodies with Drizzle queries:

```typescript
// listThreads:
// SELECT id, NULL as historyId, latest_message_at cursor fields
// FROM mail_thread
// WHERE transport_id = active transport
//   AND folder/label filters match shared labels
//   AND latest_message_at < cursor when cursor exists
// ORDER BY latest_message_at DESC
// LIMIT maxResults + 1

// get:
// SELECT thread by id
// SELECT messages WHERE thread_id = id ORDER BY coalesce(received_at, sent_at)
// SELECT attachments WHERE message_id IN (...)
// map each row through toParsedMessage
// return makeThreadResponse(...)
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/mail-read-path.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/trpc/index.ts apps/server-pilot/tests/mail-read-path.test.ts
git commit -m "feat: add db-backed mail read paths"
```

---

### Task 11: Mail Mutations, Labels, Connections, Drafts, Notes, Templates

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/connections.ts`
- Create: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Create: `apps/server-pilot/src/trpc/routes/notes.ts`
- Create: `apps/server-pilot/src/trpc/routes/templates.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/trpc/routes/compat.ts`
- Modify: `apps/server-pilot/src/trpc/index.ts`
- Create: `apps/server-pilot/tests/core-trpc-routes.test.ts`

**Interfaces:**
- Produces: real shared-state mail mutations.
- Produces: real connection shim shape.
- Produces: real local drafts, notes, templates, labels.

- [ ] **Step 1: Write shared label helper test**

Create `apps/server-pilot/tests/core-trpc-routes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { applyLabelMutation } from '../src/trpc/routes/mail';
import { toConnectionShape } from '../src/trpc/routes/connections';

describe('core trpc helpers', () => {
  it('removes UNREAD when marking read', () => {
    expect(applyLabelMutation(['INBOX', 'UNREAD'], [], ['UNREAD'])).toEqual(['INBOX']);
  });

  it('archives by replacing INBOX with ARCHIVE', () => {
    expect(applyLabelMutation(['INBOX'], ['ARCHIVE'], ['INBOX'])).toEqual(['ARCHIVE']);
  });

  it('returns frontend connection shape', () => {
    expect(toConnectionShape({
      id: 'staff-01',
      email: 'agent01@legacy.local',
      name: 'Agent 01',
      createdAt: new Date('2026-06-30T12:00:00Z')
    })).toEqual({
      id: 'staff-01',
      email: 'agent01@legacy.local',
      name: 'Agent 01',
      picture: null,
      providerId: 'pop3_smtp',
      createdAt: new Date('2026-06-30T12:00:00Z')
    });
  });
});
```

- [ ] **Step 2: Add mail mutation helper**

Add to `apps/server-pilot/src/trpc/routes/mail.ts`:

```typescript
export function applyLabelMutation(labels: string[], add: string[], remove: string[]) {
  const next = new Set(labels);
  for (const label of remove) next.delete(label);
  for (const label of add) next.add(label);
  return Array.from(next).sort();
}
```

Implement these procedures against `mailThread`:

```typescript
markAsRead -> remove UNREAD, set isUnread false
markAsUnread -> add UNREAD, set isUnread true
toggleStar -> flip isStarred and STARRED label
toggleImportant -> flip isImportant and IMPORTANT label
modifyLabels -> apply addLabels/removeLabels to shared labels
delete -> add TRASH, remove INBOX
bulkDelete -> same for many ids
bulkArchive -> add ARCHIVE, remove INBOX
snoozeThreads -> add SNOOZED, remove INBOX, upsert mailSnooze
unsnoozeThreads -> add INBOX, remove SNOOZED, delete mailSnooze
```

- [ ] **Step 3: Add connections router**

Create `apps/server-pilot/src/trpc/routes/connections.ts`:

```typescript
import { z } from 'zod';
import { privateProcedure, publicProcedure, router } from '../context';

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
    providerId: 'pop3_smtp',
    createdAt: row.createdAt
  };
}

export const connectionsRouter = router({
  list: privateProcedure.query(async () => ({ connections: [], disconnectedIds: [] })),
  setDefault: privateProcedure.input(z.object({ connectionId: z.string() })).mutation(() => undefined),
  delete: privateProcedure.input(z.object({ connectionId: z.string() })).mutation(() => undefined),
  getDefault: publicProcedure.query(async ({ ctx }) =>
    toConnectionShape({
      id: ctx.staffMemberId,
      email: 'nava@legacy.local',
      name: 'Nava',
      createdAt: new Date(0)
    })
  )
});
```

- [ ] **Step 4: Add local CRUD route files**

Create route files for `drafts`, `notes`, and `templates` using the exact procedure names from the compatibility surface:

```typescript
// drafts: create, get, list, delete
// notes: list, create, update, delete, reorder
// templates: list, create, delete
```

Each procedure reads/writes its matching Postgres table and returns the same shape the current frontend consumes.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/core-trpc-routes.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/trpc/routes apps/server-pilot/src/trpc/index.ts apps/server-pilot/tests/core-trpc-routes.test.ts
git commit -m "feat: add core trpc mutations"
```

---

### Task 12: SMTP Send and Browser Undo Contract

**Files:**
- Create: `apps/server-pilot/src/lib/smtp/sender.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/mail/hooks/use-undo-send.ts`
- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/components/mail/reply-composer.tsx`
- Create: `apps/server-pilot/tests/smtp-send.test.ts`

**Interfaces:**
- Produces: `sendSmtp(input): Promise<{ messageId: string }>`
- Produces: `mail.send` returning immediate `{ success: true, messageId }` after SMTP send.
- Produces: `mail.unsend` safe no-op returning `{ success: false, error: 'Send already delivered' }` because browser delay prevents server-side queued send.

- [ ] **Step 1: Write SMTP send test**

Create `apps/server-pilot/tests/smtp-send.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeSmtpSender } from '../src/lib/smtp/sender';

describe('smtp sender', () => {
  it('passes through the SMTP message id', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<smtp-1>' });
    const sender = makeSmtpSender({ sendMail });
    await expect(sender.sendSmtp({
      from: 'nava@legacy.local',
      to: ['guest@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello'
    })).resolves.toEqual({ messageId: '<smtp-1>' });
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

export function makeSmtpSender(deps: {
  sendMail: (input: SendSmtpInput) => Promise<{ messageId?: string }>;
}) {
  return {
    async sendSmtp(input: SendSmtpInput) {
      const result = await deps.sendMail(input);
      return { messageId: result.messageId ?? '' };
    }
  };
}

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS
  }
});

export const smtpSender = makeSmtpSender({
  sendMail: (input) => transport.sendMail(input)
});
```

- [ ] **Step 3: Implement `mail.send`**

In `apps/server-pilot/src/trpc/routes/mail.ts`, implement:

```typescript
send input -> compute thread root -> send SMTP -> insert outbound message -> update thread latest -> return { success: true, messageId }
unsend -> return { success: false, error: 'Send already delivered' }
```

- [ ] **Step 4: Update frontend undo**

Change browser undo flow:

```typescript
export const UNDO_SEND_DELAY_MS = 15_000;

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

Update `create-email.tsx` and `reply-composer.tsx` so they wait before calling `trpc.mail.send`. Keep `mail.unsend` present for type compatibility, but the UI should cancel the `AbortController`, not call the server.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/smtp-send.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/lib/smtp/sender.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/smtp-send.test.ts apps/mail/hooks/use-undo-send.ts apps/mail/components/create/create-email.tsx apps/mail/components/mail/reply-composer.tsx
git commit -m "feat: add smtp send and browser undo"
```

---

### Task 13: Worker Loop, Snooze Cron, and CloudWatch Metrics

**Files:**
- Create: `apps/server-pilot/src/workers/worker.ts`
- Create: `apps/server-pilot/src/lib/metrics.ts`
- Create: `apps/server-pilot/tests/snooze-cron.test.ts`
- Create: `apps/server-pilot/tests/ingest-health.test.ts`

**Interfaces:**
- Produces: one PM2 worker with POP3 poll interval and snooze cron interval.
- Produces: `wakeDueSnoozes(now)` query.
- Produces: CloudWatch metrics for `IngestCycleMs`, `UidlBacklog`, `LastSuccessfulPollAgeSeconds`.

- [ ] **Step 1: Write health tests**

Create `apps/server-pilot/tests/ingest-health.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { shouldAlertOnIngestHealth } from '../src/workers/worker';

describe('ingest health', () => {
  it('alerts on stale successful poll', () => {
    expect(shouldAlertOnIngestHealth({
      now: new Date('2026-06-30T12:15:01Z'),
      lastSuccessfulPollAt: new Date('2026-06-30T12:00:00Z'),
      backlogSamples: [0, 0, 0]
    })).toEqual({ alert: true, reason: 'last_successful_poll_stale' });
  });

  it('alerts on growing backlog', () => {
    expect(shouldAlertOnIngestHealth({
      now: new Date('2026-06-30T12:00:00Z'),
      lastSuccessfulPollAt: new Date('2026-06-30T11:59:50Z'),
      backlogSamples: [10, 25, 40]
    })).toEqual({ alert: true, reason: 'uidl_backlog_growing' });
  });
});
```

- [ ] **Step 2: Implement worker health and loop**

Create `apps/server-pilot/src/workers/worker.ts`:

```typescript
import { env } from '../env';
import { connectPop3 } from '../lib/pop3/client';
import { ingestOnce } from '../lib/pop3/poller';
import { emitIngestMetrics } from '../lib/metrics';

export function shouldAlertOnIngestHealth(input: {
  now: Date;
  lastSuccessfulPollAt: Date | null;
  backlogSamples: number[];
}) {
  if (!input.lastSuccessfulPollAt || input.now.getTime() - input.lastSuccessfulPollAt.getTime() > 15 * 60 * 1000) {
    return { alert: true, reason: 'last_successful_poll_stale' as const };
  }
  const [a, b, c] = input.backlogSamples.slice(-3);
  if (a !== undefined && b !== undefined && c !== undefined && a < b && b < c) {
    return { alert: true, reason: 'uidl_backlog_growing' as const };
  }
  return { alert: false };
}

async function pollPop3() {
  const pop3 = await connectPop3();
  const result = await ingestOnce('nava-pop3-smtp', {
    now: () => new Date(),
    maxMessagesPerCycle: env.POP3_MAX_MESSAGES_PER_CYCLE,
    pop3,
    store: await createProductionIngestStore()
  });
  await emitIngestMetrics(result);
}

async function wakeDueSnoozes() {
  // SELECT mail_snooze WHERE wake_at <= now(); update shared thread labels; delete wake rows.
}

setInterval(() => {
  pollPop3().catch((error) => console.error('[worker] POP3 poll failed', error));
}, env.POP3_POLL_INTERVAL_MS);

setInterval(() => {
  wakeDueSnoozes().catch((error) => console.error('[worker] snooze wake failed', error));
}, 60_000);

console.log('server-pilot worker started');
```

- [ ] **Step 3: Add CloudWatch metrics**

Create `apps/server-pilot/src/lib/metrics.ts`:

```typescript
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { env } from '../env';
import type { IngestResult } from './pop3/poller';

const client = new CloudWatchClient({ region: env.AWS_REGION });

export async function emitIngestMetrics(result: IngestResult) {
  await client.send(new PutMetricDataCommand({
    Namespace: 'Zero/ServerPilot',
    MetricData: [
      { MetricName: 'IngestCycleMs', Value: result.cycleMs, Unit: 'Milliseconds' },
      { MetricName: 'UidlBacklog', Value: result.uidlBacklog, Unit: 'Count' },
      { MetricName: 'Ingested', Value: result.ingested, Unit: 'Count' },
      { MetricName: 'Purged', Value: result.purged, Unit: 'Count' }
    ]
  }));
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm --filter @zero/server test tests/ingest-health.test.ts tests/snooze-cron.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/server-pilot/src/workers/worker.ts apps/server-pilot/src/lib/metrics.ts apps/server-pilot/tests/ingest-health.test.ts apps/server-pilot/tests/snooze-cron.test.ts
git commit -m "feat: add production worker loop"
```

---

### Task 14: Frontend Wiring and Build Proof

**Files:**
- Modify: `apps/mail/lib/demo/runtime.ts`
- Modify: `apps/mail/providers/query-provider.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/vite.config.ts`
- Create: `apps/mail/tests/production-backend-wiring.test.ts`

**Interfaces:**
- Demo mode defaults off.
- Mail list and open thread refetch every 30 seconds.
- `apps/mail` typechecks against `apps/server-pilot`.

- [ ] **Step 1: Write demo flag test**

Create `apps/mail/tests/production-backend-wiring.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isFrontendOnlyDemoForced } from '../lib/demo/runtime';

describe('production backend wiring', () => {
  it('does not force frontend-only demo by default', () => {
    expect(isFrontendOnlyDemoForced({})).toBe(false);
  });

  it('allows explicit demo mode', () => {
    expect(isFrontendOnlyDemoForced({ VITE_FORCE_FRONTEND_ONLY_DEMO: 'true' })).toBe(true);
  });
});
```

- [ ] **Step 2: Env-gate demo runtime**

Modify `apps/mail/lib/demo/runtime.ts`:

```typescript
export function isFrontendOnlyDemoForced(env: Record<string, string | undefined> = import.meta.env) {
  return env.VITE_FORCE_FRONTEND_ONLY_DEMO === 'true';
}

export const FORCE_FRONTEND_ONLY_DEMO = isFrontendOnlyDemoForced();
```

- [ ] **Step 3: Enable refetch**

In `apps/mail/providers/query-provider.tsx`, set:

```typescript
refetchOnWindowFocus: true
```

In `apps/mail/hooks/use-threads.ts`, set list and open-thread queries to:

```typescript
staleTime: 30 * 1000,
refetchInterval: 30 * 1000,
refetchIntervalInBackground: true
```

- [ ] **Step 4: Alias server-pilot subpaths**

Modify `apps/mail/vite.config.ts`:

```typescript
resolve: {
  alias: {
    '@zero/server/trpc': path.resolve(__dirname, '../server-pilot/src/trpc.ts'),
    '@zero/server/auth': path.resolve(__dirname, '../server-pilot/src/auth.ts'),
    '@zero/server/schemas': path.resolve(__dirname, '../server-pilot/src/schemas.ts'),
    '@zero/server/auth-providers': path.resolve(__dirname, '../server-pilot/src/auth-providers.ts')
  }
}
```

Preserve existing aliases in the same object.

- [ ] **Step 5: Build proof**

Run:

```bash
pnpm --filter @zero/server build
pnpm --filter @zero/mail test tests/production-backend-wiring.test.ts
pnpm --filter @zero/mail build
```

Expected: both packages build and the test passes.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/demo/runtime.ts apps/mail/providers/query-provider.tsx apps/mail/hooks/use-threads.ts apps/mail/vite.config.ts apps/mail/tests/production-backend-wiring.test.ts
git commit -m "feat: wire frontend to production backend"
```

---

### Task 15: EC2 Deploy, Runbook, and Acceptance Gates

**Files:**
- Create: `apps/server-pilot/ecosystem.config.cjs`
- Create: `apps/server-pilot/deploy/nginx.conf`
- Create: `apps/server-pilot/deploy/.env.example`
- Create: `apps/server-pilot/deploy/runbook.md`
- Create: `apps/server-pilot/tests/load/ingest-capacity.test.ts`

**Interfaces:**
- PM2 apps: `server-pilot-http`, `server-pilot-worker`.
- nginx plain reverse proxy.
- Runbook with alarms and acceptance gates.

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
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'server-pilot-worker',
      script: 'dist/workers/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' }
    }
  ]
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
POP3_POLL_INTERVAL_MS=30000
POP3_MAX_MESSAGES_PER_CYCLE=500
SMTP_HOST=smtp.legacy.local
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=nava@legacy.local
SMTP_PASS=change-me
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/legacy-corporate-ca.pem
```

- [ ] **Step 4: Add capacity test**

Create `apps/server-pilot/tests/load/ingest-capacity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

function dailyCapacity(secondsPerMessage: number) {
  return Math.floor((24 * 60 * 60) / secondsPerMessage);
}

describe('ingest capacity budget', () => {
  it('shows one-second messages can clear 15000 per day', () => {
    expect(dailyCapacity(1)).toBeGreaterThan(15000);
  });

  it('shows ten-second PDF-heavy messages block go-live', () => {
    expect(dailyCapacity(10)).toBeLessThan(15000);
  });
});
```

- [ ] **Step 5: Add runbook**

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
- POP3 cycle duration over 5 minutes: inspect attachment size and mail server latency
- RDS CPU over 70% for 15 minutes: bump RDS class
- RDS free storage under 20%: increase GP3 autoscaling maximum
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

- [ ] **Step 6: Final verification**

Run:

```bash
pnpm --filter @zero/server test
pnpm --filter @zero/server build
pnpm --filter @zero/mail build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/ecosystem.config.cjs apps/server-pilot/deploy apps/server-pilot/tests/load/ingest-capacity.test.ts
git commit -m "feat: add ec2 deploy and acceptance gates"
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
- POP3 cycle cap.
- Already-stored UIDLs still get `DELE` so replayed messages drain after a crash before `QUIT`.
- `(transport_id, pop3_uidl)` partial unique index.
- S3 keys based on DB ids, not Message-ID headers.
- `pop3_purged_at` audit.
- Full `@zero/server/*` subpath export surface.
- Full `AppRouter` procedure surface.
- RDS/S3 backup, lifecycle, and alarm setup.

## Self-Review

Spec coverage:

- Production-not-pilot target: covered by Global Constraints, Capacity Budget, Tasks 8 and 15.
- 50 users and 15,000 emails/day: covered by Capacity Budget and acceptance tests.
- Claude REJECT blockers: covered by Tasks 2, 6, 7, 8, 9, 10, 11, 12, 13, 14.
- Ponytail cuts: retained in Removed From Earlier Plan.
- POP3 download-and-delete: covered by Tasks 6, 7, 8.
- 7-day retention: covered by Global Constraints and runbook alarms.
- Generic on-prem POP3/SMTP: covered by env, node-pop3 adapter, SMTP task, runbook.
- FE-demo-minimal branch: covered by Task 1 and Task 14.

Plan hygiene scan:

- No banned planning tokens remain in implementation steps.
- Deferred product features keep safe procedure stubs and add-back triggers.

Type consistency:

- `message`, `mailThread`, `mailboxTransport`, `staffMember`, and `mailLabel` names match across schema and route tasks.
- `ingestOnce`, `Pop3Session`, `IngestStore`, and `IngestResult` are defined before worker usage.
- `toParsedMessage` emits the real `ParsedMessage` fields used by `apps/mail/types/index.ts`.

## GSTACK REVIEW REPORT

Claude Opus max-effort review rejected v1 because it specified the right cuts but left runtime paths as scaffolds.

Closed in v2:

- POP3 client adapter added as Task 6.
- Ingest store transaction added as Task 7.
- Batch-capped poller added as Task 8.
- Real frontend module and router contract added as Task 2.
- Full `ParsedMessage` shape added as Task 9.
- DB-backed mail read paths added as Task 10.
- Core tRPC mutations and local CRUD routes added as Task 11.
- SMTP send and browser undo contract added as Task 12.
- Worker loop, snooze cron, and metrics added as Task 13.
- FE build proof added as Task 14.
- EC2 runbook and acceptance gates added as Task 15.

Verdict for this v2: APPROVE_WITH_CHANGES pending implementation-time proof from `pnpm --filter @zero/server test`, `pnpm --filter @zero/server build`, and `pnpm --filter @zero/mail build`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-ec2-production-backend-implementation-plan-v2.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
