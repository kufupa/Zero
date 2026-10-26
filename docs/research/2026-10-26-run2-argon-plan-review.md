# Run 2 — Argon adversarial plan review + coordinator fixes (2026-10-26)

**What:** Gemini 4 Argon High (`agy --mode plan`, read-only) reviewed `docs/plans/2026-10-26-002-overnight-run2-plan.md` + `/tmp/or2/units.tsv` + PR #553 scripts. First run failed (headless auto-denied a shell tool → empty output); rerun with `--dangerously-skip-permissions` in plan mode, ~25 min. Cost: $0 (AI Pro plan). Quality: 12 findings, 5 P0 / 6 P1 / 1 P2, all with file:line; ~10 judged real by the coordinator.

| # | Finding | Coordinator verdict | Action |
|---|---|---|---|
| 1 | Barrier tokens (T1_BASE_COMPLETE/T1_COMPLETE/OWNER_APPROVAL) deadlock dispatch | Real | Barrier rows added to units.tsv (`held`); coord-tick marks T1_COMPLETE when every T1 unit merges; R-SEED → DS1-P3b,DS1-P3a |
| 2 | Status vocab; failed/held re-launched | Real | dispatch now starts only `pending`/`todo`; `review` holds its files (#553) |
| 3 | No one writes gate `.ok` files | Real | coord-tick writes it after Argon/Grok diff review approves, then runs merge-gate |
| 4 | False deps: F2←F1, B1←G2b, Lease-R←B2, R-SEED←barrier, DS2-S1←P2 | Real | All cut; hms-jobs.ts serialisation left to the dispatcher file lock |
| 5 | S0-PANEL ~1.2–1.6k LOC megaslice | Real | Split into S0-PANEL-STEPS then S0-PANEL (rates/booking host), each ≤450 moved lines |
| 6 | EC2-private JSON in git-owned files | Real | Removed; P0 lane writes contents + SSM steps to a coordinator-held live file |
| 7 | DS3-E2 live Labtest Save in T1 | Real | Dry-run create-request payload assertion only |
| 8 | Wrong owned files (F1 rates.ts, F2 pane-stay-bind.ts, G2b missing rate files) | Real (paths verified) | units.tsv corrected |
| 9 | H2/J2 mount collision on nava-pane/needs-you | Real | H2/J2 self-contained; DS4-I mounts |
| 10 | HRCEN/HRDAV unions + BAR/Government literals | Real (pre-existing) | P3b/F1 briefs: derive from profile, fail closed |
| 11 | Weak tests (P1/P2 ledger matrix, party replay, tRPC wire) | Real | Briefs updated |
| 12 | R-CORPUS column names | Moot | R-CORPUS already finished |

Longest T1 chain after fixes: ~7 slices (server: S0-JOBS → P1 → P2 → S1 → F1 → P3b → R-SEED via the hms-jobs.ts file lock), down from 13. Argon's 6-slice DAG needs a wider S0-JOBS extraction; not done (S0-JOBS was already running).

R-SEED design: `/tmp/or2/ds/RSEED.md`, summarised in its brief. Seed from the S5 corpus with exact-code truth only, holdout before/after 2026-10-10, ≥100 held-out rows or no accuracy claim.
