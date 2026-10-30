---
name: building-hms-playwright-tools
description: Use when building or extending PMS Playwright read or write flows, especially Centurion Stay 360.
---

# Building PMS flows

Build quickly with Codex and Playwright driving the actual PMS. Discuss the desired behavior with the user. Give each useful read or action a module with explicit inputs and structured results; compose longer flows on the same page/session where useful. Return options for unresolved identities instead of guessing.

Current modules live in `apps/server-pilot/tooling/playwright-quote/`:

- `centurion-stay360.mjs`: browser, login and Stay 360 lifecycle.
- `stay360-notes.mjs`: automatically closes and privately captures Notes popups; other dialogs stay untouched. The shared browser installs it; install it on any other page setup. Use `takeHandledNotes(page)` to include automatic captures in a reader's output.
- `stay360-confirmation.mjs` (1a), `stay360-record-view.mjs` (1b), `stay360-guest-details.mjs` (1c): composable readers; their end comments inventory observed fields. 1a accepts optional name/date and returns options for ambiguous matches. `read-*-ui.mjs` runners compose them.
- `stay360-lookup-cli.mjs`: shared JSON input and structured lookup-error output.
- `create-lab-stay.mjs`, `amend-stay.mjs`, and `write-cli-lease.mjs`: existing write-workflow references; check their actual coverage before reuse.

Inspect the real UI, build in small stages, and validate the requested behavior in the PMS as directly as practical. For identity lookups, check ambiguous results, blank fields and conflicting hints against real records where available. Skip low-value local test loops; follow the repository's required release checks. Report what was observed and what remains unverified. An observed read field is not proof it is writable.

Follow `PRODUCT.md` and current workspace instructions: an agent may read real guests, but writes only to Labtest. Keep credentials and guest values out of logs, comments and this skill.

After each building session, discuss what worked, what was slow or failed, and what to change with the user. Append or revise durable lessons and the module list in both the repository and shared skill copies; keep this file short and avoid overgeneralizing from one run.
