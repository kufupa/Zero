# Handoff — Lab HITL Proposed rail (loop 4 of ≤5)

**Date:** 2026-09-21  
**Branch:** `feat/centurion-dashboard-tools`  
**Status:** Loop 4 overlay live (`ClToOutK`). Dual-plane **401 / auth 1069**. Whole-product HITL. Greptile waived (no PR).

## Counts (no PII)

| Metric | Value |
|--------|------:|
| Lab rows | 1069 |
| With live Proposed | 656 |
| Empty skip | 413 |
| Find live | 490 |
| Read live | 483 |
| Notes live | 107 |
| Quote live | 281 |
| Quote document live | 100 |
| Email folio live | 40 |
| Folio live | 90 |
| Invoice live | 118 |
| Payment live | 114 |
| Proforma live | 114 |
| Send live | 157 |
| Attach live | 89 |
| Amend live | 93 |
| Create live | 66 |
| Cancel live | 90 |
| Company live | 50 |
| Event live | 54 |
| Group live | 163 |
| Occupancy adults filled | 228 |
| Staff-did usedResult nonempty | 82 |
| Live with empty Staff-did | 578 |
| `%PDF` soup | 0 |
| Unknown freeze tool | 0 |
| Year as roomQty | 0 |
| Mail lab Vitest | 20/20 |

## Schema-field table (ids frozen)

Same as loop 3. No freeze id add/remove. Occupancy fill is extract.

## Features added / removed

**Add**
- Proposed action cards (not stay chips).
- Per-inbound colors; Find/Read always-in-stack with writes; Notes when tools/staff/needed.
- Quote document + email folio from tools when freeze `needed` is 0.
- StaffUsed primaries stay **live** (not hidden in Already done). Staff-did = gold `usedResult` only.
- Occupancy from `N pax/singles/twins/doubles` and quote `roomQty`.
- Client always re-enriches so stale index still paints the stack.
- Skip empty: other-desk, or no_reply/channel-auto with no remaining write.
- Keyboard j/k, 1–4. Has Proposed / Skip. Staff-did missing copy.

**Remove**
- Stay chips. Schema JSON dump. One-pink-for-all. Fake occupancy. Fake PMS when gold missing. Public lab index. Noisy artifact/audit chips when a primary is live.

## Process

Inbound → PDF layout text → Luna JSONL → collate (refuse empty when write remains) → enrich → overlay private index + SPA. Dual-plane cookie GET.

## Show

Outlook-shaped Proposed rail. Input shows blanks. Staff-did quiet missing. Folded = superseded priors only. Attachment as card. Folder click keeps tool.

## Pull-out

Request fields + PDF/body pax. Never `%PDF` soup. Never year-as-qty.

## Backtest

Sep 9–18 window, 1069 inbounds, overlay on live `feat/outlook-setup-download-button`.

## PMS-shaped responses

Staff-did = gold `usedResult` only. 82 nonempty. 578 live with gap copy. No fake payload.

## Remaining by design (not 10/10 lies)

- Freeze `neededCount` untouched; quote-document needed stays 0 (cards from tools/staff).
- Attach/send from staffUsed/needed, not every tools[] hit.
- `hms_sent_email_audit` noisy.
- Occupancy 228 — only when file/body has pax or quote roomQty.
- Greptile: no PR on this branch → waived until PR exists.
