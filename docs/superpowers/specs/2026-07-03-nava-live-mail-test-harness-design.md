# Nava Live Mail Test Harness Design

**Date:** 2026-07-03
**Branch:** `EC2-pilot`
**Status:** Ready for implementation

## Goal

Enable manual real-mail testing from the normal mail UI with a dedicated Nava ops login. The human tester should be able to prove:

1. App sends to `nava@legacyhotel.com` and the looped-back message appears in the Nava inbox.
2. External mail to `nava@legacyhotel.com` appears in the Nava spam folder.
3. App sends to an external inbox and records the sent message in the normal sent folder.

## Non-Goals

- Quarantine list/release APIs.
- `/mail/quarantine` frontend routes.
- Staff-facing ops tools.
- Custom outbound header editing.
- New Zimbra rules for app self-loop testing.
- New `message` schema columns for header copies.
- S3 raw MIME reads for header debug.
- Automated live-mail tests run by agents.

## Architecture

```text
[nava-ops login]
      |
      v
normal mail UI: inbox / spam / sent / compose
      |
      v
server-pilot tRPC
active transport = transport-nava
      |
      +-- mail.send stamps X-Zero-Mailbox: nava@legacyhotel.com
      |        |
      |        v
      |   SMTP / Zimbra / POP3 loopback
      |
      +-- ingest stores:
      |        X-Zero-Mailbox match       -> target transport inbox
      |        missing header + To match  -> target transport spam
      |        no match / unknown header  -> quarantine table only
      |
      +-- mail.get returns Nava-only debug headers from message metadata
```

## Chosen Design

### 1. Nava Transport And Login

Seed one extra app user and one extra transport:

| Row | Value |
| --- | --- |
| Transport id | `transport-nava` |
| Transport email | `nava@legacyhotel.com` |
| Owner header | `nava@legacyhotel.com` |
| App user id | `user-nava` |
| App login email | `nava-ops@legacyhotel.com` |
| Access | `user-nava` -> `transport-nava`, role `owner`, `isDefault: true` |

Centurion users stay scoped to `transport-centurion`; no staff user receives access to `transport-nava`.

### 2. Outbound Header Stamp

`mail.send` passes an SMTP-only extra header:

```http
X-Zero-Mailbox: <ctx.transportEmail>
```

The backend stamps this. The frontend cannot supply or edit it. Reply threading still uses existing DB fields:

- `messageIdHeader`
- `inReplyTo`
- `references`

### 3. Direct-To Spam Fallback

Inbound routing keeps `X-Zero-Mailbox` as the primary path. Missing-header mail falls back only when the raw `To` header includes an active transport email.

| Condition | Result |
| --- | --- |
| `X-Zero-Mailbox` matches active transport | Store on that transport inbox |
| No header, `To` includes `nava@legacyhotel.com` | Store on `transport-nava` with `SPAM` label |
| No header, `To` includes another active transport email | Store on that transport with `SPAM` label |
| No header, no `To` match | Existing quarantine table |
| Unknown `X-Zero-Mailbox` value | Existing quarantine table |

Use `To` only, not `Cc` or `Bcc`. BCC sink copies should still depend on the trusted transport stamp.

### 4. Header Debug

Header debug is intentionally metadata-only.

Server gate:

```text
ctx.activeTransportId === "transport-nava"
```

Client reveal:

```text
activeConnection.id === "transport-nava"
localStorage["zero-dev-show-headers"] === "1"
```

Inbound debug lines come from existing `message` columns:

```text
X-Zero-Mailbox -> message.ownerHeaderValue or "(missing)"
Message-ID     -> message.messageIdHeader
In-Reply-To    -> message.inReplyTo
References     -> message.references
```

Outbound debug lines are reconstructed from the send invariant:

```text
X-Zero-Mailbox -> active transport email
Message-ID     -> message.messageIdHeader
In-Reply-To    -> message.inReplyTo
References     -> message.references
```

This deliberately does not read S3 and does not add `mimeHeaderLines`. Full raw MIME remains available in S3 for backend/operator investigation, not normal UI.

### 5. Manual Playbook

| Test | Human steps | Pass condition |
| --- | --- | --- |
| App to self | Login as `nava-ops@legacyhotel.com`, compose to `nava@legacyhotel.com`, wait for POP worker | Thread appears in Nava inbox; optional debug shows `X-Zero-Mailbox: nava@legacyhotel.com` |
| External to Nava | Send from external mailbox to `nava@legacyhotel.com`, wait for POP worker | Thread appears in Nava spam; optional debug shows missing `X-Zero-Mailbox` |
| App to external | Login as `nava-ops@legacyhotel.com`, send to external address | External inbox receives mail; app sent folder shows outbound row |

## Complexity Cuts

- Delete planned `mimeHeaderLines` schema/migration.
- Delete planned quarantine API/UI.
- Delete planned `mail.getMessageHeaders` route.
- Delete planned `S3Storage.getObject`.
- Do not expose header tools by role; `admin` is too broad for staff.
- Do not add settings page switches; `localStorage` plus Nava transport gate is enough.
- Do not add custom header editor; read-only debug preview only.

## Test Requirements

- Seed contract: Nava transport, ops user, Nava-only access, credential account, SPAM labels.
- SMTP send: fake transport receives `X-Zero-Mailbox`.
- Ingest: `missing-owner.eml` routes to `transport-nava` spam, not quarantine.
- Ingest: unknown To without header still quarantines.
- Worker: missing-owner fixture outcome changes from quarantined to stored on `transport-nava`.
- Metadata debug: Nava `mail.get` responses include debug lines; Centurion responses do not.
- FE helpers: header tools enable only for `transport-nava`; outbound preview is deterministic.

## Risks

- SMTP relay strips custom headers: app-to-self returns as spam instead of inbox because the direct-To fallback catches it. Manual test catches this immediately.
- Staff leakage: server only returns debug lines for `transport-nava`; client gate is only UI hiding.
- Direct-To fallback broadens missing-header behavior for known transports: acceptable because it still lands in spam, not inbox, and unknown recipients still quarantine.
