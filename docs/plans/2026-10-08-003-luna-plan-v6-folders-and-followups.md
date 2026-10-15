---
title: "Luna Plan v6: folder auto-approve, speed flag, PR #45/#48, add-in 1.0.15 spec"
type: fix
date: 2026-10-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
---

# Luna Plan v6 (1-hour sprint, 10:05 → 11:05 UTC)

Prod is `0fe5c894` (#49) and healthy. Centurion's pane is blocked: `outlook_approved_folder` is empty for transport-centurion, so native refuses every read with "Select an approved Outlook folder".

## Decisions (user: "lgtm", 09:55 UTC)

| # | Decision |
|---|---|
| D1 | Auto-approve covers **reads + drafts** in the paired device's own store. Move destinations (triage/inbox/spam) still need explicit approval. |
| D2 | 1.0.15 pairing is **self-service** for staff with `mailbox_access` to the transport. Gate: native-reported store SMTP == transport email. |
| D3 | `QUOTE_TRACE_ASYNC=on` today **only if** 2 live quotes + PDF pass after the timeout fix. |
| D4 | The server fix (A) stays permanently, even after 1.0.15. It is the backport path for 1.0.14 installs. |
| D5 | Out of scope: PR #2, PR #3, the smoke-runner script, `RESERVATIONIST_PANE_SAVE`, real-guest writes. |

## Retro: overnight (23:15 → 06:50)

| ✅ Went well | ❌ Went badly | Rule now |
|---|---|---|
| 4 Haiku lanes in worktrees, Opus review per wave: 7 PRs merged, 6 deploys, 0 rollbacks | Staff quote had **never run on prod**. Found by smoke at 03:46, 4.5h in | **Prod-path smoke first**, before building on any path |
| Opus root-cause slices fixed P0s in about 25 min each (menu race, spawn env) | The http process lacked CDP env (prod ≠ local) | Smoke via the prod route, not the CLI |
| Greptile caught real P1s on #37, #38, #47 | Fix commits added new P1s (#47 round 2) | Fixes stay small; re-review the same round |
| Lab book + cancel proven live, no penalty accepted | Lane merges conflicted (round 4, round 7 integrator) | Lanes own **disjoint files**; merge order fixed up front |
| Ledger + handoff kept the state clear | **Onboarding (pair + folders) never tested on a fresh device** → failed on the client call | Test the **new-user journey end to end** before any client call |
| | Agency feature built before any positive live case (Tourvest `no_match`) | **Verify data assumptions live before coding** |
| | Smoke-runner lane overran; tunnel dropped when idle ×2; husky EACCES | Timebox 20 min; reopen the tunnel before HMS work; chmod before deploy |
| | Too much prose for the user | 1 table + ≤5 bullets |

## Lanes (parallel; Haiku implements, Opus reviews/deploys/does live HMS)

| Lane | Model | Worktree / branch | Owns files (disjoint) | Done when |
|---|---|---|---|---|
| **L1 Folder auto-approve (A)** | Haiku max | `.worktrees/v6-folders` · `fix/outlook-auto-approve-folders` | `apps/server-pilot/src/outlook-security/authorization.ts`, `apps/server-pilot/tests/outlook-bridge-authorization.test.ts` | PR open; tsc clean; CI `rocketseed-transactional` green (runs the auth tests on disposable Postgres) |
| **L2 Speed flag + pane copy** | Haiku max | `.worktrees/v6-speed` · `fix/quote-trace-async-client` | `apps/mail/lib/trpc-request-timeout.ts`, `apps/mail/tests/trpc-request-timeout.test.ts`, quote screenshot/choices callers in `apps/mail/app/(routes)/outlook-pane/page.tsx`, auth banner copy (same file ~L1381) | PR open; mail tests green |
| **L3 PR #48 rebase** | Haiku max | `.worktrees/v5-b` · `feat/luna-v5-b` | the #48 files only; rebase onto main **after** L2 merges | Draft is mergeable, tests green, stays **draft** |
| **L4 Add-in 1.0.15 spec** | Haiku max (read-only) | none (reads `/tmp/oba.cs`, `/tmp/OutlookMailOperationPolicy.cs`, `apps/server-pilot/src/outlook-security/device.ts`) | new `docs/plans/2026-10-08-004-addin-1.0.15-plan.md` | Spec with exact C# + server touchpoints and tests |
| **Opus** | Opus 5.5 | `.worktrees/recover-parse-failure` (deploy) | reviews, PR #45 merge, deploy W7, live HMS (agency positive case, flag-on quotes) | see timeline |

## Timeline (UTC)

| Time | L1 | L2 | L3 | L4 | Opus |
|---|---|---|---|---|---|
| 10:05 | start | start | wait | start | dispatch; review + merge **PR #45**; reopen CDP tunnel |
| 10:10–10:35 | build + tests | build + tests | — | spec | **Agency positive case** (live, read-only; see U5) |
| 10:35 | PR | PR | rebase after L2 merges | spec done | **Review L1 hard** (security); review L2 |
| 10:40–10:50 | P1 fixes | P1 fixes | rebase + tests | — | Greptile + CI wait; merge L1, L2 |
| 10:50 | | | | | **Deploy W7** (chmod husky first) → Runbook C health |
| 10:55 | | | | | Verify Centurion folder rows appear (count only) · flag ON → 2 live quotes + PDF → keep or revert |
| 11:05 | | | | | Freeze; ledger + handoff update; summary to user |

**Cut order if behind:** flag stays OFF → L3 waits until tomorrow → L4 spec finished tomorrow. **Never cut:** L1 deploy + Centurion verification.

---

## U1. Server auto-approve of observed folders (L1)

**Goal:** a paired 1.0.14 device reads mail and inserts drafts in its own mailbox with no operator step, no reinstall, no re-pair.

**Why this works:** native already sends the observed `sourceFolderId` / `destinationFolderId` / `destinationKind` in the signed `/authorize` body. Native accepts when the source is in the returned `approvedFolderIds` (`/tmp/oba.cs` ~L224). Native checks the kind only for the destination.

**Approach (in `authorizeNative`, after `isDeviceAuthorized` passes):**
- `isDeviceAuthorized` already proves the device's **enrolled** storeId == `input.storeId` and the staff grant. Auto-approve only inside that.
- Source: if the action is not a move, `sourceFolderId` is not approved, and `sourceKind` ∉ {deleted, outbox, deleted-child, outbox-child} → treat as approved with kind **`read`**.
- Destination: only for created-draft actions with `destinationKind === 'drafts'` (native resolves the real Drafts folder from COM) → approve as `drafts`. If the row exists as `read`, upgrade it to `drafts`.
- **Never** auto-approve for `moveActions` (source or destination) or `CREATE_FOLDER`.
- Merge auto rows into the in-memory `folderRows` **before** the existing checks, so the existing logic stays unchanged.
- Persist with insert `onConflictDoNothing` (or the conditional `read`→`drafts` update) **just before the ticket claim**, so a later `return null` doesn't commit an orphan approval.
- Log `outlook_folder_auto_approved` with transportId, kind, and the action. Never log the raw ids in full (truncate/hash).
- No migration: `kind` is free `text`. The kind `read` can never match a move `destinationKind` (`triage`/`inbox`/`spam`).

**Execution checks (L1 must grep):**
- Every reader of `outlookApprovedFolder.kind`: the operator `inventory`, retention, sync endpoints. Confirm an unknown `read` kind is harmless.
- Whether `/sync/*` and `GET_FOLDER_EMAILS` go through `authorizeNative`. If so they're covered too; if not, note it in the PR (1.0.15 read-root report covers them).
- That `sourceKind` is present on the native authorize body for item reads. If absent, still approve as `read` (deleted/outbox can only be excluded when the kind is known). Note this in the PR.

**Tests (`apps/server-pilot/tests/outlook-bridge-authorization.test.ts`, DB-backed; run in CI):**
1. Paired device, empty approved folders, `GET_ACTIVE_EMAIL` with a source → granted. Response `approvedFolderIds` includes `{source, 'read'}`. Row persisted.
2. Same, but `input.storeId` ≠ the device's enrolled store → `null`, no row.
3. Revoked device / no grant / expired session → `null`, no row.
4. `MOVE_EMAIL` with an unapproved source or destination → `null`, no row (moves unchanged).
5. Created draft with `destinationKind: 'drafts'` → granted, row kind `drafts`. Existing `read` row upgraded.
6. Draft-create with `destinationKind` ≠ `drafts` → `null`.
7. `sourceKind: 'deleted'` → not auto-approved.
8. Auto `read` row is never accepted as a move destination (`approved(id, 'inbox')` false).
9. Ticket replay after the grant → `null`. No duplicate row (PK conflict ignored).

**Verification on prod:** Centurion pane retries every 45s, so it self-heals. SSM count of `outlook_approved_folder` rows for transport-centurion > 0 + log line present. **No staff action.**

## U2. Speed flag client fixes + pane copy (L2)

- `trpcRequestTimeoutMs`: `workstation.quoteRunScreenshot` and `workstation.qualifiedProposalChoices` → 60s (the trace can be pending about 45s with the flag on).
- When the quote run is not recorded (trace failed), the PDF/choices path shows plain copy ("Quote expired, run it again") instead of a generic error. Find the existing error-mapping spot; don't add a new toast system.
- Auth banner (~`page.tsx:1381`): replace "Select an approved Outlook folder" with plain copy that doesn't ask staff to do anything technical, e.g. "Nava is connecting to this mailbox. This can take a minute." + the existing retry.
- **Tests:** `apps/mail/tests/trpc-request-timeout.test.ts`: both routes → 60_000; batched URL containing the route → 60_000; unrelated route → 5_000. Copy test for the expired-run mapping if a unit seam exists.
- **Flag-on gate (Opus, after deploy):** set `QUOTE_TRACE_ASYNC=on` → `pm2 restart http --update-env` → 2 live staff quotes (B&B, 1 room) via the prod route → screenshot + PDF valid. Pass → keep on; otherwise remove the line + restart. Record timings vs the 120–135s baseline.

## U3. PR #45 P2 follow-ups (Opus)

- Mergeable, all checks green, 7 files.
- Opus reads the diff. Check: does `reservationist-evaluation-composition.ts` change the Luna cache key / prompt (it would bust the warm cache)? No → merge before W7. Yes → merge and schedule a backfill re-run after deploy.

## U4. PR #48 rebase (L3)

- Rebase `feat/luna-v5-b` onto main after L2 merges. Conflicts expected in `trpc-request-timeout.ts`, `page.tsx`, `workstation.ts`.
- Keep the `panePartyLookup.findParty` 6-min timeout.
- Tests green; push; **stays draft** until U5 proves a positive case.

## U5. Agency positive case (Opus, live, read-only)

- **Goal:** prove `party-lookup` finds **any** real agency/company profile before more picker code.
- **Steps:**
  1. Take 3–5 recent HMS confirmation numbers from booking-confirmation emails that name an agency.
  2. Run `stay-lookup` (find) on them → read the agency/company field as HMS stores it.
  3. Run `party-lookup` with that exact string → expect `{nativeId}`.
- **Pass:** ≥1 exact hit → the picker is viable. Next: Luna ranks broad-prefix candidates (e.g. "Tourvest") → staff confirm → learn the sender→profile map. Build tomorrow.
- **Fail:** stay-lookup doesn't expose the field, or party-lookup can't find it → park #48. Note the HMS screen to inspect.
- **Rules:** one HMS job at a time (property lock); reopen the tunnel first.

## U6. Add-in 1.0.15 spec (L4 → `docs/plans/2026-10-08-004-addin-1.0.15-plan.md`)

1. **Folder report.** After pairing and on each `register-navigation`, native sends a signed `/api/outlook/native/folders` with `{storeId, storeSmtp, rootEntryId, inbox, drafts, junk}` for the enrolled store only. The server verifies the device store + grant, then upserts approved folders + read root (policy v1). Covers sync and folder browsing, which U1 may not.
2. **Self-enroll (D2).** A signed-in pane with `mailbox_access` + native StoreID/SMTP → the server issues and consumes the enrollment in one step. No operator `issue`, no StoreID read-aloud. The SMTP must equal the transport email. Rate-limit; audit log.
3. **Installer.** Detect a running Outlook and ask staff to close it (installer UI, not a script); check whether a New Outlook switch is on and show clear copy; credential survives the upgrade (DPAPI path unchanged).
4. **Per item:** C# file/line touchpoints from `/tmp/oba.cs` etc., server endpoint + tests, CI (`outlook-vsto.yml`) build, the pin bump in `apps/server-pilot/vsto`, contract tests to update.
5. **Open risks:** self-signed cert / SmartScreen (needs a real code-signing cert, the user's purchase); estimate 2–3 days + 1–2 for self-enroll.

## Risks

| Risk | Mitigation |
|---|---|
| Auto-approve widens native authority | Same store as the device enrollment only; reads + drafts only; moves unchanged; deleted/outbox excluded; logged |
| Auth tests skip locally (no DB) | Gate on the CI `rocketseed-transactional` job (runs them with a disposable PG). Opus reviews the logic line by line |
| "Outlook security paths changed" CI job needs private add-in source | Check at PR open; if it fails for access reasons, note it, don't bypass |
| Greptile slow (10–15 min) | Open the L1 PR first; merge on CI green + no P1 |
| Flag-on breaks the PDF | 2-quote gate; revert = remove the env line + restart |
| Deploy exit 1 at `outboundBacklogEmpty` | Pre-existing; verify with Runbook C |

## Rules (unchanged)

- Never ask staff to run scripts/PowerShell. Staff actions: install, click, sign in.
- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` before vitest. No migrations. No pilot-RDS tests.
- No real-guest HMS writes. `RESERVATIONIST_PANE_SAVE` unset.
- Redact `postgres://` in output. Never print secrets.
- 2 failed attempts or 20 min without new evidence → park.
