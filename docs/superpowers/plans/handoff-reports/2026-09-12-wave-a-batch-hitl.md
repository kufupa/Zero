# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-13 (completion audit)  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** PAYLOAD completion; packaging alone ≠ done  
**Status:** Autonomous escalation **exhausted**. Tools are PASS **or** TRUE EXTERNAL_ROLE_GATE.  
**HITL:** Do **not** invent green PASS on gated sections. Human **accept EXTERNAL_ROLE_GATE packets** (or grant entitlements and reopen). **Do not start Wave B.**

## Payload board (authoritative)

| ID | Tool | Payload | Packaging |
|---|---|---|---|
| A1 | `hms_read_reservation` | core/stay/policies PASS; rates summary PASS; nightly = **EXTERNAL_ROLE_GATE**; ops invent-forbid | video digest retained |
| A2 | `hms_read_folio` | **GREEN** balance+deposits+txn | video + payload |
| A3 | `hms_list_documents` | Sent Email + tax list **GREEN**; finalized Documents = **EXTERNAL_ROLE_GATE** | videos on EC2 |
| A4 | `documents_read_existing` | **GREEN live** mailbox digest | mailProof |
| A5 | `hms_quote_stay` | **GREEN** nightly 495 | videos verified sha256 |
| A6 | `hms_group_block_read` | **GREEN** GSGRPB.LST 50 | a678 video verified |
| A7 | `hms_event_read` | **EXTERNAL_ROLE_GATE** | packaging retained |
| A8 | `hms_company_account_read` | **GREEN** FSOGPF+BPF; trio invent-forbid | a678 video |
| A9 | `hms_read_notes_traces` | **GREEN** TRC+NOT | video |
| A10 | `property_read_knowledge` | **EXTERNAL_ROLE_GATE** | mailProof absent corpus |
| A11 | `mail_parse_channel_payload` | **GREEN** 3 channel fixtures | mailProof |

Audit: `.private/wave-a-20260912/COMPLETION-AUDIT.md`  
Ledger: `.private/wave-a-20260912/PROGRESS.md`

## EXTERNAL_ROLE_GATE packets (accept or grant)

1. A1 Rate Details — `a1-external-role-gate-rate-details/EXTERNAL_ROLE_GATE.md`
2. A3 Guest Stay Documents — `a3-external-role-gate-documents/EXTERNAL_ROLE_GATE.md`
3. A7 Events — `a7-external-role-gate/EXTERNAL_ROLE_GATE.md`
4. A10 Knowledge corpus — `a10-external-role-gate/EXTERNAL_ROLE_GATE.md`

## Safety

- Pilot-RDS: unset before Vitest; no pilot RDS tests
- No secrets/PII in Git/SSM/Exa
- Wave B not started

## Human ask

Accept the four EXTERNAL_ROLE_GATE packets as terminal for Wave A, **or** grant Rate Details / Documents / Events / corpus and ask agent to re-open soft-open.
