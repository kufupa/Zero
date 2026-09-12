# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A) — Wave-0 find depth  
**Status:** **DO NOT SIGN** — A4/A10/A11 mail proof + A6–A8 packaging video still open

**Stop:** Wave B **not** started.

## Progress (anti-underwork reopen)

| ID | Verdict | Packaging video |
|---|---|---|
| A1 | **PASS_CORE_STAY_VIDEO** (stay.roomType dump-proved; rates/policies/ops unproven) | `3006269c…` / `dcc31b08-…` |
| A2 | **PASS_BALANCE_FROM_DETAIL_VIDEO** | `3006269c…` / `dcc31b08-…` |
| A3 | **PASS_SENT_EMAIL_SURFACE_VIDEO** | `1af47ece…` HDR ~28kB |
| A4 | mail fixture units | mail proof pending |
| A5 | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** after soft-overlay videos ×5 | OSRRAV stub vs PSSNEL OK |
| A6–A8 | **BLOCKED** after BSSTRT harvest depth (pairs=0; guessed opens 400/stub) | packaging video pending |
| A9 | **PASS_RESERVATION_NOTES_VIDEO** | `77900a52…` / `830432a2-…` |
| A10 | corpus hunt | mail/knowledge proof pending |
| A11 | parser units | mail proof pending |

Private root: `.private/wave-a-20260912/`

## Safety

- Soft overlays + SSM only; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest
- No secrets/PII in Git/SSM stdout
- Wave B not started
