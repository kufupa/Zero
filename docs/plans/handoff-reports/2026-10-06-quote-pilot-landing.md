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
- Actual production frontend and server builds passed. CI run 37467040118 passed
  the complete disposable-DB Outlook sync/security gate and server build, plus
  transactional Rocketseed regressions. Its autofix job failed at imported-code
  lint; the exact CI oxlint 1.6.0 command now passes locally without suppressions.
- Greptile CLI round 1: `8a25299a-a9e6-4bd4-a4dc-a53210fc5543`, reviewing
  `0a924c0c`. Four verified findings fixed: reset quote state on staff-session
  changes; invalidate late-analysis quote/PDF evidence with advancing revision;
  initialize draft artifact services before routes (production without real S3
  remains closed); update converter test for full Chromium/LibreOffice image.
- Focused review regressions: 55 UI tests passed (including same-message session
  changes and late analysis); server source/execution/draft/startup tests all
  passed (536 tests across eight files); updated converter assertion passed.
  A wider 150-test deployment run had 14 failures in inherited subprocess/AWS
  perimeter fixtures; these are not counted as passing or silently removed.
- No production or PMS mutations occurred during landing preparation.

## Final review corrections

- Greptile CLI round 2: `3e83b03f-d809-4d72-8189-8bb398492380`, reviewing
  `4f49324a`. Fixed uncertain native retries to freeze the reviewed reply and PDF
  together before revalidation; rejected imported/override offers from older
  staff approvals before and after conversion; normalized new controls to the
  repository's Tailwind v4 small-radius rule.
- Evaluated the GitHub review as well: reject ambiguous duplicate Message-IDs
  in analysis, source and choices lookups; revalidate pricing freshness after
  conversion; retain unchanged running steps during delayed analysis. Changed
  analysis explicitly invalidates downstream state instead.
- Fresh final focused UI verification: 69 passed across session/panel/PDF files,
  plus all 30 pane regressions. The genuine 257-admission overflow scenario now
  uses the approved quote/PDF path; its measured 174-second test needs a
  180-second bound rather than the obsolete 90-second demo-path bound. Its
  production limits and assertions are unchanged.
- Fresh real-route disposable-DB verification: nine passed, including repeated
  Message-ID rejection and expiry during conversion; no live PMS calls.
- Fresh exact CI lint: zero warnings/errors. Server typecheck passed before the
  last small test/revalidation updates; final CI and follow-up typecheck govern
  merge readiness. No blanket lint suppressions or skipped failing tests.

## P0 release checklist after landing

PR #29 merged at `e593ea7557719fba519643e265a8e85bea0436a5` on
2026-10-06 13:24:42 UTC. CI run `37469771103` passed autofix (lint, both builds,
pane/native/security regressions), transactional mail, and the required migrated
disposable-DB Outlook sync gate. GitHub Greptile and Vercel preview checks passed.
Both local and upstream main include the quote integration and unchanged native
gitlink. Original dirty backend/UI worktrees are preserved.

Release follow-up starts on `fix/quote-pilot-release`, derived from this main.
It removes a duplicated catch-up env key that made strict remote-env parsing
reject deployment, supplies omitted remote-readiness fixture inputs, and updates
the documented readiness command. It also distinguishes read-only revalidation
failure (current review can be updated) from uncertain submitted CREATE retries
(original exact reply/PDF must be retained), resolving the final review tension.
No additional CLI review loop or broad corpus replay is required for these
focused corrections.

Read-only deployment inspection confirmed current EC2 is still on main's earlier
security commit `2e3f1b3f`; its existing borrowed Chromium owner listens on
loopback `19223` with Playwright 1.63/Stagehand 4.1 already installed in the
older SDK directory. The repository-relative pinned dependency, staff descriptor,
policy documents and sandbox image are not installed at the expected paths.
The converter is still the LibreOffice-only image. These are real deployment
prerequisites, not assertions that the quote tools failed. The selected mailbox
`transport-centurion` exists in production.

Fresh release follow-up verification: 150/150 deployment tests passed, 14/14
focused pane/PDF/visual-markup tests passed, shell syntax passed, and exact CI
lint reported zero warnings/errors. The two remaining inherited fixture failures
were traced: an obsolete literal readiness-command path (actual script uses
`SCRIPT_DIR`), and killed Linux orphan zombies reported alive by `kill(pid, 0)`.
The test now treats zombies as terminated while retaining the delayed no-write
assertion; production process-kill behavior is unchanged. The rendered narrow
pane fixture was regenerated by its existing test.

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
