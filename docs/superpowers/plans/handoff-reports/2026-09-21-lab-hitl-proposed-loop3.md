# Handoff — Lab HITL Proposed rail (loop 3 of ≤5)

**Date:** 2026-09-21  
**Branch:** `feat/centurion-dashboard-tools`  
**Status:** Loop 3 overlay live. Dual-plane **401 / auth 1069**. **Not 10/10** (company staffUsed still thin). Goal open.

## Counts (no PII)

| Metric | Value |
|--------|------:|
| Lab rows | 1069 |
| With live Proposed | 574 |
| Empty skip | 495 |
| Multi-live | (index) |
| Find live | 368 |
| Read live | 351 |
| Notes live | 44 |
| Quote live | 176 |
| Quote document live | 70 |
| Email folio live | 29 |
| Folio live | 68 |
| Invoice live | 78 |
| Proforma live | 98 |
| Event live | 36 |
| Group live | 118 |
| Occupancy adults filled | 227 |
| Staff-did usedResult nonempty | 82 |
| Live with empty Staff-did | 532 |
| `%PDF` soup | 0 |
| Unknown freeze tool | 0 |
| Year as roomQty | 0 |
| Mail lab Vitest | 20/20 |

## Schema-field table (ids frozen)

| Tool | Input | Output |
|------|-------|--------|
| Find | confirmationNumber, guestName, arrival, departure | confirmationNumber, status, roomType |
| Read | confirmationNumber | confirmationNumber, guestName, arrival, departure, adults, children, occupancy, roomQty, roomType, rateCode, status, groupName |
| Notes | confirmationNumber, guestName | guestName, status |
| Quote stay | arrival, departure, adults, children, occupancy, roomQty, roomType, rateCode | arrival, departure, roomType, rateCode, rateQuoted, amount, occupancy, status |
| Quote document | arrival, departure, roomType, occupancy, docType | arrival, departure, roomType, rateQuoted, amount, occupancy, docType |
| Folio | confirmationNumber | amount, status, confirmationNumber, docType |
| Email folio | confirmationNumber, amount, docType | amount, docType, confirmationNumber, status |
| Amend | confirmationNumber, arrival, departure, adults, children, occupancy, roomQty, roomType, rateCode | confirmationNumber, status, arrival, departure, roomType |
| Create | guestName, arrival, departure, adults, children, occupancy, roomQty, roomType, rateCode | confirmationNumber, guestName, arrival, departure, status, roomType |
| Cancel | confirmationNumber, cancelReason | confirmationNumber, cancelReason, amount, status |

No freeze **id** add/remove. Occupancy fill is extract, not schema rewrite.

## Features added this loop

- Client always `enrichHitlProposed` (stale index still gets Find/Read + companions).
- Quote document + email folio cards from `tools`/`staffUsed` when freeze `needed` is always false.
- Notes join write stack when tools/staff/needed say so.
- Occupancy from `N singles/twins/doubles` and quote `roomQty` when adults blank.
- Unused `rowHasLiveProposed` import dropped.

## Features still wrong / next loops

- Company live 9 vs staffUsed 44 — loop 4 staffUsed primaries.
- Attach/send live thin vs tools (intentional; do not over-chip 374 attach).
- `hms_sent_email_audit` live 0 (noisy when primary exists).
- Company live 9 / 148 folder n.
- Staff-did empty on 532 live — gold `usedResult` sparse; do not fake.
- Dual-plane unauth 401/401; auth 1069 on admin nginx, hotel nginx, :8788, :8789.
- Public nginx index false. SPA `B2gUMiwk`. Live git `feat/outlook-setup-download-button`.

## Come-back so far

1. Features: companions despite needed=0; client enrich; occupancy singles; Find/Read/Notes stack.
2. Schema fields unchanged.
3. Process: inbound → Luna → collate → enrich (companions + occupancy) → rail.
4. Show: Proposed cards; Input blanks; Staff-did missing copy; Already done.
5. Pull-out: adults 227; PDF never soup.
6. PMS-shaped: Staff-did = gold `usedResult` only (82 nonempty).
