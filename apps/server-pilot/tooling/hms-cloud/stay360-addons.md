# Native Stay 360 Add-Ons

One generic Non-Room Item workflow for HRCEN. Catalogue names, item IDs, defaults, dropdown options and calculations come from current HMS. Callers choose an explicit current item code. There is no dinner-specific implementation or local pricing engine.

## Tools and schemas

All functions operate on the supplied logged-in Playwright `page`, bound to one saved confirmation at the HRCEN origin. `confirmation` is required and has the native form `digits-digits`. Results are plain JSON; errors return `{outcome, issue, ...context}` rather than claiming an empty successful result.

| Export | Required inputs | Optional inputs | Success result |
| --- | --- | --- | --- |
| `readStay360AddOns` | `page`, `confirmation` | `{detailIds: string[]}` | `{outcome:"ok", confirmation, propertyCode, target, rows, columns, details, items, coverage, notes}` |
| `listStay360AddOnItems` | `page`, `confirmation` | None | `{outcome:"ok", confirmation, propertyCode, candidates, columns, coverage}` |
| `listStay360AddOnCatalogue` | `page`, `confirmation` | `{itemType:"ITEM"\|"PACK"\|"MEAL"}`; default ITEM | Same catalogue result, plus `itemType` |
| `prepareStay360AddOns` | `page`, `confirmation`, `items: AddOnInput[]` | Optional fields inside each item | `{outcome:"prepared", preparedId, confirmation, propertyCode, items: AddOnPreview[], baselineCoverage, availabilityVerified:false, saved:false}` |
| `saveStay360AddOns` | `page`, `confirmation`, `preparedId`, `{authorize}` | Trusted `beforeDispatch`, `afterDispatch`, `readBaseline` callbacks | `{outcome:"awaiting_readback", confirmation, preparedId, receipts, attempts, requestedCount, baseline, baselineCoverage}`; never reports saved on acknowledgement alone |
| `reconcileStay360AddOns` | Previous save result | `{withPage, target}` for an independent browser and lookup hints | `{outcome:"verified"\|"uncertain", confirmation, verified, mismatches, readback}` |
| `withStay360AddOnSession` | Async callback receiving `{runTool}` | Trusted host callbacks and browser factory | Callback's return value; owns one page and serializes JSON tool calls |

`target = {confirmation, propertyCode, guestName, arrival, departure, status}`. Dates are calendar strings `YYYY-MM-DD`; prices and quantities in previews and receipts are decimal strings, never floating-point calculations by this tool.

`coverage = {loaded:number, reportedTotal:number|null, complete:boolean|null}`. Unknown completeness stays `null`. Raw rows and column field mappings are preserved. `candidates` contain `{code, name, itemId, native}`. A detail contains `{nativeId, fields:AddOnPreview}`. Catalogue item IDs come from current native selection; saved row IDs come from the booking's read. Callers cannot substitute catalogue IDs.

The typed catalogue reader exposes current Non-Room Item (`ITEM`), Non-Room
Bundle (`PACK`) and Meal Plan (`MEAL`) definitions. It invalidates earlier
preparations, verifies the native type change, closes the lookup and restores
the ITEM form before returning. It does not widen the insert tool to bundle or
meal-plan writes. Current HRCEN catalogue reads verified 33 Items, two conference
Bundles and 12 Meal Plans, each complete.

`diagnostics/batch-read-addons.mjs INPUT.json PRIVATE_OUTPUT_DIR WORKERS` reads a
confirmation cohort with one or two fresh guarded sessions. Inputs require
`propertyCode:"HRCEN"`, `sourceSha256` and `candidates` with confirmation and
arrivalDate; optional guestName refines an ambiguous exact-confirmation lookup.
If the old PDF date conflicts with one exact native match in a complete search,
the runner retries in a fresh session using that match's current arrival date.
Optional `detailIds:string[]` per candidate reads those exact saved Add-On rows.
Optional `--identity-source SOURCE.json` supplies the original historical HMS
snapshot. Its bytes must match `sourceSha256`, and each historical confirmation
must match the candidate's source index. When an ambiguous current search has
one exact match to the verified historical HMS guest name, the runner retries
with that name and the returned current date. The standard exact-match reader
still verifies both hints; each attempt records its hint source. Existing
permanent failures resume only when a supported hint refinement is available.
The runner preserves individual attempt JSON, input hashes, cleanup attestation
and resumable progress, then emits full `reads.json`. Failed/incomplete reads
remain separate from complete empty grids. It uses no Save operation.

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

Existing tools are `read`, `list`, `prepare`, `save`, `reconcile`; corrections add `prepareChanges` and `saveChanges` below. Every request requires `confirmation`; optional initial lookup hints are `guestName` and `arrivalDate`. `prepare` additionally requires `items`; `save` requires the latest `preparedId`. `reconcile` uses retained receipts from this session. No authorization booleans or caller-selected catalogue IDs can be supplied through JSON. Corrections accept saved row IDs from the reader, as documented below. A prepared ID works only on its originating page; a new prepare invalidates earlier IDs.

`read` additionally accepts optional `detailIds:string[]` for exact saved-row
details. `list` additionally accepts optional `itemType:"ITEM"|"PACK"|"MEAL"`;
omission retains the existing ITEM list behavior. These fields are accepted only
on their corresponding read operations, and do not extend write support.

Provide `arrivalDate` for future or historical stays outside the shared lookup's default date range. An unhinted lookup failure does not establish that the reservation is absent.

The session wrapper fresh-reads every possible dispatch. It reports `saved` only when all requested items have matching native row IDs and full field readback in a separate browser. `uncertain` requires reconciliation before any retry. Successful save seals the original page; start a fresh session for further operations.

Each receipt/attempt contains `{index, item, itemId, nativeId:string|null}`. Attempts are retained at the possible-dispatch boundary, before reading the response. If an ID is lost, reconciliation selects a unique new row outside the complete baseline and then reads all its detailed fields. Ambiguous, missing or partially dispatched items remain uncertain. Native response metadata must prove the complete baseline before Save; capped/incomplete Add-On lists return `ADDONS_BASELINE_INCOMPLETE` rather than guessing.

Save reads that baseline in an independent session after acquiring the caller's write lock. It recalculates every item and compares identity, description and approved values before dispatch. Preview's earlier baseline is not used to credit a Save. Direct callers must hold the reservation lock around the low-level Save; the JSON session owns this wrapping. Optional `readBaseline(prepared)` overrides the fresh Centurion reader and must return a fresh `{outcome:"ok", target, rows, coverage}`. Dispatch journals receive `baselineIds` and `baselineCoverage` with the approved item.

## Write boundary

The CLI's default authorization allows only a freshly verified Proof Labtest stay, arrival 2027 or later, Reserved status, matching native stay identity, and CMS Send off. Real guest saves require a trusted server host to supply `authorize(prepared)`, `beforeDispatch(dispatch)`, `afterDispatch(receipt)` and `withWriteLock(confirmation, callback)`. The host owns staff approval, a durable dispatch journal and cross-process reservation locking. `authorize` and `beforeDispatch` must return exactly `true`.

Host callbacks must settle within the host's own deadlines. After an interrupted dispatch, the tool quarantines the page and drains running journal callbacks before returning from the locked operation. It deliberately retains the reservation lock while a host callback is still running. Native response headers and body reads each have a 25-second deadline. Concurrent first calls share one initialization and guard; the same-page busy fence rejects overlapping direct actions.

Only the matched native Submit request gets a one-shot exception in the shared read guard. Property, stay/account IDs, item code/ID, action and approved business values must match. Full request field sets and counts are not pinned. Late unexpected requests are blocked; failed native steps quarantine the page.

Insert guards also require empty record identities and a new-record primary key when supplied, so an existing row cannot be updated under an Add approval.

Multiple items use native Submit once per item. This is not an atomic batch: earlier items can persist if a later item fails. Receipts, requested count and independent readback expose partial completion; never replay the whole batch blindly. The original preparation/Save pair adds items. Corrections use the separate pair below; activity/bundle workflows remain outside this contract.

## New reservations

The prepared unsaved Guest Stay did not expose a native Add-On entry in the inspected flow. Create the reservation first, verify its confirmation, then run these tools on that confirmation. Report booking creation and Add-On save separately so an Add-On failure cannot imply that the booking failed.

## Verification

Current catalogue inspection loaded 33 Non-Room Items. Unsaved native previews verified explicit dates, quantity, unit price, frequency, pricing control, folio and comment.

On the owned Proof Labtest confirmation `3640876178-1` (9–11 November 2027, CMS off), native Adult Dinner Submit persisted row `1739`; an independent browser read every saved field with no mismatches. Submit places `pageaction=SAVE` in both URL and form and resets the form afterward, so inserted IDs are captured from the native grid rather than assumed to remain in the form.

A later two-item batch returned `saved` with automatic fresh-session reconciliation: Dinner row `1740` had quantity 2, unit price ZAR 123.45, one day, Once, Per Room, Guest Folio 2 and native total ZAR 246.90; Breakfast row `1741` had quantity 3, unit price ZAR 30.00, one day, Once, Per Room, Guest Folio 1 and native total ZAR 90.00. All requested fields, comments, item IDs and native row identities matched. The original Dinner remained present.

Existing lookup, booking-session and read-guard checks passed (11 tests); the five read-guard tests passed again after the native URL-action correction. No new tests were added. These are backend module/runner proofs in the isolated feature checkout, not a deployed production canary.

Unsaved refusal/recovery checks also passed: an unknown item code returned `ADDONS_ITEM_NOT_LOADED`; missing native-zero pricing returned `ADDONS_PRICE_REQUIRED`; an explicit zero then prepared successfully on the same page with `saved:false`.

After review fixes, concurrent first reads produced one successful read and one `ADDONS_ACTION_IN_PROGRESS` refusal. A 28-second dispatch callback retained the reservation lock through completion; fresh readback confirmed no new row. An owned Labtest Save with deliberately interrupted response reading retained its attempted values, recovered row `1742` from the complete preimage, and matched every field in a fresh browser without a retry. The existing 11 focused tests passed again after these changes.

The approval-delay recovery check also passed: another session inserted identical row `1743` while the original held a preview. The original's blocked Submit used a fresh five-row baseline inside its lock, remained uncertain, and left the row count at five. It did not credit the other session's row as a successful Save.

## Exact-row edit and removal

The add-only exports and wire `prepare`/`save` keep their existing meaning. Corrections use two additional exports and wire operations:

| Export | Required inputs | Optional inputs | Result |
| --- | --- | --- | --- |
| `prepareStay360AddOnChanges` | `page`, `confirmation`, `changes` | Optional fields in an edit patch | `{outcome:"prepared", preparedId, confirmation, propertyCode, saved:false, changes}` |
| `saveStay360AddOnChanges` | `page`, `confirmation`, originating `preparedId`, `{authorize}` | Trusted `readBaseline`, `beforeDispatch`, `afterDispatch` callbacks | `{outcome:"awaiting_readback"\|"unchanged"\|"uncertain", kind:"changes", changes, attempts, receipts, requestedCount, baseline, baselineCoverage, target}` or an input/refusal/failure envelope |

`changes` contains 1–100 operations, each using a different saved native row ID:

```ts
type AddOnChange =
  | { operation: "edit"; nativeId: string; patch: AddOnPatch }
  | { operation: "remove"; nativeId: string };

type AddOnPatch = {
  quantity?: string | number;
  startDate?: string;
  endDate?: string;
  unitPrice?: string | number;
  frequency?: string;
  pricingControl?: string;
  folio?: string;
  comment?: string;
};
```

`operation` and numeric-string `nativeId` are required. Edits additionally require a nonempty `patch`; removals reject a patch. Patch fields use the same dates, decimal validation and native option codes as item preparation. Omitted fields retain the existing values; `comment:""` clears the comment and `unitPrice:"0"` explicitly requests zero. Preserving an existing zero does not require resupplying its price. Code/catalogue ID changes are unsupported: the selected native row's code is read-only in the inspected flow.

A correction preview contains `{index, operation, nativeId, before, after, changedFields, warnings, financialEffect:"unknown"}`. `before` and an edit's `after` are `{nativeId, fields:AddOnPreview}`. For removal `after:null` means requested removal, not zero cost or a refund. Preparation does not click the native Remove action. `warnings` reports available native warnings; it does not promise no later prompt.

The read result now also includes `items`, normalized saved-row summaries alongside the existing raw rows. Grid-unavailable values such as a blank catalogue code remain `null` until the requested detail is read; summaries then include those known fields. Full `details` also expose editable controls. Wire `read` accepts optional `detailIds`, allowing callers to prefetch exact row details. Names/codes can repeat; corrections always choose a saved `nativeId` from that booking's read.

### Correction session calls

```json
{"tool":"read","confirmation":"<confirmation>","guestName":"Proof Labtest","arrivalDate":"2027-11-23"}
{"tool":"read","confirmation":"<confirmation>","detailIds":["<saved row ID>"]}
{"tool":"prepareChanges","confirmation":"<confirmation>","changes":[{"operation":"edit","nativeId":"<saved row ID>","patch":{"quantity":"2","comment":"Dinner for two"}}]}
{"tool":"saveChanges","confirmation":"<confirmation>","preparedId":"<returned preparation ID>"}
```

`prepareChanges` requires `changes`; `saveChanges` requires the originating `preparedId`. Both require `confirmation`, with optional initial name/date lookup hints. Unsupported wire fields are rejected; `changes` belongs only to `prepareChanges`, and `detailIds` only to `read`. An invalid or unloaded detail ID on the first read remains retryable on the same owning booking; native-step failures still require a fresh session. Tokens are bound to add or corrections preparation; the other Save operation cannot consume them.

Corrections execute one by one in the existing session queue. They require no new journal or distributed-lock framework. Default CLI authorization remains fresh Proof Labtest verification, arrival 2027+, Reserved status and CMS off. Real-guest callers provide a trusted `authorizeChanges(prepared)` function returning exactly `true` on staff approval. Optional host hooks are `beforeChangeDispatch(dispatch)` and `afterChangeDispatch(receipt)`. An optional existing `withWriteLock(confirmation, callback)` is honored for both Save paths; it is not required for corrections. The existing add-session `authorize` and callback requirements remain unchanged. JSON cannot provide authority or callbacks.

Immediately before each correction, the tool reads the target in an independent session, compares its full supported fields with the prepared before-state, reloads/stages the owning form, and compares the approved result before dispatch. Changed records return `ADDONS_RECORD_CHANGED` without overwriting the concurrent change. Different processes and direct HMS operators must avoid concurrent writes to the same booking; this fresh check is not an atomic compare-and-set against a later external edit.

Native edit uses `pageaction=SAVE`, removal uses `pageaction=DELETE`, in both URL and body. The guard checks the exact saved row and native primary key, operation and approved fields; the existing insert guard still requires new-record identity. Unexpected Ext warning windows and browser dialogs are checked before native actions and after responses. Automatic acceptance of financial/activity prompts is not supported. An unexpected prompt or native error after possible dispatch requires review and fresh readback.

### Correction results and recovery

The session adds `reconciliation.results` entries containing `{index, operation, nativeId, status, dispatched, attribution, before, expectedAfter, observedAfter}`. Status is `updated`, `removed`, `unchanged`, `uncertain` or `not_attempted`; attribution is `verified` or `unknown`.

Edits require the same row ID and all supported final fields. Removals require absence in a complete independent Add-On read and preservation of untargeted IDs observed in the batch baseline and each attempt's fresh census. This does not establish financial reversal. A missing or already removed row before dispatch is not credited to this attempt.

A matched native response plus successful independent readback can yield `saved`. A no-op edit yields `unchanged` with no dispatch. After a lost response, results can show that the desired state exists while attribution stays unknown and overall outcome stays `uncertain`. Return attempts and next action `reconcile_before_retry`; never blindly replay. Multiple corrections are sequential and may partially persist; unattempted operations stay explicit.

A possible write seals the session; start a fresh session after verified completion. Preparation or Save refusal after a consumed correction token also requires a fresh session. A partial or lost response retains the original native IDs and before/expected-after fields for `reconcile`.

### Correction verification

On 2026-11-05, an exclusively owned Proof Labtest stay (2027-11-23 to 2027-11-25, CMS off) proved native edit and removal through the backend session. The edit changed all eight supported fields, including an explicit blank comment, kept the same row ID and read back ZAR 37.02. The duplicate Dinner row and Breakfast row retained their full values. Removal then yielded a complete independent two-row census without the removed ID.

Invalid/duplicate IDs, unsupported code changes, malformed patches, wrong token kind and wire authorization were refused. A no-op returned `unchanged` with zero dispatches. An intervening sequential-session edit caused `ADDONS_RECORD_CHANGED` with zero dispatches. This is raw source-worktree proof; deployed-main canary and real-guest enablement remain separate.
