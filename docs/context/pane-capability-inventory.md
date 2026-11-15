# Reservation pane capability inventory

Inventory taken before consolidation cleanup, 2026-11-15, from
`components/nava-pane/nava-pane.tsx`, `components/quote-workflow/quote-workflow-panel.tsx`,
their child components and hooks. Paths below are relative to `apps/mail`.
This is a source-level inventory, not a claim of live HMS verification.

Both production entry points already use `ReservationPaneHost`: Outlook
`app/(routes)/outlook-pane/page.tsx` and webmail `components/nava-pane/web-pane-panel.tsx`.
The host always opens `ReservationWorkspace`; no workflow or property selects the
legacy panel. The HRDAV/HRDAVS hotel switch stays in that same host; HRCEN comes
from the connected mailbox configuration.

## Staff capabilities

| Old-panel capability | New-pane coverage / preservation decision |
| --- | --- |
| Selected email identity, subject, sender and attachments | Host and source evidence controls; covered. |
| Mailbox sign-in, Outlook pairing, reconnect and add-in update guidance | Host and shared bridge; covered. |
| Outlook sync progress, pause/resume and mailbox context | Host and shared sync controls; covered. |
| HRCEN configuration and HRDAV/HRDAVS selection | Shared host configuration and Hotel selector; covered without a legacy fallback. |
| Read email/attachments, show unread sources and retry extraction | Workspace prefill, issues and source evidence; covered in part; retain legacy source-failure and retry presentation. |
| Skip OTA/system mail; identify existing-stay self-mail and separate asks | Source/prefill handling and request cards; retain legacy no-action, OTA channel and existing-stay explanatory presentation. |
| Correct workflow / manually start a booking | Add action and action tabs; covered. |
| Re-read with a free-text staff correction | No equivalent correction-note submission found; retain `CorrectionNote`, shell handler and dependencies. |
| Persist edits, recover failed saves, undo/redo | Workbench edit buffer, conflicts and history controls; covered. |
| Reset old read, inspect revision history and field provenance | Undo/redo and field evidence exist; legacy reset/history/provenance presentation retained where not equivalent. |
| Mark questions/secondary asks handled; undo; prepared staff tasks | New request/issue display is not equivalent to legacy per-item handled/undo controls; retain those controls and persistence. |
| Show unsupported requests and draft a missing-details/partial-failure reply | New issues do not replace every reply path; retain legacy question/reply helpers. |
| Organization, booking agency and A/R search, candidate selection and evidence | Native pickers and workbench lookup; covered. |
| Edit booker/contact details used in quotations | New Create fields and quote output exist; retain legacy quote-specific contact editor until parity is verified. |
| Add/remove/undo rooms and stays; dates, nights, room type, occupancy, children and meal plan | New Quote/Create editors, row actions and shared fields; covered. |
| Native rates, availability, room/rate selection and price review | New Quote/Create/Amend preparation and pickers; covered. |
| Side-by-side sales-strategy comparison, saved rates and one-off rate controls | No equivalent for every legacy comparison/saved-rate action; retain rate components and binders. |
| Typed/override rates, approval notes and stay extras | New Create typed-rate controls and Add-Ons cover core path; retain old quote-specific rate/extras behavior not proven equivalent. |
| Select alternative offers and multi-option quote replies | No complete equivalent found; retain offer selection and multi-option reply helpers. |
| Quote cover reply editing, PDF/Excel download and unsent draft save/replace confirmation | New quote output panel/workspace; covered for current quote outputs. |
| Reuse earlier staff quote for booking or re-quote an expired quote | No equivalent prior-revision chooser found; retain booking-draft binders and shell integration. |
| New guest profile or existing guest selection; duplicate handling | New Create editor and guest profile commands; covered. |
| Create with native unsaved preview, staff Go, saved confirmation and readback | New Create workflow; covered. |
| Multi-room booking inclusion, batch evidence and per-room results | New sequential Create exists; retain legacy batch evidence/review/inclusion until equivalent staff controls verified. |
| Amend search/selection, editable fields, repricing and staff Go | New Amend editor; covered. |
| Cancel lookup, reason, penalty review and second staff confirmation | New Cancel editor and preparation; covered. |
| Find stay and file voucher/payment proof; choose attachment and target | New Filing editor; covered. |
| Booking voucher details, filing receipt and follow-up reminders | Filing exists; retain legacy voucher summary/follow-up controls where no equivalent exists. |
| Shuttle draft and secondary service requests | New Add-Ons editor covers native services; retain legacy shuttle-specific draft. |
| CMS send checkbox, message and recipient | New Create/Amend editors; covered. |
| Unknown-write outcome checks and recovery, without blind retry | New dispatch/result notices and Check outcome; covered. |
| HMS queue, running-job chip and cross-email completion/failure notices | Not equivalent to current-email dispatch status; retain legacy provider, notices, queue and polling graph. |
| Native screenshots, audit evidence and HMS link actions | New source evidence is not native screenshot parity; retain screenshot/audit/link components and transports. |
| Translation and saved/AI reply insertion | No full equivalent found; retain translation/reply blocks and hooks. |
| Needs-you queue and navigation to original thread | Webmail control remains; retain legacy pane entry/screen/navigation support. |
| Gold workflow labeling and workflow badge | Legacy labeling remains separate; retain labeling/badge and shell support. |
| Welcome/tour, connection diagnostics, system check and build information | Host has limited connection/build notices; retain legacy screens, menu and system-check hooks. |
| Email/WhatsApp feedback links | No equivalent host menu found; retain legacy menu. |

## Cleanup boundary

The interrupted worker had staged deletion of 105 legacy files before this
inventory existed. Those deletions are not safe: the graph contains capabilities
listed as gaps above, existing focused tests, and shared HMS write helpers.
Restore that graph intact rather than guess at leaf-level parity. Retaining
source does not route production traffic through it: the two production entry
points remain on the new reservation pane for every action and property.

No legacy capability is claimed as newly available in the new pane. Gaps above
are retained implementation for later porting, not a staff-facing fallback or a
second workflow route. No legacy source file is deleted in this change.
