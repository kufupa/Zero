# Handoff — unstamped Centurion routing + quarantine promote

**Date:** 2026-07-27  
**Branch:** `EC2-pilot` @ `ce8648cd`  
**Plan:** `docs/plans/2026-07-27-002-feat-unstamped-centurion-routing-plan.md`  
**Verdict:** U1–U4 code + EC2 flip + promote **done**. Centurion equated quarantine drained; inbound triage running. **Incident:** accidental full vitest against prod `DATABASE_URL` wiped non-quarantine message/thread rows before promote.

## Commits (U1–U3)

| SHA | Summary |
|-----|---------|
| `055f8b7e` | U1: `INGEST_REQUIRE_OWNER_HEADER` + unstamped Centurion equate in `store.ts` |
| `fd554a96` | U2: Centurion primary `centurion@legacyhotels.co.za` + aliases; seed upsert by id |
| `bb0fdb3f` | U3: `promote-quarantine` script + store `promoteQuarantineId` + tests |
| `ce8648cd` | CONCEPTS + `write-ec2-env.sh` real-mode default `INGEST_REQUIRE_OWNER_HEADER=false` |

## Deploy / EC2 (U4)

- Bundle sync → HEAD `ce8648cd`
- `ops-deploy.sh` ok; health `{"ok":true,"service":"server-pilot"}` on `:8788`
- PM2: `http` / `worker` / `ai-worker` online
- `.env.production` + PM2 env: `INGEST_REQUIRE_OWNER_HEADER=false`, `MAIL_TRANSPORT_MODE=real`, `AI_WRITE_GATE_ENABLED=true`
- `CONFIRM_PILOT_SEED=1 pnpm --filter @zero/server seed:prod` (twice: once after deploy, again after vitest wipe)

### Centurion identity (live)

| id | email | aliases |
|----|-------|---------|
| `transport-centurion` | `centurion@legacyhotels.co.za` | `centurion@legacyhotels.com`, `centurion@legacyhotel.com` |
| `transport-nava` | `navaai@legacyhotels.co.za` | — |

Fixture leftovers from botched vitest (`*@example.com`) deactivated (`is_active=false`).

## Promote

```text
# first attempt (Centurion transport missing after vitest wipe)
scanned=19 stored=0 duplicate=0 quarantined=19 errors=0

# after re-seed + deactivate fixtures
scanned=20 stored=17 duplicate=0 quarantined=3 errors=0
```

**Residual `missing_owner_header` (3) — correct R5 poison** (no Centurion To/Cc/Bcc/From):

1. Please Quote Urgently — thabatellemine ↔ purchasing  
2. Hospitality and Outdoor's Top Candidates — self To francois@…  
3. Proof of Payment — gugulethumlambo600@gmail.com self  

Not Centurion-equated; leave in quarantine.

### Post-promote SQL

```text
transport-centurion inbound=15 outbound=2
inbound_triage succeeded=15  dead_letter=1
candidate_draft claimed=1
```

Sample Centurion subjects restored: SynXis / TBO / confirmation letters / FortiMail quarantine summary / FAC quote threads / HTR OSA BLT charter.

## Incident — vitest vs prod DB

**Cause:** `pnpm --filter @zero/server test -- tests/…` ignored file filter and ran **full suite** with sourced `.env.production`. Some tests mutated outside `withTestDb` rollback (or otherwise left fixture transports + deleted pilot rows).

**Impact:**

- `message` / `mail_thread` collapsed to fixture leftovers (~3 rows) before re-seed/promote
- Pilot Centurion/Nava transports temporarily replaced by `*@example.com` until `seed:prod`
- Quarantine MIME on S3 survived → **17 Centurion-equated rows recovered via promote**
- Non-quarantine historical inbox/Sent that had already been POP3-`DELE`'d **not recoverable** from mailbox (worker shows `listed=0`; DELE already committed). S3 raw-mime may still hold older keys — **no bulk rehydrate run this night**

**Guardrail residual:** never source prod env for vitest on EC2; run focused `pnpm exec vitest run <files>` from `apps/server-pilot` only against disposable DB, or add hard refuse of RDS pilot host in `test-db.ts`.

## Tests

| Suite | Result |
|-------|--------|
| Local U1–U3 focused (prior session) | green |
| EC2 focused `env` / `ingest-store` / `seed-contract` / `promote-quarantine` | **partial RED** — promote tests see live quarantine bleed when `DATABASE_URL`=pilot |
| EC2 full suite (accidental) | many fail + **data damage** — do not repeat |

## Residual / next

1. ~~Optional: S3 raw-mime rehydrate~~ → **done** (`af19955d`; Centurion inbound 248 post-rehydrate). See [pilot RDS guard handoff](./2026-07-27-pilot-rds-guard-ops-parity.md).
2. ~~Hard-block pilot RDS host in vitest helpers~~ → **done** (`e67bc111`, `88e6937a`, `31401824`). See [vitest wipe solution](../../solutions/database-issues/vitest-production-pilot-db-wipe.md).
3. Delete deactivated `*@example.com` transports + their 3 orphan messages when safe — **deferred** (deactivate only; no CASCADE)
4. IT Rule A/B stamp/strip still **deferred**
5. Watch next live BCC: should land Centurion not quarantine while flag false — **open** (human send)
6. `git push` origin if laptop branch still ahead (EC2 has bundle only)

## Frozen decisions (unchanged)

- Stamp path unchanged when IT adds `X-Zero-Mailbox`
- Direct-To `navaai@` stays Nava; Centurion equate = To/Cc/Bcc/From vs primary+aliases
- Unknown unstamped → quarantine (R5)
- Promote one-shot only; no auto-promote on poll
