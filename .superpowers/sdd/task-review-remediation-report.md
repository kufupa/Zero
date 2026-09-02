# Centurion review-remediation report

Date: 2026-09-02 UTC
Branch: `feat/centurion-link-precision`

## Findings and fixes

1. `centurion-thread-linkage-audit.ts` and its CLI read the superseded
   `defensible-daily-chart-2026-09-01.json` snapshot and rendered a hardcoded
   `438 actionable` heading. The canonical residual enumerator and CLI had the
   same stale snapshot/gate. All canonical audit/residual paths now use the EOD
   threads snapshot and EOD inbox (`483 actionable / 282 responded /
   201 unanswered`); the residual CLI gate imports the shared EOD actionable
   constant.
2. The linkage audit is explicitly `descriptive`, not an enforceable Layer C
   gate. It labels subject clusters as census evidence only and points
   enforceable checks to the canonical residual enumerator/linker, which owns
   production predicates. Audit output contains counts only on stdout.
3. `t-orph-a` was labelled responded despite direct detector replay producing
   `[]`. Its generic confirmation-letter orphan has no confirmation number,
   guest identity, or quoted hotel block, so EOD FP policy requires
   `responded=false`. Fixture guest identity was isolated from the positive
   human-orphan fixture to prevent cross-fixture contamination; regression now
   asserts binary unanswered and zero FP.
4. `mail-triage.ts` accepted RFC fields but dropped them in
   `toTriageMessageRows`, so workflow metrics lost `in_reply_to_hotel_msgid`.
   Mapping now preserves `messageIdHeader`, `inReplyTo`, and `references`;
   workflow contract regression covers the signal.

## TDD evidence

RED audit contract:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run tests/centurion-thread-linkage-audit.test.ts -t "assigns layers"
1 failed: expected report.auditMode "descriptive", received undefined
```

RED workflow header contract:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run tests/ai-triage-contract.test.ts -t "mailTriageWorkflow returns validated output field"
1 failed: expected in_reply_to_hotel_msgid, received []
```

RED orphan fixture after relabelling `t-orph-a` unanswered exposed one FP from
the fixture's shared `guest-a` identity; isolating that fixture to `guest-z`
made the intended weak-orphan regression deterministic.

GREEN focused suite:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/conversation-signals-gold.test.ts tests/conversation-signals.test.ts \
  tests/centurion-thread-linkage-audit.test.ts tests/centurion-link-residual.test.ts \
  tests/ai-triage-contract.test.ts
5 files passed; 86 passed, 11 skipped
```

Static checks:

```text
pnpm --dir apps/server-pilot exec tsc -p tsconfig.json --noEmit   # pass
git diff --check                                                   # pass
```

EOD audit replay (aggregate stdout only):

```text
auditMode=descriptive
goldTotals=483/282/201
observed=483/282/201
layerCounts=90/139/80/6/168
subjectClusters=24
```

EOD residual replay (aggregate stdout only):

```text
actionable=483
pairsTotal=427
byReason={cross_thread_conf:48, orphan_auto_confirm:289,
orphan_centurion_human:7, quoted_hotel_header:50, subject_cluster:33}
```

## Files

- `apps/server-pilot/src/ops/centurion-thread-linkage-audit.ts`
- `apps/server-pilot/scripts/audit-centurion-thread-linkage.ts`
- `apps/server-pilot/src/ops/centurion-link-residual-enumerator.ts`
- `apps/server-pilot/scripts/enumerate-centurion-link-residuals.ts`
- `apps/server-pilot/tests/centurion-thread-linkage-audit.test.ts`
- `apps/server-pilot/tests/centurion-link-residual.test.ts`
- `apps/server-pilot/tests/conversation-signals-gold.test.ts`
- `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- `apps/server-pilot/tests/ai-triage-contract.test.ts`

Implementation commit: `6c18757d` (`fix(centurion): align EOD audits and preserve response headers`).

Safety: every Vitest command unset `DATABASE_URL` and
`VITEST_ALLOW_PILOT_RDS`; no pilot/production RDS, LLM, deploy, or PII stdout.
