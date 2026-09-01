# Task 4 — Exception-first refine + R22/R23 + Layer-3 apply

Status: complete (local gates green; disposable-DB proof skipped safely)

## Scope

- `apps/server-pilot/src/ai/triage.ts`
- `apps/server-pilot/tests/ai-triage-refine.test.ts`

## RED

Command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-refine.test.ts
```

Initial result: 19 tests, 5 failed, 1 skipped. Failures covered missing shared
R22/R23 predicate, canonical refine force-not-spam, ReserveCloud recipient
discriminator, and Layer-3 behavior.

## GREEN

Focused result:

```text
tests/ai-triage-refine.test.ts — 19 tests; 18 passed; 1 skipped
```

Broader triage result:

```text
ai-triage-refine + ai-triage-contract + ai-worker-contract + sender-preference
76 passed; 28 skipped
```

Type/build/format gates:

```text
pnpm --filter @zero/server exec tsc --noEmit --pretty false — PASS
pnpm --filter @zero/server build — PASS
pnpm exec prettier --check <Task 4 files> — PASS
git diff --check <Task 4 files> — PASS
```

## Decisions

- Shared `staffConversationNotSpam` covers exact never-spam identities plus
  causal Legacy outbound / true RC Penny staff response. RC SCS wrapper remains
  not-spam through exact never-spam identity but is not staff-outbound. Noreply
  RC remains outside both paths.
- RC staff-outbound requires at least one recipient other than Penny's Legacy
  address; `To`, `Cc`, `Bcc`, parsed recipient aliases, and causal booleans are
  supported. No broad ReserveCloud domain was added.
- Canonical workflow refine maps hotel/RC exceptions to `internal-partner`,
  pilot personal allowlist to `bookings`, and preserves RC event-shaped
  `groups-events`; legacy output remains `ops`/`new-bookings` compatible.
- Layer 3 honors `spam_user_locked_at` and sender `block` precedence. Unlocked
  never-spam/R22 applies clear `spam_at`, remove AI-managed memberships, and
  join the resolved primary plus Urgent overlay; no early return omits the
  primary join.
- FP2 full-body hotel-conversation belt maps payment-shaped quoted hotel
  context to `money-billing` with `refine:hotel-conversation-not-spam`.

## Self-review

- Legacy v5 `TriageOutput` overload and category behavior remain compatible;
  canonical workflow payloads validate explicitly and are not silently converted
  during refine.
- No broad ReserveCloud domain, write-tool tag, draft-AI path, HMS activation,
  or production mutation was added.
- Locked threads and sender `block` remain fail-closed; only unlocked automatic
  exceptions take the clear-and-join path.

## DB safety

The Layer-3 integration test is `skipIf`-gated on the disposable test DB helper.
No `TEST_DATABASE_URL`/disposable DB was available in this run. `DATABASE_URL`
and `VITEST_ALLOW_PILOT_RDS` were unset before every Vitest command; pilot RDS
was never used.
