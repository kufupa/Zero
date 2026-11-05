# Box 1: Cloud `createReservation` tool, CLI-only

**Status:** ready to execute. Not started. Owner approved the direction on 2026-11-01.
**Executor:** one fresh coordinator (any strong model) plus up to two helper lanes.
**Replaces:** the timing and phasing of [the modular tools plan](2026-11-01-001-feat-hms-cloud-modular-tools-plan.md). Its research and evidence remain valid. Read it only when this file points to it.

---

## 1. Goal

Build one new, well-designed HMS Cloud tool, `createReservation`, that prepares and saves a new reservation from clean JSON input.

- **Prove it end to end from a terminal.** Save one Proof Labtest stay, then reopen it with the existing read tools and compare.
- **Check it against real requests.** Run it in prepare mode, without saving, on real booking requests already extracted into the production database.
- **No pane, no deploy, no email.** The staff pane and its old code stay untouched in this box.

**Why this first:** a Labtest create with readback already worked twice on 31 Oct. What's missing is a clean, reusable tool contract that a later caller (pane, agent, worker) can use. Proving that quickly gives a measured pace for estimating the rest.

---

## 2. Rules for every lane (keep these at the top of your context through compaction)

1. **Build new.** Write new tools in `apps/server-pilot/tooling/hms-cloud/`. The `tooling/playwright-quote/` business tools are old reference only: never edit them, never call them from new code. Existing Cloud modules and their shared login and guard helpers are fine to reuse.
2. **Product inputs, Labtest proofs.** Inputs must be general: any guest, rate, guarantee, party or CMS choice. Labtest is only the proof target. Never hard-code NGI, a rate or blank A/R as a product rule.
3. **Saves.** Save only Proof Labtest stays arriving in 2027 or later. On real stays you may open forms, type and explore, then close without saving.
4. **Never send.** CMS checkbox, message ID and recipient are optional. Suggest `03`, allow change or clear. A save with the send box checked returns `unsupported`.
5. **Never accept a cancellation-penalty dialog.**
6. **Every save:** screenshot the filled form, save once, screenshot the result, reopen the stay with a read tool and compare. Never retry blindly; read back first.
7. **One proof per distinct behaviour.** No per-field, per-rate or per-combination proofs. Good input design generalizes.
8. **Small tests.** One happy path and one refusal per tool. The live Labtest run is the real test.
9. **Small PRs.** One behaviour each, about 250 product lines and 300 test lines at most, never stacked on an unmerged PR. Evidence: in the last run, PRs under 300 product lines took 11–24 minutes median from open to merge; PRs over 300 took about 111.
10. **No new frameworks.** Reuse the existing session modules and `page-request-fence.mjs`. No new guard, queue or fixture system.
11. **The property read lock is legacy.** New Cloud tools don't use it. Don't add it or spend time on it.
12. **Don't block on small choices.** Pick the sensible default and record it in the decision log (section 9). Stop and ask the owner only for real-guest writes, sends, deploys, flag changes or a previously denied action.

**Held actions, never retry or reroute:** two cross-thread linker association checks were denied by automatic review. The earlier room-amend hold is cleared for Proof Labtest only (owner, 2026-11-01); on real stays room and rate changes stay unsaved.

---

## 3. What already exists (reuse, don't rebuild)

| Capability | Where | State |
|---|---|---|
| Blank Guest Stay session with sequential tool calls | `hms-cloud/booking-lookup-session.mjs` (`withBookingLookupSession`, `runBookingLookupTool`) and its `.md` | Live-proven on HRCEN |
| Guest profile search, inspect, select | `searchGuestProfiles`, `inspectGuestProfileCandidates`, `selectGuestProfile` | Live-proven |
| Dates, adults, child ages, dropdowns, text fields | `setGuestStayDate`, `selectGuestStayDropdown`, `setGuestStayChildAges`, `setGuestStayText` | Draft-proven |
| Room, rate, source | `selectRoomType`, `selectGuestStayRatePlan`, `selectGuestStaySourceBusiness` | Draft-proven, saved on Labtest |
| Agency, organization, A/R | `select…` party tools | Draft-proven; organization saved once on Labtest |
| CMS picker and send checkbox | `listCmsMessageIds`, `selectCmsMessageId`, `setCmsSendCheckbox` | Draft-proven |
| Labtest save | `hms-cloud/guest-stay-save.mjs` `saveNewLabtestStay` | Saved twice on 31 Oct. Requires Proof Labtest, NGI, blank A/R, CMS send off, plus a strict full-body match on 985 form keys |
| Fresh read of a saved stay | `hms-cloud/saved-stay-agent-session.mjs` (`read`), Record View reader | Live-proven |

**Prior proof artifacts:** `/tmp/hms-labtest-create-xyq2Hw/` holds the 31 Oct create result JSON and screenshots. Read it to see the real output shape. Evidence log: [coverage run, 09:22 and 09:41 checkpoints](../research/halloween/2026-10-31-hms-coverage-run.md#0922-utc-checkpoint--broad-create-proof).

**Known risk:** the 985-key full-body matcher rejected earlier create attempts on a field called `revenuevalue`; the cause was not recorded. Start with the already-proven field set. If it rejects, report the mismatching keys and propose checking only intended fields plus identity and no-send. Do not silently weaken it.

---

## 4. Tool contract (draft; the coding lane finalizes it after scouting)

Design rule: the tool returns enough for a human or an agent to decide the next step. It never returns just "ambiguous": it returns the candidates.

**Input**

| Field | Notes |
|---|---|
| `mode` | `prepare` (fill and stop) or `commit` (fill, save once, read back) |
| `propertyCode` | `HRCEN` for now |
| `guest` | `{ profileId }`, or `{ search: { lastName, firstName?, email? } }` |
| `stay` | `arrival`, `departure`, `adults`, `childAges`: number array, or `null` when the child count is known but ages aren't |
| `room` | `roomType`, `ratePlan` |
| `guaranteeType` | Any current option. Box 1 commit supports NGI only (current save guard) |
| `sourceOfBusiness` | Optional |
| `parties` | Optional `agencyId`, `organizationId`, `arAccountId` |
| `note`, `booker {name, contact}`, `cms {send:false, messageId?, recipient?}`, `billingReference`, `price` | Optional |
| `approval` | `{ by, at }`, required for `commit` |

Coverage check: the input must cover every field the existing pane sends today (`apps/server-pilot/src/ai/pane-stay-save.ts:64-86`), so a later pane swap is just field mapping.

**Output**

| Field | Notes |
|---|---|
| `outcome` | `prepared`, `saved`, `refused`, `needs_input`, `unsupported`, `uncertain` |
| `guestCandidates` | When the guest search is ambiguous: candidates with distinguishing fields |
| `applied` | Fields actually set on the form, with values HMS shows |
| `warnings` | Inputs accepted but not settable yet in box 1. **Never fail a save because of these.** |
| `confirmation` | On `saved` |
| `readback` | Fresh Record View fields after save, plus `mismatches` against intended values |
| `screenshots` | `before` and `after` paths in a private run directory (`/tmp/hms-cloud-create-<uuid>/`, mode 0700) |

**Box 1 settable fields:** guest, dates, adults, child ages, room, rate, source, note, organization. Everything else lands in `warnings` until box 2.

**Refusals:** real guest with `commit` returns `refused: real_guest_write_disabled`. Non-NGI guarantee with `commit` returns `refused: guarantee_not_supported_yet`. Unknown child ages return `needs_input`, never invented ages.

---

## 5. Lanes and order

Three lanes. Only lane A writes product code, so there are no file collisions.

| Lane | Work | Starts | Output |
|---|---|---|---|
| **A: tool (critical path)** | Short scouting pass on a blank Labtest form: list current guarantee, CMS and source options; check whether a price field and billing-reference field exist; check what the 985-key match covers. Then build `hms-cloud/create-reservation.mjs` plus `.md`, two tests, one live Labtest commit and readback. One PR. | Immediately | Merged tool, proof artifacts |
| **B: real inputs** | Read-only query of production booking extractions (table `mail_extraction`, booking-kind payloads; find the right kind and fields yourself). Map 10–20 recent Centurion requests to the contract and save them to a private file. When lane A has prepare mode, run each through it, unsaved. | Immediately | Summary of how many were set, warned, refused or ambiguous, plus top gaps. No personal data in the repo. |
| **C: box 2 scouting** | Unsaved observation only. On an existing saved Labtest stay: what changes when dates or occupancy are edited (repricing, cleared fields). Read the folio tab. Look at the Documents tab upload control without selecting a file. | Immediately | Short findings note that sizes box 2 |

**How to run things:**
- **Live HMS:** run from this VPS with Node 22, as the 31 Oct proofs did. Credentials come from AWS secret `nava-zero/server-pilot/infor-hms-read`, already used by the Cloud session.
- **Concurrent browsers:** separate sessions are fine. Never act on the same reservation from two sessions at once.
- **Production data reads:** use `.worktrees/ops-run.sh` with a `SELECT`-only script. Print counts, not ID lists (SSM truncates around 24k characters). Write raw rows only to a private `/tmp` file, mode 0600. Never write to the database. Never run tests against it.
- **Lane C may observe rate and room changes on a Labtest stay** (owner cleared the room-amend hold for Labtest only). Unsaved observation is enough for box 1.

---

## 6. Checks and merge

- **Typecheck:** `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app server-pilot`. Never run `tsc` locally; it has frozen this VPS.
- **Tests:** Node tests for `.mjs` tools run on Product EC2 against the exact head. Vitest via `bash /home/orca/bin/remote-vitest.sh`. Before Vitest, unset `DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. The Vitest helper once reported 0 for a failing test, so read the summary yourself.
- **Review:** Greptile Apex on the final head. Fix valid P0/P1 findings. Merge with `scripts/orch/merge-gate.sh`. Never `--no-verify`. No GitHub Actions.
- **Worktree:** isolated, from current `origin/main`.

---

## 7. Time, checkpoints and stop rules

| Clock (minutes) | Checkpoint |
|---:|---|
| about 45 | Scouting done; contract fixed; lanes B and C reporting |
| about 135 | Live Labtest commit saved and read back from the terminal |
| about 165 | Prepare mode run on real inputs |
| **about 200** (range 160–280) | PR merged, findings written, box 2 re-estimated |

Basis: about 165 raw minutes on lane A (scouting 30, coding 90, proof 15, review 30) × 1.2, the orchestration median actual/estimate ratio after removing superseded rows.

**Stop and report if:** total passes 280 minutes; any step passes twice its estimate; the PR exceeds 300 product lines (split it); a PR needs more than three review rounds; 90 minutes pass with no live proof; any held action would be required.

**Report every 30 minutes, 10 lines max:** proved, merged, blocked, next, revised ETA.

---

## 8. After box 1, and what is out

**Box 2** (estimate from box 1's measured pace; current guess about 500 minutes):
- **Create, full width:** guarantee choice, A/R, agency plus company, CMS, booker and contacts, billing, price if HMS exposes it, and multi-room as a loop over single create.
- **Amend:** dates, occupancy, rate if cleared, party.
- **Cancel:** preparation plus Labtest confirm, never touching the penalty dialog.
- **Finance and documents:** folio reader, and document upload if the Cloud UI supports it.
- **Quote:** honest partial-night coverage.
- **Then:** one pane swap for all workflows together.

**Out of scope:** creating or editing shared guest profiles; OCR and proof-of-payment intake; groups and rooming spreadsheets; payment posting; real-guest writes and real cancellations; native linked multi-room; pane redesign; removing the property lock; the open PR stack #815–#833 (parked).

---

## 9. Decision log (append; one row per choice)

| When | Decision | Why | Evidence |
|---|---|---|---|
| 2026-11-01 | CLI-only, no pane | Faster, no deploy, no old code | Owner direction |
| 2026-11-01 | New contract, not the old tool's CLI | Old contract is a last-line text parse | `pane-stay-save.ts:563-617` |
| 2026-11-01 | Keep screenshots | About 10 minutes; `PRODUCT.md` requires one on every write | Owner agreed |
| 2026-11-01 | Multi-room is a loop over single create | Several single-room bookings in a row | Owner direction |
| 2026-11-01 | Room-amend hold cleared for Proof Labtest only | Rate and room amend are box 2 scope; real-guest room/rate changes stay unsaved | Owner direction in chat |
| 2026-11-01 | Split fresh readback into a prerequisite PR | Keep each product diff within 300 lines | PR #854 merged |
| 2026-11-01 | Map unconfirmed child ages to `null` | Empty extractor arrays did not prove zero children | 20-request private sample |
| 2026-11-01 | Search organizations by native ID when supplied | IDs are not organization names | Unsaved HRCEN picker probe |
| 2026-11-01 | Keep the existing page fence for the new-stay session | Prevent the last temporary route removal from bypassing the context guard | Loopback Playwright 1.63 reproduction; PR #856 |
| 2026-11-01 | Continue an incomplete draft after safely closing an unresolved guest picker | Preserve candidates while staging other independent fields | PR #855 review and picker probe |
| 2026-11-01 | Keep price and billing reference as warnings for box 1 | The blank form showed a read-only total rate and a visible billing-reference input; neither has a guarded setter | `/tmp/hms-cloud-box1-scout-w1S2SjSt/observations.json` |
| 2026-11-01 | Commit NGI only; suggest CMS ID `03` without setting or sending it | The picker exposed 10 guarantee options and 6 CMS IDs; only NGI is covered by the current create guard | Same blank-form scout; 26 source options loaded separately |
| 2026-11-01 | Save one Proof Labtest stay and verify it in a fresh session | One authorized fake save is enough for box 1; do not repeat it blindly | Confirmation `3123652389-1`; no readback mismatches; private screenshots |
| 2026-11-01 | Treat the real-input replay as exploratory coverage, not an accuracy pass | The 20 recent extraction rows were not compared with source mail | Final head `7e201342`: 20 unsaved forms verified; 7 guests selected, 3 ambiguous, 8 not found, 2 without usable names |
| 2026-11-01 | Limit the route-teardown fix to new-stay sessions | The loopback reproduction covered this path; other session entry points were not audited | PR #856; browser regression and unsaved Labtest probe |
| 2026-11-01 | Re-estimate box 2 at 650–900 minutes, low confidence | Box 1 reached merge in about 61 minutes versus the 200-minute plan, but box 2 includes unproven repricing, folio and document work | One fake-stay observation; original 500-minute guess plus overlapping discovery allowances |

## Owner decisions

- **Room-amend hold: cleared for Proof Labtest only (2026-11-01).** Rate and room changes may be explored and saved on Proof Labtest 2027+ stays. On real stays they remain unsaved exploration. The two cross-thread linker association checks stay held.
