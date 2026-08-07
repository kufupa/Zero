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
| overnight-2026-08-07-h | outbound-centric | 2 | 0 | outbound timestamps only yield ~4 prior-inbound pairs |

## Corpus ceiling (read-only diag)

- Centurion inbound ≈ **996**, outbound ≈ **122**
- Inbounds with **later** same-thread outbound ≈ **8** (true gold pairs)
- Inbounds with **any** same-thread outbound ≈ **32**
- Outbounds with prior inbound by timestamp ≈ **4** (unique prior inbound ≈ **2**)
- Outbound bodies: almost all **html-only** (`text_nonempty` ≈ 2 / 122)

**Implication:** full “compare draft vs every Centurion sent reply” cannot exceed ~8 high-quality timestamp-ordered pairs on current RDS thread linkage. Expand later via `in_reply_to` / `references` / better threading — not inventing gold.

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
