# 2026-04-11 Hotel Demo Backend & Slowdown Audit

Source:
- Feature map used as baseline: `docs/superpowers/2026-04-11-hotel-demo-feature-map.md`
- Branch scan focused on `apps/mail` and query/mutation runtime wiring.

Goal:
Confirm remaining backend dependency surfaces in frontend-only mode and identify likely runtime slowdowns during the full-stack→frontend-demo migration.

## 1) Backend calls that still run when `ZERO_DEMO_MODE=1` and `VITE_FRONTEND_ONLY=1`

### A) High-confidence blockers (demo routes/actions will attempt remote mutation/query)

| Severity | File | Pattern | Why this is still backend-dependent |
|---|---|---|---|
| P0 | `apps/mail/components/create/create-email.tsx:61` | `trpc.mail.send` | `sendEmail` mutation is called from compose UI without demo-only gating |
| P0 | `apps/mail/components/mail/reply-composer.tsx:37` | `trpc.mail.send` | Reply send path is not demo-gated |
| P0 | `apps/mail/components/create/email-composer.tsx:220-223` | `trpc.ai.compose`, `trpc.drafts.create`, `trpc.ai.generateEmailSubject` | Draft and AI helpers execute directly unless guarded by `isFrontendOnlyDemo()` |
| P0 | `apps/mail/components/context/thread-context.tsx:180-181` | `trpc.mail.delete`, `trpc.labels.create` | Context actions can be triggered from mail list/thread details and currently hit backend in demo |
| P0 | `apps/mail/components/mail/note-panel.tsx:249-252` | `trpc.notes.create/update/delete/reorder` | CRUD/reorder flow is not mock-only in demo mode |
| P0 | `apps/mail/components/ui/prompts-dialog.tsx:61, 64` | `trpc.brain.getPrompts`, `trpc.brain.updatePrompt` | Loads and writes prompt data via backend |
| P0 | `apps/mail/components/context/command-palette-context.tsx:201` | `trpc.ai.generateSearchQuery` | AI helper action can still run in demo |
| P0 | `apps/mail/components/ui/recipient-autosuggest.tsx:98` | `trpc.mail.suggestRecipients` | Live recipient suggestion query does not short-circuit for demo |
| P0 | `apps/mail/components/ui/nav-main.tsx:77` | `trpc.labels.create` | Label creation action path lacks demo guard |
| P0 | `apps/mail/components/ui/nav-user.tsx:99` | `trpc.mail.forceSync` | Force-sync action still available and runnable |
| P0 | `apps/mail/components/ui/ai-sidebar.tsx` | AI agent/chat hooks | AI workflow paths are active unless intentionally hidden |
| P0 | `apps/mail/app/(routes)/settings/general/page.tsx:123`, `apps/mail/app/(routes)/settings/appearance/page.tsx:42` | `trpc.settings.save` | Settings persistence submit still uses mutation |
| P0 | `apps/mail/hooks/use-templates.ts:7` | `trpc.templates.list` | Demo mode does not return fixture data yet |
| P0 | `apps/mail/hooks/use-notes.tsx:14` | `trpc.notes.list` | Demo mode has no local fallback and query remains enabled |
| P0 | `apps/mail/hooks/use-drafts.ts:9` | `trpc.drafts.get` | Draft query is not gated for demo mode |
| P0 | `apps/mail/components/mail/mail-content.tsx:35-36` (in settings trust action) | `trpc.settings.save` | Trust sender action calls settings save mutation |

### B) Confirmed guarded or already local in demo mode

- `apps/mail/hooks/use-threads.ts` — list/get/content process path uses local demo runtime branch with `enabled: !frontendOnlyDemo`.
- `apps/mail/hooks/use-labels.ts` — list uses local `demo` branch.
- `apps/mail/hooks/use-connections.ts` — list/default reads local demo data when demo enabled.
- `apps/mail/hooks/use-settings.ts` — local settings fallback used in demo.
- `apps/mail/hooks/use-summary.ts` — AI summary/query path disabled by `frontendOnlyDemo`.
- `apps/mail/lib/auth-proxy.ts`, `apps/mail/lib/auth-client.ts`, and `apps/mail/app/(auth)/login/page.tsx` show explicit demo branches.

### C) Important: where backend-like network calls still happen regardless of demo

These are not all TRPC calls but are still external/network work that can slow/demo-fail when those routes/components are mounted:

- `apps/mail/lib/server-tool.ts` (`fetch(`${base}/api/ai/do/${action}`)).
- `apps/mail/lib/email-utils.client.tsx` (`fetch(listUnsubscribeAction.url, ...)`).
- `apps/mail/components/ui/bimi-avatar.tsx` uses `trpc.bimi.getByEmail` when email shown.
- `apps/mail/components/navigation.tsx` fetches GitHub repo stars via `https://api.github.com/repos/Mail-0/Zero` on nav render.
- `apps/mail/app/(full-width)/contributors.tsx` fetches multiple GitHub endpoints for contributors/repo history.
- `apps/mail/app/(auth)/login/page.tsx` fetches `/api/public/providers` when not in demo branch.
- `apps/mail/providers/query-provider.tsx` and TRPC client setup always define backend transport to `/api/trpc`; no remote traffic if no enabled queries/mutations run, but this is a remaining dependency edge in infrastructure.

## 2) Performance/slowdown candidates in the migrated demo context

I asked a second review pass specifically for slowdown risk and practical fix ideas.

### A) Real, immediate risks

- `apps/mail/components/mail/mail-list.tsx`
  - `memo` with custom comparator at `::1034` uses `() => true`, which can skip legitimate updates and cause stale UI under frequent state changes.
  - `MailLabels` comparator `JSON.stringify(prev.labels) === JSON.stringify(next.labels)` at `::1080` can be expensive for large arrays.
  - Impact: immediate correctness + unnecessary or stale render behavior under active interaction.

### B) Conditional/performance-scaling risks (low impact today, higher when data grows)

- `apps/mail/lib/demo-data/adapter.ts`
  - Synchronous, module-level data shaping (`parseDemoCorpus` + map/sort/filter setup).
  - Current dataset is small enough that it is mainly startup overhead, but grows linearly with corpus size.
- `apps/mail/components/create/create-email.tsx` / `mail-display.tsx`
  - Base64/attachment decode and bulk conversion loops can be heavy for large attachment payloads.
- `apps/mail/components/mail/thread-display.tsx`
  - Thread attachment aggregation loops across messages.
- `apps/mail/components/context/command-palette-context.tsx`
  - Frequent text filtering + repeated `localStorage` parse/stringify on history.
- `apps/mail/components/mail/mail-display.tsx`
  - String/html processing paths can be heavy on large HTML bodies and longer thread contents.
- `apps/mail/app/(routes)/mail/[folder]/page.tsx`
  - Folder validation/lookup can become costlier with unusually deep/wide folder trees.
- `apps/mail/hooks/use-threads.ts`
  - `flatMap` + `filter` pass over thread pages in memoized selector.
- `apps/mail/app/(full-width)/hr.tsx`
  - Team-overlap computations and per-second timer updates are okay for small in-memory state but can accumulate with larger tables.

### C) Verified as “not currently painful” for this demo dataset

- Current corpus in this branch is small (`12` threads, short bodies, no attachments in common flow), so many loops are currently negligible.
- Biggest practical UX issues are in menu/feature wiring and action paths that still call real backend APIs, not raw CPU cost at current scale.

## 3) Recommended patch order (practical)

1. **Stop demo-mode backend writes immediately**
   - Add local-only fallback branches (`isFrontendOnlyDemo`) to all P0 entries above:
     compose/send, drafts, notes, labels, settings saves, templates, recipients, command palette AI query, prompts, nav AI, force sync, and thread-context actions.
2. **Cut frontend-visible external API leakage**
   - Hide/short-circuit GitHub fetch surfaces (`navigation.tsx`, `contributors.tsx`) and unsubscribe/AI tool helpers in pure demo mode.
3. **Fix memoization correctness + rendering pressure**
   - Replace `memo(..., () => true)` with a real prop-aware comparator or remove custom comparator where not needed.
   - Replace label array stringify compare with stable structural checks.
4. **Scale-hardening pass**
   - Debounce/throttle command-palette filtering work and persistence.
   - Cache expensive derived data for thread bodies/attachment scans where feasible.

## 4) Final verdict

- **Backend in demo mode is still reachable.** There are many concrete action paths that still call real backend APIs and should be mocked/disabled for a stable frontend-only demo.
- **Slowdowns exist mostly as scaling risks**, with one clear immediate high-risk bug: the mail list memoization behavior.
- The migration is therefore blocked less by current computational performance and more by **stray backend side effects** and a small set of rendering correctness/efficiency issues.
