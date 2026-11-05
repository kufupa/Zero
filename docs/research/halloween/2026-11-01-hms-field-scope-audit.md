# Centurion HMS field-scope audit

**Snapshot:** source code at `0ae01692882bdb39a60b12770d97eaef95ab73f1` (HEAD at audit time). **Purpose:** exhaustive evidence-backed inventory of fields and controls already captured or inventoried for HRCEN; research only, not implementation or a final plan.

**Owner update, 2026-11-01:** CMS send checkbox, message ID and recipient email are optional tool inputs. Code `03` may be a changeable default, not a required or immutable value. Earlier statements in this audit about a mandatory nonblank message ID record a superseded historical rule, not the current requirement. Nava never sends; checking the box must not bypass that boundary. Shared guest-profile creation and amendment are outside this planning pass; finding and selecting existing profiles remains in scope.

## 1. Findings

- Inventory includes saved 1A Stay 360 cards, 1B Record View, 1C Guest Details, selected guest forms, one blank Guest Stay form, and Documents-tab reader output.
- **Control presence does not mean editability.** Every 1A/1B/1C/selected-guest-form row below is `Unknown` for editability unless a row is explicitly from the single blank-form observation. Even there, `disabled`/`readOnly` are only DOM metadata; no saved-write proof follows.
- The 892-record snapshot has no guest values reproduced here. Report contains field keys/labels, aggregate counts, and the requested CMS code distribution only. No personal names, addresses, contact values, booking IDs, IDs/passport values, or organization/agency/A/R values included.
- Identity/status fields, profile/address fields, and summary/calculated-style fields are called out separately below. Labels indicate likely role, not proof of source authority or editability.
- Money amounts below are **displayed HMS values**, not authoritative folio transactions or cleared-funds evidence.
- **Owner correction, 2026-11-01:** legacy Playwright tools are references only, not a recommended implementation foundation. New HMS capabilities should be modular Cloud tools for Centurion SaaS UI; deduplicate against existing Cloud capabilities first. This audit inventories evidence and does not propose implementation.

## 2. Evidence and limits

| Evidence | Sample and captured scope | Limits |
| --- | --- | --- |
| [S1] Saved 1A/1B/1C capture | 894 attempts; **892 succeeded, 2 failed**. Each successful record contains 16 Stay 360 card headings, a Record View capture, and a Guest Details capture. SHA-256 `85e6891ce4bdda359b4ca01092467573797b4914b915974fd9b62b2e4257a085`. | Historical capture, 29 Oct 2026. Its exact producing code SHA is not recorded in the JSON; fields are cross-walked to current source snapshot. Hidden content and unloaded grid pages are excluded; only rendered/expanded material and loaded rows appear. No user data copied into this note. |
| [S2] Selected guest-form batch | **30 distinct stays, 33 guest rows/forms**, 78 rendered controls per form (2,574 control instances); 30/30 primary forms and three secondary forms. | Deliberately diverse, not representative. Hidden content and unloaded grid pages excluded. See [existing evidence](memory-experiments/2026-10-30-guest-forms-refund-and-next-tools.md#L11-L38). |
| [S4] Blank-form metadata | **One** guarded blank HRCEN Guest Stay form; **108** visible controls; no guest selected. Supplied by coordinator as sanitized metadata; only first JSON line was read. | One blank form only. The metadata read did not type or save; a separate guarded synthetic fill probe is recorded as [S12]. Flags do not prove saved-write behavior. |
| Documents observations | **Six** read-only stay checks: one empty tree, four with one file, one with two files (**six loaded file rows total**). | No fieldwise name/code completeness counts in prior note. Unloaded folders, document bytes and full retrieval are unproved. |

### Source register

- [S1] Private 892-record JSON capture: `/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json`. Existing provenance reference: [five-day corpus note, lines 43–49](2026-10-30-centurion-five-day-corpus.md#L43-L49).
- [S2] Private guest-form JSON: `/home/orca/.local/share/zero/research/halloween/guest-form-30-20261030/results-30.json`; sanitized prior summary: [guest forms and next HMS tools, lines 11–38](memory-experiments/2026-10-30-guest-forms-refund-and-next-tools.md#L11-L38).
- [S3a] Current 1A card reconciliation: [guest-stay-cancel-preflight.mjs, lines 221–279](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-cancel-preflight.mjs#L221-L279); displayed-money marker: [lines 399–410](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-cancel-preflight.mjs#L399-L410).
- [S3b] Current Record View collector: [stay360-record-view.mjs, lines 5–123](../../../apps/server-pilot/tooling/hms-cloud/stay360-record-view.mjs#L5-L123). Narrow legacy `readRecord`: [cancel-stay.mjs, lines 97–110](../../../apps/server-pilot/tooling/playwright-quote/cancel-stay.mjs#L97-L110).
- [S3c] Current Guest Details collector: [stay360-guest-details.mjs, lines 5–137](../../../apps/server-pilot/tooling/hms-cloud/stay360-guest-details.mjs#L5-L137).
- [S3d] Current selected guest-form collector: [stay360-guest-form.mjs, lines 6–165](../../../apps/server-pilot/tooling/hms-cloud/stay360-guest-form.mjs#L6-L165).
- [S3e] Current blank Guest Stay form reader: [guest-stay-form.mjs, lines 48–67](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-form.mjs#L48-L67).
- [S3f] Current Documents reader: [stay360-documents.mjs, lines 1–73](../../../apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs#L1-L73).
- [S4] Coordinator-supplied sanitized blank-form metadata: `/tmp/claude-997/-home-ubuntu-projects-zero/35d07273-bb3b-4d8c-8923-fce89fc6e88f/tasks/bmxvn0ij2.output` (first JSON line only; field metadata and flags, no values).
- [S5] Owner correction supplied during this audit, 2026-11-01: legacy Playwright tools are references only; new HMS capabilities should use modular Cloud tools for Centurion SaaS UI, deduplicated against existing Cloud capabilities.
- [S6] Current create/save contract: [guest-stay-save.md, especially lines 13–44 and 73–158](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.md#L13-L158) and [guest-stay-save.mjs](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.mjs). These specify exact create inputs, optional strict proofs, limits and current gaps.
- [S7] Actual synthetic Labtest note evidence: [write and memory results, lines 23–31](2026-10-31-hms-write-and-memory-results.md#L23-L31); amendment scope/outcomes: [17-hour retro, lines 80–83](2026-11-01-hms-17h-retro.md#L80-L83) and [guest-stay-amend.md](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-amend.md#L1-L42).
- [S8] Booker amendment contract: [guest-stay-amend-contact.md, lines 3–71](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-amend-contact.md#L3-L71); observed paired save/readback caveat: [17-hour retro, lines 80–82](2026-11-01-hms-17h-retro.md#L80-L82).
- [S9] Cloud draft setter inventory: [17-hour retro, lines 63–75](2026-11-01-hms-17h-retro.md#L63-L75). Draft setters are not general saved-write proof.
- [S10] Historical CMS Message Id owner rule and code labels: [HRDAV lookup, lines 3–16](../2026-10-28-hrdav-cms-message-id-codes.md#L3-L16). Probe was read-only; cited as historical direction, not current Centurion validation or send authorization.
- [S11] Historical source/party CMS and rate variation: [source-cohort and Cloud-tool design, lines 42–65](memory-experiments/2026-10-30-source-cohort-and-cloud-tool-design.md#L42-L65).
- [S12] Coordinator-supplied guarded blank-form fill probe, 2026-11-01: synthetic address/phone fill+Tab observations only; a route blocked mutating HTTP methods, and zero such requests were observed during the interaction. No save was clicked and no values were retained.
- [S13] Cloud quote snapshot lifecycle: [booking-lookup-session.mjs, lines 306–316](../../../apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs#L306-L316). Handles live in a per-page `WeakMap` and are deleted on page close; this does not prove cross-session recovery.
- [S14] Counterevidence for child-age validation: [workstation.ts, lines 1078–1092](../../../apps/server-pilot/src/trpc/routes/workstation.ts#L1078-L1092); unquoted draft route rejects `childAges === null` before prefill. This narrows helper concern to unverified reachability; it is not evidence of a production incident.
- [S15] Coordinator-supplied privacy-safe aggregate, 2026-11-01: child counts and populated age-band counts across the 892 successful Record View captures; no guest values retained.
- [S16] Coordinator-supplied privacy-safe cross-surface contact comparison, 2026-11-01: 30 matched primary guest forms and Record View profiles; discrepancy counts only, no contact values retained.
- Documents sample details: [guest forms and next HMS tools, lines 40–53](memory-experiments/2026-10-30-guest-forms-refund-and-next-tools.md#L40-L53). Group/association limitation: [parked items, lines 5–11](2026-11-01-hms-tooling-parked-items.md#L5-L11).

## 3. Cross-field checks on the 892 saved records

These counts use only populated/blank status of party fields; no party values are included. `company` is the Record View field labeled Organization. Exclusive rows sum to 892.

| Exclusive populated-field pattern | Records | Source |
| --- | ---: | --- |
| ta1 | 248/892 | [S1] |
| company | 204/892 | [S1] |
| ta1, company | 195/892 | [S1] |
| ta1, company, araccountname | 131/892 | [S1] |
| none | 71/892 | [S1] |
| ta1, araccountname | 22/892 | [S1] |
| company, araccountname | 18/892 | [S1] |
| araccountname | 3/892 | [S1] |

| Field | Populated records | Source |
| --- | ---: | --- |
| ta1 | 596/892 | [S1] |
| company | 548/892 | [S1] |
| araccountname | 174/892 | [S1] |

The combinations show agency, organization and A/R do not always appear together; independent selection/readback remains justified. These are later snapshots, not booking-time policy. `CMS Message Id` (`udfchar09`) is present and nonblank in 892/892 records; observed codes:

| CMS code | Records / 892 | Source |
| --- | --- | --- |
| 03 | 840/892 | [S1] |
| 01 | 43/892 | [S1] |
| 014 | 6/892 | [S1] |
| 012 | 2/892 | [S1] |
| 05 | 1/892 | [S1] |

`03` dominates at **840/892**. This is a descriptive sample result, not proof that 03 is a valid/default code for future bookings.

| Agency populated | Organization populated | CMS 03 | Other codes |
| --- | --- | ---: | ---: |
| No | No | 51 | 23 |
| No | Yes | 213 | 9 |
| Yes | No | 260 | 10 |
| Yes | Yes | 316 | 10 |

These later snapshots show that 03 is not determined by the mere presence of agency or organization fields. They do not establish booking-time policy.

Coordinator-supplied child-count aggregate across the same 892 successful Record View captures: **868** stays had zero children, **16** had one, and **8** had two. Age bands were populated above zero in **10** records for ages 0–2, **12** for 3–12, and **3** for 13–17; band counts can overlap. In all 892 records, the captured child count equaled the sum of the three captured age bands. This is a selected later snapshot, not inbound prevalence or a reason to omit child fields [S15].

## 4. 1A — Stay 360 shallow cards / `readShallow`

The capture had all 16 card headings in 892/892 records. Structured named `fields` appeared only in **Stay (15)**, **Associations (8)**, **Guest (11)**, and **Folio (8)**: 42 field descriptors total. The other 12 headings were Add-Ons, Stay Details, External Confirmations, Additional Guests, Preferences, Notes, Messages, Traces, Tax Invoicing, Auto Transfer, Associated Reservations, and Shares; empty structured `fields` do **not** prove that those tabs/cards contain no information. `visibleFormFields` was empty in **892/892** captures. Current `readShallowField` reads named-card fields or `visibleFormFields`; it has no editability test [S3a].

`Captures` and `non-empty serialized` use denominator 892. Empty string/null counted empty; values were never printed. `SUBFOLIOS` is a structural field marker, not a guest value.

| Card | Stable key | Captured label | DOM type | Captures | Non-empty serialized | Editable? | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stay | arrivaldate | Arrival | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | departuredate | Departure | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | nights | nights | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | adults | adults | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | status | Status | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | roomtype | Room Type | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | rateplan | Rate Plan | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | mealplan | Meal Plan | div | 891/892 | 891/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | room | Room | div | 892/892 | 729/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | grandtotal | Stay Grand Total | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | averagenightly | Average Nightly | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | enhancedexptotal | Add-On Total | div | 892/892 | 19/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | tax | Tax | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | reservationnote | Reservation Note | div | 885/892 | 885/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | sourceofbusinessdesc | Source of Business | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | marketsegmentdesc | Market Segment | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | channeldesc | Channel | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | groupname | Group | div | 892/892 | 1/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | company | Organization | div | 892/892 | 548/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | ta1 | Booking Agency | div | 892/892 | 596/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | araccountname | A/R Account | div | 892/892 | 174/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Associations | leasenumber | Lease | div | 892/892 | 0/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | guestfullname | guestfullname | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | emailaddress | emailaddress | div | 777/892 | 777/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | viplevel_display | VIP Level | div | 892/892 | 116/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | loyaltynumber | Loyalty | div | 892/892 | 2/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | rewardsprogram_display | Rewards | div | 892/892 | 0/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | revenuevalue | Lifetime Revenue | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | nightsvalue | Lifetime Nights | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | lifetimestays | Lifetime Stays | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | cardnumber1 | Guarantee | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | cardnumber | Settlement | div | 892/892 | 719/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | remainingauthorization | Remaining Authorization | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | depositduedate | Deposit Due Date | div | 892/892 | 301/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | depositamount | Deposit Amount | div | 892/892 | 301/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | depositreceived | Deposit Received | div | 892/892 | 381/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | foliobalance | Balance: | div | 892/892 | 654/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Folio | SUBFOLIOS | SUBFOLIOS | div | 892/892 | 892/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | address | address | div | 743/892 | 743/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | mobilenumber | Mobile Number | div | 639/892 | 639/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Stay | roomtypecharge | Room Type for Charge | div | 217/892 | 217/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |
| Guest | guestnotes | Guest Notes | div | 5/892 | 5/892 | Unknown — card descriptor is not editability evidence. | [S1, S3a] |

**Similar labels, distinct keys:** the Folio card has `cardnumber1` (Guarantee) and `cardnumber` (Settlement). Preserve both keys with their labels; the capture has no duplicate exact-name keys within a card. If a future read finds duplicate exact-name matches, `readShallowField` returns `duplicate_field` instead of choosing one [S3a]. Card amounts (Average Nightly, Add-On Total, Stay Grand Total, Tax, Balance, Deposit Amount/Received, Remaining Authorization) are display values only; `moneyDisplay` marks its basis `stay360_display_only_not_ledger` [S3a].

## 5. 1B — Record View / `readRecordViewFromStay360`

The 892-record capture contains **118 distinct named fields**, one occurrence of each key in each capture; duplicate field names were not observed. `readRecordViewFromStay360` expands visible collapsed panels and collects visible inputs, textareas, selects, contenteditable fields and display fields; it excludes hidden/password inputs and grid descendants. It does **not** capture disabled/readOnly flags or prove any field editable [S3b]. `non-empty serialized` counts false checkboxes as an observed serialized value; it does not mean “checked.”

The table groups fields by captured section. `—` means no section captured; labels are preserved where available, and keys without a display label remain identifiable by key. Every row's editability is **Unknown** from this reader. One blank-form observation's DOM flags are cross-listed in §8, not generalized to saved-record editability.

| Captured section | Stable key | Label | DOM type | Present / 892 | Non-empty serialized / 892 | Editable? | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | status | Status: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | confirmationnumber | Confirmation Number: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | externalreference1 | External Reference 1: | text | 892/892 | 229/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar10 | Wi-Fi Voucher: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar11 | WIFI Status: | text | 892/892 | 690/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | groupname | Group: | text | 892/892 | 1/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | bacontract | Booking Agency Contract: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar02 | Deposit Due Amount Required: | text | 892/892 | 96/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfdate02 | Deposit Due Date.: | text | 892/892 | 107/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | depositreceived | Deposit Received: | text | 892/892 | 151/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | depositreceivedcurrency | Deposit Received: | text | 892/892 | 151/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | balance | Balance: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | balancecurr | Balance: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | lastproperty | Last Property: | text | 892/892 | 672/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | lastroomoccupied | Last Room Occupied: | text | 892/892 | 672/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | lastcheckoutdate | Last Checkout Date : | text | 892/892 | 672/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar07 | CMS Form Status: | text | 892/892 | 29/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchkbox04 | CMS Send Mail: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar09 | CMS Message Id: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | udfchar13 | CMS Booker Email: | text | 892/892 | 107/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | revenuevalue | Lifetime Revenue: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | revenuedesc | Lifetime Revenue: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | nightsvalue | Lifetime Nights: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | lifetimestays | Lifetime Stays: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | playernumber | Loyalty Number: | text | 892/892 | 86/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | twitterid | Loyalty Points Balance: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | facebookid | Legacy Lifestyle Update: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| — | bookingdotcomid | New / Existing Member: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | ta1 | Primary Booking Agency: | text | 892/892 | 596/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | company | Organization: | text | 892/892 | 548/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | araccountname | A/R Account: | text | 892/892 | 174/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | billingreference | Billing Reference: | text | 892/892 | 163/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | arrivaldate | Arrival Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | arrivaldayofweek | Arrival Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | nights | Nights: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | departuredate | Departure Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | departuredayofweek | Departure Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | adults | Adults: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | child1 | Child 0 - 02: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | child2 | Child 03 - 12: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | child3 | Child 13 - 17: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | children | Children: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | reasonforstay | Reason for Stay: | text | 892/892 | 309/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | sourceofbusinessdesc | Source Of Business: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | iswalkin | Walk In: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | ignoreallrestrictions | Ignore All Restrictions: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | ta1commission | Commission Percent: | text | 892/892 | 233/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | guaranteetype | Guarantee Type: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | roomtype | Room Type: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | roomtypecharge | Room Type for Charge: | text | 892/892 | 217/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | rateplan | Rate Plan: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | promotioncode | Promotion: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | mealplan | Meal Plan: | text | 892/892 | 891/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | resortfee | Resort Fee: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | totalresortfee | Resort Fee: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | marketsegment | Market Segment: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | track | Track / Sub Segment: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | confidentialratecb | Confidential Rate: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | room | Room: | text | 892/892 | 662/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | donotmove | Do Not Move: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | donotmovereason | Do Not Move Reason: | text | 892/892 | 9/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | scheduledroom | Scheduled Room: | text | 892/892 | 662/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | averagerate | Average Rate: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | averageratecurr | Average Rate: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | totalrate | Total Rate: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | totalratecurr | Total Rate: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | enhancedexptotal | Add-On Total: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | enhancedexptotalcurr | Add-On Total: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | grandtotal | Grand Total: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | grandtotalcurr | Grand Total: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | waitlistpriority | Waitlist Priority: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | caller | Booker Name: | text | 892/892 | 105/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | udfchar06 | Booker Contact: | text | 892/892 | 368/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Stay | reservationnote | Reservation Note / Billing Instructions: | textarea | 892/892 | 885/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | guestid | Profile ID: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | prefix | Title: | text | 892/892 | 563/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | lastname | Last Name: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | firstname | First Name: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | viplevel | VIP Level: | text | 892/892 | 116/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | gender | Gender: | text | 892/892 | 598/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | phonetypecode | Phone Type: | text | 892/892 | 181/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | phonenumber | Phone Number: | text | 892/892 | 181/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | mobilenumber | Mobile Number: | text | 892/892 | 639/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | emailtypecode | E-mail Type: | text | 892/892 | 777/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | emailaddress | E-mail Address: | text | 892/892 | 777/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | autoemailfolio | Auto Email Folio: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | guestoptin1 | Legacy Marketing Opt in: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | guestoptin2 | Lifestyle Marketing Opt in: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | guestoptin3 | Legacy Lifestyle Member: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | guestoptin4 | Terms and Conditions: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | language | Language: | text | 892/892 | 676/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | scannedpassportref | Scanned Passport Reference: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | passportscanneddate | Passport Scan Date: | text | 892/892 | 55/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | addresstypecode | Address Type: | text | 892/892 | 744/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | address | Address: | textarea | 892/892 | 596/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | city | City: | text | 892/892 | 403/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | postalcode | Postal Code: | text | 892/892 | 275/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | countrydesc | Country: | text | 892/892 | 731/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | statedesc | State / Province: | text | 892/892 | 296/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | nationalitydesc | Nationality: | text | 892/892 | 699/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | countryofresidencedesc | Country of Residence: | text | 892/892 | 589/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | taxid | Vat Id: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | vehicle | Vehicle Reg No.: | text | 892/892 | 40/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | dateofbirth | Date of Birth: | text | 892/892 | 528/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | turndowntime | Turndown Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Guest | cleaningtime | Cleaning Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Settlement | settlementtype | Settlement Type: | text | 892/892 | 719/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Settlement | nopost | No Post: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | reservationdate | Reservation Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | canceldate | Cancellation Date: | text | 892/892 | 144/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | cancelnumber | Cancellation Number: | text | 892/892 | 144/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | cancelreasondesc | Cancellation Reason: | text | 892/892 | 144/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | thirdpartycancellationnumber | External Cancellation Number: | text | 892/892 | 21/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Reservation | cancellationnote | Cancellation Note: | textarea | 892/892 | 103/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Record Details | updatedby | Updated By: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Record Details | updated | Updated On: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Record Details | createdby | Created By: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |
| Record Details | created | Created On: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3b] |

The legacy `readRecord` helper is narrower still: it returns only `confirmation ← confirmationnumber`, `lastName ← lastname`, `arrival ← arrivaldate`, and `status ← status` from the first visible named input; none of this projection establishes editable state [S3b]. It is inventoried as a reader reference only, not a recommended implementation foundation [S5]. Duplicate labels do occur for different keys—for example currency/display pairs such as Balance, Deposit Received, Average Rate, Total Rate, Add-On Total and Grand Total—so preserve key and label together [S1, S3b].

**Field-family interpretation (labels/keys only):** identity and record identifiers include `confirmationnumber`, `guestid`, `idnumber` and passport/visa identifiers; status/state fields include `status`, cancellation fields, `guaranteetype` and CMS status/send controls; profile/address fields include names, contact, address, city, postal code and country fields; summary/calculated-style candidates include nights/day-of-week, rate/total, tax and lifetime summary fields. These names do not prove calculation method, data authority, editability or checked state. Money remains displayed-only as documented above [S1–S3d].

## 6. 1C — Guest Details / `readGuest`

The capture contains **88 distinct field/control descriptors** per record: 84 named keys plus four unnamed time-display controls. The same descriptor set appears in all 892 captures; no duplicate named control keys were observed. This is the rendered Guest Details panel capture, not a selected per-guest profile form. The reader records visible controls and grid content, but no disabled/readOnly flags [S3c]. Non-empty serialized counts include checkbox booleans and must not be read as “checked.” Ten exact-name keys absent from both Record View and sampled guest-form keys are filter/query UI (`dataspylist`, `ff_arrivaltimenew`, `ff_arrivaltype_display`, `ff_departuretimenew`, `ff_departuretype_display`, `ff_firstname`, `ff_lastname`, `filterfields`, `selfiltervaluectrl`, `showfilter`); they are not reservation fields [crosswalk §11].

| Captured section | Stable key | Label | DOM type | Present / 892 | Non-empty serialized / 892 | Editable? | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | dataspylist | dataspylist | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | filterfields | filterfields | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | selfiltervaluectrl | selfiltervaluectrl | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_lastname | ff_lastname | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_firstname | ff_firstname | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_arrivaltype_display | ff_arrivaltype_display | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_arrivaltimenew | ff_arrivaltimenew | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_departuretype_display | ff_departuretype_display | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | ff_departuretimenew | ff_departuretimenew | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| — | showfilter | Show Filter Row: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | guestid | Profile ID: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | prefix | Title: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | lastname | Last Name: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | firstname | First Name: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | nationality | Guest Nationality: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | dateofbirth | Date of Birth: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | birthcity | Birth City: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | addresstype | Address Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | streetaddress | Address: | textarea | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | city | City: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | postalcode | Postal Code: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | countrydesc | Country: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | statedesc | State/Province: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | phonetype | Phone Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | phonenumber | Phone Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | mobilenumber | Mobile Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | emailtype | Email Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | emailaddress | Email Address: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | idnumber | ID Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | idexpirationdate | ID Expiration Date : | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | emailmarketingoptin | Email Marketing Opt In: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passporttype | Passport Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passportnumber | Passport Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passportname | Passport Name: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passportissueddate | Passport Issued Date: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passportexpirationdate | Passport Expiration Date: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | passportnationalitydesc | Passport Nationality: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | controlsegment | Control Segment: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | primaryguest | Primary Guest: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | addupdateprofile | Add/Update Profile: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | nopost | No Post: | checkbox | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | guestcategory | Guest Category: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | guestrelationshipdesc | Guest Relationship: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | reasonforstay | Reason for Stay: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | viplevel | VIP Level: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Guest Details | countryofresidencedesc | Country of Residence: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivaldate | Arrival Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivaldayofweek | Arrival Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivaltype | Arrival Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivaltime_h | Arrival Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | (unnamed control) | Arrival Time: | div | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivaltime_m | Arrival Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivalinformation | Arrival Information: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivalhotel_h | Hotel Arrival Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | (unnamed control) | Hotel Arrival Time: | div | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivalhotel_m | Hotel Arrival Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departuredate | Departure Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departuredayofweek | Departure Date: | text | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departuretype | Departure Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departuretime_h | Departure Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | (unnamed control) | Departure Time: | div | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departuretime_m | Departure Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departureinformation | Departure Information: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departurehotel_h | Hotel Departure Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | (unnamed control) | Hotel Departure Time: | div | 892/892 | 892/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departurehotel_m | Hotel Departure Time: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | nextdestination | Next Destination: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | arrivalnotes | Arrival Notes: | textarea | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Arrival / Departure Information | departurenotes | Departure Notes: | textarea | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Identification | idtype | ID Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Identification | iddescription | ID Description: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Identification | idname | Name: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Identification | iddateofbirth | Date of Birth: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Identification | idgender | Gender: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | issuingcountrydesc | Passport Issuing Country: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | personalnumber | Personal Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | gender | Gender: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visanumber | Visa Number: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visaname | Visa Name: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visatype | Visa Type: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visastatus | Visa Status: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visaissueddate | Visa Issued Date: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visabegindate | Visa Begin Date: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Passport / Visa | visaexpirationdate | Visa Expiration Date: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Record Details | updatedby | Updated By: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Record Details | updated | Updated On: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Record Details | createdby | Created By: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |
| Record Details | created | Created On: | text | 892/892 | 0/892 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S1, S3c] |

The loaded Guest Details grid showed these headers in the saved capture. Rows are private and omitted; only header labels and aggregate row coverage are recorded.

| Grid header | Evidence | Coverage | Editable? | Source |
| --- | --- | --- | --- | --- |
| Last Name | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| First Name | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Primary Guest | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Arrival Type | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Arrival Time | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Departure Type | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Departure Time | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| Passport / Visa | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| ID | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |
| No Post | Visible Guest Details grid header | 892/892 grids; field-specific values not reproduced. | Unknown — grid header does not establish row-control editability. | [S1, S3c] |

Observed grid shape: 892 capture(s) with 1 grid(s); loaded row-count distribution: 1 row(s) in 865 grid(s), 2 row(s) in 24 grid(s), 3 row(s) in 3 grid(s). Hidden data and unloaded grid pages remain excluded [S1, S3c].

## 7. Selected Guest Details forms (`readGuestForm`)

The separate selected-row batch read **33 rendered forms** from 30 stays: 27 one-row stays and 3 two-row stays. Each form had 78 controls (2,574 total control instances); all captured field signatures were present in 33/33 forms. These rows include guest-profile/address and passport/visa controls; no guest values appear here. Selected forms do not record disabled/readOnly flags, so editability is **Unknown** [S2, S3d].

| Grid column | Evidence | Coverage | Editable? | Source |
| --- | --- | --- | --- | --- |
| Last Name | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| First Name | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Primary Guest | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Arrival Type | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Arrival Time | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Departure Type | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Departure Time | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| Passport / Visa | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| ID | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |
| No Post | Loaded guest-row grid header | 30 stays / 33 guest rows; header values only | Unknown — read-only capture does not prove editability | [S2, S3d] |

| Captured section | Stable key | Label | DOM type | Forms with control / 33 | Non-empty serialized / 33 | Editable? | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Guest Details | guestid | Profile ID: | text | 33/33 | 30/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | prefix | Title: | text | 33/33 | 17/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | lastname | Last Name: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | firstname | First Name: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | nationality | Guest Nationality: | text | 33/33 | 21/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | dateofbirth | Date of Birth: | text | 33/33 | 17/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | birthcity | Birth City: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | addresstype | Address Type: | text | 33/33 | 21/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | streetaddress | Address: | textarea | 33/33 | 18/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | city | City: | text | 33/33 | 9/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | postalcode | Postal Code: | text | 33/33 | 2/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | countrydesc | Country: | text | 33/33 | 21/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | statedesc | State/Province: | text | 33/33 | 6/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | phonetype | Phone Type: | text | 33/33 | 7/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | phonenumber | Phone Number: | text | 33/33 | 7/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | mobilenumber | Mobile Number: | text | 33/33 | 14/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | emailtype | Email Type: | text | 33/33 | 28/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | emailaddress | Email Address: | text | 33/33 | 28/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | idnumber | ID Number: | text | 33/33 | 14/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | idexpirationdate | ID Expiration Date : | text | 33/33 | 5/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | emailmarketingoptin | Email Marketing Opt In: | checkbox | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passporttype | Passport Type: | text | 33/33 | 2/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passportnumber | Passport Number: | text | 33/33 | 3/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passportname | Passport Name: | text | 33/33 | 3/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passportissueddate | Passport Issued Date: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passportexpirationdate | Passport Expiration Date: | text | 33/33 | 3/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | passportnationalitydesc | Passport Nationality: | text | 33/33 | 3/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | controlsegment | Control Segment: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | primaryguest | Primary Guest: | checkbox | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | addupdateprofile | Add/Update Profile: | checkbox | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | nopost | No Post: | checkbox | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | guestcategory | Guest Category: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | guestrelationshipdesc | Guest Relationship: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | reasonforstay | Reason for Stay: | text | 33/33 | 7/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | viplevel | VIP Level: | text | 33/33 | 1/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Guest Details | countryofresidencedesc | Country of Residence: | text | 33/33 | 19/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivaldate | Arrival Date: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivaldayofweek | Arrival Date: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivaltype | Arrival Type: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivaltime_h | Arrival Time: | text | 33/33 | 1/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | (unnamed control) | Arrival Time: | div | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivaltime_m | Arrival Time: | text | 33/33 | 1/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivalinformation | Arrival Information: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivalhotel_h | Hotel Arrival Time: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | (unnamed control) | Hotel Arrival Time: | div | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivalhotel_m | Hotel Arrival Time: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departuredate | Departure Date: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departuredayofweek | Departure Date: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departuretype | Departure Type: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departuretime_h | Departure Time: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | (unnamed control) | Departure Time: | div | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departuretime_m | Departure Time: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departureinformation | Departure Information: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departurehotel_h | Hotel Departure Time: | text | 33/33 | 17/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | (unnamed control) | Hotel Departure Time: | div | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departurehotel_m | Hotel Departure Time: | text | 33/33 | 17/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | nextdestination | Next Destination: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | arrivalnotes | Arrival Notes: | textarea | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Arrival / Departure Information | departurenotes | Departure Notes: | textarea | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Identification | idtype | ID Type: | text | 33/33 | 14/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Identification | iddescription | ID Description: | text | 33/33 | 14/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Identification | idname | Name: | text | 33/33 | 13/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Identification | iddateofbirth | Date of Birth: | text | 33/33 | 17/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Identification | idgender | Gender: | text | 33/33 | 19/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | issuingcountrydesc | Passport Issuing Country: | text | 33/33 | 2/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | personalnumber | Personal Number: | text | 33/33 | 2/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | gender | Gender: | text | 33/33 | 19/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visanumber | Visa Number: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visaname | Visa Name: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visatype | Visa Type: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visastatus | Visa Status: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visaissueddate | Visa Issued Date: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visabegindate | Visa Begin Date: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Passport / Visa | visaexpirationdate | Visa Expiration Date: | text | 33/33 | 0/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Record Details | updatedby | Updated By: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Record Details | updated | Updated On: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Record Details | createdby | Created By: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |
| Record Details | created | Created On: | text | 33/33 | 33/33 | Unknown — reader records value/type, not disabled/readOnly or save outcome. | [S2, S3d] |

The earlier sanitized summary reports 30/30 primary-form profile IDs matched the same stay's Record View; three secondary forms had no profile ID. Coordinator's independent exact-ID check confirms all 30 sampled records had exactly one guest form matching its Record View profile ID. Among those matched forms, phone was present only in Guest Details for 6, mobile only in Record View for 7, mobile differed for 1, and email differed for 1. These are cross-surface discrepancy counts from a selected sample, not editability or persistence evidence; values remain omitted [S2, S16]. ID and passport fields occur in the field inventory, but their values are deliberately absent [S2].

## 8. One blank HRCEN Guest Stay form

Coordinator-supplied metadata records **108 visible controls** from one blank Guest Stay form, with no guest row selected. This count is separate from the 78-control selected Guest Details form. All 108 had `disabled=false`; **43** had `readOnly=true`, **65** had `readOnly=false` in this blank-form observation. The reader explicitly samples visible controls and records these DOM flags [S3e, S4]. No save/write was tested; every row's saved-write/editability status remains **Unknown**. Coordinator follow-up probe accepted synthetic `address` and `phonenumber` values in the blank form after fill+Tab; `confirmationnumber` and `guestid` stayed blank. Mutating requests were blocked before dispatch; zero mutation requests reached HMS and no save occurred. This proves local input acceptance only—not a Cloud setter, persistence, profile ownership, or saved-record editability [S12].

| Stable key | Label in blank-form observation | DOM type | disabled | readOnly | Saved-write status | Source |
| --- | --- | --- | --- | --- | --- | --- |
| status | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| confirmationnumber | Confirmation Number: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| externalreference1 | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar10 | Wi-Fi Voucher: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar11 | WIFI Status: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| groupname | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| bacontract | Booking Agency Contract: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar02 | Deposit Due Amount Required: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfdate02 | Deposit Due Date.: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| depositreceived | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| depositreceivedcurrency | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| balance | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| balancecurr | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| lastproperty | Last Property: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| lastroomoccupied | Last Room Occupied: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| lastcheckoutdate | Last Checkout Date : | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar07 | CMS Form Status: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchkbox04 | CMS Send Mail: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar09 | CMS Message Id: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar13 | CMS Booker Email: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| revenuevalue | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| revenuedesc | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| nightsvalue | Lifetime Nights: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| lifetimestays | Lifetime Stays: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| playernumber | Loyalty Number: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| twitterid | Loyalty Points Balance: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| facebookid | Legacy Lifestyle Update: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| bookingdotcomid | New / Existing Member: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| ta1 | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| company | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| araccountname | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| billingreference | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| arrivaldate | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| arrivaldayofweek | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| nights | Nights: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| departuredate | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| departuredayofweek | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| adults | Adults: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| child1 | Child 0 - 02: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| child2 | Child 03 - 12: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| child3 | Child 13 - 17: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| children | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| reasonforstay | Reason for Stay: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| sourceofbusinessdesc | Source Of Business: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| iswalkin | Walk In: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| ignoreallrestrictions | Ignore All Restrictions: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| ta1commission | Commission Percent: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guaranteetype | Guarantee Type: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| roomtype | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| roomtypecharge | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| rateplan | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| promotioncode | Promotion: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| mealplan | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| resortfee | Resort Fee: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| totalresortfee | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| marketsegment | Market Segment: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| track | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| confidentialratecb | Confidential Rate: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| room | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| donotmove | Do Not Move: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| donotmovereason | Do Not Move Reason: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| scheduledroom | Scheduled Room: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| averagerate | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| averageratecurr | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| totalrate | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| totalratecurr | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| enhancedexptotal | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| enhancedexptotalcurr | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| grandtotal | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| grandtotalcurr | (no label captured) | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| waitlistpriority | Waitlist Priority: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| caller | Booker Name: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| udfchar06 | Booker Contact: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| reservationnote | Reservation Note / Billing Instructions: | textarea | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guestid | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| prefix | Title: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| lastname | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| firstname | First Name: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| viplevel | VIP Level: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| gender | Gender: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| phonetypecode | Phone Type: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| phonenumber | Phone Number: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| mobilenumber | Mobile Number: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| emailtypecode | E-mail Type: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| emailaddress | E-mail Address: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| autoemailfolio | Auto Email Folio: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guestoptin1 | Legacy Marketing Opt in: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guestoptin2 | Lifestyle Marketing Opt in: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guestoptin3 | Legacy Lifestyle Member: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| guestoptin4 | Terms and Conditions: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| language | Language: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| scannedpassportref | Scanned Passport Reference: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| passportscanneddate | Passport Scan Date: | text | false | true | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| addresstypecode | Address Type: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| address | (no label captured) | textarea | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| city | City: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| postalcode | Postal Code: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| countrydesc | Country: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| statedesc | State / Province: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| nationalitydesc | Nationality: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| countryofresidencedesc | Country of Residence: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| taxid | Vat Id: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| vehicle | Vehicle Reg No.: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| dateofbirth | Date of Birth: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| turndowntime | Turndown Time: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| cleaningtime | Cleaning Time: | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| settlementtype | (no label captured) | text | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |
| nopost | No Post: | button | false | false | Unknown — blank-form DOM flags do not prove saved-write behavior. | [S4, S3e] |

Every blank-form key also appears in the 118-key Record View capture. Record View has ten additional keys absent from the blank form: `canceldate`, `cancellationnote`, `cancelnumber`, `cancelreasondesc`, `created`, `createdby`, `reservationdate`, `thirdpartycancellationnumber`, `updated`, and `updatedby` [S1, S4]. This is an observed schema overlap, not a promise those fields are present/editable on every HMS form.

## 9. Documents tab

The current reader visits the Documents tab and traverses loaded tree nodes only. Its returned fields are `name`, `documentCode`, and display `label`; name can come from `documentFileName` or parsed label, and code from either code property or label prefix. It reports unloaded-folder/unrecognized-leaf counts, marks refresh/full coverage unverified, and does not download/change files [S3f]. Field-by-field sample completeness and editability are **Unknown**.

| Stable output field/control | Evidence label or meaning | Sample count | Editable? | Source |
| --- | --- | --- | --- | --- |
| `name` | Display/file name from a loaded leaf | Six loaded document rows across five stays; per-field completeness unknown | Unknown; reader does not edit/download | [S3f, Documents sample] |
| `documentCode` | Code parsed from loaded leaf metadata/label | Six loaded document rows across five stays; per-field completeness unknown | Unknown; reader does not edit/download | [S3f, Documents sample] |
| `label` | Loaded tree-leaf display text | Six loaded document rows across five stays; per-field completeness unknown | Unknown; reader does not edit/download | [S3f, Documents sample] |
| tree folder / leaf | Folder expansion and loaded/unloaded state | Six stay checks; unloaded-folder totals not in sanitized summary | Unknown | [S3f, Documents sample] |
| “No Documents” leaf | Reader's recognized empty-tree label | One of six checks returned no files | Not an editable field | [S3f] |

Prior Documents evidence says six stays yielded zero files on one, one file on four, and two files on one; one populated stay's returned name and code matched the visible listing. That proves a small loaded-node read, not complete inventory, file-byte access or document retrieval [Documents sample].

## 10. High-impact omissions and uncertainties

- **Saved-record inventories do not classify editability.** 1A card descriptors and 1B/1C/selected-form readers capture display/control metadata only. The blank form reports DOM flags, but they do not establish saved-record editability. Separate historical Labtest note and Booker writes have fresh-readback evidence; no write was part of this audit.
- **Hidden/unloaded scope and similar labels matter.** 1A `visibleFormFields` was empty in 892 records. 1B/1C omit hidden controls and unloaded pages; 1A omitted unopened tabs. No duplicate named keys were found within captured 1A cards, 1B or 1C. Folio has distinct `cardnumber1` and `cardnumber` keys; other labels can collide across different amount/currency keys.
- **Party fields are not interchangeable.** Agency, organization and A/R often appear independently; exclusive co-occurrence patterns and code counts above contain no party values. They do not establish booking rules or which selector must be required.
- **Money remains displayed, not authoritative.** Stay, Folio and Record View expose amounts/balances, but these captures do not read ledger transactions, prove cleared funds, or reconcile every display against an authoritative folio.
- **Linked-reservation evidence needs reassessment, not assumption.** The Associated Reservations heading was present in all 892 Stay 360 captures, but its grid/rows were not captured there. The 892-record sample also contains **24 same-guest, same-date clusters spanning 61 records with differing assigned rooms**—a likely simultaneous multi-room signal, not proof each cluster was HMS-linked or a population-wide incidence estimate. Owner direction was to reassess the deferred multi-room scope; this audit does not authorize a build or deploy. A separate 60-stay grid capture found no other linked confirmation: 36 grids were empty and 24 showed only the current stay. All 24 self-only results had questionable completeness, so do not infer no links [group/association limitation].
- **Guest-profile overlap is source-dependent.** Record View, Guest Details panel, selected Guest Details forms and blank Guest Stay form share some keys but are different surfaces and samples. Blank controls or empty panel controls are not evidence that the profile lacks a value.
- **Documents remain partial.** Six checks do not establish loaded-tree completeness, refresh behavior, downloads, document bytes, or fieldwise name/code coverage.

No SQL, fresh mail, product-code edit, deployment or HMS save was performed for this audit. The coordinator performed two guarded live blank-form interactions: a metadata read and a separate synthetic fill+Tab observation [S4, S12].

## 11. Per-key Cloud create/amend crosswalk

This maps every captured field/control **by surface and exact key**. Same-name controls can represent different objects. Draft status names current Cloud new Guest Stay tools; it does not imply that a captured saved-record or Guest Details control is editable. Guest Details panel/forms below intentionally remain unknown, even where a same-name new-stay setter exists. `No explicit setter / unknown` means evidence does not show support; it does not mean HMS makes the operation impossible.

**Coverage:** 42 Stay 360 card fields, 118 Record View keys, 88 Guest Details panel controls (84 named + four unnamed), 78 selected-form controls (74 named + four unnamed), and 108 blank Guest Stay controls. The 10 panel-only names above are included and marked as query/filter UI, not stay fields. Exact-name comparison found all 108 blank-form keys in the union of Record View and selected-form keys; blank form still gets its own table because same-name surface behavior differs. No rows are grouped.

Core create inputs apply only to guarded synthetic HRCEN Proof Labtest saves: new stays, 2027+ dates, verified fake profile, and NGI guarantee. Three synthetic notes were independently read back after create [S7]. Strict optional occupancy/source/party proof is distinct from the core save. Later historical Labtest creates were dispatched and read back; their execution SHA was not recorded [S6; see chronology below]. Saved amend support is narrower: note-only, plus paired Booker text fields under their separate Labtest guards [S7, S8]. No real-guest write is implied.

API/key aliases: `guestId` → `guestid`; `guestEmail` → `emailaddress`; `cmsRecipient` → `udfchar13`; `bookerName` → `caller`; `bookerContact` → `udfchar06`; `reservationNote` → `reservationnote`. Child-age selection derives count/bands; source selection validates description/code in current model/request, but native-code saved readback is unsupported [S6, S8, S9].

### 1A — Stay 360 card descriptors

Cloud statuses below refer to same-key Stay record operations, **not** editability of card DOM. Card descriptors remain read-only observations [S3a].

| 1A card / key / label | Cloud new-stay draft by same key | Create save | Saved amend | Boundary |
| --- | --- | --- | --- | --- |
| Stay / `arrivaldate` — Arrival | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| Stay / `departuredate` — Departure | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| Stay / `nights` — nights | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `adults` — adults | Explicit new-stay selector [S9] | Optional strict adult-selection proof; historical selected adult count read back; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `status` — Status | No explicit setter / unknown | New-record state is fixed; not a create setter [S6] | No explicit setter / unknown |  |
| Stay / `roomtype` — Room Type | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| Stay / `rateplan` — Rate Plan | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| Stay / `mealplan` — Meal Plan | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown | Do not infer independent field write from rate-plan selection. |
| Stay / `room` — Room | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `grandtotal` — Stay Grand Total | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `averagenightly` — Average Nightly | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `enhancedexptotal` — Add-On Total | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `tax` — Tax | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `reservationnote` — Reservation Note | Explicit new-stay text setter [S9] | Core input; 3 synthetic Labtest notes independently read back [S7] | Labtest note-only amend; fresh readback evidence [S7] | Values were synthetic; no real-guest write. |
| Associations / `sourceofbusinessdesc` — Source of Business | Explicit new-stay selector [S9] | Optional strict source proof; description read back, native code readback unsupported [S6, S9] | No explicit setter / unknown |  |
| Associations / `marketsegmentdesc` — Market Segment | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown | Do not infer independent field write from rate-plan selection. |
| Associations / `channeldesc` — Channel | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Associations / `groupname` — Group | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| Associations / `company` — Organization | Explicit new-stay selector [S9] | Optional strict organization proof; company-only readback exists; agency+company combination unproved [S6, S9] | No explicit setter / unknown | Company-only save read back; agency+company combined save not proved. |
| Associations / `ta1` — Booking Agency | Explicit new-stay selector [S9] | Optional strict agency proof; no agency save has yet proved either picker-reference case [S6] | No explicit setter / unknown | Selector proof is not agency persistence proof. |
| Associations / `araccountname` — A/R Account | Explicit new-stay selector [S9] | Must remain blank in current create writer; do not auto-clear [S6] | No explicit setter / unknown |  |
| Associations / `leasenumber` — Lease | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestfullname` — guestfullname | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `emailaddress` — emailaddress | Explicit new-stay text setter [S9] | Guest email / CMS recipient must be blank at create [S6, S7] | No explicit setter / unknown |  |
| Guest / `viplevel_display` — VIP Level | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `loyaltynumber` — Loyalty | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `rewardsprogram_display` — Rewards | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `revenuevalue` — Lifetime Revenue | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| Guest / `nightsvalue` — Lifetime Nights | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| Guest / `lifetimestays` — Lifetime Stays | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `cardnumber1` — Guarantee | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| Folio / `cardnumber` — Settlement | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `remainingauthorization` — Remaining Authorization | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `depositduedate` — Deposit Due Date | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `depositamount` — Deposit Amount | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `depositreceived` — Deposit Received | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `foliobalance` — Balance: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Folio / `SUBFOLIOS` — SUBFOLIOS | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `address` — address | Blank-form UI probe only; no saved-profile setter [S12] | No explicit create input / unknown | No explicit setter / unknown | Probe applies only to blank Guest Stay form; no saved-profile proof. |
| Guest / `mobilenumber` — Mobile Number | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `roomtypecharge` — Room Type for Charge | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestnotes` — Guest Notes | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |

### 1B — Record View fields

Record View source fields are observations, not setter proof. `amend` column means a saved-stay Cloud adapter exists for that exact key only where marked [S3b, S6–S9].

| 1B section / key / label | Cloud new-stay draft by same key | Create save | Saved amend | Boundary |
| --- | --- | --- | --- | --- |
| — / `status` — Status: | No explicit setter / unknown | New-record state is fixed; not a create setter [S6] | No explicit setter / unknown |  |
| — / `confirmationnumber` — Confirmation Number: | No explicit setter / unknown | Must be blank for new-stay preimage; HMS assigns confirmation [S6] | No explicit setter / unknown |  |
| — / `externalreference1` — External Reference 1: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `udfchar10` — Wi-Fi Voucher: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `udfchar11` — WIFI Status: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `groupname` — Group: | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| — / `bacontract` — Booking Agency Contract: | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| — / `udfchar02` — Deposit Due Amount Required: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `udfdate02` — Deposit Due Date.: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `depositreceived` — Deposit Received: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `depositreceivedcurrency` — Deposit Received: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `balance` — Balance: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `balancecurr` — Balance: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `lastproperty` — Last Property: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `lastroomoccupied` — Last Room Occupied: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `lastcheckoutdate` — Last Checkout Date : | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `udfchar07` — CMS Form Status: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `udfchkbox04` — CMS Send Mail: | Explicit new-stay send-checkbox setter [S9] | CMS Send must be false; no send capability [S6, S7] | No explicit setter / unknown |  |
| — / `udfchar09` — CMS Message Id: | Explicit new-stay picker and code selection [S9] | No explicit create input/nonblank guard; owner now makes the ID optional [S10 and 2026-11-01 update] | No explicit setter / unknown | The earlier nonblank rule is superseded. Current HRCEN default is unverified; `03` may be a changeable suggestion, never an immutable choice. |
| — / `udfchar13` — CMS Booker Email: | Explicit new-stay text setter [S9] | Guest email / CMS recipient must be blank at create [S6, S7] | No explicit setter / unknown |  |
| — / `revenuevalue` — Lifetime Revenue: | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| — / `revenuedesc` — Lifetime Revenue: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `nightsvalue` — Lifetime Nights: | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| — / `lifetimestays` — Lifetime Stays: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `playernumber` — Loyalty Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `twitterid` — Loyalty Points Balance: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `facebookid` — Legacy Lifestyle Update: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| — / `bookingdotcomid` — New / Existing Member: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `ta1` — Primary Booking Agency: | Explicit new-stay selector [S9] | Optional strict agency proof; no agency save has yet proved either picker-reference case [S6] | No explicit setter / unknown | Selector proof is not agency persistence proof. |
| Stay / `company` — Organization: | Explicit new-stay selector [S9] | Optional strict organization proof; company-only readback exists; agency+company combination unproved [S6, S9] | No explicit setter / unknown | Company-only save read back; agency+company combined save not proved. |
| Stay / `araccountname` — A/R Account: | Explicit new-stay selector [S9] | Must remain blank in current create writer; do not auto-clear [S6] | No explicit setter / unknown |  |
| Stay / `billingreference` — Billing Reference: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `arrivaldate` — Arrival Date: | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| Stay / `arrivaldayofweek` — Arrival Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `nights` — Nights: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `departuredate` — Departure Date: | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| Stay / `departuredayofweek` — Departure Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `adults` — Adults: | Explicit new-stay selector [S9] | Optional strict adult-selection proof; historical selected adult count read back; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `child1` — Child 0 - 02: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `child2` — Child 03 - 12: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `child3` — Child 13 - 17: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `children` — Children: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| Stay / `reasonforstay` — Reason for Stay: | Explicit new-stay selector [S9] | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `sourceofbusinessdesc` — Source Of Business: | Explicit new-stay selector [S9] | Optional strict source proof; description read back, native code readback unsupported [S6, S9] | No explicit setter / unknown |  |
| Stay / `iswalkin` — Walk In: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `ignoreallrestrictions` — Ignore All Restrictions: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `ta1commission` — Commission Percent: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `guaranteetype` — Guarantee Type: | Explicit new-stay selector [S9] | Create restricted to NGI; not a rate code [S6] | No explicit setter / unknown |  |
| Stay / `roomtype` — Room Type: | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| Stay / `roomtypecharge` — Room Type for Charge: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `rateplan` — Rate Plan: | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| Stay / `promotioncode` — Promotion: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `mealplan` — Meal Plan: | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown | Do not infer independent field write from rate-plan selection. |
| Stay / `resortfee` — Resort Fee: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `totalresortfee` — Resort Fee: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `marketsegment` — Market Segment: | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown | Do not infer independent field write from rate-plan selection. |
| Stay / `track` — Track / Sub Segment: | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown | Do not infer independent field write from rate-plan selection. |
| Stay / `confidentialratecb` — Confidential Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `room` — Room: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `donotmove` — Do Not Move: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `donotmovereason` — Do Not Move Reason: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `scheduledroom` — Scheduled Room: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `averagerate` — Average Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `averageratecurr` — Average Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `totalrate` — Total Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `totalratecurr` — Total Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `enhancedexptotal` — Add-On Total: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `enhancedexptotalcurr` — Add-On Total: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `grandtotal` — Grand Total: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `grandtotalcurr` — Grand Total: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `waitlistpriority` — Waitlist Priority: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Stay / `caller` — Booker Name: | Explicit new-stay text setter [S9] | No explicit create input; native model may carry value, but create save not proved for these fields [S6, S9] | Paired Booker amend read back once despite uncertain tool result; nonempty ≤200 chars; cannot clear [S8] | Saved-stay adapter, not a general profile/contact writer. |
| Stay / `udfchar06` — Booker Contact: | Explicit new-stay text setter [S9] | No explicit create input; native model may carry value, but create save not proved for these fields [S6, S9] | Paired Booker amend read back once despite uncertain tool result; nonempty ≤200 chars; cannot clear [S8] | Saved-stay adapter, not a general profile/contact writer. |
| Stay / `reservationnote` — Reservation Note / Billing Instructions: | Explicit new-stay text setter [S9] | Core input; 3 synthetic Labtest notes independently read back [S7] | Labtest note-only amend; fresh readback evidence [S7] | Values were synthetic; no real-guest write. |
| Guest / `guestid` — Profile ID: | Select an explicit current profile ID on the blank draft; saved create is Labtest-only [S6, S9] | Core create input; verified HRCEN Proof Labtest profile only [S6] | No explicit setter / unknown |  |
| Guest / `prefix` — Title: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `lastname` — Last Name: | Explicit new-stay text setter [S9] | Create identity fixed to verified Proof Labtest profile; no arbitrary guest-name write [S6] | No explicit setter / unknown |  |
| Guest / `firstname` — First Name: | Explicit new-stay text setter [S9] | Create identity fixed to verified Proof Labtest profile; no arbitrary guest-name write [S6] | No explicit setter / unknown |  |
| Guest / `viplevel` — VIP Level: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `gender` — Gender: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `phonetypecode` — Phone Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `phonenumber` — Phone Number: | Blank-form UI probe only; no saved-profile setter [S12] | No explicit create input / unknown | No explicit setter / unknown | Probe applies only to blank Guest Stay form; no saved-profile proof. |
| Guest / `mobilenumber` — Mobile Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `emailtypecode` — E-mail Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `emailaddress` — E-mail Address: | Explicit new-stay text setter [S9] | Guest email / CMS recipient must be blank at create [S6, S7] | No explicit setter / unknown |  |
| Guest / `autoemailfolio` — Auto Email Folio: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestoptin1` — Legacy Marketing Opt in: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestoptin2` — Lifestyle Marketing Opt in: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestoptin3` — Legacy Lifestyle Member: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `guestoptin4` — Terms and Conditions: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `language` — Language: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `scannedpassportref` — Scanned Passport Reference: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `passportscanneddate` — Passport Scan Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `addresstypecode` — Address Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `address` — Address: | Blank-form UI probe only; no saved-profile setter [S12] | No explicit create input / unknown | No explicit setter / unknown | Probe applies only to blank Guest Stay form; no saved-profile proof. |
| Guest / `city` — City: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `postalcode` — Postal Code: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `countrydesc` — Country: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `statedesc` — State / Province: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `nationalitydesc` — Nationality: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `countryofresidencedesc` — Country of Residence: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `taxid` — Vat Id: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `vehicle` — Vehicle Reg No.: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `dateofbirth` — Date of Birth: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `turndowntime` — Turndown Time: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Guest / `cleaningtime` — Cleaning Time: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Settlement / `settlementtype` — Settlement Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Settlement / `nopost` — No Post: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `reservationdate` — Reservation Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `canceldate` — Cancellation Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `cancelnumber` — Cancellation Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `cancelreasondesc` — Cancellation Reason: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `thirdpartycancellationnumber` — External Cancellation Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Reservation / `cancellationnote` — Cancellation Note: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Record Details / `updatedby` — Updated By: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Record Details / `updated` — Updated On: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Record Details / `createdby` — Created By: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| Record Details / `created` — Created On: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |

### 1C — Guest Details panel controls

Filter/query controls are not reservation fields. Other panel controls have no profile-form create/amend adapter identified [S3c].

| Surface control signature | Draft create | Create save | Saved amend | Boundary |
| --- | --- | --- | --- | --- |
| — / `dataspylist` / dataspylist / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `filterfields` / filterfields / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `selfiltervaluectrl` / selfiltervaluectrl / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_lastname` / ff_lastname / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_firstname` / ff_firstname / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_arrivaltype_display` / ff_arrivaltype_display / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_arrivaltimenew` / ff_arrivaltimenew / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_departuretype_display` / ff_departuretype_display / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `ff_departuretimenew` / ff_departuretimenew / text | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| — / `showfilter` / Show Filter Row: / checkbox | Not a stay field: query/filter UI | Not a stay field | Not a stay field | Do not treat as an amendable reservation key. |
| Guest Details / `guestid` / Profile ID: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `prefix` / Title: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `lastname` / Last Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `firstname` / First Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `nationality` / Guest Nationality: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `dateofbirth` / Date of Birth: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `birthcity` / Birth City: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `addresstype` / Address Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `streetaddress` / Address: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `city` / City: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `postalcode` / Postal Code: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `countrydesc` / Country: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `statedesc` / State/Province: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `phonetype` / Phone Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `phonenumber` / Phone Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `mobilenumber` / Mobile Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailtype` / Email Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailaddress` / Email Address: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `idnumber` / ID Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `idexpirationdate` / ID Expiration Date : / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailmarketingoptin` / Email Marketing Opt In: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passporttype` / Passport Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportnumber` / Passport Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportname` / Passport Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportissueddate` / Passport Issued Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportexpirationdate` / Passport Expiration Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportnationalitydesc` / Passport Nationality: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `controlsegment` / Control Segment: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `primaryguest` / Primary Guest: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `addupdateprofile` / Add/Update Profile: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `nopost` / No Post: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `guestcategory` / Guest Category: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `guestrelationshipdesc` / Guest Relationship: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `reasonforstay` / Reason for Stay: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `viplevel` / VIP Level: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `countryofresidencedesc` / Country of Residence: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaldate` / Arrival Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaldayofweek` / Arrival Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltype` / Arrival Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltime_h` / Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Arrival Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltime_m` / Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalinformation` / Arrival Information: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalhotel_h` / Hotel Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Hotel Arrival Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalhotel_m` / Hotel Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuredate` / Departure Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuredayofweek` / Departure Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretype` / Departure Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretime_h` / Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Departure Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretime_m` / Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departureinformation` / Departure Information: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurehotel_h` / Hotel Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Hotel Departure Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurehotel_m` / Hotel Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `nextdestination` / Next Destination: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalnotes` / Arrival Notes: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurenotes` / Departure Notes: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idtype` / ID Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `iddescription` / ID Description: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idname` / Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `iddateofbirth` / Date of Birth: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idgender` / Gender: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `issuingcountrydesc` / Passport Issuing Country: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `personalnumber` / Personal Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `gender` / Gender: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visanumber` / Visa Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaname` / Visa Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visatype` / Visa Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visastatus` / Visa Status: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaissueddate` / Visa Issued Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visabegindate` / Visa Begin Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaexpirationdate` / Visa Expiration Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `updatedby` / Updated By: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `updated` / Updated On: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `createdby` / Created By: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `created` / Created On: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |

### Selected Guest Details forms

These are per-guest profile forms, not blank Guest Stay controls. Current stay setters do not establish profile create/update support [S2, S3d].

| Surface control signature | Draft create | Create save | Saved amend | Boundary |
| --- | --- | --- | --- | --- |
| Guest Details / `guestid` / Profile ID: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `prefix` / Title: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `lastname` / Last Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `firstname` / First Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `nationality` / Guest Nationality: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `dateofbirth` / Date of Birth: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `birthcity` / Birth City: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `addresstype` / Address Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `streetaddress` / Address: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `city` / City: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `postalcode` / Postal Code: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `countrydesc` / Country: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `statedesc` / State/Province: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `phonetype` / Phone Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `phonenumber` / Phone Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `mobilenumber` / Mobile Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailtype` / Email Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailaddress` / Email Address: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `idnumber` / ID Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `idexpirationdate` / ID Expiration Date : / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `emailmarketingoptin` / Email Marketing Opt In: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passporttype` / Passport Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportnumber` / Passport Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportname` / Passport Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportissueddate` / Passport Issued Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportexpirationdate` / Passport Expiration Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `passportnationalitydesc` / Passport Nationality: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `controlsegment` / Control Segment: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `primaryguest` / Primary Guest: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `addupdateprofile` / Add/Update Profile: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `nopost` / No Post: / checkbox | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `guestcategory` / Guest Category: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `guestrelationshipdesc` / Guest Relationship: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `reasonforstay` / Reason for Stay: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `viplevel` / VIP Level: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Guest Details / `countryofresidencedesc` / Country of Residence: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaldate` / Arrival Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaldayofweek` / Arrival Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltype` / Arrival Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltime_h` / Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Arrival Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivaltime_m` / Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalinformation` / Arrival Information: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalhotel_h` / Hotel Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Hotel Arrival Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalhotel_m` / Hotel Arrival Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuredate` / Departure Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuredayofweek` / Departure Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretype` / Departure Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretime_h` / Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Departure Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departuretime_m` / Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departureinformation` / Departure Information: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurehotel_h` / Hotel Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / unnamed / Hotel Departure Time: / div | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurehotel_m` / Hotel Departure Time: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `nextdestination` / Next Destination: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `arrivalnotes` / Arrival Notes: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Arrival / Departure Information / `departurenotes` / Departure Notes: / textarea | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idtype` / ID Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `iddescription` / ID Description: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idname` / Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `iddateofbirth` / Date of Birth: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Identification / `idgender` / Gender: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `issuingcountrydesc` / Passport Issuing Country: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `personalnumber` / Personal Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `gender` / Gender: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visanumber` / Visa Number: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaname` / Visa Name: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visatype` / Visa Type: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visastatus` / Visa Status: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaissueddate` / Visa Issued Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visabegindate` / Visa Begin Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Passport / Visa / `visaexpirationdate` / Visa Expiration Date: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `updatedby` / Updated By: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `updated` / Updated On: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `createdby` / Created By: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |
| Record Details / `created` / Created On: / text | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown | Guest Details/profile-form surface; same-name Guest Stay setters do not transfer here. |

### Blank Guest Stay controls

DOM `disabled`/`readOnly` metadata and the synthetic fill+Tab probe do not establish save behavior. Each of 108 keys gets its own row [S4, S6, S9, S12].

| Blank Guest Stay key / label | Draft control | Create save | Saved amend by same key | Boundary |
| --- | --- | --- | --- | --- |
| `status` — (no label captured) | No explicit setter / unknown | New-record state is fixed; not a create setter [S6] | No explicit setter / unknown |  |
| `confirmationnumber` — Confirmation Number: | No explicit setter / unknown | Must be blank for new-stay preimage; HMS assigns confirmation [S6] | No explicit setter / unknown |  |
| `externalreference1` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `udfchar10` — Wi-Fi Voucher: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `udfchar11` — WIFI Status: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `groupname` — (no label captured) | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| `bacontract` — Booking Agency Contract: | No explicit setter / unknown | Must remain blank under current strict create constraints [S6] | No explicit setter / unknown |  |
| `udfchar02` — Deposit Due Amount Required: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `udfdate02` — Deposit Due Date.: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `depositreceived` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `depositreceivedcurrency` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `balance` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `balancecurr` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `lastproperty` — Last Property: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `lastroomoccupied` — Last Room Occupied: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `lastcheckoutdate` — Last Checkout Date : | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `udfchar07` — CMS Form Status: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `udfchkbox04` — CMS Send Mail: | Explicit new-stay send-checkbox setter [S9] | CMS Send must be false; no send capability [S6, S7] | No explicit setter / unknown |  |
| `udfchar09` — CMS Message Id: | Explicit new-stay picker and code selection [S9] | No explicit create input/nonblank guard; owner now makes the ID optional [S10 and 2026-11-01 update] | No explicit setter / unknown | The old nonblank rule is superseded; historical HRDAV was blank, and the current HRCEN default remains unverified [S10]. |
| `udfchar13` — CMS Booker Email: | Explicit new-stay text setter [S9] | Guest email / CMS recipient must be blank at create [S6, S7] | No explicit setter / unknown |  |
| `revenuevalue` — (no label captured) | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| `revenuedesc` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `nightsvalue` — Lifetime Nights: | No explicit setter / unknown | Read-only strict-proof constraint, not setter; later historical strict-path create readback exists; execution SHA unrecorded [S6] | No explicit setter / unknown |  |
| `lifetimestays` — Lifetime Stays: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `playernumber` — Loyalty Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `twitterid` — Loyalty Points Balance: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `facebookid` — Legacy Lifestyle Update: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `bookingdotcomid` — New / Existing Member: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `ta1` — (no label captured) | Explicit new-stay selector [S9] | Optional strict agency proof; no agency save has yet proved either picker-reference case [S6] | No explicit setter / unknown | Selector result alone is not save proof. |
| `company` — (no label captured) | Explicit new-stay selector [S9] | Optional strict organization proof; company-only readback exists; agency+company combination unproved [S6, S9] | No explicit setter / unknown | Selector result alone is not save proof. |
| `araccountname` — (no label captured) | Explicit new-stay selector [S9] | Must remain blank in current create writer; do not auto-clear [S6] | No explicit setter / unknown |  |
| `billingreference` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `arrivaldate` — (no label captured) | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| `arrivaldayofweek` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `nights` — Nights: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `departuredate` — (no label captured) | Explicit new-stay date setter [S9] | Core create input; HRCEN Labtest dates must be 2027+ [S6, S7] | No explicit setter / unknown |  |
| `departuredayofweek` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `adults` — Adults: | Explicit new-stay selector [S9] | Optional strict adult-selection proof; historical selected adult count read back; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| `child1` — Child 0 - 02: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| `child2` — Child 03 - 12: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| `child3` — Child 13 - 17: | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| `children` — (no label captured) | Child-age editor derives count/bands from age array [S9] | Optional strict age-array proof; historical count/bands read back, not exact ages; later historical strict-path create readback exists; execution SHA unrecorded [S6, S9] | No explicit setter / unknown |  |
| `reasonforstay` — Reason for Stay: | Explicit new-stay selector [S9] | No explicit create input / unknown | No explicit setter / unknown |  |
| `sourceofbusinessdesc` — Source Of Business: | Explicit new-stay selector [S9] | Optional strict source proof; description read back, native code readback unsupported [S6, S9] | No explicit setter / unknown |  |
| `iswalkin` — Walk In: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `ignoreallrestrictions` — Ignore All Restrictions: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `ta1commission` — Commission Percent: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `guaranteetype` — Guarantee Type: | Explicit new-stay selector [S9] | Create restricted to NGI; not a rate code [S6] | No explicit setter / unknown |  |
| `roomtype` — (no label captured) | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| `roomtypecharge` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `rateplan` — (no label captured) | Explicit new-stay selector [S9] | Core create input; synthetic Labtest readback exists; no saved amend [S6, S7] | No explicit setter / unknown |  |
| `promotioncode` — Promotion: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `mealplan` — (no label captured) | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown |  |
| `resortfee` — Resort Fee: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `totalresortfee` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `marketsegment` — Market Segment: | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown |  |
| `track` — (no label captured) | May change through rate selection; no direct setter [S9] | No explicit create input; may be pinned or changed by rate-selection side effects [S6, S9] | No explicit setter / unknown |  |
| `confidentialratecb` — Confidential Rate: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `room` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `donotmove` — Do Not Move: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `donotmovereason` — Do Not Move Reason: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `scheduledroom` — Scheduled Room: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `averagerate` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `averageratecurr` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `totalrate` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `totalratecurr` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `enhancedexptotal` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `enhancedexptotalcurr` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `grandtotal` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `grandtotalcurr` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `waitlistpriority` — Waitlist Priority: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `caller` — Booker Name: | Explicit new-stay text setter [S9] | No explicit create input; native model may carry value, but create save not proved for these fields [S6, S9] | Paired Booker amend read back once despite uncertain tool result; nonempty ≤200 chars; cannot clear [S8] | Saved amendment applies only to existing Labtest Record View [S8]. |
| `udfchar06` — Booker Contact: | Explicit new-stay text setter [S9] | No explicit create input; native model may carry value, but create save not proved for these fields [S6, S9] | Paired Booker amend read back once despite uncertain tool result; nonempty ≤200 chars; cannot clear [S8] | Saved amendment applies only to existing Labtest Record View [S8]. |
| `reservationnote` — Reservation Note / Billing Instructions: | Explicit new-stay text setter [S9] | Core input; 3 synthetic Labtest notes independently read back [S7] | Labtest note-only amend; fresh readback evidence [S7] | Saved amendment applies only after a stay exists; Labtest readback is separate evidence [S7]. |
| `guestid` — (no label captured) | Select an explicit current profile ID on the blank draft; saved create is Labtest-only [S6, S9] | Core create input; verified HRCEN Proof Labtest profile only [S6] | No explicit setter / unknown |  |
| `prefix` — Title: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `lastname` — (no label captured) | Explicit new-stay text setter [S9] | Create identity fixed to verified Proof Labtest profile; no arbitrary guest-name write [S6] | No explicit setter / unknown |  |
| `firstname` — First Name: | Explicit new-stay text setter [S9] | Create identity fixed to verified Proof Labtest profile; no arbitrary guest-name write [S6] | No explicit setter / unknown |  |
| `viplevel` — VIP Level: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `gender` — Gender: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `phonetypecode` — Phone Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `phonenumber` — Phone Number: | Guarded UI fill+Tab accepted; no Cloud setter [S12] | No explicit create input / unknown | No explicit setter / unknown | No mutating HTTP request or save observed; no Cloud setter or persistence proof [S12]. |
| `mobilenumber` — Mobile Number: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `emailtypecode` — E-mail Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `emailaddress` — E-mail Address: | Explicit new-stay text setter [S9] | Guest email / CMS recipient must be blank at create [S6, S7] | No explicit setter / unknown |  |
| `autoemailfolio` — Auto Email Folio: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `guestoptin1` — Legacy Marketing Opt in: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `guestoptin2` — Lifestyle Marketing Opt in: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `guestoptin3` — Legacy Lifestyle Member: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `guestoptin4` — Terms and Conditions: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `language` — Language: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `scannedpassportref` — Scanned Passport Reference: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `passportscanneddate` — Passport Scan Date: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `addresstypecode` — Address Type: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `address` — (no label captured) | Guarded UI fill+Tab accepted; no Cloud setter [S12] | No explicit create input / unknown | No explicit setter / unknown | No mutating HTTP request or save observed; no Cloud setter or persistence proof [S12]. |
| `city` — City: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `postalcode` — Postal Code: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `countrydesc` — Country: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `statedesc` — State / Province: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `nationalitydesc` — Nationality: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `countryofresidencedesc` — Country of Residence: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `taxid` — Vat Id: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `vehicle` — Vehicle Reg No.: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `dateofbirth` — Date of Birth: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `turndowntime` — Turndown Time: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `cleaningtime` — Cleaning Time: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `settlementtype` — (no label captured) | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |
| `nopost` — No Post: | No explicit setter / unknown | No explicit create input / unknown | No explicit setter / unknown |  |

### Fieldwise evidence boundary

- `reservationnote`: three created fake stays had independently read-back synthetic notes; a separate note-only Labtest amendment also had fresh readback [S7].
- `caller` / `udfchar06`: paired Booker update was read back once despite an uncertain tool outcome. Inputs must be nonempty and ≤200 characters; clearing is unsupported. Nonblank-party preservation is not live-proved [S8].
- `ta1` / `company`: selection and strict create proof are not identical to saved proof. Company-only readback exists; agency-only and combined agency+company cases remain unproved [S6, S9].
- `address` / `phonenumber`: only local blank-form fill+Tab acceptance; no Cloud setter, save, or existing-profile edit proof [S12].
- `udfchar09`: the historical nonblank rule was superseded by the 2026-11-01 owner update above. The historical HRDAV draft default was blank; current HRCEN default is unverified. The current create contract has no explicit CMS Message Id input. Support an optional choice and changeable 03 suggestion without sending [S10].

## Further claim checks

### Create and amend capability, not just field presence

| Field family | Current Cloud draft capability | Current Cloud save / amend boundary and gap |
| --- | --- | --- |
| Names, guest identity and profile | Search current guest candidates and select a verified profile; first/last name text setters exist. | Create requires the exact Proof Labtest profile. No general guest-profile creation or profile identity amendment is established. |
| Address, phone, mobile, other profile data | Visible in blank form and saved readers; profile search uses several fields. One guarded blank-form probe accepted synthetic `address` and `phonenumber` after fill+Tab. | No explicit Cloud address/phone setter or save/readback proof. Probe does not establish shared-profile ownership or saved-record editability. Do not silently discard these fields. |
| Guest email, Booker and CMS | Draft setters cover guest email, Booker name/contact, CMS recipient, CMS message ID and send checkbox. | Labtest create requires guest email and CMS recipient blank and CMS send off. Saved Labtest Booker name/contact amendment exists; one historical paired change persisted on independent readback even though the tool outcome was uncertain. No general contact/profile or CMS saved-write capability is established. |
| Dates and occupancy | Arrival/departure setters, adult selector, and child-age editor exist. The editor derives child count and age bands from an explicitly supplied age array. | Dates and selected occupancy appear in historical Labtest create readback; exact child ages are not independently visible in the saved reader. No saved date or occupancy amendment tool. Unknown ages are not zero children. |
| Room, rate, meal and pricing | Current room-type/rate-plan selection exists; rate selection can change meal plan, market segment and track. A separate 612-stay source cohort contains multiple plans with different source mixes. | Room type and rate are narrow Labtest create inputs, not a global rate rule. No saved room/rate/price amendment is established. Charge room type, assigned room, override and repricing need separate classification. Do not repeat the held room-amend probe [S11]. |
| Agency, organization and A/R | Three separate current lookup/select capabilities exist. | Strict create accepts verified agency and/or organization selections. A historical company-linked fake create was read back; agency plus company remains unproved. A/R must be blank in the current create writer, not automatically cleared. No general party-link amendment is established. |
| Guarantee, deposit and settlement | Guarantee choices can be selected on a guarded unsaved Labtest draft; deposit and settlement controls appear in the inventory. | Create requires `NGI`, a **guarantee type**, not a rate; other guarantee types are rejected by the current writer. No general deposit, settlement or guarantee amendment is established. |
| Source, reason, billing and note | Source selector and reason dropdown exist; draft reservation-note setter exists. Billing reference and other controls are visible. | Source was present in a historical create readback. Note is a create input and has historical saved Labtest amend proof. No independent billing-reference or reason-for-stay saved write is established. |
| Other controls | Promotion, external reference, stay flags, CMS, opt-ins, arrival/departure details and selected guest forms appear in the inventory. | No blanket write support is established. Determine ownership, permissions, coupled changes, and whether each is relevant to create or amend before designing a setter. Read-only, derived, restricted and unsupported are distinct outcomes. |

Sources: [Cloud draft controls](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-form.md#L10-L29), [Cloud create inputs and proof](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.md#L13-L44), [create guard](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.mjs#L416-L433), [saved note](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-amend.md#L15-L42), [saved Booker controls](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-amend-contact.md#L1-L8), and [historical proof chronology](2026-11-01-hms-17h-retro.md#L13-L19). Whole-form serialization can include unnamed fields: absence of an explicit setter means no deliberate, independently proved operation, not proof a value is absent from the native request.

### Corrections, counterevidence and decisions to investigate

**CMS Message Id history and current direction.** The 2026-10-28 owner rule said CMS Message Id must never be blank on a Nava create; that read-only HRDAV probe recorded a blank new-record default. The owner superseded the nonblank requirement on 2026-11-01: the checkbox, message ID and recipient are optional, with `03` allowed as a changeable default. Centurion screenshots were reported to show the same six options, but the current HRCEN default remains unverified. Current Cloud create does not expose an explicit CMS Message Id input. No direction authorizes sending [S10, S6].

| Historical option | Picker label | Historical use note |
| --- | --- | --- |
| `01` | Booking Confirmation for Guest (with Payment link) | Guest-direct booking |
| `012` | Confirmation of payment for Guest | Payment proof; later workflow |
| `014` | Confirmation of payment for Agency or Organization | Payment proof; later workflow |
| `03` | Booking Confirmation for Agency or Organization (with Payment link and Proforma) | HRDAV Faith used as default; not a universal Centurion default |
| `05` | Online check-in | Not a booking letter |
| `08` | Booking Confirmation for Agency or Organization — NO RATE | Agency booking where rate must not show |

These labels come from the historical HRDAV picker lookup; no save occurred. Another 612-stay cohort shows rate plans and CMS choices vary by source; neither code nor plan should be hard-coded from global frequency [S10, S11].

- **CMS 03:** `840/892` selected records carried code 03; 52 carried other codes. A separate 612-stay source cohort had CMS 03 on 576/612, 01 on 31, and 014 on five, with source mix variation. The owner now permits 03 as a changeable default; do not hide other options or require a code. Verify the current picker and keep sending off [inventory §3](#3-cross-field-checks-on-the-892-saved-records), [source cohort](memory-experiments/2026-10-30-source-cohort-and-cloud-tool-design.md#L42-L55).
- **Current strict create versus later proofs:** [the create documentation](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.md#L100-L113) records a refused full-body attempt and says that path had not yet been dispatched. [Later run records](2026-10-31-hms-coverage-run.md#L971-L974) and [company readback](2026-10-31-hms-coverage-run.md#L992-L1002) document successful fake creates after the refusal. The exact execution SHA for those runs was not recorded. The failed `revenuevalue` contents were not captured, so its specific cause remains unknown; do not claim a serialization fix or present the older documentation as current proof status.
- **Guard design:** The current strict path pins 985 observed native model keys and matches the full request. This can make harmless read-only or derived-field drift a potential operational blocker, but unknown keys can also carry side effects. Preserve identity, explicit authorization, intended changes, send suppression, one-request fencing and independent readback; classify fields before considering any narrower boundary. Do not bypass safety just because a caller promises the operation is safe. [Create guard](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.md#L73-L98).
- **Children:** The 892-record snapshot has 868 stays with zero children, 16 with one, and 8 with two; ages 0–2/3–12/13–17 are populated in 10/12/3 records, with overlap. Selected snapshot, not prevalence or omission evidence [S15]. Extraction preserves child count separately from age knowledge. One booking prefill checks for unknown ages, but a separate [booking-card helper](../../../apps/mail/components/quote-workflow/booking-card.tsx#L739-L752) can prefer an empty ages array and [pane binding](../../../apps/mail/lib/quote-workflow/pane-stay-bind.ts#L342-L369) omits empty ages. Counterevidence: the unquoted booking-draft route rejects `childAges === null` before building prefill [route](../../../apps/server-pilot/src/trpc/routes/workstation.ts#L1078-L1092). Helper reachability through every path and any live impact remain unverified; **no production incident is established**. Preserve explicit zero, known count with unknown ages, and known ages as distinct states.
- **Partial quote information:** The older staff BAR-board projection computes an average from only positive observed prices and a minimum from observed non-null stock, without carrying requested-night completeness. It can therefore show a subset as an unlabeled stay summary. [Projection](../../../apps/server-pilot/src/ai/hms-availability.ts#L556-L593). Its separate [sellable-card check](../../../apps/server-pilot/src/ai/rate-options.ts#L65-L70) requires complete nightly data and other eligibility checks. Current [Cloud availability view](../../../apps/server-pilot/tooling/hms-cloud/availability-view.mjs#L234-L277) already retains nightly counts, price, restriction reasons and context; check actual Cloud output and staff wiring before adding duplicate tooling. Display useful known nights and coverage. An observed stock minimum may be shown as such, not as a verified full-stay minimum; missing values are not zero or sold out. Preserve an observed zero price as evidence without asserting it is a valid bookable price.
- **Background work:** A queued quote path and later source-bound job readback exist in [the workstation route](../../../apps/server-pilot/src/trpc/routes/workstation.ts#L945-L1005) and [pane readback](../../../apps/mail/components/nava-pane/nava-pane.tsx#L1081-L1165); the browser poll stops on cleanup. Cloud quote snapshot handles are page-scoped and deleted when that page closes [snapshot lifecycle](../../../apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs#L306-L316). A private snapshot file exists separately, but cross-session recovery/wiring is not proved. Current flags and live continuity after navigation remain unverified; do not claim durable cross-session recovery. A later design should let staff leave and return to result, not require watching a spinner.
- **Finance and documents:** Record View and shallow Folio cards contain displayed money, while [finance preparation](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-finance-preflight.mjs#L1-L40) is a projection of those reads, not another ledger call. [Cloud document reading](../../../apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs#L1-L73) lists loaded-node metadata, not bytes or upload. A typed folio reader also exists but live access and transaction completeness need verification. A generic Cloud document uploader is a separate potential capability; legacy uploader is inspiration only. Voucher and proof-of-payment intake/OCR remain parked in [the to-do](2026-11-01-hms-tooling-parked-items.md#ocr-pop-extraction-and-intake-triage).
- **Multi-room:** 24 same-profile/date clusters spanning 61 records with different rooms are a useful Centurion pilot signal. They are not proof of association or a population rate. The owner accepted a bounded pilot in the new plan. Historical HRDAV linked-room evidence is reference only; build any new capability for the Cloud UI and do not rerun the held association probe. [Evidence](2026-11-01-hms-tooling-parked-items.md#multi-room-booking).
- **Amend priorities:** In 223 heuristic thread/action candidates, 17 mentioned added nights, 67 people/occupancy and 5 both. These counts are not human-verified prevalence, but they support investigating dates, occupancy, room allocation, price effects and correct stay matching, not treating note amendment as the whole workflow. [Amend study](../2026-10-20-arch-lanes/l2-amend-payment.md#L5-L24).

### Remaining discovery, not an implementation plan

1. Compare saved Labtest Record View and relevant blank-draft controls for reservation-field affordances, dependencies and write effects. Existing reader captures alone do not establish this. Shared-profile creation and amendment are outside the current pass.
2. Use representative unsaved interactions only where they answer a real reservation control-family question. Do not silently change a shared profile, save a reservation or repeat either previously held probe during this research.
3. Map each meaningful field to its real create/amend workflow, available Cloud reader/setter and evidence level. Do not equate a DOM flag with persistence or treat every system-derived value as staff-editable.
4. When a future write is authorized, use a small number of representative Labtest proofs with fresh readback, expanding only for materially different behavior or safety boundaries. Prior success does not establish current HEAD or every combination.
5. Check current Cloud-to-pane wiring, partial-result recovery and folio role access before proposing duplicate tools. Both Outlook pane and webmail need any later staff-facing capability.

These are research gaps and possible follow-up checks, not authorization to implement, save, deploy or change flags. Existing functionality remains intact; old Playwright tools are read-only historical references, not implementation targets.
