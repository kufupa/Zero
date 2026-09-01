# Inbox Mail Row Selection Highlight Design

## Problem

Clicking a thread in the Inbox makes the drag-and-drop wrapper focusable through
`useDraggable`. Arrow-key navigation changes the mail navigation state, but it
does not move DOM focus. The browser therefore keeps its native focus outline
on the originally clicked row while the newly navigated row receives only the
very subtle selection background. In light and dark themes this looks like two
different rows are selected.

## Evidence and causal chain

1. `apps/mail/components/mail/mail-list.tsx` spreads `useDraggable` attributes
   onto the outer row. Those attributes make the row a focusable button-like
   element.
2. The click handler records `focusedIndex` and eventually updates `threadId`
   after the compose-leave flush.
3. `apps/mail/hooks/use-mail-navigation.ts` handles ArrowUp/ArrowDown by
   changing `focusedIndex` and requesting the next `threadId`, but never calls
   `focus()` on the next row.
4. The clicked row consequently keeps the browser focus outline. The new row
   uses `bg-primary/5`; `ring-primary/50` only sets a ring color and does not
   provide a visible ring width, so the keyboard state is hard to see.
5. The compose flush intentionally remains awaited before `threadId` changes;
   changing that ordering would reintroduce the draft-loss race documented in
   `docs/solutions/logic-errors/compose-close-draft-honesty.md`.

The drag-and-drop attributes were introduced by commit `b76c0c16` while the
older selection styling predates them. No tracker or existing solution covers
this regression.

## Requirements

- During keyboard navigation, exactly the row at `focusedIndex` is visually
  active; the previously opened thread must not retain a competing outline or
  active background.
- A selected or bulk-selected row remains clearly visible in both themes.
- The native draggable focus outline must not remain stranded on a pointer-
  clicked row.
- Preserve pointer drag behavior, keyboard shortcuts, virtualization, and the
  existing compose flush-before-thread-switch ordering.
- Add regression coverage for active-row exclusivity and the focus styling
  contract without requiring a live or pilot database.

## Design decision

Use state-driven mail-row highlighting plus focus handoff:

- Pass whether keyboard navigation is active into `Thread`, and treat
  `isKeyboardFocused` as the sole row-selection signal while that mode is
  active. Keep `isMailSelected` as the fallback when no keyboard navigation is
  active, and keep bulk selection independent. The navigation hook mirrors its
  synchronous keyboard ref with state so pointer and search-focus transitions
  rerender the rows immediately.
- Add an explicit theme-aware inset ring and stronger background for active
  rows. The keyboard-focused row gets the stronger ring variant.
- Remove the browser's default focus outline from the draggable wrapper and
  expose a `focus-visible` ring for true keyboard tab focus only while keyboard
  navigation is inactive, so the inner state-driven ring is the sole
  keyboard-active visual.
- After `focusedIndex` or its thread id changes during keyboard navigation,
  focus the associated draggable row (found from its existing
  `data-thread-id` element), retrying briefly when virtualization has not
  mounted it yet. The `Thread` row also focuses its closest draggable ancestor
  from a mount ref callback, covering rows that load or mount after the retry.
  This keeps assistive technology and drag interactions aligned with the visual
  active row and prevents the old row from retaining DOM focus.
- Leave the compose flush and URL navigation flow unchanged.

## Alternatives considered

### CSS-only suppression

Hide the native outline and strengthen the background/ring. This is the
smallest patch, but DOM focus would still be on the old row and assistive
technology would receive stale focus information.

### Focus handoff only

Call `focus()` on the next row and retain the existing subtle background. This
fixes the stale outline but leaves the keyboard-selected state difficult to see
and still allows a short async window with two selection signals.

### State-driven highlighting plus focus handoff (chosen)

It fixes the visual and semantic causes together, keeps the current navigation
contract, and avoids changing URL/compose timing. The added state is local to
the mail list and has no new dependency or public API.

## Test strategy

- Add pure tests for the row-active decision: selected-only, bulk-selected,
  keyboard-focused, and the transient state where `threadId` still points at
  the prior row during keyboard navigation.
- Add pure selection/focus-helper tests, a happy-dom hook harness that asserts
  `document.activeElement` moves across ArrowDown, delayed and recycled rows,
  Escape/pointer mode transitions, and a source contract that the draggable
  wrapper uses `focus:outline-none`, the active classes include a visible ring
  width, and keyboard mode gates the fallback ring.
- Run the mail test file(s), targeted ESLint/TypeScript checks, and the frontend
  build with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.

## Scope boundaries

No changes to server APIs, mail queries, database state, compose persistence,
drag sensors, route semantics, or unrelated color tokens. No production/pilot
database tests are needed.
