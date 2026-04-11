# Hotel Frontend-Only Demo Feature Map

Date: 2026-04-11  
Scope: `apps/mail` feature inventory for a frontend-only hotel reservationist demo (no backend dependency)  
Purpose: single reusable reference for future analysis rounds

## 1) Quick operating model for frontend-only mode

- Demo mode switches are driven by:
  - `ZERO_DEMO_MODE=1`
  - `VITE_FRONTEND_ONLY=1`
- `isFrontendOnlyDemo()` returns true only when both flags are set.
- In active demo mode:
  - thread list and thread data are sourced from local JSON via `lib/demo-data`.
  - settings, aliases, labels, and connections are mocked through local hooks.
  - many actions still instantiate optimistic UI but skip backend writes.

## 2) Routing and surface inventory

### Core routes
- `apps/mail/app/routes.ts`
  - Route graph includes:
    - `/mail` (redirects to `/mail/inbox`)
    - `/mail/:folder` (inbox, labels, folders, demo folders)
    - `/mail/create`, `/mail/compose`
    - `/mail/under-construction/:path`
    - `/settings/*` routes
    - full-width pages: `/about`, `/terms`, `/pricing`, `/privacy`, `/contributors`, `/hr`
    - `/developer`, `/login`
  - Keep
  - Nuance: `mail` path intentionally redirects, so this route is non-negotiable as entrypoint anchor.

### Mail folder route policy
- `apps/mail/app/(routes)/mail/[folder]/page.tsx`
  - Validates folder id against:
    - standard folders (`FOLDERS`)
    - demo queue folders via `isFrontendOnlyDemo() + isDemoQueueFolder`
  - Keeps existing folders and reroutes invalid ones to `/mail/inbox`.
  - Keep for demo, but ensure demo queue map and legacy folders stay aligned.

### Under-construction route
- `apps/mail/app/(routes)/mail/under-construction/[path]/page.tsx`
  - Generic placeholder page with back navigation.
  - Keep as-is (placeholder for future features).

## 3) Demo data/modeling layer (important)

### Demo runtime flags
- `apps/mail/lib/demo/runtime.ts`
- `apps/mail/lib/demo/config.ts`
  - `showWorkQueues`: true
  - `showAiDraftPreview`: true
  - `showAssistantChatUi`: false (flag exists but is not currently consumed anywhere)
  - Keep but verify feature consumers.

### Work queue + folder map
- `apps/mail/lib/demo/folder-map.ts`
- `apps/mail/lib/demo-data/work-queue.ts`
  - Maps `/mail/internal`, `/mail/group`, `/mail/urgent`, etc to folder + queue metadata.
  - Supports `urgent` and `demoCategory` filtering.
  - Keep; this is the core for reservationist queue UX.

### Demo corpus + validation
- `apps/mail/lib/demo-data/schema.ts`
- `apps/mail/lib/demo-data/client.ts`
- `apps/mail/lib/demo-data/adapter.ts`
- `apps/mail/lib/demo-data/centurion-threads.json`
  - JSON schema enforces: `demoCategory`, `urgent`, optional `llmIssueMessage`.
  - `listDemoThreads` filters by folder, search, labels, queue.
  - `getDemoThread` maps into existing thread payload shape.
  - Keep and expand corpus fields for hotel UX experiments.

### Tests already covering demo data
- `apps/mail/tests/demo-client-data.test.ts`
- `apps/mail/tests/demo-folder-map.test.ts`
- `apps/mail/tests/demo-data.adapter.test.ts`
- `apps/mail/tests/work-queue-filter.test.ts`
- `apps/mail/tests/demo-runtime.test.ts`
  - Keep and add new tests as fields/features expand (esp. queue + metadata extraction).

## 4) Mail core UI/features

### Shell and layout
- `apps/mail/app/(routes)/mail/layout.tsx`
- `apps/mail/components/mail/mail.tsx`
  - `MailLayout` composes sidebar + threaded list + detail pane + compose-on-mobile routing.
  - Hotkeys provider and onboarding wrapper included at higher level.
  - Keep for hotel demo.

### Mail list and thread rendering
- `apps/mail/components/mail/mail-list.tsx`
- `apps/mail/components/mail/thread-display.tsx`
- `apps/mail/components/mail/mail-display.tsx`
  - Features: list virtualization, bulk selection, optimistic actions, detail switching, reply buttons, print.
  - `MailList` reads urgent demo metadata and renders urgent stripe.
  - Keep; add reservationist-specific fields and queue-first sorting as needed.

### Thread content rendering
- `apps/mail/components/mail/mail-content.tsx`
  - Uses backend `processEmailContent` unless demo mode, then resolves raw mail HTML locally.
  - Keeps thread body view alive without backend.
  - Keep.

### Thread action context menu
- `apps/mail/components/context/thread-context.tsx`
  - Archive/spam/bin/delete/archive label actions + quick reply.
  - Uses optimistic actions plus `trpc.mail.delete`, `trpc.labels.create`.
  - Keep UI, but disable hard backend paths in pure frontend mode.

### Compose flows
- `apps/mail/components/create/create-email.tsx`
- `apps/mail/components/mail/reply-composer.tsx`
- `apps/mail/components/create/email-composer.tsx`
  - Compose/send path, draft auto-save, recipient composition, attachment pipeline, alias + settings.
  - Backend-dependent operations: `trpc.mail.send`, `trpc.drafts.create`, `trpc.drafts.delete` (reply), settings updates.
  - Keep UI; mock send/draft actions for demo.
  - `EmailComposer` includes AI helpers:
    - `trpc.ai.compose`
    - `trpc.ai.generateEmailSubject`
    - currently used and should be stubbed or mocked.

### Notes panel
- `apps/mail/components/mail/note-panel.tsx`
  - Full note CRUD UX in threads.
  - Backend mutations: `trpc.notes.create/update/delete/reorder`.
  - Keep for now; gate behind demo local storage mock or disable mutation.
  - **Known issue**: TODO notes "Dialog is bugged? needs fixing" on delete confirm flow.

### Command palette
- `apps/mail/components/context/command-palette-context.tsx`
  - Search/filter/navigation command overlay.
  - Has NLP-style query helpers and AI query generation via `trpc.ai.generateSearchQuery`.
  - Keep UI; AI-generation action should be simulated/hard-disabled in demo.

## 5) AI and automation features (highly backend-sensitive)

### AI assistant sidebar
- `apps/mail/components/ui/ai-sidebar.tsx`
- `apps/mail/components/create/ai-chat.tsx`
  - Real-time query/callbacks, tools, and backend agent host integration.
  - Backend-sensitive and currently chat-centric.
  - Recommend comment-out/ hide from demo navigation and disable trigger by default.

### Prompts management
- `apps/mail/components/ui/prompts-dialog.tsx`
  - Loads/saves system prompts with `trpc.brain.getPrompts` and `trpc.brain.updatePrompt`.
  - Keep component but hide/disable in demo unless a mock prompt store is added.

### Mail AI helper surfaces in content
- `apps/mail/components/mail/mail-display.tsx`
  - `AiSummary` uses `useSummary` backend hook.
  - "More about sender/thread" uses `trpc.ai.webSearch`.
  - In demo:
    - keep static summary placeholder (`llmIssueMessage` preview).
    - disable live search/web actions or mock responses.

### AI draft preview (intended demo feature)
- `apps/mail/lib/demo-data/schema.ts` + `lib/demo/` mapping + consumer components
  - `llmIssueMessage` is available and should be shown in read-only draft-preview surfaces.
  - Keep.

## 6) Templates, prompts, and automation helpers

### Templates
- `apps/mail/components/create/template-button.tsx`
- `apps/mail/hooks/use-templates.ts`
  - CRUD of templates is backend-based (`trpc.templates.*`).
  - Keep UI; implement local fixture-backed template storage for demo.

### Email verification + recipient autosuggest
- `apps/mail/components/mail/email-verification-badge.tsx`
- `apps/mail/components/ui/recipient-autosuggest.tsx`
  - Recipient suggestion uses `trpc.mail.suggestRecipients`.
  - Keep for demo; should be robust with local suggestions fallback when no backend.

## 7) Settings area matrix

### Route behavior
- `apps/mail/app/(routes)/settings/layout.tsx`
- `apps/mail/app/(routes)/settings/page.tsx`
- `apps/mail/app/(routes)/settings/[...settings]/page.tsx`
  - Keep routing and page dispatch logic.

### Settings pages and status
- `general` (`app/(routes)/settings/general/page.tsx`)
  - Active; backend save via `trpc.settings.save`.
  - Keep UI and mock saves in demo.
- `appearance` (`app/(routes)/settings/appearance/page.tsx`)
  - Uses next-themes + backend save.
  - Keep UI; mock persistence locally.
- `notifications` (`app/(routes)/settings/notifications/page.tsx`)
  - Already simulated via timeout.
  - Safe for demo; keep.
- `labels` (`app/(routes)/settings/labels/page.tsx`)
- `categories` (`app/(routes)/settings/categories/page.tsx`)
  - Both rely on backend for CRUD and list.
  - Keep but stub in demo or disable edit actions if no local persistence.
- `connections` (`app/(routes)/settings/connections/page.tsx`)
  - Read via demo-friendly hooks, write/backend paths are live.
  - Keep viewer + disable real connect/disconnect in demo.
- `privacy` (`app/(routes)/settings/privacy/page.tsx`)
- `security` (`app/(routes)/settings/security/page.tsx`)
  - Keep; security save simulation is currently mocked with setTimeout.
- `danger-zone` (`app/(routes)/settings/danger-zone/page.tsx`)
  - Delete account calls backend mutation.
  - Keep UI only; disable destructive action for frontend-only mode.
- `shortcuts` (`app/(routes)/settings/shortcuts/page.tsx`)
  - Read-only now.
  - Existing shortcut editing + recorder features are commented out.

### Settings hooks (important for demo)
- `apps/mail/hooks/use-settings.ts`
- `apps/mail/hooks/use-email-aliases.ts`
- `apps/mail/hooks/use-labels.ts`
- `apps/mail/hooks/use-connections.ts`
  - Demo-mode branches return local fixtures for settings/aliases/labels/connections.
  - Keep.

## 8) Navigation, shell, and app chrome

### Sidebar nav + sections
- `apps/mail/config/navigation.ts`
- `apps/mail/components/ui/app-sidebar.tsx`
  - Mail and settings sections are explicit.
  - Demo adds queue section and hides signature feature.
  - Keep, but review section labels for hotel language.

### Sidebar main nav rendering
- `apps/mail/components/ui/nav-main.tsx`
  - Handles folders/labels, query/account context, intercom wiring.
  - In demo, Intercom creation is already gated by mode.
  - Keep with support-link gating as already planned.

### User account and account switch menu
- `apps/mail/components/ui/nav-user.tsx`
  - Logout, account switch, force sync, theme, support links.
  - In demo: `AddConnectionDialog` already hidden; account-switch still safe with guards.
  - Keep, but force-sync/logout/debug actions should be no-op or mocked.

### Route-level auth/session guards
- `apps/mail/app/(routes)/settings/layout.tsx`
- `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- `apps/mail/app/(auth)/login/page.tsx`
  - Session checks remain for UI consistency.
  - In demo, login route exposes "Continue to Demo" bypass.

## 9) Onboarding and marketing/demo intro

- `apps/mail/components/onboarding.tsx`
- `apps/mail/app/(routes)/home/page.tsx`
- `apps/mail/app/(full-width)/*`
  - Hotel-themed onboarding is present and should be retained.
  - Good baseline for a curated demo-first experience.

## 10) Known commented-out / intentionally disabled items

- `apps/mail/components/mail/mail.tsx`
  - `AutoLabelingSettings` block is currently commented out.
  - Recommendation: Keep disabled for now (AI+backend heavy coupling).
- `apps/mail/app/(routes)/settings/shortcuts/page.tsx`
  - Hotkey recorder and save/reset interactions are commented.
  - Keep as read-only display.
- `apps/mail/components/context/thread-context.tsx` and others
  - Backend-only mutation actions (for persistence/sync) should be mocked or blocked in demo.

## 11) Risks and bug notes (for demo hardening)

- `apps/mail/components/mail/note-panel.tsx`
  - Inline TODO states delete confirmation dialog is bugged; delete action uses toast-confirm pattern.
- `apps/mail/lib/demo/config.ts`
  - `showAssistantChatUi` flag exists but currently appears unused; either wire it in or remove dead config.
- Backend-coupled paths currently still create mutations in demo mode unless explicitly guarded; this can produce noisy failures when backend is unavailable.
- Some optimistic UI actions update local state and then skip backend calls in demo mode; this can diverge from expected state without periodic reset if UI is not fully mocked.

## 12) Hotel demo recommendation matrix

- **Keep as-is**
  - mail route shell, folder system, thread list/detail views, compose UI, onboarding, static pages, full-width info pages.
- **Keep but mock/stub**
  - compose send/draft, settings save, labels/categories/templates/connections, notes, templates, nav user debug/support actions.
- **Keep hidden/disabled**
  - full AI agent workflows (chat/sidebar/prompts/query generation, backend summary search), destructive account actions (delete account), signature settings, AI chat/sidebar surfaces.
- **Refactor first for better demo quality**
  - `mail-thread` and `mail-list` metadata display to emphasize urgency, group RFQ, and queue-specific badges.
  - Replace live backend dependencies with deterministic local fixtures.

## 13) Suggested hotel-specific new UI features (priority set)

### A) Group RFQ concierge workflow
- New "Group Requests" queue derived from `demoCategory=group`.
- Add dedicated thread badges:
  - arrival date range
  - guest count
  - room nights
  - quote status (draft/sent/reviewed)
- Add one-click actions:
  - `Mark as Urgent`
  - `Generate Follow-up Draft` (template-backed, no live AI)
  - `Escalate to Reservations`

### B) PMS integration surfaces (demo-safe)
- Add PMS Availability panel in thread header/sidebar:
  - availability snapshot by property/room type (fixture-backed in demo mode)
  - occupancy/conflict indicator
  - action chips: `Hold Rooms`, `Release Hold`, `Open PMS Record`
- Add command palette quick action:
  - `availability check <property> <dates>`
  - `find substitute rooms`
- Introduce a "PMS Sync Log" in thread detail:
  - timestamped events, mock API statuses, request IDs.

### C) Quote and follow-up automation
- "RFQ draft assistant" flow using local templates:
  - pre-populated quote blocks per destination/client segment
  - acceptance/decline CTA states
- "Reservation notes + audit trail":
  - local sticky notes with thread-bound context
  - auto-generated change log for demo review.

### D) Reservationist workflow polish
- Work queue dashboard cards:
  - urgency lane + aging (`overdue`, `needs review`, `awaiting client`)
- Add bulk actions for queue-level operations:
  - `Assign`, `Batch Tag`, `Mark Reviewed`, `Archive`.
- Add small inline hints:
  - "what to read first" based on metadata + labels.

## 14) Suggested next-step implementation order (shortest path)

1. Finalize demo-safe behavior for high-risk AI paths:
   - hide/disable assistant chat, prompts, live web search/suggested summaries.
2. Add local mocks for:
   - notes, templates, connections, labels, settings persistency.
3. Resolve note delete confirmation TODO and remove debug noise.
4. Implement one first-pass Group RFQ list enhancements (UI indicators + metadata badges).
5. Add PMS availability fixture panel + queue-level status actions.
6. Add targeted tests for demo route/render behavior and queue metadata filtering.

