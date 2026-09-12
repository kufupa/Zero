---
title: HMS live proof must gate payload quality not only packaging
date: 2026-09-11
category: workflow-issues
module: server-pilot-hms / centurion-dashboard-tools
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Live HMS PMS tool proof runs where PROOF_EXIT=0 and artifact packaging are the primary done gates"
  - "Building or extending Centurion dashboard PMS tools with claimKeys field assertions"
  - "Unit tests and fixtures use optimistic GRID XML while live Infor dataspy omits or sentinel-fills fields"
  - "Agents or plans declare success from proof scripts without auditing result.v1.json payload fields"
  - "Schema allows nullable fields but operators expect guestName, roomType, and ratePlan to be populated"
symptoms:
  - "Live hms_find_reservation returned guestName=\"-1\" (Infor primaryguest sentinel) and null roomType/ratePlan while proof passed"
  - "Unit tests and fixtures used optimistic GRID with real primaryguest and roomtype/rateplan present"
  - "Plan done criteria were packaging-only: PROOF_EXIT=0, video capture, digest artifacts"
  - "claimKeys overclaimed eight fields without live payload field-quality audit"
  - "Agent declared success without opening or validating result.v1.json against expected business fields"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - testing_framework
  - service_object
  - tooling
tags:
  - hms
  - live-proof
  - payload-completeness
  - centurion-dashboard
  - pms-tools
  - claimkeys
  - grid-parser
  - workflow-gates
---

# HMS live proof must gate payload quality not only packaging

## Context

During live proof for `hms_find_reservation` (Guest Stay grid / OSRESS search path), packaging gates reported success: `PROOF_EXIT=0`, comparison artifacts present, and a human-reviewable Playwright video. The run was treated as complete against plan `2026-09-11-fast-live-find-reservation-video.md`, whose done criteria required match outcome, video, source/result comparison, and `view_only` — but **not** payload field quality.

Inspection of `result.v1.json` showed the tool was semantically incomplete:

| Field | Expected (catalogue / narrative) | Live result |
|-------|----------------------------------|-------------|
| `guestName` | Real guest name | `"-1"` |
| `roomType` | Room type when grid exposes it | `null` |
| `ratePlan` | Rate plan when grid exposes it | `null` |
| `claimKeys` | Honest list of populated claims | Always 8 keys regardless of null/wrong values |

**Root cause — guest name:** `guestNameFromGridRow` in `live-guest-stay-driver.ts` prefers truthy `primaryguest`. On live OSRESS dataspy 1941 grid rows, `primaryguest` is often the sentinel `"-1"` while the real name lives in `lastname` / `firstname`. Because `"-1"` is truthy, the function returns it and never falls through to name composition.

**Root cause — room type / rate plan:** Unit fixtures and happy-path tests assumed `roomtype` and `rateplan` keys on GRID `DATA[0]`. Live OSRESS `DATA[0]` for the proof record had `room` (room number) but **no** `roomtype` or `rateplan` keys. Fixtures invented keys the live surface does not provide on the search grid.

**Root cause — claim honesty:** `mapMatchedRow` in `reservation-candidate-session.ts` always emits eight `claimKeys` while `unresolvedFields` only tracks confirmation, dates, and status — not guest-name quality, sentinel values, or missing room/rate fields.

**Process gap:** Packaging green (auth, video, lock, digest comparison) was equated with tool complete. Narration described "returns guest name, room type, rate plan" as if filled when values were null or sentinel. Aspirational catalogue wording for "room type" does not match what dataspy 1941 search grid actually exposes; detail fields may belong to a separate read path (e.g. `hms_read_reservation`), but that was never validated against a recorded live snapshot before declaring done.

This document captures **diagnosis and prevention gates only** — not a shipped code fix for the guest-name parser.

## Guidance

Adopt a **two-layer gate model** for every live HMS tool in a multi-tool build. Packaging gates and semantic gates must pass independently before a tool is promoted.

### 1. Explicit payload contract in done criteria

Before implementation starts, write a field contract into the plan's done checklist:

- **Required fields** — must be non-null and match live shape (e.g. `confirmationNumber`, `guestName`).
- **Allowed nulls** — fields explicitly optional on this surface (e.g. `roomType` on search grid if live dump proves absence).
- **Forbidden sentinels** — values that must never surface as user-facing data (e.g. `primaryguest: "-1"` must not become `guestName`).
- **claimKeys honesty** — every listed claim key must correspond to a validated, non-sentinel value; null or unresolved fields must appear in `unresolvedFields` and/or shrink `claimKeys`.

Do not mark a tool done on match + video + comparison alone.

### 2. Recorded live fixture before green

Every live tool needs at least one **sanitized, committed live response fixture** (GRIDRESULT envelope or equivalent) captured from a real proof run **before** declaring the tool green. Unit tests must exercise that fixture — not only synthetic happy paths.

- Prefer dumping actual GRID keys from live over inventing alias keys in tests.
- When live lacks a key, tests must assert `null` and document that the search grid does not provide it — not fabricate `roomtype` / `rateplan`.

### 3. Live proof soft gate: payload policy before human video

Insert an automated assertion step in the live proof pipeline **before** `PHASE_A_PROOF_READY` and before human video review:

- Parse `result.v1.json` against the field contract.
- Fail the proof run if forbidden sentinels appear, required fields are null, or `claimKeys` over-claim relative to `unresolvedFields`.
- Keep existing packaging checks (auth, `view_only`, digest comparison, video artifact presence) as a separate stage.

### 4. Human HITL: video + field-by-field JSON

Human review must include:

- Playwright video (navigation / no mutation).
- `result.v1.json` reviewed **field-by-field** against the contract and against known live record ground truth.
- Explicit sign-off that sentinels, nulls, and `claimKeys` are acceptable for this tool version — or send back for mapping fix.

### 5. Sequential tool promotion

Do not start the next write/read tool in the kickoff sequence until the current tool passes:

1. Field contract (automated),
2. Recorded live fixture regression,
3. Live proof with payload policy,
4. Human HITL sign-off.

### 6. Separate packaging from semantics

| Packaging gates (keep) | Semantic gates (add) |
|------------------------|-------------------------|
| Auth / session shell | Required fields populated |
| `view_only` / no mutation | No forbidden sentinels in payload |
| Video artifact | `claimKeys` ⊆ validated fields |
| Source/result digest comparison | `unresolvedFields` reflects actual gaps |
| `PROOF_EXIT=0` | Live fixture regression passes |

Green on the left column does **not** imply green on the right.

### 7. Fixture discipline

When building unit tests for grid parsers:

1. Capture live `GRID.DATA[0]` key list from proof (redact PII in committed fixture).
2. Mirror key names and sentinel patterns exactly.
3. Add a dedicated case for `primaryguest: "-1"` with real names in `lastname` / `firstname`.
4. Omit keys that live omits — do not add `roomtype` / `rateplan` unless live dump shows them on this dataspy.

## Why This Matters

Multi-tool HMS builds chain dependencies: downstream tools assume upstream reads return trustworthy guest, room, and rate context. A tool that "succeeds" with `guestName: "-1"` and null room/rate poisons agent prompts, draft-ready logic, and operator trust. Live proof infrastructure already invests in video and comparison; without payload policy, that investment validates packaging only and silently ships wrong semantics. Recorded live fixtures are cheap insurance against schema drift and optimistic unit tests.

## When to Apply

- Any new or live-proven HMS read tool in `apps/server-pilot` (Guest Stay grid, folio, reservation detail).
- Multi-tool kickoff plans (e.g. write-tools sequence from gold record 3949) where one tool gates the next.
- When plan done criteria mention "match" or "video" but not field-level contracts.
- When unit tests use synthetic grid rows that were not derived from a live GRIDRESULT snapshot.
- When catalogue or tool descriptions promise fields that the chosen dataspy / endpoint may not expose.

## Examples

### Done criteria — before vs after

**Before (insufficient):**

- [ ] Live match outcome
- [ ] Playwright video
- [ ] Source/result comparison
- [ ] `view_only`, no mutation
- [ ] `PROOF_EXIT=0`

**After (required for promotion):**

- [ ] Payload contract documented in plan (required / allowed-null / forbidden sentinels)
- [ ] Sanitized live GRIDRESULT fixture committed; unit tests use it
- [ ] Live proof asserts payload policy (pre–human review)
- [ ] `guestName` not sentinel; or explicitly `partial` with honest `unresolvedFields`
- [ ] `claimKeys` only lists fields that passed contract
- [ ] Human HITL: video + `result.v1.json` field sign-off
- [ ] Packaging gates (video, comparison, `view_only`, exit code)
- [ ] Next tool in sequence **not** started until above are green

### Test fixture shape — before vs after

**Before (optimistic; masks live behavior):**

```typescript
{
  confirmationnumber: SYNTH.conf,
  primaryguest: SYNTH.guest,   // always a real name in tests
  roomtype: 'STD',             // invented — live search row may lack this key
  rateplan: 'BAR',             // invented — live search row may lack this key
  lastname: 'Syntherson',
  firstname: 'Alpha',
}
```

**After (live-faithful; includes sentinel case):**

```typescript
// Fixture A: recorded live snapshot (sanitized) — keys match dump, no invented aliases
{
  confirmationnumber: '…',
  primaryguest: '-1',
  lastname: '…',
  firstname: '…',
  room: '…',                   // present on live; roomtype/rateplan absent
  arrivaldate: '…',
  departuredate: '…',
  status: 'Confirmed',
}

// Fixture B: contract expectations for Fixture A
// guestName must compose from lastname/firstname, not "-1"
// roomType / ratePlan null unless live dump adds keys
// mapMatchedRow must not claim guestName/roomType/ratePlan without validation
```

Reference: happy path in `hms-live-guest-stay.test.ts` uses `primaryguest: SYNTH.guest` with `roomtype` / `rateplan` present — valid for parser mechanics but insufficient as the only regression shape.

### Proof pipeline insertion point

```
live run → parse result.v1.json → [NEW] payload policy assert → PHASE_A_PROOF_READY → human video + JSON review → promote tool
                                      ↓ fail
                               fix mapping / contract / fixture (do not advance sequence)
```

## Related

- Plan (video-focused done criteria): `docs/superpowers/plans/2026-09-11-fast-live-find-reservation-video.md`
- Multi-tool kickoff: `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md`
- Guest name mapping: `apps/server-pilot/src/hms/live-guest-stay-driver.ts` (`guestNameFromGridRow`, `parseLiveOsressGridRows`)
- Match result / claimKeys: `apps/server-pilot/src/hms/reservation-candidate-session.ts` (`mapMatchedRow`)
- Unit tests: `apps/server-pilot/tests/hms-live-guest-stay.test.ts`
- Related convention (negative-result six-proof gate): `docs/solutions/conventions/live-negative-result-verification-gate.md`
- Related integration DoD tokens: `docs/solutions/integration-issues/live-osress-gridresult-parse-canary-row-ok.md`
- Analogous false-green: `docs/solutions/workflow-issues/false-green-gate-unpersisted-tsc-fixes.md`
