# Codex Pomerado Centurion read and session reset

2026-10-28. The owner authorized a native self-hosted Pomerado read for one
specific real Centurion reservation, then directed this run to proceed without
the earlier browser-lock integration. No guest write was authorized.

## Observed

- This Codex's Pomerado server accepted a `read` mint and the native credential
  prompt. A captured execution showed the requested exact confirmation in the
  Stay 360 heading and returned its visible fields and nightly rows. The private
  readout and underlying observation are in
  `.private/pomerado-readstay/codex-centurion-20261028/`.
- The terminal mint result was `completed` with `build: incomplete` and a
  session-not-kept explanation. The integration directory did not exist after
  the job. A screen read is not publication or a fresh reusable-tool replay.
- In a separate browser diagnostic, an authenticated HRCEN shell was observed.
  The site's root reset led to a visible login form. In another fresh login,
  reloading the authenticated page also led to a visible login form. These
  observations show the pages seen after navigation, not whether the server
  invalidated every session cookie.
- Pomerado's `makeBuildStart` reloads the site root before an example or live
  test; its `runOperation` also loads the site root after sign-in. This is a
  credible explanation for the reported failure, but the exact internal
  transition in the mint was not captured. Runtime and mint changes require
  separate verification; changing the generated prompt alone cannot remove a
  host-controlled reset.
- No active headless Chrome process was observed after the owned jobs finished.
  No browser was running on the product host at the preflight; no lock was held
  for this owner-directed attempt, so exclusive access was not guaranteed.

## Next acceptance check and hold

The owner asked to pause. Do not start another mint until resumed. On resume,
investigate a scoped way to keep the authenticated tab during mint tests and
fresh tool runs, while preserving Pomerado's Guardian and read-only boundary.
An attempted fix is not proved until a new integration publishes and a fresh
execution returns the same exact reservation with its captured fields. Register
its own MCP server only after source review; a Codex reload is then needed.

Sources: `/home/orca/pomerado/typescript/src/standalone/mint-state.ts`,
`/home/orca/pomerado/typescript/src/standalone/run-operation.ts`,
`/home/orca/pomerado/README.md`, and
`docs/plans/2026-10-28-003-feat-pomerado-centurion-read.md`.
