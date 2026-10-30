# HRCEN contact-source history and cloud HMS tool design

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

Exploration on 30 October 2026. This extends the earlier
[party analysis](./2026-10-30-party-memory-and-lookups.md) and
[guest and next-tools report](./2026-10-30-guest-forms-refund-and-next-tools.md).
It separates existing code, directly observed cloud behavior and proposed
interfaces. Individual guest details and raw PMS responses remain in the private
Halloween directory.

## The requested history: E-Mail, Voice Call and Call Center

From 892 successful HRCEN Stay 360 snapshots out of 894 attempted confirmations,
the PMS **Source of Business** field selects 612 stays: E-Mail 492, Voice Call 56
and Call Center 64. That adds 120 observations to the old E-Mail-only slice. Each
confirmation is counted once even when it has several outbound PDFs. These are
later PMS snapshots linked to outbound confirmation letters, not a random sample,
not proof of the original inbound channel, and not a live prediction evaluation.
Statuses at capture: Checked Out 408, Cancelled 110, Reserved 53, In-house 34,
No Show 7.

| PMS source | Stays | Agency populated | Organization populated | A/R populated | None of the three | All three |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| E-Mail | 492 | 298 | 391 | 138 | 34 | 101 |
| Voice Call | 56 | 15 | 33 | 10 | 22 | 10 |
| Call Center | 64 | 37 | 28 | 2 | 5 | 1 |
| **Combined** | **612** | **350** | **452** | **150** | **61** | **112** |

In the combined cohort there are 62 observed agency names, 126 organization
names and 10 A/R account names, counted case-insensitively. This describes
display names in these snapshots, not the full live HMS catalog. All 612 show a
profile ID at capture; that does not tell us how it was chosen at booking time.

The most frequent agency display names are XL Nexus 61, Tourvest Travel Services
31, Kobo Safaris 30, Rennies Travel 18 and 360 degrees Travel 13. The most
frequent A/R names are XL Nexus Travel 57, Tourvest Travel Services 27, Refund
Account 25 and Rennies BCD Travel 17. Of the 25 Refund Account stays, 23 have
E-Mail source and two Call Center; see the prior report for why a later refund
account is not necessarily a new-booking choice.

| Agency | Organization | A/R | Stays | CMS 03 | CMS 01 | CMS 014 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| No | No | No | 61 | 40 | 21 | 0 |
| No | No | Yes | 3 | 3 | 0 | 0 |
| No | Yes | No | 180 | 172 | 7 | 1 |
| No | Yes | Yes | 18 | 18 | 0 | 0 |
| Yes | No | No | 79 | 79 | 0 | 0 |
| Yes | No | Yes | 17 | 17 | 0 | 0 |
| Yes | Yes | No | 142 | 139 | 3 | 0 |
| Yes | Yes | Yes | 112 | 108 | 0 | 4 |

CMS `03` appears on 576/612; `01` on 31; `014` on five. It differs by
source: `03` is on 475/492 E-Mail, 45/56 Voice Call and 56/64 Call Center.
This is useful ordering evidence, not a rule that every new booking uses `03`.

### Rate plans change with source

| Rate plan | E-Mail | Voice Call | Call Center | Combined |
| --- | ---: | ---: | ---: | ---: |
| NGOVDB | 204 | 5 | 6 | 215 |
| NCOR1B | 95 | 12 | 17 | 124 |
| NGOVB | 63 | 8 | 0 | 71 |
| BAR | 45 | 23 | 1 | 69 |
| NCOR2B | 52 | 3 | 4 | 59 |
| WSF2B | 13 | 0 | 31 | 44 |
| EDU | 11 | 0 | 0 | 11 |
| Other plans | 9 | 5 | 5 | 19 |

The top seven cover 593/612; BAR is the largest plan in Voice Call, while WSF2B
is largest in Call Center. Source-aware history is more useful than one global
ranking, but the sample is concentrated: all 31 Call Center WSF2B records are
28 Kobo Safaris and three Flytoride, while all 23 Voice Call BAR records have
blank agency. The source split alone cannot establish a rate rule. STQN and
STWN appear on 235 and 200 stays respectively, 435/612
combined. Guarantees are Deposit Requested 265, Guaranteed By Deposit 230 and
Guaranteed By Agent 101, plus 16 others. Even NGOVDB spans 86 Deposit Requested,
81 Guaranteed By Deposit, 42 Guaranteed By Agent and six others: a rate does not
determine the guarantee in these observations.

### XL Nexus and contact ambiguity

There are 59 confirmations in the filtered cohort with an outbound `To`
recipient at `nexustravel.co.za`. All 59 have PMS source E-Mail; the two added
sources contribute none to this particular example. All 59 show XL Nexus as
agency; 54 show XL Nexus Travel as A/R and five have blank A/R. Organizations
vary: MISA 32, SITA 19, RTMS four, CHIETA two and Department of Justices two.
There are eight observed agency/organization/A-R combinations. The agency field
itself says XL Nexus on 61 of the 612, all with E-Mail source. The earlier three
GDS/domain records are excluded by the new scope.

Across the 612 cohort, 131 distinct outbound `To` addresses occur on at least
two linked confirmations; 33 of those 131 have multiple three-field party
combinations. For domains, 74 occur on at least two confirmations and 25 of
those 74 have multiple combinations. At five or more confirmations the figures
are 17/32 addresses and 20/27 domains; these have different denominators, so do
not interpret them as an accuracy comparison. Repeated addresses can still act
for different organizations. Outbound recipients are not established inbound
senders, and upstream PDF-to-confirmation linkage can include inferred evidence.

The combined counts and contact ambiguity aggregates are private:
`/home/orca/.local/share/zero/research/halloween/analysis/source-business-email-voice-callcenter-20261030.json`
and `source-business-contact-ambiguity-20261030.json` in that directory.

## Existing work: cloud modules versus the older stack

These modules are local work in this worktree, not a deployed staff-facing
product. Most are currently untracked. Previous interfaces remain available.

| Module | What exists and was exercised | Important limit |
| --- | --- | --- |
| `centurion-stay360.mjs` | New cloud login and a reusable page/browser lifecycle. | A new-booking form can be opened directly; it does not require looking up an existing confirmation. |
| `hms-readers.mjs`: `readShallow`, `readRecord` | Find/open an existing stay; shallow lookup handles ambiguity with options. | Historical record values do not equal booking-time values. |
| `readGuest`, `readGuestForm` | Guest list, then the detailed form for each loaded guest row. | A 30-stay live run covered 33 loaded forms, not all possible unloaded pages. |
| `readDocuments` | Separate Documents-tab reader. | Tested on six stays; loaded content only. |
| `readAssociatedReservations` | Separate linked-reservations-tab reader. | Still needs a populated HRCEN example with another linked stay to verify extraction. |
| `hms-party-search.mjs` | New cloud searches for agency, organization and A/R; explicit agency selection on an unsaved new form. | Name-only search and a curated result subset; no organization or A/R selection yet. |
| `hms-party-session.mjs` | Same-page JSONL runner can repeat searches and call memory. | Not an LLM agent, product UI or automatic workflow. |
| `hms-booking-memory.mjs` | Query prior observed combinations by name, exact email or domain. | Currently **E-Mail only**; no continuous staff-correction learning, and address queries mix sender/recipient roles. |

Correction to the earlier report: the guest reader now **does** use the shared
`openStay360RecordTab` helper, as do Documents and Associated Reservations.
Those readers remain separate modules.

The confusingly named older `party-lookup.mjs` is separate from the new cloud
`hms-party-search.mjs`. The older availability stack is also separate:
`fetch-quote.mjs` was adapted for Centurion cloud on 29 October, so it is not
exclusively a local-SaaS implementation, but its live correctness and design
for this new workflow were not established here. Its current
`hms-availability.ts` wrapper sends a broad room-type request without party
context; that statement describes the wrapper, not every capability in the
lower-level script. Treat old code as a source of clues, and design the new
interface against the live cloud screen.

The 612-source filter above was applied to analysis. The existing memory code
still has its original E-Mail-only filter; it was not silently expanded during
this design investigation.

## Cloud booking lookups: what the UI actually offers

On a blank new Guest Stay in the cloud, read-only searches returned two agency
matches for `XL Nexus`, three organizations for `Justice`, and one A/R match for
`XL Nexus`. The agency match list included XL Nexus and XL Nexus Travel ATNS;
names alone do not establish the correct one. A prior live check selected XL
Nexus explicitly by its current native ID, read the agency field back and did
not save the booking. The UI sent a server request during that unsaved selection;
`OK` in a picker must not be described as a purely local action.

The live filter selector offers more than the new code currently exposes:

| Field | Examples of available search filters |
| --- | --- |
| Primary Booking Agency | Name, city, address, country, contact, phone, IATA/reference number, ID, internal reference |
| Organization | Name, city, address, country, contact, corporate account number, organization ID, parent company |
| A/R Account | Name, account number, status, standing, account type, city, address, contact |

The grid visibly includes identifying and contact details; the new reader drops
some, such as the Peppol GLN column. Additional data is present in the received
row/store but was not necessarily displayed as a grid column: examples include
organization parent and sales manager, and A/R billing requirements, balance
and credit limit. Preserve relevant available information and label its source;
handle sensitive financial/identity fields according to the task and privacy
boundaries. The filter options were inspected; every possible filter/operator
combination was not tested.

## Proposed agent loop: small field-named tools, flexible order

Give the agent one authenticated, property-scoped browser session, with readable
tools rather than a monolithic reservation workflow:

1. Query history for supplied requester/name/address and requested source
   labels, keeping inbound-sender, outbound-`To`, `Cc` and `Bcc` evidence
   distinct. The existing corpus only establishes outbound roles. Retain the
   observation time, link provenance, source, historical status, conflicting
   observations and whether a value is blank or missing. Record staff-verified
   corrections separately from agent guesses. Existing snapshots contain party
   display names, not reliable live native IDs; resolve them in HMS.
2. `searchPrimaryBookingAgency`, `searchOrganization` or `searchArAccount`:
   start with a simple name query; return the applied query, live candidate IDs,
   useful visible/details fields, result counts, completeness (`hasMore` or
   unknown), and an honest no-match versus execution failure. Search again with
   variants as needed. The other observed filter fields can be exposed later if
   they prove useful, without discarding them from the discovery notes.
3. `selectPrimaryBookingAgency`, `selectOrganization` or `selectArAccount`:
   accept a specific ID from a current, verified result, click that record and
   the picker OK, then read back the chosen field and any changed/dependent
   fields. If the result is stale, refresh or return an explicit stale result.
   The existing code implements only the agency action, and reads back that
   field; generic dependent-field diffing is still proposed.
4. `closeLookup` closes a picker without choosing; it is not cancellation of a
   reservation. If nothing fits, preserve what was tried and leave that field
   unresolved for staff while continuing other useful work.

Tool calls can be sequenced by the agent in any sensible order; actual page and
picker state are prerequisites. A small shared lookup helper can implement the
common mechanics while exposing clear field-specific names. Add a search-revision
token only if needed to prevent stale selection; avoid a large generic framework.

For staff, show a recommendation, why it was proposed, and the live alternative
records with distinguishing details. An XL Nexus domain might suggest XL Nexus
and XL Nexus Travel but cannot choose MISA versus SITA without more evidence.
Do not silently turn frequencies into hotel policy or uncalibrated confidence.
Picker OK populates an **unsaved** form; saving a real reservation is a separate
action subject to current product authority.

For experiments, a private structured JSON/JSONL store is sufficient. A
database becomes useful for concurrent writers, durable staff corrections and
larger indexed history; it should retain the same observation provenance. The
owner-requested cohort is E-Mail, Voice Call and Call Center; enable those as
source-labeled memory inputs when memory is expanded, keeping source selectable
at query time rather than conflating the three.

## Client direction: use Hotel Availability for quotes

The owner relayed the hotel's instruction: **use Hotel Availability for
quotes** because it considers children and quotes the correct rate; the hotel
said the "room type and availability screen" is not the correct quoting
screen. A fresh read-only look at Hotel Availability's Guests control showed
separate Adults and Children count inputs. Setting one child revealed an
`Age of Child 1` control. Preserve the supplied child ages along with the counts;
how ages affect rates and how they relate to the booking form's child categories
remain to be checked. We have not established whether the
client's phrase refers to the menu's `Room Type and Rate Availability` screen,
Guest Stay's Rate Shop, or both. The client made the positive quoting choice
clear regardless: Hotel Availability.

Rate Shop may still matter when applying a room/rate to an unsaved booking;
that action remains unverified and should not be used as the quote source
without further evidence.

### Quote and confirmation/pro-forma paths

A request can be priced from Hotel Availability without saving a Guest Stay,
then answered with a separate quote. A reservation-based flow can instead use a
Guest Stay and the CMS correspondence controls. These paths can overlap in
purpose: in the three-day PDF audit (source report retained in the local research checkout),
355 of 432 selected PDF records had both a tentative-confirmation heading and a
pro-forma banner; records include repeats and are not 432 distinct requests.
The 1,880-record dataset was selected by the outbound confirmation-letter filename,
so it cannot by itself measure what proportion of all enquiries receive either
type of quote. A PDF heading does not establish a current booking status or hold.

In a prior [HRDAV live lookup](../../2026-10-28-hrdav-cms-message-id-codes.md),
CMS code `03` was labeled a booking confirmation for an agency or organization
with payment link and pro-forma; the owner reported the same codes in Centurion
screenshots. Message ID, CMS Booker Email and CMS Send Mail are separate fields.
The corpus does not prove which action caused each letter to be sent, or its
delivery or timing. The current product specification puts quoting before a
staff-approved create, but observed hotel workflows may vary.

## New Guest Stay: room picker versus Rate Shop

Further read-only exploration on 30 October after the owner questioned whether
price and availability already come together. On a blank, unsaved Guest Stay:

- The **Room Type** field's lookup opened a simple single-selection Room Types
  list. It displayed room code/name, unit type, minimum and maximum adults,
  maximum children and bed type. It did not show a dated price grid.
- The **Rate Plan** field's lookup opened **Rate Shop**, a larger screen with
  a Room Rates grid and a Stay Summary. Its inputs included Dates, Nights,
  Guests, Sales Strategy, Group, Currency, Room Type Categories, Room Types,
  Organization, Primary Booking Agency, Rate Plans, Promotion, Room Type for
  Charge, Reservation Template, Show Restricted Sell Options and Flexible Dates.
  It also showed Rate Details and Auto Transfer Rules links, and an Update Stay
  button. The Stay Summary showed labels for average daily rate, total rate,
  add-ons, taxes and total price for stay; these were blank before selection.
- In Rate Shop, selecting room types STQN and STWN and rate plans BAR and BARRO
  as search filters, then clicking Search, returned a grid for 30–31 October
  2026 and one adult. The grid displayed room-type counts 24 and 46 and dated
  amounts ZAR 1,940 for BAR and ZAR 1,750 for BARRO for each room type. The
  response reported those four cells available and unrestricted, and included
  Bed & Breakfast / Room Only bundle labels. These are time-specific results,
  not a current quote. Price-cell selection, Stay Summary calculation, Rate
  Details, Update Stay, applying the choice to the draft and Save were **not**
  exercised.
- The Rate Shop room-type filter showed 10/10 options, including `ZPUB` / `zPublic
  Area`; the standalone Hotel Availability picker previously showed nine. Its
  actual purpose and bookability are unknown. The Rate Shop rate-plan picker
  showed columns including market segment, minimum LOS, non-room bundle and
  meal plan. Preserve such discovered details rather than assuming the two
  screens or their picker catalogs are identical.

The earlier Hotel Availability example used two adults and Show Restricted Sell
Options was selected; the Rate Shop example above used one adult with that
option unselected. Differences between their displayed prices cannot be
attributed to screen or occupancy from these two separate runs.

Private captures:
`/home/orca/.local/share/zero/research/halloween/memory-experiments/live-ui/cloud-guest-stay-room-rate-20261030.private.json`
and
`/home/orca/.local/share/zero/research/halloween/memory-experiments/live-ui/cloud-guest-rate-shop-search-20261030.private.json`.
Their accompanying `.png` files show the blank form, the pickers and the grid.
No reservation was saved or guest edited.

The owner prefers a simple query input, comprehensive useful results with source
and loaded/total metadata, and another narrower query when results are broad;
do not automatically paginate the whole catalog for every search. The owner
deprioritized Associated Reservations verification and wants a clear separate
folder for the new cloud tools. Worktree delegation remains a future discussion,
not an action taken in this exploration.

## Cloud Hotel Availability: directly observed

A fresh headless, read-only cloud probe opened **Front Desk → Availability →
Hotel Availability**. The screen has property, dates, nights, guests, sales
strategy, group, currency, room types, rate plans, organization, booking agency
and a Show Restricted Sell Options control. Room types and rate plans each open
a multi-checkbox picker. At HRCEN, the room picker loaded 9/9 options; the rate
picker loaded the first 50 of 95, so a complete selector must handle paging or
refine the search. All nine room-type codes in that picker appeared in the 612
historical snapshots. The snapshots contain 15 distinct rate-plan codes versus
95 records shown by the rate picker; picker membership does not establish that a
rate is available or eligible for any particular stay.

For one night, 30–31 October 2026, two adults, the probe checked STQN and STWN
and BAR and BARRO. The screen read back `STQN,STWN` and `BAR,BARRO`; Search
returned HTTP 200 and a grid with both room types and both rates. The UI showed
room-type counts of 24 and 46 for that date, and nightly prices of ZAR 2,140
and ZAR 1,930 respectively for BAR and BARRO in both room types. The response
included `israteavailable: true`, meal-bundle labels and restriction-related
fields for these cells. These are time-specific observations, not a quote or
guaranteed remaining inventory. We have not established all tax/policy semantics,
every restriction type, or behavior across multiple nights and pages.

The selected-checkbox state was independent of the grid's highlighted-row
selection: two boxes were checked while the Ext selection model reported only
one highlighted row. Verify applied inputs, not just highlighted row count.
Raw screenshot and response are private at
`/home/orca/.local/share/zero/research/halloween/memory-experiments/live-ui/cloud-availability-multi-search-20261030.private.json`
and its `.results.png` companion. The other availability screens in the menu
were not inspected and should not be assumed identical.

A further read-only comparison repeated a search with two adults, first with no
children and then with one child. Adding the child revealed an `Age of Child 1`
input, which was left blank in this probe. The displayed rates and room counts
were the same in that single example; this does not establish how child ages
affect pricing. The comparison and its screenshots are private at
`/home/orca/.local/share/zero/research/halloween/memory-experiments/live-ui/cloud-hotel-availability-child-compare-20261030.private.json`
and the accompanying `.guests.png` and `.result.png` files.

### Guest Stay toolbar, draft preservation and a child-inclusive search

Another read-only probe opened Hotel Availability using its **Guest Stay
toolbar icon**. It appeared in an overlay above the unsaved form. The draft had
30 October–1 November, two nights and one adult; the overlay initially showed
30 October–13 November, 14 nights and two adults. After three searches and
closing the overlay, the draft still had its original dates and adult count, its
confirmation was blank, and room type and rate plan were still blank. There was
no obvious transfer button; selecting a grid rate and any possible transfer to
the draft were not tested. Set and verify quote criteria explicitly rather than
assuming this window copied the draft. The Front Desk menu was not exercised
from the draft in this probe.

For 30–31 October and two adults, paired filtered searches used STQN and STWN
and BAR and BARRO; the actual requests differed only in child count and ages.
With no children, BAR was ZAR 2,140 and BARRO ZAR 1,930 for both rooms; with an
eight-year-old, BAR remained ZAR 2,140 and BARRO was ZAR 2,020. All four cells
were marked available and unrestricted in each search. The child's age was
selected and read back in the request. These are one-night observations, not
general rules about child pricing.

With the same eight-year-old criteria and both room and rate filters blank,
Search returned an empty body and an unavailable message. Selecting STQN/STWN
and BAR/BARRO instead returned four rate cells. The two requests differed only
in the room and rate codes, so blank filters did not mean all options in this
Preset search. A full-catalog search was not measured. From clicking Search to
receiving the response body, the blank, child-filtered and zero-child filtered
requests took 0.71 s, 3.10 s and 1.78 s respectively; these times exclude picker
entry and grid rendering. The private evidence is
`/home/orca/.local/share/zero/research/halloween/memory-experiments/live-ui/cloud-guest-draft-nav-wide-narrow-20261030.private.json`.

### Proposed availability tool

`searchHotelAvailability` should take the property, arrival/departure, adults,
children and supplied child ages,
optional lists of room types and rate plans, and optional agency, organization,
group, currency, strategy and restriction choices where supported. Return the
applied criteria, observation time, dates, property/room-type counts, room and
rate identifiers and names, nightly prices/currency, available/restricted
indicators and useful extra details the UI/response actually provides, while
clearly distinguishing empty, incomplete and failed results. Keep the original
useful details rather than collapse the grid into a single cheapest price.

The owner suggested collecting a broad result once, keeping it privately for
later, and applying deterministic output filters so the agent receives only the
subset it requests. Separate what HMS actually fetched from the subset returned
to the agent, with criteria, capture time and coverage attached to the snapshot.
Test the actual cost and completeness of fetching a broad set before deciding on
the default; blank pickers are not a proven all-options shortcut.

This screen showed one Guests control; multiple distinct occupancies and room
quantities may require separate searches and were not verified. Do not confuse
room-type count, number of requested rooms and associated confirmations. We have
not validated the entire picker catalog, pagination, price inclusion, all
restrictions, multi-night date columns or party-context effects. A UI result is
time-sensitive and can change before booking.

## Suggested next implementation slice

For the new-booking flow, first return useful loaded lookup details and add
**organization selection** with readback, keeping the initial search input
simple; then apply the same mechanics to
A/R selection and broaden agency selection readback. Organization appeared on
452/612 stays, and its cloud search already exists. This proves the reusable
search/refine/select loop on another field without a big framework.

For the quoting flow, build the new Hotel Availability reader from the live
screen with multiple room/rate filters and optional party context; it can run
without opening a reservation. The owner can choose which lane to start with.
Guest-profile selection, booking saves, staff UI and automatic learning remain
later work. No guest booking or saved reservation was created or edited during
this investigation.
