// Agent SOP for workflow: quote
export const QUOTE_FINISH_SOP = `AOP-1 finish — lodging quote / availability. Spine (party→contract, skip OTA, unsent draft, no HMS write) already applies. Do not repeat it.

Entry: rate, quote, quotation, price or availability for a stay at this hotel, no existing confirmation. A change of dates, rooms or numbers on a quote thread is still quote (re-price) — never clarify, never amend unless a confirmation number is present. A day-of-month is enough; resolve it from the thread.

Stay on workflow=quote whenever the mail asks a rate or availability, or gives dates for this hotel. Mixed conference, shuttle, transfer or event details do not change that. skip, other and forward_to_partner only for true no-ask FYI (thanks / noted) with no dates, rooms, rates or references. Dated rooms are never skip, other, clarify or forward. A short inbound (rate code, booking ref, empty subject) is still quote, never skip.

1. Dates. Missing departure: assume 1 night and say so in replyDraft. Missing arrival: still quote; list missing; no tools. Never open a quote with a clarifying question (staff 0%). Headcount-only with no room split (~10+): one rooms/sharing question only if rooms cannot be derived.
2. Defaults. No board → B&B. No occupancy → 1 adult/room. Rooms from the guest total. Unresolved type → all types. Never clarify for those.
3. quote_stay. Call it. Unavailable or error: still workflow=quote. replyDraft = short holding text that staff will price. No invented rates. No hms_todo. No clarify, skip or other because the tool failed.
4. Availability (when counts exist). Call decideQuoteAvailability. full → quote. partial → quote, replyDraft = replyLine ("We have X of the Y rooms for <dates>; shall I proceed with X?"). sold_out → quote, replyDraft = the one-line decline. Never offer another hotel, date or room type.
5. DBB. Include the Dinner Allowance line from decideQuoteAvailability (Centurion default R350 pp/night). Do not invent another amount.
6. Acceptance. Guest accepts a prior quote / "please book" / "confirm the booking" now, and is not asking a new rate → create. First-mail quote stays quote even if it also says book. Hold / option / "I will come back" / asking for a signed quotation or names is still quote, not create.
7. Pure venue / conference / DDR with no dates and no rate ask → forward_to_partner. Any price or availability ask stays quote.

Done: workflow=quote (create only on acceptance). replyDraft = quote, proceed question, decline, or holding text. Never claim a send or HMS write.`;
