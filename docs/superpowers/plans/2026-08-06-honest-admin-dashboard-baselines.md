# Honest Admin Dashboard Baselines

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (or `executing-plans`) task-by-task.

**Goal:** Ship one truthful Client Impact admin page: real Centurion baseline volume + response metrics from existing `message` rows; everything else dash or Coming Soon — zero hard-coded KPIs on hosted.

**Architecture:** Read-only tRPC `adminDashboard.getMetrics` aggregates `message` / `mail_thread` / `mailbox_transport` on the fly. No baseline warehouse table. UI keeps current shell; hosted hook stops using placeholder demo data for LIVE numbers.

**Tech stack:** Drizzle + tRPC on server-pilot; React + Recharts on mail; Vitest in-memory fixtures only (never pilot RDS).

**Source of truth plan:** also mirrored from `.cursor/plans/honest_admin_baselines_1ac90c0a.plan.md`.

## Global constraints

- Never fake or hard-code hosted KPI numbers.
- Never Vitest against pilot RDS; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- No PII bodies in metrics API responses or logs.
- Reuse existing dashboard design; do not invent a new visual system.
- Product Health / edit-distance / handle-time / HMS revenue: out of this pass.
- Delete no existing dashboard components; Coming Soon greys them in place.
- No commits unless user explicitly requests (nava-run authority).

## Metric definitions

- Eligible thread: exclude spamAt/trashedAt.
- First-response per thread: earliest inbound → first outbound after; median/p90 over answered only; track unanswered.
- % within 3h: unanswered = miss. Label "Answered within 3h" (RES005-aligned, not literal).
- Window: 7 days; TZ Africa/Johannesburg; exclude navaai transport.
- LIVE: inbound volume, median/p90 response, 3h %, inbound/day line, comparison inbound+SLA.
- UNAVAILABLE: draft time, AI-assisted, edit distance, drafted series, Nava half.
- COMING SOON: revenue, booked, hours, tone, splits, multi-hotel palette legend.

## Tasks

1. Pure aggregators + Vitest fixtures
2. tRPC adminDashboard.getMetrics + server allowlist
3. FE types + hook honesty
4. Page LIVE/dash/Coming Soon + palette
5. Verification

See full plan body in `.cursor/plans/honest_admin_baselines_1ac90c0a.plan.md`.
