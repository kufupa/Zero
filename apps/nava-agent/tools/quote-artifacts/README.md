# Quote artifacts

Port of the deterministic Excel-master path in `apps/server-pilot/src/quote-proposal/{quote-workbook,proposal-pdf,gotenberg}.ts` and its quotation template. The bundle includes `quotation-template.xlsx` and `fflate`. PDF uses the same workbook, converted by a private Gotenberg LibreOffice service. No email is sent or drafted by this tool; the quote skill owns cover text and may say attached only after both artifacts have been attached to the unsent draft.

After the staff quote recheck, signed staff with the quote mailbox can `POST /api/nava/v1/proposals/:id/quote-artifacts` with `{expected_revision,quote_id,selections:[{group_id,room_id,option_index}]}`. Both returned handles appear on that revision's stage snapshot. Signed staff in that mailbox can download them at `GET /api/nava/v1/artifacts/:id`. Later revisions invalidate the handles. Set `NAVA_QUOTE_ARTIFACT_DIR` to an absolute private persistent path owned by the API user (0700) and `NAVA_QUOTE_GOTENBERG_URL` to the private loopback HTTP origin (`GOTENBERG_URL` is the fallback).

The staff route injects the ports; the model does not call the renderer. `resolveQuote` MUST authorize the session's mailbox and selected published quote, and read the exact current proposal revision and its revision-bound native capture and staff selections. It returns:

```
{quote_id, proposal_id, revision, property_code, authored_date,
 header:{attention,organization,clientEmail,clientTelephone,signerName,signerEmail,displayBookingAgency?}, note?,
 groups:[{group_id,arrival_date,departure_date,rooms:[{id,quantity,adults,children,child_ages}]}],
 capture: <hms_quote data.quotes[quote_id] from that revision>,
 selections:[{group_id,room_id,option_index}]}
```

One selected option per room group/occupancy; indices address that capture's `groups[group_id].rooms[].native_result.options`. Resolver must verify that request and capture are from the same recheck for the exact revision, including quantities and occupancy; no stale recheck, inferred option or model-provided native data. The adapter checks IDs, dates, coverage, availability, currency and prices before rendering; incomplete facts refuse. No company name is required. The workbook template supports HRCEN and HRDAV and ZAR only; unsupported properties/currencies refuse. Nightly-derived sums are labelled as not the HMS payable total. Any stay or room omitted by the capture or selections refuses the whole quote.

`writePair` MUST reauthorize and compare current quote/proposal revision atomically with publishing both objects; on stale revision, abort and return no references. Both files must be private and scoped to the same mailbox, thread, session, quote and revision. Return actual stored `{id,name,mime_type,url}` handles, with URLs `/api/nava/v1/artifacts/<encoded-id>` for the authorized artifact endpoint. Do not expose bucket or converter URLs. If staging fails, clean up unpublished objects in the storage implementation. The tool validates both handles after storage and returns neither on failure. Converter receives guest data; deploy it as a private authorized server service. A PDF byte signature alone cannot prove a converter renders correctly; prove signability for the configured service in deployment.

Zero nightly price needs staff review. HMS returned five `0.00` offers for one real HRCEN night while reporting availability, with no verified complimentary terms (17 Nov 2026 preview). The renderer does not turn those rows into a complimentary quotation.
