# PMS tool catalogue from 3949-human Sent gold vs 420 labelled gold

Research date: 2026-09-10. Demand/evidence catalogue, not a live-PMS implementation plan. Codex remains on `2026-09-06-reservation-revenue-triage-drafting-plan.md` for live **reads**. This document decides **what to build next** for an AI reservationist.

Private working files (bodies, quotes, ids, per-record labels): `.private/gold-reanalysis-2026-09-10/`. This git file is aggregates only.

**Close-read pass (authoritative):** 99 shards, 40 emails each (last 29). Subagents labeled every authored body. `labels-all.jsonl` = **3949 unique ids**, parity vs `all-ids.txt`. Confidence: 3576 high / 333 medium / 40 low. One illegal write value `amend` recoded to `amend_dates`. Earlier regex-lane counts below are **superseded** by this pass.

**Handoff for later write/read build (after current live-read lane):** `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md`.

## Verdict

**420 was enough to pick the read MVP. 3949 close-read was required to rank writes and to stop regex from lying.**

| Question | Answer |
|---|---|
| Change the 12 read contracts? | **Mostly no.** Spine still find-reservation (2115) + mail artifact (2032) + existing documents (1059 list / 354 read) + folio (763) + quote (582). |
| Change build **order**? | **Yes for writes.** Most writes in Sent gold are **already done in PMS**, then emailed. Pending (staff still need a mutation) rank: **post_payment 165**, send_quote 74, send_invoice 67, refund 40, create 31, then amend_dates/cancel/amend_rate (~12 each). Cancel kind = 104 emails; 79 already cancelled, 12 pending. 420 labelled cancel as 6. |
| Add brand-new PMS read tools for reservationist? | **One parser, not a PMS screen:** `channel_parse` on 173 records; kind `channel_fw` = 149. Occupancy/housekeeping = `ops_report` 239 — staff-ops, not guest reservationist. |
| Replace the 361 PMS autos? | **Already scoped, not coded.** `document.generate_confirmation_proforma` / `document.send_confirmation` exist in the July write roadmap. Human gold: send_confirmation write **121** (115 already sent). Zero TypeScript write adapters. |
| Live writes tonight? | **No.** Fixture-only, human-gated. Infor CRS Check Availability **creates** a reservation; Stay Wizard / cancel / deposit forfeit **mutate** ledger. |

## Corpora (do not mix)

| Corpus | n | What it is |
|---|---:|---|
| 3949 human Sent gold | 3949 | Apr 1–Sep 10 Centurion Sent eml, autos subtracted |
| Subtracted autos | 361 | PMS Confirmation Letter, Pre Stay, Payment Confirmation template, Outlook calendar |
| 420 labelled gold | 420 | Manual semantic review (188 human_reply, 85 human_template, 133 internal_handoff, 7 system_output, 6 test) |
| 314 catch-up Sent bodies | 314 | Prior response-side frequency used to rank the original MVP |

3949 mix: **2891 RE / 717 FW / 341 original**. Quote-boundary in 3536/3949. Empty authored 474. Missing eml 0.

Close-read kinds (all 3949, not originals-only): `ops_report` **239**, `internal_coord` 657, `guest_service` 600. Do **not** rank guest-reservationist writes off ops_report / internal_coord.

## Close-read census (3949 labels)

| kind | n | | pms_write | n | already done | still pending |
|---|---:|---|---|---:|---:|---:|
| internal_coord | 657 | | none | 2247 | — | — |
| guest_service | 600 | | send_quote | 404 | 330 | 74 |
| quote_send | 390 | | create | 326 | 295 | 31 |
| payment_ack | 389 | | post_payment | 325 | 160 | **165** |
| document_wrap | 362 | | send_invoice | 300 | 233 | 67 |
| booking_create_confirm | 339 | | send_confirmation | 121 | 115 | 6 |
| invoice_send | 256 | | cancel | 91 | 79 | 12 |
| ops_report | 239 | | refund | 43 | 3 | **40** |
| channel_fw | 149 | | amend_dates | 36 | 23 | 13 |
| payment_chase | 128 | | amend_rate | 26 | 14 | 12 |
| cancel | 104 | | amend_room | 17 | 14 | 3 |
| amend | 98 | | release_hold | 13 | 12 | 1 |
| test_or_noise | 78 | | | | | |
| other | 61 | | | | | |
| refund | 58 | | | | | |
| amenity_policy | 41 | | | | | |

Reads needed (a record may list several): `hms_find_reservation` 2115, `mail_read_artifact` 2032, `documents_list_existing` 1059, `hms_read_folio` 763, `hms_quote_stay` 582, `documents_read_existing` 354, `hms_group_block_read` 255, `hms_read_reservation` 223, `channel_parse` 173, `property_read_knowledge` 141, `hms_event_read` 42, `hms_company_account_read` 14, `hms_sent_email_audit` 2.

## Was 420 insufficient?

| Hypothesis | Result |
|---|---|
| 420 already had the read MVP | **Supported.** 3949 still document-delivery + lookup + folio/quote. |
| Sent-only undercounts create | **Supported for originals** (1 booking_create_confirm / 341). Creates live in RE (“booking done”) and inbound RFQ, not in standalone originals. |
| Ops originals should not drive PMS writes | **Supported.** 63% of originals = internal reports. |
| Regex on 3949 equals tool demand | **Falsified.** Cancel regex precision **60%**; amend **45%**; create **48%. Bodies required.** |
| 420 undercounted writes | **Supported.** 420 `action_dependency.cancel` = 6; close-read cancel **kind 104 / write 91** (79 already done, 12 pending). Create write 326 (mostly already booked then emailed). Refund write 43, **40 still pending**. |
| Authored text has reservation numbers | **Falsified.** Identity 87 in authored vs **231** if quoted history included. Staff leave conf# in quotes/subject. |

## Auto confirmation letters (the 361)

Not “missed human.” Those are Infor confirmation / Pre Stay / calendar templates.

- Official generate/send: [Reservation Confirmation overview](https://docs.infor.com/hms/3.8/en-us/hmsolh/mru1453227736677.html); CRS wrap-up **Confirm to Email** [creates then emails](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html).
- Product names already in `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`: `document.generate_confirmation_proforma`, `document.send_confirmation` → `hms_generate_confirmation_proforma`, `hms_send_reservation_confirmation`.
- `apps/server-pilot` has **zero** matches for those IDs. Read registry only (`read-tools.ts`).
- Human gold almost never carries `HRCEN_Confirmation_Letter_*.pdf` (32 attachments / 3949). Original auto send was subtracted; humans RE/FW later.

**Replace autos later as write wave 4, after live reads work.** Same contract, not a new invention.

## Evidence-backed tool table

Mode: `R` read, `W` write/amend. Status: `TS` = in current TypeScript unions; `cat` = Sept 7 catalogue only; `new` = 3949-driven add. Demand is **not** additive.

| Order | Tool ID | Mode | Schema (closed) | Why (evidence) | Status |
|---:|---|---|---|---|---|
| 1 | `hms_find_reservation` | R | `{candidateId}` → matches with opaque `reservationRef`, status, arrival/departure, room type | Spine. **2115/3949** close-read named it. 123/420 labels. Conf# often only in quoted history (231 vs 87 authored) | TS |
| 2 | `mail_read_artifact` | R | `{attachmentId}` → bounded text/metadata | **2032/3949**. 216/420. Channel FW + voucher/POP threads live in quoted mail, not authored | TS |
| 3 | `mail_parse_channel_payload` | R | `{artifactRef}` → `{channel, externalRef, stayDates, guestLabel, cardHandleAbsent}` | Close-read: `channel_parse` **173**, kind `channel_fw` **149**. WebBeds/RateTiger/SynXis “see below”. **Not** a new HMS screen | new (mail) |
| 4 | `hms_read_reservation` | R | `{reservationRef, sections[core,stay,rates,policies,operations]}` | **223/3949**. Split identity from stay facts after find, for amend/cancel confirmations | TS context union |
| 5 | `documents_list_existing` / `documents_read_existing` | R | `{scopeRef, source, kinds[]}` / `{documentRef, format}` | List **1059**, read **354**. Kinds `document_wrap` 362 + `quote_send` 390 + `invoice_send` 256 | TS existing-doc union |
| 6 | `hms_list_documents` | R | HMS metadata only | Companion to byte tools; metadata ≠ bytes ≠ sent | TS |
| 7 | `hms_read_folio` | R | `{reservationRef, sections[balance,deposits,transactions]}`; unknown ≠ 0 | **763/3949**. Payment kinds: ack 389 + chase 128 + refund 58. Pending `post_payment` **165** is the largest unfinished write | TS |
| 8 | `hms_quote_stay` | R | every night, `bookable` unknown unless complete, `held:false` | **582/3949**. Quote kind 390; write send_quote 404 (330 already attached PDF, **74** still need a quote). Do not assume every “Quotation” subject is a CRS shop | TS |
| 9 | `hms_group_block_read` / `hms_event_read` | R | block/pickup/delegates; event source must be HMS | Group **255**, event **42**. Keep; 420 had 66 group labels | TS |
| 10 | `hms_company_account_read` | R | linked bill-to only | Close-read only **14**. Keep, defer live proof | TS U15 |
| 11 | `hms_sent_email_audit` | R | log-only, not delivery | Close-read named it **2 times**. Distinguishes HMS CL log from human RE wrap; keep, do not promote | TS |
| 12 | `hms_read_notes_traces` | R | bounded permitted text | Low frequency; privacy | TS U15 |
| 13 | `property_read_knowledge` | R | versioned policy topics | Close-read **141** + amenity_policy kind **41**. 73/420. **Not in `READ_TOOL_IDS`.** Strongest read gap vs TS | cat, not TS |
| 14 | `hms_post_payment` / deposit post | W | activity type, amount, associated deposit; never invent zero | **Largest pending write: 165.** Write tagged post_payment 325 (160 already posted). Payment_ack kind 389. 420 undercounted this | cat, no TS |
| 15 | `hms_generate_quote` + `mail_send_with_attachments` | W | quote PDF or HMS quote then human-approved send | send_quote 404 (74 pending). Distinct from live CRS shop | cat, no TS |
| 16 | `hms_generate_invoice` / `hms_email_folio` | W | type/template/payer; send ≠ paid | send_invoice 300 (67 pending). invoice_send kind 256 | cat, no TS |
| 17 | `hms_refund` | W | supervisor; associated deposit; unknown money ≠ 0 | refund write **43**, **40 still pending**. Kind 58. 420 had ~3. Highest unfinished money mutation after post_payment | cat, no TS |
| 18 | `hms_create_reservation` | W | guest/dates/occupancy/rate/guarantee; CRS Check Availability **creates a record** — never use as read | create write **326** but **295 already booked** then emailed; **31 pending**. Kind booking_create_confirm 339 | cat, no TS |
| 19 | `hms_cancel_reservation` | W | proposal: occurrence, reason, fee/refund/forfeit amounts; reread status+ledger | cancel write **91** (79 already done, **12 pending**). Kind 104. 420 tagged 6. Past-tense “has been cancelled” dominates Sent | cat, no TS |
| 20 | `hms_amend_reservation` | W | Stay Wizard fields: dates, room type, rateMode retain/requote/override | amend_dates 36 (13 pending), amend_rate 26 (12 pending), amend_room 17 (3 pending), release_hold 13 (1 pending). Kind amend 98. Regex FP was “amended quotation” | cat, no TS |
| 21 | `hms_generate_confirmation_proforma` + `hms_send_reservation_confirmation` | W | template, reservationRef, recipients; print/generate can fiscalize | send_confirmation **121** (115 already sent, 6 pending). Replaces 299 CL autos. Infor send is a write. Not in TS | cat, no TS |

### Document kinds to add on existing list/read (not new HMS modules)

`voucher` (45 PDFs), `bank_letter`, `function_sheet`, `ops_report` (internal only). Keep `reservation_confirmation` | `tax_invoice` | `pro_forma` | `folio`.

### Explicitly **not** reservationist tools

| Surface | Why |
|---|---|
| Occupancy / housekeeping / Profit-room / night audit | 214/341 originals. Staff ops. Separate product. |
| CRS Check Availability / Guest Stay hold | [Creates or temporarily holds](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html) a reservation. Read path = Room Availability / Display Rates only. |
| Room Plan create/hold | Write. |
| Complete Message / traces send | Asserts delivery. Read without Complete. |
| Channel manager **push** | Connector unproved. Parse inbound FW first. |

## Write/amend schema (shared)

Reuse Sept 7 future-write contract:

1. Inert `proposalRef` + expected-before fingerprint + typed diff + effects + approver role.
2. Execute `{proposalRef, approvedOperationRef, idempotencyKey}` only.
3. Outcome `applied|rejected|conflict|duplicate_prevented|partial_success|unknown_outcome`.
4. Authoritative reread. Timeout after submit → unknown, never retry charge/book/send.

Cancel-specific: [policy can post fee / forfeit / refund](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html). Unknown money must not become zero.

Amend-specific: [Stay Wizard](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html) whole-stay vs interval; Override / Re-Quote / Retain Rate.

Observed fields on true writes: confirmation number (81), group ref (20), stay dates (15), guest name (11), room type (10).

## Build order for AI reservationist

**Now (reads, current Codex lane):** keep 1–12. Add `property_read_knowledge` to the read registry. Add `mail_parse_channel_payload` beside `mail_read_artifact`.

**Next (fixture writes, no live HMS), ranked by *pending* close-read demand:** post_payment / folio post → send_quote → send_invoice → refund → create → amend_dates / cancel / amend_rate → send_confirmation → amend_room / release_hold.

Most Sent-gold writes are **already done**; the AI still needs those tools to *do* what staff already did. Pending counts say **money post + quote/invoice send + refund** beat cancel/create for unfinished work.

**Do not** start live writes while Codex proves live reads.

## 420 vs 3949 ranking (guest-facing)

| Need | 420 | 3949 close-read | Use |
|---|---|---|---|
| Find reservation | 123 | **2115** named the read | Keep spine |
| Mail artifact | 216 | **2032** | Keep #1 companion |
| List/read existing docs | 156 | list 1059 / read 354 | Keep |
| Folio | 40 | **763** reads; pending post_payment **165** | Promote vs old inbound ranking |
| Live / send quote | 43 | quote read 582; send_quote 404 (74 pending) | Keep; don’t inflate from subject |
| Cancel write | 6 | kind 104 / write 91 (**12 pending**) | Needed; not the largest *pending* write |
| Create write | 24 | write 326 (**31 pending**, 295 already booked) | Keep, behind money/docs |
| Refund write | ~3 | write 43 (**40 pending**) | **Promote vs 420** |
| Property knowledge | 73 | **141** reads + amenity kind 41 | **Implement read; missing in TS** |
| Channel parse | not named | **173** reads; kind 149 | **New mail tool** |

## Counterevidence

- 3949 is Sent-only. Inbound RFQ volume for create/quote is not this file. 420 mixed some inbound staff-source.
- Labels are one pass per shard, not double-blind. 40 low-confidence. One write recode (`amend` → `amend_dates`).
- `pms_write` is the email’s implied PMS action, not a proven live mutation. `write_already_done_in_pms` is a body-tense call.
- Cancel/create in Sent gold are mostly **already performed** then emailed. Pending counts are the better “what AI must still do” ranker.
- `hms_sent_email_audit` named 2 times — likely under-tagged, not proof the tool is unused.
- `other_pdf` 1576 includes many HMS guest-named PDFs not matching `HRCEN_Confirmation_Letter_*`.
- Exa Agent MCP unavailable this session; public Infor via ordinary Exa + known docs.infor.com URLs.

## Sources

- `.private/gold-reanalysis-2026-09-10/labels-all.jsonl` (3949 close-read labels; PII stays private)
- `.private/gold-reanalysis-2026-09-10/labels-aggregate.json`
- `.private/gold-reanalysis-2026-09-10/verify_shards.py`
- `.private/gold-reanalysis-2026-09-10/census.json`
- `.private/gold-reanalysis-2026-09-10/hypotheses.json` (pre-close-read; superseded for counts)
- `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md`
- `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`
- `apps/server-pilot/src/hms/read-tools.ts`
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html
- https://docs.infor.com/hms/3.8/en-us/hmsolh/mru1453227736677.html
