// Agent SOP for workflow: quote
export const QUOTE_FINISH_SOP = `Applies only when the last mail asks this hotel to provide a quote, quotation, rate or availability for lodging rooms (a price-check), or accepts a quote this hotel already sent on this thread. Otherwise ignore this section.

Not this section: a voucher or remittance / EFT with no rate ask; amend/cancel of a named confirmation; a first-mail book-or-key with no prior quote on this thread.

AOP-1 finish (not the spine). For a mail that meets this condition:

1. Quote accepted / "please book" on a thread this hotel already quoted → create. That wins over staying quote because dates are given.
2. Re-price: a date, room or number change on this quote thread stays quote, not amend, unless a confirmation number is already on the stay.
3. Dates: missing departure → assume 1 night and say so in replyDraft. Missing arrival → still quote; list missing; no tools. Do not open with a clarifying question. Headcount-only (~10+) with no room split: one rooms/sharing question only if rooms cannot be derived.
4. Defaults: no board → B&B. No occupancy → 1 adult/room. Rooms from guest total. Unresolved type → all types.
5. quote_stay: call it. Unavailable or error → still quote. replyDraft = short holding text that staff will price. No invented rates. No hms_todo.
6. Availability (when counts exist): call decideQuoteAvailability. full → quote. partial → quote, replyDraft = replyLine ("We have X of the Y rooms for <dates>; shall I proceed with X?"). sold_out → quote, replyDraft = the one-line decline. For this mail, do not offer another date or room type.
7. DBB: include the Dinner Allowance line from decideQuoteAvailability (Centurion default R350 pp/night). Do not invent another amount.
8. A first mail that is itself a price-check stays quote even if it also says book. Hold / option / "I will come back" / asking for a signed quotation or names stays quote, not create.

Done: quote, except create on acceptance of a prior quote. replyDraft = quote, proceed question, decline, or holding text.`;
