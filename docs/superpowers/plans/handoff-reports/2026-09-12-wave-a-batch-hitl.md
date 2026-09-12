# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A) — Wave-0 find depth  
**Status:** **DO NOT SIGN** — underwork ×2 same day (skip packets, then soft-capture/`BLOCKED` without per-tool packaging videos)

**Stop:** Wave B **not** started. Do **not** offer this packet for sign-off until the video/mail checklist in the catalogue plan is green.

## Why DO NOT SIGN

1. First stop: skip JSON / DRAFT HITL without live Wave-0 packaging.
2. Second stop: soft-capture + `BLOCKED_*` / PARTIAL compare JSON treated as wave-complete HITL — still missing packaging videos for most tools (A2/A3/A5/A6–A8/A9 and incomplete A1).

Private work-in-progress root: `.private/wave-a-20260912/` — useful RCA, **not** HITL-ready evidence.

## Work remaining (binding)

See catalogue plan **Done criteria (autonomous Wave A) — REOPENED ×2**. Priority: A5 soft-overlay quote packaging → A3 Sent Email video → A2/A9 dedicated videos → A6–A8 code harvest + soft overlay → A1 remaining sections → A10/A11 mail proof.

## Interim matrix (progress only — not sign-off)

| ID | toolId | Interim | Gap vs Wave-0 HITL |
|---|---|---|---|
| A1 | `hms_read_reservation` | Production wire + partial soft packaging | rates/policies/ops unproven; video soft-incomplete |
| A2 | `hms_read_folio` | Balance from detail | **No dedicated packaging video** |
| A3 | `hms_list_documents` | PSSNEL.HDR structure proof | **No Sent Email driver→video** |
| A4 | `documents_read_existing` | Mail fixture units | Packaging-class mail proof |
| A5 | `hms_quote_stay` | Soft-capture ×4 → stub | **No soft-overlay packaging like A1** |
| A6–A8 | group/event/company | One menu probe | Code harvest + soft-overlay dumps missing |
| A9 | `hms_read_notes_traces` | Notes from detail | **No dedicated packaging video**; traces unproven |
| A10 | `property_read_knowledge` | Corpus absent this-wave | Exhaust corpus hunt or hard BLOCKED |
| A11 | `mail_parse_channel_payload` | Parser + units | Packaging-class mail proof |

## Safety

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest
- Soft overlays + SSM only; no pilot-RDS tests; no secrets/PII in Git/SSM stdout
- Wave B not started

## After true READY (future)

Only rewrite status to READY when every PASS/PARTIAL row has packaging video digests (or mail proof) and any BLOCKED row cites soft-overlay Wave-0-depth RCA.
