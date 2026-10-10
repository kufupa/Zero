# Retro: overnight v8 (2026-10-08 23:45 → 2026-10-09 07:08 UTC)

Evidence: GitHub PR timestamps (#58–#94, UTC), the run ledger (`docs/context/ledger/2026-10-08-overnight.md`; rows before ~01:59 UTC were estimates), live EC2 checks. Plan: `docs/plans/2026-10-08-007-feat-overnight-v8-nava-pane-plan.md`.

## TL;DR
- **Output:** 37 PRs opened, 36 merged, 1 closed. 6 production deploys (D1–D6), every one READY with VPN OK, 0 rollbacks. Add-in 1.0.17 published.
- **Coding was fast. Proving it was slow.** Feature PRs usually merged 10–70 min after they opened. Anything that touched live HMS or the real browser took 2–5 h longer than planned.
- **Live probing found 6 bugs unit tests could not:** Guest Stay nav (create, then party), the party dialog input and Run button, gate onboarding, a signature image blocking quotes, and the exact-name party match. 9 of the 36 merged PRs were unplanned fixes found live.
- **Biggest win:** company contract rates work end to end. Woolworths quotes NCOR2B R1,360 against BAR R1,940, the same R1,360 staff charged on 2026-08-26.
- **Biggest miss:** the contract-rate cause was misattributed twice (50-row cap, ZAR conversion) before the data showed the name match. About 1 h lost. The "check data first" rule was not applied to our own hypotheses.

## Planned vs actual (units)
| Unit | Plan done | Actual | Δ | Notes |
|---|---|---|---|---|
| U1 context + plan | 00:05 | 00:13 (#58) | +8m | CLAUDE.md imports ACTIVE.md |
| U9 add-in 1.0.17 | 02:30 | 00:18 published, pin #59 00:25 | **−2h** | Blank title strip, SHA-verified |
| U5 PDF route check | 00:40 | 00:20 | −20m | Gotenberg Chromium 200 |
| U2 extract NavaPane | 00:30 | 01:16 (#65) | +46m | Mechanical, 478 tests |
| U8-C separate allowances | 01:30 | 01:32 (#60) | ≈ | 2 P1 rounds (notes lost, invalid input kept old charge) |
| U10 create modes + party + note | 02:00 code | 01:10 (#62); live 03:14 | code −50m; proof −2h | Live: Labtest saved with agency, org, 10% commission |
| U17 cancel modes (stretch) | 05:40 | 01:32 (#70) + #74 tests | −4h | Charge dialogs never clicked |
| U12 Open HMS + copy | 04:00 | 01:19 (#64), 01:46 (#71) | −2.5h | Deep link probe 03:15: records not linkable |
| U15 deploy papercuts | 04:00 | 01:19 (#67) | −2.5h | Deploys exit green from D1 on |
| U11 HITL ledger | 03:00 | 02:10 (#63), PR3 02:53 (#78) | −50m | Flag off, migration 0046 applied D2a |
| U13 Excel | 03:00 | 02:10 (#66), wired 04:36 (#82) | wiring +1h | Exact staff template |
| U4 viewer + gate | 02:10 | merged 02:16 (#75); gate **PASS 04:50** | +2h40 proof | Failed 20/20 first (onboarding, husky) → #86, #88 |
| U14 voucher find (stretch) | 05:30 | 03:23 (#73) | −2h | 3 P1 rounds on the parser |
| U3 auto-reload | 01:10 | 03:15 (#69) | +2h05 | 4 P1 rounds → safe-boundary policy (#76) |
| U8-A/B/D copy + look | 03:40 | 04:09 (#76) | +29m | Rebased 3 times |
| U6 party picker | 01:50 | merged 04:09 (#61); **live PASS 04:35** | +2h45 | 3 live bugs: #87 nav, #89 dialog input, Run by text |
| U7 contract rates | 02:40 | merged 05:19 (#79); **live PASS 07:04 (#93)** | **+4h20** | 4 Greptile rounds, then the name-match root cause |
| U16 quote proofs + speed flag | 03:45 | 06:25 partial | +2h40 | Server path proven. Pane PDF/Excel not run. Speed flag not flipped |

Deploys: planned 3 (01:40, 04:00, 06:00). Actual 6: D1 01:58, D2a 02:25 (+migration), D2b ~02:58, D2c 04:14, D3 04:50, D4 05:24, D5 06:15, D6 07:04.

## Unplanned work (found live)
| PR | What | How it was found |
|---|---|---|
| #83 | Main CI red: an unclassified tRPC procedure | Autofix failing on every PR |
| #85 | Every EC2 create failed (Guest Stay click dropped) | Live Labtest create |
| #86 | Gate install died silently (husky EACCES) | Live gate run |
| #87 | Party lookup failed on the same nav bug | Live party lookup |
| #88 | Viewer stuck on first-run onboarding, app-shell reads blocked | Live gate 20/20 timeout |
| #89 | Party query typed into the saved-search combo; Run had no ARIA role | Live screenshots |
| #90 | Signature image `image001.jpg` blocked the quote (P0) | Live gate on real booking mail |
| #91 | Live quote harness | Needed for V3 proof |
| #93 | Contract rows rejected by an exact-name match | Live quote + run evidence |

## Verification outcome
| Gate | Result |
|---|---|
| V1 viewer, real emails | PASS: 20/20 analysed, 0 blocked writes. Booking request pre-filled 13 fields |
| V2 party | PASS: 360 → agency #113, Woolworths → org #49, Tourvest → org #206 |
| V3 quotes | PASS (server path): baseline BARRO R1,750; 360 → BAR + honest copy; Woolworths → NCOR2B R1,360. Pane PDF/Excel not run |
| V4 create | PASS (runner level): Labtest 48315098-1 with agency, org, commission; cancelled. Not via the pane route |
| V5 add-in | PASS: 1.0.17 served, SHA `0d25d56a…4bbc` |
| V6 prod | PASS on all 6 deploys |
| V7 her first use | Today, on the call |

## What went well
- **Parallel Haiku lanes (A, B, C, D, G) at effort max** shipped 36 PRs. Haiku implemented everything; Opus drove HMS, deploys and the critical diffs.
- **Two reviewers beat one.** The Haiku checklist reviewer caught 2 P0s in #61 that Greptile missed. Greptile caught about 20 P1s across PRs.
- **The real-browser gate earned its keep.** It caught the onboarding block and the signature-image P0 before staff did.
- **The live-check pack (#80, #91)** turned HMS proofs into one-line commands.
- **Data-first, when it was used,** settled things fast. Rate-shop vs staff-run evidence, the corpus check (Woolworths R1,360 on 2026-08-26) and the dialog screenshots each ended a debate in minutes.

## What went badly
| Issue | Cost | Rule |
|---|---|---|
| Contract-rate cause guessed twice (row cap, ZAR) before checking run evidence | ~1h | Read the run's own evidence (options, appliedContext) before theorising |
| HMS runners shipped on unit tests alone | 3 fix PRs, ~1.5h | Live-probe every runner on EC2 before merge |
| Stacked PRs: merging #72 landed in #69's branch, plus many rebase rounds | ~30m | Stack only when unavoidable. Retarget to main before merging |
| Greptile comments stayed on old heads | Confusion about which P1s were open | Compare the review commit with the fix commit |
| SSM quoting, payload size and the `rm` safety check | ~30m of Opus time | Ship scripts via base64 file or S3. Never `rm -rf` in SSM |
| One `--no-verify` commit | Rule break | Never |
| Ledger times estimated early | Unreliable early timeline | Stamp with `date -u` |

## Estimation lessons
- Pure-code units came in on time or early (−20m to −4h), usually because the plan was conservative.
- Units that needed live HMS or a real browser ran +2 to +4.5h over, due to review rounds, live bugs and deploy cycles.
- **Rule for next plans:** budget 1× for code and 2–3× for HMS or browser proof. Schedule live proofs early, not at the end.

## Highest-ROI to-dos (ranked)
| # | To-do | ROI | Effort |
|---|---|---|---|
| 1 | **Party auto-bind:** when Nava reads "Woolworths", match it against the party index and show a one-click "Use Woolworths Holdings (#49)" chip | Very high: a party is named on 70–80% of quote/booking mail and contract rates depend on the pick | ~45m code + live check |
| 2 | **Party index sweep** (instant typeahead, and the option list for constrained Nava matching) | High: search goes from ~1 min to instant | ~1 h of HMS time (~52 lookups), no code |
| 3 | **Pane quote → PDF → Excel live proof** (viewer act mode), then decide on `QUOTE_TRACE_ASYNC` | High: protects the core flow | ~30m |
| 4 | **Create through the pane:** flag `lab` → Labtest Preview→Book via the viewer → confirm the note → `on` | High once the owner OKs real bookings | ~30m + owner decision |
| 5 | `HITL_LEDGER=on` | High compounding value: every click becomes eval data | 5m (owner flag) |
| 6 | Booking-card dropdowns with HMS values (track, source, guarantee, rate plan) | Medium-high: no trips into HMS | ~30–45m |
| 7 | Voucher analysis speed (>90s on voucher PDFs) | Medium | Investigate ~30m |
| 8 | Nava constrained party choice (LLM picks from the index's top-k ids) | High after #2 | ~1h |
| 9 | Amend writes (date or room change) | High but large | Days |
| 10 | POP → Documents upload | Ask her first | — |
| 11 | Mail routing for the 5 new mailboxes | Needs hotel IT | — |
</content>
</invoke>
