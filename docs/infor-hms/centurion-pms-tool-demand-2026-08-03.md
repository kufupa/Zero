# Centurion → PMS tool demand analysis (2026-08-03)

> Read-only corpus analysis. No PMS mutation. Guest bodies stay in gitignored dumps; this doc is aggregates + recommendations.

## Snapshot

- Generated: 2026-08-03T07:57:41.363Z
- Dump source: pilot RDS `transport-centurion` via `dump-centurion-emails-md.mjs`
- Messages: **623** (551 inbound / 72 outbound)
- Threads: **520**
- Multi-message threads: **53**
- Threads with staff outbound: **72**
- Threads with ≥1 PMS-fact signal: **467** (89.8%)
- Prior dumps: 223 msgs (27–29 Jul) → 526 msgs (01 Aug) → **623 msgs (03 Aug)**.
- Vs 01 Aug: **+97 msgs**, +4 outbound, +86 threads.

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
| `docs/infor-hms/centurion-outbound-index-2026-08-03.md` | Outbound index (subjects) | tracked |
| `docs/infor-hms/centurion-thread-collation-summary-2026-08-03.md` | Thread size/direction summary | tracked |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-03.md` | This analysis + tool recs | tracked |

## 2) Thread collation

- 520 threads; 53 conversations (2+ msgs).
- 72 threads already have Centurion outbound (historical reply workflows).
- 322 inbound-only threads still look PMS-reply-worthy (heuristic).
- See `docs/infor-hms/centurion-thread-collation-summary-2026-08-03.md` for size + I/O pattern histograms.

## 3) Outbound / response view

- **72 outbound messages** across **72 threads**.
- Dominant pattern still document/confirmation delivery + invoice/tax language.
- Full outbound subject index: `docs/infor-hms/centurion-outbound-index-2026-08-03.md`.

### Outbound intent hits

| Intent | Msgs | % outbound |
| --- | --- | --- |
| Confirm / status check | 70 | 97.2% |
| Templated confirmation / voucher delivery (outbound) | 70 | 97.2% |
| Invoice / tax / pro-forma docs | 66 | 91.7% |
| OTA / channel booking notice | 4 | 5.6% |
| New booking request | 4 | 5.6% |

### Outbound PMS facts

| Fact | Msgs | % outbound |
| --- | --- | --- |
| Confirmation / reservation number | 70 | 97.2% |
| Reservation status (confirmed/cancelled/no-show) | 70 | 97.2% |
| Company / agency billing / account | 70 | 97.2% |
| Confirmation letter / voucher / PDF attach | 70 | 97.2% |
| Tax invoice / VAT / pro-forma | 66 | 91.7% |
| Payment / deposit / refund | 66 | 91.7% |
| External / channel reference (OTA, travel agent) | 4 | 5.6% |

## 4) Whole-corpus intent demand (all messages)

| Intent | Msgs | % msgs |
| --- | --- | --- |
| Confirm / status check | 242 | 38.8% |
| New booking request | 204 | 32.7% |
| Group / event / conference | 198 | 31.8% |
| Invoice / tax / pro-forma docs | 185 | 29.7% |
| Templated confirmation / voucher delivery (outbound) | 146 | 23.4% |
| In-stay / post-stay guest service | 96 | 15.4% |
| Cancellation / refund | 91 | 14.6% |
| Payment / deposit / POP | 83 | 13.3% |
| OTA / channel booking notice | 59 | 9.5% |
| Marketing / spam / newsletter | 43 | 6.9% |
| Amend existing reservation | 43 | 6.9% |
| Internal ops / FW staff mail | 36 | 5.8% |
| Stay quote / rate request | 29 | 4.7% |

### Thread-level intents

| Intent | Threads | % threads |
| --- | --- | --- |
| Confirm / status check | 201 | 38.7% |
| New booking request | 143 | 27.5% |
| Group / event / conference | 139 | 26.7% |
| Invoice / tax / pro-forma docs | 124 | 23.8% |
| Templated confirmation / voucher delivery (outbound) | 106 | 20.4% |
| In-stay / post-stay guest service | 71 | 13.7% |
| Cancellation / refund | 65 | 12.5% |
| OTA / channel booking notice | 55 | 10.6% |
| Payment / deposit / POP | 52 | 10.0% |
| Marketing / spam / newsletter | 43 | 8.3% |
| Amend existing reservation | 37 | 7.1% |
| Internal ops / FW staff mail | 36 | 6.9% |
| Stay quote / rate request | 25 | 4.8% |

## 5) PMS field / access requirements

Facts an external PMS (Infor HMS) must supply if agent drafts replies without inventing numbers:

| Fact type | Threads | % threads | Source |
| --- | --- | --- | --- |
| Confirmation / reservation number | 222 | 42.7% | PMS |
| Confirmation letter / voucher / PDF attach | 219 | 42.1% | PMS |
| Reservation status (confirmed/cancelled/no-show) | 204 | 39.2% | PMS |
| Payment / deposit / refund | 193 | 37.1% | PMS |
| Rate / quote / BAR / package price | 176 | 33.8% | PMS |
| Arrival / departure / nights | 174 | 33.5% | PMS |
| Company / agency billing / account | 137 | 26.3% | PMS |
| Group / allotment / rooming list | 134 | 25.8% | PMS |
| Tax invoice / VAT / pro-forma | 133 | 25.6% | PMS |
| Room type / occupancy | 122 | 23.5% | PMS |
| Room availability / inventory | 91 | 17.5% | PMS |
| External / channel reference (OTA, travel agent) | 77 | 14.8% | PMS |
| Loyalty / membership | 71 | 13.7% | PMS |
| Event / meeting / F&B | 69 | 13.3% | PMS |
| Guest / lead name for lookup | 51 | 9.8% | PMS |
| Special requests / preferences | 21 | 4.0% | PMS |
| Folio / balance / outstanding amount | 13 | 2.5% | PMS |
| Prior HMS-sent email / resend | 6 | 1.2% | PMS |

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
| 1 | `hms_find_reservation` | Find reservation (Guest Stay search) | active_read | 3833 | 711 | 850 |
| 2 | `mail_read_artifact` | Read inbound PDF/attachment text (no OCR) | active_read | 2718 | 432 | 711 |
| 3 | `hms_list_documents` | List / fetch confirmation + pro-forma + tax invoice docs | roadmap_read | 2453 | 431 | 580 |
| 4 | `hms_company_account_read` | Company / agency account billing read | roadmap_read | 2300 | 458 | 463 |
| 5 | `hms_group_block_read` | Group / allotment / rooming-list read | roadmap_read | 1963 | 307 | 521 |
| 6 | `hms_quote_stay` | Quote stay (Room Availability + Display Rates) | active_read | 1630 | 168 | 563 |
| 7 | `hms_sent_email_audit` | Sent-email audit / resend check | roadmap_read | 1425 | 325 | 225 |
| 8 | `hms_read_folio` | Read folio / balance | roadmap_read | 1401 | 241 | 339 |
| 9 | `hms_event_read` | Event / F&B reservation read | roadmap_read | 1330 | 164 | 419 |
| 10 | `hms_guest_preferences_read` | Guest preferences / special requests read | roadmap_read | 897 | 251 | 72 |

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
| Messages | 223 | 526 | 623 |
| Threads | 193 | 434 | 520 |
| Outbound msgs | 26 | 68 | 72 |
| Threads w/ outbound | ~26 | 68 | 72 |
| Threads w/ PMS signal | n/a | 390 | 467 |
| Open inbound needing reply | n/a | 272 | 322 |

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

