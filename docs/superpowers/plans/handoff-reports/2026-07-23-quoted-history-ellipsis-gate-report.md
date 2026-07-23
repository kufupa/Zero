# Gate report — quoted message history ellipsis

**Date:** 2026-07-23  
**Branch:** `EC2-pilot` @ `52f301f4`  
**Plan:** `docs/superpowers/plans/2026-07-23-quoted-message-history-ellipsis-plan.md`

## Done criteria

| Criterion | Status |
|-----------|--------|
| Reply/forward HTML includes prior body after quote header | PASS — `constructReplyBody` / `constructForwardBody` + composer |
| Quote header uses sender email (not reply To) | PASS |
| Quoted blocks collapsed by default (`blockquote`, `.gmail_quote`) | PASS — `collapse-quoted-html.ts` + `processEmailContent` |
| Boxed ellipsis summary (`⋯`) | PASS |
| Local vitest (mail construct-reply + pilot suites) | PASS |
| EC2 `ops-deploy.sh` + health | PASS (`{"ok":true,"service":"server-pilot"}`) |
| EC2 SSM vitest (collapse + wire + sanitize) | PASS — 32/32 |

## RCA summary

Outbound crop: constructors omitted `quotedMessage`; composer commented out `decodedBody`; pilot `sendInput` dropped `originalMessage`.  
Display: pilot never ran legacy `collapseQuoted`.

## Commits

- `52f301f4` — `fix(mail): include quoted history and collapse it behind ellipsis`

## Divergence

- Wrote-header angle brackets use **sender email** (Gmail-correct) instead of original To list — clearer than plan's "pass original To" wording.
- Belt-and-suspenders: `originalMessage` still accepted on pilot `sendInput` and appended when missing from html.

## Manual UI check (optional morning)

Open a thread with nested quotes → should see boxed `⋯` under new text; click expands history. Send a reply → recipient/thread should show full prior body under `On … wrote:`.
