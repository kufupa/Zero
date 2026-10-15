# Plan: store root auto-accept (option B) + rejected-root logs + add-in 1.0.18

## Goal
- New onboarding: download installer, pair, open Outlook + pane. Mail sync starts with no operator step.
- Centurion (already paired, 1.0.17): upgrade to 1.0.18 over the top, keep enrollment, sync starts.
- Every root decision logged on the pilot server (pm2 `http`) so rejects are visible.

## Why the root is blocked today
- Sync activation needs `rootEntryId` (`apps/mail/lib/workstation/use-outlook-sync.ts:57,122,131`). Pane gets it from `readRoots` (`bridge-protocol.ts:135`).
- Root rows come only from `approve-read-root` (`scripts/outlook-device-operator.ts:132-185`). The operator must type a root EntryID.
- Only native can read the store root: `store.GetRootFolder()` (already used in `OutlookMailOperations.cs` ~L232, 775, 871, 990).
- Pane cannot find it: `ListFolders` (`OutlookMailOperations.cs:172`) lists only under already-approved roots. Circular.
- Server cannot derive it: `enrollDevice` (`device.ts:61`) takes no root. `PairAsync` (`OutlookBridgeAuthorization.cs:244-262`) sends `{code, deviceId, storeId, version, secret}` only.
- Re-pair is refused for installed devices, so Centurion needs a signed call to report the root, not a new pairing.

## Model change (B)
| | Today | With B |
|---|---|---|
| Approvals | 2: enrollment + operator-typed read root | 1: enrollment. Device reports store top-level root. |
| Sync scope | Whatever root the operator typed (may miss Sent Items) | Whole store (Inbox, Sent Items, Deleted Items, ...) |
| Kept | Exact device/staff/mailbox/store binding | same |
| Kept | Folder approvals for draft and move targets | same |
| Kept | Native refuses reads outside the paired store | same |
| Override | `approve-read-root` / `revoke-read-root` | same, still works |

Caveat: server trusts the enrolled device for the root value. Store binding limits the damage. Server cannot prove it is the top folder.

## Server lane (zero repo, branch `feat/store-root-auto-accept`)
1. **Accept root on enroll.** `device.ts:61` `enrollDevice`: optional `rootEntryId` in body. After the device/grant insert in the same transaction, record root via the existing `outlook_device_read_root` table. No migration.
2. **Accept root on signed call.** New endpoint `POST /api/outlook/native/store-root`, body `{storeId, rootEntryId}`, signed like other native calls. Add path to the allowlist at `http/outlook-native.ts:36`. Body cap stays 4096 (`:40`).
3. **Decision rules** (new helper next to `approveReadRoot`, `device.ts:179`):
   - device must be active (`isDeviceAuthorized`, exact tuple);
   - `storeId` must equal the device's paired store;
   - root must be a non-empty, length-capped string (malformed → reject);
   - no existing root → record (`root_recorded`);
   - same root already recorded → no-op (idempotent);
   - different root already recorded → reject (`conflict_existing_root`), keep the old row. Operator must `revoke-read-root` first.
4. **Logs (pm2 `http` stdout, VPS).** One line per decision, JSON:
   - `event: root_recorded | root_rejected | root_noop`
   - `reason` on reject: `malformed`, `device_inactive`, `store_mismatch`, `conflict_existing_root`
   - fields: `deviceId`, `staffEmail`, `storeId`, `rootEntryId`, `existingRootEntryId` (conflict only).
   - Raw EntryIDs are opaque hex, not mail content, so log them raw. Confirm before shipping.
5. **Tests (run locally, no Actions).** `pnpm --filter` server-pilot vitest on:
   - enroll with root → row recorded;
   - enroll without root → unchanged behaviour;
   - signed call: recorded, noop, conflict, store mismatch, inactive device, malformed;
   - sync authorization still rejects a source whose root is missing.
6. **Typecheck + oxlint locally.**

## Native lane (`kufupa/nava-outlook-addin` / vsto submodule, branch `fix/1.0.18-store-root` from `fb0831a`)
1. `OutlookBridgeAuthorization.cs:244-262` `PairAsync`: add `rootEntryId` = `store.GetRootFolder().EntryID` to the payload. Pass the store in from `TaskPaneControl.cs:432-435`.
2. New `ReportStoreRootAsync(storeId, rootEntryId)`: posts to `/api/outlook/native/store-root`, signed like other calls. Call it:
   - right after successful pairing;
   - on every add-in startup after sign-in (idempotent; covers Centurion).
3. Failure of the report must not block the pane. Log it locally and retry on next startup.
4. Bump to 1.0.18. Update `tests/native-hardening.test.mjs` and `tests/release-identity.test.mjs`. Add source-contract test for the report call.
5. Windows build via the allowed "Outlook VSTO installer" workflow only. No other workflows.

## Pane lane (zero repo)
- No code change expected. Verify after the server lane: `readRoots` returns the recorded root for Centurion's device, and the pane re-reads it without a restart. If the pane caches an empty `readRoots`, add a refresh after the store-root report. Decide after checking.

## Ops (after explicit go)
1. Deploy server via `apps/server-pilot/deploy/ops-deploy.sh` (SSM). Not Actions.
2. Publish 1.0.18: S3 presign → EC2 `/var/www/nava-mail/downloads/NavaOutlookSetup.exe`. Back up 1.0.17 first. Check served SHA against the built artifact on the worker.
3. PR: bump installer pin and SHA-256 in `docs/pilot/2026-10-08-install-and-onboarding.md`.
4. Centurion: install 1.0.18 over 1.0.17. Keep enrollment. Open Outlook and the pane.

## Verification
- Server: pm2 `http` log shows `root_recorded` for Centurion's device with her store.
- DB (read-only): `outlook_device_read_root` row for her device, `revokedAt` null.
- Pane: `readRoots` non-empty; `outlook_sync_source` row created with `rootEntryId` set.
- S3: `outlook-sync-staging/v1/...` objects appear, then `outlook-sync-originals/v1/...`.
- Negative: replay a root for a different store → `store_mismatch` in log, no row change.

## Rollback
- Server: redeploy previous commit via `ops-deploy.sh`. Revoke a bad root with `revoke-read-root`.
- Native: reinstall 1.0.17 from the S3 backup. Enrollment is kept.

## Risks
| Risk | Mitigation |
|---|---|
| Device reports a wrong root | Store binding + logs; operator can revoke |
| Profile rebuilt → new root → conflict | Logged as `conflict_existing_root`; operator revoke + re-report |
| Store top-level root changes (Outlook reset) | Same as above |
| Pane caches empty `readRoots` | Refresh step (see pane lane) |

## ETA (ledger rows already logged, queued until go)
| Lane | Estimate |
|---|---|
| Server: accept, log, tests | ~30 min |
| Native 1.0.18 + Windows build (parallel) | ~45 min |
| Server deploy | ~4 min |
| Publish, pin/hash PR, SHA check | ~20 min |
| Centurion upgrade + verify | ~12 min + her install |

About 75 min to 1.0.18 live after go. Sync starts after she upgrades and opens the pane.

## Open choices
1. Root report: at pairing + startup (recommended) vs startup only. Recommended: both.
2. Log raw EntryIDs (recommended) vs hashed.

## Go gates
- Start server + native branch work: needs go.
- Publish installer, ops-deploy to prod, pin/hash PR: each needs explicit OK.
