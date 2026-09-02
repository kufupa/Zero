# Task 1 — Layer B signal port (TDD)

Date: 2026-09-02
Branch: `feat/centurion-link-precision`
Baseline: `9bb90c649`
Model lock: Luna Max only

## Scope

Ported the deterministic Layer B EOD conversation detector. The implementation remains
regex/header/body-only and produces the binary `responded` KPI; it does not add voucher or
PoP enums, invoke an LLM, or rewrite `thread_id`. Layer C files were not changed.

Signal coverage now includes the existing `in_thread_outbound`, `cross_thread_conf`,
`orphan_auto_confirm`, `orphan_centurion_human`, `quoted_hotel_header`, and
`quoted_hotel_phrase` signals plus the EOD variants:

`in_thread`, `quoted_outlook_legacy_from`, `in_reply_to_hotel_msgid`, `quoted_staff_sig`,
`quoted_gmail_hotel`, `quoted_from_centurion_date`, `quoted_applemail_hotel`, and
`staff_inbound_commercial_reply`.

The offline snapshot evaluator now preserves `Message-ID`, `In-Reply-To`, and `References`
from the EOD markdown dump. Weak orphan/cross matches fail closed: cross-thread matching
requires a matching confirmation number or normalized guest identity (length at least five)
within the short EOD window; generic orphan confirmation text requires matching identity or a
strong quoted hotel block. A weak guest-email orphan alone remains unanswered. Existing human
Centurion orphan detection and deterministic system/auto filtering remain intact.

## TDD evidence

### RED

Added behavior fixtures for Outlook `From`/`Sent`, hotel `In-Reply-To`, staff commercial
inbound, Gmail/Apple quote headers, From/Date, quoted staff signature, and weak orphan/cross
negative cases. Before implementation:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run tests/conversation-signals.test.ts
18 tests | 6 failed
```

All six failures were the expected missing-signal failures; the pre-existing 12 tests passed.

### GREEN

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/conversation-signals.test.ts tests/conversation-signals-gold.test.ts
24 passed, 1 skipped
```

The one skip is the private-gold Vitest case because the private corpus is intentionally not
linked into the checkout. The same private corpus was evaluated explicitly below.

Additional DB-safe consumer regression:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/conversation-signals.test.ts tests/conversation-signals-gold.test.ts \
  tests/centurion-link-residual.test.ts tests/centurion-thread-linkage-audit.test.ts \
  tests/ai-triage-input.test.ts tests/ai-triage-contract.test.ts
86 passed, 11 skipped
```

Static checks:

```text
pnpm --dir apps/server-pilot exec tsc -p tsconfig.json --noEmit   # pass
git diff --check                                                   # pass
```

## Offline EOD gate

Command (private corpus is read-only and outside Git):

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec tsx \
  scripts/eval-centurion-conversation-signals.ts \
  /home/ubuntu/projects/zero/.private/connected-mailbox-corpus
```

Aggregate output only:

```text
gold:       483 actionable / 282 responded / 201 unanswered
confusion:  279 true positives / 3 false negatives / 2 false positives / 199 true negatives
predicted:  281 responded
recall:     279/282 (98.9%)  [minimum 268]
FP rate:    2/201 (1.0%)    [maximum 4]
skipped:    0
gate:       PASS
```

No corpus rows, addresses, names, message IDs, or other PII were copied into Git or this
report. The temporary ignored corpus symlink was removed after evaluation.

## Files owned by Task 1

- `apps/server-pilot/src/mail/conversation-signals.ts`
- `apps/server-pilot/src/ops/centurion-conversation-signals-eval.ts`
- `apps/server-pilot/scripts/eval-centurion-conversation-signals.ts`
- `apps/server-pilot/tests/conversation-signals.test.ts`
- `apps/server-pilot/tests/conversation-signals-gold.test.ts`

The pre-existing `.superpowers/sdd/progress.md` edit was preserved and is intentionally not
part of the Task 1 commit.

## Review fix — staff commercial direction/noise guard

Date: 2026-09-02

The review regression was confirmed in `detectConversationSignals`: the
`staff_inbound_commercial_reply` scan did not require `message.direction ===
'inbound'` and used a narrower sender exclusion than `responderBucket`. Thus
outbound `mail@legacyhotels.co.za` text such as “Please be advised” could set a
signal and the binary `responded` KPI. The fix now requires inbound direction,
reuses `responderBucket`'s existing system/noise guard, and retains the
explicit legacy noise aliases. `OrphanOutboundRow.day` is now required because
the index builder always populates it; the tested positive orphan fixture
asserts the day contract.

### Fix TDD evidence

RED after adding outbound real-staff and outbound/inbound `mail`, `postmaster`,
and `system` fixtures:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run tests/conversation-signals.test.ts
26 tests | 7 failed
```

The failures were the expected missing direction/noise protections; the
pre-existing 19 tests passed.

GREEN focused:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run tests/conversation-signals.test.ts
26 passed
```

GREEN DB-safe consumer regression:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/conversation-signals.test.ts tests/conversation-signals-gold.test.ts \
  tests/centurion-link-residual.test.ts tests/centurion-thread-linkage-audit.test.ts \
  tests/ai-triage-input.test.ts tests/ai-triage-contract.test.ts
93 passed, 11 skipped
```

Static checks:

```text
pnpm --dir apps/server-pilot exec tsc -p tsconfig.json --noEmit   # pass
git diff --check                                                   # pass
```

### Offline EOD gate after fix

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec tsx \
  scripts/eval-centurion-conversation-signals.ts \
  /home/ubuntu/projects/zero/.private/connected-mailbox-corpus
```

Aggregate output only:

```text
gold:       483 actionable / 282 responded / 201 unanswered
confusion:  279 true positives / 3 false negatives / 2 false positives / 199 true negatives
predicted:  281 responded
recall:     279/282 (98.9%)  [minimum 268]
FP rate:    2/201 (1.0%)    [maximum 4]
skipped:    0
gate:       PASS
```

No corpus rows, addresses, names, message IDs, or other PII were copied into
Git or this report.
