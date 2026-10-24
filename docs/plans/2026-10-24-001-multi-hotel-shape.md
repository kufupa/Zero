---
title: Multi-hotel Nava (shape brief)
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: shape
date: 2026-10-24
asks: [210, 211, 212, 217, 218, 219, 220]
---

# Multi-hotel Nava — shape brief

## Ask (original words, OWNER-ASKS 210–212)

"Make Nava hotel-agnostic … swap everywhere"; ≥3 more hotels; many users per hotel (Faith + Ayanda at Da Vinci, whole reservations teams). DV pane lacks wholesale and shows Standard Queen, which DV doesn't have. 10/10 = every Infor workflow field per hotel in the pane, prefilled from the email, vague fields suggested from past mail, staff click yes. Propose architecture rewrites, not patches. DV rates from our data + HMS, not from staff.

## Evidence

| Claim | Number | Source |
|---|---|---|
| Hotels live in prod | 2 (HRCEN, HRDAV); 7 active mailboxes (1 CEN, 5 DV, 1 Nava) | S3 (`docs/research/2026-10-24-multihotel-shape-S3-hotels-users-mix.md`) |
| Unknown mailbox → Centurion | every non-DV transport reads HRCEN | `apps/server-pilot/src/hms/hms-read-target.ts`; S3 |
| Access model | user→mailbox grants only (13 grants, 7 users); no property table, no property grant | S3 |
| Grants live only in prod DB | `seed.ts` has 7 grants (CEN/Nava), prod has 13 incl. 5 DV mailboxes | S3 |
| Centurion-hardcoded code | HRCEN 144 hits / 72 files; Centurion 330 / 90 | A1 (`docs/research/2026-10-23-g1023-retro/A1.md`) |
| Pane room/rate lists | Centurion constants (`room-types.js`, `CENTURION_RATE_PLANS`); DV maps exist but pane omits property | A2, S1 |
| Infor fields known to our tools | quote ~20 request fields + HMS grid; create 10 required + 9 optional; amend 5 writable; cancel read 20; attach 4 | S1 (`docs/research/2026-10-24-multihotel-shape-S1-infor-fields.md`) |
| Create fields absent from mail | source 31%, adults 25%, guarantee 13%, room 10%, rate 7% (n=91) | `docs/plans/2026-10-06-003-case-coverage-gap-audit.md` |
| DV quote result, 30 d | 29/29 refused (100%) | S3 |
| DV extraction coverage | 26% of inbound copies have an action vs CEN 57% | S3 |
| DV duplicate copies | 1,121 inbound copies of the same Message-ID across DV mailboxes | S3 |
| DV rate words in outbound quote bodies (148 msgs) | STO/net 18, contract 17, BAR 16, airline 8, GOV 7, promo 7, wholesale **1**; Standard Queen 0 | S2 (`docs/research/2026-10-24-multihotel-shape-S2-dv-rates.md`) |
| DV answer key | **27 distinct validated BAR B&B facts** (38 PDF rows; Standard King/Suite/Deluxe King; ZAR 2,700–22,813/night, median 4,071). 0 validated non-BAR rows; 10 XLSX mix Contract/NC + STO/net without a row binding | S4 (`docs/research/2026-10-24-multihotel-shape-S4-dv-answer-key.md`) |
| DV quote format | 93% PDF, 7% XLSX; letterheads vary (Da Vinci 88, Legacy 56) | S4 |
| DV answer key covers all 5 DV mailboxes | S4 scanned outbound on davinci@, faith@, ayanda@, epick@, kmgidi@ together; no per-mailbox split yet | S4 brief; per-mailbox split = lane S5 |
| Rate words per mailbox (30 d, 1,458 quote-like outbound, regex) | Faith: STO/net 33, contract 35, BAR 26; davinci@ 551 BAR; "wholesale" written **once** across 6 mailboxes; sender class predicts poorly (GOV 7/10, TA→STO 17/128) | S5 (`docs/research/2026-10-24-multihotel-shape-S5-rate-patterns.md`) |
| Staff asked for wholesale | Faith: "I can't see the wholesale rate" (owner, 2026-10-24) | OWNER-ASKS 219 |
| Reply closes a to-do only in the replier's mailbox | `planThreadWork` trusts an own-domain inbound as the hotel's reply only from an address *that* mailbox has sent from; a reply-all from faith@ landing in davinci@ leaves davinci@'s to-do open | `apps/server-pilot/src/ai/work-items.ts:1230-1240` (code read; not counted in data) |
| Each mailbox copy runs its own prepare | quote-ready keys on the per-copy message row, so 5 copies = 5 HMS reads on one DV browser lock | `apps/server-pilot/src/ai/quote-ready.ts:226-246` (code read); 1,121 DV repeat copies / 30 d (S3) |
| Live-HMS proof time | p50 22 min, p75 85 min (n=43) | ETA ledger |

## Gate G1–G10

| # | Answer |
|---|---|
| G1 properties | HRCEN, HRDAV now; HRBAK/HRKWA likely next (owner, unconfirmed; no design change). Unknown mailbox **refuses** (no Centurion fallback) |
| G2 live canary | Table below; every workflow × hotel on the deployed SHA |
| G3 flags | Each `*_ON` flag reads the registry; readiness check refuses `on` when the property lacks secret, browser slot, quote installation, rate source or required-field map |
| G4 retry cap | 2 failed loops per cell, then DOM diagnosis from screenshot or park |
| G5 ETA | ce-plan: LOC per slice (Luna scope) × code-server median 0.85 + review + deploy + live-hms p50 22 / p75 85 per cell |
| G6 freshness | CANARY PASS line carries the live SHA; flip script refuses older SHA |
| G7 error copy | Cause class shown: not set up for this hotel / HMS down / busy / not found |
| G8 patch vs rewrite | **Rewrite.** A 3rd hotel would add a 3rd branch to ~70 files. Registry + PropertyContext instead |
| G9 done | DV quote: BAR room + board + price match staff on ≥10 of the 27 S4 facts (future-dated stays re-shopped live); every sales strategy HRDAV allows (WS, NC/contract, GOV, AIR, STO) appears with its HMS price on a live shop of 3 future S4 stays, matching HMS's own rate grid; HRFAKE contract test green; CEN quote score not lower on the same rows |
| G10 holds | Real-guest writes, flag flips to `on`, seeding prod grants, onboarding a 3rd hotel's HMS login |

## Patch-vs-rewrite verdict

Rewrite into one **property registry** (rooms, rate plans + strategies, boards, dinner, required Infor fields + option lists, HMS tenant/secret/slot, quote installation, branding, reply copy, eval identity) + **mailbox→property** (unknown refuses) + **property grants** + a `PropertyContext` resolved once and passed through every job and pane call. Pane renders fields/options from the registry. A 3rd hotel = data + live canaries, no code.

## Slices (draft; ce-plan sizes them)

| # | Slice | LOC (est.) | Coder |
|---|---|---:|---|
| 1 | Registry + mailbox→property resolver, unknown refuses | 150–220 | Luna |
| 2 | Keep per-mailbox grants (owner sets who sees what); move the 6 prod-only DV grants into seed so a re-seed can't wipe them; property comes from mailbox | 40–90 | Grok (auth) |
| 3 | HMS target/installation/slot/lock from registry | 250–400 | Grok (HMS) |
| 4 | Pane fields + option lists from registry (quote + create first) | 250–400 | Luna |
| 5 | Prefetch/background jobs carry PropertyContext; one HMS read per (hotel, Message-ID header) reused by every mailbox copy; **to-dos stay per mailbox**; a reply from any mailbox of the same hotel closes the to-do in the others | 80–150 | Luna |
| 6 | Rate source per property: live HMS shop of **every** strategy the hotel allows (BAR, WS, NC/contract, GOV, AIR, STO), all shown with HMS price; no hard-coded rate lists | 150–250 | Grok (HMS) |
| 7 | Party indexes + learned sender history per property | 100–170 | Luna |
| 8 | Branding/PDF/reply copy per property | 120–200 | Luna |
| 9 | Amend/cancel/attach fields from registry | 200–350 | Grok (write paths) |
| 10 | HRFAKE contract test (one fake registry entry: unknown mailbox refuses, no HRCEN constant read) + property-keyed eval | 60–120 | Luna |

Total ≈ 1,400–2,300 product LOC (A1 1,090–1,770 + S1 pane 450–750, overlapping; slices 2 and 10 shrank after owner answers). ce-plan replaces these with Luna scope-lane counts.

**Review loop per PR:** coder (above) → Greptile **Apex** on every PR (owner 2026-10-24; Apex free until 2026-11-21, then 500 credits ever) → a separate Grok 4.6 high lane triages each comment: fix if it hits a staff action or prod path today, otherwise reply with a one-line reason (over-engineering gets pushed back) → Apex again. Grok 4.7 xhigh reviews the plan and write/auth PRs.

**Computer use:** only for DOM discovery on an HRDAV screen we haven't mapped (e.g. strategy selector, required create fields): Codex GPT-6.1 Sol driving Playwright over CDP, one session, under the HMS lock. Shipped tools stay deterministic Playwright.

## Live-test table

| Workflow | HRCEN canary | HRDAV canary | SHA rule |
|---|---|---|---|
| Quote (read) | 1 real recent quote thread, price = staff's | 1 real DV quote thread, rooms = DV list, price = staff's | after last deploy |
| Create (Labtest) | Labtest create + cancel | Labtest create (with reservation note) + cancel | after last deploy |
| Amend (Labtest) | parked; out of scope unless fixed | parked | — |
| Cancel unpaid (Labtest) | Labtest cancel | Labtest cancel | after last deploy |
| Attach (Labtest) | Labtest attach | Labtest attach | after last deploy |
| Unknown mailbox | HRFAKE refuses, no HMS call | — | contract test |

## Owner decisions (round 1, 2026-10-24)

| # | Question | Answer |
|---|---|---|
| 1 | First release scope | Quote + create first (recommended) |
| 2 | Which rates | **All strategies the hotel allows, wholesale included, whatever the corpus shows** — Faith asked for wholesale; rates are revenue, must be complete. Suggesting *which* strategy fits an email = later, from lane S5 patterns |
| 3 | Who sees what | Every ingested mailbox is separate (like Outlook's multiple inboxes); owner grants per mailbox. No property-wide view |
| 4 | Duplicate copies | One to-do **per mailbox** (someone may be off). Dedupe only HMS reads. No claim-on-open |
| 5 | Next hotels | HRBAK/HRKWA likely, unconfirmed; registry stays hotel-agnostic, hotel #3 after DV quote passes |
| 6 | Routing | Luna writes 1,4,5,7,8,10; Grok 4.6 writes 2,3,6,9; Apex on everything; Grok lane triages comments |
| 7 | HRFAKE | Owner sees it as low value; kept as one small test (60–120 LOC), because silent HRCEN fallback is exactly the 10-23 DV failure |

## Open (parallel, not blocking ce-plan)

- ✅ S5 done (see evidence). Next for rate suggestion: per-party strategy history (which strategy staff used last time for this agency), truth from HMS rate codes, ≥100 rows. Was: per-mailbox rate-label split (all 5 DV + Centurion) and when staff pick BAR vs STO vs contract vs GOV vs AIR vs WS (sender class, group size, lead time). Feeds a later "suggest the rate" slice.
