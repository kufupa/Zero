# Exchange / Real Mail Smoke (deferred)

When real mail becomes in scope, send test email to Centurion and verify:

```text
raw copy lands in nava@
raw headers include X-Zero-Mailbox: centurion@legacyhotel.com
worker ingests and deletes only after persistence
manager and member can see thread
frontdesk user cannot see thread
reply sends as centurion@legacyhotel.com
```

## Preconditions

1. VPN connected with split tunnel for AWS (see `deferred-real-mail-readiness.md`).
2. `POP3_HOST`, `POP3_PORT`, `POP3_USER`, POP3 password in Secrets Manager.
3. `SMTP_ENABLE_REAL=true` and relay credentials configured.
4. All fixture/fake tests green on EC2.

## Smoke steps

1. Send email to `centurion@legacyhotel.com` from external account.
2. Confirm copy arrives at aggregate `nava@` POP3 mailbox.
3. Run worker: `pm2 logs worker --lines 50`.
4. Verify thread visible to `user-manager` and `user-centurion-worker`.
5. Verify `user-frontdesk` cannot list the thread.
6. Reply via UI; confirm outbound `fromAddress` is `centurion@legacyhotel.com`.

## Rollback

If real ingest causes issues, stop worker (`pm2 stop worker`), revert to fixture-only mode, and quarantine unmapped messages via `mailIngestQuarantine`.
