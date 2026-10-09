# Overnight v8 handoff (2026-10-09)

Status: final, 2026-10-09 ~06:00 UTC, main at `4979df0f` + #84 merged; D4 (`4979df0f`) live. Evidence: run ledger (`.superpowers/sdd/v8-progress.md`, UTC; times before 01:59 are estimates), merged PRs, live EC2 checks.

Plan: `docs/plans/2026-10-08-007-feat-overnight-v8-nava-pane-plan.md`. Teaching guide: `docs/pilot/2026-10-09-teaching-script.md`. Install doc: `docs/pilot/2026-10-08-install-and-onboarding.md`.

---

## TL;DR

- 29 v8 PRs merged on 2026-10-09 (#58–#89, except #79, #81 and #84). "Merged" means on main. Deployed: D2b (4435c5c3) was live at 03:07 UTC. D3 (31ae92cb4, the current main) was started at 04:45 UTC and its result is not recorded yet.
- Proven live on EC2: rateshop reads (03:07), a Labtest create that was saved and cancelled (03:14), party lookups for 360, Woolworths and Tourvest (04:35, on the fix build), and the 1.0.17 installer served with a verified SHA.
- Not proven yet: two full quotes with PDF and Excel (V3), and a clean viewer gate run (V1 failed 03:57 and was fixed in #88 at 04:42). The QUOTE_TRACE_ASYNC decision waits on V3.
- Staff copy on main has no Luna text left (#72 and #82). The install doc still says Luna in places.
- Go or no-go for today's pilot call (2026-10-09): **GO for quote + party picker + allowances + Excel + voucher find + links.** Create stays `off` until you set the flag (see Flags). Contract-rate quotes are merged but **not yet proven end to end** (see V3).

---

## Still open at handoff

Clearly open items. Each needs Opus before the call.

- **#79 contract-rate wiring: MERGED** (05:21, after 4 Greptile P1 rounds: unpicked parties, public fallback, >5 rows, incomplete searches). Deployed in D4 (`4979df0f`).
- **#84 party typeahead: MERGED** (05:40). Not yet deployed (next deploy). No index file exists on the box yet, so typeahead falls back to live HMS search until the sweep runs.
- **Preview gate (V1): PASS** after #88. Latest 20 emails: 20/20 analysed, 0 timeouts, 0 blocked writes (`gate-20261009T045007Z`). 8 real quote/booking/voucher threads: booking request pre-filled 13 fields (`gate-20261009T045320Z`). That run exposed a **P0** (a signature image `image001.jpg` blocked the quote) → fixed in #90, re-verified in `gate-20261009T053510Z` (no attachment blocker). Two voucher threads still showed "Nava is reading the email…" at the 90 s screenshot: voucher PDF analysis is slow.
- **Party index sweep: NOT RUN.** It needs ~150 HMS lookups (~1 h+). Run it on a quiet morning: `cd /home/ubuntu/repos/zero && pnpm -C apps/server-pilot exec tsx scripts/party-index-sweep.ts --delay-ms 20000 --max-runs 150` (resumable).
- **Deploys:** D3 `31ae92cb4` and D4 `4979df0f` both READY, health 200, pane 200, VPN OK. Prod flags: all unset → `RESERVATIONIST_PANE_SAVE` off, `HITL_LEDGER` off, `QUOTE_TRACE_ASYNC` off, `QUOTE_RATE_CONTEXT` on (applies only when staff pick a party).
- **V3 not proven end to end.** HMS quote runs succeed live (rate shop org #49 → BCO1B/NCOR2B flagged; staff-path runs with org 49 resolved "Woolworths Holdings"), but the server-side harness (#91) failed after capture, so a full quote → PDF → Excel through the pane path is still unproven. **Do one live quote on the call before relying on it.** V7 happens on the call.
- **Gallery:** `aws s3 sync s3://nava-zero-mail-845242190536-af-south-1/nava-preview-gate/<run>/ ./gallery/` with run ids above (screenshots mask guest fields). Live viewer for you: https://nava.legacyhotels.co.za/nava-preview (sign in as usual).

---

## What's live

"Live" here means merged to main. Merge times are GitHub's (UTC).

| PR | Merged (UTC) | Feature | Flag or setting | Evidence |
|---|---|---|---|---|
| #58 | 00:13 | v8 plan and auto-loaded context | none | docs |
| #59 | 00:25 | Add-in 1.0.17 pinned; install doc updated | none | V5 |
| #60 | 01:32 | Separate dinner, lunch, office transfer, shuttle, other and notes on quotes | none | labels on main; quote runs not yet proven (V3) |
| #61 | 04:09 | Party picker: one Find in HMS under Agency for company or agency; fail-closed runner | `QUOTE_RATE_CONTEXT` (on unless exactly `off`) | V2 party lookups, 04:35 |
| #62 | 01:10 | Pane booking modes off/lab/on with agency, organisation and note | `RESERVATIONIST_PANE_SAVE` | V4 Labtest save, 03:14 |
| #63 | 02:10 | HITL decision ledger tables and analyse recording | `HITL_LEDGER` (exact `on`) | migration 0046 applied 02:25; flag off |
| #64 | 01:19 | Open HMS and Copy confirmation; billing refs no longer treated as confirmations | none | Open HMS goes to the sign-in page only |
| #65 | 01:16 | NavaPane extracted from the outlook-pane route | none | refactor |
| #66 | 02:10 | Approved quote downloadable as Excel | none | wired by #82 |
| #67 | 01:19 | Deploy papercuts: husky auto-fix; backlog readiness as a warning | none | D1 exit 0 |
| #68 | 01:25 | `VITE_PUBLIC_HMS_LANDING_URL` baked into the mail build | `VITE_PUBLIC_HMS_LANDING_URL` | in the bundle at D1 (01:58) |
| #69 | 03:15 | Reload idle panes onto a newer release, at a safe boundary | none | with #76 |
| #70 | 01:32 | Pane cancel modes off/lab/on | `RESERVATIONIST_PANE_SAVE` | penalty text recorded, not clicked (03:14) |
| #71 | 01:46 | Open HMS and Copy beside the booked confirmation | none | — |
| #72 | 01:46 into #69's branch; on main from 03:15 | Staff copy says Nava, not Luna | none | "See what Nava did in HMS" on main |
| #73 | 03:23 | Find the booking for voucher and proof-of-payment mail | none | live check not recorded yet |
| #74 | 01:59 | Test: cancel charge refusal through the cancel dialog | none | test only |
| #75 | 02:16 | `/nava-preview` viewer and real-browser gate runner | none | ops tooling |
| #76 | 04:09 | First-run steps only; ⋯ menu (Check connection, Replay tour, Feedback by email or WhatsApp, About); status line; safe-boundary reload | none | UI deployed at D2c (04:14) |
| #77 | 02:53 | EC2 gate for `/nava-preview` (no-login session, pinned host, private output, S3 gallery) | none | gate run failed at 03:57 (V1) |
| #78 | 02:53 | Record HITL tool runs (quote, PDF, stay, cancel, lookups) | `HITL_LEDGER` | flag off |
| #80 | 02:53 | Read-only live-check pack | none | ops tooling |
| #82 | 04:36 | Download Excel wiring; party picker wiring; no-Luna sweep | none | — |
| #83 | 02:35 | Main CI: classify quoteWorkbook in the gate runner | none | main CI green again |
| #85 | 03:23 | Create runner: Guest Stay open retried | none | fix found live at 03:14 |
| #86 | 03:47 | Gate install skips husky (EACCES on EC2) | none | — |
| #87 | 04:29 | One Guest Stay opener for every HMS runner | none | V2, 04:35 |
| #88 | 04:42 | Viewer preview mode (skips onboarding); app-shell reads allowed | none | V1 rerun open |
| #89 | 04:45 | Party dialog: type into the Run-row box, wait for the dialog, find Run by text | none | V2, 04:35 (fix build) |

Open PRs:

| PR | State | Feature | Flag or setting |
|---|---|---|---|
| #79 | open, base main | Contract rates from the picked company or agency (HMS-flagged only); "No contract rate found" | `QUOTE_RATE_CONTEXT` |
| #84 | open, stacked on #79 | Party typeahead index and sweep | — |
| #81 | open (this docs PR) | Teaching guide and handoff | — |

In flight at drafting (not merged at the time of the last ledger row): none listed.

---

## Flags for the owner

| Flag | Where | State (ledger) | Target | When | Who |
|---|---|---|---|---|---|
| `RESERVATIONIST_PANE_SAVE` | server env | Unset, so off. Create stays off in prod until the flag is set (01:12) | `lab` (Labtest stays, arrival 2027 or later) or `on` (real guests) | owner decides, after the proofs are reviewed | owner decides; operator sets |
| `HITL_LEDGER` | server env | Off. Migration 0046 is applied on prod (02:25) | `on`, to start collecting decisions | owner decides; #78 is merged | operator |
| `QUOTE_TRACE_ASYNC` | server env | Off (#47). No decision yet | Keep off until V3 passes (two full quotes with PDF and Excel). Then decide | after V3 | operator |
| `LUNA_ANALYSE_WARMER` | `apps/server-pilot/deploy/pm2.config.cjs` | `on` | keep `on` | none | none |
| `VITE_PUBLIC_HMS_LANDING_URL` | mail build env | Baked in (#68); in the bundle at D1 | keep | none | operator |
| `QUOTE_RATE_CONTEXT` | server env (#61) | On unless exactly `off` (kill switch in `quote-rate-switch.ts`) | keep on; `off` stops every party lookup | none | operator |
| `PANE_STAY_LOOKUP` | server env | On by default; `off` disables Find this booking | keep on | none | none |

- The Labtest save at 03:14 ran `create-lab-stay.mjs` directly on EC2 (not through the pane route), so no prod flag was changed. The pane Book button stays copy-only until you set `RESERVATIONIST_PANE_SAVE`.
- `QUOTE_TRACE_ASYNC` (#47) stays off: its gate was two full live pane quotes, which were not proven tonight (see V3).

---

## Install

- Installer: `NavaOutlookSetup.exe`, version **1.0.17**
- Download: https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe
- SHA-256: `0d25d56a5ce473e6bc2fe25f5d2d3ea8fc9c6e022ba9b6388be4fd7ce4c64bbc`
- The ledger records the artifact SHA as the manifest value (addin PR #8, merged 47d0d9d, about 00:16 UTC, estimated), and the served SHA verified on the EC2 downloads (about 00:18 UTC, estimated). The S3 instance profile returned 403, so the downloads use a presigned fallback.
- The install doc's own check says "verified on the server 2026-10-09 00:30 UTC". Do not use the 1.0.12 hash in the 2026-10-02 security record.
- Staff steps: `docs/pilot/2026-10-08-install-and-onboarding.md`, Part 1. Step 3 (the hash check) is for the operator or IT only, and is left out of the teaching guide.
- The install doc still uses the old name in places (docs only). No staff-facing Luna copy is left on main.

---

## Live proofs

From the plan's verification contract (lines 366–372), with the ledger's times (UTC).

| Gate | What the plan requires | Status | Evidence |
|---|---|---|---|
| V1 | Viewer run, 20 real emails: 0 crashes, intent shown, pre-fill on quote and booking emails, screenshots in the gallery | **PASS** after #88: 20/20 analysed, 0 timeouts, 0 blocked writes (`gate-20261009T045007Z`); booking request pre-filled 13 fields (`gate-20261009T045320Z`); signature-image blocker found + fixed (#90), re-verified (`gate-20261009T053510Z`) | S3 `nava-preview-gate/<run>/` |
| V2 | Party: 360 → #113, Tourvest → Company #206, an org quote returns a non-BAR plan | **PASS** at 04:35 on the fix build: 360 → agency #113, Woolworths → org #49, Tourvest → org #206. Rateshop at 03:07 (D2b): org #49 flagged BCO1B×5 and NCOR2B×5; agency #113 flagged none (BAR) | run evidence `.private/playwright-quote/runs` on EC2 |
| V3 | Quote: 2 live quotes → PDF and Excel, totals match, allowance lines correct | **NOT PROVEN end to end.** Live HMS quote runs succeed (org #49 resolved, contract rows flagged); the server-side harness (#91) failed after capture, so pane quote → PDF → Excel is unproven | Do one live quote on the call first |
| V4 | Create: Labtest booked with agency, org and note; confirmation read back; no guest email; cancelled | **PASS (runner level)** at 03:14: Labtest 48315098-1 saved via `create-lab-stay.mjs` on EC2 with agency "360 degrees Travel", org "Woolworths", commission 10% auto; no guest email; cancelled via `cancel-stay.mjs` (penalty text recorded, not clicked). Not yet via the pane route; note field not visually confirmed | screenshots in ledger |
| V5 | Add-in: 1.0.17 published, SHA matches, install doc updated | **PASS.** Artifact SHA matches the manifest and the served SHA (about 00:16 and 00:18 UTC, estimated). Pin and install doc merged (#59, 00:25) | addin PR #8; #59 |
| V6 | Prod: 8788/8789 ok, pane 200, VPN ok, migration applied, flags as listed | **PASS** for D1 `4ab79674`, D2a `c469cbf3` (+0046), D2b `4435c5c3`, D2c, D3 `31ae92cb4`, D4 `4979df0f`; all READY + VPN OK; flags all unset (defaults) | ledger |
| V7 | First staff use: `analyseSelection` 200 from her IP after install | **On the call today** (2026-10-09). Check nginx for `analyseSelection` from her IP after she installs 1.0.17 | — |

Deep links (03:16 UTC): every OSRESV and OSRESS GET bounces to the login page, even when logged in, with or without a confirmation number and with prefill. Record links are not possible. The shipped approach stays: the landing page and Copy confirmation (K10 confirmed). The messenger APPURL format is untested.

Bugs found live and fixed:

| When (UTC) | Bug | Fix |
|---|---|---|
| 02:35 | Main CI red: the viewer's classification test did not know the new `quoteWorkbook` procedure | #83 (02:35) |
| 03:14 | Every EC2 create failed at the Guest Stay navigation | #85 (merged 03:23) |
| 03:36 | Gate install failed: husky EACCES on the EC2 pnpm install | #86 (merged 03:47) |
| 03:57 | Viewer gate 20/20 timeout: pane stuck on first-run onboarding (fresh profile); app-shell reads blocked | #88 (merged 04:42) |
| 04:19 | Party lookup failed live: the same Guest Stay navigation | #87 (merged 04:29) |
| 04:19 | Party dialog: the query went into the saved-search combo, not the name input. Run is an ExtJS `a.x-btn` with no ARIA role | #89 (merged 04:45); Opus patch 4fea6749 on the fix branch |

---

## Open risks

1. **V1 not re-run.** The real-browser gate is the proof for the viewer. The last run failed; the fix merged at 04:42.
2. **V3 not proven.** Two full quotes with PDF and Excel are not recorded, so `QUOTE_TRACE_ASYNC` stays off.
3. **Contract rates (#79) are open.** The pilot call uses BAR. The contract-rate line comes later.
4. **#84 is stacked on #79.** Merge order matters. A stacked PR merges into its base branch, not main (lesson, 2026-10-09).
5. **Voucher find (#73) has no live check recorded.** Its label is "Find the booking in HMS" on voucher and proof-of-payment mail.
6. **Booking and cancelling are off in prod.** `RESERVATIONIST_PANE_SAVE` is unset. The Labtest proof needed the save path, and the flag change is not recorded.
7. **Windows is not tested on a real PC.** The install doc says the first real PC is the test (known gap 7).
8. **Shared mailbox.** Insert draft in Outlook is refused unless the shared mailbox is the default Drafts store (install doc, known gap 3).
9. **Ledger times before 01:59 UTC are estimates.** Use the GitHub merge times for PRs.

---

## Next steps

1. Before the call (2026-10-10, 08:00 UK, 09:00 SA): set the flags per the owner's decision. `RESERVATIONIST_PANE_SAVE` stays off or goes to `lab`. `HITL_LEDGER` can go to `on`. `QUOTE_TRACE_ASYNC` stays off until V3 passes.
2. Opus: rerun the viewer gate on current main (V1). Record the result and the gallery URL.
3. Opus: confirm D3 (31ae92cb4) for V6: health, pane, migration and flags.
4. Opus: run one live full quote (PDF and Excel) to close V3. Then decide `QUOTE_TRACE_ASYNC`.
5. Opus: #79, rebase on main, review and merge. Then retarget #84 to main, run the party index sweep on EC2, and merge.
6. Confirm IT has approved the installer and the server hash matches, before the call.
7. Owner: fill the support contact and follow-up date in the teaching guide.
8. Owner: confirm the call slot and the test stays for the booking step (test data only).
