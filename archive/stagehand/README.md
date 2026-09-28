# Historical Archive: Stagehand Read-Tool Spike

> [!WARNING]
> **DO NOT USE OR IMPORT CODE FROM THIS DIRECTORY.**
> This directory is a preserved historical archive of the early Stagehand spike (September 2026). It has been completely superseded by the native, deterministic Playwright tools in `apps/server-pilot/tooling/playwright-quote/`.

## Why this exists
In mid-September 2026, an exploratory spike tested whether Stagehand (AI browser agent) could navigate Infor HMS and extract quotes. While useful for initial element discovery, Stagehand proved too slow, unpredictable, and heavyweight for production PMS automation.

The production-grade approach is **native Playwright** (`apps/server-pilot/tooling/playwright-quote/`), which:
1. Operates deterministically without runtime LLM dependencies.
2. Directs the browser via exact ExtJS / CDP bindings in under 50 seconds.
3. Produces auditable video, trace, and screenshot bundles.

## What is in this archive
- `tooling/`: Early Stagehand prototype for `fetch-quote`.
- `scripts/`: Diagnostic and observe scripts from the Stagehand trial.
- `src/`: Early HMS Stagehand adapters and capture persistence.
- `tests/`: Vitest specifications for the Stagehand adapters.
- `docs/`: Superseded planning documents (`2026-09-16-001` and `2026-09-17-001`).

*Note:* `apps/server-pilot/tooling/stagehand/package.json` remains in place only as the pinned dependency container for Playwright 1.63.0.
