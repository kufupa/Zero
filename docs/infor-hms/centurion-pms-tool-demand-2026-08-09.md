# Centurion → PMS tool demand analysis (2026-08-09)

> Read-only corpus analysis. No PMS mutation. Guest bodies stay in gitignored dumps; this doc is aggregates + recommendations.

## Snapshot

- Generated: 2026-08-09T17:59:06.128Z
- Dump source: pilot RDS `transport-centurion` via `dump-centurion-emails-md.mjs`
- Messages: **1304** (1176 inbound / 128 outbound)
- Threads: **1026**
- Multi-message threads: **115**
- Threads with outbound: **124**
- Threads with ≥1 PMS-fact signal: **923** (90.0%)
- Previous documented baseline: 812 msgs (724 inbound / 88 outbound, 668 threads) on 2026-08-04.
- Vs previous documented baseline: **+492 msgs**, +452 inbound, +40 outbound, +358 threads.

## Method

1. Refresh flat dump from RDS (read-only).
2. Regroup by `thread_id` chronological order → `centurion-emails-by-thread.md`.
3. Index all outbound subjects + intent/fact hits.
4. Regex-classify every message subject+body for intents and PMS fact types.
5. Score tool candidates by thread-level fact/intent coverage.
6. Recommend minimum tool portfolio to draft ~100% of reply-worthy Centurion mail.

Caveat: regex classifiers are recall-oriented; expect some false positives. Counts are demand signals, not exact ops tickets.

## 1) Artifacts on disk

| File | Role | Git |
| --- | --- | --- |
| `centurion-emails-dump.md` | Flat message dump | gitignored |
| `centurion-emails-by-thread.md` | Full thread collation | gitignored |
| `docs\infor-hms\centurion-outbound-index-2026-08-09.md` | Outbound index (subjects) | tracked |
| `docs\infor-hms\centurion-thread-collation-summary-2026-08-09.md` | Thread size/direction summary | tracked |
| `docs\infor-hms\centurion-pms-tool-demand-2026-08-09.md` | This analysis + tool recs | tracked |

## 2) Thread collation

- 1026 threads; 115 conversations (2+ msgs).
- 124 threads already have observed Centurion outbound.
- 632 inbound-only threads still look PMS-reply-worthy (heuristic).
- See `docs\infor-hms\centurion-thread-collation-summary-2026-08-09.md` for size + I/O pattern histograms.

## 3) Outbound / response view

- **128 outbound messages** across **124 threads**.
- Dominant pattern still document/confirmation delivery + invoice/tax language.
- Full outbound subject index: `docs\infor-hms\centurion-outbound-index-2026-08-09.md`.

### Outbound intent hits

| Intent | Msgs | % outbound |
| --- | --- | --- |
| Confirm / status check | 122 | 95.3% |
| Templated confirmation / voucher delivery (outbound) | 120 | 93.8% |
| Invoice / tax / pro-forma docs | 117 | 91.4% |
| New booking request | 9 | 7.0% |
| Group / event / conference | 7 | 5.5% |
| OTA / channel booking notice | 4 | 3.1% |

### Outbound PMS facts

| Fact | Msgs | % outbound |
| --- | --- | --- |
| Confirmation / reservation number | 120 | 93.8% |
| Reservation status (confirmed/cancelled/no-show) | 120 | 93.8% |
| Confirmation letter / voucher / PDF attach | 120 | 93.8% |
| Company / agency billing / account | 118 | 92.2% |
| Tax invoice / VAT / pro-forma | 117 | 91.4% |
| Payment / deposit / refund | 113 | 88.3% |
| Group / allotment / rooming list | 8 | 6.3% |
| External / channel reference (OTA, travel agent) | 4 | 3.1% |
| Arrival / departure / nights | 2 | 1.6% |
| Room type / occupancy | 2 | 1.6% |

## 4) Whole-corpus intent demand (all messages)

| Intent | Msgs | % msgs |
| --- | --- | --- |
| Confirm / status check | 512 | 39.3% |
| Group / event / conference | 452 | 34.7% |
| New booking request | 396 | 30.4% |
| Invoice / tax / pro-forma docs | 375 | 28.8% |
| Templated confirmation / voucher delivery (outbound) | 240 | 18.4% |
| In-stay / post-stay guest service | 201 | 15.4% |
| Cancellation / refund | 199 | 15.3% |
| Payment / deposit / POP | 166 | 12.7% |
| Marketing / spam / newsletter | 92 | 7.1% |
| OTA / channel booking notice | 91 | 7.0% |
| Amend existing reservation | 86 | 6.6% |
| Internal ops / FW staff mail | 65 | 5.0% |
| Stay quote / rate request | 53 | 4.1% |

### Thread-level intents

| Intent | Threads | % threads |
| --- | --- | --- |
| Confirm / status check | 388 | 37.8% |
| Group / event / conference | 274 | 26.7% |
| New booking request | 265 | 25.8% |
| Invoice / tax / pro-forma docs | 239 | 23.3% |
| Templated confirmation / voucher delivery (outbound) | 171 | 16.7% |
| Cancellation / refund | 155 | 15.1% |
| In-stay / post-stay guest service | 130 | 12.7% |
| Payment / deposit / POP | 93 | 9.1% |
| Marketing / spam / newsletter | 88 | 8.6% |
| OTA / channel booking notice | 86 | 8.4% |
| Amend existing reservation | 66 | 6.4% |
| Internal ops / FW staff mail | 64 | 6.2% |
| Stay quote / rate request | 42 | 4.1% |

## 5) PMS field / access requirements

Facts an external PMS (Infor HMS) must supply if agent drafts replies without inventing numbers:

| Fact type | Threads | % threads | Source |
| --- | --- | --- | --- |
| Confirmation / reservation number | 452 | 44.1% | PMS |
| Confirmation letter / voucher / PDF attach | 423 | 41.2% | PMS |
| Reservation status (confirmed/cancelled/no-show) | 397 | 38.7% | PMS |
| Payment / deposit / refund | 384 | 37.4% | PMS |
| Rate / quote / BAR / package price | 357 | 34.8% | PMS |
| Arrival / departure / nights | 342 | 33.3% | PMS |
| Company / agency billing / account | 282 | 27.5% | PMS |
| Group / allotment / rooming list | 270 | 26.3% | PMS |
| Tax invoice / VAT / pro-forma | 256 | 25.0% | PMS |
| Room type / occupancy | 247 | 24.1% | PMS |
| Room availability / inventory | 170 | 16.6% | PMS |
| External / channel reference (OTA, travel agent) | 162 | 15.8% | PMS |
| Event / meeting / F&B | 134 | 13.1% | PMS |
| Loyalty / membership | 127 | 12.4% | PMS |
| Guest / lead name for lookup | 119 | 11.6% | PMS |
| Folio / balance / outstanding amount | 35 | 3.4% | PMS |
| Special requests / preferences | 35 | 3.4% | PMS |
| Prior HMS-sent email / resend | 9 | 0.9% | PMS |
| Room number / assignment | 1 | 0.1% | PMS |

### Field groups → Infor surfaces

| Needed fields | Likely Infor surface | Notes |
| --- | --- | --- |
| confirmation, external ref, guest, dates, status, room type | Guest Stay / OSRESS.search | Live not-found canary already proven |
| availability counts by date/room | Room Availability | Read-only inventory; never CRS Check Availability |
| rate amount, plan, inclusions, currency | Display Rates | Separate from inventory; `bookable=false` |
| folio balance, deposits, settlements | Folios / Advance Deposit | Roadmap read |
| tax invoice / pro-forma / confirmation PDF | Property documents / Sent Email | Outbound corpus is wrapper-heavy |
| company bill-to, agency terms | Profiles / AR accounts | Corporate + TA mail |
| group block, rooming list | Group Booking / blocks | Conference/showcase threads |
| event package / F&B | Event Reservations | Event quote threads |
| prior outbound proof | Sent Email audit | “Did you send…?” |
| voucher/POP text | Mail attachment text extract | Not PMS, but blocks HMS lookup |

## 6) Recommended common tools for 100% drafting coverage

Goal: AI drafting agent can answer **every reply-worthy Centurion thread** with cited facts (HITL send still required).

Score = `2×thread_fact_hits + 3×thread_intent_hits` from this corpus.

| Rank | Tool | Title | Phase | Score | Intent hits | Fact hits |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `hms_find_reservation` | Find reservation (Guest Stay search) | active_read | 7424 | 1328 | 1720 |
| 2 | `mail_read_artifact` | Read inbound PDF/attachment text (no OCR) | active_read | 5260 | 806 | 1421 |
| 3 | `hms_list_documents` | List / fetch confirmation + pro-forma + tax invoice docs | roadmap_read | 4674 | 798 | 1140 |
| 4 | `hms_company_account_read` | Company / agency account billing read | roadmap_read | 4457 | 871 | 922 |
| 5 | `hms_group_block_read` | Group / allotment / rooming-list read | roadmap_read | 3801 | 581 | 1029 |
| 6 | `hms_quote_stay` | Quote stay (Room Availability + Display Rates) | active_read | 3153 | 307 | 1116 |
| 7 | `hms_read_folio` | Read folio / balance | roadmap_read | 2811 | 487 | 675 |
| 8 | `hms_sent_email_audit` | Sent-email audit / resend check | roadmap_read | 2745 | 627 | 432 |
| 9 | `hms_event_read` | Event / F&B reservation read | roadmap_read | 2614 | 316 | 833 |
| 10 | `hms_guest_preferences_read` | Guest preferences / special requests read | roadmap_read | 1691 | 461 | 154 |

### Must-have now (covers drafting wedge)

1. **`hms_find_reservation`** — Guest Stay real search + row parse. Without this, agent cannot ground confirmations, amendments, invoices, or “where is my booking?”.
2. **`hms_quote_stay`** — Availability + Display Rates as separate observations. Required for quote/new-booking inbound.
3. **`mail_read_artifact`** — Already in foundation; keep. Many inbound vouchers/POPs carry the only confirmation/external ref.
4. **`hms_list_documents` + attach path** — Outbound history shows staff replies are often confirmation/pro-forma delivery, not bespoke essays. Drafting 100% of *sent shape* needs document lookup/generation, not just prose.

### Next wave (unlock invoice/payment/group)

5. **`hms_read_folio`** — balances, deposits, refunds.
6. **`hms_sent_email_audit`** — prove prior send / support resend decisions.
7. **`hms_company_account_read`** — corporate/TA bill-to.
8. **`hms_group_block_read`** + **`hms_event_read`** — group/conference/showcase.

### Explicitly not in autonomous discovery

- CRS Check Availability (creates reservation).
- Any save/create/amend/cancel/post/settle/refund/send write.
- Live write-form exploration.

## Coverage story vs prior dumps

| Metric | 27–29 Jul | 01 Aug | 2026-08-09 |
| --- | --- | --- | --- |
| Messages | 223 | 526 | 1304 |
| Threads | 193 | 434 | 1026 |
| Outbound msgs | 26 | 68 | 128 |
| Threads w/ outbound | ~26 | 68 | 124 |
| Threads w/ PMS signal | n/a | 390 | 923 |
| Open inbound needing reply | n/a | 272 | 632 |

Foundation three tools (`find_reservation`, `quote_stay`, `mail_read_artifact`) still cover **lookup + quote + attachment** — the evidence core.
They do **not** complete document-delivery outbound, folio/tax, group/event, or company billing alone.
For “draft 100% of emails,” treat **document list/fetch** and **folio read** as equal priority after live Guest Stay adapter works.

## Practical build order (aligned to live ladder)

1. Live Guest Stay adapter + worker Playwright session + shadow real reads (steps 4–6).
2. Harden quote path on live Room Availability + Display Rates (still read-only).
3. Document list/fetch read + outbound-shaped draft templates.
4. Folio + sent-email audit reads.
5. Group/event/company account reads.
6. Only then human-supervised write tools (create/amend/cancel/send docs).

## Safety reminder

- Analysis used mail corpus + classifiers only.
- Live PMS: read exploration OK; **no writes / no side-effecting clicks**.
- Do not commit gitignored dumps (PII).

