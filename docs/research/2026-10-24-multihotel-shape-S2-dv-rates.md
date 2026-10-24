# S2 — Da Vinci quote-rate answer key
**Answer:** Prod DB has 1,931 DV staff outbound messages. It has no extracted outbound PDF/Excel text. So actual rate/room/board/nightly-price answer key and agency→strategy map stay unverified. Body scan found 15 crude full-field candidates; zero validated rows.
- Required context read; `origin/main` `1656bca50`. `copy.ts` has no DV aliases; actual list: [`mailbox-hms-origin-bind.ts`](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/src/hms/mailbox-hms-origin-bind.ts#L7-L44).
- No guest names, emails, phone numbers, raw message text, or S3 keys included.
---

## 1. Verified scope

| Scope | Count / window |
|---|---:|
| DV transports | 5 staff transports |
| Outbound | **1,931**, all unique Message-ID headers; inbound 5,713 |
| Outbound date window | 2026-10-08 13:24 → 2026-10-23 15:59; DB timezone unspecified |
| Body contains `quote` or `quotation` | 148 messages / 98 threads; 2026-10-08 13:56 → 2026-10-23 15:08 |
| PDFs / spreadsheets | 1,148 PDF files on 927 messages; 25 Excel files on 21 messages; 944 messages have either |

- Supplied ~1,687 outbound count is 244 below current count. Duplicate Message-IDs do not explain gap; earlier window/query differs, cause unknown.
- Exact body substring `quote`: 110 messages, near supplied 111. Adding `quotation`: 148 total.

## 2. Body labels are clues, not proven priced rate classes

Counts use outbound `quote`/`quotation` bodies; overlap possible. Room/board are body tokens only.

| Rate label | Body hits | Room-term hits | Board: B&B / RO / dinner-DBB | Distinct external domains* |
|---|---:|---:|---:|---:|
| BAR | 16 | 13 | 6 / 0 / 0 | 6 |
| Wholesale / WS | 1 | 1 | 1 / 1 / 0 | 0 |
| Contract word | 17 | 13 | 7 / 1 / 3 | 4 |
| NC token | 1 | 1 | 0 / 0 / 0 | 1 |
| Government / GOV | 7 | 5 | 0 / 0 / 2 | 2 |
| Airline | 8 | 1 | 2 / 0 / 0 | 4 |
| STO / net | 18 | 15 | 9 / 1 / 4 | 8 |
| Promo | 7 | 3 | 0 / 0 / 1 | 0 |
| Rack | 3 | 1 | 3 / 1 / 0 | 2 |

- Exact phrase `contract rate`: **0** in quote/quotation bodies. Body room clues: Standard Queen **0**, Standard King 24, Deluxe 22, Executive 13, Twin 39; not verified inventory.
- 48 quote bodies have `R<number>`, 40 have “per night,” 146 have date-like text. Body amounts can be totals or quoted history. **No defensible ZAR/night range by rate class.**
- *External domains are thread-linked sender-domain proxies, not confirmed agencies or recipients of the named rate.

## 3. Provisional contract-domain leads

Same-thread latest inbound domain joined to quote/quotation bodies containing exact `contract` word. **Inference only; not confirmed contract pricing.**

| Sender domain | Tagged outbound messages |
|---|---:|
| thompsonsafrica.co.za | 3 |
| nissan.co.za | 2 |
| luxustravel.co.za | 1 |
| rgcosmetics.co.za | 1 |
| No linked inbound sender | 3 |

No external domain linked to the one wholesale-word body hit. Do not use this as strategy policy.

## 4. Answer-key readiness

| Check | Result |
|---|---:|
| Crude body intersection: Rand + per-night + specific room + dates + board | 15 distinct messages |
| By keyword class | STO/net 7; BAR 4; contract-word 3; others 0 |
| **Validated answer-key rows** | **0** |
| ≥10 verified rows per main rate type | **Not met** |

Regex candidates can include quoted history; no attached text to validate. Do not train rate defaults from them.

## 5. Attachment metadata only

| Filename keyword* | Type | Files |
|---|---|---:|
| Contract / net / rate / STO | PDF | 6 / 4 / 1 / 5 |
| Rate / STO | XLSX | 3 / 1 |

- Keyword counts overlap. No wholesale/GOV/airline/promo/rack filename hit. No candidate filename passed generic safe-name filter; raw names withheld pending guest-name screening.
- `mail_extraction`: **0 outbound rows**. `attachment` stores filename, MIME, size, S3 key—not extracted text. Binary objects may exist in S3; this SQL-only lane did not read them.

## Method / status

`BEGIN READ ONLY;` aggregate `message` by five DV transport IDs and outbound direction; join `attachment` for MIME/filename-keyword counts; link latest prior inbound by same transport/thread for sender-domain proxies; check `mail_extraction`; `ROLLBACK;`. Queries ran through `ssm-run-command.sh` from `.worktrees/recover-parse-failure`. No writes, sends, or HMS access.

**VERIFIED:** transport/message counts, timestamps, body keyword counts, attachment metadata, no outbound extraction rows, read-only transactions. **INFERENCE:** rate class, room/board/price facts, and agency mapping from body terms/domains. Reliable prices require read-only PDF/XLSX text extraction with guest fields suppressed.
