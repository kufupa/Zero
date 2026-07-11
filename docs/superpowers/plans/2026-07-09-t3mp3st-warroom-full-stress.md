# T3MP3ST War Room full stress — EC2-pilot overnight (grok-4.5)

> **For agentic workers:** REQUIRED SUB-SKILL: `overnight-autonomous-execution` + `overnight-autonomous-zero` overlay. Tooling-only changes under `tools/t3mp3st/**`; **never** modify `apps/server-pilot` or `apps/mail`.

```yaml
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
plan_depth: deep
branch: EC2-pilot
```

---

## Goal Capsule

**Objective:** Run a **full-spectrum** T3MP3ST War Room stress test against authorized EC2-pilot production surfaces (backend `:8788`, frontend `:3000`) with **all 8 operator archetypes**, Admiral LIVE planning, auto-approved capability gates, and progressive markdown reporting — **100% autonomous overnight** on **xAI grok-4.5 + reasoning_effort=high**.

**Authority hierarchy:** This plan > `tools/t3mp3st/missions/ec2-pilot-scope.md` > prior `2026-07-08-t3mp3st-warroom-overnight.md` (superseded for War Room execution posture).

**Stop conditions:**
- Done criteria all green, OR
- xAI/War Room budget exhausted after RCA attempts, OR
- Hard infra failure (EC2 down, SSM blocked, `XAI_API_KEY` invalid) after 3 RCA cycles

**Non-goals:** Production app code fixes, RDS/S3 direct attacks, third-party hosts, real cred stuffing, destructive data wipes.

---

## Product Contract

### Problem frame

Prior overnight War Room run (2026-07-08) completed kill-chain ticks but **Evidence Vault stayed 0**: only recon/scanner/analyst spawned initially, exploiter/infiltrator arrived late, **exfiltrator/ghost/coordinator never ran**, agents hit **maxIterations** before ledger promotion, and mission objectives were generic. cli-swarm white-box audit was **CLEAN** — runtime black-box stress did not happen.

User wants to wake up to a **proper** application stress test: everything War Room can throw at authorized pilot targets, documented with file:line + HTTP evidence where possible.

### Requirements

| ID | Requirement |
|----|-------------|
| R1 | War Room uses **grok-4.5** + **reasoning_effort=high** end-to-end |
| R2 | All **8 operators** spawned at mission start (not gated to recon-only) |
| R3 | **Admiral LIVE** mission with explicit EC2-pilot attack objectives (mailbox header, auth, tRPC, ingest, signed URLs, FE XSS) |
| R4 | Auto-approve all mission + capability receipts for **own** pilot instance |
| R5 | SSM tunnels → `127.0.0.1:18788` (BE) + `127.0.0.1:13000` (FE); EC2 services healthy |
| R6 | `TEMPEST_AGENT_MAX_ITERATIONS≥80`; monitor budget **≥8h** |
| R7 | Progressive findings MD + morning handoff under `handoff-reports/` |
| R8 | Optional parallel **cli-swarm regression** pass (read-only code) — does not block War Room |
| R9 | **Zero** `apps/**` modifications; tooling-only fixes if War Room fails to start |
| R10 | Morning artifact explains ran vs failed vs vault-empty RCA |

### Scope boundaries

**In scope:**
- `tools/t3mp3st/**` orchestrator upgrades
- War Room live probes against tunneled EC2 pilot
- White-box context via `repoPath` = monorepo root
- Prior audit regression cross-check (`docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md`)

**Out of scope:**
- `apps/server-pilot` / `apps/mail` code changes
- Direct RDS / S3 bucket attacks
- IT Exchange / real mailbox credentials
- Force-push, `--no-verify`, destructive git

### Deferred to follow-up work
- Re-run cli-swarm pass 2 deep sweep (only if pass 1 finds signal)
- Local `:8787` destructive exploit sandbox (separate plan if prod vault stays empty)
- Upstream T3MP3ST swarm maturity improvements (experimental exploiter chain)

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |
| Backend (prod) | `http://127.0.0.1:8788` on EC2 (PM2 `http`) |
| Frontend | `http://127.0.0.1:3000` on EC2 |
| War Room | `http://127.0.0.1:3333/ui/` (local) |
| BE tunnel | `http://127.0.0.1:18788` → EC2 `:8788` |
| FE tunnel | `http://127.0.0.1:13000` → EC2 `:3000` |

**Allowed:** SSM health/restart PM2+FE if down, War Room server, auto-approve pilot targets, cli-swarm + decompose regression, progressive markdown, vendor `tools/t3mp3st` fixes only.

**Forbidden:** force-push main, `--no-verify`, destructive git, modifying `apps/**`, attacking third-party hosts.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix (**tooling only**) → test → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log divergence in handoff report.

---

## Planning Contract

### High-level architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  overnight-warroom-full-stress.mjs (orchestrator)               │
├─────────────────────────────────────────────────────────────────┤
│  1. configure + test-llm (grok-4.5)                             │
│  2. SSM: EC2 health → port-forwards 18788/13000                 │
│  3. War Room server (:3333) + TEMPEST_AGENT_MAX_ITERATIONS=80   │
│  4. Admiral LIVE + /api/mission/start (8 operators)             │
│  5. Auto-approve loop (mission + arsenal capabilities)          │
│  6. Parallel: overnight-monitor.mjs (8h budget)                 │
│  7. Parallel: cli-swarm pass1 regression (optional, background) │
│  8. Poll vault / hypotheses / evidence → findings MD            │
│  9. Handoff MD + executive OPEN/FIXED table                     │
└─────────────────────────────────────────────────────────────────┘
         │ HTTP probes                    │ read-only grep
         ▼                                ▼
   EC2 pilot :8788/:3000            apps/server-pilot/**
   (via SSM tunnels)                (cli-swarm white-box)
```

### Kill-chain phases (War Room auto)

`reconnaissance` → `weaponization` → `delivery` → `installation` → `actions_on_objectives` → report

### Operator roster (all 8 — spawn at start)

| Archetype | Stress role on pilot |
|-----------|----------------------|
| recon | Surface map: `/health`, `/api/public/providers`, `/api/auth/*`, `/api/trpc/*`, FE routes |
| scanner | Headers, TLS, paths, misconfig, CORS, cookie flags |
| analyst | Correlate → Evidence Vault; cross-ref prior audit OPEN items |
| exploiter | Auth bypass, IDOR, XSS payloads, header injection (`X-Zero-Mailbox`) |
| infiltrator | Session/post-auth lateral, mailbox transport switching |
| exfiltrator | Prove data exposure via signed URLs, attachment paths |
| ghost | Low-noise re-checks on interesting endpoints |
| coordinator | Multi-op task sync when Admiral spawns sub-missions |

Upstream note: exploiter/infiltrator/exfiltrator are **experimental** in T3MP3ST — vault may still be thin; mission must run them anyway and document operator task output + iteration-limit RCA.

### Authorized HTTP surfaces (paste into Admiral objectives)

```markdown
Targets (tunneled):
- API: http://127.0.0.1:18788
- FE:  http://127.0.0.1:13000

Priority probes:
1. X-Zero-Mailbox header trust on inbound ingest (OPEN from prior audit) — apps/server-pilot/src/mail/ingest/parse-message.ts, store.ts
2. tRPC auth boundaries — /api/trpc/*, session cookies, mailboxProcedure
3. Better Auth — /api/auth/*, PILOT_OPEN_SIGNUP behavior
4. Signed URL + Content-Disposition attachment handling
5. HTML ingest/storage XSS regression (verify still sanitized)
6. FE mail rendering — shadow DOM / processEmailContent path
7. AI mail pipeline hooks — apps/server-pilot/src/ai/**

Constraints: authorized own EC2 pilot only; no destructive DB wipe; document evidence with request/response snippets.
```

### Key technical decisions

| KTD | Decision | Rationale |
|-----|----------|-----------|
| KTD1 | New script `overnight-warroom-full-stress.mjs` | Keeps 2026-07-08 orchestrator as reference; full-stress is explicit entrypoint |
| KTD2 | Spawn all 8 operators in `/api/mission/start` | Last run gated intrusive ops — root cause of weak stress |
| KTD3 | Admiral LIVE after manual mission start | Admiral plans kill-chain; manual start ensures operator roster |
| KTD4 | `TEMPEST_AGENT_MAX_ITERATIONS=80` | 15/40 caused iteration-limit vault empty |
| KTD5 | Monitor budget 480 min, poll 5 min | User sleeps ~8h; enough for phases + cli-swarm |
| KTD6 | grok-4.5 defaults in tooling (done) | User requested model upgrade |
| KTD7 | No `apps/**` edits | User mandate; findings → separate fix PR |
| KTD8 | Auto-approve all pending receipts | Autonomous overnight; scope limited to own pilot |

### Environment (orchestrator exports)

```bash
LLM_PROVIDER=xai
LLM_MODEL=grok-4.5
XAI_REASONING_EFFORT=high
TEMPEST_AGENT_MAX_ITERATIONS=80
TEMPEST_GENERAL_TIMEOUT_MS=600000
WARROOM_BUDGET_MIN=480
MONITOR_INTERVAL_MIN=5
T3MP3ST_WAR_ROOM_URL=http://127.0.0.1:3333
```

### Report paths

| Artifact | Path |
|----------|------|
| Progressive War Room findings | `docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-t3mp3st-warroom-findings.md` |
| cli-swarm regression (if run) | `docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-t3mp3st-cli-swarm-audit.md` |
| Morning handoff | `docs/superpowers/plans/handoff-reports/2026-07-09-t3mp3st-warroom-handoff.md` |
| Orchestrator log | `tools/t3mp3st/overnight-warroom-full-stress.log` |
| Scope | `tools/t3mp3st/missions/ec2-pilot-full-stress-objectives.md` |

---

## Implementation Units

### U1. Full-stress mission objectives file

**Goal:** Single paste-ready objective block for Admiral + mission API.

**Files:**
- `tools/t3mp3st/missions/ec2-pilot-full-stress-objectives.md` (create)

**Approach:** Extract priority probes from KTD section + prior audit OPEN items (`X-Zero-Mailbox`, auth, tRPC, signed URLs, XSS). Include repo-relative file hints for white-box context.

**Verification:** File exists; objectives mention all 7 probe areas.

---

### U2. `overnight-warroom-full-stress.mjs` orchestrator

**Goal:** One-command autonomous full War Room stress run.

**Dependencies:** U1

**Files:**
- `tools/t3mp3st/scripts/overnight-warroom-full-stress.mjs` (create)
- Reuse helpers from `tools/t3mp3st/scripts/overnight-warroom.mjs` (import or copy minimal: `loadAllEnv`, `approvePending`, `ensureSsmTunnels`, `startWarRoomServer`, `fetchJson`)

**Approach:**
1. Load `.env` → require `XAI_API_KEY`
2. `pnpm t3mp3st:configure` + `test-llm.mjs` (assert model `grok-4.5`)
3. SSM tunnel + health gates (`18788/health`, `13000/`)
4. Start War Room with `TEMPEST_AGENT_MAX_ITERATIONS=80`
5. `POST /api/mission/start` with:
   - `operators`: all 8 archetypes
   - `targets`: BE + FE tunnel URLs
   - `repoPath`: monorepo root
   - `objectives`: read from U1 file
6. Auto-approve pending (loop every 60s in background or delegate to monitor)
7. `POST /api/admiral/launch` LIVE with same targets + objectives (if mission not already Admiral-driven)
8. Spawn `overnight-monitor.mjs` with env pointing at **2026-07-09** report paths
9. Optional background: `overnight-swarm.mjs` pass1 → `2026-07-09-…-cli-swarm-audit.md`
10. On budget complete: write handoff MD with executive table (OPEN/FIXED from decompose if run)

**Execution note:** On Windows, spawn War Room via `node dist/server.js` (existing pattern in `overnight-warroom.mjs`).

**Test scenarios:**
- Dry run: script parses, env defaults include grok-4.5 and 8 operators (static grep)
- Live: `test-llm` returns `ok:true` + `model:grok-4.5`

**Verification:** `node tools/t3mp3st/scripts/overnight-warroom-full-stress.mjs` starts without throw when War Room down (or document that configure+test-llm is the preflight gate).

---

### U3. Monitor + package.json entrypoint

**Goal:** Long-run polling wired to new report filenames.

**Dependencies:** U2

**Files:**
- `tools/t3mp3st/scripts/overnight-monitor.mjs` (modify — accept `FINDINGS`/`HANDOFF`/`SWARM` via env)
- `package.json` (add `"t3mp3st:warroom:full-stress": "node tools/t3mp3st/scripts/overnight-warroom-full-stress.mjs"`)

**Approach:**
- Default env vars for 2026-07-09 paths when `WARROOM_FULL_STRESS=1`
- Monitor exit: cli-swarm complete (if launched) **AND** `WARROOM_BUDGET_MIN` elapsed **OR** vault has findings **OR** mission phase = complete
- Append operator summary each tick: phase, tick, vault counts, ops by archetype

**Verification:** `pnpm t3mp3st:warroom:full-stress` resolves in package.json.

---

### U4. Update scope doc + prior plan pointer

**Goal:** Document full-stress as authorized War Room mode.

**Files:**
- `tools/t3mp3st/missions/ec2-pilot-scope.md` (add "Full stress" section → link U1 + new script)
- `docs/superpowers/plans/2026-07-08-t3mp3st-warroom-overnight.md` (add one-line superseded-by pointer at top)

**Verification:** Scope doc references grok-4.5 and 8-operator full stress.

---

### U5. Overnight execution wave (autonomous — no user)

**Goal:** Run everything; produce morning artifacts.

**Dependencies:** U1–U4

**Approach:**

```text
Wave A — Preflight (30 min max, RCA on red)
  git diff -- apps/  # must be empty before start
  pnpm t3mp3st:configure
  pnpm t3mp3st:test-llm
  SSM: curl BE/FE on EC2; restart PM2/nginx if down

Wave B — Launch (5 min)
  export WARROOM_FULL_STRESS=1 + env block from Planning Contract
  pnpm t3mp3st:warroom:full-stress
  Confirm :3333 health, mission active, 8 operator archetypes in status JSON

Wave C — Babysit (8h)
  Monitor auto-approves capability gates
  If vault still 0 after 2h: bump TEMPEST_AGENT_MAX_ITERATIONS to 120, restart War Room, relaunch mission (tooling only)
  If xAI 401: verify baseUrl in vendor resolveGeneralLLMConfig (known fix)

Wave D — Closeout (30 min)
  Final poll: /api/findings, /api/mission/findings, /api/evidence, /api/hypotheses
  Write handoff with: ran vs didn't, vault count, cli-swarm verdict, OPEN items table
  Leave tunnels + War Room up for morning UI OR kill if user prior preference was kill (default: leave up)
```

**Verification:** Handoff file exists with timestamp + checklist.

---

## Verification Contract

| Gate | Command / check | Pass |
|------|-----------------|------|
| V1 | `pnpm t3mp3st:test-llm` | `ok:true`, `model:grok-4.5`, `reasoning_effort:high` |
| V2 | `curl http://127.0.0.1:18788/health` (via tunnel) | HTTP 200 |
| V3 | `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/` | HTTP 200 |
| V4 | `curl http://127.0.0.1:3333/health` | `ok:true` |
| V5 | Mission status JSON | `operators` includes all 8 archetypes (count ≥ 8) |
| V6 | `git diff --stat -- apps/` after run | empty |
| V7 | Findings MD | exists, >10 sections appended |
| V8 | Handoff MD | exists with executive summary |

---

## Definition of Done

- [ ] U1–U4 implemented (tooling only)
- [ ] V1–V4 green at run start
- [ ] War Room mission ran ≥4h with all 8 operators spawned at least once
- [ ] Admiral LIVE launched at least once
- [ ] Auto-approvals logged in findings MD
- [ ] Progressive findings + handoff written (`2026-07-09-*`)
- [ ] Executive table: prior audit OPEN items (`X-Zero-Mailbox`, etc.) with tonight status
- [ ] **Zero** `apps/server-pilot` / `apps/mail` diffs
- [ ] If vault empty: RCA section explains iteration limits / T3MP3ST experimental ops (not silent success)

---

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED: implement U1–U4 first (≤1h), then U5 until done criteria or budget exhausted. Do not ask "which approach?"

**Launch command (after U1–U4):**

```bash
pnpm t3mp3st:warroom:full-stress
```

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Vault stays 0 (T3MP3ST experimental downstream ops) | Bump iterations; capture raw operator task logs in findings MD; targeted manual repro notes |
| SSM tunnel drops | Monitor re-establishes; SSM health check each hour |
| xAI rate limits | Log errors; reduce concurrent swarm; continue War Room |
| False positives on prod | Scope doc + no destructive writes; findings marked unverified until triaged |
| grok-4.5 model string rejected by API | `test-llm` preflight; fallback to `grok-4` only if 404 (log + handoff) |

---

## Sources & research

- Prior run: `docs/superpowers/plans/handoff-reports/2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md`
- Prior audit: `docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md`
- T3MP3ST upstream: recon stable; downstream operators experimental
- Model: grok-4.5 + high (user request 2026-07-09)
