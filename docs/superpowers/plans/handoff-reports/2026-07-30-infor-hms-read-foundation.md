# Handoff — Infor HMS Read Foundation (2026-07-30)

**Branch:** `EC2-pilot` @ `c0844b0a`  
**Plan:** `docs/superpowers/plans/2026-07-30-infor-hms-read-foundation.md`  
**Deploy:** `ops-deploy.sh` green earlier; health `ok`; VPN HARD ok; `hms-ai-worker` online `lane=hms` **`HMS_DRAFT_ENRICHMENT_MODE=shadow`**  
**Fixture gate:** `hms-read-gate.sh --fixture-only` **PASS**; `pdf-text-gate.sh` **PASS**; shadow corpus **n=35** eval pass

## Tasks 0–9

| Task | Status |
|------|--------|
| 0 Evidence baseline | complete |
| 1 Lanes/budget/fencing | complete (0015 migrated on RDS) |
| 2 Thread context + evidence | complete |
| 3 Artifact/PDF reads | complete |
| 4 Request policy | complete (PolicyRoute stub Accepted) |
| 5 Runtime + discovery | complete fixture; live login discovery in progress |
| 6 Reservation + quote adapter | complete |
| 7 Claim-safe candidate agent | complete (`planModel` Accepted) |
| 8 Freshness UI / promote-send | complete |
| 9 Gates + fixture E2E + rollout wave | fixture/security/shadow green; live login+property title canary green; reservation read canary deferred on BSSTRT |

## Mode

- **`shadow`** on EC2 (metrics / claim-safe mock tools). **`enabled` still forbidden.**
- PM2 fix: `pm2.config.cjs` now passes `HMS_READ_SECRET_ARN` + chromium path into `hms-ai-worker`.

## Live canary evidence (redacted)

- IAM: `NavaZeroSecretsRead` includes `infor-hms-read-*`.
- Probe: `apps/server-pilot/scripts/hms-live-login-probe.ts` + inventory `evals/hms/live-login-inventory.v1.json`.
- Login POST `/web/base/login` → HTTP 200.
- Landed `/web/base/COMMON`, title **`Infor HMS - HRCEN`**.
- Secret `expectedPropertyCode` corrected **`centurion` → `HRCEN`** (name still Centurion Hotel).
- Fail-closed next block: **POST `/web/base/BSSTRT`** (bootstrap; body keys inventoried; not auto-allowed).

## Remaining deferred

1. **Guest Stay / reservation not-found canary** — shell (COMMON + BSSTRT) green; need dedicated nav phase under fail-closed policy (do not allow save/submit toolbar actions).
2. Replace interim shadow abstention labels with live shadow outcomes when reads exist.
3. Optional disposable-DB `--full` gate.
4. **`enabled` only after** hard+stat + reservation read canary.

## Review closeout (post-canary)

Whole-branch [review](ac67f5e7-d179-423d-8c57-d300fd1e1406) Critical/Important addressed:
- Critical: `quoteStay` property/tenant bind fail-closed (match `findReservation`).
- Important: probe submit dual-gate + view_only; keys-only fixedBody; REQ_KEY charset pin; `redactSecrets` HMS patterns; `persistDraft` default false.

## Safety

- No PMS writes. CRS Check Availability blocked. `bookable` always false.
- Promote/send hard-block stale HMS.
- Default AI worker cannot claim HMS lane; `hms-ai-worker` separate.
- Probe never logs credential values; cookie-bearing Playwright errors sanitized.

## Divergence log

- Property code live title uses **HRCEN**, not fixture `centurion`.
- Infor password field is `type=text` name=`password`.
- Shadow worker initially crashed: PM2 env omitted secret ARN when mode≠off — fixed in `c0844b0a`.
- `ops-restart.sh` health curl can race before http binds; retry curl succeeds.

## Key commits (rollout wave)

`30954a82` shadow n=35 · `0a9ba4ac`…`5169ace4` live probe/allowlist · `c0844b0a` PM2 HMS env
