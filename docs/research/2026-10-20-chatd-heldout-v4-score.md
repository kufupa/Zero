# Live v4 triage classifier on the untouched Aug–Sep held-out set (2026-10-20)

Chat D's goal: a **valid** score of the live action classifier (rules v4) on mail it was never tuned on, with the same input prod sends (vision images on), run twice to measure noise. Owner approval: OWNER-ASKS row 154 (no budget cap). Earlier status and the failed attempts: [Chat D status](2026-10-19-chat-d-triage-gepa-safety-gate.md), [Chat D plan](2026-10-19-chat-d-triage-gepa-plan.md). The metric definitions are the same as in the [leak-free triage eval](2026-10-19-leak-free-triage-eval.md).

## Answer

On 436 held-out Centurion mails from Aug 1 to Sep 8, the live v4 classifier scored **94.0% accuracy / 91.6 macro-F1 (pass 1)** and **93.8% / 90.2 (pass 2)**. That is higher than its 90.3% / 88.6 on the frozen 431-row test. The two sets differ in months, mix and vision, so the comparison is directional (§5). The two passes gave the same action on **421/436 rows (96.6%)**. After one retry every row got a prediction (0 rate limits). But **36 of 872 first attempts (4.1%) ran past the prod 180 s deadline**, which is above the PRODUCT ≤1% failure bar (§2).

On silver labels, money classes meet the leak-free triage bar on both passes. quote_availability is 100 P and 100 R on both passes (n=11). new_booking precision is 98.7 then 96.2, recall 97.4 then 98.7 (n=77). amend and cancel precision is 100 on both passes; their recall falls in pass 2 (amend 81.8, cancel 80.0).

One real-booking skip occurred, in one pass. Row `e0e0f8dd` (silver new_booking) came out no_action in pass 2 and correct in pass 1. It is hotel staff writing internally to ask for a booking. PRODUCT calls a skipped booking ask unacceptable, so this row needs an owner ruling (see §5).

## 1. What was run

| Item | Value |
|---|---|
| Rows | 436 = every silver-labelled row in the pre-label, thread-disjoint test split (477 sampled rows, seeded on 2026-10-19). Same IDs as the 2026-10-19 attempts; no re-split |
| Window | Centurion inbound 2026-08-01 → 2026-09-08 (D0 export). No v1–v5 rule tuning ever saw these rows |
| Labels | Silver: 430 rows where Luna (high) and Sol 6.1 (high) agreed; 6 rows from the staff-outbound rule (2 quote file, 4 POP). Mix: no_action 214, new_booking 77, billing 45, group_event 36, payment_proof 29, amend 11, quote_availability 11, other_actionable 8, cancel 5 |
| Not scored | The **41** test-split rows where the two silver models disagreed. They are reported separately and not counted (§4) |
| Classifier | Prod `buildInboundPrompt` + prod system prompt + schema; `ACTION_CLASSIFICATION_RULES` = rules v4 (sha256 `6cf0dbde…bd2979b`). Model `gpt-6-luna`, effort `max`, route `azure_gpt6_luna_extraction` (the deployment prod extraction uses). Usage source `reported` on every row |
| Input parity | Text prompt parity 436/436 against the D3 prompts. Attachments were re-read from the live mailbox via prod `loadSyncedQuoteSelectionFromMailbox` (with vision), and images were built by prod `prepareExtractionVisionImages` with `EXTRACTION_VISION` on: **28 rows / 53 images**, 0 missing image bytes, 0 PDF render failures. Thread context is strictly earlier mail that does not reply to the target (leak-free) |
| Runtime | EC2 checkout `1181ca923` (prod), run as `ubuntu` with the prod env sourced, `nice -n 10`, launched through `ssm-run-command.sh` and detached. No product code, flag or deploy change |
| Concurrency | 10 per pass, both passes at once (20 model calls in flight). Model deadline 180 s, same as the prod `lunaCallBudget('max')`. A failed row was recorded, not fatal; each pass then retried its failed rows once with a 400 s deadline |
| When | Started 03:00:20Z, finished 03:48:38Z on 2026-10-20 (48 min, before staff start at 05:00Z) |
| Cost | Luna **$3.35** at $0.10 / $0.50 per M tokens (908 model calls). Redacted gists for this report: $0.004 (Luna low, on the internal gateway) |

### Why the 2026-10-19 attempts failed and what changed

Five attempts aborted. Each one ran 2 rows at a time with one model retry, and the whole pass stopped on the first failed row. In this run, **36 of 872 first attempts (4.1%) hit the 180 s deadline**: 22 rows in pass 1 and 14 in pass 2 (28 `timeout`, 8 adapter `timeout_error`). All 36 succeeded on the 400 s retry, so 908 model calls were made in total. At those rates, the old abort-on-first-failure design could not have finished a 436-row pass.

Model latency per scored row: p50 35–39 s, p90 ~127 s.

## 2. Scores (n=436, silver; failures would count as wrong, none occurred)

| Run | Acc | Macro-F1 | Final failures |
|---|---|---|---|
| **v4 + vision, pass 1** | **94.0** | **91.6** | 0/436 |
| **v4 + vision, pass 2** | **93.8** | **90.2** | 0/436 |
| Noise band (pass 1 vs pass 2) | 0.2 pt | 1.4 pt | — |
| Reference: v4 on frozen 431 (text only, Sep 9 – Oct 16) | 90.3 | 88.6 | 0 |

Per class (P / R, pass 1 → pass 2):

| Class | n | Pass 1 P / R | Pass 2 P / R | Frozen-431 v4 P / R |
|---|---|---|---|---|
| quote_availability | 11 | 100 / 100 | 100 / 100 | 88.5 / 88.5 (n=26) |
| new_booking | 77 | 98.7 / 97.4 | 96.2 / 98.7 | 85.9 / 94.4 |
| amend | 11 | 100 / 90.9 | 100 / 81.8 | 95.2 / 83.3 |
| cancel | 5 | 100 / 100 | 100 / 80.0 | 100 / 100 (n=6) |
| payment_proof | 29 | 93.1 / 93.1 | 100 / 82.8 | 100 / 93.1 |
| billing | 45 | 82.0 / 91.1 | 79.6 / 95.6 | — |
| group_event | 36 | 94.3 / 91.7 | 91.7 / 91.7 | — |
| other_actionable | 8 | 54.5 / 75.0 | 66.7 / 75.0 | — |
| no_action | 214 | 96.7 / 94.4 | 96.7 / 94.9 | — |

Small classes move a lot per row. One amend row is ±9 points; one cancel row is ±20.

**Against the bars.** Triage bar from the leak-free eval: ≥90% precision on money classes, and ≥95% recall on quote and new_booking. Every one of those numbers is met on **both** passes, on silver labels. The lowest money-class precision is payment_proof at 93.1 in pass 1. payment_proof recall dropped to 82.8 in pass 2, but the recall bar covers only quote and new_booking.

The PRODUCT front-door bar has three parts. Not all of them pass:

| PRODUCT front-door bar | This run | Verdict |
|---|---|---|
| ≥90% agreement with outbound-grounded labels | Only 6 rows have outbound-grounded labels: 6/6 in pass 1, 4/6 in pass 2. Against all 436 silver labels: 94.0 / 93.8 | n=6 is too small to pass or fail; silver ✓ |
| ≤1% failures at production concurrency and effort | Effort `max` and the 180 s deadline match prod. **First-attempt failures 36/872 = 4.1%**; 0 after a 400 s retry that prod does not do in-call. Concurrency was 20 in flight, not a measured prod level | ✗ at the prod deadline (prod-side rate not measured) |
| No real booking/quote ask skipped | One booking ask skipped, on one pass (§3) | ✗ |

Pass-1 vs pass-2 agreement (96.6%) is the noise band, not a PRODUCT bar.

**Outbound-grounded rows** (6, strongest labels): both quote-file rows were right on both passes. POP rows: 4/4 right on pass 1 and 2/4 on pass 2; both misses went to new_booking, which is also a working folder.

**Image rows** (28): 25/28 right on both passes. The misses were 1 no_action→billing and 2 actionable→no_action (the ef2e0aae group rooming list and the c4700cd7 itinerary, both in §3).

**Biggest error cluster:** no_action → billing, 7 rows (pass 1) and 9 rows (pass 2). These are mail the two labellers called no_action but v4 sends to billing (payment-processed / declined-card notices and the like). It is a precision loss, not a skip.

## 3. Every actionable → no_action miss (the skip-risk class)

The gists are redacted one-liners written by Luna low from the prompt text, with no names, emails, references, dates or amounts. Row IDs are the first 8 characters of the message UUID. The full IDs are in the private run folder.

| Row | Silver | Pass(es) missed | Gist |
|---|---|---|---|
| `e0e0f8dd` | new_booking | 2 only | hotel staff requests a new guest booking for two room nights and a pro-forma invoice for prepayment |
| `ef2e0aae` | group_event | 1 + 2 | hotel staff sent a rooming list for a group event as previously requested |
| `f9122031` | group_event | 1 + 2 | hotel staff requests increasing the group booking headcount and notes another booking may be cancelled |
| `7bb0794c` | billing | 1 + 2 | hotel staff asks another incorrect food charge to be corrected because it was included in the dinner package |
| `406a53d8` | billing | 1 + 2 | hotel staff requests follow-up on outstanding reservation vouchers and payments |
| `add77677` | billing | 1 only | gist withheld (the redaction check rejected all three drafts) |
| `2a7938da` | other_actionable | 1 + 2 | hotel staff asks colleagues to retrieve last year's corporate booking statistics to contact past bookers |
| `c4700cd7` | other_actionable | 1 + 2 | a corporate booker sends a guest's flight itinerary after hotel staff arranged a pickup |

**Pattern:** 6 of 8 misses are **hotel staff writing internally**. Rule v2 says "internal staff mail with no outside request = no_action", and v4 follows it. The silver labellers judged these mails by the work they ask a colleague to do. A rule that classed internal mail by the requested work was tried and dropped in the overnight round (val −7/+5 rows; [leak-free eval §3](2026-10-19-leak-free-triage-eval.md)). So this is mostly a **policy question, not a model error**. No quote ask was skipped.

## 4. Silver-disagreement rows (not scored)

The test split has **41** rows where Luna and Sol disagreed. They are excluded from every number above, the same treatment the frozen 431-row test used (180 disagreements set aside). The held-out score is therefore measured on mail where two strong models already agree, which is the easier part of the mix. The 2026-10-19 [owner label sheet](2026-10-19-chat-d-owner-label-sheet.md) lists 40 disagreement rows from the whole Aug–Sep sample. 16 of those 40 fall in this split's 41; the owner has filled none of them yet.

## 5. Limits and next step

- **Silver, not gold.** 430/436 labels come from two-model agreement, and one of the two labellers is Luna, the classifier's own model family. Agreement with silver can overstate true accuracy. Owner gold overlaps 0 of these rows.
- **Small money classes.** The quote result is 11/11; one more quote row would move recall about 8 points. Do not read "100%" as proof of the PRODUCT quote bar (that bar is ≥10 *priced* threads end to end, a different test).
- **Different months.** Aug–Sep has a different mix (more group_event and billing) than the Sep 9 – Oct 16 frozen set. The frozen set was text only; this run has vision. The comparison is directional, not paired.
- **Timeout rate.** 4.1% of first calls ran past the 180 s prod deadline at 20 calls in flight. Prod treats a timeout as a failed extraction. Compare this with prod's own extraction timeout rate (not measured here) before calling it a prod defect.
- **Image rows.** The 2026-10-19 status note counted 43 of the 477 sampled test rows with non-inline image-file attachments. Prod vision prep produced images for 28 of the 436 scored rows. This run does not break down the gap (unlabelled rows, or files that vision prep skips).

**Recommended next step (not run; no GEPA or hand-rule round, per the brief).** On silver there is no money-class precision or recall gap outside the noise band, so GEPA has nothing to chase. The PRODUCT skip bar is still open, but it comes down to one policy row, which is not a prompt-search problem. The open item is a policy call. The owner should rule whether internal hotel-staff mail that asks a colleague to do booking or billing work belongs in a working folder (6 of 8 misses, including the one booking skip `e0e0f8dd`). If yes, write one rule and re-score it against this same frozen held-out set, ×2 passes. Then use the same runner to score the 41 disagreement rows after owner or adjudicated labels exist.

## 6. Reproduce

The run folder `/home/orca/nava-research/triage-chatd-20261020/` (private, contains PII) holds `runner.ts`, `launcher.sh`, `score_heldout.py`, `miss_gists.py`, both prediction files, `runner.log` and `score.json`. S3 inputs are under `triage-export/2026-10-19/chatd-d5-vision-v4-20261019/input` and the D3 prompt and selection prefixes. Outputs are at `triage-export/2026-10-19/chatd-heldout-c10-20261020/out` (SSE AES256). The runner is the 2026-10-19 vision runner, changed in only four ways: concurrency 10, both passes concurrent, no spend stop, and a record-then-retry-once failure path.
