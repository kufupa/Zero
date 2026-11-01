# Stay 360 Folio reader

`readFolioFromStay360(page, confirmation)` in `stay360-folio.mjs` takes a
caller-owned authenticated page with the exact stay already open. It checks the
header and Record View confirmation through `openStay360RecordTab`, installs the
shared read-only guard, opens Folio, and clicks only the grid's Run control.
The caller retains ownership of the page and must serialize operations on it.

The result contains rows intersecting the current grid viewport. It may include
horizontally clipped rendered columns and cells. It also returns rendered,
loaded and total counts, current page and page size, the displayed records label
when recognized, observed filter inputs and
Ext store filters, and displayed summary field strings with currencies. A blank
string is an observed blank; `null` means unavailable or ambiguous. The grid
may contain sensitive guest and transaction data: keep results private.

`status` is `loaded`, `loaded_empty`, `partial`, `not_loaded`, or `failed`.
One verification path requires a successful Ext store `beforeload` and `load`
event around Run. A second, specifically observed Cloud path recognizes an
empty data-only Folio response bound to the confirmation, grid and DataSpy,
whose request starts after the Run click, together with one post-click store
`datachanged` and `refresh` and matching zero rendered, loaded and total counts. `refreshMethod` identifies this path.
The reader parses the response as data, never executable script. This empty-grid
correlation does not establish a complete ledger or identify cleared funds.
Response-to-row correlation for nonempty grids remains unverified: unfamiliar,
malformed, inconsistent or ambiguous refreshes remain `not_loaded` rather than
being called empty. An observed failed Folio Run request is `failed`, and a
still-pending request is `not_loaded`. Network tracking is limited to the known
Folio POST paths. `partial` indicates count, page, or row/column coverage
mismatches or unknown counts. It is not the only way results can be incomplete.
Filters include the selected DataSpy and observed values, not proof that every
server-side filter is known or applied. Even matching counts do not verify the
entire ledger. The displayed summary has no independent freshness proof.
The displayed balance is not evidence of cleared funds, payment, or absence of
later charges. `coverage.complete` is always unknown.

The temporary Run request fence allows only read methods and Folio POST paths,
then falls through to the shared read-only guard. If refresh is not verified,
the fence stays on the page because a delayed request may still arrive. Discard
that page and use a fresh session before further operations. Header mismatch,
ambiguous controls, navigation errors and other structural failures throw.
No payment, save, cancel, upload, download, or send is performed. This reader
does not paginate or clear/change filters.

## Bounded live observations

On 2026-11-01, the initial version was called on HRCEN confirmation
`3123652389-1` after verifying the fake Proof Labtest identity and 22–24 March
2027 stay. It reported `not_loaded`: no Ext store load event was observed.
A subsequent guarded diagnostic on the same verified fake stay found that Run
instead produced a matching data-only Folio response followed by Ext
`datachanged` and `refresh` events. This established the different refresh
mechanism, not a complete ledger or cleared funds. Private diagnostic evidence:
`/tmp/hms-folio-diagnostic-cBHwxGFR/evidence.json`.

A final guarded read using this module at 23:07–23:08 UTC on 2026-11-01
reverified the same fake stay and returned `loaded_empty` with the matched
empty response and one each of the store events. The current page showed
`Records: 0 of 0`, page 1, page size 25 and `Standard Folios`, with no observed
filter criteria. Displayed Folio Balance and Folio Balance in Guest Currency
were both `0.00 ZAR`; these are displayed values only. Both tracked Run requests
completed without observed failures, and three Folio responses across tab open
and Run had HTTP 200. Private evidence:
`/tmp/hms-folio-final-fasS0abF/evidence.json`.

Nonempty and filtered live folios, pagination, failed or delayed refreshes,
other properties, and response-to-row correlation for nonempty rows remain
unproved. Synthetic tests are written but were not run in this dispatch.
