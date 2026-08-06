# Phase B final whole-branch review — 2026-08-06

**Verdict:** NOT APPROVED

**Scope:** committed Phase B diff `16b61154` (`feat(hms): Phase B read portfolio fixtures, kernel, and release grammar`) vs plan `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`. Base reference `e9f4a121` (Phase A). Critical/Important only; accepted state: Tasks 1–10 fixture/partial; live promotion blocked on role-proof-v2 + discovery; production active-read = `hms_find_reservation` only.

**Reviewer:** cavecrew-reviewer (final gate).

---

## Verdict line

```
NOT APPROVED
```

## Critical

_None._

## Important

1. **Empty executable gather fallthrough (attachment loop)** — `apps/server-pilot/src/ai/candidate-draft-agent.ts` (~735–745). Probe loop correctly skips when `executableToolIds.size === 0`, but attachment loop only skips mail when `size > 0 && !has('mail_read_artifact')`. Empty production executable (quote/group/event plans under `planMode: 'production'`) therefore does **not** block `mail_read_artifact` if the tool is registered and attachment IDs are present. Violates stated invariant “empty executable = no gather / no fallthrough.” Current HMS worker mitigates via `probeAttachmentIds: []` + find-only `activeToolIds`, but guard is incomplete and untested for the empty-set case. **Fix:** treat missing mail in executable set as hard skip (`if (!executableToolIds.has('mail_read_artifact')) break;` and/or `if (executableToolIds.size === 0) break;`), plus regression: production quote plan + attachments + mail-registered session must not call `readArtifact`.

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
