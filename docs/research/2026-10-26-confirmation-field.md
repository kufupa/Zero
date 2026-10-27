# Which HMS field drives the confirmation letter (E0)

Live HRDAV Guest Stay, 2026-10-27 00:50–01:27Z. Labtest only. No Email/Send click. No guest addresses in this file.

**Answer: Save does not auto-mail** (no confirmation observed within 15 minutes; POP3 ingest can lag). Filling Guest Stay `emailaddress` with the Nava collector and saving a Labtest stay produced 0 inbound on `transport-nava` and 0 Da Vinci outbound confirmation in that window. Automatic sending beyond 15 min is unverified.

## Method

1. Offline fixture `apps/server-pilot/tooling/playwright-quote/fixtures/stay-lookup/record-form-live.html` (121 named inputs).
2. Read-only New Record DOM dump on live HRDAV (166 named inputs; values as shapes only). CRS Confirm-to-Email was not on this screen; not opened (CRS Check Availability creates a stay; Confirm-to-Email is a send).
3. One Labtest create from a `/tmp` copy of `create-lab-stay.mjs` (`--property HRDAV --pane-commit`). After `optionalPartyAndNoteFills`, the copy called `fillNamed(page, 'emailaddress', collector)` once (committed script has no `emailaddress` fill). Only that field got the `transport-nava` collector (domain `legacyhotels.co.za`, length 25). Other email fields left blank. `udfchkbox04` CMS Send Mail left unchecked. Fill ran before Save.
4. Read-only find of the saved stay. Prod SQL read-only: inbound on `transport-nava` and outbound on `transport-davinci` from 01:11Z, subject class / confirmation-id presence only.

Stay left Reserved for F3 cancel after deploy: confirmation `13201076-1`, arrival 2027-07-22, STKNG BAR, status Reserved, lastName Labtest.

## Candidates (D2: keep unused)

| name | label | type | max | New Record | After Save (13201076-1) | Role |
|---|---|---|---|---|---|---|
| `emailaddress` | E-mail Address: | text | 255 | empty | email-like:25 (stuck) | Guest email. Filled this run. |
| `emailtypecode` | E-mail Type: | combobox | — | empty | text:7 (HMS default; not typed) | Type beside address. |
| `udfchar06` | Booker Contact: | text | 80 | empty | empty | What `create-request.mjs` writes from `bookerEmail` (LIVE-UNVERIFIED). Not filled. |
| `udfchar13` | CMS Booker Email: | text | 80 | empty | empty | CMS recipient. Not filled. |
| `udfchkbox04` | CMS Send Mail: | checkbox | — | unchecked | unchecked | Send trigger. Not clicked (send). |
| `autoemailfolio` | Auto Email Folio: | checkbox | — | absent on New Record | absent | Folio, not confirmation. Fixture-only. |
| `caller` | Booker Name: | text | 50 | empty | empty | Name, not mail. |
| `ff_emailaddress` | (filter row) | text | — | empty | — | Find-filter. Unused in UI. |
| CRS Confirm-to-Email | Infor CRS wrap-up | — | — | not visible | not opened | Separate send/create path. |

`create-lab-stay` today maps `bookerEmail` → `udfchar06` only. It does not write `emailaddress` or `udfchar13`.

## Create

| | |
|---|---|
| When | 2026-10-27 01:08–01:11Z, 156 s |
| Outcome | `committed` `13201076-1`, `clickedSave` true, `statusAfterSave` Reserved, `readbackMatch` true |
| Fill | `emailaddress` = transport-nava collector. No `bookerEmail`. CMS Send Mail unchecked. |
| Misses | (1) `pane_save_market_segment_required` until request set `marketSegment` = Best Available Rate and `guestoptin4` true. (2) 2027-11-18 BAR `Rate is not available.` Then 2027-07-22. |

## Mail watch (15 min)

Create finished 01:11:32Z. Queries `BEGIN READ ONLY` / `ROLLBACK`.

| Window | transport-nava inbound | davinci outbound | confirm-like / conf `13201076` in subject |
|---|---:|---:|---|
| 01:12Z | 0 | — | — |
| 01:19Z | 0 | — | — |
| 01:27Z | 0 | 0 | 0 / 0 |

POP3 ingest can lag past 15 min; this run used the brief's window. No hotel-mailbox confirmation copy appeared either.

## Implication for E2

- `emailaddress` is the guest email field and **sticks** after Save. This run did not prove it routes the confirmation letter. `udfchar13` (CMS Booker Email) was not filled. Letter-routing field stays unresolved until delivery is shown.
- Do **not** treat Save as sending a letter.
- `udfchkbox04` CMS Send Mail is the on-form send control; checking it is a send. Plan 007 dropped Email/Send clicks. Letter send stays a separate approved action (or staff forwards).
- CRS Confirm-to-Email is not on Guest Stay New Record.

## Appendix A — live New Record inventory (all 166; D2)

vis = Y visible / n not. valueShape never holds an address. Labels blank when ExtJS had no `label[for]`.

| vis | name | type | valueShape | max | label |
|---|---|---|---|---|---|
| Y | `search` | text | empty | - |  |
| Y | `dataspylist` | text | text:4 | - |  |
| Y | `filterfields` | text | code | - |  |
| Y | `selfiltervaluectrl` | text | empty | - |  |
| Y | `ff_mobilenumber` | text | empty | - |  |
| Y | `ff_phonenumber` | text | empty | - |  |
| n | `ff_guestoptin3` | hidden | empty | - |  |
| Y | `ff_room` | text | empty | - |  |
| Y | `ff_lastname` | text | empty | - |  |
| Y | `ff_firstname` | text | empty | - |  |
| Y | `ff_confirmationnumber` | text | empty | - |  |
| Y | `ff_arrivaldate` | text | empty | - |  |
| Y | `ff_departuredate` | text | empty | - |  |
| Y | `ff_nights` | text | empty | 55 |  |
| Y | `ff_roomtype` | text | empty | - |  |
| Y | `ff_rateplan` | text | empty | - |  |
| Y | `ff_status` | text | empty | - |  |
| Y | `ff_adults` | text | empty | 55 |  |
| Y | `ff_children` | text | empty | 55 |  |
| Y | `ff_viplevel_display` | text | empty | - |  |
| Y | `ff_balance` | text | empty | 55 |  |
| Y | `ff_ta1` | text | empty | - |  |
| Y | `ff_company` | text | empty | - |  |
| Y | `ff_totalrate` | text | empty | 55 |  |
| Y | `ff_groupname` | text | empty | - |  |
| Y | `ff_udfchar01` | text | empty | - |  |
| Y | `ff_araccountname` | text | empty | - |  |
| n | `ff_preferencesflag` | hidden | empty | - |  |
| n | `ff_isshared` | hidden | empty | - |  |
| n | `ff_undeliveredmessages` | hidden | empty | - |  |
| Y | `ff_createdon` | text | empty | - |  |
| n | `ff_guestoptin2` | hidden | empty | - |  |
| Y | `ff_loyaltylevel_display` | text | empty | - |  |
| Y | `ff_loyaltynumber` | text | empty | - |  |
| Y | `ff_emailaddress` | text | empty | - |  |
| Y | `ff_guestid` | text | empty | 55 |  |
| Y | `ff_updatedon` | text | empty | - |  |
| Y | `showfilter` | button | unchecked | - | Show Filter Row: |
| Y | `status` | text | code | 50 |  |
| Y | `confirmationnumber` | text | empty | 50 | Confirmation Number: |
| Y | `externalreference1` | text | empty | 50 |  |
| Y | `bacontract` | text | empty | 100 | Booking Agency Contract: |
| Y | `udfchar10` | text | empty | 80 | Wi-Fi Voucher: |
| Y | `udfchar11` | text | empty | 80 | WIFI Status: |
| Y | `groupname` | text | empty | 100 |  |
| Y | `udfchar01` | text | empty | 80 | Ind. Group: |
| Y | `udfchar03` | text | empty | 80 | Deposit Due Amount Required: |
| Y | `udfdate03` | text | empty | - | Deposit Due Date.: |
| Y | `depositreceived` | text | empty | 55 |  |
| Y | `depositreceivedcurrency` | text | empty | 10 |  |
| Y | `balance` | text | empty | 55 |  |
| Y | `balancecurr` | text | empty | 10 |  |
| Y | `lastproperty` | text | empty | - | Last Property: |
| Y | `lastroomoccupied` | text | empty | - | Last Room Occupied: |
| Y | `lastcheckoutdate` | text | empty | - | Last Checkout Date : |
| Y | `settlementtype` | text | empty | 6 |  |
| Y | `udfchar07` | text | empty | 80 | CMS Form Status: |
| Y | `udfchkbox04` | button | unchecked | - | CMS Send Mail: |
| Y | `udfchar09` | text | empty | 80 | CMS Message Id: |
| Y | `udfchar13` | text | empty | 80 | CMS Booker Email: |
| Y | `revenuevalue` | text | empty | 55 |  |
| Y | `revenuedesc` | text | empty | 10 |  |
| Y | `nightsvalue` | text | empty | 55 | Lifetime Nights: |
| Y | `lifetimestays` | text | empty | - | Lifetime Stays: |
| Y | `playernumber` | text | empty | - | Loyalty Number: |
| Y | `twitterid` | text | empty | 32 | Loyalty Points Balance: |
| Y | `facebookid` | text | empty | 32 | Legacy Lifestyle Update: |
| Y | `bookingdotcomid` | text | empty | 32 | New / Existing Member: |
| Y | `ta1` | text | empty | 100 |  |
| Y | `company` | text | empty | 100 |  |
| Y | `araccountname` | text | empty | 100 |  |
| Y | `billingreference` | text | empty | 50 | Billing Reference: |
| Y | `arrivaldate` | text | date | - |  |
| Y | `arrivaldayofweek` | text | code | - |  |
| Y | `nights` | text | digits | 55 | Nights: |
| Y | `departuredate` | text | date | - |  |
| Y | `departuredayofweek` | text | code | - |  |
| Y | `adults` | text | digits | - | Adults: |
| Y | `child1` | text | digits | - | Child 0 - 02: |
| Y | `child2` | text | digits | - | Child 03 - 12: |
| n | `child3` | text | digits | - | Child 13 - 17: |
| Y | `children` | text | empty | - |  |
| n | `child5` | text | empty | - | Child 5: |
| n | `child6` | text | empty | - | Child 6: |
| Y | `reasonforstay` | text | empty | - | Reason for Stay: |
| Y | `sourceofbusinessdesc` | text | empty | - | Source Of Business: |
| n | `grouprateschedulecode` | text | empty | 15 | Group Rate Plan: |
| Y | `ignoreallrestrictions` | button | unchecked | - | Ignore All Restrictions: |
| Y | `ta1commission` | text | empty | 55 | Commission Percent: |
| Y | `bookingagency1iatanumber` | text | empty | - | IATA Number: |
| Y | `leasenumber` | text | empty | 100 | Lease: |
| Y | `leasestartdate` | text | empty | - | Lease Start Date: |
| Y | `leaseenddate` | text | empty | - | Lease End Date: |
| Y | `guaranteetype` | text | empty | - | Guarantee Type: |
| Y | `roomtype` | text | empty | 50 |  |
| Y | `roomtypecharge` | text | empty | 50 |  |
| Y | `rateplan` | text | empty | 50 |  |
| Y | `promotioncode` | text | empty | - | Promotion: |
| Y | `mealplan` | text | empty | 50 |  |
| Y | `totalresortfee` | text | empty | 55 |  |
| Y | `marketsegment` | text | empty | - | Market Segment: |
| Y | `track` | text | empty | 80 |  |
| Y | `confidentialratecb` | button | unchecked | - | Confidential Rate: |
| Y | `room` | text | empty | 12 |  |
| Y | `donotmove` | button | unchecked | - | Do Not Move: |
| Y | `donotmovereason` | text | empty | - | Do Not Move Reason: |
| Y | `scheduledbuilding` | text | empty | - | Scheduled Building: |
| Y | `averagerate` | text | empty | 55 |  |
| Y | `averageratecurr` | text | empty | 10 |  |
| Y | `totalrate` | text | empty | 55 |  |
| Y | `totalratecurr` | text | empty | 10 |  |
| Y | `enhancedexptotal` | text | empty | 55 |  |
| Y | `enhancedexptotalcurr` | text | empty | 10 |  |
| Y | `grandtotal` | text | empty | 55 |  |
| Y | `grandtotalcurr` | text | empty | 10 |  |
| Y | `waitlistpriority` | text | empty | 55 | Waitlist Priority: |
| Y | `caller` | text | empty | 50 | Booker Name: |
| Y | `udfchar06` | text | empty | 80 | Booker Contact: |
| n | `guesttotalwithtaxcurr` | text | empty | 10 |  |
| Y | `reservationnote` | textarea | empty | 2000 | Reservation Note / Billing Instructions: |
| Y | `guestid` | text | empty | 55 |  |
| Y | `prefix` | text | empty | - | Title: |
| Y | `lastname` | text | empty | 50 |  |
| Y | `firstname` | text | empty | 50 | First Name: |
| Y | `viplevel` | text | empty | - | VIP Level: |
| Y | `phonetypecode` | text | empty | - | Phone Type: |
| Y | `phonenumber` | text | empty | 50 | Phone Number: |
| Y | `mobilenumber` | text | empty | 50 | Mobile Number: |
| Y | `emailtypecode` | text | empty | - | E-mail Type: |
| Y | `emailaddress` | text | empty | 255 | E-mail Address: |
| Y | `guestoptin1` | button | unchecked | - | Legacy Marketing Opt in: |
| Y | `guestoptin2` | button | unchecked | - | Lifestyle Marketing Opt in: |
| Y | `guestoptin3` | button | unchecked | - | Legacy Lifestyle Member: |
| Y | `guestoptin4` | button | unchecked | - | Terms and Conditions: |
| Y | `language` | text | code | - | Language: |
| Y | `scannedpassportref` | text | empty | 50 | Scanned Passport Reference: |
| Y | `passportscanneddate` | text | empty | - | Passport Scan Date: |
| Y | `scannedvisaref` | text | empty | 50 | Visa Reference: |
| Y | `visascanneddate` | text | empty | - | Visa Scan Date: |
| Y | `addresstypecode` | text | empty | - | Address Type: |
| Y | `address` | textarea | empty | 400 |  |
| Y | `city` | text | empty | 50 | City: |
| Y | `postalcode` | text | empty | 20 | Postal Code: |
| Y | `countrydesc` | text | empty | 100 | Country: |
| Y | `statedesc` | text | empty | 50 | State / Province: |
| Y | `nationalitydesc` | text | empty | 100 | Nationality: |
| Y | `countryofresidencedesc` | text | empty | 100 | Country of Residence: |
| Y | `vehicle` | text | empty | 50 | Vehicle Reg No.: |
| Y | `dateofbirth` | text | empty | - | Date of Birth: |
| Y | `cleaningtime` | text | empty | - | Cleaning Time: |
| Y | `turndowntime` | text | empty | - | Turndown Time: |
| Y | `rewardsprogram` | text | empty | 6 | Rewards Program: |
| Y | `rewardsnumber` | text | empty | 50 | Rewards Number: |
| Y | `guestnotes` | textarea | empty | 255 | Notes: |
| Y | `nopost` | button | unchecked | - | No Post: |
| Y | `reservationdate` | text | empty | - | Reservation Date: |
| Y | `canceldate` | text | empty | - | Cancellation Date: |
| Y | `cancelnumber` | text | empty | 50 | Cancellation Number: |
| Y | `cancelreasondesc` | text | empty | 80 | Cancellation Reason: |
| Y | `thirdpartycancellationnumber` | text | empty | 50 | External Cancellation Number: |
| Y | `cancellationnote` | textarea | empty | 2000 | Cancellation Note: |
| Y | `updatedby` | text | empty | 150 | Updated By: |
| Y | `updated` | text | empty | - | Updated On: |
| Y | `createdby` | text | empty | 150 | Created By: |
| Y | `created` | text | empty | - | Created On: |
| Y | `appmenusearch` | text | empty | - |  |


## Appendix B — fixture vs live

Fixture `record-form-live.html` (opened stay, 121 names) already had `emailaddress`, `emailtypecode`, `udfchar06`, `udfchar13` (CMS Booker Email), `udfchkbox04` (CMS Send Mail), and `autoemailfolio`. Live New Record omitted `autoemailfolio`.

## Sources

- Plan D4 / Grok P0: dump all fields; one Labtest create; no Email click.
- `create-request.mjs` `udfchar06: stay.bookerEmail`.
- Infor Confirm-to-Email: distinct CRS send, not Guest Stay Save.
- Stay `13201076-1` left Reserved for F3.
