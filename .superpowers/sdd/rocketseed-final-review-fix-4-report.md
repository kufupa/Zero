# Rocketseed final review fix wave 4 report

## A. Deferred raw MIME preservation

- RED: transactional deferred-retry regression expected retained raw MIME and failed because deferral deleted it.
- GREEN: deferred cleanup now deletes only candidate attachment objects. Deterministic `rawMimeKey(ingestMailboxId, uidl)` remains available for retry reconciliation.

## B. Malformed persisted delivery outcomes

- RED: trusted UUID-correlated malformed outcome case returned `deferred`.
- GREEN: only absent outcomes defer. A trusted active `sending` canonical row with malformed persisted delivery evidence is quarantined as `malformed_delivery_outcome`; worker drains and archives normal quarantine raw MIME.
- Fail-closed: special path requires live POP3, valid UUID correlation, active sending row, no prior ingest metadata, trusted topology, and malformed outcome. Other candidates retain ordinary ingest.

## Verification

- Transactional reconciliation suite: 20 passed.
- Transactional POP3 worker suite: 7 passed.
- Server TypeScript build: passed.

## Changed paths

- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/src/mail/ingest/worker.ts`
- `apps/server-pilot/tests/rocketseed-returned-copy-reconciliation.test.ts`
- `apps/server-pilot/tests/pop3-worker.test.ts`

## Limitation

- Existing `progress.md` left untouched. No pilot/prod access, deployment, or production environment loading.
