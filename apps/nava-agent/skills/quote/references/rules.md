# Quote rules + fields

- Q01 Availability/quote = read-only offer. Price check never creates Guest Stay or holds inventory. Acceptance/proceed separate create task; signed document must be inspected, not inferred from subject.
- Q02 Required native criteria: property, exact stay dates, room quantity, per-room adults/children/each age. Guest names, headcount, attendees, room-nights never substitute room assignments. No children indicated after reading relevant request/docs → editable zero quote default, `child_ages:[]`, not an extracted fact. Children indicated but count/ages unclear → clarify; unknown adult count/room quantity still input gaps.
- Q03 Show native room/rate code + meaning, dated price/currency/basis, availability and eligibility/restrictions separately. Price ≠ inventory ≠ official stay total. Missing result combination stays unknown; `criteria_unavailable` ≠ hotel sold out.
- Q04 Negotiated party rate: native Organization/Agency/Group selection + eligible rate. Domain/employer/government/corporate wording insufficient. Free-text quote recipient/name need not match an HMS Organization for public rates. Public BAR after absent contracted rate = explicit alternative, not contracted offer.
- Q05 Meals separate: room-only/BB/DBB/half/full/all-inclusive according to native meaning. Conflicting room-only + breakfast → ask/show clearly distinct options. Dinner/soft drinks included only when actual native bundle proves it. Child age bands/fees never invented.
- Q06 One client quote can contain many room/date/occupancy groups; separate quotes only explicit request or staff split. Call `hms_quote` separately where top-level dates or search context differ. Preserve group IDs; merge results into same client quote. Group duplicate gets new ID, copies editable fields only, no stale results/review. Staff price override labelled override, not HMS price; preserve supplied approval note, no inferred universal gate.
- Q07 >10 concurrent rooms → group flag; group booking/allotment work may need staff. Group attendees ≠ rooms; do not suppress supported read-only quote because group flagged. No inferred group-booking permission.
- Q08 Special requests/rooming lists/docs bound to correct stay. “Attached” ≠ file captured; read supplied file before using contents. Connecting/cot/dinner/transport requests not guaranteed by note.
- Q09 Missing dates/occupancy/board/party or unsupported request → targeted needs-info/staff review. Decline only demonstrated native inability; tool errors or missing rows never become “fully booked.” Old quoted task superseded by current existing-stay check → don't quote anew.

## Field order

Staff-facing task groups: property → arrival/departure → room type/quantity → adults/children/ages → bed/board → native party/rate request → native choices/code/meaning/availability/price → special requests/guest labels → offer/reply. Proposed business grouping, not universal visual order proof.

Native order: reset prior party/room/rate/currency → arrival → Group → Organization → Agency → sales strategy → restore arrival → adults → children → each child age → currency/conversion → restricted-rate visibility → room codes → rate codes → verify criteria → Search/grid/date windows. Deterministic adapter owns technical reset steps; skill owns correct criteria.

Use typed rate code + current dropdown meaning + native price/availability; staff edit persisted. Existing manual-override UI's code list is not native catalogue authority. Full staff field-entry order not independently observed.

Native capture: nightly dated price/inventory/restrictions. Current official totals null when absent; calculated displayed-nightly sums `official:false`, label “Displayed nightly sum (not HMS payable total)”. Per-group quotes may use separate calls; no made-up combined payable total.

Thin backend binds only last native quote capture to proposal. Until multi-capture aggregation exists, retain all requested groups in proposal, explicitly mark any groups without publishable native results. Never splice raw captures into `native_result` or claim complete multi-group pricing.
