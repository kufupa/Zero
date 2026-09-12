# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A)  
**Status:** **DRAFT / INSUFFICIENT — DO NOT SIGN** (revoked 2026-09-12). Human correctly refused. Agent must re-run A2–A11 at Wave-0 quality; replace this packet when compare-green evidence exists.

**Stop:** Wave B not started.

## Human ask

**None yet.** This draft listed skip packets instead of live working tools. Ignore for promotion. Wait for a rewritten packet after Wave A repair.

Private skip index (operator box / worktree): `.private/wave-a-20260912/skips/index.v1.json`

## Tool matrix

| ID | toolId | Verdict | Evidence |
|---|---|---|---|
| A1 | `hms_read_reservation` | **PASS_CORE_STAY** | Live detail-dump `/tmp/nava-fast-find.AfL0kuXg` PROOF_EXIT=0; keys=122; fixture `evals/hms/osresv-detail.live-shape.v1.json` valid; artifact `6ad6ae09-e4b1-417e-91a1-7846af7fda2f` (video soft-incomplete kept); private compare `.private/wave-a-20260912/a1-packaging/compare.v1.json`. rates/policies/operations = `SURFACE_UNPROVEN`. |
| A2 | `hms_read_folio` | **BLOCKED_NO_FINANCE_ROLE_PROOF_V2** | Unit 48 green. RCA dossier. SSM 2026-09-12: role proof v1 `allowedSurfaces=['Guest Stay']`, `expiresAt=2026-08-12` **expired**, no role-proof v2 dirs. Skip: `skips/A2-hms_read_folio.skip.v1.json`. |
| A3 | `hms_list_documents` | **SURFACE_UNPROVEN** | `hms_finalized_document` sourceDefaultBlocker. Skip A3. |
| A3b | `documents_list_existing` | **PASS_MAIL_FIXTURE_UNIT** | existing-document-service 6 green; HMS finalized still SURFACE_UNPROVEN. Skip A3b. |
| A4 | `documents_read_existing` | **PASS_MAIL_FIXTURE_UNIT** | Same mail/DB unit; artifact format unsupported on U9. Skip A4. |
| A5 | `hms_quote_stay` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | Unit 28 green. Needs OSRRAV; EC2 role only Guest Stay + expired. CRS Check Availability denied. Skip A5. |
| A6 | `hms_group_block_read` | **BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN** | Unit 30 green fail-closed. Skip A6. |
| A7 | `hms_event_read` | **BLOCKED_EVENT_READ_SURFACE_UNPROVEN** | Unit 8 green. Skip A7. |
| A8 | `hms_company_account_read` | **BLOCKED_COMPANY_READ_SURFACE_UNPROVEN** | Unit 4 green. Skip A8. |
| A9 | `hms_read_notes_traces` | **SURFACE_UNPROVEN** | Driver stub returns SOURCE_UNAVAILABLE. Unit 1 green. Skip A9. |
| A10 | `property_read_knowledge` | **SURFACE_UNPROVEN_KNOWLEDGE_CORPUS** | Unit 35 green; no approved corpus bound. Skip A10. |
| A11 | `mail_parse_channel_payload` | **BLOCKED_STUB_ONLY** | Companion: stub/kickoff only. Skip A11. |

## A1 detail (promotion candidate)

### What passed
- Exact OSRESS search → Guest Stay detail open → sanitized key dump
- Policy: OSRESV.HDR `guestfullname`; detail toolbar chrome SVGs; detail-open rules; find stays search-only
- Projection: core+stay claimable; rates/policies/ops unavailable

### Commits
- `fa35c64f` detail-open OSRESV policy
- `c15b167b` guestfullname wire key
- `78b866c7` detail toolbar chrome
- `f4b6ab37` live-shape fixture

### Video / artifacts
- Artifact id: `6ad6ae09-e4b1-417e-91a1-7846af7fda2f`
- Attempt: `/tmp/nava-fast-find.AfL0kuXg` (EC2; may age out)
- Private compare: `.private/wave-a-20260912/a1-packaging/compare.v1.json`

## Unit gate summary (2026-09-12, `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`)
- folio + group + event + company + quote + notes: **119 passed**
- property-knowledge + existing-document + notes: **42 passed**

## Safety
- Overlay-only live proofs for A1; no pilot-RDS Vitest; no secrets/PII in Git/SSM stdout
- Cleared empty stale `.hms-live-operation.v2.lock` after A1
- Find Wave 0/0b HITL already human-passed; not re-opened

## After sign-off
- Wave B writes remain blocked until this packet is signed
- Refresh HMS role proof (v2) with finance + quote surfaces before retrying A2/A5 live packaging
- Promote A1 core/stay only; keep rates/policies/ops unavailable until dedicated dumps
- A9 needs real Notes/Traces tab driver (replace SOURCE_UNAVAILABLE stub)
- A11 needs channel_fw parser implementation before Wave A re-open
