# EC2 Pilot — AI triage live gate handoff

**Date:** 2026-07-11  
**Branch:** `EC2-pilot`  
**HEAD:** `c2b2084f`  
**Gate:** `apps/server-pilot/deploy/ai-triage-live-gate.sh` → **PASS**  
**Executor:** Cursor overnight agent (executing-plans, no subagents)

## Env proof

| Flag | Value |
|------|-------|
| `AI_WRITE_GATE_ENABLED` | true |
| `AI_DRAFTS_ENABLED` | false |
| `MAIL_TRANSPORT_MODE` | wire (Mailpit) |
| Model | Nova Lite (`amazon.nova-lite-v1:0`) |
| FE proof | nginx `https://127.0.0.1` + Playwright `ai-triage-live.spec.ts` |

## Fixes applied overnight (to get green)

1. **SSM poll** — Status-only poll so Windows AWS CLI charmap does not false-timeout on vitest unicode.
2. **Playwright FE** — Prefer nginx HTTPS (same-origin `/api`) over static `:3000`.
3. **SPA build** — Force empty `VITE_PUBLIC_BACKEND_URL` so bundle is `/api/trpc` not `undefined/api/trpc`.
4. **nginx CSP** — `script-src 'self' 'unsafe-inline'` so Vite/RR inline boots run.
5. **Date buckets** — Coerce superjson `Date` `latestMessageAt` before `parseISO` (was blanking inbox).
6. **E2E helper** — Detect Inbox via href/text (sidebar is not `role=link`).

## LLM-in-the-loop review (agent = reviewer)

Every guest fixture read (subject/from/body) and judged as Centurion hotel ops would file. Categories = `internal | individual | group | travel-agents | spam`. Urgent = same-day human attention only.

| id | subject | agent_expected | nova_actual | urgent | applyMode | review | why / fix |
|----|---------|----------------|-------------|--------|-----------|--------|-----------|
| spam-viqal | Video inside: Virtual Hotel Concierge | spam | spam | false | urgency_only* | correct | Cold sales demo + unsubscribe — spam |
| group-kleinkaap | Maple Estate Overflow Rooms 23 July | group | group | false | urgency_only* | correct | 20 rooms overflow quote — group |
| individual-urgent-invoice | Urgent Tax invoice | individual + urgent | individual | true | urgency_only* | correct | Same-day tax invoice ask — individual + urgent |
| individual-quotation | Request for a quotation | individual | individual | false | urgency_only* | correct | Single-guest gov rate quote — individual |
| individual-municipality | booking | travel-agents | travel-agents | false | urgency_only* | correct | Sample Travel Admin booking for municipality — travel-agents |
| travel-agents-four-rooms | RE 4 ROOMS CHECK IN THE 09 JUL… | travel-agents | travel-agents | false | urgency_only* | correct | Consultant multi-room gov booking — travel-agents |
| travel-agents-quote | REQUEST FOR QUOTATION | travel-agents | travel-agents | false | urgency_only* | correct | Travel consultant quote — travel-agents |
| internal-handover | Handover: VIP arrivals Thursday | internal | internal | false | urgency_only* | correct | Staff→mailbox VIP handover; not same-day urgent |
| hotel-sent-copy | Re: Booking confirmation HRCEN-50140001 | Sent / zero triage | outbound, triageRuns=0 | — | — | correct | From=transport.email → Sent, skip AI |

\* `applyMode=urgency_only` on this run because threads were already settled from earlier gate passes (primary category / spamAt already present). Category + urgent still match oracle; first-touch `full` apply was proven on earlier unsettled runs and in vitest contracts.

## Playwright

- Spec: `packages/testing/e2e/ai-triage-live.spec.ts`
- Result: **2 passed** (setup + shows Maple Estate in inbox + group folder)
- No draft card asserted (drafts off)

## Done criteria

- [x] Tasks 1–9 complete; contract vitests green on prior EC2 runs
- [x] Sanitized live corpus committed
- [x] EC2 write gate on, drafts off; `ai-triage-live-gate.sh` green
- [x] Playwright shows threads in inbox + category folder
- [x] Every guest fixture passes agent LLM-in-the-loop review
- [x] Hotel-sent: Sent, zero triage
- [x] Handoff report with per-email review
- [x] No candidate-draft enablement
