---
date: 2026-10-24
topic: Multi-hotel Nava — consolidated evidence
asks: [210, 211, 212, 216, 217, 218, 219, 220]
plan: docs/plans/2026-10-24-001-multi-hotel-shape.md
---

# Multi-hotel Nava — why we picked what we picked

One page to answer "where did this number come from?" for the multi-hotel plan. Every row links the lane file that holds the method, window and limits. Numbers are from read-only prod SQL, S3 attachment reads, code reads and the ETA ledger. Nothing here came from staff memory unless marked **owner**.

## 1. Sources

| Lane | File | Method | Window / base | Cost / model |
|---|---|---|---|---|
| A1 | [g1023 A1 architecture](2026-10-23-g1023-retro/A1.md) | grep + code read | main `23b71fa40` | Luna max |
| S1 | [Infor fields vs pane](2026-10-24-multihotel-shape-S1-infor-fields.md) | code + docs read | main `1656bca50` | Luna max |
| S2 | [DV rate words in bodies](2026-10-24-multihotel-shape-S2-dv-rates.md) | read-only prod SQL | DV outbound 2026-10-08 → 10-23 | Luna max |
| S3 | [Hotels, users, mail mix](2026-10-24-multihotel-shape-S3-hotels-users-mix.md) | read-only prod SQL | 30 d to 2026-10-24 00:23Z | Luna max |
| S4 | [DV answer key from PDFs](2026-10-24-multihotel-shape-S4-dv-answer-key.md) | S3 GET + pdftotext | 150 DV outbound quote files | Luna max |
| S5 | [Rate words per mailbox](2026-10-24-multihotel-shape-S5-rate-patterns.md) + [script/SQL](2026-10-24-multihotel-shape-S5/) | prod SQL + S3 + regex | 30 d to 2026-10-24 ~14:00Z, 6 mailboxes | Luna max; 1 bug fixed by Opus |
| Retro | [g1023 retro](../context/ledger/2026-10-23-g1023-retro.md) | run logs | 2026-10-22/23 | — |
| Ledger | `~/.claude/eta-ledger.jsonl` (local) | estimate vs actual | all rows to 2026-10-24 | — |

## 2. Facts that drive the design

| # | Fact | Number | Source | Drives |
|---|---|---|---|---|
| F1 | DV quotes all failed in prod | 29/29 refused, 30 d | S3 §4 | rewrite, not patch |
| F2 | Unknown mailbox reads Centurion | every non-DV transport → HRCEN | S3 §1, A1 | registry; unknown refuses |
| F3 | Centurion hard-coded | HRCEN 144 hits / 72 files; "Centurion" 330 / 90 | A1 | rewrite verdict (G8) |
| F4 | Hotels / mailboxes / users | 2 hotels, 7 active mailboxes (1 CEN, 5 DV, 1 Nava), 7 users, 13 grants | S3 §1–2 | per-mailbox grants (owner Q3) |
| F5 | DV grants only in prod DB | seed.ts 7 grants (CEN/Nava), prod 13 | S3 §2 | slice 2 (seed them) |
| F6 | DV duplicate copies | 1,121 repeat copies of the same Message-ID across DV mailboxes / 30 d; CEN 182 | S3 §1 | one HMS read per mail, to-dos per mailbox |
| F7 | DV extraction coverage | 25.6% vs CEN 56.8% | S3 §3 | follow-up (not in this plan) |
| F8 | Pane lists are Centurion constants | room matcher, `CENTURION_RATE_CATALOGUE`, override codes, board labels | S1 §2 | slice 4 |
| F9 | DV room list differs | 9 DV codes (JNRSUI, EXKNGB…), no Standard Queen | S1 §2 | slice 4 |
| F10 | DV create needs Reservation Note | HRDAV profile `reservationnote` required | S1 §2 | registry required fields |
| F11 | Create fields absent from mail | source 31%, adults 25%, guarantee 13%, room 10%, rate 7% (n=91) | `docs/plans/2026-10-06-003-case-coverage-gap-audit.md` | defaults + "suggest" fields |
| F12 | Validated DV prices | 27 BAR B&B facts (Standard King / Suite / Deluxe King, ZAR 2,700–22,813, median 4,071); 0 non-BAR | S4 §2, §7 | G9 BAR price bar |
| F13 | Faith's rate mix | STO/net 33, contract 35, BAR 26 docs | S5 §2 | slice 6 shows all strategies |
| F14 | "Wholesale" written | 1 time in 30 d across 6 mailboxes, no price | S5 §5 | wholesale comes from HMS strategy, not mail |
| F15 | Sender predicts rate? | GOV sender → GOV 7/10; TA → STO 17/128; TA → WS 0/128 | S5 §4 | rate suggestion deferred; try party history |
| F16 | Reply-all closes only replier's to-do | own-domain inbound counts as reply only from an address that mailbox sent from | `apps/server-pilot/src/ai/work-items.ts` (knownSenders, planThreadWork) | slice 5 |
| F17 | Prepare runs per mailbox copy | quote-ready keys on per-copy message row | `apps/server-pilot/src/ai/quote-ready.ts` | slice 5 dedupe |
| F18 | Live-HMS proof time | p50 22 / p75 79 min actual (n=47) | ETA ledger | G5 ETA tail |
| F19 | Next hotels | HRBAK / HRKWA candidates; 1 address hit each | S3 §5 + **owner** "likely, unconfirmed" | registry hotel-agnostic |

## 3. Owner decisions (2026-10-24)

| Q | Decision | Evidence that informed it |
|---|---|---|
| Scope | Quote + create first | PRODUCT.md ROI order; F1 |
| Rates | Every strategy the hotel allows, wholesale included, regardless of corpus | **owner**: Faith "I can't see the wholesale rate"; F13, F14 |
| Access | Each ingested mailbox separate; owner grants per mailbox | **owner**; F4 |
| Duplicates | To-do per mailbox; no claim-on-open; dedupe HMS reads only | **owner**; F6, F16, F17 |
| Routing | Grok 4.6 high orchestrator; Luna codes small units, Grok 4.6 codes HMS/auth/write; Greptile Apex every PR; Grok lane triages comments | **owner** asks 216, 220 |
| HRFAKE | Owner called it low value; kept small (one fake entry) | F2 (10-23 failure was a silent fallback) |

## 4. Known gaps (not evidence, don't quote as fact)

- No validated price for any non-BAR DV strategy. Slice 6 proves them by live read-only HMS shop.
- S5 label counts include confirmation letters; regex, not truth.
- Reply-all miss (F16) is from code; how often it happens is not counted.
- HRBAK/HRKWA tenant, rooms, rates: unknown.
