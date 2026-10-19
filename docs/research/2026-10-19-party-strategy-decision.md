# 2026-10-19 party lookup: strategy decision (history + search hybrid)

Party = the HMS company/travel-agency profile whose contract rate prices a quote. "Bind" = Nava picks the profile itself; staff still see and can change it. All prod numbers: read-only SQL (`begin('read only')`, counts only) via `ops-run.sh`, 2026-10-19 17:20–17:40Z. Offline numbers: `/home/orca/nava-research/testsets/party-truth.jsonl` (167 HMS reservations read 2026-10-16, arrivals 2026-09-12 → 11-01, 76 sender domains) joined to `party-truth-conf-domain.json`. Prior evidence reused: [party lookup evidence](2026-10-19-party-lookup-evidence.md) §1–12.

## 1. Answer

Don't swap strategies; stack them. **History first, live search second, staff pick last.** v3's loop stays as the search step (with #408, v2's picker on v3's rows). Sender history becomes a strong, bindable candidate for agencies. Staff picks write back to history so it grows. Score all three on the same big set before any flag.

## 2. What we know (evidence)

| # | Fact | Number | Source |
|---|---|---|---|
| E1 | Real prod rate today, mails that name a party (30 days, no SynXis/notices/staff) | v2 bound **18/66 (27%)** | SQL q25 |
| E2 | Why v2 missed the other 48 | rows came back, no pick 31 · no rows 9 · duplicate tie 8 | SQL q26 (reason-text buckets, approximate) |
| E3 | Missed mails whose sender has booking history | 21/48; all named-party jobs with history 31/66 (47%) | SQL q25/q26 |
| E4 | Agency on the booking (Centurion mix) | 107/167 (64%); company 115/167; both 74 | truth set |
| E5 | History → agency, leave-one-out, unanimous | **82/107 right, 0 wrong**, 25 abstain | truth set |
| E6 | Same, honest (only bookings that arrived **earlier**) | **65/107 right, 1 wrong**, 41 abstain | truth set |
| E7 | History → company (sender never books via an agency, earlier only) | 37/115 right, **2 wrong** | truth set |
| E8 | History vs staff quote picks **by HMS id** | 10/16 right, 0 wrong (earlier only) | SQL q24; small |
| E9 | Live replay, 22 staff-confirmed mails | v2 21/22 · v3 14/22 · v3 right profile in top 3 20/22 · 0 wrong both | evidence §12 |
| E10 | Speed per mail | v3 p50 34 s · v2 prod p50 65 s | evidence §12 |
| E11 | #408 (v2 picker runs on v3 rows when v3 can't pick) | READY, 48/48 tests, Greptile 0 comments; live effect unproven | PR #408 |
| E12 | `party_sender_map` today | 41 agency + 25 company hosts (29/14 with ≥2 bookings); loaded once from a 10-16 file; **no live writer** — staff picks never feed it | code `load-party-sender-map.ts`, SQL |
| E13 | History is already wired, but as a weak hint that can never bind | `party-match-v2.ts` ~531 `'sender_domain_alias', 'weak'` | code |
| E14 | Duplicates | Tourvest is 14/107 agency bookings; IATA on the booking picks the copy in 4 of 5 groups | evidence §11 |

The single E6 wrong: a sender whose 4 earlier bookings used the brand profile, then one booked under the parent group's profile. Brand vs parent, not a random error.

## 3. Options

| Option | Expected bind rate on named-party mail | Wrong-bind risk | Build | Verdict |
|---|---|---|---|---|
| A. v2 as is | 27% (E1) | 0 known | 0 | Baseline |
| B. v3 loop + #408 only | ≈ v2's rate on found rows, 2× faster; unproven on a big set | 0 seen on 42 | merged/ready | Keep, as the search step |
| C. History only | ~60% of agency mail from known senders (E6); nothing for new senders (~53% of jobs, E3); companies weak (E7) | 1/66 agency, 2/39 company | ~40 lines | Not alone: half the mail has no history |
| **D. Hybrid: history → search → staff pick, + learn from staff picks** | history covers ~half (E3); search covers the rest at v2/v3 level; history grows every staff pick | agency 1/66 (E6); staff verify every bind | ~120 lines, 2 PRs | **Recommend** |
| E. Local copy of every HMS profile (sweep, P7) | Same as D, but search takes 1 ms and can be replayed offline | same | big (sweep, freshness, per-login) | Later, only if D's search step is the bottleneck |
| F. Never bind, show top 3 | 0% auto; right one in top 3 ~91% (E9) | 0 | 0 | Already the fallback inside D |

## 4. Recommended design (D)

1. **History step.** For agencies: a sender host with ≥ 2 earlier bookings that all name the same agency → strong candidate. Store the HMS **id** (and IATA), not just the name, so a duplicate copy resolves itself. Companies: only when the sender never books through an agency (E7), and never on freemail.
2. **Confirm in HMS.** Search the history name once (same batch as the email's own names). Bind only if HMS returns that id, or a single row with that name. No copy match → staff pick.
3. **Email beats history.** If the email names a different agency/company, the email wins and history is only a suggestion (covers the brand → parent switch in E6).
4. **Search step** for everything else: v3 loop + #408.
5. **Learn.** When staff pick or accept a party on a quote, upsert `(host, kind, nativeId, name, support+1)`. Our own DB table only; no HMS write.
6. Flags: history bind and v3 both default off; on = owner, after §5.

## 5. Acceptance (before any flag)

Same rows for every variant: the 167 + new big-set bookings (178 left to read, run `party-bigset-read2`, ~50 min) + staff quote picks.

| Check | Bar (PRODUCT.md) |
|---|---|
| Wrong binds, by HMS id where known | 0 on staff-pick truth; ≤ 1 explained on reservation truth |
| Auto-bind on mail that names a party | ≥ 70% target; report v2 / v3+#408 / hybrid side by side |
| Right profile in top 3 | ≥ 95% |
| Time per mail | ≤ v2 prod p50 (65 s) |

History is scored offline (no HMS). Search steps need one night live replay (read-only, property lock, after 19:00 SAST).

## 5c. Big-set score (2026-10-19 ~19:05Z)

Read-only HMS read of 194 more conf numbers from outside-sender threads (prod mail since 2026-07-27): 88 found, 86 usable after the join. Total truth now **253 bookings, 104 sender domains** (was 167 / 76). Leave-one-out, unanimous history, freemail skipped:

| Kind | Support ≥ 1 | Support ≥ 2 |
|---|---|---|
| Agency | **109/150 right, 0 wrong**, 41 abstain | 95/150 right, 0 wrong |
| Company (sender never books via an agency) | 27/159 right, 3 wrong | 15/159 right, 1 wrong |

- Agency history holds up on the larger set (73% bind, 0 wrong). Company history stays weak: most companies book through an agency, so the sender is the agency.
- By IATA/id (new rows only): of 11 senders with ≥ 2 same-kind bookings, 7 always use the same copy and 4 mix. Example: one corporate sender used Tourvest copy TOU001 4× and 77206905 1×. The unanimity rule abstains there and staff pick, which is the right outcome.
- H1 records history only when the sender's host matches the recorded party name (Greptile P1 on #410), so a corporate sender doesn't learn its agency as its own party.
- Still unscored: v2 / v3+#408 on the same rows needs a live replay (needs the inbound mail per conf, not just the booking); planned tonight after deploy.

## 5d. Live replay after deploy (2026-10-19 ~20:10Z, `347c188bc`, flags on, read-only, same 42 mails)

| | v2 (old prod) | v3 + #408 | + history candidates |
|---|---:|---:|---:|
| Right profile bound (22 staff-confirmed) | 21/22 | 19/22 | 19/22 |
| Wrong binds | 0 | 0 | 0 |
| Right profile in top 3 | — | 20/22 | 20/22 |
| Bound on 20 v2-misses | 0 | 2 | 1 |
| p50 / p90 per mail | 65 s / 86 s | 38 s / 46 s | 40 s / 48 s |

History turned strong on 1 of 14 history hits. Cause: the "email beats history" rule treats any differently spelled name of the same kind as a contradiction (exact normalised compare), so "Nexus Travel" in the email vs "XL Nexus" in the map, or "Rennies BCD" vs "RENNIES TRAVEL", downgrade history to weak. Also the map was loaded on 10-16 by name only (no `native_id`), so the duplicate-copy path never fires. Next: (1) contradiction = no shared distinctive token, not any spelling difference; (2) backfill `native_id`/`iata` from the 253-booking read; (3) never search the hotel's own name ("Legacy Hotels", 2 of 3 remaining misses).

## 5b. Owner calls (2026-10-19 ~18:00Z, this chat)

| # | Call |
|---|---|
| D1 | History binds **both** agencies and companies; "fair fight", staff verify |
| D2 | Booking (reservation) truth wins over quote picks; either can be a staff slip, so staff verify |
| D3 | 1 wrong agency bind in ~66 is fine, as long as the pane shows every option with the info staff use in HMS (IATA, city, address, id) and switching is instant, no new HMS lookup |
| D4 | Flags can flip any time (owner OK). Coordinator pushback: flip `PARTY_MATCH_V3` only once #408 is live and re-scored (v3 alone binds less than v2) |

## 6. Unknowns (honest)

| Unknown | Why it matters | How we close it |
|---|---|---|
| Truth set has names, not ids, for 167 rows | Duplicate copies can't be scored | Big-set read stores `companyid` + IATA; staff picks have ids |
| Quote party ≠ reservation party sometimes (Nexus Travel #27 on quotes, "XL Nexus" on bookings) | History from bookings could suggest the wrong profile for quotes | Prefer staff quote picks over booking history when both exist; test on E8 rows |
| Coverage of new senders | ~half of jobs get no history help | Search step + staff-pick writer; re-measure weekly |
| #408's live gain | We expect v2-level binds at v3 speed; not measured | Night replay |
| Thread → booking link | Conf numbers found in a thread may belong to another booking in that thread | Arrival/guest cross-check on a 10-row sample |
| Owner's "70% agency" | Truth set says 64% of found bookings carry an agency | Big set will refine it |
| Rate impact of a wrong agency | Wrong contract rate on a quote staff could send | Staff verify every bind; 0-wrong bar |

## 7. Retro (why this took 3 h)

| Mistake | Effect | Rule now in AGENTS.md / MISTAKES.md |
|---|---|---|
| Built the LLM loop before scoring the simple deterministic baseline (sender history, already in the code as a weak hint) | ~3 h on a loop that tied v2 at best | Score the cheapest deterministic baseline on the truth set before building an agent |
| Scored on 42 mails, 22 of them circular (v2 bound, staff accepted) | Couldn't tell better from worse | ≥ 100 truth rows by id, independent of the system under test |
| Patch on patch (P5b, P5c) on one design | AGENTS.md round-3 design flag | Stop at round 2; re-plan with the baseline |
| Lanes 25–40 min for 30-line diffs | Gates, not code: remote typecheck + tests + 2 Greptile rounds | Small diffs: 1 Greptile round |
| Long HMS reads launched without a lock-busy retry | Big-set read died after 16/194 when staff took the lock | Batch HMS readers retry `LOCK_BUSY` with backoff |
| History table loaded once, never written | Staff picks taught the matcher nothing for 3 days | Every learned table names its live writer before merge |
