# Design: Centurion mock inbox corpus (demo mode)

## Goal

Seed a believable **shared hotel mailbox** for **screenshots and demos**: **The Centurion** (`@legacyhotels.com`), with mock threads and **composer-oriented draft text** that reads **human and professional**, not model-generated. The demo should show that AI-assisted replies can look **clean and operational**, not robotic.

**Steering principle:** implementation is AI-driven; humans steer requirements. The corpus ships as **data + a small loader**, not as a large hand-maintained TypeScript narrative.

## Non-goals

- Replacing production mail storage or sync paths long term.
- Perfect parity with every edge case in real hotel operations.
- Localization beyond **US English** unless added later.

## Packaging (approved)

Use **JSON corpus + schema validation + tiny loader** (approach “2” from brainstorming):

- One or more JSON files under a stable path (exact path chosen in implementation plan).
- Validate with a schema (e.g. Zod) at load time in **`ZERO_DEMO_MODE=1`** only.
- Loader maps each record to the **existing** mail API shapes (`listThreads` / `get` thread payloads, draft/composer fields the app already understands—e.g. synthetic `isDraft` messages and/or draft ids as used today).

This keeps copy editable without TypeScript churn and produces readable diffs.

## Volume and threading

- **~15–25 threads** total.
- **Mostly unread** in the list (fresh-handoff feel).
- **Mix of shapes:** many **single-message** threads; several **2–4 message** mini-threads; optional **one longer** chain if it helps a hero screenshot (not required in v1).
- **Human-sent replies** (where present): **corporate-polished** tone, consistent with a real ops inbox.

## Content mix

- **~⅔ internal** (HR / scheduling / policy / access / training / payroll-adjacent). Senders and recipients use plausible **`@legacyhotels.com`** (and similar internal) addresses; all names and events are fictional.
- **~⅓ customer-facing:** split across
  - **group** / block / event inquiries,
  - **individual** stay requests with **dates and times**,
  - **general** hotel questions (amenities, billing, airport, early check-in, etc.).

## Draft behavior (composer / future AI UI)

- **Guest threads:** every thread includes a **full** suggested reply draft: concise greeting, direct answer, specific **May 2026** dates and room/product labels where relevant.
  - If **availability is “yes”:** include a **professional** link using a **clearly fictional** host, e.g. `https://book.iveri.studio/reserve/...` (path style realistic; host not impersonating a real vendor).
  - If **availability is “no”:** propose **concrete alternatives** (other room categories, alternate date windows, hold language) in the same human tone.
- **Internal threads (hybrid):**
  - **Actionable** threads (scheduling, policy clarification, “please confirm X”): **full** draft appropriate to the thread.
  - **FYI / broadcast / low-action** threads: **minimal** draft—empty composer or a **1–2 line** stub (e.g. acknowledgment only).

All threads should still be **eligible** for a draft payload in data terms; the difference is **depth of copy**, not presence/absence of a record.

## Tone rules (drafts and sent mail)

- **Short, specific, calm.** No meta-language, no over-signposting, no bullet walls unless the thread is an RFP-style group request.
- **No “AI voice”** markers (no lecturing, no “happy to help” spam, no redundant summaries of the guest’s email).
- Guest-facing drafts read like a **strong front-office or reservations manager**; internal drafts read like **professional staff email**.

## Calendar

Use a **fixed fictional calendar: May 2026** for explicit check-in/out and event dates so screenshots stay **repeatable** and internally consistent across threads.

## JSON record shape (minimal contract)

The loader’s schema does **not** need to mirror the full internal DB. It needs enough fields to **deterministically build** API responses, for example (illustrative, not prescriptive of final names):

- Thread: stable `id`, `subject`, sort `receivedOn`, `unread`, optional labels/tags for demo.
- Messages: `id`, `from`, `to`, `cc` (optional), `receivedOn`, `subject` (if needed per message), `body` (HTML or text + processing rules), `isDraft`, threading headers if required by the driver.
- Optional explicit **draft block** if the implementation prefers separating “composer seed” from thread messages—must still map to whatever the client already uses for `ReplyCompose` / `latestDraft` behavior.

Exact field names and nesting are **implementation details** fixed in the implementation plan against current `ParsedMessage` / `IGetThreadResponse` types.

## Verification (lightweight)

Manually spot-check in the UI:

1. One **group** inquiry thread (draft shows structured, professional handling).
2. One **availability yes** thread (Iveri link reads well, not spammy).
3. One **availability no** thread (alternates with concrete May 2026 options).
4. One **internal FYI** (minimal draft) vs one **internal actionable** (full draft).

## Open work (out of scope for this document)

Implementation planning, file paths, Zod schema, and demo-mode wiring to `mail.listThreads` / `mail.get` / drafts—handled in a follow-up **implementation plan** after this spec is approved.
