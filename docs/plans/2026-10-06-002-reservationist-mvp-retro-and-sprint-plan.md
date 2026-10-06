# Reservationist MVP — retro + sprint plan (Oct 6 2026, final 21:55 UTC)

Evidence: `2026-10-06-002-reservationist-mvp-evidence-ledger.md` (claim numbers `[L#]`) and subagent reports `/tmp/retro/out-{A,B,C,D}-*.md`. Reviewed once by an engineering pass and a simplicity pass (21:43 UTC); their accepted edits are folded in below.

## 1. Retro — why 4 days produced a regex quote tool

**Time.** Oct 2–6: 44.5 wall-clock active hours (74.75 thread-hours counting parallel threads) [A].

| Label | Wall-clock h | Share |
|---|---:|---:|
| Useful now (on path to shipped quote pane) | 13.75 | 31% |
| Useful long-term | 8.5 | 19% |
| Overbuilt (eval/provenance/qualification infra) | 14.25 | 32% |
| Steering / supervision / blocked / idle | 8.0 | 18% |

The executor's subagents added ~71 agent-hours / 12,764 tool calls; stalls of ~5h (Oct 4) and ~2h45 (Oct 6 morning) went unnoticed [A]. Model spend was never the constraint ($0.99 for 126 Phase B cases; ~$44 cumulative) [B][D].

**Root causes (ranked).**

1. **Product goal fused with statistical qualification.** The Oct 4 plan (15.5k words, 7 gates) required "≥95% eligible completion… on development and untouched holdout", plus hashes, three clocks and per-call quota admission. 10.5h → zero verified business completions [A][D].
2. **Agents optimised proxies.** 1,739 tests and 922 sessions audited for holdout purity while 0/13 business tasks were done [A].
3. **The LLM never reached the product.** Luna code sat uncommitted in another worktree; the UI worker branched from main and wrote a regex. The pilot plan never mentioned Luna [A][L1][L2].
4. **Explicit instructions not honoured.** "Don't over-engineer", "3–4 samples", "pre-fill all of the details" were each overridden [A].
5. **Live PMS in the iteration loop.** 9m55s live vs 1m58s recorded for the same quote [A][L9].
6. **Luna pinned at `max` + a 607 KB multi-call extractor.** Measured single call: 3.8s low / 6.1s medium / 22.7s max [L19]. Prompt at v75 with ~33 KB of edge rules [C].
7. **Supervision theatre + environment friction.** Overnight polling, duplicate supervisors, 46 user supervisor prompts; EPERM ~70 min; 239-entry dirty worktree 44 commits behind main; installer AV diagnosis ~5.75h [A].
8. **Wrong labels, wrong benchmark.** Regex-derived classes; ~5/10 "create" cases weren't new bookings; scorer passed invalid creates [B][D].

**Disconfirmed:** "coding model too weak" — Codex threads ran gpt-6.1-sol high/medium [L7].

**Reusable.** Deterministic quote path on main (`executeStaffQuote` → qualified PDF → unsent draft, proven on a real R8,500 quote); mailbox isolation and stale-result guards; `readAuthorizedArtifactBytes` (S3 + pdftotext); `reservationist-agent.ts` decision schema + `CENTURION_HOTEL_RULES`; `validateCreateRequest`; lab `create-lab-stay.mjs`; the Sep 18–23 Luna extraction lab (0 invented money/occupancy on 252 rows); local corpus (846 inbound Sep 26–Oct 2 + Sep 9–18; 126 gold trigger→reply pairs; 45 staff proposal PDFs; ~118 booking confirmations) [B][C][D].

## 2. Demand

Per working day (±40%; no human-adjudicated census exists) [B][L26]:

| Metric | Value |
|---|---:|
| Inbound mail | ~150–180 |
| Quote requests in | ~6 (4–8) |
| New-booking requests in | ~10 (8–14) |
| Confirmations sent / quotes sent | 13.4 / 3.8 |

Bookings ≈ 2× quotes. Both lanes matter; booking is bigger, quote is closer to done.

## 3. Product

One analysis step for both lanes; tools stay deterministic; staff approve every write; every AI value is labelled "AI suggestion".

1. **Analyse** — one Luna call via Azure (`createAzureLunaModel`, ~30-line adapter), effort `medium`, route deadline 25s, client timeout 45s, env kill switch `QUOTE_WORKFLOW_LLM`.
   - Input: selected email + preceding thread + PDF attachments only (skip inline/images; cap 3 files / ~5 MB / 50 pages; pdftotext first, native PDF only if text is empty). An unreadable file becomes a review item, never `missing_source`.
   - Schema: extend `reservationistDecisionSchema` in place — `workflow` gains `create_booking`; `stayAsk` → `groups[]` (arrival, departure, rooms, `adults_per_room`, child ages, board, room preference, guest names); party (company/agency/IATA); booking refs (voucher/PO); `missing[]` (incl. extras like shuttle as questions); `evidence[{field, quote}]` (display only, not byte-verified). Prompt = `CENTURION_HOTEL_RULES` as-is. Model never outputs prices.
   - Fallback: server regex only, visibly flagged "AI unavailable". Client regex (`page.tsx:281`) removed.
2. **Pane** — workflow badge, prefilled editable groups (existing `patch_group`), "Needs your answer" list. Overnight add: one notes box → re-analyse with staff notes (the lightweight "chat for missing info").
3. **Quote lane** — existing `executeStaffQuote` → qualified PDF → reply draft from a deterministic template over the quote revision (prices only from the revision); optional Luna prose polish, checked with existing `assessReply` → staff edits → unsent Outlook draft with PDF.
4. **Booking lane** — prefilled booking card; PMS codes from a **static defaults table** (most common codes in ~118 confirmation letters, shown as suggestions) + dropdowns from `create-tool.schema.json` enums; instant schema dry-run via `validateCreateRequest`; HMS `--stop-before availability` only on 3 proof cases, serially.
   - Write rules (agreed 21:45 UTC): historical corpus → never saved. **Overnight = zero saves**: server wrapper refuses to spawn the create script without `--stop-before`, with a unit test (the lab default saves then cancels and has a `cancel_failed` outcome). Synthetic far-future save→cancel test runs tomorrow with the user present. Staff Save button enabled tomorrow after the user approves the defaults table and dry-runs.
5. **Out of scope:** cancellations/amendments, groups ≥10 rooms/conferences (manual, with extracted facts), shuttle/extras pricing (asked as question), installer signing / AV issue, Windows Outlook acceptance, sending.

## 4. Evaluation — small, outcome-labelled, never a gate

- **Class labels from outcomes** (corpus `inReplyTo` join only): staff replied with quote PDF/typed rate → `quote`; PMS confirmation letter → `create_booking`; else `other`. **Field gold** from the existing 126 gold trigger→reply pairs and 45 proposal PDFs; no new adjudication pipeline.
- **Tonight smoke:** ~60 outcome-labelled cases (20 quote / 20 booking / 20 other), text-only, standalone script on main with explicit corpus path (`.private/reservationist-backtest/corpus/messages.jsonl`). ~10 min runtime.
- **Overnight:** all outcome-labelled cases in the dev week; optional second-week check on local Sep 9–18. No exporter, no untouched holdout.
- **Scoring in code:** class confusion matrix; exact match on dates, rooms, adults/room, board; false-filled fields; invented price = fail. No LLM judge.
- **Gates:** only "0 invented prices". Recall/accuracy numbers are reported, not gating. Max 2 prompt rounds.
- **Limit stated:** only ~8 PDFs are local, so offline numbers measure body text; PDF reading is proven on the host with 3 real emails.

## 5. Schedule (UTC; all times assume "go" at ~22:00)

| Block | Work | Done when |
|---|---|---|
| 22:00–22:10 | Branch `feat/luna-reservationist-mvp` from `main`; Azure adapter, effort param, kill switch | compiles |
| 22:10–22:50 | Analyse service + extended schema; loader PDFs; drop `missing_source` gate; 25s/45s timeouts; route tests with fake adapter (timeout→flagged fallback, attachment failure→review item, cross-mailbox→`unsynced`, schema mapping) | tests green, no DB |
| 22:50–23:15 | Smoke backtest 60 cases → table; user skims ~10 failures | table in ledger |
| 23:15–23:45 | Pane: badge, prefill, "needs your answer", AI-suggestion label; build; **deploy with user present**; read-only nginx timeout check; 1 real email analysed on host | health green |
| Overnight (no deploys, no PMS writes) | (a) full dev-week scoring ~1h · (b) 3 live read-only HMS quote proofs, serial ~1h · (c) reply template + optional Luna prose ~1h · (d) booking card + defaults table + schema dry-run + 3 `--stop-before` + create-guard test ~2.5h · (e) notes→re-analyse ~45m · (f) PR staged + morning report ~30m | ticked in `.superpowers/sdd/progress.md` |
| 07:30–09:00 | Deploy staged PR (~15 min); user tries ~5 real emails; approve defaults table; synthetic far-future save→cancel with user; enable staff Save | DoD |

**ETA honesty (21:55 /95 check):** block times above are engineering estimates, not measurements, and were compressed to fit the user's window. Calibrated from history: the prior agent estimated 60–90 min for the same Luna wiring; the entire quote pane took ~11–12 useful hours; UI-only work ran 23:12–04:21; integration + review + merge ran 09:44–13:25. Realistic range for the tonight slice (adapter + analyse + loader + timeouts + tests + pane + deploy): **2.5–3.5h**, so a deploy before the user leaves at ~23:15 is unlikely unless the slice is cut to server analysis + existing prefill UI (~1.5–2h).

**Throughput calibration (22:00, git):** quote-UI branch 23:24→04:21 = 14 commits / ~8k inserted lines; clear-scope feature commits of 400–1,200 lines (incl. tests) landed every 20–45 min; review-fix commits every ~11 min (12:56→13:29); PR #30 merge→deploy ~15 min. Tonight slice ≈ 500 prod + 300 test lines → **median ~2h, P80 ~3h** to deploy-ready. Overnight queue (22:00→08:30 = 10.5h) sized at ~9.8h of median estimates, in priority order so any stop point is shippable:

| # | Item | Median | Done check |
|---|---|---:|---|
| 0 | WIP-commit feature worktree to `wip/` branch; branch `feat/luna-reservationist-mvp` from main | 5m | branches exist |
| 1 | Analyse slice (adapter, schema, PDFs, gate removal, timeouts, route tests, pane badge/prefill/needs-answer) → deploy | 2h | real email analysed on host |
| 2 | Dev-week scoring script + run + table | 1h | table in ledger, 0 invented prices |
| 3 | Booking ladder 1–3: mapping/guard/duplicate-key tests; 20 past booking emails vs confirmation letters; 3–5 HMS `--stop-before` serial | 3h | per-field match table + screenshots |
| 4 | Booking card UI + static code defaults (derived from confirmation letters) | 1.25h | card renders prefilled, Save disabled |
| 5 | Booking ladder 4 (if user approves): ≤5 synthetic far-future lab stays save→readback→cancel→readback | 45m | 5 cancelled-verified |
| 6 | 3 live read-only quote proofs on host + reply template | 1.5h | 3 PDFs + unsent drafts |
| 7 | Playwright video/screenshots of pane flows; morning report | 1h | `docs/plans/handoff-reports/2026-10-07-*.md` |

If tonight runs behind at 23:15: deploy the server analysis with the existing prefill UI; badge/polish moves overnight. Overruns cut scope, never add infra.

## 6. Definition of done (tomorrow ~09:00)

1. Selecting any inbound in the deployed pane shows within ~30s Luna's workflow + prefilled groups/party + "needs your answer" items with source quotes; PDFs are read or flagged, never skipped.
2. One dev-week table (denominators stated): class confusion, critical-field exact match, invented-price count = 0.
3. Quote lane: 3 real emails end-to-end on the host — AI prefill → staff edit → live read-only HMS → qualified PDF → reply draft → unsent Outlook draft.
4. Booking lane: ≥3 real booking emails prefilled with suggested PMS codes, passing schema dry-run and HMS `--stop-before`; Save enabled only after the user's morning approval.
5. Merged to `main` via normal pipeline; rollback = previous main commit.

## 7. Process rules

- This page is the plan; acceptance = the user journey, not test counts.
- One executor + `.superpowers/sdd/progress.md` ledger. No supervisor sessions, cron monitors or periodic reports.
- Branch from `main`; nothing product-critical left uncommitted in side worktrees.
- Luna path always on; regex only as flagged fallback. Effort `medium`.
- Recorded fixtures for iteration; live HMS only for the 3+3 proofs, serially.
- Safety: no pilot-RDS tests; no sends; no PMS saves overnight; no unattended deploys.
