# 2026-10-19 evening retro: party hybrid + pane review sprint

**Verdict: 6 PRs merged and live in 95 min (21:58Z owner review → 23:33Z deploy, `78c29b5ae`), outside staff hours. Four real P1s were caught before staff saw them. Two misses: one lane stalled and needed a coordinator takeover (~25 min), and two P1s were found only after merge, because Greptile reviewed against a stale base.**

Evidence: GitHub PR timestamps, ETA ledger rows `*-20261019` (u2, h2, s3, b4, r5), lane screens, `/tmp/partyv3/deploy-2330.log`, and `/proc` + bundle check at 23:34Z.

## 1. What shipped

| PR | Owner ask | Lane / model | Opened → merged (UTC) | Size (+/−, incl. tests) |
|---|---|---|---|---|
| #412 rooms left on rate cards | 130 / 135 | R5 / Luna max | 22:23 → 22:24 | +94 / −7 |
| #415 Source of business = Email | 137 | B4 / Luna max | 22:28 → 22:29 | +45 / −3 |
| #414 history binds on shared words; no own-brand/country searches | 129 | H2 / Luna max | 22:28 → 22:33 | +258 / −52 |
| #416 stay card: ⓘ, icons, nights dropdown, Skyscanner clicks | 135 | S3 / Luna max | 22:28 → 22:48 | +1384 / −538 (mostly snapshot) |
| #413 step 1 "Agency & company": preset dropdown, ✓ / ✏, Search HMS… | 133 | U2 / Luna max → Opus finish | 22:27 → 23:10 | +1026 / −835 |
| #417 email beats name-only history; Check-out edits departure | Greptile P1s | Opus | 23:12 → 23:28 | +50 / −5 |

Deploy: `ops-deploy.sh` rc=1 only from the 24 h dead-letter gate. Health OK. `PARTY_MATCH_V3=true` and `PARTY_HISTORY_BIND=on` confirmed in `/proc` on http/worker/ai-worker. Bundle `nava-pane-D22iMVfj.js` contains "Agency & company". Last-good before: `1c74f42b5`.

## 2. Lanes vs estimate (ETA ledger)

| Lane | Est min | Actual | Ratio | Stuck / rework | Cause |
|---|---:|---:|---:|---|---|
| U2 step 1 | 70 | 92 | 1.31 | 20 / 35 | Lane wrote tests that diverged from the code, left 9 test type errors + a stale pane snapshot, edited the shared `remote-vitest.sh`, then idled. Coordinator took over at 22:47Z |
| H2 history | 80 | 50 | 0.63 | 0 / 15 | Dropped generic words (coordinator review) and history overriding an exact email name (Greptile) |
| S3 stay card | 40 | 41 | 1.03 | 5 / 10 | Red-first test run; Check-out regression found after merge |
| B4 source | 25 | 22 | 0.88 | 0 / 0 | Clean |
| R5 rooms left | 35 | 13 | 0.37 | 0 / 0 | Small diff, parallel gates |

## 3. What worked

| Practice | Evidence |
|---|---|
| Owner pushback at 22:02Z → re-plan in 5 min: 3 more lanes on disjoint files, gates run in parallel, no self-review subagents | 1 PR planned for 23:15Z became 6 PRs live at 23:33Z |
| Read code before briefing; data checks cut scope | Pre-read keeps `nightly[].inventory`, so R5 was a 4-file change. The HMS read has 0/43 agency ids, so the H2 backfill script was dropped |
| Coordinator reads every product diff before merge | Caught #414's dropped "hotel/consulting" junk words (would have revived junk searches) and #413's contact questions scrolling staff to a step with no contact fields |
| PR watcher (`gh pr list` loop) instead of `tui-idle` waits | `tui-idle` fired falsely 6 times while lanes were thinking |
| One batch deploy | 1 deploy instead of 5; flags and bundle checked once |

## 4. What went wrong

| Miss | Effect | Rule now (MISTAKES.md) |
|---|---|---|
| U2 brief didn't list the tests that assert the old UI | Lane fought 9 test files it thought it couldn't touch; ~25 min coordinator takeover | A UI lane's brief greps the removed strings and lists every test file it owns |
| Lane edited `/home/orca/bin/remote-vitest.sh` | Shared gate briefly ran extra code for every lane | Lanes never edit `/home/orca/bin` |
| Greptile CLI used a stale local `main` | Real P1s on #414/#416 surfaced only after merge (fixed in #417 before deploy) | `git fetch`, then `greptile review --branch origin/main`; one round per PR on its final head |
| Deploy worktree's local `main` was stale | 2 refused deploy attempts (~3 min; nothing shipped) | `git merge --ff-only origin/main` in `recover-parse-failure` before `ops-deploy.sh` |
| Pane snapshot can't come back from EC2 by S3 (PutObject denied) | 10 min finding a route | `vitest -u` on EC2, gzip+base64 the diff, read it over SSM (<24 KB) |

## 5. Still open

| Item | Next check |
|---|---|
| Party score on live code | Replay p9 (same 42 mails, `78c29b5ae`, read-only) vs v2 21/22, 0 wrong → decision doc §5d |
| Owner look at the pane | Before 05:00Z staff start; staff bundle load in nginx after that |
| Asks 134 (real rates in Rate authority), 136 (extras/shuttle trips, R up front) | Next lanes; both touch `quote-workflow-panel.tsx`, now free |
| Ask 132 reusable HMS login | Tracked in WORKSTREAMS §2 row 9 |
