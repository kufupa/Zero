# Assemble representative cases from existing truth

Type: task
Labels: wayfinder:task
Status: resolved
Assignee: /root/evaluation_cases
Blocked by: none
Mode: AFK

**Map:** [Centurion end-to-end reservation agent](../map.md)

## Question

Which existing independent Centurion staff/HMS answer keys and production-shaped email cases can prove extraction, matching, prices and write outcomes without another broad corpus study?

Reuse the 194-row HMS party key and existing booking/quote corpus where applicable. The current 26-row action gold contains no create cases. Include an agency with multiple rooms and a child, missing/ambiguous party, voucher versus payment evidence, a manual rate, Add-On, existing booking, multi-stay email, partial write and cancellation. Preserve source, date, version, independent truth and privacy; distinguish a small smoke set from the owner-requested 100 independent booking extraction examples per hotel and the scoped quote-recall target.

Finish with a usable inventory and genuinely missing truth, not model-generated answers as the gold standard.

**Starting evidence:** [booking evidence and answer keys](../../../docs/research/2026-10-28-booking-wayfinding-evidence-codex-7f2c.md) · [corpus facts](../../../docs/context/FACTS.md) · [product evaluation details](../../../docs/context/PRODUCT-DETAIL.md).

## Answer

Reuse the existing material in the order below. The inventory establishes useful sources and the missing truth; it does **not** establish that these cases pass on current Centurion SaaS.

| Source | What it can support | Limit |
|---|---|---|
| [HMS party read key](../../../docs/research/2026-10-28-booking-wayfinding-evidence-codex-7f2c.md#2026-10-28-follow-up-chosen-slice-and-existing-answer-keys) | 194 attempted reservation reads: 167 found, 26 not found, one failure. The found rows include 107 agency, 115 company and 74 both. | Historical HMS party fields, not a field-complete booking gold; a missing reservation is not necessarily a verified no-agency guest. |
| [Expanded party/history study](../../../docs/research/2026-10-19-party-strategy-decision.md#5c-big-set-score-2026-10-19-1905z) | Reports 253 usable bookings across 104 sender domains after joining 86 usable rows from 194 additional reads. Reuse alongside the original key. | Historical party/history evaluation; not proof that the present picker or cloud UI is correct. |
| [Versioned action-class gold](../../../docs/research/CATALOG.md) | 26 curated rows can check action classification on the same versioned inputs. | The measured version has **zero create rows** and does not score booking fields or prices. |
| [Quote ask/output candidates](../../../docs/research/2026-10-13/r1-quote-gold.md#pairing-and-output-coverage) | 93 heuristically paired asks, including child and multi-stay shapes; 220 unpaired asks may support abstention/visibility checks. | Pair boundaries need review; only 18/93 had a parsed nightly rate, and output PDFs do not supply reliable full rate-plan truth. This is not a measured price-accuracy set. |
| [Booking prefill sample](../../../docs/research/2026-10-20-booking-prefill-backtest.md#method) | 26 messages / 23 threads; 10 purposively sampled, including multiple rooms, missing fields and a voucher-shaped request. | Only one provisional same-thread HMS find and **zero** confirmation-linked truth rows. Do not treat its field comparisons as a reliability score. |
| [Voucher study](../../../docs/context/FACTS.md#1-case-mix-do-not-choose-a-winner-across-unlike-estimates) | 24/35 sampled agent vouchers also requested booking; 0/35 contained actual payment-proof evidence. | These are sampled observations, not proof that a voucher is always unpaid; obtain separately verified paid and unverified examples. |
| [Multi-case linkage](../../../docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md#multiple-guestsdates-in-one-thread) | Nine of 164 studied threads had 2+ linked guest/date cases, with separate confirmation IDs in 9/9. A masked review supported 30/30 selected positive links. | Selected-link precision evidence, not link recall or field correctness; one extra ID remained unexplained. |

### First case matrix

Use **synthetic** inputs for a quick integration/failure smoke check, and independently verified historical staff/HMS cases for accuracy. The following are required case shapes, not claims that an existing complete gold row already covers each:

1. Agency request with two rooms, a child and a hotel-native Add-On; show distinct occupants/age, native agency, live eligible rate and the correct per-stay Add-On readback. The old quote set has three child-shaped and two multi-stay candidates, but it does not establish a single complete case combining these features.
2. Missing, duplicate or ambiguous agency/company, and a private guest with no business party: staff must see uncertainty instead of an invented or wrong bind. Obtain verified no-party and ambiguity negatives; an HMS reservation not found is not that truth.
3. Agent voucher plus new booking; separate actual verified payment proof, a claimed payment without proof, and attachment versus payment posting. Preserve unknown where staff/HMS evidence does not establish settlement.
4. Staff-selected manual price versus the live rate, and a native Add-On with dates/quantity/charge. Compare the actual stored values to independently captured staff/HMS truth; quoted extras or notes alone do not prove a native Add-On.
5. Existing confirmation and pre-stay self-mail; one email/thread containing several genuinely different stays; distinct guests/dates and matching ambiguity. Link each case to the correct reservation rather than forcing one email to one stay.
6. Inject a save success followed by Add-On failure, an uncertain save, and a cancellation/penalty case. Check the correct reservation, each independently read-back outcome and reconciliation before retry. Use approved Labtest for HMS writes; the synthetic failure check alone cannot establish hotel behavior.

Existing candidate test files include [multi-stay booking drafts](../../../apps/server-pilot/tests/booking-draft-multistay.test.ts), [stay save](../../../apps/server-pilot/tests/pane-stay-save.test.ts), [cancellation](../../../apps/server-pilot/tests/pane-stay-cancel.test.ts), [payment-proof matching](../../../apps/server-pilot/tests/aop-payment-proof-match.test.ts) and [added rooms](../../../apps/server-pilot/tooling/playwright-quote/add-room-stay.test.mjs). Their presence is not evidence that the complete cases above pass; no tests ran in this inventory.

### How to make the evidence usable

- Privately record the property, case ID, versioned original email input at the decision time, staff action and independently sourced HMS state/readback. Keep guest identifiers and raw mail out of the map and public issue bodies. A reviewer resolves collisions; unresolved or absent evidence is **unknown**, not a negative.
- Split repeated messages/threads together, freeze rows and compare the baseline and candidate on the same version. Review whether the mailbox ingest and observation window captured the relevant replies; neither unpaired mail nor a recent follow-up window proves a negative outcome.
- Review an initial 10–20 examples to measure labeling throughput and expose gaps. The prior owner request was **at least 100 independent staff-created booking examples per hotel**; it is not met by a synthetic smoke case or the old action gold. For the 2026-10-20 plan, the owner accepted **at least 85% quote recall on at least 100 independent outbound-grounded rows**; this is scoped to that plan, not an automatically universal bar. The separate ≥10 plannable-thread quote-price bar in product details is a proposal pending owner confirmation. [Owner-scoped booking target](../../../docs/plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md#shape-gates) · [Evaluation details](../../../docs/context/PRODUCT-DETAIL.md#done-this-is-the-overnight-gate).
