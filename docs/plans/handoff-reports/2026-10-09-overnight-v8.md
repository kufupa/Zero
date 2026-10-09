# Overnight v8 handoff (2026-10-09)

Status: **draft skeleton**, docs only. Nothing here was deployed, migrated or run live. Items marked **TODO(opus)** need Opus to confirm or fill in.

Plan: `docs/plans/2026-10-08-007-feat-overnight-v8-nava-pane-plan.md`. Teaching guide: `docs/pilot/2026-10-09-teaching-script.md`.

---

## TL;DR

- 14 v8 PRs are merged to main (#58–#60, #62–#68, #70–#71, #74–#75). The HITL ledger (#63) is merged with its flag off. "Merged" does not mean deployed. Deployed state: **TODO(opus)** (V6).
- Still open: company and agency search and contract rates (#61, #79), voucher find (#73), ⋯ menu and first-run steps (#76), idle-pane reload (#69), HITL tool runs (#78), live-check pack (#80), EC2 gate (#77).
- Staff screens on main still show the old name in places. The rename (#72) is stacked on #69, so it reaches main only with #69.
- Installer 1.0.17 is pinned (#59). SHA-256 below.
- Teaching guide drafted. Steps for pending features are marked TODO(opus).
- Go or no-go for the call: **TODO(opus)**.

---

## What's live

"Live" here means merged to main. Deployment to EC2 is not checked in this file.

| PR | Feature | Flag or setting | Notes |
|---|---|---|---|
| #59 | Add-in 1.0.17 pinned; install doc updated | none | SHA-256 in the Install section |
| #60 | Separate dinner, lunch, office transfer, shuttle, other and notes on quotes | none | labels checked on main |
| #62 | Pane booking modes with agency, organization and note | `RESERVATIONIST_PANE_SAVE` (off, lab, on) | off unless set |
| #63 | HITL decision ledger tables and analyse recording | `HITL_LEDGER` (exact `on`) | migration `0046_hitl_ledger` on main |
| #64 | Open HMS and Copy confirmation; billing refs no longer treated as confirmations | none | Open HMS goes to the HMS sign-in page only |
| #65 | NavaPane extracted from the outlook-pane route | none | refactor |
| #66 | Approved quote downloadable as Excel ("Download Excel") | none | |
| #67 | Deploy papercuts: husky auto-fix, backlog readiness as a warning | none | |
| #68 | `VITE_PUBLIC_HMS_LANDING_URL` baked into the mail build | `VITE_PUBLIC_HMS_LANDING_URL` | default in `apps/server-pilot/deploy/deploy-ec2.sh` |
| #70 | Pane cancel modes (off, lab, on) | `RESERVATIONIST_PANE_SAVE` | |
| #71 | Open HMS and Copy beside the booked confirmation | none | |
| #74 | Test: cancel charge refusal through the cancel dialog | none | test only |
| #75 | `/nava-preview` viewer and real-browser gate runner | none | ops tooling |
| #47 (earlier) | Quote trace async | `QUOTE_TRACE_ASYNC` (exact `on`) | flag off on main |
| #50 (earlier) | Pane waits for the background quote trace | `QUOTE_TRACE_ASYNC` | client side |
| config | Instant pane (analyse warmer) | `LUNA_ANALYSE_WARMER=on` | set in `apps/server-pilot/deploy/pm2.config.cjs` |

Not on main yet:

| PR | State | Feature | Flag or setting |
|---|---|---|---|
| #61 | open (supersedes #48) | Unified company and agency search ("Find in HMS"), fail-closed runner, sender aliases | `QUOTE_RATE_CONTEXT` (kill switch; on unless exactly `off`) |
| #79 | open, base `feat/v8-party` | Contract rates from the picked company or agency (HMS-flagged only); "No contract rate found" message | `QUOTE_RATE_CONTEXT` |
| #73 | open | Find the booking for voucher and proof-of-payment mail | **TODO(opus)** |
| #76 | open | First-run steps only; ⋯ menu (Check connection, Replay tour, Feedback, About); empty state; pane look | **TODO(opus)** |
| #69 | open | Reload idle panes onto a newer release | **TODO(opus)** |
| #72 | merged into the #69 branch only | Say Nava, not the old name, in staff copy | none; not on main |
| #77 | open | EC2 gate for `/nava-preview` (no-login session, pinned host, private output, S3 gallery) | none; ops only |
| #78 | open | Record HITL tool runs (quote, PDF, stay, cancel, lookups) | `HITL_LEDGER` |
| #80 | open | Read-only live-check pack | **TODO(opus)** |

Still in flight when this was drafted (not merged): U2 (NavaPane extraction), U6 (party picker), U8-C (separate allowance fields). Status: **TODO(opus)**.

---

## Flags to flip

| Flag | Where it is set | Default on main | Target | When | Who |
|---|---|---|---|---|---|
| `RESERVATIONIST_PANE_SAVE` | server env | unset means off; only exact `lab` or `on` opens the save path | `on` | after review of the proofs (plan K6) | owner decides; operator sets |
| `HITL_LEDGER` | server env | off unless exact `on` | `on` | after migration `0046_hitl_ledger` is confirmed applied on prod (V6) and #78 is reviewed | operator |
| `QUOTE_TRACE_ASYNC` | server env | off unless exact `on` | `on` | after two passing live quote runs (U16) | operator |
| `LUNA_ANALYSE_WARMER` | `apps/server-pilot/deploy/pm2.config.cjs` | `on` | keep `on` | none | none |
| `VITE_PUBLIC_HMS_LANDING_URL` | mail build env | default in `deploy-ec2.sh` | confirm prod value | before the call | operator |
| `QUOTE_RATE_CONTEXT` | server env (#61, #79) | not on main; on unless exact `off` | `on` | with #61 and #79 | **TODO(opus)** |
| `PANE_STAY_LOOKUP` | server env | on by default; `off` disables | keep on | none | none |

- Plan K6 says `RESERVATIONIST_PANE_SAVE` ships as `lab`. Nothing in the repo sets it, so on EC2 it is off unless the environment sets it. **TODO(opus):** confirm the value on the server.
- #47's title says `QUOTE_TRACE_ASYNC` is flag off. No PR body describes what the flag changes. **TODO(opus):** document it before flipping.

---

## Install

- Installer: `NavaOutlookSetup.exe`, version **1.0.17**
- Download: https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe
- SHA-256: `0d25d56a5ce473e6bc2fe25f5d2d3ea8fc9c6e022ba9b6388be4fd7ce4c64bbc`
- Verified on the server 2026-10-09 00:30 UTC (per the install doc). Do not use the 1.0.12 hash in the 2026-10-02 security record.
- Staff steps: `docs/pilot/2026-10-08-install-and-onboarding.md`, Part 1. Step 3 (the hash check) is for the operator or IT only, and is left out of the teaching guide.
- The install doc still uses the old name in places. **TODO(opus):** update after #69 and #72 land.

---

## Live proofs

From the plan's verification contract (lines 366–372). Status and evidence are for Opus to fill in.

| Gate | What the plan requires | Status | Evidence |
|---|---|---|---|
| V1 | Viewer run, 20 real emails: 0 crashes, intent shown, pre-fill on quote and booking emails, screenshots in the gallery | TODO(opus) | TODO(opus) |
| V2 | Party: 360 → #113, Tourvest → Company #206, an org quote returns a non-BAR plan (needs #61, #79) | TODO(opus) | TODO(opus) |
| V3 | Quote: 2 live quotes → PDF and Excel, totals match, allowance lines correct | TODO(opus) | TODO(opus) |
| V4 | Create: Labtest booked from the pane with agency, org and note; confirmation read back; no guest email (or flagged); cancelled | TODO(opus) | TODO(opus) |
| V5 | Add-in: 1.0.17 published, SHA matches, install doc updated | Install doc updated (#59). Publication and SHA match: TODO(opus) | TODO(opus) |
| V6 | Prod: 8788/8789 ok, pane 200, VPN ok, migration applied, flags as listed | TODO(opus) | TODO(opus) |
| V7 | First staff use: `analyseSelection` 200 from her IP after install | TODO(opus) | TODO(opus) |

Gallery URL: **TODO(opus)**.

---

## Open risks

1. **Old name on screen.** Main still shows "See what Luna did in HMS" and some older copy in the find and cancel messages. #72 reaches main only with #69. If #69 does not merge before the call, staff will see the old name. The teaching guide does not say it.
2. **Company and agency search and contract rates (#61, #79) are open.** Section 4 of the teaching guide is marked TODO(opus). Skip it if they are not merged.
3. **Voucher find (#73) and the ⋯ menu (#76) are open.** Their steps in the teaching guide are marked TODO(opus).
4. **Booking and cancelling are off by default.** They open only when `RESERVATIONIST_PANE_SAVE` is `lab` or `on`. Plan K6 says it ships as `lab`, but nothing in the repo sets it. Confirm the server value.
5. **`QUOTE_TRACE_ASYNC`** has no PR body that describes what it changes. Document it before flipping.
6. **`HITL_LEDGER=on`** needs migration `0046_hitl_ledger` on prod first (V6). Not run from this branch.
7. **Shared mailbox.** Insert draft in Outlook is refused unless the shared mailbox is the default Drafts store (install doc, known gap 3).
8. **Windows is not tested on a real PC.** The install doc says the first real PC is the test (known gap 7).
9. **#77 gate: Greptile P1, "uploaded galleries retain guest names".** The fix is pushed to `feat/v8-preview-gate` (#77). It needs re-review before the gate runs on EC2.
10. **In flight at drafting time:** U2, U6 and U8-C. Sections 3 and 5 of the teaching guide may change.

---

## Next steps

1. Review and merge #77 after the P1 fix. The gate then runs on EC2 (Opus only).
2. Review #61 and #79. They unblock the company and agency section and the contract rates.
3. Decide #73 and #76 for the call: merge them, or cut those steps.
4. Opus fills in V1–V7 and the gallery URL.
5. Opus resolves every TODO(opus) in the teaching guide before the call.
6. Flip flags after review, per the table above.
7. Decide whether #69 (and so #72) goes in before the call, or accept the old name on screen.
8. Confirm IT has approved the installer and that the server hash matches before the call.
9. Finish the ledger and the Hindsight retro (plan Definition of Done).
