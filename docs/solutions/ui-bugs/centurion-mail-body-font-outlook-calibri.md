---
title: Centurion Mail Body Font Matches Outlook Calibri 11pt
date: 2026-08-06
category: ui-bugs
module: apps/mail compose + apps/server-pilot outbound/display HTML
problem_type: ui_bug
component: email_processing
severity: high
symptoms:
  - Hotel staff said Zero email font looked wrong vs Centurion Outlook replies
  - Compose typing used Geist (app chrome inheritance)
  - Outbound replies wrapped apple-system / Segoe / Arial; new compose sent bare TipTap HTML
  - Read pane inherited Geist after sanitize stripped inline font styles from Outlook Word HTML
root_cause: inconsistent_mail_body_typography
resolution_type: code_fix
tags:
  - calibri
  - outlook-2016
  - centurion
  - mail-body
  - sanitize-html
  - nava-mail-body
  - tip-tap
  - compose
---

# Centurion Mail Body Font Matches Outlook Calibri 11pt

## Problem

Centurion reservations staff (Outlook 2016 / Word HTML front end) saw Zero-composed and Zero-displayed mail typography diverge from their normal Calibri 11pt replies.

## Symptoms

- Typing in TipTap looked like Geist (app `font-sans`), not Calibri.
- Sent replies carried `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', …` wrappers (confirmed in Centurion outbound dump).
- New compose / AI bare `<p>` HTML often had no inline font → classic Outlook Word engine risk (Times New Roman fallback).
- Inbound Outlook `MsoNormal` mail lost Calibri because pilot `sanitizeEmailHtml` strips `style` (keeps `class` only); read pane then inherited Geist via shadow host.

## Root cause

Three independent font contracts (Geist compose, system-stack reply wrap, stripped inbound) with no single Outlook-compatible default. Sanitize correctly blocks style XSS but also removes legitimate Outlook font styles; display had no replacement default.

## Fix

Canonical hotel **mail body** stack: `Calibri, Arial, sans-serif` @ `11pt`. App chrome stays Geist.

1. `wrapMailBodyHtml` / `prepareOutboundHtml` — idempotent wrap with `class="nava-mail-body"` (survives sanitize; `data-*` / `style` do not).
2. `mail.send` — single choke point; same wrapped HTML → DB row + SMTP + draft revision.
3. FE `constructReplyBody` / `constructForwardBody` — same class + stack for WYSIWYG; send skips re-wrap.
4. `processEmailHtmlForDisplay` — prepend fixed `mailBodyDisplayStyleTag()` after sanitize (no user HTML in `<style>`; no forced `#000` for dark mode).
5. `.ProseMirror` — Calibri 11pt; color inherits theme.

## Prevention

- Do not reopen arbitrary `style=` allowlisting for “font only” without a dedicated CSS sanitizer.
- Do not put web fonts first in outbound stacks (Outlook Word → TNR trap).
- Keep one outbound wrap site (`mail.send`); avoid Zod `sendInput` transform mutation.

## Verification

- Unit: `mail-body-typography`, `mail-send-font-wrap`, `process-email-html-font`, `construct-reply-body` (with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`).
- Manual canary (pilot, deferred to deploy): Zero compose → Outlook receive Calibri; Zero read + compose match; dark mode readable.

## Related

- Plan: `docs/superpowers/plans/2026-08-04-centurion-mail-font-parity.md`
- Sanitize strips styles: `apps/server-pilot/src/mail/sanitize-email-html.ts`
