# Handoff — Lab HITL Proposed rail (loop 2 of ≤5)

**Date:** 2026-09-21  
**Branch:** `feat/centurion-dashboard-tools`  
**Status:** Loop 2 overlay live. **Not 10/10.** Luna shards 1/2/6 still in flight (0,3,4,5 collated later). Goal remains open.

## Counts (no PII)

| Metric | Value |
|--------|------:|
| Lab rows | 1069 |
| With proposedActions length>0 | 610 |
| Explicit empty skip | 459 |
| Other-desk empties | 98 |
| no_reply empty but needed remaining | 0 |
| Multi-live | 303 |
| Find live | 110 |
| Read live | 107 |
| Quote live | 279 |
| Folio live | 43 |
| Event live | 42 |
| Staff-did usedResult nonempty | 82 |
| Live with empty Staff-did | 541 |
| `%PDF` soup | 0 |
| Unknown freeze tool | 0 |
| Year as roomQty | 0 |
| Mail lab Vitest | 19/19 |
| Dual-plane unauth | 401 / 401 |
| Private index rows on EC2 | 1069 |
| Public nginx index | **removed** (was leaked by SPA tar) |
| SPA `Already done` + `lab-span-action-0` | present (`CXqO28eI`) |
| index.html lab hash | false (lazy route; manifest has hash) |
| Luna extracts complete | 4/7 |

## Features added this loop

- Skip empty only for other-desk, or no_reply/channel-auto with **no remaining write**.
- Quote stack also emits Find/Read when needed/tools say so (quote still first).
- `needs_human` cards visible.
- Folded copy: **Already done** (not Already quoted).
- Kill Proposed-rail JSON dump (`ExtractBlock`).
- Gate `LAB_WRITE_PUBLIC_INDEX=1` so collate/span/needed scripts cannot dump PII into `apps/mail/public`.
- Luna prompt: write JSONL only, do not edit repo.

## Features still wrong / next loops

- Luna 1/2/6 not written; workers wander into source unless write-only prompt sticks.
- Folio/invoice/send/event still thin vs quote. 20-read samples in `.private/.../review/product-loop-2.json`.
- Staff-did empty on 541 live cards — gold `usedResult` sparse; do not fake.
- Auth 1069 cookie proof not re-run this loop (unauth 401 only).
- Extra hashed JS `Cl63s8m1.js` still on nginx (also has action marks).
- `hms_generate_quote_document` / `hms_email_folio` / `hms_sent_email_audit` withLive 0.

## Come-back so far

1. Features: stay chips gone; dump gone; remaining-write skip; Find/Read with quote; needs_human; public-index leak killed.
2. Schema fields unchanged (ids frozen).
3. Process: inbound → sanitize (remaining-write) → Luna (partial) → collate refuses Luna empty when write remains → rail.
4. Show: Proposed cards, both colors, Input + Staff-did, Already done.
5. Pull-out: stayAsks + needed; occupancy still weak until remaining Luna+PDF.
6. PMS-shaped: Staff-did = gold `usedResult` only (82 nonempty).
