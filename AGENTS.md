# Zero agent rules — SHIP MODE

The owner's latest chat message wins over everything.

## Goal

Ship a working Nava for Centurion staff across all six workflows (`PRODUCT.md`). Progress is measured only by the **scoreboard**: real corpus emails + live HMS readback against what staff actually saved. Never report composite scores as accuracy; always report Create hard-field accuracy, `agent_sha`, `scorer_sha`, and `n`.

## Default = ship

- Code, merge to main, deploy, flag changes, Labtest Saves, HMS reads, and unsaved staging are pre-approved. Never ask reversible questions or block on anyone; fix forward.

## Hard lines (only two)

1. Agents never press staff Go on a real guest. Real-guest writes happen only when staff click Go in the pane.
2. After an uncertain Save, never blind-retry. Re-read HMS first (double bookings kill the pilot).

Infra: secrets stay out of git/external services; guest PII is owner-authorized for logs, tests, and approved LLM chats; additive DB migrations only (no destructive DB/volume ops without owner); GitHub Actions stay reserved for the Outlook installer.

## Banned

- **Speculative guards** not tied to a real scoreboard failure or staff complaint. Delete guards that fire wrongly on real cases.
- **Review gates, proof ceremonies, plans, retros, and handoff docs.** One short state file outside the repo is enough.
- **Typecheck ceremonies.** No typecheck runs, remote or local. The deploy build is the only check. Run an existing targeted test only when faster than a real run.

## Build & deploy

- Build reservationist fields in HMS order; reuse the single copy of HMS Playwright tools. Delete old code when it fights the new path.
- Prove pane features on admin webmail only; prove tools on real emails (Labtest swap-and-inject: `Proof Labtest`, 2027, CMS off).
- Deploy from clean `origin/main` via `ops-deploy.sh` or `apps/nava-agent/deploy/bundle.sh`, then verify health + runtime SHA. Use a dedicated bot login (never kick staff `user-centurion`) and avoid disruptive restarts during Centurion hotel hours (07:00–19:00 SAST) unless the owner asks.
