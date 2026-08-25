---
name: connected-mailbox-refresh
description: >-
  Use when refreshing a connected reservationist inbox corpus, verifying active
  connected transport scope, or producing PII-free taxonomy, KPI, template, or
  SOP artifacts from an approved local private dump.
disable-model-invocation: true
---

# Connected mailbox refresh

Refresh only through an approved local private workflow. Start with scope metadata,
not mail content. This workflow is read-only and never changes mailbox, triage, or
transport state.

## Non-negotiable boundaries

- Raw PII must never travel via SSM, terminal, Git, web, remote MCP/API, or docs.
- No remote raw corpus transfer.
- Never send raw mail to a remote model, service, or analysis endpoint.
- Never infer scope from a named source, sender address, owner header, or fallback
  transport.
- Never use an allow-empty scope. A missing active scope is blocked, not an empty
  corpus result.
- Never run Vitest with a pilot `DATABASE_URL`. Never set
  `VITEST_ALLOW_PILOT_RDS`.

## Required workflow

### 1. Metadata-only scope gate

Run a metadata-only read-only gate first. It may read only connected transport
identity, active status, and snapshot metadata; it must not read bodies, subjects,
addresses, attachment names, or raw MIME.

Confirm one `ActiveTransportScope` before any mail-content operation:

1. active connected transport set is non-empty;
2. transport IDs are deterministically sorted and bound to one `asOf` value;
3. every later message, thread, and KPI selection is constrained to that same set
   and `asOf`;
4. no quarantine, address-derived, named-source, or inferred fallback enters scope.

If approved local private DB access is unavailable, stop with:

```text
BLOCKED_LOCAL_PRIVATE_DB_ACCESS_UNAVAILABLE
```

Do not query mail content, create a dump, substitute an alternate scope, or make
data-derived documentation claims after that outcome.

### 2. Approved local private raw-dump path

Only after the metadata gate is ready, use the approved local private raw-dump path.
Keep raw input and rendered output inside its approved ignored private root. The
renderer must be read-only, must not emit mail content to stdout or stderr, and may
report only safe aggregate counts and snapshot metadata.

Do not copy, upload, attach, paste, commit, or document raw content. Do not create
an alternate transfer path.

### 3. PII-free analysis artifacts

Tracked taxonomy, KPI, template, and SOP artifacts may contain only controlled
vocabularies, definitions, aggregate counts, and explicit unknown or blocked
states. They must identify scope generically as active connected transports and
must never encode mail bodies, addresses, subjects, attachment names, or raw dump
paths.

Keep deterministic classification separate from local residual review. A residual
review may add only review-marked rows; it cannot rewrite deterministic results or
change gold/runtime behavior without its own approved evidence path.

### 4. Report outcome

Report only:

- metadata gate result;
- active transport count and `asOf` status, when available;
- aggregate message/thread/category counts, when an approved local snapshot exists;
- produced PII-free artifact paths; and
- explicit blocked status when local private access is unavailable.

Never report raw mail excerpts or identifiers.
