# Guest forms, Refund Account and next HMS tools

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

Exploratory analysis on 30 October 2026. This complements
[party memory and live lookups](./2026-10-30-party-memory-and-lookups.md) and
[reservation note patterns](./2026-10-30-email-reservation-note-patterns.md).
Individual guest data, confirmation numbers and document names stay in the private
Halloween data directory, not this report.

## Guest Details: 30 different agencies

`readShallow`, `readRecord` and `readGuest` are preferred composable names for
the earlier 1a/1b/1c readers; the previous modules and result keys remain usable.
`readGuestForm` selects each currently rendered Guest Details row and reads its
form. Thirty distinct confirmations from thirty different agency display names
were selected from the E-Mail-source corpus. This intentionally diverse sample
is not representative of all stays.

- Live read-only run: **30/30 stays**, **33/33 rendered guest rows**, no failures.
  Twenty-seven stays had one guest row and three had two. Each form exposed 78
  rendered controls, including empty and checkbox controls.
- All 30 primary forms had a profile ID matching the same stay's Record View;
  the three secondary guest forms had no profile ID populated. Row selection and
  first/last-name checks matched on all 33 rows. This doesn't establish how
  profiles were selected when reservations were created.
- Fourteen of 33 guest forms had an ID number; three had a passport number.
  Six of 30 primary guest forms had a phone number where Record View's phone
  field was blank. Some form fields overlap Record View under different names.
- One primary guest's email differed between the two views; one mobile differed,
  and seven had a mobile in Record View but a blank mobile in the detailed form.
  Preserve both observations with their sources; don't assume either is newer or
  more authoritative from this comparison.
- Form capture includes rendered controls, not hidden content or unloaded grid
  pages. Sensitive ID and passport data are present in the private results; use
  only the fields a downstream task needs.

Raw batch: `/home/orca/.local/share/zero/research/halloween/guest-form-30-20261030/results-30.json`.

## Documents and linked reservations

Documents and Associated Reservations are separate readers built on shared
record-tab navigation. In six read-only checks of distinct stays, Documents
returned no files on one stay, one file on four stays and two files on one stay.
On one populated stay, the returned document name and code matched the visible
HMS listing. This checks loaded tree nodes; unloaded folders are flagged.

The six Associated Reservations grids showed zero rows, including one stay with
a populated Record View Group field and four stays from the Refund Account date
clusters below. This is not evidence that HRCEN has no linked reservations. The
reader still needs a live populated-grid example before its row extraction can be
called verified. Both modules return only loaded content, not every possible
unloaded page.

## Refund Account: later snapshots, not a booking rule

Across the 892 successful HRCEN snapshots, 30 used `Refund Account` in A/R:
23 E-Mail, four GDS, two Call Center and one Walk in. All 30 were Checked Out
with a displayed zero balance when captured. Their last update was on departure
day for seven and later for 23. These observations do **not** show when the A/R
value was set, whether a refund occurred, or what the hotel's procedure is.
All-source arrival dates ranged from 2 August to 21 October: eight arrivals in
August, 14 in September and eight in October. Across all sources, 174 snapshots
had an A/R account; `XL Nexus Travel` appeared 62 times and `Refund Account` 30
times, out of 11 distinct observed A/R display names.

For the 23 E-Mail records, arrival dates were in August (six), September (11)
and October (six), ranging from 11 August through 21 October 2026. Guarantees
were Guaranteed By Deposit (14) or Deposit Requested (nine); all used CMS `03`.
The rate plans were BAR (eight), NGOVDB (six), NCOR1B (four), NCOR2B (four) and
WSF2B (one). Twelve had no booking agency on the later snapshot; 10 had no
organization. Other combinations involved several agencies and organizations.

Outbound confirmation `To` domains among the 23, counted once per confirmation:

| Domain | Confirmations |
| --- | ---: |
| olebelotravel.co.za | 4 |
| 360travel.co.za | 4 |
| skywise.co.bw | 4 |
| gmail.com | 3 |
| focusminings.com | 1 |
| khumzi.co.za | 1 |
| mcgrath.co.za | 1 |
| contractcatering.co.za | 1 |
| travelandiafrica.com | 1 |
| cummins.com | 1 |
| mithastravel.co.za | 1 |
| sekta.co.za | 1 |

There are clusters of separate confirmations sharing dates and a domain: four
Olebelo-related stays arriving 28 September, four Skywise stays arriving
24 August, and three 360 Travel/Dischem stays arriving 5 October. They suggest
requests or travel arrangements worth investigating, but do not establish that
the PMS linked those stays or that they came from the same inbound request.

None of the 30 main notes contains the literal word `refund`. On the 23 E-Mail
records, literal note phrases include `extras direct` (14), `to agent` (15),
`to company` (five) and `settle direct` (two); counts overlap and do not prove
the accounting workflow. Treat Refund Account as a hypothesis for finance or
checkout investigation, not a new-booking default.

## XL Nexus: agency and recipient domain are different slices

Among all 892 successful records:

| Slice | E-Mail | GDS | BCOM | Travel Agent | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Primary agency is XL Nexus | 61 | 0 | 1 | 1 | 63 |
| An outbound confirmation went to `nexustravel.co.za` | 59 | 3 | 1 | 1 | 64 |

The 59 E-Mail/domain records have eight observed party combinations. All 59 had
XL Nexus as agency; 54 had XL Nexus Travel as A/R and five had blank A/R. All
had an organization, across five names: MISA 32, State Information Technology
Agency - SITA 19, Road Traffic Management Services (RTMS) four, CHIETA two and
Department of Justices two. Thus the domain is a useful party-history clue but
does not identify which organization applies.

For the five non-E-Mail/domain records, the three GDS stays used **GEMINI MOON TRADING
7 (PTY)LTD** as agency, MISA as organization and XL Nexus Travel as A/R; the
Travel Agent stay used XL Nexus, MISA and XL Nexus Travel; the BCOM stay used
XL Nexus with blank organization and A/R. All five had rate NGOVDB; the BCOM
stay was Cancelled, the Travel Agent stay Checked Out, and the GDS stays were
two In-house and one Checked Out at capture. Two further E-Mail records had
XL Nexus as agency without this domain as an outbound `To` recipient.

The current memory intentionally filters to PMS `E-Mail`, following the owner's
earlier instruction. This comparison makes a broader, source-labeled memory
worth considering: keep other sources and statuses distinguishable and let the
caller choose, rather than assume every observation was an email request. The
domain is an outbound recipient, not proof of an inbound sender.

Exact-recipient history and domain history are useful evidence, not hardcoded
rules. An exploratory retrospective found the actual later party combination in
the prior top three for 252/284 exact-address cases and 248/364 domain cases.
The eligible sets differ, and later PMS snapshots can leak future information;
neither is a live accuracy estimate. The current memory also mixes outbound
sender and recipient roles when querying addresses, so role-specific filtering
is needed before treating its output as requester history.

## Grouping, rates and tool priorities

All 892 shallow snapshots contain an Associated Reservations card, but none
captured its table or rows. This does not mean there are no links. Only one
Record View `Group` value was populated. A separate historical HRDAV Labtest
used the Associated Reservations UI to create two linked stays with separate
confirmation numbers; that is evidence of a workflow, not a universal claim
about every property or group booking.

The seven most frequent E-Mail-source rate plans covered 483/492 snapshots:
NGOVDB 204, NCOR1B 95, NGOVB 63, NCOR2B 52, BAR 45, WSF2B 13 and EDU 11.
Use this as ranking context, not a fixed selection or current rate/availability.
The most common guarantees were Deposit Requested 204, Guaranteed By Deposit
180 and Guaranteed By Agent 92, together 476/492. Room types STQN 188 and STWN
172 together covered 360/492. These are observations from later snapshots;
they do not establish booking rules or current room inventory.

For the booking form, extend the existing live party tools to select an explicit
organization and A/R candidate on the same unsaved form, then verify each field
and any dependent fields. Search, refine and selection must remain separate
agent calls: search returns current native IDs, distinguishing fields, zero vs
error and truncation; the agent combines them with request and role-labeled
memory, and chooses or asks for help when ambiguous. Agency selection already
exists; organization and A/R currently have search only.

For availability and pricing, inspect and directly verify the existing
`fetch-quote.mjs` and `hms-availability.ts` paths before designing another
reader. The existing code already models date ranges, room groups, rate options,
inventory, observation time and incomplete results. Its requested room type is
currently a label rather than an HMS filter. Live behavior and deployment
readiness must be established separately.
