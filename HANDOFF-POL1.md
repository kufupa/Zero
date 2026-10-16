# HANDOFF-POL1

Updated: 2026-10-16T01:35Z
Branch: `feat/g-POL1-10160126`
PR: (open after impl)
#344 B0b: still OPEN — Treat-as cache is independent, not built on pane-edits.

## (c) Twin priced as Standard Queen — finding

**Where:** `apps/server-pilot/src/ai/quote-ready.ts:76-86` (`groupForStay`).
**Not in** `staff-quote-run.ts` — that file never defaults a room code.

Unpicked twin request:

1. Extraction `roomType` is `"twin"` / `"1 x twin"` / `"2 beds"`.
2. `matchRoomType("twin")` returns suggestions `[STWN, DLXTWN]` and **no** unique `code` (Standard Twin vs Deluxe Twin).
3. `"2 beds"` / `"two beds"` is emptied: `IGNORED_ROOM_WORDS` contains `two` and `bed`.
4. `groupForStay` only sets `roomCodes` when `roomMatch.code` is unique → **omitted**.
5. HMS search with no room filter returns the first BAR type, **Standard Queen (STQN)**.

Pane path matches: `staff-quote-bind.ts:staffQuoteGroupsFromStay` + test *lets a defaulted unresolved room preference quote any type* (`roomPreference: 'Twin'`, `fields.roomPreference: 'defaulted'`) sends **no** `roomCodes`.

**Fix:** map twin / 2 beds → `STWN` when staff have not picked a code. Unique names (`Deluxe Twin`) still win via `matchRoomType`. Queen/king/double/single stay omitted (ambiguous).

## (a) Reply editor

`document-review.tsx:114-121` `<textarea value={session.reviewedReplyHtml}>` shows raw HTML. Composer uses TipTap; pane gets a small `contentEditable` that keeps the same HTML in session.

## (b) PDF name "Guest"

`quote-proposal/filename.ts:8` fallback `'Guest'` when agency (and proposal-pdf's company) empty. Party order: agency → company → attention/contact → sender display name from `message.fromAddress`. Never `Guest`. workstation overwrites `fileName` after PDF build (`proposal-pdf.ts` not in allow-list).

## (d) Treat-as lost on switch

`nava-pane.tsx:510` reset on `currentScope`; `treatAs` is session-only (`:559/:609/:664`). Persist per mail in sessionStorage (same idea as auto-quote suppress). #344 not merged, so not the B0b pane-edits map.

## Status

Impl done. Focused tests green. Typecheck + PR next. No deploy.

| Item | Fix | Tests |
|---|---|---|
| (a) reply editor | `document-review.tsx` contentEditable, same HTML | `document-review.test.tsx`, pane reply tests |
| (b) PDF name | `filename.ts` party order; workstation retargets | `quote-pdf-filename.test.ts` |
| (c) twin | `quote-ready.ts` + `staff-quote-bind.ts` → STWN | `quote-ready.test.ts`, backend-bind |
| (d) Treat-as | `treat-as-cache.ts` sessionStorage per mail; restore on open | `treat-as-cache.test.ts` |

#344 still OPEN — cache is independent of B0b pane-edits.
