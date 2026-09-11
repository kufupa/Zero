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
| 5 | Dedupe | Multi-source: keep existing `catchup-gold-*` rows; skip PST twins via uidl + subject+minute (+ day+norm near-dup); prefer richer body only when upgrading an existing row |
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

| Source | Path | Size / count | Role |
|--------|------|-------------:|------|
| **Earlier Bongi zip** | [`.private/Nava.zip`](.private/Nava.zip) | 181MB / **362** `.msg` | Smaller Sent export (Jul 30–Sep 4) |
| Converted catchup | [`.private/both-outbound-emails-gold/`](.private/both-outbound-emails-gold/) | **328** eml / 362 msg | Already processed; README + indexes |
| Prior RDS ingest (2026-09-04) | `catchup-gold-*` on pilot | **308** stored (+20 content-dup) | Already in RDS; `skipAiEnqueue: true` at the time |
| **New PST backup** | [`.private/backup-zip-2026-09-10/`](.private/backup-zip-2026-09-10/) | ~6.3GiB PST / **1571** Aug–Sep Sent eml | Larger archive; desk + Nava AI Sent |
| Date window | — | `2026-08-01` … `2026-09-30` | Locked scope A |

Prior analysis (local only): `augsep-fp-*.json`, `augsep-vs-nava-catchup-overlap.json`, `augsep-overlap-richness.json`, `augsep-pst-only-vs-rds.json`.

## Multi-source duplicate map (measured)

| Bucket | Count | Meaning |
|--------|------:|---------|
| PST Aug–Sep Sent | **1571** | Ingest target universe |
| Nava.zip catchup eml | **328** (Aug–Sep ~299) | Earlier smaller set |
| Overlap PST ∩ catchup (`day`+norm subj) | **270** | Same mail, two extracts |
| PST-only (no catchup twin) | **1295** | New PST coverage |
| Of PST-only already in RDS (subj+minute) | **191** | Live/prior outbound dups |
| Of PST-only day-only near-dup | **59** | Exhaustive verdict below |
| → day-only **SKIP** | **24** | ≤20m clock skew + conf# empty-body twins |
| → day-only **STORE** | **35** | Generic/template subject collisions (not same mail) |
| Of PST-only **truly new** (pre bodyhash) | **1045** | +35 day-only STORE ≈ **1080** |
| TZ body-sha true-dup beyond minute | **4** | SKIP — already in RDS (±2h SA vs UTC) |
| Expected new stores (post skips) | **~1076** | Dry-run owns exact |
| Catchup already in RDS | **308** total / **279** Aug–Sep | Do not re-ingest |
| RDS Centurion outbound Aug–Sep now | **1069** | Baseline before PST complement |

### Day-only 59 + body-hash beyond minute (locked)

- Day-only verdict artifact: `.private/backup-zip-2026-09-10/augsep-dayonly-verdict.json` (24 SKIP / 35 STORE).
- Content-hash check (HTML-stripped): **301** sha hits without subj+minute — **296** confirmation-letter **template** collisions (must STORE); **4** true dups with ±3h TZ + same stem (must SKIP).
- Blind body-sha SKIP forbidden. Only the 4 fps below are extra SKIPs.
- Skip list: `.private/backup-zip-2026-09-10/augsep-tz-bodyhash-skip.json`

| fp | PST minute | Already in RDS (UTC minute) | Subject stem |
|----|------------|-----------------------------|--------------|
| `b92d86951a98` | 2026-09-02T10:35 | 08:35 / 08:45 | group offer_beal travel_collegiate (ref.3875054) |
| `f72cfa890dbd` | 2026-09-02T10:45 | 08:35 / 08:45 | same Beal Travel offer |
| `da1df70b917d` | 2026-09-02T11:07 | 08:35 / 08:45 | same Beal Travel offer |
| `82f249e7e17f` | 2026-08-27T15:03 | 13:03 | group offer_amazing africa amafrica tours |

### Richness on the 270 overlaps (evidence)

| Signal | Catchup (Nava.zip→eml) | PST twin | Winner |
|--------|------------------------|----------|--------|
| Real SMTP Message-ID | **0%** (100% synthetic `catchup-gold-…`) | **1.9%** real on overlap | PST rare win |
| File bytes larger | **87.8%** of pairs | 12.2% | Catchup usually |
| Prefer-score (MID≫att≫text≫bytes) | **179** | **23** (68 tie) | Catchup body/size |

**Claim check:** “earlier zip has more information” → **partly true for body/size**, **false for RFC Message-ID** (synthetics injected at convert/ingest). Prefer **keeping existing catchup rows**; do not blindly overwrite with PST.

## Architecture / flow

```
Sources: Nava.zip catchup (already in RDS) + PST Aug–Sep Sent eml
    → classify each PST eml: overlap | near-dup | truly-new
    → skip overlap/near-dup (keep catchup/live row); optional rare MID upgrade if PST has real MID + RDS synthetic
    → also SKIP day-only 24 + TZ bodyhash 4 (`augsep-tz-bodyhash-skip.json`)
    → ingest truly-new PST (~1076) as outbound (preserve real MID when present)
    → recomputeConversationLinksForTransport(transport-centurion)
    → re-enqueue inbound_triage on threads that gained new catchup/PST outbound + have inbound
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

Aug–Sep Sent visible in Nava Centurion with **no double-stored twins**; Nava.zip catchup rows kept; ~**1076** new PST-only rows stored (subject to dry-run; excludes day-only 24 + TZ bodyhash 4); links only via existing discovery; linked conversations re-triaged; dangerous over-link patterns remain blocked.
