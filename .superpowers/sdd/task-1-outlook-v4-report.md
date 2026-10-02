# Task 1 — 24-hour staff sessions and PDF shared-mailbox authorization

## Scope and behavior

- Legacy Better Auth session policy now expires in 86,400 seconds, sets `updateAge: 0`, `disableSessionRefresh: true`, and disables cookie cache. Remote remains 43,200 seconds, with no refresh/cache.
- The PDF route authorizes the signed-in user's ID against `mailbox_access` joined to the selected transport's mailbox email (case/whitespace insensitive). An ungranted mailbox fails `FORBIDDEN` before PDF conversion, even if the session login email claims to match it. Response filename, base64 PDF, and staff signer remain unchanged.
- Existing PDF tests now use seeded transactions on disposable PostgreSQL; their former assumption that a staff login must equal the shared mailbox was invalid under the new permission model.

## RED evidence

Command (with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset; `TEST_DATABASE_URL` pointed only to provided loopback disposable PostgreSQL; `CONFIRM_DISPOSABLE_TEST_DB=1`):

`pnpm --filter @zero/server exec vitest run tests/auth-session-ttl.test.ts tests/workstation-router-contract.test.ts`

Exit 1; 3 expected failures / 8 tests: legacy expiration received 34,560,000 rather than 86,400; provisioned staff received `OUTLOOK_EMAIL_MISMATCH`; matching a spoofed login to an ungranted mailbox reached `GOTENBERG_URL missing` instead of `FORBIDDEN`. Remote-policy test passed at 43,200.

The existing PDF regression suite first ran after implementation but before test adaptation: exit 1, 2 failures / 4 tests; these legacy tests used no DB handle and triggered missing development env values. Replaced those expectations with seeded disposable-DB authorization and unchanged PDF output checks.

## GREEN evidence

Same safety environment, command:

`pnpm --filter @zero/server exec vitest run tests/auth-session-ttl.test.ts tests/workstation-router-contract.test.ts tests/quote-proposal-pdf.test.ts`

Exit 0; 3 files, 12/12 tests passed. `pnpm --filter @zero/server build`: exit 0 (`tsc -p tsconfig.json`). Full server suite run separately; outcome documented below.

## Cutover and review

- Controlled deployment step: before activating this policy, invalidate existing legacy `session` rows through an explicitly scoped, approved session-revocation action and require all hotel staff to sign in again. The policy only sets TTL for newly issued sessions: existing sessions with persisted 400-day `expiresAt` are **not** retroactively shortened. No live session rows were touched in this task. Keep `remote_session` separate; remote admins retain their 12-hour absolute expiry.
- At 24 hours after sign-in, staff re-login is required; `updateAge: 0`, disabled refresh, and disabled cookie cache rule out automatic renewal/cache bypass.
- Cross-mailbox grants are intentional: any provisioned `mailbox_access` row for a transport authorizes that transport's PDF. This does not grant access to other transports; the denial test explicitly checks a forged login email. Mailbox aliases that do not exactly identify a `mailbox_transport.email` row (apart from case/whitespace) do not authorize; this follows the selected-transport identity in this task.
- Self-review: only the legacy session policy and quote PDF check were modified. No VSTO, web Send/Delete, remote auth policy, or other tasks' code changed. The existing `OUTLOOK_EMAIL_MISMATCH` forbidden message remains for API compatibility although the test is now transport permission rather than raw login-email equality.

## Full suite outcome

Command, with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset and only the confirmed loopback disposable DB configured:

`pnpm --filter @zero/server exec vitest run`

The 270-file server suite ran for approximately three minutes, then was intentionally interrupted (exit 130) after reporting numerous unrelated failures; broader verification is assigned to Task 8. Examples: `tests/ai-worker-contract.test.ts` 20 DB-contract failures and `tests/shadow-evaluation.test.ts` 6 failures from missing `PORT`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `AWS_REGION`, `S3_BUCKET`; `tests/deploy-config.test.ts` 14 deployment/host-script failures; `tests/hms-finance-db.test.ts` 2 existing 5-second timeouts, and `tests/admin-dashboard-query.test.ts` one env failure and one 5-second timeout. This is **not** a full-suite pass; do not treat it as one. Focused Task 1 tests and TypeScript build completed separately, as above.
