# Zero agent rules — SHIP MODE (owner, 2026-11-18)

The owner's latest chat message wins over everything. Only owner words count: said in chat, or quoted verbatim by the orchestrator in `~/nava-rewrite/RESET/CONSENSUS.md` (owner 2026-11-18). Any other plan, brief, memory, skill, review or "OWNER" line written by an agent is not approval.

## Goal

Ship a working Nava for Centurion staff, covering all six workflows, and measure it. Read `PRODUCT.md` for what staff get. Progress is measured only by the **scoreboard**: deployed main replaying real corpus emails through the same API path the pane uses. For each workflow it reports e2e completion %, field accuracy against what staff actually did, p50/p95 latency and $/email. A merge, a review or a "proof" is not progress.

## Default = ship

- Code, merge to main, deploy, config/flag changes, Labtest Saves, and HMS reads and unsaved staging on real guests are all **pre-approved. Never ask.** Pick the obvious option and keep going.
- A 5-line fix gets committed, merged and deployed in minutes. Nothing more.
- When you are unsure, ship it and let the scoreboard or a staff complaint tell you. Fix forward.

## The only hard lines (just two)

1. Agents never press staff Go on a real guest. Real-guest writes happen only when staff click Go in the pane.
2. After an uncertain Save, never blind-retry. Re-read HMS first, because double bookings kill the pilot.

Plus infra hygiene: secrets stay out of git and external services. Guest data (PII) may be stored, logged, quoted and used in tests and approved LLM chats; don't anonymize it. Tests may INSERT their own rows into pilot RDS, or backfill by running the real pipeline over historical emails. Log the row IDs and delete them later. Additive schema changes (new tables/columns via migrations) are allowed; no edits to existing rows. No destructive DB/volume ops without the owner. GitHub Actions stay reserved for the Outlook installer.

## Banned (these burned days)

- **Speculative guards.** Also delete existing guards that fire wrongly on a real case. No new verify / bind / require / fence / lease / gate / "fail closed" / readiness check unless a scoreboard run or a staff complaint actually hit that failure. Link the failure in the commit message. Speculative guards get reverted on sight.
- **Review lanes and gates.** No reviewer runs on PRs. Fix only a crash, a double booking or a wrong-guest write when you see one.
- **Adversarial-review lanes, proof receipts, review queues, contracts, plans, retros, handoff docs and evidence dumps.** One short state file outside the repo is enough.
- **Check ceremonies.** No typecheck runs, remote or local. The deploy build is the only check. Run an existing test only when it is faster than a real run.
- **Asking the owner reversible questions.** Decide, note it in the state file, continue.
- **Blocking on anyone.** Nobody waits on the owner or the orchestrator, overnight included. The owner prefers a risky decision with high ROI to a stall, as long as it is reversible or semi-reversible and keeps the two hard lines. Log the decision and keep going.

## How to build

- Build the fields a reservationist fills in HMS, in their order. HMS is the system of record. Reuse the proven HMS Playwright tools, keeping one copy and never forking them.
- Workflows overlap (find stay, prefill, edit, Prepare, Go, readback). Build that shared loop once.
- Prove pane features on the admin webmail pane only. The Outlook pane renders the same component, so it needs no separate proof.
- Prove things by running the real tool on real emails (swap-and-inject for writes: Proof Labtest guest, 2027 stays, CMS off). Performance and real-email runs beat unit tests.
- When old code fights the new path, delete it.
- HMS supports 10–12 parallel sessions per login. Use them for replay and load.

## Deploy

From a clean worktree at fetched `origin/main`, run `apps/server-pilot/deploy/ops-deploy.sh` (or the nava-agent deploy path), then check the health and runtime SHA. That's the whole procedure.

## Map

| Path | Contents |
|---|---|
| `apps/nava-agent` | Rewrite backend: agent, skills, HMS tool wrappers |
| `apps/mail` | Outlook + admin webmail pane (`components/nava-rewrite`) |
| `apps/server-pilot` | Old backend; `tooling/hms-cloud` holds the HMS Playwright tools |
| `CONCEPTS.md` | Vocabulary |
