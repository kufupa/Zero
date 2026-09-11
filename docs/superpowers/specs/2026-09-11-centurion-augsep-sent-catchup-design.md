# Centurion Aug–Sep Sent catchup (ingest + link + re-triage)

**Date:** 2026-09-11  
**Status:** Approved (brainstorm)  
**Module:** `apps/server-pilot` Centurion mail ingest, conversation links, triage enqueue

## Goal

Copy **all Aug–Sep 2026 Sent** mail from the Outlook PST extract into Centurion RDS so Nava has archive parity for that window, then attach messages to conversations using **existing** hardened link discovery (not loose subject matching), then **re-enqueue inbound triage** on threads that gained a catchup outbound.

## Decisions (locked)

| # | Topic | Choice |
|---|-------|--------|
| 1 | Scope | Aug–Sep 2026 Sent only (~1571 eml: desk Sent + `Nava AI - SENT`) |
| 2 | Ingest filter | **All** of them (no true-positive filter on store) |
| 3 | Direction / transport | `outbound` / `transport-centurion` |
| 4 | Message-ID | Preserve real header when present; stable synthetic only when missing |
| 5 | Dedupe | Skip existing catchup uidl; skip outbound subject+minute content dup |
| 6 | Thread matching | After ingest: `recomputeConversationLinksForTransport` with **current** gates |
| 7 | Soft subject / staff-only | Still stored; linked only if current `subject_cluster` gates pass |
| 8 | AI / triage | After ingest + link: re-enqueue `inbound_triage` on threads that gained catchup outbound |
| 9 | Singleton outbound | Store; no triage |
| 10 | Template / mega-cluster gates | Stay tight (no loosening) |
| 11 | Out of scope | Full PST, Inbox, other months, Graph/conversationId recreation |
| 12 | Safety | EC2 ingest only; no Vitest against pilot RDS; no mail bodies in git |

## Context (why this shape)

- Desk Sent is POP3/SMTP local copies: usually **no** `Message-ID` / `In-Reply-To`. That is source-normal, not extract failure.
- Nava AI Sent often **has** real SMTP Message-IDs — must not overwrite them.
- Exhaustive FP dry-runs showed raw subject “hits” (~89%) over-claim; gated “safe” (~54%) still mostly **staff-only** participant overlap (`centurion@`), not guest identity. High-confidence cross-thread identity is conf# / guest email / external participant (~11–17%).
- Prior precision work already hardened subject_cluster, template reject, mega-cluster, and weak component size. Migration must **reuse** that, not bypass it.
- Product rule: `persistInboundMessage` enqueues `inbound_triage` only for **non–hotel-sent** messages. Catchup Sent is outbound, so `skipAiEnqueue: false` alone does not triage them. Re-triage the **affected inbound threads** instead.

## Source artifacts

- Extract root: `.private/backup-zip-2026-09-10/eml-full/` (local; not committed)
- Date window: `2026-08-01` … `2026-09-30` (inclusive), folders under Sent Items
- Prior analysis (local only): `augsep-fp-audit.json`, `augsep-fp-deep.json`, `augsep-fp-external.json`, `augsep-fp-deeper-report.json`

## Architecture / flow

```
Aug–Sep Sent .eml
    → selective catchup ingest (preserve MID; outbound; dedupe)
    → message rows in RDS (each gets resolveThreadId at persist)
    → recomputeConversationLinksForTransport(transport-centurion)
    → collect thread_ids that contain new catchup outbound and ≥1 inbound
    → enqueueAiRun(inbound_triage) once per such thread
    → verify counts + spot-checks
```

### Units

1. **Ingest runner** (script evolution of `ingest-centurion-catchup-gold.ts` or successor)
   - Input: directory + optional manifest of Aug–Sep Sent eml
   - Output: stored / dup / quarantined / error counts
   - Must set `messageIdHeader` from parsed MIME when present; only synthesize when absent
   - Must not use the current catchup path that always forces `catchup-gold-…@catchup…` over a real MID

2. **Link recompute**
   - Call existing `recomputeConversationLinksForTransport`
   - No new link types; no temporary gate relaxation

3. **Re-triage enqueue**
   - Conversation links are an overlay (`mail_conversation_link`); they do **not** rewrite `thread_id`. Re-triage therefore targets **inbound-bearing** threads the UI would treat as the conversation:
     1. Any `thread_id` that contains ≥1 newly stored catchup outbound **and** ≥1 inbound message, and/or
     2. Any inbound `thread_id` with an **active** conversation link to a thread that contains a newly stored catchup outbound
   - Enqueue `inbound_triage` once per such inbound-bearing thread
   - Idempotency key: `inbound-triage:catchup-augsep-2026:<threadId>` (or equivalent stable batch+thread key)
   - Skip outbound-only threads

## Data rules

| Field | Rule |
|-------|------|
| `direction` | `outbound` |
| `transport_id` | `transport-centurion` |
| `pop3_uidl` | `catchup-gold-<fp>` (or successor prefix if renamed; must not collide with live POP3) |
| `message_id_header` | Real MIME Message-ID if present; else stable synthetic unique per fp |
| `from_address` | Normalize to `centurion@legacyhotels.co.za` when hotel-sent heuristics require it (existing catchup behavior OK) |
| `sent_at` / `received_at` | From eml Date |

## Error handling

- Per-file errors: count + list; continue batch
- Quarantine: follow existing persist quarantine paths
- Dry-run first: scanned / would-store / would-dup; no writes
- Batch writes; stop on systemic failure (DB/S3 down)

## Verification

| Check | Pass criterion |
|-------|----------------|
| Store completeness | scanned ≈ Aug–Sep Sent count; stored + dups ≈ scanned (minus hard errors) |
| MID integrity | Nava AI Sent rows retain non-catchup Message-IDs when eml had them |
| Link precision | Spot-check conf# / guest links land on expected threads; `handover` / Nedbank / generic quotation norms not mega-merged |
| Triage | Affected linked threads get a new/queued `inbound_triage` run; pure outbound singletons do not |
| Safety | No Vitest with pilot `DATABASE_URL`; no PII mail committed |

## Out of scope

- Ingesting full PST / Inbox / other months
- Loosening conversation-link gates to raise merge rate
- Claiming Outlook-identical threading for POP3 Sent without RFC headers
- Changing triage prompts or adding an outbound-trigger run kind
- Committing `.private/` mail extracts

## Risks / honest outcome

- Many desk Sent will remain outbound-only or weakly linked: source limitation, not ingest failure.
- Staff-only subject overlap will still produce some subject_cluster edges under current prod rules; that is accepted for this migration (gates stay as-is).
- Re-triage volume scales with linked threads (hundreds possible), not full 1571.

## Success

Aug–Sep Sent visible in Nava Centurion; links only via existing discovery; linked conversations re-triaged; dangerous over-link patterns remain blocked.
