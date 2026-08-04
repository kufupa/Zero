# Handoff — Infor HMS Live Reservation Shadow (2026-08-01)

**Branch:** `EC2-pilot`  
**Plan:** `docs/superpowers/plans/2026-08-01-infor-hms-live-reservation-shadow.md`  
**Runbook:** `docs/infor-hms/live-reservation-shadow-runbook.md`  
**Instance:** `i-008f737974a9ba9b3`  
**DoD:** Live sequence green; plan Definition of Done ticked.

## Live proof tokens (redacted)

```text
HMS_LIVE_NOT_FOUND_OK
HMS_LIVE_ROW_FINGERPRINT_OK
HMS_LIVE_ROW_OK
HMS_SHADOW_OK
HMS_SHADOW_VERIFIED
HMS_ROLLBACK_OK
```

Zero policy-block delta; zero forbidden-row delta. No raw HMS/guest/email values in SSM/proof JSON (digests only).

## What shipped

| Area | Result |
|------|--------|
| Tasks 1–5 | Complete — safety gates, Playwright Guest Stay driver, row fingerprint, reservation-only tool session, HMS worker shadow terminal, EC2 proof CLI |
| Active tool | Only `hms_find_reservation` `1.1.0` |
| Live parse | OSRESS `GRIDRESULT` JSON rows + `dd-mon-yyyy` dates; HTML fallback retained |
| Search body | Kind-scoped OR slots (`___NOMATCH___` unused); ±365 day window for real lookups |
| Canary | Walk oldest exact Centurion candidates (len≥6); extended AbortSignal |
| Status | Health prefers `checkedAt` over `updatedAt` |
| Starter | Sole `ops-hms-shadow.sh start`; generic deploy/restart keep HMS off |

## Ops harden (post-DoD)

- `/opt/nava/shared` ensured `ubuntu`-owned on every `deploy-ec2.sh` / `install-hms-browser.sh` (no manual `chown` for proof writes).
- `ops-deploy.sh --quiesced` = assets only; **online PM2 `http` OK** (no longer refuses while Node stays up).
- `ops-hms-shadow.sh rearm` clears `hms-shadow-disabled` after intentional `stop` → `HMS_SHADOW_REARMED`.
- Runbook + ops-deploy docs updated.

## Mode / safety

- Shadow only. Literal `enabled` still forbidden.
- No draft/generation/revision rows from shadow path.
- PMS writes / CRS bookable / auto-enqueue / quote-docs-folio-group tools deferred.

## Remaining deferred

1. **Next plan (recommended):** `mail_read_artifact` — better exact candidates into `hms_find_reservation` without new PMS surface.
2. Quote / document-list / folio / group / preferences / write adapters / `enabled`.
3. Optional disposable-DB full gate when URL provisioned.

## Divergence log (live wave)

- Live search returns JSON `GRIDRESULT`, not HTML table.
- Confirmation-shaped candidates shorter than ~6 chars miss live rows → canary walks longer exacts.
- Filling all OR slots with same candidate tripped policy vs kind-scoped body.
- Proof dir root-owned once → EACCES (fixed in deploy bootstrap).
- Quiesced used to refuse online `http` mid-proof (fixed — assets-only now).
- Health stamp field name `checkedAt` vs status looking for `updatedAt` (fixed).

## Follow-on ops

```bash
# After stop, before next canary/start:
bash apps/server-pilot/deploy/ops-hms-shadow.sh rearm

# Mid-proof rebuild without bouncing http:
bash apps/server-pilot/deploy/ops-deploy.sh --quiesced
```
