# Corpus-driven PMS tool catalogue and contracts

> **Current quote exception (2026-09-17):** This catalogue predates the standalone quote decision. Its `hms_quote_stay`/Room Availability/Display Rates references are historical demand evidence. Current quote execution uses Front Desk → Availability → **Hotel Availability** with applied adults/children/ages and read-only Availability Details; OSRRAV is diagnostic only and never a fallback.

Research date: 2026-09-07. This is a demand/evidence and interface catalogue, **not a second implementation plan**. Work ordering, implementation units and acceptance gates belong to the [canonical implementation plan](../superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md).

Contract definitions below are proposed until separately implemented, verified and released. Registered schemas, fixture tests, historical promotion, current activation and successful business outcomes are different evidence states. No live PMS operations or production tests were performed for this research. All business writes and automatic sending remain outside the current read-only build.

## 1. Demand, population and limitations

The local [bounded corpus audit](../../.private/pms-tools-replan-2026-09-07/corpus-demand.md) and [reproducible record map](../../.private/pms-tools-replan-2026-09-07/corpus-tool-map.json) are private evidence artifacts, not public mail exports. They join 581 opaque review IDs to semantic needs, source limitations and candidate families. All prior annotations were read; 25 representative/ambiguous source records were newly inspected and 19 targeted source conditions checked. This is not a new full-source census or an automation benchmark.

| Selected population | Records | Physically outbound | Staff-origin inbound |
|---|---:|---:|---:|
| Original G001–G420 | 420 | 388 | 32 |
| Later same-filter E001–E020 | 20 | 16 | 4 |
| Previously excluded catch-up X001–X034 | 34 | 34 | 0 |
| Events-platform P001–P103 | 103 | 103 | 0 |
| Native-staff omissions N001–N004 | 4 | 0 | 4 |
| Distinct selected review frame | **581** | **541** | **40** |

The original external/mixed human-reply/template candidate subset is **253**. It includes physically inbound G098/G099, so the strict outbound subset is **251**. External includes supplier/other-hotel correspondence; neither subset means 253 or 251 correct, customer-only, independent tasks. The old 433-row analysis contains the same 420 fingerprints, with 13 repeated rows.

The latest mailbox snapshot, as of 2026-09-02T10:08:49.888Z, contains 4,536 rows: 3,963 inbound and 573 outbound, representing 560 outbound historical fingerprints. The final review frame represents 196/560; 364 remaining confirmation-cover records were structurally compared previously but not individually attachment/action-adjudicated. They are excluded from the percentages below. The selected catch-up set extends beyond that snapshot. No population prevalence, time saving, revenue uplift or complete-mailbox gold count follows from this selection.

Historical fingerprint: SHA-256 of repeatedly RE/FW/FWD-prefix-normalized subject, UTC minute and sorted unique To addresses, truncated to 20 hex. Sender/body/Cc are not part of that contract. Source-row ID is not RFC Message-ID; repeated sends are not independent bookings, payments or sales.

### Seven-family support counts

These are unique records with inherited manual semantic labels. Families overlap; a label means candidate fact/artifact support, not information available only from HMS or enough information for a complete reply.

| Family | Original 420 | Outbound 388 | External/mixed 253 | Strict outbound 251 | E20 / X34 / P103 / N4 |
|---|---:|---:|---:|---:|---|
| Reservation identity/current stay | 123 | 123 | 111 | 111 | 2 / 13 / 0 / 0 |
| Existing business documents | 156 | 156 | 136 | 136 | 4 / 5 / 88 / 0 |
| Folio/payment/credit evidence | 40 | 36 | 28 | 28 | 2 / 3 / 0 / 0 |
| Availability/rate/package facts | 43 | 42 | 42 | 41 | 1 / 1 / 0 / 0 |
| Group/event/rooming/operations | 66 | 63 | 53 | 53 | 5 / 0 / 14 / 0 |
| Mail-artifact reading, non-PMS | 216 | 200 | 122 | 122 | 0 / 0 / 89 / 3 |
| Approved property policy/knowledge, non-PMS | 73 | 73 | 70 | 70 | 0 / 2 / 0 / 0 |

On the 253 subset, reservation then documents then finance then rates then group gives touch unions **111 → 164 → 171 → 190 → 192**, marginal additions **111,+53,+7,+19,+2**. On all 420: **123 → 192 → 207 → 227 → 234**. Adding policy/mail gives 204/253 and 309/420. The strict 251 subset gives 191 for the five PMS/mixed-source families, 203 for all seven. Documents-first, then reservation, rates, finance and group, changes the 253 marginal sequence to **136,+28,+19,+7,+2**, not the final union.

Reservation/documents intersect on 83 records; documents/group on 39; documents/rates on 23; documents/folio on 17. The five-family bundle touches 192/253 but includes all nonempty annotated tool labels on only **49**, of which **25** are also annotated routine/no-action. Including mail/policy gives 204 with all labels, 83 routine/no-action. Even these are screening counts, **not verified full-input sufficiency, correct replies or completed actions**. The 49 no-label replies include acknowledgement, clarification and partner requests, not 49 completed hotel tasks.

### The 136 document-labelled candidates are not 136 HMS invoice fetches

| Primary observed task/document | Count | Source implication | Opaque examples |
|---|---:|---|---|
| Reservation-linked confirmation/proforma | 55 | HMS-shaped/linked candidate; actual retrievable source must be proved | G160, G186, G196, G352 |
| Existing/final tax invoice, including reissue context | 16 | Issued financial document; retrieving differs from issuing/reissuing | G261, G272, G321, G344 |
| Folio/balance/credit evidence | 7 | Finance evidence; refund forms may be separate non-PMS artifacts | G117, G233, G296, G379 |
| Group accommodation proforma | 18 | Manual/group/SCS/HMS ownership unresolved | G168, G235, G255, G374 |
| Standalone quote/manual proforma/consolidated invoice | 23 | Approved artifact or preparation workflow, not established issued-HMS retrieval | G159, G240, G245, G407 |
| Policy/compliance/registration/menu/property material | 7 | Approved non-PMS source | G217, G218, G324, G390 |
| Event contract as primary task | 1 | Event/contract source | G181 |
| Bespoke immigration letter | 1 | Approved letter plus reservation/ledger evidence | G326 |
| Another property's confirmation | 1 | Mail/provider source, not this property's HMS | G226 |
| Later document promised, not delivered now | 4 | Not established current document-read need | G285, G322, G343, G346 |
| Unverified payment artifact/link/unspecified proof | 3 | Source/content unavailable; no retrieval success | G195, G370, G411 |
| Total | **136** | | |

The 78 primary reservation/folio/final-tax tasks are not 78 proved HMS-exclusive dependencies. Secondary facets overlap: G218 also contains reservation proformas; G117/G233/G253 refund intake; G330/G374/G376 contract material; G344 transport invoice; G381 credit statement. G016's historical source explicitly distinguishes accommodation/group quotations not on HMS from SCS-generated event quotations. That is workflow evidence, not current policy authority. Other quote documents had only rate/mail/policy labels, so 136 is not a complete document-work census either.

The platform extension has 100 human-template candidates plus three relay/uncertain records. Its 88 insufficient-context cases and 88 document labels cannot inflate HMS coverage: attachment presence/bytes and earlier same-thread context are unknown for all 103. P015 modifies a quotation, not a reservation; P061 is quoted customer correction without a new hotel answer. N003/N004 repeat the same bank instruction, not two payments.

## 2. Resource and authority boundaries

Use bounded rich resource/intent reads, not one tool per browser click and not one universal PMS query. Existing internal drivers remain small typed operations. Resource summaries reduce repeated sessions and conflicting observations; finance, documents, company disclosures and notes retain distinct permission/readiness boundaries. Optional detail must not fetch the entire account or dump raw pages. This is a task-specific design choice, not a proven optimal tool count; see [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) and [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

Sources remain distinct: HMS reservation/folio/group state; HMS sent-log metadata; authorized mailbox bytes; approved property documents; unintegrated SCS/event systems; payment providers; supplier/staff arrangements. A document's kind does not prove its source. A sent-log row is not delivery; a POP is not posted funds; a provisional/zero-deposit confirmation is not paid; a quote does not hold inventory.

Priority follows demand and risk: reservation + existing-document retrieval first; finance and quote facts next; group/company/event/notes where safely supported. Mail artifacts and approved property knowledge are essential companions throughout. Company/group/notes counts are contextual support, not separate-exclusive frequency estimates. Operational reporting, payment-provider link issuance and SCS connectors remain explicit capability gaps rather than invented HMS methods.

Deployed reads must be repeatable, code-owned and guarded. The coding agent authors, tests and repairs adapters at build time; a runtime model does not improvise browser scripts, SQL, selectors, URLs, function codes or authorization. Preserve the [HMS runtime](../../apps/server-pilot/src/hms/runtime.ts), [requester authorization](../../apps/server-pilot/src/hms/requester-authorization.ts), [candidate graph](../../apps/server-pilot/src/hms/candidate-graph.ts) and [release kernel](../../apps/server-pilot/src/hms/release-kernel.ts). A read-only hint is not enforcement; [MCP tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) make the same distinction.


## 3. Concrete read contracts

These are implementation targets, not claims that every branch already works. Inputs/outputs become closed Zod/JSON Schema objects with unknown keys rejected. Optional sections select a fixed enum, never arbitrary fields or browser operations. Existing eight HMS IDs and mail_read_artifact remain compatible through versioned adapters; do not show duplicate old/new versions to the same model.

### Shared types, defaults and authority

- Ref: nonempty opaque string, at most 256 characters, minted by the trusted server for an exact authorized candidate/resource. It binds mailbox/property, requester, purpose, parent, branch, release version and expiry. Raw reservation numbers, URLs, S3 keys and selectors are not substitutes.
- Timestamp: RFC 3339 instant; LocalDate: validated ISO date. Hotel business date, source update time and observation time are different.
- Money: {amount: decimalString, currency: ISO4217, basis: enum, taxTreatment: enum}. Basis is per_room_per_night|per_person|per_stay|per_item|ledger_balance|ledger_movement|other|unknown; tax is inclusive|exclusive|mixed|not_applicable|unknown. Decimal arithmetic only; missing money is not zero.
- `ReadFact<V>`: discriminated union. Known requires a typed value, evidence reference, observation time and expiry. Unknown/not_authorized/not_applicable/not_requested/stale requires value:null and a closed reason code. Source-update time is nullable. Each business value has its own evidence/age; a fresh balance cannot refresh an old deposit. Known fields have non-null evidence/observation/expiry; missing fields may have a bounded failure evidence reference but never a fabricated value.
- `ReadSection<S>`: {state:available/partial,data:S,completeness,issues} or {state:unavailable/not_requested,data:null,reasonCode,issues}. A section containing a partial set of known facts is partial, not wholly absent. Nested values retain `ReadFact` evidence; section availability is not a fact about money or guest state.
- `ReadResult<D>`: {schemaVersion,status,data,completeness,unavailableSections,scopeRef,evidence,page,issues}. Status is ok|partial|not_found|unverified_negative|ambiguous|manual_required; data is the concrete tool payload or null when no authorized payload can be returned. Completeness is complete|partial|unknown for the requested scope, never the whole hotel.
- Evidence: {evidenceRef,sourceSystem,sourceSurface,requestBranchId,observedAt,sourceUpdatedAt,expiresAt,scopeVerified,artifactRef}. Source/surface are release-owned enums. Raw captures/backend locators remain private; only authorized opaque evidence/artifact references leave the service.
- Page: null or {returnedCount,hasMore:boolean|null,nextCursor:Ref|null}. Null hasMore means completeness unproved, not false. Cursors bind scope/filter/snapshot/role/expiry; paging needs independently allowed read requests and remaining budget.
- Issue: {code,retryable,safeNextAction}. Closed codes: INPUT_MISSING, INVALID_INPUT, SCOPE_DENIED, REF_EXPIRED, AMBIGUOUS_IDENTITY, ROLE_UNAVAILABLE, SURFACE_UNPROVEN, STALE_EVIDENCE, PARTIAL_WINDOW, TRUNCATED, SIZE_LIMIT, TIMEOUT, SOURCE_UNAVAILABLE, UNSUPPORTED_FORMAT, DOCUMENT_CHANGED, POLICY_UNAPPROVED, INCOMPLETE_QUOTE, UNVERIFIED_NEGATIVE, READ_EFFECT_BLOCKED, NOT_REQUESTED, NOT_APPLICABLE. Safe action is retry_same_read|request_input|manual_review|none; no raw transport payload.
- Trusted ReadExecutionContext injects authorization, candidate graph, exact upstream bindings, AbortSignal, budget, release and capture settings. It is never model input. Resolve scope before access; recheck after asynchronous retrieval.
- Summary is default. Lists default 20, hard maximum 50; reservation matches retain the existing maximum 20. Proposed notes text limit is 2,000 characters/item with explicit truncation. Current domain limits are ceilings, not permission to increase them: quotes at most 30 nights/4 rooms/16 guests; finance/communications 50 rows and 64 KiB parsed envelopes; deposit detail at most seven date scopes unless a new bounded release proves expansion.
- Reject oversize transport before expensive parsing; retain actual bytes/time before capping output. Do not clamp counters then declare a read within budget. Current quote v2 has no paging; a cursor must not bypass it.
- Not-found uses the existing negative-result gate: exact scope, recognized response, parser, complete relevant window/paging and known-positive control. Empty/hidden/masked is not business absence.

### Payload typing rules

The following compact interface map fixes field names and types; it is schema design, not implementation code. `F<T>` means `ReadFact<T>`; `S<T>` means `ReadSection<T>`; `List<T>` means {items:T[],page:Page}. Requested quantities and row counts are non-negative integers (requested room quantity must be at least one); observed availability and remaining-inventory values use signed integers where the source permits overbooking. Preserve the source sign, never clamp it. Text is bounded and sanitized. Status strings retain an explicit source-system vocabulary, never a guessed normalized state. Unknown values use F/S, not empty strings/arrays or zero. All fields shown are required; optional input selectors have the defaults in the next table. Unknown keys are rejected recursively.

| Payload | Closed structure and field types |
| --- | --- |
| `ReservationMatch` | `reservationRef:Ref; label:F<string>; referenceKind:F<confirmation/external>; status:F<string>; arrival:F<LocalDate>; departure:F<LocalDate>; roomType:F<string>; matchEvidenceRefs:Ref[]` |
| `FindReservationData` | `matches:ReservationMatch[]; matchCount:integer; capped:boolean. MatchCount is returned candidates, not an invented total beyond the cap.` |
| `ReservationData` | `core:S<ReservationCore>; stay:S<ReservationStay>; rates:S<List<NightlyRate>>; policies:S<BookedPolicies>; operations:S<List<OperationObservation>>` |
| `ReservationCore` | `confirmation:F<string>; externalReference:F<string>; status:F<string>; guestRefs:F<Ref[]>; organizationRef:F<Ref>; agencyRef:F<Ref>; groupRef:F<Ref>` |
| `ReservationStay` | `arrival:F<LocalDate>; departure:F<LocalDate>; roomType:F<string>; roomQuantity:F<integer>; adults:F<integer>; childAges:F<integer[]>; additionalGuests:F<Ref[]>` |
| `NightlyRate` | `night:LocalDate; roomType:F<string>; ratePlan:F<string>; price:F<Money>; inventory:F<signed_integer>; restrictions:F<string[]>; inclusions:F<string[]>; taxes:F<Money[]>; fees:F<Money[]>` |
| `BookedPolicies` | `guarantee:F<string>; deposit:F<string>; cancellation:F<string>; policyVersion:F<string>` |
| `OperationObservation` | `kind:F<string>; permittedText:F<string>; dueAt:F<Timestamp>; sourceStatus:F<string>. Observed wording/status is not evidence of completed external action.` |
| `DocumentMetadata` | `documentRef:Ref or null; source:DocumentSource; kind:F<DocumentKind>; version:F<string>; issuedAt:F<Timestamp>; status:F<string>; parentRef:Ref; payerRef:F<Ref>; displayName:F<string>; mime:F<string>; sizeBytes:F<integer>; sha256:F<string>; retrievable:boolean; retrievalBlocker:Issue or null; priceVisibility:F<visible/hidden>` |
| `DocumentListData` | `documents:List<DocumentMetadata>; sourceOutcomes:{source:DocumentSource,status:ok/partial/unavailable,issues:Issue[]}[]` |
| `ExistingDocumentData` | `document:DocumentMetadata; artifactRef:Ref or null; text:string or null; extractionState:complete/partial/unsupported; pageCount:F<integer>; validation:DocumentValidation. Format artifact gives only authorized artifactRef; format text gives bounded text. Never both, and neither on a failed extraction.` |
| `DocumentValidation` | `identity:F<match/mismatch>; stayDates:F<match/mismatch>; payer:F<match/mismatch>; kind:F<match/mismatch>; version:F<current/superseded>; priceVisibility:F<allowed/forbidden>. Missing requested constraints remain unknown, not pass.` |
| `FolioData` | `balance:S<List<FolioBalance>>; deposits:S<List<DepositSummary>>; transactions:S<List<FolioPosting>>; liabilityLocation:F<guest_folio/accounts_receivable/mixed/other>; authorization:F<Money>` |
| `FolioBalance` | `folioRef:Ref; folioType:F<guest/incidentals/accounts_receivable/master/other>; balance:F<Money>` |
| `DepositSummary` | `due:F<Money>; paid:F<Money>; refunded:F<Money>; forfeited:F<Money>; transferred:F<Money>; untransferred:F<Money>. Use separate summaries per currency when needed; never combine currencies.` |
| `FolioPosting` | `postingRef:Ref; folioRef:Ref; postedAt:F<Timestamp>; businessDate:F<LocalDate>; type:F<string>; amount:F<Money>; sourceAccountRef:F<Ref>; destinationAccountRef:F<Ref>; reversesPostingRef:F<Ref>` |
| `QuoteData` | `requestRef:Ref; arrival:LocalDate; departure:LocalDate; rooms:NormalizedQuoteRoom[]; currency:string; nights:List<QuoteNight>; coveredNights:LocalDate[]; missingNights:LocalDate[]; continuousStay:F<boolean>; roomMoveRequired:F<boolean>; displayRateSum:F<Money>; stayTotal:F<Money>; occupancyPriced:F<boolean>; bookable:F<boolean>; held:false; unresolvedInputs:string[]` |
| `QuoteNight` | `NightlyRate fields plus roomGroupIndex:integer and quantity:integer, binding each night to its normalized requested room group.` |
| `NormalizedQuoteRoom` | `quantity:integer; adultsPerRoom:integer; childAges:integer[]; roomTypeRef:Ref or null; ratePlanRef:Ref or null. Limits below apply to sums, not each array item.` |
| `CompanyData` | `companyRef:Ref; billingMode:F<string>; paymentTerms:F<string>; requiredPaperwork:F<string[]>; billingReference:F<string>; arAccountRef:F<Ref>; organizationRef:F<Ref>; agencyRef:F<Ref>; negotiatedRateRefs:F<Ref[]>; restrictions:F<string[]>; audience:F<staff_only/customer_disclosable>` |
| `GroupData` | `summary:S<GroupSummary>; blocks:S<List<GroupBlock>>; delegates:S<List<GroupDelegate>>` |
| `GroupSummary` | `groupRef:Ref; status:F<string>; startDate:F<LocalDate>; endDate:F<LocalDate>; releasePolicy:F<string>; billingRef:F<Ref>` |
| `GroupBlock` | `night:LocalDate; roomType:F<string>; contracted:F<integer>; blocked:F<integer>; pickedUp:F<integer>; remaining:F<signed_integer>; sourceFieldMapping:F<string>. CON/BLK must be mapped by proof; no guessed arithmetic.` |
| `GroupDelegate` | `delegateRef:Ref; reservationRef:F<Ref>; arrival:F<LocalDate>; departure:F<LocalDate>; roomQuantity:F<integer>; roomType:F<string>; billingRef:F<Ref>` |
| `EventData` | `eventRef:Ref; source:F<hms>; masterRef:F<Ref>; status:F<string>; startAt:F<Timestamp>; endAt:F<Timestamp>; layout:F<string>; persons:F<integer>; setup:F<string>; lines:S<List<EventLine>>; quotedAmount:F<Money>; contractedAmount:F<Money>; depositAmount:F<Money>; depositReceived:F<Money>; depositDueDate:F<LocalDate>; linkedRefs:F<Ref[]>` |
| `EventLine` | `lineRef:Ref; kind:F<string>; description:F<string>; quantity:F<integer>; startsAt:F<Timestamp>; endsAt:F<Timestamp>; amount:F<Money>` |
| `NotesData` | `notes:List<NoteObservation>` |
| `NoteObservation` | `noteRef:Ref; resourceRef:Ref; sourceKind:F<note/message/trace>; permittedText:F<string>; audience:F<staff_only/customer_disclosable>; customerPrintable:F<boolean>; status:F<string>; dueAt:F<Timestamp>; deliveredAt:F<Timestamp>; method:F<string>; authorLabel:F<string>; createdAt:F<Timestamp>` |
| `SentEmailData` | `records:List<SentLogRecord>; deliveryEvidence:hms_log_only` |
| `SentLogRecord` | `logRef:Ref; recipients:F<string[]>; sentAt:F<Timestamp>; kind:F<string>; subject:F<string>; attachments:S<List<DocumentMetadata>>; error:F<string>` |
| `KnowledgeData` | `entries:List<KnowledgeEntry>; conflicts:{entryRefs:Ref[],topic:PropertyKnowledgeTopic}[]` |
| `KnowledgeEntry` | `entryRef:Ref; topic:PropertyKnowledgeTopic; content:F<string>; sourceRef:Ref; version:string; ownerRef:Ref; approvedAt:Timestamp; effectiveFrom:Timestamp; effectiveUntil:Timestamp or null; audience:staff_only/customer_disclosable; documentRefs:Ref[]` |

Event depositAmount, depositReceived and depositDueDate bind separately to their proved source fields; the documentation's amount/received wording is not permission to equate them. Keep unproved meanings unknown. Neither the amount nor event status proves received money, and an HMS received-money observation is not bank settlement. Negative inventory is a valid source observation for overbooking, not an input-validation failure or independent proof of bookability.

Return only fields authorized for the trusted audience; an audience flag is not permission to disclose a staff-only value to a guest or unauthorized caller. Source text, quote restrictions and policy prose remain untrusted bounded data. Default short labels are capped at 256 characters; paragraphs/items at 2,000 characters. Source-bound extracted text retains the existing maximum 20 MiB input / 256 KiB output / 50 pages, plus the stricter downstream context budget; oversize/scan-only is partial or unsupported, never a request to bypass extraction guards. The property knowledge reader has the same bounded entry/list/output limits and no arbitrary-file lookup.

Multi-currency deposits use one DepositSummary per currency; a single-currency result is a one-item list. Every Money in one summary has the same currency. Unknown currency makes aggregation unavailable. A parent result's page describes its primary collection when there is one; independently selected sections retain their own List page/completeness. Section selectors are unique and nonempty (folio max 3, group max 3, notes states max 2); a requested unproved branch returns a section blocker. `status:ok` requires complete supported requested scope; partial/unknown requested facts cannot be promoted by omitting issues.

### Tool-by-tool schema and rationale

| Tool / unit | Required input; defaults | Concrete data fields | Evidence demand / reason |
|---|---|---|---|
| hms_find_reservation / U8 | {candidateId:Ref} | matches with opaque reservationRef, safe label, confirmation/external-reference kind, status, arrival/departure, room type and match evidence; matchCount, capped | 111/253 reservation labels. Exact identity is the prerequisite for finance/documents; lookup is distinct from deep disclosure. |
| hms_read_reservation / U8 | {reservationRef:Ref,sections?:[core,stay,rates,policies,operations],detail?:summary-or-detail}; default core+stay; unique nonempty sections, max 5 | core identity/status and typed linked guest/org/agency/group refs; stay dates/room quantity/adults/children/ages/additional guests; rates per-night plan/basis/inclusions/tax; policies booked guarantee/deposit/cancellation; operations supported special requests/deadlines/action state | Same 111-label family, not 111 extra records. Coherent snapshot helps changes/confirmations/checking. A company label is not privileged credit/terms. |
| documents_list_existing / U9 | {scopeRef:Ref,source:DocumentSource,kinds?:DocumentKind[],limit?:1..50,cursor?:Ref}; limit 20, source required | documents with documentRef or null, source/kind/version/issue time/status, parent/payer scope, safe display name, MIME/size/hash if known, retrievable, retrievalBlocker, price visibility; sourceOutcomes | 136 mixed-source document labels. Explicit source prevents treating manual/SCS/mail material as an HMS invoice. Metadata can help without bytes. |
| documents_read_existing / U9 | {documentRef:Ref,format:text-or-artifact} | source/kind/version, MIME/bytes/hash, text or authorized artifactRef, extraction state/page count, identity/date/payer/price-visibility validation; no signed URL/token to model | Same 136 family plus 122 mail-artifact labels; overlap, not addition. Real bytes are necessary for “attached”; never regenerate silently. |
| hms_read_folio / U17 | {reservationRef:Ref,sections?:[balance,deposits,transactions]}; default balance+deposits; transactions need separate branch proof | balances by folio/type/currency; deposits due/paid/refunded/forfeited/transferred/untransferred; bounded posting ref/date/type/source/destination/amount; liability/authorization only where proved | 28/253 finance labels; +7 touches after reservation/documents, but high consequence: POP, authorization, A/R transfer and settled money differ. |
| hms_quote_stay / U7 | {quoteRequestRef:Ref,detail?:summary-or-detail}; summary | **Hotel Availability** dates/rooms/occupancy; every occupied-night observation with room/rate/currency/basis/inventory/restrictions/tax/fees/inclusions; continuity/room-move requirements; display-rate sum versus complete total; bookability, held:false, unresolved fields | 42/253, 41/251 strict outbound rate labels; +19 on 253 after reservation/documents/finance. No inventory hold. OSRRAV is legacy/diagnostic only. |
| hms_company_account_read / U15 | {reservationRef:Ref}; exact linked account only | existing typed billing mode/terms, required contract/paperwork/reference, A/R/org/agency binding, restrictions/negotiated-rate identifiers and audience flags | 59/253 curated identity/bill-to contexts, not 59 exclusive account reads. Keep existing privileged billing meaning; simple identity belongs in reservation context. |
| hms_group_block_read / U15 | {groupRef:Ref,sections?:[summary,blocks,delegates]}; summary, max 3 | group status/date/release policy; per-night/type blocks/pickup/remaining with source semantics; separately entitled delegate stays/room quantities and billing refs | Part of 53/253 group/event labels, not another 53. Low marginal reach (+2 after others), needed depth. Delegates are not rooms. |
| hms_event_read / U15 | {eventRef:Ref}; exact existing HMS event | event/master source, status/dates/times, layout/persons/setup, supported service/room lines, quoted/contracted amounts/deposits/linked records, section outcomes | Same mixed 53-label family; actual HMS ownership must be proved. No SCS connector or BEO generation implied. |
| hms_read_notes_traces / U15 | {resourceRef:Ref,states?:[open,completed],limit?:1..50,cursor?:Ref}; open, limit 20 | bounded note/trace resource/source, permitted text, privacy/customer-print flags, status, due/delivery date/method, author/time only if exposed | Context facet; no defensible standalone frequency. Separate sensitivity/untrusted text and consequential Complete/Submit controls. |
| hms_sent_email_audit / U9 | {reservationRef:Ref} | bounded logged recipients/time/type/subject, attachment metadata/error/completeness; deliveryEvidence:hms_log_only | Communication facet (37/253 curated contexts), not 37 HMS-only reads. Recorded-send evidence is not delivery or bytes. |
| property_read_knowledge / U16 | {topic:PropertyKnowledgeTopic,detail?:summary-or-detail}; summary | entries with approved content/topic/source/version/owner/approved time/effective dates/audience, linked existing document refs and conflicts | 70/253 non-PMS policy labels. Approved file/attachment reader, not a knowledge platform; old replies are not policy authority. |

DocumentSource is mail_attachment|hms_sent_attachment|hms_finalized_document|approved_property_document; no implicit all. A caller may request several source-bound reads within budget, retaining each outcome. DocumentKind is reservation_confirmation|tax_invoice|pro_forma|folio|statement|contract|supplier_compliance|property_information|other_existing. Kind never grants access or implies an integrated provider.

PropertyKnowledgeTopic is check_in_out|cancellation|deposits_payment|room_types|meals_children|amenities|parking_transport|location_contacts|groups_events|compliance_documents. Payment instructions require separately approved current material, never customer-supplied instructions or historical card-request prose. Raw card details/passwords/room PINs/passport IDs and unrelated profile history are excluded.

The existing mail_read_artifact ID remains a versioned adapter: {attachmentId:Ref} to authorized bounded extraction, never an arbitrary locator. hms_list_documents remains an HMS-only metadata adapter. Neither is silently redefined as a universal source or verified financial fact. Thin agent wrappers use the same services after direct verification.

### Quote input and completeness

The trusted producer of quoteRequestRef normalizes {arrival,departure,rooms:[{quantity,adultsPerRoom,childAges,roomTypeRef?,ratePlanRef?}],currency,organizationRef?,agencyRef?,groupRef?} from authorized authored request spans and approved code vocabulary. Missing dates/ages/occupancy stay missing; never default to two adults or infer negotiated-rate entitlement. Separate stay segments get separate bound requests and an explicit whole-request coverage map; do not omit a segment. Existing homogeneous-room limits remain explicit; richer mixes need a newly proven branch.

Departure is exclusive and every occupied night is represented. A display-rate sum is not a stay quote when tax/packages/fees/occupancy/restrictions are unknown. Current bookable:false, stayTotal:null, occupancyPriced:false mean “not established as bookable,” not “sold out.” The new result uses unknown bookability with INCOMPLETE_QUOTE where appropriate. A proven complete quote still has held:false and never claims a booking was created.

### Example: useful partial finance result

Synthetic example; values and IDs are not client data. The example requests only the summary view; the balance is one scoped folio, not a statement about all guest liability.

~~~json
{
  "input": {
    "reservationRef": "res_demo_01",
    "sections": [
      "balance",
      "deposits"
    ]
  },
  "output": {
    "schemaVersion": "folio-read-rich/1",
    "status": "partial",
    "scopeRef": "res_demo_01",
    "completeness": "partial",
    "data": {
      "balance": {
        "state": "available",
        "data": {
          "items": [
            {
              "folioRef": "folio_demo_01",
              "folioType": {
                "state": "known",
                "value": "guest",
                "evidenceRef": "ev_demo_balance",
                "observedAt": "2026-09-07T10:00:00Z",
                "sourceUpdatedAt": null,
                "expiresAt": "2026-09-07T10:05:00Z"
              },
              "balance": {
                "state": "known",
                "value": {
                  "amount": "1200.00",
                  "currency": "ZAR",
                  "basis": "ledger_balance",
                  "taxTreatment": "not_applicable"
                },
                "evidenceRef": "ev_demo_balance",
                "observedAt": "2026-09-07T10:00:00Z",
                "sourceUpdatedAt": null,
                "expiresAt": "2026-09-07T10:05:00Z"
              }
            }
          ],
          "page": {
            "returnedCount": 1,
            "hasMore": false,
            "nextCursor": null
          }
        },
        "completeness": "complete",
        "issues": []
      },
      "deposits": {
        "state": "unavailable",
        "data": null,
        "reasonCode": "PARTIAL_WINDOW",
        "issues": [
          {
            "code": "PARTIAL_WINDOW",
            "retryable": false,
            "safeNextAction": "manual_review"
          }
        ]
      },
      "transactions": {
        "state": "not_requested",
        "data": null,
        "reasonCode": "NOT_REQUESTED",
        "issues": []
      },
      "liabilityLocation": {
        "state": "unknown",
        "value": null,
        "reasonCode": "SURFACE_UNPROVEN",
        "evidenceRef": null,
        "observedAt": null,
        "sourceUpdatedAt": null,
        "expiresAt": null
      },
      "authorization": {
        "state": "not_requested",
        "value": null,
        "reasonCode": "NOT_REQUESTED",
        "evidenceRef": null,
        "observedAt": null,
        "sourceUpdatedAt": null,
        "expiresAt": null
      }
    },
    "unavailableSections": [
      {
        "section": "deposits",
        "reasonCode": "PARTIAL_WINDOW"
      }
    ],
    "evidence": [
      {
        "evidenceRef": "ev_demo_balance",
        "sourceSystem": "hms",
        "sourceSurface": "reservation_folio",
        "requestBranchId": "folio_summary",
        "observedAt": "2026-09-07T10:00:00Z",
        "sourceUpdatedAt": null,
        "expiresAt": "2026-09-07T10:05:00Z",
        "scopeVerified": true,
        "artifactRef": null
      }
    ],
    "page": null,
    "issues": [
      {
        "code": "PARTIAL_WINDOW",
        "retryable": false,
        "safeNextAction": "manual_review"
      },
      {
        "code": "SURFACE_UNPROVEN",
        "retryable": false,
        "safeNextAction": "manual_review"
      }
    ]
  }
}
~~~

This supports a scoped balance observation, not “no deposit,” “paid in full,” or “please pay this amount” without checking liability, recipient authority and remaining asks.

## 4. What exists and what must be proved

The [source inventory](../../.private/pms-tools-replan-2026-09-07/current-tool-inventory.json) and [runtime audit](../../.private/pms-tools-replan-2026-09-07/tool-architecture-audit.md) distinguish source code, execution wiring, agent exposure, retained proof and current activation.

- Nine contracts exist: eight HMS plus mail artifacts. The normal candidate session supplies find and conditional quote; finance/communications/artifacts are not all wired. The handler index's seed execute returns a stub while proving binding.
- Normal audited runtime requires auditSpec; newer quote/folio/sent drivers need it wired. Quote normalization disagrees with the wrapper's older candidate kind. Direct services and an audited harness must work before drafting.
- Independent calls need real execution ownership: U8 adds a model-free read_tool purpose on the existing HMS-lane ledger, trusted closed request admission, fenced private result receipts and an admission switch independent of drafting. The existing worker owns the runtime; all worker/proof processes share the same tenant/property advisory lock. An in-worker call reuses its current fence. This is not another queue/browser service, and a process-local semaphore alone cannot serialize a separate harness.
- Source flags alone do not prove “all tools off.” [August 6/7 retained activation evidence](../superpowers/plans/handoff-reports/2026-08-06-phase-b-autonomous-live-completion.md) reports six active tools and later deposit promotion; not September live-state proof.
- Company billing, group counts and event reads have structural blockers. Narrow proved fields can help, but fixtures returning a blocker are not finished readers.
- Existing finance partial results use zero placeholders guarded by draftReady:false. Rich consumers require per-field unknowns; do not weaken the legacy drafting gate. The current classifyDepositActivity helper also defaults unrecognized activities to paid; replace that fallback with explicit unknown/unmapped handling for rich finance, retain affected total incompleteness, and prove a closed source mapping before any paid claim.
- Existing [mail artifact reading](../../apps/server-pilot/src/mail/artifacts/read-artifact.ts), bounded S3 reads and mailbox authorization provide the first document path. HMS metadata is non-retrievable until an inert byte route is proven.
- [Tax Invoice role/menu absence](../solutions/integration-issues/hms-tax-invoice-role-menu-absent-2026-08-07.md) is an entitlement blocker, not permission to guess hidden function codes.

Each enabled branch requires exact scope/role/version, known-positive and legitimate negative/ambiguity controls, bounded completeness, parser/source agreement and a current release fingerprint. Capture private trace/video evidence through the actual audited service path, not only mock parsers. Hand off tested scenarios, failure/manual paths and expiry. The agent owns research/coding/testing/repair; the user is not the coder or browser operator.

## 5. Documentation limits that change implementation

The [full capability report](../../.private/pms-tools-replan-2026-09-07/pms-docs-capabilities.md), [structured fields/actions](../../.private/pms-tools-replan-2026-09-07/pms-capabilities.json), and [53-source manifest](../../.private/pms-tools-replan-2026-09-07/docs-public/manifest.json) retain versions/fetch dates/hashes/disconfirmation. Most decisive topics are 2026.08; company/group/event also use 3.8/3.8.x; Sent Email uses 2025.x. None establishes the installed hotel version.

| Read assumption | Product evidence | Decision |
|---|---|---|
| Availability controls are inert | [CRS creates a record](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html); [Guest Stay temporarily holds selection](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573093.html) | Exclude both routes from reads. |
| Current grid prices occupancy | [Hotel Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html) has richer inputs but Shop by Day ignores restrictions; [Rate Shop](https://docs.infor.com/hms/2026.08/en-us/hmsolh/pages/osrasd_help.html) depends on configuration | Prove a richer route or return partial displayed rates, not full totals. |
| Print means existing bytes | [Print count changes](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428580083.html); [generation/finalization](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579864.html) can transfer deposits/post/check out/send | Metadata, bytes and generation stay separate. |
| Zero balance means paid | [Folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html) can transfer liability to A/R; [authorizations](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571939.html) are not receipts | Keep liability and transaction evidence. |
| Cancellation has no finance effects | [Cancellation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html) can charge/refund/forfeit | Future operation needs approved effects and reconciliation. |
| Rooming list is just a report | [Create rooming list](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428589568.html) creates reservations | Read existing delegates only. |
| Profile tabs never save | [Organization creation](https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428593016.html) saves on another profile tab | No create/edit flow during reads. |
| Complete/Submit dismisses a message | [Complete Message](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428576416.html) asserts delivery; [traces](https://docs.infor.com/hms/2026.08/en-us/hmsolh/mru1429015474343.html) may send/schedule/lock checkout | Read without changing state. |
| Logged email proves delivery/bytes | [Sent Email](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html) documents metadata/errors | Log-only evidence; no replay or attachment promise. |


## 6. Future action contracts - catalogue only

No executor, write credential, write registry entry or automatic-send tool is built now. These contracts retain research for a later plan; tenant version, role and compliant provider integration still need verification.

### Shared future-write contract

- Preparation returns an inert proposal: proposalRef, typed target/creation scope, expected-before fingerprint, exact field/record diff, fees/taxes/payment/fiscal/communication effects, required approver role, expiry and reconciliation plan. Preliminary form entry must also be inert; “preview” cannot create a record.
- Execution requires {proposalRef,approvedOperationRef,idempotencyKey}. Approval binds full payload/target/current-state/allowed effects/requester/expiry. No model self-approval, freeform patch or force flag.
- Closed outcome: {operationRef,status,affectedRefs,beforeEvidenceRefs,afterEvidenceRefs,actualEffects,reconciliationRequired,recovery}. Status is applied/rejected/conflict/duplicate_prevented/partial_success/unknown_outcome. Each operation defines concrete typed effects, not an arbitrary object.
- Revalidate before the first consequential step. Changed state returns conflict and requires a new approved proposal. A local idempotency key does not make HMS or a provider idempotent.
- Timeout after possible submission is unknown outcome. Inspect authoritative reservation/ledger/provider/invoice/send state before retry. Never re-charge/re-book/re-send blindly. Financial/fiscal correction usually requires a compensating action or manual recovery, not deletion.
- Success requires independently observed saved effects for every affected record. Customer notification is separate and human-approved. A composed/sent email saying “done” is not action proof.

### Operation-specific schema and side effects

Counts are curated action-context records on the 253 subset, not necessary write calls or verified executions. They include requested/promised/preparation/claimed outcomes. Shared context counts are not allocated or repeated as independent coverage. Exact IDs and original/strict-outbound/extended counts remain in the private record map.

| Action family; contextual count | Typed proposal payload beyond shared target/state | Preconditions and outcome to reconcile | Source, approval and recovery |
|---|---|---|---|
| Reservation create/hold; 20 | guest existingProfileRef or approved new identity; dates; room quantities/occupancy/child ages; rate/offer ref; org/agency/group; guarantee/settlement; hold policy | Valid offer and no duplicate stay; new confirmation/status/inventory plus profile/account effects | [Creation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573093.html). Reservation approval before hold; reconcile partial record; cancellation is separate compensation. |
| Reservation amend/reinstate; 21 (20 strict outbound) | stay/share/segment refs; allowed date/room/guest/occupancy/allowance patch; rateMode retain/requote/approved-override; reason | Expected old state; read back every changed segment/share/rate/tax/activity/occurrence | [Stay Wizard](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html). Whole-stay versus interval explicit; no automatic revert after repricing. |
| Cancel/release reservation; 7 | exact occurrence; reason/note; booked-policy ref; approved fee/refund/forfeit/charge amounts and method | Cancelled status, inventory and all ledger/provider outcomes; quote withdrawal is different | [Cancellation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html). Reservation/finance approval; uncertain charge/refund reconciles before retry. |
| Guest/company/agency/A-R profile create/update; 11 (10 strict outbound) | typed entity; identity/contact/fiscal/billing patch; duplicate resolution; propagation scope | Profile versus stay-only correction; changed fields/links read back; issued invoice does not automatically change | [Guest](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428591565.html), [organization](https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428593016.html). Data-owner approval; tab change can save; explicit compensation. |
| Group create/amend/status; shared group/event 29 | booker/group identity; start/end; status; rate/policy/billing; delegate propagation | New/changed group, auto billing account and inventory; Prospect/Tentative/Definite differ | [Create group](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428584716.html), [status](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428584950.html). Group/finance authority; delegates reconciled separately. |
| Group block/release; same shared 29 | per-night/type expected and desired CON/BLK; release schedule; approved inventory delta | No illegal past/checked-out changes; prove field meanings; read block/pickup/house inventory | [Blocks](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428587883.html). Inventory approval; partial-night reconciliation before correction. |
| Group delegates create/update/cancel; same shared 29 | selected/new delegate identities; quantity; date/room/rate mask; expected count; action | Creation makes reservations; asynchronous updates may partially fail; reconcile each child, not batch status alone | [Rooming creation](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428589568.html), [update](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428589131.html). Group authority; retry only proved unapplied children. |
| Deposit post/payment post and allocate; 0 on 253, 5 original420 | exact account/folio; transaction code; amount/currency; receipt/provider handle; invoice allocations; fee/fiscal options | Verified receipt/authority, not POP alone; ledger/transfer/processor/invoice refs | [Deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html), [payment](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428582360.html). Finance approval; compensating correction, never erase history. |
| Card/VCC charge/collection; 5 | tokenized provider instrument; reservation/payer; amount/currency; reason; authorization/capture mode | Compliant provider workflow and source restrictions; authorization/capture/settlement distinct | [Authorization](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571939.html). Execution contract unproved; no raw-card email; reconcile ambiguous charge. |
| Payment-link create/replace; 15 | payer/reservation; amount/currency; expiry; provider/template; prior-request ref; replacement policy | Concrete gateway contract; new request status, old-link disposition, delivery separate | No supported HMS link-issuance contract found. Finance/provider approval; explicit revoke/replace, no inferred send. |
| Refund/forfeit; 5 | original deposit/payment; amount/currency; reason; original method; explicit remaining-forfeit choice | Refundable amount/approval; processor/ledger/credit/fiscal results, not intake alone | [Deposit actions](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html). Finance authority; no blind retry of unknown refund. |
| Folio adjustment/discount/void; shared credit/adjustment 6 | original posting; amount or percent; reason/code; tax/package scope | Current posting/approval; contra entries and tax/package reversals retain original links | [Corrections](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428576994.html). Finance authority; compensation, not destructive history editing. |
| Folio/deposit/credit transfer; same shared 6 | source/target account+folio; posting refs; amount or percent; currency; reason | Both scopes authorized; paired source/target entries; no double-counted payment | [Transfers](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428577087.html). Finance approval both sides; reconcile partial transfer first. |
| Financial document issue/amend; 35 (34 strict outbound) | type/template/account/payer/locale; folios/charges; original version; approved identity/amounts; store versus later send | Retrieval versus new artifact resolved; immutable bytes/version and legal/informational state | [Print options](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428577321.html), [tax generation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579864.html). Finance/template authority; may audit/fiscalize/post. |
| Tax finalize/correct/void/reinvoice; shares document 35 | invoice/folio/payer; correction links/reason; independently approved payment/checkout/email/profile changes | Fiscal sequence/correction state and every deposit/payment outcome | [Generation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579864.html), [invoice view](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428580083.html). Finance/fiscal authority; correction document, not overwrite. |
| Standalone quote prepare/revise/split; 40 | actual owner system; proposal/version; stay/event segments; quantities; supported price/tax/inclusions; terms/exceptions | Quote not booking; all segments/arithmetic/identity checked; artifact without inventory hold | [Confirmation contents](https://docs.infor.com/hms/3.8/en-us/hmsolh/mru1453227736677.html) does not prove SCS/manual ownership. Template/owner approval; source connector unproved; retain versions. |
| Event/function create/amend/cancel; shared group/event 29 | actual HMS/SCS event/master; dates/times/layout/resources/service lines/pricing; explicit Bill-to-Master/transfers | Source resolved; resource/item dates, transfer rules, deposits/contracts/BEO effects | [Events](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428591097.html), [BEO](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428560300.html). Event/finance authority; SCS integration separate. |
| Contract/e-signature prepare/send/accept; 5 | contract/version/terms; parties/signing order/expiry; prior-envelope ref; acceptance-evidence ref | Prepared, sent, signed return and accepted terms distinct; deposits/holds separate | [BEO](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428560300.html) is not e-sign API proof. Contract owner/provider approval; connector unproved; audited void/replace. |
| Communication send/resend/attach; 251 physical outbound candidates | draft/document versions; recipients/sender/attachments; previous-send ref; consent/purpose; approved payload digest | Revalidate at enqueue/every transmission; acceptance/unknown/delivery distinct | [Email folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/msh1719480545520.html), [sent log](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html). Human send approval; existing manual mail retained; no new autonomous PMS sender. |
| Note/trace/message change; no standalone frequency | exact resource; kind/text; privacy/print flags; delivery time/method/recipient; alert/checkout-lock effects; actual delivery for Complete | Source/audience authority; persistent state/schedules/messages/lock read back | [Notes](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428576136.html), [traces](https://docs.infor.com/hms/2026.08/en-us/hmsolh/mru1429015474343.html). Operations approval; schedule cancellation/unlock explicitly scoped. |
| Policy/comp/credit/fee exception approval; 16 | policy/offer; exception/amount/dates/guest; reason; approver-role proof; expiry | Authorized decision, not customer request or rate read; following write separately approved | [Policies](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428595450.html). Human-authority workflow; no model-granted discount. |
| Callback/transport/overflow/meals/cot/site visit; 23 (22 strict outbound) | staff/provider; guest consent; service/date/time/leg/headcount; price; commitment/cancellation terms | Actual acceptance/completion; PMS note is not driver/chef readiness | Non-PMS contract unproved; [BEO](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428560300.html) only where applicable. Provider/human authority; cancel accepted arrangements explicitly. |
| Prepare/revise report/workbook; 0 on 253, 37 original420 | report kind/version; property/date/as-of; source scope; formulas/denominators; audience; target version | Circulation is not generation; reproducible totals; historical/forecast/net/gross distinct | [Deposit ledger](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579271.html) is one source, not every report. Finance/operations approval; new version, no silent overwrite. |

Additional contexts retained without fabricated counts: guarantee acceptance/state changes (G248/G300), commission payable/payment (G131), rate-contract maintenance (G413) and housekeeping/room balancing (G013/G022). Their future payloads require exact contract/account/room/date, desired state and approver; source, execution and compensation remain unproved. Do not hide them inside generic profile/reservation patches.

## 7. Read candidates retained for later planning

| Candidate not independently built in this pass | Evidence | Required contract / reason to defer |
|---|---|---|
| Existing payment-request status/link | 22/253 curated contexts | Provider request ref, payer/reservation/amount/expiry/state, separate delivery. Concrete HMS gateway contract unproved; no bearer tokens or status inferred from folio. |
| Full reservation/channel history | 14/253 curated contexts | Exact occurrence/channel IDs, ordered source events and completeness. Proved HMS history can join U8; no new OTA/channel connector. |
| Operational reports/occupancy | 37 original420, none on 253 | Report/version/as-of/denominator, historical versus forecast, scoped export. Lower initial customer-drafting priority; not automatically part of email dashboard. |
| Supplier/staff service state | 26/253 curated contexts, 25 strict outbound | Exact provider/leg/date/person, acceptance and observation time. HMS does not prove driver/chef/other-hotel readiness; authorized existing mail only. |
| External SCS/event contracts | Within 53 group/event labels plus platform extension | Actual system/source/version/permissions. Authorized mail copies readable now; no inferred connector or write capability. |

## 8. Acceptance and research posture

- Direct deterministic callers invoke released reads without a drafting model. Useful typed values or precise section blockers; handler_stub is not a working capability.
- Limits and forbidden effects are tested through the actual intended composition, including audit metadata, worker ownership and cleanup.
- Known positives, ambiguity, legitimate negatives, masked/stale fields, wrong/changed documents, sold-out middle nights and finance sign/transfer cases have independent expected outcomes.
- Read-only exploration never enters creation/printing/finalization/charge/Complete workflows. Exhaust safe alternatives for missing role/transport, retain a precise blocker and continue other sources/tools.
- Later drafting uses the same facts but separate all-ask/recipient/policy/action/attachment checks. A useful read is not automatically a safe complete customer reply.
- Confidentiality, approved processing, retention and human send approval remain binding. Tests use synthetic/local or verified disposable databases, never pilot/production RDS.
- Research used local evidence and ordinary Exa/public primary docs; no expensive Exa Agent. Installed version, September activation, pure PMS bytes and complete occupancy-priced quotes are not established here.
