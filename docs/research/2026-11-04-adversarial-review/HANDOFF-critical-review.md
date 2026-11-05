# Handoff for critical review: Nava pilot recovery (2026-11-04)

**Ask:** attack this plan and the review behind it. Find wrong facts, wrong priorities, missing work, a bad ETA and unsafe steps. Agreement is not useful. Check every claim yourself in the repo before you accept it.

Repo: `/home/ubuntu/projects/zero`. Read code at `origin/main` = `70f42e7c8`. Deployed runtime = `1e2b2f7a0` (#999). The only commits between them are two docs-only commits (`7e871275c`, `70f42e7c8`), so the code at both is the same.

Labels used below:
- **V** = verified in code or git this session, with the reference given.
- **I** = inferred, not tested.
- **U** = unverified or open.

---

## 0. Reviewer rules (hard)

1. **Read only.** No HMS writes, no deploys, no flag changes, no pushes, no PRs.
2. **Never send credentials or secrets anywhere.** Never source `.env.production`. Never test against pilot RDS. Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL` before any test.
3. **No local `tsc`/`tsgo`.** The VPS freezes. Don't typecheck at all; this is a review.
4. **Don't touch GitHub Actions.**
5. **Don't modify other sessions' worktrees.** That includes the root checkout, which is behind main and dirty.
6. **Section 2 is decided.** Don't reopen it. You may say a decision is *unsafe* if you can show evidence, but don't re-ask it as a question.

---

## 1. Situation

- **Product:** Nava, an AI reservationist for Legacy Hotels Centurion (HRCEN).
  - Staff use a pane in classic Outlook (VSTO + WebView2), and the same pane in nava-admin webmail.
  - The backend is `apps/server-pilot`. Deterministic Playwright tools drive Infor HMS Cloud.
  - HRCEN moved to Infor Cloud on 2026-10-27 (`hmsweb.hms.eu1.inforcloudsuite.com`, tenant `THECENTURION_PRD`).
- **Status:** the staff pilot is more than 2 days late, and the owner says their job is at risk.
  - Quote works.
  - Create, Amend, Cancel and Filing do not work for real guests from the pane.
- **Plan under review:** `docs/plans/2026-11-04-001-feat-m1-recovery-plan.md`.
  - 4,997 words, 35 tasks, 29 "checkpoint"s, 12 "Unknown"s.
  - Roughly 400 LOC of real product change.
  - No ETA, although the owner asked for one 3 times.
- **My review:**
  - `REVIEW.md` is v1 and **partly superseded**; see section 10.
  - `TRACKER.md` v2/v3 is current.
  - Lane research is in `lane-*.md` in this folder.

---

## 2. Owner decisions (fixed; on main in `PRODUCT.md`/`AGENTS.md`, commit `7e871275c`)

| # | Decision | Source |
|---|---|---|
| D1 | Every HRCEN write flag (Create, Amend, Cancel, Filing) may go `lab`→`on` as soon as that workflow works. Real writes happen only on staff **Go** in the pane. Agents never Save on a real guest. | owner 2026-11-04: "I'm okay with enabling every single flag from lab test to rights right now" |
| D2 | CMS confirmation is a staff **tick box** (default on), plus a message ID and a recipient email, all editable. HMS sends the email only if the box is ticked. Nava never sends email. | owner; earlier 11-02 "option B sounds good" |
| D3 | **Cancel penalty:** show the HMS charge, and staff decide with a second Go. The old rule "never accept a penalty dialog" is deleted. | owner S:493 19:38 "Show charge; require second staff approval in Nava" |
| D4 | **No unpaid/payment gate.** "zero deposit doesn't establish no payments. I don't give a shit… we pull information, and we let them decide." | owner S:439 19:36 |
| D5 | **No whole-body or field-count pins** (985 keys). Check the business fields staff actually fill, before and after Save. | owner |
| D6 | **Proof method:** (1) run the real tool on a real inbound email's details in the backend and stop before Save; (2) one Labtest Save + fresh readback on deployed main. No pane clicking, no numbered probe loops. | owner; `AGENTS.md` |
| D7 | **No new tests** unless the owner asks. Minimal ceremony. | owner S:15 "as little ceremony and as little testing as possible" |
| D8 | **No fallbacks.** Timeboxes are OK. The ETA may stretch 1.5×. | owner |
| D9 | **Amend fields:** dates/nights, room type, adults, children + ages, rate plan, guest details, CMS, and any other field with a deterministic tool. Rate options are sorted by corpus frequency. | owner |
| D10 | **Core is Create, Amend and Cancel** (plus Filing): "not enough to just do the prefilling and reads". | owner S:4716 01:04 |
| D11 | Amend and Cancel are **separate lanes**, built by Codex GPT-6.1 coders and watched by one GPT-6.1 "Sol Ultra" watcher scoped against ceremony. | owner |
| D12 | **Wipe the HRCEN hard-refusal code** in Cancel and Amend. "just wipe that shit". | owner (see claim A1: what the refusal actually guards) |

---

## 3. Already done this session

| What | Where | Note |
|---|---|---|
| PRODUCT.md rewritten to pilot-now (1,122→866 words) | main `7e871275c` | pushed at the owner's request |
| AGENTS.md rewritten (1,195→613 words) | main `7e871275c` | |
| Dev-era write rules removed from HMS tool docs and `.cursor/rules/nava-workflow.mdc` | main `70f42e7c8` | **docs only; the code is still Labtest-pinned** (see section 4) |
| Agent memory cut from 86 files to 8 | `~/.claude/projects/.../memory/` | backup `/tmp/memory-bak-20261104` |
| 3 skills edited (penalty rule, preserve-rules line) | `/home/ubuntu/.agents/skills/{nava-run,zero-plan,building-hms-playwright-tools}` | `references/traps.md:21` not edited |
| Nothing executed | — | no code PRs, no flag flips, no HMS writes |

---

## 4. Evidence ledger (origin/main `70f42e7c8`)

### 4.1 Create

| # | Fact | Label | Reference |
|---|---|---|---|
| C1 | **P0:** the pane drops `childAges` when it is empty, and the server then refuses with `child_ages_required`. So every adults-only Create from the pane is refused. | V | `apps/mail/lib/quote-workflow/pane-stay-bind.ts:400,427` (`...(childAges.length ? { childAges } : {})`); `apps/server-pilot/src/ai/pane-create-cloud-input.ts:88-89` |
| C2 | Earlier proofs bypassed the pane builder. The operator script sent `childAges:[]` directly, which hid C1. | V | `~/.codex/m1-20261103-203425/create-canary2-preview.sh:17` |
| C3 | Lab mode refuses an unsaved preview for a real guest (`cloud_preview_labtest_only`). Flipping `PANE_WRITE_CREATE=on` lifts it. | V | `apps/server-pilot/src/ai/pane-cloud-preview.ts:116-118` |
| C4 | The Cloud mapper refuses `confirmationSendMail===true` and hard-sets `cms.send:false`. | V | `pane-create-cloud-input.ts:56-57,148-149` |
| C5 | `reservationNote` is required (`staff_note_required`). The native guest id is required at commit. | V | `pane-create-cloud-input.ts:91,120-122` |
| C6 | Save pins `CREATE_MODEL_FIELD_COUNT = 985` plus a sha256 of the key set. `saveNewLabtestStay` has about 15 throw paths and expects `udfchkbox04:'0'` (CMS off). | V | `tooling/hms-cloud/guest-stay-save.mjs:32-48,562-680` |
| C7 | The legacy Create clicks **Check Availability** before Save. The Cloud Create does not; the shared read-only guard blocks that path. | V | legacy `tooling/playwright-quote/create-lab-stay.mjs:1247`; `hms-read-only-guard.mjs:39-63` |
| C8 | **Counterevidence to C7:** PR #870 (11-02) did one guarded HRCEN Labtest Create on Cloud **without** Check Availability, with readback matched. | V | `tooling/hms-cloud/guest-stay-save.md` (~line 125); commit `1dcbc55e6` |
| C9 | The 11-03 23:33 Create failed with HMS "Rate is not available". Uncertain hold `a290e545-…` is preserved, and a census found no same-arrival stay. | V (log) / U (cause) | paused retro; `TRACKER.md` |
| C10 | PR #1000 (`ea70d7283`, **still OPEN**) adds the Check Availability click with a one-shot exact-request guard exception. Its matcher hardcodes `112` and case-folds field keys. It also adds startup assertions in `lookup.mjs` for a Vault startup race. | V | `guest-stay-rate-plan.mjs:13-15,247-286` on that PR |
| C11 | Create is a **two-session flow**. Go (`commitPaneCloud`) opens a fresh browser session and restages before Save, so Prepare's page state is not reused. | V | `pane-cloud-preview.ts` / commit path; this kills plan U2.2 "same current draft" |
| C12 | The legacy Create schema has 24 request fields, 10 of them required. That is what the tool accepts, **not** a census of what staff type. | V | `tooling/playwright-quote/create-tool.schema.json` `$defs.request` |

### 4.2 Cancel and Amend: the HRCEN refusals (**corrected this session**)

| # | Fact | Label | Reference |
|---|---|---|---|
| R1 | HRCEN Cancel and Amend are hard-refused in 4 places. | V | `pane-stay-cancel.ts:301-303`; `pane-hms-write.ts:868-870` (amend preview), `:986-990` (queued cancel), `:1016-1017` (queued amend) |
| R2 | **Why they exist:** all four came from #963 "Hold unfenced Centurion amend and cancel paths" (`9a74faca6`, 2026-11-03 04:43). The code comment says: "legacy path has no durable target hold… cannot respect other uncertain HMS writes" and "edits the native form without a request fence". **This is a concurrency and uncertain-write fence. It is not because the tool can't reach Cloud.** | V | `git blame` on those lines |
| R3 | The legacy tools **do reach the Cloud tenant.** Pane Cancel spawns `tooling/playwright-quote/cancel-stay.mjs`, and Amend spawns `amend-stay.mjs`. Both log in with the HRCEN registry secret (`nava-zero/server-pilot/infor-hms-read`), whose `loginUrl` other code asserts is the Cloud origin and tenant. `fetch-quote.mjs:75` handles both the on-prem and Cloud screen builds. | V (host) / **U (DOM steps work on the Cloud build)** | `pane-stay-cancel.ts:33-35`; `property-registry.mjs:49-59`; `centurion-stay360.mjs:15-47` |
| R4 | Legacy Amend was patched on 10-27, the move day: occupancy combo, Ext writability, and dates via blur. It has not been proven on Cloud since. | V (commits) / U (works) | `d252ab78a`, `86610bf6b`, `b9c6367b0` |
| R5 | Legacy `amend-stay.mjs:2` says: "Rate, penalty, and charge dialogs are always refused." That **conflicts with D3 and D9.** | V | file header |
| R6 | `cancel-stay.mjs` already has `--allow-real-guest` ("server passes it… in on mode"). `pane-stay-cancel.ts` has `LAB_ARRIVAL_FLOOR = '2027-01-01'`. | V | `cancel-stay.mjs:14`; `pane-stay-cancel.ts:36` |
| R7 | Amend refuses unless `classifyAmendPayment(stay) === 'unpaid'` (`refused_payment_unknown`). That contradicts D4. | V | `pane-hms-write.ts:1015` |
| R8 | The Cloud cancel `tooling/hms-cloud/guest-stay-cancel.mjs` (319 lines) pins the whole body to Proof/Labtest, NGI and blank parties. | V | `:41-171` |
| R9 | The candidate Cloud cancel in worktree `~/.codex/worktrees/810e/zero` (`64d1caf57`, clean, 12 behind main) has about 711 LOC of core: `pane-cloud-cancel.ts` 406, recovery 110, session 205, association scope 247. | V (sizes) / U (quality) | lane-cancel-amend.md |
| R10 | The candidate Cloud amend in `ee01` (`b44f134fe`, 73 dirty paths) includes `pane-cloud-amend.ts` 301, `pane-amend-session.mjs` 639, `guest-stay-amend-adults.mjs` 444 and `guest-stay-amend-date-room-rate.mjs` 589. Adults-only native Save is proven. **Dates are not.** The 11-03 lane took 268 min against a 65-min target. | V (sizes, log) | lane-cancel-amend.md |
| R11 | **Penalty sequence:** the HRCEN evidence dates from 10-25, **before the Cloud move**. The status went Reserved → Cancelled, *then* the "Cancellation Penalty of 2060.00… OK" dialog appeared. HRDAV accepted its penalty. The order on the Cloud build is unknown. | V (old log) / U (Cloud) | DoD5 evidence |
| R12 | I did not find a clear "durable target hold" helper for Cloud writes. The only related code I found is the Create batch holds (`pane-cloud-preview.ts:101-293`, state-scoped) and `target_hold_missing` for Attach (`pane-hms-write.ts:1380`). **What #963 meant by the "shared durable hold" is open.** | U | — |

### 4.3 Filing and pane

| # | Fact | Label | Reference |
|---|---|---|---|
| F1 | The voucher find card needs an extracted surname + arrival and exactly one row. Staff can't search or pick a stay. | V | `apps/mail/.../voucher-find-card.tsx:201-230,452-457` |
| F2 | The voucher card key lacks the selection epoch and source hash, so it can go stale on a source change. | V | `booking-voucher-card.tsx:107-120` |
| F3 | No PDF upload with Documents readback has **ever** been proven. The only evidence is a 64-byte text upload (HTTP 200) on 11-01. | V | lane-filing-release.md |
| P1 | 15 raw technical strings render verbatim to staff. Create preview/Book shows no message past 30 s. The CMS checkbox is a dead control. | V | lane-pane.md |

### 4.4 Release mechanics

| Fact | Label | Reference |
|---|---|---|
| Flags are written with `deploy/write-ec2-remote-env.sh --m1-only` + `ops-restart.sh`. HRCEN requires a line `CANARY PASS <workflow> HRCEN <40-char sha>` in `${NAVA_CANARY_PASS_FILE:-/tmp/mh1024/CANARY.txt}`. **No in-repo producer exists.** | V | `write-ec2-remote-env.sh:466-599` |
| Flags must be verified in all 4 PM2 processes (`http`, `worker`, `ai-worker`, `remote-http`). | V | AGENTS.md |
| Deploy takes about 5m19s. The #999 review→merge→deploy→audit took 11m27s. Remote typecheck takes 27 s to 3 min. | V | logs |

### 4.5 Corpus (for D9 rate sorting)

- **Email bookings (n=492):** top 5 rate codes cover 93.3%.

  | Code | Share |
  |---|---:|
  | NGOVDB | 41.5% |
  | NCOR1B | 19.3% |
  | NGOVB | 12.8% |
  | NCOR2B | 10.6% |
  | BAR | 9.1% |

  Source: `docs/research/halloween/memory-experiments/2026-10-30-party-memory-and-lookups.md:33,47`.
- **Broader cohort (612 stays):** top 7 cover 96.9% (`source-cohort-and-cloud-tool-design.md:14-19,59-70`).
- **Amend mix (n=223 heuristic thread events):** people/occupancy 30.0%, extend/add nights 7.6%, both 2.2%. Room, rate and children are not split out (`docs/research/2026-10-20-arch-lanes/l2-amend-payment.md:106-112`).

---

## 5. Diagnosis: why the past week failed

1. **Knowledge was lost in the Cloud rebuild.** Legacy step lists such as Check Availability before Save were not ported, and there was no checklist for porting them.
2. **Proofs bypassed the pane.** Operator scripts hid the childAges P0 (C1, C2).
3. **Lab mode blocks real-guest unsaved previews** (C3), so no real email has been prepared end to end.
4. **Fail-closed matchers are hyper-strict:** 985-key sha256 pins, whole-body pins and a hardcoded 112. Any HMS form drift stops the write (C6, C10, R8).
5. **Native Save was attempted last,** after review and deploy, so failures surfaced at the most expensive point.
6. **Ceremony crowded out product.**
   - Since 11-01: tests +29K lines vs product +18K.
   - 10 plans and about 396K words of docs.
   - Evening run 20:34–00:25: product +565, tests +67, docs +15,257 (one commit `23c8126a8` alone was +15,257).
   - 51 operator `.sh` scripts and 46 `create-canary2-*` numbered-probe artifacts.
7. **ETAs were missed 2–4×** and never recalibrated (section 8).

---

## 6. Verdict on plan 2026-11-04-001

| Item | Verdict |
|---|---|
| Goal (real-guest Create/Amend/Cancel/Filing from the pane) | Right |
| U2.2 "Go saves the same current draft" | **Wrong premise.** Go uses a fresh session and restages (C11). |
| Wave C | Runs Prepare only, which proves nothing about Save. |
| U6 "installed proof" | Repeats the operator-script blind spot (C2). |
| CMS = "manual" | Contradicts D2. |
| U7/U8 | One owner, serialized, no source for the ordering. |
| U3.3 reset/freeze | No API exists. |
| U4 joint helper | Cut. |
| Size | 35 tasks / 29 checkpoints for about 400 LOC. Ceremony. |
| ETA | "Unknown", 3 times. |
| R10 charged-cancel second approval | Kept; owner-sourced (D3). |

---

## 7. Proposed lanes (my plan; not yet written as a plan file)

The four lanes run in parallel and each owns distinct files. One PR per connected workflow (pane → route → tool).

### Lane A: Create (critical path)

1. **Fix C1.** Always send `childAges` as an array (`pane-stay-bind.ts:427`), or default it to `[]` in the mapper.
2. **Prove on the backend:** run a real inbound email through the real Cloud Create tool in prepare mode, and stop before Save.
3. **Check Availability:** add it to the shared staging step used by both Prepare and Go, with a narrow one-shot guard exception. Take PR #1000 but fix its matcher (drop the hardcoded 112 and the case-folding). **Only if** the staged state needs it (C7 vs C8).
4. **Replace the 985 sha256 pin** with checks on the business fields (C6, D5).
5. **Show the HMS price** on the Create card before Go (`booking-card.tsx:173-195,1841-1846`).
6. **CMS tick box:** wire it through the card → mapper → `create-reservation.mjs` → `guest-stay-save.mjs` `udfchkbox04`. Estimated at about 35–60 LOC. Keep CMS off on Labtest.
7. **Release:** one Labtest Save + readback on the deployed SHA → CANARY line → flag `on` → 4-process audit.

### Lane B: Filing

1. First-ever Labtest **PDF** upload + Documents readback through the existing uploader (F3).
2. Pane: editable surname/arrival, an explicit Search (`amend-find.ts` `searchRequestFor`), a row picker, resolve via `findRequestFor`, and invalidate on source change (F1, F2). About 60–100 LOC.
3. Promote the Attach flag.

### Lane C: Cancel

1. Remove the HRCEN refusals (R1). **But** keep or replace the fence they provided (R2, R12): the cancel must take the same property/target hold as Cloud Create, or run under it.
2. Choose one tool:
   - **(i)** the legacy `cancel-stay.mjs` with `--allow-real-guest` (R3, R6); its DOM steps are unproven on Cloud;
   - **(ii)** generalize the Cloud `guest-stay-cancel.mjs` (R8);
   - **(iii)** port 810e (R9).
3. Drop the unpaid classifier and the 409-line finance preflight.
4. **Penalty:** show the charge → second Go decides whether to click OK (D3). The sequence on Cloud is unknown (R11).
5. **Proof:** Labtest Create → Cancel → readback.

### Lane D: Amend

1. Remove the HRCEN refusals and the unpaid gate (R1, R7), with the same fence caveat as Lane C.
2. **Fields:** D9. Rate plan shows the top 5–7 corpus codes with HMS prices.
3. **Prepare** stages the change + Check Availability, accepts HMS's default reprice, and shows the new total. **Go** = Save + readback.
4. Port the legacy `amend-stay.mjs` step list; reuse the `ee01` modules. Remove the "rate dialogs always refused" behaviour (R5). Fix the tax-refresh step that was misclassified UNKNOWN.
5. **Cut:** per-night overrides, the exact-price freeze, and any date "spike" task.
6. **Proof:** Labtest Save + readback.

### Coordinator and watcher

- **Coordinator:** merge gate (`scripts/orch/merge-gate.sh`), at most 2 deploy bundles, flags and CANARY lines.
- **Watcher** (GPT-6.1 Sol Ultra, owner's choice): every ~15 min, checks each lane's diff:
  - is it product code?
  - is it on the lane's own files?
  - does it add more than ~10 lines of tests, docs or probes?

  The watcher never writes code.

---

## 8. ETA

**History, past week:**

| Run | Estimate (min) | Actual (min) | Result |
|---|---:|---:|---|
| Plan 005 | 340 | 339 | superseded |
| Option A | 120–165 | 274+ | no deploy |
| Evening M1 | 120 | 231 | paused, 0 writes |
| U3 Amend lane | 65 | 268 | open |

**My current estimate** (from execution start; low confidence; recalibrate after Lane A's first Labtest Save):

| Milestone | P50 | P80 |
|---|---:|---:|
| Create + Filing on | ~3h | ~4h30 |
| Cancel on | ~3h30 | ~5h |
| Amend on | ~5h | ~7h |

The past-week ratio is 2–4×. My P50 already assumes about 2× over raw coding time. Attack it.

---

## 9. Claims to attack (ranked by how much they change the plan)

| # | Claim | Why it may be wrong |
|---|---|---|
| A1 | "Wipe the HRCEN refusals" (D12) is safe if done inside Lanes C/D. | R2: they are a double-write fence from #963, not a reachability guard. Wiping the lines alone removes the uncertain-write protection. What is the minimum fence that satisfies "never blind-retry"? Does one already exist (R12)? |
| A2 | Legacy cancel/amend could be the fastest route (R3). | They reach Cloud, but their DOM steps are unproven on the Cloud build, and legacy amend refuses rate dialogs (R5). Is legacy, Cloud generalize, or a candidate port the fastest **proven** path? |
| A3 | Check Availability is the Create fix. | C8: #870 saved without it. Is "Rate is not available" (C9) a staging-state problem, a rate/date availability fact, or an artifact of the hold? Does the click change the Save key set? |
| A4 | Hold `a290e545` doesn't block the next Create. | U. Read `cloudCreateHoldOf` and the batch holds (`pane-cloud-preview.ts:217-300`). |
| A5 | Flipping flags `on` early is safe and useful. | It lifts C3, which enables real-email prepare in the pane. But does `on` before the C1 fix risk anything beyond refusals? Real Save still needs staff Go. |
| A6 | The penalty flow = show the charge + second Go. | R11: if HMS has already set Cancelled before the dialog appears, "staff decide" may be moot. What does the second Go actually control on Cloud? |
| A7 | Business-field checks can replace the 985 pin without losing safety. | Which fields? The 24 from the schema are what the tool accepts, not what staff type (C12). |
| A8 | Stop-before-Save on a real email + one Labtest Save is enough proof (D6). | Can a real-guest Go fail in a way neither proof covers (e.g. a different guarantee, agency or A/R)? |
| A9 | Four parallel lanes with separate files. | `pane-hms-write.ts` hosts both the Amend and Cancel refusals and queues. Is a merge conflict or shared-file serialization likely? Is Lane A really independent of the hold work in C/D? |
| A10 | The ETA in section 8. | Past ratio 2–4×, unknown Cloud DOM for cancel/amend, Filing never proven. |
| A11 | The memory cut (86→8) lost nothing needed. | Greptile/merge/Orca operational facts now live only in AGENTS.md and skills. Is anything missing that an executor needs? |
| A12 | Pushing the rule rewrite straight to main was fine. | The owner asked for it. Check for broken references or deleted safety rules that still matter (pilot RDS, secrets, `--no-verify`). |

---

## 10. My known mistakes this session (discount these)

- `REVIEW.md` v1 contains superseded content:
  - "keep the unpaid gate" (contradicts D4)
  - D1–D4 posed as open questions
  - Check Availability stated as the proven root cause (see A3)
  - fallbacks and a 30-min date spike (contradicts D8)
  - an ETA of 1h35/2h30
  - it also missed the startup race
- I told the owner the HRCEN refusals guard legacy tools that "can't reach Cloud". **Wrong:** see R2 and R3.
- I quoted "20 fields" before checking; the correct number is 24 (C12).
- I re-asked the CMS decision after the owner had already decided it.
- I proposed a watcher model based on a stale memory ban.
- I overindexed on agent architecture (Mastra) instead of the plan.
- I opened two ETA-ledger rows and never closed them.

---

## 11. Read in this order

1. `PRODUCT.md`, `AGENTS.md` (main): the rules.
2. `docs/plans/2026-11-04-001-feat-m1-recovery-plan.md`: the plan under review.
3. This file, then `TRACKER.md` (v2/v3 sections).
4. `lane-create.md`, `lane-cancel-amend.md`, `lane-filing-release.md`, `lane-pane.md`, `lane-owner-asks.md`.
5. The code at the references in section 4. Start with C1, R1–R3 and C6–C10.
6. `REVIEW.md` last, minding section 10.

## 12. Return this

1. **Verdict in one line:** is this plan the fastest safe path to D10? Yes or no, and why.
2. **Wrong facts:** each with a file:line or commit that disproves it.
3. **Missing work:** anything that blocks "Done" (PRODUCT.md "Done") and isn't in a lane.
4. **Cuts:** anything in the lanes not needed for Done.
5. **Order/parallelism changes,** with the shared files that force them.
6. **Your ETA** (P50/P80) per milestone, with its basis.
7. **Top 3 risks** of a double booking or a wrong real-guest write, and the smallest guard for each.

Keep it to 1 page plus tables. Cite evidence for every claim; give no unverified numbers.
