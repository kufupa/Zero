# Last HITL tools for near-full Centurion email automation

Research date: 2026-09-10. Decision catalogue. Not a live-PMS write plan. Codex stays on `2026-09-06-reservation-revenue-triage-drafting-plan.md` for live **reads**. This file decides **what else to build** so guest reservationist email can approach automation, still human-gated, then later drop HITL on low-risk classes.

Git file = IDs, schemas, aggregates. Labels stay in `.private/gold-reanalysis-2026-09-10/`. No mail PII.

## Verdict

**100% of all Sent mail is unreachable.** Ops reports, internal-only FWs, and inbound RFQ (not in this corpus) stay out. **Guest-reservationist email can approach ~86% with two missing reads + a HITL send/attach path; the last ~14% of that pool needs PMS writes (money first).** Disable-HITL is a later policy on those same tools, not a different inventory.

Do **not** invent a parallel read MVP. Codex already picked the right reads from 420/314. Ship those live. Add two reads Codex scoped but never registered. Then document-send **and inbound Guest Stay Documents attach**. Then money writes. Then create/cancel/amend.

Inbound attach (Nava mail → HMS Documents tab) is scoped in `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md`. It is a **write**, not U9 list/read.

## What Codex already chose (do not rebuild)

`READ_TOOL_IDS` in `apps/server-pilot/src/hms/read-tools.ts`:

`mail_read_artifact`, `hms_find_reservation`, `hms_quote_stay`, `hms_list_documents`, `hms_sent_email_audit`, `hms_read_folio`, `hms_company_account_read`, `hms_group_block_read`, `hms_event_read`.

Sibling unions (not Phase-B fingerprint): `documents_list_existing`, `documents_read_existing`, `hms_read_reservation`, `hms_read_notes_traces`.

`productionActiveReadToolIds()` = **[]**. Live proof not done. That is Codex’s job.

**Why (Codex / gold, not 3949):**

| Source | Rank |
|---|---|
| 314 Sent-body (Sep-04) | find 70 → folio 59 → list_documents 51 = artifact 51 → quote 43 |
| 420 union `toolDemandFromGoldResponse` | find 151, quote 73, folio 65, list_documents 59, artifact 59 |
| 420 family labels (Sep-07) | mail-artifact 216, existing docs 156, identity 123, group/event 66, quote 43, folio 40, **policy 73** |
| Sep-06 plan | live read-only only; writes catalogue-only |

Codex **deferred** all writes, and left `property_read_knowledge` as U16 **not in TS**. Sep-04 also said no `draft_mail_compose` registry tool (code-owned renderer). 3949 close-read **does not reverse** the read spine. It **adds** channel parse + property knowledge + a send/generate/write ladder.

## 3949 close-read vs automation

Labels: 3949 unique ids. Confidence 3576 high / 333 medium / 40 low.

| Bucket | n | % |
|---|---:|---:|
| Guest facts already in TS reads (write none or already done) | 2327 | 58.9 |
| Needs `property_read_knowledge` or `channel_parse` | 263 | 6.7 |
| Pending PMS/doc write | 423 | 10.7 |
| Internal mail-only (coord/other, no guest PMS) | 619 | 15.7 |
| Ops / test noise | 317 | 8.0 |

Guest-pool (drop ops + internal-only) n=3013:

| Tool set | Guest-pool automatable *facts* |
|---|---|
| Current TS reads | **77.2%** (2327) |
| + `property_read_knowledge` + `mail_parse_channel_payload` | **86.0%** (2590) |
| + pending writes (if those tools exist) | **100% of labeled guest-pool facts** |

“Facts” ≠ sent email. Renderer + `mail.send_with_attachments` still required to leave HITL draft. Sep-04 kept compose out of the tool registry; keep that split: **model calls reads/writes, code owns MIME.**

Pending writes (424):

| write | pending | already done in PMS | Guest-facing hotspot |
|---|---:|---:|---|
| `post_payment` | **165** | 160 | 71 payment_ack + 80 internal “please charge” |
| `send_quote` | 74 | 330 | quote_send |
| `send_invoice` | 67 | 233 | invoice_send |
| `refund` | **40** | 3 | refund kind |
| `create` | 31 | 295 | booking_create_confirm; 11 channel_fw |
| `amend_dates` | 13 | 23 | |
| `cancel` | 12 | 79 | |
| `amend_rate` | 12 | 14 | |
| `send_confirmation` | 6 | 115 | |
| `amend_room` | 3 | 14 | |
| `release_hold` | 1 | 12 | |

Counter to “pending = just attach PDF”: **65% of pending is live mutate** (post/refund/create/cancel/amend), 35% doc-send. Doc-send still needs generate/email, not only `documents_read_existing`.

## Last tool inventory (build these, then stop)

### Already in TS — finish live, do not redesign

Keep Codex contracts. Schema already in `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md`.

### READ — missing vs 3949 (Wave 1)

| # | Tool ID | Schema (closed) | Why build | Evidence |
|---|---|---|---|---|
| R1 | `property_read_knowledge` | `{topic, detail?:summary\|detail}` → approved versioned policy entries. Topics: check_in_out, cancellation, deposits_payment, room_types, meals_children, amenities, parking_transport, location_contacts, groups_events, compliance_documents | Strongest **read gap vs TS**. Codex U16, never registered. | 141/3949 reads; amenity_policy kind 41 (37 need this read); 73/420 Sep-07; 70/253 catalogue |
| R2 | `mail_parse_channel_payload` | `{artifactRef}` → `{channel, externalRef, stayDates, guestLabel, cardHandleAbsent}` then `hms_find_reservation`. Not an HMS screen | Channel FW is human cover + quoted OTA. Authored often empty. | 173 `channel_parse`; kind `channel_fw` 149 (122 need this read). WebBeds/RateTiger/SynXis |

### MAIL — HITL enqueue (Wave 2) — this is the email-automation lever

| # | Tool ID | Schema | Why | Evidence |
|---|---|---|---|---|
| M1 | `mail.send_with_attachments` | `{threadId, toDigest, subjectDigest, bodyDigest, attachmentRefs[], idempotencyKey}` → `queued\|rejected`. Human approve before SMTP. Never raw card/PAN | Almost all guest Sent is wrap PDF / short ack. Reads find the bytes; this **sends**. July roadmap already named it. | document_wrap 362, quote_send 390 (330 already attached), invoice_send 256 (233 already attached), payment_ack 389. Sep-04: no model-owned compose registry |

Disable-HITL later: auto-approve only when attachments = existing `documentRef`s + template body, no money mutation.

### DOCUMENT GENERATE / EMAIL (Wave 3) — Infor writes

Infor: Guest Stay **Email documents** opens Email Folio / document send ([action buttons](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428572875.html); [folio email params](https://docs.infor.com/hms/2026.08/en-us/hmsolh/msh1719480545520.html)). CRS wrap-up **Confirm to Email** sends confirmation after Confirm assigns a number ([CRS create](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html)). Batch confirmation letters: [Reservation Confirmation overview](https://docs.infor.com/hms/3.8/en-us/hmsolh/mru1453227736677.html). Property Forms hold confirmation/cancellation/proforma email subject+body ([Forms tab](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html)).

These **mutate comms log** and can fiscalize. Not reads.

| # | Tool ID | Schema | Why | Evidence |
|---|---|---|---|---|
| D1 | `hms_generate_quote_document` + send via M1 or HMS | `{reservationRef?\|quoteRequestRef, template}` → `documentRef`. held:false | 74 quotes still not sent; 330 already sent by attaching existing PDF | send_quote pending 74 |
| D2 | `hms_generate_invoice` / `hms_email_folio` | `{reservationRef, folioIds[], recipient:GUEST\|ORG\|GROUP\|AR, flags}` per Email Folio window | 67 invoices pending | send_invoice 67; folio read 763 |
| D3 | `hms_generate_confirmation_proforma` + `hms_send_reservation_confirmation` | `{reservationRef, recipients[], language, header?, footer?}` → Confirm-to-Email analogue | Replaces 361 subtracted autos. Human gold already sent 115; 6 pending | send_confirmation 121; July IDs `document.generate_confirmation_proforma`, `document.send_confirmation` |

### PMS MUTATION (Waves 4–6) — HITL until supervisor policy

Shared write envelope (Sept 7 / July): inert `proposalRef` + expected-before fingerprint + typed diff → execute `{proposalRef, approvedOperationRef, idempotencyKey}` → `applied\|rejected\|conflict\|duplicate_prevented\|partial_success\|unknown_outcome` → authoritative reread. Timeout ≠ retry charge.

| # | Tool ID | Schema | Infor surface | Why | Evidence |
|---|---|---|---|---|---|
| W1 | `hms_post_payment` / advance deposit | `{accountRef, activity:Deposit, amount, guaranteeRef, associatedDeposit?}` | [Advance Deposit tab](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html). Activity Deposit only while Pending. TAXINVATPAYMENT may force tax invoice | **Largest unfinished write.** POP-ack ≠ posted | pending 165 (71 guest payment_ack, 80 internal_coord charge-now) |
| W2 | `hms_refund` | `{accountRef, activity:Refund, associatedDeposit, amount, refundReason}` supervisor | Same tab. Refund/Forfeit need Associated Deposit. [Refund Requires Approval](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html) | 40/43 refunds still pending. 420 had ~3 | pending 40 |
| W3 | `hms_create_reservation` | `{guest, dates, occupancy, ratePlan, guarantee}` via Guest Stay Save **or** CRS after Select. **Never** CRS Check Availability as a read — [it creates a record](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html). Read avail = [Room Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428570987.html) / Hotel Availability | 326 creates in Sent are mostly **already booked** then emailed | pending 31 (10 booking_create_confirm, 11 channel) |
| W4 | `hms_cancel_reservation` | `{reservationRef, reason, applyPolicy:bool}` → fee/forfeit/refund/none must be explicit; unknown money ≠ 0 | [Cancel](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html): Post Cancellation Fee / Advance Deposit Forfeit / Full Refund / Partial Refund | 420 tagged 6; close-read kind 104, write 91, **12 pending** | pending 12 |
| W5 | `hms_amend_reservation` | Stay Wizard: dates, roomType, rateInstruction `Override\|Re-Quote\|Retain Rate` | [Stay Wizard](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html) | amend regex was 45% FP (“amended quotation”) | pending dates 13, rate 12, room 3, hold 1 |

Do **not** build as reservationist tools: occupancy/housekeeping (`ops_report` 239), CRS Check Availability-as-read, Room Plan create, Complete Message, channel-manager **push**.

## Build order (email automation, not “biggest PMS verb”)

0. **Codex live reads** — find, artifact, quote, folio, documents, context. Without these, new tools guess. `productionActive` still empty.
1. **R1 + R2** — property knowledge + channel parser. +263 emails (6.7%). No HMS mutation. Guest-pool 77% → 86%.
2. **M1** — HITL `mail.send_with_attachments` + existing document refs. Turns “facts known” into drafts that can leave HITL later. This is the step that automates **outbound email**, not PMS.
2b. **`hms_attach_guest_stay_document`** — HITL copy inbound voucher/POP/.eml onto Guest Stay **Documents** tab (Create/Upload). Inverse of M1. See `2026-09-11-hms-attach-inbound-document.md`. After find + `documents_list_existing` dup check. Not IDM. Not folio Email Documents.
3. **D1–D3** — generate/send quote, invoice/folio, confirmation. Closes 147 pending doc-sends. Maps to Infor Email Documents / Confirm to Email / 361 autos.
4. **W1** — post deposit/payment. 165 pending. Keep HITL. Guest-visible subset is payment_ack 71; 80 are staff “charge this VCC”.
5. **W2** — refund. Supervisor. Last money class before disable-HITL on mail.
6. **W3** — create. 31 pending. CRS Check Availability is the write path, not a quote.
7. **W4–W5** — cancel then amend. Small pending; high blast radius (fee/forfeit).

**Then stop.** Next “tools” would be ops dashboard, group-block writes, event BEO, SCS connectors — not guest email.

### Disable-HITL ladder (policy on this same set)

| Auto-approve when | Still HITL forever (default) |
|---|---|
| Send existing HMS PDF + template ack | Any `post_payment`, `refund`, `cancel` with fee/forfeit |
| Quote send after `hms_quote_stay` complete + held:false | Create / amend_rate Override |
| Channel parse → find only (no charge) | Card/VCC charge, unknown money |

Infor refund already requires supervisor when `Refund Requires Approval` is set. Do not “disable HITL” on W1/W2 by product wish.

## What changed vs prior 3949 catalogue

Earlier close-read ranked **pending PMS writes** as post_payment → quote → invoice → refund. That is still true for **ledger**. For **email automation**, Wave 2 send/attach outranks Wave 4 post, because 1916 writes are already done in PMS and the remaining staff work is the email. Cancel-first (420-era) is **wrong** for both pending (12) and email.

## 95 threshold

**Met** for: read spine (Codex+420+3949 agree), two missing reads, send/attach as email lever, Infor write surfaces (CRS create, Stay Wizard, cancel policy, advance deposit, Email Documents), cannot-claim-100% (ops/internal/Sent-only).

**Not met** for: live HMS adapter field-level mapping (Codex videos not this run); exact Centurion tax-invoice parameter (`TAXINV` / `FORCETAXINVONPAYMENT`) on this property; whether internal_coord “charge VCC” should be a guest tool at all.

## Remaining gaps

- 3949 is **Sent**. Inbound RFQ create/quote volume unknown — create rank may be low.
- Labels one-pass, 40 low-confidence.
- `hms_sent_email_audit` named 2/3949 — likely under-tagged; keep, don’t promote.
- `productionActiveReadToolIds()` empty — Wave 0 unfinished.
- No live write fixtures in this worktree.

## Route used

Local: `read-tools.ts`, Sep-04/06/07/10 plans, 3949 `labels-all.jsonl` / `automation-coverage.json`, Codex session JSONL (tool-ID rationale only). Exa basic + fetch (no Agent). Subagents: Codex-why, coverage classifier.

## Sources

- `.private/gold-reanalysis-2026-09-10/labels-aggregate.json`
- `.private/gold-reanalysis-2026-09-10/automation-coverage.json`
- `apps/server-pilot/src/hms/read-tools.ts` (`READ_TOOL_IDS`, `productionActiveReadToolIds`)
- `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md`
- `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md`
- `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md`
- `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`
- `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md`
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573998.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428572875.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/msh1719480545520.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428570987.html
- https://docs.infor.com/hms/3.8/en-us/hmsolh/mru1453227736677.html
