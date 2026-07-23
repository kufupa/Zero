# Mail quoted history crop + missing collapse

## Problem
1. Outbound replies showed `On … wrote:` with **no prior body** (cropped history).
2. Inbound/outbound bodies rendered **full nested quotes expanded** — no Gmail/Outlook ellipsis toggle.

## Root cause
1. `apps/mail/lib/utils.ts` `constructReplyBody` omitted `quotedMessage`; composer commented out `decodedBody`. Pilot `sendInput` also dropped FE `originalMessage`.
2. Pilot `processEmailContent` only ran `sanitizeEmailHtml` — never ported `collapseQuoted` from `apps/server/src/lib/email-processor.ts`.

## Fix
1. Restore `quotedMessage` on reply/forward constructors; pass `decodedBody` from composer; sender email in wrote-header; optional `originalMessage` append in pilot `sendInput`.
2. New `collapse-quoted-html.ts` — wrap `blockquote` / `.gmail_quote` in `<details class="quoted-toggle">` with boxed `⋯` summary; wire in `processEmailContent`.

## Prevention
- `apps/mail/tests/construct-reply-body.test.ts`
- `apps/server-pilot/tests/collapse-quoted-html.test.ts`
- wire contract tests for `originalMessage`

## Related
- `docs/solutions/architecture-patterns/live-pilot-production-parity-real-mail.md`
