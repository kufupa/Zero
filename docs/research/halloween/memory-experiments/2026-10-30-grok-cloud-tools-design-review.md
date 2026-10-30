# Grok review: cloud HMS agent tools

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

30 October 2026. The owner requested an independent critical review of the
lookup and availability design in
[the source-cohort and cloud-tool report](./2026-10-30-source-cohort-and-cloud-tool-design.md).

Grok Build completed one `grok-4.7` call with `xhigh` configured, using a
sanitized design brief plus the exact, line-numbered `hms-party-search.mjs`
source. It did not inspect the live HMS, other repository files or the private
guest corpus. The CLI reported $0.220106 for the call. The input brief is at
`/home/orca/.local/share/zero/research/halloween/memory-experiments/grok-review-20261030/review-brief.md`
(SHA-256 `5f2020d552a97e4e004f9e1f545a7e387aa5c8fffbc01cd63e27096933a1422f`).
The unedited final response is reproduced below; its example and recommendations
are not all correct.

## Assessment

Grok agrees with the broad split: deterministic, composable browser actions;
an agent that searches and judges; history as evidence; staff review; HMS as
the system of record. Its most useful challenges are:

| Finding | Assessment | Lean response |
| --- | --- | --- |
| Empty search can have uncertain coverage | Code-confirmed: `outcome: no_match` is chosen from an empty grid even if `possiblyTruncated` is true. A previous real zero-result probe did have `serverMoreRecords: false`; no false negative was observed. | Report verified empty separately from incomplete/unknown coverage. |
| Literal name-substring validation can discard a current server result | Code-confirmed conditional: a candidate whose returned name lacks the exact substring triggers `execution_failure`. We have not shown the live HMS returning such a match. | Check the operator and matching behavior; don't discard valid current results, while retaining response/grid verification. |
| After OK, only the agency name is read back | Code-confirmed. Other fields changing is not yet observed. Failure after the click can mean the form changed even though the tool reports `execution_failure`. | Read the draft and relevant dependent fields; distinguish an unconfirmed post-click outcome from a confirmed failure before retrying. |
| Moving between screens or picker types can disturb state | Code closes an earlier lookup and can click New Record when the form is not visible. Actual draft loss or discard prompts have not been demonstrated. | Make current page/modal and transitions explicit; probe draft preservation. Report automatic picker closure, or expose an explicit close where useful. |
| Guest Stay and Hotel Availability are separate surfaces | Observed. It is not proven that their agency/organization pickers or applied context behave identically. | Verify party context on the availability surface itself. |
| Availability cells need interpretation | Observed single-night grid, not a proven end-to-end quote. Taxes, policy, multi-night restrictions and exact inventory-count semantics remain open. | Probe those while building; return applied inputs and raw meaningful grid details, and don't label unverified totals or eligibility as established. |
| Historical memory may confuse sender/recipient and snapshot vs initial booking | Confirmed limitation. Display names are not current live IDs. | Separate address roles, preserve source/time/status and resolve candidates in current HMS. |

Grok also recommended several things we should **not** adopt as stated:

- Its example claims an inbound `sita.co.za` query would return 19 observations.
  The data supplied to Grok instead says 19 observations have **SITA as the
  organization** among the 59 outbound `nexustravel.co.za` recipient-domain
  records. No such `sita.co.za` inbound result was established.
- The owner requested expanding memory to E-Mail, Voice Call and Call Center.
  Add source labels and correct address-role filtering together; do not defer
  the requested sources indefinitely.
- The owner wants the agent to suggest and prefill an unsaved draft for staff to
  review and swap. A mandatory staff click on every individual selection is not
  a demonstrated product requirement. Actual reservation writes still follow
  the repository's current authorization and human-review rules. The observed
  unsaved agency action made a server request; its full side effects remain to
  be verified before broader use.
- Keep useful HMS candidate fields and support relevant live filters; do not
  retain the current narrow allowlist merely because three sample results may
  differ on existing fields. Data sent to an agent or staff still needs
  appropriate sensitivity handling. Refinement can avoid fetching every page,
  but an incomplete 50-of-95 list must not be represented as the whole catalog.
- A single unchanged availability result with and without party context would
  not prove context irrelevant. Check whether criteria can be applied and test
  relevant negotiated examples before drawing a conclusion.
- Grok suggests preserving an earlier search token after a failed refinement.
  Since a failed refinement may leave an in-flight request or changed filter,
  the simplest safe behavior is to invalidate it and re-search unless the
  current state can be fully reverified.
- `ff_confirmationnumber` is used by the code while waiting for the Guest Stay
  search/list screen; `confirmationnumber` is read on the new form. They are not
  established as two equivalent draft confirmation fields.

## Practical next slice

Keep the field-named search/select API and one shared implementation. First make
coverage, current search identity, and post-selection readback honest. In
parallel with implementation, use small cloud read probes to compare party
context, multi-night pricing and room counts. Organization and A/R selection
can then use the same pattern; the quote tool should use the availability
screen's own verified context. Avoid a generic framework or speculative test
suite. This is a design recommendation, not a completed implementation.

## Unedited Grok final response

**Verdict: keep the split. Current party module is the right kernel, and it can already lie. Do not ship a quote tool or a memory ranker yet.**

No live HMS check in this review. Tags: **Obs** = prompt or attached source. **Inf** = follows from those. **Unk** = needs a short UI probe.

Loop shape is right: one property-scoped page, deterministic Playwright modules, agent judges candidates, memory is evidence, staff picks, Infor stays the system of record. Cut the extra machinery. Quote-first does not mean build `searchHotelAvailability` next. Hotel Availability is a different surface from Guest Stay. A quote from the wrong surface, or from an unverified price cell, is the failure that reaches a guest.

## 1. Ranked findings

| # | Finding | Failure case | Lean fix | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Availability proposal lists the right screen fields. It does not yet know what a cell means. | Staff gets a one-night rack cell, told it is the stay price, while the rate checkbox was never the row highlight. Restricted sell looks like "sold out," or a restricted price looks bookable. | Read-only probes below. Tool must echo applied codes from the request/response. Mismatch returns `criteria_mismatch` and no quote. Leave totals, tax, and "rooms left" unlabeled until probed. | **Obs** fields, one-night 4 cells, checkbox ≠ highlight, catalog 50/95 ≠ eligibility. **Unk** party effect, multi-night, tax, count meaning. |
| 2 | Party code is bound to a new Guest Stay (`ta1`, New Record). Availability has its own agency/org fields and can run without a reservation. | Agent selects XL Nexus on Guest Stay, then searches availability on a clean availability screen. Quote has no party. Guest gets rack rate for what staff think is a contract. | Keep two surfaces. Do not open Guest Stay to produce a quote. Probe whether the availability LOV is the same window before sharing a parser. | **Obs** code lines 39–59, 74–75; availability works without a new reservation. **Unk** shared LOV / shared form state. |
| 3 | Search reports a confident empty when it is not sure, and hides real rows. | Memory name `Department of Justices`. HMS returns `Department of Justice` or a spaced variant. Lines 200–203 throw, catch returns `candidates: []`. Staff hears "lookup failed" or, on a true empty with a missing more-flag, "no such org." | `no_match` only if the more-flag is `-` and loaded &lt; 50. Else `incomplete` or `unverified_empty`, with rows attached when the grid matches the response. Drop the name-substring gate. | **Obs** lines 200–214. Live `+`/`-` values **Unk**. Substring reject is code-certain; how often HMS does it is **Unk**. |
| 4 | Memory will pick the wrong party if anything treats a display name as the choice. | Inbound From `sita.co.za`. Matcher hits outbound From and To together. 19 SITA rows sit inside 59 Nexus-domain mails; 33/131 repeated To addresses have more than one agency/org/A/R combo; 110/612 were cancelled at capture. Mode becomes "the agency." Native id is not in memory. | Require `matchOn` + direction. Return top combos with counts, cancelled separate, cohort label `E-Mail` (what the code actually is). No winner, no id, no select from memory. | **Obs** corpus counts and current matcher. Predictive value **Unk** — prompt already says these are later snapshots. |
| 5 | Select proves the display name, then forgets the draft. | OK fires the known server request. Form shows XL Nexus, so lines 270–275 pass. Org, A/R, or confirmation number changed, or a dialog is up. Tool returns only `displayedAgency`. Next search hits lines 58–59 and dies with `NOT_A_NEW_GUEST_STAY` if confirmation filled. | After OK, read property, both confirmation inputs, agency, org, A/R, visible dialog. Success is `selected_unsaved` plus that draft. Select stays lab-only until that request is identified. | **Obs** name readback; unsaved select can hit the server. Durable write, confirmation fill, dependent fill: **Unk**. |
| 6 | Search silently cancels the other picker and can click New Record. | Agent has a blank stay with dates filled, opens availability, then searches an agency. `ta1` is not visible, so lines 47–59 click New Record and wipe the draft. Or agency results are still open, org search hits Cancel, and a discard prompt stalls the page. | If another modal is open, return `other_lookup_open`. Do not Cancel inside search. `openNewGuestStay` must refuse when a draft is already open. `closeLookup` is the only cancel. | **Obs** lines 47–77. Whether New Record prompts or discards: **Unk**. |

Same small patch as finding 3, no new framework:

- Lines 157–163 delete `lastSearch` before the new search succeeds, including on a bad argument. A failed refine must keep the old token if the grid signature is unchanged.
- Lines 196–198 treat any visible page text matching that error as this search's failure. Scope it to this run.
- Lines 55 and 58 use different confirmation input names. Read both.
- `possiblyTruncated` is true whenever loaded ≥ 50, even if the server says `-`. Keep that caution. Put it in `coverage`, not in a soft flag the agent can ignore.
- Failure returns must include `modalStillOpen` and a draft snapshot whenever OK or New Record may have run.

## 2. Minimal contract

One page. One property. One modal. One in-flight UI call. `lookup_in_progress` means retry the same call. It does not mean "no such agency."

Public tools stay field-named. Internals stay one `searchParty` / one `selectParty`. No lookup service, no searchRef database.

**Search** `searchPrimaryBookingAgency({ value })`, same for organization and A/R.

- Input is a name string. Extra filter fields wait until a live collision needs them and the operator has been read.
- Return: `generation`, `filterField`, `operator` (`null` until read), `coverage: complete | truncated | unknown`, `outcome: matches | no_match | incomplete | unverified_empty | execution_failure | input_gap`, `candidates[]` with native id plus the current allowlist, `property`.
- `no_match` only when coverage is `complete` and the verified grid is empty.
- Truncated results may still be selected by id. Wording must say the list is incomplete.
- Do not auto-select a unique name.

**Select** `selectPrimaryBookingAgency({ nativeId, generation })`. Organization select is the same shape, next slice. A/R select waits.

- Generation must match the open window and grid signature. Else `stale_search`, no click.
- Click that id, confirm the selection model, OK, then `readBookingDraft()`.
- Return `selected_unsaved` and the draft. This is not Save.
- Agent calls select only after a staff choice, or with an explicit lab flag.

**closeLookup()** cancels the picker only. **readBookingDraft()** returns property, both confirmation fields, agency, org, A/R, active modal, visible alert. Unresolved means the HMS field was left untouched, and the tried queries stay in the trace.

**Availability**, after probes, separate tool: property, arrival, departure, occupancy the screen actually has, optional room codes, optional rate codes. Echo applied criteria, timestamp, coverage, per-cell amount with `amountKind: unverified`. `total` stays null. Optional agency/org only if probe 1 shows the availability screen itself took them. `roomCount > 1` is `input_gap` until the UI shows a quantity control.

Quote policy, not a workflow engine: a price recommendation must come from an availability result whose applied criteria match the request. If party context was not applied, say `partyContext: unset`.

### Agent example

Inbound domain `sita.co.za`, HRCEN, one night, one adult. Memory query is `domain` + `outbound_to` only. Evidence comes back 19 rows, display name SITA on org, XL Nexus on agency, cancelled split out, cohort `E-Mail`, no native id. That is a hint.

Live org search `SITA`. Coverage `complete`, three or fewer rows, cities differ: recommend one, list the others, stop. Coverage `truncated`: recommend only an exact row that is actually present, and say the list is incomplete. Do not call select. Staff picks. Lab runner then `selectOrganization({ nativeId, generation })`. Draft comes back with org, and with whatever agency/A/R the form now shows. Availability search runs on Hotel Availability, not through Guest Stay. Recommendation carries alternatives, coverage, and `doNotSave: true`.

## 3. Memory: now vs later

| Now | Later |
| --- | --- |
| Split outbound To from outbound From. Label cohort `E-Mail`. Split cancelled counts. Return distributions. | Add Voice Call and Call Center only after those labels exist, so counts stay comparable. |
| Live search supplies the only selectable id. | Staff-decision JSONL: suggestion, alternatives, staff choice, live native ids, evidence row ids. |
| Keep the 59-row Nexus/SITA counts as evidence the agent can read. | No learned ranker, no offline id backfill, no database. |

Matcher fix is a query change. It is not the next UI build. Expanding the 612 cohort before the split makes a bad matcher louder.

## 4. Proof steps

Read-only on the real cloud, except step 4.

1. Hotel Availability, same dates, same two room types and two rate codes. Run with party empty, then agency set, then agency+org, using the availability screen's own fields. Diff applied request and the four cells. Also record whether that LOV is the Guest Stay "Booking Agencies" window.
2. Check two rate codes without highlighting those rows. Highlight two other rows without checking them. Run. Compare the payload with the checkboxes.
3. Same room and rate, one night vs two nights. Record whether amounts are per night, a total, or include tax, and whether restriction flags differ by night. Save field names only.
4. Lab blank Guest Stay only: agency OK, do not Save. Read both confirmation inputs, org, A/R, dialogs, and the request URL/status. Stop if this looks like a durable write.
5. While already in the party picker: read the operator for a name search; list visible columns vs the allowlist; confirm the three Justice rows differ on fields the tool already returns.

## 5. Next build order

1. Probes 1–3 and 5. Manual is enough. No new tool surface.
2. Honesty patch in the existing party module: outcomes, token lifetime, drop substring gate, explicit close, draft read, no silent Cancel, no surprise New Record, echo property.
3. Probe 4, lab only.
4. `selectOrganization` as a kind on the same select path, plus draft readback. This is the search/select lesson, on the prefill surface.
5. `searchHotelAvailability` v1 only after probes 1–3. It must refuse a quote on criteria mismatch. It sets party only on the availability surface, and only if probe 1 showed a difference.

Tradeoff: organization select teaches the pattern and serves prefill. It does not make quotes true. An availability tool built first matches quote-first and can mis-price. Extra agency filters are the wrong slice: XL Nexus vs XL Nexus Travel ATNS already splits on name.

## 6. Cut

Leave `hms-availability.ts`, `fetch-quote.mjs`, and `party-lookup.mjs` unused as the new engine. No pagination loop, filter algebra, generic form-diff, searchRef store, learning loop, SOB expansion, XL Nexus special case, staff UI, or local Ext unit-test pack. Raw GRIDDATA stays in the operator proof log. Agent results keep the current allowlist. Add a column only if probe 5 shows the three Justice rows are identical on it.

**Decision:** if lab OK is off the table this week, stop after the honesty patch. Searches and availability probes stay available.
