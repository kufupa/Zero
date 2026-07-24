# Handoff — compose-close-draft-honesty

**Date:** 2026-07-24  
**Branch:** `EC2-pilot` @ `5ce64288`  
**Plan:** `docs/superpowers/plans/2026-07-24-compose-close-draft-honesty.md`  
**Verdict:** DONE — code shipped, vitest green, AE1–AE4 green on live pilot Playwright, ops-deploy ok.

## Commits (feature + overnight RCA)

| SHA | Summary |
|-----|---------|
| `b7a586c2` | helpers + flush registry |
| `2969d71a` | honest Save/Discard/Keep editing dialog |
| `2d3090ad` | mail-list flush before thread switch |
| `d0569cb9` | thread-display flush in clearComposeContext |
| `21967853` | await flush before navigate (race fix) |
| `33b13878` | do not await draft save query invalidations |
| `eba59d61` | upsert drafts.create on active-thread unique conflict |
| `5ce64288` | invalidate mail.get after draft delete |
| `7258b50f`… | real-mail AE gate (`real-mail-compose-close-honesty.spec.ts`) |

## Tests

- `apps/mail` vitest: draft-persistence / compose-flush-registry / reply-compose-context / stale-draft-send-flow
- Pilot Playwright: **4/4 passed** `real-mail-compose-close-honesty` (AE1–AE4)

## Deploy

- `ops-deploy.sh` → health ok, VPN hard OK @ `5ce64288`

## Divergence / overnight RCA

1. Wave 2 race: await flush before `setThreadId`
2. Save hung on `await invalidateQueries(listThreads)` → fire-and-forget invalidations
3. Save failed with `mail_draft_one_active_thread_uidx` when `draftId` omitted → upsert + bind `latestDraft.id`
4. Discard left stale `mail.get` cache → invalidate `mail.get` after delete

## Deferred (unchanged)

Create-email DialogClose bypass; pop-out; autosave settings UI; non-en locale keys; AI candidate mass-discard redesign.
