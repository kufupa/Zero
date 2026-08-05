---
title: Hotel Folder UI Parity for Live Pilot Category Pills and Centurion Theme
date: 2026-07-23
category: ui-bugs
module: apps/mail hotel folder nav + category pills + mail.get categories
problem_type: ui_bug
component: email_processing
severity: high
symptoms:
  - Hotel Folders nav displays raw DB seed hex colors instead of Centurion pastels when category.color is set
  - Category pills hidden in live pilot because isFrontendOnlyDemo gate blocks despite list returning categoryIds
  - Mail detail view missing category pills because mail.get lacked categoryIds and categories
  - Mailbox sidebar Labels block titled Folders clashes with hotel Folders section; Collapsible without Trigger makes defaultOpen a noop
  - Category chips show raw DB names and hex instead of presentation-layer titles and pastel themes
root_cause: logic_error
resolution_type: code_fix
tags:
  - hotel-folders
  - category-pills
  - centurion-theme
  - live-pilot
  - ec2-pilot
  - demo-parity
  - mail-get
  - category-nav
  - ui-parity
---

# Hotel Folder UI Parity for Live Pilot Category Pills and Centurion Theme

## Problem

On the live EC2-pilot mail UI (real `categoryIds` / AI-managed categories, not demo chrome), hotel folder presentation diverged from the polished demo: sidebar folders showed seed hex colors and raw names, Centurion pills vanished, thread detail lacked categories after open, triage polls left stale pills, Labels chrome mislabeled, and category filter chips ignored presentation titles/colors. Six coordinated defects; none required flipping `FORCE_FRONTEND_ONLY_DEMO` or changing triage/seed taxonomy.

## Symptoms

- Live Folders nav rendered seed `category.color` hex and DB `name` instead of demo pastels, human titles, subtitles, and urgent stripe for AI-managed slugs (`individual`, `group`, `travel-agents`, `internal`, `urgent`).
- `CenturionCategoryPill` never rendered on live pilot because it was gated behind `isFrontendOnlyDemo()`; inbox/folder rows showed no category chip despite threads having category memberships.
- Opening a thread via `mail.get` returned no `categoryIds` / `categories`, so detail and any pill resolution that depended on get-path data were empty even when `listThreads` already had memberships.
- After a triage poll updated a thread’s categories, the list row kept the old pill until hard refresh — `Thread` memo treated the row as unchanged when only `id` matched.
- Live sidebar Labels section did not always show the literal title **Labels**, and/or did not use a real collapsed `CollapsibleTrigger` / `CollapsibleContent` with `defaultOpen={false}`.
- `CategoryDropdown` filter chips showed raw category names/colors instead of presentation titles and managed pastel accents, while filters still needed stable UUID `categoryIds`.

## What Didn't Work

- Treating live parity as “turn on demo mode.” Flipping `FORCE_FRONTEND_ONLY_DEMO` would restore chrome by abandoning the live `categoryIds` path; explicitly out of scope. (session history)
- Preferring `category.color` whenever the seed row had a color. Seed taxonomy always ships hex, so that precedence permanently masked presentation themes for managed slugs.
- Leaving pill resolution on demo-only `centurionCategory` string fields. Live list/detail carry UUID `categoryIds` that must map through an id→slug map; a demo gate or string-only path skips live data.
- Loading categories only in `listThreads`. Detail open used a separate `mail.get` shape; omitting categories there made “open thread” look uncategorized even when the list row was correct.
- Memoizing `Thread` on `message.id` alone (plus focus/index/handlers). Category membership is mutable under triage poll; id-stable rows must still re-render when `categoryIds` or `centurionCategory` change.
- Changing AI category seed lists or triage rules to “fix” display. Presentation is a frontend overlay on locked AI slugs; taxonomy churn was unnecessary and forbidden for this fix.
- Prior production-parity overnight treated hotel folders as a thin checklist item (categoryIds + colors) without a dedicated presentation module or `mail.get` membership parity — incomplete for demo-grade chrome. (session history)

## Solution

Centralize live presentation in `apps/mail/lib/mail/hotel-folder-presentation.ts` (`getHotelFolderPresentation`, `getHotelFolderNavTheme` / pill colors, `resolveThreadCategoryPresentation`, managed-slug guards). Wire every live consumer through that module while keeping UUID `categoryIds` as the filter/wire identity.

### 1. Nav theme precedence — presentation wins for managed slugs

In `buildLiveCategoryNavItems` (`apps/mail/config/navigation.ts`), invert color precedence: AI-managed slugs take presentation pastels/titles/subtitles/urgent stripe; only non-managed categories fall back to seed `category.color`.

**Before (seed color always won when set):**

```typescript
const theme = category.color?.trim()
  ? categoryColorNavTheme(category.color)
  : getHotelFolderNavTheme(category.slug);
```

**After:**

```typescript
const presentation = getHotelFolderPresentation(category.slug);
const managedTheme = isHotelManagedCategorySlug(category.slug)
  ? getHotelFolderNavTheme(category.slug)
  : category.color?.trim()
    ? categoryColorNavTheme(category.color)
    : {};

return {
  id: category.slug,
  title: presentation?.title ?? category.name,
  subtitle: presentation?.subtitle,
  url: `/mail/${category.slug}`,
  icon: Folder,
  ...managedTheme,
};
```

### 2. CenturionCategoryPill — live path, demo fallback

Remove the `isFrontendOnlyDemo()` gate. Resolve primary/urgent pill from `categoryIds` + id→slug map via `resolveThreadCategoryPresentation`; if live resolution yields nothing, fall back to demo/legacy `centurionCategory` when it is a primary hotel slug. Titles and colors come from presentation helpers.

```tsx
const resolved =
  categoryIds && idToSlug
    ? resolveThreadCategoryPresentation(categoryIds, idToSlug)
    : { primarySlug: null, isUrgent: false, pillSlug: null };

let pillSlug = resolved.pillSlug;
let isUrgent = resolved.isUrgent;

if (!pillSlug && category && isHotelPrimaryCategorySlug(category)) {
  pillSlug = category;
}

if (!shouldShowHotelCategoryPill({ routeFolder, pillSlug })) return null;
```

### 3. `mail.get` returns categories — shared loader with list

In `apps/server-pilot/src/trpc/routes/mail.ts`, extract `loadCategoryIdsByThreadIds` and reuse it from `listThreads` and thread get. `mail.get` / `ThreadDetailResponse` now include `categoryIds` plus hydrated `categories` (id, slug, name, color, sortOrder) so detail and list stay on one membership source.

```typescript
async function loadCategoryIdsByThreadIds(
  db: ReturnType<typeof getDb>,
  transportId: string,
  threadIds: string[],
): Promise<Map<string, string[]>> { /* mail_thread_category join */ }

// mail.get
const { categoryIds, categories } = await loadThreadCategoriesForGet(
  db,
  transportId,
  threadId,
);
return { /* ... */, categoryIds, categories };
```

### 4. Thread memo — compare category identity

`Thread` in `apps/mail/components/mail/mail-list.tsx` custom `memo` comparator now requires equal `categoryIds` (length + per-index) and equal `centurionCategory`, not only `message.id`.

**Before:** same id ⇒ skip re-render (stale pill after triage).

**After:**

```typescript
(prev, next) => {
  const prevCategoryIds = prev.message.categoryIds ?? [];
  const nextCategoryIds = next.message.categoryIds ?? [];
  const isSameCategoryIds =
    prevCategoryIds.length === nextCategoryIds.length &&
    prevCategoryIds.every((id, index) => id === nextCategoryIds[index]);
  return (
    prev.message.id === next.message.id &&
    prev.message.centurionCategory === next.message.centurionCategory &&
    isSameCategoryIds &&
    /* focus, index, onClick … */
  );
}
```

### 5. Labels section chrome

In `apps/mail/components/ui/nav-main.tsx`, live Labels uses a real `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` with `defaultOpen={false}` and the fixed title **Labels** (not a dynamic folder/category label).

### 6. CategoryDropdown chips — presentation display, UUID filters

In `CategoryDropdown` (`apps/mail/components/mail/mail.tsx`), chip label/dot color resolve through `getHotelFolderPresentation` / `getHotelPillColorStyle` for managed slugs; selection and filter state continue to use UUID `category.id` / `categoryIds` arrays so list queries stay correct.

```typescript
const presentation = slug ? getHotelFolderPresentation(slug) : null;
const displayName = presentation?.title ?? category.name;
const dotColor =
  slug && isHotelManagedCategorySlug(slug)
    ? getHotelPillColorStyle(slug).text
    : category.color;
// isChecked still: categoryIds.includes(category.id)
```

Do **not** flip `FORCE_FRONTEND_ONLY_DEMO`. Do **not** edit triage or seed taxonomy for this parity work.

## Why This Works

Demo chrome and live pilot share the same AI-managed slug set (`HOTEL_MANAGED_CATEGORY_SLUGS`, locked to server AI category constants). Demo baked presentation into static folder definitions; live previously mixed three incomplete paths: seed hex/name for nav, demo-gated pills, and list-only category loading. Preferring presentation for managed slugs restores visual parity without inventing a second taxonomy. Resolving pills from `categoryIds` + id→slug matches how the server stores memberships. Returning the same memberships from `mail.get` closes the list/detail gap. Comparing `categoryIds` in the memo acknowledges that triage mutates categories in place on a stable thread id. Labels and CategoryDropdown fixes are pure UI identity: human-facing strings/colors from presentation; machine-facing filters remain UUIDs.

Root cause cluster: **logic_error** / incomplete live-path wiring (wrong precedence, demo gate, asymmetric API shape, over-narrow memo), surfaced as **ui_bug** on EC2-pilot. Resolution: **code_fix** across mail FE + server-pilot `mail` routes.

## Prevention

- Treat `hotel-folder-presentation.ts` as the single source for managed-slug titles, subtitles, nav themes, and pill colors. New live consumers must call it; do not read `category.color` / `category.name` first for managed slugs.
- Never gate hotel category chrome on `isFrontendOnlyDemo()` when the live path already has `categoryIds`. Demo string fields are fallbacks only.
- Any procedure that returns thread list rows with `categoryIds` must return the same fields on `mail.get` / detail types — prefer shared loaders like `loadCategoryIdsByThreadIds`.
- When memoizing list rows that show derived category UI, include `categoryIds` (and demo `centurionCategory`) in the equality check alongside `id`.
- Keep filter wire format as UUID `categoryIds`; map to presentation only at render time.
- Regression tests: `apps/mail/tests/hotel-folder-presentation.test.ts` (theme precedence for managed vs custom colors; presentation titles) and filter/contract tests that assert chip display names without changing filter ids.
- Explicit non-goals for future agents: do not flip `FORCE_FRONTEND_ONLY_DEMO` for visual parity; do not rewrite AI/seed category taxonomy to fix chrome.

## Related Issues

- [Live pilot production parity (real mail)](../architecture-patterns/live-pilot-production-parity-real-mail.md) — parent overnight wave; hotel folders were checklist item #11 without this UI depth
- [Live AI mail pipeline / Mastra worker gates](../architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md) — upstream AI-managed category slugs and durable triage writes
- [FE ↔ pilot tRPC wire contract drift](../integration-issues/fe-pilot-trpc-wire-contract-drift.md) — list/get payload shape discipline
- [Mail open-thread stale + recipient You label](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md) — adjacent live UI wire/presentation lessons
- Plan: `docs/superpowers/plans/2026-07-23-hotel-folder-ui-parity.md`
- Handoff: `docs/superpowers/plans/handoff-reports/2026-07-23-hotel-folder-ui-parity.md`
