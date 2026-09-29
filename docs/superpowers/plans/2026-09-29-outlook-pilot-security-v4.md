# Outlook Pilot Security v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Use test-driven-development: verify each changed behavior fails before implementation and passes after. This file supersedes `archive/lab-scratch/docs/plans/2026-09-25-001-feat-outlook-pilot-security-plan.md` wherever the older plan removes server mail functionality or mandates an IT-issued certificate.

**Goal:** One supervised security update to the Classic Outlook add-in; preserve centrally updated `/outlook-pane`, server-side web-mail Send/Delete, and local approved Outlook read/draft/attachment/triage workflows.

**Architecture:** The existing hotel Better Auth session authorizes staff for 24 hours. A separate revocable credential generated in each installed Windows user profile authenticates the native add-in to the server. The web pane receives only one-use browser tickets and never gets the device key; native code verifies staff, installation, actual Outlook store, command and scope before COM. New UI stays hosted.

**Tech stack:** Zero monorepo (`@zero/server` Hono/tRPC/Better Auth/Drizzle/Postgres, `@zero/mail` React Router SPA), `kufupa/nava-outlook-addin` VSTO .NET Framework/WebView2 submodule, Windows CI/Inno Setup, Nginx.

## Global Constraints

- Exact pane URL `https://nava.legacyhotels.co.za/outlook-pane`; bridge protocol v4 is mandatory after rollout, with no unauthenticated v2/v3 fallback. No COM-derived data, selection events or cached data leave native before authorization.
- Hotel sessions: 24-hour absolute lifetime from login, no sliding renewal/cookie-cache bypass; remote-admin 12-hour profile unchanged. Never turn workstation names or unverified mailbox strings into identity.
- Enrollment: operator issues a one-use code expiring within 10 minutes; every Windows-user installation owns a separate 256-bit secret protected by DPAPI CurrentUser. Device credential persists until revoked, not merely 24 hours. HMAC-SHA256 authenticates native calls; HTTPS validates the existing website certificate and encrypts the connection. No JS access to the device secret.
- Native read lease at most 60 seconds in memory, mutation authorization at most 15 seconds and bound to the current operation and navigation. Invalidate on logout, navigation, account switch, server denial or device revocation; a revoked read lease can survive only until the 60-second maximum. No offline COM access.
- Keep native reads (including metadata, templates and attachments), reply/new/update drafts, draft attachments, category/flag/read mutations, approved same-store folder creation and triage moves. Remove native `SEND_DRAFT`, `DELETE_EMAIL`, `DELETE_EMAIL_PERMANENTLY`. Block move into Deleted Items/Outbox or their descendants; approved triage-folder policy updates server-side. Normal staff Outlook Send/Delete remains manual.
- Keep `apps/server-pilot/src/trpc/routes/mail.ts` web-mail Send/Delete, POP3 cleanup and existing server SMTP infrastructure untouched. No new DaVinci auto-forwarding in this release. No separate web-mail UI redesign, click-tracking, forced Windows auto-updater, or commercial/IT-issued certificate requirement.
- Confirm explicit batches of 10+ native moves and more than 25 native moves/minute. Native approval identifies exact items and destination and cannot be reused for changed work; normal single moves do not prompt. Build native hook now so future bulk-move UI can ship centrally.
- Pane shows mail as text; sanitize any rich HTML before rendering. Pane-specific CSP script policy derives hashes from each built asset, with no `unsafe-inline` script allowance; do not disable React buttons or apply new policy to the separate mail UI. Screenshot popouts receive no bridge.
- Existing `.github/workflows/outlook-vsto.yml` signs VSTO manifests with a self-signed certificate; site TLS is unrelated and the EXE may still show Windows publisher warnings. Verify existing per-user trust on Windows with IT; do not silently broaden cert trust or kill Outlook/unsaved drafts. No claim of fleet completion without verifying every old binary upgraded/disabled.
- Never test on pilot/production RDS; before each Vitest command `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. DB tests require a disposable DB. Do not run production writes in this implementation session; independent Windows/IT and staff-PC verification gates cannot be claimed from Linux.
- Work from `feat/outlook-pilot-security-v4` off `main` `e3203a4687bf6afa7fbda41b2bb8f5a26793d173`; existing user changes in `feat/reservationist-backtest` and other worktrees belong to the user. Native baseline is `190f350acccfb1312adbbfcf09e9c05c27d72676`; commit native changes before updating the Zero gitlink.

## Task 1: Staff session and approved mailbox identity

**Files:** `apps/server-pilot/src/lib/auth-profile.ts`, `apps/server-pilot/src/trpc/routes/workstation.ts`, `apps/server-pilot/tests/auth-session-ttl.test.ts`, `apps/server-pilot/tests/workstation-router-contract.test.ts`, relevant disposable-DB mailbox permission test.

**Interfaces:** Existing `resolveAuthProfilePolicy` returns 86400-second absolute `legacy` session with `updateAge: 0`, `disableSessionRefresh: true`, disabled cookie cache; `remote` stays 43200 seconds. Quote PDF authorization checks authenticated `userId` plus `mailboxAccess` to the selected transport, not raw email equality. Maintain existing PDF output schema.

- [ ] RED: add tests for 24-hour policy/remote unchanged and shared-mailbox staff who have access versus users without access; verify expected failures with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS; pnpm --filter @zero/server exec vitest run tests/auth-session-ttl.test.ts tests/workstation-router-contract.test.ts` and disposable DB for DB-backed authorization.
- [ ] GREEN: adjust profile and quote permission, preserve signed-in quotation workflows, run focused tests and `pnpm --filter @zero/server build`. Record controlled legacy-session invalidation step for cutover; do not delete live sessions here.
- [ ] Review for cross-mailbox allowance, remote-admin regression and re-login after 24 hours; commit only task-owned paths.

## Task 2: Device enrollment and HMAC verification

**Files:** `apps/server-pilot/src/db/schema/` (new device/enrollment schema), next additive SQL under `apps/server-pilot/drizzle/` and journal, `apps/server-pilot/src/outlook-security/` (new focused policy/service modules), `apps/server-pilot/src/http/outlook-native.ts`, `apps/server-pilot/src/main.ts`, `apps/server-pilot/scripts/` operator-only enrollment/revoke CLI, `apps/server-pilot/tests/outlook-device-*.test.ts`.

**Interfaces:** `POST /api/outlook/native/enroll` takes operator code, native-observed store ID, version, random device ID and 256-bit secret over TLS, consumes approved 10-minute enrollment atomically, and binds one or more named staff users + mailbox transports to the operator-approved store. `POST /api/outlook/native/challenge` issues 60-second one-use nonce; subsequent native endpoints accept `X-Nava-Device-Id`, `X-Nava-Nonce`, `X-Nava-Timestamp`, `X-Nava-Signature` computed as HMAC-SHA256 over versioned method/path/exact SHA256 body/device ID/timestamp/nonce; consume nonce atomically and compare signatures constant-time. Store secrets encrypted at rest under a separate server wrapping key; in native use DPAPI CurrentUser with restrictive file ACL. Enrollment/revocation is a restricted CLI, never a public web page or self-signup route.

- [ ] RED: tests for successful one-use pairing, duplicate/expired/guessed code, missing or wrong enrollment, HMAC replay and tampered body, device revocation, cross-user/store rejection and leaked-secret-free responses; demonstrate expected failures first, with disposable DB only for persistence tests.
- [ ] GREEN: implement minimal schema, policy, endpoints and CLI, cover crash-safe nonce/code consumption; run focused tests, migrations on disposable DB only, and `pnpm --filter @zero/server build`.
- [ ] Verify audit records contain device ID/version/last handshake/revocation only; no mail bodies, passwords, secrets or click telemetry. Review and commit.

## Task 3: Staff ticket, scoped native lease and move policy

**Files:** `apps/server-pilot/src/trpc/routes/workstation.ts`, `apps/server-pilot/src/outlook-security/`, `apps/server-pilot/src/http/outlook-native.ts`, additive migration as needed, `apps/server-pilot/tests/outlook-bridge-authorization.test.ts`.

**Interfaces:** A safe unauthenticated native bootstrap returns protocol/status/random navigation challenge without Outlook data. The installed device registers its per-navigation challenge via signed native request. Signed-in staff call `workstation.bridgeTicket` with `{deviceId, paneChallenge, action, storeId?, operationId?}` and get one opaque ticket expiring within 60 seconds. Native sends ticket and actual observed store/resource/operation via signed `POST /api/outlook/native/authorize`. The server checks the original Better Auth session ID (including logout and 24-hour expiry), named user, device, stored Outlook store mapping, `mailboxAccess`, action allowlist and approved folder IDs; consumes tickets once. It returns directly to native either read scope valid for <=60s or mutation approval valid for <=15s, bound to one operation/resource/destination. Never return a reusable native grant or HMAC secret to JS. Persist per-mailbox and per-device move counters across panes/restarts; >25 moves/minute requires exact native batch consent.

- [ ] RED: write authorization tests for anonymous/unapproved/wrong mailbox, expired/replayed tickets, stale navigation, revoked device/session, no grant on network failure, forbidden folders, move budgets shared across devices and idempotent retry accounting; observe expected failures.
- [ ] GREEN: implement server ticket/grant policy and safe operation receipts, run targeted tests against disposable DB and TypeScript build; review and commit. Web-mail `mail.send`, `mail.delete`, `mail.bulkDelete` remain unchanged.

## Task 4: Native command/folder, template and installer hardening

**Files in `apps/server-pilot/vsto`:** `NavaOutlookAddin/OutlookBridgeDispatcher.cs`, `NavaOutlookAddin/OutlookMailOperations.cs`, `NavaOutlookAddin/OutlookMailOperationPolicy.cs`, `tests/BridgePolicyTests.cs`, `installer/setup.iss`, `installer/RegisterTrust.cs`, `.github/workflows/outlook-vsto.yml` if needed for tests.

- [ ] RED: extend native policy tests to reject deleted/native send and forbidden folder identity/descendants, cross-store or missing-store fallback, arbitrary/UNC template paths, and installer forced `taskkill`; run the Windows workflow or available portable C# policy tests and record failing output.
- [ ] GREEN: remove native Send/Delete dispatch/capability/implementations, independently check actual Outlook COM source/destination stores and folder identities for every retained action, enforce approved destinations received from Task 3, restrict template lookup to native enumerated local templates, keep supported attachment types/sizes with private temporary files. Installer asks staff to close Outlook rather than killing it; retain verified existing VSTO manifest signing and explicit per-user trust. Run focused tests and Windows CI.
- [ ] Commit native-only changes; do not update the Zero gitlink until Task 5 and CI complete.

## Task 5: Native v4 authorization, events, consent and popouts

**Files in `apps/server-pilot/vsto`:** `NavaOutlookAddin/TaskPaneControl.cs`, `NavaOutlookAddin/OutlookBridgeDispatcher.cs`, new `NavaOutlookAddin/OutlookBridgeAuthorization.cs` and focused native tests, `.github/workflows/outlook-vsto.yml`.

- [ ] RED: test sibling URL/frame/popup rejection, post-login exact path, `PING` without COM data, pre-login `NotifySelectionChanged` silence, cached response after signout, wrong-store attachment/draft, TLS/HMAC/revocation/expired grant, invalid async epoch, and exact-set Windows batch consent; observe failures first.
- [ ] GREEN: implement DPAPI/HMAC device client and v4 pairing; validate current top-level source **on each** inbound bridge message and before each outbound response/event. Run all COM on Outlook's STA thread after async authorization with final epoch/actual-store checks. Give screenshot/HTTPS popouts a separate bridge-free WebView, keep external links safe. Preserve operation-ID retry semantics; require native batch consent for 10+ explicit moves or >25/min single moves. Perform Windows x86/x64 build and behavioral CI, then commit native repo and update Zero gitlink in a separate root commit.

### Task 5c integration discovered during cross-component review

- [ ] Preserve reply/update draft and PDF attachment workflows: the native COM bridge pins a draft's actual source folder ID, so permit the operator to approve an exact folder with a `drafts` kind for native reads/draft mutations without making it a `MOVE_EMAIL` or `MOVE_TO_SPAM` destination. Keep approval tied to enrolled store and mailbox transport; add disposable-DB tests for approved Drafts attachment/update and rejected move into that same folder, plus operator docs for collecting exact Inbox/Drafts/triage folder IDs. No new installer required for server-side folder approval.
- [ ] Deny browser tickets and signed native scopes that omit the approved `sourceFolderId` for existing-item reads and mutations (including reply-draft creation and PDF attachment), even when a legacy ticket was already minted; native `GET_ACTIVE_EMAIL` may omit source only for an empty selection. The pane must carry the actual selected message folder ID and then the returned Drafts folder ID. Template path reads and new drafts have no existing Outlook item source.

## Task 6: Hosted pane authorization and minimal UI

**Files:** `apps/mail/lib/workstation/use-outlook-bridge.ts`, `apps/mail/lib/workstation/bridge-protocol.ts`, `apps/mail/app/(routes)/outlook-pane/page.tsx`, tests `apps/mail/tests/outlook-pane-auth.test.tsx`, `apps/mail/tests/workstation-bridge-protocol.test.tsx`, `apps/mail/tests/outlook-pane-render.test.tsx`.

- [ ] RED: tests for no mail request before staff session+native pairing, 24-hour re-login, old v2/v3 update-required state, known same-user/shared-mailbox mapping, no late stale selection after logout, PDF reply draft+attachment, manual Outlook Send, and central bulk-consent hooks; verify failures.
- [ ] GREEN: use new bridgeTicket/grant handshake, clear pending bridge requests and cached mail on session/navigation change; use server-verified mapping for quotation PDF rather than email text equality. Keep hosted pane, onboarding, quote drafting, screenshot inspection and existing web-mail Send/Delete UI. Run focused/full mail tests and build; review and commit.

## Task 7: Pane-only script policy and reliable web release

**Files:** `apps/server-pilot/deploy/nginx.conf`, `apps/server-pilot/deploy/deploy-ec2.sh` and deployment tests, `apps/mail/app/root.tsx` only if build proves necessary for inline hydration, pane CSP tests.

- [ ] RED: tests that `/outlook-pane` has no script `unsafe-inline`, computed SHA256 hashes match final built inline scripts, a stale index/CSP mismatch rejects publication, other app routes keep their existing policy and security headers, and old asset URLs remain available across deploys; observe expected failures.
- [ ] GREEN: build-derived hash policy scoped to exact pane route, stage versioned web assets + matching Nginx policy and switch a validated release atomically while retaining prior assets for open clients. Validate login, buttons, PDF flow, screenshot popouts and zero unauthorized script execution in a built pane; no new installer for UI-only publish. Review and commit.

## Task 8: Whole-path security verification and release handoff

**Files:** Root and native CI contracts, focused tests and security runbook. Include compatible submodule commit and hashes, operator enrollment/revocation instructions, rollback to fail-closed v4 and deployment smoke checklist.

- [ ] Run server/mailer targeted and full relevant tests, typecheck, lint, builds, disposable-DB migration roundtrip, Windows VSTO CI x86/x64 and artifact manifest/signature/hash verification; perform independent task + whole-branch security review, fix blocking findings and rerun affected suites.
- [ ] Verify old clients get update-required, web-mail server Send/Delete remain available, `PILOT_OPEN_SIGNUP=0` and hotel 24-hour session only, while remote admin stays 12 hours. Never use real guest emails or pilot RDS test runners.
- [ ] Ensure a production env writer can load the distinct, stable server-only device-wrapping key from an operator-provisioned secret without logging it or regenerating it during deploy; `PILOT_OPEN_SIGNUP=0` must deny even a leftover self-signup allowlist. Refresh old v3/1.0.11 root-CI source contracts rather than skipping them. Do not provision the production secret or change the live environment in this implementation session.
- [ ] Code and verified artifact are not proof of rollout. Server deployment, revoking old 400-day sessions, signing-policy acceptance and each staff-PC install/store enrollment require separately recorded production/IT access and supervised validation. Do not execute production writes implicitly. No claim that web-mail’s raw-HTML rendering gap is fixed by this native release; create a separate urgent follow-up that preserves web-mail functionality.

## Initial verification baseline (2026-09-29)

- Security worktree from `main` is clean and native submodule checked out at `190f350` before edits; original user worktrees remain untouched.
- With `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset: server focused suites 17/17 passed; pane/bridge focused suites 44/44 passed. No Windows test runner, live pilot EC2, signing policy or staff-PC state was exercised.
