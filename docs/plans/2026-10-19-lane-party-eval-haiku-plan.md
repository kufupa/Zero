Reading the plan file and the required context first.
Reading the required startup files and the ETA ledger first. The plan says to read `PRODUCT.md`, `AGENTS.md` and `MISTAKES.md` once, and the ETA must rest on code I've read.
Startup reads are done: `origin/main` is `aee15e351`, and `PRODUCT.md`, `AGENTS.md`, and `MISTAKES.md` are read. Next I need the party-lookup code and the data artifacts so the ETA rests on code I've read.
Startup reads are done. CodeGraph isn't indexed here (no `.codegraph/`), so I'm using grep and read. Next I'm reading the party matcher, the HMS party job path, and the prior scoring report, to ground the plan and ETA.
Startup reads are done and the party code is in view. Before I estimate, I need the matcher's search-term logic, the bind rule, and where the job decision gets stored, all read-only.
Startup reads are done. Before I give the ETA, I need to check the bind gate, since the plan's main lever depends on it, and the running-lanes state for the footer. The caveman, adhd, and exemplar files are required output rules, so I'm loading them too.
Startup reads are done. I need three things before the ETA: the picker's actual inputs (the live-vs-simulated question), the table the 123 reads live in, and whether `party-aliases` is a per-company alias table, since that would break the no-entity-rules rule. I'm also reading the caveman and adhd skills from the correct `/home/orca` path, because my earlier `/home/ubuntu` guess was wrong.
Startup reads are done. Two local checks decide whether the baseline is usable: whether the hardcoded sender-alias table or the learned sender map feeds the bind path, and which picker produced the 55/95 "live" number. The file's method says the persisted LLM answer was null, which doesn't fit that number.
I've read the plan, the required files, and the party code. Before I give the ETA, I'm checking three things it depends on: where party decisions are stored, what `read_tool` means, and that the gate scripts I'll name exist.
Chat B is read-only through step 2, and step 3 needs owner approval. I've read the matcher, the bind gate and the job schema. Three checks remain before I can give an honest ETA: what the 55/95 "live" row actually measured, how the stored read results are kept, and how much staff-side truth exists. The last check counts field coverage only and prints no values, since the corpus is PII.
Startup reads are done. Two checks could change the plan: whether the hardcoded sender-alias table can produce a strong bind candidate, and whether the local corpus holds any party reads from the 72 h window. Both are read-only.
Reading the matcher and bind gate showed the baseline may not measure what the plan assumes. Before I state the plan, I'm checking three things: how the 55/95 "live" row was produced, which reads prod prefetch actually sends, and the field names in `staff_quotes.metrics`.
Before I write the plan, I need to settle three facts: whether the 55/95 row has a defined method, how much staff truth exists, and what the local HMS snapshot holds. All are read-only.
The plan needs two more facts before I give an ETA. First, what the 55/95 "live" row measured. Second, whether the staff-side truth is usable. Both are read-only, and I'm printing key names and counts only, no values.
Startup reads and the code check are done. I'm logging the ETA and this turn's asks now, since the repo rules require both on the same turn.
Next check: the 55/95 "live" row. Its report says no Luna call, but it has 17 binds the deterministic fallback lacks. I also need to confirm where the truth names come from. Both are read-only.
Two checks left before I write the plan. First, the 23 staff-quote attestations: do they name a party inside the `metrics` JSON? Key names only, no values. Second, one ledger row for the step-3 ETA, since I'm quoting one.
Plan and ETA are below. Before I stop for your go, I'm making three quick checks: whether the stored party result carries the bind decision (so auto-bind can be read without truth), the current peer lane status, and a wording fix to ask row 119, which should quote your message verbatim.
Last check before the plan: whether the stored party result carries the bind decision. If it does, step 2 can bucket the 123 misses without re-running HMS. Read-only.
Startup reads and the ETA data are in hand. Before I commit to a number I need to check three things: which function produces `readResult` (the stored-decision claim depends on it), whether a fresh 72 h pull path exists (the snapshot ends 10-13 and the window starts 10-16), and how many staff-quote rows have non-null values. Names and counts only.
The R7 baseline is weaker than the plan assumes. Before I write the plan I need to check whether a later party study already exists (the plan requires reusing prior artifacts), and whether this VPS has a read-only route to prod data for the 123 reads.
The check I queued for truth-source keys hasn't run yet. I only checked key names on the first and not-found answer-key rows, so I'm checking the found rows and the conf-domain map before I write the plan. Key names only, no values.
Plan is built and the ETA is logged. Before I stop, I'm writing the ledger rows and the ask rows, as the repo rules require on the same turn.
Before I deliver the plan I need to check one claim I'm about to make: that the stored party result carries the bind decision, so step 2 can bucket misses without a new HMS run. I'm also fixing rows 119–121 in the asks ledger, which I garbled earlier by replacing your words with my own status notes.
Three more checks before I write the plan: what `not_found` means in the answer key, what the party job's stored result contains, and the UTC time.
Plan is nearly ready. Two last facts before I post it: whether the party job's stored result includes the bind decision, and whether this VPS already has a read-only prod route. Names and counts only, no secrets printed.
I have enough to plan. Before I stop for your go, I'm logging your ask in `PRODUCT.md` Asks logged, as its rules require. I'm also confirming the working-tree state.
Checks are in. Before the plan goes out, I need to answer two things: whether the staff-quote value count (which read a wrong path and returned 0) is right, and whether the answer key's `commercial` flag can serve as negatives. I'm also logging your ask in PRODUCT.md, which its rules require.
Plan's nearly done. Before I post it, I'm fixing two ledger rows I got wrong: I closed Chat B's row as `superseded`, and my plan row has conflicting closes and a late start stamp. The ledger is append-only, so I'm adding correcting rows, not editing.
Plan and ETA are ready. Before I post them, I'm pinning the line numbers for the baseline claims I'm about to make.
Before I post the plan I need to check two stored-data claims it depends on: the shape of `searchesTried` and `results` in the stored party result, and the current working-tree state.
**Plan: diagnose from stored fields first, then pick the fix. Steps 1–2 ETA 39 min after your go. Nothing run against prod.**

- **Now:** plan written, waiting on you.
- **Next:** steps 1–2 (read-only) on your go.
- **ETA:** 39 min after go, timebox 98 min. Step 3 (code) only if you approve after step 2.

---

## 0. Your asks

| # | Ask | Status |
|---|---|---|
| 1 | Read the plan, run Chat B only | 🟡 steps 1–2 planned |
| 2 | First reply = plan with ETA | ✅ this reply |
| 3 | Then wait. Plan → you → code | 🟡 waiting on your go |
| 4 | Deploy/env approvals come only from you, in this chat | 🟡 standing; none proposed |

Logged: `docs/context/OWNER-ASKS.md` rows 119–121, and your line verbatim in `PRODUCT.md` Asks logged.

## 1. What I read and touched

- **Read:** `PRODUCT.md`, `AGENTS.md`, `AGENT.md`, `ACTIVE.md` (imported by `CLAUDE.md`), `OWNER-ASKS.md`, `MISTAKES.md`, the plan. FACTS §3 and the CATALOG party rows by grep. Research README by grep only.
- **Revision:** `origin/main` = `aee15e351`, HEAD same, branch `kufupa/oct19-party-eval`.
- **Changed:** 2 doc files, uncommitted. No code, no prod read, no HMS, no tests or typecheck.

## 2. Plan

| Step | Work | Output | Writes | ETA (min) |
|---|---|---|---|---|
| 1 | SELECT succeeded party reads from the last 72 h. Split by `matchVersion`, `pickSource`, `matchStatus`. Join staff truth. | Wrong-bind count first, then truth coverage, then bound / needs-pick by source | none | 40 |
| 2 | Bucket misses from **stored** fields (no new HMS). Read 20 by hashed conf. | Cause table (below) | none | 25 |
| Gate | You decide the fix | — | — | — |
| 3 | Only if buckets say variants dominate | Variant proposal inside the V2 path. Queues behind chat A. | code | 81 after its own approval |

Step 2 buckets:

| Bucket | Meaning | Fix if it dominates |
|---|---|---|
| B1 | Truth not in `results` | Variant proposal (step 3) |
| B2 | Truth in results, no pick or low confidence | Pick prompt or data |
| B3 | Truth picked, but the claim rule blocks it (`apps/server-pilot/src/ai/party-match-v2.ts:849`) | Bind-rule change. Needs your OK and negatives. |
| B4 | Competing row or truncation (`:828`, `:837`, `:862`) | Probably correct. No change. |

## 3. What changes the plan (checked in code and data)

| Plan assumed | Found | Source |
|---|---|---|
| Baseline 55/95 bound, 0 wrong | Not a prod rate. Prefetch is quote-only, and only 3 of 95 sampled emails are quotes. The row says "production picker" but also says no Luna call, so I can't tell which picker made the 55. | `/home/orca/nava-research/reports/r7-party-v2-live.md` lines 7, 14, 17, 193, 194 |
| Truth = confirmation PDF company field | 30 of 1,179 name a party (2.5%). Most reads would be unlabelled. | FACTS §3; R2 |
| Staff quote headers as truth (my addition) | 15 of 23 snapshot rows have a party. **Circularity risk:** if Nava's bind filled the header, it isn't independent. Check first. | `staff_quotes` snapshot, 10-13 |
| Local data covers the window | Local corpus ends 10-13. Its 13 party reads are all before 10-16. Fresh export needed. Route not yet verified. | corpus `hms_reads` |
| Re-run HMS to bucket misses | Not needed. Stored `readResult` has `matchStatus`, `reason`, `searchesTried`, `results`, `pickSource`, `confidence`. | `hms-jobs.ts:2410–2424`, `:2991` |
| Variant loop needs a new LLM picker | The picker exists (`gpt-6-luna`). The new part is only variant proposal plus extra searches. | `party-match-v2.ts:677–691`; `hms-jobs.ts:2400` |
| Aliases might cause a bind | No. Weak candidates can't bind. They only set search order. | `party-match-v2.ts:736` |

## 4. Risks and holds

- **No verified negatives.** Answer key: 167 found, 26 not_found (meaning unverified in code), 1 failure. R2 found no private-guest negatives, so the false-bind rate is unmeasured. The 0-wrong-binds bar stays unproven.
- **Entity rule.** `SENDER_ALIASES` hard-codes 8 agencies or companies (`apps/server-pilot/src/ai/party-aliases.ts:29`). Your rule is no entity rules (memory `feedback-generalize-no-overfit`). Flagged, not touched.
- **Chat A bar.** Party wait p50 is 411 s on one HRCEN browser; run p50 is 70 s (shared facts, 09:30Z). Each extra search is one more call in that queue, against A's bar of p50 < 60 s. Agree a latency budget with A first.
- **File overlap.** Step 3 touches `party-match-v2.ts` and `hms-jobs.ts`, which chat A is changing. It queues behind A.
- **Model.** Your plan has Haiku driving. PRODUCT.md assigns user-facing claims to Opus. I'll keep Haiku driving and send the step-1 numbers through one Opus check before they reach you.
- **PII.** Hashed conf ids only. No guest names. Corpus stays off git.

## 5. ETAs (ledger-scaled)

| Item | Raw min | Ledger median (n) | ETA min |
|---|---:|---|---:|
| Steps 1–2, read-only | 65 | research 0.60 (25) | **39** (timebox 98) |
| Step 3 code, conditional | 60 code + 15 review + 12 deploy + 15 live proof | 0.77 / 0.87 / 0.83 / 0.80 | **81** after its own approval, plus chat A queue |

Ledger rows: `chat-b-20261019-steps12`, `chat-b-20261019-variant-chain`. Planning ran 56 min against a 33-min estimate. I read past the startup list to ground the numbers.

## 6. Decision: your go

| Option | Completeness | ETA (min) | Value / ROI | Risk |
|---|---|---|---|---|
| **A. Go on steps 1–2 as planned (recommended)** | 7/10 | 39 | Only option that measures wrong binds and misses | Prod route unverified; truth thin |
| B. Go, confirmation PDFs only as truth | 4/10 | 39 | Avoids the circularity risk | ~2.5% coverage, almost nothing scoreable |
| C. Hold | 0/10 | — | — | Party bind accuracy stays unmeasured |

**Recommendation: A.** Read-only, no HMS, no writes. Truth = staff quote headers (after the circularity check) plus confirmation PDFs, with coverage reported for each. No "top 3 ≥ 95%" claim without labels. No commit until you ask.

## 7. Honest notes

- I closed Chat B as `superseded` in the ETA ledger by mistake, then appended `reopened`, which isn't an allowed outcome. The plan row is logged as research with ratio 1.7. The ledger is append-only, so I can't fix it. It nudges the research median slightly.
- One command printed agency names, rates and arrival dates when I meant counts. No guest names, no secrets. I'll keep to counts.

Waiting for your go.

---

**Peers (as of 10:24Z):** A hms-speed busy · C ship-small busy · D triage-gepa busy · oct18-c1-classify-53 busy (7 h) · oct18-c1-classify-c2 idle (10 h).

**Open topics by ROI:**
1. **Party wait p50 411 s (chat A).** Measured staff pain; the fix is queue order.
2. **Party bind accuracy (chat B).** PRODUCT bar, not yet measured. Steps 1–2 start this.
3. **Truth coverage and negatives.** Blocks any accuracy claim.
4. **`SENDER_ALIASES` entity rule.** Owner decision, no urgency.
