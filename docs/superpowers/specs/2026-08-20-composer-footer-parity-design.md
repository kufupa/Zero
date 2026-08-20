# Composer Footer Parity and Disabled AI-Control Removal

## Status

Approved 2026-08-20.

## Goal

Make reply composer footer match new-message composer footer. Remove disabled AI compose affordances from new-message composer.

## Behavior

- New-message and reply composers share one left-aligned action sequence:
  `Send`, `Send later`, existing attachment/template controls, and formatting `T`.
- When that sequence does not fit, its shared action row wraps while preserving
  control order and reachability.
- Reply composer no longer renders separate right-aligned `Send`.
- New-message composer no longer renders:
  - subject-line AI sparkle control;
  - footer `Generate` control;
  - generated-content preview.
- Existing send, schedule, attachment, template, formatting, draft-save, close, and validation behavior stays unchanged.

## Implementation Boundary

- Change `apps/mail/components/create/email-composer.tsx` and focused UI-contract test coverage.
- Remove unreachable composer-side AI state, mutations, handlers, preview, and imports so lint has no dormant paths.
- Keep server-side AI procedures and unrelated AI features unchanged.
- Preserve draft persistence contract by providing `aiBlocked: false` where its existing input shape requires that field.

## Verification

- Add a focused source/UI contract confirming common footer order, absent right-side reply `Send`, and absent new-message AI controls.
- Run focused Vitest after clearing `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`.
- Run mail lint.
