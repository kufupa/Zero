# Quote pilot landing and remaining release work

## Landing scope

Land from `feat/reservationist-quote-integration`, not the divergent
`feat/reservationist-backtest` tree. At landing preparation, current upstream
main is `2e3f1b3f7386fb5d437832ec5aff9ca195eb6fae` and is an ancestor of the
integration branch. The native gitlink remains
`32738e4d1764340b66fce3cdfb3262d56614edb9` on both branches. Preserve main's
authorization, session revocation, mailbox isolation, history/admission and
read-root changes. Do not replay the earlier backend-only overlay wholesale.

The PR contains the existing staff-controlled quote UI, canonical approved-input
execution, selected evidence/revision pricing, PDF generation and unsent draft
integration, plus its public dependency closure and applicable regression tests.
Broader worker admission/parity and hosted-model extraction tests stay with their
unlanded implementations in the original source worktree; this is not a claim
that the full autonomous reservationist has shipped.

## Fresh pre-review checks

- Server `tsc --noEmit`: passed.
- Quote/PDF/source/business execution tests: 765 passed across 15 files.
- Quote/bridge/onboarding UI tests: 146 passed across eight files.
- Staff-approved quote route on a fresh migrated disposable PostgreSQL database:
  seven passed, including mailbox isolation, overlapping approvals, stale source,
  policy failure and source mutation during conversion. Native calls are mocked.
- Initial borrowed legacy-DB test attempt failed on missing schema columns; it
  was not credited. The replacement database is
  `reservationist_quote_landing_20261006` on the local test PostgreSQL container.
- Full current-main sync/security gate and actual frontend build are separate
  running checks; append their terminal outcomes and Greptile review IDs before
  merge. No production or PMS mutations have occurred during landing preparation.

## P0 release checklist after landing

1. Generate normal mail artifacts and obtain a passing actual application build;
   resolve relevant release diagnostics without deleting main functionality.
2. Apply integrated code and explicitly reviewed deployment configuration:
   trusted existing PMS owner/policy paths, full Chromium/LibreOffice converter,
   pinned browser dependency, and native quote request/proxy deadlines. Preserve
   the stable device wrapping key, native security restrictions and mailbox grants.
3. Verify the deployed staff path and Windows Classic Outlook: fresh approved
   quote, correct exact-money PDF, complete edited reply and exact PDF attached to
   an unsent draft. Do not infer Windows acceptance from browser or protocol tests.

Use main-derived branches/worktrees for follow-up release fixes; do not continue
deploying from the older backtest checkout. A merged PR is not deployed acceptance.

## Explicit pilot limitations and follow-ups

- Pane analysis currently reads email text and attachment metadata, not attachment
  contents. Automatic Luna PDF extraction is not connected. Staff inspect the
  named document and confirm requirements manually; metadata is never price or
  entitlement evidence. Reuse the existing authorized attachment/analysis path
  when connecting this feature, with a genuine PDF pane check.
- The actual three-room public native sample returned valid independent prices
  but `allocation.status = unknown`: all room options had `buildingCode = null`
  and the source did not establish a shared inventory-pool identity. This is a
  tested qualification gap, not a finding that stock is unavailable or arithmetic
  wrong. Combined quotations remain blocked until source qualification is fixed.
- Combined mixed-date proposals, broad corpus evaluation, full autonomous worker
  repair, booking writes and automatic sending are not this release's scope.
- Native 1.0.13 is documented as a candidate; verify the actual published/installed
  binary's exact SHA/hash rather than assuming a version label proves deployment.

For prior actual native/PDF/browser evidence and host procedure, see
`2026-10-06-staff-quote-pilot-verification.md` in this directory.
