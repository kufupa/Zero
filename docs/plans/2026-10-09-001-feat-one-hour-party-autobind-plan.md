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

## Result (run 2026-10-09 08:05 → 08:55 UTC)
| Item | Outcome | Evidence |
|---|---|---|
| Lane A, one-click button | **Shipped** #96 (Haiku). Opus diff review, Greptile 0 comments | Server 336 + mail 263 tests pass |
| Lane B, booking card | **Shipped** #97 (Haiku). Greptile P1 (price match kept after a room change) fixed by Opus | 63 booking-card tests pass |
| Gate thread targeting | **Shipped** #98 (Opus): `NAVA_PREVIEW_THREADS=id1,id2` | 23 gate tests pass |
| Deploy D7 `3132d3c97` | READY, VPN + hotel probe OK, 0 pm2 restarts, 08:46 | ops-deploy ok |
| V-index | **PASS** on prod: Woolworths → #49, 360 Degrees Travel (Pty) Ltd → #113, Tourvest → #206, Pick n Pay → none, all ≤ 1 ms | tsx on EC2 |
| Staff bundle | Her pane reloaded onto D7 at 08:48:43 | nginx, Windows client |
| Gate (real browser) | 5 real threads, 0 blocked writes. TFG booking request: 8 fields pre-filled, company "Foschini Retail Group (pty) Ltd", correctly no button | gate-20261009T0848xxZ |
| V-chip (positive render) | **Not shown in a real browser.** No mailbox thread had Nava pre-fill a listed name. Covered by the QuoteWorkflowPanel unit test | — |
| V-quote | Not re-run: she was active, and the quote path is unchanged since the D6 proof (NCOR2B R1,360) | ledger 07:04 |
| Sweep | **Not run in the hour.** The index is written only when every prefix is done (hours). Idle-gated runner on EC2 (`/home/ubuntu/party-sweep-idle.sh`, log `/home/ubuntu/party-sweep.log`, stop: `touch /home/ubuntu/party-sweep.stop`). It runs 8 lookups per chunk once her Windows client has been idle 20 min | — |

### Lessons
- **The plan misjudged the sweep.** Reading `party-index-sweep.ts` first (5 min) would have shown "index written only at the end" before the plan promised an hour. Data step first, again.
- **The listed table is a stopgap.** Nava extracts full legal names ("Foschini Retail Group (pty) Ltd", "HWSETA (…)"), so 3 listed parties rarely match. The full index (sweep) is what makes the button common. Next: Nava picks from the index top-k (to-do #8).
- **The gate marks voucher emails as errors** when the voucher banner shows before analysis ends (1.3 s). That's a runner classification bug, not a pane failure.
- Live risk not proven: bind re-searches HMS for "Woolworths Holdings" (the button's name). The 04:35 lookup searched "Woolworths". Prove it once she's idle: `v8-live-checks.ts party "Woolworths Holdings" --kind company`.
