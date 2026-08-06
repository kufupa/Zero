# Phase B live promotion — true blocker (2026-08-06)

`can_proceed_live=false`. Overnight cannot unblock without human.

## Evidence

| Check | Result |
|-------|--------|
| `ops-hms-proof.sh read-discovery` / `read-proof` | `PHASE_B_BLOCKED` (exit 3) — intentional latch |
| role-proof-v2 files in repo / EC2 | absent (schema only in `release-kernel.ts`) |
| `centurion.manifest.json` Folio / Sent Email / Tax Invoice / company / group / event | absent |
| Reviewed request manifests for Tasks 4–9 | absent |
| EC2 HMS credentials | present (`view_only`); **not** the blocker |
| Chromium on EC2 | present |

## Named blockers (accepted overnight)

Per-tool (fixture_verified, no live driver):

- `hms_quote_stay` — `BLOCKED_QUOTE_DISCOVERY_ROLE_PROOF_UNAVAILABLE`
- `hms_list_documents` / `hms_sent_email_audit` — role-proof-v2 + routes + positive controls
- `hms_read_folio` — `BLOCKED_NO_FINANCE_ROLE_PROOF_V2`, surface, manifest, discovery operator
- `hms_company_account_read` — `BLOCKED_COMPANY_READ_SURFACE_UNPROVEN` (+ role/manifest/discovery)
- `hms_group_block_read` — group-block surface / role / manifest / discovery
- `hms_event_read` — event list-summary surface / role / manifest / discovery

Cross-cutting: `OPS_PHASE_B_LATCH`, `ROLE_PROOF_V2_ABSENT`, `REVIEWED_REQUEST_MANIFEST_GAP`.

## What overnight must not do

- Invent live drivers or fake discovery digests
- Unlatch `PHASE_B_BLOCKED` without real role-proof-v2 + reviewed manifests
- Couple production active-read allowlist to fixture_verified tools

## Human next (wake)

1. Capture role-proof-v2 for each target surface (finance / groups / events as needed)
2. Abort-first discovery with reviewed request manifests
3. Then unlatch discovery CLI per tool and run registered-tool proofs
