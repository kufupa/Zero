# Leak-free triage eval and rules v2–v4 (2026-10-19 overnight)

Plan: [2026-10-19-overnight-triage-dspy.md](../plans/2026-10-19-overnight-triage-dspy.md). Data, prompts, predictions and disagreement files are on the coding VPS at `/home/orca/nava-research/triage-20261019/` (PII; never in git).

## Answer

The action classifier now reads **prior thread mail only** (#369), and its rules were rewritten from a frozen eval (#370 = v2, deployed 04:09Z; #371 = v4, deployed ~05:08Z, prod `357315940`, extractor `extract-3ccdd9c9966e`). On the same 431 frozen test rows with leak-free prod input, **accuracy goes from 81.0–83.3% (prod rules, run ×2) to 90.3% (v4), and macro-F1 from 78.5–81.1 to 88.6.** Parse failures: 0.

## 1. Data and labels

| Item | Value |
|---|---|
| Window | Centurion inbound 2026-09-09 10:00Z → 2026-10-16 14:00Z (4,985 inbound / 1,198 outbound in window; 701 inbound on automated-channel threads excluded) |
| Sample | 1,694 inbound: every row with a non-no_action prod/agent/model label, an inbound document or a staff reply document (1,394), plus 300 natural rows; ≤3 per thread |
| Inference input | Prod `loadSyncedQuoteSelectionFromMailbox` (attachment text via prod `readQuoteAttachments`) → prod `buildInboundPrompt`, thread context **strictly before** the target and not replying to it. Luna, reasoning `max`, prod system prompt + schema; only `ACTION_CLASSIFICATION_RULES` varies |
| Parity gap | Vision images are not in the eval (prod sends PNG/JPEG/scanned PDF pages). Text-only |
| Leak size | 812 / 1,694 sampled rows (48%) had later thread messages in the old prod prompt |
| Silver labels | Staff-outbound rules first (HRCEN confirmation letter → new_booking/amend, quote file → quote, POP file → payment_proof), else Luna (high) and Sol 6.1 (high) agree, each seeing prior thread + target + attachment text + staff replies ≤7 days. 1,514 silver; 180 disagreements (10.6%) set aside |
| Owner gold | 8 owner labels overlap: 6 agree with silver; the 2 disagreements are overridden with the owner label |
| Split | Stratified by label, then made thread-disjoint: val/train rows sharing a thread with a test row (or train rows sharing one with val) were dropped, 157 of 1,514. Result: test 431, val 186, train 740. Prompts were tuned on val/train errors only |

## 2. Scores (frozen test n=431)

| Rules | Acc | Macro-F1 | quote P/R | new_booking P/R | amend P/R | cancel P/R (n=6) | payment_proof P/R |
|---|---|---|---|---|---|---|---|
| prod, leak-free, run 1 | 81.0 | 78.5 | 77.4/92.3 | 87.5/69.0 | 81.8/75.0 | 75.0/100 | 100/82.8 |
| prod, leak-free, run 2 | 83.3 | 81.1 | 85.7/92.3 | 89.1/69.0 | 85.7/75.0 | 75.0/100 | 100/93.1 |
| v2 generic (#370, live 04:09–05:08Z) | 87.0 | 82.6 | 81.5/84.6 | 86.1/95.8 | 83.3/83.3 | 75.0/100 | 100/86.2 |
| v3 (round 3) | 88.6 | 84.0 | 88.5/88.5 | 87.2/95.8 | 83.3/83.3 | 85.7/100 | 96.2/86.2 |
| **v4 (round 4, #371, live since ~05:08Z)** | **90.3** | **88.6** | 88.5/88.5 | 85.9/94.4 | 95.2/83.3 | 100/100 | 100/93.1 |

Val (n=186) macro-F1: prod 81.0/81.9 → v2 93.1 → v3 94.6 → v4 95.8 (rerun 96.0).

**Against the bar** (≥90% precision on money classes; quote and new_booking recall ≥95%): met for amend, cancel and payment_proof precision. Not met: quote P 88.5 / R 88.5 (n=26), new_booking P 85.9 / R 94.4. Small-n classes swing ±4 points per row.

## 3. What moved the score (rule changes)

| Round | Change | Main effect |
|---|---|---|
| v1 | Prior-only wording; explicit class boundaries; >12 guests = group_event; quote-feedback rules | billing P 77→92 |
| v2 | System-generated mail is classed by what it carries (agent/TMC voucher → new_booking, extension → amend, VCC → billing, bank paid-in notice → payment_proof); internal staff mail with no outside request = no_action | new_booking R 69→94, no_action P 85→94 |
| v3 | Booking request that also asks the rate stays new_booking; TMC/platform cancellation **notification** = no_action (owner policy 2026-10-14), a person asking = cancel; extra night / early check-in = amend; inventory-update / review-site / integration-error notices = no_action | quote P 81→88, cancel P 75→86 |
| v4 | Changes to an existing group booking stay group_event; amend = individual bookings; POP + invoice ask = payment_proof; "payment was made" with no proof = billing | amend P 83→95, payment_proof R 86→93 |
| dropped | Internal mail asking a colleague for concrete work classed by that work; job applications = no_action | val −7/+5 rows |

DSPy (MIPROv2/GEPA) was not run: the plan's "measure first" rule applied. Hand-written rule rounds from error reading gained 2–4 points per round, and each round was 6 min. DSPy is installed in the run venv if a later plateau needs it.

## 4. Da Vinci transfer (report only, small n, no Da Vinci tuning)

| Mailbox | Silver rows | prod rules acc | v2 acc | v4 acc |
|---|---|---|---|---|
| transport-ayanda | 50 | 80.0 | 94.0 | 94.0 |
| transport-faith | 56 | 67.9 | 87.5 | 91.1 |

Few money-class rows (ayanda: none; faith: 2 new_booking, 7 amend, 1 payment_proof), so this is directional only.

## 5. Findings for the owner

1. **Automated booking notices still hit Not for Nava.** On test, 31 rows v2 now classes correctly as actionable carry `origin=system_notice`; `mapWorkflowFolder` sends every `system_notice` to not-for-nava before reading the action (`workflow-folders.ts:269`, encoded by `tests/workflow-folders.test.ts:180`). This isn't a regression (they went there before too). Routing them into action folders changes the "skip automated at the door" policy, so it needs an owner decision.
2. **Azure content filter blocks some mail.** 2 of 740 train rows and 1 faith row return "response was filtered" for Luna. Prod sees the same filter as an extraction failure.
3. **Silver disagreements** (`disagreements-transport-*.jsonl`): Centurion 180 (top pairs Luna billing vs Sol no_action 35; new_booking vs billing 19; group_event vs no_action 15), ayanda 7, faith 8. Need an owner pass to become gold.
4. **Label edge cases worth a ruling:** H-Pay payment-processed notices (silver no_action; door policy keeps non-notice H-Pay finance mail), internal handovers listing guest follow-ups, "did you receive my booking?" verification mail.

## 6. Prod changes in this run

| Change | State |
|---|---|
| `INBOUND_TRIAGE_CLASSIFIER=off`, `PANE_PRECLASSIFY` unset | http/worker/ai-worker, checked in `/proc/<pid>/environ`; remote-http never had either. Backup `.env.production.bak-20261019-triage-flip` |
| `hms-slot@hrcen` systemd unit (CDP 19223) | enabled + active; env `/etc/nava/hms-slot-hrcen.env`. First swap lacked `PLAYWRIGHT_BROWSERS_PATH` → crash loop, HMS reads down 04:15:23–04:17:19Z, 0 runs in flight; fixed and re-swapped, ready 04:17:45Z; party read succeeded 04:29Z |
| Live check after deploy 1 | 4 new-version extractions on post-deploy mail, 0 failures. Post-flip `inbound_triage` runs were channel mail only (expected). One staff_quote `read_tool` dead letter `TRANSIENT_NETWORK`, same as the pre-existing pattern (5 in 24 h vs 154 succeeded) |

## 7. Reproduce

`apps/server-pilot/scripts/triage-dataset/export.ts` (EC2, read-only) → `build-prompts.ts` (VPS, no DB) → `work/label.py`, `work/predict.py`, `work/score.py` in the run folder. LLM spend for the whole run is ≈ **$31 at Luna list price** (57M input / 50M output tokens across labelling, two baselines, 6 rule variants and Da Vinci). The Sol labelling share is priced at the Luna rate, so the real figure differs by the Sol/Luna price gap.
