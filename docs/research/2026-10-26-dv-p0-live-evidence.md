# DV (HRDAV) background quote P0: live evidence, 2026-10-26 overnight run 2

| Time (UTC) | Mail | Build | Jobs | Outcome |
|---|---|---|---|---|
| 02:5x–03:18 | bca90631 (dinner B&B, 1 room) | ccb3d48 | 9 | 5 PRECONDITION (conditional contract rates), AIR no rate, 3 dead_letter TRANSIENT (1-attempt cap) |
| 03:07–03:18 | 0b7b3628 (B&B, 1 adult, 2 stays) | ccb3d48 | 18 | BAR 2/2 dead_letter (a 20 s startdate wait), 5 PRECONDITION, 8 queue_expired |
| 03:2x–03:33 | 2c7de863 (B&B, 3 rooms) | ccb3d48 | 8 | No BAR job (idempotency: a BAR run from 10-24 existed); 6 PRECONDITION, 2 queue_expired |
| 05:56–06:06 | d3e81b90 (B&B, 1 room, 3–5 Jan 2027) | 09bce5a | 9 | **BAR run 06:02 = outcome quote, requiredFacts complete, 9 verified BAR B&B rows** (STKNG R5,956.50/night, JNRSUI R7,166.50); interrupted by the 06:04 deploy restart; retry 06:03:49 DETAIL_READ_FAILED → recorded PRECONDITION. 7 queue_expired. |

## Conclusions
- The HMS read on HRDAV works and prices BAR B&B correctly (tool outcome `quote`). The P0 "0 of 3 DV mails prepared" is now three separate causes, all fixed or in flight:
  1. 1-attempt transient cap → DS1-P2b #574 (deployed 05:55Z).
  2. 10-min queue TTL drops prepared jobs → DS1-P2c (new unit).
  3. Retry after interruption re-reads details only and can fail. Watch on the next canary.
- Non-BAR strategies return `conditional` eligibility on mail with no company/agency → PRECONDITION is correct behaviour, not a bug.
- Staff-sender mail (e.g. bc6a321e today 04:07) is correctly skipped.
- Not yet proven: a priced prepared quote stored end-to-end (job ok=true). Needs one clean canary after DS1-P2c deploys and with no deploy mid-run.

## 07:08Z — root cause #4: empty HRDAV corpus file (FIXED live)
- Canary 03580008 BAR: attempt 07:00 returned outcome=partial (refused, correct). Retry 07:02:18 returned **outcome=quote, audit complete**, but the job still failed with `staff_quote_private_file_invalid`, logged as TRANSIENT_NETWORK "staff quote execution failed".
- Cause: `staff-quote-installation.ts` `checkedPrivateFile` rejects size<1. The DS1-P0 install (`/tmp/or2/dv-install.sh`) wrote `.private/hrdav-corpus/messages.jsonl` as an EMPTY file. The rate-policy read loads every corpusPath before its documents (`documents: []`), so every HRDAV quote that HMS priced was then thrown away.
- This also accounts for some earlier "transient" DV failures logged as `private_file_invalid`.
- Fix: corpus file is now 1 byte ("\n", 0600 ubuntu, not a link); the parser skips blank lines. dv-install.sh is patched. No code or env change, no restart needed (the file is read per job).
- Follow-up (code, T2): the policy read should treat a missing or empty corpus as "no documents", and the failure class should not be TRANSIENT_NETWORK; that class hides config errors. Logged for retro.

## 07:12Z — blocker #5: HRDAV has no VAT/levy source document
- After the corpus fix, BAR got further and was refused PRECONDITION_FAILED business_quote_policy_unavailable ("Verify VAT and tourism levy inclusion…").
- The selected-rate policy resolver needs ≥1 usable source doc (hotel_rate_terms letter or family invoice). All 5 HRDAV policies have `documents: []`. HRCEN's 9 docs were hand-installed in Oct; no builder exists. HRDAV_CONFIRMATION in reservationist-rate-policy-source.ts is a placeholder.
- Action: new T1 unit **DS1-P0b** (reusable install-rate-terms-policy script, Grok 4.6). Coordinator runs dry-run/apply live, then re-canaries.
- Until then every DV prepared quote ends terminal ok=false with a clear staff message (fail-closed, correct behaviour). No price is ever invented.

## 07:28Z — canary 03580008 final (ebafe78, 9 strategies, train paused)
- 9/9 terminal, **0 queue_expired, 0 dead_letter**: DS1-P2b (retry) + DS1-P2c (TTL exemption) proven live. Total wall time 06:28→07:27 under staff-hours prefill priority.
- BAR + DOML: HMS priced, refused business_quote_policy_unavailable (no VAT/levy source doc) → DS1-P0b.
- PROMO, PRESET, WS, NC, Government, AIR, OTHER: refused "HMS couldn't price this exact combination" (partial capture for 3 rooms B&B Feb 2027), the correct fail-closed result.
- P0 bar (≥1 succeeded ok=true with price) NOT met yet. Next proof: after the DS1-P0b apply, re-canary a fresh DV mail.

## 07:58Z — blocker #6: HRDAV letter-identity placeholder was wrong
- DS1-P0b deployed (49b0686). The prod dry-run exited 3 rate_terms_letter_not_found: the top 3 HRDAV outbound letters score 3/5 (exact VAT + levy clauses, but neither hotel nor confirmation matched).
- A redacted probe (hotel-name word only) shows the live wording: letterhead "Davinci Hotel & Suites"; body "We have pleasure in confirming your reservation at The Davinci Hotel and Suites, Sandton". The placeholder was "Da Vinci Hotel and Suites".
- Fix: coordinator hotfix PR DS1-P0c (2 regexes, tolerant spelling, case-insensitive; test proves the live text scores 5 and Centurion stays <5). Train paused since 07:51; after merge → deploy → P0b apply → DV canary.

## 08:03Z — DS1-P0b applied (4b1fd41 incl. DS1-P0c)
- Dry-run then --apply for HRDAV across transport-davinci, faith, ayanda, epick, kmgidi: scanned 34 outbound PDFs, matched 5, installed 5, skipped 0. sourceHash afb8b403…, corpus 74c22f17…. Atomic writes with .bak; no restart needed.
- Canary 3 enqueued on d3bc91f5 (1 room, 2 adults, B&B, 2026-11-01→03, no party): queued 8. Train paused.

## 08:10Z — canary 3 lost to an HMS connection blip; idempotency blocks re-run
- d3bc91f5: all 8 jobs dead-lettered 08:02–08:03 with ERR_CONNECTION_REFUSED from HMS (HRCEN jobs failed in the same window; VPN up). A fresh HRDAV Labtest read at 08:09 returned outcome ok, so HMS is back.
- No BAR job was enqueued for d3bc91f5 because a BAR run from 10-23 already held its idempotency key. Re-enqueue returns queued 0: keys ignore job age and dead-letter state (logged for retro / T2).
- 1f092c51 was read as system_notice with no input → queued 0 (correct skip).
- Canary 4 enqueued 08:12Z on 550ddf56 (kmgidi, B&B, 0 prior jobs): queued 9. Train paused.
