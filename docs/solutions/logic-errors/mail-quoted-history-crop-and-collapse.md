# Mail quoted history crop + missing collapse

## Problem
1. Outbound replies showed `On … wrote:` with **no prior body** (cropped history).
2. Inbound/outbound bodies rendered **full nested quotes expanded** — no Gmail/Outlook ellipsis toggle.
3. Follow-up: first collapse port wrapped **every** `blockquote` and `.gmail_quote` → nested ellipsis chips (dropdown-in-dropdown). Button used off-theme gray pill.

## Root cause
1. `apps/mail/lib/utils.ts` `constructReplyBody` omitted `quotedMessage`; composer commented out `decodedBody`. Pilot `sendInput` also dropped FE `originalMessage`.
2. Pilot `processEmailContent` only ran `sanitizeEmailHtml` — never ported `collapseQuoted` from `apps/server/src/lib/email-processor.ts`.
3. Gmail MIME is outer `.gmail_quote` wrapping nested `blockquote` / deeper `.gmail_quote`. Collapsing all matches without an outermost-only guard produces multiple `<details>`.

## Fix
1. Restore `quotedMessage` on reply/forward constructors; pass `decodedBody` from composer; sender email in wrote-header; optional `originalMessage` append in pilot `sendInput`.
2. `collapse-quoted-html.ts` — wrap only **outermost** `blockquote` / `.gmail_quote` in `<details class="quoted-toggle">`; one toggle reveals full stream.
3. Outbound wrappers use `class="gmail_quote"` so clients + Zero share one root.
4. Summary styled like thread ThreeDots chrome (`h-7`, `rounded-lg`, dark `#313131`, icon `#898989`/`#6D6D6D`, inline SVG) — shadow DOM cannot use Tailwind/React.

## Prevention
- `apps/mail/tests/construct-reply-body.test.ts` (includes `gmail_quote` assert)
- `apps/server-pilot/tests/collapse-quoted-html.test.ts` (nested → single toggle)
- wire contract tests for `originalMessage`

## Related
- `docs/solutions/architecture-patterns/live-pilot-production-parity-real-mail.md`
- `docs/superpowers/plans/handoff-reports/2026-07-23-quoted-history-ellipsis-design-polish-gate.md`
