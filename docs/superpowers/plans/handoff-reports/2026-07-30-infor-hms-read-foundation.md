# Handoff — Infor HMS Read Foundation (2026-07-30)

**Branch:** `EC2-pilot` @ `fdb1db5e` (+ toolbar-image allow follow-up)  
**Plan:** `docs/superpowers/plans/2026-07-30-infor-hms-read-foundation.md`  
**Deploy:** health `ok`; VPN HARD ok; `hms-ai-worker` online `lane=hms` **`HMS_DRAFT_ENRICHMENT_MODE=shadow`**  
**Fixture gate:** `hms-read-gate.sh --fixture-only` **PASS**; `pdf-text-gate.sh` **PASS**; shadow corpus **n=35** eval pass

## Tasks 0–9

| Task | Status |
|------|--------|
| 0 Evidence baseline | complete |
| 1 Lanes/budget/fencing | complete (0015 migrated on RDS) |
| 2 Thread context + evidence | complete |
| 3 Artifact/PDF reads | complete |
| 4 Request policy | complete (PolicyRoute stub Accepted) |
| 5 Runtime + discovery | complete fixture + live login/property/Guest Stay not-found |
| 6 Reservation + quote adapter | complete (fixture selectors; live wiring next) |
| 7 Claim-safe candidate agent | complete (`planModel` Accepted) |
| 8 Freshness UI / promote-send | complete |
| 9 Gates + fixture E2E + rollout wave | fixture/security/shadow green; **live Guest Stay not-found canary green** |

## Mode

- **`shadow`** on EC2 (metrics / claim-safe mock tools). **`enabled` still forbidden.**
- PM2: `HMS_READ_SECRET_ARN` + chromium path passed into `hms-ai-worker`.

## Live canary evidence (redacted)

- IAM: `NavaZeroSecretsRead` includes `infor-hms-read-*`.
- Probe: `apps/server-pilot/scripts/hms-live-login-probe.ts` + inventory `evals/hms/live-login-inventory.v1.json`.
- Login POST `/web/base/login` → HTTP 200.
- Landed `/web/base/COMMON`, title **`Infor HMS - HRCEN`**.
- Bootstrap: POST `BSSTRT` / `BSSTRT.HDR` allowed.
- Guest Stay: Front Desk → Guest Stay → POST `OSRESV` / `OSRESV.HDR` / `OSRESV.LST`.
- **Not-found search green:** fill `input[name=search]` with `NOTFOUND-CANARY` → POST **`/web/base/OSRESS.search`** allow → `listHint.hasNoResults=true`, `hasNewRecord=false`, `confirmFieldLooksCanary=true`.
- Soft-capture scripts: `hms-guest-stay-form-inventory.ts`, `hms-guest-stay-search-capture.ts`.

## Remaining deferred

1. Wire reservation adapter to live Guest Stay selectors / `OSRESS.search` (still fixture until then).
2. Replace interim shadow abstention labels with live shadow outcomes when reads exist.
3. Optional disposable-DB `--full` gate.
4. **`enabled` only after** hard+stat + production read path review.

## Review closeout (post-canary)

Whole-branch Critical/Important addressed earlier:
- Critical: `quoteStay` property/tenant bind fail-closed.
- Important: probe dual-gate + view_only; redact patterns; `persistDraft` default false.

## Safety

- No PMS writes. CRS Check Availability blocked. `bookable` always false.
- Toolbar **image GETs** may be allowed; **New/Save/Delete action POSTs** stay blocked.
- Promote/send hard-block stale HMS.
- Probe never logs credential values.

## Divergence log

- Property code live title uses **HRCEN**, not fixture `centurion`.
- Infor password field is `type=text` name=`password`.
- Guest Stay quick-search posts **`OSRESS.search`** (not `OSRESV`); filter-row DOM uses `ff_*` names.
- Declaring unused `ff_*` keys in HDR `variableBody` caused `invalid_variable_body` (variable keys are required) — removed.
- Placeholder text "Confirmation" matched `/confirm/` fallback and filled wrong field until quick-search made primary.

## Key commits (live wave)

`c0844b0a` PM2 HMS env · `db9a5918` form inventory · `fdb1db5e` OSRESS.search allow + not-found canary
