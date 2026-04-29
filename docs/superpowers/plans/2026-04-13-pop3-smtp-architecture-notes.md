# POP3/SMTP Integration Notes - Current Integration Architecture (April 13, 2026)

## Scope of this note

This note is an architecture brain-dump of current email integration support (Gmail + Outlook) to support designing a POP3/SMTP path.

---

## 1) Current integration pattern (what exists now)

### 1.1 Provider identity and dispatch

- Provider IDs are centralized in `apps/server/src/types.ts`:
  - `EProviders.google`
  - `EProviders.microsoft`
- Driver selection happens in `apps/server/src/lib/driver/index.ts` through `createDriver(provider, config)`.
- Provider-specific driver implementations live under `apps/server/src/lib/driver/`.
  - `google.ts` → `GoogleMailManager`
  - `microsoft.ts` → `OutlookMailManager`

### 1.2 Provider abstraction

- Mail operations are defined via `MailManager` in `apps/server/src/lib/driver/types.ts`.
- Interface includes, among others:
  - `list`, `get`, `create`, `modifyLabels`, `createDraft`, `delete`, `sendEmail`, folder/list/search helpers
  - Attachment and raw message retrieval
  - Label/folder operations
- Existing drivers implement many but not all features consistently:
  - `GoogleMailManager` is more complete and aligned with Gmail.
  - `OutlookMailManager` contains partial coverage with TODOs/warnings in subscription and search/label edge cases.

### 1.3 Connection lifecycle and persistence

- OAuth connections are stored in `apps/server/src/db/schema.ts` (`connection` table) with:
  - `userId`, `email`, `providerId`, `accessToken`, `refreshToken`, `scope`, `expiresAt`, provider metadata
- `providerId` is currently limited to Gmail/Microsoft union in schema typing.
- Auth flow/hook is managed in `apps/server/src/lib/auth.ts`:
  - `connectionHandlerHook` creates/updates `connection` row after successful OAuth
- `apps/server/src/lib/server-utils.ts` has:
  - `getActiveConnection`
  - `connectionToDriver(connection, env)` using `createDriver`

### 1.4 Subscription / real-time update wiring

- Shared abstraction:
  - `apps/server/src/lib/factories/base-subscription.factory.ts` defines:
    - `subscribe()`
    - `unsubscribe()`
    - `verifyToken()`
    - shared DB helpers and label bootstrap behavior
- Provider-specific subscription implementations:
  - `google-subscription.factory.ts`: active Pub/Sub integration with Gmail watch/renewal
  - `outlook-subscription.factory.ts`: throws `"Outlook subscription not implemented yet"` for key actions
- Registry:
  - `subscription-factory.registry.ts` maps provider → factory
  - currently only Google factory is effectively usable

### 1.5 Notification + queue orchestration

- `apps/server/src/main.ts` has endpoint: `/a8n/notify/:providerId`
  - handles inbound external callbacks
  - enqueues to `thread_queue`
- Scheduled renewal logic for subscriptions exists and is mostly Gmail-oriented (`gmail_sub_age` state and expiration checks).
- `send_email_queue` is wired for send workflows (see routes/queue usage).

### 1.6 Orchestration in Durable Objects

- DOs:
  - `ZeroDB`, `ShardRegistry`, `ZeroDriver`, `ZeroAgent`, `WorkflowRunner`, `ThreadSyncWorker` in routing files
- `apps/server/src/routes/agent/index.ts`:
  - `ZeroDriver`: data persistence + workflow fan-out helpers
  - `ZeroAgent`: chat/assistant behaviors
- `apps/server/src/pipelines.ts`:
  - `WorkflowRunner` main dispatch for provider workflows
  - current provider branching is Google-first; non-Google routes often return unsupported

### 1.7 Frontend provider entry points

- Provider list used by add-connection UI is `apps/mail/lib/constants.tsx`.
  - Gmail is enabled.
  - Outlook currently commented out.
- Add flow in `apps/mail/components/connection/add.tsx` iterates providers and starts social link flow.
- Connection list/manage flows in `apps/mail/components/connection/*` and TRPC `connections.ts` router.

---

## 2) Dataflow summary (current)

1. User authenticates through social provider (currently Google OAuth in practice).
2. Auth hook writes/updates connection row in DB.
3. `connectionToDriver` turns stored credentials into `MailManager`.
4. Sync scheduling/workflow reads DB connection + provider + user.
5. Driver fetches/listens using provider API.
6. Notifications from provider hit `/a8n/notify/:providerId` and enqueue work.
7. `WorkflowRunner`/`ThreadSyncWorker` persists messages/threads into Zero state.
8. Frontend reads processed thread/label/user data through TRPC/agent endpoints.

---

## 3) Where POP3/SMTP does not fit cleanly

- OAuth-specific assumptions are embedded in:
  - `EProviders` / schema typing
  - Auth provider configs
  - token lifecycle in existing connection rows (`refreshToken`, `scope`, `expiresAt`)
  - subscription model (push/webhook first-class)
- POP3 is pull-oriented (typically polling), not webhook-native.
- SMTP send is usually direct transport (username/password or service-specific auth tokens) with different auth/credential semantics.
- “One shared POP3 server, many users” is model mismatch with current per-connection/user-account coupling.

---

## 4) Key integration boundary decisions for future design

- Keep core `MailManager` as the interface, but add new concrete impl that maps provider-agnostic operations to POP3/SMTP primitives.
- Abstract connection credentials as provider-kind payload, not Gmail/Outlook token assumptions.
- Introduce server-backed connector service for POP3 polling and SMTP send if direct Node/worker POP3 libs are not ideal in Workers runtime.
- Add a new provider metadata strategy:
  - provider kind
  - host/port/security
  - per-user identity mapping on top of shared POP3 ingress
- Decide between:
  - “POP3/SMTP as pseudo-provider” in existing enums, or
  - “connector provider” separated from OAuth social providers.

---

## 5) Immediate observations for the plan

- Lowest-risk path will likely:
  1. Preserve DO + workflow architecture.
  2. Add a non-OAuth credential pathway (manual connection config).
  3. Add POP3 poller as out-of-band service or internal scheduler.
  4. Route inbound email into same storage + normalize pipeline.
  5. Add SMTP send adapter that writes into current send flow/queue with provider checks.

- Biggest refactor hotspots:
  - `EProviders` + schema typings + DB columns for auth payload
  - `createDriver` + driver factories + subscription registry dispatch
  - `WorkflowRunner` provider branching
  - Auth provider config and TRPC connection validation assumptions
  - Connection UI cards/buttons and backend credential input forms

---

## 6) Files most likely involved (inventory only)

- `apps/server/src/types.ts`
- `apps/server/src/db/schema.ts`
- `apps/server/src/lib/driver/index.ts`
- `apps/server/src/lib/driver/types.ts`
- `apps/server/src/lib/driver/google.ts`
- `apps/server/src/lib/driver/microsoft.ts`
- `apps/server/src/lib/factories/base-subscription.factory.ts`
- `apps/server/src/lib/factories/google-subscription.factory.ts`
- `apps/server/src/lib/factories/outlook-subscription.factory.ts`
- `apps/server/src/lib/factories/subscription-factory.registry.ts`
- `apps/server/src/lib/server-utils.ts`
- `apps/server/src/lib/auth.ts`
- `apps/server/src/main.ts`
- `apps/server/src/pipelines.ts`
- `apps/server/src/routes/agent/index.ts`
- `apps/server/src/routes/agent/sync-worker.ts`
- `apps/server/src/trpc/routes/connections.ts`
- `apps/mail/lib/constants.tsx`
- `apps/mail/components/connection/add.tsx`

---

## 7) Note about implementation source of truth

- This file is the working architecture baseline.
- Next step should be phased by subsystem:
  - Data model/auth
  - Driver + connector adapter
  - Subscription/event model
  - Sync + queue/workflow paths
  - Frontend flow and operations UI

