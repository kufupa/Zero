# Handoff — Lab HITL Proposed rail (loop 1 of ≤5)

**Date:** 2026-09-21  
**Branch:** `feat/centurion-dashboard-tools`  
**Status:** Loop 1 shipped overlay + tests. **Not 10/10.** Luna wave `proposed` still running (7 shards). Goal remains open.

## Counts (no PII)

| Metric | Value |
|--------|------:|
| Lab rows | 1069 |
| StayAsk rows | 190 |
| Rows with proposedActions length>0 | 434 |
| Explicit empty skip | 635 |
| Multi-live (>=2) | 217 |
| attachmentText starting `%PDF` | 0 |
| Mail lab Vitest | 18/18 |
| Dual-plane unauth `/api/lab/centurion-index` | 401 / 401 |
| SPA asset `lab-span-action-0` on nginx | present |
| Luna `proposed-*.jsonl` written | 0 (in flight) |

## Features added this loop

- Proposed rail (verb + facts + color). Kill stay chips.
- Per-action inbound marks (amber/teal/violet/lime). Gold stays blue.
- Input fold + Staff did (`usedResult`).
- Empty: “No HMS write for this mail”.
- Already quoted fold for superseded.
- PDF harvest: no latin-1 `%PDF` dump. Sanitize drops soup.
- Derive proposedActions from stayAsks + needed tools. Luna will overwrite.

## Features still wrong / next loops

- 635 empty is likely over-skip (`no_reply_owed` + other-desk). Hunt false empties.
- Folio/cancel/group/event packs still mostly derived, not Luna-reviewed.
- `index.html` hash check on overlay did not prove HTML points at new bundle; hashed JS file is on disk. Hard-refresh.
- Luna 1069 not collated yet.
- No captured Playwright PMS payloads — Staff did is gold-only.
- Old hashed JS with `lab-stay-asks` may still sit next to the new file.

## Come-back so far (partial)

1. Schema fields unchanged this loop (freeze ids frozen).
2. Process: inbound → sanitize/derive → (Luna pending) → coerce → Proposed rail.
3. Show: left inbound, right Proposed cards, both colors on.
4. Pull-out: stayAsks + needed request; occupancy still weak until Luna+PDF.
5. Backtest: overlay live, 1069 index.
6. PMS-shaped responses: Staff did = gold `usedResult` only.
