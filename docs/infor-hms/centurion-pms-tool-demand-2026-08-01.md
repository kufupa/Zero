# Centurion → PMS tool demand analysis (2026-08-01)

> Read-only corpus analysis. No PMS mutation. Guest bodies stay in gitignored dumps; this doc is aggregates + recommendations.

## Snapshot

- Generated: 2026-08-01T01:46:13.551Z
- Dump source: pilot RDS `transport-centurion` via `dump-centurion-emails-md.mjs`
- Messages: **526** (458 inbound / 68 outbound)
- Threads: **434**
- Multi-message threads: **48**
- Threads with staff outbound: **68**
- Threads with ≥1 PMS-fact signal: **390** (89.9%)
- Prior roadmap baseline (27–29 Jul): 223 msgs / 193 threads / 26 outbound — corpus **grew ~2.4×**.

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
| `docs/infor-hms/centurion-outbound-index-2026-08-01.md` | Outbound index (subjects) | tracked |
| `docs/infor-hms/centurion-thread-collation-summary-2026-08-01.md` | Thread size/direction summary | tracked |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` | This analysis + tool recs | tracked |

## 2) Thread collation

- 434 threads; 48 conversations (2+ msgs).
- 68 threads already have Centurion outbound (historical reply workflows).
- 272 inbound-only threads still look PMS-reply-worthy (heuristic).
- See `docs/infor-hms/centurion-thread-collation-summary-2026-08-01.md` for size + I/O pattern histograms.

## 3) Outbound / response view

- **68 outbound messages** across **68 threads**.
- Dominant pattern still document/confirmation delivery + invoice/tax language.
- Full outbound subject index: `docs/infor-hms/centurion-outbound-index-2026-08-01.md`.

### Outbound intent hits

| Intent | Msgs | % outbound |
| --- | --- | --- |
| Confirm / status check | 66 | 97.1% |
| Invoice / tax / pro-forma docs | 66 | 97.1% |
| Templated confirmation / voucher delivery (outbound) | 66 | 97.1% |
| OTA / channel booking notice | 4 | 5.9% |

### Outbound PMS facts

| Fact | Msgs | % outbound |
| --- | --- | --- |
| Confirmation / reservation number | 66 | 97.1% |
| Reservation status (confirmed/cancelled/no-show) | 66 | 97.1% |
| Tax invoice / VAT / pro-forma | 66 | 97.1% |
| Payment / deposit / refund | 66 | 97.1% |
| Company / agency billing / account | 66 | 97.1% |
| Confirmation letter / voucher / PDF attach | 66 | 97.1% |
| External / channel reference (OTA, travel agent) | 4 | 5.9% |

## 4) Whole-corpus intent demand (all messages)

| Intent | Msgs | % msgs |
| --- | --- | --- |
| Confirm / status check | 220 | 41.8% |
| Group / event / conference | 178 | 33.8% |
| New booking request | 174 | 33.1% |
| Invoice / tax / pro-forma docs | 173 | 32.9% |
| Templated confirmation / voucher delivery (outbound) | 136 | 25.9% |
| Cancellation / refund | 82 | 15.6% |
| In-stay / post-stay guest service | 81 | 15.4% |
| Payment / deposit / POP | 79 | 15.0% |
| OTA / channel booking notice | 45 | 8.6% |
| Amend existing reservation | 36 | 6.8% |
| Marketing / spam / newsletter | 35 | 6.7% |
| Internal ops / FW staff mail | 35 | 6.7% |
| Stay quote / rate request | 25 | 4.8% |

### Thread-level intents

| Intent | Threads | % threads |
| --- | --- | --- |
| Confirm / status check | 183 | 42.2% |
| Group / event / conference | 124 | 28.6% |
| New booking request | 119 | 27.4% |
| Invoice / tax / pro-forma docs | 118 | 27.2% |
| Templated confirmation / voucher delivery (outbound) | 99 | 22.8% |
| In-stay / post-stay guest service | 60 | 13.8% |
| Cancellation / refund | 59 | 13.6% |
| Payment / deposit / POP | 48 | 11.1% |
| OTA / channel booking notice | 41 | 9.4% |
| Marketing / spam / newsletter | 35 | 8.1% |
| Internal ops / FW staff mail | 35 | 8.1% |
| Amend existing reservation | 30 | 6.9% |
| Stay quote / rate request | 21 | 4.8% |

## 5) PMS field / access requirements

Facts an external PMS (Infor HMS) must supply if agent drafts replies without inventing numbers:

| Fact type | Threads | % threads | Source |
| --- | --- | --- | --- |
| Confirmation / reservation number | 198 | 45.6% | PMS |
| Confirmation letter / voucher / PDF attach | 188 | 43.3% | PMS |
| Reservation status (confirmed/cancelled/no-show) | 186 | 42.9% | PMS |
| Payment / deposit / refund | 181 | 41.7% | PMS |
| Rate / quote / BAR / package price | 153 | 35.3% | PMS |
| Arrival / departure / nights | 142 | 32.7% | PMS |
| Tax invoice / VAT / pro-forma | 127 | 29.3% | PMS |
| Group / allotment / rooming list | 119 | 27.4% | PMS |
| Company / agency billing / account | 117 | 27.0% | PMS |
| Room type / occupancy | 101 | 23.3% | PMS |
| Room availability / inventory | 78 | 18.0% | PMS |
| Event / meeting / F&B | 63 | 14.5% | PMS |
| External / channel reference (OTA, travel agent) | 60 | 13.8% | PMS |
| Loyalty / membership | 56 | 12.9% | PMS |
| Guest / lead name for lookup | 46 | 10.6% | PMS |
| Special requests / preferences | 18 | 4.1% | PMS |
| Folio / balance / outstanding amount | 10 | 2.3% | PMS |
| Prior HMS-sent email / resend | 5 | 1.2% | PMS |

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
| 1 | `hms_find_reservation` | Find reservation (Guest Stay search) | active_read | 3380 | 638 | 733 |
| 2 | `mail_read_artifact` | Read inbound PDF/attachment text (no OCR) | active_read | 2424 | 390 | 627 |
| 3 | `hms_list_documents` | List / fetch confirmation + pro-forma + tax invoice docs | roadmap_read | 2236 | 400 | 518 |
| 4 | `hms_company_account_read` | Company / agency account billing read | roadmap_read | 2077 | 409 | 425 |
| 5 | `hms_group_block_read` | Group / allotment / rooming-list read | roadmap_read | 1672 | 264 | 440 |
| 6 | `hms_quote_stay` | Quote stay (Room Availability + Display Rates) | active_read | 1368 | 140 | 474 |
| 7 | `hms_read_folio` | Read folio / balance | roadmap_read | 1311 | 225 | 318 |
| 8 | `hms_sent_email_audit` | Sent-email audit / resend check | roadmap_read | 1289 | 301 | 193 |
| 9 | `hms_event_read` | Event / F&B reservation read | roadmap_read | 1151 | 145 | 358 |
| 10 | `hms_guest_preferences_read` | Guest preferences / special requests read | roadmap_read | 755 | 209 | 64 |

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

## Coverage story vs prior plan

| Metric | Prior (27–29 Jul) | Now (01 Aug dump) |
| --- | --- | --- |
| Messages | 223 | 526 |
| Threads | 193 | 434 |
| Outbound msgs | 26 | 68 |
| Threads w/ outbound | ~26 | 68 |
| Threads w/ PMS signal | n/a | 390 |

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

