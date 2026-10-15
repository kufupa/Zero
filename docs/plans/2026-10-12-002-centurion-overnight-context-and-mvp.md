# Centurion Nava: overnight context pack and MVP (2026-10-12)

**Status:** planning only. Nothing merged, deployed, committed, pushed or sent. No prod reads. Gated steps are in §8.
**Written:** 2026-10-12 23:09 UTC by Haiku 5.5 (max). Replaces the 22:40 draft; corrections in §0.
**Staff test:** tomorrow morning, Tue 13 Oct (time to confirm).
**Tags:** [code] `file:line` on `main` (a2816a753, on prod since deploy B 09:41 UTC) unless a branch is named. [handoff] `.worktrees/HANDOFF-2026-10-12-N2.md`. [audit] `docs/plans/2026-10-12-002-plan-audit.md` (copy of `/tmp/nava-ovn/A-plan-audit.md`). [retro] memory `project-nava-adoption-gap`. [tx] `bongi UI call transcript.md` (auto-transcribed, rough wording). [est] estimate. [unverified] not checked.

---

## 0. Corrections to the 22:40 draft

| # | Draft said | Correct, with source |
|---|---|---|
| C1 | Needs-you scope fix only on a branch, "no PR" | Shipped. #185 merged and deployed (deploy A). Open items 795 → 106 at deploy, proven by a read-only `listWorkItems` call [handoff §3-4]. Branch `fix/needs-you-scope` is the merged source [handoff §9]. |
| C2 | Manual special rate NOT BUILT | Built: "Set a specific price" + "Authorised by" (#190; `apps/mail/components/quote-workflow/rate-controls.tsx:443,893`; test `apps/mail/tests/rate-cards.test.tsx:225`). Server saved and override rates: audit U13. Live not proven. |
| C3 | Amend/cancel lookup by confirmation number works | Works only when the number is in the mail. 48 of 62 human-written amendments have no HMS booking number [handoff §4]. Retro: confirmation number missing 85% of amendment mails [retro §2]. |
| C4 | Extraction v2 is an optional later option | It is the only automated route to guest-name lookup, but its dry run garbled guest names [ledger `extract-v2-dryrun-20261012`]. MVP uses a manual surname and date field instead. |
| C5 | Store-root server route at `main.ts:52` | On the branch: `apps/server-pilot/src/http/outlook-native.ts:72-73`. |
| C6 | Transcript cites: 77 = Excel; 225 = checkout change feature; 301 = saved rate "not asked"; 313 = manager approval "not asked" | 77 = staff expect a click-through to HMS from the confirmation (MVP uses Copy confirmation). Excel is line 493 only. 225 = AI got checkout dates wrong (26, 27, 28). 301 = builder promised a manual add and a saved rate (built, U13). 313 = client says authorisation is manual, a text field, not a workflow. |
| C7 | Overnight API $20–30 | Measured N2 run, 8.6 h: $41.99 (Opus $17.26, Haiku $16.44, Luna $5.64, Sol leak $2.65) [handoff §8]. Revised to $27–36 (§11). |
| C8 | Quote-lane ETA with no overrun case | N2 quote panel lane ran 2.07× its estimate [handoff §8]. Overrun case in §8.2. |
| C9 | "Other 53%" expected to drop with the fix | Already excluded by #185. Largest bucket now voucher_pop: 39 of 106 [handoff §4]. |
| C10 | Written 22:40 UTC | 23:09 UTC. |
| C11 | Extraction v2 full re-run "66 min scaled" | Ledger row `extract-v2-fullrun-20261012` estimates 10 min code time. The 66 figure is unverified and dropped. Option C ETA is unscoped until the garbled-name fix is sized. |
| C12 | Cold serial 426 min; critical path 216 min | Recomputed with the §7 rows: serial 356 min without stretch (405 with notify); critical path 224 min. |

---

## 1. Decisions

### 1.1 Yours (holds)

| # | Decision | Recommend | Why |
|---|---|---|---|
| D1 | Scope of tomorrow's test | Live sync from enrolment + Find in HMS + Needs-you. No one-month copy. | Copy not on main. Audit: 10-04 U7 UNKNOWN [audit]. |
| D2 | Overnight build scope | Option A (§6) | Fits 7 h with a cut line. No HMS writes. No re-extraction spend. |
| D3 | Gated read-only and live checks (G1–G4, §8.3) | Go tonight | Find-in-HMS cause and the 120 count stay unknown without them. |
| D4 | Deploy and merges (G5–G7) | Pre-approve a window. Merge #189 after rebase and Greptile P1 triage. | Deploy and merge need your explicit go [handoff §2]. #189 is the amend/cancel "Run HMS" entry point. |
| D5 | Store-root auto-accept risk | Accept, after you confirm | Server trusts the enrolled device for the root; the operator no longer approves the root [store-root plan line 26; 10-04 plan A2 "approves each actual Outlook store/root"]. |

### 1.2 Mine (reversible; I will report them)

- POP (voucher_pop) moves to its own list, out of Needs-you. 39 of 106 [handoff §4]. POP attach to HMS works only on the test property [retro §2], so these have no action in Nava.
- Amend/cancel gets manual surname and arrival-date fields. No model spend, no re-extraction.
- Design pass has a cut line (§8.2).
- Manual special rate and Authorised-by stay as built (#190), with copy fixes.

---

## 2. Definitions: live for Centurion (L1–L8)

| # | Check | Pass rule | Status 23:09 UTC |
|---|---|---|---|
| L1 | Pane installed, handshaking on the Centurion PC | Handshake in last 24 h | Unknown now. Last handshake Oct 9 [retro]. Refresh before the test. |
| L2 | Live sync starts, no operator step | Root recorded without typing; sync shows running | **NOT LIVE.** Server branch not deployed (§9). |
| L3 | Find in HMS works | 10 of 10 timed party searches return a result or a named state. Any wait over 60 s shows a running state with elapsed time, and the search continues in the background. No generic text. | **NOT LIVE.** §5.1. |
| L4 | Needs-you shows human-written work only | Quote, booking, amendment, cancellation. POP on its own list. No `other`, no notices. | **PARTIAL.** #185 deployed. POP move and count reconcile open. |
| L5 | Contact block read-only | No editable fields. "Correct" says where the change goes. | **NOT DONE.** §5.3. |
| L6 | Amend and cancel lookup | Number shown or typed; manual surname/date fallback; OTA chip; Copy confirmation | **PARTIAL.** Works by number only. §5.4. |
| L7 | Quote request in order | Contact → stay details (date dropdowns, room types, occupancy beside rooms) → rates (read-only, each confirmed) → confirm | **PARTIAL.** #190 on prod; you cut the live check [handoff §5.6]. |
| L8 | No HMS writes | Write actions say "Coming soon" | **DONE** (#188). |

Legend: LIVE = proven on prod. BUILT = on main, not live-proven. BRANCH = not merged. PARTIAL. NOT BUILT. HELD = writes.

---

## 3. What works in HMS and on screen

### 3.1 HMS functions

| HMS function | Surface | State | Evidence | Gap |
|---|---|---|---|---|
| Party search (company, agency) | pane, webmail | BUILT, fails for staff | `party-picker.tsx:19` "Takes about a minute"; `party-lookup.ts:68` generic error; `pane-party-lookup.ts:23` 150 s per kind | Real states, timing, env |
| Guest / stay search | pane, webmail | BUILT, depends on env | `pane-stay-lookup.ts:152,165`; `hms-jobs.ts:1302` `searchGuest` | `HMS_JOB_QUEUE`, worker env |
| Availability and rate reads | pane | BUILT, none run on prod | handoff §4 "no availability reads in prod yet"; rate codes stored: BAR, NCOR1B, NGOVB | Live proof |
| Contract rate use | pane | BUILT, unproven | #190 rate cards; `rate-controls.tsx` | Confirm-each step; live proof |
| Manual special rate, Authorised by | pane | BUILT, unproven live | #190; audit U13, U21 | Live proof |
| Amend / cancel lookup | pane, webmail | BUILT, number only | `amend-find.ts:157,265`; handoff §4 | Surname/date fallback |
| Voucher / POP HMS check | pane | UNKNOWN live | audit U28 | Live check |
| Run HMS chip (read-only) | pane, webmail | #189 open, unmerged | handoff §3 | Rebase; your merge go |
| Background lookup + top notice | pane, webmail | NOT BUILT | audit: no completion alert found | Stretch |
| HMS writes (create, amend, cancel) | pane | HELD ("Coming soon") | #188 | Not tomorrow |

### 3.2 Other features

| Feature | State | Evidence | Gap |
|---|---|---|---|
| Needs-you list and count | BUILT, deployed (#185) | 795 → 106 [handoff §4] | POP placement; S2, S5 NOT BUILT |
| Contact block | BUILT, editable | `apps/mail/components/nava-pane/blocks/contact-block.tsx:79`; `apps/mail/lib/quote-workflow/use-work-item.ts:431-443` | Make read-only |
| Quote panel v2 | BUILT, deployed (#190) | handoff §3 | Live check cut; order; §5.5 defects |
| Pane install, enrolment | 1 device, enrolled Oct 8, last seen Oct 9 | [retro] | Refresh before test |
| Live mail sync | BUILT on main; needs an approved root | `apps/mail/lib/workstation/use-outlook-sync.ts:57`; root typed by operator, `apps/server-pilot/scripts/outlook-device-operator.ts:132-163` | Server branch not deployed (D5) |
| Extraction v1 | LIVE on prod | 29 extractions after deploy A [handoff §4] | — |
| Extraction v2 (guest surname, requests) | BRANCH `feat/extraction-v2-dryrun` `9dccc2af5`, local only (no origin) | Dry run: guest names garbled, requests empty | Not in MVP (C4) |
| Multilingual in, English out | BUILT | `apps/server-pilot/src/ai/extraction/inbound-run.ts:66-80` (TRANSLATE_RULES in the version hash); audit U3 | Live unverified |
| Voucher / POP card | BUILT (#182; audit U26) | `5e8cc0af8`; audit U26 | Live HMS check (U28) |
| Proposal Excel and PDF | BUILT | audit U12 `cb13299d3` | Staff cannot test here [tx 493] |
| Confirmation letter, pro forma, quote PDF | NOT BUILT | audit line 27 | Not in MVP |
| "Booked via Booking.com" chip | Keep (product rule) | [memory] | [unverified] present on main |

---

## 4. Planned vs done (plan audit)

Source: [audit]. 105 units: **DONE 66 · BRANCH 4 · NOT BUILT 4 · UNKNOWN 31**. Two placeholder rows (plans absent from main) excluded.

| Plan | DONE | BRANCH | NOT BUILT | UNKNOWN | Open |
|---|---:|---:|---:|---:|---|
| 2026-10-06-002 reservationist MVP, v2, follow-ups | 23 | – | – | 15 | v2 live proofs (C2, C3, C4, A6, B1, B2.5, C6) not recorded |
| 2026-10-09-001 nava pane weekend v4 | 27 | – | – | 2 | U28 HMS live research and voucher/POP check; U29 deploy reports |
| 2026-10-04 outlook history and live sync | 9 | – | – | 1 | U7 one-month profile acceptance |
| 2026-10-02-002 mailbox history (superseded) | 6 | – | – | 1 | U7 release |
| 2026-10-11-002 needs-you scope | 1 | – | 2 | 2 | S2 spam, S5 colleague replies NOT BUILT. S3 backfill proof, S4 folder labels UNKNOWN. |
| 2026-10-12 store-root and native 1.0.18 | – | 4 | 2 | 10 | Server-5 tests NOT BUILT. Native, ops and install UNKNOWN. |
| Placeholders: 2026-10-11-001, 2026-10-08-006 | – | – | – | (2) | Plans absent from main. Same-named drafts untracked, not used. |

Still open and relevant to staff: S2 spam, S5 colleague replies, S4 folders, U28 HMS live proofs, one-month copy, 1.0.18, Centurion install.

---

## 5. Diagnoses

### 5.1 Find in HMS: fails, sometimes about two minutes, still says broken

**Confirmed in code [code]:**
- Queue runs only if `HMS_JOB_QUEUE=on` (`apps/server-pilot/src/ai/hms-jobs.ts:61-62`). Off → `runId: null` (`pane-stay-lookup.ts:152,165`) → client runs inline (`amend-find.ts:157`).
- Inline and worker CLIs get the browser endpoint only from `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION` (`apps/server-pilot/src/ai/staff-quote-installation.ts:122-125`). Missing → `CDP_URL_REQUIRED` (`apps/server-pilot/src/ai/pane-stay-spawn-env.ts:26-52`).
- CDP URL must be localhost (`staff-quote-installation.ts:104-120`), so browser and spawning process share a host.
- Any failure → "HMS search didn't apply — try again" (`apps/mail/lib/quote-workflow/party-lookup.ts:68`). That hides the real state, which is why it still reads "broken".
- Party search budget is 150 s per kind (`apps/server-pilot/src/ai/pane-party-lookup.ts:23`). One kind timing out gives about two minutes, then an error. **Most likely cause, not proven.**

**Not proven:**
- Whether the job worker has the staff-quote env. If not, turning the queue on only moves the error into the worker.
- Whether the HMS browser session is logged in.

**Order (no fix before G1):** G1 names read → G2 flag and env → G3 timed runs → code: real states → code: background run and notice (stretch).

### 5.2 Needs-you "120"

- Before #185: denylist; 795 open [handoff §4; plan 11-002].
- #185 rule: allowlist of quote, booking, amendment, cancellation, voucher_pop. Automated and `other` excluded. Deploy A.
- At deploy: **106** = quote 20, booking 24, amendment 21, cancellation 2, voucher_pop 39 [handoff §4].
- Pane showed 120, 14 above the read. **Not verified.** Candidates: items created after 09:41; HMS-touched items that stay open until review (#185 rule); stale pane. G4 settles it.
- 120 is a count, not a cap. `NEEDS_YOU_LIMIT` = 200, label "200+" [code `apps/mail/components/nava-pane/screens/needs-you.tsx:10-14`].
- Still open from plan 11-002: S2 spam, S5 colleague replies, S3 backfill proof, S4 folder labels.

### 5.3 Contact editable

- Each edit calls `recordContact` → `contact.<field>` work-item event (`use-work-item.ts:431-443`; `contact-block.tsx:79`).
- Nothing changes in HMS. The event counts as a staff touch, which blocks auto-close [plan 11-002, `personTouchSql`].
- Built to correct extracted values. The UI never says so.
- Fix: read-only; one "Correct" action; copy: "Saves to this request only. HMS not changed."

### 5.4 Amend and cancel finds

- 48 of 62 human-written amendments have no HMS booking number [handoff §4]. Retro: 85% of amendment mails lack the confirmation number [retro §2].
- No guest-name field: projection hard-codes `guestLastName: null` (`apps/server-pilot/src/ai/work-items.ts` ~L316 [handoff]).
- MVP: manual surname and arrival-date fields feed the existing `searchGuest` (`hms-jobs.ts:1302`). Confirmation number shown if present, typed if not.
- Extraction v2 is the automated route, but its dry run is not usable yet (C4).

### 5.5 Quote-flow defects [handoff §5.3–5.4]

- Contact prefill marks the pane dirty on open; blocks idle reloads (`apps/mail/lib/quote-workflow/session.ts`, inputRevision bump).
- Search stays enabled with an unknown meal plan, then fails.
- "Check before sending" can show raw key `rooms_only_group` (08:10 render).
- Office-transfer values sent to HMS with no UI for them.
- Shuttle and "other" default on every stay.
- Date control is tiles (#190). You asked for dropdowns.

---

## 6. MVP options

### 6.1 Decision block

| Option | Completeness X/10 | ETA (min, cold code) | Value / ROI | Risk |
|---|---|---|---|---|
| **A (recommended)** | **7** | **224** median critical path; **414** if the quote lane overruns like Q-P | High: removes the three staff-facing failures named | Gated HMS steps; quote-lane overrun |
| B = A + voucher/POP HMS check | 7.5 | +13 | Medium: POP stays unproven otherwise | Live POP check may fail |
| C = A + extraction v2 guest-name auto-fill | 8.5 | Unscoped (re-run is 10 min code time; garbled-name fix not sized) | High for amend lookup | Garbled names; re-extract spend (139 open items, needs go); not tomorrow-safe |
| D = A + HMS writes with approve and screenshot review | 3 | Weeks | Low now (1 device, 0 quotes used) | Writes held by rule |

Recommendation: **A**. Add B only if the POP check is cheap in the morning.

### 6.2 Option A, in

- Find in HMS real states + timed proof (L3).
- Needs-you: POP to own list; count reconcile (L4).
- Contact read-only + Correct (L5).
- Amend/cancel: number, manual surname/date fallback, OTA chip, Copy confirmation (L6).
- Quote flow: order, date dropdowns, §5.5 defects (L7).
- Live sync path: server branch + 1.0.18 if ready (L1, L2).
- Design pass on four screens (§10).
- Stretch: background lookup + top notice.

### 6.3 Option A, out

HMS writes (L8, held). Complete bookings. Confirmation letter, pro forma, quote PDF. Extraction v2. One-month history copy. DaVinci.

### 6.4 Staff must-haves from the call [tx]

| Must-have | tx lines | State |
|---|---|---|
| Mixed room types and counts, not 30 twins | 157, 413 | BUILT (#187 matcher, #190 room table); live unproven |
| No duplicate stays | 233 | Reported; #190 multi-stay; unproven |
| Booker identified: company, person, contact | 201, 345 | #190 Booked-by block with Find on both parties; name fill needs a live test |
| Checkout dates correct | 225 | AI got 26/27/28 wrong; test in L7 |
| Manual special rate (cricket) | 245, 269 | BUILT (#190 "Set a specific price") |
| Save a rate, no retyping | 301 | BUILT server (U13); UI (U21) |
| Manager authorisation, as text | 305, 313 | BUILT (#190 "Authorised by") |
| Incoming Chinese, French, Portuguese; reply in English | 109, 121 | BUILT (`inbound-run.ts:66-80`); live unverified |
| Remove AI-filled text | 373 | Unknown; test |
| Download to Excel | 493 | BUILT (audit U12); staff test needed |

---

## 7. ROI table (sorted by ROI; lane in last column)

Cold ETA = raw estimate × median ratio for the kind (ledger, 2026-10-12): code-server 0.69 (n=69), code-ui 0.81 (n=39), deploy 0.80 (n=30), live-hms 0.53 (n=23), review 0.87 (n=17). Scaled value in bold.

| ROI | Item (ledger id) | Current state | Why complete or lacking | Cold ETA raw → scaled (min) | Lane |
|---|---|---|---|---|---|
| 1 | Find in HMS real states, timed proof (`ovn-hms-find-20261012`) | BUILT, fails for staff | Generic error (`party-lookup.ts:68`); queue env unknown; 150 s timeout; no proof | 25 → **13** (live-hms), plus 10 timed runs, ~25 min wall, gated | H |
| 2 | Amend/cancel lookup, fallback, OTA chip (`ovn-amend-cancel-20261012`) | BUILT, number only | 77–85% of amendment mails lack number; no surname field | 40 → **32** (code-ui) | N |
| 3 | Needs-you: POP to own list, count reconcile (`ovn-needs-you-20261012`) | #185 deployed, 106 | Rule shipped; 120 disputed; S2, S5, S3, S4 open | 45 → **31** (code-server) | N |
| 4 | Contact read-only + Correct (`ovn-contact-20261012`) | Editable | Edits look like HMS changes; block auto-close | 30 → **24** (code-ui) | Q |
| 5 | Party and rate live path (`ovn-party-rates-20261012`) | BUILT, no availability read on prod | Confirm-each step; static defaults wrong for 77% [audit:39] | 40 → **21** (live-hms) | H |
| 6 | Server store-root tests, merge-ready (`ovn-installer-20261012`) | BRANCH `bfc45f2c9`, not deployed | Prerequisite for live sync. Tests NOT BUILT. | 50 → **35** (code-server) | I |
| 7 | Quote flow order and §5.5 defects (`ovn-quote-flow-20261012`) | BUILT (#190), live check cut | Order off; date tiles; defects §5.5; Q-P ran 2.07× | 100 → **81** (code-ui) | Q |
| 8 | Design pass, four screens (`ovn-design-20261012`) | Not started | Design skills not run; looks changed, flow not | 90 → **73** (code-ui); cut line | Q |
| 9 | Deploy + live proof (`ovn-deploy-20261012`) | Not started | Needs go (G5–G7) | 30 → **24** (deploy) | Ship |
| 10 | Greptile P0/P1 (`ovn-greptile-20261012`) | Required | Fix P0/P1 only | 25 → **22** (review) | Ship |
| 11 | Background lookup + top notice (`ovn-notify-20261012`) | NOT BUILT | No completion alert (audit) | 60 → **49** (code-ui); stretch | H |
| 12 | Voucher/POP HMS check (`ovn-pop-verify-20261012`) | UNKNOWN live | U28 unproven | 25 → **13** (live-hms); Option B | H |
| – | HITL ledger flag | Off (env change) | Not for MVP; gated | 4 → **3** (code-server) | – |
| – | Demo name sweep | Needed before external share | Not for tomorrow | 10 → **8** (code-ui) | – |
| – | Legacy IT request, email record links | You send | Not code | 10 → **8** (research) | – |

---

## 8. Work plan, lanes, cut line, gates

### 8.1 Lanes (parallel; Luna max codes; each lane in its own worktree)

| Lane | Items (scaled min) | Total | Depends on |
|---|---|---:|---|
| H (HMS) | Find in HMS 13 → party rates 21 → notify 49 (stretch) | 83 | G1 names read (code can start before) |
| N (Needs-you, amend) | Needs-you 31; amend/cancel 32 | 63 | #189 rebase for the Run HMS chip (G5) |
| Q (quote, contact, design) | Contact 24 → quote 81 → design 73 | **178 (critical)** | Contact first (shared files) |
| I (installer, server) | Store-root tests and typecheck 35 | 35 | None; blocks L2 only |
| Ship | Deploy 24 → Greptile 22 | 46 | After H, N, Q, I are reviewed |

### 8.2 Totals

- Serial, Option A without stretch: **356 min (5.9 h)**. With notify: 405 min (6.75 h).
- Critical path (median): 178 + 46 = **224 min (3.7 h)**.
- Overrun (Q lane at the Q-P ratio 2.07): 178 × 2.07 = 368; + 46 = **414 min (6.9 h)**. Over budget.
- Cut line: design pass reduced to critique and copy fixes (~20 min [est]). Overrun then: (24 + 81 + 20) × 2.07 = 259; + 46 = **305 min (5.1 h)**. Fits.
- Budget: 7 h = 420 min. Assume 30 min of Opus planning first [est]. ~390 min left.

### 8.3 Gated steps (none run; each needs your go)

| Gate | Step | Read or write | Notes |
|---|---|---|---|
| G1 | Names only, on webmail and the job worker: `HMS_JOB_QUEUE`, `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION`, `HMS_STAGEHAND_CDP_URL`, `INBOUND_TRIAGE_CLASSIFIER`, `INBOUND_EXTRACTION`, `HITL_LEDGER` | Read | `ops-run.sh` under systemd-run with `.env.production`; print presence only [handoff §6]. Classifier stays on unless `INBOUND_TRIAGE_CLASSIFIER=off` [plan 11-002 line 33]. |
| G2 | If missing: `HMS_JOB_QUEUE=on`, staff-quote env on the worker, restart | Env change (hold) | Confirm the worker is one of the 4 pm2 processes first [handoff §0]. |
| G3 | 10 timed party searches | Live HMS read, no sends | Record stage times and outcomes. ~25 min wall. |
| G4 | Open Needs-you count by kind; items created after 09:41 | Read, read-only transaction | Reconciles 106 vs 120. |
| G5 | Rebase #189 on main; Greptile P1 triage; merge | Merge (hold) | [handoff §3]. |
| G6 | Deploy via `apps/server-pilot/deploy/ops-deploy.sh` from a clean detached worktree; health check | Deploy (hold) | Recipe [handoff §6]. No GitHub Actions. |
| G7 | Install 1.0.18 over 1.0.17 on Centurion; enrolment kept; supervised by Ansh/IT | Staff device | [10-04 plan line 575]. |

Also: no sends to staff. No HMS writes. No DB migrations (`drizzle/`) without go [handoff §2].

### 8.4 Build rules

- Extraction v2 re-run only after its code deploys. Otherwise stale-version dead letters (`apps/server-pilot/src/ai/extraction/inbound-run.ts:232, 244-256, 505-512`; `apps/server-pilot/scripts/backfill-inbound-extraction.ts:100-120`).
- Typecheck: mail tsc has 11–14 existing errors; gate ≤21 [handoff §6]. Lint: `pnpm dlx oxlint@1.6.0 --deny-warnings <files>`.
- DB suites: reviewer runs them outside the codex sandbox (EPERM on Postgres). Never print the test env. `--maxWorkers=1`.
- Codex coding: `codex exec -C <wt> -s workspace-write --skip-git-repo-check -c multi_agent_v2=false -o <out> - < prompt`. Research: `-s read-only`. The `multi_agent_v2=false` flag stops the Sol leak [handoff §8].
- Greptile: P0/P1 only. Triage every P1 before merge.

---

## 9. Installer and one-month sync

**Answer: no.** An installer alone does not start sync tomorrow.

| Question | Answer | Source |
|---|---|---|
| Already installed? | Yes, 1.0.17, enrolled | store-root plan line 5; [retro] |
| Typed pairing code needed? | No, for an enrolled device. Upgrade keeps enrolment. | store-root plan line 66 |
| Does sync start on its own? | No. It needs an approved root. On main only the operator types it. | `apps/server-pilot/scripts/outlook-device-operator.ts:132-163` |
| Fix | Server branch: root accepted on enrol and on signed call. Not deployed. | branch `feat/store-root-autoaccept` `bfc45f2c9`; `apps/server-pilot/src/http/outlook-native.ts:72-73` on branch |
| Tested? | No store-root tests (Server-5 NOT BUILT); typecheck UNKNOWN | [audit] |
| Native 1.0.18 | UNKNOWN. Lives in `kufupa/nava-outlook-addin`, not this checkout. | [audit] Native-4 |
| 1.0.18 download risk | Ledger rows opened 14:48 UTC today: "protected-download gate: stage exact bytes for Edge test", and fallback "pin WebView2 bootstrapper 1.3.275.13, rebuild CI, retest". Both open, no close row. Edge may block the download. | ledger `installer-1018-stage-test`, `installer-1018-pin-rebuild` |
| One-month copy | Plan only; not on main | `docs/superpowers/plans/2026-10-04-outlook-history-and-live-sync.md`; [audit] U7 |

- **Tomorrow can prove** (after G6 and G7): upgrade over 1.0.17 keeps enrolment; root recorded without typing; sync starts for new mail; pane shows sync state.
- **Tomorrow cannot prove:** the one-month copy. Re-scope the test (D1).
- **Before the morning:** L1 handshake; device root row (read, G4-style); confirm the window with Ansh (authorised operator, 10-04 plan A2 and line 575).

---

## 10. Design plan

**Why the last pass failed:** it changed looks, not steps. No flow spec, no critique loop, design skills not run. Visual QA came late because Chromium is blocked in the codex sandbox [handoff §8].

**Order:** flow spec → layout → critique loop → copy. Test on real DOM, not hand-drawn mockups.

**Four screens:**
1. Needs-you row: what, why, one action, state.
2. Quote request: contact → stay details (date dropdowns, room types, occupancy beside rooms) → rates (read-only, each confirmed) → confirm.
3. Amend/cancel card: number, dates, OTA chip, Copy confirmation, manual surname/date fallback.
4. Lookup status: not connected / running (elapsed) / done / failed with a named reason / timed out.

**Tools:**
- gstack: `design-review`, `plan-design-review`, `design-consultation`, `design-html`, `design-shotgun`, `browse` (screenshots), `avoid-ai-writing` (copy).
- Impeccable (not installed): critique, audit, clarify, distill, polish, harden, adapt. Install with `npx impeccable install` or the Claude Code plugin marketplace `pbakaus/impeccable`. Untrusted download: own folder, review before running.
- Harness: `.worktrees/ui-proof/harness/` mounts the real pane code (`--mail-root`, `--surface outlook|webmail`, `--width`) [handoff §7].

**Widths:** 360 px (Outlook pane) and 1280 px (webmail). Both surfaces, always (feature rule).

**Copy rules:**
- One helper line per field. No repeats.
- Say what happens next. If a button is disabled, say why.
- Room types, never "Room 1 / Room 2".
- One date line. Dates are dropdowns.
- "15 rooms, 20 guests" beside the room types.
- Never show "error" for a state. Name the state.
- "human-written" in UI copy, never "origin=person" [handoff §2].
- Public demo: no "MOCK" text, no real names.

**Acceptance:** you scan each screen and agree in about 5 s. Every §6.4 must-have is visible.

---

## 11. Models and cost

**Routing** (memory `feedback-model-routing`, measured 2026-10-11; N2 in [handoff §8]):

| Work | Model | Rule |
|---|---|---|
| Orchestration, decisions, critical review | Opus 5.5 | Main loop, 1 h cache. Short sessions; read summaries. |
| Code lanes, large research | GPT-6 Luna max (`codex exec`) | `multi_agent_v2=false` |
| Review, verify, digests | Haiku 5.5 max | Fresh agent per round, under 100k; narrow scope |
| PR gate | Greptile P0/P1 + Haiku verify; Opus after 2 failed rounds | — |
| Live HMS | Deterministic scripts; an LLM digests output only | — |
| Never | Sonnet 5.5; GPT-6.1 Sol (too slow; leaked in N2) | — |

**API list prices, per 1M tokens** [memory, 2026-10-11]: Opus 5.5 $4 in / $20 out, cache read $0.20 (cache write 1.25× at 5 min, 2× at 1 h). Haiku 5.5 $0.10 / $0.50 (above 100k: $0.50 / $2.50). GPT-6 Luna $0.10 / $0.50.

**Measured runs:**

| Run | Window | Opus | Haiku | Luna | Sol | Total |
|---|---|---:|---:|---:|---:|---:|
| N2 overnight [handoff §8] | 8.6 h | $17.26 | $16.44 | $5.64 | $2.65 (leak) | **$41.99** |
| m1-finish [memory] | 407 min | $12.70 | $11.80 | $3.00 | – | **$27.50** |

**Estimate for the next overnight build [est]:**

| Model | N2 rate per hour | 7 h | Note |
|---|---:|---:|---|
| Opus 5.5 | $2.00 | $14–17 | Orchestrator |
| Haiku 5.5 max | $1.91 | $9–13 | Fresh agents under 100k. N2 had 57% of requests above 100k. |
| GPT-6 Luna max | $0.65 | $4–6 | Sol flag off |
| **Total** | | **$27–36 (central ~$32)** | If wall time is 4.5 h: ~$21 |

---

## 12. Housekeeping

- Red tests, not touched: `apps/mail/tests/outlook-pane-render.test.tsx` (400 s timeout, also on main); `apps/server-pilot/tests/work-event-immutability.test.ts` (FK message text) [handoff §5.5].
- PRs: #189 open (needs rebase; G5). #48 draft, superseded; #2 draft, Cursor perf. Leave both [handoff §3].
- Merged worktrees, safe to remove: `q-p`, `q-s`, `m2-pane-cleanup`, `m2-d1-deadletter`, `needs-you-scope` [handoff §9].
- Stale: `.worktrees/ui-proof/REVIEW.md` (predates #190) [handoff §5.7]. Demo `ui-proof/pane-demo/v5` is static; the header "Needs you (10)" is hand-picked.
- Background processes, not checked: `/home/orca/n2-tools/shot-daemon.cjs` [handoff §7]. Codex PIDs 847925 and 847932, started 09:34 UTC with `--dangerously-bypass-approvals-and-sandbox`. Not from these sweeps. Left running; check cost.
- ETA ledger: 28 older start rows with no close row, plus 13 new ones from this turn (41 open at 23:09 UTC). Supersede `extract-v2-spotcheck-20261012` and `extract-v2-fullrun-20261012` on go. `installer-1018-*` rows open with no close.

---

## 13. Not checked

- Prod: env names, DB counts, device handshake, root rows, live HMS. All gated.
- Native repo `kufupa/nava-outlook-addin`: 1.0.18 status.
- Voucher/POP card live. Multilingual extraction live. Ingest worker coverage of the full Centurion mailbox, and how far back.
- Quote panel v2 live (you cut the check).
- Needs-you denylist line numbers: taken from plan 11-002, not re-read.
- Sweep B (`/tmp/nava-ovn/B-requirements.md`): used from earlier notes, not re-read this turn.
- This planning turn's own cost: not measured. `cost.mjs` writes `ui-proof/COST.md`, so it was not run.
- Hindsight recall: an earlier reflect call timed out and was not retried.

---

## 14. Sources

- Handoff: `.worktrees/HANDOFF-2026-10-12-N2.md` (written 09:50 UTC by the Opus N2 session).
- Plan audit: `docs/plans/2026-10-12-002-plan-audit.md` (copy of `/tmp/nava-ovn/A-plan-audit.md`).
- Plans on main: `docs/plans/2026-10-11-002-needs-you-scope-plan.md`; `docs/superpowers/plans/2026-10-04-outlook-history-and-live-sync.md`.
- Plans in the worktree (untracked): `docs/plans/2026-10-12-001-store-root-auto-accept-plan.md`; `docs/plans/2026-10-06-003-case-coverage-gap-audit.md`; `docs/plans/2026-10-06-002-reservationist-mvp-retro-and-sprint-plan.md`.
- Transcript (untracked): `bongi UI call transcript.md`.
- Ledger: `~/.claude/eta-ledger.jsonl`.
- Memory: `feedback-model-routing`, `project-nava-adoption-gap`.
- PRs: `gh pr list --state open` at 23:09 UTC: #189 (open), #48 (draft), #2 (draft).
