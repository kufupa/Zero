---
title: "Outlook-style thread order + bigger reply box"
date: 2026-08-03
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Outlook-style thread order + bigger reply box

## Goal Capsule

Make the reading-pane thread match Outlook’s common **Newest on top** conversation layout, put the **reply composer above** the message being replied to, and restore a **large default reply editor** (drop the 50px min-height override). FE-only display change; keep `mail.get` chronological ascending + `latest` = last message.

**Stop when:** newest message renders first, older messages collapse below it, Reply mounts above the target message, reply editor uses the shared composer min-height (≥200px), and unit tests cover the newest-first helper. No user-facing order toggle in this slice.

**Executable TDD plan:** `docs/superpowers/plans/2026-08-03-outlook-thread-order-reply-size.md` (reconciled eng + ponytail + design).

## Product Contract

### Requirements

1. **Newest on top** — In the open thread pane, messages render newest → oldest (Outlook reading-pane “Newest on top”).
2. **Reply above target** — When the user clicks Reply / Reply all / Forward on a message (or toolbar reply to latest), the composer appears **above** that message, not below it.
3. **Bigger reply box** — Reply editor default height matches (or is at least) `EmailComposer`’s default `min-h-[200px]`. Remove reply’s `min-h-[50px]` override.
4. **Collapse still newest-focused** — Newest message expands by default; older messages stay collapsed until expanded (existing `latest.id` rule).
5. **Out of scope** — User setting for newest/oldest; API `orderBy` flip; draft-card reposition; print HTML reordering; changing new-mail compose height.

### Acceptance examples

- Thread with messages A (old) → B → C (new): pane shows C, then B, then A. C expanded; B/A collapsed.
- Click Reply on B: composer sits visually above B’s header/body; C remains above the composer; A remains below B.
- Click Reply on C (latest): composer at top of thread content, above C; no sticky bottom bar.
- Open reply: editor tall enough to write (~200px min), not a one-line 50px strip.

### Outlook reference (evidence)

- New Outlook: Settings → Mail → Layout → conversation reading pane: **Newest on top** / **Newest on bottom** ([Microsoft support](https://support.microsoft.com/en-us/outlook/mail/view-email-messages-by-conversation-in-outlook)).
- Classic/conversation defaults often newest-on-top in the conversation list; reading pane order is configurable.
- Customer ask locks **Newest on top** + reply **above** the clicked message (explicit product choice; not “newest on bottom + inline reply at bottom”).

## Planning Contract

### Key technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to reverse | **FE display only** via pure helper | Keep wire/`mail.get` `asc(receivedAt)` and `latest = last`; avoid contract + consumer churn. `ThreadDemo` already reverses for display. |
| API order | **Unchanged** `orderBy(asc(message.receivedAt))` | Pilot wire contract and `useThread` latest derivation stay valid. |
| Reply mount | **Always above** target `MailDisplay`; remove sticky-bottom special case | Sticky bottom existed because latest lived at bottom. Newest-on-top + above-target makes sticky bottom wrong. |
| Sticky top? | **No sticky composer** in v1 | Inline above target + existing `scrollIntoView` is enough. Sticky top can return if pilot feedback says composer scrolls away. |
| Reply height | **Delete** `editorClassName="min-h-[50px]"` | Composer default `min-h-[200px]` / shell `max-h-[500px]` already “big”. No new size token. |
| Thread attachments strip | Attach to **chronologically oldest** message id, not visual index `0` | After reverse, index `0` is newest; today’s `index === 0` would mis-attach the strip. |
| Draft / AI cards | Keep `trailing` after all messages | Still at visual bottom (oldest end). Reposition deferred. |
| Order toggle | **Hardcode** newest-on-top | YAGNI until customer asks. |

### Current code map

- Order source: `apps/server-pilot/src/trpc/routes/mail.ts` (`asc(receivedAt)`); FE `useThread` keeps array order; `latest` = last non-draft.
- Render: `MessageList` in `apps/mail/components/mail/thread-display.tsx` maps array as-is; inline reply **below** non-last; sticky bottom for last.
- Collapse: `mail-display.tsx` expands `emailData.id === threadData?.latest?.id`.
- Reply height: `reply-composer.tsx` passes `editorClassName="min-h-[50px]"` overriding `email-composer.tsx` default `min-h-[200px]`.
- Prior art: `ThreadDemo` reverses with `[...(messages \|\| [])].reverse()`.
- Related solution: `docs/solutions/logic-errors/mail-open-thread-stale-and-recipient-you-label.md` (open-thread poll; not order).

### Technical design

1. Add `apps/mail/lib/mail/thread-display-order.ts`:
   - `orderMessagesNewestFirst<T extends { id: string; receivedOn?: string }>(messages: T[]): T[]` — stable newest-first for display (copy + reverse chronologically ascending input, or sort by `receivedOn` desc if needed). Prefer reverse of API asc order when caller guarantees asc.
   - `isChronologicallyOldestMessage(messageId, messages): boolean` — for attachment strip.
2. `MessageList`: render `orderMessagesNewestFirst(messages)`; for each message, if replying to it, render `ReplyCompose` **before** `MailDisplay`; drop `!isLastMessage` gate and parent sticky-bottom block.
3. `reply-composer.tsx`: remove `editorClassName="min-h-[50px]"`.
4. `mail-display.tsx`: keep `isLastEmail`/`latest.id` collapse; fix scroll-into-view effect that keys off `index === totalEmails - 1` if it breaks under reverse (prefer scroll to `latest.id` element).
5. Tests: pure helper unit tests; no Vitest against pilot RDS.

### Risks

| Risk | Mitigation |
|------|------------|
| Keyboard shortcuts / “last email” still tied to `latest` | Keep semantic latest = newest chronologically; only visual order flips. |
| Attachment strip jumps to newest | Gate on oldest id helper. |
| Long threads + large reply + above-newest | Composer may push older mail down; expected for newest-on-top. |
| E2E selectors assuming bottom sticky | Update any reply e2e that assert sticky/bottom placement. |

### Sequencing

1. Pure order helper + tests  
2. MessageList order + reply-above + remove sticky bottom  
3. Reply height override removal  
4. Attachment-strip + scroll-target fix  
5. Smoke / e2e spot-check if local disposable env available  

## Implementation Units

### U1. Thread display order helper

**Files:** create `apps/mail/lib/mail/thread-display-order.ts`; test `apps/mail/tests/thread-display-order.test.ts`

**Does:** Newest-first ordering + oldest-id detection for attachment strip.

**Test scenarios:**
- Ascending input `[old, mid, new]` → `[new, mid, old]`
- Empty / single message identity
- `isChronologicallyOldestMessage(old.id, msgs)` true; newest false

### U2. MessageList newest-first + reply above target

**Files:** modify `apps/mail/components/mail/thread-display.tsx` (`MessageList` + sticky block ~1164–1173); optionally align `ThreadDemo` to shared helper

**Does:** Display newest-first; mount `ReplyCompose` **above** target for any `activeReplyId`; delete sticky-bottom latest-only path. Composer wrapper: `px-4 py-3 border-b border-border`. On open: `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` on `reply-composer-${id}`.

**Test scenarios:** Prefer extracting a tiny pure `buildThreadMessageSlots(messages, activeReplyId)` returning ordered slots `{ message, showReplyAbove }` for unit tests if JSX hard to test; else characterization via helper + manual pilot check listed in verification.

### U3. Bigger reply editor default

**Files:** modify `apps/mail/components/mail/reply-composer.tsx` (remove `editorClassName="min-h-[50px]"`)

**Does:** Reply uses `EmailComposer` default `min-h-[200px]`.

**Test scenarios:** Grep/assert absence of reply `min-h-[50px]` in a small unit or static test if present pattern exists; otherwise verify via component prop test if cheap, else verification checklist.

### U4. Attachment strip + open-scroll correctness

**Files:** `thread-display.tsx` MessageList attachment prop; `mail-display.tsx` collapse/scroll effect if index-based

**Does:** Thread attachments on chronological oldest; scroll-to-latest uses latest id not “last index in display list”. Collapse: keep `latest.id` expanded; force-expand `activeReplyId` target (dual-expand OK).

## Verification Contract

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before any Vitest.
- Run: `pnpm --filter=@zero/mail exec vitest run tests/thread-display-order.test.ts` (and any new slot helper tests) from `apps/mail` with disposable/no DB.
- Do **not** point Vitest at `nava-zero-mail-pilot`.
- Manual / pilot UI: open multi-message thread → newest top; Reply → composer above target; editor ≥ ~200px tall.

## Definition of Done

- [ ] Newest-on-top in thread pane
- [ ] Reply composer above replied-to message for every target (including latest)
- [ ] No sticky-bottom reply bar
- [ ] Reply min-height no longer 50px; uses composer default
- [ ] Attachment strip still on oldest message
- [ ] Unit tests for order helper green without pilot RDS
- [ ] Reviews reconciled into this plan / superpowers plan
- [ ] Design UX specs applied: composer border band, nearest scroll, dual-expand, no sticky-bottom on mobile

## Appendix

### Layout after change

```
ScrollArea
  [ReplyCompose if reply to newest]   ← above target
  msg newest (expanded)
  [ReplyCompose if reply to mid]
  msg mid (collapsed)
  msg oldest (collapsed) + optional thread attachments
  trailing drafts / AI cards
```

### Design review UX specs (required for this slice)

Classifier: **APP UI** (reading-pane mail). No new chrome; reuse `EmailComposer` + `MailDisplay` + existing `border-border` / panel tokens.

#### Visual hierarchy (scan order)

1. Thread subject / toolbar (existing sticky header) — unchanged.
2. Active reply composer (when open) — primary action surface.
3. Target message header + body (always expanded while replying).
4. Other messages — collapsed headers only.
5. Trailing drafts/AI — still visual bottom (oldest end); deferred relocate.

Composer wrapper (above target): keep `px-4`; use `py-3` (not `py-2`) once default height is ~200px. Add `border-b border-border` on composer container so editor reads as distinct band above the message it answers. Do **not** invent card chrome, colored left borders, or new radius tokens.

#### Reply focus

- Keep existing `autofocus={true}` on reply composer.
- On `mode` + `activeReplyId` set: `scrollIntoView` the `reply-composer-${id}` node with `behavior: 'smooth'`, `block: 'nearest'` (prefer nearest over center so target message header stays in view when space allows).
- Acceptance: Reply on latest → composer + newest header visible with no manual scroll. Reply on mid → composer + that message’s header in viewport (newest may partially leave top).

#### Collapse behavior

| Message | Default | While `activeReplyId` set |
|---------|---------|---------------------------|
| Chronological latest (`latest.id`) | Expanded | Stays expanded |
| Reply target (`activeReplyId`) | — | Always expanded |
| All others | Collapsed | Collapsed |

Dual-expand allowed when replying to a non-latest message (latest + target both open). Closing reply restores default (latest only expanded).

#### Spacing

- Zero gap between composer band and target `MailDisplay` (Outlook-like adjacency); separation = `border-b` on composer only.
- Message-to-message: keep existing `border-t` between visual neighbors after reverse.
- Thread attachments remain under chronological oldest (visual bottom of message stack).

#### Mobile (`isMobile`)

- Still drop `min-h-[50px]`; let composer default `min-h-[200px]` apply.
- Cap editor growth with existing shell `max-h-[500px]`; on mobile, ensure ScrollArea can scroll so focused editor sits above OS keyboard (rely on existing autofocus + scrollIntoView; no new sticky).
- Do **not** reintroduce sticky-bottom on mobile in v1.
- Touch: reply actions stay on existing message headers/toolbar (no new controls).

#### Sticky risk (no sticky top in v1)

Removing sticky-bottom without sticky-top means: while drafting, scrolling to older messages **scrolls the composer away**. Acceptable for v1 because (a) newest-on-top puts reply-to-latest at top of content, (b) open-reply scrolls composer into view, (c) Outlook-like adjacency beats a floating bottom bar that fought newest-on-top.

Pilot trigger to add sticky-top later: users report losing the composer while reading older mail mid-draft. If added, sticky-top only when `activeReplyId === latest.id` and composer rect leaves viewport — not for mid-thread replies.

#### Interaction states (display-only; no new empty/error UI)

| Action | User sees |
|--------|-----------|
| Open multi-msg thread | Newest at top, expanded; older collapsed |
| Open single-msg thread | One expanded message; reply mounts above it |
| Open Reply / Reply all / Forward | Composer band above target; autofocus; scroll nearest |
| Cancel / close reply | Composer unmounts; collapse returns to latest-only |
| Send success | Existing post-send behavior; no new toast in this slice |

#### NOT in scope (design)

- Order toggle UI; sticky-top composer; draft-card relocate; print reorder; new size tokens; mobile-only shorter min-height.

#### What already exists

- `EmailComposer` default `min-h-[200px]` + shell max-height; `ReplyCompose` `autofocus`; `scrollIntoView` on mode/activeReplyId; collapse via `latest.id`; sticky thread header on mobile; `ThreadDemo` reverse precedent.

## Implementation Tasks (design-review)

- [ ] **T1 (P1)** — Dual-expand + `scrollIntoView` `block: 'nearest'` on reply open (`thread-display` / `mail-display`)
- [ ] **T2 (P1)** — Composer band `py-3` + `border-b`; mobile: no sticky-bottom, rely on scroll+autofocus
- [ ] **T3 (P2)** — Sticky-loss acceptance + pilot sticky-top trigger (documented above)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (edits applied) | 7 dims scored; UX specs + sticky risk landed in plan |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** DESIGN CLEARED with edits (approve-with-edits) — ready for eng review / implement after UX specs above. eng review required.

**UNRESOLVED DECISIONS:**
- Sticky-top composer deferred to pilot feedback (v1: nearest scroll only)
- Draft/AI trailing stay at visual bottom (oldest end) until separate slice
