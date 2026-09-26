# Handoff — fast live find-reservation video (2026-09-11)

## Outcome
Live `hms_find_reservation` proof completed with real Playwright PMS video under soft-trace mode.

- `PROOF_EXIT=0`
- `PHASE_A_PROOF_READY`
- Soft finalize kept playable `video.webm` when sanitized trace ZIP was skipped
- Private evidence path (not in git): `.private/hms-find-reservation-live-20260911/evidence-20260911-run5/`

## Digests (safe)
- artifactId: `61ef089a-a4ae-47c4-9506-93a35d19fd9f`
- video bytes: `811742`
- video sha256: `83fcf643865500970b51e8e2e0ee8291d5ec57b0a168a20812bd73c57b93e2f9`
- sourceRevision: `phase-a-62169b437b49-e8fc7ce7b015a700`
- toolId: `hms_find_reservation` / toolVersion `1.2.0`

## Comparison (non-PII)
- Source: mail-derived exact reservation candidate
- PMS: live Guest Stay `OSRESS.search` returned correlated match (`HAS_PAGEDATA` 1345 bytes)
- Gate: soft video receipt (`operationOutcome=succeeded`, terminal soft-incomplete)

## Divergences
- Intentionally skipped Playwright sanitized trace ZIP (`HMS_PROOF_SOFT_TRACE_FINALIZE=1`)
- Video is acceptance artifact for this run

## Do not
- Commit `.private/` video or result sidecars
- Treat soft-incomplete as production Wave A hardening complete without follow-up
