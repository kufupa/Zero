---
title: "feat: Real Zimbra mail cutover for navaai@"
type: feat
status: active
date: 2026-07-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-brainstorm
origin: ce-brainstorm session 2026-07-22 (navaai@ cutover; VPN ALWAYS_ON_OK assumed)
gstack_eng_review_scope: full-as-written
---

# feat: Real Zimbra mail cutover for navaai@

> **For agentic workers:** Prefer `superpowers:subagent-driven-development` or `/ce-work`. Product Contract IDs (R/A/F/AE) are authoritative for behavior.

**Product Contract preservation:** Enriched in-place from brainstorm confirmation — Product Contract unchanged after write; Planning Contract added below.

**Eng review Step 0:** Scope accepted **as written (B)** — full identity rename + runbook updates; do not silently shrink.

**Eng review decisions locked:** D2-A env writer fix; KD4 permanent `.env`; D3 wipe+reseed; D4 keep POP3 DELE; D5-A grep gate; D6-A full test package; **D7-A** outside-voice P0/P1 folded in. **Testing posture:** prefer more automated coverage over implementer speed — production pilot DB + AI-written code; never offer “skip tests to go faster.”

## Goal Capsule

**Objective:** Run EC2 mail pilot on real Zimbra for `navaai@legacyhotels.co.za` — external inbound + app outbound + POP3 ingest + AI triage — with drafts off.

**Product authority:** This Product Contract (session-settled decisions below).

**Open blockers:** Mailbox password must exist in local gitignored file before EC2 env write (human pastes). POP3/SMTP port/TLS exact values probed at activate time if defaults fail.

---

## Summary

Flip production EC2 from `MAIL_TRANSPORT_MODE=fixture` to `real` against hotel Zimbra (`172.24.0.10`), using mailbox **`navaai@legacyhotels.co.za`** as the primary internet-reachable ingest + send identity. Prove one external inbound and one app outbound; triage may land in spam without Centurion header rules. Always-on VPN already green. **Banner/Rocketseed is out of this plan entirely** (no unit, no TODO, no later step here). Secrets Manager for mail also out.

---

## Product Contract

### Problem Frame

Fixture/wire loops proved the app path, but hotel mail is still mocked. IT delivered Zimbra access via VPN (always-on OK) and mailbox `navaai@legacyhotels.co.za`. Without a real cutover, Nava cannot ingest BCC/external mail or send from the hotel domain. Old runbooks centered on hidden aggregate `nava@legacyhotel.com` (not internet-reachable, BCC-only) — that model is superseded for this pilot.

### Actors

| ID | Actor | Notes |
|----|-------|-------|
| A1 | Nava operator (Ansh / agent) | Pastes password; sends external test; runs activate/smoke |
| A2 | `navaai@legacyhotels.co.za` mailbox | Real Zimbra POP3/SMTP identity |
| A3 | EC2 mail pilot | Ingest worker + HTTP + AI worker on always-on VPN |

### Requirements

- **R1.** Seed/docs/env treat **`navaai@legacyhotels.co.za`** as the **sole POP3 ingest sink** and the Nava transport email (replacing `nava@legacyhotel.com`). Centurion remains a **separate logical transport** in Postgres (`centurion@…`), not a second POP3 account.
- **R1b.** Inbound fan-out is **in-app only**: worker drains `navaai@` once; `X-Zero-Mailbox` (or direct-To → spam) selects which `mailbox_transport` inbox stores the message. No second POP3 for Centurion.
- **R2.** POP3 + SMTP credentials for that mailbox live in EC2 `apps/server-pilot/.env.production` as the **long-term** secret store for this single-box pilot (not Secrets Manager for mail).
- **R3.** After activate: `MAIL_TRANSPORT_MODE=real`, POP3 `worker` running, **`AI_DRAFTS_ENABLED=false`**, **`AI_WRITE_GATE_ENABLED=true`** (durable triage writes on; drafts off).
- **R4.** External internet senders can deliver to `navaai@`; one human external test email is a success proof.
- **R5.** App can SMTP-send (From/`navaai@`) via Zimbra `172.24.0.10` (not Rocketseed this wave).
- **R6.** POP3 worker ingests new mail → S3/Postgres → enqueues `inbound_triage`; landing in spam/unmapped **counts as pass** without `X-Zero-Mailbox` rules. **Keep today’s POP3 DELE-after-ingest** (standard client drain).
- **R7.** No secrets committed to git; local password file gitignored; never echo password in SSM argv.
- **R8.** One-time pilot **RDS** wipe of legacy test data only (not a change to Zimbra retention policy — Zimbra retention is DELE-after-ingest as today).

### Key Decisions

- **KD1 — Replace ingest identity** `(session-settled: user-directed — chosen over keep-old-name / dual-name):` `navaai@legacyhotels.co.za` replaces `nava@legacyhotel.com` for ingest/Nava transport; Centurion persona fixture emails (`centurion@`, `manager@`, etc.) stay until header-routing wave.
- **KD1b — Single POP3, multi transport** `(session-settled: user-approved — eng-review):` Only ever POP3 `navaai@`. Centurion (and future inboxes) are extra `mailbox_transport` rows; hotel BCC+`X-Zero-Mailbox` stamps choose the local inbox. Dual appearance of one MIME in two inboxes is out of scope.
- **KD1c — Wipe pilot RDS before reseed** `(session-settled: user-directed — chosen over upsert-rename / leave-old-rows):` One-time cleanup of **legacy testing rows** in Postgres (old `nava@` era). After wipe: migrate + `seed:prod`.
- **KD1d — Keep POP3 DELE after ingest** `(session-settled: user-directed — chosen over leave-on-server):` Do **not** change worker drain behavior. After S3+PG success, DELE on Zimbra as today (normal client). App retains copies in RDS/S3; Zimbra `navaai@` is the sink that gets drained. View mail in the **Nava app**, not as a long-lived Zimbra inbox.
- **KD2 — Smoke cutover scope** `(session-settled: user-directed — chosen over smoke+banner / full hotel-prod):` Zimbra real path only; Rocketseed banner deferred.
- **KD3 — Stay real after green** `(session-settled: user-directed — chosen over park-to-fixture):` leave `real` + worker on; drafts off.
- **KD4 — Env-on-disk for mail (permanent, single-box)** `(session-settled: user-directed — chosen over Secrets-Manager-first / wave-only):` POP3/SMTP passwords live only in EC2 `.env.production` (`chmod 600`). Trusted pilot box; multi-host later would revisit. DB URL may still use SM. Mitigations: single writer `write-ec2-env.sh`, never password in SSM argv (S3/file stage), no `.env` in git/snapshots share, no `set -x` around secrets.
- **KD5 — Internet-reachable mailbox** `(session-settled: user-directed — chosen over internal-only BCC model):` supersedes old “`nava@` must not be internet-reachable” for this pilot.
- **KD6 — VPN prerequisite** `(session-settled: user-approved):` assume always-on OpenVPN already `ALWAYS_ON_OK`; mail plan does not re-do VPN.

### Key Flows

- **F1. Activate real mail** — Password staged → **export into shell env** → `activate-real-mail` smokes POP3 auth + SMTP **auth** → `write-ec2-env` persists (incl. gates) → deploy → worker on.
- **F2. External inbound proof** — A1 sends from external account → Zimbra → POP3 cycle → triage job → visible in app (inbox or spam).
- **F3. App outbound proof** — App `mail.send` as `navaai@` → Zimbra SMTP → deliver (self or external); optional self-send also exercises ingest.

### Acceptance Examples

- **AE1.** After activate, port probe + POP3 auth + SMTP **auth** OK to `172.24.0.10`; `MAIL_TRANSPORT_MODE=real` in `.env.production`.
- **AE2.** External test subject visible in app after ≤2 poll cycles (or one-shot worker); triage run with **durable write** exists; spam OK.
- **AE3.** App send returns success; message leaves via Zimbra (not fixture FakeSmtp).
- **AE4.** `git status` shows no password/secret files staged; `AI_DRAFTS_ENABLED=false` and `AI_WRITE_GATE_ENABLED=true` on EC2.
- **AE5.** MX preflight: `dig`/`nslookup` for `navaai@legacyhotels.co.za` MX path documented PASS, or FAIL with self-send substitute used for AE2.

### Scope Boundaries

**In:** Identity rename (seed + tests + runbooks pointing at Nava ingest), env wiring, activate/smoke, one external + one app send proof, draft-off stay-real.

**Out / deferred:**

- Rocketseed / banner SMTP (`172.24.0.8`)
- Secrets Manager for mail POP3/SMTP (explicitly **not planned** for this single-box pilot; env-on-disk is the store)
- IT Centurion BCC + `X-Zero-Mailbox` multi-user routing (**required later** so Centurion inbox fills from the same `navaai@` POP3 sink — not a second POP3)
- Second POP3 account for Centurion (anti-pattern — rejected)
- Always-on VPN install (already done)
- Infor / Send-As Centurion
- Making ops login email (`nava-ops@…`) match `navaai@` (app auth vs mailbox — separate unless activate requires it)
- Multi-instance credential sync (out until >1 box)
- Same message landing in two transports without two stamps/copies

### Assumptions

- Always-on VPN keeps `172.24.0.0/16` routed; SSM/STS still healthy.
- Same password works for POP3 and SMTP on Zimbra for `navaai@`.
- Default ports: try POP3S **995** (fallback 110), SMTP **587** (fallback 25); TLS flags match Zimbra.
- External MX for `@legacyhotels.co.za` delivers to hotel Zimbra for `navaai@`.

### Outstanding Questions

- Exact POP3/SMTP port/TLS — resolve by probe (or fixed defaults) during activate.

---

## Planning Contract

### High-Level Technical Design

```text
Zimbra POP3 navaai@ ONLY ──worker──► parse
                                      │
                    X-Zero-Mailbox? ──┼── centurion@… → transport-centurion inbox
                                      ├── navaai@…    → transport-nava inbox
                                      └── (none)+To navaai@ → Nava SPAM (smoke OK)

A1 password file → stage → **export POP3/SMTP pass + SMTP_USER** → activate smoke → write-ec2-env → deploy
Pilot DB: **MANDATORY WIPE** → migrate → seed:prod (gate: refuse seed rename without wipe marker)
```

Reuse existing `createPop3Client` / `RealSmtpTransport` / `activate-real-mail.sh` / `write-ec2-env.sh`. Primary code change is **identity constants + docs + wipe script + env-writer gates**, not a second poller.

### Key Technical Decisions

- **KTD1 — Reuse activate path** — Extend/parameterize existing `scripts/activate-real-mail.sh` + `deploy/write-ec2-env.sh` for env-password mode; do not invent a second activator.
- **KTD1b — Complete env writer (eng-review D2-A + D7 P0)** — `write-ec2-env.sh` must `append_env`:
  - `SMTP_PASSWORD`
  - `AI_DRAFTS_ENABLED` (false for this cutover)
  - `AI_WRITE_GATE_ENABLED` (true for this cutover — durable triage; default in `env.ts` is false and would silently skip writes)
  Cover all three in `deploy-config.test.ts`. Without this, activate smoke can pass then prod outbound/triage config is wrong after rewrite.
- **KTD1c — Stage → export → smoke → write (D7 P0)** — `stage-navaai-mail-env.sh` must leave `POP3_PASSWORD`/`SMTP_PASSWORD` in the **shell environment** (and/or a root-only file that activate sources) **before** activate’s auth smoke. Activate currently smokes **before** `write-ec2-env`; sourcing an empty/old `.env.production` must not wipe staged secrets. Document order in smoke runbook.
- **KTD1d — SMTP auth smoke + SMTP_USER (D7 P1)** — Replace EHLO-only `transporter.verify()` with authenticated verify using `SMTP_USER=navaai@legacyhotels.co.za` + `SMTP_PASSWORD`. Set `SMTP_USER` explicitly in activate defaults and env writer.
- **KTD1e — Port probe loop (D7 P1)** — Before auth smoke, probe POP3 candidates `995` then `110`, SMTP `587` then `25` (TLS flags match winner); fail closed if none accept.
- **KTD1f — Wipe gates seed (D7 P0)** — U1b wipe is **mandatory** before first `seed:prod` with `navaai@` constants on a DB that ever had `nava@`. Activate/smoke runbook refuses cutover if wipe not confirmed in session (or wipe marker file).
- **KTD1g — Post-wipe Zimbra backlog (D7 P1)** — After RDS wipe, first POP3 cycles may DELE-ingest any mail still on `navaai@`. Throttle with `POP3_MAX_MESSAGES_PER_CYCLE` / one-shot; note in runbook. Empty Zimbra first only if operator wants zero backlog (optional, not required).
- **KTD1h — MX preflight (D7 P1)** — Smoke runbook runs MX/dig check for `legacyhotels.co.za` / `navaai@` before external AE2; on FAIL document blocker and use app self-send for ingest proof.
- **KTD2 — Identity scope** — Change `INGEST_EMAIL` / `NAVA_TRANSPORT_EMAIL` (and fixtures/tests that hardcode `nava@legacyhotel.com` ingest). Leave Centurion `TRANSPORT_EMAIL` personas unless a test wrongly aliases them to Nava ingest.
- **KTD3 — Zimbra for both directions** — `POP3_HOST=SMTP_HOST=172.24.0.10` this wave.
- **KTD4 — Local password skeleton** — `live real data connection/navaai-mail-pass.txt` (gitignored); operator pastes one line; stage script copies into env write without logging value.
- **KTD5 — Runbook supersession** — Update `deferred-real-mail-readiness.md` / `exchange-smoke.md` / `it-handoff-runbook.md` to document internet-reachable `navaai@` pilot model and mark old BCC-quarantine as deferred/hotel-prod-later (D7 P2 accepted with U3).

### Risks

| Risk | Mitigation |
|------|------------|
| External MX doesn't deliver to `navaai@` | AE5 dig preflight; fall back AE via app self-send + POP3; document IT MX ask |
| Wrong POP3/SMTP port | KTD1e probe loop 995/110 + 587/25 |
| Env rewrite drops AI write gate | KTD1b persist `AI_WRITE_GATE_ENABLED=true` |
| Activate smoke before env write | KTD1c stage exports password into shell first |
| Seed rename without wipe | KTD1f mandatory wipe gate |
| Post-wipe re-ingest backlog | KTD1g throttle / one-shot |
| Env password on disk / SSM leak | Accept single trusted box; chmod 600; S3 stage not argv; no snapshot share; single writer |
| Seed rename breaks fixture loopback gate | Update loopback targets + seed-contract; re-run fixture gate before real flip |
| Stay-real without header rules floods spam | Accepted; drafts off limits outbound blast |
| Multi-box later | Out of scope — revisit SM/Parameter Store if N>1 |
| Zimbra `navaai@` empties after ingest | Expected (DELE); use app inbox as source of truth |

---

## Implementation Units

### U1. Password skeleton + gitignore

**Goal:** Operator has a safe local place to paste mailbox password.

**Requirements:** R2, R7

**Dependencies:** none

**Files:**

- Create `live real data connection/navaai-mail-pass.txt` (placeholder line)
- Modify `live real data connection/.gitignore` (ignore `navaai-mail-pass.txt`, `*mail-pass*`)

**Approach:** One-line password file; FILL note in existing `FILL-ME.txt`. Never commit filled value.

**Test expectation:** none — secret staging only.

**Verification:** File exists locally; gitignore prevents add.

---

### U1b. Pilot DB wipe + reseed

**Goal:** Clear testing data so `navaai@` identity seeds cleanly; keep Centurion + Nava transports. **Mandatory** before first `seed:prod` with new identity on any DB that held `nava@` (D7 P0).

**Requirements:** R1, KD1c, KTD1f, KTD1g

**Dependencies:** none (run before activate)

**Files:**

- Create `apps/server-pilot/deploy/pilot-db-wipe.sh` (requires `CONFIRM=WIPE_PILOT_DB`; truncates mail/auth pilot tables or drops+migrates — pick safest ordered truncate against schema FKs; writes wipe marker e.g. `/var/lib/nava-pilot/last-wipe` or smoke checklist checkbox)
- Modify smoke runbook: wipe → migrate → `pnpm seed:prod` (no `--rotate` by default); refuse activate if wipe not done this cutover
- Note post-wipe Zimbra backlog: first cycles may ingest leftover `navaai@` mail — throttle / `WORKER_ONE_SHOT`

**Approach:** Destructive **Postgres** cleanup only (SSM, confirm flag). Does **not** change POP3 DELE behavior. After wipe: migrate + seed. Optional S3 raw-mime prefix cleanup for old test keys.

**Test scenarios:**

- Happy: wipe with confirm exits 0; seed:prod recreates ingest + both transports
- Error: missing `CONFIRM=WIPE_PILOT_DB` → exit non-zero, no truncate
- Safety: script refuses if `DATABASE_URL` host looks non-pilot (optional allowlist check)
- Gate: cutover runbook / activate preflight fails if wipe marker absent when migrating from legacy identity
- Unit: bash `-n` + assert script contains CONFIRM guard (deploy-config style)

**Verification:** DB has `navaai@` ingest row; `centurion@` transport still exists; old fixture threads gone.

---

### U2. Replace Nava ingest identity in seed + tests

**Goal:** Code/seed use `navaai@legacyhotels.co.za` as Nava ingest/transport email.

**Requirements:** R1, R1b

**Dependencies:** U1b preferred before prod verify; unit tests independent

**Files:**

- Modify `apps/server-pilot/src/db/seed.ts` (`NAVA_TRANSPORT_EMAIL`, `INGEST_EMAIL`, descriptions)
- Modify `apps/server-pilot/tests/seed-contract.test.ts`
- Modify fixture/loopback tests that assert `nava@legacyhotel.com` ingest (`fixture-loopback-e2e.test.ts`, related)
- Modify gate scripts referencing `nava@legacyhotel.com` as ingest To: (`deploy/ai-mail-pipeline-live-gate.sh`, etc.)

**Approach:** Constant swap + test updates. Keep Centurion `TRANSPORT_EMAIL` / `ownerHeaderValue` unchanged. Keep `nava-ops@legacyhotel.com` ops login. Re-run seed-contract + fixture-loopback before real activate.

**Execution note:** Test-first on seed-contract expectations.

**Test scenarios:**

- Happy: seed creates ingest mailbox `navaai@legacyhotels.co.za`
- Happy: Nava transport email matches ingest identity
- Regression: Centurion transport `centurion@legacyhotel.com` still seeded
- Integration: fixture loopback send→ingest still green with new address
- Gate: automated test or `deploy-config` check that fails if `nava@legacyhotel.com` appears under `apps/server-pilot/{src,tests,deploy,scripts}` (allowlist runbook “superseded” lines only if needed)

**Verification:** `seed-contract` + `fixture-loopback-e2e` green. **Grep gate (D5-A):** `rg 'nava@legacyhotel\\.com' apps/server-pilot` — zero hits in code/tests/gates except intentional superseded “old model” notes in runbooks. Centurion `@legacyhotel.com` may remain.

### Test coverage (plan paths)

```
CODE PATHS                                              USER / OPS FLOWS
[+] seed identity rename                                  [+] Cutover
  ├── [★★  PLANNED] seed-contract navaai@                   ├── [GAP] [→E2E] Wipe→seed→activate→external ingest
  ├── [★★  PLANNED] fixture-loopback-e2e                    ├── [GAP] [→E2E] App SMTP send as navaai@
  └── [GAP] grep gate as automated test                     └── [★★  PLANNED] smoke.md checklist

[+] write-ec2-env
  ├── [★   EXISTS] quotes values
  ├── [GAP] SMTP_PASSWORD appended when set
  ├── [GAP] AI_DRAFTS_ENABLED=false persisted
  ├── [GAP] AI_WRITE_GATE_ENABLED=true persisted
  └── [GAP] SMTP_USER=navaai@ persisted

[+] activate-real-mail
  ├── [★   EXISTS] POP3 auth smoke + nc on given ports
  ├── [GAP] port probe loop 995/110 + 587/25
  ├── [GAP] SMTP auth smoke (not EHLO-only)
  └── [GAP] stage exports pass before smoke

[+] pilot-db-wipe.sh
  ├── [GAP] refuses without CONFIRM
  ├── [GAP] mandatory before seed on legacy DB
  └── [GAP] seed recreates both transports

[+] worker DELE                                          [+] Error states
  └── [★★★ EXISTS] pop3-worker tests (unchanged)           ├── [GAP] missing pass file
                                                           ├── [GAP] POP3/SMTP auth fail (activate smoke)
                                                           └── [GAP] MX preflight FAIL → self-send path

COVERAGE (planned): ~8/16 paths have concrete tests | GAPS: 8 (2 E2E/live, 6 unit/script)
```

**Testing mandate (eng-review D6-A + D7-A + user):** Expand gaps into real automated checks — do not defer for speed:

- `deploy-config.test.ts`: `SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`, `SMTP_USER`, wipe CONFIRM guard strings, stage missing-pass fail-closed, activate SMTP smoke uses auth (string/assert), probe loop present
- New or extended test: identity grep gate (fail CI if `nava@legacyhotel.com` in src/tests/deploy/scripts)
- Wipe script: `bash -n` + dry-run path if feasible; CONFIRM required; wipe-before-seed documented/gated
- Live U4 smoke remains required after unit green — not a substitute for the above

D5-A + D6-A + D7-A locked.

---

### U3. Env write + activate path for plaintext password

**Goal:** Stage password into shell + `.env.production` and activate real mode without Secrets Manager. Persist AI gates correctly.

**Requirements:** R2, R3, R5, R7; KTD1b–KTD1e, KTD1h

**Dependencies:** U1, U1b, U2

**Files:**

- Modify `apps/server-pilot/deploy/write-ec2-env.sh` (`SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`, ensure `SMTP_USER`)
- Modify `apps/server-pilot/tests/deploy-config.test.ts`
- Modify `apps/server-pilot/scripts/activate-real-mail.sh`:
  - defaults `POP3_USER`/`SMTP_USER=navaai@legacyhotels.co.za`, host `172.24.0.10`
  - port probe loop before auth
  - SMTP smoke with auth (not EHLO-only)
  - preserve staged env passwords across source of `.env.production`
- Create `apps/server-pilot/deploy/stage-navaai-mail-env.sh` (export secrets for activate smoke **before** write-ec2-env)
- Modify runbooks: env-on-disk canonical; SM mail not-planned; DELE-after-ingest; MX preflight; wipe mandatory; activate sequence

**Approach:** Stage → **export** → activate (probe + POP3 auth + SMTP auth) → write-ec2-env → deploy. Worker DELE unchanged.

**Execution note:** Runtime smoke via SSM.

**Test scenarios:**

- Happy: POP3 auth OK + SMTP **auth** OK
- Happy: `.env.production` contains `SMTP_PASSWORD`, `SMTP_USER=navaai@…`, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`
- Error: missing password file → stage fails
- Safety: no password in SSM argv
- Config: `MAIL_TRANSPORT_MODE=real` after write
- Unit: `deploy-config.test.ts` asserts writer emits all of the above when set
- Unit: stage fails closed when password file missing
- Unit: activate script contains probe loop + SMTP auth (not bare `verify()` without auth)

**Verification:** Activate complete; worker online; durable triage gate on.

---

### U4. Proof runbook + handoff evidence

**Goal:** Operator can execute F2/F3 and record PASS/FAIL.

**Requirements:** R4, R5, R6

**Dependencies:** U1b, U2, U3

**Files:**

- Create `apps/server-pilot/deploy/navaai-real-mail-smoke.md`
- Create `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md` (after live run)

**Approach:** VPN → wipe **RDS only** (mandatory) → seed → MX preflight → stage env (export) → activate → external mail (or self-send) → triage durable write → app send. Mail appears in **app**; Zimbra DELE after ingest (expected). Centurion empty until IT BCC. Only POP3 `navaai@`; routing local. Live proof = AE2/AE3/AE5 (SSM + human external send) — not mocked.

**Test expectation:** none — docs + live evidence.

**Verification:** Handoff report with AE1–AE5 checked or diagnosed blocker (MX / auth / port).

---

## Verification Contract

1. Fixture gate still green after identity rename (before real flip).
2. Wipe+seed: `navaai@` ingest + Centurion transport present; old threads gone; wipe marker set.
3. VPN always-on still OK (`systemctl is-active openvpn-client@nava` or equivalent).
4. Activate: port probe OK, POP3 auth OK, SMTP **auth** OK, `MAIL_TRANSPORT_MODE=real`, worker running, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`, `SMTP_USER=navaai@…`.
5. AE5 MX preflight PASS or documented FAIL + self-send substitute.
6. AE2 external inbound (or substitute) with durable triage write.
7. AE3 app outbound success.
8. No secrets in git.

## Definition of Done

- [ ] U2 grep gate: no `nava@legacyhotel.com` left in `apps/server-pilot` code/tests/gates (D5-A)
- [ ] Writer persists `SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`, `SMTP_USER` (D2-A + D7)
- [ ] Activate: stage-before-smoke, port probe, SMTP auth smoke (D7)
- [ ] Wipe mandatory before reseed on legacy DB (D7)
- [ ] Live AE1–AE5 or diagnosed blockers

## NOT in scope (eng-review deferred)

| Item | Why deferred |
|------|----------------|
| Rocketseed / banner SMTP (`172.24.0.8`) | Out of this plan entirely (user: no build, no TODO) |
| Secrets Manager for mail POP3/SMTP | KD4 env-on-disk for single trusted box |
| IT Centurion BCC + `X-Zero-Mailbox` rules | Needs hotel IT; after smoke green |
| Second POP3 for Centurion | Anti-pattern — rejected |
| Always-on VPN install | Already `ALWAYS_ON_OK` |
| Infor / Send-As Centurion | Separate product wave |
| Ops login email rename to `navaai@` | App auth ≠ mailbox |
| Multi-instance credential sync | N=1 pilot only |
| Leave mail on Zimbra after ingest | User confirmed keep DELE |
| Full wipe DB integration test against live RDS | Script asserts + live smoke instead |

## What already exists (reuse)

| Existing | Reuse |
|----------|--------|
| `activate-real-mail.sh` | Connectivity + env flip + one-shot ingest — extend, don’t fork |
| `write-ec2-env.sh` / `deploy-ec2.sh` | Persist mode + PM2 — **extend** for missing keys |
| `vpn-route-check.sh` | Preflight hotel route |
| Always-on VPN | `ALWAYS_ON_OK` handoff 2026-07-22 |
| Real POP3/SMTP clients | `pop3-client.ts` / `smtp.ts` |
| Fixture loopback gate | Regression before flip |
| `deploy-config.test.ts` | Extend for writer/gate asserts |

## Implementation Tasks

Synthesized from eng-review findings. Checkbox as you ship.

- [ ] **T1 (P0)** — Persist AI + SMTP secrets in env writer — `write-ec2-env.sh` append `SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`, `SMTP_USER`; tests in `deploy-config.test.ts`
- [ ] **T2 (P0)** — Mandatory wipe before `navaai@` seed — `pilot-db-wipe.sh` + cutover gate
- [ ] **T3 (P0)** — Stage exports password before activate smoke — `stage-navaai-mail-env.sh` + activate order
- [ ] **T4 (P1)** — SMTP auth smoke + explicit `SMTP_USER=navaai@` — `activate-real-mail.sh`
- [ ] **T5 (P1)** — Port probe loop 995/110 + 587/25 — `activate-real-mail.sh`
- [ ] **T6 (P1)** — Identity rename + grep gate — `seed.ts` + tests + CI assert
- [ ] **T7 (P1)** — MX preflight + backlog throttle notes — smoke runbook
- [ ] **T8 (P2)** — Supersede old BCC runbooks for `navaai@` pilot model
- [ ] **T9 (P1)** — Live AE1–AE5 smoke + handoff report

## Worktree parallelization

| Step | Modules | Depends on |
|------|---------|------------|
| U1 password skeleton | `live real data connection/` | — |
| U1b wipe script | `apps/server-pilot/deploy/` | — |
| U2 identity rename | `apps/server-pilot/src/`, `tests/` | — |
| U3 env/activate | `apps/server-pilot/deploy/`, `scripts/` | U1 |
| U4 smoke docs | `apps/server-pilot/deploy/`, `docs/` | U1b, U2, U3 conceptually |

**Lanes:** Launch U1 + U1b + U2 in parallel (U2 vs U1b share little until live). U3 after U1. U4 after U2+U3 code green. **Conflict flag:** U1b and U3 both touch `deploy/` — merge carefully or sequential after U1b script lands.

**Execution order:** (U1 ∥ U1b ∥ U2) → U3 → unit green → U4 live.

## Failure modes (critical paths)

| Path | Failure | Test? | Handling? | User sees |
|------|---------|-------|-----------|-----------|
| Env rewrite omits SMTP pass | Outbound dies after reboot | T1 unit | Writer fix | Send errors |
| Env omits write gate | Triage runs, no durable write | T1 unit | Writer fix | Silent miss — **was critical** |
| Smoke before stage | Auth smoke false-neg | T3 | Stage-first | Activate fails loud |
| Seed without wipe | PK/zombie identity | T2 gate | Refuse | Seed/activate fail |
| SMTP EHLO-only | Auth never proven | T4 | Auth smoke | Later send fail |
| Wrong port | Connect fail | T5 | Probe loop | Activate fails loud |
| MX missing | External AE2 never arrives | T7 | Dig + self-send | Documented blocker |
| Post-wipe backlog flood | Many DELE ingests | Runbook throttle | One-shot | Busy first cycle OK |

## Sources & Research

- Brainstorm session 2026-07-22; VPN always-on handoff.
- Rocketseed = banner SMTP relay (deferred); not required for Zimbra cutover.
- Old BCC-quarantine model in `exchange-smoke.md` — superseded for pilot per KD5.
- Outside-voice challenge 2026-07-22 (D7-A absorbed).

---

## GSTACK REVIEW REPORT

| Field | Value |
|-------|-------|
| Skill | plan-eng-review |
| Plan | `docs/plans/2026-07-22-003-feat-real-mail-navaai-cutover-plan.md` |
| Date | 2026-07-22 |
| Status | COMPLETE — decisions locked |

### Runs

| Run | Result |
|-----|--------|
| Architecture | Findings D2–D4 locked (A/A/keep-DELE) |
| Code quality | D5-A grep gate |
| Tests | D6-A full package + no speed tradeoffs |
| Performance | No issues |
| Outside voice | D7-A accept all P0+P1 |

### Findings absorbed

| ID | Sev | Decision |
|----|-----|----------|
| D2 | P1→P0 | Writer must persist SMTP_PASSWORD + AI gates |
| KD4 | — | Env-on-disk permanent for N=1 |
| D3 | P1 | Mandatory wipe + reseed |
| D4 | P2 | Keep POP3 DELE |
| D5 | P2 | Grep gate for old `nava@` |
| D6 | — | Full test package |
| D7 | P0/P1 | AI_WRITE_GATE, stage-before-smoke, SMTP auth, SMTP_USER, port probe, wipe gate, backlog, MX |

### VERDICT

**READY TO IMPLEMENT** after operator pastes mailbox password into gitignored `navaai-mail-pass.txt`. Scope = smoke cutover as written; banner/SM/Centurion BCC remain NOT in scope.

CROSS-MODEL: outside voice absorbed via D7-A; no remaining tension on DELE or env-on-disk.

NO UNRESOLVED DECISIONS

