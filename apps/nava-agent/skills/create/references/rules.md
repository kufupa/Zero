# Create decisions + fields

## Rules

- C01 Explicit book/reserve/proceed → create. Quote subject does not override booking body. Hold-only, status check, payment acknowledgment, chaser ≠ create authority. R6: confirmation notice including HMS pre-stay → existing stay, never Create from notice; guest text → note/Amend candidate (20/107 pre-stay self-mails). Ambiguous “confirm” → clarify.
- C02 Keep full guest identity + arrival/departure + each room's occupancy/children ages + room/rate/meals + bill-to linked. Missing/contradictory task-critical facts → inspect supplied spec, then clarify. Never choose conflicting dates silently.
- C03 / R8: sequential single-room creates from separately scoped, approved guest/room/stay items. Preserve dates, board, rate, payer; verify readback per item. No hard numeric cap; ≥10 rooms → rooming-list/group review before writes. Evidence: 151/222 creates one confirmation, 41/222 two, 12/222 three, 9/222 four; tail to 10, requests to 30. Uncertain item → stop/reconcile; never replay saved items. No invented room sharing.
- C04 Native rate code + meaning + exact stay availability + price. Requested corporate rate may guide catalogue search; company name alone never proves eligibility or selects rate. Do not replace unavailable requested rate silently; offer verified alternatives.
- C05 Source, market, track distinct. Select native source from explicit agency/context; employer, sender domain, bill-to are separate concepts. Preserve uncertainty rather than inserting guessed code.
- C06 Match profile with supplied identity evidence; new profile only when needed/supported. Guest contact, booker, Organization, Primary Booking Agency, A/R account, PO/reference, employer, bill-to each separate. Company reply alone ≠ invoice instruction.
- C07 Payment method, guarantee, voucher, deposit and POP distinct. Preserve explicit payer and covered charges. Pro-forma/card instructions ≠ paid account. AirPlus handling unverified: inspect actual document, staff-review unknown billing/guarantee instructions.
- C08 Inspect actual attachment + same stay match; body claim or filename insufficient. Confirmation PDF supports historical facts, not current availability/native state. Cross-thread number links require identity/stay confirmation.
- C09 / R3: CMS Send default on; prefill usable requester email, editable with tick and supported message ID (228/228 confirmed-create sample got later letters; 217/222 to requester). Separate guest/booker/contact and CMS recipient. HMS sends only if ticked at approved Save. Labtest off; Nava drafts only. Note staged ≠ request fulfilled.
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

Staff-facing supplemental order: Awaiting Payment above Reservation Note if adapter supports; airport/lunch/lunch-pack choices only with native support. Show R3 CMS controls; missing usable requester email → staff correction or untick, never guess.

Readback: guest + dates + occupancy + room/rate/price + source/track/guarantee; requested optional fields only where saved reader can verify. If billing ref cannot be checked, disclose unverified; never claim persistence. Multi-room results separately.
