# Archived 2026-11-02: golden-set Done gate

Superseded by the owner on 2026-11-02 (see PRODUCT.md "Done"). Kept for history and old citations; not a current constraint.

## Done (historical overnight gate)

**Done = score on a golden set of real past mail**, not merged, not deployed, not “3 live threads went green.”

Target mix (~30): quote 12, amend 6, cancel 4, create 3, channel/system skip 5. Answer key from read-only HMS, not from whatever the agent last saw in Outlook. Overnight goal = move that scoreboard. Tests are allowed as a gate only when they encode this class of mail, not one thread.

The golden set is versioned. Compare scores only on the same rows; when rows change, re-score the old build on the new rows before claiming a gain (2026-10-14: the set moved 30 → 27 → 26 rows overnight; v1 was re-scored each time, so 15/26 → 24/26 is a fair comparison). The golden set scores extraction and action class only; quote prices and party binds have their own bars below.

**Pass bars per workflow** (proposed in the 2026-10-14 retro; owner confirms or edits). Separately, for the 2026-10-20 plan, the owner accepted at least 85% quote recall and a target of at least 100 independent outbound-grounded quote rows. This is distinct from pricing and front-door agreement; verify scope before treating it as a universal target. See [decision D19](DECISIONS-2026-10-20.md#owner-decisions-1530z-ask-163).

| Workflow / check | Pass bar | Unacceptable error |
|---|---|---|
| Party bind | 0 wrong auto-binds on the HMS answer key; auto-bind ≥ 70%; right party in top 3 ≥ 95% | any wrong bind → `PARTY_MATCH_V2` off |
| Quote (prepared or staff-run) | rate plan + price per night = what staff sent, on every plannable real ask in the proof set (≥ 10 threads) | a price that differs with no HMS-side reason |
| Front-door classifier | ≥ 90% agreement with outbound-grounded labels, ≤ 1% failures, at production concurrency and effort | a real booking/quote ask skipped |
| Amend / cancel find | right reservation found ≥ 95% on golden rows | a different guest's booking shown as the match |
| Any pane change | viewer run green + staff bundle load seen in nginx after the last deploy | "deployed" claimed without the bundle load |

A slice is **done** only when its bar passes on prod after the last fix. Merged, deployed or "tests green" is progress, not done.

Research already done: `docs/research/2026-10-13/README.md`. Do not redo it. Refresh the corpus snapshot if the mail mix is stale.
