# Stagehand for Infor HMS — decision (2026-10-22)

**Question (owner):** We keep hitting one-off HMS browser issues. Should we use Stagehand (self-healing, becomes deterministic) instead of our Playwright CLIs?

**Verdict:** Keep live HMS deterministic. Use Stagehand at most as an **offline** locator-suggestion aid on a saved DOM, with a human turning its output into plain Playwright.

## Failure classes seen 2026-10-22

| Failure | Class | Stagehand fixes? |
|---|---|---|
| Ext tree node visible but off-viewport | locator / viewport | Maybe. #487 already fixed it with a scroll + DOM-click fallback |
| `x-mask` intercepts clicks | HMS state / timing | No |
| Leftover UI state between runs | state | No. Needs reset or isolation |
| "Rate is not available" / "no rooms or openings" | availability (business data) | No. It can read the message, not change the data |
| "Page contains errors" = DV-required Reservation Note | property schema | Detection only |
| Save hangs, no confirmation number | commit status | No. Needs read-back |
| Pre-save search fails in a second context | session / context | No |

## Key facts

- The repo already has an isolated Stagehand v4.1.0 package (`apps/server-pilot/tooling/stagehand/`) from a September trial. The live quote runner imports no Stagehand SDK and calls no model (`apps/server-pilot/tooling/playwright-quote/README.md`).
- Stagehand v3 can attach over CDP to an existing Chrome ([API](https://docs.stagehand.dev/v3/references/stagehand)).
- Cached actions replay without an LLM, but a changed page misses the cache and calls the LLM again ([caching](https://docs.stagehand.dev/v3/best-practices/caching), [act](https://docs.stagehand.dev/v3/basics/act)). That is cached recovery with a runtime LLM fallback. It conflicts with PRODUCT.md "deterministic HMS tools" and the no-LLM-on-live-HMS rule.
- No HMS latency or per-action cost benchmark exists. Browserbase plans: [pricing](https://docs.browserbase.com/account/billing/plans).

## What fixes today's class of problem instead

A read-only, per-property **create preflight** that reports every blocker in one run, before any Save. It checks:

- a fresh tab
- exact-date availability and rate restrictions
- required fields on the commit screen
- duplicate search in the same context
- nav readiness

See the [DV install retro](../context/ledger/2026-10-22-dv-install-retro.md).

## Smallest experiment (only if wanted)

Run Stagehand `observe` on one sanitized, saved HMS DOM for the off-viewport case, then compare it to the #487 fix. No live browser, no guest data.

**Limits:** this is an architecture decision only; Stagehand's efficacy on HMS was not measured.
