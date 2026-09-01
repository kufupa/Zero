---
title: HTML zoom leaves persistent black band at viewport bottom
date: 2026-09-01
category: ui-bugs
module: mail
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Solid black horizontal band at bottom of Chrome window on Nava admin mail UI"
  - "All three columns (sidebar, list, thread) stop at same height regardless of window resize"
  - "Chrome page zoom changes do not remove the gap"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags:
  - css-zoom
  - viewport-height
  - mail-shell
  - globals-css
  - kufupa-main
---

# HTML zoom leaves persistent black band at viewport bottom

## Problem

Hotel staff on Nava admin saw a large empty black strip at the bottom of the mail UI. The app looked scaled down inside the browser, but the page background did not fill the viewport.

## Symptoms

- Solid black horizontal band (~20% of viewport height) below sidebar, inbox list, and thread pane
- Gap persisted across window resize and Chrome zoom (Ctrl +/-)
- Built CSS contained `html{zoom:.8}` on live EC2 (`kufupa/main`)

## What Didn't Work

- Changing Chrome zoom percentage — independent from CSS `zoom`; gap ratio stayed the same
- Suspecting a browser extension — band was full-width, matched layout cutoff, and reproduced on deployed build with zoom baked into assets

## Solution

Replace root `zoom` with root `font-size` scaling in `apps/mail/app/globals.css`:

```css
@layer base {
  html {
    font-size: 80%;
  }
}
```

Before (broken):

```css
html {
  zoom: 0.8;
}
```

Commit `18964619` on `kufupa/main`. Deploy with `GIT_BRANCH=kufupa/main` — default `ops-deploy` syncs `main`, which did not contain this fix at time of ship.

## Why This Works

CSS `zoom` on `<html>` paints the document at 80% scale while layout/viewport units (`100vh`, `100dvh`, Tailwind `h-screen`, `max-h-screen`) still resolve against the full viewport. Visual height ≈ 80% → ~20% uncovered page background (dark theme reads as black bar).

Root `font-size: 80%` scales rem/em-based typography and spacing (Tailwind default) without shrinking the layout box against viewport height. Mail shell keeps filling the window; UI stays denser for staff who wanted a zoomed-out feel.

## Prevention

- Do not use `zoom` on `html`/`body` for app-wide density when shell uses `h-screen` or `100dvh`
- Prefer root `font-size` percentage, design tokens, or user-controlled browser zoom
- After CSS layout changes on hotel mail, verify full viewport fill at 100% Chrome zoom before `ops-deploy`
- Confirm deploy branch: pilot Nava admin tracks `kufupa/main`; `GIT_BRANCH=kufupa/main ops-deploy` when shipping that line

## Related Issues

- [mail-reply-inbox-list-horizontal-shift.md](./mail-reply-inbox-list-horizontal-shift.md) — same mail shell viewport containment surface
- [ec2-pilot-ops-deploy-restart-reboot.md](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — deploy entrypoint and default `GIT_BRANCH=main`
