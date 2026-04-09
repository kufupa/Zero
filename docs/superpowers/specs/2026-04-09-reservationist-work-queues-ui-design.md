# Reservationist demo: work queues, urgency, and AI draft preview (UI design)

**Date:** 2026-04-09  
**Status:** Draft — pending review of this document before implementation plan  
**Scope:** Front-end demo behavior and layout only. No real LLM integration, no change to send/automation backends in this phase.

## Goals

- Keep a **human in the loop** for AI-assisted replies while the product moves toward fuller automation.
- Match a **Microsoft Outlook–style** mental model: familiar folders plus **dedicated work queues** for hotel reservation workflows.
- Make **triage faster**: see **category**, **urgency**, and **draft reply content** without unnecessary clicks.
- Make the demo **visually clear** for stakeholders and reservationists (not “you are being replaced”).

## Non-goals (this phase)

- Wiring a real model to classify or draft messages.
- One-click send from the preview without an explicit review/edit step (may follow later).
- Replacing or removing existing core folders (Inbox, Drafts, Sent, etc.).

## Persona and context

**Primary user:** Reservationist who today works mainly in Outlook-like mail. They need confidence, clarity, and speed when reviewing AI-suggested replies.

## Architecture and navigation

### Sidebar

- **Preserve** existing **Core** and **Management** folder groups unchanged (`navigationConfig` pattern in `apps/mail/config/navigation.ts`).
- **Add** a new section (working title: **“Work queues”**) **below** Core/Management (exact order: after Management, unless product prefers otherwise).
- **Visibility:** Show this section when the app is in **frontend-only demo mode** (`isFrontendOnlyDemo()`), so production-like builds are not polluted with demo-only entries. If demo mode is off, the section is omitted.

### Routes (first-class demo routes)

Implement dedicated routes under a stable prefix so each queue is bookmarkable and easy to narrate in demos:

| Queue            | Path                         | Slug (param)   |
|------------------|------------------------------|----------------|
| Group bookings   | `/mail/work/group`           | `group`        |
| Individual       | `/mail/work/individual`      | `individual`   |
| Travel agent     | `/mail/work/travel-agent`    | `travel-agent` |
| Internal HR      | `/mail/work/hr`              | `hr`           |
| Urgent (rollup)  | `/mail/work/urgent`          | `urgent`       |

**Routing implementation note:** These paths **must not** collide with the existing dynamic folder route `[folder]` (e.g. `inbox`). Add a **nested route** such as `app/(routes)/mail/work/[queue]/page.tsx` (exact file layout follows existing React Router conventions in this repo). Unknown `queue` values redirect to `/mail/inbox`.

Each work-queue route renders the same **mail shell** (`MailLayout` / three-pane layout) as standard folders, but passes a **queue identifier** into the thread list data layer (see Data model).

### Urgent behavior (dual surfacing)

- **Dedicated “Urgent” queue** (`/mail/work/urgent`): list shows the **union** of all threads marked urgent **across** demo categories.
- **Within any other queue or standard folder** (as mock data allows): threads that are urgent still show **urgency affordances** on the row (red stripe—see below) so urgency is not only visible inside the urgent bucket.

## Thread list (middle column)

### Urgency stripe

- **Red vertical stripe** (or equivalent **right-edge accent**) on the row **only** when the thread is **urgent** (time-sensitive / escalation / demo flag).
- **No** second color on the stripe for “unreviewed AI draft.” Draft state is communicated in the **reading pane** only (see below).

### Optional text badges (YAGNI default)

- Default implementation: **stripe + subject/sender** only; avoid clutter.
- If demo feedback asks for it, add a small **“Urgent”** pill; not required for v1.

### Filtering

- For `group`, `individual`, `travel-agent`, `hr`: show threads whose **demo category** matches that slug.
- For `urgent`: show threads where **urgent** is true (any category).

## Reading pane: incoming mail + AI draft preview

### States

1. **No AI draft**  
   - Pane behaves as today for viewing the thread; no draft block.

2. **AI draft present, not yet reviewed**  
   - Show a **full-height, scrollable** preview of the **draft body** (not a one-line snippet).
   - **Muted / “disabled” styling** (greyed text, reduced emphasis) so it is obvious the user is **not** in an editable composer.
   - **Red outline** (or equivalent prominent border) around the draft preview region plus a short label (e.g. **“AI draft — review before sending”**).
   - Optional: if the demo needs a **“model uncertainty”** story, show a **compact banner** above the draft with **fixed demo copy** (no live LLM) **without** using a second stripe color on the list row.

3. **Review / edit**  
   - User can enter edit mode by **either**:
     - **Clicking anywhere** on the grey preview region, **or**
     - Activating a **primary labeled control** (e.g. **“Review & edit”** or **“Edit draft”**).
   - On transition to edit mode: remove **red outline** and “unreviewed” muted styling; use **normal** editable/composer styling consistent with the existing reply component.
   - **Reviewed flag (demo):** First entry into edit mode counts as **reviewed** for mock state (no separate “mark reviewed” control required unless product adds it later).

4. **After edit**  
   - Standard editable state; no AI-unreviewed outline until a **new** draft arrives (mock-driven).

### Placement

- Reuse the **same general area** as the current reply/draft footer so implementation stays cohesive; extend it **upward** into a scrollable preview **above** the action row if needed.

## Data model (mock / demo seed)

Extend mock thread (or thread metadata used in FE-only demo) with:

- `demoCategory`: `'group' | 'individual' | 'travel-agent' | 'hr'` (threads may appear in exactly one category for demo simplicity).
- `urgent`: `boolean`.
- `aiDraftBody`: `string | null` — full text shown in preview when non-null.
- `aiDraftReviewed`: `boolean` — after user opens edit mode, set `true` in client state for the session (persist only if existing demo persistence allows).
- `llmIssue` (optional): `boolean` or `{ message: string }` — drives optional **banner** above draft; **does not** change stripe rules.

**Overlap rule:** A thread can be **urgent** and have an **unreviewed** draft; stripe shows **red**; draft panel shows **outline + label**.

## Empty and error handling

- **Empty queue:** Friendly empty state (“No threads in this queue”) with link back to Inbox.
- **Invalid `/mail/work/:queue`:** Redirect to `/mail/inbox`.
- **Missing thread / loading:** Reuse existing mail loading and error patterns; no new modal flows required for v1.

## Internationalization and copy

- New nav section title and queue labels must use **Paraglide message keys** (same constraint as existing `navigationConfig` titles). Add keys in the repo’s message source files.

## Accessibility

- Stripe alone must not be the only signal: ensure **urgent** threads remain identifiable with **text** (subject prefix, `aria-label`, or visible “Urgent” where needed) if contrast or color-blind use is a concern—minimum for demo is **semantic labeling** on the row or thread header.
- Draft preview: `aria-readonly="true"` (or equivalent) until edit mode; focus management when entering edit mode should follow existing composer behavior.

## Testing (demo acceptance)

- Manual: each work-queue URL loads, filters correctly, empty state works.
- Manual: urgent thread appears in **Urgent** queue **and** shows **red stripe** in a category queue.
- Manual: thread with `aiDraftBody` shows **scrollable grey preview** + **outline**; **click preview** and **primary button** both enter edit mode and **clear** unreviewed styling.
- Optional: unit tests for **filter functions** mapping `queue` slug → predicate on mock thread (fast regression safety).

## Implementation alignment

- **Approach:** First-class routes under `/mail/work/...` (user-selected option **2**).
- **Stripe semantics:** Red **only** for urgent; unreviewed draft **only** on draft panel (user-selected option **C**).
- **Edit entry:** Click preview **and** primary control (user-selected option **C**).
