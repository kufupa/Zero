---
title: Sender Click Copies Email Instead of Dead-End Web-Search Dialog
date: 2026-07-23
category: ui-bugs
module: apps/mail mail-display sender click + copy-sender-email helper
problem_type: ui_bug
component: email_processing
severity: medium
symptoms:
  - Clicking sender display name in thread detail opens blank overlay and More about dialog
  - "Dialog shows Web search is unavailable in pilot mode with no useful action"
  - Staff cannot copy sender email from header click despite clipboard copy existing on recipient chip
root_cause: incomplete_setup
resolution_type: code_fix
related_components:
  - frontend_stimulus
tags:
  - sender-click
  - clipboard-copy
  - pilot-mode
  - mail-display
  - web-search
  - ui-dead-end
  - ec2-pilot
  - more-about-person
---

# Sender Click Copies Email Instead of Dead-End Web-Search Dialog

## Problem

In the live EC2 pilot, hotel staff clicking a message sender name in the thread detail header expected a quick way to grab that person's email address. Instead, the click wired into a "More about …" research flow: it set `researchSender` state, mounted the `MoreAboutPerson` dialog, and attempted an AI web search via `ai.webSearch`. Pilot mode disables that backend capability, so the UI surfaced a modal with a blank overlay and the message **"Web search is unavailable in pilot mode."** — a dead end with no clipboard action and no useful information.

## Symptoms

- Clicking the sender display name (`MailboxInline` in the message header) opened a modal overlay instead of copying email.
- The overlay appeared largely blank behind the dialog chrome, with pilot-specific stub copy stating web search was unavailable.
- No email landed on the clipboard; no success or error toast appeared on the sender-name click path.
- The details popover **From:** line showed the same sender but was not wired to copy — only the broken research dialog path was reachable from the primary header click target.
- Recipient chip hover + copy icon continued to work correctly, creating inconsistent UX: one copy path worked, the primary sender click did not.

## What Didn't Work

- **Leaving the MoreAboutPerson dialog and stubbing web search in pilot.** The dialog still opened on every sender click, consumed attention with a blank overlay, and told staff the feature was unavailable. That preserved dead UI rather than delivering the action staff actually wanted (copy email).
- **Keeping `researchSender` state and only hiding the error message.** The click target would still mount dialog infrastructure, block the thread interaction model, and fail silently or confusingly when search was disabled.
- **Relying on the recipient-chip copy icon as the only copy affordance.** Staff naturally click the prominent sender name in the header; burying copy behind a hover state on a secondary chip is easy to miss during real inbox work.
- **Inlining clipboard logic only in JSX without a testable helper.** Eng review flagged that `navigator.clipboard.writeText` needs try/catch, empty-email guards, and unit tests — logic duplicated across header and popover would be brittle.
- **Touching server `ai.webSearch` to fix a frontend UX bug.** The backend route was correctly disabled for pilot; the fix belonged entirely on the mail-display click path and in removing unused FE web-search stack for this surface.

## Solution

Shipped across three commits on EC2-pilot: `caa73212` (helper + tests), `2f72810c` (UI wiring + removal of research dialog stack), `a8316ad4` (handoff). Deployed via `apps/server-pilot/deploy/ops-deploy.sh` (FE-only, no migrate).

### 1. Extract testable clipboard helper (TDD first)

Added `apps/mail/lib/mail/copy-sender-email.ts`:

```typescript
export type CopySenderEmailResult = 'copied' | 'empty' | 'failed';

export async function copySenderEmail(email: string): Promise<CopySenderEmailResult> {
  const trimmed = email.trim();
  if (!trimmed) return 'empty';
  try {
    await navigator.clipboard.writeText(trimmed);
    return 'copied';
  } catch {
    return 'failed';
  }
}
```

Unit tests in `apps/mail/tests/copy-sender-email.test.ts` cover blank/whitespace → `'empty'`, successful write → `'copied'`, rejected write → `'failed'`.

### 2. Shared handler in mail-display with toast mapping

**Before:** Sender name click set `researchSender` and opened `MoreAboutPerson`.

**After:** `handleCopySenderEmail` delegates to the helper and maps results to toasts:

```typescript
const handleCopySenderEmail = useCallback(async (personEmail: string) => {
  const result = await copySenderEmail(personEmail || '');
  if (result === 'copied') {
    toast.success('Email copied to clipboard');
  } else if (result === 'failed') {
    toast.error('Failed to copy email');
  }
}, []);
```

Empty email produces no success toast (and no error toast).

### 3. Wire sender name and details From: (a11y + event isolation)

Header sender and details popover **From:** both call `handleCopySenderEmail`, with propagation stopped so the thread row does not collapse:

```typescript
<span
  onClick={(e) => {
    e.stopPropagation();
    e.preventDefault();
    void handleCopySenderEmail(emailData?.sender?.email || '');
  }}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      void handleCopySenderEmail(emailData?.sender?.email || '');
    }
  }}
  role="button"
  tabIndex={0}
  title="Copy email address"
  aria-label="Copy email address"
  className="hover:bg-muted min-w-0 cursor-pointer"
>
  <MailboxInline sender={emailData?.sender} />
</span>
```

### 4. Recipient chip unchanged

`renderPerson` popover copy icon still calls `handleCopySenderEmail(person.email)` — icon path preserved; only the research dialog path was removed from the primary sender click target.

### 5. Remove dead web-search FE stack from mail-display

Deleted from the mail-display surface (not server `ai.webSearch`):

- `MoreAboutPerson` / `researchSender` / `MoreAboutQuery`
- `resolveMailDisplayWebSearch`, `useMailDisplayWebSearchMutation`, `demoWebSearch`

Updated `demo-backend-guards` tests to drop `resolveMailDisplayWebSearch` expectations.

## Why This Works

- **Matches staff intent in pilot:** Copying an email address is the actionable outcome when web search is off. Clipboard + toast is immediate feedback without modal chrome.
- **Reuses proven UX:** Same handler and success toast string already validated on recipient chips.
- **Helper isolates browser API fragility:** Clipboard write can throw; try/catch returns `'failed'` so UI can show `toast.error`.
- **Empty guard avoids false success:** Trim + early `'empty'` prevents writing whitespace or showing "Email copied" when there is no address.
- **Event isolation preserves thread UX:** Without `stopPropagation`, activating the sender control would bubble and fold the message.
- **Accessibility:** `role="button"`, `tabIndex={0}`, Enter/Space, and `title` / `aria-label` make the sender name a real copy control.
- **Removal over stub:** Deleting `MoreAboutPerson` eliminates the blank-overlay path rather than leaving a disabled feature one mis-click away.

## Prevention

- Keep `apps/mail/tests/copy-sender-email.test.ts` green (empty / copied / failed).
- Before merging mail-display changes, grep for `MoreAboutPerson`, `researchSender`, `MoreAboutQuery`, `resolveMailDisplayWebSearch`, `useMailDisplayWebSearchMutation`. Reintroduction on sender click without product intent should fail review.
- Do not re-wire sender click to `ai.webSearch` unless product re-authorizes that flow and pilot/backend support is confirmed.
- Extend copy via `handleCopySenderEmail` (or `copySenderEmail` + same toast mapping), not parallel handlers.
- Manual pilot smoke: click sender → clipboard + success toast, no modal; details **From:** same; thread still collapses on background click; Tab + Enter copies.
- If web-search resolver tests return, ensure they match real UI entry points — not resurrected dead paths in mail-display.

## Related Issues

- [Mail open-thread stale and recipient You label](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md) — same `mail-display.tsx` surface; pure-helper + Vitest pattern
- [Hotel folder UI parity](./hotel-folder-ui-parity.md) — remove dead/demo-gated UX on live path without flipping `FORCE_FRONTEND_ONLY_DEMO`
- [Live pilot production parity](../architecture-patterns/live-pilot-production-parity-real-mail.md) — Honesty UI checklist (replace dead affordances with real staff workflows)

**Refresh candidates (outside `docs/solutions/`):** `docs/superpowers/2026-04-11-hotel-demo-feature-map.md` and `docs/superpowers/2026-04-11-upgraded-model-backend-review.md` still describe More-about / `ai.webSearch` on sender click.
