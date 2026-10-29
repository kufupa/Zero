# Earliest Pomerado screen evidence

Date: 2026-10-28. Scope: read-only review of Pomerado source pinned at `7349a1c2`, for owner ask 349. No browser, model, HMS, tests or live mint. The EC2 overlay was not independently checked for this question.

## Findings

- The native controller exposes job status and input requests while a mint runs. Source does not establish an independently readable native screen result before the terminal outcome. [Native job source](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-jobs.ts#L132-L157).
- `captures/current-page.aria.yml` is a virtual Guardian-readable map entry populated from in-memory observation. Its name does not prove an on-disk file. [Observation and map](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/request-context.ts#L281-L282), [capture map](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/request-context.ts#L379-L383), [observe](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/request-context.ts#L555-L593).
- The capture is accessibility text, not a screenshot. It is capped at 256 KiB, skips pages above 10,000 elements and can time out; it does not by itself prove every visible value. [Capture source](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/request-context.ts#L187-L234).
- Observation follows an authored live step that can already contain multiple actions. Therefore a later status check cannot establish an immediate action stop. [Execution order](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mint-execution.ts#L578-L633).
- Native cancellation interrupts the job and can remove its reserved unpublished artifact; it is not a reliable capture method. [Cancellation](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-jobs.ts#L430-L441) and [cleanup](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/standalone/mcp-package.ts#L65-L75).

Known secret redaction does not establish removal of guest details. Any actual output stays in the approved private worktree. A terminal outcome can screen details, as the [login-first retro](../context/ledger/2026-10-27-pomerado-login-first-retro.md) records, so neither an early capture nor complete terminal output is guaranteed.
