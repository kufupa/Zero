# Staff UI feedback, consolidated (research pass, 2026-10-12 23:50 UTC)

Sources: `bongi UI call transcript.md` (Fri 10-09 staff call), the founder's Friday prompt (2026-10-09 15:17 UTC, session 5010619f L356), founder turns Oct 7–12, retro 10-11, handoff N2. Against main a2816a753: 29 asks, 5 done, 11 partial, 11 not done, 2 unknown.

Friday prompt, verbatim (key lines):
- "we should put the name company email details at the very, very top. So that should be pre-filled at the very top."
- "...that only allows her to select one type of room and it wasn't clear what's going on"
- "maybe we provide a total number of rooms or total occupancy count"
- drag-drop POP is "the highest ROI thing we can possibly" provide; "She thought this would save the attachment into her HMS record."
- "not show errors to non-technical users to scare them unless we're confident"
- "if anything takes over 30 seconds, then it's probably worth flagging"
- "she treats the side panel ... as like a to-do UI"
- "why does the find this booking HMS button exist after they've clicked it already"

## Rules for the pilot pane (W3 review checklist)
1. Order follows the staff flow: contact → which email (one-line strip) → stays → rates → HMS/confirmation → review. One primary action per step.
2. Contact is read-only, with "Correct". Every edit says where it saves. No silent HMS write.
3. Rooms are rows by room type with counts (Infor names, e.g. "Standard Queen (STQN)"). Mixed types are allowed. A totals row shows rooms and guests. Never "Room 1/2".
4. One card per stay, one date range, no duplicates. Dates are unambiguous.
5. Get rates never needs a room picked first. A one-off typed rate and saved custom rates are both available. A discount needs "Authorised by".
6. HMS runs in a background queue: start it and move on, with a timer and a done notice. Past 30 s, flag it in plain words. No raw errors.
7. Needs you holds short typed lists. Dismiss offers Undo and moves the item to Finished. Mail before the pilot cutoff counts as done.
8. The booking card has one Copy confirmation and one Open HMS (only if it really works). No repeated copy rows. Hide the Find button once it has run.
9. Ship only what works: no "Coming soon", no mock text. Staff never need to open Info to finish a step.
10. Keep the current look, with less dense text. Same components in the Outlook pane and webmail. Right-hand scrollbar.

## Not done on main, by priority for tonight
- Lane C has these: contact read-only; drop "Room N"; done notice; remove "Coming soon" in the quote flow.
- W3: totals row (rooms + guests); 30-second "still working" flag; one Find per section, hidden once it has run; "Coming soon" removed from booking-card.tsx:844, approve-card.tsx:350 and amend-lookup-panel.tsx:642; translation box collapsed at the top for non-English mail only; Needs-you Undo + Finished.
- Not tonight: drag-drop POP (attach works only on the test property, so it's a write); a type dropdown per email; morning batch view.
