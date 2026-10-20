# 2026-10-19 Chat D: triage quote recall, labels, GEPA gate (plan + findings)

**Status: plan only.** No LLM calls, no EC2/RDS calls, no code, no prod change. Uncommitted. Waiting for the owner's go in the Chat D session.

Base: `origin/main` `aee15e351`. Worktree `oct19-triage-gepa`.

**Method:** count-only reads of local silver files (`/home/orca/nava-research/triage-20261019/`, PII, never in git) and the private corpus (field names and counts; no content printed). Reused: [leak-free triage eval](2026-10-19-leak-free-triage-eval.md) §2 (frozen-test scores), [overnight plan](../plans/2026-10-19-overnight-triage-dspy.md), [parallel-chats plan](../plans/2026-10-19-parallel-chats.md) Chat D, FACTS §4 (no class-level major-error counts exist), CATALOG (no study scores classifier quote recall over all staff-quote threads).

**Definitions:** "latest" = latest inbound before the staff quote file, ≤7 days. Quote targets in window: **33** (28 in the 1,694-row sample, 5 not sampled).

## 1. Findings

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | One latest-inbound quote row (prefix `e32e9e67`): both silver models say `quote_availability`, v4 says `no_action`. Frozen test. | silver `two_model`; v4 pred | PRODUCT: "real quote ask skipped" = unacceptable. Read this row first. v4 is live in extraction (prod `357315940`, since ~05:08Z), so this skip class is live (inference). |
| F2 | Frozen test quote recall **23/26 = 88.5%** (bar ≥95%). Outbound-grounded quote rows (silver `det=quote_availability`, n=13): v4 agrees **11/13 = 84.6%** (PRODUCT front-door bar ≥90%). | report §2; silver `det` | Bars not met; n tiny. POP rule is inbound-filename-grounded, not outbound. |
| F3 | 180 disagreements were never scored. 14 are quote-file rows; in **10 of 14** both models say `group_event`. | `disagreements-transport-centurion.jsonl` | Quote recall excluded the hardest rows. |
| F4 | Owner 2026-10-19 rule ">12 guests → group_event" sits after the quote-file rule in the overnight plan's deterministic list. `label.py` `deterministic()` implements only HRCEN, quote, POP. | overnight plan L28; `work/label.py` | Precedence unclear → decision D4. |
| F5 | Fresh holdout (2026-10-16 14:00Z → now) = 2.9 days. 33 targets / 37.2 days = 0.89/day → **~2.5 expected quote targets**. | window arithmetic | Cannot gate on it → decision D3. |
| F6 | v5 was rejected on frozen-test numbers ("test 88.6→88.0 … Rejected", RUNLOG 05:49Z). The eval report says tuning used val/train errors only. | RUNLOG; report §3 | Frozen test is no longer clean. Aug–Sep 8 is the only untouched set. |
| F7 | Private corpus cannot link Aug quote replies: **43/43** Aug quote-file messages sit in threads with no inbound under the same `thread_id`. Corpus has no message-id or in-reply-to fields. | corpus keys + thread check | Aug silver must come from RDS via EC2 read-only export (has headers). D0 checks this first. |
| F8 | **98 of 155** model disagreements are actionable vs `no_action` (the skip-risk class). | disagreements file | Adjudicate these first. |
| F9 | Overnight eval cost ≈ **$50 at API list** (Luna $37.7 = labels $0.7 + preds $37.0; Sol $12.2 labels), not "≈$31". Report priced Sol at the Luna rate. Prices: Luna $0.10/$0.50, Sol $2/$10 (HANDOFF-2026-10-14 L71, not re-checked against the gateway). | usage fields | Correct report §7. |
| F10 | Latest-only re-score (latest inbound in thread; no LLM cost): v4 **92.4 acc / 90.3 macro-F1** on 304 rows, vs 90.3 / 88.6 on all 431. 11 of 39 quote-anchored rows are earlier inbounds. | v4 preds × split | Owner rule "one gold row per latest inbound" (overnight plan, quote-feedback rules). Report both; gate on latest-only. |
| ✓ | `rules-v4.txt` is identical to prod `ACTION_CLASSIFICATION_RULES` (5,620 chars). | diff | GEPA seed = live prompt. |

## 2. Plan

Critical path: D0 → D3 → D5 → D6 (+ D4 only on a gap). D1 and D2 run alongside D0/D3.

| Step | What | Model, API $ | Raw → scaled min |
|---|---|---|---|
| D0 | RDS count + join check for Aug quote-file replies. EC2 read-only export of Aug 1–Sep 8 threads (same command family as overnight D1). No writes. | none (SSM) | 15 → 9 |
| D1 | v4 on the 33 latest-inbound quote targets. Prompts already exist for the sample; 5 need D0. Read F1 and the 2 scored misses first. | Luna max ≈$0.15 | 10 → 6 |
| D2 | Adjudicate the 180 disagreements: label, confidence, one-line reason. The 98 actionable-vs-`no_action` rows first. Owner spot-checks the 20 lowest. | Luna max ≈$0.8 | 30 → 18 (parallel) |
| D3 | Aug–Sep 8 silver, overnight method (staff-outbound anchors; else Luna high + Sol high agree; else set aside). ~1,500 rows (34% of 4,358 inbound, overnight sampling rate). Thread-disjoint split → **~400-row holdout, never tuned.** | Luna high ≈$0.6; Sol high ≈$10.2 | 45 → 27 |
| D4 | **Only on a gap** (see below). First one hand-written rule round on the top error cluster (~6 min per round in the overnight run). GEPA only if that does not close the gap. GEPA seeded from `rules-v4`; metric = money-class macro-F1, billing + other_actionable merged, actionable→`no_action` penalty ×3 (my proposal); ≤1,500 metric calls; 32 in flight. | Luna max ≈$6.8; reflection (Sol high, ~40 calls) ≈$2 | 60 → 36 |
| D5 | Gate on holdout: v4 ×2 (noise band) + candidate ×1. Ship a PR only if it beats v4 outside the band **and** adds zero actionable→`no_action` on quote/new_booking. Frozen test reported once, not used to choose. | Luna max ≈$5.4 | 15 → 9 |
| D6 | Report in `docs/research`; short ACTIVE.md update; ledger close; disagreement file for the owner. A PR, if any, goes to Chat A for deploy. | none | 10 → 6 |

**Gap (triggers D4):** holdout misses a PRODUCT bar beyond the noise band: quote or new_booking recall < 95%, or any actionable→`no_action` on quote/new_booking.

**Stop rules:** each step at 1.5× scaled; cut scope at the timebox. No HMS writes, no sends, no Vitest/tsc on the VPS, kill by PID.

**Adjudicator default (not a block item):** Luna max + owner's 20-row spot-check. PRODUCT Asks (2026-10-14) say "disagreements go to the owner"; the 2026-10-19 overnight plan says "owner gold = spot check only". Using the newer wording unless the owner objects.

## 3. ETA (ledger-scaled; research median 0.60, n=25)

| Path | Critical raw min | Scaled min | From a go at ~11:40Z |
|---|---|---|---|
| No GEPA | 85 (D0 15 + D3 45 + D5 15 + D6 10) | **51** | ~12:31Z |
| With GEPA | 145 (+ D4 60) | **87** | ~13:07Z |

Ledger: `chat-d-20261019-chain-nogepa` (51) and `chat-d-20261019-chain-gepa` (87) appended. `chat-d-20261019-chain-eta` (96, 160 raw) closed as superseded: its basis counted D2 serially and left out the D0 export. GEPA wall time is the weakest number (60 raw; range 60–150 min). Owner's 20-row spot-check time is not in the ETA.

## 4. Cost (API list, $ by model)

| Path | Luna | Sol | Total |
|---|---|---|---|
| No GEPA | ≈$7.0 | ≈$10.2 | **≈$17** |
| With GEPA | ≈$13.7 | ≈$12.2 | **≈$26** |

Cap $40 holds at API price. Per-call basis: Luna max ≈$0.0045 (measured avg 7.2k in / 7.5k out over 9,044 calls); Sol high label ≈$0.0068 (2.7k in / 0.14k out); Luna high label ≈$0.0004. Sol max adjudication (not planned) would add ≈$5–14.

## 5. Decisions (pick first; completeness / ETA / ROI)

- **D1 GEPA scope.** **Pick B:** GEPA only on a gap, hand round first. Completeness 8/10. ETA +36 min only when it runs. ROI: avoids fitting silver noise (180 rows set aside; RUNLOG 05:49Z already names residuals as silver noise + policy). Alt A: GEPA always. Completeness 9/10 for coverage; +$8.75; +36 min; no evidence yet it beats a hand round.
- **D2 Time box.** **Pick:** extend to **13:15Z** so GEPA can run if the gap is real. Completeness 8/10. Alt: keep 12:31Z: no-GEPA path only; report at ~12:31Z; GEPA cannot run.
- **D3 Holdout.** **Pick:** Aug–Sep 8 (~400 rows, untouched). Completeness 9/10. ROI: ~400 rows vs ~2.5 quote targets in the fresh slice. Alt: fresh slice (2026-10-16 14:00Z → now): cannot gate; keep as a live drift check only.
- **D4 Label precedence for >12-guest quote files** (10 rows, both models `group_event`). **Pick:** >12 guests → `group_event` first (explicit owner class rule; not yet in `label.py`). Completeness 7/10 (owner rule is ambiguous on order). Impact: ~10 rows move quote → group_event; quote recall denominator shrinks. Alt: outbound quote file first (plan list order): keeps them as quote; recall measured on them.

**Reply format:** `go 1B 2A 3A 4A` (or `go` to accept all picks). `go` also covers the read-only EC2 export in D0 (no writes) and API spend up to ≈$26.

## 6. Argue the opposite (PRODUCT step 3)

GEPA may chase label noise, not classifier error. The quote gap is 3 misses of 26; one row = 3.8 points. The cheap levers are labels (D2, D3) and the precedence call (D4), not prompt search. So GEPA runs last, and only on a gap.

## 7. Not done / limits

- No LLM calls, no EC2/RDS reads, no prod change in this stage. Nothing committed.
- Sol price and Sol max token use not re-checked against the gateway.
- Whether the Aug thread-linkage failure (F7) is a corpus artifact is unknown until D0.
- Holdout size (~400) and sample size (~1,500) are estimates from the overnight sampling rate.
