# Kickoff: read + write tools after 420 gold and 3949 Sent gold

Date: 2026-09-11. **Handoff for later implementation.** Current Codex/Astra lane on `feat/centurion-dashboard-tools` is live **read-only** proof (`2026-09-06-reservation-revenue-triage-drafting-plan.md`). This file is the inventory to build **after** that lane: what Astra already decided, what the ~10× Sent corpus changed, and the evidence-backed **write** set (including inbound attach to Guest Stay Documents).

Git = IDs, schemas, aggregates. Mail bodies stay in `.private/gold-reanalysis-2026-09-10/`. No PII.

Do **not** mix corpora:

| Corpus | n | Role |
|---|---:|---|
| Labelled 420 gold | 420 | Astra method baseline (188 human_reply, 85 human_template, 133 internal_handoff) |
| 314 Sent-body catch-up | 314 | Astra **response-side** rank that replaced inflated Sep-01 draft-target counts |
| 3949 human Sent gold | 3949 | Apr 1–Sep 10 Centurion Sent, 361 PMS/calendar autos subtracted. Close-read labels, 99 shards, id parity vs `all-ids.txt` |
| 361 autos | 361 | Infor confirmation / Pre Stay / payment-conf templates — replace later as generate/send, not human-reply rank |

3949 close-read confidence: 3576 high / 333 medium / 40 low.

---

## 1. What Astra / Codex already decided (keep)

Astra’s live plan is **not** a write plan. Goal capsule: finish existing read-only HMS tools through a guarded live executor. Writes stay catalogue-only.

### 1.1 Reads already in TypeScript (do not redesign)

`READ_TOOL_IDS` (`apps/server-pilot/src/hms/read-tools.ts`):

`mail_read_artifact`, `hms_find_reservation`, `hms_quote_stay`, `hms_list_documents`, `hms_sent_email_audit`, `hms_read_folio`, `hms_company_account_read`, `hms_group_block_read`, `hms_event_read`.

Sibling unions (not Phase-B fingerprint): `documents_list_existing`, `documents_read_existing`, `hms_read_reservation`, `hms_read_notes_traces`.

`productionActiveReadToolIds()` is still **empty**. Live promotion is Codex’s job.

**Why Astra ranked these (314 Sent-body, not 3949):**

| Tool | 314 Sent-body | 420 union `toolDemandFromGoldResponse` | Sep-07 family (420) |
|---|---:|---:|---:|
| `hms_find_reservation` | 70 | 151 | identity 123 |
| `hms_read_folio` | 59 | 65 | folio/payment 40 |
| `hms_list_documents` | 51 | 59 | existing docs 156 |
| `mail_read_artifact` | 51 | 59 | mail-artifact 216 |
| `hms_quote_stay` | 43 | 73 | availability/rate 43 |
| group/event | ~14 each | 46 each | group/event 66 |
| `hms_company_account_read` | 1 | 1 | bill-to contexts (curated) |
| `property_read_knowledge` | (deferred) | — | **policy 73** — catalogued U16, **never registered in TS** |

Sep-04 Wave MVP order: promote find → keep artifact → quote → **pull folio forward** → list_documents. Defer company, sent-audit, group/event for first staff-visible draft; **defer all writes**.

Sep-07 catalogue turned seven overlapping families into **12 typed read contracts** plus `property_read_knowledge`. Bounded rich resource reads, not one tool per HMS click. CRS Check Availability excluded from reads because [it creates a reservation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html).

### 1.2 Writes Astra already **named** (catalogue only, no TS)

July roadmap + Sep-07 §6. Shared envelope: inert `proposalRef` + expected-before fingerprint → execute `{proposalRef, approvedOperationRef, idempotencyKey}` → `applied|rejected|conflict|duplicate_prevented|partial_success|unknown_outcome` → authoritative reread. Timeout ≠ retry charge/book/send.

| Astra / July ID | Model-facing ID | 420 / 253 evidence (catalogue, not 3949) |
|---|---|---|
| `reservation.create` | `hms_create_reservation` | create/hold 20 on 253; 24/420 action create |
| `reservation.amend` | `hms_amend_reservation` | amend 21 on 253 |
| `reservation.cancel` | `hms_cancel_reservation` | cancel 7 on 253; **420 `action_dependency.cancel` = 6** |
| `document.generate_confirmation_proforma` | `hms_generate_confirmation_proforma` | financial document 35 on 253 |
| `document.send_confirmation` | `hms_send_reservation_confirmation` | communication send 251 outbound candidates |
| `folio.email` | `hms_email_folio` / generate invoice | same document + email-folio docs |
| `mail.send_with_attachments` | same | almost all guest mail is attach-forward |
| deposit/payment post | `hms_post_payment` | **0 on 253**, 5 on original 420 — Astra **undercounted money post** |
| refund/forfeit | `hms_refund` | 5 on 253 |
| group/event/profile/trace writes | later | not guest-email MVP |

Astra explicitly: no executor, no write credential, no automatic-send, no `draft_mail_compose` registry tool (code-owned renderer).

---

## 2. What the 3949 close-read changed (~10× Sent)

**Reads: 420 was enough for the MVP spine. 3949 did not replace find / artifact / docs / folio / quote.** It measured scale and found two **missing reads** plus a honest write rank.

Close-read **named reads** (a mail can name several):

| Read | 3949 | vs Astra |
|---|---:|---|
| `hms_find_reservation` | **2115** | still spine |
| `mail_read_artifact` | **2032** | still #1 companion |
| `documents_list_existing` | 1059 | keep |
| `hms_read_folio` | **763** | reinforced (420 folio family was 40) |
| `hms_quote_stay` | 582 | keep; do not inflate from “Quotation” subject |
| `documents_read_existing` | 354 | keep |
| `hms_group_block_read` | 255 | keep, defer live if blocked |
| `hms_read_reservation` | 223 | keep |
| **`channel_parse` / `mail_parse_channel_payload`** | **173** | **NEW** — not in Astra 12 |
| **`property_read_knowledge`** | **141** | Astra had 73/420 but **never shipped TS** |
| `hms_event_read` | 42 | keep |
| `hms_company_account_read` | 14 | keep, defer live |
| `hms_sent_email_audit` | 2 | keep, do not promote |

**Writes: 420 was not enough.** Regex on 3949 lied (cancel precision ~60%, amend ~45%). Bodies required. 420 cancel=6 vs close-read cancel **kind 104 / write 91**. Refund 420 ~3 vs **43 writes, 40 still pending**.

Most Sent writes are **already done in PMS**, then emailed (`write_already_done` 1916). Pending (still need a mutation) is the right “what to automate” ranker:

| `pms_write` | pending | already done | 420-era implication |
|---|---:|---:|---|
| `post_payment` | **165** | 160 | Astra 5/420 — **promote** |
| `send_quote` | 74 | 330 | keep generate/send |
| `send_invoice` | 67 | 233 | keep folio email |
| `refund` | **40** | 3 | **promote vs 420** |
| `create` | 31 | 295 | 420 over-weighted create vs Sent “booking done” |
| `amend_dates` | 13 | 23 | Stay Wizard |
| `cancel` | 12 | 79 | 420 cancel-first is **wrong** |
| `amend_rate` | 12 | 14 | Override/Re-Quote/Retain |
| `send_confirmation` | 6 | 115 | replace 361 autos |
| `amend_room` | 3 | 14 | |
| `release_hold` | 1 | 12 | |

Guest-pool automation (drop ops + internal-only, n=3013): TS reads **77.2%** of facts → +property+channel **86.0%** → pending writes cover the rest of labeled guest facts. Ops/internal/Sent-only still block 100% of *all* mailbox mail.

---

## 3. New tools decided after 3949 (build later)

### 3.1 New **reads** (not in live `READ_TOOL_IDS`)

| ID | Why | Evidence |
|---|---|---|
| `property_read_knowledge` | Policy/amenity/shuttle/kids/meal answers without inventing rates | 141/3949; amenity_policy kind 41; Astra 73/420 already asked for U16 |
| `mail_parse_channel_payload` | WebBeds/RateTiger/SynXis “see below” — parse quoted OTA, then find. **Not** an HMS screen | 173 reads; channel_fw kind 149 |

### 3.2 Writes to implement (HITL proposal envelope)

All writes: fixture / human-gated first. `audited_write` only on the write session. Reads stay `view_only`.

#### A. Outbound mail (email automation lever)

| ID | Schema sketch | Why we will build it | Evidence |
|---|---|---|---|
| `mail.send_with_attachments` | `{threadId, toDigest, subjectDigest, bodyDigest, attachmentRefs[], idempotencyKey}` → queued\|rejected. Human approve before SMTP | Almost all guest Sent is wrap PDF / short ack. Reads find bytes; this **sends**. Astra named it; Sep-04 forbade model-owned compose | document_wrap 362; quote_send 390 (330 already attached); invoice_send 256 (233 already attached); payment_ack 389 |

#### B. Inbound attach to HMS (Direct HMS Sync) — **new vs Astra write list**

| ID | Schema sketch | Why we will build it | Evidence |
|---|---|---|---|
| `hms_attach_guest_stay_document` | `{reservationRef, attachmentId XOR includeRawEml, documentCode, descriptionDigest, idempotencyKey}` → proposal → execute. Reread `documents_list_existing` `hms_finalized_document` | Check-in/finance need voucher/POP/OTA file **on the stay**, not only in Nava. U9 list/read is empty until someone uploads. Inverse of outbound send. **Not** IDM/Ming.le. **Not** folio Email Documents (that sends). Official UI: Guest Stay **Documents** tab → Create/Upload Document (code + description + file) → Save | Official: [Creating/Uploading documents](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428568335.html). 420 mail-artifact 216 = files already in Nava (`mail_attachment`), not proof they sit in HMS. 3949 Sent **undercounts** inbound attach. Adapter `findReservation`/`quoteStay` is **not** upload (`adapter.ts:65-75`). Full scope: `2026-09-11-hms-attach-inbound-document.md` |

#### C. Document generate / HMS email (Infor writes)

| ID | Schema sketch | Why | Evidence |
|---|---|---|---|
| `hms_generate_quote_document` | `{reservationRef\|quoteRequestRef, template}` → `documentRef`, `held:false` | 74 quotes not yet sent; 330 already wrapped existing PDF | send_quote 404 / pending 74 |
| `hms_generate_invoice` / `hms_email_folio` | `{reservationRef, folioIds[], recipient:GUEST\|ORG\|GROUP\|AR, flags}` | Guest Stay Email Documents / Email Folio window | send_invoice 300 / pending 67; folio read 763. [Email folio params](https://docs.infor.com/hms/2026.08/en-us/hmsolh/msh1719480545520.html) |
| `hms_generate_confirmation_proforma` + `hms_send_reservation_confirmation` | `{reservationRef, recipients[], language, header?, footer?}` | Replaces 361 autos. CRS **Confirm to Email**. STORECONF can also file CL on Documents tab | send_confirmation 121 (115 done, 6 pending). [CRS Confirm to Email](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html) |

#### D. Ledger mutation

| ID | Schema sketch | Infor | Why | Evidence |
|---|---|---|---|---|
| `hms_post_payment` | `{accountRef, activity:Deposit, amount, guaranteeRef}` | [Advance Deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html) | **Largest unfinished write.** POP-ack ≠ posted | pending **165** (71 payment_ack + 80 internal “charge VCC”) |
| `hms_refund` | `{accountRef, activity:Refund, associatedDeposit, amount, refundReason}` supervisor | same tab; Refund Requires Approval | 420 ~3; almost all refunds still open | pending **40** / write 43 |
| `hms_create_reservation` | guest/dates/occupancy/rate/guarantee. **Never** Check Availability as a read | Guest Stay Save or CRS after Select | Sent “booking done” ≠ inbound RFQ; still need create for the 31 pending | pending 31; already done 295 |
| `hms_cancel_reservation` | occurrence, reason, explicit fee/forfeit/refund (unknown ≠ 0) | [Cancel policy](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html) | Needed; **not** write #1 | pending 12; kind 104 |
| `hms_amend_reservation` | Stay Wizard dates/room/`Override\|Re-Quote\|Retain Rate` | [Stay Wizard](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html) | “Amended quotation” was regex FP | pending dates 13, rate 12, room 3, hold 1 |

---

## 4. Later build order (after live reads exist)

Email automation order, not “biggest PMS verb”:

0. Finish Astra live **reads** (find, artifact, quote, folio, documents, context). Without these, writes guess.
1. `property_read_knowledge` + `mail_parse_channel_payload`
2. `mail.send_with_attachments` (outbound HITL)
2b. `hms_attach_guest_stay_document` (inbound HITL, Guest Stay Documents Create/Upload)
3. generate/send quote, invoice/folio, confirmation
4. `hms_post_payment`
5. `hms_refund` (supervisor stays)
6. `hms_create_reservation`
7. `hms_cancel_reservation` then `hms_amend_reservation`

Then **stop** for guest reservationist email. Ops reports, group-block writes, event BEO, SCS, Chrome-extension drag — out of this kickoff.

Disable-HITL later is **policy on this same set** (auto-approve send-existing-PDF / complete quote). Money, cancel-with-fee, Override rate, VCC charge stay gated. Infor refund already requires supervisor when configured.

---

## 5. Explicitly do not build as reservationist tools

| Surface | Why |
|---|---|
| Occupancy / housekeeping / night audit | ops_report 239 / 214 of 341 originals |
| CRS Check Availability as a “quote” | Creates a reservation |
| Room Plan create/hold | Write, not email MVP |
| Complete Message / traces send | Asserts delivery |
| Channel manager **push** | Parse inbound FW first |
| IDM / Ming.le dropzone | Different product; Centurion live path is HMS `/web/base/OSRESS.search` |
| Folio “attachments dropzone” for inbound .eml | Folio Email/Print = **outbound** |
| Notes/traces for binary email | Text only |
| `draft_mail_compose` as a model tool | Code-owned renderer (Astra Sep-04) |

---

## 6. Shared write contract (copy into child plans)

1. Inert proposal: `proposalRef`, expected-before fingerprint, typed diff, fees/taxes/comms effects, approver role, expiry.
2. Execute only `{proposalRef, approvedOperationRef, idempotencyKey}`.
3. Closed outcome union above. Success = independently observed saved effects.
4. Timeout after possible submit → `unknown_outcome`. Inspect HMS/ledger before retry. Never re-charge / re-book / re-send / re-upload blindly.
5. Customer notification is separate HITL from ledger mutation.
6. Attach inbound: idempotency `(attachment_sha256, reservation_ref)`; prefer PDF/voucher over whole `.eml`; reread `documents_list_existing`.

---

## 7. Pointers for the next LLM

| Doc | Use |
|---|---|
| `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` | Current **read-only** live proof (do not hijack) |
| `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` | 12 read schemas + Astra future-write §6 |
| `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md` | Why 314 Sent-body beat Sep-01 |
| `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md` | Stable operation IDs |
| `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` | 3949 close-read census |
| `docs/superpowers/plans/2026-09-10-last-tools-email-automation.md` | Automation % + order |
| `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md` | Direct HMS Sync disproof + attach schema |
| `.private/gold-reanalysis-2026-09-10/labels-aggregate.json` | Counts (no PII) |
| `.private/gold-reanalysis-2026-09-10/automation-coverage.json` | 77% / 86% guest-pool |

**One-line delta:** Astra locked the **read spine** on 420/314 and listed writes without ranking them on Sent reality. 3949 says: add **property knowledge + channel parse**; send and **inbound Documents attach** before money; **post_payment and refund beat cancel/create** for unfinished work; then generate CL/invoice/quote to replace autos.
