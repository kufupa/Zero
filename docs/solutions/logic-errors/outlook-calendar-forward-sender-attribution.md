---
title: Outlook Calendar Forward Stored Organizer as Sender Instead of Forwarder
date: 2026-07-28
category: logic-errors
module: server-pilot/mail-ingest
problem_type: logic_error
component: email_processing
severity: medium
symptoms:
  - Centurion mailbox UI showed calendar organizer (aroransh17@gmail.com) as sender on an Outlook calendar forward
  - message.from_address stored organizer email instead of actual forwarder kdouglas@legacyhotels.co.za
  - Triage, reply-to, never-spam, and UI attribution all read wrong from_address for FW calendar invites with X-RS-Calendar
root_cause: logic_error
resolution_type: code_fix
related_components:
  - database
tags:
  - outlook
  - calendar-forward
  - sender-header
  - rfc5322
  - mail-ingest
  - parse-message
  - from-address
  - server-pilot
---

# Outlook Calendar Forward Stored Organizer as Sender Instead of Forwarder

## Problem

Outlook calendar forwards preserve the original appointment organizer in MIME `From` while the person who actually forwarded the message appears in `Sender`. The ingest parser in `apps/server-pilot/src/mail/ingest/parse-message.ts` (`buildParsedMessage`) only read `From` and stored that as `fromAddress`. Downstream code in `apps/server-pilot/src/mail/ingest/store.ts` treats `parsed.fromAddress` as the canonical sender for DB persistence, direction (`inbound` vs `outbound`), sender preferences, soft-quarantine, and UI attribution. A calendar forward therefore looked like it came from the organizer (e.g. `aroransh17@gmail.com`) instead of the forwarder (e.g. `kdouglas@legacyhotels.co.za`).

## Symptoms

- UI showed wrong sender on forwarded Outlook calendar messages.
- Never-spam allowlist logic keyed off `fromAddress` did not match the real forwarder; triage behaved as if an allowlisted organizer sent mail the user never sent to Centurion.
- Reply-to and sender-preference lookups (`getSenderPreference` in `store.ts`) used the organizer address, so block/allow prefs applied to the wrong identity.
- Initial misread: looked like spam false-negative or never-spam bypass on Ansh's allowlist. User correctly noted they did not send to Centurion — root cause was MIME header attribution, not spam policy.

Production example: message `83dc749d-…` raw MIME had `Sender: kdouglas@legacyhotels.co.za` while `From` held the calendar organizer; after fix, stored `from_address` corrected to the forwarder.

## What Didn't Work

- Treating the symptom as spam/triage failure or never-spam allowlist misconfiguration.
- Assuming `From` always equals the transmitting mailbox on forwarded calendar items.
- No regression coverage for divergent `Sender` vs `From` before the fixture and three parse tests were added.

## Solution

**File:** `apps/server-pilot/src/mail/ingest/parse-message.ts` — `buildParsedMessage`

**Before:**

```ts
const fromHeaderRaw = firstHeader(headers, 'from');
const fromAddress = extractAddress(headers.get('from')) ?? fromHeaderRaw;
```

**After:**

```ts
const fromHeaderRaw = firstHeader(headers, 'from');
const fromEmail = extractAddress(headers.get('from')) ?? fromHeaderRaw;
const senderEmail = extractAddress(headers.get('sender'));
// ponytail: Outlook calendar FW keeps organizer in From; Sender is transmitter.
const fromAddress =
  senderEmail &&
  fromEmail &&
  senderEmail.trim().toLowerCase() !== fromEmail.trim().toLowerCase()
    ? senderEmail
    : fromEmail;
```

**Tests added in** `apps/server-pilot/tests/ingest-store.test.ts` (`parseRawMessage` suite):

| Case | Fixture / setup | Expected `fromAddress` |
|------|-----------------|------------------------|
| Divergent Sender | `outlook-calendar-fw-sender.eml` | `kdouglas@legacyhotels.co.za` |
| Absent Sender | `centurion-stamped.eml` (no Sender header) | `guest1@example.com` |
| Equal Sender | `centurion-stamped.eml` + injected `Sender: Guest One <guest1@example.com>` | `guest1@example.com` |

**Fixture:** `apps/server-pilot/tests/fixtures/outlook-calendar-fw-sender.eml` — `From: Ansh Arora <aroransh17@gmail.com>`, `Sender: Kamala Douglas <kdouglas@legacyhotels.co.za>`, `X-RS-Calendar: Yes`.

Commits on `EC2-pilot`: `1440aac7` (fix), `2dbc48ab` (handoff). Plan: `docs/superpowers/plans/2026-07-28-ingest-sender-header.md`.

## Why This Works

RFC 5322 allows `Sender` when the transmitting agent differs from the author in `From` (common for forwards and on-behalf-of). Outlook calendar forwards keep the appointment organizer in `From` and put the forwarding mailbox in `Sender`. Preferring `Sender` only when it is present and case-insensitively different from `From` yields the actual transmitter without breaking normal mail (no Sender) or redundant Sender=From headers. `fromAddress` then flows correctly through `store.ts` into `message.fromAddress`, sender prefs, triage inputs, and UI.

## Prevention

1. **Keep the three-case matrix** in `ingest-store.test.ts` whenever touching `buildParsedMessage` or header extraction:
   - `expect(parsed.fromAddress).toBe('kdouglas@legacyhotels.co.za')` for divergent Sender (`outlook-calendar-fw-sender.eml`).
   - `expect(parsed.fromAddress).toBe('guest1@example.com')` when Sender absent.
   - Same assertion when Sender equals From (injected header on `centurion-stamped.eml`).

2. **Add a fixture** for any new forward/calendar variant before changing parser logic; mirror real raw MIME from production (Return-Path, From, Sender, calendar markers).

3. **Code review rule:** any change to `fromAddress` derivation must cite RFC 5322 Sender semantics and run `apps/server-pilot/tests/ingest-store.test.ts` parse suite.

4. **Prod verification:** on suspect forwards, inspect raw MIME for both `From` and `Sender`; stored `from_address` must match the transmitting mailbox when they differ.

5. **Avoid triage rabbit holes:** if allowlist/never-spam looks wrong but user denies sending, check ingest attribution first (`parse-message.ts` → `store.ts` `fromAddress` column) before changing spam policy.

## Related Issues

- [mail-open-thread-stale-and-recipient-you-label.md](./mail-open-thread-stale-and-recipient-you-label.md) — display-layer “You” mislabel when ingest From/To already correct (distinct from Sender vs From parse bug).
- [folder-first-spam-at-folder-matrix.md](../architecture-patterns/folder-first-spam-at-folder-matrix.md) — sender prefs consume ingest `fromAddress`.
- [ec2-pilot-pre-real-ingest-security-gate.md](../security-issues/ec2-pilot-pre-real-ingest-security-gate.md) — ingest-parser trust guidance adjacent to MIME header correctness.
- [mail-transport-mode-fixture-vs-real.md](../architecture-patterns/mail-transport-mode-fixture-vs-real.md) — shared ingest path where `parse-message` runs.
- [sender-click-copies-email.md](../ui-bugs/sender-click-copies-email.md) — UI shows ingest sender first.
- Plan / handoff: `docs/superpowers/plans/2026-07-28-ingest-sender-header.md`, `docs/superpowers/plans/handoff-reports/2026-07-28-ingest-sender-header.md`
