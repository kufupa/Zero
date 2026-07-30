# Handoff — Infor HMS Read Foundation (2026-07-30)

**Branch:** `EC2-pilot` @ `8c50373c`  
**Plan:** `docs/superpowers/plans/2026-07-30-infor-hms-read-foundation.md`  
**Deploy:** `ops-deploy.sh --migrate` green; health `ok`; VPN HARD ok  
**Fixture gate:** `hms-read-gate.sh --fixture-only` **PASS** on EC2 (119 unit + playwright 2 + shadow eval smoke)

## Tasks 0–9

| Task | Status |
|------|--------|
| 0 Evidence baseline | complete |
| 1 Lanes/budget/fencing | complete (0015 migrated on RDS) |
| 2 Thread context + evidence | complete |
| 3 Artifact/PDF reads | complete |
| 4 Request policy | complete (PolicyRoute stub Accepted) |
| 5 Runtime + discovery | complete (fixture; live discovery deferred) |
| 6 Reservation + quote adapter | complete |
| 7 Claim-safe candidate agent | complete (`planModel` Accepted) |
| 8 Freshness UI / promote-send | complete |
| 9 Gates + fixture E2E | complete implementer + EC2 fixture gate |

## Mode

Keep **`HMS_DRAFT_ENRICHMENT_MODE=off`** until remaining rollout gates below.

## Remaining (true rollout, not code)

1. **Shadow quality** — labelled corpus **n≥30** for statistical gates (current eval smoke labels=3).
2. **Live read canary** — orchestrator-only: import HMS secret → Task 5 discovery phases under Task 4 policy → redacted blocked signatures between phases. No mutation.
3. **Enable** only after hard+stat gates green; else stay `off`.
4. Optional: disposable-DB `--full` gate (pilot RDS DB vitest suites not used in fixture-only).
5. EC2 `pdf-text-gate.sh` live Poppler/bwrap smoke when convenient.

## Safety

- No PMS writes. CRS Check Availability blocked. `bookable` always false.
- Promote/send hard-block stale HMS (`STALE_AI_CANDIDATE` / `STALE_AI_DRAFT`).
- Default AI worker cannot claim HMS lane; `hms-ai-worker` separate.

## Key commits (foundation wave)

`ee648de5` … `8c50373c` on `EC2-pilot` (see `git log b6dddca2..HEAD --oneline`).
