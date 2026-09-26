# Centurion Flow C design shotgun

- **Status:** static concept gallery; no production UI or behavior changed.
- **Prompt carried forward:** “many more artboards, one-page Flow C builder UI.”
- **Working assumption:** Flow C is a one-page stay builder opened from an inbound reservation email. The Antigravity prompt did not define its field contract, so this gallery keeps the builder evidence-led and non-writing.

## Intent

Show a reservationist the current inbound request, the evidence behind it, and the proposed PMS actions without turning the email thread into an implied reservation. Keep the common Outlook-shaped inbox, make action boundaries obvious, and give Flow C one scannable page rather than a wizard.

All names, properties, messages, IDs, dates, and counts in the gallery are fictional. The gallery uses no captured screenshots and makes no live HMS calls.

## Design guardrails

- The product unit is one **Proposed action per inbound request**, not one stay chip per thread. Current-message amendments are live; older requests remain folded context.
- Use a distinct, calm color per action family; keep evidence and verified staff outcomes visually separate from proposals.
- Empty means empty: skip, other-desk, and channel-auto cases do not get invented work. Unknown or conflicting facts stay blank and ask for a person.
- “Staff did” may show only source-bound `usedResult` data. When proof is absent, say so; never manufacture a PMS-shaped response.
- Flow C displays which fields came from the email and which need a human. No fabricated price, availability, occupancy, confirmation, or write-success state.
- The current production runtime is view-only for this quote/create path. Quote and create buttons in the concept are visibly unavailable; this is not a live HMS workflow.
- Multi-user access is per signed-in user and their grants. A shared URL is not an authorization token. The property-level queue indicator is a concept until queue status is surfaced in the UI.
- The Outlook VSTO host currently has one WebView2 pane per Windows-user profile. A controlled popout is a concept here, not an implemented feature; it inherits the same signed-in user's session.

The action-card and empty-state direction follows the local [HITL action-card plan](../plans/2026-09-21-lab-hitl-action-cards.md) and [loop-four handoff](../plans/handoff-reports/2026-09-21-lab-hitl-proposed-loop4.md). The one-page field set is informed by the [quote/create harness handoff](../plans/handoff-reports/2026-09-23-quote-create-harness-handoff.md); its live test data is not reused.

## Gallery boards

Open [the standalone gallery](./2026-09-23-centurion-flow-c-shotgun-gallery.html) in a browser. It is self-contained HTML/CSS with in-page navigation and no external assets.

1. Inbox overview — email, evidence, and two scoped Proposed cards.
2. Multi-ask — separate action cards with separate verbs, evidence, and colors.
3. Amendment — newest inbound is actionable; prior requests are folded.
4. PDF rooming list — extracted guest/room facts point back to page evidence.
5. Quiet skip — no reservation action is proposed for a Sales handoff.
6. Needs a person — conflicting dates and missing fields remain unresolved.
7. Staff-did truth states — source present versus no verified result; no mock payload.
8. Multi-user queue — separate authenticated users, one property-scoped read in flight.
9. Popout — full-workspace concept beside the existing Outlook pane, clearly marked unshipped.
10. Flow C builder — one page, source-linked fields, unresolved controls, no live quote or save.
11. Compact pane — same evidence and status hierarchy at Outlook-pane width.

## Flow C page contract

Keep the inbound email visible beside the form. Group the fields into Guest, Stay, and HMS setup; show a source badge on every extracted value; leave unsupported values blank; and surface the missing required fields together. The page should make the next human decision obvious without implying that a quote was fetched or a reservation was created.

The concept includes arrival, departure, adults, room count, guest name, room type, rate plan, source of business, track, and guarantee. The create harness found that guarantee can be required by HMS even when the empty form does not visually mark it required, so the design calls it out explicitly. The exact production contract still needs confirmation before implementation.

## Not included

No React edits, API/schema changes, quote execution, reservation mutation, Outlook host changes, shared-session/auth changes, or screenshot assets. Those need a separate implementation plan after the Flow C field contract and queue/popout behavior are confirmed.
