# Task 4 — CID eligibility hardening and network-free Rocketseed CI

## Scope completed

- Added one shared exported `MAX_INLINE_IMAGE_BYTES` limit. CID projection and
  inline HTTP serving use the same bound.
- Made CID projection fail closed. A `cid:` image is rewritten only when exactly
  one normalized CID attachment is explicit-inline, a supported raster MIME
  type, and has a positive safe-integer size at or below the shared limit.
  Duplicate normalized CIDs are ambiguous even when one duplicate is otherwise
  ineligible.
- Made MIME parsing mark an attachment inline only for explicit
  `Content-Disposition: inline`; `multipart/related` alone is insufficient.
- Loaded and passed `isInline` through mail-content projection and inline-route
  authorization. The HTTP route rejects non-inline metadata before object
  storage.
- Made inline-route failures opaque: 401, 404, 413, 415, and unexpected
  dependency failures return empty response bodies.
- Hardened sanitization. Only `BLOCKED_IMAGE_PLACEHOLDER` may survive as an
  image `data:` URL, and `cid:` remains image-source-only rather than a global
  link scheme.
- Added a synthetic `multipart/related` fixture and a DB-free end-to-end flow
  regression covering parse, sanitize, CID projection, eligible serving, and
  ineligible metadata.
- Added `test:rocketseed` and CI enforcement that clears all DB/test variables,
  exports fixture transport mode, runs only the focused suite, and builds both
  mail applications.

No returned-copy interface, SMTP implementation, Rocketseed no-AUTH policy,
host policy, or TLS policy was changed. No old feature branch was merged or
copied.

## TDD evidence

### Initial RED

Task 4 regressions were added before their production changes. The first
focused Vitest run had 26 failures across CID projection, HTML sanitization,
safe-image export, inline HTTP responses, synthetic MIME flow, and the CI
contract. The failures proved these missing behaviors:

1. No exported shared inline-image limit.
2. CID projection accepted non-inline, non-raster, invalid-size, oversize, and
   ambiguous duplicate metadata.
3. Parser treated `related` membership as inline.
4. Arbitrary email `data:` image URLs and `cid:` links survived sanitization.
5. Inline serving returned explanatory error bodies, did not query `isInline`,
   and could read storage for non-inline metadata.
6. No focused DB-free CI command or workflow contract existed.

### GREEN

Minimal production changes made each failing group pass:

- Explicit disposition parsing now distinguishes the synthetic inline GIF from
  the ordinary related PDF attachment.
- Projection indexes every normalized CID, then accepts exactly one eligible
  attachment only.
- The inline handler checks authorization metadata, explicit-inline status,
  raster MIME type, declared size, and bounded object size before returning
  bytes; dependency errors are caught as opaque 500s.
- Sanitization trims image sources, preserves only the fixed blocked-image
  placeholder data URI, and removes `cid:` links.
- The new synthetic flow uses `FakeS3Storage`, a synthetic local fixture, and
  request-local mocks only.

A temporary same-origin mutation was also used to prove the new projection
assertion could fail, then reverted before the final green run.

## DB-free and network boundary

Every Vitest invocation unset at least `DATABASE_URL` and
`VITEST_ALLOW_PILOT_RDS`; the final focused command explicitly cleared:

```sh
unset DATABASE_URL TEST_DATABASE_URL CONFIRM_DISPOSABLE_TEST_DB VITEST_ALLOW_PILOT_RDS
export MAIL_TRANSPORT_MODE=fixture
pnpm --dir apps/server-pilot run test:rocketseed
```

No test set `TEST_DATABASE_URL`, `CONFIRM_DISPOSABLE_TEST_DB`, or
`VITEST_ALLOW_PILOT_RDS`. Tests use no database, EC2, remote mail, remote
object storage, secrets, production environment, or client mail data. The new
fixture contains synthetic-only data.

The workflow contains the same unset/export boundary and does not source
`.env.production`. `rocketseed-ci-contract.test.ts` statically asserts this
contract plus the two required build commands.

## Verification

- Focused DB-free Rocketseed suite: 11 files, 97 tests passed.
  - Transport/no-AUTH policy and fixture loopback
  - Worker modes and returned-copy trust/correlation regressions
  - CID eligibility, sanitizer, shared safe-image limit, and inline HTTP route
  - Synthetic multipart flow and CI/workflow contract
- `pnpm --dir apps/server-pilot build`: passed (`tsc -p tsconfig.json`).
- `pnpm --dir apps/mail build`: passed.
- Scoped `oxlint` over Task 4 source and tests: 0 warnings, 0 errors.
- Scoped Prettier checks for added Task 4 test, config, and report files:
  passed. The synthetic `.eml` fixture has no Prettier parser and is
  intentionally excluded.
- `git diff --check`: passed.

## Self-review

Reviewed data flow from parsed MIME part through attachment metadata, projected
HTML, authorization query, and bounded object response. The shared byte limit,
explicit-inline gate, duplicate-CID rejection, expected MIME checks, opaque
errors, and no-network CI boundary are enforced at each applicable boundary.

## Non-blocking build notes

The mail build exited successfully but emitted non-fatal Vite/Rollup source-map,
third-party PURE-comment, and CSS-minifier warnings. Task 4 does not touch
those mail UI build inputs.
