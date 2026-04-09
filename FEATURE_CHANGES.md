# Feature Changes Log

Track feature-level UI behavior changes (user-visible decisions), not code implementation notes.

---
manifest_version: 1
entry_format: json
required_fields:
  - date
  - ticket
  - owner
  - why_changed
  - user_visible_impact
  - rollback_plan
discovery:
  command:
    list: "pnpm feature-changes:list --json"
    latest: "pnpm feature-changes:latest --json"
  parse_pattern: "```json"
---

## How to add an entry
- Add entries under `## Entries` with newest date first.
- Keep each entry concise and user-focused.
- Complete every required field in both the human section and JSON block.
- Use one JSON block per entry for machine consumption.

## Entry template
### [DATE] [TICKET] [TITLE]
Date: YYYY-MM-DD  
Ticket: DEMO-000
Owner: @owner  
Why changed:
- ...

User-visible impact:
- ...

Rollback plan:
- ...

```json
{
  "status": "template",
  "date": "YYYY-MM-DD",
  "ticket": "DEMO-000",
  "owner": "@your-name",
  "title": "Short title",
  "why_changed": "What needed to change and why",
  "user_visible_impact": [
    "User-visible behavior change 1",
    "User-visible behavior change 2"
  ],
  "rollback_plan": [
    "Rollback step 1",
    "Rollback step 2"
  ]
}
```

## Entries

### [2026-04-09] [DEMO-103] FE-only demo: work queues, urgent stripe, AI draft preview
Date: 2026-04-09  
Ticket: DEMO-103  
Owner: @frontend-team  

Why changed:
- Hotel reservationist demo needs Outlook-like **work queues** (group, individual, travel agent, HR, urgent rollup), visible **urgency** on rows, and a **read-only AI draft preview** before edit/send, all without backend LLM services.

User-visible impact:
- In **frontend-only demo mode**, the sidebar gains **Work queues** with links to `/mail/work/...` routes; invalid slugs redirect to Inbox; non-demo builds are unchanged.
- Thread rows show a **red right-edge stripe** when the demo marks a thread **urgent**; list empty states for queues link back to Inbox.
- Threads with a non-empty demo **draft** show a **scrollable grey preview** with **red outline** and optional **fixed “model confidence” banner**; **Review & edit** (or clicking the preview) opens the existing reply composer and clears the “unreviewed” styling for that thread in the session.

Rollback plan:
- Remove `/mail/work/:queue` route, sidebar section, `listDemoThreads` workQueue filtering, list `$raw.demo`, `IGetThreadResponse.demo`, mail-list stripe/empty state, `AiDraftPreviewPanel`, Jotai `demoAiDraftReviewedAtomFamily`, and demo corpus fields; restore `useThreads` demo `messages` filtering if full parity with pre-demo thread view is required.

```json
{
  "status": "active",
  "date": "2026-04-09",
  "ticket": "DEMO-103",
  "owner": "@frontend-team",
  "title": "FE-only demo: work queues, urgent stripe, AI draft preview",
  "why_changed": "Reservationist human-in-the-loop demo needs categorized queues, urgency affordances, and visible AI drafts without backend automation.",
  "user_visible_impact": [
    "Work queues appear in the sidebar only in frontend-only demo mode and open filtered thread lists per queue.",
    "Urgent demo threads show a red stripe on the row plus an accessible urgent label in the row aria-label.",
    "Demo threads with draft text show a read-only preview and banner until the user enters review/edit via button or click."
  ],
  "rollback_plan": [
    "Revert demo-mail adapter/schema/JSON, routes, useThreads, mail-list, app-sidebar, thread-display, and new components/store.",
    "Remove FEATURE_CHANGES entry DEMO-103 and reset spec status if documenting rollback."
  ]
}
```

### [2026-04-08] [DEMO-101] FE-only demo: disable AI assistant and simplify tabs
Date: 2026-04-08  
Ticket: DEMO-101
Owner: @frontend-team  

Why changed:
- FE-only mode is meant to be deterministic and self-contained, so any assistant flows requiring backend AI services should be inaccessible.

User-visible impact:
- AI Assistant tab, panel affordances, and composer shortcuts are hidden or disabled in FE-only demo mode.
- FE-only tab set is reduced to supported surfaces to avoid dead/unsupported navigation states.
- Standard inbox, compose, and non-AI workflows continue to function without assistant features.

Rollback plan:
- Disable the FE-only guard on assistant and restore full AI assistant navigation and composer actions.
- Re-open the full tab set for FE-only mode and remove frontend-only feature restrictions.
- Run a small smoke check in both FE-only and standard modes before re-enabling.

```json
{
  "status": "active",
  "date": "2026-04-08",
  "ticket": "DEMO-101",
  "owner": "@frontend-team",
  "title": "FE-only demo: disable AI assistant and simplify tabs",
  "why_changed": "Prevent FE-only users from seeing AI flows that depend on unavailable backend services.",
  "user_visible_impact": [
    "AI assistant entry points (panel, tab, and command shortcuts) are hidden or disabled in FE-only demo mode.",
    "Tab configuration in FE-only mode is reduced to supported surfaces, preventing dead links and broken flows.",
    "Core inbox/composer workflows remain unchanged and continue to operate within FE-only constraints."
  ],
  "rollback_plan": [
    "Restore the FE-only feature flag path that enables AI assistant UI and shortcuts.",
    "Re-enable the full tab configuration used in non-demo frontend modes.",
    "Verify normal mode still exposes the AI assistant correctly and that no stale FE-only-only checks remain."
  ]
}
```

### [2026-04-08] [DEMO-102] FE-only demo: cut remaining backend-only surfaces
Date: 2026-04-08  
Ticket: DEMO-102
Owner: @frontend-team

Why changed:
- Additional FE-only requests were still reaching backend services for avatar, verification, attachments, summaries, and processed content.
- AI and support entry points were still visible in some flows and could be triggered, which is misleading without backend support.

User-visible impact:
- BIMI avatar loading, email summary/verification/attachments, and message content processing now skip backend calls in FE-only mode and render safely with local data.
- AI assistant launcher surfaces are hidden/disabled in FE-only mode (toggle button, sidebar entry, and empty-state shortcut).
- Live support and feedback links are visually muted and disabled so users can’t open unsupported external/dependent flows.

Rollback plan:
- Remove FE-only guards in `@/lib/demo-frontonly` dependent UI and hooks to restore original behavior.
- Re-enable AI/support links and components when backend services are available.
- Re-enable all data-fetching calls and verify by running the existing backend-dependent smoke checks.

```json
{
  "status": "active",
  "date": "2026-04-08",
  "ticket": "DEMO-102",
  "owner": "@frontend-team",
  "title": "FE-only demo: remove remaining backend-only surfaces",
  "why_changed": "FE-only mode needs to stop attempting unsupported backend-only calls and hide unreachable AI/support workflows.",
  "user_visible_impact": [
    "Backend-dependent per-message features now no-op in FE-only mode, preventing console connection failures.",
    "AI assistant entry points are disabled in FE-only mode, including the floating toggle and empty-state chat action.",
    "Live support and feedback actions are visually muted and non-functional in FE-only mode."
  ],
  "rollback_plan": [
    "Re-enable FE-only guards for the modified hooks/components.",
    "Restore AI sidebar and support items in `mail.tsx`, `thread-display.tsx`, `nav-main.tsx`, and `ai-toggle-button.tsx`.",
    "Run regression checks for both FE-only and connected backend modes."
  ]
}
```
