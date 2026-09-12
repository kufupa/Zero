# Wave A batch HITL packet — Centurion PMS remaining reads (Wave-0 grade)

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A) — Wave-0 quality bar  
**Status:** **READY FOR HUMAN SIGN-OFF** (replaces DRAFT / DO-NOT-SIGN skip-packet packet)

**Stop:** Wave B **not** started.

## Human ask

Review video/mail/compare evidence below. Sign only if you accept Wave-0-grade PASS/BLOCKED rows. Do **not** treat `.private/wave-a-20260912/skips/*` as evidence.

Private packaging root: `.private/wave-a-20260912/`

## Tool matrix (this-wave evidence only)

| ID | toolId | Verdict | Evidence |
|---|---|---|---|
| A1 | `hms_read_reservation` | **PASS_CORE_STAY** | Production `readContext` wired to detail dump (not grid fake-available). Live dump attempt `/tmp/nava-fast-find.AfL0kuXg`; artifact `6ad6ae09-e4b1-417e-91a1-7846af7fda2f`; fixture `evals/hms/osresv-detail.live-shape.v1.json`; compare `.private/wave-a-20260912/a1-packaging/compare.v1.json`. rates/policies/operations = `SURFACE_UNPROVEN` until Rate Details dump. |
| A2 | `hms_read_folio` | **PASS_BALANCE_FROM_DETAIL** | Live detail keys `balance`/`balancecurr` → folio projection + worker wire. Compare `.private/wave-a-20260912/a2-packaging/compare.v1.json`. deposits/transactions = `SURFACE_UNPROVEN`. |
| A3 | `hms_list_documents` | **PASS_SENT_EMAIL_SURFACE_PARTIAL** | This-wave `PSSNEL.HDR` open returns Sent Email grid/toolbar structure (~28kB). Tax Invoice menu still absent. `hms_finalized_document` = `SURFACE_UNPROVEN`. Compare `.private/wave-a-20260912/a3a4-packaging/compare.v1.json` + `pssnel-hdr-structure.sanitized.v1.json`. |
| A3b | `documents_list_existing` | **PASS_MAIL_FIXTURE_UNIT** | `tests/existing-document-service.test.ts` 6/6 green (`unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`). |
| A4 | `documents_read_existing` | **PASS_MAIL_FIXTURE_UNIT** | Same mail fixture units; artifact format remains unsupported on U9 path. HMS finalized unproven. |
| A5 | `hms_quote_stay` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | This-wave soft-capture ×4: Room Type and Rate Availability label **absent**; credentialed OSRRAV open = 813B stub (`ewslanguage`/`tenant`); CRS soft-aborted/denied. Fresh role-proof v1 = Guest Stay only (expires 2026-09-17) — did **not** falsely mint OSRRAV. Compare `.private/wave-a-20260912/a5-packaging/compare.v1.json`. RCA dossier updated. |
| A6 | `hms_group_block_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | This-wave menu probe: Group Sales visible; OSGRP/OSGBLK/OSALLT open → HTTP 400. Compare `.private/wave-a-20260912/a678-packaging/compare.v1.json`. |
| A7 | `hms_event_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | Events label absent; OSEVT/OSBEO → HTTP 400. Same a678 packaging. |
| A8 | `hms_company_account_read` | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** | Company label absent; OSACCT → stub shell; ARACCT/OSCOMP → 400. Same a678 packaging. |
| A9 | `hms_read_notes_traces` | **PASS_RESERVATION_NOTES_PARTIAL** | Live detail `reservationnote`/`cancellationnote` projection + worker wire. Traces tab = `SURFACE_UNPROVEN`. Compare `.private/wave-a-20260912/a9-packaging/compare.v1.json`. |
| A10 | `property_read_knowledge` | **BLOCKED_KNOWLEDGE_CORPUS_ABSENT** | Unit 35 green. Agent search this-wave: no approved corpus under `/etc/nava` / `/opt/nava/shared`; no KNOWLEDGE/CORPUS env keys; only synthetic test fixture. Compare `.private/wave-a-20260912/a10-packaging/compare.v1.json`. |
| A11 | `mail_parse_channel_payload` | **PASS_MAIL_CHANNEL_FW** | Implemented parser + contract; 7/7 unit tests; synthetic WebBeds fixture compare all-required-pass. Commit `9db5165d`. Packaging `.private/wave-a-20260912/a11-packaging/compare.v1.json`. |

## Commits (Wave A repair, newest first)

- `7afadbb3` A6–A8 soft menu probe script
- `9db5165d` A11 channel_fw parser
- `b6610791` A5 soft-capture deepen + RCA schema-valid dossiers
- `5ca10eb5` / `b4397a37` A2 folio balance from detail
- `7977c685` A9 reservation notes from detail
- `440fdab6` A1 detailDump → production readContext
- `752e0336` reopen mandate + DO-NOT-SIGN (superseded by this packet)

## Role-proof (agent-owned)

- Fresh v1 proofs on EC2 (Guest Stay only) through ~2026-09-17; default `hms-read-role-proof.v1.json` still expired.
- Soft overlay path used for Guest Stay dumps (A1/A2/A9).
- No role-proof v2 dirs found. Surfaces not live-available were **not** written into role-proof.

## Safety

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest
- Soft overlays + SSM only; no pilot-RDS tests; no secrets/PII in Git/SSM stdout
- Wave B not started

## After sign-off

- Promote only PASS rows as stated; keep `SURFACE_UNPROVEN` subsections unavailable
- Entitlement work outside this packet: OSRRAV, Tax Invoice, Group/Event/Company forms, approved property knowledge corpus, Rate Details / deposit ledger / traces tabs
- Wave B waits for human sign-off of this packet
