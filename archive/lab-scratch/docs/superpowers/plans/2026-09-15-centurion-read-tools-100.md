# Centurion read-tools 100% — soft-open + role-gate WebM

Date: 2026-09-15  
Branch: `feat/centurion-dashboard-tools`  
Parent: `2026-09-15-centurion-read-tools-2h-close.md` (slice done)  
**Execution posture:** Overnight autonomous — user unavailable for long wall; implement-fix-loop until done criteria green.  
**REQUIRED SUB-SKILL:** overnight-autonomous-execution / overnight-autonomous-zero (mandate below binding).

## Goal

Close Centurion **PMS READ tools** to **real 100%** for AI reservationist.

Corpus: **100** unique Sent emails. Live pack via **reuse runner** (parallel `context.request` finds, serial soft, recycle-on-poison — not login-per-phase). Role-gate WebM = end of line. Promote proven tools into `productionActiveReadToolIds()`.

## Definition of 100% (binding)

### Soft-open path (happy path)

- Recipe-driven live soft/find on production surfaces (OSRESS folio etc.)
- Reuse session: parallel finds, serial soft; drain finds before soft
- Soft green on unique emails in the 100-pack (prefer ≥10 when demand exists)
- **No WebM required** when soft path green

### EXTERNAL_ROLE_GATE (blocked path)

- **MUST** ship UI-first Playwright **WebM** showing exact blocked UI
- HMS Documents / rate-details / events: WebM = end of line (no mail workaround required)

### Bug / fail gate

- Soft fail after correct runner → fix **or** fail-WebM before move-on

### Gold bar

- Live pack digests scored vs Sent `gold_facts` extracts; per-email catalogue MD

### Packaging

- Digests + WebMs + HANDOFF in zip; downloadable

## Global Constraints

- Pilot-RDS: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest; never pilot RDS
- Live HMS: flock `/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock`; digests tails/counts
- Skip `property_read_knowledge`; skip `mail_read_artifact` soft burn (not PMS)
- CUT: parallel scheduler **product**; login-per-phase burns
- Soft-open defaults: find `context.request`; detail `page.evaluate` + bind after find drain
- HITL recorder: `apps/server-pilot/scripts/hms-hitl-ui-record.mjs` + `hms-gate-record-block-videos.mjs`
- Writes execute deferred

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions. No "which approach?" pause. `/goal` + `/continue-autonomously` armed. Execute until done criteria evidenced or true blocker.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- Code/commits/PRs: normal prose.

### Decision authority

- Best safe reversible option without asking
- Better route to Goal OK; log what/why
- Preserve requirements; do not silently cut scope
- Standard non-fast subagents; else inline

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **read-only checks only; never Vitest** |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Live runner | `apps/server-pilot/deploy/ssm-run-command.sh` |
| Chromium | `/opt/nava/chromium/chrome` |
| HMS flock | `/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock` |

**Allowed:** SSM live HMS read burns under flock, digests, WebM recorders, ops wrappers, disposable-DB Vitest.

**Forbidden:** force-push main, `--no-verify`, Vitest on pilot RDS, `VITEST_ALLOW_PILOT_RDS=1`, expose secrets/DB URLs, live PMS writes.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

### RCA loop

FAIL → reproduce → RCA (file:line) → fix **or** fail-WebM → resume. Soft wall ≫30 min on 100-pack → runner bug; fix session model before more emails.

### Cursor execution-backend flake

Exact: `Execution backend unavailable…` → backoff-retry Shell/Write; not an app RCA. Playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

### Done criteria

- [x] Burn runner: no `reloginEvery=1` default; reuse + request finds + serial soft; recycle-on-poison only
- [x] `GOLD-EMAIL-TOOL-CATALOGUE.md` for all 100 emails (tools + gold details + why)
- [x] Folio verify aligned to OSRESS production path *(leftover 2026-09-15: money values role-masked `protected`; `hms_read_folio` demoted `live:false` until unmasked money ≥10)*
- [x] Live HMS pack on 100 recipe-driven; digests under `.private/hms-read-100-20260915/`
- [x] Find / notes / group-company / surname / sent-audit evidenced in pack (or honest thin-census / role WebM) *(leftover: notes 3/15 thin; group/company unique-email 0 — see `.private/hms-read-leftovers-20260915/`)*
- [x] Role-gates still have WebMs; new soft fails have fail-WebM after correct runner
- [x] Soft-proven PMS tools promoted into `productionActiveReadToolIds()`; gated stay fail-closed *(leftover: allowlist = find+quote; folio demoted; A1 via `productionActiveReservationContextToolIds`)*
- [x] Gold score vs Sent extracts; HANDOFF + zip downloadable
- [ ] No unresolved blocker affecting goal — **leftover open:** folio money role-mask; notes/group/company thin; docs/events/rate role-gate

### True blockers

Missing HMS credentials, flock held >15m after wait, external outage, safety conflict, inability to record WebM after recorder RCA exhausted.

## Execution Mode

Autonomous. Resume first incomplete. No routine checkpoints. REQUIRED: overnight-autonomous-zero + pilot-RDS safety.
## Priority order

1. Expand corpus 29→100  
2. Quote ≥10 unique + driver  
3. A1 stayId/bind/rate ≥10 unique  
4. Folio/notes ≥10 unique production path  
5. Docs mail % + HMS role-gate WebM if needed  
6. Group/event/company  
7. Surname unlocker + channel live  
8. Gold score + zip handoff  

## Prior slice (do not redo)

`.private/hms-read-close-2h-20260915/` — quote 6/6 burn, A1 core keys, channel unit, docs recipe split.

## File map

| Path | Role |
|------|------|
| `.private/gold-fact-backtest-100/` | Expanded corpus |
| `.private/hms-read-100-20260915/` | Digests, WebMs, zip, HANDOFF |
| `scripts/hms-read-close-2h-burn.mjs` | Extend → 100-pack soft-open verifier |
| `scripts/hms-hitl-ui-record.mjs` | UI-first WebM |
| `scripts/hms-gate-record-block-videos.mjs` | Role-gate / fail WebMs |
