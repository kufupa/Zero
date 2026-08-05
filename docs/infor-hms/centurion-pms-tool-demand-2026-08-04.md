# Centurion → PMS tool demand analysis (2026-08-04)

> Read-only corpus analysis. No PMS mutation. Guest bodies stay in gitignored dumps; this doc is aggregates + recommendations.

## Snapshot

- Generated: 2026-08-04T11:26:59.309Z
- Dump source: pilot RDS `transport-centurion` via `dump-centurion-emails-md.mjs`
- Messages: **812** (724 inbound / 88 outbound)
- Threads: **668**
- Multi-message threads: **63**
- Threads with staff outbound: **86**
- Threads with ≥1 PMS-fact signal: **599** (89.7%)
- Prior dumps: 223 msgs (27–29 Jul) → 526 msgs (01 Aug) → 623 msgs (03 Aug) → **812 msgs (04 Aug)**.
- Vs 03 Aug: **+189 msgs**, +16 outbound, +148 threads.

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
| `docs/infor-hms/centurion-outbound-index-2026-08-04.md` | Outbound index (subjects) | tracked |
| `docs/infor-hms/centurion-thread-collation-summary-2026-08-04.md` | Thread size/direction summary | tracked |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-04.md` | This analysis + tool recs | tracked |

## 2) Thread collation

- 668 threads; 63 conversations (2+ msgs).
- 86 threads already have Centurion outbound (historical reply workflows).
- 420 inbound-only threads still look PMS-reply-worthy (heuristic).
- See `docs/infor-hms/centurion-thread-collation-summary-2026-08-04.md` for size + I/O pattern histograms.

## 3) Outbound / response view

- **88 outbound messages** across **86 threads**.
- Dominant pattern still document/confirmation delivery + invoice/tax language.
- Full outbound subject index: `docs/infor-hms/centurion-outbound-index-2026-08-04.md`.

### Outbound intent hits

| Intent | Msgs | % outbound |
| --- | --- | --- |
| Confirm / status check | 84 | 95.5% |
| Templated confirmation / voucher delivery (outbound) | 84 | 95.5% |
| Invoice / tax / pro-forma docs | 80 | 90.9% |
| New booking request | 6 | 6.8% |
| OTA / channel booking notice | 4 | 4.5% |
| Group / event / conference | 4 | 4.5% |

### Outbound PMS facts

| Fact | Msgs | % outbound |
| --- | --- | --- |
| Confirmation letter / voucher / PDF attach | 84 | 95.5% |
| Confirmation / reservation number | 82 | 93.2% |
| Reservation status (confirmed/cancelled/no-show) | 82 | 93.2% |
| Company / agency billing / account | 82 | 93.2% |
| Tax invoice / VAT / pro-forma | 80 | 90.9% |
| Payment / deposit / refund | 78 | 88.6% |
| External / channel reference (OTA, travel agent) | 4 | 4.5% |
| Group / allotment / rooming list | 4 | 4.5% |
| Arrival / departure / nights | 2 | 2.3% |

## 4) Whole-corpus intent demand (all messages)

| Intent | Msgs | % msgs |
| --- | --- | --- |
| Confirm / status check | 335 | 41.3% |
| Group / event / conference | 271 | 33.4% |
| New booking request | 260 | 32.0% |
| Invoice / tax / pro-forma docs | 237 | 29.2% |
| Templated confirmation / voucher delivery (outbound) | 174 | 21.4% |
| Cancellation / refund | 132 | 16.3% |
| In-stay / post-stay guest service | 125 | 15.4% |
| Payment / deposit / POP | 105 | 12.9% |
| OTA / channel booking notice | 70 | 8.6% |
| Marketing / spam / newsletter | 50 | 6.2% |
| Amend existing reservation | 50 | 6.2% |
| Internal ops / FW staff mail | 43 | 5.3% |
| Stay quote / rate request | 38 | 4.7% |

### Thread-level intents

| Intent | Threads | % threads |
| --- | --- | --- |
| Confirm / status check | 270 | 40.4% |
| New booking request | 185 | 27.7% |
| Group / event / conference | 184 | 27.5% |
| Invoice / tax / pro-forma docs | 159 | 23.8% |
| Templated confirmation / voucher delivery (outbound) | 125 | 18.7% |
| Cancellation / refund | 99 | 14.8% |
| In-stay / post-stay guest service | 91 | 13.6% |
| Payment / deposit / POP | 67 | 10.0% |
| OTA / channel booking notice | 66 | 9.9% |
| Marketing / spam / newsletter | 50 | 7.5% |
| Amend existing reservation | 43 | 6.4% |
| Internal ops / FW staff mail | 42 | 6.3% |
| Stay quote / rate request | 30 | 4.5% |

## 5) PMS field / access requirements

Facts an external PMS (Infor HMS) must supply if agent drafts replies without inventing numbers:

| Fact type | Threads | % threads | Source |
| --- | --- | --- | --- |
| Confirmation / reservation number | 298 | 44.6% | PMS |
| Confirmation letter / voucher / PDF attach | 282 | 42.2% | PMS |
| Reservation status (confirmed/cancelled/no-show) | 274 | 41.0% | PMS |
| Payment / deposit / refund | 256 | 38.3% | PMS |
| Rate / quote / BAR / package price | 237 | 35.5% | PMS |
| Arrival / departure / nights | 229 | 34.3% | PMS |
| Company / agency billing / account | 180 | 26.9% | PMS |
| Group / allotment / rooming list | 178 | 26.6% | PMS |
| Room type / occupancy | 171 | 25.6% | PMS |
| Tax invoice / VAT / pro-forma | 170 | 25.4% | PMS |
| Room availability / inventory | 116 | 17.4% | PMS |
| External / channel reference (OTA, travel agent) | 115 | 17.2% | PMS |
| Loyalty / membership | 87 | 13.0% | PMS |
| Event / meeting / F&B | 86 | 12.9% | PMS |
| Guest / lead name for lookup | 78 | 11.7% | PMS |
| Special requests / preferences | 30 | 4.5% | PMS |
| Folio / balance / outstanding amount | 20 | 3.0% | PMS |
| Prior HMS-sent email / resend | 7 | 1.0% | PMS |

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
| 1 | `hms_find_reservation` | Find reservation (Guest Stay search) | active_read | 5090 | 920 | 1165 |
| 2 | `mail_read_artifact` | Read inbound PDF/attachment text (no OCR) | active_read | 3588 | 562 | 951 |
| 3 | `hms_list_documents` | List / fetch confirmation + pro-forma + tax invoice docs | roadmap_read | 3176 | 554 | 757 |
| 4 | `hms_company_account_read` | Company / agency account billing read | roadmap_read | 2997 | 595 | 606 |
| 5 | `hms_group_block_read` | Group / allotment / rooming-list read | roadmap_read | 2585 | 399 | 694 |
| 6 | `hms_quote_stay` | Quote stay (Room Availability + Display Rates) | active_read | 2151 | 215 | 753 |
| 7 | `hms_read_folio` | Read folio / balance | roadmap_read | 1867 | 325 | 446 |
| 8 | `hms_sent_email_audit` | Sent-email audit / resend check | roadmap_read | 1865 | 429 | 289 |
| 9 | `hms_event_read` | Event / F&B reservation read | roadmap_read | 1746 | 214 | 552 |
| 10 | `hms_guest_preferences_read` | Guest preferences / special requests read | roadmap_read | 1173 | 319 | 108 |

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

| Metric | 27–29 Jul | 01 Aug | 03 Aug |
| --- | --- | --- | --- |
| Messages | 223 | 526 | 812 |
| Threads | 193 | 434 | 668 |
| Outbound msgs | 26 | 68 | 88 |
| Threads w/ outbound | ~26 | 68 | 86 |
| Threads w/ PMS signal | n/a | 390 | 599 |
| Open inbound needing reply | n/a | 272 | 420 |

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

