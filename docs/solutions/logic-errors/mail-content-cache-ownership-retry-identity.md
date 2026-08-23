---
title: "Safe mail-content processing cache ownership and retry identity"
date: 2026-08-23
category: logic-errors
module: "apps/mail mail-content processing"
problem_type: logic_error
component: email_processing
severity: medium
symptoms:
  - "Non-empty messages render safe failure UI when hosted processing fails"
  - "Same message ID needs a new processed-output identity when source HTML changes"
  - "A delayed retry must not affect a newer content identity"
root_cause: logic_error
resolution_type: code_fix
tags:
  - mail-content
  - react-query
  - cache-identity
  - retry-identity
  - content-digest
  - email-processing
---

# Safe mail-content processing cache ownership and retry identity

## Problem

A hosted mail reader needs one visible owner for processed-content work and a cache
identity that changes with the source body. Otherwise, it cannot reliably distinguish
the safe pending, error, retry, and successful-render states for a particular content
revision.

## Symptoms

- A changed message body with the same message ID needs a distinct processed-output
  cache entry and processing request.
- Hosted pending or error states need to withhold the Shadow DOM host so source input
  never becomes a fallback display path.
- A retry that starts for one content revision must not clear state or restore focus
  for a newer revision.

## What Didn't Work

- An invisible processing query cannot represent the visible component's complete
  safety state. `useThread` now fetches thread data only; its ownership contract
  prevents both `processEmailContent` and the legacy
  `email-content-v2` key from returning there
  (`apps/mail/tests/use-threads-content-query-ownership.test.ts:6-11`).
- Identifying processed output by message ID alone was insufficient: a message can
  retain its ID while its source HTML changes.
- A safe placeholder resolver is not a render gate. The hosted render path must also
  withhold its content host until processing succeeds.
- Button-state assertions need an `HTMLButtonElement` guard before reading
  `.disabled`; the retry regression test does this now
  (`apps/mail/tests/mail-content-rendering.test.tsx:187-198`).

## Solution

`MailContent` is the sole owner of live processed-content work. It derives a SHA-256
digest from the exact source HTML and keeps that digest associated with the matching
HTML value (`apps/mail/components/mail/mail-content.tsx:52-77`,
`apps/mail/components/mail/mail-content.tsx:108-141`).

The client query identity is versioned and records its caller-supplied processing
inputs without putting source HTML in the cache key:

```ts
const contentQueryKey = [
  'email-content-v3',
  id,
  contentDigest,
  shouldLoadImages,
  processingTheme,
] as const;
```

The current implementation only enables the query once the digest exists and turns
off automatic, mount, and focus refetches
(`apps/mail/components/mail/mail-content.tsx:96-103`,
`apps/mail/components/mail/mail-content.tsx:175-203`).

`MailContent` renders distinct loading, error, retrying, and successful states. For
non-demo content that requires hosted processing, the content host mounts only after
processing succeeds
(`apps/mail/components/mail/mail-content.tsx:205-217`,
`apps/mail/components/mail/mail-content.tsx:283-304`,
`apps/mail/components/mail/mail-content.tsx:381-413`). In non-demo mode,
`resolveMailDisplayHtml` returns a fixed safe placeholder when processed HTML is
unavailable rather than returning source HTML
(`apps/mail/lib/mail/resolve-mail-display-html.ts:3-26`).

For processed-content query failures, manual retry records the serialized full query
identity. A later retry result can clear state or restore focus only when it still
belongs to that identity; a source, trust, or theme change invalidates pending focus
intent
(`apps/mail/components/mail/mail-content.tsx:219-258`,
`apps/mail/components/mail/mail-content.tsx:276-326`).

## Why This Works

Keeping processing inside the visible component aligns query lifetime with the
component that decides whether it is safe to attach rendered HTML. A SHA-256 content
digest makes a same-ID body revision a different cache identity while keeping raw
source out of React Query keys.

The explicit state gate prevents both pending and terminal failures from mounting the
content host. Identity-bound retry and focus bookkeeping prevents a delayed retry for
an older body from affecting a newer revision of that message.

## Prevention

- Keep `MailContent` as the only live mail-content processing owner. Do not restore an
  invisible `useThread` processing query.
- Version client processed-output keys when a caller-supplied processing input changes,
  and define invalidation or versioning for server-derived output dependencies. Do not
  include raw HTML in a cache key.
- Preserve `retry: false` for this safety boundary; retry must remain explicit and
  scoped to the full content identity.
- Keep regression coverage for pending host withholding, error safety, manual retry,
  same-ID source updates, and stale-retry isolation in
  `apps/mail/tests/mail-content-rendering.test.tsx`.
- Keep the exact cache-key contract in
  `apps/mail/tests/mail-content-cache-key-contract.test.ts` and the query-ownership
  contract in `apps/mail/tests/use-threads-content-query-ownership.test.ts`.

## Related Issues

- [Hotel Email HTML Images Missing: CID Rewrite Plus Remote Trust Gate](../ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md)
  documents the adjacent CID and image-trust processing boundary. Its cache paragraph
  references `email-content-v2`, while the current client key is
  `email-content-v3`; refresh that paragraph without merging the two distinct
  learnings.
- [Mail quoted history crop and missing collapse](mail-quoted-history-crop-and-collapse.md)
  covers another transformation in the same processed display pipeline.
