---
title: "Mail quoted history crop and missing collapse"
date: 2026-07-23
last_updated: 2026-07-31
category: logic-errors
module: mail / server-pilot quoted history
problem_type: logic_error
component: email_processing
severity: high
symptoms:
  - Outbound replies showed On … wrote: with no prior body (cropped history)
  - Inbound/outbound bodies rendered full nested quotes expanded — no ellipsis toggle
  - First collapse port wrapped every blockquote and .gmail_quote → nested ellipsis chips
root_cause: logic_error
resolution_type: code_fix
tags:
  - quoted-history
  - gmail-quote
  - collapse-quoted
  - construct-reply-body
  - process-email-html
---

# Mail quoted history crop + missing collapse

## Problem
1. Outbound replies showed `On … wrote:` with **no prior body** (cropped history).
2. Inbound/outbound bodies rendered **full nested quotes expanded** — no Gmail/Outlook ellipsis toggle.
3. Follow-up: first collapse port wrapped **every** `blockquote` and `.gmail_quote` → nested ellipsis chips (dropdown-in-dropdown). Button used off-theme gray pill.

## Root cause
1. `apps/mail/lib/utils.ts` `constructReplyBody` omitted `quotedMessage`; composer commented out `decodedBody`. Pilot `sendInput` also dropped FE `originalMessage`.
2. Pilot display path only ran `sanitizeEmailHtml` — never ported quote collapse from `apps/server/src/lib/email-processor.ts`.
3. Gmail MIME is outer `.gmail_quote` wrapping nested `blockquote` / deeper `.gmail_quote`. Collapsing all matches without an outermost-only guard produces multiple `<details>`.

## Fix
1. Restore `quotedMessage` on reply/forward constructors; pass `decodedBody` from composer; sender email in wrote-header; optional `originalMessage` append in pilot `sendInput` (`wire-compat.ts`).
2. `collapse-quoted-html.ts` — `collapseQuotedHtml` / `processQuotedContent` wrap only **outermost** `blockquote` / `.gmail_quote` in `<details class="quoted-toggle">`; one toggle reveals full stream.
3. Display pipeline (`processEmailHtmlForDisplay`, called from tRPC `processEmailContent`): sanitize → CID project → `processQuotedContent`.
4. Outbound wrappers use `class="gmail_quote"` so clients + Zero share one root.
5. Summary styled like thread ThreeDots chrome (`h-7`, `rounded-lg`, dark `#313131`, icon `#898989`/`#6D6D6D`, inline SVG) — shadow DOM cannot use Tailwind/React.

## Prevention
- `apps/mail/tests/construct-reply-body.test.ts` (includes `gmail_quote` assert)
- `apps/server-pilot/tests/collapse-quoted-html.test.ts` (nested → single toggle)
- `apps/server-pilot/tests/mail-wire-contract.test.ts` (`originalMessage` append)

## Related
- `docs/solutions/architecture-patterns/live-pilot-production-parity-real-mail.md`
- `docs/superpowers/plans/handoff-reports/2026-07-23-quoted-history-ellipsis-design-polish-gate.md`
- `docs/solutions/ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md` — same display pipeline (sanitize → CID → quotes); distinct failure mode
