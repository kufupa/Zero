---
title: Centurion Outlook Sent/Received Parity (BCC Ingest)
date: 2026-09-10
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
status: active
---

# Centurion Outlook Sent/Received Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and future-proof Outlook-like Inbox vs Sent parity for `centurion@` on Nava after ItemSend Auto-BCC: hotel sends → Centurion `outbound` (Sent), guest mail → `inbound` (Inbox), threads join via preserved Message-ID / In-Reply-To — without a BCC-header classifier and without fake Forward-clone backfill.

**Architecture:** Do **not** rewrite the hotel-sent classifier (already correct in `store.ts`). Lock it with thin characterization + one folder-semantics parity test; ship one read-only parity auditor with hard regression gates; document Forward residue as unrecoverable; defer OWA/mobile server journal as capture follow-on.

**Tech Stack:** server-pilot ingest + folder-semantics, Vitest on disposable DB only, SSM read-only auditor against pilot, Classic Outlook ItemSend Auto-BCC (deployed).

## Global Constraints

- Pilot-RDS safety: never Vitest with `DATABASE_URL` → `nava-zero-mail-pilot`; never `VITEST_ALLOW_PILOT_RDS=1`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before local Vitest.
- Do not classify Sent from `bcc_addresses` (live copies have empty `Bcc:`).
- Do not reintroduce Forward / Copy-then-Send VBA.
- Do not rewrite Forward clones into Centurion outbound with fabricated Message-IDs.
- Auditor JSON: counts + rates only — no subjects, addresses, or Message-IDs in stdout committed to Git/CI logs.
- Client-authorized PII may be read locally for human ops; keep PII out of Git and web tools.

---

## Goal Capsule

Centurion on Nava mirrors Outlook folders: Inbox = has inbound, Sent = has outbound, same thread can sit in both.

Authority: pilot RDS 2026-09-10 census, `store.ts` / `folder-semantics.ts`, CE solution `docs/solutions/integration-issues/centurion-outlook-sent-forward-bcc-ingest-threading.md`, RFC 5322, MS-OXCMail Bcc.

Stop when: AE3 asserts empty-Bcc outbound; R3 folder dual-membership tested; auditor gates post-cutover Nava-from-centurion = 0 and env/routing regressions; residue + deferred journal documented; no new classifier module.

---

## Product Contract

### Problem

Pre-cutover SentItems Forward VBA produced `FW:` clones on `transport-nava` (wrong transport, inbound, new Message-IDs). ItemSend Auto-BCC now delivers the real hotel send into ingest. Need durable Sent/Received parity and regression detection — not a new classification invention.

### Actors

- Centurion Classic Outlook (ItemSend Auto-BCC)
- Nava UI Inbox/Sent on `transport-centurion`
- Ingest worker (`persistInboundMessage`)
- Ops (SSM auditor, VBA hygiene)

### Requirements

- R1. Hotel From ∈ Centurion identities, recipients not self-loopback → `transport-centurion` + `direction=outbound` (covers Outlook Auto-BCC and other paths that already reach ingest with hotel From, e.g. HMS/Rocketseed copies).
- R2. External From to Centurion → `direction=inbound`.
- R3. Thread with both inbound and outbound appears in Inbox **and** Sent (thread-level folders).
- R4. Outbound with matching `In-Reply-To` / `References` joins parent Centurion thread when parent `message_id_header` exists on that transport.
- R5. Classification MUST NOT require surviving `Bcc:` header.
- R6. PMBobo From MUST NOT be treated as Centurion hotel-sent unless it is in Centurion transport identity set (today: not — stays inbound / separate).
- R7. Historical Forward clones MUST NOT be Message-ID-rewritten into Centurion Sent.
- R8. Future Auto-BCC keeps working given `INGEST_REQUIRE_OWNER_HEADER=false` + Centurion aliases seeded + VBA intact.
- R9. Honest backfill only: original Sent Items `.eml` catch-up if hotel exports real Message-IDs; else residue stays residue.
- R10. Capture gaps (OWA/mobile/other PCs without VBA) are **out of classification scope** — deferred server journal; auditor may report HMS vs Outlook MID shapes as informational only.

### Acceptance examples

- AE1. From=centurion, To=guest, no Bcc header → Centurion outbound; Sent; no inbound_triage.
- AE2. From=guest, To=centurion → Centurion inbound; Inbox.
- AE3. Inbound then hotel reply with IRT → same `thread_id`; thread in Inbox and Sent.
- AE4. Legacy FW clone To=navaai on Nava → residue; never promoted to Centurion Sent.
- AE5. Post-cutover: zero new `from=centurion*` rows on `transport-nava` (FW or not).

### Out of scope (deferred, non-blocking)

- Server-side Rocketseed/Exim journal for OWA/mobile (follow-on ticket).
- Outlook `Thread-Index` backup.
- Changing Centurion→Centurion self-loopback from inbound → outbound.

---

## Planning Contract

### Key technical decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Keep inline `isHotelSent` in `store.ts` — **no extract module** | Ponytail: already one caller; AE3 locks behavior. Eng interface drift avoided. |
| D2 | No BCC-presence / `receivedFor` Sent gate | Headers stripped; From-identity rule sufficient |
| D3 | Thin characterization only (extend AE3 + R3 folder test + R6 PMBobo) | Completeness without new abstraction |
| D4 | No Message-ID rewrite backfill of FW clones | RFC forward = new message; clones already off Centurion Sent |
| D5 | One read-only auditor with **hard** gates + informational metrics | Eng: confidence deliverable; Ponytail: not a vanity dashboard |
| D6 | Prefer extending patterns near `count-centurion-outbound-daily.ts` over inventing parallel SQL dialects | Avoid divergent ops SQL |
| D7 | Server journal = deferred named follow-on | Capture ≠ classification |

### Evidence snapshot (pilot RDS, SA day ≈ 2026-09-09T22:00Z → now)

| Signal | Value |
|--------|-------|
| Centurion outbound | 69 (62 Outlook MID `$@legacyhotels.co.za`, 7 HMS `@mail.legacyhotels.com`) |
| Centurion inbound | 176 |
| Outbound with `bcc` containing navaai | 0 |
| Nava FW-from-centurion today | 0 |
| Post-cutover Nava from centurion (any subject) | 0 |
| Post-cutover IRT → same-thread parent | 84 / 87 (~96.6%) |
| Pre-cutover 14d Nava FW residue | 69 |
| Distinct Sent threads today | 51 |

### Current path (keep — do not reinvent)

```
ItemSend Auto-BCC → single SMTP (same Message-ID)
  → POP3 ingest-nava-legacy
  → findDirectToTransport(To=guest) miss
  → findCenturionEquatedTransport(From=centurion) → transport-centurion
  → isHotelSent (From ∈ identities ∧ ¬self-loopback) → outbound
  → resolveThreadId(IRT-first References walk)
  → UI: Sent = exists outbound; Inbox = exists inbound
```

### Assumptions

- A1. EC2 `.env.production` keeps `INGEST_REQUIRE_OWNER_HEADER=false` (code default when unset is **strict true** — drift is a live failure mode).
- A2. ItemSend Auto-BCC remains on Centurion Classic Outlook workstations.
- A3. Centurion aliases include `centurion@legacyhotels.co.za`.

### Sequencing

1. Extend AE3 empty-Bcc assert + R3 folder-semantics test + R6 PMBobo case.
2. Ship thin parity auditor (hard gates below).
3. Append residue + ops + deferred journal to existing solutions doc (no second checklist doc).
4. Optional: Sent Items EML catch-up only if hotel provides originals (separate ops run, not this plan's code).

### Risks

| Risk | Mitigation |
|------|------------|
| BCC-header classifier temptation | R5 + AE3 empty-Bcc assert |
| Vitest on pilot | Safety rule + auditor is non-test script |
| Fake FW backfill | R7/R9; no promote path |
| `INGEST_REQUIRE_OWNER_HEADER` flips true | Auditor hard-fails / warns on env ≠ false |
| Forward VBA relapse | Auditor hard-fails on any post-cutover Nava-from-centurion |
| Overclaiming OWA parity | R10; informational HMS MID segment only |

### Review reconciliation

| Source | Finding | Disposition |
|--------|---------|-------------|
| Eng C1 | Auditor underspecified | **Accepted** — Appendix A auditor spec |
| Eng C2 | U1 return-type drift | **Accepted via delete** — no extract (ponytail) |
| Eng C3 | R3 untested | **Accepted** — Task 1 folder-semantics test |
| Eng C4 | Routing half-missing | **Accepted** — auditor counts all Nava-from-centurion; AE5 |
| Eng C5 | Owner-header env trap | **Accepted** — auditor env gate |
| Eng C6 | HMS unbounded | **Accepted** — R10 informational segment; not hard fail |
| Eng I1 | Empty-recipients edge | **Accepted** — do not characterize as desired product; leave inline behavior |
| Ponytail | Delete hotel-sent extract | **Accepted** |
| Ponytail | Delete new auditor entirely | **Rejected** — eng completeness: one thin gated script required for R8 confidence |
| Ponytail | Shrink U2/U4/U5 | **Accepted** |

---

## Implementation Units

### U1. Characterization + folder parity (no classifier rewrite)

**Files:**
- Modify: `apps/server-pilot/tests/ingest-store.test.ts` (AE3 assert `bccAddresses === []`)
- Create: `apps/server-pilot/tests/folder-semantics.test.ts` (none exists today)
- Modify: `apps/server-pilot/tests/ingest-store.test.ts` — PMBobo From case (R6)

**Interfaces:** none new — uses existing `persistInboundMessage` + `buildMailFolderConditions`.

**Produces:** CI proof for R3, R5, R6 without new modules.

### U2. Read-only Centurion sent-parity auditor

**Files:**
- Create: `apps/server-pilot/scripts/audit-centurion-sent-parity.ts` (tsx, peer of `count-centurion-outbound-daily.ts`)
- Spec: Appendix A below

**Hard fail (exit 1) when any true:**
1. `navaFromCenturionPostCutover > 0`
2. Live EC2 env read path: `INGEST_REQUIRE_OWNER_HEADER` parses true (when script run on EC2 with production env)
3. Optional strict mode: `irtJoinRate < 0.90` on post-cutover outbound-with-IRT sample (default **warn only** — 84/87 baseline; References noise exists)

**Informational only (never fail alone):** Outlook vs HMS MID shape counts; empty-bcc rate on Centurion outbound; historical FW residue count; outbound volume vs prior 7d median.

### U3. Solutions-doc residue + ops (single surface)

**Files:**
- Modify: `docs/solutions/integration-issues/centurion-outlook-sent-forward-bcc-ingest-threading.md`

**Content (~8–12 bullets):**
- Residue: pre-cutover Nava FW clones are not Centurion Sent pollution; do not Message-ID-rewrite.
- Ops: keep ItemSend BCC; never SentItems Forward; `INGEST_REQUIRE_OWNER_HEADER=false` on EC2; run auditor weekly via SSM.
- Deferred follow-on title: `Centurion server-side sent journal (Rocketseed/Exim) for OWA/mobile/non-VBA` — acceptance: same ingest hotel-sent contract without desktop macro.
- Prefer **envelope journaling** (or SMTP-path silent copy that preserves original Message-ID / IRT) over transport-rule BCC-to-inbox or Forward clones. Transport-rule BCC to an archive mailbox often looks inbound (RCPT=archive) and can miss per-recipient BCC forks; do not classify Sent from archive `To:`/`Delivered-To:` alone. Exchange org headers (`MessageDirectionality: Originating`, etc.) are useful if present — Centurion POP3 path today relies on hotel-From `isHotelSent`, not those headers.

---

## Verification Contract

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter server-pilot exec vitest run tests/ingest-store.test.ts tests/folder-semantics.test.ts
# (adjust path if folder-semantics tests live elsewhere — discover via rg buildMailFolderConditions)
```

Pilot (SSM, read-only):

```bash
# remote on EC2 app host, after sourcing .env.production
npx tsx scripts/audit-centurion-sent-parity.ts
# Expected: exit 0; navaFromCenturionPostCutover=0; INGEST_REQUIRE_OWNER_HEADER=false
```

Manual UI: pick one mixed thread_id from auditor-adjacent query → visible in Centurion Inbox and Sent.

---

## Definition of Done

- R1–R10 satisfied or deferred with named ticket text in solutions doc.
- No `hotel-sent.ts` extract module.
- AE3 empty-Bcc + R3 folder dual-membership + R6 PMBobo tests green on disposable DB.
- Auditor Appendix A implemented; SSM run exit 0 on current pilot.
- Solutions doc updated; no fake backfill code.
- Paired review findings reconciled (table above).

---

## Writing-plans tasks (TDD)

### Task 1: AE3 empty-Bcc + R6 PMBobo + R3 folder dual-membership

**Files:**
- Modify: `apps/server-pilot/tests/ingest-store.test.ts`
- Create: `apps/server-pilot/tests/folder-semantics.test.ts`
- Fixture reuse: `apps/server-pilot/tests/fixtures/centurion-hotel-sent.eml` (already Bcc-stripped — do **not** add a second fixture)

**Interfaces:**
- Consumes: existing persist helpers / DB test harness
- Produces: assertions only

- [ ] **Step 1: Write failing asserts**
  - AE3: after persist hotel-sent, `row.bccAddresses` deep-equals `[]`.
  - R6: From=`pmbobo@legacyhotels.co.za` (or fixture address not in Centurion identities) to external → `direction === 'inbound'` (or quarantine/routing per current seed — assert **not** hotel-sent outbound via Centurion identity rule).
  - R3: insert thread with one inbound + one outbound message → `buildMailFolderConditions(..., 'inbox')` and `'sent'` both match that `thread_id`.

- [ ] **Step 2: Run**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter server-pilot exec vitest run tests/ingest-store.test.ts tests/folder-semantics.test.ts
```

Expected: FAIL on new asserts if not yet present; discover exact folder-semantics test path with `rg -n buildMailFolderConditions apps/server-pilot/tests`.

- [ ] **Step 3: Implement minimal test setup only** — no production code unless a real bug surfaces.

- [ ] **Step 4: Re-run** — Expected: PASS

- [ ] **Step 5: Commit** (only when user requests)

### Task 2: Parity auditor script

**Files:**
- Create: `apps/server-pilot/scripts/audit-centurion-sent-parity.ts`

**Interfaces:**
- Env: `DATABASE_URL` (EC2 only), `CUTOVER` default `2026-09-09T09:50:00.000Z`, `SINCE` optional day window, `IRT_JOIN_FAIL=0|1`
- Stdout: PII-free JSON per Appendix A
- Exit: 0 ok; 1 hard-gate fail; 2 usage/DB error

- [ ] **Step 1: Implement SQL + gates** exactly as Appendix A (no subject/address fields).

- [ ] **Step 2: SSM dry-run** via `apps/server-pilot/deploy/ssm-run-command.sh` — Expected: exit 0 today; print counts only.

- [ ] **Step 3: Commit** (when user requests)

### Task 3: Solutions doc residue + ops + deferred ticket

**Files:**
- Modify: `docs/solutions/integration-issues/centurion-outlook-sent-forward-bcc-ingest-threading.md`

- [ ] **Step 1: Append short Residue / Ops / Follow-on subsections** (merge into Prevention; no new doc).

- [ ] **Step 2: Commit** (when user requests)

---

## Appendix A — Auditor spec

### Purpose

Detect live regressions of Centurion Sent capture/classification after Auto-BCC cutover. Not a Sent classifier.

### Queries (conceptual)

1. `navaFromCenturionPostCutover` = count `message` where `transport_id='transport-nava'` AND `lower(from_address) LIKE '%centurion%'` AND `coalesce(received_at,created_at) >= CUTOVER`.
2. `centurionOutbound` / `centurionInbound` counts for `SINCE` window on `transport-centurion`.
3. `irtJoin` = among Centurion outbound with non-null `in_reply_to` since CUTOVER: fraction where exists same-transport parent `message_id_header = in_reply_to` sharing `thread_id`.
4. `midShape` = group Centurion outbound by Outlook vs HMS vs other Message-ID suffix (informational).
5. `emptyBccRate` = fraction Centurion outbound with empty `bcc_addresses` (informational; expect ~1.0).
6. `historicalFwResidue` = Nava inbound from centurion with `subject ILIKE 'fw:%'` and `received_at < CUTOVER` (informational).
7. Env: parse `process.env.INGEST_REQUIRE_OWNER_HEADER` with same bool rules as `env.ts` — hard fail if true when script intends production audit.

### Output shape (example)

```json
{
  "generatedAt": "ISO-8601",
  "cutover": "2026-09-09T09:50:00.000Z",
  "gates": {
    "navaFromCenturionPostCutover": 0,
    "ingestRequireOwnerHeader": false
  },
  "warn": { "irtJoinRate": 0.966, "irtJoinSample": 87 },
  "info": {
    "centurionOutbound": 69,
    "centurionInbound": 176,
    "midShape": { "outlook": 62, "hms": 7, "other": 0 },
    "emptyBccRate": 1.0,
    "historicalFwResidue": 69
  }
}
```

### SSM recipe

```bash
cd apps/server-pilot/deploy
SSM_EXECUTION_TIMEOUT_SECONDS=120 bash ./ssm-run-command.sh "$(cat <<'REMOTE'
set -euo pipefail
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a; source .env.production; set +a
npx tsx scripts/audit-centurion-sent-parity.ts
REMOTE
)"
```

Never print `DATABASE_URL`. Use `postgres` max=1, connect_timeout≤30.

---

## Appendix B — /95 evidence

### Verdict

Live Auto-BCC path already classifies Centurion Sent correctly. Plan locks proof + regression gates; refuses fake backfill and BCC-header fantasy.

### Counterevidence / strongest alternative

Classify via `Delivered-To`/`Received for=navaai` — rejected as primary gate (redundant, MTA-variable). Rewrite Nava FW clones → Centurion outbound — rejected (wrong Message-ID).

### 95 threshold

Met for live BCC classification + empty Bcc. Capture coverage for non-VBA sends unresolved → R10 deferred.

### Sources

- Local: `apps/server-pilot/src/mail/ingest/store.ts`, `folder-semantics.ts`, CE solutions doc, pilot RDS census 2026-09-10
- https://www.rfc-editor.org/rfc/rfc5322
- https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/db4548ad-9075-415d-876a-0b88d1a8852e
- https://learn.microsoft.com/en-us/answers/questions/4543688/rules-redirect-action-should-follow-mail-standards
- https://www.rfc-editor.org/rfc/rfc9228

### Route used

local + Exa basic + subagents (eng + ponytail + ingest explore)

---

## Review disposition

- gstack-plan-eng-review: **WITHHOLD → reconciled** (Appendix A + R3/R6/env/routing gates added; extract dropped)
- ponytail-review: **net −extract/−fixture/−checklist duplication accepted**; thin auditor retained against eng completeness floor
- Unresolved true blockers: none for this plan’s scope. Deferred: server-side journal capture.
