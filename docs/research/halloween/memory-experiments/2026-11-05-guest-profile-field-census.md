# Guest-profile field census and creation shortlist

Observed 5 November 2026, HRCEN. Read-only investigation; no native guest Saves, field writes or UI changes. Scope: extend the existing master reader, compare reservation views and message evidence, investigate available history, then choose the next creation fields.

## Recommendation

Keep the existing core creator. Today's blank native New Profile requires **surname, first name, mobile and status**. The creator already stages these, ACTIVE status and optional email. Historical profiles without a mobile are readable records; they do not establish that today's New form accepts a blank mobile.

The next small extension should be **optional title**, resolved from current native options and supplied explicitly. Then consider **additional phone with phone type** and **email type**, where the current request establishes the guest contact and its role. This census establishes field presence and native controls; each extension still needs unsaved preparation and its own authorized Labtest Save/readback before it becomes supported.

Do not automatically add every demographic, address, identity or loyalty control. Preserve supplied guest details, but never derive title/gender from a name, copy a requester's signature into the guest profile, or use a repeated email address as proof of identity. DOB, nationality/residence, address and ID/passport are candidates for explicit supplied-field support, with booking versus later profile maintenance still unresolved. Keep profile notes separate from reservation billing instructions.

## What existed, and what changed

The earlier corpus contains **894 lookup attempts, 892 successful reservation snapshots and 779 distinct primary profile IDs**. Those IDs are records, not a deduplicated person count. The snapshots captured Record View and unselected Guest Details; blank unselected detail controls were not a profile read. The earlier selected-form investigation covered 30 stays and 33 rendered guest rows.

The existing `readGuestProfile` already performed an exact native master read but returned a narrow summary and rejected some legitimate older records. It now returns every dynamically discovered Header field, native dropdown code/options, selected display when unambiguous, raw representation, explicit blank/unknown/unread states, source scope and observation time. Creation's strict readback comparison remains intact. Credential/password controls are redacted by native name and label, including text-typed controls.

Added one batch library function and two private diagnostics; reused the existing reservation readers rather than duplicating lookup:

| Entry point | Input | Output / role |
| --- | --- | --- |
| `readGuestProfile` | required numeric-string `nativeId`; optional `propertyCode: HRCEN` | existing summary plus `fields`, `coverage`, `observedAt`; exact-ID read, no search or Save |
| `readGuestProfiles` | nonempty list of unique exact-ID inputs; optional trusted `onResult`, `signal`, session adapter | `outcome`, `profiles`, `sessionVerified`; checkpoints provisional until cleanup succeeds |
| `diagnostics/batch-read-guest-profiles.mjs` | JSON `candidates` of exact-ID inputs | private full master observations, verification and failure state |
| `diagnostics/batch-read-reservation-guests.mjs` | HRCEN and unique trimmed confirmations; optional historical profile ID and corroborated lookup name/date | existing lookup → Record View → Guest Details → selected guest forms, with native identity, times and per-session guard verification |

Detailed schemas: [guest-profile-create.md](../../../../apps/server-pilot/tooling/hms-cloud/guest-profile-create.md). The supplied runner's write authority remains Proof Labtest-only; this investigation does not extend it.

Header metadata comes from instantiated native components, which may be hidden while List is active. `visibleWhenDiscovered` is not New/selected-record visibility or editability. Separate live blank-New inspection established required/read-only metadata. There were 65 discovered Header components in this observation; the reader does not require that count, inspect all profile tabs, or dump the unrelated native response payload.

## Coverage

- **779/779** historical master profile IDs read successfully under verified read-only sessions.
- E-Mail-source cohort: **492 stays / 440 distinct primary profile IDs**. The other **339** profile IDs provide an all-source comparison; four email-linked IDs also have other-source stays.
- Paired reservation census: **492/492** verified stays; **507** selected rendered guest rows, including **15** other guest rows. Per-guest form errors: **0**. **0** target stays remain unresolved. A successful row is counted only after its session guard/cleanup passes.
- Historical primary ID changes observed: **0**. Additional selected IDs outside the master corpus: **0**.
- Selected-grid scope is loaded/rendered rows, with native counts retained. It does not establish that all occupants or hidden/unloaded pages were read.

Historical arrival dates must come from the native Record View. Six PDF date hints disagreed with that native snapshot. Native date-based lookup retries recovered earlier default-window not-founds. Two later searches had one complete exact-confirmation match with a date different from the historical hint; fresh native choices were retained separately and used for read-only retries. Fresh Record View arrival dates differ from the historical native snapshot on **7** verified stays; **0** arrival values could not be compared. Ambiguity and timeouts remain explicit; no arbitrary matching row is chosen.

## Current profile population

Counts mean nonblank current master values, not requester supply or reservationist entry. E-Mail is the historical native Source of Business classification. Dropdown defaults can inflate population, especially language/status.

| Field | Native name | E-Mail profile cohort | All-source profiles |
| --- | --- | ---: | ---: |
| First name | `firstname` | 440/440 | 779/779 |
| Surname | `lastname` | 440/440 | 779/779 |
| Mobile | `mobilenumber` | 306/440 | 558/779 |
| Email | `emailaddress` | 439/440 | 777/779 |
| Title | `nametitle` | 298/440 | 515/779 |
| Additional phone | `phonenumber` | 96/440 | 242/779 |
| Nationality | `nationalityforprofile` | 351/440 | 622/779 |
| Country of residence | `countryofresidenceforprofile` | 303/440 | 517/779 |
| Gender | `gender` | 315/440 | 537/779 |
| Date of birth | `birthdateforprofile` | 277/440 | 469/779 |
| Address country | `countrydesc` | 341/440 | 641/779 |
| Street address | `streetaddress` | 238/440 | 398/779 |
| City | `city` | 163/440 | 298/779 |
| State/province | `stateprovincedesc` | 128/440 | 200/779 |
| Postal code | `postalcode` | 116/440 | 191/779 |
| ID type | `idtype` | 225/440 | 364/779 |
| ID number | `idnumber` | 222/440 | 363/779 |
| ID expiry | `idexpirationdate` | 63/440 | 105/779 |
| Passport number | `passportnumber` | 44/440 | 99/779 |
| Passport expiry | `passportexpirationdate` | 44/440 | 97/779 |
| Language | `primarylanguage` | 408/440 | 596/779 |
| VIP level | `viplevel` | 68/440 | 94/779 |
| Profile note | `note` | 1/440 | 5/779 |

The 439 populated email fields contain **299 distinct addresses**. **64 addresses** are shared across **204 profiles with different names**. Among email types, Primary occurs on 399 profiles, Alternative on 18, Work on four and Personal on 18; one is blank. Phone types accompany the 96 additional phones: Daytime 86, Home eight, Work one and Evening one. These are contact-role observations, not proof of guest versus booker ownership.

## Reservation forms versus current master

This is a source comparison, not a correctness verdict. This census comprises timestamped observations across sessions, not one atomic snapshot. Values may be stay snapshots or later master updates. Keep both views and their timestamps. Dates are compared as native calendar dates: rendered stay `dd-MMM-yyyy` versus observed month-first master representation; ambiguous/unsupported formats remain distinct.

| Field | Matching populated | Both blank | Stay blank / master populated | Stay populated / master blank | Different representation/value |
| --- | ---: | ---: | ---: | ---: | ---: |
| firstname | 492 | 0 | 0 | 0 | 0 |
| lastname | 492 | 0 | 0 | 0 | 0 |
| mobile | 316 | 139 | 35 | 0 | 2 |
| email | 267 | 1 | 63 | 0 | 161 |
| street | 239 | 131 | 9 | 86 | 27 |
| dob | 315 | 174 | 2 | 0 | 1 |
| id | 251 | 240 | 1 | 0 | 0 |
| passport | 52 | 438 | 1 | 0 | 1 |

The denominator is 492 verified primary guest forms. Different representation/value does not by itself establish a wrong field. Independently, all 492 historical Record Views compared with the current master show 212 differing guest-email values, including 62 blank reservation emails where the master is populated. Native booker email/name/contact fields were populated on 15/57/250 of those historical stays; these fields and their roles stay separate from guest identity. Five selected email disagreements were independently re-read with exact-ID master observations within three minutes: all five differences persisted. This confirms a live view distinction; it cannot reconstruct the author or creation-time value.

## Available messages

Used exact attachment-to-PDF associations, same-thread IDs and existing reply-header-linked DB source IDs. Did not use names or cross-thread confirmation candidates as new identity links. This expands the thread-only 142-stay/253-source-row comparison to **147/492 stays and 266 distinct inbound source rows**.

Only **1 stay** has linked inbound before its earliest captured linked PDF; **39** have inbound before at least one later PDF. The earliest captured PDF is not necessarily the first confirmation ever sent. Most available evidence therefore cannot serve as a reliable original-request transcript.

Literal overlap examples across the linked cohort: master email matches an inbound sender on 103 stays; surname appears before the heuristic signature boundary on 28, first name on 23, email on 10 and mobile on three. These are overlap hypotheses, not verified supplied fields. Sender comparisons use exact parsed addresses; body comparisons require at least four characters (seven digits for phones), token boundaries and heuristic quote/signature splitting. Short names, other formats and HTML quote variants can be missed or misclassified. Nationality text can come from signatures or legal/location text. No exact DOB, street, ID or passport overlap was found by this conservative matcher; formatting, omitted requests and unavailable inbound attachment contents limit that result.

The existing five-day selected mail extracts were also checked through exact thread/header links; they added no inbound source rows or changed bodies. The selected 1,880-attachment PDF export is entirely outbound. Its absence of inbound attachment contents is a corpus limitation, not evidence that staff never received passports, IDs or addresses.

## History investigation

Created/Updated metadata is populated on all 440 email-linked profiles. **356** have an update on a later native display day than creation; **84** are on the same day. This establishes record-level later activity, not which particular field changed. Consent unknowns are preserved: opt-ins 1–4 have respectively 23, 17, 30 and 361 unknown values; none is silently treated as false.

Inspected native master tabs, relevant Header buttons, configured More menus and screen methods. Contact/Stay/Billing/Visa/Preferences/Notes/Comments/Documents and other profile tabs exist. No dedicated field-audit/history read operation was established on the inspected surface. This does not establish that HMS has no audit facility. Field-level authorship and creation-time field values remain unknown.

## Creation shortlist

| Priority | Fields | Why / boundary |
| --- | --- | --- |
| Already supported | first name, surname, mobile, optional email; native ACTIVE status | covers today's required personal fields; preserve strict pre-Save/readback checks |
| First optional extension | title | 298/440 populated; finite native options; only explicit supplied choice, no inferred default |
| Next optional contact extension | additional phone + phone type, email type | real native usage and differentiated contact types; keep guest and booker roles explicit |
| Supplied-only candidates | nationality, residence, address group, DOB | common master data, but later updates/source gaps prevent booking-time attribution |
| Separate identity detail capability if needed | ID type/number/expiry, passport group | present in HMS; no original-request supply established in this corpus; independent native validation/readback required |
| Keep out of ordinary creation | audit IDs, integration/loyalty controls, credential controls, inferred consent | native read-only/system meanings or different workflow; technical field names can be misleading |

Notable native aliases: `tripadvisorid` is labelled Loyalty Level, `twitterid` Loyalty Points Balance and `facebookid` Legacy Lifestyle Update. These are not ordinary social-profile inputs. `birthdateforprofile`/`nationalityforprofile` are the main personal fields; `dateofbirth`/`nationality` are in the passport area. Preserve the distinction.

## Verification and private reproducibility

Final syntax checks and **22/22 existing focused tests** passed. A deliberately contradictory read-only lookup also proved that native candidates/date-range/coverage are retained, no row is selected, and ordinary lookup failure closes a verified guarded session. No new tests were added. A fresh final 10-profile live proof passed after the reader's final metadata correction; the full historical corpus had already passed exact-ID reads. Independent reader and batch reviews found guard accounting/path issues that were fixed; final source reviews reported no remaining concrete defects. Greptile Apex was unavailable, so independent reviewers supplied the repository-permitted fallback.

Private observations and reproducible analysis live under `/home/orca/.local/share/zero/research/halloween/guest-profile-comparison-20261105/` (0700 directory, 0600 files). `aggregate-census.py`, `expand-message-links.py` and `compare-expanded-messages.py` regenerate the counts from preserved sources. Original captures, failed attempts and source times remain separate. No guest values or source-message bodies are included in this report or Git.

Shared [building-hms-playwright-tools skill](/home/ubuntu/.agents/skills/building-hms-playwright-tools/SKILL.md) was updated with the reusable read-contract, source-attribution, guard-observability and batch-reader lessons; scoped readability verification passed. No production deploy or guest write is part of this investigation.

## Observed Header inventory

Required/read-only flags are from the separate blank native New form. Optional does not mean a supported write. Population is current email-linked master data. Checkbox true/false/unknown counts preserve native state; credential values are redacted.

| Native label | Field | Observation | Blank New form |
| --- | --- | --- | --- |
| Profile ID | `profileid` | 440/440 populated | read only |
| Do Not Merge | `donotmerge` | true: 0, false: 440, unknown: 0 | optional, not proven writable |
| External ID | `externalid` | 440/440 populated | read only |
| Originating System | `originatingsystemid` | 440/440 populated | read only |
| Status | `profilestatuscode` | 440/440 populated | required, creator stages ACTIVE |
| araccountnumber | `araccountnumber` | 0/440 populated | optional, not proven writable |
| Title | `nametitle` | 298/440 populated | optional, not proven writable |
| Surname | `lastname` | 440/440 populated | required, creator input supported |
| First Name | `firstname` | 440/440 populated | required, creator input supported |
| VIP Level | `viplevel` | 68/440 populated | optional, not proven writable |
| Nationality (main) | `nationalityforprofile` | 351/440 populated | optional, not proven writable |
| DOB (main) | `birthdateforprofile` | 277/440 populated | optional, not proven writable |
| Phone Type | `phonenumbertypecode` | 96/440 populated | optional, not proven writable |
| Phone Number | `phonenumber` | 96/440 populated | optional, not proven writable |
| Mobile Number | `mobilenumber` | 306/440 populated | required, creator input supported |
| Email Type | `emailtypecode` | 439/440 populated | optional, not proven writable |
| Email Address | `emailaddress` | 439/440 populated | optional; creator input supported |
| New Password | `newpassword` | values redacted | optional, not proven writable |
| Confirm New Password | `confirmnewpassword` | values redacted | optional, not proven writable |
| Reset Password | `resetpassword` | values redacted | optional, not proven writable |
| Web Access | `haswebaccess` | true: 0, false: 440, unknown: 0 | optional, not proven writable |
| Address Type | `addresstypecode` | 354/440 populated | optional, not proven writable |
| Street address | `streetaddress` | 238/440 populated | optional, not proven writable |
| City | `city` | 163/440 populated | optional, not proven writable |
| Postal Code | `postalcode` | 116/440 populated | optional, not proven writable |
| Country | `countrydesc` | 341/440 populated | optional, not proven writable |
| State/Province | `stateprovincedesc` | 128/440 populated | optional, not proven writable |
| Vat Id | `taxid` | 1/440 populated | optional, not proven writable |
| Gender | `gender` | 315/440 populated | optional, not proven writable |
| Language | `primarylanguage` | 408/440 populated | optional, not proven writable |
| Legacy Marketing Opt in | `guestoptin1` | true: 0, false: 417, unknown: 23 | optional, not proven writable |
| Lifestyle Marketing Opt in | `guestoptin2` | true: 0, false: 423, unknown: 17 | optional, not proven writable |
| Legacy Lifestyle Member | `guestoptin3` | true: 0, false: 410, unknown: 30 | optional, not proven writable |
| Terms and Conditions | `guestoptin4` | true: 0, false: 79, unknown: 361 | optional, not proven writable |
| Program Name | `programname` | 440/440 populated | read only |
| Loyalty Number | `playernumber` | 31/440 populated | read only |
| Loyalty Level | `tripadvisorid` | 440/440 populated | read only |
| Loyalty Points Balance | `twitterid` | 440/440 populated | read only |
| Legacy Lifestyle Update | `facebookid` | 440/440 populated | read only |
| User Defined Field 01 | `udfchar01` | 0/440 populated | optional, not proven writable |
| User Defined Field 02 | `udfchar02` | 0/440 populated | optional, not proven writable |
| User Defined Field 03 | `udfchar03` | 0/440 populated | optional, not proven writable |
| Passport number | `passportnumber` | 44/440 populated | optional, not proven writable |
| Passport Name | `passportname` | 44/440 populated | optional, not proven writable |
| Gender | `gendercode` | 41/440 populated | optional, not proven writable |
| Nationality (passport) | `nationality` | 44/440 populated | optional, not proven writable |
| DOB (passport) | `dateofbirth` | 44/440 populated | optional, not proven writable |
| Passport Issuing Country | `issuingcountry` | 31/440 populated | optional, not proven writable |
| Passport Type | `passporttype` | 31/440 populated | optional, not proven writable |
| Passport Issued Date | `passportissueddate` | 19/440 populated | optional, not proven writable |
| Passport Expiration Date | `passportexpirationdate` | 44/440 populated | optional, not proven writable |
| Turndown Time | `roomdowntime` | 0/440 populated | optional, not proven writable |
| ID Type | `idtype` | 225/440 populated | optional, not proven writable |
| ID number | `idnumber` | 222/440 populated | optional, not proven writable |
| ID Expiration Date | `idexpirationdate` | 63/440 populated | optional, not proven writable |
| Vehicle Reg No. | `vehicle` | 27/440 populated | optional, not proven writable |
| Notes | `note` | 1/440 populated | optional, not proven writable |
| Country of Residence | `countryofresidenceforprofile` | 303/440 populated | optional, not proven writable |
| Id Scan Date | `idscanneddate` | 217/440 populated | read only |
| Id Reference | `scannedidref` | 216/440 populated | read only |
| Booking.com ID | `bookingdotcomid` | 440/440 populated | optional, not proven writable |
| Updated By | `updatedby` | 440/440 populated | read only |
| Updated On | `updated` | 440/440 populated | read only |
| Created By | `createdby` | 440/440 populated | read only |
| Created On | `created` | 440/440 populated | read only |
