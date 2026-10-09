---
title: "feat: One-hour sprint: Nava auto-binds the party (contract rates without an HMS trip)"
type: feat
date: 2026-10-09
execution: code
window: T+0 → T+60 (research done; code, review, deploy, live proof)
---

# One-hour sprint: party auto-bind

## Goal
When Nava reads "Woolworths" in an email, the pane shows **"Use Woolworths Holdings (#49)"**. One click binds the HMS id, and the quote prices the contract rate (NCOR2B R1,360 instead of BAR R1,940). There's no trip into HMS and no ~1 min live search.

## Why this, why now (evidence)
- A party is named on 70–80% of quote and booking mail. Contract rates work end to end (#93), but only after a manual pick.
- Today, Nava's pre-fill sets only text (`apps/mail/lib/quote-workflow/session.ts:525-537`). `findParty` runs only on "Search HMS now" (`nava-pane.tsx:232`, `:1867`).
- #84's instant typeahead exists server-side (`party-index.ts:130-145`), but **is not wired**: `partyIndex` is never passed in `nava-pane.tsx`. The index file is also absent on the server.
- Lessons from the retro: budget 1× for code and 2–3× for HMS proof, start the live proof early, and do the data step first.

## Scope
| In | Out (later) |
|---|---|
| Party index sweep on EC2 (A–Z, both kinds) | 2-letter deep sweep beyond what's truncated |
| Wire typeahead + an auto "Use X (#id)" chip from Nava's pre-filled name | Background live `findParty` on every email (HMS load) |
| Booking card: agency and org fields pre-filled from the quote's picked party | Rate-plan dropdown (needs a catalog sweep, days) |
| Live proof: Woolworths email → chip → quote → NCOR2B | Pane PDF/Excel act-mode runner (~1 day) |

## Lanes (parallel)
| Lane | Model | Work | T+ |
|---|---|---|---|
| **HMS** | Opus (single HMS owner) | Run `pnpm -C apps/server-pilot exec tsx scripts/party-index-sweep.ts --delay-ms 15000 --max-runs 30` on EC2. A full A–Z sweep for both kinds is ~52 lookups at ~1 min each, so it does **not** fit in the hour. Run 30, pause (exit 3), and resume after the proofs. The gaps between runs leave the HMS lock free for staff during the pilot. Verify "Woolworths" → #49 and "360" → #113 once those letters are done | 0 → 40, resume after 60 |
| **A: chip** | Haiku (max) | `nava-pane.tsx`: pass `partyIndex={partyIndexFromTrpc(trpcClient)}` to the panel and `PartyPicker`. `party-picker.tsx`: when the field holds Nava's pre-filled name and the index returns hits whose `matchKey` contains it, show the top hit as a chip "Use {HMS name} (#{id})". One click → `onPick` (binds the id; the server re-verifies at bind, `pane-party-lookup.ts:265-291`). Several hits → show the top 3 chips. None → keep "Search HMS now". Tests: chip appears and binds; no index → no chip; multiple hits → 3 chips | 0 → 35 |
| **B: booking card** | Haiku (max) | `booking-card.tsx`: when the quote header has a picked company or agency, pre-fill Booking agency and Organization with the **HMS name** (the runner types it into HMS, and the create proof bound "360 degrees Travel" and "Woolworths" this way). Room type: show a select from the 9 schema enum values (`booking-draft.ts:205-231`) instead of read-only text. Tests | 0 → 30 |
| **Review** | 2nd Haiku (checklist) + Greptile | Picks must always carry a nativeId; no unverified id is bound; chip copy has no "Luna" | 35 → 42 |
| **Ship** | Opus | Merge A, B → deploy (~8 min) | 42 → 50 |
| **Prove** | Opus | Gate on a Woolworths-mentioning thread (screenshot shows the chip). Live quote harness with org 49 → NCOR2B. Index typeahead `Woolworths` → #49 | 50 → 60 |

## Verification
- V-chip: in the gate screenshot of a Woolworths email, the chip "Use Woolworths Holdings (#49)" is visible.
- V-quote: `v8-live-checks.ts quote … --org 49` → `contractChosen NCOR2B`.
- V-index: typeahead for "woolw" returns #49 in under 1 s.
- Prod: health 200, pane 200, VPN OK.

## Risks
| Risk | Mitigation |
|---|---|
| The sweep collides with live proofs or staff on the HMS lock | `--max-runs 30` pauses it before the proofs. A 15 s delay frees the lock between runs |
| A bad chip binds the wrong party | Only exact or contains index hits, staff click to bind, and the server re-verifies the id against HMS at bind |
| Index stale | The picker shows the index age. Re-run the sweep weekly |
| The sweep doesn't finish in the hour (expected) | It's resumable. Any partial index still gives chips for the letters covered. If W isn't covered yet, V-chip uses a party from a covered letter |
</content>
</invoke>
