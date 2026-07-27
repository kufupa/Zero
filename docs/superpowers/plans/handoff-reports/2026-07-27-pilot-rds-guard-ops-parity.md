# Handoff — pilot RDS vitest guard + ops parity

**Date:** 2026-07-27  
**Branch:** `EC2-pilot` @ `60c5c867` (laptop); EC2 bundle HEAD `af19955d` (pre–Task-7 docs commit; re-sync after handoff commit)  
**Plan:** `docs/superpowers/plans/2026-07-27-pilot-rds-test-guard-and-ops-parity.md`  
**Spec:** `docs/plans/2026-07-27-003-fix-pilot-rds-test-guard-and-ops-parity-plan.md`  
**Verdict:** Tasks 1–7 **done**. Pilot RDS refuse guard live; rehydrate committed; fixtures deactivated; SQL + ops smoke green. SPA UI spot-check **skipped** (no VPN this session).

## What landed

| SHA | Summary |
|-----|---------|
| `e67bc111` | Pure `pilot-rds-guard` helper + unit tests (fake URLs only) |
| `88e6937a` | Vitest `setupFiles` refuse + `test-db.ts` assert before connect |
| `31401824` | Gate scripts export `VITEST_ALLOW_PILOT_RDS=1`; wipe solution doc |
| `af19955d` | S3 raw-MIME `rehydrate-raw-mime` + `skipAiEnqueue` persist flag |
| `60c5c867` | Fixture deactivate SQL + post-guard smoke section in `navaai-real-mail-smoke.md` |

**EC2 sync SHA (verified Task 7):** `af19955d` — guard files, rehydrate script, smoke doc present on box.

**Fixture deactivate (Task 6 / AE4):** `active_example = 0`; Centurion + Nava `is_active = true`.

## SQL counts snapshot (2026-07-27 ~16:53 UTC+1, pilot RDS via EC2 psql)

### Active transports

| email | is_active |
|-------|-----------|
| `centurion@legacyhotels.co.za` | true |
| `navaai@legacyhotels.co.za` | true |
| `nava-0d03ffcb@example.com` | false |
| `nava-9efba301@example.com` | false |
| `replay@example.com` | false |

### Message volume by transport

| email | direction | count |
|-------|-----------|------:|
| `centurion@legacyhotels.co.za` | inbound | 248 |
| `centurion@legacyhotels.co.za` | outbound | 22 |
| `navaai@legacyhotels.co.za` | inbound | 15 |
| `*@example.com` fixtures | inbound | 3 (orphans; leave) |

Centurion inbound **≫ 0** (rehydrate + promote recovery held).

### Quarantine residuals

| reason | count |
|--------|------:|
| `missing_owner_header` | 4 |
| `unknown_transport` | 2 |

**Assessment:** `missing_owner_header` rows are poison/non-equated only (no bulk equated Centurion BCC). Same class as overnight handoff R5 residuals; count +1 vs promote night (new inbound since). `unknown_transport` (2) pre-existing / non-Centurion routing — leave.

### Newest Centurion subjects (sample)

- FW: The Centurion Hotel_Confirmation Letter_Kevin Douglas  
- Scans  
- Expedia Group Ranking Booster tool…  
- New Corporate Distribution Channel Added: ehotel…  
- Quarantine Summary: [ 2 message(s) quarantined…  
- The Centurion Hotel has received a Post-Stay survey response  
- winter green  
- RE: [EXT] The Centurion Hotel_Confirmation Letter_Shantele M…  
- The Centurion Hotel_Confirmation Letter_Alexandra Morley (×2)

Subjects non-empty; restored mail visible in DB.

## Ops checklist (AE5)

| Check | Result |
|-------|--------|
| `curl -sS http://127.0.0.1:8788/health` | `{"ok":true,"service":"server-pilot"}` |
| PM2 `http` / `worker` / `ai-worker` | all **online** (~3h uptime) |
| `INGEST_REQUIRE_OWNER_HEADER=false` | yes |
| `MAIL_TRANSPORT_MODE=real` | yes |
| `AI_WRITE_GATE_ENABLED=true` | yes |
| SPA VPN: Centurion folder subjects | **skipped** — no VPN; SQL subjects suffice |
| SPA VPN: Nava direct-To tests | **skipped** — no VPN |
| Live equated Centurion BCC → not quarantine | **deferred** — needs human + real send |

## Local regression (Task 7)

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/pilot-rds-guard.test.ts tests/rehydrate-raw-mime.test.ts
```

**Result:** 2 files, 11 tests **PASS**.

## Residual / deferred

1. **Testcontainers** disposable DB for full server-pilot suite — not in this plan  
2. **CASCADE delete** of deactivated `*@example.com` transports + 3 orphan fixture messages — explicitly out of scope  
3. **Zimbra stamp/strip** (IT Rule A/B) — still deferred  
4. **`rehydrate-raw-mime --triage`** bulk enqueue — not run; default remains `skipAiEnqueue`  
5. **SPA human spot-check** — run on VPN when convenient  
6. **Live BCC smoke** — one equated Centurion BCC while flag false; confirm lands Centurion not `missing_owner_header`  
7. **EC2 bundle re-sync** after Task 7 handoff doc commit (`60c5c867` → tip)  
8. **`git push` origin** if laptop branch ahead of remote

## Pointers

- Wipe RCA + guard usage: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`  
- Ops smoke + fixture SQL: `apps/server-pilot/deploy/navaai-real-mail-smoke.md`  
- Unstamped Centurion overnight (prior incident): `docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md`  
- Implementation plan: `docs/superpowers/plans/2026-07-27-pilot-rds-test-guard-and-ops-parity.md`

## Frozen decisions (unchanged)

- Pilot host marker: `nava-zero-mail-pilot`; opt-in `VITEST_ALLOW_PILOT_RDS=1` for gate scripts only  
- Scoped vitest: `cd apps/server-pilot && pnpm exec vitest run <files>` — never `pnpm --filter @zero/server test -- …`  
- Fixture cleanup: `is_active=false` only  
- Rehydrate: triage-off by default; S3 `raw-mime/` is durable archive after POP3 DELE
