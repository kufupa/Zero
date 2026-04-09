# Frontend Startup Performance (Mail App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce “type URL → interactive” latency by removing large, optional UI/features from the initial JS graph and trimming dev-server cold-start overhead in `apps/mail`.

**Architecture:** Keep the default route’s import graph minimal by moving optional features behind dynamic imports (`React.lazy`) and small “state-only” modules. Make expensive dev-time transforms opt-in via env flags and narrow Vite warmup to first-view modules.

**Tech Stack:** React Router v7 (SPA mode), Vite, React 19, pnpm workspace, Tailwind, `nuqs`, Cloudflare adapter/plugin.

---

## Scope / What This Plan Covers

This plan recreates the same high-impact frontend changes that were implemented in this repo’s `apps/mail` app:

- Lazy-load the AI sidebar UI (huge bundle) and keep only lightweight state/hooks eagerly loaded.
- Lazy-load compose (`CreateEmail`) inside the sidebar dialog (avoid pulling editor stack at startup).
- Lazy-load onboarding wrapper and defer `canvas-confetti` until needed.
- Add a lazy boundary for command palette provider so it loads only after first use (`Ctrl/Cmd+K`).
- Split hotkey provider usage so heavy mail-only hotkeys only mount where needed.
- Reduce dev server startup overhead by narrowing warmup targets and making heavy plugins opt-in.

### Important note about “frontend-only”

The original work also included **optional backend hardening** for an Autumn/billing route to avoid 500s when Autumn credentials are missing. That backend change is **not required** to get the core frontend startup/perf wins, and you can skip it if you truly need “frontend-only”. I include it as an **optional appendix**.

---

## Success Criteria (What “done” looks like)

- **Production build** completes and shows a much smaller `ai-sidebar` client chunk (it should drop from ~1MB to tens of KB).
- App still renders and can navigate basic routes.
- AI sidebar, compose UI, onboarding dialog, and command palette still work when triggered (they may require auth/session depending on your environment, but the lazy-loading wiring should be correct).
- Dev startup feels faster due to reduced warmup + disabled heavy transforms by default.

---

## File Map (What to touch)

### New files
- `apps/mail/components/ui/ai-sidebar-state.ts`: lightweight AI sidebar state/hooks (query params + localStorage sync).
- `apps/mail/components/context/lazy-command-palette-provider.tsx`: wrapper that loads command palette provider only after first use.

### Modified files
- `apps/mail/components/ui/ai-sidebar.tsx`: remove heavy state hooks; import from `ai-sidebar-state.ts`; export aliases to preserve imports.
- `apps/mail/components/ai-toggle-button.tsx`: use state-only hook (no longer imports heavy AI sidebar module).
- `apps/mail/components/mail/mail.tsx`: lazy-load AI sidebar UI (`React.lazy` + `Suspense`).
- `apps/mail/components/ui/app-sidebar.tsx`: lazy-load `CreateEmail` within compose dialog.
- `apps/mail/app/(routes)/layout.tsx`: wrap with `LazyCommandPaletteProvider` instead of eager `CommandPaletteProvider`.
- `apps/mail/app/(routes)/mail/layout.tsx`: lazy-load onboarding wrapper.
- `apps/mail/components/onboarding.tsx`: defer `canvas-confetti` dynamic import until last step.
- `apps/mail/components/providers/hotkey-provider-wrapper.tsx`: add `includeMailHotkeys` prop and gate heavy hotkeys.
- `apps/mail/vite.config.ts`: narrow warmup targets; make `oxlint` + React Compiler transforms opt-in; `filter(Boolean)` plugins array.

---

## Task 0: Create a clean “frontend-only perf” branch

**Files:** none

- [ ] **Step 1: Create a new branch off `staging`**

Run:
`git checkout staging`

Run:
`git checkout -b cursor/frontend-perf-startup-<suffix>`

Expected: you are on a new branch.

- [ ] **Step 2: Ensure dependencies are installed**

Run:
`pnpm -v`

Run:
`pnpm install`

Expected: install completes.

- [ ] **Step 3: Record baseline build output (for comparison)**

Run:
`time -p pnpm --filter=@zero/mail build`

Expected: build completes; note the client chunk sizes for `ai-sidebar` and `use-drafts`.

- [ ] **Step 4: Commit nothing yet**

This plan will create commits per task.

---

### Task 1: Extract AI sidebar state to a lightweight module

**Files:**
- Create: `apps/mail/components/ui/ai-sidebar-state.ts`
- Modify: `apps/mail/components/ui/ai-sidebar.tsx`
- Modify: `apps/mail/components/ai-toggle-button.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Create `apps/mail/components/ui/ai-sidebar-state.ts`**

Create the file with this exact content:

```ts
import { useCallback, useEffect, useState } from 'react';
import { useQueryState } from 'nuqs';

type ViewMode = 'sidebar' | 'popup' | 'fullscreen';

export function useAIFullScreen() {
  const [isFullScreenQuery, setIsFullScreenQuery] = useQueryState('isFullScreen');

  const [isFullScreen, setIsFullScreenState] = useState<boolean>(() => {
    if (isFullScreenQuery) return isFullScreenQuery === 'true';
    if (typeof window !== 'undefined') {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen) return savedFullScreen === 'true';
    }
    return false;
  });

  const setIsFullScreen = useCallback(
    (value: boolean) => {
      setIsFullScreenState(value);
      if (!value) {
        if (typeof window !== 'undefined') localStorage.removeItem('ai-fullscreen');
        setTimeout(() => {
          setIsFullScreenQuery(null).catch(console.error);
        }, 0);
      } else {
        setIsFullScreenQuery('true').catch(console.error);
        if (typeof window !== 'undefined') localStorage.setItem('ai-fullscreen', 'true');
      }
    },
    [setIsFullScreenQuery],
  );

  useEffect(() => {
    const queryValue = isFullScreenQuery === 'true';
    if (isFullScreenQuery !== null && queryValue !== isFullScreen) setIsFullScreenState(queryValue);
  }, [isFullScreenQuery, isFullScreen]);

  useEffect(() => {
    if (typeof window !== 'undefined' && !isFullScreenQuery) {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen === 'true') setIsFullScreenQuery('true');
    }
    if (isFullScreenQuery === null && isFullScreen) setIsFullScreenState(false);
  }, [isFullScreenQuery, setIsFullScreenQuery, isFullScreen]);

  return { isFullScreen, setIsFullScreen };
}

export function useAISidebarState() {
  const [open, setOpenQuery] = useQueryState('aiSidebar');
  const [viewModeQuery, setViewModeQuery] = useQueryState('viewMode');
  const { isFullScreen, setIsFullScreen } = useAIFullScreen();

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    if (viewModeQuery) return viewModeQuery as ViewMode;
    if (typeof window !== 'undefined') {
      const savedViewMode = localStorage.getItem('ai-viewmode');
      if (savedViewMode && (savedViewMode === 'sidebar' || savedViewMode === 'popup')) {
        return savedViewMode as ViewMode;
      }
    }
    return 'popup';
  });

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode);
      setViewModeQuery(mode === 'popup' ? null : mode);
      if (typeof window !== 'undefined') localStorage.setItem('ai-viewmode', mode);
    },
    [setViewModeQuery],
  );

  const setOpen = useCallback(
    (openState: boolean) => {
      if (!openState) {
        if (typeof window !== 'undefined') localStorage.removeItem('ai-sidebar-open');
        setTimeout(() => {
          setOpenQuery(null).catch(console.error);
        }, 0);
      } else {
        setOpenQuery('true').catch(console.error);
        if (typeof window !== 'undefined') localStorage.setItem('ai-sidebar-open', 'true');
      }
    },
    [setOpenQuery],
  );

  const toggleOpen = useCallback(() => setOpen(open !== 'true'), [open, setOpen]);

  useEffect(() => {
    if (viewModeQuery && viewModeQuery !== viewMode) setViewModeState(viewModeQuery as ViewMode);
  }, [viewModeQuery, viewMode]);

  return {
    open: !!open,
    viewMode,
    setViewMode,
    setOpen,
    toggleOpen,
    toggleViewMode: () => setViewMode(viewMode === 'popup' ? 'sidebar' : 'popup'),
    isFullScreen,
    setIsFullScreen,
    isSidebar: viewMode === 'sidebar',
    isPopup: viewMode === 'popup',
  };
}
```

- [ ] **Step 2: Modify `apps/mail/components/ui/ai-sidebar.tsx` to use the extracted state**

In `apps/mail/components/ui/ai-sidebar.tsx`:

1) Remove the old `useAIFullScreen` and `useAISidebar` implementations (they were large and pulled in stateful hooks).
2) Add this import near the top:

```ts
import { useAIFullScreen, useAISidebarState } from './ai-sidebar-state';
```

3) Update the component to call `useAISidebarState()` (or alias it) where it previously used `useAISidebar()`.

4) Add this export at the bottom to preserve legacy imports elsewhere:

```ts
export { useAIFullScreen, useAISidebarState as useAISidebar };
```

Keep `export default AISidebar;` unchanged.

- [ ] **Step 3: Modify `apps/mail/components/ai-toggle-button.tsx`**

Change:

```ts
import { useAISidebar } from './ui/ai-sidebar';
```

To:

```ts
import { useAISidebarState } from './ui/ai-sidebar-state';
```

And change the hook usage accordingly:

```ts
const { toggleOpen: toggleAISidebar, open: isSidebarOpen } = useAISidebarState();
```

- [ ] **Step 4: Run a build to ensure exports/imports are correct**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add apps/mail/components/ui/ai-sidebar-state.ts apps/mail/components/ui/ai-sidebar.tsx apps/mail/components/ai-toggle-button.tsx`

Run:
`git commit -m "perf(mail): extract AI sidebar state and reduce eager imports"`

---

### Task 2: Lazy-load the AI sidebar UI in the mail layout

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Update `apps/mail/components/mail/mail.tsx` imports**

Remove the static import of AI sidebar UI if present:

```ts
import AISidebar from '@/components/ui/ai-sidebar';
```

Add:

```ts
import { lazy, Suspense } from 'react';

const AISidebar = lazy(() => import('@/components/ui/ai-sidebar'));
```

(If the file already imports React hooks from `react`, include `lazy`/`Suspense` in the same import.)

- [ ] **Step 2: Wrap AI sidebar render in `Suspense`**

Replace:

```tsx
{activeConnection?.id ? <AISidebar /> : null}
```

With:

```tsx
{activeConnection?.id ? (
  <Suspense fallback={null}>
    <AISidebar />
  </Suspense>
) : null}
```

- [ ] **Step 3: Build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:
`git add apps/mail/components/mail/mail.tsx`

Run:
`git commit -m "perf(mail): lazy-load AI sidebar UI chunk"`

---

### Task 3: Lazy-load compose (`CreateEmail`) inside the sidebar dialog

**Files:**
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Remove static `CreateEmail` import**

In `apps/mail/components/ui/app-sidebar.tsx`, remove:

```ts
import { CreateEmail } from '../create/create-email';
```

- [ ] **Step 2: Add `lazy` + `Suspense` imports**

Ensure React import includes `lazy` and `Suspense`:

```ts
import React, { lazy, Suspense, useMemo, useState } from 'react';
```

- [ ] **Step 3: Add lazy component**

Add near the bottom/top-level (outside components):

```ts
const CreateEmail = lazy(() =>
  import('../create/create-email').then((module) => ({ default: module.CreateEmail })),
);
```

- [ ] **Step 4: Wrap `CreateEmail` with `Suspense`**

Replace:

```tsx
<CreateEmail />
```

With:

```tsx
<Suspense fallback={null}>
  <CreateEmail />
</Suspense>
```

- [ ] **Step 5: Build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:
`git add apps/mail/components/ui/app-sidebar.tsx`

Run:
`git commit -m "perf(mail): lazy-load compose UI from sidebar dialog"`

---

### Task 4: Lazy-load onboarding wrapper + defer confetti until needed

**Files:**
- Modify: `apps/mail/app/(routes)/mail/layout.tsx`
- Modify: `apps/mail/components/onboarding.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Lazy-load onboarding wrapper in mail layout**

In `apps/mail/app/(routes)/mail/layout.tsx`:

1) Remove:

```ts
import { OnboardingWrapper } from '@/components/onboarding';
```

2) Add:

```ts
import { lazy, Suspense } from 'react';

const OnboardingWrapper = lazy(() =>
  import('@/components/onboarding').then((module) => ({ default: module.OnboardingWrapper })),
);
```

3) Wrap usage:

```tsx
<Suspense fallback={null}>
  <OnboardingWrapper />
</Suspense>
```

- [ ] **Step 2: Defer `canvas-confetti` import**

In `apps/mail/components/onboarding.tsx`:

1) Remove:

```ts
import confetti from 'canvas-confetti';
```

2) Replace the confetti call in the “final step” effect with:

```ts
import('canvas-confetti')
  .then(({ default: confetti }) =>
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
    }),
  )
  .catch(console.error);
```

- [ ] **Step 3: Build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:
`git add apps/mail/app/(routes)/mail/layout.tsx apps/mail/components/onboarding.tsx`

Run:
`git commit -m "perf(mail): lazy-load onboarding and defer confetti import"`

---

### Task 5: Lazy-load command palette provider (only after first use)

**Files:**
- Create: `apps/mail/components/context/lazy-command-palette-provider.tsx`
- Modify: `apps/mail/app/(routes)/layout.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Create `apps/mail/components/context/lazy-command-palette-provider.tsx`**

```tsx
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

const CommandPaletteProvider = lazy(() =>
  import('@/components/context/command-palette-context').then((module) => ({
    default: module.CommandPaletteProvider,
  })),
);

export function LazyCommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        setIsLoaded(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!isLoaded) return <>{children}</>;

  return (
    <Suspense fallback={<>{children}</>}>
      <CommandPaletteProvider>{children}</CommandPaletteProvider>
    </Suspense>
  );
}
```

- [ ] **Step 2: Wire it into the `(routes)` layout**

In `apps/mail/app/(routes)/layout.tsx`:

Replace:

```ts
import { CommandPaletteProvider } from '@/components/context/command-palette-context';
```

With:

```ts
import { LazyCommandPaletteProvider } from '@/components/context/lazy-command-palette-provider';
```

And replace the wrapper component:

```tsx
<LazyCommandPaletteProvider>
  ...
</LazyCommandPaletteProvider>
```

- [ ] **Step 3: Build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:
`git add apps/mail/components/context/lazy-command-palette-provider.tsx apps/mail/app/(routes)/layout.tsx`

Run:
`git commit -m "perf(mail): lazy-load command palette provider on first use"`

---

### Task 6: Gate heavy mail-only hotkeys behind a prop

**Files:**
- Modify: `apps/mail/components/providers/hotkey-provider-wrapper.tsx`
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Add prop to wrapper**

Change the props to:

```ts
interface HotkeyProviderWrapperProps {
  children: React.ReactNode;
  includeMailHotkeys?: boolean;
}
```

Update the component signature:

```ts
export function HotkeyProviderWrapper({
  children,
  includeMailHotkeys = true,
}: HotkeyProviderWrapperProps) {
```

Wrap the mail-only hotkeys:

```tsx
{includeMailHotkeys ? (
  <>
    <MailListHotkeys />
    <ThreadDisplayHotkeys />
    <ComposeHotkeys />
  </>
) : null}
```

Keep `NavigationHotkeys` and `GlobalHotkeys` always mounted.

- [ ] **Step 2: (Optional) Use `includeMailHotkeys={false}` in non-mail layouts**

If you want to match the original split, update whichever route groups should not mount mail hotkeys. (If this causes behavioral regressions, skip and keep default.)

- [ ] **Step 3: Build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:
`git add apps/mail/components/providers/hotkey-provider-wrapper.tsx`

Run:
`git commit -m "perf(mail): gate mail hotkeys behind wrapper option"`

---

### Task 7: Reduce dev startup overhead in `vite.config.ts`

**Files:**
- Modify: `apps/mail/vite.config.ts`
- Test: `pnpm --filter=@zero/mail dev` (manual)
- Test: `pnpm --filter=@zero/mail build`

- [ ] **Step 1: Make `oxlint` plugin opt-in**

Replace:

```ts
oxlintPlugin(),
```

With:

```ts
process.env.VITE_ENABLE_OXLINT === 'true' ? oxlintPlugin() : null,
```

- [ ] **Step 2: Make React compiler transform opt-in**

Replace the unconditional `babel(...)` plugin with:

```ts
process.env.VITE_ENABLE_REACT_COMPILER === 'true'
  ? babel({
      filter: /\.[jt]sx?$/,
      babelConfig: {
        presets: ['@babel/preset-typescript'],
        plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
      },
    })
  : null,
```

- [ ] **Step 3: Filter out null plugins**

Wrap plugins list:

```ts
plugins: [
  ...,
].filter(Boolean),
```

- [ ] **Step 4: Narrow warmup targets**

Replace the broad warmup:

```ts
warmup: { clientFiles: ['./app/**/*', './components/**/*'] },
```

With:

```ts
warmup:
  process.env.VITE_DISABLE_WARMUP === 'true'
    ? undefined
    : {
        clientFiles: ['./app/entry.client.tsx', './app/root.tsx', './app/(routes)/mail/page.tsx'],
      },
```

- [ ] **Step 5: Verify dev server still starts**

Run:
`pnpm --filter=@zero/mail dev`

Expected: server prints Local URL and connects.

- [ ] **Step 6: Verify build**

Run:
`pnpm --filter=@zero/mail build`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:
`git add apps/mail/vite.config.ts`

Run:
`git commit -m "perf(dev): narrow warmup and make heavy transforms opt-in"`

---

### Task 8: Verify the performance win (compare bundle outputs)

**Files:** none

- [ ] **Step 1: Run a fresh build**

Run:
`pnpm --filter=@zero/mail build`

- [ ] **Step 2: Confirm AI sidebar chunk reduction**

In the build output, locate the `build/client/assets/ai-sidebar-*.js` line.

Expected: it should be **far smaller** than before (tens of KB instead of ~1MB).

- [ ] **Step 3: Commit any final small fixups**

Only if you needed to fix imports/exports to satisfy the build.

---

## Appendix A (Optional, NOT frontend-only): backend hardening for Autumn when secrets are missing

If you also want local demo environments to avoid server crashes when `AUTUMN_SECRET_KEY` is missing, implement this backend change.

### Task A1: Guard Autumn initialization

**Files:**
- Modify: `apps/server/src/routes/autumn.ts`

- [ ] **Step 1: Set `autumn` to null when `AUTUMN_SECRET_KEY` is missing**

Change the `.use('*', ...)` middleware from:

```ts
c.set('autumn', new Autumn({ secretKey: env.AUTUMN_SECRET_KEY }));
```

To:

```ts
if (env.AUTUMN_SECRET_KEY) {
  c.set('autumn', new Autumn({ secretKey: env.AUTUMN_SECRET_KEY }));
} else {
  c.set('autumn', null);
}
```

- [ ] **Step 2: Early-return for each Autumn route when not configured**

Add near the top of each handler (after customerData check):

```ts
if (!autumn) return c.json({ error: 'Autumn is not configured' }, 501);
```

- [ ] **Step 3: Run server dev and confirm no 500**

Run:
`pnpm --filter=@zero/server dev`

Expected: requests to `/api/autumn/*` return 501 (configured) or 401 (no session), but not a crash/500 due to missing secret.

- [ ] **Step 4: Commit**

Run:
`git add apps/server/src/routes/autumn.ts`

Run:
`git commit -m "fix(server): make Autumn routes safe without AUTUMN_SECRET_KEY"`

---

## Self-review checklist (for the implementing agent)

- [ ] **Spec coverage:** all items in “Scope” implemented via Tasks 1–7.
- [ ] **Placeholder scan:** no “TODO/TBD” in code changes; all steps have concrete code.
- [ ] **Export compatibility:** `apps/mail/components/ui/ai-sidebar.tsx` exports `useAIFullScreen` and `useAISidebar` aliases so existing imports don’t break.
- [ ] **Build proof:** saved before/after build logs show chunk size improvements.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-09-frontend-startup-perf.md`.

Two execution options:

1) **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration  
2) **Inline Execution** - execute tasks in one session with checkpoints

Which approach?

