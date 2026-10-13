# R1 — Quote gold: inbound ask → staff output

## 1. Answer

**[M] Built [M] 93 same-thread ask→staff-output candidates from [M] 313 detected quote/availability asks; [M] 220 detected asks have no staff outbound in the bounded reply window.**

**[M] Only [M] 18/[M] 93 pairs have a parseable nightly rate. Quote, HMS-offer, and confirmation PDFs expose no explicit rate-code field; rate-plan gold is sparse [I].**

**[M] The [M] 8 headcount-only pairs show [M] 0 quantified single-plus-shared room mixes. The corpus does not support a general room-splitting rule [I].**

**[I] Reproduce answers from verified party context and per-stay live quote results; clarify missing occupancy/dates, preserve requested meal basis, and keep custom rates behind staff authorization.**

## 2. Method

- Read the local [2026-10-13 corpus](/home/orca/nava-research/corpus/2026-10-13/) only (the supplied [M] 75-day snapshot): [M] 12,433 messages, [M] 3,697 extraction rows, [M] 2,426 messages with a latest succeeded extraction, [M] 2,162 staff-PDF manifest entries/texts, [M] 178 HMS-read rows, and [M] 23 staff-quote runs. No network service, database, or HMS was contacted.
- Eligible asks were inbound, non-staff, and not from the excluded channel domains or their subdomains: `synxis.com`, `expedia.com`, `expediapartnercentral.com`, `partnercentral.com`, `webbeds.com`, `hotelbeds.com`, `booking.com`, `get-e.com`, `get-e.co.za`, `hotels.com`, `agoda.com`, `trip.com`, `traveloka.com`, `airbnb.com`, `reviewpro.com`, `trustyou.com`, `tripadvisor.com`, `revinate.com`, or `medallia.com`. The quote/availability detector required an ask signal plus quote/rate/availability language and lodging context; it filtered booking-status, venue-only, invoice, cancellation, and other non-quote messages. It selected the latest succeeded extraction per message by `created_at`.
- Paired each candidate to all subsequent `@legacyhotels.co.za` outbound messages in the same `thread_id`, sorted by message timestamp and original row order for ties, up to the next detected ask in that thread. Staff PDFs attached to those outbound messages were included. Inbound clarification messages before the first staff reply informed request-shape labels. This is a thread-window heuristic, not an `In-Reply-To` proof.
- Ran [quote_gold_research.py](/home/orca/nava-research/scripts/r1/quote_gold_research.py). Re-run aggregates with `python3 /home/orca/nava-research/scripts/r1/quote_gold_research.py`; re-run up to [M] 30 masked examples with `python3 /home/orca/nava-research/scripts/r1/quote_gold_research.py --snippets 30 --sample-set paired`. Snippet output is capped at [M] 180 characters. PDF rates, code fields, board, and date/room observations are regex-parsed from `pdftxt/`; workflow traces are reduced to aggregate counters.
- Confidence: medium for timestamps and literal PDF fields; medium-low for pair boundaries and output extraction; low for taxonomy labels, rate-code semantics, dinner units, and room-option counts. Shapes overlap. Unless noted otherwise, shape shares use the [M] 93 paired candidates as denominator.

## 3. Findings

### Pairing and output coverage

| Stage / observed output | Count and share | Confidence |
|---|---:|---|
| Eligible external inbound | [M] 5,204 | Medium; direction/domain filters |
| Detected quote/availability asks | [M] 313 ([M] 6.0% of [M] 5,204) | Medium-low; text heuristic |
| Same-thread staff-output candidates | [M] 93 ([M] 29.7% of [M] 313) | Medium-low; bounded thread window |
| No staff outbound found in window | [M] 220 ([M] 70.3% of [M] 313) | Low; not proof no reply exists elsewhere |
| Distinct threads among paired candidates | [M] 87; [M] 6 threads contain [M] 12 asks total | Medium |
| Staff outbound body present | [M] 74/[M] 93 ([M] 79.6%) | Medium |
| Any staff PDF / quote-offer PDF | [M] 33/[M] 93 ([M] 35.5%) / [M] 21/[M] 93 ([M] 22.6%) | Medium |
| Any visible amount / parsed nightly rate | [M] 36/[M] 93 ([M] 38.7%) / [M] 18/[M] 93 ([M] 19.4%) | Low-medium; amount basis varies |

Paired staff output contained [M] 72 PDFs: [M] 27 quote offers, [M] 26 invoices, and [M] 19 other documents; [M] 0 classified as confirmation letters. These counts are documents, not unique pairs.

### Request shapes and what staff returned

`R/P/N` = output with room/occupancy text / any visible price / parsed nightly price. `BB/DBB` = output basis mentions. `D` = dinner/meal mention in staff output. `Code` = attached PDF has an explicit rate-code field. `Opt` = median distinct priced room-type labels in quote-offer PDFs (eligible PDF count); this is only an option proxy. Values below are measured [M]; slash-separated output counts are within the row's ask count.

| Request shape | Ask count (% of paired) | Output: R/P/N; BB/DBB; D; Code; Opt | Confidence |
|---|---:|---|---|
| Exact room count + type | [M] 21 ([M] 22.6%) | [M] 13/11/8; [M] 10/4; [M] 5; [M] 3; [M] 1 (offers [M] n=9) | Medium-low |
| Headcount only | [M] 8 ([M] 8.6%) | [M] 5/5/2; [M] 5/2; [M] 3; [M] 0; [M] 1 (offers [M] n=2) | Low; small sample |
| Room count, no type | [M] 18 ([M] 19.4%) | [M] 7/7/3; [M] 7/3; [M] 3; [M] 0; [M] 1 (offers [M] n=3) | Low-medium |
| Group / rooming-list language | [M] 20 ([M] 21.5%) | [M] 4/4/3; [M] 4/2; [M] 4; [M] 1; [M] 1 (offers [M] n=3) | Low-medium |
| Multi-date / multi-stay | [M] 2 ([M] 2.2%) | [M] 1/1/1; [M] 1/1; [M] 1; [M] 0; [M] 1 (offers [M] n=1) | Low; very small sample |
| Meal / dinner asked | [M] 58 ([M] 62.4%) | [M] 19/20/12; [M] 16/10; [M] 14; [M] 3; [M] 1 (offers [M] n=14) | Medium-low |
| Company/agency-rate feature | [M] 1 ([M] 1.1%) | [M] 1/1/1; [M] 1/1; [M] 1; [M] 1; [M] 1 (offers [M] n=1) | Low; not a verified contract ask |
| Children mentioned | [M] 3 ([M] 3.2%) | [M] 3/3/1; [M] 3/0; [M] 1; [M] 0; [M] 1 (offers [M] n=2) | Low; small sample |
| Foreign-language detector | [M] 0 ([M] 0.0%) | — | Low; detector/extractor may miss cases |
| Missing/incomplete date pair | [M] 29 ([M] 31.2%) | [M] 6/8/3; [M] 6/2; [M] 4; [M] 2; [M] 1 (offers [M] n=3) | Medium-low |

The one company/agency-rate feature candidate is a request for a price below [M] R2,000, not clean evidence of a contract-rate ask; its staff reply says government rates. Treat [M] 1/[M] 93 as a low-confidence detector hit, not a measured contract-rate share. Features overlap, so percentages do not sum to [M] 100%.

Shape-level output text flags are also weak: exact-type asks have [M] 1 contract/company phrase and [M] 1 approval/discount phrase; room-count-only, group, meal, and incomplete-date rows each have [M] 1 approval/discount phrase; the company-rate candidate has [M] 1 Government phrase; the other shapes have [M] 0 such flags. The approval/discount detector combines “approved by” with discount wording, so these hits are not proof of custom prices or a specific plan.

### Room allocation evidence

Among headcount-only pairs, output allocation evidence was (low confidence; [M] n=8):

| Output evidence | Count / share of headcount-only pairs |
|---|---:|
| No room/occupancy evidence | [M] 3/[M] 8 ([M] 37.5%) |
| Type/occupancy mention, no quantity | [M] 2/[M] 8 ([M] 25.0%) |
| Some room quantity, no mixed single/shared split | [M] 3/[M] 8 ([M] 37.5%) |
| Quantified singles plus shared rooms | [M] 0/[M] 8 ([M] 0.0%) |

Separate structured staff-quote traces contain [M] 25 group rows from [M] 23 runs: [M] 15 rows have [M] 1 adult/room and [M] 10 have [M] 2 adults/room; quantity-weighted counts are [M] 73 single-occupancy room units and [M] 68 double-occupancy units. Those traces are not specifically headcount-only asks and are not proven sent outputs. They show both occupancies occur, not a rule for splitting a group. Current source instructs that “two people” without a room count means [M] 2 adults in [M] 1 room ([reservationist-decision.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-decision.ts:13)); the corpus does not justify generalizing this narrow rule to larger parties.

### Rate plans, basis, add-ons, and options

| Staff PDF family | PDFs | Explicit rate-code field |
|---|---:|---:|
| Named quote offers | [M] 206 | [M] 0 |
| HMS offer PDFs | [M] 6 | [M] 0 |
| Confirmation letters | [M] 1,176 | [M] 0 |
| Invoices | [M] 388 | [M] 253 |
| Other PDFs | [M] 386 | [M] 87 |

Codes therefore come from [M] 340 invoice/other PDFs (with [M] 342 code occurrences; some documents contain more than one), not the offer/confirmation templates. Literal codes and inferred semantics:

| Codes seen in invoice/other PDFs | Frequency | Interpretation |
|---|---:|---|
| `BAR` [M] 19, `BARRO` [M] 2 | [M] 21 code docs | BAR/public [I] |
| `NGOVDB` [M] 120, `NGOVB` [M] 11 | [M] 131 code docs | Government inferred from spelling [I]; `NGDS3B` [M] 1 left unmapped |
| `NEGOTIATED` [M] 23, `NCOR1B` [M] 22, `NCOR2B` [M] 15, `NCORRO` [M] 3 | [M] 63 code docs | Company/contract inferred from spelling [I] |
| `GROUP` [M] 1 | [M] 1 code doc | Group inferred from spelling [I] |
| Other / unmapped | [M] 126 code occurrences | `BGDSB` [M] 28, `COMPLIMENTARY` [M] 22, `BOTAB` [M] 13, `ACCOUNT` [M] 13, `BEST` [M] 8, `SALES` [M] 8, `WSF2B` [M] 7, `ROOM` [M] 12, `BLRB` [M] 4, `OTA` [M] 3, `EDUCATIONAL` [M] 2, `LOCAL` [M] 2, `CMPBB` [M] 1, `EDU` [M] 1, `NGDS3B` [M] 1, `GDS` [M] 1; meaning unverified [I] |

Across [M] 206 quote offers, board/basis text includes BB in [M] 175 ([M] 85.0%), dinner+BB in [M] 84 ([M] 40.8%), and room-only in [M] 4 ([M] 1.9%); categories can overlap. [M] 111 ([M] 53.9%) mention dinner/meal; [M] 105 ([M] 51.0%) have an amount on a dinner/meal line. Of [M] 160 parsed numeric dinner-line amounts, [M] 13 ([M] 8.1%) fall between R250 and R350, but [M] 0 have a detected per-person/per-guest unit on the same line. The range is not evidence for a per-person dinner tariff. The PDF parser finds Government wording in [M] 5/[M] 206 offer PDFs; this is text, not a verified rate code. No explicit BAR/contract/group code field was found in offer PDFs.

Parsed priced-room labels show [M] 12 quote offers with none, [M] 164 with one, and [M] 30 with two. Among the [M] 194 offers with labels, [M] 164 ([M] 84.5%) show one and [M] 30 ([M] 15.5%) show two. Dated/grouped lines can look like multiple room options, so do not treat this as a true alternatives count.

The separate staff-quote logs show [M] 23 successful runs, all ready for staff review and using BAR strategy; their [M] 25 priced groups all have `rateCode=BAR` and breakfast board. All [M] 23 quote revisions report `observed_not_held`, so these are not reservation holds. Room codes appear as `STWN` [M] 10, `SKNG` [M] 9, `STQN` [M] 6. There are [M] 3 override rows with a non-empty note; no literal “authorised by”/“approved by” phrase was detected in those notes. In quote-offer PDFs, [M] 6/[M] 206 contain “approved by”, [M] 0 contain “authorised by”, and [M] 0 have detected discount/special/reduced wording. Across the full PDF inventory, [M] 8 other PDFs say “authorised by”; “approved by” appears in [M] 2 invoices, and discount/special/reduced wording in [M] 1 invoice and [M] 1 other PDF. These are phrase detections, not proof that a specific quoted rate had valid authorization. Current staff-quote input requires an override rate code, per-night rate, and a note saying who approved it and why ([staff-quote workflow](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/staff-quote-workflow.ts:50)).

### Historical price variation

For each observation, the parser groups same visible arrival/departure, room label, board, and visible rate-code key across documents sent at different times. All repeated keys below have rate code `unknown`; party, occupancy, tax basis, and plan are not reliably visible.

| Documents | Parsed observations | Repeated keys / changed | Min–max spread relative to group median |
|---|---:|---:|---:|
| Named quote offers | [M] 163 from [M] 151 PDFs | [M] 29 / [M] 15 ([M] 51.7%) | Median [M] 5.9%; p90 [M] 106.0%; max [M] 188.2% |
| Confirmation letters | [M] 1,142 | [M] 173 / [M] 57 ([M] 32.9%) | Median [M] 0.0%; p90 [M] 23.5%; max [M] 64.8% |
| Combined | [M] 1,305 from [M] 1,293 PDFs | [M] 202 / [M] 72 ([M] 35.6%) | Median [M] 0.0%; p90 [M] 33.9%; max [M] 188.2% |

Confidence is low for *dynamic pricing specifically*: an apparent change may be a different party, occupancy, commercial plan, or tax treatment. Do not use one global ±% tolerance. For a deterministic replay of the same quote source and inputs, compare ZAR to the same minor unit ([I] ±R0.01 for rounding). For historical documents, score price only after matching stay, room, occupancy, board, party, and rate code; use the exact repeated-key min–max band where that key is reliable, otherwise mark price unscorable.

### Turnaround

Measured from inbound timestamp to the first staff outbound in the pair; all [M] 93 timestamps were present and nonnegative.

| Measure | Time / count |
|---|---:|
| p25 / median / p75 | [M] 0.93h / [M] 4.67h / [M] 25.96h |
| p90 / mean | [M] 71.13h / [M] 53.02h |
| First reply within [M] 1h / [M] 4h / [M] 24h | [M] 25/[M] 93 ([M] 26.9%) / [M] 42/[M] 93 ([M] 45.2%) / [M] 67/[M] 93 ([M] 72.0%) |

### Read-tool and staff-quote traces

The supplied `hms_reads` snapshot has [M] 178 succeeded rows: `find` [M] 94, `search_guest` [M] 49, `staff_quote` [M] 18, `party` [M] 13, and [M] 4 without a kind. There is no `availability` kind in these logs. [M] 17 rows fall in paired threads, including `staff_quote` [M] 9 and `party` [M] 5. The current Mastra agent has a separate `quote_stay` tool; do not treat these older read rows as proof of quote-stay execution.

Of [M] 23 staff-quote runs, [M] 12 share a thread with a paired candidate, [M] 5 match a paired ask's message ID, and [M] 0 match a paired outbound message ID. Treat them as structured auxiliary evidence, not verified final sent offers. Their [M] 25 room groups have [M] 15 one-adult and [M] 10 two-adult groups; this is not linked specifically to headcount-only requests.

## 4. Examples

- [M] Ask `26a90f65-f2df-4be2-87f6-bff2dd657a7a`: “Please advise whether you have available 10x standard single rooms for the night of 16th September ([name]).” Staff reply `c0e7d188-3c3e-49c1-852d-5307d921f62b`: “I only have 1 standard room and 2 suites to sell for the 16th [name].” This is a direct availability answer; a second staff message is `4ca72115-adfe-4448-8da5-98529751a011`.
- [M] Ask `7f441ba0-bd87-4bbe-859c-2ec14d4d0812`: “The client indicated that the rate is a bit high – will it be possible to please offer them a rate below R2 000?” Staff reply `46d022e7-02ce-4ce7-8a8d-0846b60a19d4`: “Please see attached the best offer, please note we are quote government rates.” This illustrates why a lower-price request is not necessarily a contract-rate request.
- [M] Ask `c7fc698d-541d-41f1-8a13-9f3628d86930`: “I would like to enquire about accommodation for the following dates:” Child details are omitted; the paired staff output `15445e7c-0f43-4be3-8276-e471cef3bf34` includes one quote-offer PDF.
- [M] Candidate ask `b2634549-98c4-4baf-829c-e9e1cbd7ae5e`: “Can you please send a quotation for our staff accommodation;” The linked staff body `d2bcddb5-1f1c-4a4e-8a83-4c95e5b49d8e` says “[name] has been done and pro forma invoice will follow shortly.” This is a weak quote-gold candidate and needs human adjudication.

## 5. Implications for the product

### Target-agent spec

- **Inputs [I]:** normalized thread + relevant attachments; per stay, ISO arrival/departure (checkout-exclusive), room groups with quantity, adults per room, child ages, room preference/type, board, named company/agency/guest, budget/rate claims, and missing-field flags. Keep ask facts distinct from inferred assumptions.
- **Tool sequence [I]:** for a named company/agency rate, call `party_lookup` and use only the selected HMS `nativeId`; for each fully specified date range and occupancy mix, call `quote_stay` for live availability and rate options. This is one combined availability+rate call, not separate tools; it requests alternatives while excluding restricted rates ([reservationist-agent.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-agent.ts:108)). The current quote accepts one stay with up to [M] 8 occupancy groups, and the quote-PDF schema accepts up to [M] 7 rate lines ([reservationist-agent.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-agent.ts:45)). Preserve returned options and party context. Current workflow rules require party lookup before named company/agency pricing, say not to quote with missing dates, and direct formal written quotes to a PDF tool ([reservationist-decision.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-decision.ts:3)). The `quote_proposal_pdf` schema accepts rate-per-room/night lines ([reservationist-agent.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-agent.ts:79)). Do not promise a booking.
- **Decision rules and observed coverage:**

| Rule | Paired-ask coverage | Agent behavior |
|---|---:|---|
| One stay with complete dates | [M] 62/[M] 93 ([M] 66.7%) | Quote that stay; normalize dates and keep checkout exclusive [I]. |
| Missing/incomplete date pair | [M] 29/[M] 93 ([M] 31.2%) | Ask only for missing arrival/departure date(s); no quote call until complete [I]. |
| Multi-date / multi-stay | [M] 2/[M] 93 ([M] 2.2%) | Split into one quote call per date range; do not blend stays [I]. |
| Exact rooms/types | [M] 21/[M] 93 ([M] 22.6%) | Preserve requested types and quantities; flag unavailable exact matches and return tool-backed alternatives [I]. |
| Room count without type / group list | [M] 18/[M] 93 ([M] 19.4%) / [M] 20/[M] 93 ([M] 21.5%) | Keep room counts/list groupings; ask only for occupancy/type details that change pricing [I]. |
| Headcount only | [M] 8/[M] 93 ([M] 8.6%) | Ask how many rooms and who shares; if useful, show explicit single/shared scenarios rather than silently assigning them [I]. |
| Meal/dinner request | [M] 58/[M] 93 ([M] 62.4%) | Preserve the requested board; price dinner as an explicit unit/add-on, never assume R250–350 per person [I]. |
| Children | [M] 3/[M] 93 ([M] 3.2%) | Pass child count and ages; clarify ages when absent [I]. |
| Company/agency-rate feature | [M] 1/[M] 93 ([M] 1.1%), low confidence | When party-linked pricing is explicitly requested, verify the party and use only its returned rate; never infer entitlement from a company name [I]. |
| Foreign-language request | [M] 0/[M] 93 detected | No behavior coverage can be estimated from this snapshot [I]. |

- **Rate/discount guard [I]:** the current reservationist quote input has party context but no direct rate-code selector ([reservationist-agent.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-agent.ts:45)); the separate staff-quote flow supports BAR/Government strategy ([staff-quote-workflow.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/staff-quote-workflow.ts:96)) and per-group rate codes ([staff-quote-workflow.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/staff-quote-workflow.ts:38)). Confirm which rate plans the live runner is authorized to expose. Never treat a budget request as discount approval; route a custom override to staff with the required approver/why note ([staff-quote workflow](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/staff-quote-workflow.ts:50)).
- **Output contract [I]:** return each tool-backed option with stay dates, availability, room code/type and count, adults/children per room, party/rate code and label, board, ZAR per room/night, total, taxes/inclusions when known, and explicit add-on amount/unit. Give one best-fit option and at most one genuine tool-returned alternative; the PDF proxy is mostly one priced room type, but does not prove alternatives count. State missing assumptions and whether a price is public, party-linked, or staff-authorized.

### Backtest definition

- **Candidate pool:** the [M] 93 paired ask/output candidates ([M] 87 threads); keep repeated asks from the same thread in one split. Human-adjudicate pair boundaries and reject non-quote artifacts such as the weak pro-forma example above before calling rows “gold.” The [M] 220 unpaired asks are a reply-visibility/abstention set, not answer gold.
- **Scored fields:** request parse—dates/stays, party, room types/counts, occupancy, children/ages, board, budget, and missing fields; action—party lookup and quote calls with the right arguments; output—availability, selected room mix, board, plan/code, nightly ZAR and total, add-on units, and genuine alternatives. Compare exact discrete fields; price uses the tolerance policy in Historical price variation. Mark absent evidence unscorable rather than guessed.
- **Price-scored subset:** at most [M] 18/[M] 93 candidates have a parsed nightly rate; only score after manually confirming room/date/board/party/rate plan. If no matching plan or source-time baseline is available, do not fail on a historical price. The present offer PDFs do not expose rate codes.
- **Expected difficulty [I]:** moderate for basic ask parsing, high for headcount allocation and commercial-rate reproduction, and high for historical price scoring. The [M] 8 headcount-only pairs do not show a mixed allocation rule; quote/confirmation price keys hide plan and party; meal units and true option counts are mostly unobserved.
- Keep the corpus-derived test set private and separate from the existing operator-built golden set; the current backtest source describes an [M] 80-case dev / [M] 40-case holdout set ([reservationist-backtest.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/reservationist-backtest.ts:90)). No backtest or live quote call was run for this read-only analysis.

### Open questions

- What do the unmapped legacy codes (`BGDSB`, `BOTAB`, `NCOR1B`, `NGOVDB`, and others) mean, and which require a verified company, agency, or government party?
- What is the approved occupancy/share policy for a headcount-only group beyond the documented two-person case? Do staff offer fixed single/twin/double scenarios or ask first?
- Are the [M] R250–350 dinner-line values per person, per night, or group totals? Which meal boards/add-ons are valid for quote offers?
- Do the [M] 23 staff-quote traces correspond to the final staff-sent PDFs, and what binds each revision to its exact outbound message? Only [M] 5 match a paired ask ID; none match a paired output ID.
- Should the Mastra agent be allowed to request government/restricted plans, or must those stay staff-only? This analysis did not contact HMS to test live availability or rate authorization.
