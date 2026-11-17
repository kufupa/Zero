---
name: amend
description: Use when a current hotel email requests changing dates, guest details, occupancy, room, rate, contact, billing or preferences on an existing reservation, including extensions and per-room changes.
---

# Amend

Read [common rules](../references/common.md), [patch rules + fields](references/rules.md), [reply drafts](references/replies.md).

1. Resolve property + existing native reservation; verify guest/stay. Confirmation number is candidate evidence, not arbitrary ID substitution. Ambiguous target → exact clarification.
2. Fresh-read `current_state`. Extract latest delta only. Existing pre-stay guest text → note/Amend candidate, never Create from notice (R6). Preserve scope. Separate genuine new-room ask; shortening stay ≠ whole cancellation.
3. For dates/room/occupancy/rate changes, native-reprice/check availability in affected stay context. `hms_quote` supports pricing options; generic offer cannot alone prove existing held room unavailable. Publish price change/unknown scope.
4. Stage requested supported fields: find/read → patch fill/blur/read → Check Availability → preview. Exact fixed staff field order unproven; proposed grouping in reference. Unsupported field → explicit review, not no-op success.
5. Publish ordered patch + before-state + native preview + source/target IDs. Show CMS Send default on + editable requester recipient (R3; Labtest off). No copied old dates/rates overriding current ask.
6. `hms_save` after publish waits for staff Go. Backend re-stages edited delta, Save + fresh readback. Compare changed values/target; uncertain/partial state → read first, no blind retry.
7. Draft revised confirmation only verified fields/items; preserve unresolved requests for staff. Preference note ≠ fulfilled amenity.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `hms_read_catalogue`, `hms_quote`, `hms_prepare`, `proposal_publish`, `hms_save`, `reply_draft`. Exact [bindings](../references/tools-and-proposal.md); initial backend may lack amend handler.

Example: “Guest A leaves one day earlier; Guest B unchanged” → A departure patch, B unchanged evidence; never cancel party or reset B rate.
