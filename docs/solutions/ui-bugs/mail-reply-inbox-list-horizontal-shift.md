---
title: Mail Reply Inbox List Horizontal Shift on Narrow Viewport
date: 2026-08-03
category: ui-bugs
module: apps/mail mail-shell route content + ResizablePanel mail-list/mail-thread
problem_type: ui_bug
component: email_processing
symptoms:
  - "After Reply, especially at zoomed/narrow viewport (~1050px), inbox list shifted right horizontally"
  - "Sender column in mail list became clipped and unreachable"
  - "overflow-hidden ancestors still allowed programmatic scrollIntoView to scroll the layout sideways"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - mail-shell
  - horizontal-overflow
  - min-w-0
  - resizable-panel
  - reply
  - narrow-viewport
  - scrollintoview
  - ec2-pilot
---

# Mail Reply Inbox List Horizontal Shift on Narrow Viewport

## Problem

On the hotel mail UI (desktop split: list + thread), opening Reply caused the thread and inbox list to slide right. On zoomed or narrow viewports, staff could not get back to the left edge to see the sender column. The shell behaved like page-level horizontal overflow instead of contained scroll inside the thread panel.

## Symptoms

- After clicking Reply (or Reply All), the open thread visually moves right; sender / left chrome disappears off-screen on zoomed or narrow desktops.
- Horizontal pan does not restore a usable view of the left edge; staff feel stuck on the right.
- Geometry / containment bug, not send failure: drafts can still create and delete while the layout is broken.
- Reproduced under constrained viewport width; less obvious at full native width.
- Trigger coincides with composer open + scroll-into-view, not with idle thread read.

## What Didn't Work

- **Verifying only from the local IDE browser against the VPN-only pilot URL.** `https://nava.legacyhotels.co.za` is not reachable from that environment, so geometry claims could not be grounded there. Verification moved to EC2 Playwright over SSM against the pilot host.
- **Avoiding Reply entirely in the first canary to avoid creating drafts.** That left the real open-composer path unproven. A synthetic wide child plus `scrollIntoView` proved containment, but it was not a staff workflow. User later confirmed discarding a draft after Reply is acceptable for the live canary.
- **Assuming the bug was "Reply always sends" or "mark as read on open."** The discard canary showed `drafts.create` + `drafts.delete` only; no `mail.send`, and no `markAsRead` when the thread was opened via URL with `threadId` already set.
- **Treating temporary SDD canary scripts under `.superpowers/sdd` as product surface.** Those files were deleted after the run; durable guard is the Vitest source contract, not throwaway probes.
- **Counterfactual without a contract:** removing `min-w-0` or adding `w-fit` on the resizable panels reproduced horizontal movement under the same scroll/wide-child stress. That confirmed CSS containment but also showed the fix would regress without a static test locking the class tokens.

## Solution

Keep the mail route + desktop split panels shrinkable under their percentage widths, and lock that with a Vitest source contract. Reply may still `scrollIntoView` the composer; scroll stays vertical inside a contained panel instead of expanding the shell sideways.

### 1. Route content beside the fixed sidebar must shrink

In `apps/mail/app/(routes)/mail/layout.tsx`, the outlet wrapper next to `AppSidebar` carries `min-w-0` (and `w-full`) so the main column can be narrower than its children's intrinsic min-content:

```20:22:apps/mail/app/(routes)/mail/layout.tsx
      <div className="bg-sidebar dark:bg-sidebar min-w-0 w-full">
        <Outlet />
      </div>
```

Without `min-w-0` here, the sidebar + content flex row lets the mail shell grow past the viewport when inner content is wide.

### 2. List and thread `ResizablePanel`s: `min-w-0`, never `w-fit`

In `apps/mail/components/mail/mail.tsx`, both desktop panels opt into shrink-below-content:

```437:446:apps/mail/components/mail/mail.tsx
          <ResizablePanel
            id="mail-list-panel"
            order={0}
            defaultSize={isDesktop ? MAIL_LIST_SPLIT.default : 100}
            minSize={isDesktop ? MAIL_LIST_SPLIT.min : 100}
            maxSize={isDesktop ? MAIL_LIST_SPLIT.max : 100}
            className={cn(
              `bg-panelLight dark:bg-panelDark mb-1 min-w-0 shadow-sm md:mr-[3px] md:rounded-2xl lg:flex lg:h-[calc(100dvh-8px)] lg:shadow-sm`,
              isDesktop && threadId && 'hidden lg:block',
            )}
```

```569:577:apps/mail/components/mail/mail.tsx
          {isDesktop && (
            <ResizablePanel
              id="mail-thread-panel"
              order={1}
              className="bg-panelLight dark:bg-panelDark mb-1 mr-0.5 min-w-0 rounded-2xl shadow-sm lg:h-[calc(100dvh-8px)]"
              defaultSize={MAIL_THREAD_SPLIT.default}
              minSize={MAIL_THREAD_SPLIT.min}
              maxSize={MAIL_THREAD_SPLIT.max}
            >
```

`w-fit` on either panel would reintroduce content-driven width and defeat the percentage split. Panel `minSize` / `maxSize` percentages still govern the drag handle; `min-w-0` only stops CSS min-content from fighting those percentages.

### 3. Thread message list also clamps width; Reply still scrolls the composer into view

`MessageList` uses `min-w-0` on the `ScrollArea` and inner wrapper so long HTML / composer chrome does not force the panel wider:

```1196:1197:apps/mail/components/mail/thread-display.tsx
    <ScrollArea className={cn('min-w-0 flex-1', isMobile ? 'h-[calc(100%-1px)]' : 'h-full')} type="auto">
      <div className="min-w-0 pb-4">
```

When `mode` and `activeReplyId` are set, the existing effect scrolls the composer node into view (smooth, `block: 'nearest'` in the current tree):

```816:826:apps/mail/components/mail/thread-display.tsx
  // Scroll to the active reply composer when it's opened
  useEffect(() => {
    if (mode && activeReplyId) {
      setTimeout(() => {
        const replyElement = document.getElementById(`reply-composer-${activeReplyId}`);
        if (replyElement) {
          replyElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100); // Short delay to ensure the component is rendered
    }
  }, [mode, activeReplyId]);
```

With the shell contained, that call adjusts vertical scroll inside the thread panel instead of shoving the whole mail chrome sideways. Composer mount remains inline on the target message as `#reply-composer-${id}` (`thread-display.tsx` around the `MessageList` reply branch).

### 4. Vitest contract against the source tokens

`apps/mail/tests/mail-shell-overflow-contract.test.ts` reads layout + `mail.tsx` source and asserts:

- Route content `div` after `<AppSidebar />` includes `min-w-0`.
- Opening tags for `id="mail-list-panel"` and `id="mail-thread-panel"` include `min-w-0` and do **not** include `w-fit`.

This is a static containment contract (no browser). It fails if someone removes those classes during a later layout pass.

### 5. EC2-pilot verification (SSM Playwright)

Verified on EC2-pilot (Playwright over SSM), not from the VPN-blocked local IDE browser:

1. **Containment canary:** synthetic wide child + `scrollIntoView` - with `min-w-0` in place, horizontal geometry stayed put; counterfactual (strip `min-w-0` / add `w-fit`) reproduced rightward movement.
2. **Staff-shaped discard canary (user OK with discard):** open thread → Reply → type → Escape → Discard. Geometry deltas ~0. Observed mutations: `drafts.create` then `drafts.delete`. No `mail.send`. No `markAsRead` for open-via-`threadId`-URL. Temporary canary assets lived under `.superpowers/sdd` and were removed after the run - do not treat them as product files.

Do not invent a PR number here; cite EC2-pilot verification above when referencing this fix in handoffs.

## Why This Works

Flex and many resizable layouts default `min-width: auto`, which means "at least as wide as the largest unwrappable descendant." Reply composer, long subjects, and HTML bodies easily exceed a percentage panel width. `scrollIntoView` then scrolls the nearest scrollport - and if that scrollport is (or becomes) the document / outer shell because children blew past the panel, the user sees horizontal page shift.

`min-w-0` overrides that auto minimum so the panel honors its resizable percentage and clips/scrolls internally. Keeping `w-fit` off the panels prevents a second path back to content-sized width. The route-level `min-w-0` closes the same hole one level up beside the fixed sidebar. Once the overflow chain is contained, the Reply `scrollIntoView` effect is safe: it only moves vertical scroll inside the thread column.

The Vitest contract encodes the non-obvious class tokens so a future "simplify className" edit cannot silently restore the bug without a red test.

## Prevention

- Treat `min-w-0` on mail shell flex / `ResizablePanel` ancestors as load-bearing, not decorative. Do not remove it when tidying Tailwind classes.
- Never put `w-fit` (or equivalent content-sized width) on `mail-list-panel` / `mail-thread-panel`.
- Keep `apps/mail/tests/mail-shell-overflow-contract.test.ts` green in CI; extend it if a new shell ancestor joins the horizontal chain (e.g. another wrapper around `ResizablePanelGroup`).
- When changing Reply open behavior (`scrollIntoView` options, sticky vs inline composer), re-check narrow / zoomed desktop: containment first, then scroll preference.
- Pilot UI geometry that depends on VPN-only hosts: validate on EC2 Playwright via SSM, not only local IDE browsers.
- Prefer discard-after-Reply canaries when drafts are acceptable; avoid leaving live drafts behind, and do not confuse draft create/delete with send or mark-as-read.
- Do not check temporary `.superpowers/sdd` probes into product docs; document only durable source + contract tests.

## Related Issues

- [Sender click copies email](../ui-bugs/sender-click-copies-email.md) - adjacent sender-row `min-w-0` containment; different clipboard bug.
- [Compose-close draft honesty](../logic-errors/compose-close-draft-honesty.md) - same Reply composer lifecycle; draft autosave honesty, not shell overflow.
- [Mail open-thread stale and recipient You label](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md) - list vs thread pane coupling; poll/stale-data root cause.
