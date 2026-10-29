# Product details

These task-specific sections extend `PRODUCT.md`. Read the relevant sections before assessing, planning, implementing or evaluating product behavior. Proposed bars remain proposals unless owner-confirmed.

## Front door specifics

A TMC cancellation notification needs no action; a person asking to cancel is a cancellation. A group shuttle request is group/event; other shuttle requests are amendments. Vouchers are parked after finding the stay. For evaluation labels, use staff outbound action first; otherwise require two models to agree and send disagreements to the owner. The owner recorded exact-host exclusions for Profitroom, Tiket.com, RateTiger and H-Pay (`hospitality.cloud`); Travelit and TBO remain in scope. Current source has exceptions for human Profitroom enquiries and non-notice H-Pay finance mail. Reconcile that conflict with the owner before changing those paths; see the [original request](../../PRODUCT-ASKS-HISTORY.md#asks-logged).

## Pane (staff)

Keep the V1 look. One primary action per step. Hide dead controls.

- Header: active mailbox + sync status, then selected email, then **read as** (same vocabulary as Needs-you: quote / booking / amendment / cancellation / voucher-POP / other).
- **Quote contact — appears in the PDF** at top (name / email / phone). Company/agency on the quote is a separate field. Edits save to this request; they do **not** write HMS unless staff hits the explicit book action.
- Stay by date range. Room-**type** rows with counts and occupancy. Totals. No “Room 1 / Room 2”.
- Rates: HMS rates + one-off/saved + required “Authorised by” for discounts.
- After an HMS match: facts + **one** Copy confirmation + Open HMS only if the target is real. Hide Find after a result.
- Quote review: PDF, Excel, editable reply, save unsent draft. Nava never sends.
- Attachments: say **Download to this computer** if that is all the code does. Attaching into HMS is a separate, approved write.
- Needs-you: short to-do list. Dismiss has Undo and a Finished path.
- Client-requested follow-up: about 66 hours after a staff quote states a validity or hold window, draft an in-thread follow-up for staff review and add a Needs-you item; never send. The original client example was a 72-hour quote; scope for other windows is unsettled.

## Done (this is the overnight gate)

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
