# Wave A batch HITL packet — Centurion PMS remaining reads

**Date:** 2026-09-12  
**Branch:** `feat/centurion-dashboard-tools`  
**Authority:** Overnight Autonomous Execution Mandate (Wave A) — Wave-0 find depth  
**Status:** **DO NOT SIGN** — packaging videos still incomplete for full wave (A6–A8 / A1 rates / A10–A11 mail proof)

**Stop:** Wave B **not** started.

## Progress this reopen (anti-underwork)

| ID | Verdict | Packaging video |
|---|---|---|
| A1 | PASS_CORE_STAY + detail now exposes roomType/ratePlan keys | soft-incomplete; deepen rates next |
| A2 | **PASS_BALANCE_FROM_DETAIL_VIDEO** | sha256 `3006269c…` artifact `dcc31b08-…` |
| A3 | **PASS_SENT_EMAIL_SURFACE_VIDEO** | sha256 `1af47ece…` HDR ~28kB |
| A4 | mail fixture units | mail proof pending |
| A5 | **BLOCKED_ROLE_SURFACE_UNAVAILABLE** after soft-overlay ×5 videos | OSRRAV stub vs PSSNEL OK same cred |
| A6–A8 | pending code harvest + soft overlay | not done |
| A9 | **PASS_RESERVATION_NOTES_VIDEO** | sha256 `77900a52…` artifact `830432a2-…` |
| A10 | corpus hunt | mail proof pending |
| A11 | parser units | mail proof pending |

Private root: `.private/wave-a-20260912/`

## Safety

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest
- Soft overlays + SSM only; no secrets/PII in Git/SSM stdout
- Wave B not started
