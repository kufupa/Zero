# Composer Footer Parity and Disabled AI-Control Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give new-message and reply composers one left-aligned action sequence while removing disabled AI compose controls and their unreachable client paths.

**Architecture:** Reuse `EmailComposer`’s existing `sendButton` JSX in its shared left footer row for both composer modes; remove the reply-only right footer branch and its now-dead `replyingTo` discriminator. Delete only composer-side AI presentation and invocation code, leaving server AI procedures and other feature surfaces unchanged; existing draft-persistence call sites retain their required shape with `aiBlocked: false`.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest source contracts, ESLint.

## Global Constraints

- Do not change server AI procedures, mail send behavior, scheduling, attachments, templates, formatting, draft lifecycle, or reply context.
- Keep `PersistDecisionInput.aiBlocked` at every existing `shouldPersistDraft` / `resolveComposeCloseAction` call site; set it to `false` after composer AI state is removed.
- Let the shared action row wrap on narrow panes; preserve the `Send → Send later → existing actions` order and keep every control reachable.
- Do not run Vitest with `DATABASE_URL` or `VITEST_ALLOW_PILOT_RDS` set. Use a local disposable test environment only.
- Do not commit unless user explicitly requests it.

## File Structure

- Modify `apps/mail/components/create/email-composer.tsx`: common, wrapping footer ordering; removal of disabled composer-AI client paths and the dead reply discriminator; and preservation of draft persistence input shape.
- Modify `apps/mail/components/mail/reply-composer.tsx`: stop passing the dead `replyingTo` prop.
- Modify `apps/mail/tests/compose-draft-ownership-contract.test.ts`: replace the obsolete AI-preview acceptance assertion with an editor dirty-state assertion.
- Create `apps/mail/tests/composer-footer-parity-contract.test.ts`: focused source contract for common footer structure, one Send control, removal of reply-only right Send/AI affordances, removed `replyingTo`, and all four `aiBlocked: false` guards.

---

### Task 1: Unify Composer Footer Actions and Remove Disabled Client AI Paths

**Files:**
- Create: `apps/mail/tests/composer-footer-parity-contract.test.ts`
- Modify: `apps/mail/components/create/email-composer.tsx:1-77, 123-175, 264-271, 378-384, 433-848, 897-906, 1039-1070, 1084-1096, 1101-1336, 1404-1517`
- Modify: `apps/mail/components/mail/reply-composer.tsx:370-390`
- Modify: `apps/mail/tests/compose-draft-ownership-contract.test.ts:13-28`

**Interfaces:**
- Consumes: existing `sendButton` JSX, `ScheduleSendPicker`, `PersistDecisionInput`, and shared attachment/template/formatting controls.
- Produces: both new-message and reply footers render exactly one `{sendButton}` immediately before `<ScheduleSendPicker>` in the left action row; no composer-side Generate, subject AI affordances, or `replyingTo` prop remain.

- [ ] **Step 1: Add failing source contract**

Create `apps/mail/tests/composer-footer-parity-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);
const replyComposerSource = readFileSync(
  new URL('../components/mail/reply-composer.tsx', import.meta.url),
  'utf8',
);

describe('composer footer parity', () => {
  it('puts Send immediately before Send later in one wrapping shared left action row', () => {
    const footerStart = source.indexOf('{/* Bottom Actions */}');
    const footerEnd = source.indexOf('<Dialog open={showLeaveConfirmation}', footerStart);
    const leftActionsStart = source.indexOf(
      '<div className="flex flex-wrap items-center justify-start gap-2">',
      footerStart,
    );
    const scheduleStart = source.indexOf('<ScheduleSendPicker', leftActionsStart);
    const sendStart = source.lastIndexOf('{sendButton}', scheduleStart);

    expect(footerStart).toBeGreaterThanOrEqual(0);
    expect(footerEnd).toBeGreaterThan(footerStart);
    expect(leftActionsStart).toBeGreaterThan(footerStart);
    expect(sendStart).toBeGreaterThan(leftActionsStart);
    expect(scheduleStart).toBeGreaterThan(sendStart);
    const leftActionTag = source.slice(leftActionsStart, source.indexOf('>', leftActionsStart));
    expect(leftActionTag).toContain('flex-wrap');
    expect(source.slice(leftActionsStart, scheduleStart)).not.toContain('isReplyComposer');
    const footer = source.slice(footerStart, footerEnd);
    expect(footer.match(/\{sendButton\}/g) ?? []).toHaveLength(1);
    expect(footer).not.toContain('isReplyComposer');
    expect(source).not.toContain('isReplyComposer');
    expect(source).not.toContain('replyingTo?:');
    expect(replyComposerSource).not.toContain('replyingTo=');
  });

  it('removes disabled composer AI controls while preserving draft input shape', () => {
    expect(source).not.toContain('handleAiGenerate');
    expect(source).not.toContain('handleGenerateSubject');
    expect(source).not.toContain('aiGeneratedMessage');
    expect(source).not.toContain('ContentPreview');
    expect(source).not.toContain('Sparkles');
    expect(source.match(/aiBlocked:\s*false/g)).toHaveLength(4);
  });
});
```

Update `apps/mail/tests/compose-draft-ownership-contract.test.ts` so its
local-edit test continues protecting a real remaining mutation surface instead
of the removed AI preview:

```ts
expect(emailComposerSource).toMatch(
  /onLengthChange:\s*\(\)\s*=>\s*\{\s*markUnsavedChanges\(\);\s*\}/,
);
```

Delete the former `onAccept={() => { ... }}` / `ContentPreview` source
assertions from that test.

- [ ] **Step 2: Verify contract fails for current layout**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/composer-footer-parity-contract.test.ts
```

Expected: FAIL because the left row neither wraps nor has unconditional `Send`, reply still has a separate right-side branch, `replyingTo` remains, and composer AI identifiers remain.

- [ ] **Step 3: Make minimal production change**

In `apps/mail/components/create/email-composer.tsx`, remove only composer-side AI dependencies and code. Keep the demo runtime import because draft persistence still selects `demoUpsertDraft` with it:

```ts
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { Command, Paperclip, Plus, Type, X as XIcon } from 'lucide-react';
import { CurvedArrow, X } from '../icons/icons';
import { demoUpsertDraft } from '@/lib/demo/local-actions';
```

Delete `ThreadContent`; `messageLength`; `aiGeneratedMessage`, `aiIsLoading`, and `isGeneratingSubject`; `useThread`; `demoAiCompose`; `demoGenerateEmailSubject`; `aiCompose` and `generateEmailSubject` mutations; `threadContent`; `handleAiGenerate`; `handleGenerateSubject`; commented AI hotkey block; subject sparkle button; footer Generate/preview branch; and `animations` / `ContentPreview`.

Keep editor edits tracked without the removed length state:

```ts
const editor = useComposeEditor({
  initialValue: initialMessage,
  isReadOnly: isLoading,
  onLengthChange: () => {
    markUnsavedChanges();
  },
  onModEnter: () => {
    void handleSend();
    return true;
  },
  onAttachmentsChange: async (files) => {
    await handleAttachment(files);
  },
  placeholder: 'Start your email here',
  autofocus,
});
```

Replace each existing AI draft guard with the static post-removal value:

```ts
aiBlocked: false,
```

Remove the stale send-time reset:

```ts
// Delete this line from proceedWithSend:
setAiGeneratedMessage(null);
```

Render `sendButton` unconditionally at the beginning of the shared left action row:

```tsx
<div className="flex flex-wrap items-center justify-start gap-2">
  {sendButton}
  <ScheduleSendPicker
    value={scheduleAt}
    onChange={handleScheduleChange}
    onValidityChange={handleScheduleValidityChange}
  />
  {/* existing Add, template, attachment, and formatting controls stay in order */}
</div>
```

Delete the separate right-side footer `<div>` because after disabled Generate removal it contains no user-visible action. Delete `replyingTo` from `EmailComposerProps` and from the component parameter destructure, then remove `replyingTo={replyToMessage?.sender.email}` from `apps/mail/components/mail/reply-composer.tsx`. This removes the dead reply-only discriminator without changing reply recipients or `replyToMessageId`.

Remove the editor blur conditional so the editor class remains:

```tsx
className={cn(`min-h-[200px] w-full`, editorClassName)}
```

- [ ] **Step 4: Verify focused contract passes**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/composer-footer-parity-contract.test.ts tests/compose-draft-ownership-contract.test.ts
```

Expected: PASS with all focused contract tests.

- [ ] **Step 5: Run focused regression checks**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/compose-draft-ownership-contract.test.ts tests/draft-persistence.test.ts tests/composer-footer-parity-contract.test.ts
pnpm --filter @zero/mail lint
```

Expected: all selected tests PASS and lint exits 0.

Do not add a rendered-component test: the mail Vitest suite runs in Node and
has no component-rendering harness. The strengthened source contract follows
existing local convention; manual UI verification below covers rendered layout
without adding new test dependencies or a broad mock tree.

- [ ] **Step 6: Manual UI verification**

At desktop and narrow responsive widths:

1. Open a new message: confirm footer begins `Send`, then `Send later`, followed by existing Add/template/attachment/format controls; no subject sparkle or Generate control appears.
2. Open Reply: confirm the same left-aligned action sequence begins `Send`, then `Send later`; no separate right-side Send remains.
3. Constrain the composer until its action row wraps, then confirm every control stays visible, operable, and ordered across wrapped lines.
4. Schedule a message, add an attachment, toggle formatting, type content, and send/close a draft to confirm existing controls and draft behavior remain available.
5. Tab through a wrapped action row; focus order must remain `Send`, `Send later`, then the existing controls in DOM order.

No commit step: wait for explicit user request.

## Review Notes

### What Already Exists

- `EmailComposer` already owns the `sendButton`, `ScheduleSendPicker`, Add,
  template, attachment, formatting, draft persistence, and send validation
  paths. This plan reorders those existing controls rather than adding a new
  footer component.
- New-message compose already establishes the intended left-to-right visual
  order. Reply reuses that exact row instead of inventing a reply-specific
  variant.
- Mail source contracts in `apps/mail/tests/` use `readFileSync` + Vitest in a
  Node environment. The new contract follows that local pattern.
- `draft-persistence.ts` owns persistence semantics. `EmailComposer` retains
  its required `aiBlocked` input shape rather than changing the helper API.

### Not in Scope

- Server AI procedures and unrelated AI surfaces: disabled controls are removed
  only from this composer.
- New design-system tokens, colors, typography, or a visual redesign: reply
  deliberately copies the existing new-compose appearance.
- A component-rendering test harness: current mail Vitest runs in Node, while
  the strengthened source contract plus manual UI verification covers this
  local layout change without new dependencies.
- Overflow menus or hidden actions on narrow layouts: wrapping preserves
  visible, keyboard-reachable controls.

### Engineering Coverage Map

```text
CODE PATHS                                      USER FLOWS
[+] EmailComposer footer                        [+] New message
  ├─ Send → Send later [contract]                 ├─ [manual] Expected action order
  ├─ exactly one Send [contract]                  ├─ [manual] Narrow row wraps
  └─ reply discriminator removed [contract]       └─ [manual] Tab order follows DOM

[+] Disabled composer AI                         [+] Reply
  ├─ controls/preview absent [contract]           ├─ [manual] Same left action row
  └─ 4 aiBlocked:false guards [contract]          ├─ [manual] No right-side Send
                                                   └─ [manual] Schedule/Add/T remain usable

[+] Draft ownership
  └─ editor onLengthChange marks edit
     [existing contract regression]
```

### Failure Modes

- A future reply-only Send branch returns: the footer contract rejects
  `isReplyComposer` and a second `{sendButton}`.
- A removed AI state leaves one persistence guard stale: the contract requires
  exactly four `aiBlocked: false` occurrences; lint catches dangling imports
  and state.
- A narrow reply pane crowds controls: shared `flex-wrap` keeps every action
  visible; manual verification covers wrapped layout and keyboard order.

### Parallelization

Sequential implementation, no parallelization opportunity. Every change
touches the same compose footer contract and its direct consumers.

## Implementation Tasks

- [ ] **T1 (P1, human: ~25m / CC: ~8m)** — mail composer — unify footer,
  remove disabled composer AI paths, and remove the dead reply discriminator.
  - Surfaced by: engineering review and independent plan challenge.
  - Files: `apps/mail/components/create/email-composer.tsx`,
    `apps/mail/components/mail/reply-composer.tsx`,
    `apps/mail/tests/compose-draft-ownership-contract.test.ts`, and
    `apps/mail/tests/composer-footer-parity-contract.test.ts`.
  - Verify: focused safe Vitest commands, mail lint, and desktop/narrow manual
    composer checks from Task 1.

## Design Review Summary

- Classification: app UI.
- Initial completeness: 8/10. Existing new-compose layout is a concrete visual
  reference, but narrow reply panes lacked an explicit control-overflow rule.
- Decision: wrap the shared action row and preserve DOM/tab order.
- Final completeness: 10/10 for this focused layout change.
- Information architecture, interaction states, user journey, AI-slop risk,
  and design-system alignment: no new visual structure, state, or token is
  introduced; the plan reuses existing composer controls.
- Responsive/accessibility: wrapping and tab-order verification are explicit.
- Outside design voices: skipped by user for this focused, existing-pattern
  change.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Not needed for focused UI parity |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | skipped | No Codex pass |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | Four plan findings folded: obsolete AI-preview assertion, demo draft import, dead reply discriminator, stronger footer contract |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | Shared row wraps; manual tab-order verification added |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | No developer-facing surface |

**PONYTAIL:** Lean already. Ship.

**VERDICT:** ENG + DESIGN CLEARED — ready to implement.
NO UNRESOLVED DECISIONS
