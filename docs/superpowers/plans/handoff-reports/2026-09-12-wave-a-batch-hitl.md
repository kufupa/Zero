# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A) — Wave-0 find depth  
**Status:** **DO NOT SIGN** — payload-completion reopen. Packaging videos exist but DoD-required sections still open (rates/folio/quote/group/traces/live A4/A10). Absence videos ≠ success. **Do not start Wave B.**

## Per-tool packaging checklist

| ID | Tool | Verdict | Packaging proof |
|---|---|---|---|
| A1 | `hms_read_reservation` | **PASS_CORE_STAY_VIDEO** (rates/policies/ops `SURFACE_UNPROVEN`) | video sha256 `3006269caa0a4a825ed0a4d8f9210181a71d5385ac679d9a376b557096c12e9a` / artifact `dcc31b08-150f-4944-9663-3b8083be2778` |
| A2 | `hms_read_folio` | **PASS_BALANCE_FROM_DETAIL_VIDEO** | video sha256 `3006269caa0a4a825ed0a4d8f9210181a71d5385ac679d9a376b557096c12e9a` / artifact `dcc31b08-150f-4944-9663-3b8083be2778` |
| A3 | `hms_list_documents` (Sent Email) | **PASS_SENT_EMAIL_SURFACE_VIDEO** | video sha256 `1af47ece76d6c5cddee0fe8c66905bbca1dfd1792458554691d265cdb28ed251`; PSSNEL.HDR ~28kB |
| A4 | `documents_read_existing` | **PASS_DOCUMENTS_READ_BYTE_DIGEST** | mailProof fixture sha256 `e6663aa42eba0668121e7f5b7b115bc30df8774f11d420dab75aa88b1ede10f4` |
| A5 | `hms_quote_stay` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | soft-overlay packaging videos ×5; OSRRAV stub vs PSSNEL OK |
| A6 | `hms_group_block_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | video sha256 `34df79f7ae98391975accc41a453463574a79d5859c1424a505411dfdc53e0d1`; early-open + harvest depth |
| A7 | `hms_event_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | same A6–A8 packaging video; Events label absent; OSEVT/OSEVNT HTTP 400 |
| A8 | `hms_company_account_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | same video; OSACBL/OSACCT 813B stub; OSCOMP HTTP 400 |
| A9 | `hms_read_notes_traces` | **PASS_RESERVATION_NOTES_VIDEO** | video sha256 `77900a5205bae2eb01aafdb96f63c7d9e92294aeb0afd1a8a8a684078f321063` / artifact `830432a2-cd7c-4115-b84d-fc0fcae601f5` |
| A10 | `property_read_knowledge` | **BLOCKED_KNOWLEDGE_CORPUS_ABSENT** | packaging knowledge-source hunt (`mailProof.v1.json`); no `property-knowledge-file/v1` on EC2 |
| A11 | `mail_parse_channel_payload` | **PASS_MAIL_CHANNEL_FW_PACKAGING** | mailProof fixture sha256 `20ae5c78d83aa4f77926c8ada270ebf33e08fe5d321ce6e225dee39d2f4b52f9` |

Private evidence root: `.private/wave-a-20260912/`

## Honest terminals (BLOCKED)

- **A5:** soft-overlay quote packaging attempted; OSRRAV remains 813B stub while PSSNEL opens ~28kB on same credential → entitlement gap, not probe order alone.
- **A6–A8:** BSSTRT warm + module sweep + early-open-before-menu-clicks + packaging video. Group Sales/Profiles visible; Events/Company/Allotment/Banquet absent. Harvested 24 OS* codes with **zero** group/event codes; guessed opens HTTP 400; account codes 813B stub. Control OSRESS 34kB proves session.
- **A10:** Wave-0-depth SSM hunt — mailbox/thread corpora exist; no owner-approved property knowledge corpus bound.

## Safety

- Soft overlays + SSM only; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest
- No secrets/PII in Git/SSM stdout
- **Wave B not started**

## Human ask

Batch-watch PASS videos + skim BLOCKED RCA digests. Sign Wave A only if packaging proofs match table. After sign-off, Wave B may start.
