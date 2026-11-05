# Native Stay 360 Add-Ons

One generic Non-Room Item workflow for HRCEN. Catalogue names, item IDs, defaults, dropdown options and calculations come from current HMS. Callers choose an explicit current item code. There is no dinner-specific implementation or local pricing engine.

## Tools and schemas

All functions operate on the supplied logged-in Playwright `page`, bound to one saved confirmation at the HRCEN origin. `confirmation` is required and has the native form `digits-digits`. Results are plain JSON; errors return `{outcome, issue, ...context}` rather than claiming an empty successful result.

| Export | Required inputs | Optional inputs | Success result |
| --- | --- | --- | --- |
| `readStay360AddOns` | `page`, `confirmation` | `{detailIds: string[]}` | `{outcome:"ok", confirmation, propertyCode, target, rows, columns, details, coverage, notes}` |
| `listStay360AddOnItems` | `page`, `confirmation` | None | `{outcome:"ok", confirmation, propertyCode, candidates, columns, coverage}` |
| `prepareStay360AddOns` | `page`, `confirmation`, `items: AddOnInput[]` | Optional fields inside each item | `{outcome:"prepared", preparedId, confirmation, propertyCode, items: AddOnPreview[], baselineCoverage, availabilityVerified:false, saved:false}` |
| `saveStay360AddOns` | `page`, `confirmation`, `preparedId`, `{authorize}` | Trusted `beforeDispatch`, `afterDispatch` callbacks | `{outcome:"awaiting_readback", confirmation, preparedId, receipts, attempts, requestedCount, baseline, baselineCoverage}`; never reports saved on acknowledgement alone |
| `reconcileStay360AddOns` | Previous save result | `{withPage, target}` for an independent browser and lookup hints | `{outcome:"verified"\|"uncertain", confirmation, verified, mismatches, readback}` |
| `withStay360AddOnSession` | Async callback receiving `{runTool}` | Trusted host callbacks and browser factory | Callback's return value; owns one page and serializes JSON tool calls |

`target = {confirmation, propertyCode, guestName, arrival, departure, status}`. Dates are calendar strings `YYYY-MM-DD`; prices and quantities in previews and receipts are decimal strings, never floating-point calculations by this tool.

`coverage = {loaded:number, reportedTotal:number|null, complete:boolean|null}`. Unknown completeness stays `null`. Raw rows and column field mappings are preserved. `candidates` contain `{code, name, itemId, native}`. A detail contains `{nativeId, fields:AddOnPreview}`. Native IDs are resolved from current catalogue selection, not accepted as arbitrary caller substitutions.

### Item input

`items` must contain 1–100 item objects. Unsupported fields are refused, not ignored.

| Field | Required? | Type / meaning |
| --- | --- | --- |
| `code` | Yes | Exact current catalogue code, e.g. `ADDINA` |
| `quantity` | No | Positive decimal string or number; omitted uses native default |
| `startDate`, `endDate` | No | Valid `YYYY-MM-DD` dates; omitted uses native dates |
| `unitPrice` | Conditional | Nonnegative decimal string or number. A native zero price requires an explicit caller price, including explicit `"0"` if intended |
| `frequency` | No | Native dropdown code; current HRCEN options include `PERDAY`, `FLOAT`, `ONCE` |
| `pricingControl` | No | Native dropdown code; current options include `PERADT`, `PERCHD`, `PERRM`, `CHILD1`, `CHILD2`, `CHILD3` |
| `folio` | No | Native dropdown code; options include `GUEST`, `INCID`, `AR`, `FOLIO4`, `FOLIO5`, `FOLIO7` |
| `comment` | No | Plain text; omitted uses native default |

Native controls determine editability and options. The tool compares every supplied field with the finished form after all native recalculations and returns the effective values for approval. `AddOnPreview` contains all nine input fields, plus `name`, `itemId`, `currency`, `averageDaily`, `totalCost`, `status`, and `controls`. Each control contains `{value, display, editable, required, options?}`; options contain `{code,name}`. Totals are HMS calculations; `VALID` is not proof of inventory availability.

### Same-session JSON interface

Run `node apps/server-pilot/tooling/hms-cloud/stay360-addons-session.mjs --jsonl` to keep one authenticated browser alive. Each input line emits one JSON result.

```json
{"tool":"list","confirmation":"3640876178-1","guestName":"Proof Labtest","arrivalDate":"2027-11-09"}
{"tool":"prepare","confirmation":"3640876178-1","items":[{"code":"ADDINA","quantity":"2","startDate":"2027-11-09","endDate":"2027-11-09","unitPrice":"123.45","frequency":"ONCE","pricingControl":"PERRM","folio":"INCID"}]}
{"tool":"save","confirmation":"3640876178-1","preparedId":"<ID from prepared result>"}
{"tool":"reconcile","confirmation":"3640876178-1"}
```

Supported `tool` values: `read`, `list`, `prepare`, `save`, `reconcile`. Every request requires `confirmation`; optional initial lookup hints are `guestName` and `arrivalDate`. `prepare` additionally requires `items`; `save` requires the latest `preparedId`. `reconcile` uses retained receipts from this session. No authorization booleans or native item IDs can be supplied through JSON. A prepared ID works only on its originating page; a new prepare invalidates earlier IDs.

Provide `arrivalDate` for future or historical stays outside the shared lookup's default date range. An unhinted lookup failure does not establish that the reservation is absent.

The session wrapper fresh-reads every possible dispatch. It reports `saved` only when all requested items have matching native row IDs and full field readback in a separate browser. `uncertain` requires reconciliation before any retry. Successful save seals the original page; start a fresh session for further operations.

Each receipt/attempt contains `{index, item, itemId, nativeId:string|null}`. Attempts are retained at the possible-dispatch boundary, before reading the response. If an ID is lost, reconciliation selects a unique new row outside the complete baseline and then reads all its detailed fields. Ambiguous, missing or partially dispatched items remain uncertain. Native response metadata must prove the complete baseline before Save; capped/incomplete Add-On lists return `ADDONS_BASELINE_INCOMPLETE` rather than guessing.

## Write boundary

The CLI's default authorization allows only a freshly verified Proof Labtest stay, arrival 2027 or later, Reserved status, matching native stay identity, and CMS Send off. Real guest saves require a trusted server host to supply `authorize(prepared)`, `beforeDispatch(dispatch)`, `afterDispatch(receipt)` and `withWriteLock(confirmation, callback)`. The host owns staff approval, a durable dispatch journal and cross-process reservation locking. `authorize` and `beforeDispatch` must return exactly `true`.

Host callbacks must settle within the host's own deadlines. After an interrupted dispatch, the tool quarantines the page and drains running journal callbacks before returning from the locked operation. It deliberately retains the reservation lock while a host callback is still running. Native response headers and body reads each have a 25-second deadline. Concurrent first calls share one initialization and guard; the same-page busy fence rejects overlapping direct actions.

Only the matched native Submit request gets a one-shot exception in the shared read guard. Property, stay/account IDs, item code/ID, action and approved business values must match. Full request field sets and counts are not pinned. Late unexpected requests are blocked; failed native steps quarantine the page.

Insert guards also require empty record identities and a new-record primary key when supplied, so an existing row cannot be updated under an Add approval.

Multiple items use native Submit once per item. This is not an atomic batch: earlier items can persist if a later item fails. Receipts, requested count and independent readback expose partial completion; never replay the whole batch blindly. This tool adds items; edit/remove existing Add-Ons and activity/bundle workflows are outside this contract.

## New reservations

The prepared unsaved Guest Stay did not expose a native Add-On entry in the inspected flow. Create the reservation first, verify its confirmation, then run these tools on that confirmation. Report booking creation and Add-On save separately so an Add-On failure cannot imply that the booking failed.

## Verification

Current catalogue inspection loaded 33 Non-Room Items. Unsaved native previews verified explicit dates, quantity, unit price, frequency, pricing control, folio and comment.

On the owned Proof Labtest confirmation `3640876178-1` (9–11 November 2027, CMS off), native Adult Dinner Submit persisted row `1739`; an independent browser read every saved field with no mismatches. Submit places `pageaction=SAVE` in both URL and form and resets the form afterward, so inserted IDs are captured from the native grid rather than assumed to remain in the form.

A later two-item batch returned `saved` with automatic fresh-session reconciliation: Dinner row `1740` had quantity 2, unit price ZAR 123.45, one day, Once, Per Room, Guest Folio 2 and native total ZAR 246.90; Breakfast row `1741` had quantity 3, unit price ZAR 30.00, one day, Once, Per Room, Guest Folio 1 and native total ZAR 90.00. All requested fields, comments, item IDs and native row identities matched. The original Dinner remained present.

Existing lookup, booking-session and read-guard checks passed (11 tests); the five read-guard tests passed again after the native URL-action correction. No new tests were added. These are backend module/runner proofs in the isolated feature checkout, not a deployed production canary.

Unsaved refusal/recovery checks also passed: an unknown item code returned `ADDONS_ITEM_NOT_LOADED`; missing native-zero pricing returned `ADDONS_PRICE_REQUIRED`; an explicit zero then prepared successfully on the same page with `saved:false`.

After review fixes, concurrent first reads produced one successful read and one `ADDONS_ACTION_IN_PROGRESS` refusal. A 28-second dispatch callback retained the reservation lock through completion; fresh readback confirmed no new row. An owned Labtest Save with deliberately interrupted response reading retained its attempted values, recovered row `1742` from the complete preimage, and matched every field in a fresh browser without a retry. The existing 11 focused tests passed again after these changes.
