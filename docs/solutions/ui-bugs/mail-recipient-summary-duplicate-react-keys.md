---
title: Duplicate React keys in mail recipient summaries
date: 2026-08-10
category: ui-bugs
module: apps/mail recipient summary rendering
problem_type: ui_bug
component: email_processing
symptoms:
  - Repeated formatted recipients could receive the same React key in To or Cc summaries.
  - Visible and overflow recipient lists could not distinguish duplicate display values safely.
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - mail
  - recipient-summary
  - react-keys
  - mailbox-format
---

# Duplicate React keys in mail recipient summaries

## Problem

The mail reader renders recipient summaries as sibling React elements. Formatted
mailbox text is presentation data, not a unique identity: two recipient rows can
both display as the same address. Using that text as the React key made duplicate
recipients unsafe to render.

## Symptoms

- Repeated recipient display values could produce duplicate keys in either the
  first three visible entries or the overflow tooltip.
- The summary needed stable unique keys without hiding legitimate duplicate
  recipient rows.

## What Didn't Work

- Reusing `formatMailboxPlain` output as both visible text and a React key
  assumes every rendered mailbox value is unique. For a mailbox with a usable
  address, the formatter returns either an address or `Name <address>`, so that
  invariant does not hold.
- Deduplicating recipients would change the mail data staff see instead of
  fixing UI identity.

## Solution

The local implementation of `formatMailboxEntries` separates display text from
list identity. It formats each mailbox, counts occurrences of each non-empty
rendered value, and returns a deterministic `{ key, value }` record.

```typescript
const occurrence = (occurrenceByValue.get(value) ?? 0) + 1;
occurrenceByValue.set(value, occurrence);
return [{ key: JSON.stringify([value, occurrence]), value }];
```

The summary renderer consumes `value` for the text and `key` for React in both
the visible and hidden recipient lists:

```typescript
{visibleRecipients.map(({ key, value }, index) => (
  <span key={key}>{value}</span>
))}
```

Source: `apps/mail/lib/mail/mailbox-format.tsx:34-46` and
`apps/mail/components/mail/mail-display.tsx:224-247`.

## Why This Works

Occurrences are tracked after formatting, so two rows that both display as
`guest@example.com` get different identities while retaining exactly the same
visible text. Given the same recipient order, the generated keys are
deterministic. This preserves duplicate entries and gives React unique sibling
keys in each recipient list.

The regression test covers two repeated addresses and a separately formatted
`Guest <guest@example.com>` entry in
`apps/mail/tests/mailbox-format.test.ts:4-18`.

## Prevention

- Use `formatMailboxEntries` for mailbox-derived React lists; never reuse
  formatted display text as the list key.
- Keep presentation and identity separate when source data permits duplicate
  rendered values.
- Include repeated rendered values in recipient-list tests, including both the
  inline summary and its overflow path.

## Related Issues

- [Mail open-thread stale after ingest and outbound To You mislabel](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md)
  documents a separate recipient-display rule and the same preference for pure,
  tested presentation helpers.
