Review only. I'll read the proposal, its evidence, and the product spec, then attack the claims.**Verdict:** Letter census and inference got sold as a router. Do not merge quote into HMS create, and do not build the memory A/B now.

Read `PRODUCT.md`, [PROPOSAL-draft.md](docs/research/2026-10-20-arch-lanes/PROPOSAL-draft.md), [README.md](docs/research/2026-10-20-arch-lanes/README.md), l0–l6, exa-ultra. `origin/main` `3e1acb694`.

## 1. Evidence does not carry these claims

- **E1 / “letter = the quote”.** 1,114/1,174 deposit 0 and 1,163/1,174 provisional are a letter-file census (`l2` Answer, Base table). Letters exist only after a booking exists. 7/1,174 show a positive deposit; 53/1,174 deposit unparsed. L0 already says this is not proof every quote should create a booking (`l0` Answer). 15/200 sampled letters had no proforma table (`l0` §2).
- **E2 denominator swap.** 39/103 is reply-anchored core asks, 39/189 of core asks (`l1` Linked outputs). 30/30 precision is a +3d accepted-link sample (30/57), recall unchecked (`l1` Manual review; `README` C6). Prod-SQL 53/92 and lifecycle 54/642 are other cohorts (`README` C6; `l0` §2). “Usual next artefact” is 38% of anchored asks.
- **E4 “edit in place”.** 14/74 same number, 0/74 new, **60/74 no letter** (`l2` Follow-up table). New-number search needs an end-client name hit. 108/223 amend events are own-domain. L2 marks this as not an HMS-write proof.
- **E6 “always own confirmation”.** 9/9 is threads that already had 2+ linked letter cases, 9/164 threads (`l1` Multiple guests). 17/164 had 2+ asks. One thread had 10 conf IDs for 9 guest/date pairs.
- **E7 domain mix uses letter recipients, not asks.** Gmail 34/108 and Atlantis 5/37 are letters (`l1` domain table). Atlantis core asks are 1/189. Small-agency “7/7” is one observation per letter (`l1` Open gaps).
- **E8 rate-plan claim.** 367/1,130 is the modal ADR+board pair among parsed letters (`l3` Board table). Parsed board is B&B 750/1,160 vs DBB 410/1,160. Government 19/22 is 7 asks weighted to 22 PDFs. Rate-plan label is 0/1,179 letters (`l3` Answer). `README` C3 calling this “the highest-volume rate” overreaches.
- **E9.** 6/12 Queen vs 5/12 Twin is extractor `roomType` on linked PDFs, not asks. Literal “single” is 2/43 asks (`l3` Ask wording).
- **E11 bar is noise.** Useful@3 = 6/20, one rater, seed 20261020; partly useful 13/20 (`l6` Manual review). +10 pt on 20 items is +2 items. Held-out first replies are text-only 301/411; same-thread HRCEN is 1/411 (`l6` Answer type). `README` still says recall@5; proposal §5 switches the metric.
- **E3 recount** (1,001/1,174) lives only as an Opus note (`README` C1). No lane appendix. Usable as a hypothesis, not as party-truth sign-off.
- **Quote-PDF path is real and unpublished as a cross-tab.** Hand Quote PDF 14/103 at ±30 min (`l1`). Lead 31+ days: HRCEN 2/14, Quote PDF 3/14. Rooms 10+: HRCEN 1/9, Quote PDF 2/9. L1 says overlap exists and is not a decision rule.

## 2. Riskiest choice, cheapest falsifier

**Riskiest:** `want=stay & state=none → STAY`, with provisional HMS create as a normal end state (`PROPOSAL` §3 step 4).

- Cancel is lab-only (`PRODUCT.md` Workflows). A bad create has no prod undo.
- CRS Check Availability creates a reservation; Guest Stay check only holds a rate (`l4` Availability semantics). Proposal never names which read.
- L0 says the letter is auto-mailed after save. L4 says send-on-save is unproven (`l4` Open gaps). If L0 is right, “quote” emails the guest. Nava-never-sends does not cover an HMS send.

**Falsifier (no build):** on the 88 complete core asks (`l1` +3d feature table), label end state quote-PDF-only / letter-only / both / neither, split by the existing lead-time rows. A large quote-PDF-only share at 7+ days falsifies one create-shaped flow. Cheaper still: one reservationist answers “rate-only request → do you save an Infor reservation?”

## 3. Keep quote and new booking separate

- `PRODUCT.md` Workflows: finish Quote, then Create. Asks logged 2026-10-20: quote end-to-end is the goal; architecture rewrite is not approved.
- Price does not need Save. Safe reads are Room Availability + Display Rates (`l0` §4, `l4`).
- Quote contact is a PDF field and must not write HMS (`PRODUCT.md` Pane). Create is Prepare → Queue → Act → Review.
- Da Vinci: proforma follows acceptance; groups use Excel (`l5` 11:16 and 24:09). Interview does not show every quote becoming a reservation (`l5` What this means).
- Letter-conditioned samples cannot see quotes that stayed quotes (`l2` Answer: “not a request-to-booking funnel”).
- Same prefill can feed two buttons. The “quote contact on a new booking” bug is a label/UI bug. It does not require one state machine.

## 4. want × HMS-state breaks

- **Unknown.** Mail payment is unknown 125/223 (`l2`). Proposal routes `paid|unknown` to AMEND-PAID (`PROPOSAL` §3). Open Q2 admits the Infor field is unknown. L4 drops billing/deposit from pane stay results (`l4` findStay DROPPED). A failed read becomes a money review forever, or a second booking if coded as `none`.
- **Link wrong.** Proposal finder “letter to same address ±30m” is weaker than the L1 score≥7 linker whose precision was checked (`PROPOSAL` §3 vs `l1` Method). Recall unmeasured. Guest+dates search can hit another stay. Unacceptable error is a different guest’s booking (`PRODUCT.md` pass bars).
- **Missing rows.** No route for change+no link (149/223 amend events not comparable, `l2`), stay+already provisional, stay+paid, or both cues (56 thread events, `l2`).
- **Multi-ask.** 17/164 threads have 2+ quote/booking asks (`l1`). One thread, one HMS lock (`PRODUCT.md`). No priority when one mail is voucher + amend, or guest A quote + guest B cancel.
- **Collapsed states.** Enum merges paid and guaranteed (`PROPOSAL` §3). L2 and L0 say voucher, guarantee, POP, and posted money stay separate.
- **Door misses.** Pre-stay self-mail must never create (`PRODUCT.md` Front door). Travelit is 40/189 core asks, 0 letters, 0 outbound (`l1`), and 154/181 voucher threads (`l2`). L0 TMC note: notices can describe stays already booked. `state=none` sends those into STAY.

## 5. Slice list

| Slice | Call |
|---|---|
| S4 rate grid + S5 unforced party on **current quote flow** | Ship first |
| S2 deposit/guarantee probe | Blocking fact for amend only |
| S1 multi-ask schema | Later. 147/164 core threads are one ask |
| S3 router replacement | Cut from first release |
| S6 letter-as-party-truth | Cut. Suggestion only after recall exists |
| S7 memory harness | Cut now |
| New `stay_case` / `fact` model (`PROPOSAL` §4) | Cut until the two-button flow is scored |

- S4 and S5 are not disjoint: both sit in the quote pane (`l4` Current pane order). `PRODUCT.md` WIP = 1.
- S4’s helper has no board and no company/agency (`l4` All-room helper). A grid before party pick cannot show contract or government rows. Proposal step 3 promises those plans anyway.
- Missing: golden quote bar (rate plan + price = staff sent, `PRODUCT.md` Done); group/Excel (≥12, owner ask; 10+ rooms already a different artifact mix); fully-booked one-line decline; Excel as first-class (`PRODUCT.md` Asks 2026-10-20).
- Party suggestions already have a better source than S6: agency history 109/150 right, 0/150 wrong (`l0` §5). Quote-pick vs booking-history precedence is still an open conflict in that same section.

**Staff-first:** current quote pane, all-room prices before room pick, Queen and Twin both visible, party as ranked suggestions, explicit “Make quote PDF/Excel” vs “Create provisional” buttons. No new router.

## 6. Memory A/B — not now

- L6’s own close: baseline is not enough to choose a framework (`l6` Open gaps).
- Fact-recall labels are missing in the reply corpus: board cue 32/411, government word 0/411 (`l6` Answer features). Same-thread pairing misses the letter.
- Exa: no 2026 controlled email/ticket study shows graph memory beating BM25+vector (`exa-ultra` §3). Hindsight 1.0.0 is 2026-10-13, extra extraction pass, tenant auth is app work (`exa-ultra` U1, cost note).
- Pane value unproven: 6/20 directly useful, 13/20 vague overlap. Advisory mail in a >30s pane (`PRODUCT.md` Who it is for).
- Moves no golden-set bar. Defer until quote price and party bind pass.

## 7. Lanes missed

- Unpublished Quote-PDF × HRCEN cross-tab, by lead time.
- No HMS read of deposit/guarantee on the 74 linked amend confs, while the router forbids mail as payment truth.
- Reversibility: lab-only cancel × create-on-quote.
- One browser lock vs prefetch + find + state read + multi-card.
- Three people: quote contact, guest, bill-to. Company and agency are different HMS fields (`l4` Company versus agency). Proposal step 1 has “contact + bill-to”.
- Attachment parity. Prior rule: 74% of gold inbound carry attachments; these lanes are body + letter PDF.
- Group Excel path and fully-booked decline.
- H-Pay / hospitality.cloud door rule (`PRODUCT.md` Asks 2026-10-14) absent from lane OTA lists.
- Multi-hotel: L5 says do not copy Da Vinci rules; proposal has no property playbook boundary.
- No minutes-saved or wrong-booking cost. ROI is unmeasured.
- Classifier error rate on the complained-about bug is unmeasured. S3 replaces it with no new pass bar.

## Top 3 changes

1. **Two terminal buttons, one prefill.** Quote PDF/Excel stays the default end state. HMS create stays a separate approved write. Falsify the merge with the lead-time cross-tab before any router work.
2. **Ship S4+S5 on the live quote flow only.** Both bed types, no silent pick, ranked party from existing history, no forced company. Cut S3, S6-as-truth, S7, and the new case/fact model from this release.
3. **Unknown and unlinked are their own screen.** Show candidates. Do not fold them into AMEND-PAID or STAY. Labtest must show where deposit/guarantee live before any payment branch.
