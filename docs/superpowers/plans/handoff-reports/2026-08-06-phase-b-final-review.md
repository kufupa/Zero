# Phase B final whole-branch review — 2026-08-06

**Verdict:** APPROVED (Important #1 fixed in `1281930d`)

**Scope:** committed Phase B diff through `1281930d`. Plan `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`. Critical/Important only; accepted state: Tasks 1–10 fixture/partial; live promotion blocked on role-proof-v2 + discovery; production active-read = `hms_find_reservation` only.

**Reviewer:** cavecrew-reviewer (final gate) + overnight fix.

---

## Verdict line

```
APPROVED
```

## Critical

_None._

## Important

1. **Empty executable gather fallthrough (attachment loop)** — **FIXED** in `1281930d`: attachment loop now `if (!executableToolIds.has('mail_read_artifact')) break;` (empty set cannot fall through).

---

## Focus checklist (spec vs reality)

| Focus | Result |
| --- | --- |
| Fail-closed negatives (`unverified_negative` vs `not_found`) | Pass — parser `outcome: 'not_found'` remapped at session/driver/receipt; branded certificate required for tool `not_found`; empty folio/docs/company → `unverified_negative`; `collectBusinessNotFoundAssignments()` empty |
| Production allowlist ≠ blocked tools | Pass — `productionActiveReadToolIds() === ['hms_find_reservation']`; followups stripped in production executable; ablation/load membership promoted-only |
| Empty executable gather no fallthrough | **Fail** — see Important #1 |
| Privacy denials / claim eligibility recompute | Pass — folio/company/group/event recompute eligibility; forged stored fields ignored; blocked → null claim |
| PMS write surface absence | Pass — `candidateToolEffects` / `READ_TOOLS` effect `read` only; CRS/write-forms `future_write` + `autonomousAllowed: false`; ops Phase B promote CLI exits `PHASE_B_BLOCKED` |
| Pilot RDS safety in tests/scripts | Pass in-scope — Phase B ablation replay is DB-free; no new Vitest→pilot path in commit; existing gate `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` unchanged |

---

## Accepted / out of gate

- Live discovery + role-proof-v2 promotion still blocked (`ops-hms-proof.sh` doctor/status/read-* → `HMS_WAIT code=PHASE_B_BLOCKED`).
- Fixture-only contracts for quote/comms/folio/company/group/event.
- Placeholder discovery/live digests on find remain Phase A binding markers.
- Followup tools planned but not yet executed in gather (fixture/partial accepted).

---

## Findings (cavecrew)

```
apps/server-pilot/src/ai/candidate-draft-agent.ts:739: 🟡 risk: empty executableToolIds skips probe gather but attachment loop still runs mail_read_artifact when size===0. Guard `size > 0 && !has(mail)` is inverted for empty set. Fix: hard-skip when mail not in executable (and when size===0); add production quote+attachments regression.
totals: 0🔴 1🟡 0❓
```

---

## Re-approve when

- Important #1 fixed + regression green.
- Re-confirm `productionActiveReadToolIds()` still find-only and HMS worker still `planMode: 'production'` with empty `probeAttachmentIds`.
