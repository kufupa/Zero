---
title: Add-Ons (Pomerado trial), booking UX, Da Vinci rates and handoff backlog — ROI speed plan
date: 2026-10-26
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
origin: docs/context/2026-10-26-addons-ux-intake.md
asks: 238-261
source_checkpoint: origin/main 02e326f79
---

# Add-Ons, booking UX, Da Vinci rates and backlog — speed plan

## Goal Capsule

- Objective: one ROI-ranked plan covering owner asks 238–261 plus every handoff leftover, so the owner can pick a coding window.
- Authority: planning only. No product code, install, flag, deploy, live real-guest write, send or or2 merge is authorised by this file.
- Evidence: four Luna max read-only lanes plus coordinator source reads, all at `origin/main` 02e326f79 or one to two commits behind it with the named files unchanged.
  - [Pomerado fit](../research/2026-10-26-pomerado-source-fit.md)
  - [Booking UX Assessment A](../research/2026-10-26-booking-ux-assessment-a.md)
  - [Da Vinci Assessment B](../research/2026-10-26-davinci-room-rate-assessment-b.md)
  - [Handoff, confirmation, shuttle](../research/2026-10-26-handoff-confirmation-shuttle.md)
- Stop condition: owner states coding hours and answers the holds in the last section.

---

## Product Contract

### Summary

Three findings change the plan versus the owner's starting assumptions.

1. Da Vinci "Room profile out of date or missing" is not a Standard Twin / STWN naming bug. It is the multi-room-type pooling guard in `apps/server-pilot/tooling/playwright-quote/quote-contract.mjs` (`composeAllocation`, `matchesProfile`). The guard fires when any observed row has a room code missing from `HRDAV.json` `roomCapacity`, a non-null building, or a nightly inventory above the profile capacity. HRDAV capacities were derived from the maximum inventory on one BAR shop night (2026-10-22), not the real room count. Any later night showing more free rooms of a type, or any room code outside the nine profiled, trips the guard. Single-room-type quotes skip it, which matches "multi-room-type only". Runtime confirmation still needs the failing job's captured rows.
2. The rate grid looks selectable but does nothing to the price. `StayRateGrid` clicks dispatch `room_rate_board_selected`, which stores `roomRateBoardSelections`; no quote, PDF or booking code reads that field. Only `RateCards` → `pickRate` patches the row and re-runs. This is a direct cause of "I expected the grid to be clickable".
3. Guest Stay already exposes an Add-Ons toolbar action (`add-ons.svg`) and `ADDONS_REQUIRED` / `GRIDPARAM_ADDON_SORT_*` fields in our live read manifest (`apps/server-pilot/src/hms/live-read-manifest.ts` lines 720, 750, 886). Add-On writing is a new action on a screen our tools already open, not an unknown screen. Item catalogue, posting rules and save semantics are still unobserved.

### Correction 2026-10-26 15:10Z: the pane error staff saw

Staff saw, in the pane, toast `Room type "STANDARD TWIN ROOM" is not one HMS knows. Choose one of: JNRSUI, … STWN.` (private screenshot `/home/orca/nava-research/screenshots/2026-10-26-faith-call/pane-room-type-error.png`). Cause: `hrdavKnownCode` in `apps/mail/lib/quote-workflow/staff-quote-bind.ts` (~line 426) accepts only an exact code or an exact label (`Standard Twin`). Email wording `STANDARD TWIN ROOM` fails before HMS is asked. Centurion uses the looser `knownRoomCode`. The owner's naming hypothesis (ask 259) was right for this error. Assessment B missed it because it traced the pooling guard instead. Both are real and separate:

| Error staff see | Where | Cause | Fix unit |
|---|---|---|---|
| `Room type "…" is not one HMS knows` | pane, before any HMS read | HRDAV label match is exact; no `room`/`bedroom` suffix, no case-insensitive containment, no fuzzy | A0a |
| `Room profile out of date or missing` | server, multi-room-type quote | HRDAV capacities from one night's maximum; any higher inventory or unprofiled code trips the pooling guard | A1, A2 |

Also: a toast that tells staff "Choose one of: JNRSUI, EXKNGB…" is raw codes. Staff copy should offer the room-type dropdown already on the row instead.

### Shuttle answers from the private Faith call (Da Vinci)

Read once at `/home/orca/nava-research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.txt` (ASR, garbled; quotes are short and approximate).

| Question | Answer from the call | Line |
|---|---|---|
| Provider | Spoken "Jarrod/Jarat"; the HMS Arrival Type dropdown in the screenshot reads **Jarat Tours** | 47, screenshot |
| Sequence | Book the stay with the shuttle Add-On → email the transport desk/provider → get confirmation + invoice → send charge/confirmation to the guest together → delete the Add-On in Infor | 75–87 |
| When is the Add-On removed | "as soon as we receive the confirmation" from the provider; the provider/transport desk then posts the charge, so keeping the Add-On would double charge | 45, 81 |
| Who pays whom | Guest pays the hotel; "we pay the transport"; the transport desk posts the charge to the guest when they arrive; accounting detail unknown to staff ("it's accounts") | 96–108 |
| Where arrival details go | Guest Stay → Guest Details tab → Arrival / Departure Information → **Arrival Type = Jarat Tours, Arrival Time (e.g. 14:00)**; reception reads it there | 147–156, screenshot `hrdav-guest-details-arrival-type.png` |
| Centurion | Not in the call. Corpus: transfer threads exist (46/3,599 = 1.3% in the Centurion export) with per-trip prices R100–R800, but no provider email or Jarat token found; workflow unknown | [shuttle corpus](../research/2026-10-26-shuttle-corpus.md) |
| Volume | Da Vinci mailboxes 8/123 threads (6.5%) mention shuttle/transfer; 1 verified outbound to `jarattours.co.za` (flight + drop-off time + pax; no name, conf no or price) | same |

Corpus verdict: shuttle is a real Da Vinci workflow (6.5% of sampled threads, keyword screen) but provider-email evidence is n=1, so B4 (provider draft) is held until more outbound samples or a staff template exist. B1b (remove Add-On + set Arrival Type/Time) does not depend on it.

Product meaning: a shuttle request is three HMS edits plus one email, with Nava drafting and staff sending. (1) Add the billable Add-On at create. (2) Draft the provider email. (3) After the provider confirms, remove the Add-On and set Arrival Type/Time. The Guest Details arrival fields are a small, well-located write, and a good first target for Pomerado.

### Requirements

Booking UX (asks 244–253)
- R1. Child ages are one numeric control per child, prefilled from email, never comma text.
- R2. Guests appear as rows (name, adult/child, age) linked to room-type rows; room quantities stay authoritative and each count is shown once.
- R3. A rate-grid click selects that exact room/rate/board and re-prices, the same as a rate card.
- R4. "All rates" stays visible with the reason when a filter hides everything.
- R5. Booking is a visible step; result copy distinguishes provisional from confirmed using HMS status.
- R6. Per-room guest overrides are labelled as overrides with a reset.
- R7. One total per scope; nested chrome reduced only after a rendered review.
- R8. No HMS option removed; Outlook pane and webmail panel both ship.

Da Vinci rates (asks 243, 258–260)
- R9. The profile guard names the mismatching room code, night and inventory in the diagnostic, and staff copy says which class failed (not set up / profile mismatch / no rate / HMS down).
- R10. HRDAV capacities come from a real room-count source, not one night's maximum.
- R11. Background prefill uses the property profile's room map, not the generic Centurion map (Standard King is `SKNG` generically but `STKNG` at HRDAV).

Add-Ons (asks 238, 239, 256, 257)
- R12. Read-only Labtest DOM read of the Guest Stay Add-Ons tab on HRCEN and HRDAV before any writer LOC.
- R13. Writer is Zero-owned: `previewAddOns` / `commitAddOns`, per-row outcomes, readback before any retry, never replays reservation create.
- R14. Pomerado, if used, is an authoring aid on Labtest only, not the staff runtime.
- R15. Screenshots stay private; a small field/DOM manifest is committed instead.

Confirmation and shuttle (asks 254, 255)
- R16. Staff-first confirmation uses a separate staff recipient, never guest or booker contact, proven on Labtest before any real stay.
- R17. Shuttle automation stays parked until provider, payer, removal trigger and note field are answered.

### Scope Boundaries

- Deferred: shuttle provider email, any real-guest Add-On write, multi-mailbox pairing code, R-SEED (held on DS1-P3b), WIRE provenance follow-up (after #607).
- Outside this plan: or2 units, `/tmp/or2`, deploy train ownership.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Fix the Da Vinci guard by improving its evidence, not by loosening it. The guard prevents pooled-inventory overbooking. Loosening it without a room-count source would trade a visible block for a silent wrong quote.
- KTD2. Grid select reuses the rate-card path (`pickRate`) so there is one way a price changes. A second price path would be a duplicated control.
- KTD3. Pomerado stock host cannot attach to our CDP browser (`session.ts:15` rejects CDP). Using it means either signing in inside its own browser, where the model sees the page, or writing a custom host on its low-level executor. Recommendation: run the Add-On DOM read with our own tools first, then decide whether Pomerado saves time on a single screen.
- KTD3a. Owner decision 15:05Z: Pomerado is the Add-On build path, no fallback tool. Its models are hard-coded to `gpt-6.1-sol` / `gpt-6-luna` (`typescript/src/models/models.ts`) and it uses `@openai/agents`, so pointing it at our Azure endpoint means setting the Agents SDK default client. Unverified until B0. Its stock host refuses CDP, so it signs in inside its own browser and does not share our HMS slot. HMS allows a second session per user (staff and bot already share), but the one-browser-lock rule is ours: B0/B1 run only when no prod HMS job is in flight for that property, or under a second login. Repo pushed 2026-10-26 15:03Z, 716 stars.
- KTD3b. (superseded by KTD3a, kept for record) Fallbacks to Pomerado (Haiku max Exa lane, 13 calls, 2026-10-26, unfiled vendor claims): Libretto (saffron-health, MIT, v0.6.36, records then emits deterministic TS, CDP attach documented, `--read-only` mode, pre-1.0) and Playwright MCP `--codegen` for capture with plain Playwright replay (Apache-2.0, `--cdp-endpoint`). None documents dry-run or readback; the write gate is Zero's either way. Stagehand 4.1 is already installed but its runtime was dropped for native Playwright (plan 2026-09-17-002 KTD1). Deciding fact: does a Libretto script replay as plain Playwright with no Libretto import, daemon or model key.
- KTD4. Add-On composes after create as a separate idempotent step keyed per row, never inside the create transaction.
- KTD5. `gate.sh` needs structured Vitest failures. `remote-vitest.sh` prints dot output and lanes may not edit `/home/orca/bin`. Either the owner approves a JSON reporter there, or `gate.sh` issues its own remote command.

### Units

LOC from lane source reads; product and test counted separately. Coder routing follows AGENTS.md.

Owner steer 2026-10-26 15:05Z: Pomerado only for Add-On/arrival writes (no fallback tool), Azure endpoint is ZDR so page content to the model is fine, cut over-plumbing (MISTAKES 2026-10-19 party v3; 2026-10-20 "many tiny gate units"; retro list of over-big units U11a/U11b/UDV-2). Changes below: D1–D5 operations scripts dropped from this run (they are coordinator tooling, not staff value; `gate.sh` needs a `/home/orca/bin` change); C2 recipient feature replaced by a Labtest probe first; B1 Pomerado is now the build path, not optional.

| ID | Unit | Area | Needs | Coder | Product LOC | Test LOC | Test file | Mount owner |
|---|---|---|---|---|---|---|---|---|
| A0a | HRDAV room label match: case-insensitive, strip trailing "room/rooms", accept label contained in text when exactly one label matches; staff copy offers the row's room dropdown, not code list | staff-quote-bind | none | Luna | 15–30 | 20–30 | `apps/mail/tests/staff-quote-bind.test.ts` | n/a lib |
| A1 | Guard diagnostic names code/night/inventory; staff copy by cause class | quote-contract | none | Grok 4.6 | 30–60 | 30–50 | `apps/server-pilot/tooling/playwright-quote/quote-contract.test.mjs` | n/a server |
| A2 | HRDAV capacity from real room counts | profile data | A0 read | Luna | 10–20 data | 10–20 | `property-profile.test.mjs` | n/a |
| A3 | Grid click = pick (re-price) | pane | none | Luna | 30–60 | 30–50 | `apps/mail/tests/stay-rate-grid.test.tsx` | QuoteStayStep via QuoteWorkflowPanel |
| A4 | Property-aware prefill room map | server prefill | none | Luna | 40–80 | 30–50 | `apps/server-pilot/tests/quote-ready*.test.ts` | n/a |
| A5 | Per-child age fields | pane | none | Luna | 60–100 | 40–60 | `apps/mail/tests/stay-room-builder.test.tsx` | StayCard |
| A6 | Booking step + provisional/confirmed copy | pane | none | Luna | 60–100 | 45–75 | `quote-workflow-panel.test.tsx`, `booking-card.test.tsx` | QuoteBookingHost |
| A7 | Guest override label + reset | pane | none | Luna | 45–75 | 40–65 | `quote-people-step.test.tsx` | People, BookingCards |
| A8 | One total per scope, flatten chrome | pane | screenshot review | Luna | 25–55 | 20–35 | `stay-room-builder.test.tsx` | StayCard |
| A9 | Guest rows linked to room rows | pane + session | A5 | Grok 4.6 | unsized: scope lane first | unsized | TBD | QuoteStayStep |
| B0 | Pomerado setup: Node 24 isolated dir on EC2 (or VPS), Azure endpoint via Agents SDK client, sign in to HMS inside its own browser, Labtest guest only | ops | none | Grok 4.6 | 0 product | 0 | setup log | n/a |
| B1 | Pomerado mint `add_guest_stay_addon` (read the Add-Ons item list first, then one Labtest add) on HRDAV | HMS write | B0 | Grok 4.6 + Pomerado | generated | readback | Labtest readback | n/a |
| B1b | Pomerado mint `remove_guest_stay_addon` + `set_arrival_type_time` (Guest Details Arrival Type/Time) | HMS write | B0 | Grok 4.6 + Pomerado | generated | readback | Labtest readback | n/a |
| B2 | Wrap minted ops in Zero: gate (`PANE_WRITE_ADDON=lab`), property from mailbox, per-row result, readback before retry, never re-runs create | server-pilot hms | B1 | Grok 4.6 | 120–200 | 80–120 | new `apps/server-pilot/tests/hms-addon-writer.test.ts` | n/a |
| B3 | Add-On rows (item, nights, price) in booking card; shuttle toggle sets Add-On + later "Provider confirmed → remove + set arrival" button | pane | B2 | Luna | 100–180 | 60–90 | `apps/mail/tests/booking-card.test.tsx` | QuoteBookingHost → BookingCards |
| B4 | Provider email draft (Jarat Tours template from corpus fields), staff sends | drafts | shuttle corpus lane | Luna | 60–120 | 40–60 | TBD from existing draft tests | Needs-you / reply composer |
| C1 | Labtest probe: does Infor create send a confirmation, and to which field | canary lane | none | deterministic script or Pomerado read | 0 | 0 | private log | n/a |
| C2 | Staff confirmation recipient (only if C1 shows Infor sends) | create + pane | C1 | Grok 4.6 | sized after C1 | — | — | BookingCards |

A0: read-only lookup of the failing HRDAV job's captured options and of a real room-count source (HMS room master or factsheet). Canary lane, no code.

### Handoff backlog kept (not started)

| Item | State |
|---|---|
| Queue dead-letter-aware idempotency | open |
| `staff_quote_private_file_invalid` mis-classed transient | open |
| Prepared-quote attach retry exhaustion | open |
| Nightly main baseline opens GREEN when red; pane test failures; duplicate Vite types | open |
| Azure-drafted reply route mismatch | open |
| Argon 429 fallback | open |
| Needs-you exact-message canary; priced Da Vinci PDF canary; staff bundle proof | successor / owner proof |
| Reply-check `REPLY_RECHECK` | hold: 24 h shadow, no flip |
| R-SEED | held on DS1-P3b |
| WIRE provenance follow-up | after #607 |
| Multi-mailbox pairing | design only |
| Evals: quote bar n≥10, prefill eval, staff feedback capture | open; quote bar not passed |

---

### ETA basis (measured, ledger `~/.claude/eta-ledger.jsonl`, 2026-10-26 15:15Z)

| Kind | n | Actual p50 min | Actual p75 min |
|---|---:|---:|---:|
| code-ui | 70 | 41 | 75 |
| code-server | 163 | 43 | 75 |
| review (Greptile round) | 24 | 20 | 27 |
| deploy | 45 | 7 | 14 |
| live-hms | 44 | 22 | 85 |

No Pomerado or Add-On write has a measured median. B0/B1 use the "new write type" floor from the 2026-10-26 Add-On plan (≥120 min to first Labtest save), labelled ballpark until B0 runs.

| Track | Longest real chain | p50 | p75 |
|---|---|---:|---:|
| A: DV room fixes + grid + pane UX (A0a, A1–A8) | one unit (all parallel) + 1 P1 round + deploy + DV live quote | 41+20+7+22 = **90 min** | 75+27+14+85 = **~3.3 h** |
| B: Pomerado Add-On + shuttle arrival | B0 setup → B1 mint → B2 wrap → B3 pane, each + review, + deploy + Labtest canary | ballpark **4–5 h** | **~7 h** |
| C1: confirmation probe | one Labtest create read | 22 | 85 |

Run A and B in parallel: wall clock ≈ B. A ships first and fixes the error staff saw. A pane units start after #607 merges (its pane-file edits are +53 lines, append-only; review ETA ~30–45 min per the other chat at 14:58Z).

### Other big ROI items from the handoff and workstreams (not in this run)

| Rank | Item | Why it matters | State |
|---|---|---|---|
| 1 | Quote bar: ≥10 real threads, rate plan + nightly price = staff | The only "done" gate for quote; not passed (5/8 on 10-20, n<10) | open |
| 2 | DV priced-PDF and Needs-you owner canaries | Proves DV quote end-to-end for staff | successor (other chat) |
| 3 | Queue: dead-letter-aware idempotency; private-file error mis-classed transient; prepared-quote attach retry exhaustion | Silent lost quotes | open, small |
| 4 | One reusable HMS login across jobs (ask 132) | ~75% of party time is login + navigation | open |
| 5 | Golden truth ≥100 rows for party / classifier | Bars require it | open |
| 6 | Nightly main baseline + `gate.sh`/`canary.sh` | Saves coordinator time per run, not staff time | deferred |
| 7 | Multi-mailbox one workstation | design only | deferred |

---

## Verification Contract

| Unit | Done signal |
|---|---|
| A1–A2 | One live HRDAV multi-room-type quote canary on the deployed SHA returns a priced or correctly classed result |
| A3–A8 | Remote tests pass on head SHA; viewer run green; staff bundle load seen in nginx after the last deploy; Outlook and webmail both render |
| B0, C1 | Private manifest written; no real-guest write |
| B2 | Labtest Add-On saved and read back per row on HRCEN, then HRDAV, same SHA |
| D1–D5 | Fixture tests pass; never run against live or2 state |

## Definition of Done

Quote bar (rate plan and nightly price equal staff on ≥10 plannable threads) moves on prod after the last fix. Merged or deployed is progress only.

---

## Appendix: owner decisions recorded 2026-10-26 ~15:05Z

1. Coding window: decide after the max-parallel ETA (above).
2. Pomerado: approved as the only Add-On tool; Azure ZDR endpoint, so model egress is acceptable.
3. Shuttle: answered from the Faith call and screenshot (section above); corpus lane for Centurion and invoicing evidence.
4. `gate.sh`: dropped from this run (over-plumbing; coordinator tooling).
5. Timing: pane units wait for #607 merge; server and Pomerado units start immediately.

---

## Revision 2026-10-26 16:00Z: run-now plan (supersedes Units/ETA above)

Owner steer: Cursor `auto` coders (Greptile Apex reviews every PR), Luna max (Codex) for the quote-bar truth build, everything in this run, middle-ground live proof, faster deploys, Grok 4.7 xhigh plan review.

### Where the old 90 min came from (evidence)

| Step | Measured | Source |
|---|---|---|
| PR size vs launch→merge | <50 lines 37 min; 50–150 46; 150–300 37; 300+ 42 (size does not predict time) | or2 retro §3 |
| Remote gate call | median 97 s, p90 204 s | or2 retro §3 |
| Greptile Apex | 2m24s–3m40s, n=5 today | `gh pr checks` #591 #593 #607 #609 #611 |
| File-lock waits | 91–139 min per blocked unit | or2 retro §3 |
| Red-main stalls | ~60 min on the critical path | or2 retro §3 |
| Busy lanes | 3.0 of 8 | or2 retro §4 |
| Deploy (manual today) | 7.5 min; script is serial sync → pnpm install → build server → build SPA → rsync → pm2 → health → VPN assert | other chat 15:4xZ; `apps/server-pilot/deploy/deploy-ec2.sh` |

The coding itself is minutes. The rest was waiting. Main is green now (#605–#610), #607 merged 15:34Z, so locks and red-main stalls are gone if every lane starts at once and rebases at merge.

### Lanes (all start together, own Orca worktree off main, Cursor `auto` unless noted)

| Lane | Units | Product lines | Test |
|---|---|---|---|
| L1 | A0a DV room label match + staff copy | 15–30 | `apps/mail/tests/staff-quote-bind.test.ts` |
| L2 | A1 guard diagnostic; A2 real HRDAV capacities (after 5-min read-only room-count lookup) | 40–80 | `quote-contract.test.mjs`, `property-profile.test.mjs` |
| L3 | A4 property-aware prefill room map | 40–80 | `apps/server-pilot/tests/quote-ready*.test.ts` |
| L4 | A3 grid click = pick | 30–60 | `apps/mail/tests/stay-rate-grid.test.tsx` |
| L5 | A5 per-child ages → A8 totals | 85–155 | `stay-room-builder.test.tsx` |
| L6 | A6 Booking step → A7 override label | 105–175 | `quote-workflow-panel.test.tsx`, `booking-card.test.tsx` |
| L7 | Pomerado B0 setup → B1 add Add-On → B1b remove Add-On + set Arrival Type/Time (Labtest, HRDAV) | generated | Labtest readback |
| L8 | B2 wrap (gate `PANE_WRITE_ADDON=lab`, property, per-row result, readback) → B3 pane rows; starts on the minted op signature | 220–380, 2 PRs | `hms-addon-writer.test.ts`, `booking-card.test.tsx` |
| L9 | C1 Labtest create → does Infor send a confirmation, which field | 0 | private log |
| L10 | Queue: dead-letter-aware idempotency key; `staff_quote_private_file_invalid` permanent; prepared-quote attach retry | 60–120 | existing `staff-quote-job.test.ts` |
| L11 | Quote bar truth (Luna max, Codex): future-arrival staff-priced individual threads, n≥10, staff PDF/reply → rate plan + nightly price; then replay on prod | 0 product | `docs/research/2026-10-26-quote-bar.md` |
| L12 | Reusable HMS login across jobs (ask 132): scope lane first (Haiku max, 10 min), then build if ≤250 lines | TBD | TBD |
| L13 | Owner-ask follow-ups from other chat: `ops-deploy --migrate` CA fix (1 line); #607 P2 mid-Undo lock; 6 stale `rate-*` tests | 10–40 | named tests |

Dropped: dispatch/gate/eta/canary scripts (coordinator tooling). Held: R-SEED (migration + DS1-P3b), multi-mailbox (design), ≥100-row truth sets (n available is ~12 future-priced threads; not reachable today).

### Live proof (middle ground)

Per lane: unit test on the seam + Greptile Apex. Per track after one deploy: one live check.

| Check | Property | Pass |
|---|---|---|
| Quote with "STANDARD TWIN ROOM" + a second room type | HRDAV | priced; no room-type toast; no profile error |
| Grid click re-prices; child-age fields; Booking step | HRDAV pane, viewer run | screenshots |
| Add-On add → remove → Arrival Type/Time set, readback | HRDAV Labtest | 3 rows read back |
| Confirmation probe | HRCEN or HRDAV Labtest | recipient field identified |
| Quote bar replay | both | score on n≥10 |

### Deploy

Batch: one deploy after the A lanes merge, one after B. Not per PR. The train already runs in the background, so a deploy costs no coordinator time, only wall time on the last link. A deploy only matters when a live check needs it. Possible later cut (not this run): skip `pnpm install` when the lockfile is unchanged, and skip the server build for pane-only diffs.

### ETA (rough, to be closed in the ledger)

| Chain | p50 | p75 | Basis |
|---|---:|---:|---|
| L1–L6, L10, L13 → merged | 35 min | 50 | code ~10 + gate ~2 + Apex ~3 + 1 fix round ~10 + rebase ~5 |
| + deploy + A live checks | +15 | +25 | 7.5 min deploy + 1 HRDAV quote |
| L7 → L8 → deploy → Labtest | 90 min | 150 | Pomerado setup unmeasured; ballpark |
| L11 quote bar | 40 min | 70 | research p50 26 / p75 52 + one prod replay |
| L12 login reuse | scope 10 min, then decide | — | unknown |

### Risks

- Pomerado on Azure: SDK client override unproven; if it fails, L7 stalls (no fallback by owner choice).
- Merge conflicts in `quote-workflow-panel.tsx`, `booking-card.tsx` (L4/L5/L6/L8): expected, rebase at merge.
- HRDAV HMS lock: L2 lookup, L7, L9 and live checks share one browser; run them serially in one canary lane.
- Quote bar may still be < 10 rows (pool was ~12 threads on 10-20; prices may have moved).
- 13 lanes = 13 Greptile reviews and ~13 Cursor sessions in parallel; VPS rule bans local tsc/vitest, all gates remote.
