# Lab scratch archive (Centurion HMS / eval, Sep 2026)

> **Do not ship, import, or run this from production paths.**
> One-off eval, probe, and unmerged HMS-read drafts. Live tools stay in
> `apps/server-pilot/src/hms/` and `apps/server-pilot/tooling/`.

## Why this folder exists

A Cursor worktree accumulated ~140 **never-committed** files while quote/find
tools were merging. They sat in `apps/server-pilot/scripts|src|tests` next to
shipping code. This archive is the durable home so another agent can find them
without treating them as the current pipeline.

**Sibling archives**

- [`archive/wave-a-probes/`](../wave-a-probes/README.md) — earlier HMS tab/harvest probes
- [`archive/stagehand/`](../stagehand/README.md) — Stagehand spike, superseded by Playwright

## What “next-wave HMS” meant

After quote + find-reservation shipped, the next intended slice was **connected
reads**: one guest-mail case that then reads folio, notes/traces, and hotel
availability without a new HITL loop. That slice never merged. Source for it
is under `apps/server-pilot/src/hms/connected-*.ts` and
`hotel-availability-*.ts` **in this archive**, not in live `src/hms/`.

## Layout (mirrors original paths)

Everything that used to live at `$REPO/<path>` is now:

`archive/lab-scratch/<path>`

Relative imports **between archived files** stay as they were. Imports that
pointed at **live** `apps/server-pilot` / `apps/mail` modules were rewritten to
walk back to those live files.

| Prefix in this archive | What it was for |
| --- | --- |
| `apps/server-pilot/scripts/centurion-eval-*` | Eval lab gold/needed freeze, shuffle, collate, Luna launch |
| `apps/server-pilot/scripts/gold-fact-*` | Live gold-fact backtest / collect / score |
| `apps/server-pilot/scripts/hms-connected-*`, `hms-standalone-*` | Connected-read drivers and diagnostics |
| `apps/server-pilot/scripts/hms-gate-*`, `hms-hitl-*`, `hms-read-100-*` | Gate videos, HITL recorder, 100-read verify |
| `apps/server-pilot/src/hms/connected-*.ts` | Connected-runner contracts, sequence, folio/notes variants |
| `apps/server-pilot/src/hms/hotel-availability-*.ts` | Availability facade/manifest (unmerged) |
| `apps/server-pilot/src/hms/notes-inquiry-*`, `notes-traces-*` | Notes/traces read facades (unmerged drafts) |
| `apps/server-pilot/src/mail/ingest/recover-parse-failure.ts` | Scratch recover CLI. **Canonical recover path is PR #10 / live ingest, not this copy.** |
| `apps/server-pilot/tests/hms-connected-*.ts` | Tests for the unmerged connected-read slice |
| `apps/mail/lib/lab/quote-stay-route.ts` | Quote-only room-code / date / pax parser used in lab |
| `docs/superpowers/plans/`, `docs/solutions/`, `docs/infor-hms/` | Plans, handoffs, playbooks from that loop |
| `_local-pii/` | **Gitignored.** Local transcripts/contracts; never commit |

## How another agent should use this

1. Search this README + filenames, not `apps/server-pilot/scripts/` for these jobs.
2. Treat files as historical evidence. Copy a script out and re-point imports if you must re-run.
3. Do not add this tree to `apps/server-pilot` `tsconfig` / Vitest. Oxlint ignores `archive/**`.
4. Recover-from-quarantine for production: `apps/server-pilot/src/mail/ingest/recover-parse-failure.ts` once PR #10 is on `main`. Ignore the copy here.
5. Do not git-add `_local-pii/` (guest contracts, invoices, call transcripts).

## Not in git (on purpose)

- `__pycache__/`
- `archive/lab-scratch/_local-pii/` (PII)
