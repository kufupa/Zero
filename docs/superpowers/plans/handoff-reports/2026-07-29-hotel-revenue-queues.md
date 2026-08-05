# Handoff — Hotel revenue queues (Centurion retag)

**Date:** 2026-07-29  
**Branch:** `EC2-pilot` @ `6cff7686` (laptop + EC2 bundle after ops-deploy)  
**Plan:** `docs/superpowers/plans/2026-07-29-hotel-revenue-queues-implementation.md`  
**Spec:** `docs/plans/2026-07-29-001-feat-hotel-revenue-inbox-ia-plan.md`  
**Verdict:** Task 8 **done**. Task 8b voucher FP fix deployed + subset `retag-v4b` drained (4/4). Remaining concerns: SPA spot-check only.

## Deploy

```bash
git push -u origin EC2-pilot
bash apps/server-pilot/deploy/ops-deploy.sh
```

- **EC2 HEAD:** `6cff7686` (`docs: handoff nava mailbox switcher finish`)
- **Revenue-queue commits on tip:** `25126773` … `1bca9f65` (categories, triage-v4, FE sections, retag script, invent-WHO unsettle)
- Health: `{"ok":true,"service":"server-pilot"}` on `:8788`
- VPN assert: `VPN_HARD_OK`, `HOTEL_PROBE_OK`
- No migrate (schema unchanged)

## Seed (no rotate)

```bash
CONFIRM_PILOT_SEED=1 pnpm seed:prod
```

**Result:** 5 transports; `AI_MANAGED_CATEGORY_SEED_ROWS` upserted on all active transports. Centurion now has `at-risk`, `new-bookings`, `groups-events`, `ops`, `urgent` active.

## Legacy invent-WHO deactivate

```sql
UPDATE mail_category
SET is_active = false, updated_at = now()
WHERE transport_id = 'transport-centurion'
  AND slug IN ('internal','individual','group','travel-agents');
```

| slug | is_active after |
|------|-----------------|
| internal | false |
| individual | false |
| group | false |
| travel-agents | false |
| at-risk / new-bookings / groups-events / ops / urgent | true |

**Deactivated rows:** 4  
**Legacy `mail_thread_category` joins remaining:** 0

## Env (retag window)

From `/home/ubuntu/repos/zero/apps/server-pilot/.env.production`:

- `AI_WRITE_GATE_ENABLED='true'`
- `AI_DRAFTS_ENABLED='false'`

No PM2 bounce required — values already correct for real-mail mode.

## Retag (`triage-v4`)

| Phase | scanned | skipped_locked | unsettled | enqueued |
|-------|--------:|---------------:|----------:|---------:|
| dry-run | 177 | 0 | 177 | 177 |
| `--apply` (once) | 177 | 0 | 177 | 177 |

Drain: **177/177** `inbound-triage-retag-v4:*` runs `succeeded`; 0 failed.

## Post-retag audit (`dump-centurion-spam-audit.mjs`)

**Artifact on EC2:** `/tmp/centurion-spam-audit-post-retag.json` (not committed — PII)

| Metric | Value |
|--------|------:|
| Threads | 200 |
| `spam_at` threads | 41 |
| Retag triage runs | 177 |
| `no_triage` | 23 (outbound-only / no inbound trigger) |
| at-risk | 13 |
| new-bookings | 43 |
| groups-events | 10 |
| ops | 70 |
| spam (category) | 41 |
| urgent overlay | 12 |

### Sense-check (brief table)

| Check | Verdict |
|-------|---------|
| **Spam TP** — FortiMail, cold promo, BookLogic booster, donation | **PASS** |
| **Spam FP** — GuestRevu, TBO OTP, OOO-on-RFQ, FNB POP, MTA bounce | **PASS** (all `spam_at` null, routed `ops` / `new-bookings`) |
| **Queues** — one-stay→new-bookings; multi→groups-events; cancel/SLA→at-risk; handover→ops | **PASS** (spot samples) |
| **Urgent** — real SLA / arrival / cancel pressure | **PASS** (12; SynXis 48h, Booking.com guest-needs, cancellations) |

### Concerns (not blockers)

- **tvlinc availability blasts** correctly spam (cold promo).

## Task 8b — voucher spam FP fix (2026-07-29)

**Commit:** `b6dddca2` — `fix(ai): exclude agency travel vouchers from triage spam`

Prompt-only: `mail-triage.ts` Not-spam exclusion + few-shot for agency travel/booking voucher → `new-bookings` (multi-room → `groups-events`). `retag-centurion-triage.mjs` gained `--key-prefix` + `--from-domain`.

| Phase | scanned | unsettled | enqueued |
|-------|--------:|----------:|---------:|
| dry-run (`v4b` + `renniesbcdtravel.com`) | 179 | 4 | 4 |
| `--apply` | 179 | 4 | 4 |

Drain: **4/4** `inbound-triage-retag-v4b:*` `succeeded`; 0 failed.

| thread (short) | from | before | after |
|----------------|------|--------|-------|
| `2f53c984` | innocentia.mamazi@renniesbcdtravel.com | spam / spam_at set | new-bookings / spam_at null |
| `54d8044d` | innocentia.mamazi@renniesbcdtravel.com | spam / spam_at set | new-bookings / spam_at null |
| `d6842400` | documents@renniesbcdtravel.com | spam / spam_at set | new-bookings / spam_at null |
| `eb36b007` | innocentia.mamazi@renniesbcdtravel.com | spam / spam_at set | new-bookings / spam_at null |

Other `*@renniesbcdtravel.com` threads (3) already non-spam; not retagged.

Env unchanged: `AI_DRAFTS_ENABLED=false`, write gate on.

## Follow-up (optional)

1. Human SPA spot-check Centurion Inbox sections + sidebar twins (no VPN browser this session).
2. `no_triage` 23 threads are expected (outbound-only confirmations).

## Ops commands (replay)

```bash
# deploy
bash apps/server-pilot/deploy/ops-deploy.sh

# seed
bash apps/server-pilot/deploy/ssm-run-command.sh '... CONFIRM_PILOT_SEED=1 pnpm seed:prod'

# dry-run / apply subset (v4b keys — spam rennies only)
node apps/server-pilot/scripts/retag-centurion-triage.mjs --key-prefix inbound-triage-retag-v4b --from-domain renniesbcdtravel.com
node apps/server-pilot/scripts/retag-centurion-triage.mjs --apply --key-prefix inbound-triage-retag-v4b --from-domain renniesbcdtravel.com

# audit
node apps/server-pilot/scripts/dump-centurion-spam-audit.mjs --out /tmp/centurion-spam-audit-post-retag.json
```
