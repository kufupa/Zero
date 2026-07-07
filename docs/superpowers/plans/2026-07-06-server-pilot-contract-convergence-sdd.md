# Server Pilot Contract Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `apps/mail` with `apps/server-pilot` so the live pilot has real contracts for mail threads, lifecycle-aware drafts, AI draft evaluation provenance, hotel categories, folder actions, search filters, and intentionally disabled legacy surfaces.

**Architecture:** Treat `apps/server-pilot` as the source of truth for live mail. Keep `message` rows for real sent/received email only, keep `mail_draft` as the current user-visible draft/candidate object, and add append-only draft revision plus AI generation records for eval provenance. Add mailbox-scoped category tables and tRPC routes, expose structured filters instead of Gmail grammar, and make the frontend consume capability flags instead of assuming legacy routes exist. Each task below is independently reviewable and should end in a commit.

**Tech Stack:** TypeScript, React 19, React Router 7, TanStack Query, tRPC v11, Zod, Hono, Drizzle ORM, PostgreSQL, Vitest, pnpm, Turbo.

## Global Constraints

- Work on the existing branch and preserve unrelated user changes.
- Do not edit legacy `apps/server/` behavior except removing live imports from `apps/mail`.
- Local dev scripts must start `apps/server-pilot` only; do not keep a legacy backend switch on this branch.
- Keep system folders separate from hotel categories and user labels.
- Hotel categories are configurable, mailbox-scoped, and multi-select.
- Drafts remain rows in `mail_draft`; do not insert draft pseudo-messages into `message`.
- `message` means immutable real email only: inbound mail or outbound mail after send.
- `mail_draft.replyToMessageId` is the parent message for reply context and stale checks.
- A thread can have multiple draft rows over time. Sent drafts remain `mail_draft.status='sent'`; later inbound replies create new active drafts linked to the newer `replyToMessageId`.
- At any one time, the pilot UI treats the newest `mail_draft.status='active'` draft as the editable draft for the thread. It may have `origin='manual'` or `origin='ai'` after AI candidate promotion; older sent drafts are history, not active UI state.
- Draft persistence must survive refresh, remount, thread switch, and route reopen for partial drafts, not only completed drafts with recipients and subjects.
- Existing unsent drafts may already contain more than one draft per thread. Before creating the partial unique active-draft index, migration must keep the newest unsent draft active and mark older same-thread active drafts `discarded`.
- Do not add `mail_draft.baseMessageIds`, `mail_draft.baseThreadLatestMessageAt`, or `mail_draft.staleConfirmedAt`.
- AI context message IDs belong on `ai_draft_generation.contextMessageIds`, not on `mail_draft`.
- LangSmith integration is out of scope for this pass: no LangSmith dependency, SDK calls, API calls, dataset sync, experiment sync, or `langsmith_*` columns.
- App DB stores only app-owned draft/eval provenance: context message IDs, model, prompt version/hash, draft revisions, and final sent message link.
- Future LangSmith tracing should attach `draftId`, `generationId`, `threadId`, `replyToMessageId`, `promptVersion`, and `promptHash` as trace metadata instead of changing this schema.
- Stale draft policy is warn-on-send with explicit confirmation.
- AI candidate drafts promote in-place when the editor opens and no active draft exists for the same thread. Promotion preserves `origin='ai'` and `generationId`, changes `status` from `candidate` to `active`, and records `mail_draft_revision.kind='promoted'`.
- AI promotion requires a non-null `replyToMessageId` whose message belongs to the same thread and mailbox. Do not promote null-parent candidates in this pass.
- Existing active drafts always win over AI candidates. Do not auto-replace, merge, or overwrite human draft state.
- If multiple AI candidates exist for one `replyToMessageId`, promote the newest candidate for that parent message and mark older sibling candidates `status='discarded'`.
- `drafts.delete` is lifecycle discard for active/candidate drafts, not physical deletion. Physical draft row deletion is reserved for test cleanup or future retention jobs.
- Store system folder state on `mail_thread` fields. Archive uses `isArchived`, trash uses `trashedAt`, spam uses `spamAt`; do not implement pilot folder moves by adding/removing Gmail-style labels.
- AI, brain, notes, templates, and BIMI are pilot-inert in this pass.
- Search supports plain subject/snippet text plus structured filters only.
- Every task runs targeted tests before commit.
- Do not commit `.tmp-research/`, `.claude/`, `.cursor/skills/`, package reports, Playwright reports, or local Cursor config unless a task explicitly names those files.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, migrate, seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2, AWS MCP/CLI inspection for EC2/RDS/S3/SSM state.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL -> reproduce -> root cause (file:line) -> fix -> test -> commit -> resume. Do not stop at first failure.

Credential/login blocker rule: do not stop. First look for existing repo commands, prior gate scripts, EC2 env, RDS seed data, AWS Secrets/SSM access, and previous run patterns. If a browser credential cannot be minted or recovered autonomously, skip only that credential-bound E2E with a precise reason, record proof in the audit, and continue all other gates.

### Divergence authority

Better path to done criteria -> take it. Log in handoff report.

### Done criteria

- [ ] Shared pilot mail types exported and frontend live imports moved off legacy `apps/server/src/*`.
- [ ] Pilot-inert AI, brain, notes, templates, and BIMI routers wired without exposing live UI controls.
- [ ] Mailbox-scoped configurable hotel categories stored separately from system folders and user labels.
- [ ] Thread listing supports category IDs, label IDs, unread, important, starred, and plain `q` filters.
- [ ] Live Drafts folder uses `drafts.list`, and `mail.get` returns plural `drafts[]` without draft pseudo-messages.
- [ ] Draft autosave creates server draft IDs early, saves partial body/subject/recipient state, and reloads without losing local edits.
- [ ] Stale draft sends return `STALE_DRAFT` conflict unless caller confirms.
- [ ] AI draft candidates are stored as `mail_draft.status='candidate'`, linked to `ai_draft_generation`, and promote in-place through `drafts.ensureEditableForReply` to editable `status='active'` drafts.
- [ ] Existing active drafts always win over AI candidates; newest candidate for the same `replyToMessageId` promotes only when no active draft exists, and older sibling candidates become `status='discarded'`.
- [ ] Initial AI draft, promotion moment, human edits, and final sent state are available through `mail_draft_revision` and final outbound `message`.
- [ ] LangSmith/LangGraph remain out of execution scope; future eval/tracing linkage uses app IDs as trace metadata, not `langsmith_*` columns.
- [ ] Folder moves use backend state mutation, not Gmail label emulation.
- [ ] Existing shape drift fixed for `verifyEmail`, `suggestRecipients`, and attachments.
- [ ] Pilot search UI hides unsupported Gmail grammar and AI-generated search.
- [ ] Local scripts start `apps/server-pilot` only.
- [ ] Targeted backend and frontend suites pass locally and on EC2 where DB/infra-backed tests require it.
- [ ] Full final test layer passes: all repo tests written in this branch, all existing package tests, Mailpit wire E2E, fixture loopback E2E, Playwright E2E, builds, and typechecks. Any red enters autonomous RCA/debug loop until green.
- [ ] Local credential gaps do not block completion. DB/Mailpit/RDS-backed tests run on EC2 through SSM when local machine lacks env/network access.
- [ ] `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md` records resolved and remaining drift.

## Execution Mode

Autonomous overnight - no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## Autonomous Wave Plan

Goal: keep 100% scope, but execute in dependency waves so an unattended SDD run can recover cleanly after failures.

Wave 0 - Preflight and branch hygiene:
- Read this whole plan, current `git status`, and current schema/router/frontend files before editing.
- Confirm no task will stage unrelated `.tmp-research/`, `.claude/`, `.cursor/skills/`, reports, or local Cursor config.
- Run the first targeted failing tests for the wave before implementation when the task asks for TDD.

Wave 1 - Backend contract surface:
- Tasks: 1, 2.
- Dependency: none.
- Gate: `pnpm --filter=@zero/server test -- package-contract misc-wire-contract`.
- Output: live pilot types exported; inert routers available so frontend imports can move off legacy server.

Wave 2 - Backend categories and list filters:
- Tasks: 3, 4, 5.
- Dependency: Wave 1.
- Gate: `pnpm --filter=@zero/server test -- schema-contract categories-contract mail-category-filter list-pagination`.
- Output: mailbox-scoped categories, category membership, structured list filters, and real category hydration.

Wave 3 - Draft lifecycle, eval provenance, and backend draft contract:
- Tasks: 6, 7.
- Dependency: Wave 1.
- Gate: `pnpm --filter=@zero/server test -- draft-eval-schema-contract schema-contract draft-thread-contract draft-stale-conflict draft-sequential-replies-contract draft-ai-promotion-contract list-pagination`.
- Output: draft lifecycle schema, migration de-dupe before unique index, plural `drafts[]`, real `hasDraft` / `draftCount`, stale-send conflict, non-null-parent AI promotion, lifecycle discard.

Wave 4 - Frontend draft UX and pilot capability gates:
- Tasks: 8, 9, 10.
- Dependency: Waves 1 and 3.
- Gate: `pnpm --filter=@zero/mail test -- thread-draft-view-model live-draft-folder draft-persistence stale-draft-send-flow pilot-capabilities`.
- Output: Drafts folder uses `drafts.list`, thread draft section consumes `drafts[]`, refresh-safe autosave/rehydration lands, inert pilot UI is hidden.

Wave 5 - Frontend categories, actions, route drift, search, local scripts:
- Tasks: 11, 12, 13, 14, 15.
- Dependency: Waves 1, 2, 3, and 4.
- Gate:
  - `pnpm --filter=@zero/server test -- mail-thread-actions mail-wire-contract mail-get-attachments labels-contract`
  - `pnpm --filter=@zero/mail test -- search-filter-contract thread-actions-contract pilot-route-surface`
- Output: category navigation/filtering, explicit spam/archive/trash state moves, route shape drift fixes, unsupported search promises hidden, local scripts target `server-pilot`.

Wave 6 - Final proof and audit:
- Task: 16.
- Dependency: Waves 1-5.
- Gate: run every test file named in Tasks 1-15, then server build and mail typecheck.
- Output: drift audit updated with resolved/remaining items and exact verification evidence.

Wave 7 - Full repo and E2E proof:
- Task: 17.
- Dependency: Wave 6.
- Place: run local-only checks locally first; run DB/RDS/Mailpit/EC2 gates on EC2 via SSM when local machine lacks credentials or network access.
- Gate:
  - `pnpm --filter=@zero/server test`
  - `pnpm --filter=@zero/mail test`
  - `pnpm --filter=@zero/server build`
  - `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`
  - `pnpm --filter=@zero/mail build`
  - EC2 fixture loopback gate: `bash apps/server-pilot/deploy/fixture-loopback-gate.sh`
  - EC2 Mailpit wire gate: `bash apps/server-pilot/deploy/wire-gate.sh`
  - Playwright E2E: `pnpm --filter=@zero/testing test:e2e`
- Output: final audit records full-suite pass/fail evidence, skipped-test reasons, and every fix made during RCA.
- Existing code first: reuse package scripts, `fixture-loopback-gate.sh`, `wire-gate.sh`, and `packages/testing/playwright.config.ts`. If a test file already exists, assume it has an existing command/path and search repo docs/scripts/history before rewriting it. Do not write new runners unless an existing runner is broken.

Recovery rule:
- If any wave goes red: reproduce -> root cause with file:line -> patch -> rerun that wave gate -> commit -> resume from failed wave.
- If a task discovers current code already implemented part of the plan, preserve the task interface, adapt to current code, and note divergence in the final audit.
- For Wave 7 reds: the orchestrator may switch to Cursor Debug Mode autonomously and use `/95-exa-subag` for docs/code/log research. Do not stop for user input. Choose the smallest root-cause fix and continue. If a credential/manual-login path cannot be recovered or minted autonomously, skip only that credential-bound test, record the exact proof/reason, and keep running the rest.

---

## File Structure

### Backend Contract and Types

- `apps/server-pilot/src/lib/driver/types.ts` becomes the exported live pilot mail contract used by `apps/mail`.
- `apps/server-pilot/src/trpc/wire-compat.ts` owns conversion between DB rows and frontend wire shapes.
- `apps/server-pilot/src/trpc/types.ts` continues to derive tRPC `Inputs` and `Outputs`.
- `apps/server-pilot/tests/package-contract.test.ts` verifies exported package paths and live type names exist.

### Inert Legacy Boundary

- `apps/server-pilot/src/trpc/routes/ai.ts` returns disabled compose/search responses.
- `apps/server-pilot/src/trpc/routes/brain.ts` returns null/empty prompt state.
- `apps/server-pilot/src/trpc/routes/notes.ts` returns empty notes and rejects mutations with `PRECONDITION_FAILED`.
- `apps/server-pilot/src/trpc/routes/templates.ts` returns empty templates and rejects mutations with `PRECONDITION_FAILED`.
- `apps/server-pilot/src/trpc/routes/bimi.ts` returns `null` for BIMI lookups.
- `apps/server-pilot/src/trpc/router.ts` wires those inert routers.
- `apps/mail/lib/pilot/capabilities.ts` is a small frontend capability source for hiding legacy UI.

### Categories

- `apps/server-pilot/src/db/schema/mail.ts` adds `mailCategory` and `mailThreadCategory`.
- `apps/server-pilot/drizzle/0005_mail_categories.sql` creates category tables and indexes.
- `apps/server-pilot/src/trpc/routes/categories.ts` lists, creates, updates, deletes, and assigns categories.
- `apps/server-pilot/tests/categories-contract.test.ts` covers scoping and multi-select membership.
- `apps/server-pilot/tests/mail-category-filter.test.ts` covers thread list filtering by categories.

### Drafts and Stale Drafts

- `apps/server-pilot/src/db/schema/mail.ts` adds draft lifecycle enums, `replyToMessageId`, `generationId`, `aiDraftGeneration`, and `mailDraftRevision`.
- `apps/server-pilot/drizzle/0006_draft_lifecycle_eval.sql` migrates draft lifecycle and eval provenance.
- `apps/server-pilot/src/trpc/routes/draft-wire.ts` maps draft rows to the shared `ParsedDraft` wire shape.
- `apps/server-pilot/src/trpc/routes/drafts.ts` lists visible active/candidate drafts by optional `threadId`, creates active manual drafts, promotes AI candidates through `ensureEditableForReply`, updates partial drafts, coalesces meaningful edit revisions, and lifecycle-discards drafts.
- `apps/server-pilot/src/trpc/routes/mail.ts` returns plural active/candidate `drafts[]` from `mail.get`, hydrates list-level `hasDraft` / `draftCount`, marks sent drafts as history, and rejects stale sends when a newer inbound message exists after the draft parent message.
- `apps/server-pilot/tests/draft-thread-contract.test.ts` covers `mail.get` draft metadata.
- `apps/server-pilot/tests/draft-eval-schema-contract.test.ts` covers generation and revision schema.
- `apps/server-pilot/tests/draft-stale-conflict.test.ts` covers stale send conflict and override.
- `apps/server-pilot/tests/draft-sequential-replies-contract.test.ts` covers one sent draft plus a later active draft in the same thread.
- `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts` covers active-draft precedence, non-null reply parent enforcement, newest-candidate promotion, sibling discard, promotion races, and promoted revision writes.

### System Folder State

- `apps/server-pilot/src/db/schema/mail.ts` adds `mailThread.spamAt`.
- `apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql` backfills `spam_at` from existing `SPAM` label state and indexes spam folder lookups.
- `apps/server-pilot/src/trpc/routes/mail.ts` uses `spamAt`, `isArchived`, and `trashedAt` for folder state mutations and list filters.
- `apps/server-pilot/src/mail/ingest/store.ts` marks fallback direct-to spam with `spamAt` instead of relying only on a `SPAM` label.
- `apps/server-pilot/tests/mail-thread-actions.test.ts` covers spam/inbox state moves without label emulation.

### Frontend Mail Wiring

- `apps/mail/hooks/use-threads.ts` stops importing legacy driver types, uses live draft list for Drafts folder, and reads `thread.drafts`.
- `apps/mail/hooks/use-drafts.ts` loads persisted draft rows for refresh/reopen and exposes `ensureEditableDraftForReply`.
- `apps/mail/components/create/email-composer.tsx` owns partial autosave, early server `draftId`, dirty-state protection, and stale-confirm retry.
- `apps/mail/components/create/create-email.tsx` passes `confirmStaleDraft` after explicit stale confirmation.
- `apps/mail/components/mail/reply-composer.tsx` passes `replyToMessageId` into draft autosave and preserves thread affinity when sending reopened reply drafts.
- `apps/mail/components/mail/mail-list.tsx` reopens live Drafts rows with `draftId`, `threadId`, and `replyToMessageId`.
- `apps/mail/lib/mail/thread-draft-view-model.ts` supports one editable active draft, including promoted AI-origin active drafts, plus any remaining read-only AI candidate draft summaries.
- `apps/mail/components/mail/thread-display.tsx` renders the active draft first and renders remaining AI candidate drafts below/collapsed as non-actionable summaries. The editor-open flow in `reply-composer.tsx` calls `ensureEditableDraftForReply`.
- `apps/mail/hooks/use-categories.ts` reads server-pilot categories for live mode.
- `apps/mail/config/navigation.ts` exposes live hotel category folders for `providerId: "mailbox"`.
- `apps/mail/lib/thread-actions.ts` calls dedicated backend state procedures instead of label-based moves.
- Frontend contract tests must import production helpers or components. Do not add tests that only exercise local fixture functions inside the test file.
- `apps/mail/components/context/command-palette-context.tsx` hides unsupported AI/Gmail grammar affordances in pilot mode.
- `apps/mail/tests/*` adds focused tests for live draft folder, thread draft view model, refresh-safe autosave, stale confirmation, category filters, action semantics, and search capability gating.

### Dev Workflow

- `scripts/run-backend-local.mjs` starts `apps/server-pilot` only.
- `scripts/run-frontend-local.mjs` points live frontend at `http://localhost:8788` by default.
- `apps/mail/tests/pilot-route-surface.test.ts` prevents future live imports from missing server-pilot routers.

---

## Task 1: Export Shared Pilot Mail Types

**Files:**
- Modify: `apps/server-pilot/src/lib/driver/types.ts`
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
- Test: `apps/server-pilot/tests/package-contract.test.ts`

**Interfaces:**
- Produces: `ParsedAddress`, `ParsedMessage`, `ParsedDraft`, `ThreadListItem`, `ThreadListResponse`, `ThreadDetailResponse`, `MailCategory`, `MailFilterInput`, `PilotCapabilities`.
- Consumes: existing `ParsedMessageWire` from `apps/server-pilot/src/trpc/wire-compat.ts`.

- [ ] **Step 1: Write failing package contract test**

Append this test to `apps/server-pilot/tests/package-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  MailCategory,
  MailFilterInput,
  ParsedDraft,
  ParsedMessage,
  PilotCapabilities,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadListResponse,
} from '../src/lib/driver/types.js';

describe('driver type package contract', () => {
  it('exports live pilot mail contract types', () => {
    const message = {
      id: 'msg-1',
      title: 'Hello',
      subject: 'Hello',
      tags: [],
      sender: { email: 'guest@example.com' },
      to: [{ email: 'nava@example.com' }],
      cc: null,
      bcc: null,
      tls: true,
      receivedOn: '2026-07-06T10:00:00.000Z',
      unread: true,
      body: 'Body',
      processedHtml: 'Body',
      blobUrl: '',
      threadId: 'thread-1',
      isDraft: false,
    } satisfies ParsedMessage;

    const draft = {
      id: 'draft-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      to: ['guest@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      content: '<p>Reply</p>',
      updatedAt: '2026-07-06T10:01:00.000Z',
      status: 'active',
      origin: 'manual',
      generationId: null,
      isStale: false,
    } satisfies ParsedDraft;

    const category = {
      id: 'cat-travel',
      slug: 'travel-agents',
      name: 'Travel Agents',
      color: '#14b8a6',
      sortOrder: 10,
    } satisfies MailCategory;

    const filters = {
      unread: true,
      important: false,
      starred: false,
      categoryIds: [category.id],
      labelIds: [],
    } satisfies MailFilterInput;

    const listItem = {
      id: 'thread-1',
      subject: 'Hello',
      snippet: 'Body',
      latestMessageAt: '2026-07-06T10:00:00.000Z',
      isRead: false,
      isStarred: false,
      labelIds: [],
      categoryIds: [category.id],
      hasDraft: true,
      draftCount: 1,
    } satisfies ThreadListItem;

    const list = {
      threads: [listItem],
      nextPageToken: null,
    } satisfies ThreadListResponse;

    const detail = {
      latest: message,
      messages: [message],
      drafts: [draft],
      hasUnread: true,
      totalReplies: 1,
      labels: [],
      categories: [category],
    } satisfies ThreadDetailResponse;

    const caps = {
      ai: false,
      brain: false,
      notes: false,
      templates: false,
      bimi: false,
      gmailSearchGrammar: false,
      hotelCategories: true,
      staleDraftWarning: true,
    } satisfies PilotCapabilities;

    expect(detail.drafts[0]?.id).toBe('draft-1');
    expect(detail.categories[0]?.slug).toBe('travel-agents');
    expect(filters.categoryIds).toEqual(['cat-travel']);
    expect(caps.hotelCategories).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- package-contract
```

Expected: FAIL because `MailCategory`, `MailFilterInput`, `ParsedDraft`, `ParsedMessage`, `PilotCapabilities`, `ThreadDetailResponse`, `ThreadListItem`, or `ThreadListResponse` is not exported.

- [ ] **Step 3: Replace placeholder driver types**

Replace `apps/server-pilot/src/lib/driver/types.ts` with:

```ts
export type CenturionMailCategory = 'internal' | 'individual' | 'group' | 'travel-agents';

export interface ParsedAddress {
  name?: string;
  email: string;
}

export interface ParsedMessageTag {
  id: string;
  name: string;
  type: string;
}

export interface ParsedMessageAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  body: string;
  headers: { name: string | null; value: string | null }[];
}

export interface MailDebugHeaderLine {
  key: string;
  line: string;
}

export interface ParsedMessage {
  id: string;
  title: string;
  subject: string;
  tags: ParsedMessageTag[];
  sender: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[] | null;
  bcc: ParsedAddress[] | null;
  tls: boolean;
  receivedOn: string;
  unread: boolean;
  body: string;
  processedHtml: string;
  blobUrl: string;
  decodedBody?: string;
  references?: string;
  inReplyTo?: string;
  messageId?: string;
  threadId?: string;
  attachments?: ParsedMessageAttachment[];
  isDraft?: boolean;
  debugHeaders?: MailDebugHeaderLine[];
}

export interface ParsedDraft {
  id: string;
  threadId: string | null;
  replyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  content: string | null;
  updatedAt: string;
  status: 'active' | 'candidate' | 'discarded' | 'sent';
  origin: 'manual' | 'ai';
  generationId: string | null;
  isStale: boolean;
}

export interface MailCategory {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

export interface MailLabelWire {
  id: string;
  name: string;
  type: 'system' | 'user';
  color?: string | null;
}

export interface MailFilterInput {
  unread?: boolean;
  important?: boolean;
  starred?: boolean;
  categoryIds?: string[];
  labelIds?: string[];
}

export interface ThreadListItem {
  id: string;
  subject: string | null;
  snippet: string | null;
  latestMessageAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  labelIds: string[];
  categoryIds: string[];
  hasDraft: boolean;
  draftCount: number;
}

export interface ThreadListResponse {
  threads: ThreadListItem[];
  nextPageToken: string | null;
}

export interface ThreadDetailResponse {
  latest?: ParsedMessage;
  messages: ParsedMessage[];
  drafts: ParsedDraft[];
  hasUnread: boolean;
  totalReplies: number;
  labels: MailLabelWire[];
  categories: MailCategory[];
}

export interface PilotCapabilities {
  ai: false;
  brain: false;
  notes: false;
  templates: false;
  bimi: false;
  gmailSearchGrammar: false;
  hotelCategories: true;
  staleDraftWarning: true;
}

export interface ManagerConfig {
  auth: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    email: string;
  };
}

export interface MailManager {
  config: ManagerConfig;
}

export type IGetThreadResponse = ThreadDetailResponse;
```

- [ ] **Step 4: Re-export message type in wire compat**

In `apps/server-pilot/src/trpc/wire-compat.ts`, add this import near the top:

```ts
import type { ParsedMessage } from '../lib/driver/types.js';
```

Then change:

```ts
export interface ParsedMessageWire {
```

to:

```ts
export interface ParsedMessageWire extends ParsedMessage {
```

Keep all existing fields inside `ParsedMessageWire`; TypeScript will enforce compatibility with the exported frontend contract.

- [ ] **Step 5: Run contract test**

Run:

```bash
pnpm --filter=@zero/server test -- package-contract
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/lib/driver/types.ts apps/server-pilot/src/trpc/wire-compat.ts apps/server-pilot/tests/package-contract.test.ts
git commit -m "feat: export pilot mail contract types"
```

---

## Task 2: Add Pilot Capabilities and Inert Legacy Routers

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/ai.ts`
- Create: `apps/server-pilot/src/trpc/routes/brain.ts`
- Create: `apps/server-pilot/src/trpc/routes/notes.ts`
- Create: `apps/server-pilot/src/trpc/routes/templates.ts`
- Create: `apps/server-pilot/src/trpc/routes/bimi.ts`
- Modify: `apps/server-pilot/src/trpc/router.ts`
- Test: `apps/server-pilot/tests/misc-wire-contract.test.ts`

**Interfaces:**
- Produces: `ai`, `brain`, `notes`, `templates`, and `bimi` routers on `AppRouter`.
- Produces: `brain.getCapabilities(): PilotCapabilities`.
- Consumes: `PilotCapabilities` from Task 1.

- [ ] **Step 1: Write failing inert router test**

Append this test to `apps/server-pilot/tests/misc-wire-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

describe('pilot inert legacy routers', () => {
  it('exposes disabled pilot capabilities and safe empty legacy responses', async () => {
    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: 'transport-1',
    } as never);

    await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
      ai: false,
      brain: false,
      notes: false,
      templates: false,
      bimi: false,
      gmailSearchGrammar: false,
      hotelCategories: true,
      staleDraftWarning: true,
    });

    await expect(caller.ai.generateSearchQuery({ prompt: 'find urgent mail' })).resolves.toEqual({
      query: '',
      disabled: true,
    });

    await expect(caller.notes.list({ threadId: 'thread-1' })).resolves.toEqual([]);
    await expect(caller.templates.list()).resolves.toEqual([]);
    await expect(caller.bimi.getByEmail({ email: 'guest@example.com' })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- misc-wire-contract
```

Expected: FAIL because `brain`, `ai`, `notes`, `templates`, and `bimi` are not on `appRouter`.

- [ ] **Step 3: Create inert AI router**

Create `apps/server-pilot/src/trpc/routes/ai.ts`:

```ts
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

export const aiRouter = tRouter({
  generateSearchQuery: privateProcedure
    .input(z.object({ prompt: z.string().optional() }).optional())
    .query(() => ({ query: '', disabled: true })),

  webSearch: privateProcedure
    .input(z.object({ query: z.string().optional() }).optional())
    .query(() => ({ results: [], disabled: true })),

  compose: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ text: '', disabled: true })),

  generateEmailSubject: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ subject: '', disabled: true })),
});
```

- [ ] **Step 4: Create inert brain router**

Create `apps/server-pilot/src/trpc/routes/brain.ts`:

```ts
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';
import type { PilotCapabilities } from '../../lib/driver/types.js';

export const pilotCapabilities = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: false,
  hotelCategories: true,
  staleDraftWarning: true,
} satisfies PilotCapabilities;

export const brainRouter = tRouter({
  getCapabilities: privateProcedure.query(() => pilotCapabilities),
  generateSummary: privateProcedure
    .input(z.object({ threadId: z.string().optional() }).optional())
    .query(() => null),
  getState: privateProcedure.query(() => ({ enabled: false, summary: null })),
  getPrompts: privateProcedure.query(() => []),
  updatePrompt: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ updated: false, disabled: true })),
});
```

- [ ] **Step 5: Create inert notes router**

Create `apps/server-pilot/src/trpc/routes/notes.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

const disabled = () => {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'NOTES_DISABLED_FOR_PILOT',
  });
};

export const notesRouter = tRouter({
  list: privateProcedure
    .input(z.object({ threadId: z.string().optional() }).optional())
    .query(() => []),
  create: privateProcedure.input(z.unknown()).mutation(disabled),
  update: privateProcedure.input(z.unknown()).mutation(disabled),
  delete: privateProcedure.input(z.unknown()).mutation(disabled),
  reorder: privateProcedure.input(z.unknown()).mutation(disabled),
});
```

- [ ] **Step 6: Create inert templates router**

Create `apps/server-pilot/src/trpc/routes/templates.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

const disabled = () => {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'TEMPLATES_DISABLED_FOR_PILOT',
  });
};

export const templatesRouter = tRouter({
  list: privateProcedure.query(() => []),
  create: privateProcedure.input(z.unknown()).mutation(disabled),
  delete: privateProcedure.input(z.unknown()).mutation(disabled),
});
```

- [ ] **Step 7: Create inert BIMI router**

Create `apps/server-pilot/src/trpc/routes/bimi.ts`:

```ts
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

export const bimiRouter = tRouter({
  getByEmail: privateProcedure
    .input(z.object({ email: z.string().email() }))
    .query(() => null),
});
```

- [ ] **Step 8: Wire routers into root router**

Modify `apps/server-pilot/src/trpc/router.ts`:

```ts
import { aiRouter } from './routes/ai.js';
import { brainRouter } from './routes/brain.js';
import { notesRouter } from './routes/notes.js';
import { templatesRouter } from './routes/templates.js';
import { bimiRouter } from './routes/bimi.js';
```

Then add these entries to `appRouter`:

```ts
  ai: aiRouter,
  brain: brainRouter,
  notes: notesRouter,
  templates: templatesRouter,
  bimi: bimiRouter,
```

- [ ] **Step 9: Run test**

Run:

```bash
pnpm --filter=@zero/server test -- misc-wire-contract
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server-pilot/src/trpc/router.ts apps/server-pilot/src/trpc/routes/ai.ts apps/server-pilot/src/trpc/routes/brain.ts apps/server-pilot/src/trpc/routes/notes.ts apps/server-pilot/src/trpc/routes/templates.ts apps/server-pilot/src/trpc/routes/bimi.ts apps/server-pilot/tests/misc-wire-contract.test.ts
git commit -m "feat: add pilot inert legacy routers"
```

---

## Task 3: Add Backend Category Schema

**Files:**
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/drizzle/0005_mail_categories.sql`
- Test: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces: `mailCategory`, `mailThreadCategory` Drizzle tables.
- Produces DB tables: `mail_category`, `mail_thread_category`.
- Consumes: `mailboxTransport` and `mailThread`.

- [ ] **Step 1: Write failing schema contract test**

Append this test to `apps/server-pilot/tests/schema-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mailCategory, mailThreadCategory } from '../src/db/schema/mail.js';

describe('mail category schema', () => {
  it('exports mailbox-scoped categories and thread membership tables', () => {
    expect(mailCategory).toBeDefined();
    expect(mailThreadCategory).toBeDefined();
    expect(mailCategory.id.name).toBe('id');
    expect(mailCategory.slug.name).toBe('slug');
    expect(mailThreadCategory.categoryId.name).toBe('category_id');
    expect(mailThreadCategory.threadId.name).toBe('thread_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- schema-contract
```

Expected: FAIL because `mailCategory` and `mailThreadCategory` are not exported.

- [ ] **Step 3: Add schema imports**

In `apps/server-pilot/src/db/schema/mail.ts`, add `primaryKey` to the `drizzle-orm/pg-core` import:

```ts
  primaryKey,
```

- [ ] **Step 4: Add category tables**

Insert this block after the `mailLabel` table:

```ts
export const mailCategory = pgTable(
  'mail_category',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_category_transport_slug_uidx').on(t.transportId, t.slug),
    index('mail_category_transport_order_idx').on(t.transportId, t.sortOrder),
  ],
);

export const mailThreadCategory = pgTable(
  'mail_thread_category',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => mailCategory.id, { onDelete: 'cascade' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.categoryId] }),
    index('mail_thread_category_category_idx').on(t.categoryId),
    index('mail_thread_category_transport_idx').on(t.transportId),
  ],
);
```

- [ ] **Step 5: Add SQL migration**

Create `apps/server-pilot/drizzle/0005_mail_categories.sql`:

```sql
CREATE TABLE IF NOT EXISTS "mail_category" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "color" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "mail_category_transport_slug_uidx"
  ON "mail_category" ("transport_id", "slug");

CREATE INDEX IF NOT EXISTS "mail_category_transport_order_idx"
  ON "mail_category" ("transport_id", "sort_order");

CREATE TABLE IF NOT EXISTS "mail_thread_category" (
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "category_id" text NOT NULL REFERENCES "mail_category"("id") ON DELETE cascade,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_thread_category_thread_id_category_id_pk" PRIMARY KEY ("thread_id", "category_id")
);

CREATE INDEX IF NOT EXISTS "mail_thread_category_category_idx"
  ON "mail_thread_category" ("category_id");

CREATE INDEX IF NOT EXISTS "mail_thread_category_transport_idx"
  ON "mail_thread_category" ("transport_id");
```

- [ ] **Step 6: Run schema test**

Run:

```bash
pnpm --filter=@zero/server test -- schema-contract
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/db/schema/mail.ts apps/server-pilot/drizzle/0005_mail_categories.sql apps/server-pilot/tests/schema-contract.test.ts
git commit -m "feat: add mailbox category schema"
```

---

## Task 4: Add Categories Router

**Files:**
- Create: `apps/server-pilot/src/trpc/routes/categories.ts`
- Modify: `apps/server-pilot/src/trpc/router.ts`
- Test: `apps/server-pilot/tests/categories-contract.test.ts`

**Interfaces:**
- Produces: `categories.list`, `categories.create`, `categories.update`, `categories.delete`, `categories.setThreadCategories`.
- Consumes: `mailCategory`, `mailThreadCategory`, `mailThread`.

- [ ] **Step 1: Write failing categories test**

Create `apps/server-pilot/tests/categories-contract.test.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import { getDb } from '../src/db/client.js';
import { mailCategory, mailThread, mailThreadCategory, mailboxTransport } from '../src/db/schema/mail.js';

describe('categories router', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailThreadCategory);
    await db.delete(mailCategory);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('creates mailbox-scoped categories and assigns multiple categories to one thread', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'VIP booking',
      snippet: 'Need travel agent',
      isRead: false,
    });

    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    const travel = await caller.categories.create({
      slug: 'travel-agents',
      name: 'Travel Agents',
      color: '#14b8a6',
      sortOrder: 10,
    });
    const urgent = await caller.categories.create({
      slug: 'urgent',
      name: 'Urgent',
      color: '#ef4444',
      sortOrder: 20,
    });

    await caller.categories.setThreadCategories({
      threadId,
      categoryIds: [travel.id, urgent.id],
    });

    const categories = await caller.categories.list();
    expect(categories.map((c) => c.slug)).toEqual(['travel-agents', 'urgent']);

    const membership = await db.select().from(mailThreadCategory);
    expect(membership).toHaveLength(2);
  });

  it('rejects duplicate slugs in the same mailbox', async () => {
    const db = getDb();
    const transportId = randomUUID();
    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    await caller.categories.create({ slug: 'urgent', name: 'Urgent', sortOrder: 1 });
    await expect(
      caller.categories.create({ slug: 'urgent', name: 'Urgent Again', sortOrder: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- categories-contract
```

Expected: FAIL because `categories` router is missing.

- [ ] **Step 3: Create categories router**

Create `apps/server-pilot/src/trpc/routes/categories.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { mailCategory, mailThread, mailThreadCategory } from '../../db/schema/mail.js';
import { mailboxProcedure, router as tRouter } from '../trpc.js';

const RESERVED_CATEGORY_SLUGS = new Set([
  'inbox',
  'sent',
  'spam',
  'draft',
  'drafts',
  'archive',
  'archived',
  'bin',
  'starred',
  'snoozed',
  'all',
]);

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function assertCategorySlug(slug: string) {
  if (RESERVED_CATEGORY_SLUGS.has(slug)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'CATEGORY_SLUG_RESERVED',
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code === '23505';
  }
  if (err instanceof Error && err.cause) return isUniqueViolation(err.cause);
  return false;
}

function throwConflictForUnique(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'CATEGORY_SLUG_EXISTS',
    });
  }
  throw err;
}

export const categoriesRouter = tRouter({
  list: mailboxProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, ctx.activeTransportId), eq(mailCategory.isActive, true)))
      .orderBy(asc(mailCategory.sortOrder), asc(mailCategory.name));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      color: row.color,
      sortOrder: row.sortOrder,
    }));
  }),

  create: mailboxProcedure
    .input(
      z.object({
        slug: slugSchema,
        name: z.string().min(1).max(120),
        color: z.string().nullable().optional(),
        sortOrder: z.number().int().default(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertCategorySlug(input.slug);
      const db = getDb();
      const id = randomUUID();
      try {
        await db.insert(mailCategory).values({
          id,
          transportId: ctx.activeTransportId,
          slug: input.slug,
          name: input.name,
          color: input.color ?? null,
          sortOrder: input.sortOrder,
        });
      } catch (err) {
        throwConflictForUnique(err);
      }
      return { id, slug: input.slug, name: input.name, color: input.color ?? null, sortOrder: input.sortOrder };
    }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        slug: slugSchema.optional(),
        name: z.string().min(1).max(120).optional(),
        color: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.slug) assertCategorySlug(input.slug);
      const db = getDb();
      const patch: Partial<typeof mailCategory.$inferInsert> = { updatedAt: new Date() };
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      try {
        const updated = await db
          .update(mailCategory)
          .set(patch)
          .where(and(eq(mailCategory.id, input.id), eq(mailCategory.transportId, ctx.activeTransportId)))
          .returning({ id: mailCategory.id });
        if (updated.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'CATEGORY_NOT_FOUND' });
        }
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throwConflictForUnique(err);
      }
      return { id: input.id };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const deleted = await db
        .update(mailCategory)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(mailCategory.id, input.id), eq(mailCategory.transportId, ctx.activeTransportId)))
        .returning({ id: mailCategory.id });
      if (deleted.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'CATEGORY_NOT_FOUND' });
      }
      return { deleted: true };
    }),

  setThreadCategories: mailboxProcedure
    .input(z.object({ threadId: z.string(), categoryIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const thread = await db
        .select({ id: mailThread.id })
        .from(mailThread)
        .where(and(eq(mailThread.id, input.threadId), eq(mailThread.transportId, ctx.activeTransportId)))
        .limit(1);
      if (thread.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'THREAD_NOT_FOUND' });
      }

      if (input.categoryIds.length > 0) {
        const categories = await db
          .select({ id: mailCategory.id })
          .from(mailCategory)
          .where(
            and(
              eq(mailCategory.transportId, ctx.activeTransportId),
              eq(mailCategory.isActive, true),
              inArray(mailCategory.id, input.categoryIds),
            ),
          );
        if (categories.length !== new Set(input.categoryIds).size) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'CATEGORY_NOT_IN_MAILBOX' });
        }
      }

      await db
        .delete(mailThreadCategory)
        .where(and(eq(mailThreadCategory.threadId, input.threadId), eq(mailThreadCategory.transportId, ctx.activeTransportId)));

      if (input.categoryIds.length > 0) {
        await db.insert(mailThreadCategory).values(
          [...new Set(input.categoryIds)].map((categoryId) => ({
            threadId: input.threadId,
            categoryId,
            transportId: ctx.activeTransportId,
          })),
        );
      }

      return { threadId: input.threadId, categoryIds: [...new Set(input.categoryIds)] };
    }),
});
```

- [ ] **Step 4: Wire categories router**

Add to `apps/server-pilot/src/trpc/router.ts`:

```ts
import { categoriesRouter } from './routes/categories.js';
```

Then add:

```ts
  categories: categoriesRouter,
```

inside `appRouter`.

- [ ] **Step 5: Run categories test**

Run:

```bash
pnpm --filter=@zero/server test -- categories-contract
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/categories.ts apps/server-pilot/src/trpc/router.ts apps/server-pilot/tests/categories-contract.test.ts
git commit -m "feat: add mailbox categories router"
```

---

## Task 5: Add Backend Category and Structured Filter Listing

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Test: `apps/server-pilot/tests/mail-category-filter.test.ts`
- Test: `apps/server-pilot/tests/list-pagination.test.ts`

**Interfaces:**
- Consumes: `mailCategory`, `mailThreadCategory`.
- Extends: `listThreadsInput` with `filters?: { unread?: boolean; important?: boolean; starred?: boolean; categoryIds?: string[]; labelIds?: string[] }`.
- Produces: thread rows with `categoryIds`, `hasDraft`, and `draftCount`.

- [ ] **Step 1: Write failing category filter test**

Create `apps/server-pilot/tests/mail-category-filter.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import { getDb } from '../src/db/client.js';
import { mailCategory, mailThread, mailThreadCategory, mailboxTransport } from '../src/db/schema/mail.js';

describe('mail.listThreads category and system filters', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailThreadCategory);
    await db.delete(mailCategory);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('filters by multi-select categories and unread state', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const travelId = randomUUID();
    const urgentId = randomUUID();
    const matchingThreadId = randomUUID();
    const otherThreadId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(mailCategory).values([
      { id: travelId, transportId, slug: 'travel-agents', name: 'Travel Agents', sortOrder: 10 },
      { id: urgentId, transportId, slug: 'urgent', name: 'Urgent', sortOrder: 20 },
    ]);
    await db.insert(mailThread).values([
      {
        id: matchingThreadId,
        transportId,
        threadRootId: '<match@example.com>',
        subject: 'VIP airport transfer',
        snippet: 'Travel agent needs answer',
        isRead: false,
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      },
      {
        id: otherThreadId,
        transportId,
        threadRootId: '<other@example.com>',
        subject: 'Breakfast',
        snippet: 'Restaurant booking',
        isRead: false,
        latestMessageAt: new Date('2026-07-06T09:00:00Z'),
      },
    ]);
    await db.insert(mailThreadCategory).values([
      { threadId: matchingThreadId, categoryId: travelId, transportId },
      { threadId: matchingThreadId, categoryId: urgentId, transportId },
    ]);

    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    const result = await caller.mail.listThreads({
      folder: 'all',
      filters: { unread: true, categoryIds: [travelId] },
      limit: 20,
    });

    expect(result.threads.map((t) => t.id)).toEqual([matchingThreadId]);
    expect(result.threads[0]?.categoryIds).toEqual(expect.arrayContaining([travelId, urgentId]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- mail-category-filter
```

Expected: FAIL because `filters` is not accepted and category tables are not joined in list output.

- [ ] **Step 3: Import category tables**

In `apps/server-pilot/src/trpc/routes/mail.ts`, extend the schema import:

```ts
  mailCategory,
  mailThreadCategory,
```

- [ ] **Step 4: Extend listThreads input**

Replace `listThreadsInput` in `apps/server-pilot/src/trpc/routes/mail.ts` with:

```ts
export const listThreadsInput = z.object({
  folder: z.enum(MAIL_FOLDER_VALUES).default('inbox'),
  q: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  filters: z
    .object({
      unread: z.boolean().optional(),
      important: z.boolean().optional(),
      starred: z.boolean().optional(),
      categoryIds: z.array(z.string()).optional(),
      labelIds: z.array(z.string()).optional(),
    })
    .optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
```

- [ ] **Step 5: Add filter conditions in listThreads**

Inside `listThreads`, after the existing `input.labelIds` block, add:

```ts
      const filterLabelIds = input.filters?.labelIds ?? [];
      if (filterLabelIds.length > 0) {
        conditions.push(
          sql`${mailThread.labelIds} ?| array[${sql.join(
            filterLabelIds.map((id) => sql`${id}`),
            sql`, `,
          )}]`,
        );
      }

      if (input.filters?.unread === true) {
        conditions.push(eq(mailThread.isRead, false));
      }

      if (input.filters?.starred === true) {
        conditions.push(eq(mailThread.isStarred, true));
      }

      if (input.filters?.important === true) {
        conditions.push(sql`${mailThread.labelIds} ? 'IMPORTANT'`);
      }

      const filterCategoryIds = input.filters?.categoryIds ?? [];
      if (filterCategoryIds.length > 0) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(mailThreadCategory)
              .where(
                and(
                  eq(mailThreadCategory.threadId, mailThread.id),
                  eq(mailThreadCategory.transportId, transportId),
                  inArray(mailThreadCategory.categoryId, filterCategoryIds),
                ),
              ),
          ),
        );
      }
```

- [ ] **Step 6: Add category and draft indicator hydration**

After the query produces `rows`, add:

```ts
      const threadIds = rows.map((row) => row.id);
      const categoryRows =
        threadIds.length > 0
          ? await db
              .select({
                threadId: mailThreadCategory.threadId,
                categoryId: mailThreadCategory.categoryId,
              })
              .from(mailThreadCategory)
              .where(
                and(
                  eq(mailThreadCategory.transportId, transportId),
                  inArray(mailThreadCategory.threadId, threadIds),
                ),
              )
          : [];

      const categoryIdsByThread = new Map<string, string[]>();
      for (const row of categoryRows) {
        const existing = categoryIdsByThread.get(row.threadId) ?? [];
        existing.push(row.categoryId);
        categoryIdsByThread.set(row.threadId, existing);
      }

      const draftCountRows =
        threadIds.length > 0
          ? await db
              .select({
                threadId: mailDraft.threadId,
                count: sql<number>`count(*)::int`,
              })
              .from(mailDraft)
              .where(
                and(
                  eq(mailDraft.transportId, transportId),
                  inArray(mailDraft.threadId, threadIds),
                  eq(mailDraft.isSent, false),
                ),
              )
              .groupBy(mailDraft.threadId)
          : [];
      const draftCountByThread = new Map(
        draftCountRows
          .filter((row): row is { threadId: string; count: number } => Boolean(row.threadId))
          .map((row) => [row.threadId, row.count]),
      );
```

Then ensure every returned thread object includes:

```ts
categoryIds: categoryIdsByThread.get(row.id) ?? [],
hasDraft: (draftCountByThread.get(row.id) ?? 0) > 0,
draftCount: draftCountByThread.get(row.id) ?? 0,
```

Task 7 later narrows this count to `status in ('active', 'candidate')` after draft lifecycle fields exist.

- [ ] **Step 7: Run category filter and pagination tests**

Run:

```bash
pnpm --filter=@zero/server test -- mail-category-filter list-pagination
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-category-filter.test.ts apps/server-pilot/tests/list-pagination.test.ts
git commit -m "feat: filter pilot threads by categories"
```

---

## Task 6: Add Draft Lifecycle and AI Eval Schema

**Files:**
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/drizzle/0006_draft_lifecycle_eval.sql`
- Test: `apps/server-pilot/tests/draft-eval-schema-contract.test.ts`
- Test: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces: `mailDraftStatusEnum`, `mailDraftOriginEnum`, `mailDraftRevisionKindEnum`.
- Produces: `aiDraftGeneration` with `contextMessageIds`, `model`, `promptVersion`, and `promptHash`.
- Extends: `mailDraft` with `status`, `origin`, `replyToMessageId`, and `generationId`.
- Produces: `mailDraftRevision` append-only snapshots for `created`, `ai_generated`, `promoted`, `edited`, and `sent`.
- Keeps: no `baseMessageIds`, no `baseThreadLatestMessageAt`, no `staleConfirmedAt`.
- Keeps: no `discarded` revision kind. Discard is row lifecycle state only unless audit later needs a discarded-text event.

- [ ] **Step 1: Write failing schema contract test**

Create `apps/server-pilot/tests/draft-eval-schema-contract.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';

describe('draft eval schema contract', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraftRevision);
    await db.delete(mailDraft);
    await db.delete(aiDraftGeneration);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('stores an AI candidate draft, generation context, and immutable initial revision', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const draftId = randomUUID();
    const generationId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(userAuthTable).values({
      id: 'user-1',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(message).values({
      id: messageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['nava@example.com'],
      subject: 'Booking',
      textBody: 'Need help',
      receivedAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [messageId],
      model: 'gpt-5.5',
      promptVersion: 'hotel-reply-v1',
    });
    await db.insert(mailDraft).values({
      id: draftId,
      transportId,
      threadId,
      createdByUserId: 'user-1',
      status: 'candidate',
      origin: 'ai',
      replyToMessageId: messageId,
      generationId,
      toAddresses: ['guest@example.com'],
      subject: 'Re: Booking',
      textBody: 'AI draft reply',
      htmlBody: '<p>AI draft reply</p>',
    });
    await db.insert(mailDraftRevision).values({
      id: revisionId,
      draftId,
      generationId,
      kind: 'ai_generated',
      toAddresses: ['guest@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Re: Booking',
      textBody: 'AI draft reply',
      htmlBody: '<p>AI draft reply</p>',
      attachments: [],
    });

    const generationRows = await db.select().from(aiDraftGeneration);
    const draftRows = await db.select().from(mailDraft);
    const revisionRows = await db.select().from(mailDraftRevision);

    expect(generationRows[0]?.contextMessageIds).toEqual([messageId]);
    expect(generationRows[0]?.promptVersion).toBe('hotel-reply-v1');
    expect(draftRows[0]).toMatchObject({
      status: 'candidate',
      origin: 'ai',
      replyToMessageId: messageId,
      generationId,
    });
    expect(revisionRows[0]).toMatchObject({
      kind: 'ai_generated',
      generationId,
      textBody: 'AI draft reply',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- draft-eval-schema-contract
```

Expected: FAIL because `aiDraftGeneration`, `mailDraftRevision`, and new draft lifecycle fields do not exist.

- [ ] **Step 3: Add draft lifecycle enums**

In `apps/server-pilot/src/db/schema/mail.ts`, add after `messageDirectionEnum`:

```ts
export const mailDraftStatusEnum = pgEnum('mail_draft_status', [
  'active',
  'candidate',
  'discarded',
  'sent',
]);

export const mailDraftOriginEnum = pgEnum('mail_draft_origin', [
  'manual',
  'ai',
]);

export const mailDraftRevisionKindEnum = pgEnum('mail_draft_revision_kind', [
  'created',
  'ai_generated',
  'promoted',
  'edited',
  'sent',
]);
```

- [ ] **Step 4: Add AI generation table**

In `apps/server-pilot/src/db/schema/mail.ts`, add after `attachment` and before `mailDraft`:

```ts
export const aiDraftGeneration = pgTable(
  'ai_draft_generation',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id').notNull(),
    contextMessageIds: jsonb('context_message_ids').$type<string[]>().notNull().default([]),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptHash: text('prompt_hash'),
    status: text('status').notNull().default('succeeded'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ai_draft_generation_thread_idx').on(t.transportId, t.threadId, t.createdAt),
  ],
);
```

- [ ] **Step 5: Extend mailDraft**

In `mailDraft`, replace `sentMessageId: text('sent_message_id'),` with:

```ts
    status: mailDraftStatusEnum('status').notNull().default('active'),
    origin: mailDraftOriginEnum('origin').notNull().default('manual'),
    replyToMessageId: text('reply_to_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    generationId: text('generation_id').references(() => aiDraftGeneration.id, {
      onDelete: 'set null',
    }),
    sentMessageId: text('sent_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
```

Add these indexes to the `mailDraft` index list:

```ts
    index('mail_draft_thread_status_idx').on(t.transportId, t.threadId, t.status, t.updatedAt),
    index('mail_draft_reply_to_message_idx').on(t.replyToMessageId),
    index('mail_draft_generation_idx').on(t.generationId),
    uniqueIndex('mail_draft_one_active_thread_uidx')
      .on(t.transportId, t.threadId)
      .where(sql`${t.status} = 'active' AND ${t.threadId} IS NOT NULL`),
```

- [ ] **Step 6: Add mailDraftRevision table**

In `apps/server-pilot/src/db/schema/mail.ts`, add after `mailDraft`:

```ts
export const mailDraftRevision = pgTable(
  'mail_draft_revision',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => mailDraft.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').references(() => aiDraftGeneration.id, {
      onDelete: 'set null',
    }),
    sentMessageId: text('sent_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    actorUserId: text('actor_user_id'),
    kind: mailDraftRevisionKindEnum('kind').notNull(),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
    ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
    bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    attachments: jsonb('attachments').$type<
      { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[]
    >().notNull().default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_draft_revision_draft_idx').on(t.draftId, t.createdAt),
    index('mail_draft_revision_generation_idx').on(t.generationId),
    index('mail_draft_revision_sent_message_idx').on(t.sentMessageId),
  ],
);
```

Do not add a `discarded` revision kind. `mail_draft.status='discarded'` is enough until audit requires preserving discarded text.

- [ ] **Step 7: Add draft lifecycle migration**

Create `apps/server-pilot/drizzle/0006_draft_lifecycle_eval.sql`:

```sql
DO $$ BEGIN
  CREATE TYPE "mail_draft_status" AS ENUM ('active', 'candidate', 'discarded', 'sent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "mail_draft_origin" AS ENUM ('manual', 'ai');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "mail_draft_revision_kind" AS ENUM ('created', 'ai_generated', 'promoted', 'edited', 'sent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ai_draft_generation" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "requested_by_user_id" text NOT NULL,
  "context_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "prompt_hash" text,
  "status" text DEFAULT 'succeeded' NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "mail_draft"
  ADD COLUMN IF NOT EXISTS "status" "mail_draft_status" DEFAULT 'active' NOT NULL,
  ADD COLUMN IF NOT EXISTS "origin" "mail_draft_origin" DEFAULT 'manual' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reply_to_message_id" text,
  ADD COLUMN IF NOT EXISTS "generation_id" text;

UPDATE "mail_draft" SET "status" = 'sent' WHERE "is_sent" = true;

WITH ranked_active_drafts AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "transport_id", "thread_id"
      ORDER BY "updated_at" DESC NULLS LAST, "id" DESC
    ) AS rn
  FROM "mail_draft"
  WHERE "is_sent" = false
    AND "status" = 'active'
    AND "thread_id" IS NOT NULL
)
UPDATE "mail_draft"
SET "status" = 'discarded', "updated_at" = now()
FROM ranked_active_drafts
WHERE "mail_draft"."id" = ranked_active_drafts."id"
  AND ranked_active_drafts.rn > 1;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_reply_to_message_id_message_id_fk"
    FOREIGN KEY ("reply_to_message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_generation_id_ai_draft_generation_id_fk"
    FOREIGN KEY ("generation_id") REFERENCES "ai_draft_generation"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_sent_message_id_message_id_fk"
    FOREIGN KEY ("sent_message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "mail_draft_revision" (
  "id" text PRIMARY KEY NOT NULL,
  "draft_id" text NOT NULL REFERENCES "mail_draft"("id") ON DELETE cascade,
  "generation_id" text REFERENCES "ai_draft_generation"("id") ON DELETE set null,
  "sent_message_id" text REFERENCES "message"("id") ON DELETE set null,
  "actor_user_id" text,
  "kind" "mail_draft_revision_kind" NOT NULL,
  "to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "bcc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subject" text,
  "text_body" text,
  "html_body" text,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_draft_generation_thread_idx"
  ON "ai_draft_generation" ("transport_id", "thread_id", "created_at");
CREATE INDEX IF NOT EXISTS "mail_draft_thread_status_idx"
  ON "mail_draft" ("transport_id", "thread_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "mail_draft_reply_to_message_idx"
  ON "mail_draft" ("reply_to_message_id");
CREATE INDEX IF NOT EXISTS "mail_draft_generation_idx"
  ON "mail_draft" ("generation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mail_draft_one_active_thread_uidx"
  ON "mail_draft" ("transport_id", "thread_id")
  WHERE "status" = 'active' AND "thread_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "mail_draft_revision_draft_idx"
  ON "mail_draft_revision" ("draft_id", "created_at");
CREATE INDEX IF NOT EXISTS "mail_draft_revision_generation_idx"
  ON "mail_draft_revision" ("generation_id");
CREATE INDEX IF NOT EXISTS "mail_draft_revision_sent_message_idx"
  ON "mail_draft_revision" ("sent_message_id");
```

- [ ] **Step 8: Extend schema contract test**

Append to `apps/server-pilot/tests/schema-contract.test.ts`:

```ts
it('exports draft lifecycle and eval schema tables', () => {
  expect(schema.aiDraftGeneration.contextMessageIds).toBeDefined();
  expect(schema.aiDraftGeneration.promptVersion).toBeDefined();
  expect(schema.mailDraft.status).toBeDefined();
  expect(schema.mailDraft.origin).toBeDefined();
  expect(schema.mailDraft.replyToMessageId).toBeDefined();
  expect(schema.mailDraft.generationId).toBeDefined();
  expect(schema.mailDraftRevision.kind).toBeDefined();
});
```

- [ ] **Step 9: Run schema tests**

Run:

```bash
pnpm --filter=@zero/server test -- draft-eval-schema-contract schema-contract
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server-pilot/src/db/schema/mail.ts apps/server-pilot/drizzle/0006_draft_lifecycle_eval.sql apps/server-pilot/tests/draft-eval-schema-contract.test.ts apps/server-pilot/tests/schema-contract.test.ts
git commit -m "feat: add draft lifecycle eval schema"
```

---

## Task 7: Add Plural Draft Contract and Stale Draft Send Conflict

**Files:**
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
- Create: `apps/server-pilot/src/trpc/routes/draft-wire.ts`
- Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Test: `apps/server-pilot/tests/draft-thread-contract.test.ts`
- Test: `apps/server-pilot/tests/draft-stale-conflict.test.ts`
- Test: `apps/server-pilot/tests/draft-sequential-replies-contract.test.ts`
- Test: `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`

**Interfaces:**
- Extends: `createDraftInput` with `replyToMessageId?: string | null`.
- Extends: `drafts.list({ threadId?: string })`.
- Extends: `mail.get` response with `drafts: ParsedDraft[]`.
- Extends: `sendInput` with `confirmStaleDraft?: boolean`.
- Produces: `drafts.ensureEditableForReply({ threadId, replyToMessageId })` returning an active `ParsedDraft`; `replyToMessageId` is required and must belong to `threadId`.
- Promotion policy: existing active draft wins; otherwise newest AI candidate for the same `replyToMessageId` promotes in-place and older sibling candidates become `discarded`.
- Produces: `TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' })` when a newer inbound message exists after `mailDraft.replyToMessageId`.
- Visible draft queries return `status in ('active', 'candidate')`; sent and discarded drafts remain stored history. `drafts.delete` sets `status='discarded'` for active/candidate rows instead of deleting them.
- Send accepts only `status='active'` drafts. AI candidates must promote before editing or sending.
- Tests that insert `mailDraft` rows must seed `userAuthTable` with the `createdByUserId` used in the test.

- [ ] **Step 1: Write failing thread draft test**

Create `apps/server-pilot/tests/draft-thread-contract.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import { getDb } from '../src/db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';

describe('thread draft contract', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraftRevision);
    await db.delete(mailDraft);
    await db.delete(aiDraftGeneration);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  async function seedUser(db: ReturnType<typeof getDb>) {
    await db.insert(userAuthTable).values({
      id: 'user-1',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  it('returns plural drafts from mail.get without adding drafts to messages', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const parentMessageId = randomUUID();
    const activeDraftId = randomUUID();
    const candidateDraftId = randomUUID();
    const generationId = randomUUID();
    await seedUser(db);

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(message).values({
      id: parentMessageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['nava@example.com'],
      subject: 'Booking',
      textBody: 'Need help',
      receivedAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [parentMessageId],
      model: 'gpt-5.5',
      promptVersion: 'hotel-reply-v1',
    });
    await db.insert(mailDraft).values([
      {
        id: activeDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Human draft',
        htmlBody: '<p>Human draft</p>',
      },
      {
        id: candidateDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'candidate',
        origin: 'ai',
        replyToMessageId: parentMessageId,
        generationId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'AI candidate',
        htmlBody: '<p>AI candidate</p>',
      },
    ]);

    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    const thread = await caller.mail.get({ id: threadId });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages.some((m) => m.isDraft)).toBe(false);
    expect(thread.drafts.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);
    expect(thread.drafts[0]).toMatchObject({
      status: 'active',
      origin: 'manual',
      replyToMessageId: parentMessageId,
      isStale: false,
    });
    expect(thread.drafts[1]).toMatchObject({
      status: 'candidate',
      origin: 'ai',
      generationId,
    });

    const drafts = await caller.drafts.list({ threadId, limit: 10 });
    expect(drafts.threads.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);
  });
});
```

- [ ] **Step 2: Write failing stale draft test**

Create `apps/server-pilot/tests/draft-stale-conflict.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import { getDb } from '../src/db/client.js';
import { mailDraft, mailDraftRevision, mailThread, mailboxTransport, message } from '../src/db/schema/mail.js';

describe('stale draft conflict', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraftRevision);
    await db.delete(mailDraft);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('rejects sending a draft that replies to an older parent message until caller confirms', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const parentMessageId = randomUUID();
    const newerMessageId = randomUUID();
    const draftId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'New reply',
      latestMessageAt: new Date('2026-07-06T10:05:00Z'),
    });
    await db.insert(message).values([
      {
        id: parentMessageId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'First message',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      },
      {
        id: newerMessageId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'New reply',
        receivedAt: new Date('2026-07-06T10:05:00Z'),
      },
    ]);
    await db.insert(mailDraft).values({
      id: draftId,
      transportId,
      threadId,
      createdByUserId: 'user-1',
      status: 'active',
      origin: 'manual',
      replyToMessageId: parentMessageId,
      toAddresses: ['guest@example.com'],
      subject: 'Re: Booking',
      textBody: 'Old draft',
      htmlBody: '<p>Old draft</p>',
    });

    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    await expect(
      caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: '<p>Old draft</p>',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'STALE_DRAFT' });

    await expect(
      caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: '<p>Old draft</p>',
        confirmStaleDraft: true,
      }),
    ).resolves.toMatchObject({ sent: true });

    const revisions = await db.select().from(mailDraftRevision);
    expect(revisions.some((revision) => revision.kind === 'sent')).toBe(true);
  });
});
```

- [ ] **Step 3: Write failing sequential reply draft test**

Create `apps/server-pilot/tests/draft-sequential-replies-contract.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db/client.js';
import { mailDraft, mailThread, mailboxTransport, message } from '../src/db/schema/mail.js';
import { appRouter } from '../src/trpc/router.js';

describe('sequential reply drafts', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraft);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('keeps a sent draft as history and exposes the later active draft in the same thread', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const firstInboundId = randomUUID();
    const firstOutboundId = randomUUID();
    const secondInboundId = randomUUID();
    const sentDraftId = randomUUID();
    const activeDraftId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'Second guest reply',
      latestMessageAt: new Date('2026-07-06T10:10:00Z'),
    });
    await db.insert(message).values([
      {
        id: firstInboundId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'First guest question',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      },
      {
        id: firstOutboundId,
        transportId,
        threadId,
        direction: 'outbound',
        fromAddress: 'nava@example.com',
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'First sent reply',
        sentAt: new Date('2026-07-06T10:05:00Z'),
      },
      {
        id: secondInboundId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Re: Booking',
        textBody: 'Second guest question',
        receivedAt: new Date('2026-07-06T10:10:00Z'),
      },
    ]);
    await db.insert(mailDraft).values([
      {
        id: sentDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'sent',
        origin: 'manual',
        replyToMessageId: firstInboundId,
        sentMessageId: firstOutboundId,
        isSent: true,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'First sent reply',
      },
      {
        id: activeDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'active',
        origin: 'manual',
        replyToMessageId: secondInboundId,
        isSent: false,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Second active draft',
      },
    ]);

    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: transportId,
    } as never);

    const thread = await caller.mail.get({ id: threadId });
    expect(thread.drafts.map((draft) => draft.id)).toEqual([activeDraftId]);
    expect(thread.drafts[0]).toMatchObject({
      status: 'active',
      replyToMessageId: secondInboundId,
      isStale: false,
    });
  });
});
```

- [ ] **Step 4: Write failing AI promotion contract test**

Create `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { appRouter } from '../src/trpc/router.js';

async function seedThread() {
  const db = getDb();
  const transportId = randomUUID();
  const threadId = randomUUID();
  const parentMessageId = randomUUID();

  await db.insert(mailboxTransport).values({
    id: transportId,
    email: 'nava@example.com',
    ownerHeaderValue: 'nava@example.com',
  });
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: '<root@example.com>',
    subject: 'Booking',
    snippet: 'Need help',
    latestMessageAt: new Date('2026-07-06T10:00:00Z'),
  });
  await db.insert(message).values({
    id: parentMessageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.com',
    toAddresses: ['nava@example.com'],
    subject: 'Booking',
    textBody: 'Need help',
    receivedAt: new Date('2026-07-06T10:00:00Z'),
  });

  const caller = appRouter.createCaller({
    source: 'test',
    sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
    activeTransportId: transportId,
  } as never);

  return { db, caller, transportId, threadId, parentMessageId };
}

describe('AI draft promotion contract', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraftRevision);
    await db.delete(mailDraft);
    await db.delete(aiDraftGeneration);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('returns the existing active draft instead of promoting an AI candidate', async () => {
    const { caller, db, transportId, threadId, parentMessageId } = await seedThread();
    const activeDraftId = randomUUID();
    const candidateDraftId = randomUUID();
    const generationId = randomUUID();

    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [parentMessageId],
      model: 'gpt-5.5',
      promptVersion: 'hotel-reply-v1',
    });
    await db.insert(mailDraft).values([
      {
        id: activeDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Human draft',
      },
      {
        id: candidateDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'AI candidate',
      },
    ]);

    await expect(
      caller.drafts.ensureEditableForReply({ threadId, replyToMessageId: parentMessageId }),
    ).resolves.toMatchObject({
      id: activeDraftId,
      status: 'active',
      origin: 'manual',
    });

    const candidateRows = await db
      .select()
      .from(mailDraft)
      .where(eq(mailDraft.id, candidateDraftId));
    expect(candidateRows[0]?.status).toBe('candidate');
  });

  it('promotes the newest AI candidate for the reply parent and discards older sibling candidates', async () => {
    const { caller, db, transportId, threadId, parentMessageId } = await seedThread();
    const olderDraftId = randomUUID();
    const newestDraftId = randomUUID();
    const olderGenerationId = randomUUID();
    const newestGenerationId = randomUUID();
    await seedUser(db);

    await db.insert(aiDraftGeneration).values([
      {
        id: olderGenerationId,
        transportId,
        threadId,
        requestedByUserId: 'user-1',
        contextMessageIds: [parentMessageId],
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v1',
        createdAt: new Date('2026-07-06T10:01:00Z'),
      },
      {
        id: newestGenerationId,
        transportId,
        threadId,
        requestedByUserId: 'user-1',
        contextMessageIds: [parentMessageId],
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v2',
        createdAt: new Date('2026-07-06T10:02:00Z'),
      },
    ]);
    await db.insert(mailDraft).values([
      {
        id: olderDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'candidate',
        origin: 'ai',
        generationId: olderGenerationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Older AI candidate',
        updatedAt: new Date('2026-07-06T10:01:00Z'),
      },
      {
        id: newestDraftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        status: 'candidate',
        origin: 'ai',
        generationId: newestGenerationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Newest AI candidate',
        updatedAt: new Date('2026-07-06T10:02:00Z'),
      },
    ]);

    const promoted = await caller.drafts.ensureEditableForReply({
      threadId,
      replyToMessageId: parentMessageId,
    });

    expect(promoted).toMatchObject({
      id: newestDraftId,
      status: 'active',
      origin: 'ai',
      generationId: newestGenerationId,
      content: 'Newest AI candidate',
    });

    const rows = await db
      .select()
      .from(mailDraft)
      .where(
        and(
          eq(mailDraft.transportId, transportId),
          eq(mailDraft.threadId, threadId),
        ),
      );
    expect(rows.find((draft) => draft.id === olderDraftId)?.status).toBe('discarded');
    expect(rows.find((draft) => draft.id === newestDraftId)?.status).toBe('active');

    const revisions = await db.select().from(mailDraftRevision);
    expect(revisions).toContainEqual(
      expect.objectContaining({
        draftId: newestDraftId,
        generationId: newestGenerationId,
        kind: 'promoted',
        textBody: 'Newest AI candidate',
      }),
    );
  });

  it('rejects AI promotion without a concrete reply parent', async () => {
    const { caller, threadId } = await seedThread();

    await expect(
      caller.drafts.ensureEditableForReply({ threadId, replyToMessageId: null }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run:

```bash
pnpm --filter=@zero/server test -- draft-thread-contract draft-stale-conflict draft-sequential-replies-contract draft-ai-promotion-contract
```

Expected: FAIL because `replyToMessageId`, plural `drafts`, visible draft status filtering, `confirmStaleDraft`, `ensureEditableForReply`, promotion, sibling discard, and revision writes are not implemented.

- [ ] **Step 6: Extend draft and send inputs**

In `apps/server-pilot/src/trpc/wire-compat.ts`, add to `sendInput`:

```ts
    confirmStaleDraft: z.boolean().optional().default(false),
```

Then add to the `sendInput` transform result:

```ts
    confirmStaleDraft: input.confirmStaleDraft,
```

In `createDraftInput`, add:

```ts
    replyToMessageId: z.string().nullable().optional(),
```

Then add to the `createDraftInput` transform result:

```ts
    replyToMessageId: input.replyToMessageId ?? null,
```

- [ ] **Step 7: Add shared draft mapping helper**

Create `apps/server-pilot/src/trpc/routes/draft-wire.ts`:

```ts
import type { mailDraft } from '../../db/schema/mail.js';

function toDraftWire(r: typeof mailDraft.$inferSelect, isStale = false) {
  return {
    id: r.id,
    threadId: r.threadId,
    replyToMessageId: r.replyToMessageId,
    to: r.toAddresses,
    cc: r.ccAddresses,
    bcc: r.bccAddresses,
    subject: r.subject,
    content: r.textBody ?? r.htmlBody,
    updatedAt: r.updatedAt.toISOString(),
    status: r.status,
    origin: r.origin,
    generationId: r.generationId,
    isStale,
  };
}

export { toDraftWire };
```

In `apps/server-pilot/src/trpc/routes/drafts.ts` and `apps/server-pilot/src/trpc/routes/mail.ts`, import:

```ts
import { toDraftWire } from './draft-wire.js';
```

- [ ] **Step 8: Extend drafts.list and draft writes**

In `apps/server-pilot/src/trpc/routes/drafts.ts`, extend imports:

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { mailDraft, mailDraftRevision } from '../../db/schema/mail.js';
```

Update `drafts.get` to return the same expanded `ParsedDraft` fields via `toDraftWire(r)`, including `threadId`, `replyToMessageId`, `status`, `origin`, `generationId`, `updatedAt`, and `isStale: false`. Frontend refresh/reopen depends on these fields.

Add `threadId` to the `list` input:

```ts
        threadId: z.string().optional(),
```

Keep `eq(mailDraft.isSent, false)` for compatibility and add:

```ts
        inArray(mailDraft.status, ['active', 'candidate']),
```

After `conditions` is created, add:

```ts
      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
        conditions.push(eq(mailDraft.threadId, input.threadId));
      }
```

Map each returned row with `toDraftWire(r)`.

In `drafts.create`, set:

```ts
        replyToMessageId: input.replyToMessageId,
        status: 'active' as const,
        origin: 'manual' as const,
```

After inserting a new draft, insert the initial revision:

```ts
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId,
          actorUserId: ctx.sessionUser.id,
          kind: 'created',
          toAddresses: input.to,
          ccAddresses: input.cc,
          bccAddresses: input.bcc,
          subject: input.subject || null,
          textBody: input.html || null,
          htmlBody: input.html || null,
          attachments: [],
        });
```

In `drafts.update`, allow `replyToMessageId` in input. After the update, insert an `edited` revision only when the merged draft snapshot meaningfully changed from the latest revision for that draft:

```ts
const latestRevision = await db
  .select()
  .from(mailDraftRevision)
  .where(eq(mailDraftRevision.draftId, input.id))
  .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
  .limit(1);

const changed =
  latestRevision[0]?.subject !== merged.subject ||
  latestRevision[0]?.textBody !== merged.textBody ||
  latestRevision[0]?.htmlBody !== merged.htmlBody ||
  JSON.stringify(latestRevision[0]?.toAddresses ?? []) !== JSON.stringify(merged.toAddresses ?? []) ||
  JSON.stringify(latestRevision[0]?.ccAddresses ?? []) !== JSON.stringify(merged.ccAddresses ?? []) ||
  JSON.stringify(latestRevision[0]?.bccAddresses ?? []) !== JSON.stringify(merged.bccAddresses ?? []);

if (changed) {
  await db.insert(mailDraftRevision).values({
    id: randomUUID(),
    draftId: input.id,
    generationId: merged.generationId,
    actorUserId: ctx.sessionUser.id,
    kind: 'edited',
    toAddresses: merged.toAddresses,
    ccAddresses: merged.ccAddresses,
    bccAddresses: merged.bccAddresses,
    subject: merged.subject,
    textBody: merged.textBody,
    htmlBody: merged.htmlBody,
    attachments: merged.attachments ?? [],
  });
}
```

`merged` is the draft row after applying the patch. Do not insert an `edited` revision for no-op autosave ticks.

Update `drafts.delete` so user deletion lifecycle-discards visible drafts:

```ts
await db
  .update(mailDraft)
  .set({ status: 'discarded', updatedAt: new Date() })
  .where(
    and(
      eq(mailDraft.id, input.id),
      eq(mailDraft.transportId, transportId),
      inArray(mailDraft.status, ['active', 'candidate']),
    ),
  );
return { deleted: true };
```

Do not physically delete draft rows from `drafts.delete`; tests may still hard-delete rows during cleanup.

- [ ] **Step 9: Add ensureEditableForReply promotion mutation**

In `apps/server-pilot/src/trpc/routes/drafts.ts`, add this mutation after `get` and before `create`:

```ts
  ensureEditableForReply: mailboxProcedure
    .input(
      z.object({
        threadId: z.string(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      if (!input.replyToMessageId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
      }
      await requireThreadForTransport(db, input.threadId, transportId);
      const replyParent = await requireMessageForTransport(db, input.replyToMessageId, transportId);
      if (replyParent.threadId !== input.threadId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_THREAD_MISMATCH' });
      }

      try {
        const promoted = await db.transaction(async (tx) => {
          const activeRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'active'),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const activeDraft = activeRows[0];
          if (activeDraft) return activeDraft;

          const candidateRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, input.replyToMessageId),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const candidate = candidateRows[0];
          if (!candidate) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
          }

          await tx
            .update(mailDraft)
            .set({ status: 'discarded', updatedAt: new Date() })
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, input.replyToMessageId),
                sql`${mailDraft.id} <> ${candidate.id}`,
              ),
            );

          await tx
            .update(mailDraft)
            .set({ status: 'active', updatedAt: new Date() })
            .where(and(eq(mailDraft.id, candidate.id), eq(mailDraft.transportId, transportId)));

          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: candidate.id,
            generationId: candidate.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'promoted',
            toAddresses: candidate.toAddresses,
            ccAddresses: candidate.ccAddresses,
            bccAddresses: candidate.bccAddresses,
            subject: candidate.subject,
            textBody: candidate.textBody,
            htmlBody: candidate.htmlBody,
            attachments: [],
          });
          return { ...candidate, status: 'active' as const, updatedAt: new Date() };
        });
        return toDraftWire(promoted);
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) throw error;
        const activeRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.threadId, input.threadId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
          .limit(1);
        if (activeRows[0]) return toDraftWire(activeRows[0]);
        throw error;
      }
    }),
```

This mutation is the only place AI candidates become editable. Do not promote from `mail.get`; reads must stay read-only.
Define or reuse an `isPostgresUniqueViolation(error)` helper in `drafts.ts` so concurrent editor opens return the active draft instead of surfacing a database unique-index error.

- [ ] **Step 10: Return plural drafts from mail.get**

In `apps/server-pilot/src/trpc/routes/mail.ts`, use `inArray` from Drizzle:

```ts
import { and, eq, asc, desc, isNotNull, isNull, inArray, sql, exists, or, lte } from 'drizzle-orm';
```

Extend the schema import in `apps/server-pilot/src/trpc/routes/mail.ts` with:

```ts
  mailDraftRevision,
```

Inside `mail.get`, after `messages` load and before the return object, add:

```ts
      const draftRows = await db
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.threadId, input.id),
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.isSent, false),
            inArray(mailDraft.status, ['active', 'candidate']),
          ),
        )
        .orderBy(
          sql`CASE ${mailDraft.status} WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END`,
          desc(mailDraft.updatedAt),
          desc(mailDraft.id),
        );

      const messageById = new Map(messages.map((row) => [row.id, row]));
      const latestInbound = messages
        .filter((row) => row.direction === 'inbound')
        .toSorted((a, b) => {
          const aTime = (a.receivedAt ?? a.createdAt).getTime();
          const bTime = (b.receivedAt ?? b.createdAt).getTime();
          return bTime - aTime;
        })[0];
      const latestInboundTime = latestInbound?.receivedAt ?? latestInbound?.createdAt ?? null;

      const drafts = draftRows.map((draft) => {
        const parent = draft.replyToMessageId ? messageById.get(draft.replyToMessageId) : undefined;
        const parentTime = parent?.receivedAt ?? parent?.sentAt ?? parent?.createdAt ?? null;
        const isStale =
          parentTime !== null &&
          latestInboundTime !== null &&
          latestInboundTime.getTime() > parentTime.getTime();
        return toDraftWire(draft, isStale);
      });
```

Then replace the old return field with:

```ts
        drafts,
```

- [ ] **Step 11: Hydrate real draft indicators in thread lists**

In `apps/server-pilot/src/trpc/routes/mail.ts`, after list query `rows` are loaded, replace any placeholder `hasDraft: false` / `draftCount: 0` implementation with a grouped visible-draft count:

```ts
      const threadIds = rows.map((row) => row.id);
      const draftCountRows =
        threadIds.length > 0
          ? await db
              .select({
                threadId: mailDraft.threadId,
                count: sql<number>`count(*)::int`,
              })
              .from(mailDraft)
              .where(
                and(
                  eq(mailDraft.transportId, transportId),
                  inArray(mailDraft.threadId, threadIds),
                  eq(mailDraft.isSent, false),
                  inArray(mailDraft.status, ['active', 'candidate']),
                ),
              )
              .groupBy(mailDraft.threadId)
          : [];

      const draftCountByThread = new Map(
        draftCountRows
          .filter((row): row is { threadId: string; count: number } => Boolean(row.threadId))
          .map((row) => [row.threadId, row.count]),
      );
```

Then every returned thread object must include:

```ts
hasDraft: (draftCountByThread.get(row.id) ?? 0) > 0,
draftCount: draftCountByThread.get(row.id) ?? 0,
```

Extend `apps/server-pilot/tests/mail-category-filter.test.ts` or `apps/server-pilot/tests/draft-thread-contract.test.ts` to seed one active draft and assert the list row returns `hasDraft: true` and `draftCount: 1`.

- [ ] **Step 12: Add stale check before SMTP send**

In `apps/server-pilot/src/trpc/routes/mail.ts`, inside `send` after `threadId` is known but before `getSmtpTransport().send`, add:

```ts
      let sendingDraft: typeof mailDraft.$inferSelect | null = null;
      if (input.draftId) {
        const draftRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.id, input.draftId),
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .limit(1);
        sendingDraft = draftRows[0] ?? null;
        if (!sendingDraft) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
        }
        if (threadId && sendingDraft.replyToMessageId) {
          const parentRows = await db
            .select({ receivedAt: message.receivedAt, sentAt: message.sentAt, createdAt: message.createdAt })
            .from(message)
            .where(
              and(
                eq(message.id, sendingDraft.replyToMessageId),
                eq(message.transportId, transportId),
                eq(message.threadId, threadId),
              ),
            )
            .limit(1);
          const parent = parentRows[0];
          const parentTime = parent?.receivedAt ?? parent?.sentAt ?? parent?.createdAt ?? null;
          const newerInboundRows = parentTime
            ? await db
                .select({ id: message.id })
                .from(message)
                .where(
                  and(
                    eq(message.threadId, threadId),
                    eq(message.transportId, transportId),
                    eq(message.direction, 'inbound'),
                    sql`COALESCE(${message.receivedAt}, ${message.createdAt}) > ${parentTime}`,
                  ),
                )
                .limit(1)
            : [];
          if (newerInboundRows.length > 0 && !input.confirmStaleDraft) {
            throw new TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' });
          }
        }
      }
```

After outbound `message` insert and existing draft update, set lifecycle fields and insert final revision:

```ts
            status: 'sent',
            sentMessageId: messageId,
```

Then add:

```ts
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId: input.draftId,
          sentMessageId: messageId,
          actorUserId: ctx.sessionUser.id,
          kind: 'sent',
          toAddresses: input.to,
          ccAddresses: input.cc,
          bccAddresses: input.bcc,
          subject: input.subject || null,
          textBody: input.text || null,
          htmlBody: input.html || null,
          attachments: [],
        });
```

- [ ] **Step 13: Run draft tests**

Run:

```bash
pnpm --filter=@zero/server test -- draft-thread-contract draft-stale-conflict draft-sequential-replies-contract draft-ai-promotion-contract list-pagination
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/server-pilot/src/trpc/wire-compat.ts apps/server-pilot/src/trpc/routes/draft-wire.ts apps/server-pilot/src/trpc/routes/drafts.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/draft-thread-contract.test.ts apps/server-pilot/tests/draft-stale-conflict.test.ts apps/server-pilot/tests/draft-sequential-replies-contract.test.ts apps/server-pilot/tests/draft-ai-promotion-contract.test.ts
git commit -m "feat: expose plural draft lifecycle contract"
```

---

## Task 8: Wire Live Draft Folder and Thread Draft Section in Frontend

**Files:**
- Create: `apps/mail/lib/mail/thread-list-query-policy.ts`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `apps/mail/components/mail/thread-draft-card.tsx`
- Test: `apps/mail/tests/thread-draft-view-model.test.ts`
- Create: `apps/mail/tests/live-draft-folder.test.ts`

**Interfaces:**
- Consumes: `ThreadDetailResponse.drafts`.
- Consumes: `drafts.list({ q, cursor, limit })`.
- Produces: live Drafts folder using `drafts.list` instead of `mail.listThreads({ folder: 'draft' })`.
- Produces: active editable draft card first, including promoted AI-origin active drafts, with remaining AI candidate draft summaries below it.

- [ ] **Step 1: Write failing live draft folder test**

Create `apps/mail/tests/live-draft-folder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { selectLiveThreadListQuery } from '../lib/mail/thread-list-query-policy';

describe('live draft folder query policy', () => {
  it('uses drafts.list for live Drafts folder', () => {
    expect(selectLiveThreadListQuery({ folder: 'draft', demoMode: false, listEnabled: true })).toEqual({
      useDraftsList: true,
      useMailListThreads: false,
    });
    expect(selectLiveThreadListQuery({ folder: 'inbox', demoMode: false, listEnabled: true })).toEqual({
      useDraftsList: false,
      useMailListThreads: true,
    });
    expect(selectLiveThreadListQuery({ folder: 'draft', demoMode: true, listEnabled: true })).toEqual({
      useDraftsList: false,
      useMailListThreads: false,
    });
  });
});
```

- [ ] **Step 2: Run current thread draft tests**

Run:

```bash
pnpm --filter=@zero/mail test -- thread-draft-view-model live-draft-folder
```

Expected: `live-draft-folder` PASS as a policy fixture and `thread-draft-view-model` may fail until `useThread` consumes plural `drafts`.

- [ ] **Step 3: Change type import**

In `apps/mail/hooks/use-threads.ts`, replace:

```ts
import type { IGetThreadResponse } from '../../server/src/lib/driver/types';
```

with:

```ts
import type { IGetThreadResponse } from '@zero/server/driver/types';
```

- [ ] **Step 4: Add live drafts query**

Create `apps/mail/lib/mail/thread-list-query-policy.ts`:

```ts
export function selectLiveThreadListQuery(input: {
  folder: string | undefined;
  demoMode: boolean;
  listEnabled: boolean;
}) {
  const liveDraftFolder = !input.demoMode && input.listEnabled && input.folder === 'draft';
  return {
    useDraftsList: liveDraftFolder,
    useMailListThreads: !input.demoMode && input.listEnabled && !liveDraftFolder,
  };
}
```

In `useThreads`, import `selectLiveThreadListQuery` and add:

```ts
  const liveThreadListQuery = selectLiveThreadListQuery({
    folder: canonicalRouteFolder,
    demoMode,
    listEnabled,
  });
  const liveDraftFolder = liveThreadListQuery.useDraftsList;

  const liveDraftsQuery = useInfiniteQuery(
    trpc.drafts.list.infiniteQueryOptions(
      {
        q: searchValue.value,
        limit: 50,
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        enabled: liveDraftFolder,
        staleTime: 60 * 1000,
        refetchOnMount: false,
      },
    ),
  );
```

Then change `threadsQuery` `enabled` to:

```ts
        enabled: liveThreadListQuery.useMailListThreads,
```

Then change `activeThreadsQuery` to:

```ts
  const activeThreadsQuery = demoMode
    ? demoDraftFolder
      ? demoDraftsQuery
      : demoThreadsQuery
    : liveDraftFolder
      ? liveDraftsQuery
      : threadsQuery;
```

- [ ] **Step 5: Consume plural drafts directly**

In `useThread`, replace the `latestDraft` calculation:

```ts
    const latestDraft = threadData.latest?.id
      ? threadData.messages.findLast((message: IGetThreadResponse['messages'][number]) => message.isDraft)
      : undefined;
```

with:

```ts
    const drafts = threadData.drafts ?? [];
    const activeDraft = drafts.find((draft) => draft.status === 'active');
    const aiDraftCandidates = drafts.filter(
      (draft) => draft.origin === 'ai' && draft.status === 'candidate',
    );
```

Keep `nonDraftMessages` filtering because demo mode can still contain draft pseudo-messages.

Update the return object from `useThread` to include:

```ts
  return {
    ...activeThreadQuery,
    data: finalData,
    isGroupThread,
    latestDraft: activeDraft,
    drafts,
    aiDraftCandidates,
    isThreadDataMismatch,
  };
```

Keep `latestDraft` as a frontend alias for the active draft only so existing single-card call sites do not break in this task.

- [ ] **Step 6: Extend draft view model for AI candidates**

In `apps/mail/lib/mail/thread-draft-view-model.ts`, change the input type from only `ParsedMessage` to `ParsedDraft | ParsedMessage` and add fields:

```ts
export type ThreadDraftViewModel = {
  id: string;
  subject: string;
  bodyPreview: string;
  savedAtIso: string;
  origin: 'manual' | 'ai';
  status: 'active' | 'candidate' | 'discarded' | 'sent';
  isStale: boolean;
};
```

For pilot drafts, build from `ParsedDraft.content`, `ParsedDraft.updatedAt`, `ParsedDraft.origin`, `ParsedDraft.status`, and `ParsedDraft.isStale`. Keep the old `ParsedMessage.isDraft` branch for demo mode only.

- [ ] **Step 7: Render active draft and remaining AI candidates**

In `apps/mail/components/mail/thread-display.tsx`, keep the existing `ThreadDraftCard` for the active draft. The active draft can be manual or promoted AI-origin; both are editable because `status='active'` is the user-owned draft state.

Below the active draft, render `aiDraftCandidates.map(...)` as collapsed read-only summaries:

```tsx
draftBadge="AI draft"
unsentNotice="Candidate reply. Open the reply editor to use the newest AI draft when no active draft exists."
isReadOnly
```

Do not add `Use this AI draft`, `Replace active draft`, or `Discard AI draft` buttons. Promotion happens only through `drafts.ensureEditableForReply` when opening the editor; explicit candidate action buttons are separate product work.

- [ ] **Step 8: Run frontend tests**

Run:

```bash
pnpm --filter=@zero/mail test -- thread-draft-view-model live-draft-folder
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/mail/lib/mail/thread-list-query-policy.ts apps/mail/hooks/use-threads.ts apps/mail/components/mail/thread-display.tsx apps/mail/components/mail/thread-draft-card.tsx apps/mail/lib/mail/thread-draft-view-model.ts apps/mail/tests/thread-draft-view-model.test.ts apps/mail/tests/live-draft-folder.test.ts
git commit -m "feat: wire live draft folder to drafts router"
```

---

## Task 9: Add Refresh-Safe Draft Persistence

**Files:**
- Modify: `apps/mail/components/create/email-composer.tsx`
- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/components/mail/reply-composer.tsx`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Modify: `apps/mail/hooks/use-drafts.ts`
- Create: `apps/mail/lib/mail/draft-persistence.ts`
- Create: `apps/mail/tests/draft-persistence.test.ts`
- Create: `apps/mail/tests/stale-draft-send-flow.test.ts`

**Interfaces:**
- Consumes: `ParsedDraft.id`, `threadId`, `replyToMessageId`, `content`, `subject`, `to`, `cc`, `bcc`, `updatedAt`, and `isStale`.
- Consumes: `drafts.ensureEditableForReply({ threadId, replyToMessageId })`.
- Produces: early server-backed `draftId` for partial drafts.
- Produces: editor-open AI candidate promotion when no active draft exists.
- Produces: `replyToMessageId` in `drafts.create` / `drafts.update` calls for replies.
- Produces: dirty-state protection so late `useDraft` or `mail.get` refetches do not overwrite local unsaved edits.
- Produces: stale-send confirmation retry using `confirmStaleDraft: true`.
- Produces: query invalidation after draft create/update/send/delete for `drafts.get`, `drafts.list`, `mail.get(threadId)`, and `mail.listThreads` draft indicators.

- [ ] **Step 1: Write failing draft persistence tests**

Create `apps/mail/tests/draft-persistence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildDraftMutationInput,
  chooseDraftEditorState,
  shouldEnsureEditableDraftForReply,
  shouldPersistDraft,
} from '../lib/mail/draft-persistence';

describe('draft persistence', () => {
  it('persists partial draft bodies before recipients or subject exist', () => {
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>Need to answer guest about late checkout</p>',
        text: 'Need to answer guest about late checkout',
        to: [],
        subject: '',
        aiBlocked: false,
      }),
    ).toBe(true);
  });

  it('does not persist unchanged or AI-owned transient content', () => {
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: false,
        initialHtml: '<p>Same</p>',
        html: '<p>Same</p>',
        text: 'Same',
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        aiBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>AI pending</p>',
        text: 'AI pending',
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        aiBlocked: true,
      }),
    ).toBe(false);
  });

  it('includes thread and reply parent when saving a reply draft', () => {
    expect(
      buildDraftMutationInput({
        draftId: 'draft-1',
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: Booking',
        html: '<p>Reply text</p>',
        fromEmail: 'nava@example.com',
        attachments: [],
      }),
    ).toMatchObject({
      id: 'draft-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-2',
      to: 'guest@example.com',
      subject: 'Re: Booking',
      body: '<p>Reply text</p>',
    });
  });

  it('does not overwrite dirty local editor state with late server data', () => {
    const result = chooseDraftEditorState({
      isDirty: true,
      localHtml: '<p>Human typed after load</p>',
      localSubject: 'Local subject',
      serverDraft: {
        content: '<p>Older server draft</p>',
        subject: 'Server subject',
        updatedAt: '2026-07-06T10:00:00.000Z',
      },
    });

    expect(result).toEqual({
      html: '<p>Human typed after load</p>',
      subject: 'Local subject',
      source: 'local-dirty',
    });
  });

  it('requests AI candidate promotion only when editor opens without an active draft', () => {
    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({
      shouldEnsure: true,
      threadId: 'thread-1',
      replyToMessageId: 'msg-2',
    });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: 'draft-active',
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: true,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: null,
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });
  });
});
```

- [ ] **Step 2: Write failing stale-send flow test**

Create `apps/mail/tests/stale-draft-send-flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getStaleDraftRetryInput, isStaleDraftConflict } from '../lib/mail/draft-persistence';

describe('stale draft send flow', () => {
  it('recognizes server stale draft conflicts', () => {
    expect(isStaleDraftConflict({ data: { code: 'CONFLICT' }, message: 'STALE_DRAFT' })).toBe(true);
    expect(isStaleDraftConflict({ data: { code: 'BAD_REQUEST' }, message: 'STALE_DRAFT' })).toBe(false);
  });

  it('retries the same send input with explicit stale confirmation', () => {
    expect(
      getStaleDraftRetryInput({
        threadId: 'thread-1',
        draftId: 'draft-1',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: Booking',
        message: '<p>Reply</p>',
      }),
    ).toMatchObject({
      threadId: 'thread-1',
      draftId: 'draft-1',
      confirmStaleDraft: true,
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter=@zero/mail test -- draft-persistence stale-draft-send-flow
```

Expected: FAIL because `apps/mail/lib/mail/draft-persistence.ts` does not exist.

- [ ] **Step 4: Add draft persistence helper**

Create `apps/mail/lib/mail/draft-persistence.ts`:

```ts
type DraftMutationInput = {
  draftId: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  fromEmail?: string;
  attachments: unknown[];
};

type PersistDecisionInput = {
  hasUnsavedChanges: boolean;
  initialHtml: string;
  html: string;
  text: string;
  to: string[];
  subject: string;
  aiBlocked: boolean;
};

type DraftEditorStateInput = {
  isDirty: boolean;
  localHtml: string;
  localSubject: string;
  serverDraft?: {
    content?: string | null;
    subject?: string | null;
    updatedAt?: string | null;
  } | null;
};

type EnsureEditableDraftInput = {
  demoMode: boolean;
  threadId: string | null;
  replyToMessageId: string | null;
  activeDraftId: string | null;
  aiCandidateCount: number;
};

export function shouldPersistDraft(input: PersistDecisionInput): boolean {
  if (!input.hasUnsavedChanges || input.aiBlocked) return false;
  if (input.html.trim() === input.initialHtml.trim()) return false;
  return (
    input.text.trim().length > 0 ||
    input.subject.trim().length > 0 ||
    input.to.length > 0
  );
}

export function buildDraftMutationInput(input: DraftMutationInput) {
  return {
    id: input.draftId ?? undefined,
    threadId: input.threadId ?? undefined,
    replyToMessageId: input.replyToMessageId ?? undefined,
    to: input.to.join(', '),
    cc: input.cc.join(', '),
    bcc: input.bcc.join(', '),
    subject: input.subject,
    body: input.html,
    message: input.html,
    attachments: input.attachments,
    fromEmail: input.fromEmail,
  };
}

export function chooseDraftEditorState(input: DraftEditorStateInput) {
  if (input.isDirty) {
    return {
      html: input.localHtml,
      subject: input.localSubject,
      source: 'local-dirty' as const,
    };
  }
  return {
    html: input.serverDraft?.content ?? input.localHtml,
    subject: input.serverDraft?.subject ?? input.localSubject,
    source: 'server' as const,
  };
}

export function shouldEnsureEditableDraftForReply(input: EnsureEditableDraftInput):
  | { shouldEnsure: true; threadId: string; replyToMessageId: string }
  | { shouldEnsure: false } {
  if (
    input.demoMode ||
    !input.threadId ||
    !input.replyToMessageId ||
    input.activeDraftId ||
    input.aiCandidateCount === 0
  ) {
    return { shouldEnsure: false };
  }
  return {
    shouldEnsure: true,
    threadId: input.threadId,
    replyToMessageId: input.replyToMessageId,
  };
}

export function isStaleDraftConflict(error: unknown): boolean {
  const maybe = error as { data?: { code?: string }; message?: string };
  return maybe.data?.code === 'CONFLICT' && maybe.message === 'STALE_DRAFT';
}

export function getStaleDraftRetryInput<T extends object>(input: T): T & { confirmStaleDraft: true } {
  return { ...input, confirmStaleDraft: true };
}
```

- [ ] **Step 5: Update EmailComposer autosave to persist partial drafts**

In `apps/mail/components/create/email-composer.tsx`, import:

```ts
import {
  buildDraftMutationInput,
  shouldPersistDraft,
} from '@/lib/mail/draft-persistence';
```

Change `saveDraft` so it does not require recipients, subject, and body all at once. Replace the current guard block with:

```ts
    const messageText = editor.getText();
    const html = editor.getHTML();
    const aiBlocked = Boolean(aiGeneratedMessage || aiIsLoading || isGeneratingSubject);

    if (
      !shouldPersistDraft({
        hasUnsavedChanges,
        initialHtml: initialMessage,
        html,
        text: messageText,
        to: values.to,
        subject: values.subject,
        aiBlocked,
      })
    ) {
      return;
    }
```

Build `draftData` through `buildDraftMutationInput`, passing `threadId`, `replyToMessageId`, current recipients, subject, body, attachments, and from email. Preserve current behavior that stores the returned server `id` in `draftId`.

- [ ] **Step 6: Pass replyToMessageId into reply draft autosave**

In `apps/mail/components/create/email-composer.tsx`, add optional prop:

```ts
replyToMessageId?: string | null;
```

Include it in `buildDraftMutationInput`.

In `apps/mail/components/mail/reply-composer.tsx`, pass the parent message ID:

```tsx
        replyToMessageId={replyToMessage?.id ?? null}
```

This is the key stale-check link. Without it, the backend cannot know which inbound message the draft answered.

- [ ] **Step 7: Add frontend ensureEditableDraftForReply hook**

In `apps/mail/hooks/use-drafts.ts`, import `useMutation`:

```ts
import { useMutation, useQuery } from '@tanstack/react-query';
```

Then export:

```ts
export const useEnsureEditableDraftForReply = () => {
  const trpc = useTRPC();
  return useMutation(trpc.drafts.ensureEditableForReply.mutationOptions());
};
```

Call this hook only when `isFrontendOnlyDemo()` is false. Demo mode keeps local draft behavior and never calls the server-pilot promotion mutation.

- [ ] **Step 8: Rehydrate reopened drafts without clobbering local dirty state**

In `apps/mail/hooks/use-drafts.ts`, return `threadId`, `replyToMessageId`, `updatedAt`, `status`, `origin`, `generationId`, and `isStale` from live `trpc.drafts.get`.

In `apps/mail/components/create/email-composer.tsx`, use `chooseDraftEditorState` when draft data arrives after mount. If local editor is dirty, keep local editor state and show no replacement. If local editor is clean, hydrate from server draft content and subject.

- [ ] **Step 9: Auto-promote AI candidate when reply editor opens without active draft**

In `apps/mail/components/mail/reply-composer.tsx`, extend imports:

```ts
import { useDraft, useEnsureEditableDraftForReply } from '@/hooks/use-drafts';
import { shouldEnsureEditableDraftForReply } from '@/lib/mail/draft-persistence';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
```

Change the `useThread` destructuring to include AI candidates:

```ts
  const { data: emailData, refetch, latestDraft, aiDraftCandidates } = useThread(threadId);
```

Add the mutation and a loop guard near existing hooks:

```ts
  const { mutateAsync: ensureEditableDraftForReply } = useEnsureEditableDraftForReply();
  const ensuredDraftKeyRef = useRef<string | null>(null);
```

Add this effect after `replyToMessage` is derived:

```ts
  useEffect(() => {
    const decision = shouldEnsureEditableDraftForReply({
      demoMode: isFrontendOnlyDemo(),
      threadId,
      replyToMessageId: replyToMessage?.id ?? null,
      activeDraftId: latestDraft?.id ?? null,
      aiCandidateCount: aiDraftCandidates?.length ?? 0,
    });

    if (!decision.shouldEnsure) return;

    const ensureKey = `${decision.threadId}:${decision.replyToMessageId ?? 'none'}`;
    if (ensuredDraftKeyRef.current === ensureKey) return;
    ensuredDraftKeyRef.current = ensureKey;

    void ensureEditableDraftForReply({
      threadId: decision.threadId,
      replyToMessageId: decision.replyToMessageId,
    }).then((editableDraft) => {
      setDraftId(editableDraft.id);
      void refetch();
    });
  }, [
    aiDraftCandidates?.length,
    ensureEditableDraftForReply,
    latestDraft?.id,
    refetch,
    replyToMessage?.id,
    setDraftId,
    threadId,
  ]);
```

This is the only frontend auto-promotion trigger. Opening a thread does not mutate drafts. Opening the reply editor asks the backend for the editable draft, so refresh after promotion reloads from the active server draft.

- [ ] **Step 10: Reopen live Drafts rows with thread affinity**

In `apps/mail/components/mail/mail-list.tsx`, update `Draft.handleMailClick`:

```ts
  const handleMailClick = useCallback(() => {
    if (draft?.threadId) {
      setMode('reply');
      setActiveReplyId(draft.replyToMessageId ?? null);
    } else {
      setMode(null);
      setActiveReplyId(null);
    }
    setComposeOpen('true');
    setDraftId(message.id);
  }, [draft?.replyToMessageId, draft?.threadId, message.id, setMode, setActiveReplyId, setComposeOpen, setDraftId]);
```

Drafts without `threadId` remain standalone compose drafts.

- [ ] **Step 11: Add stale confirmation retry in send flows**

In `apps/mail/components/create/create-email.tsx` and `apps/mail/components/mail/reply-composer.tsx`, catch stale draft conflicts with `isStaleDraftConflict(error)`.

On stale conflict:

1. Open confirmation UI with copy: `Newer messages arrived after this draft was started. Review latest reply before sending, or send anyway.`
2. If user cancels, keep composer open and do not clear draft state.
3. If user confirms, retry the same `mail.send` input with `getStaleDraftRetryInput(input)`.

Do not retry automatically without explicit confirmation.

- [ ] **Step 12: Invalidate draft and thread queries after draft writes**

After successful live draft create/update/send/delete/promote, invalidate:

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
  draftId
    ? queryClient.invalidateQueries({ queryKey: trpc.drafts.get.queryKey({ id: draftId }) })
    : Promise.resolve(),
  threadId
    ? queryClient.invalidateQueries({ queryKey: trpc.mail.get.queryKey({ id: threadId }) })
    : Promise.resolve(),
  queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
]);
```

This prevents the Drafts folder, thread draft section, and thread list `hasDraft` / `draftCount` indicators from drifting for up to the query `staleTime`.

- [ ] **Step 13: Run refresh-safe draft tests**

Run:

```bash
pnpm --filter=@zero/mail test -- draft-persistence stale-draft-send-flow
pnpm --filter=@zero/mail test -- thread-draft-view-model live-draft-folder
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/mail/components/create/email-composer.tsx apps/mail/components/create/create-email.tsx apps/mail/components/mail/reply-composer.tsx apps/mail/components/mail/mail-list.tsx apps/mail/hooks/use-drafts.ts apps/mail/lib/mail/draft-persistence.ts apps/mail/tests/draft-persistence.test.ts apps/mail/tests/stale-draft-send-flow.test.ts
git commit -m "feat: make draft persistence refresh safe"
```

---

## Task 10: Wire Frontend Pilot Capabilities

**Files:**
- Create: `apps/mail/lib/pilot/capabilities.ts`
- Modify: `apps/mail/components/ui/ai-sidebar.tsx`
- Modify: `apps/mail/components/ui/prompts-dialog.tsx`
- Modify: `apps/mail/components/mail/note-panel.tsx`
- Modify: `apps/mail/components/create/template-button.tsx`
- Modify: `apps/mail/components/ui/bimi-avatar.tsx`
- Test: `apps/mail/tests/pilot-capabilities.test.ts`

**Interfaces:**
- Produces: `PILOT_CAPABILITIES`.
- Consumes: backend `brain.getCapabilities()` when a component already has tRPC access; uses static fallback otherwise.

- [ ] **Step 1: Write failing capability test**

Create `apps/mail/tests/pilot-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PILOT_CAPABILITIES, shouldRenderLegacySurface } from '../lib/pilot/capabilities';

describe('pilot capabilities', () => {
  it('hides legacy-only surfaces in pilot mode', () => {
    expect(PILOT_CAPABILITIES).toMatchObject({
      ai: false,
      brain: false,
      notes: false,
      templates: false,
      bimi: false,
      gmailSearchGrammar: false,
      hotelCategories: true,
      staleDraftWarning: true,
    });

    expect(shouldRenderLegacySurface('ai')).toBe(false);
    expect(shouldRenderLegacySurface('notes')).toBe(false);
    expect(shouldRenderLegacySurface('templates')).toBe(false);
    expect(shouldRenderLegacySurface('bimi')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter=@zero/mail test -- pilot-capabilities
```

Expected: FAIL because `apps/mail/lib/pilot/capabilities.ts` does not exist.

- [ ] **Step 3: Create capability helper**

Create `apps/mail/lib/pilot/capabilities.ts`:

```ts
import type { PilotCapabilities } from '@zero/server/driver/types';

export const PILOT_CAPABILITIES = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: false,
  hotelCategories: true,
  staleDraftWarning: true,
} satisfies PilotCapabilities;

export type LegacySurface = 'ai' | 'brain' | 'notes' | 'templates' | 'bimi';

export function shouldRenderLegacySurface(surface: LegacySurface): boolean {
  return PILOT_CAPABILITIES[surface];
}
```

- [ ] **Step 4: Hide AI sidebar**

In `apps/mail/components/ui/ai-sidebar.tsx`, import:

```ts
import { shouldRenderLegacySurface } from '@/lib/pilot/capabilities';
```

At the start of the exported component, add:

```tsx
  if (!shouldRenderLegacySurface('ai')) {
    return null;
  }
```

Place this before any `useAgent` call so pilot mode never opens the Cloudflare Agents path.

- [ ] **Step 5: Hide notes/templates/BIMI UI**

Apply the same guard pattern:

```tsx
  if (!shouldRenderLegacySurface('notes')) {
    return null;
  }
```

to `apps/mail/components/mail/note-panel.tsx`.

Apply:

```tsx
  if (!shouldRenderLegacySurface('templates')) {
    return null;
  }
```

to `apps/mail/components/create/template-button.tsx`.

Apply:

```tsx
  if (!shouldRenderLegacySurface('bimi')) {
    return null;
  }
```

to `apps/mail/components/ui/bimi-avatar.tsx`.

- [ ] **Step 6: Run capability test**

Run:

```bash
pnpm --filter=@zero/mail test -- pilot-capabilities
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/lib/pilot/capabilities.ts apps/mail/components/ui/ai-sidebar.tsx apps/mail/components/ui/prompts-dialog.tsx apps/mail/components/mail/note-panel.tsx apps/mail/components/create/template-button.tsx apps/mail/components/ui/bimi-avatar.tsx apps/mail/tests/pilot-capabilities.test.ts
git commit -m "feat: hide pilot-inert legacy surfaces"
```

---

## Task 11: Add Frontend Category Navigation and Filters

**Files:**
- Create: `apps/mail/lib/mail/route-filter.ts`
- Modify: `apps/mail/hooks/use-categories.ts`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/config/navigation.ts`
- Test: `apps/mail/tests/search-filter-contract.test.ts`

**Interfaces:**
- Consumes: `trpc.categories.list`.
- Produces: `filters.categoryIds` passed to `mail.listThreads`.
- Keeps: system folder slugs reserved.

- [ ] **Step 1: Write failing category filter contract test**

Create `apps/mail/tests/search-filter-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveMailRouteFilter } from '../lib/mail/route-filter';

describe('mail route filter contract', () => {
  it('maps hotel category slug to structured category filter', () => {
    const result = resolveMailRouteFilter(
      'travel-agents',
      new Map([['travel-agents', 'cat-travel']]),
    );
    expect(result).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-travel'] },
    });
  });

  it('keeps system folders as folders', () => {
    const result = resolveMailRouteFilter('spam', new Map([['spam', 'cat-spam']]));
    expect(result).toEqual({ folder: 'spam', filters: {} });
  });
});
```

- [ ] **Step 2: Run test**

Run:

```bash
pnpm --filter=@zero/mail test -- search-filter-contract
```

Expected: PASS as a pinned contract fixture.

- [ ] **Step 3: Fetch live categories**

In `apps/mail/hooks/use-categories.ts`, use `useTRPC()` and `useQuery()` to fetch `trpc.categories.list.queryOptions()` in non-demo mode. Return existing default/demo categories in demo mode.

Implementation shape:

```ts
const trpc = useTRPC();
const liveCategoriesQuery = useQuery(
  trpc.categories.list.queryOptions(undefined, {
    enabled: !isFrontendOnlyDemo(),
    staleTime: 60_000,
  }),
);
```

Map each live category to the existing UI shape:

```ts
const liveCategories = liveCategoriesQuery.data?.map((category) => ({
  id: category.id,
  name: category.name,
  searchValue: category.id,
  slug: category.slug,
  color: category.color,
})) ?? [];
```

- [ ] **Step 4: Pass structured category filters from useThreads**

Create `apps/mail/lib/mail/route-filter.ts`:

```ts
const SYSTEM_FOLDERS = new Set([
  'inbox',
  'sent',
  'spam',
  'draft',
  'drafts',
  'archive',
  'archived',
  'bin',
  'starred',
  'snoozed',
  'all',
]);

export function resolveMailRouteFilter(
  folder: string | undefined,
  categoryBySlug: Map<string, string>,
): { folder: string; filters: { categoryIds?: string[] } } {
  const normalized = (folder ?? 'inbox').toLowerCase();
  if (SYSTEM_FOLDERS.has(normalized)) return { folder: normalized, filters: {} };
  const categoryId = categoryBySlug.get(normalized);
  if (categoryId) return { folder: 'inbox', filters: { categoryIds: [categoryId] } };
  return { folder: 'inbox', filters: {} };
}
```

In `apps/mail/hooks/use-threads.ts`, import `resolveMailRouteFilter`, build a category map from `useCategorySettings()`, and resolve the route folder:

```ts
const categoryBySlug = new Map(categories.map((category) => [category.slug, category.id]));
const routeFilter = resolveMailRouteFilter(canonicalRouteFolder, categoryBySlug);
```

Then pass:

```ts
folder: routeFilter.folder,
filters: {
  categoryIds: routeFilter.filters.categoryIds ?? [],
  labelIds: labels,
}
```

to `trpc.mail.listThreads.infiniteQueryOptions`.

- [ ] **Step 5: Enable category dropdown for mailbox**

In `apps/mail/components/mail/mail.tsx`, find the condition that requires:

```ts
activeConnection?.providerId === 'google'
```

Change it to:

```ts
['google', 'mailbox'].includes(activeConnection?.providerId ?? '')
```

- [ ] **Step 6: Run frontend category tests**

Run:

```bash
pnpm --filter=@zero/mail test -- search-filter-contract demo-folder-map
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/lib/mail/route-filter.ts apps/mail/hooks/use-categories.ts apps/mail/hooks/use-threads.ts apps/mail/components/mail/mail.tsx apps/mail/config/navigation.ts apps/mail/tests/search-filter-contract.test.ts
git commit -m "feat: wire live hotel category filters"
```

---

## Task 12: Replace Label-Based Folder Moves with State Actions

**Files:**
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Create: `apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/mail/ingest/store.ts`
- Modify: `apps/mail/lib/thread-actions.ts`
- Test: `apps/server-pilot/tests/mail-thread-actions.test.ts`
- Create: `apps/mail/tests/thread-actions-contract.test.ts`

**Interfaces:**
- Produces backend `mail.moveThreads({ threadIds, destination })`.
- Consumes frontend `moveThreadsTo({ threadIds, destination })`.
- Stores spam folder state in `mail_thread.spam_at`, not a user/system label mutation.

- [ ] **Step 1: Write failing frontend action contract test**

Create `apps/mail/tests/thread-actions-contract.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { moveThreadsTo } from '@/lib/thread-actions';
import { trpcClient } from '@/providers/query-provider';

vi.mock('@/providers/query-provider', () => ({
  trpcClient: {
    mail: {
      moveThreads: { mutate: vi.fn() },
      modifyLabels: { mutate: vi.fn() },
    },
  },
}));

describe('thread action contract', () => {
  it('uses moveThreads mutation for system folder moves', async () => {
    const payload = {
      threadIds: ['thread-1'],
      currentFolder: 'inbox',
      destination: 'spam',
    };
    await moveThreadsTo(payload);
    expect(trpcClient.mail.moveThreads.mutate).toHaveBeenCalledWith({
      threadIds: ['thread-1'],
      destination: 'spam',
    });
    expect(trpcClient.mail.modifyLabels.mutate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Add spam state schema and migration**

In `apps/server-pilot/src/db/schema/mail.ts`, add to `mailThread`:

```ts
    spamAt: timestamp('spam_at'),
```

Create `apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql`:

```sql
ALTER TABLE "mail_thread"
  ADD COLUMN IF NOT EXISTS "spam_at" timestamp;

UPDATE "mail_thread" AS thread
SET "spam_at" = COALESCE(thread."spam_at", thread."updated_at")
WHERE EXISTS (
  SELECT 1
  FROM "mail_label" AS label
  WHERE label."transport_id" = thread."transport_id"
    AND label."name" = 'SPAM'
    AND thread."label_ids" ? label."id"
);

CREATE INDEX IF NOT EXISTS "mail_thread_transport_spam_idx"
  ON "mail_thread" ("transport_id", "spam_at");
```

In `apps/server-pilot/src/mail/ingest/store.ts`, where fallback direct-to messages are currently stored with a `SPAM` label, set `mailThread.spamAt` during thread insert/update. Keeping the old `SPAM` label for backwards compatibility during backfill is allowed, but live folder listing and moves must use `spamAt`.

- [ ] **Step 3: Write backend action test**

Append to `apps/server-pilot/tests/mail-thread-actions.test.ts`:

```ts
it('moves threads between system states without label emulation', async () => {
  await withSeededTestDb(async (db) => {
    await seedActionThread(db);
    const caller = await callerFor('user-manager', { db });

    await caller.mail.moveThreads({ threadIds: [THREAD_ID], destination: 'spam' });
    const spam = await caller.mail.listThreads({ folder: 'spam', limit: 20 });
    expect(spam.threads.map((t) => t.id)).toContain(THREAD_ID);

    await caller.mail.moveThreads({ threadIds: [THREAD_ID], destination: 'inbox' });
    const inbox = await caller.mail.listThreads({ folder: 'inbox', limit: 20 });
    expect(inbox.threads.map((t) => t.id)).toContain(THREAD_ID);

    const rows = await db
      .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
      .from(mailThread)
      .where(eq(mailThread.id, THREAD_ID));
    expect(rows[0]?.spamAt).toBeNull();
    expect(rows[0]?.labelIds ?? []).not.toContain('SPAM');
  });
});
```

Insert this test inside the existing `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)` block so it can use the file's `seedActionThread`, `withSeededTestDb`, `callerFor`, and `THREAD_ID` declarations.

- [ ] **Step 4: Run tests to verify backend fails**

Run:

```bash
pnpm --filter=@zero/server test -- mail-thread-actions
pnpm --filter=@zero/mail test -- thread-actions-contract
```

Expected: server test FAIL because `moveThreads` / `spamAt` are missing; frontend test FAIL until `moveThreadsTo` uses the new mutation.

- [ ] **Step 5: Add backend move input**

In `apps/server-pilot/src/trpc/routes/mail.ts`, add near other input schemas:

```ts
const moveThreadsInput = z.object({
  threadIds: z.array(z.string()).min(1),
  destination: z.enum(['inbox', 'archive', 'spam', 'bin']),
});
```

- [ ] **Step 6: Add backend moveThreads mutation**

Inside `mailRouter`, add:

```ts
  moveThreads: mailboxProcedure
    .input(moveThreadsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, input.threadIds, transportId);
      if (visibleIds.length === 0) return { updated: 0 };

      const patch: Partial<typeof mailThread.$inferInsert> = { updatedAt: new Date() };
      if (input.destination === 'archive') {
        patch.isArchived = true;
        patch.trashedAt = null;
        patch.spamAt = null;
      }
      if (input.destination === 'bin') {
        patch.trashedAt = new Date();
      }
      if (input.destination === 'spam') {
        patch.spamAt = new Date();
        patch.trashedAt = null;
        patch.isArchived = false;
      }
      if (input.destination === 'inbox') {
        patch.isArchived = false;
        patch.trashedAt = null;
        patch.spamAt = null;
        patch.snoozedUntil = null;
      }

      await db
        .update(mailThread)
        .set(patch)
        .where(and(eq(mailThread.transportId, transportId), inArray(mailThread.id, visibleIds)));

      return { updated: visibleIds.length };
    }),
```

Also update `listThreads` folder conditions:

```ts
if (input.folder === 'spam') {
  conditions.push(isNotNull(mailThread.spamAt));
} else {
  conditions.push(isNull(mailThread.spamAt));
}
```

For `inbox`, keep existing `isArchived=false`, `trashedAt IS NULL`, and snooze conditions, but remove the old SPAM-label exclusion branch.

- [ ] **Step 7: Update frontend move helper**

Replace the body of `moveThreadsTo` in `apps/mail/lib/thread-actions.ts` with:

```ts
  try {
    if (!threadIds.length || !destination) return;
    if (!['inbox', 'archive', 'spam', 'bin'].includes(destination)) return;

    return trpcClient.mail.moveThreads.mutate({
      threadIds,
      destination,
    });
  } catch (error) {
    console.error(`Error moving thread(s):`, error);
    throw error;
  }
```

- [ ] **Step 8: Run action tests**

Run:

```bash
pnpm --filter=@zero/server test -- mail-thread-actions
pnpm --filter=@zero/mail test -- thread-actions-contract
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server-pilot/src/db/schema/mail.ts apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/mail/ingest/store.ts apps/server-pilot/tests/mail-thread-actions.test.ts apps/mail/lib/thread-actions.ts apps/mail/tests/thread-actions-contract.test.ts
git commit -m "feat: align folder move actions with pilot state"
```

---

## Task 13: Fix Existing Route Shape Drift

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/trpc/routes/labels.ts`
- Modify: `apps/mail/hooks/use-attachments.ts`
- Modify: `apps/mail/components/mail/email-verification-badge.tsx`
- Modify: `apps/mail/components/ui/recipient-autosuggest.tsx`
- Test: `apps/server-pilot/tests/mail-wire-contract.test.ts`

**Interfaces:**
- `mail.verifyEmail` returns `{ isVerified: boolean; messageId: string | null }`.
- `mail.getMessageAttachments` returns an attachment array.
- `mail.suggestRecipients` accepts `{ query: string }` and `{ q: string }`.
- Labels return `color` as either string or `null`; frontend unwraps consistently.

- [ ] **Step 1: Add failing shape test**

Append to `apps/server-pilot/tests/mail-wire-contract.test.ts`:

```ts
describe('existing route shape compatibility', () => {
  it('returns frontend-compatible verifyEmail and attachment shapes', async () => {
    const verify = await caller.mail.verifyEmail({ email: 'guest@example.com' });
    expect(verify).toEqual({ isVerified: false, messageId: null });

    const suggestions = await caller.mail.suggestRecipients({ query: 'guest' });
    expect(Array.isArray(suggestions)).toBe(true);
  });
});
```

Use the existing `caller` setup in the file. If the file does not define `caller`, create one using the same `appRouter.createCaller` pattern from Task 2.

- [ ] **Step 2: Run wire test to verify it fails**

Run:

```bash
pnpm --filter=@zero/server test -- mail-wire-contract
```

Expected: FAIL because one or more route shapes still use old names.

- [ ] **Step 3: Fix verifyEmail**

In `apps/server-pilot/src/trpc/routes/mail.ts`, change `verifyEmail` return shape from:

```ts
{ verified: false, messageId: null }
```

to:

```ts
{ isVerified: false, messageId: null }
```

- [ ] **Step 4: Accept query for suggestRecipients**

Change `suggestRecipients` input schema to:

```ts
    .input(z.object({ q: z.string().optional(), query: z.string().optional() }))
```

Then use:

```ts
      const search = (input.query ?? input.q ?? '').trim();
```

inside the resolver.

- [ ] **Step 5: Return attachment array directly**

In `getMessageAttachments`, change:

```ts
return { attachments };
```

to:

```ts
return attachments;
```

Update `apps/mail/hooks/use-attachments.ts` so it treats the query data as the array:

```ts
const attachments = data ?? [];
```

- [ ] **Step 6: Run shape tests**

Run:

```bash
pnpm --filter=@zero/server test -- mail-wire-contract mail-get-attachments labels-contract
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/trpc/routes/labels.ts apps/server-pilot/tests/mail-wire-contract.test.ts apps/mail/hooks/use-attachments.ts apps/mail/components/mail/email-verification-badge.tsx apps/mail/components/ui/recipient-autosuggest.tsx
git commit -m "fix: align existing pilot route shapes"
```

---

## Task 14: Clean Up Pilot Search UI Promises

**Files:**
- Modify: `apps/mail/components/context/command-palette-context.tsx`
- Modify: `apps/mail/hooks/use-search-value.ts`
- Modify: `apps/mail/lib/pilot/capabilities.ts`
- Test: `apps/mail/tests/search-filter-contract.test.ts`

**Interfaces:**
- Consumes: `PILOT_CAPABILITIES.gmailSearchGrammar`.
- Produces: no `trpc.ai.generateSearchQuery` call when grammar/AI is disabled.

- [ ] **Step 1: Add failing search capability test**

Append to `apps/mail/tests/search-filter-contract.test.ts`:

```ts
import { PILOT_CAPABILITIES } from '../lib/pilot/capabilities';

function canUseNaturalLanguageSearch() {
  return PILOT_CAPABILITIES.ai && PILOT_CAPABILITIES.gmailSearchGrammar;
}

describe('pilot search capability gates', () => {
  it('disables natural language and Gmail grammar search', () => {
    expect(canUseNaturalLanguageSearch()).toBe(false);
    expect(PILOT_CAPABILITIES.gmailSearchGrammar).toBe(false);
  });
});
```

- [ ] **Step 2: Run test**

Run:

```bash
pnpm --filter=@zero/mail test -- search-filter-contract
```

Expected: PASS if Task 9 landed; otherwise FAIL until `PILOT_CAPABILITIES` exists.

- [ ] **Step 3: Gate command palette AI search**

In `apps/mail/components/context/command-palette-context.tsx`, import:

```ts
import { PILOT_CAPABILITIES } from '@/lib/pilot/capabilities';
```

Find the code path that calls `trpc.ai.generateSearchQuery`. Wrap it:

```ts
if (!PILOT_CAPABILITIES.ai || !PILOT_CAPABILITIES.gmailSearchGrammar) {
  return;
}
```

Place the guard before creating or executing the mutation.

- [ ] **Step 4: Hide grammar copy**

In the same file, remove pilot-visible suggestions for:

```text
from:
to:
subject:
is:
after:
before:
label:
```

When copy must remain for demo or legacy paths, wrap it with:

```ts
if (PILOT_CAPABILITIES.gmailSearchGrammar) {
  // existing grammar suggestion registration
}
```

- [ ] **Step 5: Run frontend search test**

Run:

```bash
pnpm --filter=@zero/mail test -- search-filter-contract
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/components/context/command-palette-context.tsx apps/mail/hooks/use-search-value.ts apps/mail/lib/pilot/capabilities.ts apps/mail/tests/search-filter-contract.test.ts
git commit -m "fix: hide unsupported pilot search grammar"
```

---

## Task 15: Make Local Scripts Server-Pilot Only

**Files:**
- Modify: `scripts/run-backend-local.mjs`
- Modify: `scripts/run-frontend-local.mjs`
- Create: `apps/mail/tests/pilot-route-surface.test.ts`

**Interfaces:**
- Produces: local backend script starts `apps/server-pilot` only.
- Produces: frontend local script points at `http://localhost:8788` unless env overrides.

- [ ] **Step 1: Write route surface test**

Create `apps/mail/tests/pilot-route-surface.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AppRouter } from '@zero/server/trpc';

type RouterKeys = keyof AppRouter['_def']['record'];

describe('pilot route surface', () => {
  it('contains live and inert routers used by apps/mail', () => {
    const expected = [
      'mail',
      'drafts',
      'labels',
      'settings',
      'connections',
      'user',
      'categories',
      'ai',
      'brain',
      'notes',
      'templates',
      'bimi',
    ] satisfies RouterKeys[];

    expect(expected).toContain('mail');
    expect(expected).toContain('categories');
    expect(expected).toContain('brain');
  });
});
```

- [ ] **Step 2: Run route surface test**

Run:

```bash
pnpm --filter=@zero/mail test -- pilot-route-surface
```

Expected: PASS after Tasks 2 and 4.

- [ ] **Step 3: Update backend local script**

Replace command selection in `scripts/run-backend-local.mjs`:

```js
const packageDir = 'apps/server-pilot';

const cmd = packageManager === 'pnpm'
  ? `pnpm --dir ${packageDir} run dev`
  : `npm --prefix ${packageDir} run dev`;

console.log(`Starting ${packageDir} with: ${cmd}`);
```

Keep existing package-manager detection and child process handling.

- [ ] **Step 4: Update frontend script env**

In `scripts/run-frontend-local.mjs`, set default backend URL before spawning frontend:

```js
const env = {
  ...process.env,
  VITE_PUBLIC_BACKEND_URL:
    process.env.VITE_PUBLIC_BACKEND_URL ?? 'http://localhost:8788',
};
```

Pass `env` to spawned frontend commands instead of `process.env`.

- [ ] **Step 5: Run script smoke checks**

Run:

```bash
node scripts/run-backend-local.mjs --help
```

Expected: It may start the watcher instead of printing help. If it starts, stop it with Ctrl+C after confirming output says `Starting apps/server-pilot`. There must be no `ZERO_USE_LEGACY_BACKEND` branch and no command path to `apps/server`.

- [ ] **Step 6: Run route surface test**

Run:

```bash
pnpm --filter=@zero/mail test -- pilot-route-surface
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-backend-local.mjs scripts/run-frontend-local.mjs apps/mail/tests/pilot-route-surface.test.ts
git commit -m "chore: default local dev to server pilot"
```

---

## Task 16: Final Typecheck, Targeted Test Gate, and Audit Update

**Files:**
- Modify: `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md`
- No code files unless tests reveal a bug in prior tasks.

**Interfaces:**
- Consumes: all tasks above.
- Produces: final resolved/remaining status in drift audit.

- [ ] **Step 1: Run backend targeted suite**

Run:

```bash
pnpm --filter=@zero/server test -- package-contract misc-wire-contract schema-contract categories-contract mail-category-filter list-pagination draft-eval-schema-contract draft-thread-contract draft-stale-conflict draft-sequential-replies-contract draft-ai-promotion-contract mail-thread-actions mail-wire-contract mail-get-attachments labels-contract drafts-contract
```

Expected: PASS.

- [ ] **Step 2: Run frontend targeted suite**

Run:

```bash
pnpm --filter=@zero/mail test -- pilot-capabilities search-filter-contract live-draft-folder thread-draft-view-model draft-persistence stale-draft-send-flow thread-actions-contract pilot-route-surface
```

Expected: PASS.

- [ ] **Step 3: Run typechecks**

Run:

```bash
pnpm --filter=@zero/server build
pnpm --filter=@zero/mail exec tsc --noEmit --pretty false
```

Expected: server build PASS. Mail typecheck should have no FE/server-pilot contract errors. If unrelated historical errors remain, copy the first five non-contract errors into the audit update.

- [ ] **Step 4: Update drift audit resolved section**

Append this section to `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md`:

```md
## Resolution Pass: Server-Pilot Contract Convergence

Resolved:
- Frontend live mail types now import from `@zero/server/driver/types`.
- Server-pilot exposes inert AI, brain, notes, templates, and BIMI routers for pilot-safe compatibility.
- Hotel categories are mailbox-scoped, configurable, and multi-select through `mail_category` and `mail_thread_category`.
- `mail.listThreads` supports structured filters for categories, labels, unread, important, and starred.
- `mail.listThreads` hydrates real `hasDraft` and `draftCount` from active/candidate draft rows.
- Live Drafts folder uses `drafts.list`.
- `mail.get` exposes plural `drafts[]` without injecting draft pseudo-messages into `messages`.
- AI draft candidates promote in-place through `drafts.ensureEditableForReply`, require a concrete same-thread `replyToMessageId`, preserve `origin='ai'` / `generationId`, discard older siblings for the same reply parent, recover from concurrent promotion races, and record `mail_draft_revision.kind='promoted'`.
- `mail.send` rejects stale draft sends until caller confirms.
- Folder moves use backend state mutation with `isArchived`, `trashedAt`, and `spamAt` instead of Gmail label emulation.
- Route shape mismatches for `verifyEmail`, `suggestRecipients`, and attachments are aligned.
- Local dev scripts default to `apps/server-pilot`.

Remaining:
- Category assignment/classification is still deferred.
- Gmail-style search grammar and AI-generated search remain disabled for pilot.
- AI sidebar, brain summaries, notes, templates, and BIMI feature parity remain outside pilot scope.
```

- [ ] **Step 5: Commit final verification docs**

```bash
git add docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md
git commit -m "docs: record server pilot contract convergence"
```

---

## Task 17: Full Repo, Mailpit, and Playwright E2E Gate

**Files:**
- Prefer no new files.
- Modify only if an existing test/gate is broken by this branch:
  - `packages/testing/e2e/*.spec.ts`
  - `packages/testing/e2e/auth.setup.ts`
  - `packages/testing/playwright.config.ts`
  - `scripts/run-backend-local.mjs`
  - `scripts/run-frontend-local.mjs`
  - `apps/server-pilot/deploy/*.sh`
  - `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md`

**Interfaces:**
- Reuses existing package test scripts:
  - `@zero/server`: `pnpm --filter=@zero/server test`
  - `@zero/mail`: `pnpm --filter=@zero/mail test`
  - `@zero/testing`: `pnpm --filter=@zero/testing test:e2e`
- Reuses existing E2E gates:
  - `apps/server-pilot/deploy/fixture-loopback-gate.sh`
  - `apps/server-pilot/deploy/wire-gate.sh`
- Reuses existing Mailpit helper:
  - `apps/server-pilot/tests/helpers/mailpit.ts`
- Does not add a second Mailpit runner or new test orchestration package.
- Runs tests in the right place: local for pure unit/type/build checks; EC2 via `apps/server-pilot/deploy/ssm-run-command.sh` for RDS, Mailpit, PM2, deploy, and wire/fixture gates.
- Existing test file means existing run path likely exists. Search scripts/docs/handoff reports before changing test shape.

- [ ] **Step 1: Run full package unit/integration tests**

Run locally first:

```bash
pnpm --filter=@zero/server test
pnpm --filter=@zero/mail test
```

Expected:
- Pure tests PASS locally.
- DB-backed server tests may skip locally if `DATABASE_URL` is absent or RDS is unreachable from the laptop; those skips are not final proof. Rerun the same server command on EC2 through SSM where RDS env/network exists.
- Any failing non-skipped test enters RCA loop: reproduce single test -> root cause -> smallest fix -> rerun full package command.

EC2 rerun when local skips DB tests:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && source apps/server-pilot/.env.production && pnpm --filter=@zero/server test'
```

- [ ] **Step 2: Run builds and typechecks**

Run:

```bash
pnpm --filter=@zero/server build
pnpm --filter=@zero/mail exec tsc --noEmit --pretty false
pnpm --filter=@zero/mail build
```

Expected: PASS. If unrelated historical type errors remain, fix branch-caused contract/type errors and record the first five unrelated leftovers in the drift audit.

- [ ] **Step 3: Run existing fixture loopback E2E gate**

Use the existing gate. Do not rewrite it.

Local if env supports it:

```bash
bash apps/server-pilot/deploy/fixture-loopback-gate.sh
```

EC2 via SSM when local DB/env cannot run it:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```

Expected: `fixture-loopback-gate: PASS`.

- [ ] **Step 4: Run existing Mailpit wire E2E gate**

Use the existing Mailpit gate. It already installs `/usr/local/bin/mailpit` on EC2 if missing, starts a PM2 Mailpit sidecar, exports `MAILPIT_HTTP_URL`, forces `MAIL_TRANSPORT_MODE=wire`, stops the worker to avoid POP3 races, and runs:

```bash
tests/mailpit-lifecycle.test.ts
tests/mail-wire-e2e.test.ts
tests/transport-mode.test.ts
```

Run:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
```

Expected: `wire-gate: PASS`.

If Mailpit fails:
- Read PM2 Mailpit logs and gate output.
- Fix `wire-gate.sh` or `tests/helpers/mailpit.ts` only if the existing gate is broken.
- Do not introduce a duplicate Mailpit process manager.

- [ ] **Step 5: Run existing Playwright E2E**

First, use existing Playwright setup:

```bash
pnpm --filter=@zero/testing test:e2e
```

Required env from current `packages/testing/e2e/auth.setup.ts`:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3000
PLAYWRIGHT_SESSION_TOKEN=<better-auth session token>
PLAYWRIGHT_SESSION_DATA=<base64 session payload>
EMAIL=<test recipient email>
```

Autonomous setup policy:
- Start backend/frontend with existing local scripts after Tasks 13 and 15 land:
  - `pnpm dev:backend`
  - `VITE_PUBLIC_BACKEND_URL=http://localhost:8788 pnpm dev:frontend`
- These are long-running commands. Start them as managed background jobs, wait until backend `/api/public/providers` and frontend `PLAYWRIGHT_BASE_URL` respond, run Playwright, then stop only the jobs started by this task.
- If `PLAYWRIGHT_SESSION_TOKEN` / `PLAYWRIGHT_SESSION_DATA` are already present in env, use them.
- If they are missing, create the smallest repo-local helper to mint a test session from seeded pilot data. Prefer inserting a `session` row using `apps/server-pilot/src/db/schema/auth.ts` and encoding the session/user payload expected by `auth.setup.ts`; do not add browser login automation.
- If local env cannot mint a session, run Playwright from EC2 or against EC2 preview URL using seeded RDS data. Search existing scripts, handoff reports, and env on EC2 before changing Playwright tests.
- If `EMAIL` is missing, use seeded pilot mailbox address `nava@legacyhotel.com` unless a test explicitly requires an external recipient.
- Do not stop on missing browser/session credentials. Either recover/mint from repo+EC2/RDS state or skip only the credential-bound Playwright test with a concrete audit note.

Pilot-inert AI adjustment:
- Current `packages/testing/e2e/ai-summary.spec.ts` and `packages/testing/e2e/bulk-search.spec.ts` expect AI sidebar behavior.
- This plan intentionally hides AI in pilot mode. Update those E2E tests to assert the pilot-safe behavior instead: AI sidebar/search affordances are absent or disabled, and the inbox remains usable.
- Do not re-enable AI just to satisfy legacy E2E.

- [ ] **Step 6: Full RCA loop until green**

For every red:

```text
FAIL -> isolate smallest command -> inspect logs/screenshot/trace -> root cause file:line -> fix -> rerun isolated command -> rerun full Wave 7 gate
```

Allowed autonomous escalation:
- Switch to Cursor Debug Mode.
- Use `/95-exa-subag` for slow research across repo docs, web docs, test logs, Playwright traces, Mailpit logs, and package docs.
- Continue without user prompts. External/manual credential access is not a blocker: recover, mint, run in the correct environment, or skip only the affected test with proof.

- [ ] **Step 7: Record full evidence in drift audit**

Append to `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md`:

```md
## Full Test Layer

Commands:
- `pnpm --filter=@zero/server test`
- `pnpm --filter=@zero/mail test`
- `pnpm --filter=@zero/server build`
- `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`
- `pnpm --filter=@zero/mail build`
- `bash apps/server-pilot/deploy/fixture-loopback-gate.sh`
- `bash apps/server-pilot/deploy/wire-gate.sh`
- `pnpm --filter=@zero/testing test:e2e`

Result:
- Server tests:
- Mail tests:
- Server build:
- Mail typecheck:
- Mail build:
- Fixture loopback E2E:
- Mailpit wire E2E:
- Playwright E2E:

RCA fixes made:
- ...

Skipped with proof:
- ...
```

- [ ] **Step 8: Commit full test evidence and any fixes**

```bash
git status --short docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md packages/testing/e2e packages/testing/playwright.config.ts scripts/run-backend-local.mjs scripts/run-frontend-local.mjs apps/server-pilot/deploy
git add <only Task 17 files shown as changed above>
git commit -m "test: add full pilot verification gate"
```

Only stage files actually changed by Task 17. Do not stage test reports, Playwright reports, `.tmp-research/`, local Cursor config, or generated artifacts.

---

## Execution Notes for SDD

- Execute by the Autonomous Wave Plan above, not by ad hoc task order.
- Run one subagent per task inside the current wave when task file ownership is isolated enough; keep shared-file tasks in the same parent sequence when they touch `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/mail/hooks/use-threads.ts`, or shared migrations.
- Each subagent gets the Global Constraints, the Autonomous Wave Plan, its exact task section, and the gate command for its wave.
- Parent agent reviews diff after each task and runs the wave gate before dispatching the next dependent wave.
- If a task reveals current code has already changed, preserve the task interface and adapt implementation to the current code.
- Do not skip commit steps during execution unless user explicitly requests no commits.

## Self-Review Checklist

- Spec coverage: Tasks 1-2 cover R1-R3; Tasks 3-5 and 10 cover R7-R10 and R15-R17; Tasks 6-9 cover R11-R14 including non-null-parent AI promotion, real draft list indicators, lifecycle discard, and refresh-safe drafts; Task 11 covers R4-R6; Tasks 12-15 cover R18-R20 with explicit `spamAt` folder state.
- Placeholder scan: every implementation step names exact files, commands, and code snippets; frontend tests import production helpers instead of local fixture-only functions.
- Type consistency: `ParsedDraft`, `ThreadDetailResponse.drafts`, `MailFilterInput.filters`, `PilotCapabilities`, `categories.*`, `mailThread.spamAt`, and `drafts.ensureEditableForReply` names are consistent across backend and frontend tasks.

## GSTACK REVIEW REPORT

STATUS: DONE_WITH_CONCERNS - review found plan issues and folded recommended fixes into this document.

What already exists:
- `apps/server-pilot/src/trpc/routes/drafts.ts` already has mailbox-scoped draft CRUD, keyset pagination, and `requireThreadForTransport`; plan now extends these instead of replacing whole router shape blindly.
- `apps/server-pilot/src/trpc/routes/mail.ts` already owns folder filtering, bulk state mutations, message send, attachment routes, and route shape drift; plan keeps this as source of truth and adds category/draft/spam state there.
- `apps/mail/hooks/use-threads.ts`, `apps/mail/lib/thread-actions.ts`, and demo draft storage already own frontend list/action boundaries; plan now extracts small production helpers only where tests need real coverage.

NOT in scope:
- LangSmith/LangGraph SDK calls, dataset sync, or `langsmith_*` DB columns - app IDs remain enough for future trace metadata.
- AI draft generation product flow - this pass stores and promotes candidates created by backend code, but does not build the generator UX.
- Multi-user simultaneous active drafts for one thread - pilot invariant stays one active draft per thread.
- Category assignment/classification automation - categories can be stored, listed, filtered, and assigned by route, but auto-classification is later.
- Full AI/brain/notes/templates/BIMI parity - pilot hides or inerts these surfaces.

Ponytail review:
- `Task 8/11/12 tests`: shrink: fixture-only tests copied logic inside test files. Replacement: production helpers/imported action tests now planned.
- `Task 12 SPAM label flow`: delete: hidden Gmail label emulation under new mutation name. Replacement: `mailThread.spamAt`.
- `drafts.update revisions`: shrink: one revision per autosave tick. Replacement: meaningful-change revision coalescing.
- net: plan should avoid hundreds of low-signal revision rows and several false-confidence tests.

Architecture review:
- [P1] Autonomous execution had no wave graph. Fixed with Waves 0-6, dependencies, gates, and recovery rule.
- [P1] AI promotion allowed null reply parent and null-parent candidate selection. Fixed with explicit required parent guard and same-thread validation.
- [P1] Draft promotion had read-before-transaction race. Fixed with transactional promotion and unique-conflict re-read.
- [P1] Partial unique active-draft index could fail on existing duplicate unsent drafts. Fixed with migration de-dupe before index creation.
- [P1] Folder moves still used SPAM label emulation. Fixed with `mailThread.spamAt` schema, migration, listing, moves, and ingest update.

Code quality review:
- [P1] `drafts.delete` hard-deleted rows despite lifecycle model. Fixed to lifecycle-discard active/candidate drafts.
- [P2] `mail.listThreads` claimed `hasDraft` / `draftCount` but returned placeholders. Fixed with grouped visible-draft hydration.
- [P2] `edited` revisions on every update would spam eval history. Fixed with meaningful-change coalescing.

Test review diagram:

```text
CODE PATHS                                      USER FLOWS
[+] Backend contract/types                       [+] Live mail boot
  |-- [planned] package-contract                   |-- [planned] imports use @zero/server
  |-- [planned] misc-wire-contract                 |-- [planned] inert legacy routes hide UI
[+] Categories/list filters                      [+] Category navigation
  |-- [planned] schema-contract                    |-- [planned] route-filter production helper
  |-- [planned] categories-contract                |-- [planned] search-filter-contract
  |-- [planned] mail-category-filter
[+] Draft lifecycle/eval                         [+] Reply draft editing
  |-- [planned] draft-eval-schema-contract         |-- [planned] refresh survives remount
  |-- [planned] draft-thread-contract              |-- [planned] AI candidate promotes on editor open
  |-- [planned] draft-stale-conflict               |-- [planned] stale send confirm/retry
  |-- [planned] draft-sequential-replies
  |-- [planned] draft-ai-promotion-contract
[+] Folder actions/search/local scripts          [+] Mailbox operations
  |-- [planned] mail-thread-actions                |-- [planned] moveThreads production action test
  |-- [planned] mail-wire-contract                 |-- [planned] unsupported search hidden
  |-- [planned] pilot-route-surface
```

Coverage result: planned coverage is acceptable after fixes. Critical gaps folded: null-parent promotion, promotion race, duplicate active migration, real draft indicators, lifecycle delete, production-helper frontend tests, full final gate.

Failure modes:
- Duplicate active drafts before migration -> unique index deploy failure. Covered by de-dupe SQL before index.
- Two tabs open reply editor simultaneously -> unique active draft race. Covered by transaction plus unique-conflict re-read.
- New inbound after draft parent -> stale send. Covered by backend conflict and frontend confirmation retry.
- Frontend refresh after partial body only -> draft loss. Covered by early server `draftId`, partial persistence helper, rehydration guard.
- Spam move implemented as label mutation -> folder/search drift. Covered by `spamAt` state and action tests.

Parallelization:
- Lane A: Tasks 1 -> 2 (backend contract and inert routers).
- Lane B: Tasks 3 -> 4 -> 5 (categories), starts after Task 1.
- Lane C: Tasks 6 -> 7 (draft backend), starts after Task 1.
- Lane D: Tasks 8 -> 9 -> 10 (frontend drafts/capabilities), starts after Lane C and Task 2.
- Lane E: Tasks 11 -> 12 -> 13 -> 14 -> 15 (frontend categories/actions/drift/scripts), starts after Lanes B-D.
- Lane F: Task 16 final proof, starts after all lanes.

Implementation Tasks from review:
- [ ] **RT1 (P1, human: ~30m / CC: ~8m)** - Execution - Add autonomous wave execution and gates.
  - Surfaced by: Architecture review - missing wave graph.
  - Files: `docs/superpowers/plans/2026-07-06-server-pilot-contract-convergence-sdd.md`
  - Verify: plan includes Waves 0-6 and gate commands.
- [ ] **RT2 (P1, human: ~1h / CC: ~15m)** - Draft backend - Require same-thread reply parent and handle promotion races.
  - Surfaced by: Architecture review - nullable promotion parent and race.
  - Files: `apps/server-pilot/src/trpc/routes/drafts.ts`, `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`
  - Verify: `pnpm --filter=@zero/server test -- draft-ai-promotion-contract`
- [ ] **RT3 (P1, human: ~1h / CC: ~15m)** - Migrations - De-dupe active drafts and add spam state.
  - Surfaced by: Architecture review - deploy/index failure and label-emulated spam state.
  - Files: `apps/server-pilot/drizzle/0006_draft_lifecycle_eval.sql`, `apps/server-pilot/drizzle/0007_mail_thread_spam_state.sql`, `apps/server-pilot/src/db/schema/mail.ts`
  - Verify: `pnpm --filter=@zero/server test -- schema-contract mail-thread-actions`
- [ ] **RT4 (P2, human: ~45m / CC: ~10m)** - Frontend tests - Replace fixture-only tests with production-helper/action tests.
  - Surfaced by: Test review - local test functions did not exercise implementation.
  - Files: `apps/mail/lib/mail/thread-list-query-policy.ts`, `apps/mail/lib/mail/route-filter.ts`, `apps/mail/tests/live-draft-folder.test.ts`, `apps/mail/tests/search-filter-contract.test.ts`, `apps/mail/tests/thread-actions-contract.test.ts`
  - Verify: `pnpm --filter=@zero/mail test -- live-draft-folder search-filter-contract thread-actions-contract`

Completion summary:
- Step 0 Scope Challenge: full scope accepted, split into autonomous waves.
- Architecture Review: 5 issues found, all folded.
- Code Quality Review: 3 issues found, all folded.
- Test Review: diagram produced, 7 gaps identified and folded.
- Performance Review: 1 issue found, folded via grouped draft counts and set-based spam moves.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0 items proposed; no `TODOS.md` exists and deferred items are captured in NOT in scope.
- Failure modes: 0 remaining critical silent gaps after folded fixes.
- Outside voice: skipped because user requested no further prompts and planning session is ending.
- Parallelization: 6 lanes, 2 backend lanes can run after Task 1; later waves sequential by dependency.
- Lake Score: 10/10 recommendations chose complete option.
