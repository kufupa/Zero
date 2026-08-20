# Handoff: Mastra Centurion draft backtest (2026-08-07 overnight)

**Clock at write:** check `TZ=Europe/London date` — hard stop **08:00 Europe/London**. Soft warn **07:15**. Workable stop OK; finish proper work, not force-complete.

**Branch tip (local):** see `git log -1 --oneline` on `EC2-pilot`.

## Guardrails (held)

- No PMS writes / edits / deletes
- No SMTP send / no `outbound_send_queue` enqueue from backtest
- No Vitest against pilot RDS (`unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest)
- Missing facts → `[MISSING: … | how: …]` brackets, not invented rates/balances
- Eval store only: `/opt/nava/shared/draft-backtest/<runId>/`
- PII: aggregates + id hashes in reports; bodies stay on EC2 private disk

## What landed

| Area | Status |
|------|--------|
| Plan | `docs/superpowers/plans/2026-08-07-mastra-draft-backtest-overnight.md` |
| Bracket policy | `formatMissingBracket` + tests |
| Phase B tools on claim-safe | folio / sent-email / list-docs in `candidateToolEffects` |
| Backtest module | `src/ai/draft-backtest.ts` + `draft-backtest-agent.ts` |
| CLI | `scripts/run-centurion-draft-backtest.ts` (`--offline-fixtures` \| `--live-corpus`, `--draft signals\|claim-safe-stub`, `--sample gold-pairs\|all-inbounds`) |
| Scorer | invent / missing-bracket / gold-kind / `LOW_GOLD_COVERAGE` + soft Jaccard |
| Unit tests | `tests/draft-backtest-scorer.test.ts`, `tests/draft-bracket.test.ts` (disposable; no pilot) |

## Live EC2 scorecards (PII-free)

| Run | Mode | Scored | Invent rate | Notes |
|-----|------|--------|-------------|-------|
| overnight-2026-08-07-c | gold sample | 8 | 0 | first gold-bearing sample |
| overnight-2026-08-07-e | signals + html gold | 8 | 0 | soft overlap ~0.04 after html_body fallback |
| overnight-2026-08-07-g | claim-safe-stub | 8 | 0 | stub not_found → brackets |
| overnight-2026-08-07-i | all-inbounds 200 | 200 | **0.35** | invent from echoing inbound literals into draft |
| overnight-2026-08-07-k | all-inbounds 200 (no echo) | 200 | **0** | invent gate green; 200× NO_GOLD_REPLY expected |
| overnight-2026-08-07-m | gold-pairs + structural coverage | 8 | **0** | mean gold coverage **1.0**; soft ~0.067; SOFT_OTHER 8 |
| overnight-2026-08-07-n | all-inbounds 500 | 500 | **0** | 492 NO_GOLD_REPLY + 8 gold soft; invent gate holds at scale |
| centurion-from-replies-2026-08-07 | `from` centurion@ + prior on thread; claim-safe-stub | **8** | **0** | mean tone ~0.079; toolCoverage structural 1.0; brackets 44; LOW_TONE 5 / SOFT_OTHER 3 |

## Corpus ceiling (read-only diag)

- Centurion inbound ≈ **1045**, outbound ≈ **122**
- `from` starts `centurion@`: inbound **11** + outbound **122** = **133**
- Of those, same-thread **prior** by timestamp ≈ **8** ← strict gold for one-pass backtest
- Loose `%centurion%` inbound ≈ **89** (78 match “centurion” without `centurion@` in address — not mailbox local)
- Guest then later `%centurion%` ≈ **24**; multi-msg threads ≈ **104**
- Outbound bodies: almost all **html-only**

**Implication:** strict `centurion@` + reply-on-thread stays ~8 until `in_reply_to` / better threading or user widens gold beyond mailbox local.

## Draft path reality

- Default live path: **inbound-signal drafts** (cite inbound critical tokens; bracket PMS-only facts)
- **claim-safe-stub**: Mastra tool registry + not_found handlers → usually `insufficient_evidence` → brackets (no invent)
- **live-hms** claim-safe with browser: not yet run overnight (heavy; next improvement if clock allows)

## Improvement loop so far

1. Fixed gold sampling (was newest inbounds with zero replies)
2. HTML body fallback for gold compare
3. Soft overlap + Centurion-ish closing template
4. Documented corpus ceiling; added `--sample all-inbounds` for invent-rate gate on large set

## Resume checklist (`/continue-autonomously`)

1. `TZ=Europe/London date` — stop if ≥ 07:15 (handoff only) / ≥ 08:00 (hard stop)
2. Deploy tip: `GIT_BRANCH=EC2-pilot bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh`
3. Run: `--sample all-inbounds --limit 200 --draft signals`
4. Re-run gold: `--sample gold-pairs --limit 50`
5. Optional: wire `--live-hms` for exact-confirmation subset (read-only find/folio)
6. Do **not** Vitest against pilot; do **not** send mail

## Morning steer options

- Threading fix (`in_reply_to`) to grow gold pairs beyond 8
- Live HMS claim-safe for exact CONF candidates
- Tone templates mined from gold HTML (PII-safe aggregates only)
- Product draft UI still out of scope for this overnight path
