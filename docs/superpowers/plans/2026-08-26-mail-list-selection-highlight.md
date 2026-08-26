# Fix Inbox Mail Row Selection Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep exactly one Inbox row visually active during arrow-key navigation and make selected rows clearly visible in light and dark themes without leaving a stale browser focus outline on the previously clicked row.

**Architecture:** Keep the existing `focusedIndex`/`threadId` navigation and compose-flush ordering. Add small pure contracts for row selection and focus-target resolution. A reactive keyboard-navigation mode makes `focusedIndex` authoritative while arrows are active; an inner-row ref focuses the closest draggable wrapper when that row mounts, while a bounded post-render retry covers virtualized rows that are already expected to mount. Strengthen the existing row tokens with an explicit inset ring/background and suppress the wrapper fallback ring during keyboard navigation so only one ring is visible.

**Tech Stack:** React 19, TypeScript, Jotai, `react-hotkeys-hook`, `@dnd-kit/core`, Tailwind CSS v4, Vitest + happy-dom.

## Global Constraints

- Pilot-RDS safety: before Vitest, run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`; never use a pilot or production database for tests.
- Preserve `runComposeLeaveFlush(...)` before `setThreadId(...)`; the documented draft-loss prevention ordering is out of scope.
- Preserve pointer drag behavior, `useDraggable` data, keyboard shortcuts, virtualization, bulk selection, and URL navigation semantics.
- Use existing `primary`, `bg-*`, and `ring-*` theme tokens; do not introduce a new color system or dependency.
- Keep all plan and implementation file references repo-relative.
- Do not run project-wide `pnpm check`, `pnpm lint`, or formatting commands; use targeted checks only, per `AGENT.md`.

---

## Problem Frame and Confirmed Root Cause

The row selected by a pointer click keeps a black/white rectangle after ArrowUp/ArrowDown moves the visible active row. The rectangle is the browser's native focus outline: the August 4 drag-to-folder change spreads `useDraggable` attributes onto the outer row, making it focusable, while `useMailNavigation` only changes `focusedIndex` and requests the next URL thread id. It never moves DOM focus. The previous row therefore keeps focus. The new row's `bg-primary/5` is too subtle, and `ring-primary/50` only supplies ring color without an explicit ring width, so the two states look inconsistent.

The compose-leave promise intentionally delays `threadId` until after draft flushing. The visual fix must not reorder that promise. While keyboard navigation is active, the row at `focusedIndex` is the sole non-bulk active row; this removes the short period where the URL still names the previous row while the navigation state already names the next one.

## Requirements Traceability

| Requirement | Planned proof |
|---|---|
| The previously clicked row loses its stale outline | Runtime happy-dom navigation test asserts `document.activeElement` moves from row A to row B; wrapper focus styling is explicitly suppressed during keyboard mode. |
| Only the keyboard-focused row is active while arrows are moving | `isMailRowActive` returns false for the old URL-selected row when keyboard navigation is active; unit tests cover the transient async URL state. |
| Selected/bulk-selected rows are obvious in both themes | Active class contract includes `bg-primary/10`, `ring-1 ring-inset`, and keyboard `ring-2`; helper tests assert the tokens. |
| Existing navigation/drag/compose behavior remains intact | Runtime Escape/pointer transition tests, source contract for compose-flush ordering and drag attributes, plus targeted mail tests and TypeScript/build checks. |

## Settled Technical Decisions

1. Keep `data-thread-id` on the existing inner row so current e2e selectors and scroll lookup remain stable; focus its closest focusable draggable ancestor.
2. Add `isKeyboardNavigationActive` as a local `Thread` prop, not a global atom or new context. `useMailNavigation` keeps a synchronous ref for event guards and a mirrored state value for rendering; `MailList` passes that state with `isKeyboardFocused`.
3. Use a pure helper in `apps/mail/lib/mail/mail-row-selection.ts` so active-row exclusivity and Tailwind tokens have deterministic unit coverage without rendering the entire mail surface.
4. Put DOM-only target resolution in `apps/mail/lib/mail/mail-row-focus.ts`: `getFocusableThreadElement` resolves the draggable ancestor and `focusThreadElement` applies `focus({ preventScroll: true })`. This keeps hook tests independent of mail data and gives the row mount callback the same behavior as the navigation effect.
5. Remove only the native outline (`focus:outline-none`) and add a `focus-visible` ring to the draggable wrapper only when keyboard navigation is inactive. The inner row's state-driven ring is the sole keyboard-active visual.
6. Focus the new row from a bounded post-render effect keyed by both `focusedIndex` and focused thread id, guarded by `keyboardActiveRef.current`. The `Thread` ref callback repeats the focus when a virtualized/loading row mounts later, so a null lookup cannot leave accessibility focus stranded.

## Alternatives Considered

- CSS-only suppression would hide the symptom but leave DOM focus on the old row; rejected for stale accessibility/focus state.
- Focus handoff without state-driven highlighting would move the outline but keep the new row hard to see and allow two active signals during the async URL update; rejected.
- The chosen state-driven highlight plus focus handoff fixes visual and DOM state together without changing navigation timing or adding dependencies.

## File Map

| File | Responsibility |
|---|---|
| `apps/mail/lib/mail/mail-row-selection.ts` | Pure active-row decision and theme-aware class tokens. |
| `apps/mail/lib/mail/mail-row-focus.ts` | Pure DOM target resolution and prevent-scroll focus helper. |
| `apps/mail/hooks/use-mail-navigation.ts` | Keep keyboard mode reactive and focus the current row after index/id changes with bounded retry. |
| `apps/mail/components/mail/mail-list.tsx` | Consume the helper, pass keyboard-mode state, and apply wrapper focus classes. |
| `apps/mail/types/index.ts` | Extend `ThreadProps` with the local keyboard-navigation-mode flag. |
| `apps/mail/tests/mail-row-selection.test.ts` | Unit coverage for selection exclusivity and class contrast. |
| `apps/mail/tests/mail-row-focus.test.ts` | DOM helper coverage for focus target resolution and prevent-scroll focus. |
| `apps/mail/tests/use-mail-navigation.test.tsx` | happy-dom hook/list navigation coverage for active-element handoff, delayed mount, Escape, and pointer transitions. |
| `apps/mail/tests/mail-list-selection-contract.test.ts` | Integration contract ensuring the list wires the helper, prop, and focus styles. |

## High-Level Flow

```text
Pointer click
  └─ browser focuses draggable wrapper; click sets focusedIndex

ArrowUp / ArrowDown
  ├─ keyboardActiveRef = true
  ├─ focusedIndex = next index
  ├─ render: helper ignores stale threadId row and styles only focused row
  ├─ effect: data-thread-id row → closest [tabindex] wrapper → focus()
  └─ existing compose flush → setThreadId(next id) remains unchanged
```

## Implementation Units

### U1. Add the pure mail-row selection contract

**Goal:** Encode the rule that keyboard navigation owns the single active-row highlight while preserving selected and bulk-selected fallback behavior.

**Requirements:** Active-row exclusivity; visible theme-aware classes; no external state or dependency changes.

**Dependencies:** None.

**Files:**
- Create: `apps/mail/lib/mail/mail-row-selection.ts`
- Create: `apps/mail/tests/mail-row-selection.test.ts`

**Interfaces:**
- `MailRowSelectionInput`:
  - `isMailSelected: boolean` — URL/current-thread selection fallback.
  - `isMailBulkSelected: boolean` — independent bulk-selection visual state; this intentionally remains active even while keyboard navigation owns the focused row.
  - `isKeyboardFocused: boolean` — true only for the row at `focusedIndex` while keyboard mode is active.
  - `isKeyboardNavigationActive: boolean` — whether the focused-index authority is active.
- `isMailRowActive(input: MailRowSelectionInput): boolean`
- `getMailRowSelectionClasses(input: MailRowSelectionInput): string`

**Approach:**

`isMailRowActive` returns `true` for bulk selection regardless of mode. If keyboard mode is active, it returns only `isKeyboardFocused`; otherwise it returns `isMailSelected`. `getMailRowSelectionClasses` returns `bg-primary/10 opacity-100 ring-1 ring-inset ring-primary/60` for a base active row and `bg-primary/15 opacity-100 ring-2 ring-inset ring-primary/70` for the keyboard-focused row. Inactive rows return an empty string. Keep the helper framework-free so tests can run in Node.

**TDD steps:**

- [ ] **Step 1: Write the failing tests.** Add cases for a URL-selected row with keyboard mode off, the stale URL-selected row during keyboard mode, the keyboard-focused row, a bulk-selected non-focused row, and an inactive row. Assert the exact input contract and that base/keyboard classes contain `bg-primary/10` or `bg-primary/15`, `ring-1` or `ring-2`, and `ring-inset`.

  ```ts
  const staleUrlSelection = {
    isMailSelected: true,
    isMailBulkSelected: false,
    isKeyboardFocused: false,
    isKeyboardNavigationActive: true,
  };
  expect(isMailRowActive(staleUrlSelection)).toBe(false);
  expect(getMailRowSelectionClasses(staleUrlSelection)).toBe('');
  ```
- [ ] **Step 2: Run the focused test before implementation.** Run `cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/mail-row-selection.test.ts`; expect module-resolution failure because `mail-row-selection.ts` does not yet exist.
- [ ] **Step 3: Implement the minimal pure helper.** Export the interface, implement the mode/bulk decision, and return the two explicit class-token strings; do not import React, Tailwind, or `cn`.

  ```ts
  export function isMailRowActive(input: MailRowSelectionInput): boolean {
    if (input.isMailBulkSelected) return true;
    return input.isKeyboardNavigationActive ? input.isKeyboardFocused : input.isMailSelected;
  }
  ```
- [ ] **Step 4: Run the focused test after implementation.** Re-run the command from Step 2 and expect all selection cases to pass.

**Verification:** `apps/mail/tests/mail-row-selection.test.ts` passes and the returned class strings contain explicit ring width (`ring-1`/`ring-2`) plus non-zero primary backgrounds.

### U2. Move DOM focus with keyboard navigation

**Goal:** Ensure the focusable draggable wrapper follows `focusedIndex` instead of retaining focus on the pointer-clicked row.

**Requirements:** Stale outline removal; keyboard/assistive focus parity; virtualization-safe lookup; no change to navigation URL or compose flushing.

**Dependencies:** None (can be implemented independently of U1, but wire after U1 for final integration).

**Files:**
- Create: `apps/mail/lib/mail/mail-row-focus.ts`
- Modify: `apps/mail/hooks/use-mail-navigation.ts`
- Create: `apps/mail/tests/mail-row-focus.test.ts`
- Create: `apps/mail/tests/use-mail-navigation.test.tsx`

**Interfaces:**
- `getFocusableThreadElement(threadElement: HTMLElement | null): HTMLElement | null`
- `focusThreadElement(threadElement: HTMLElement | null): boolean`
- Internal hook callback `focusThreadAtIndex(index: number): boolean` — resolves `itemsRef.current[index]`, queries its `[data-thread-id]` node, and delegates to `focusThreadElement`.

**Approach:**

Keep `getThreadElement` querying the existing `[data-thread-id]` node. Add `getFocusableThreadElement` that returns the node itself when it has a `tabindex`, otherwise its closest `[tabindex]` ancestor. `focusThreadElement` calls `focus({ preventScroll: true })` and returns whether a focus target existed. The hook's `focusThreadAtIndex` callback uses that helper. An effect runs after a `focusedIndex` render only when `keyboardActiveRef.current` is true; it is keyed by both the numeric index and `itemsRef.current[index]?.id`, tries immediately, and retries for at most six animation frames when virtualization has not mounted the target yet. The `Thread` row will also call `focusThreadElement` from its own ref callback in U3, covering a target that mounts after the retry window. Pointer clicks retain their normal browser focus path; Escape clears the ref/state before the effect can focus a cleared index.

**TDD steps:**

- [ ] **Step 1: Write the pure focus-helper tests.** In happy-dom, assert an inner `data-thread-id` node resolves to its `tabindex="0"` wrapper, a focusable node resolves to itself, null/detached nodes return null, and `focusThreadElement` focuses the wrapper without scrolling.

  ```ts
  const wrapper = document.createElement('div');
  wrapper.tabIndex = 0;
  const row = document.createElement('div');
  wrapper.append(row);
  expect(getFocusableThreadElement(row)).toBe(wrapper);
  expect(focusThreadElement(row)).toBe(true);
  expect(document.activeElement).toBe(wrapper);
  ```
- [ ] **Step 2: Write the navigation integration tests.** Mock only `react-hotkeys-hook`, `nuqs`, `useOptimisticActions`, and `useMail`; render a small hook harness with two `[data-thread-id]` rows in a `tabindex="0"` wrapper. Capture the ArrowDown callback, focus row A, invoke it inside `act`, and assert row B is `document.activeElement`. Assert Escape clears `keyboardActive` and a pointer `handleMouseEnter` transition clears it. Render row B late and assert the bounded retry focuses it; replace the id at the same index and assert the id-keyed effect focuses the replacement.
- [ ] **Step 3: Run the focused tests before implementation.** Run `cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/mail-row-focus.test.ts tests/use-mail-navigation.test.tsx`; expect missing-module or missing-export failures.
- [ ] **Step 4: Implement the pure focus helpers.** Add the null-safe `matches('[tabindex]')`/`closest('[tabindex]')` resolution and the prevent-scroll focus call.

  ```ts
  export function focusThreadElement(threadElement: HTMLElement | null): boolean {
    const target = getFocusableThreadElement(threadElement);
    if (!target) return false;
    if (document.activeElement === target) return true;
    target.focus({ preventScroll: true });
    return true;
  }
  ```
- [ ] **Step 5: Implement reactive keyboard state and post-render focus.** Mirror `keyboardActiveRef` with `useState`; set both on arrow navigation, command-driven next, held-arrow scrolling, Escape, search focus, pointer/multi-select paths, and reset. Add the focused-index/id effect with cancellation and bounded `requestAnimationFrame` retry.

  ```ts
  const [keyboardActive, setKeyboardActive] = useState(false);
  const setKeyboardNavigationActive = useCallback((active: boolean) => {
    keyboardActiveRef.current = active;
    setKeyboardActive(active);
  }, []);

  useEffect(() => {
    if (!keyboardActive || focusedIndex === null || !focusedThreadId) return;
    let attempts = 0;
    const tryFocus = () => {
      if (focusThreadAtIndex(focusedIndex) || attempts >= 6) return;
      attempts += 1;
      requestAnimationFrame(tryFocus);
    };
    tryFocus();
  }, [focusedIndex, focusedThreadId, keyboardActive, focusThreadAtIndex]);
  ```
- [ ] **Step 6: Run the focused tests after implementation.** Re-run the command from Step 3 and expect all active-element, delayed-mount, replacement, Escape, pointer, and helper cases to pass.

**Verification:** The helper tests pass; targeted TypeScript checks accept `focus({ preventScroll: true })`; no URL, compose, or drag payload code is changed.

### U3. Wire state-driven styling and focus semantics into the list

**Goal:** Apply the helper to each `Thread` row, make keyboard mode explicit, and remove the browser's stranded native outline while preserving an accessible keyboard focus ring.

**Requirements:** All user-visible behavior in the request; existing memoization and virtual rows remain correct.

**Dependencies:** U1 and U2.

**Files:**
- Modify: `apps/mail/types/index.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Create: `apps/mail/tests/mail-list-selection-contract.test.ts`

**Approach:**

Extend `ThreadProps` with optional `isKeyboardNavigationActive?: boolean`. Import `getMailRowSelectionClasses` and `focusThreadElement`; use the selection helper for the inner `data-thread-id` row. Add `focus:outline-none` to the outer draggable wrapper and conditionally add `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60` only when `isKeyboardNavigationActive` is false. Add a stable inner-row ref callback that calls `focusThreadElement` when `isKeyboardFocused` is true; this is the mount-safe handoff for rows that appear after the hook effect. Pass `isKeyboardNavigationActive={keyboardActive}` alongside `isKeyboardFocused={focusedIndex === row.threadIndex && keyboardActive}`. Include the new prop and ref callback in the `Thread` memo comparator/content memo dependencies so mode transitions cannot leave a stale row class or focus callback.

The contract test reads the relevant source slices and asserts that the helper is consumed, keyboard mode is passed, the wrapper suppresses the default outline, and the focus-visible ring is present. This follows the existing mail contract-test pattern for large UI components while U1/U2 retain behavior-focused unit tests.

**TDD steps:**

- [ ] **Step 1: Write the source contract tests.** Assert `ThreadProps` declares `isKeyboardNavigationActive`, `mail-list.tsx` imports/uses both pure helpers, passes `keyboardActive`, has `focus:outline-none`, gates `focus-visible:ring-2` on non-keyboard mode, and includes the new prop in the memo comparator/content dependencies. Assert the existing `runComposeLeaveFlush` call appears before the click handler's `setThreadId(messageThreadId)`.

  ```ts
  expect(listSource).toContain('isKeyboardNavigationActive={keyboardActive}');
  expect(listSource).toContain('focus:outline-none');
  expect(listSource).toContain('!isKeyboardNavigationActive &&');
  expect(clickHandler.indexOf('runComposeLeaveFlush')).toBeLessThan(
    clickHandler.indexOf('setThreadId(messageThreadId)'),
  );
  ```
- [ ] **Step 2: Implement the type and list wiring.** Add the optional prop; replace the inline OR/background/ring expression with `getMailRowSelectionClasses`; attach the ref callback to the inner row; add the conditional wrapper focus classes; pass and compare the mode prop without moving drag attributes/listeners or compose-flush calls.

  ```tsx
  const selectionClasses = getMailRowSelectionClasses({
    isMailSelected,
    isMailBulkSelected,
    isKeyboardFocused,
    isKeyboardNavigationActive,
  });

  <div
    ref={setDragNodeRef}
    className={cn(
      '... focus:outline-none',
      !isKeyboardNavigationActive &&
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
    )}
    {...dragListeners}
    {...dragAttributes}
  >
    <div ref={setThreadElementRef} data-thread-id={idToUse} className={selectionClasses} />
  </div>
  ```
- [ ] **Step 3: Run the focused integration/contract tests.** Run `cd apps/mail && unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/mail-list-selection-contract.test.ts tests/demo-mail-list-perf-guards.test.ts`; expect both source wiring and existing list guards to pass.
- [ ] **Step 4: Run the complete targeted verification.** Run the U1/U2 tests together with these list tests, then targeted ESLint, TypeScript, and build commands from the Verification Matrix.

**Verification:** `mail-row-selection`, `use-mail-navigation`, `mail-list-selection-contract`, and existing `demo-mail-list-perf-guards` tests pass; targeted ESLint, TypeScript, and frontend build pass.

## Verification Matrix

Generate ignored Paraglide output first on a clean checkout, then run every Vitest command with the pilot variables unset:

```bash
pnpm --dir apps/mail exec paraglide-js compile \
  --project ./project.inlang \
  --outdir ./paraglide \
  --strategy cookie baseLocale \
  --silent
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/mail exec vitest run \
  tests/mail-row-selection.test.ts \
  tests/mail-row-focus.test.ts \
  tests/use-mail-navigation.test.tsx \
  tests/mail-list-selection-contract.test.ts \
  tests/demo-mail-list-perf-guards.test.ts
```

Expected: all listed tests pass with zero failures and no pilot database connection.

Then run targeted static checks (never the project-wide commands prohibited by `AGENT.md`):

```bash
pnpm --dir apps/mail exec eslint \
  lib/mail/mail-row-selection.ts \
  lib/mail/mail-row-focus.ts \
  hooks/use-mail-navigation.ts \
  components/mail/mail-list.tsx \
  types/index.ts \
  tests/mail-row-selection.test.ts \
  tests/mail-row-focus.test.ts \
  tests/use-mail-navigation.test.tsx \
  tests/mail-list-selection-contract.test.ts
pnpm exec tsc -p apps/mail/tsconfig.json --noEmit
pnpm --filter=@zero/mail build
```

Expected: ESLint exits 0 (the repository currently emits two pre-existing hook-dependency warnings in `mail-list.tsx`), the changed files add no TypeScript diagnostics, and the mail frontend build exits 0. A full mail `tsc` invocation may still report the repository's existing route `+types/*`, composer/thread-display, server-tool, demo-test, and server `Env` diagnostics; those are outside this fix and must be recorded rather than masked.

Finally inspect `git diff --check` and the complete diff for unintended changes. Manual browser verification should cover: click a middle row, press ArrowDown/ArrowUp repeatedly, confirm only the current row has the visible primary ring/background in light and dark themes, press Escape, and drag a row to a folder to confirm drag behavior is unchanged.

## Risks and Mitigations

- **Virtualized row not mounted:** the focused-index/id effect retries for six animation frames, and the row's own ref callback focuses it when a loading/recycled row mounts later; the helper is null-safe and the old wrapper outline is suppressed during keyboard mode.
- **Bulk selection overlap:** bulk selection remains an independent active signal; arrow navigation already clears bulk selection through `navigateToThread`.
- **Memoized row stale props:** include the new mode prop in both the `Thread` comparator and content memo dependencies.
- **Two-ring keyboard state:** the wrapper focus-visible ring is rendered only outside keyboard mode; keyboard rows use the single inner state-driven ring.
- **Reactive mode transitions:** mirror the keyboard ref with state and clear both paths on Escape, search focus, pointer/multi-select clicks, and command navigation.
- **Accessibility regression from hidden native outline:** preserve an explicit non-navigation `focus-visible` ring and move focus to the current keyboard row.
- **Draft data loss:** do not touch `runComposeLeaveFlush` or its ordering.

## Deferred to Follow-Up Work

- Converting the mail list to a formal `aria-activedescendant`/listbox model.
- Reworking the global arrow-key handler or replacing the virtual list.
- A full browser visual-regression suite for both themes.

## Review Disposition

The mandatory repository/research review found no matching issue or prior solution; it confirmed the `useDraggable` focusability, historical removal of the explicit `ring-2`, and the compose-flush ordering. The UI design review approved the direction and required four changes: reactive keyboard mode, a mount-safe row ref, no simultaneous wrapper/inner keyboard rings, and stronger base contrast. The engineering completeness review initially blocked the draft for missing runtime focus proof, incomplete virtualization handling, underspecified helper interfaces, incorrect package-relative commands, and missing Paraglide bootstrap. Those findings are reconciled above by adding the pure focus module, a happy-dom navigation harness (including delayed mount and same-index id replacement), explicit interface semantics, state/ref synchronization across all navigation boundaries, bounded retry plus row ref, and corrected verification commands. The reviewer's simplicity gate remains satisfied: no new dependency, global atom, listbox rewrite, or unrelated UI refactor.
