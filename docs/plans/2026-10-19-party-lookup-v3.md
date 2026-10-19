# 2026-10-19 party lookup v3: ship plan

**Status:** owner go 2026-10-19 ~15:40Z. F2 (one login per party job, #390 `bc856082c`) is merged, so nothing waits on it. Revised after a GPT-6.1 Sol high review (13 P1, 2 P2, all folded in) and a /95 pass on duplicate profiles. Evidence: [party lookup evidence](../research/2026-10-19-party-lookup-evidence.md).

## Summary

Prod binds an HMS company/agency on ~16% of party lookups (24/153 since 2026-10-14). The misses are notices, junk search words and duplicate profiles, not the picker. v3 searches a local copy of every HMS profile, uses staff's past picks for the same sender, confirms with one batched live call, and is scored on a backtest before staff see it. Ship as small PRs in parallel. No new tables or new UI beyond what the existing pane already has.

## What the /95 pass changed

| Finding | Evidence | Change to plan |
|---|---|---|
| No past data shows which duplicate staff pick: 0 of 27 staff picks, 69 reservation reads and 30 Nava binds touch a duplicated name | evidence §9 (SQL 15:45Z) | No "learned rule" yet. Start collecting it now (P3), let staff pick duplicates in the meantime, learn from the picks |
| Reservation reads drop the agency id (`commercial-fields.mjs` keeps an id only when it differs from the name) | evidence §9 | P3 keeps it |
| Quote rate search types the agency name, then selects by `nativeId` (`fetch-quote.mjs` `matchReference`); name-only on a duplicate throws `AMBIGUOUS_REFERENCE` | code (corrected after Greptile #392) | The bound id decides the copy and so the rate; no fetch-quote change |
| Lane B's "3 wrong binds" were all Nexus Travel #27, which staff also picked 9 times | evidence §10 | 0 known wrong binds. Truth = staff picks on quotes first; reservation party second (it can differ) |

## Requirements

- R1. Score v2 vs v3 on identical rows, per stage. Identity = kind + id; name-only truth on a duplicated name = "can't certify". History frozen before each email, own thread excluded. Staff picks equal to an earlier Nava suggestion excluded.
- R2. Bars (PRODUCT.md): 0 wrong binds; auto-bind ≥ 70%; top-3 ≥ 95%. Headline = before → after.
- R3. No party lookup on booking-system notices (owner).
- R4. Keep every column HMS shows (city, address, IATA) and the agency id; pass them to the matcher (owner).
- R5. Duplicates are permanent (owner). Bind a copy only with history or a matching column (city/IATA from the email). Otherwise show all copies with city/IATA and let staff pick; each pick becomes history.
- R6. History alone can bind; staff verify (owner).
- R7. ≤ 5 local searches; 1 batched live call (≤ N searches + confirm), N ramps 1 → 5 → 10.
- R8. Index and history per (property, HMS login), never shared.
- R9. After shadow: daily sweep 02:00–03:00 UTC; idle refresh ≤ every 2 h at lowest priority; log adds/removes/renames.

## Value gate

| Gate | Evidence |
|---|---|
| Case mix | Negotiated rate on 115/167 found reservations (69%); party lookups on 275 jobs / 30 days, 85 on threads with a later staff quote |
| Usage | 14 days: 8 accept + 1 edit on party fields; 23 staff party searches / 15 threads |
| Users tomorrow | Centurion staff, quote flow, both surfaces, after shadow + owner flag |
| Over-index | No entity rules; duplicate names are fixtures only |
| Decision | Build |

---

## Architecture decision (owner + /95 Exa, 2026-10-19 16:00Z)

Owner: replicate the reservationist — type a variant into HMS, look, vary, pick. Exa Agent run `agent_run_41572689862e4279ab10032d61a8db8a` ($0.50): local mirror first + bounded live search on miss + live confirm (C); pure live agent (A) not the default. Iterative retrieval does help (IRCoT +11–21 recall points; ITER-RETGEN: most gain at step 2, flat after ~4; ReAct: 7 steps enough), but no study shows live-over-local when both hold the same records. Contradiction search (2026 papers) found agents iterating over a **local** index (Self-Index, IndexAct), not live-over-local.

Resolution — both, in this order:
1. **MVP = the reservationist loop, live, now.** F2 made a batch of searches one login (~16 s fixed + 4–10 s/search, HRDAV probe 14:40Z). The agent picks ≤5 terms from the email, sees the rows (with city/IATA), may vary once (≤3 more), then picks or asks. Needs no sweep, so it ships first.
2. **The index = the same loop's tool, made instant + testable.** Swept HMS copy lets the backtest replay the loop offline and lets the agent's "type" step take 1 ms instead of 7 s. Built in parallel; switched in when the backtest shows it helps.

"Best" = in order: 0 wrong binds → right profile on mail that names one → seconds per email → can be re-scored on the same rows → build time.

## Final shape (owner, 2026-10-19 16:30Z)

- **The agent proposes what to type** (reservationist), not a junk-word filter. Deterministic guard only rejects empty/1–2-char terms and caps the loop. Old P4 folded into P5.
- **Step 0 = learn the duplicate rule from HMS itself**: the answer key already has 49 reservations on duplicated names (Tourvest 26, Rennies 14, BCD 7, Flight Centre 2) with confirmation numbers and sender domains. Read them batched and see which copy staff linked and whether it was HMS's top row.
- Login: F2 = **one** login per job (~10 s), not zero. Infor rejects reused sessions (#382 probe). So batch everything.

## Steps

| # | What | Who (Orca visible lane) | Timebox | Done = |
|---|---|---|---:|---|
| S0a | DOM probe: where the reservation screen holds the agency **id** (today dropped) | Sol high, computer use, read-only, HRDAV then 1 HRCEN conf | 20 min | field name known, or "id not on screen" |
| S0b | Batched read of the 49 duplicate-name reservations: copy id + its position in the HMS search grid + city/IATA | Opus runs (dev priority, property lock) | 30 min | table: copy used per sender domain, top-row yes/no |
| P1 | Docs + Step 0 result | Opus | 10 | merged |
| P2 | No party lookup on booking-system notices | Luna max | 40 | READY |
| P3 | Keep city/IATA/agency id | Grok 4.6 high | 50 | READY |
| P5 | Agent loop: LLM terms → batch → rows+columns → ≤1 vary round (≤3) → pick/ask; duplicate rule from S0b | Grok 4.6 high | 60 | READY |
| P6 | Live replay ~20 mails with id truth through P5 | Opus | 25 | score table |
| P7 | Sweep + offline replay of the same loop | Luna / Grok | after P6 | score on frozen index |
| P8–P9 | History + index tool; freshness | later | — | — |

## Failsafes

- **Read-only only.** No HMS writes; all HMS runs under the property lock at dev priority, batched; Opus is the only live driver (Sol probe read-only).
- **Timeboxes** above; at the box: ship what's green, write the gap, next item (AGENTS.md early-stop rule).
- **Flag off** on deploy; v2 stays the default. Flag on = owner.
- **Bind rule** never loosened by the loop: duplicates need history/column/S0b rule; otherwise staff pick.
- **Gates:** greptile per PR (2 rounds, then validate), EC2 tests/typecheck, Opus merges, no deploy mid-peak without warning.
- **Stop rule:** if P6 shows any wrong bind → fix before deploy; if P6 right-profile < v2 on the same mails → don't flip, report.

## Risks

| Risk | Mitigation |
|---|---|
| Id-level truth thin (~80 rows) | 0/80 bounds error ≈ 4% (rule of three); shadow staff picks grow it |
| Partial index flatters v3 | First score labelled provisional; claim only on the frozen full index |
| Duplicate rule has no data yet | Staff pick duplicates until history exists; P3 records it from deploy |
| Sweep holds the HMS lock | Batches of ~20 searches; outside staff peak; property lock |

## Holds (owner)

- P7 shadow deploy; the `PARTY_MATCH_V3` flag turned on.
- Deploys during staff hours (warn first; last-good SHA recorded).

## Deferred

- DSPy/GEPA: only if P5 shows rules miss R2.
- Embeddings: only if lexical recall misses.
- Read-only computer use for unscripted screens.
