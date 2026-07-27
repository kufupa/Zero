# Handoff — spam MVP (folder + heuristic overnight)

**Date:** 2026-07-27  
**Branch:** `EC2-pilot` @ `d4800a1b`  
**Plan:** `docs/superpowers/plans/2026-07-27-spam-mvp-heuristic-overnight.md`  
**Verdict:** Night-1 code + migrate shipped. Unit/FE contract green. DB folder invariants clean. Interactive UI smoke deferred (no Playwright password on box).

## Commits (Tasks 1–8)

| SHA | Summary |
|-----|---------|
| `982c82f7` | clear `spamAt` when moving threads to bin |
| `e8e14c79` | clear `spamAt` on all bin/trash transitions |
| `2c75bdbb` | never-spam allowlist (legacyhotels + pilot gmails) |
| `53dee433` | refine heuristic contract tests (agency/guest-file/handover/…) |
| `e6be236d` | `spam_user_locked_at` freezes AI spam flips after user correction |
| `99fc7bcf` | hide legacy SPAM user-label chips |
| `dc7cfe7b` | `mail.emptySpam` soft-trash clearing `spamAt` |
| `25a9318d` | sender block/allow prefs + ingest wire (+ Task 10 belt in apply) |
| `d4800a1b` | Undo toast after mark spam |

## Deploy

- Push: `941b30d3..d4800a1b` on `EC2-pilot`
- `ops-deploy.sh --migrate` → ok; health `{"ok":true,"service":"server-pilot"}` on `:8788`
- PM2: `http` / `worker` / `ai-worker` online @ HEAD `d4800a1b`
- `SPAM_PURGE_ENABLED=false` on EC2 `.env.production`
- Schema: `mail_thread.spam_at`, `mail_thread.spam_user_locked_at`; table `mail_sender_preference` present
- Drizzle migrations through id 15 applied

## Tests (EC2)

| Suite | Result |
|-------|--------|
| `apps/server-pilot` `tests/never-spam.test.ts` | 3/3 pass |
| `apps/mail` vitest (focused run pulled full suite) | 235 pass / 51 files |
| DB-backed `mail-thread-actions` / auth callers with sourced `.env.production` | **RED** — `getSessionUser` → `auth` null (`Cannot read properties of null (reading 'api')`). Harness/env mismatch, not feature regression. Unit paths for spam logic green. |

## Smoke

### Automated / DB

```text
spam_folder=4  bin_folder=0  orphan_spam_and_trash=0  orphan_archive_spam=0
```

Folder matrix hold: no `spam_at`+`trashed_at` orphans; no archive-keeping-spam orphans.

### Interactive UI checklist (residual — human / local Playwright)

Needs `PLAYWRIGHT_REAL_MAIL_PASSWORD` (absent from pilot `.env.production`):

1. Mark spam → leaves inbox  
2. Not spam → stays after triage (lock)  
3. From `@legacyhotels.co.za` AI spam stamp → stays inbox/internal  
4. Empty spam → threads in bin, gone from spam  
5. No SPAM chip on normal inbox row  

## Residual / Night-2

- Enable 30d purge only behind deliberate flag flip (`SPAM_PURGE_ENABLED` stays false)
- `spam_source` banner, soft-quarantine rename, prefs settings UI, a11y polish
- RCA/fix vitest `callerFor` when sourcing production env (auth null) if EC2 DB integration tests needed overnight again
- Manual AE checklist above

## Frozen decisions (unchanged)

- Truth = `spam_at` folder-first  
- Bin entry clears `spam_at`  
- Never-spam = auto-triage only; manual mark-spam + user block still allowed  
- Archive clears `spam_at` (do not keep spam in archive)
