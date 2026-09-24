# Centurion PMS tools — binding Definition-of-Done contracts (evidence-cited)

Date: 2026-09-11.  
**Status: BINDING** for autonomous Wave A/B after Wave 0 HITL.  
**Parent plan:** `2026-09-11-centurion-pms-tools-robust-catalogue.md`.

## Audit answer (2026-09-11)

| Question | Answer |
|---|---|
| Had every tool a Wave-0-depth DoD before this file? | **No.** Parent plan had full DoD for `hms_find_reservation` + a short A1 block + thin master tables. Writes were kickoff sketches only. |
| Did we re-check prior evidence plans? | **Yes.** Sep-07, 3949, kickoff, attach, TS — then **also** pre-Astra Aug demand + capability-matrix + Sep-04 gold architecture + Astra triage (surface/Infor cites). |
| Was “evidence” only demand ranks? | **Initially yes (gap).** Fixed: class **A** demand vs class **B** surface availability vs class **C** impossible-schema guard. Matrix below. |
| Goal of this file | Zero-shot auton build: closed schemas + **grabability cites** + honest stop when live dump omits — no endless hunt for invented keys. |

### Evidence sources (priority order)

**Two different “evidence” meanings — do not conflate:**

| Class | Answers | Typical sources |
|---|---|---|
| **A — Demand / why build** | Mail/gold ranks; tool order | 3949 gold, Aug demand docs, Sep-04 gold architecture, Sep-07 §1 counts |
| **B — Surface availability / why field *should* be grabable** | Official Infor surface + capability matrix + live dump | `capability-matrix.md`, Sep-07 §5 Infor table, Aug demand “Field groups → Infor surfaces”, private 53-source manifest, live GRID/detail fixtures |
| **C — Honesty / impossible-schema escape** | What to do when B fails at live | `SURFACE_UNPROVEN`, section blockers, allowed-null, amend contract on dump, never invent keys |

Prior DoD **Evidence** rows were mostly **A**. That is not enough to stop endless search for impossible fields. **B + C** below are binding for Payload gate.

1. `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` — closed payloads L100–156; **§5 Infor product decisions** L317–331; write §6 Infor URLs; issue code `SURFACE_UNPROVEN` L90  
2. `docs/infor-hms/capability-matrix.md` — officialDocs URLs per capability; “docs prove product capability, not tenant entitlement or selectors” L9  
3. Pre-Astra: `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` (also 08-03/08-04) — **Field groups → Infor surfaces** L132–145  
4. Pre-Astra: `docs/infor-hms/centurion-reservationist-roadmap-2026-08-21.md` — HMS browser gates; capability-matrix pointer  
5. Pre-Astra Cursor: `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md` — claim/deny envelopes L55–63 (find must deny invent rate/folio)  
6. Astra: `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` — 53-source Infor evidence; docs ≠ role/transport proof L263  
7. `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` — 3949 ranks (**A**)  
8. `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md` — write order + attach Infor upload URL  
9. `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md` — attach surface  
10. Live post-mortem: `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` — dataspy 1941 keys (**B** ground truth for find)  
11. TS: `apps/server-pilot/src/hms/*-contract.ts`, `read-tools.ts`  
12. Parent robust catalogue — Wave 0 Match DoD + expected-vs-actual  

Private (not Git): `.private/pms-tools-replan-2026-09-07/{pms-docs-capabilities.md,pms-capabilities.json,docs-public/manifest.json}` — 53-source fetch hashes; cite via Sep-07 §5.

### Impossible-schema guard (class C — how we stop endless hunt)

| Rule | Source | Auton action |
|---|---|---|
| Docs ≠ tenant entitlement / selectors | capability-matrix L9; Astra triage L263 | Live role/menu miss → `ROLE_UNAVAILABLE` / entitlement blocker packet; **do not** invent function codes |
| Schema design ≠ proved branch | Sep-07 L78, L98 | First live dump amends required vs allowed-null; unknown keys rejected |
| Unproved section → blocker, not zero/guess | Sep-07 L86–90, L139; issue `SURFACE_UNPROVEN` | `compare` accepts honest unavailable; **fails** if claimKeys invent |
| Catalogue field wrong for **this** surface | live-proof solution L55–59, L129; robust catalogue L76 | Example: `ratePlan` on find GRID — **out of contract**; move to `hms_read_reservation` |
| Live dump contradicts fixture/catalogue | robust catalogue Cuts; parent “companion wins until live dump + tests” | Amend DoD + unit fixtures; max 5 RCA; then blocker packet if surface truly absent |
| Role-gated roadmap reads | capability-matrix L76–78; Sep-07 L302–313 | `BLOCKED_*` skip in batch HITL — **done as honest skip**, not infinite search |
| Mail demand ≠ HMS bytes on stay | kickoff attach L139 | 420 mail-artifact ≠ proof doc already in Guest Stay Documents |

**Stop condition:** after live dump + ≤5 RCA, if required field still absent → amend contract (allowed-null / move owner surface) **or** ship `SURFACE_UNPROVEN` / `BLOCKED_*` packet. Never keep hunting for a key live dump already omitted.

### Anti-Astra / anti-vagueness

- Prefer Sep-07 closed fields + **§5 Infor decisions** over aspirational marketing.  
- Prefer 3949 **pending** write ranks over 420 cancel-first (**A** only).  
- Prefer capability-matrix / Aug surface table / live dump over demand ranks when deciding **where** a field lives (**B**).  
- Do **not** invent GRID/detail keys; `UNKNOWN` / stub / blocker stays explicit until live dump.  
- Per-tool DoD = contract fields to compare — not packaging-only.

### Wave 0 (pointer — full text lives in parent plan)

`hms_find_reservation` → public `reservationMatchSchema` only (`label` ≠ `"-1"`; no `ratePlan` claim; search grid only). See parent §Wave 0. Live run5 still fails label sentinel → Wave 0 **not** done.

**Find surface B proof already exists:** capability-matrix `reservation-search` → [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html); Aug demand L136 OSRESS.search; live dataspy 1941 (no `roomtype`/`rateplan` on GRID — ratePlan correctly out of find).

---

## Web re-verification (2026-09-11 evening) — Exa fetch of Infor primaries

**Process correction:** Step 1 = inventory cites already in prior plans. Astra/Sep-07/`capability-matrix`/kickoff/`2026-09-10-last-tools-email-automation.md` already did Infor web work (Astra triage L263: Exa + public-page fetch → 53-source catalogue). **Do not re-crawl from scratch.**

**What prior plans already cited (reuse, do not re-prove):**

| Already in repo | Where |
|---|---|
| Guest Stay / OSRESS | `capability-matrix.md` L31 |
| Room Type and Rate Availability PDF + CRS creates record | matrix L32/L44; Sep-07 §5 L323; Astra triage L256 |
| Folios / auth / Sent Email | matrix L51–52; Sep-07 §5 L326/L331 |
| Tax generation + invoice view | Sep-07 L325/L366–367; Astra triage L257 |
| Deposit / payment / cancel / Stay Wizard / upload docs / Email Folio | Sep-07 §6; kickoff; attach plan |
| Notes + traces URLs | Sep-07 §6 L372 (`s_t1424428576136`, `mru1429015474343`) |
| Group blocks CON/BLK URL | Sep-07 §6 L358 (`s_t1424428587883`) |
| Rate details action-button URL | **already** in `2026-09-10-last-tools-email-automation.md` L99/L183 (`s_t1424428572875`) |
| Private 53-source pack | `.private/pms-tools-replan-2026-09-07/` (same URL tables) |

**Tonight’s Exa:** mostly **redundant confirmation** that those URLs still resolve. Net-new usefulness was small:

1. Wire Rate-details URL into **read** DoD (was only in last-tools email plan, not companion matrix).
2. Clarify Property [Deposit ledger](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579193.html) ≠ per-stay Advance Deposit (Sep-07 already pointed deposit ledger as report source L375 — nuance was under-specified in folio DoD).
3. **Historical only:** `s_t1424428570597.html` was the old explicit “view room+rate avail” page. Current quote execution uses Hotel Availability; keep the old page/OSRRAV reference for diagnostic history, never as a fallback.
4. Fix bad pointer: event read ≠ Sep-07 L329.

**Answer:** Enough prior info for evidence-backed **owner surfaces**. More blanket web research **not** needed. Remaining gap = **live dump / role**, not missing Infor docs.

| Claim | Status vs prior cites |
|---|---|
| Guest Stay / find | Already cited |
| Rates on detail not search | Already cited (Rate details + create page); companion now points at them |
| CRS Check Availability creates | Already cited (do not re-argue) |
| Quote = Room+Rate Availability view | Already cited |
| Folio + advance deposit | Already cited |
| Tax list / Documents upload | Already cited |
| Notes/Traces/Blocks | Already cited in Sep-07 §6 |

**More Exa before Wave A?** **No.** Next evidence = live GRID/detail dump per tool.

---

## Surface availability matrix (class B) — all tools

*Demand ranks stay in per-tool Evidence rows. This matrix is the **grabability** audit. Status: `docs` = Infor URL cited; `live` = dump/fixture proved; `unproven` = must prove or blocker; `N/A` = non-HMS.*

| Tool | Owner surface (B) | Official / plan cite | Live field proof | If ungrabable |
|---|---|---|---|---|
| `hms_find_reservation` | Guest Stay search grid OSRESS | capability-matrix L31; Aug-01 L136; [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html) | **live** dataspy 1941 (post-mortem) | allowed-null / out-of-contract (ratePlan→read) |
| `hms_read_reservation` | Guest Stay **detail** + Rate Details | [Rate details](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428572875.html); Rate Information on [Creating guest reservations](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573093.html); Sep-07 L146 | **unproven** detail dump | section `unavailable` / `SURFACE_UNPROVEN` |
| `hms_read_folio` | Folio tab + per-stay Advance Deposit (**not** Property Deposit Ledger alone) | [Folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html); [Advance deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html); Property [Deposit ledger](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579193.html)=date summary | **unproven** | partial/unknown ≠ 0; never invent paid |
| `hms_list_documents` | Sent Email + Tax Invoicing list | [Sent Email](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html); [Tax invoices list](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579864.html) | **unproven**; tax menu may absent | entitlement blocker; `retrievable:false` |
| `documents_list_existing` | Explicit `DocumentSource` enum | Sep-07 L147–158; L44–61 mail≠HMS | mail paths stronger | empty HMS finalized = gap signal, not invent |
| `documents_read_existing` | Authorized artifact bytes | Sep-07 L148 | mail stronger; HMS bytes blocked | `retrievalBlocker`; no regenerate |
| `hms_quote_stay` | Room Type and Rate Availability only | [View room+rate avail](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428570597.html); never [CRS Check Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html) (creates record) | **unproven** nightly schedule | partial rates; `held:false`; deny create-from-click |
| `hms_group_block_read` | Group Booking Block tab CON/BLK | [Modifying room block](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428587883.html) (values exist; read≠Save); [Group Booking](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/groupbooking_help.html) | **unproven** / role | `BLOCKED_*`; no guessed CON/BLK math |
| `hms_event_read` | HMS event (not SCS) | Sep-07 L153 + §6 Events/BEO URLs; **not** Sep-07 L329 (org profile row) | **unproven** | `BLOCKED_EVENT_*`; no SCS invent |
| `hms_company_account_read` | Profiles / AR | capability-matrix L76 blocked; Aug-01 L141; Sep-07 L151 | **blocked** until tenant fields | stay blocked — do not invent |
| `hms_read_notes_traces` | Guest Stay Notes + Traces tabs | [Notes](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428576136.html); [Traces](https://docs.infor.com/hms/2026.08/en-us/hmsolh/mru1429015474343.html) — no Save/Complete | **unproven** | read without Complete/Submit |
| `property_read_knowledge` | Approved property docs (non-PMS) | Sep-07 L156 U16; Aug demand policy | knowledge corpus | no invented rates |
| `mail_parse_channel_payload` | Mail FW body | kickoff NEW; 3949 channel_fw | mail fixture | N/A HMS |
| `hms_sent_email_audit` | Sent Email log | capability-matrix L51; Sep-07 L331 log≠delivery | do not promote | — |
| `mail_read_artifact` | Nava mail bytes | Sep-07 L162; Aug-01 L145 | runtime bounds | N/A PMS video |
| `mail.send_with_attachments` | Nava SMTP | kickoff; Sep-04 no model compose | fixture/HITL | execute approve |
| `hms_attach_guest_stay_document` | Guest Stay Documents upload | [Creating/Uploading documents](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428568335.html); attach plan | **unproven** selectors | live blocker packet |
| `hms_generate_*` / `hms_email_folio` / confirm send | Print/Email Folio / Confirm | Sep-07 §6 L366–371 Infor print/email URLs | **unproven** | proposal only until role proved |
| `hms_post_payment` / `hms_refund` | Deposit / payment / refund | Sep-07 §6 L360–363 [Deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html) | **unproven** | finance HITL; unknown≠0 |
| `hms_create_reservation` | Guest Stay create / CRS after Select | Sep-07 §6 L353; §5 L323 exclude Check Availability-as-read | **unproven** | never treat avail read as create |
| `hms_cancel_reservation` | Cancellation UI | Sep-07 §6 L355 + §5 L327 finance effects | **unproven** | fees explicit |
| `hms_amend_reservation` | Stay Wizard | Sep-07 §6 L354 | **unproven** | whole-stay vs interval explicit |

---

## Universal gates (all tools)

| Gate | Rule |
|------|------|
| Contract | ID, effect, owner surface, required / allowed-null / forbidden sentinels |
| **Live surface dump** | Before required fields: dump **this tool’s** owner surface. Required ⊆ dump. **Also capture** filter aliases, key inventory, sentinels, denied controls, role blockers, selectors/URLs, cross-surface ownership notes for later tools. Never invent keys from catalogue or another tool’s dump. |
| Fixtures + unit | Live or mail fixture cut from dump; sentinel/missing-key; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` |
| Packaging | `view_only` (reads) or audited write; video/mail proof; digests; fail closed on mutation |
| Payload | `result.v1.json` vs contract; honest `claimKeys` / `unresolvedFields` |
| Expected-vs-actual | `oracle.v1.json` + `compare.v1.json` all-required-pass (max 5 RCA cycles) |
| Wave HITL | Batch only at wave boundary; write execute approve separate from promotion HITL |

**Write shared envelope** (`2026-09-11-write-tools-kickoff-from-3949-gold.md` §6):

1. Inert `proposalRef` + expected-before fingerprint + typed diff + effects + approver role + expiry  
2. Execute `{proposalRef, approvedOperationRef, idempotencyKey}` only  
3. Outcome `applied|rejected|conflict|duplicate_prevented|partial_success|unknown_outcome`  
4. Timeout after possible submit → `unknown_outcome`; never blind retry charge/book/send/upload  
5. Oracle = authoritative post-write reread (Wave A read tool)

**Common HMS read denied actions** (`apps/server-pilot/src/hms/read-tools.ts` `deniedCommon`):

`save`, `submit`, `create`, `amend`, `cancel`, `assign`, `post`, `settle`, `refund`, `transfer`, `void`, `finalize`, `send`, `resend`, `print`, `export`, `generate`

---

# Wave A — remaining reads

## A1 — `hms_read_reservation`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_read_reservation` |
| **2. Input schema** | **TS:** `reservationContextRequestSchema` — `{toolId:'hms_read_reservation', reservationRef:Ref, candidateId?:Ref, sections?:[core,stay,rates,policies,operations] default [core,stay], detail?:summary\|detail, admission?}` (`apps/server-pilot/src/hms/reservation-context-contract.ts`) |
| **3. Output / verify fields** | **ReadResult** `schemaVersion:'reservation-context/1'`. **Data** `reservationContextDataSchema` sections (each `available\|unavailable` + `ReadFact` children): **core** — confirmation, externalReference, status, guestRefs, organizationRef, agencyRef, groupRef; **stay** — arrival, departure, roomType, roomQuantity, adults, childAges, additionalGuests; **rates** — nightly ratePlan, price, inventory, restrictions, inclusions, taxes, fees; **policies** — guarantee, deposit, cancellation, policyVersion; **operations** — kind, permittedText, dueAt, sourceStatus. Unrequested sections honest `not_requested`. **Canonical:** Sep-07 `ReservationData` / `ReservationCore` / `ReservationStay` / `NightlyRate` / `BookedPolicies` / `OperationObservation` (`docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` L104–109). **Live dump-proved (2026-09-13 DETAIL_DUMP OSRESV.HDR keys=122):** policies `guaranteetype`/`depositreceived`/`canceldate`/`cancellationnote`; rates **summary** `rateplan`/`averagerate`/`nights`/`totalrate` (nightly Rate Details popup = EXTERNAL_ROLE_GATE — see `.private/wave-a-20260912/a1-external-role-gate-rate-details/EXTERNAL_ROLE_GATE.md`). **Invent-forbidden (absent from DETAIL_DUMP):** Sep-07 operations `kind`/`permittedText`/`dueAt`/`sourceStatus` — dump ops family only `lastcheckoutdate`/`waitlistpriority` (cite EC2 `.private/wave-a-20260912/a1-payload/compare.v1.json`) |
| **4. Surface / denied** | **Surface:** Guest Stay **detail** (inert) after find-minted `reservationRef`; `open_guest_stay_detail` **allowed** here. **Denied:** save/mutation (`2026-09-11-centurion-pms-tools-robust-catalogue.md` W0 find/read table); all `deniedCommon` if wired via HMS session |
| **5. Evidence** | **3949:** 223 named reads. **Sep-07:** L146 U8 detail disclosure. **420:** 111-label reservation family (split from find 2115) |
| **6. Oracle (one-line)** | Guest Stay detail network/DOM for each **requested** section matches `result.data` facts; unavailable sections match blocker; roomType/ratePlan depth owned when find grid lacked them |
| **7. Gaps** | **TS exists** (`reservation-context-contract.ts`). **Not in** `READ_TOOL_IDS` (`RESERVATION_CONTEXT_TOOL_IDS`). Live payload gate not done. `productionActiveReadToolIds()` empty |

---

## A2 — `hms_read_folio`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_read_folio` |
| **2. Input schema** | **TS:** `folioReadRequestSchema` — `{toolId:'hms_read_folio', reservationRef:Ref, candidateId:Ref, sections?:[balance,deposits,transactions] default [balance,deposits], admission?}` (`apps/server-pilot/src/hms/read-service-contracts.ts` L127–142) |
| **3. Output / verify fields** | **TS data:** `folioReadDataSchema` — currency, totalBalance, depositSummary (legacy), optional rich **balance/deposits/transactions** sections, liabilityLocation, authorization, disclosure (recipientClass, inquiryClass, claimEligibility), rowsScanned, bytesObserved, durationMs, observedAt (`folio-read-contract.ts`). **Canonical (Sep-07):** `FolioData` — balance by folio/type/currency; deposits due/paid/refunded/forfeited/transferred/untransferred; bounded postings; liabilityLocation; authorization (L114–117). **Verify:** balance/deposits match folio/ledger oracle; unknown ≠ 0 |
| **4. Surface / denied** | **Surface:** Folio + Deposit Ledger (`guest_stay` child). **Denied (registry):** `deniedCommon` + `email`, `line_item_export`, `advance_deposit_form`, `report_execution` (`read-tools.ts` L443–449). **Privacy:** `FOLIO_READ_PRIVACY_POLICY.deniedData` — card/VCC/credentials/transaction text (`folio-read-contract.ts` L14–23) |
| **5. Evidence** | **3949:** 763 reads; pending `post_payment` **165** (largest unfinished write). **Sep-07:** L149 U17, 28/253 finance. **420:** folio family 40 |
| **6. Oracle** | Folio/ledger response balances and deposit summaries match scoped `result.data`; no fabricated zero on unmapped deposit activity |
| **7. Gaps** | **TS exists**. Rich `ReadFact` sections optional; legacy zero placeholders guarded. Live compare gate pending |

---

## A3a — `hms_list_documents`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_list_documents` |
| **2. Input schema** | **No closed request Zod in `read-service-contracts.ts`.** **Registry:** `candidateRequirement: 'exact_reservation_child_or_sent_email_scope'` (`read-tools.ts` L370). **Branches:** `sent_email_list` \| `tax_invoice_list` via discovery ops. **Sep-07 sketch:** HMS-only metadata adapter; exact child scope (L162) |
| **3. Output / verify fields** | **TS:** `documentListReadDataSchema` — sourceClass (`finalized_tax_invoice`\|`sent_email_attachment`), rows (documentType, status, generatedAt/sentAt, attachmentPresent, retrievable:false), inventoryComplete:false, rowsScanned, bytesObserved, durationMs, observedAt (`document-list-contract.ts`). **Canonical gap:** Sep-07 `DocumentListData` / `DocumentMetadata` richer (documentRef, kind, version, sha256, retrievalBlocker, sourceOutcomes) — TS subset only |
| **4. Surface / denied** | **Surface:** Sent Email list + Tax Invoice list. **Denied:** `deniedCommon` + `open_attachment`, `preview`, `document_byte_fetch` (`read-tools.ts` L369) |
| **5. Evidence** | **3949:** companion to list 1059 / read 354. **Sep-07:** L162 HMS metadata ≠ bytes. **Astra 314:** 51 Sent-body rank |
| **6. Oracle** | Documents list/API or sent-email grid rows match `result.data.rows` count and per-row status/type classes |
| **7. Gaps** | **TS exists** (output). **Input schema UNKNOWN** in TS. Metadata-only; `retrievable:false` until byte route proven |

---

## A3b — `documents_list_existing`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `documents_list_existing` |
| **2. Input schema** | **TS:** `documentsListExistingInputSchema` — `{scopeRef:Ref, source:DocumentSource, kinds?:DocumentKind[], limit?:1..50, cursor?:Ref, requestedPriceVisibility?:allowed\|forbidden\|unknown}` (`apps/server-pilot/src/mail/artifacts/existing-document-contracts.ts` L225–234). **Sep-07:** L147 — limit default 20, source required |
| **3. Output / verify fields** | **TS:** `existingDocumentListDataSchema` — `documents[]` (`documentMetadataSchema`: documentRef, source, kind, version, issuedAt, status, parentRef, payerRef, displayName, mime, sizeBytes, sha256, retrievable, retrievalBlocker, priceVisibility, propertyRef, guestRef, stayStart/End, currentVersion), `page` (returnedCount, hasMore, nextCursor), `sourceOutcomes[]`. **Canonical:** Sep-07 `DocumentListData` / `DocumentMetadata` (L110–111) |
| **4. Surface / denied** | **Surface:** mail_attachment \| hms_sent_attachment \| hms_finalized_document \| approved_property_document (explicit source; no implicit all). **Denied:** no HMS screen mutation; byte fetch is separate tool (`documents_read_existing`) |
| **5. Evidence** | **3949:** 1059 named. **Sep-07:** L147 U9, 136/420 document labels (mixed source). **Kinds:** reservation_confirmation, tax_invoice, pro_forma, folio, statement, contract, supplier_compliance, property_information, other_existing |
| **6. Oracle** | Mail/HMS list sources match `documents[]` metadata + `sourceOutcomes`; empty HMS finalized list when mail has voucher = attach gap signal |
| **7. Gaps** | **TS exists**. Not in `READ_TOOL_IDS` (`EXISTING_DOCUMENT_TOOL_IDS`). `hms_finalized_document` empty until upload write exists |

---

## A4 — `documents_read_existing`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `documents_read_existing` |
| **2. Input schema** | **TS:** `documentsReadExistingInputSchema` — `{documentRef:Ref, format:text\|artifact}` (`existing-document-contracts.ts` L238–243). **Sep-07:** L148 |
| **3. Output / verify fields** | **TS:** `existingDocumentReadDataSchema` — document metadata, `artifactRef` XOR `text` (exclusive by format), extractionState, pageCount, `validation` (identity, stayDates, payer, kind, version, priceVisibility), sourceHash, artifactExpiresAt. **Canonical:** Sep-07 `ExistingDocumentData` + `DocumentValidation` (L112–113). **Verify:** bytes/hash match artifact oracle; validation all `match`/`current`/`allowed` for usable read |
| **4. Surface / denied** | **Surface:** authorized bytes only. **Denied:** regenerate silently; both text+artifact; signed URL to model |
| **5. Evidence** | **3949:** 354 reads. **Sep-07:** L148 U9. **420:** 136 doc-label family (bytes for “attached”) |
| **6. Oracle** | Artifact bytes SHA-256 + parsed headers match `result`; digest proof acceptable vs PMS video |
| **7. Gaps** | **TS exists**. HMS byte route may be `retrievable:false` until inert route proven (Sep-07 §4) |

---

## A5 — `hms_quote_stay`

> **Historical A5 contract (superseded 2026-09-17):** The Room Type and Rate Availability/OSRRAV material below is retained for legacy fixture and diagnostic history only. The client-approved quote workflow is Front Desk → Availability → **Hotel Availability**, including adults/children/ages and read-only Availability Details. OSRRAV is never a fallback; CRS Check Availability remains forbidden. See `docs/plans/2026-09-17-002-feat-playwright-fetch-quote-plan.md`.

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_quote_stay` |
| **2. Input schema** | **TS:** `quoteStayReadRequestSchema` — `{toolId:'hms_quote_stay', quoteRequestRef:Ref, quoteRequest:quoteRequestSchema, detail?:summary\|detail, admission?}` (`read-service-contracts.ts` L146–163). **quoteRequestSchema:** arrival, departure, rooms[{quantity, adultsPerRoom, childAges, roomTypeRef?, ratePlanRef?}], currency, org/agency/group refs, segments, authority bindings (`quote-request-normalization.ts`) |
| **3. Output / verify fields** | **TS:** `quoteStayReadDataSchema` — `nightlyObservations[]` (date, roomType, availableCount, ratePlan, displayedAmount, currency, restrictions, observedAt), `bookable`, `stayTotal`, `occupancyPriced`, `held:false`, `unresolvedInputs[]`, coveredNights, missingNights, displayRateSum, requestedRooms. **Canonical:** Sep-07 `QuoteData` / `QuoteNight` / `NormalizedQuoteRoom` (L118–120). **Verify:** nightlyObservations match rate surface; **never** CRS Check Availability |
| **4. Surface / denied** | **Current surface:** Hotel Availability + read-only Availability Details. **Legacy/diagnostic only:** Room Type Rate Availability (`room_type_rate_availability`/OSRRAV). **Denied:** `deniedCommon` + `crs_check_availability`, Reserve/create, `click_result_row`, `paging` (`read-tools.ts` L335) |
| **5. Evidence** | **3949:** 582 reads; send_quote write 404 (74 pending). **Sep-07:** L150 U7, 42/253 rate labels. **420:** availability/rate 43 |
| **6. Oracle** | Rate/availability UI or network body per night matches `nightlyObservations`; `held:false`; bookable false unless complete quote proved |
| **7. Gaps** | **TS exists**. Live quote normalization vs wrapper candidate kind disagreement noted Sep-07 §4 |

---

## A6 — `hms_group_block_read`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_group_block_read` |
| **2. Input schema** | **TS:** `groupBlockReadRequestSchema` — `{toolId:'hms_group_block_read', groupRef:Ref, sections?:[summary,blocks,delegates] default [summary], admission?}` (`read-service-contracts.ts` L177–191). **Sep-07:** L152 — max 3 sections |
| **3. Output / verify fields** | **Canonical:** Sep-07 `GroupData` — summary (groupRef, status, startDate, endDate, releasePolicy, billingRef); blocks per night/type (contracted, blocked, pickedUp, remaining, sourceFieldMapping); delegates (reservationRef, dates, roomQuantity, roomType, billingRef) (L122–125). **TS:** `groupBlockReadDataSchema` + `context-read-contracts.ts` section shapes; fixture kernel with disclosure enums |
| **4. Surface / denied** | **Surface:** Group Booking + Subgroup Room Blocks. **Denied (registry):** `deniedCommon` + `rooming_list`, `quick_entry`, `room_assignment`, `release`, `block_tab_direct_entry`, `document_tabs`, `focus`, `input`, `change`, `blur` (`read-tools.ts` L529–540) |
| **5. Evidence** | **3949:** 255 reads. **Sep-07:** L152 U15, part of 53/253 group/event. **420:** group/event 66 |
| **6. Oracle** | Group surface facts or honest `BLOCKED_*` skip packet; CON/BLK mapped by proof not guessed arithmetic |
| **7. Gaps** | **TS exists**. **Live blocker:** `GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER` — aggregate counts unproven (`group-block-read-contract.ts` L37–41). Defer live if role blocked |

---

## A7 — `hms_event_read`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_event_read` |
| **2. Input schema** | **TS:** `eventReadRequestSchema` — `{toolId:'hms_event_read', eventRef:Ref, admission?}` (`read-service-contracts.ts` L194–200). **Sep-07:** L153 |
| **3. Output / verify fields** | **Canonical:** Sep-07 `EventData` — eventRef, source, masterRef, status, startAt/endAt, layout, persons, setup, lines[], quoted/contracted amounts, depositAmount/depositReceived/depositDueDate (separate), linkedRefs (L126–127). **TS:** `eventReadDataSchema` — eventStatus, startAt/endAt, layoutClass, itemSummaries, deposit fields, disclosure (`event-read-contract.ts`) |
| **4. Surface / denied** | **Surface:** Event Reservation List. **Denied:** `deniedCommon` + `contact_read`, `notes_read`, `calculate`, `copy`, `pro_forma_generate`, `beo_generate`, `detail_double_click` (`read-tools.ts` L572–581) |
| **5. Evidence** | **3949:** 42 reads. **Sep-07:** L153 U15. **420:** group/event 66 |
| **6. Oracle** | Event list surface matches or `BLOCKED_EVENT_READ_SURFACE_UNPROVEN`; no SCS connector implied |
| **7. Gaps** | **TS exists**. **Live blocker:** `EVENT_READ_SURFACE_BLOCKER` (`event-read-contract.ts` L28–32). Defer live if blocked |

---

## A8 — `hms_company_account_read`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_company_account_read` |
| **2. Input schema** | **TS:** `companyAccountReadRequestSchema` — `{toolId:'hms_company_account_read', reservationRef:Ref, admission?}` (`read-service-contracts.ts` L167–173). **Sep-07:** L151 — exact linked account only |
| **3. Output / verify fields** | **Live dump-proved (2026-09-13):** Organization list `FSOGPF.LST` + Billing Profiles tab `FSOGPF.BPF` (`classPath: operations.common.fsbpfl`) — `organizationid`, `organizationname`, `araccountid`, `billingprofileid`, `accountstatus`, `accounttype`, `accountstanding`, `accountbalance`, `accountnumber`, `guaranteemethodcode`, `restrictedflag` (list). Agency list `FSBAPF.LST`. **Invent-forbidden (absent from FSOGPF.BPF + FSOGPF.LST dumps):** Sep-07 names `billingMode`, `paymentTerms`/`paymentTermClass`, `contractStatus`, `requiredPaperwork`, `billingReference` — cite EC2 `.private/wave-a-20260912/a8-payload/bpf-evt-exact.compare.v1.json` (`dodBillingTrio` all false; BPF `keyHits`/`valuesKeys` list). **TS:** `companyAccountReadDataSchema` + context ReadFacts — amend claim keys to dump-proved aliases; do not invent Sep-07 names |
| **4. Surface / denied** | **Surface:** Profiles → Organization Profiles (`FSOGPF`) + Billing Profiles tab (`FSOGPF.BPF`); Booking Agency (`FSBAPF`). **Denied:** `deniedCommon` + `autosave`, `arbitrary_company_search` (popup `OSORGP` is search-only), `credit_limit_read`, `contact_read`, card PAN/CVV fields on BPF (`read-tools.ts` L489–495) |
| **5. Evidence** | **Live:** FSOGPF.LST 50 rows; FSOGPF.BPF ~15kB form chrome; FSBAPF.LST 50 rows. **3949/Sep-07** historical demand only |
| **6. Oracle** | Dump-proved org + BPF AR/account fields match claims; invent-forbidden Sep-07 trio must not be required |
| **7. Gaps** | Wire driver off `FSOGPF`/`FSOGPF.BPF`/`FSBAPF` (replace fail-closed blocker). Negotiated Rates / Auto Transfer tab codes still unharvested (NGR/ATR 400) |

---

## A9 — `hms_read_notes_traces`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_read_notes_traces` |
| **2. Input schema** | **TS:** `notesTracesReadRequestSchema` — `{toolId:'hms_read_notes_traces', resourceRef:Ref, states?:[open,completed] default [open], limit?:1..50 default 20, cursor?:Ref, audience?:staff\|customer default staff, admission?}` (`read-service-contracts.ts` L203–226) |
| **3. Output / verify fields** | **Canonical:** Sep-07 `NotesData` / `NoteObservation` — noteRef, resourceRef, sourceKind, permittedText (≤2000 chars), audience, customerPrintable, status, dueAt, deliveredAt, method, authorLabel, createdAt (L128–129). **TS:** `notesTracesContextDataSchema` / `notesTraceItemSchema` (`context-read-contracts.ts` L139–173) |
| **4. Surface / denied** | **Surface:** bounded notes/trace observation. **Denied:** `complete`, `submit`, `send`, `update`, `create`, `checkout_lock` (`notes-traces-read-contract.ts` L20–23). **Registry:** U15_CONTEXT_READ_TOOL_IDS |
| **5. Evidence** | **Sep-07:** L155 U15 — context facet, no standalone frequency. **3949:** not in top named-read table (low) |
| **6. Oracle** | Notes list UI text matches bounded `permittedText`; no binary; privacy flags honored |
| **7. Gaps** | **TS exists**. Not in `READ_TOOL_IDS`. Live proof deferred |

---

## A10 — `property_read_knowledge`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `property_read_knowledge` |
| **2. Input schema** | **TS:** `propertyKnowledgeReadRequestSchema` — `{topic:PropertyKnowledgeTopic, detail?:summary\|detail default summary}` (`apps/server-pilot/src/ai/property-knowledge-contract.ts` L131–136). **Topics:** check_in_out, cancellation, deposits_payment, room_types, meals_children, amenities, parking_transport, location_contacts, groups_events, compliance_documents. **Context (server):** propertyRef + audience — not model input |
| **3. Output / verify fields** | **TS:** `propertyKnowledgeReadResultSchema` — status, `data.entries[]` (entryRef, topic, content ≤2000, sourceKind, sourceRef, sourceHash, version, ownerRef, approval, approvedAt, effectiveFrom/Until, audience, documentRefs), `conflicts[]`, `evidence[]`, `issues[]`. **Canonical:** Sep-07 `KnowledgeData` / `KnowledgeEntry` (L132–133). **Verify:** no invented rates; approved content only |
| **4. Surface / denied** | **Surface:** approved property knowledge corpus (non-PMS). **Denied:** arbitrary file lookup; reservation booked policy substitution; unapproved sources |
| **5. Evidence** | **3949:** 141 reads + amenity_policy kind 41. **Sep-07:** L156 U16, 70/253 policy labels. **420:** policy 73. **Astra:** U16 never in `READ_TOOL_IDS` |
| **6. Oracle** | Knowledge source entries match `result.data`; conflicts surfaced; knowledge-source proof OK vs PMS video |
| **7. Gaps** | **TS exists** (`property-knowledge-contract.ts`). **Not registered** in `READ_TOOL_IDS` — strongest read gap vs TS. Register when building Wave A |

---

## A11 — `mail_parse_channel_payload`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `mail_parse_channel_payload` |
| **2. Input schema** | **Kickoff / 3949 sketch only** — `{artifactRef:Ref}` (`2026-09-10-pms-tool-catalogue-from-human-gold.md` L89; `2026-09-11-write-tools-kickoff-from-3949-gold.md` §3.1). **No TS contract file** |
| **3. Output / verify fields** | **Kickoff sketch** — `{channel, externalRef, stayDates, guestLabel, cardHandleAbsent}` (`2026-09-10-pms-tool-catalogue-from-human-gold.md` L89). **Plan:** channel/ref/dates vs FW body; feeds `hms_find_reservation`. **Canonical:** no Sep-07 row — mail companion, not HMS screen |
| **4. Surface / denied** | **Surface:** mail parse only (WebBeds/RateTiger/SynXis “see below”). **Denied:** HMS screen; CRS; channel manager push |
| **5. Evidence** | **3949:** `channel_parse` **173**; kind `channel_fw` **149**. **Kickoff:** NEW vs Astra 12 |
| **6. Oracle** | Raw FW artifact bytes/headers match parsed channel, externalRef, stayDates; mail proof → find chain |
| **7. Gaps** | **Stub only** — plan marks “stub needed”. No TS. Build beside `mail_read_artifact` |

---

## A12 — `hms_sent_email_audit`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_sent_email_audit` |
| **2. Input schema** | **No request schema in `read-service-contracts.ts`.** **Registry:** `candidateRequirement: 'exact_reservation_or_account_scope'` (`read-tools.ts` L409). **Sep-07:** `{reservationRef:Ref}` (L155) |
| **3. Output / verify fields** | **TS:** `sentEmailAuditReadDataSchema` — scopeClass, rows (sentAt, emailType, subjectClass, attachmentPresent, reportCode, errorClass), delivery **not** claimed. **Canonical:** Sep-07 `SentEmailData` / `SentLogRecord` + `deliveryEvidence:hms_log_only` (L130–131) |
| **4. Surface / denied** | **Surface:** Sent Email log. **Denied:** `deniedCommon` + `open_attachment`, `resend` (`read-tools.ts` L408) |
| **5. Evidence** | **3949:** 2 named (under-tagged). **Sep-07:** L155 U9, 37/253 comm contexts. **Plan:** **do not promote** |
| **6. Oracle** | HMS sent log metadata matches rows; log-only ≠ delivery or bytes |
| **7. Gaps** | **TS exists** (output). Input UNKNOWN in TS. **Do not promote** per plan; no video required |

---

## A13 — `mail_read_artifact`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `mail_read_artifact` |
| **2. Input schema** | **Sep-07:** `{attachmentId:Ref}` (L162). **Runtime:** server-resolved `AttachmentLocator` (s3Key never model-visible) (`read-artifact.ts`). **Evidence ref:** `MailEvidenceRefSchema` — attachmentId (`draft-evidence.ts` L142–153) |
| **3. Output / verify fields** | **Runtime:** `ArtifactData` — mimeType (text/plain \| application/pdf), text, pageCount, reason (text \| no_embedded_text \| encrypted \| malformed \| too_large \| …). Bounds: 20MiB in, 256KiB out, 50 pages. **ToolResult:** status, draftReady, unresolvedFields, evidence (hash-bound). **Canonical:** authorized bounded extraction (Sep-07 L162) |
| **4. Surface / denied** | **Surface:** Nava mail bytes (not HMS). **Denied:** `deniedCommon` + `ocr`, `attachment_fact_claim` (`read-tools.ts` L311) |
| **5. Evidence** | **3949:** **2032** named. **420:** mail-artifact 216. **Sep-07:** L162 |
| **6. Oracle** | Bounded text/digest matches mail artifact bytes; no PMS video |
| **7. Gaps** | **TS exists** (implementation). **No PMS video** per plan. `claimKinds: []` — server-only material |

---

# Wave B — writes

*All writes: proposal → execute HITL approve → outcome → reread oracle → compare. No TS write adapters in `apps/server-pilot` (kickoff §1.2).*

## B1 — `mail.send_with_attachments`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `mail.send_with_attachments` |
| **2. Input schema** | **Kickoff §3.2** — `{threadId, toDigest, subjectDigest, bodyDigest, attachmentRefs[], idempotencyKey}` → `queued\|rejected`. Execute after human approve (`2026-09-11-write-tools-kickoff-from-3949-gold.md` L133) |
| **3. Output / verify fields** | **Kickoff:** queued \| rejected; idempotent. **Shared outcome union** (§6). **Verify:** queue/sent receipt; SMTP proof; attachment digests match approved refs |
| **4. Surface / denied** | **Surface:** outbound Nava SMTP. **Denied:** model-owned `draft_mail_compose`; auto-send without approve (Astra Sep-04) |
| **5. Evidence** | **Kickoff:** document_wrap 362, quote_send 390, invoice_send 256, payment_ack 389. **Astra:** named July roadmap |
| **6. Oracle** | Sent mailbox / queue receipt matches outcome; bytes were reads from Wave A doc/artifact tools |
| **7. Gaps** | **Stub only** (kickoff sketch). **No TS.** Fixture/human-gated first |

---

## B2 — `hms_attach_guest_stay_document`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_attach_guest_stay_document` |
| **2. Input schema** | **Attach plan + kickoff** — `{reservationRef, mailSource:{threadId, attachmentId? XOR includeRawEml?}, documentCode:PropertyDocumentCode, descriptionDigest, idempotencyKey}`; proposal/execute envelope (`2026-09-11-hms-attach-inbound-document.md` L72–100; kickoff §3.2) |
| **3. Output / verify fields** | **Outcome:** `applied\|rejected\|conflict\|duplicate_prevented\|unknown_outcome`. **Proposal preview:** expectedBefore fingerprint, file {mime, sizeBytes, sha256, kindGuess}, target screen `guest_stay_documents`. **Reread gate:** `documents_list_existing` `{source:'hms_finalized_document'}` shows new documentRef + matching sha256 |
| **4. Surface / denied** | **Surface:** Guest Stay **Documents** → Create/Upload Document → Save. **Denied:** generate confirmation, email folio, post payment, IDM REST, Guest Profile/passport scan, traces, CRS Check Availability (attach plan L102) |
| **5. Evidence** | **Kickoff §3.2** — inverse of outbound; 420 mail-artifact 216 ≠ HMS upload. **Official:** Infor Creating/Uploading documents |
| **6. Oracle** | Post-execute `documents_list_existing` lists new doc with sha256 match; duplicate → `duplicate_prevented` |
| **7. Gaps** | **Stub only** (closed schema in attach plan, **no TS**). **Live blocker:** exact upload URL/selectors unknown; `audited_write` session required; import script refuses write mode |

---

## B3a — `hms_generate_quote_document`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_generate_quote_document` |
| **2. Input schema** | **Kickoff §3.3** — `{reservationRef\|quoteRequestRef, template}` → proposal envelope |
| **3. Output / verify fields** | **Kickoff:** `documentRef`, `held:false`. **Verify:** docs list reread shows generated quote; not inventory hold |
| **4. Surface / denied** | **Surface:** HMS quote document generate. **Denied:** CRS Check Availability as read; inventory hold |
| **5. Evidence** | **3949 pending:** send_quote **74** (404 write total, 330 already attached). **Kickoff** §3.3 |
| **6. Oracle** | `documents_list_existing` or HMS docs tab shows new quote artifact |
| **7. Gaps** | **Stub only**. **No TS.** Pairs with `mail.send_with_attachments` |

---

## B3b — `hms_generate_invoice` / `hms_email_folio`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_generate_invoice` (generate) / `hms_email_folio` (email folio) |
| **2. Input schema** | **Kickoff §3.3** — `{reservationRef, folioIds[], recipient:GUEST\|ORG\|GROUP\|AR, flags}`; July `folio.email` alias |
| **3. Output / verify fields** | **Kickoff:** doc/email outcome; send ≠ paid. **Verify:** folio/docs reread; Email Folio params per Infor |
| **4. Surface / denied** | **Surface:** Guest Stay Email Documents / Email Folio (**outbound**). **Denied:** folio inbound dropzone (attach plan) |
| **5. Evidence** | **3949 pending:** send_invoice **67** (300 write, 233 done). **Folio read:** 763 |
| **6. Oracle** | Post-write folio state + sent log or doc list matches; no payment implied |
| **7. Gaps** | **Stub only**. **No TS.** Tax invoice role/menu may block (Sep-07 §4) |

---

## B3c — `hms_generate_confirmation_proforma`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_generate_confirmation_proforma` |
| **2. Input schema** | **Kickoff §3.3** — `{reservationRef, recipients[], language, header?, footer?}`; July `document.generate_confirmation_proforma` |
| **3. Output / verify fields** | **Kickoff:** `documentRef` filed on Documents tab; STORECONF may auto-file |
| **4. Surface / denied** | **Surface:** confirmation/proforma generate + store. **Denied:** auto-send without separate send tool approve |
| **5. Evidence** | **3949:** send_confirmation 121 (115 done, 6 pending). **361 autos** to replace. **Sep-07:** financial document 35 on 253 |
| **6. Oracle** | Documents tab metadata matches generated proforma/CL |
| **7. Gaps** | **Stub only**. **No TS** (`apps/server-pilot` zero matches per 3949 catalogue) |

---

## B3d — `hms_send_reservation_confirmation`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_send_reservation_confirmation` |
| **2. Input schema** | **Kickoff §3.3** — same recipient/template family as proforma; CRS **Confirm to Email** path |
| **3. Output / verify fields** | **Kickoff:** send outcome. **Verify:** sent/mailbox proof; may fiscalize/post per Infor print options |
| **4. Surface / denied** | **Surface:** CRS Confirm to Email / HMS send confirmation. **Denied:** autonomous send without HITL |
| **5. Evidence** | **3949 pending:** 6. **July:** `document.send_confirmation` |
| **6. Oracle** | Sent email audit or mailbox proof; reservation status unchanged unless create path |
| **7. Gaps** | **Stub only**. **No TS** |

---

## B4 — `hms_post_payment`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_post_payment` |
| **2. Input schema** | **Kickoff §3.4** — `{accountRef, activity:Deposit, amount, guaranteeRef}`; Sep-07 deposit post payload (advance deposit) |
| **3. Output / verify fields** | **Kickoff:** deposit posted; amount match. **Sep-07 §6:** receipt/provider handle, ledger refs, never invent zero. **Verify:** `hms_read_folio` ledger reread |
| **4. Surface / denied** | **Surface:** Advance Deposit / payment post. **Denied:** POP alone as proof; blind retry on timeout |
| **5. Evidence** | **3949 pending: 165** (largest unfinished write). **Kickoff:** 325 write tag, 160 done. **420:** Astra undercounted (5/420) |
| **6. Oracle** | Folio/deposit ledger shows posted amount matching proposal; fee/tax effects reconciled |
| **7. Gaps** | **Stub only** (cat §6, no TS). **Supervisor/finance** approval required. Live writes forbidden on read-only lane |

---

## B5 — `hms_refund`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_refund` |
| **2. Input schema** | **Kickoff §3.4** — `{accountRef, activity:Refund, associatedDeposit, amount, refundReason}`; supervisor when configured |
| **3. Output / verify fields** | **Kickoff:** refund OK; unknown money ≠ 0. **Sep-07:** processor/ledger/credit outcomes. **Verify:** ledger reread |
| **4. Surface / denied** | **Surface:** Deposit actions Refund. **Denied:** blind retry; erase history |
| **5. Evidence** | **3949 pending: 40** (43 writes, 3 done). **420:** ~3 — promoted vs 420 |
| **6. Oracle** | Ledger shows refund posting; remaining forfeiture explicit |
| **7. Gaps** | **Stub only**. **No TS.** Infor refund requires supervisor when configured |

---

## B6 — `hms_create_reservation`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_create_reservation` |
| **2. Input schema** | **Kickoff / Sep-07 §6** — guest profile ref or approved identity; dates; room qty/occupancy/child ages; rate/offer ref; org/agency/group; guarantee/settlement; hold policy. **Never** Check Availability as read |
| **3. Output / verify fields** | **Kickoff:** stay exists (confirmation/status). **Sep-07:** inventory/profile effects. **Verify:** `hms_find_reservation` + `hms_read_reservation` |
| **4. Surface / denied** | **Surface:** Guest Stay Save or CRS after Select. **Denied:** CRS Check Availability read path; Room Plan hold |
| **5. Evidence** | **3949 pending: 31** (326 write, 295 already booked). **Sep-07:** create/hold 20 on 253 |
| **6. Oracle** | Find/detail shows new confirmation; inventory observation |
| **7. Gaps** | **Stub only**. **No TS.** Behind money/docs per kickoff order |

---

## B7a — `hms_cancel_reservation`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_cancel_reservation` |
| **2. Input schema** | **Kickoff / Sep-07 §6** — occurrence, reason, booked-policy ref, explicit fee/refund/forfeit/charge amounts and method (unknown ≠ 0) |
| **3. Output / verify fields** | **Outcome:** canceled status + ledger effects. **Verify:** find/detail + folio reread |
| **4. Surface / denied** | **Surface:** Cancellation UI. **Denied:** cancel-first ordering (420 mistake); fee guess |
| **5. Evidence** | **3949 pending: 12** (91 write, 79 done; kind 104). **420:** cancel 6 — undercounted |
| **6. Oracle** | Detail status canceled; fee/forfeit/refund lines match policy application |
| **7. Gaps** | **Stub only**. **Not write #1** per 3949 rank |

---

## B7b — `hms_amend_reservation`

| # | Field | Value |
|---|-------|-------|
| **1. toolId** | `hms_amend_reservation` |
| **2. Input schema** | **Kickoff §3.4** — Stay Wizard: dates, room type, `rateMode: Override\|Re-Quote\|Retain Rate`; segment/share refs; reason |
| **3. Output / verify fields** | **Kickoff:** dates/room/rate applied. **Sep-07:** whole-stay vs interval explicit. **Verify:** detail reread all changed segments |
| **4. Surface / denied** | **Surface:** Stay Wizard. **Denied:** automatic revert after repricing |
| **5. Evidence** | **3949 pending:** amend_dates 13, amend_rate 12, amend_room 3, release_hold 1. **Kind amend** 98 |
| **6. Oracle** | Guest Stay detail sections match amended dates/room/rate |
| **7. Gaps** | **Stub only**. **No TS.** Regex FP “amended quotation” noted in 3949 |

---

## Summary matrix

| Wave | Tool | Input source | Output verified | Gap class |
|------|------|--------------|-----------------|-----------|
| A1 | `hms_read_reservation` | TS | Sep-07 + TS sections | TS exists; not READ_TOOL_IDS |
| A2 | `hms_read_folio` | TS | Sep-07 + TS | TS exists |
| A3a | `hms_list_documents` | Registry + UNKNOWN | TS (subset of Sep-07) | Input UNKNOWN |
| A3b | `documents_list_existing` | TS | Sep-07 + TS | TS exists |
| A4 | `documents_read_existing` | TS | Sep-07 + TS | TS exists; HMS bytes may block |
| A5 | `hms_quote_stay` | TS | Sep-07 + TS | TS exists |
| A6 | `hms_group_block_read` | TS | Sep-07 + TS | TS + **live blocker** |
| A7 | `hms_event_read` | TS | Sep-07 + TS | TS + **live blocker** |
| A8 | `hms_company_account_read` | TS | Sep-07 + TS | TS + **live blocker** |
| A9 | `hms_read_notes_traces` | TS | Sep-07 + TS | TS exists |
| A10 | `property_read_knowledge` | TS | Sep-07 + TS | TS; **not registered** |
| A11 | `mail_parse_channel_payload` | Kickoff sketch | Kickoff sketch | **Stub only** |
| A12 | `hms_sent_email_audit` | UNKNOWN + Sep-07 | TS + Sep-07 | TS; do not promote |
| A13 | `mail_read_artifact` | Sep-07 + runtime | Runtime bounds | TS/runtime |
| B1 | `mail.send_with_attachments` | Kickoff | Kickoff + §6 | **Stub only** |
| B2 | `hms_attach_guest_stay_document` | Attach plan | Attach plan | **Stub** + **live blocker** |
| B3a–d | generate/send docs | Kickoff | Kickoff | **Stub only** |
| B4 | `hms_post_payment` | Kickoff + Sep-07 | Kickoff | **Stub only** |
| B5 | `hms_refund` | Kickoff + Sep-07 | Kickoff | **Stub only** |
| B6 | `hms_create_reservation` | Kickoff + Sep-07 | Kickoff | **Stub only** |
| B7a | `hms_cancel_reservation` | Kickoff + Sep-07 | Kickoff | **Stub only** |
| B7b | `hms_amend_reservation` | Kickoff + Sep-07 | Kickoff | **Stub only** |

**Tool count:** 13 Wave A reads + 11 Wave B write IDs = **24** scoped tools.

---

## Pointers

| Document | Path |
|----------|------|
| Master plan | `docs/superpowers/plans/2026-09-11-centurion-pms-tools-robust-catalogue.md` |
| Sep-07 catalogue | `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` |
| Capability matrix (pre-Astra) | `docs/infor-hms/capability-matrix.md` |
| Aug demand surfaces (pre-Astra) | `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` |
| Roadmap gates (pre-Astra) | `docs/infor-hms/centurion-reservationist-roadmap-2026-08-21.md` |
| Sep-04 gold architecture (pre-Astra Cursor) | `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md` |
| Astra triage plan | `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` |
| 3949 gold | `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` |
| Write kickoff | `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md` |
| Attach inbound | `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md` |
| Live GRID post-mortem | `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` |
| Read registry | `apps/server-pilot/src/hms/read-tools.ts` |
| U8 find/read | `apps/server-pilot/src/hms/reservation-context-contract.ts` |
