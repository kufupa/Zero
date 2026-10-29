# Pomerado no-click mint: vendor examples

Date: 2026-10-28. Scope: read-only review of the local Pomerado checkout pinned at `7349a1c2`, for owner ask 350. No model, browser, mint, generated-tool execution or HMS access.

## Vendor pattern

The [getting-started example](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/getting-started.md#L152-L157) says: “Use Pomerado to create an integration named example_reader that reads the main heading from https://example.com. Keep it read-only.” Its native mint input is `name`, `url`, `intent`, `effect: read` and `input: {}`. The [schema](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-server.ts#L55-L69) requires the first four; input is optional. No public example is proposed to be run.

## What returns

- `mint` returns a job ID. `get_job` reports status, input requests and terminal build outcome; it is not a guaranteed transcript of the observed screen. [Example](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/getting-started.md#L160) and [implementation](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-server.ts#L196).
- A published tool run returns its schema-validated output. Run output is not secret-redacted. [README](https://github.com/Pomerado/pomerado/blob/7349a1c2/README.md#L148) and [runtime](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/how-it-works.md#L230). The owner explicitly permits screen contents in this chat, not disclosure of the supplied Pomerado API key or HMS credentials.
- An exploration receipt may support publication under specific conditions; it does not guarantee publication or screen text in the terminal outcome. [Receipt](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mint-execution.ts#L418) and [publication](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mint-publication.ts#L45).
- A fresh tool run starts in a fresh browser context at the site root; “current authenticated screen” is not a native durable session guarantee. The existing compiled Nava login hooks are a trial-specific adaptation and need actual native mint and replay proof. [Mint](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/how-it-works.md#L16) and [run](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/how-it-works.md#L230).
- A `read` effect and no-click intent do not technically enforce no clicks, no navigation or immediate stop. The Guardian accessibility capture can omit or truncate content. [Screen-capture evidence](2026-10-28-pomerado-early-screen-evidence.md).

## Existing compiled fresh-run hook

A separate read-only EC2 inspection found `source/dist/typescript/src/standalone/run-operation.js` calls `navaLogin` after `startPage` and refuses a request without the trial credential or with a non-read effect. The previously checked compiled mint host also calls that helper. These are source observations, not live mint or replay proof. No build, browser, model, credentials or HMS operation ran for this inspection.

## Recommended task intent

“Read the current authenticated screen. Return all visible text, labels, controls and displayed values in order. Do not click, type, navigate, search, save or change anything. If anything cannot be read, say so. Stop browser interaction once the screen is read.”

This is a current-screen checkpoint, not proof that Stay 360 is open or that a fresh context preserves the screen.
