# Handoff: Thread draft at top

**Date:** 2026-09-07  
**Branch:** `fix/thread-pane-layout-overflow`  
**Deployed SHA:** `5036c8871bb5999315c3ccfa64844e62c3215f23`

## Goal

Saved thread draft stack (manual then AI) renders above newest email, Outlook-style.

## Commits

| SHA | Message |
|-----|---------|
| `a36a8a24` | `test(mail): add failing contract for draft stack above newest email` |
| `5036c887` | `fix(mail): show thread draft stack above newest email` |
| `b2dceeb1` | docs: spec + autonomous plan (prior) |

## Divergence

Contract test needle for message map changed from `displayMessages.map` → `{displayMessages.map` because an earlier linked-thread id collect also called `displayMessages.map` and produced a false fail. Logged; behavior unchanged.

## Verification

- Vitest (DATABASE_URL unset): `thread-draft-leading-contract`, `thread-display-order`, `reply-composer-viewport-contract`, `thread-pane-layout-contract` — 14 PASS
- `ops-deploy` to EC2: HEAD `5036c887`; health `8788`/`8789` ok after `ops-restart` (brief remote-http EADDRINUSE from bad `pm2 restart --update-env` — fixed via ops-restart)
- `NAVA_BUILD_COMMIT` stamped to `5036c887…`
- Launch-readiness still `NOT_READY` on pre-existing `workflowDeadLetterBacklogEmpty` (529) — unrelated
- Live Playwright on `https://nava.legacyhotels.co.za`, thread `dcc67df7-…`:
  - `[Draft]` badge visible
  - `draftTop=109.3 < firstMailTop=241.8` (message id `mail-<uuid>` only)
  - Reply open → draft card hidden

## Done criteria

All plan done-criteria evidenced.
