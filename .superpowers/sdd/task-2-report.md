# Task 2 — Layer C precision harden

Date: 2026-09-02
Branch: `feat/centurion-link-precision`
Baseline: `6fc7a6eb7`
Scope: deterministic Layer C overlay only; no `thread_id` rewrite, LLM, UI change, deploy, or backfill.

## TDD evidence

1. Added failing fixtures before production changes for:
   - bounce ×3, handover ×9, quotation ×9 subject buckets;
   - low-entropy generic subjects;
   - system-only participant overlap;
   - five auto confirmations with different confirmation numbers, then one matching confirmation;
   - superseded edge resolution in `buildConversationMeta`.
2. RED run (before implementation):
   `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm exec vitest run tests/conversation-link.test.ts`
   — 18 tests, 7 expected failures (unsafe subject buckets, loose auto-orphan links, and superseded-edge union).
3. Low-entropy RED run:
   `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm exec vitest run tests/conversation-link.test.ts -t "low-entropy"`
   — 1 expected failure.
4. GREEN regression:
   `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm exec vitest run tests/conversation-link.test.ts tests/conversation-signals.test.ts tests/conversation-signals-gold.test.ts tests/centurion-link-residual.test.ts tests/centurion-thread-linkage-audit.test.ts`
   — 5 files passed; 55 passed, 4 skipped (disposable-DB/private-corpus skips).
5. TypeScript: `pnpm exec tsc --noEmit -p tsconfig.json` — passed.
6. `git diff --check` — passed.

## Implementation

- P1/P3: exported `isSystemAddress`; subject overlap ignores system/ops addresses and requires a shared non-system external participant for guest-facing clusters. The internal-only Breakfast Pack staff RE class remains allowed.
- P2: subject-cluster discovery refuses bounce, handover, Nedbank, quotation, digest/failure, and low-entropy template subjects.
- P4: normalized subject buckets larger than eight threads produce no `subject_cluster` proposals.
- P5: automatic orphan links require an exact confirmation-number match, are capped at one per source thread, and no longer fall back to guest email/name.
- Grouper: direct `buildConversationMeta` resolution ignores edges with `supersededAt IS NOT NULL`; the DB loader already had the active-edge filter.

## Offline replay evidence

Input was the local private EOD snapshot (`connected-mailbox-inbox-2026-09-01-eod.md`); no private data was written to Git or emitted. The actual discovery replay reported:

| Metric | Result |
|---|---:|
| Messages / threads | 4,536 / 3,378 |
| Total proposals | 540 |
| Subject-cluster proposals | 244 |
| Subject-cluster vs prior 3,187 baseline | 7.66% (gate pass under baseline-count interpretation) |
| Subject-only template component ≥8 | 0 (gate pass) |
| Zuko-class component | 1 (≤5 gate pass) |
| Breakfast Pack subject links | 16 |

Residual: the full proposal graph still has two quotation-named components of sizes 11 and 8, both formed by `quoted_body` (one also has one `domain_conf`) rather than subject-cluster edges. Task 2 preserves those existing quoted/domain paths; deactivation of unsafe persisted edges is explicitly Task 3 (`--deactivate-unsafe`) and was not added here. The all-proposal subject-cluster share is 45.19%, so the gate is recorded as baseline-count based, not as an all-proposal percentage claim.

The full server-pilot suite was also attempted; unrelated pre-existing HMS/deployment contract failures occurred in the shared checkout. They are outside the changed files. Focused Layer C/Layer B regression and TypeScript checks above are green.

## Safety

Every Vitest command was preceded by `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV`. No pilot/production DB, deploy, backfill, or destructive operation was run.
