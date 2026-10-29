# Pomerado .477 runtime diagnosis

2026-10-28. Source-only investigation following native read-only job
`bdf9727f-e990-43ae-9a44-0abc0e42fd00`, which failed after 29.401 seconds with
`execution_failed`. No arrival, failing browser step, or runtime trace was
returned. The initial source-only investigation made no additional live run.

## Evidence

- The published integration runs as its own MCP server. The installed
  `dist/typescript/src/standalone/run-operation.js` says runs make no model or
  Guardian request; those are used during minting.
- The runtime's `run-operation.js` performs its sign-in step and calls `startPage` with
  `siteData: keep`. `dist/typescript/src/runtime/start-state.js` replaces the
  document with an inert same-origin page and loads the site's root; retaining
  storage does not retain document-bound state.
- The first automatic hook in `standalone/session-sign-in.js` returns
  `signed_in` without checking the page. Later `ensureSignedIn` calls can
  check and replay sign-in, but the generated `src/tool.mjs` calls none. It
  initially waits for the HRCEN property button.
- An earlier, separate Centurion diagnostic observed a login form after root
  navigation: [previous evidence](2026-10-28-codex-pomerado-centurion-read.md).
  This makes lost session continuity a plausible lead, not proof about the
  newer failed call. `standalone/run-report.js` maps several pre-operation and
  operation failures to a generic outcome, so other causes remain possible.
- The installed package's `README.md`, lines 157–173, distinguishes the
  self-hosted core from Pomerado Cloud's advertised automatic breakage detection
  and repair. `standalone/failure-text.js` says the local host repairs nothing.
  The installed README does not describe Cloud's repair sequence.

## Owner-authorized diagnostic

The owner explicitly permitted one read-only diagnostic repeat of the same
lookup. Job `19b36d98-0e71-4347-88e9-57b632ecc877` failed after 32.291 seconds
with the same public `execution_failed` outcome. A Node inspector breakpoint in
the unmodified stock host captured the failure before the local outcome mapper
discarded it: `LocalOperationFailure`, `BrowserActionTimeout`, `locator.waitFor`,
15,000 ms, and the property-button selector. The authored frame points to the
operation's wrapper at `src/tool.mjs:148`; its first wait is at lines 49–50.
The code would search the confirmation only after that wait, so this diagnostic
never searched for the reservation and produced no arrival.

The host attempted the recorded native sign-in, then reset the page and
started the operation. The login prompt did not allow saving. The captured
error does not show which page was displayed, whether login succeeded before
the reset, or why the property button was absent. A signed-out page, a wrong
root page and a changed selector remain possible. The original failed job had
no retained browser trace, so the exact failed step of that earlier call is
not directly established by this repeat.

The diagnostic held the two HRCEN tenant/property advisory keys derived from
the current app and staff-quote configurations. Its guard checked the live
connection and configuration; a local watchdog was configured to stop the owned
tool on guard loss. The existing hotel slot stayed running. Guard cleanup
reported both locks released and the owned diagnostic client exited. No
credentials are included in this note.

## Next acceptance and hold

Determine the page state and why its property control was absent, then obtain a
current exact-match arrival before claiming the published integration works.
Both failed jobs said `retry: never`; the single new diagnostic was explicitly
authorized. Any further live HMS operation requires the HRCEN property lock.
Do not use the earlier screen as proof of this published tool's result.
