---
date: 2026-10-24
lane: S5 (multi-hotel shape)
model: GPT-6 Luna max (Sonnet slot) wrote the scan; coordinator (Opus 5.5) fixed one parse bug and ran it
method: read-only prod SQL export (BEGIN READ ONLY / ROLLBACK) + S3 GET of outbound PDF/XLSX, regex labels; temp files deleted on EC2 14:16Z
window: outbound sent in the 30 days before 2026-10-24 ~14:00Z
reproduce: 2026-10-24-multihotel-shape-S5/export.sql + scan.py (needs S3_BUCKET env)
---

# S5 — Rate labels per mailbox and what predicts them

**Answer: Faith quotes mostly STO/net and contract, not BAR (33 + 35 vs 26 docs). "Wholesale" is written once in 30 days across all 6 mailboxes. Simple sender rules predict the label badly (best: government sender → GOV 7/10).** This is a regex scan of rate words, not a validated price answer key (that is S4).

## 1. Scope

| Item | Count |
|---|---:|
| Outbound messages (6 mailboxes) | 3,473 (3,461 distinct Message-ID; outbound copies rarely duplicate) |
| PDF/XLSX attachments | 2,016 (1,794 unique files, 0 download failures, 1,789 parsed) |
| "Quote-like" outbound | 1,458 = body says quote/quotation/proposal, OR an attachment reads like a rate document, OR the body has an inline room + price + stay |
| With a rate label found | 1,288 (1,242 attachment only; 105 have 2+ labels) |
| Matched to a prior inbound on the thread | 344 / 1,458 (24%) — predictor tables below rest on this subset |

**Caveat (INFERENCE):** the "rate document" rule also catches HMS confirmation letters (they print rate code + nightly rate). So label counts = "rate words staff sent", not "quotes". BAR is inflated most by this.

## 2. Mailbox × label (docs with that word)

| Mailbox | Quote-like | BAR | STO/net | contract/NC | wholesale | GOV | airline | promo | corporate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| centurion@ | 619 | 487 | 1 | 6 | 0 | 18 | 1 | 11 | 44 |
| davinci@ | 577 | 551 | 3 | 3 | 1 | 2 | 2 | 1 | 1 |
| faith | 73 | 26 | **33** | **35** | 0 | 0 | 0 | 0 | 1 |
| ayanda | 17 | 5 | 1 | 4 | 0 | 3 | 2 | 0 | 0 |
| epick | 108 | 87 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| kmgidi | 64 | 41 | 10 | 11 | 0 | 2 | 3 | 2 | 0 |
| **total** | 1,458 | 1,197 | 49 | 61 | **1** | 25 | 8 | 16 | 46 |

- VERIFIED (counts of regex hits): Faith and kmgidi carry almost all DV STO/contract. davinci@ (shared) is ~all BAR.
- INFERENCE: Faith handles the agency/contract desk; her "I can't see wholesale" matches her mix (STO/net is the wholesale-type rate she sends under another name). Needs her confirmation or an HMS strategy-code check.

## 3. Label × inbound features (344 matched rows; medians on few rows)

| Label | n | Sender: TA / GOV / CO / unknown | Rooms med | Lead days med | Nights med | Nightly ZAR med |
|---|---:|---|---|---|---|---|
| BAR | 1,197 | 41 / 0 / 120 / 1,034 | 1 (n=9) | 14 (n=51) | 2 (n=34) | 2,630 (n=940) |
| STO/net | 49 | 17 / 0 / 23 / 9 | **16** (n=7) | 52 (n=9) | 2.5 (n=6) | unparsed |
| contract/NC | 61 | 20 / 0 / 29 / 11 | **12** (n=6) | 38 (n=11) | 2 (n=9) | 2,245 (n=6) |
| GOV | 25 | 4 / 7 / 8 / 5 | — | 104 (n=2) | 2 (n=3) | 1,420 (n=2) |
| airline | 8 | 0 / 0 / 2 / 6 | — | 4 (n=1) | — | 1,420 (n=1) |
| corporate | 46 | 1 / 0 / 2 / 43 | — | — | — | 1,700 (n=40; 27 Standard Queen → Centurion) |

INFERENCE (thin n): STO/contract go with group-size asks booked weeks ahead; BAR with 1-room short-lead asks.

## 4. Rules tested (hit / eligible)

| Rule | Hits | Verdict |
|---|---:|---|
| government/SOE sender → GOV | 7/10 | only usable signal; n=10 borderline |
| travel agent → STO/net | 17/128 | 13%, not usable |
| travel agent → wholesale | 0/128 | wholesale is not written down |
| named company/rate in ask → contract | 10/84 | 12%, not usable |
| company domain → corporate | 2/238 | no |

**Verdict:** sender class alone can't suggest the rate. Next candidate = per-party history (which strategy staff used last time for this agency/company), the same move that beat the LLM for party bind (FACTS, 2026-10-19). Needs the HMS party bind joined to the quote, which this scan lacks.

## 5. Wholesale

1 doc, davinci@, 2026-10-16, sent to an internal address, attachment, rooms Deluxe/Double/Executive/King; no price, inbound unknown. Staff do not write "wholesale" in what they send.

## 6. What a rate-suggestion eval needs

- Truth: the HMS rate code staff booked/quoted (confirmation PDF or HMS read), not regex words. ≥100 rows by id, with bound party.
- Join inbound → quote reliably (24% here). Separate confirmation letters from quotes.
- 95 threshold **not met** for any predictive claim; counts in §2 are the only verified output.
