# Outlook Thread Order + Bigger Reply Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reading pane shows messages newest-on-top (Outlook-style), mounts reply composer above the message being replied to, and uses the shared EmailComposer default height (≥200px) instead of a 50px reply strip.

**Architecture:** FE-only display change. Keep `mail.get` `orderBy(asc(receivedAt))` and `latest = last` chronologically. Reverse once in `MessageList` for render. Always mount `ReplyCompose` above the target `MailDisplay`. Delete sticky-bottom latest-only composer. Drop reply `editorClassName="min-h-[50px]"`.

**Tech Stack:** React, nuqs URL compose state, Tailwind, Vitest (no pilot RDS).

## Global Constraints

- Never run Vitest with `DATABASE_URL` pointing at `nava-zero-mail-pilot`; always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` first.
- No user-facing newest/oldest toggle in this slice.
- No API order flip; print HTML stays chronological ascending.
- No sticky-top composer in v1 (pilot can request later if composer scrolls away).
- No new design tokens / card chrome; reuse `border-border`, existing composer shell `max-h-[500px]`.

## Review disposition

| Gate | Verdict | Folded into this plan |
|------|---------|------------------------|
| gstack-plan-eng-review | READY_WITH_STRENGTHENINGS | Scroll gate → `latest.id`; dual-mount DoD; subject chrome on visual index 0 intentional; expanded verification |
| ponytail-review | Shrink | Drop `buildThreadMessageSlots`, drop oldest-id helper, drop sort-by-receivedOn fallback; keep one 3-line reverse helper for TDD only |
| gstack-plan-design-review | approve-with-edits | Composer `py-3` + `border-b`; `scrollIntoView` `block: 'nearest'`; dual-expand OK |

**Conflict resolved:** Eng wanted slots API; ponytail deleted it. Final: tiny `orderMessagesNewestFirst` + JSX reply-before-MailDisplay. Placement proof = helper order tests + DoD dual-mount + verification checklist.

**Upstream grounded plan:** `docs/plans/2026-08-03-001-feat-outlook-thread-order-reply-size-plan.md`

## File map

| File | Responsibility |
|------|----------------|
| `apps/mail/lib/mail/thread-display-order.ts` | `orderMessagesNewestFirst` — copy+reverse of API-asc list |
| `apps/mail/tests/thread-display-order.test.ts` | Unit tests for that helper |
| `apps/mail/components/mail/thread-display.tsx` | MessageList newest-first; reply above target; delete sticky bottom; composer band classes; nearest scroll |
| `apps/mail/components/mail/reply-composer.tsx` | Remove `min-h-[50px]` override |
| `apps/mail/components/mail/mail-display.tsx` | Open-thread scroll uses `isLastEmail` / `latest.id`, not display last index |

---

### Task 1: Newest-first display helper (TDD)

**Files:**
- Create: `apps/mail/lib/mail/thread-display-order.ts`
- Test: `apps/mail/tests/thread-display-order.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `orderMessagesNewestFirst<T>(messages: readonly T[]): T[]` — assumes caller passes API-asc (oldest→newest) non-drafts; returns new array newest-first. No sort fallback. Empty/single → shallow copy.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { orderMessagesNewestFirst } from '../lib/mail/thread-display-order';

describe('orderMessagesNewestFirst', () => {
  it('reverses API-asc messages to newest-first', () => {
    const ordered = orderMessagesNewestFirst([
      { id: 'old' },
      { id: 'mid' },
      { id: 'new' },
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });

  it('returns a new array and does not mutate input', () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    const out = orderMessagesNewestFirst(input);
    expect(out).not.toBe(input);
    expect(input.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('handles empty and single', () => {
    expect(orderMessagesNewestFirst([])).toEqual([]);
    expect(orderMessagesNewestFirst([{ id: 'only' }])).toEqual([{ id: 'only' }]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd apps/mail && pnpm exec vitest run tests/thread-display-order.test.ts
```

Expected: FAIL — module not found / export missing.

- [x] **Step 3: Write minimal implementation**

```typescript
/** Assumes messages are API-asc (oldest → newest). Returns newest-first for the reading pane. */
export function orderMessagesNewestFirst<T>(messages: readonly T[]): T[] {
  return [...messages].reverse();
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd apps/mail && pnpm exec vitest run tests/thread-display-order.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/thread-display-order.ts apps/mail/tests/thread-display-order.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): add newest-first thread display order helper

EOF
)"
```

---

### Task 2: MessageList newest-first + reply above target

**Files:**
- Modify: `apps/mail/components/mail/thread-display.tsx` (`MessageList` ~1193–1238; sticky block ~1164–1173; reply scroll effect ~815–825)

**Interfaces:**
- Consumes: `orderMessagesNewestFirst` from Task 1
- Produces: Display order newest-first; for any `mode && activeReplyId === message.id`, render composer **before** that message’s `MailDisplay`; sticky-bottom block deleted

- [x] **Step 1: Update MessageList to reverse + reply-above**

In `MessageList`, replace the map body with:

```tsx
const MessageList = ({
  messages,
  isFullscreen,
  totalReplies,
  allThreadAttachments,
  mode,
  activeReplyId,
  isMobile,
  trailing,
}: MessageListProps) => {
  const displayMessages = orderMessagesNewestFirst(messages || []);

  return (
    <ScrollArea className={cn('min-w-0 flex-1', isMobile ? 'h-[calc(100%-1px)]' : 'h-full')} type="auto">
      <div className="min-w-0 pb-4">
        {displayMessages.map((message, index) => {
          const isReplyingToThisMessage = Boolean(mode && activeReplyId === message.id);
          // After newest-first reverse, last visual index is chronologically oldest.
          const isChronologicallyOldest = index === displayMessages.length - 1;

          return (
            <div
              key={message.id}
              className={cn('duration-200', index > 0 && 'border-border border-t')}
            >
              {isReplyingToThisMessage ? (
                <div
                  className="border-border border-b px-4 py-3"
                  id={`reply-composer-${message.id}`}
                >
                  <ReplyCompose messageId={message.id} />
                </div>
              ) : null}
              <MailDisplay
                emailData={message}
                isFullscreen={isFullscreen}
                isMuted={false}
                isLoading={false}
                index={index}
                totalEmails={totalReplies}
                threadAttachments={isChronologicallyOldest ? allThreadAttachments : undefined}
              />
            </div>
          );
        })}
        {trailing ? (
          <div className={cn('duration-200', displayMessages.length > 0 && 'border-border border-t')}>
            {trailing}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
};
```

Add import:

```tsx
import { orderMessagesNewestFirst } from '@/lib/mail/thread-display-order';
```

(Use the repo’s existing alias path style if `@/` differs — match neighboring imports in this file.)

- [x] **Step 2: Delete sticky-bottom ReplyCompose block**

Remove the entire block at ~1164–1173:

```tsx
{mode &&
  activeReplyId &&
  activeReplyId === emailData.messages[emailData.messages.length - 1]?.id && (
    <div
      className="border-border bg-panelLight dark:bg-panelDark sticky bottom-0 z-10 border-t px-4 py-2"
      id={`reply-composer-${activeReplyId}`}
    >
      <ReplyCompose messageId={activeReplyId} />
    </div>
  )}
```

DoD: when replying, exactly one `#reply-composer-${id}` in the DOM (inline only).

- [x] **Step 3: Nearest scroll for open reply**

Update the existing scroll effect (~815–825):

```tsx
useEffect(() => {
  if (mode && activeReplyId) {
    setTimeout(() => {
      const replyElement = document.getElementById(`reply-composer-${activeReplyId}`);
      if (replyElement) {
        replyElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }
}, [mode, activeReplyId]);
```

- [x] **Step 4: Sanity-check TypeScript / lint on touched file**

Confirm `isLastMessage` unused locals gone; import resolves.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/mail/thread-display.tsx
git commit -m "$(cat <<'EOF'
feat(mail): newest-on-top thread list with reply above target

EOF
)"
```

**Notes (do not regress):**
- Subject chrome stays on `index === 0` in `MailDisplay` → after reverse this is newest (intentional Outlook-like).
- `ThreadDemo` may keep its own `.reverse()`; optional later DRY — not required this task.
- Print HTML path stays ascending — out of scope.

---

### Task 3: Bigger reply editor default

**Files:**
- Modify: `apps/mail/components/mail/reply-composer.tsx` (~361)

**Interfaces:**
- Consumes: `EmailComposer` default editor class `min-h-[200px]` (`email-composer.tsx` ~1008–1010)
- Produces: no reply-specific min-height override

- [x] **Step 1: Remove the 50px override**

Change:

```tsx
<EmailComposer
  key={`reply-compose-${replyComposeInstanceId}`}
  editorClassName="min-h-[50px]"
  className="w-full max-w-none! pb-1 overflow-visible"
```

To:

```tsx
<EmailComposer
  key={`reply-compose-${replyComposeInstanceId}`}
  className="w-full max-w-none! pb-1 overflow-visible"
```

- [x] **Step 2: Confirm no other reply min-h-[50px]**

```bash
rg 'min-h-\[50px\]' apps/mail
```

Expected: no matches under reply compose path (or none at all).

- [ ] **Step 3: Commit**

```bash
git add apps/mail/components/mail/reply-composer.tsx
git commit -m "$(cat <<'EOF'
fix(mail): use default composer height for reply editor

EOF
)"
```

---

### Task 4: Scroll-to-latest on open uses semantic latest

**Files:**
- Modify: `apps/mail/components/mail/mail-display.tsx` (~531–552)

**Interfaces:**
- Consumes: existing `isLastEmail` (`emailData.id === threadData?.latest?.id`)
- Produces: long-thread auto-scroll targets newest message, not visual last index after reverse

- [x] **Step 1: Fix the open-scroll gate**

Replace the index-based branch inside the existing `useEffect`:

```tsx
useEffect(() => {
  if (!demo) {
    if (activeReplyId === emailData.id) {
      setIsCollapsed(false);
    } else {
      setIsCollapsed(!isLastEmail);
    }
    // Scroll newest into view on long threads (semantic latest, not display index).
    if (isLastEmail && totalEmails && totalEmails > 5) {
      setTimeout(() => {
        const element = document.getElementById(`mail-${emailData.id}`);
        element?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }
}, [demo, emailData.id, isLastEmail, activeReplyId, totalEmails]);
```

Dual-expand already correct: reply target forced expanded; `latest.id` stays expanded.

- [ ] **Step 2: Commit**

```bash
git add apps/mail/components/mail/mail-display.tsx
git commit -m "$(cat <<'EOF'
fix(mail): scroll open long threads to semantic latest message

EOF
)"
```

---

### Task 5: Verification

**Files:** none new (checklist)

- [x] **Step 1: Re-run unit tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd apps/mail && pnpm exec vitest run tests/thread-display-order.test.ts
```

Expected: PASS.

- [x] **Step 2: Manual / pilot UI checklist** (code-path verified 2026-08-03; live pilot UI needs human login — not run)

| Case | Expect |
|------|--------|
| Multi-message thread | Newest at top, expanded; older collapsed below |
| Reply on newest | Composer at top of scroll content, above newest; no sticky bottom bar |
| Reply on middle | DOM/visual: newer msgs → composer → target → older |
| Single message + reply | Composer above the only message; editor ≥ ~200px |
| Attachment strip | Still under chronologically oldest (visual bottom of message stack) |
| Trailing drafts | Still after oldest (bottom) |
| Close reply | Latest only expanded again |
| Keyboard `r`/`a`/`f` | Still bound to chronological latest (`latest.id`) |
| Print | Still chronological if exercised (unchanged) |

- [x] **Step 3: Dual-mount smoke** (static: single MessageList mount path; sticky deleted; live DOM count needs browser)

With reply open in browser console:

```js
document.querySelectorAll('[id^="reply-composer-"]').length
```

Expected: `1`.

- [ ] **Step 4: Final commit only if verification fixes needed** — otherwise done.

---

## Self-review

1. **Spec coverage:** Newest-on-top → T1+T2. Reply above → T2. Bigger box → T3. Collapse latest-focused → already + T4. Attachment strip → T2 last visual index. Scroll → T2 nearest + T4 latest.id.
2. **Placeholders:** None.
3. **Type consistency:** `orderMessagesNewestFirst` only helper; no slots API.
4. **Safety:** Vitest commands include unset pilot RDS env.

## Autonomous continue note (2026-08-03)

Resumed via `/continue-autonomously`. Implementation Tasks 1–4 complete in working tree. Review fix: ThreadAttachments outside `index===0`; open-scroll split from `activeReplyId`. Fresh evidence: vitest 3/3 PASS; `tsc --noEmit` exit 0; lints clean on touched files. **No commit** (user commit rule; nava-run no-commit unless asked). Live pilot UI login = human-only residual.

## Execution handoff

Plan complete. Canonical next step: `/nava-run` on `docs/superpowers/plans/2026-08-03-outlook-thread-order-reply-size.md`.
