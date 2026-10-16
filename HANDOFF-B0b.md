# HANDOFF-B0b — pane edits + rates survive email switch

**Lane:** B0b. **Branch:** `feat/g-B0b-10160027`. **PR:** https://github.com/kufupa/Zero/pull/344  
**Time:** 2026-10-16 fix round 1.

---

## Fix round 1

Greptile P1s + 250-line cap.

| Issue | Fix |
|---|---|
| Old rates after occupancy edit | Read-back queries `{ input }` and binds only when saved stay terms match (dates, rooms, occupancy). Header fields ignored. |
| Two date options share newest run | Server `latestStaffQuoteRunFor` walks user runs per price-equivalent stay, not newest-on-message. |
| Deleted rooms/stays return | Saved group list is the complete edited list. Empty list stays empty. |
| Scope 281 > 250 | Dropped `Rates ready` toast, `ownStaffQuoteJobs`, messageId-only job lookup. Toast is a follow-up. |

Refused-search “rates ready” and “completed jobs miss toast” go with the toast.

---

## Still true from step 0

Email switch is `selection` → `initialQuoteSession()`. Edits live in module Map + sessionStorage (`pane-edits.ts`). Quote intent reattaches via `bindReadBackStaffQuote` on stay terms.

**Out of scope this round:** toast, header persistence, deploy, live HMS proof.

---

## Verify

- Mail vitest: `pane-edits.test.ts`, `staff-quote-job-bind.test.ts`, `nava-pane-render.test.tsx` — 130 passed, 2 skipped.
- Server-pilot `staff-quote-route.test.ts` not run here (`@ai-sdk/openai` missing in this worktree).
- Remote typecheck after commit.
- Scope: product lines vs merge-base ~150 / 250.

`LANE_DONE PR=344` after push + `@greptileai`. Prod screenshots still after owner deploy.
