---
name: building-hms-playwright-tools
description: >
  Use when building or widening a Centurion Infor HMS Playwright tool (quote,
  guest stay, folio, notes, traces, lab write), when an agent reaches for
  Stagehand, OpenAI Computer Use, CRS Check Availability, a stuffed Astra
  checklist, a new playwright-hms extract, or a second browser owner, or after
  a tool run when a new PMS trap should be recorded.
---

# Building HMS Playwright tools

Kernel today: `apps/server-pilot/tooling/playwright-quote/` — login, borrowed CDP, `audit.mjs`, `remote-owner.mjs`. Import it. Do not extract `playwright-hms` first. Shipped CLI = native Playwright, zero model.

## Swimlanes

| Actor | Owns |
|---|---|
| Cursor Grok 4.6 high | Schema, kernel import, `node --test`, docs, Astra brief, git. Never attaches HMS. |
| GPT-6 Astra via `codex exec -m gpt-6-astra` | Live PMS, selectors, live proof. Resume **one** session. |
| Not owners | Cursor Browser, Luna, Astra parent for git/tests, Stagehand click-model |

## Steps

1. Freeze `$defs.request` / `$defs.result`. Completeness = every field source-backed, explicit unknown, or typed error.
2. Grok writes CLI stub + tests **offline**. No browser.
3. Fill `assets/astra-brief.txt` ≤1500 chars. Tool, page, schema path, stop rule. No AE1–AE9 dump.
4. One `codex exec`; then `resume`. Persist locators immediately. Prices-first. Keep borrowed browser alive. Skip `--video` and tests on Astra clock.
5. Grok runs tests. Schema-complete → stop.
6. Append **one** trap to `references/traps.md`. Patch this skill; do not fork a sibling.

## Rails

- Front Desk → Availability → **Hotel Availability**. CRS Check Availability creates records.
- Native vs normalized. `STWN` = Standard Twin **room type**. Bed card is its own field. Never map `STWN` → twin beds.
- Writes: far-future lab stays only (keeper + cancel-victim, empty-inventory night). Never mailbox stays.
- HITL (`proposalRef`) is a later envelope, not first CLI.
- Unset `DATABASE_URL` before tests. Never Vitest against pilot RDS.
- No commit unless asked.

## Load next

- `references/traps.md`
- `assets/astra-brief.txt`
- Quote `README.md` for owner/tunnel env **names** (never secrets, CDP URLs, mail bodies in briefs)

## Red flags

- Stagehand runtime / “just click the PMS”
- Astra brief >1500 chars
- Tests or `--video` on first Astra exec
- New login rewrite or second browser owner
- Inventing beds, totals, or pool ids (`MAIN`) from labels
