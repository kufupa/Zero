# Rocketseed final review fix wave 3 — report

## Status

Complete. Fix A is committed in `1650bd5e`; fixes B and C are completed in the
follow-up commit.

Base before task: `4442d9580108a3d44d3e937542782cefb3c6f4ee`

## Safety checks

- Did not access pilot/prod, deploy, or source `.env.production`.
- Before every Vitest invocation: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- Transactional commands used only the provided locally bound disposable
  `TEST_DATABASE_URL` with explicit disposable confirmation and Rocketseed
  transactional-test enforcement.
- Did not write a database URL or other secret to tracked source.

## A. Queued default-undo status

Changed `useUndoSend` so a queued result displays `Email queued` with
`Delivery pending.` instead of claiming `Email sent`. Scheduled, partial, and
uncertain-result paths remain explicit.

### RED

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS; pnpm --filter=@zero/mail exec vitest run tests/mail-send-delivery-contract.test.ts
```

Result: expected failure in new contract
`labels ordinary queued sends as pending delivery, not completed delivery`:
source lacked `isQueuedSendResult(result)`.

### GREEN

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS; pnpm --filter=@zero/mail exec vitest run tests/mail-send-delivery-contract.test.ts
```

Result: exit `0`; `1` test file passed, `4` tests passed.

### Additional partial verification

- Scoped Prettier: exit `0`.
- Scoped Oxlint: exit `0`; `0` warnings, `0` errors.
- `git diff --check`: exit `0`.
- Mail production build: exit `0`. Vite emitted its existing chunk-size warning
  only.

## B. Canonical BCC reconciliation

Reconciliation now retains the canonical message's BCC recipients while it
enriches sender-visible returned-copy fields and attachments.

### RED

Transactional reconciliation suite failed as expected:

- canonical BCC was overwritten by returned-copy BCC;
- a canonical audit BCC was erased when the returned copy omitted BCC.

### GREEN

Transactional reconciliation suite: exit `0`; `19` tests passed. It proves an
original audit BCC survives a BCC-less trusted returned copy.

## C. Pre-outcome returned-copy deferral

Valid UUID-correlated, trusted live-POP3 returned copies now return
`deferred` only while their canonical queue is actively `sending` without a
durable SMTP outcome. Deferral leaves the POP3 item pending, clears its poison
counter, and removes pre-created raw-MIME and candidate attachment objects.

Once a durable outcome exists, retry reconciles the canonical outbound row and
finalizes without a second SMTP send or duplicate row. Malformed, untrusted,
cross-transport, non-sending, and legacy Message-ID-only candidates remain
ordinary ingest.

### RED

Transactional and worker regression run failed as expected:

- eligible pre-outcome UUID copies were stored instead of deferred;
- the worker issued `DELE` for a deferred result.

### GREEN

Transactional reconciliation plus worker regressions: exit `0`; `27` tests
passed. The retry regression proves no raw-MIME/attachment leak, no POP3
delete, no poison-counter advancement, no duplicate row, and no SMTP resend.

## Changed paths

- `apps/mail/hooks/use-undo-send.ts`
- `apps/mail/tests/mail-send-delivery-contract.test.ts`
- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/src/mail/ingest/worker.ts`
- `apps/server-pilot/tests/rocketseed-returned-copy-reconciliation.test.ts`
- `apps/server-pilot/tests/pop3-worker.test.ts`
- `.superpowers/sdd/rocketseed-final-review-fix-3-report.md`

## Final verification

- DB-free Rocketseed suite: exit `0`; `116` tests passed.
- Disposable transactional reconciliation, outcome, worker, and mail-send
  suites: exit `0`; `49` tests passed.
- Focused mail client suite: exit `0`; `4` tests passed.
- Server build: exit `0`.
- Scoped Prettier, Oxlint, and `git diff --check`: exit `0`.

## Residual limitations

- Mail build remains proven from fix A. Vite emitted its existing chunk-size
  warning only.
