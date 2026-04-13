# Frontend Demo Mode Audit Notes

## Scope
- Investigate why search fails in frontend-only demo mode.
- Identify features that are disabled or only partially mocked in demo mode.
- Propose targeted fix so the demo behaves like a functional frontend with no backend dependency.

## Search bar root cause (confirmed)
- File: `apps/mail/lib/demo/local-actions.ts`
- `demoGenerateSearchQuery` appended `" (demo)"` to every query before returning it.
- File: `apps/mail/lib/demo-data/adapter.ts`
- `listDemoThreads` filters threads using `entry.searchText.includes(query)` where `searchText` is built from thread fields and does not contain `"(demo)"`.
- Result: search query string never matches mock data, so thread list becomes effectively empty for searched terms.

Fix applied:
- Remove `"(demo)"` suffix so demo search returns normalized user query only.
- Updated assertions in `apps/mail/tests/demo-backend-guards.test.ts` to reflect the new query behavior.

## Features already demo-mocked (working without backend calls)
- Drafts read/update path: `apps/mail/hooks/use-drafts.ts`, `apps/mail/components/create/create-email.tsx`
- Templates read/save/delete: `apps/mail/hooks/use-templates.ts`, `apps/mail/components/create/template-button.tsx`
- Notes list/read/update: `apps/mail/hooks/use-notes.tsx`
- Optimistic action flows (read/unread/star/move/delete/labels/snooze etc.): `apps/mail/hooks/use-optimistic-actions.ts`
- Settings save (categories/appearance/privacy): `apps/mail/app/(routes)/settings/categories/page.tsx`, `/appearance`, `/privacy`
- Connection state and actions: `apps/mail/hooks/use-connections.ts`, `apps/mail/app/(routes)/settings/accounts/page.tsx`
- AI compose / send / subject generation / upsert draft: `apps/mail/lib/demo/local-actions.ts`, `apps/mail/components/create/create-email.tsx`
- Undo send: `apps/mail/hooks/use-undo-send.ts`
- Summary generation + recipient autosuggest + thread notes + trusted sender + delete account + force-sync + disconnect/reconnect are covered in `apps/mail/tests/demo-backend-guards.test.ts` assertions.

## Demo mode where backend is intentionally disabled (likely not functional)
- `apps/mail/components/ui/prompts-dialog.tsx`
  - Uses `trpc.brain.getPrompts` / `updatePrompt` directly; in demo mode TRPC client is mocked to fail for these calls.
- `apps/mail/components/ui/nav-main.tsx`
  - Disables `intercomToken` query and hides one label creation trigger via `!isFrontendOnlyDemo()`.
- General TRPC-backed API calls that are not guarded by `isFrontendOnlyDemo()` will fail because demo mode uses `createDemoTrpcClient()` as a fail-fast backend stub.

## Recommended elegant next steps
1. Keep search fixed with normalized query only (`demoGenerateSearchQuery` without suffix).
2. Add/keep a small guard policy for any future direct TRPC call in UI paths not guarded by `isFrontendOnlyDemo()`.
3. For features intentionally disabled in demo, either:
   - add local mock implementations and loading states, or
   - explicitly disable UI controls with clear messaging so users understand demo limitations.
