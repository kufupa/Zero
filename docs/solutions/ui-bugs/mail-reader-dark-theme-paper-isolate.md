---
title: Dark Theme Mail Reader Follows App Canvas
date: 2026-08-26
category: ui-bugs
module: apps/mail MailContent Shadow DOM reader
problem_type: ui_bug
component: email_processing
severity: high
symptoms:
  - Dark theme reading pane body is a full-column white rectangle with black text
  - Light theme looks correct because paper matches chrome
  - Sidebar, list, and header stay themed; only the message host is white
root_cause: logic_error
resolution_type: code_fix
tags:
  - dark-theme
  - mail-content
  - shadow-dom
  - bgcolor
  - outlook
  - color-scheme
---

# Dark Theme Mail Reader Follows App Canvas

## Problem

Zero dark chrome painted every sanitized message on a hardcoded light-paper `MailContent` host. Dark-theme-only staff saw a white slab behind every body, including unstyled letters.

## Symptoms

- Dark theme: white message column, black text, dark chrome around it
- Light theme: seamless white paper
- Isolation tests locked host `#ffffff` / `#000000` / `color-scheme: light`

## What Didn't Work

- Isolation (`f347321e`) forced the host to light paper so leftover Outlook `bgcolor="#ffffff"` would not go white-on-white after sanitize stripped `style`/`color`. That fixed contrast by abandoning dark theme for the body.
- Full color inversion / `fixNonReadableColors` / inbound `style=` allowlisting stay rejected (XSS and design breakage).

## Solution

1. Host follows app theme: `bg-background text-foreground`. `processingTheme` from `useTheme()`, with `html.dark` when `resolvedTheme` is still unset. No host `colorScheme` override.
2. Dark theme only: prepend fixed `MAIL_PAPER_NEUTRALIZE_STYLE` into the shadow write (`shadowHtml` depends on `processingTheme`, not `resolvedHtml` alone). Paper `bgcolor` values (`#ffffff` / `#fff` / `#fffffe` / `white`, `i` flag, hashless twins) become `transparent`.
3. Sanitizer, stored MIME, and `mailBodyDisplayStyleTag()` stay unchanged. Quote toggles follow the real processing theme again.

## Why This Works

Sanitize keeps `bgcolor` and drops authored colors. Unstyled text inherits the host. Neutralizing paper whites lets the themed canvas show through without rewriting arbitrary tinted cells.

## Prevention

- Do not pin `MailContent` to `#ffffff` to "fix" dark-mode contrast.
- Shadow write must include theme in its dependencies when CSS is prepended client-side.
- Playwright fixture uses `#FFFFFF` and asserts the table is not white; light fixture keeps paper white.
- Never Vitest against pilot RDS.

## Related Issues

- `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md`
- `docs/superpowers/plans/2026-08-23-mail-content-dark-mode-isolation.md`
- `docs/superpowers/plans/2026-08-26-mail-reader-dark-theme.md`
