# Quote artifacts

Port of the deterministic Excel-master path in `apps/server-pilot/src/quote-proposal/{quote-workbook,proposal-pdf,gotenberg}.ts` and its quotation template. `fflate@0.8.2` must be added to `@zero/nava-agent` by the package owner; deploy this directory including `quotation-template.xlsx`. PDF uses the same workbook, converted by a private configured Gotenberg LibreOffice service. No renderer or converter is enabled by default. No email is sent or drafted by this tool; the quote skill owns cover text and may say attached only after both artifacts have been attached to the unsent draft.

Register `createTools(ports)` or `tools` with server-injected `context.quoteArtifactsPorts`. `resolveQuote` MUST authorize the session's mailbox and selected published quote, atomically read the exact current proposal revision and its revision-bound native capture and staff selections. Never let the model provide these facts. It returns:

```
{quote_id, proposal_id, revision, property_code, authored_date,
 header:{attention,organization,clientEmail,clientTelephone,signerName,signerEmail,displayBookingAgency?}, note?,
 groups:[{group_id,arrival_date,departure_date,rooms:[{id,quantity,adults,children,child_ages}]}],
 capture: <hms_quote data.quotes[quote_id] from that revision>,
 selections:[{group_id,room_id,option_index}]}
```

One selected option per room group/occupancy; indices address that capture's `groups[group_id].rooms[].native_result.options`. Resolver must verify that request and capture are from the same recheck for the exact revision, including quantities and occupancy; no stale recheck, inferred option or model-provided native data. Current quote schema does not yet publish a selection shape: integration must establish staff selections and persist quote capture by revision. The adapter checks IDs, dates, coverage, availability, currency and prices before rendering; incomplete facts refuse. No company name is required. The workbook template supports HRCEN and HRDAV and ZAR only; unsupported properties/currencies refuse. Nightly-derived sums are labelled as not the HMS payable total. Any stay or room omitted by the capture or selections refuses the whole quote.

`writePair` MUST reauthorize and compare current quote/proposal revision atomically with publishing both objects; on stale revision, abort and return no references. Both files must be private and scoped to the same mailbox, thread, session, quote and revision. Return actual stored `{id,name,mime_type,url}` handles, with URLs `/api/nava/v1/artifacts/<encoded-id>` for the authorized artifact endpoint. Do not expose bucket or converter URLs. If staging fails, clean up unpublished objects in the storage implementation. The tool validates both handles after storage and returns neither on failure. Converter receives guest data; deploy it as a private authorized server service. A PDF byte signature alone cannot prove a converter renders correctly; prove signability for the configured service in deployment.
