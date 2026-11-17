---
name: cancel
description: Use when a current hotel email requests cancelling or releasing an existing guest reservation or booked room, including partial party cancellation, no-longer-travelling messages and cancellation-charge questions.
---

# Cancel

Read [common rules](../references/common.md), [scope/fees/native order](references/rules.md), [reply drafts](references/replies.md).

1. Identify current cancellation intent + actual saved stay. Withdrawing unaccepted quote ≠ cancelling booking. One-night shortening → amend, not whole-stay cancel.
2. Search/read exact property/reservation/guest/dates. Resolve room/party scope; linked stays never imply group-wide permission. Zero/ambiguous candidates → specific clarification.
3. Read current status. Already cancelled → no second write. In-house/completed/no-show/unsupported state → staff review; never force native status.
4. Preview live reason code + meaning, note, affected stay and native fee. In `waiting_go`, staff see amount and choose supported charge/waive before one Go (R9; 5–10/51 threads mention fees). Unknown fee ≠ zero.
5. Publish target/scope + preview; `hms_save` waits for one staff Go. Re-stage approved choice, cancel, read fresh. Unexpected/changed fee needs staff review and reconciliation; no second Go in same cancellation flow.
6. Fresh read target/status/cancellation identifier/actual fee if exposed. Uncertain/partial result → read first; never cancel again blindly. Draft only supported cancellation/charge facts.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `hms_prepare`, `proposal_publish`, `hms_save`, `reply_draft`. Exact [bindings](../references/tools-and-proposal.md). Backend initial cancel handler absent; supported capability required.

Example: cancel Guest A's extra room, book Guest B → cancel one verified room + separate create task. Never cancel associated party.
