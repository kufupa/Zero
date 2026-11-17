# Create decisions + fields

## Rules

- C01 Explicit book/reserve/proceed → create. Quote subject does not override booking body. Hold-only, status check, payment acknowledgment, chaser ≠ create authority. “Confirm” ambiguous → resolve actual intent; explicit “book and hold” remains booking instruction.
- C02 Keep full guest identity + arrival/departure + each room's occupancy/children ages + room/rate/meals + bill-to linked. Missing/contradictory task-critical facts → inspect supplied spec, then clarify. Never choose conflicting dates silently.
- C03 Multi-room = separate guest/room/stay assignments. Preserve different dates, meal plans, rates, payer scopes. Do not invent room sharing or distribute occupants evenly. Group/attendee totals and room-nights ≠ simultaneous rooms.
- C04 Native rate code + meaning + exact stay availability + price. Requested corporate rate may guide catalogue search; company name alone never proves eligibility or selects rate. Do not replace unavailable requested rate silently; offer verified alternatives.
- C05 Source, market, track distinct. Select native source from explicit agency/context; employer, sender domain, bill-to are separate concepts. Preserve uncertainty rather than inserting guessed code.
- C06 Match profile with supplied identity evidence; new profile only when needed/supported. Guest contact, booker, Organization, Primary Booking Agency, A/R account, PO/reference, employer, bill-to each separate. Company reply alone ≠ invoice instruction.
- C07 Payment method, guarantee, voucher, deposit and POP distinct. Preserve explicit payer and covered charges. Pro-forma/card instructions ≠ paid account. AirPlus handling unverified: inspect actual document, staff-review unknown billing/guarantee instructions.
- C08 Inspect actual attachment + same stay match; body claim or filename insufficient. Confirmation PDF supports historical facts, not current availability/native state. Cross-thread number links require identity/stay confirmation.
- C09 Notes, booker/contact, guest email, CMS recipient/message ID/send opt-in separate. No inferred CMS recipient or send consent. Labtest CMS off. Never promise special request fulfilled merely because note staged.
- C10 Current duplicate/reconfirm candidate → native lookup. Check Availability before Save. After Save compare actual business values; uncertain/partial result per common rules, not re-create.
- C11 Staff-facing defaults: unspecified room → standard queen only with verified property-native mapping; charge-room follows room type until staff override. Preserve explicit staff change. Surface actual HMS-derived segment/track/subsegment after rate selection when supported. Corporate/government→business and tour operator→leisure are staff-reported patterns, **not verified native mappings**; no hard-coded codes. No generalize across properties.

## Native staging order

| Order | Staff business field/step | What to preserve |
|---|---|---|
| 1–3 | Arrival, departure, adults | Exact dates/occupancy; nights derived from dates |
| 4 | Source of business | Native code + meaning, distinct from bill-to |
| 5 | Room type | Requested/supported native type; room-for-charge separate if used |
| 6 | Rate plan | Typed code + dropdown meaning + native price |
| 7 | Track | Native selection; not agency/market inference |
| 8 | Guarantee | Explicit supported selection; no default policy invented |
| 9 | First/last name | Bound to selected guest profile or new guest |
| 10 | Check Availability | Exact proposed stay/occupancy/rate |
| 11 | Save + readback | Staff Go; verify per-item business result |

Additional fields: children/ages, room quantity, room-for-charge, meals, Organization/Agency, A/R/PO/billing ref, notes, booker/contact, CMS. Native helper support exists; complete visual/staff placement not evidenced. UI may group sensibly; tools must execute supported native order. Do not pin form body/keys/counts.

Staff-facing supplemental order: Awaiting Payment above Reservation Note if adapter supports; airport/lunch/lunch-pack choices only exposed with native support. CMS send requires usable verified recipient/profile email and staff instruction; two additional CMS rules mentioned but not supplied. No invented controls or claims of note fulfillment.

Readback: guest + dates + occupancy + room/rate/price + source/track/guarantee; requested optional fields only where saved reader can verify. If billing ref cannot be checked, disclose unverified; never claim persistence. Multi-room results separately.
