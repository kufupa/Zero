# 2026-10-19 Chat A handoff: HMS speed

Chat A of [2026-10-19 parallel chats](2026-10-19-parallel-chats.md). Evidence: [HMS queue wait diagnosis](../research/2026-10-19-hms-queue-wait-diagnosis.md).

## Done

| Item | Result |
|---|---|
| 1. `staff quote execution failed` dead letters | 5, not 7, in the last 96 h. All were **system-prepared** quotes (1 attempt by design) failing at CDP `attach` during the overnight burst; 4/5 were days-old backfill mail. No staff-kicked quote dead-lettered |
| 2. Party wait | The 72 h p50 (411 s) was one burst: the 18 Oct 21:00Z re-extraction of 2,044 mails queued ~175 background party reads on the one HRCEN browser. Staff-hours wait today was 1–3 s. Queue order was never the cause (quote prep already outranks party prefetch, `run-ledger.ts:653`). Fix: [#376](https://github.com/kufupa/Zero/pull/376), merged as `57b23c965`: no background party/quote prep without a live admission snapshot; party prefetch + quote-ready skip `action=no_action` |
| 3. Party run time (~70 s) | One step dominates; see below |

## Bar (owner, 2026-10-19)

Bar A: staff-kicked party wait p50, plus the share of quote/booking mail whose party result is ready before staff open it. `< 120 s` is a starting guideline, not a pass line; improve as far as the evidence allows. Every number needs an evidence basis or is labelled a guideline.

## Party run time: where it goes

Evidence: event timestamps in `.private/pms-pipeline/party-lookup/out/*/events.jsonl` on EC2, read-only, 2026-10-19.

| Per `party-lookup.mjs` spawn | Time |
|---|---|
| New browser context + HMS login | ~4–6 s |
| Open Guest Stay + New Record | ~4–5 s |
| The actual company/agency search | **2–4 s** |

A V2 party job runs several spawns in a row (terms × company/agency). Example: 6 spawns, 09:53:59 → 09:55:21Z = 82 s. About 75% of party time is repeated login and navigation.

**Next slice (not started): reuse one logged-in session per property.** `feat/oct18-hms-slots` already builds the pieces: `slot-session.ts` (`withRead` / `recover` / `reset`, generation fencing), `slot-owner.mjs` (native persistent Chromium), the `hms-slot@.service` template, property-keyed locks and HRDAV routing. What it does **not** do yet: `party-lookup.mjs` still creates a context and logs in on every spawn (`party-lookup.mjs:871–887`). Expected after reuse: ~12 s → ~3–4 s per search (estimate from the table above, not measured).

Open design questions for the owner (main chat):

1. Session reuse inside the slot owner (long-lived page; searches run in it) vs. keeping the spawn-per-read model but skipping login when the context is already authenticated. The first is faster; the second is the smaller diff.
2. Batch the V2 terms into one spawn (one login, N searches) as an interim step. ~60–70% cut with no slot work; touches the V2 orchestration in `pane-party-lookup.ts` / `hms-jobs.ts`.
3. Slots branch size: 608 product lines (> 500 limit). Suggested split: 4a = read target + property-keyed locks + HRDAV routing (`f5442a15c`, `12e988f14`, `1e680e812`, `62375df57`); 4b = slot session + owner + systemd (`d810ef665`, `303a81d1f`). `git merge-tree` against `57b23c965`'s parent: clean.
4. HRDAV login: is the Nava Da Vinci HMS account provisioned on EC2? Needed for the parallel HRCEN+HRDAV proof.

## Holds / known gaps

- 5 `executeHmsJob` tests in `tests/hms-party-job.test.ts` fail on `origin/main` (env missing in `getDb` via `resolveHmsReadJobTarget` → `guardCenturionHmsMailboxOrigin`). Predates #376. Probably needs `getDb` mocked or `db` threaded into the origin guard.
- No disposable test Postgres exists on the VPS or EC2 today; DB-gated tests (`describe.skipIf(!TEST_DB_AVAILABLE)`) are skipped by `remote-vitest.sh`. #376's 2 DB cases have not run anywhere.
- CDP `attach` failures under sustained load are not explained beyond "burst". Watch for new `staff_quote_failed … phase: 'attach'` in `ai-worker-error-*.log`.
- `ops-run.sh` / `prod-health.sh` in `/home/ubuntu/projects/zero/.worktrees/` point at a deleted worktree (`centurion-dashboard-tools`); copy with `D=` set to any current worktree's `apps/server-pilot/deploy`.

## Next acceptance check

After the deploy of `57b23c965`: (1) the next live quote mail still gets a prepared quote and a party read; (2) no party job is created for snapshot-less runs or `no_action` mail; (3) staff-kicked party wait p50 over the next staff day, reported against the < 120 s guideline.
