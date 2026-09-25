# 5 Build

Checks: `schema.enum.parity`, `schema.required.parity`, `tests.green`

Offline. No browser.

1. TDD: tests first (`node:test`, pattern `tooling/playwright-quote/*.test.mjs`). Red → green.
2. CLI imports kernel (`tooling/playwright-quote/audit.mjs`, `remote-owner.mjs`). No second login, no second browser owner.
3. Enum = `03-screen.json` options exactly (order free). Required = screen required.
4. Output outcomes explicit: success, ambiguity, empty, input gap, execution failure. No invented scores/defaults.
5. Screenshots at each `criticalPngs` stage via `audit.mjs`.

`unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before any test run.
