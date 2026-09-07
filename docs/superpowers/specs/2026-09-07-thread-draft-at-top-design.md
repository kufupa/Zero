# Thread Draft at Top (Outlook-style) Design

**Date:** 2026-09-07  
**Status:** Approved (brainstorm)  
**Module:** `apps/mail` thread reading pane

## Goal

When a thread has a saved draft (reply / reply all / continue), show that draft with existing draft card chrome at the **top of the message stack** (newest-first), not after all emails. Mirror Outlook conversation: unsent = newest → first message-like row.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Manual + AI candidates | Same top stack; **manual first**, then AI cards |
| Relative to chrome | **B:** linked-conversation banner + thread attachments stay first; draft stack sits **right above** newest email |
| While composer open | **A:** keep hide-on-`mode` (no duplicate card while editing) |
| Approach | **1:** Flip MessageList `trailing` → `leading` slot (no synthetic message injection, no sticky chrome) |

## Current behavior

- `useThread` already strips `isDraft` from `messages`; `latestDraft` / AI candidates hydrate separately.
- `ThreadDisplay` builds `threadDraftSection` (`ThreadDraftCard` + AI cards in `ThreadAiMailsSection`).
- `MessageList` receives it as `trailing` and mounts **after** `displayMessages` → draft at bottom.
- Messages already `orderMessagesNewestFirst`.

## Target scroll order

1. Linked-conversation banner (unchanged)
2. Thread attachments strip (unchanged)
3. **Draft stack** (manual then AI) when visible
4. Messages newest → oldest (unchanged)

## Components / data

- **Change:** `apps/mail/components/mail/thread-display.tsx` — `MessageList` prop `trailing` → `leading`; render after attachments, before message map; call sites pass `leading={threadDraftSection}`.
- **Unchanged:** `ThreadDraftCard`, `buildThreadDraftViewModel`, hide rules (`draftRowOptimistic.shouldHide`, `if (mode) return null`), edit/delete/refresh handlers, API/message order.
- **Border:** divider under leading draft when messages follow (same chrome as old trailing).

## Out of scope

- New draft visual design / tokens
- Reordering drafts folder list
- API chronological order / print HTML order
- Sticky draft outside ScrollArea
- Showing draft card while composer open

## Testing

- Source-contract Vitest (pattern: `reply-composer-viewport-contract.test.ts`): assert MessageList mounts `leading` after attachments / before `displayMessages.map`; assert no post-map draft mount; assert call sites use `leading=`.
- No pilot RDS; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest.
- Pilot proof (optional gate): open thread with saved draft → draft card above newest mail; open Reply → card hides; close without send → card returns at top.

## Success criteria

- Saved manual draft appears above newest email, below banner/attachments.
- AI candidates share that top stack under manual when both exist.
- Composer open → stack hidden.
- Existing draft card formatting retained.
