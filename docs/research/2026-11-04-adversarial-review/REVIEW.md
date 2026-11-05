> **v2 (02:2x):** owner decisions applied — D1–D4 closed, fallbacks dropped, rules cut on main `7e871275c`. See TRACKER "v2" for corrections (CheckAvail = hypothesis, cancel penalty after status, startup race).

# Adversarial review: plan 2026-11-04-001 "Native Create First Recovery"

**Verdict: the plan has the right goal and the wrong order, and it misses the bugs that actually make the pane look dead. It leaves native Save until after review and deploy, it misses two blockers that refuse every real email (the `childAges` P0 and the lab-mode preview refusal), it contradicts the owner on CMS, and it refuses to give an ETA. Reorder the work: prove native Save first, then review. Fix about 10 small things, split work into four parallel lanes with timeboxes, and Create plus Filing can be live for real guests in about 1h35 (P50) or 2h30 (P80) from execution start. All four core workflows can be usable in about 2h30 (P50) or 4h (P80).**

Scope: read-only review of `docs/plans/2026-11-04-001-feat-m1-recovery-plan.md`, its retros, and deployed main `1e2b2f7a0` (#999). No code, deploy, flag or HMS action was taken. Evidence comes from the five lane files in this folder plus direct reads by the coordinator. File paths below are at `1e2b2f7a0` unless stated.

---

## 1. What is going wrong (root causes)

| # | Cause | Evidence | Cost |
|---|---|---|---|
| 1 | **Domain knowledge lost in the Cloud rebuild.** Legacy Create clicked **Check Availability** before Save. The Cloud rebuild dropped that step. | `tooling/playwright-quote/create-lab-stay.mjs:1247` `clickTip(page,'^Check Availability$')`. Legacy `amend-stay.mjs:125`: "HMS keeps a changed date or occupancy only after Check Availability has re-rated the stay." Cloud `create-reservation.mjs` never clicks it, so `averagerate` stays blank. | The first fake Go (11-03 23:33) failed with "Rate is not available" after about 3 hours of the run. |
| 2 | **Proofs bypassed the real pane.** Operator scripts sent hand-written JSON straight to the route. | `~/.codex/m1-20261103-203425/create-canary2-preview.sh:17` sends `childAges:[]`. The real pane builder drops an empty array (`pane-stay-bind.ts:400,431`), and the server then refuses `child_ages_required` (`pane-create-cloud-input.ts:88`). | **Every adults-only real email is refused.** No proof run ever saw this. |
| 3 | **Lab mode blocks unsaved previews too.** | `pane-cloud-preview.ts:116-118`: when the flag is `lab` and the guest isn't Labtest, the result is `cloud_preview_labtest_only`. The owner authorized unsaved staging on real bookings. | Every real email's Create card says "available only for Proof Labtest… Book real guests in HMS" (`pane-stay-bind.ts:49`). This is the "pane is fucked" feeling. |
| 4 | **Hyper-strict body matchers.** Save is refused unless the HTTP body has exactly 985 model keys (sha256-pinned) plus 3 controls. PR #1000 then enumerates the 1,112-pair Check Availability body. | `guest-stay-save.mjs:32-48`; there are 91 refusal hits across 4 Create files. | Any HMS field drift fails closed, and each one costs a full fix/review/deploy loop. This is where the 985/1,109/1,112 confusion comes from (§5). |
| 5 | **Native Save is attempted last.** Plans run code → review → merge → deploy → then the first Save. | The plan's Wave C uses the candidate CLI in `mode=prepare` only. Save waits for U6, after deploy. | A Save surprise costs about 35–45 minutes per loop instead of about 10. |
| 6 | **Ceremony crowds out product.** | Since 11-01, main has +29,070 test lines against +18,122 product lines. There were 10 plans in 4 days and about 396K words of docs, 17,540 doc lines merged, a 15K-line retro CSV commit, 51 operator `.sh` scripts and 46 `create-canary2-*` numbered-probe artifacts. The 11-03 evening run shipped about 530 product lines in about 4 hours. | Time is spent on proving and writing instead of shipping. |
| 7 | **No ETA and no timebox.** | The plan says "Unknown" for every workflow ETA even though the owner asked 3 times (S:847, S:1013, S:4330). Its 35 tasks with 5–15-minute "reporting budgets" add up to about 330 minutes, and none of them can fail. | Drift: checkpoints report, but nothing forces a stop or a fallback. |

---

## 2. Plan claims and verdicts

| Plan says | Verdict | Why |
|---|---|---|
| Goal: real email → existing profile → priced Prepare → Go → Save → readback | ✅ Right | Matches the owner's 11-04 01:04 message ("create, cancel, amend"; reads aren't enough). |
| "Field-count issue is a small contract repair" | ⚠️ Half right | The matcher fix is small. The plan misses that Check Availability may change the 985-key Save set, which would give `CREATE_FORM_FIELD_SCHEMA_CHANGED` as the next mystery. |
| U2.2 "confirm priced **current draft** contract" | ❌ Wrong premise | Go opens a **fresh browser session** and restages (`create-reservation.mjs:368-405`, `pane-cloud-preview.ts:583-754`). Check Availability must run in the **shared staging step** so that Prepare (to show the price) and Go (to rate the fresh draft) both do it. |
| Wave C: candidate CLI `mode=prepare` only | ❌ Too weak | Fake Labtest writes are always allowed (PRODUCT.md). Run a candidate **commit** too, before review, so Save is proven first. |
| U6: "installed operation" proof | ❌ Blind spot | Last night's "installed" proofs used hand JSON and missed the `childAges` P0. The proof must go through the pane's request builder. |
| CMS: "keep manual confirmation sending" | ❌ Contradicts owner | The owner chose option B on 11-02 ("option B sounds good"): HMS emails the guest on real creates. |
| Completion ETA "Unknown" ×5 | ❌ Fails the owner's ask | Each piece can be measured (§7). Unknown native risk becomes a P80 band plus a timebox, not "Unknown". |
| U7 Cancel with second staff approval on a charge | ⚠️ Owner-sourced, but conflicts with a hard rule | The owner said 19:38 "Show charge; require second staff approval". PRODUCT.md:54 says "Never accept a cancellation-penalty dialog". The owner must pick one; the plan silently overrides PRODUCT.md. |
| One "core follow-on owner" for U7 Cancel and U8 Amend | ❌ Serializes for no reason | No owner source says Amend waits for Cancel. Give them separate lanes and worktrees. |
| U3.3 Filing "source-scoped reset/freeze" | ✂️ Cut | No reset API exists, and the plan admits it. Freeze-after-bind already exists. |
| U4.1 remove the private helper's joint Create+Attach gate | ✅ But don't edit it, just stop using it | Per-workflow promotion exists: `write-ec2-remote-env.sh --m1-only` plus `ops-restart.sh`. |
| "Zero new tests" | ✅ OK | The owner said "as little testing as possible". Keep only the existing focused checks plus the remote typecheck (27 s to 3 min). |
| 4,997 words, 35 tasks, 29 "checkpoint"s, 40 "do not"s for about 400 LOC | ❌ Ceremony | This review replaces it. Write no more plans or retros until the workflows are on. |
| Lab preview refusal | ❌ **Missing** | 1–3 lines, the highest-ROI fix in the repo. |
| `childAges` empty-array drop | ❌ **Missing P0** | 1 line. |

---

## 3. Why the pane feels dead today

| Workflow | Staff see on a real email now | Cause | After the fix |
|---|---|---|---|
| Quote | ✅ Works: auto price, PDF, unsent reply insert | — | Same. This is the best asset. |
| Create | "HMS preview is currently available only for Proof Labtest… Book real guests in HMS" | Lab preview refusal + `childAges` P0 + no Check Availability | Prepared booking with HMS price → Go → confirmation # |
| Filing | Lab = fake only; the card needs extracted surname + arrival and exactly 1 HMS row; no edit, no picker | `voucher-find-card.tsx:201-230,452-457` | Editable search plus a row picker → file the PDF → Documents readback |
| Amend | Lookup plus local compare, "nothing saved" | HRCEN refuses at `pane-hms-write.ts:868-872,1013-1017` | Occupancy change → Go → readback |
| Cancel | Lookup/review only | `pane-stay-cancel.ts:301-303` `refused_legacy_cancel_unavailable` | Unpaid cancel → Go → readback |
| All | CMS checkbox visible but disabled (a dead control), 15 raw error strings, no ">30 s" progress copy | Polish debt | Hide the dead control, use plain copy, say "Checking HMS… about 40 s" |

The pane isn't broken. For real mail it's a **read-only demo**: every write says "do it in HMS".

---

## 4. Cancel: why it was dropped

- **An agent cut it, not the owner.** Plan 003 said: "This is an optional launch scope cut, not evidence that cancellation is inherently difficult." PRODUCT.md then adopted the M1 exclusion. No source shows the owner rejecting Cancel.
- **The owner restored it** on 11-04 at 01:04 (S:4716): core = create, cancel, amend.
- **Code state:** a clean candidate exists. `~/.codex/worktrees/810e` is at `64d1caf57` ("bind unpaid Cancel dispatch and durable pane outcomes"), 0 dirty paths, 12 commits behind main. Its core is about 711 LOC: preview/approval, recovery, native session, Save and fresh readback.
- **Not proven on Cloud:** the 11-03 native probe returned `preview_ok, requestDispatched:false`. Historic fake Cancel did pass (DoD5 on old SHA `7dd78a67b`; the penalty was shown and not accepted), so the mechanics are possible.
- **Cut:** the untracked 409-LOC `cancel-payment-preflight.mjs` finance engine in 22ad. PRODUCT.md:32 says not to build an accounting eligibility engine.

---

## 5. The 985 / 1,109 / 1,112 / 112 numbers in plain words

| Number | What it is |
|---|---|
| **985** | The number of fields in HMS's Guest Stay form model. Nava's Save guard refuses to let Save go out unless the request has **exactly** these 985 keys (fingerprinted by sha256) plus 3 control fields, 988 in total. |
| **1,109** | The same model counted with its metadata keys. |
| **1,112** | A **different** request: the Check Availability call, with 1,112 name/value pairs, 809 of them empty. |
| **112** | A **bug** in PR #1000. Its guard hardcodes 112 expected fields and lowercases names, so it refuses the real 1,112-pair request. |

**Why it matters:** these numbers only exist because Nava checks entire HTTP bodies field by field. If HMS adds one field, every write stops. The legacy tool didn't do this, and it worked.

**Fix:**
- Check Availability: allow one exact path and frame, one-shot, bound to the draft. Don't enumerate the 1,112 pairs.
- Save: if the candidate fake commit hits a key-set error, replace the sha256 pin with value checks on about 20 business fields (guest ID, dates, room, rate plan, adults, children, guarantee, party IDs, note), about 15 LOC.

---

## 6. Cut / add

### Cut

| Cut | Saves |
|---|---|
| The 1,112-pair enumeration matcher (#1000) → path + frame + one-shot | Brittleness and a review loop |
| U2.2 "same current draft" contract | A wrong-premise task |
| U3.3 Filing reset/freeze | A task with no API |
| U4 private helper edits (`~/.codex`) | Ceremony outside the repo |
| Joint Create+Attach promotion; Filing needing a fresh Create | A cross-lane dependency |
| U7.3 charged-cancel second approval (until the owner settles it against PRODUCT.md) | A new protocol and a policy conflict |
| The 409-LOC cancel finance preflight | An engine PRODUCT.md forbids |
| Full date/room/rate Amend in the first slice → occupancy first, plus a 30-min date spike | An unknown-size campaign |
| New plans, retros, evidence CSVs, numbered probe scripts | Hours of the last 3 nights |
| Cleaning up 30+ stale PRs and 167 worktrees **now** | Not on the critical path; do it after |

### Add (missing from plan)

| Add | LOC | Why |
|---|---:|---|
| `childAges` always sent (default `[]`) | 1 | P0: every adults-only email is refused |
| Real-guest **unsaved** Prepare under `lab`, with commit still gated | 1–5 | Real emails show a real prepared booking now; the owner allows unsaved staging |
| Check Availability in the shared staging step (Prepare **and** Go) | 40–70 | Go uses a fresh session |
| Candidate fake **commit** via CLI before review | 0 | Proves Save first; fake writes are always allowed |
| Proofs through the pane request builder (one webmail click-through or a builder-built payload) | 0 | Closes the bypass that hid the P0 |
| HMS price into the Create card | 10–20 | Owner 00:57: "show HMS price and final result" |
| Timebox plus fallback per lane (§8) | 0 | Stops drift |
| Hide the dead CMS checkbox and add ">30 s" progress copy | 10–20 | PRODUCT.md: no dead controls; say so if over 30 s |

---

## 7. ETA (calibrated)

**Basis:**
- Ledger medians: code-server 0.85, code-ui 0.87, live-hms 0.67, deploy 0.83. Per-unit estimates have run slightly *long*.
- But every **milestone** since 11-02 overran 2–3× or never closed, and native surprises were the cause.
- So P50 uses the unit numbers unshaved, and **P80 adds one native fix loop per lane** (about 35–45 min: fix, review, redeploy, re-proof).
- Measured tail: #999 review → merge → deploy → audit took 11m27s. Deploy alone takes about 5m30s to 6m. Remote typecheck takes 27 s to 3 min.

| Milestone (from execution start T0) | P50 | P80 | Gate |
|---|---:|---:|---|
| Real emails show a prepared Create (unsaved, priced) | T+75 | T+2h | Lane A deploy |
| **Create on for real guests** | **T+1h35** | **T+2h30** | Fake Save + readback through the pane builder, then promote |
| **Filing on for real guests** | **T+1h35** | **T+2h30** | Fake PDF → Documents readback, then promote |
| Cancel (unpaid) usable | T+2h | T+3h30 | Fake cancel + readback; real-guest flag needs owner Go |
| Amend (occupancy) usable | T+2h30 | T+4h | Fake amend + readback; real-guest flag needs owner Go |
| Amend dates/room/rate | Unknown until the 30-min spike at T+30 | — | One native date Save proven, or manual |
| CMS auto-confirmation | +20–30 after Create on | — | Owner decision (§9) |

If execution starts at 02:00 UK, Create and Filing reach P50 around 03:35 and P80 around 04:30.

### Pieces

| Piece | What | LOC | Check | HMS check | Parallel? | Min |
|---|---|---:|---|---|---|---:|
| A1 | `childAges`, lab real-guest preview + copy, fix #1000 matcher, Check Availability in shared staging, price chip | 60–100 | none new | — | ∥ B1, C1, D1 | 30 |
| A2 | Candidate fake Prepare + **commit** + readback via CLI; relax the pin only if it hits a schema error | 0–15 | — | Labtest 2027 Save | ∥ B0 (different stay) | 15–30 |
| A3 | Remote typecheck (mail, server-pilot) + Apex + merge gate | — | remote tsc | — | ∥ B2 | 15–20 |
| A4 | Bundle deploy (A+B together) + 4-process env audit | — | — | — | serial (coordinator) | 6–10 |
| A5 | One fake Create through the pane builder → readback | — | — | Labtest Save | ∥ B3 (different stay) | 10 |
| A6 | `PANE_WRITE_CREATE=on` via `--m1-only` + restart + audit; one real-email unsaved Prepare | — | — | real read only | with B4 | 10 |
| B0 | Candidate fake PDF upload → Documents readback via the existing native uploader (**never proven**) | 0 | — | Labtest stay | ∥ A1 | 15–25 |
| B1 | `voucher-find-card.tsx`: editable surname/arrival, row picker, reuse `amend-find.ts` search | 60–100 | none new | — | ∥ A1 | 25–30 |
| B2–B4 | Review → same bundle as A → fake filing via pane → `PANE_WRITE_ATTACH=on` | — | remote tsc | Labtest | with A | 25 |
| C1 | Merge main into `810e`; keep the unpaid gate; penalty → refuse / "cancel in HMS" | ~0 new | — | — | ∥ A, B, D | 30–40 |
| C2 | Candidate fake Cancel via CLI → readback | — | — | Labtest stay (not A's or B's) | ∥ | 15–25 |
| C3–C4 | Review → bundle 2 → fake cancel via pane → hold for owner real-guest Go | — | remote tsc | Labtest | bundle 2 shared with D | 35 |
| D0 | **30-min spike:** one native date-change Save on Labtest | 0 | — | Labtest | ∥ D1 | 30 |
| D1 | Extract the adult/child occupancy slice from `ee01` (73 dirty paths) onto main | ~300–500 (existing) | — | — | ∥ | 45–60 |
| D2–D4 | Candidate fake amend → review → bundle 2 → fake via pane | — | remote tsc | Labtest | bundle 2 | 50 |

The critical path is A1 → A2 → A3 → A4 → A5 → A6, about 95 min P50. B finishes inside A's tail because it shares bundle 1. C and D share bundle 2, about 30–60 min later.

---

## 8. Parallel lanes, timeboxes and fallbacks

| Lane | Worktree | Owned files | Timebox → fallback |
|---|---|---|---|
| A Create | new from main + #1000 head `ea70d728` | `pane-stay-bind.ts`, `pane-cloud-preview.ts`, `create-reservation.mjs`, `guest-stay-rate-plan.mjs`, `guest-stay-save.mjs`, `booking-card.tsx` | No green candidate fake Save by T+75 → ship the real-guest **priced Prepare** only (staff book in HMS with Nava's values), report the exact HMS error, and allow 1 more loop max |
| B Filing | new from main | `voucher-find-card.tsx` (+ reuse `amend-find.ts`) | B0 fails by T+30 → Filing stays lab; report the exact native error |
| C Cancel | `810e` (clean) | Cancel files only | No green candidate fake Cancel by T+1h15 → hold Cancel; don't start the finance work |
| D Amend | new from main, cherry-picked from `ee01` | Amend files only | D0 has no date Save by T+30 → dates stay manual; ship occupancy only |
| Coordinator | clean main worktree | Shared router/approval files, merge gate, deploys, env audits, promotions | 2 bundles max; Apex over 15 min → another reviewer |

Rules:
- Fake writes run on **distinct** Labtest stays per lane, and writes on the same stay are serialized.
- One fix loop per lane, then escalate with the exact blocker.
- No new plans or retros mid-run. One compact state file.

---

## 9. Agent architecture (one section)

| Layer | What runs | Verdict |
|---|---|---|
| Pane brain | Luna agent (`PANE_BRAIN=agent`, LunaMax) reads the email and classifies/extracts/prefills. Tools off, writes off. | Fine. The extraction prompt has grown (17 template strings over 2K chars, the largest 18K), which is overfit risk but not an M1 blocker. |
| Quote | Mastra-era reservationist runtime (`staff-quote-run.ts` → `runReservationistRuntime`, plan → execute). The `reservationist` Agent defines `quote_stay`, `party_lookup`, `quote_proposal_pdf` and `create_reservation_dry_run`, last edited 10-22. | The if-this-then-that agent **still exists** and powers Quote. |
| Writes | Deterministic: pane card → tRPC route → Playwright Cloud tool → protected Save → readback. No LLM decides a write. | Right for human-in-the-loop safety. |

**The agent isn't why the pane is dead.** The write tools and gates are. Don't rebuild the agent before the four workflows ship.

---

## 10. Owner decisions (open)

| # | Choice | Options | Recommendation |
|---|---|---|---|
| D1 | CMS confirmation on real creates | **A:** on per 11-02 option B (35–60 LOC, 4 files; Save then uses 985+2 confirm flags) / **B:** manual first, hide the checkbox | A as a follow-up PR right after Create is on (T+2h), not on the critical path |
| D2 | Charged cancel | **A:** keep the PRODUCT.md hard rule and refuse on any charge / **B:** your 19:38 "second staff approval", which requires editing PRODUCT.md:54 | A first (unpaid only). Decide B after you see unpaid working. |
| D3 | First Amend slice | **A:** occupancy now plus a 30-min date spike / **B:** wait for full dates/room/rate | A |
| D4 | 985 key pin | **A:** relax only if the candidate commit hits a schema error / **B:** relax now | A, because the truth costs 10 min |

Real-guest writes for Cancel and Amend need **your Go in the executing session**. The M1 prompt authority covers Quote, Create and Filing only.
