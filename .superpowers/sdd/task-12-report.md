# Task 12 Report — EC2 deploy + full U9 gate + handoff

**Status:** DONE_WITH_CONCERNS  
**Branch:** `EC2-pilot`  
**HEAD:** `71d6311d` (handoff)  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)

## Gate

- **Result:** PASS — `4 passed (2.8m)` (AE1, AE7, AE9, AE8)
- **Command:** `ssm-run-command.sh "bash …/playwright-real-mail-ui-gate.sh"`
- **SPA:** `https://nava.legacy.local`
- **Env:** `BETTER_AUTH_URL=https://nava.legacy.local`, `UNDO_SEND_SECONDS=0`, `AI_WRITE_GATE_ENABLED=true`, `MAIL_TRANSPORT_MODE=real`, FE `VITE_MAIL_POLL_MS=15000`

## Commits (Task 12 slice)

| SHA | Message |
|-----|---------|
| `c5d8caec` | fix(mail): add .js extension to resolve-reply-headers import |
| `d696d301` | fix(e2e): align Playwright base URL with BETTER_AUTH_URL host |
| `1bcdb8ef` | fix(e2e): dismiss Nava onboarding overlay before compose editor |
| `4f0fbe73` | fix(e2e): use UI login for AE7/8/9; tighten onboarding dismiss |
| `80f051ab` | fix(e2e): open compose via sidebar click instead of hard goto |
| `91270fac` | fix(e2e): match Reply button name including shortcut suffix |
| `71d6311d` | docs(pilot): overnight parity handoff report |

## Handoff

`docs/superpowers/plans/handoff-reports/2026-07-23-live-pilot-parity-overnight.md`

## Concerns / residuals

1. `UNDO_SEND_SECONDS=0` left on PM2 for gate — restore `30` if product undo window needed.
2. Env patched by SSM sed; future `write-ec2-env` / activate may overwrite — re-assert before next U9.
3. Cookie mint in gate script unused (UI login preferred) — cleanup optional.
4. First deploy failed on missing `.js` import (fixed); several e2e RCA rounds before green.

## Post-gate fix (2026-07-23)

- `handleDownloadAllAttachments` used `atob(attachment.body)` while API returns `body:''` → empty zip / fail.
- Fix: reuse `getAttachment` signed-URL → blob path (same as single `downloadAttachment`); zip blobs.
- Gate script: UNDO grep now strips both `"` and `'` quotes.
- Commit: `fix(mail-ui): download-all via getAttachment signed URLs`
