# Per-mailbox inboxes and canonical mail dedup

**Decision:** keep the single POP3 ingest for this slice; treat each configured `mailbox_transport` as a mailbox identity. Store one canonical message and separate mailbox-membership edges before enabling multi-alias promotion. This PR is only a read-only census plus data-driven, unambiguous promotion; no dedup or Da Vinci activation ships in it.

## Current flow

- `apps/server-pilot/src/mail/ingest/worker.ts:336-367` retrieves each POP3 UIDL, saves raw MIME to S3, parses it, and calls `persistInboundMessage`.
- `apps/server-pilot/src/mail/ingest/store.ts:287-325` routes by an active transport stamp or direct `To`; when the header is absent and `INGEST_REQUIRE_OWNER_HEADER=false`, it falls back to Centurion-only identity matching. Unmatched mail is quarantined at `:312-321` / `:1925-1970`.
- `apps/server-pilot/src/mail/ingest/promote-quarantine.ts:101-125,187-264` lists only `ingest-nava-legacy`, accepts the exact ReserveCloud staff sender/non-wrapper recipient pattern, then forces `transport-centurion` + `outbound`.
- The existing `message` row is transport-scoped (`apps/server-pilot/src/db/schema/mail.ts:311-349`); `message_id_header` is indexed only per transport (`:370-375`). It cannot represent one message visible in several mailboxes without another relation.
- Access grants already join users to transports (`apps/server-pilot/src/db/schema/mail.ts:179-198`; `apps/server-pilot/src/trpc/context.ts:37-71`). A future membership-aware mail query must enforce these grants.

## Target model

- Keep one `message.id` as the canonical message identity/content record; add a nullable canonical dedup key and an idempotent `mailbox_message_membership` relation keyed by `(message_id, transport_id)`. Membership carries mailbox-specific direction and thread reference. Keep existing `message.transport_id`, `thread_id`, and `direction` columns during compatibility rollout; do not rename/drop them.
- Extend mailbox configuration additively with hotel/property identity and nullable HMS tenant/property-code settings. Da Vinci uses tenant `HMS_DAVINCI`; property code remains explicit configuration until verified. A canonical message with conflicting property mappings fails closed for HMS work.
- Each mailbox gets recipient-side inbound and sender-side outbound membership. Multiple aliases mapped to the same mailbox collapse to one membership. Distinct mailbox matches must not choose an arbitrary winner.
- Reuse `mailbox_access`; message/thread/attachment/search/list/unread endpoints scope through granted mailbox memberships. No login is provisioned by this lane.

## Additive migration and rollout

1. Add nullable message dedup identity and property configuration columns, plus membership table/indexes. Add backfill rows for current messages. Do not delete/rename columns, tables, or data; retain legacy transport fields while readers migrate.
2. Keep the promotion flag off. Run the read-only mailbox census against quarantine first; verify per-mailbox counts, ambiguous routing, unreadable S3 objects, and duplicate groups without exposing headers or bodies.
3. Reprocess `missing_owner_header` and recoverable `parse_failure` rows from raw MIME. Resolve only configured mailbox identities; leave ambiguous, unknown, and malformed rows quarantined for review. Upsert canonical message by dedup key, then idempotently insert all matching mailbox memberships and property mappings. Clear a quarantine row only after the canonical message and every expected membership are durable.
4. Backfill legacy stored mail by the same dedup key; choose one canonical row per key deterministically and record all mailbox edges. Keep stale duplicate rows and references intact during rollout; mark/link them as aliases rather than deleting them. Audit counts before readers stop using legacy transport fields.
5. Add explicit `mailbox_access` grants only after owner approval. Da Vinci config rows remain inactive by default; seed/config creation requires an explicit opt-in flag and never activates a row. Do not infer missing staff addresses.

## Dedup and job identity

- Primary key: canonicalized RFC `Message-ID` (trim angle brackets, unquote/normalize per the existing `canonicalMessageId` helper, lowercase). Fallback only when Message-ID is absent/invalid: SHA-256 of exact raw MIME bytes. Persist the chosen key and enforce one canonical row with a unique partial index.
- On a duplicate key, add membership edges only; do not repeat extraction, triage, prefill, or prefetch. Use canonical `message.id` as each job's trigger and stable idempotency identity (for example, `mail-triage:<canonical-id>` and `hms-prefetch:<canonical-id>`). HMS admission also requires the single resolved property config; conflicting properties mean no HMS job.
- Attachments and raw MIME remain attached to the canonical message. Membership-local thread links keep per-mailbox thread state without duplicating message content.

## Dry-run and risks

- `scripts/mailbox-split-dry-run.ts` reads only quarantine metadata, raw-MIME headers, active/inactive mailbox config, and hashes; it writes nothing. Output contains transport IDs and counts only—never addresses, subjects, Message-IDs, bodies, guest data, or S3 keys.
- Risks: duplicate/malformed Message-ID, byte-different copies without Message-ID, overlapping aliases, stale/inactive configuration, existing readers that assume one `message.transport_id`, thread/attachment references during backfill, and unverified Da Vinci property code.
- Fail closed on ambiguous mailbox/property matches. Do not promote inactive rows. The dry-run counts candidates for inactive rows separately from actual would-promote counts.

## Rollback

Disable the promotion flag and leave all Da Vinci rows inactive; new unmatched mail returns to quarantine. Keep additive columns/tables and canonical/member rows in place—no destructive rollback. Existing message rows and grants remain readable through the legacy path; if any scoped reader is rolled back, use the retained legacy transport columns. Resume only after rerunning the census and reconciling counts.
