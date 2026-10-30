# HRCEN party memory and live lookups

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

Working notes for a reusable building block, not a production integration. The owner asked for agent-queryable history and fast HMS tools, using the real UI and keeping guest data private.

## What exists

- `apps/server-pilot/tooling/playwright-quote/hms-booking-memory.mjs` builds and queries a property-scoped process-local memory from the existing PMS JSON and outbound-PDF JSONL. As directed on 30 October, it includes only reservations whose Record View Source of Business is `E-Mail`; other or unknown sources are excluded. Queries can use a name, exact email or domain; results include observed party combinations and support. Optional detail includes underlying evidence. It does not require copying the 57 MiB source into Git.
- `apps/server-pilot/tooling/playwright-quote/hms-party-search.mjs` exports `openNewGuestStay`, `searchBookingAgencies`, `searchOrganizations`, `searchArAccounts` and `selectBookingAgency`. Each takes an authenticated Playwright page; calls can be sequenced on the same page. Search leaves the lookup open for refinement. Selection requires an explicit native ID from the last successful agency search and changes only the open, unsaved form.
- `apps/server-pilot/tooling/playwright-quote/hms-party-session.mjs --jsonl` exposes memory and lookup calls in a single headless HRCEN session. A caller chooses each next call; no LLM is wired up and there is no hardcoded matching workflow.

Example input lines, sent to the same running session:

```jsonl
{"id":"1","tool":"memory","query":{"name":"XL Nexus"},"options":{"limit":3}}
{"id":"2","tool":"agency","query":"Nexus"}
{"id":"3","tool":"agency","query":"XL Nexus"}
{"id":"4","tool":"selectAgency","nativeId":"<chosen live nativeId>"}
{"id":"5","tool":"organization","query":"Department of Justice"}
{"id":"6","tool":"arAccount","query":"XL Nexus"}
{"id":"7","tool":"quit"}
```

Start from the repository root with `node apps/server-pilot/tooling/playwright-quote/hms-party-session.mjs --jsonl`. It prints a `ready` event after login and opening the form, followed by one JSON response per line. Replace `<chosen live nativeId>` with a candidate ID from the immediately preceding agency search, after inspecting its details. Email/domain queries use `{"email":"..."}` or `{"domain":"..."}`; `{"includeEvidence":true,"evidenceLimit":2}` in `options` requests underlying records. Responses can contain personal and business information: capture them only in a private location.

Name searches cover agency, booking-agency contract, organization and A/R fields; each result says which fields matched. `null` means a field was not observed and `""` means it was observed blank. Each combination also has a `choiceStatus`: a populated choice, all party fields observed blank, or no choice observed with some information missing. The response separately counts confirmations with no recorded choice and those with an all-blank observation. `unresolvedConfirmationCount` means no party field was observed at all, so a known blank is not counted as unresolved. Confirmation support is deduplicated across repeated PDFs.

The default source directory is `/home/orca/.local/share/zero/research/halloween/raw-data/`; `HMS_MEMORY_DATA_DIR` can point to a directory containing the same named inputs. No database migration is needed. The memory is rebuilt in process on startup; it does not yet automatically learn staff decisions or synchronize concurrent writers. Its builder accepts additional parsed snapshots, scoped to a supplied property and the `E-Mail` source filter. A later incremental store should retain the property, observation and confirmation IDs, source, time, observed values and address role, deduplicating repeated observations; callers must partition inputs when the source does not declare its property.

## Direct observations on 30 October 2026

The saved source contains 892 successful HRCEN confirmation reads out of 894 candidates; 492 have Source of Business E-Mail and enter memory. The other 400 successful reads are excluded from memory but remain in the original source. The filtered memory links 1,061 of the outbound PDF records; remaining records include out-of-scope reservations and should not all be interpreted as failed links. These are later PMS snapshots linked to outbound confirmation PDFs, not a representative set of all inbound requests. Outbound sender/recipient roles are labeled explicitly; neither proves who initiated an inbound request.

Across all 892 snapshots, 596 have a booking agency, 548 an organization and 174 an A/R account; 71 have all four tracked party fields observed blank. XL Nexus appears on 63: 61 have an organization, spanning six distinct organization names, and 57 have an A/R account. Its guarantee types also vary: 46 Guaranteed By Agent, 13 Deposit Requested and 4 Confirmation Received. These patterns support suggestions, not fixed mapping rules.

The populated party fields contain 79 distinct agency, 153 organization and 11 A/R display names, counted case-insensitively. All 892 saved reservations have a profile ID, with 779 distinct IDs; that establishes a profile was present at capture time, not how it was selected on a new booking. Among the 492 E-Mail-source reservations, 34 have none of agency, organization or A/R populated and 101 have all three. CMS message ID is `03` for 475 of 492, and the five most frequent rate plans cover 459 of 492. These are observed historical frequencies, not the complete set of hotel options or proof of current availability.

Within the E-Mail-only slice, agency, organization and A/R are populated on 298, 391 and 138 reservations, respectively; there are 59, 106 and 10 distinct case-insensitive display names. Memory groups these into 166 party combinations, 79 observed once. The most common rate, `NGOVDB`, has 204 records but several guarantee types: Deposit Requested 82, Guaranteed By Deposit 74, Guaranteed By Agent 42 and other types 6. Rate alone is not a deterministic guarantee rule in this data. The later snapshot shows 95 Cancelled and seven No Show; those statuses do not establish the original booking-time values.

All 492 E-Mail-source records have profile IDs; 429 have a guest email and 341 a mobile number. Twenty-two guest-email values occur with multiple profile IDs; shared contact details do not prove the profiles belong to one person. Room Type for Charge is observed blank on 358 records; of the 134 with both room-type fields populated, 122 differ. The cause of the difference is not established.

The linked outbound recipients use 129 domains. Of 25 domains appearing on at least five confirmations, 20 have multiple historical party combinations; recipient sets overlap. Among 110 exact recipient addresses repeated across confirmations, 35 have multiple combinations. Neither an outbound recipient nor a historical association independently identifies the original inbound requester.

### Further E-Mail-source patterns

Rate plans among the 492 reservations: `NGOVDB` 204, `NCOR1B` 95, `NGOVB` 63, `NCOR2B` 52, `BAR` 45, `WSF2B` 13, `EDU` 11, `BARRO` 3, `BLRB` 2, and `BGDSB`, `BOTAB`, `NCORRO`, and `NG156B` one each. The five leading codes cover 459/492 (93.3%). Displayed average rates vary within a code: `NCOR1B` has ten distinct values from ZAR 1,140 to 2,960 and `BAR` has 19 from ZAR 1,610 to 2,730. These are snapshot averages, not a current price catalog.

| Rate plan | Records | Deposit Requested | Guaranteed By Deposit | Guaranteed By Agent | Other guarantees |
| --- | ---: | ---: | ---: | ---: | ---: |
| NGOVDB | 204 | 82 | 74 | 42 | 6 |
| NCOR1B | 95 | 28 | 42 | 19 | 6 |
| NGOVB | 63 | 34 | 7 | 19 | 3 |
| NCOR2B | 52 | 23 | 17 | 12 | 0 |
| BAR | 45 | 22 | 22 | 0 | 1 |

Even choosing the most common guarantee separately for every rate would match 227/492 records in this same sample. This is a descriptive in-sample calculation, not a prediction test or evidence of the hotel's guarantee rules.

Ninety-one of 92 records with `Guaranteed By Agent` have an A/R account, but only 91 of the 138 with an A/R account have that guarantee. Among the 101 with agency, organization and A/R all populated, the guarantee is By Agent on 83, Deposit Requested on nine, By Deposit on five and Confirmation Received on four. These fields are correlated but do not determine one another. A snapshot may reflect changes after the original booking.

| Agency | Organization | A/R | Records | CMS 03 | CMS 01 | CMS 014 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| No | No | No | 34 | 28 | 6 | 0 |
| No | No | Yes | 3 | 3 | 0 | 0 |
| No | Yes | No | 140 | 134 | 5 | 1 |
| No | Yes | Yes | 17 | 17 | 0 | 0 |
| Yes | No | No | 47 | 47 | 0 | 0 |
| Yes | No | Yes | 17 | 17 | 0 | 0 |
| Yes | Yes | No | 133 | 132 | 1 | 0 |
| Yes | Yes | Yes | 101 | 97 | 0 | 4 |

The earlier private corpus analysis also ran an exploratory retrospective check: sort bookings by their first outbound PDF, look up combinations associated with earlier first-PDF `To` addresses or domains, and compare the most frequent earlier combination with the later PMS snapshot. Exact-address history existed for 284 confirmations; the top combination matched on 243 and one of the top three on 252. Domain history existed for 364; the top combination matched on 203 and one of the top three on 248. The PMS values were all read later, so this can leak later information; outbound recipients also need not be inbound senders. These figures are not live prediction accuracy.

The input threads have another limitation: 142 of the 492 had any inbound message on a linked thread, but only eight had a parseable inbound sender on a linked thread before a confirmation PDF. Absence in this snapshot is not proof no inbound request existed. The reservation-note/billing-instructions field contains text in 491/492, including repeated text; 39 have a captured note popup. Actionable content and authorship have not been established.

In one headless session on a blank Guest Stay form:

| Lookup | Query | Observed result |
| --- | --- | --- |
| Agency | `Nexus` | Four candidates. |
| Agency | `XL Nexus` | Two candidates: XL Nexus and XL Nexus Travel ATNS. |
| Agency | `XL Nexus Travel ATNS` | One candidate. |
| Agency | `Travel` | 50 loaded; flagged as possibly truncated. |
| Organization | `Justice` | Three candidates, including Department of Justices. |
| A/R | `XL Nexus` | One candidate, XL Nexus Travel. |
| Each type | An invented unmatched string | Verified zero-result search. |

The live grid returned native IDs and visible contact/address fields where available. A 50-row load is marked as possibly truncated; the broad search also explicitly reported more records. The tool matches the current Run request and its response to the displayed grid before returning candidates. A response confirming zero rows produces `no_match`; an incomplete or invalid search produces `execution_failure` instead.

XL Nexus was selected by its live native ID on a blank new-record form. The agency field read back as XL Nexus, the confirmation number remained blank, and organization and A/R stayed blank. The UI issued an `OSRESV.HDR.changetravelagency` request during selection; no Save action was performed. Screenshots and any raw result data are under the shared private `memory-experiments/live-ui/` directory.

A memory-guided example used the domain `nexustravel.co.za`. The initial unfiltered run matched 64 confirmations and 10 combinations. After the E-Mail-only correction, memory returns 59 confirmations and eight combinations: the two most frequent have 29 and 18 confirmations, both with XL Nexus but different organizations. Searching `Nexus` produced four live candidates, refining to the remembered agency produced two, and searching the remembered A/R name produced one. The request's other details still matter. These are observations, not an automatic identity decision. The private `memory-live-example.json` preserves the initial unfiltered tool outputs.

The JSONL runner was also checked from a fresh login: memory, agency refinement, unsaved selection, A/R, organization and an empty search all returned results. A subsequent attempt to select a stale agency ID was refused, then the session closed normally. Its private evidence is `final-session-results.jsonl`.

## Limits and next checks

- This is live-verified tooling, not a deployed or staff-facing workflow. One matching record is not proof that it is the right entity; the caller must compare available evidence and handle uncertainty.
- The source captures display values and has limited direct inbound-sender linkage. Domain matches may cover several agency/organization/A/R combinations. Historical selection is evidence, not current rate availability or hotel policy.
- Email/domain queries currently search both outbound-sender and outbound-recipient roles; there is no role filter. In this slice, the hotel's own domain matched all 492 confirmations as an outbound sender, while only 23 had it as an outbound recipient. A caller seeking requester history must not treat those sender matches as requester evidence; expose role-specific filtering before relying on the query for that decision.
- The memory's `attachment-id` link uses associations already assembled by the corpus; it does not currently expose whether the upstream confirmation number came from a labeled field or from matching filename, subject and extracted text, or whether the subject conflicted. In the E-Mail-only slice, 1,020 of the 1,061 associated PDF records had labeled confirmation candidates and 41 did not; nine of the 492 confirmations had only unlabeled associated PDFs, and one associated PDF had a subject conflict. The filtered XL Nexus domain example had 80 matching outbound-recipient PDF records: 79 had a matching labeled candidate and one did not. These are source-quality checks, not independent validation. Surface this provenance before using the counts for automatic decisions.
- The existing 1c capture did not select a guest row; detailed guest form fields in that capture were blank. Profile statistics came from 1b.
- Evaluate the matching decisions on real linked inbound requests and add a path for confirmed staff corrections if useful. The current historical evidence contains outbound recipients, not a general inbound-sender history.
