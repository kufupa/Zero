# Retro + Plan v7: Centurion MVP working end to end, add-in 1.0.17 = final

## Context
- **State:** Centurion pilot day. Since the call, these are fixed:
  - folder auto-approve (#51), clock guard (#52), bridge diagnostics (#53);
  - add-in 1.0.15 (real error text) and 1.0.16 (STA thread fix, published);
  - the Message-ID P0 (#55).
- **She is installing 1.0.16 now.** Nothing past the first add-in call has ever run on her PC.
- **Two journey audits found 7 more risks.** You want them fixed with **one final add-in release** and a token-efficient Haiku/Opus split.

---

## 1. Retro (whole chat: overnight → morning → call → afternoon)

| ✅ Went well | ❌ Went badly | Rule from now |
|---|---|---|
| Haiku lanes in worktrees with tight briefs: L1–L4 each took 5–12 min (#50, #51, #48 rebase, 1.0.15 spec) | **Debugged blind for about 2h.** The add-in hid every error as "Native request denied" | **Diagnostics first.** When a remote client fails, ship error visibility *before* any fix |
| Prod-path smoke overnight caught "quotes never worked on prod" | **Shipped #52 (clock skew) on a guess.** The causal chain was never confirmed (it read 1s) | No fix without a confirmed causal chain (the ce-debug gate) |
| Greptile caught 4 security P1s on #51; Opus fixed them in about 15 min | **Pre-pilot testing was all unit tests or HTTP smoke.** It never covered real Outlook, a real selection or the real pane. That produced 3 P0s (empty folders, STA thread, Message-ID) | **A real Windows + classic Outlook run of the full journey** before any client session |
| Opus journey audits (2 agents, about 10 min) found the Message-ID P0 + 7 risks | The 1h plan became 3h+, because the estimate assumed one root cause | Triple estimates whenever an external machine is in the loop |
| Agency positive case proven live in about 10 min (Tourvest = company #206) | Built the agency picker before any positive case (overnight) | Prove the data live before coding |
| 1.0.15 → root cause → 1.0.16 in about 25 min once the error was visible | The test seeded a raw Message-ID prod never stores, and the DB route test never ran in CI | Fixtures must use prod-shaped data; DB route tests run in CI |
| Short tables and decisions got fast approvals from you | Too much prose early on; suggested staff scripts (rejected) | Caveman/ADHD style; zero staff tech steps |

**Token lesson:** the expensive part was Opus reading C# blind (greps, guesses). The cheap part was Haiku implementing from file:line briefs, with Greptile CLI as a free second reviewer.

---

## 2. Plan v7

### Phase 0: now (you + Opus)
- She installs 1.0.16, opens the pane, clicks an Inbox email, runs a quote, clicks **Insert draft**. She also reviews the UI.
- **Opus watches the logs live:**
  - `outlook_native_authorize` actions beyond GET_CAPABILITIES;
  - `outlook_folder_auto_approved`;
  - `outlook_bridge_native_failure` (now carries the real reason);
  - executeStaffQuote and PDF calls in nginx.
- Findings feed into 1.0.17, especially #1 and #2 (draft insert).

### Lane A: Haiku, pane only, no reinstall (#3, #4)
- **Worktree:** `.worktrees/v7-pane` from origin/main. **File:** `apps/mail/lib/workstation/use-outlook-bridge.ts` (plus copy in `apps/mail/app/(routes)/outlook-pane/page.tsx`).
- **#3, selection freezes after a draft write:**
  - After a successful write action (`MUTATIONS` set, L69), re-run GET_ACTIVE_EMAIL with the same selection-counter guard as the selection handler (L774).
  - This restores the add-in's read lease, so clicks work again immediately.
- **#4, a click in another mailbox greys out the pane for 45s:**
  - When GET_ACTIVE_EMAIL fails *before* authorize (add-in reason contains "explicit matching Outlook store"), treat it as "nothing selected". Show: "This email isn't in the Centurion mailbox."
  - Keep the navigation and the failure counter; still report the failure.
  - For any other failure, keep today's behaviour.
- **Tests:** `apps/mail/tests/workstation-bridge-protocol.test.tsx` (`respondV4` helpers):
  - after CREATE_REPLY_DRAFT succeeds, GET_ACTIVE_EMAIL runs again;
  - a store-mismatch denial keeps navigation and shows the notice;
  - any other denial still invalidates.
- **ETA:** about 25 min code, then CI + Greptile (about 10), then deploy (about 8). **About 45 min.**

### Lane B: Haiku, add-in 1.0.17 (built, not published until after the Phase 0 findings)
- **Worktree:** submodule `.worktrees/v6-addin/apps/server-pilot/vsto`, branch `fix/1.0.17-final` from main `24fa744`.
- **#5, sync thread bug:** call `TaskPaneControl.EnsureUiSynchronizationContext()` as the first line of `ThisAddIn_Startup` (`ThisAddIn.cs` ~L30, before `ResumeSync()`), and in `ResumeSync` and `SyncTimer_Tick` (L165-166).
- **#7, folder type never sent:**
  - Add `SourceKind` to `NativeObservedScope` and to `Request()` (`OutlookMailOperationPolicy.cs:237-254`).
  - Set it in `PinItemLocation` (`OutlookBridgeDispatcher.cs:207`), reusing the `ObserveDestinationKind` pattern (L295) plus `olFolderDeletedItems` / `olFolderOutbox` → `deleted` / `outbox` / `inbox` / `drafts` / `spam` / `other`.
  - The server already honours it (`authorization.ts`, auto-approve excludes deleted/outbox).
  - Confirm `RecheckNativeScope` / `EnsureSameObserved` still compares correctly.
- **#2, reply draft marked "outcome unknown":** in `GetMailLocationAfterSave` (`OutlookMailOperations.cs:1031`), re-fetch the saved item via `Session.GetItemFromID(mail.EntryID, storeId)` before reading its location.
- **#3, add-in side:** `OutlookBridgeNavigationLease.Grant` (`OutlookBridgeAuthorization.cs:71`) keeps the later expiry, capped at `NavigationExpiry`.
- **#4, add-in side:** for GET_ACTIVE_EMAIL only, a selection outside the paired store leaves resources empty (no selection) instead of throwing (`PinItemLocation` caller, `OutlookBridgeDispatcher.cs:~100`).
- **#1, conditional (only if Phase 0 shows "use manual Outlook Reply"):** when the profile's default Drafts differs from the paired store's Drafts, save the reply, then `Move` it to the paired Drafts. Otherwise skip.
- **Version and tests:**
  - Bump to 1.0.17: same 7 files as before, plus `tests/native-hardening.test.mjs` and `tests/release-identity.test.mjs`.
  - Add source-contract tests in `tests/native-security-review.test.mjs` for #5 (Startup installs the context before `ResumeSync`), #7 (`sourceKind` in `Request`) and #3 (max expiry).
- **ETA:** about 35 min code + 2 min Windows CI. The artifact is held.
- **Then:** publish the same way as 1.0.16 (S3 presign → EC2 `/var/www/nava-mail/downloads`, back up 1.0.16, check the served SHA). Then a server PR bumps the pin and the install-doc hash.

### Review gate: Opus + Greptile (cheap)
- Run `greptile review -b <base> --agent --instructions "<P0/P1 focus>"` on both branches, plus the GitHub Greptile bot.
- **Opus line-reviews only the add-in diff** (thread affinity, security of `sourceKind`, lease change). Merge only with **no P0/P1**.

### Deferred, not today
- **#6, held-back mail for the 5 new mailboxes:** mail-routing change, about 1–2h, routing risk. The RCA is in `docs/plans/2026-10-08-005-ingest-routing-rca.md`. Separate plan tomorrow.
- Agency picker #48: search both profile types + Luna ranking. Tomorrow.
- `QUOTE_TRACE_ASYNC` 2-quote live test. Tomorrow.

### Timeline (UTC, now about 13:00)
| Time | Opus | Lane A (Haiku) | Lane B (Haiku) |
|---|---|---|---|
| 13:00 | Phase 0 live watch (she's on 1.0.16) | dispatch | dispatch |
| 13:30 | review A, Greptile | PR | build |
| 13:45 | merge, deploy A; she reopens the pane | — | PR + Windows CI artifact |
| 14:00 | review B with Phase 0 findings; add #1 if needed | — | fixes from review |
| Tomorrow AM | publish 1.0.17, she installs once, final E2E with her | | |

### Model split (token-efficient, as in v5/v6)
- **Haiku 5.5** gets briefs with exact file:line, tests and timebox, on disjoint files (A = web, B = C#). No exploration.
- **Opus 5.5** handles live log reading, root cause, the add-in security/thread review, merge and deploy. No blind C# reading: targeted greps only.
- **Greptile CLI** is the second reviewer, instead of Opus multi-agent reviews.

### After approval, first actions
1. **Hindsight capture:** write the retro above (initiative "Centurion pilot onboarding, 2026-10-08") via the hindsight MCP.
2. **Memory:** add `feedback-diagnostics-first.md` (no fix without a confirmed chain; ship error visibility first) and a pointer in MEMORY.md.
3. Save this plan to `docs/plans/2026-10-08-006-luna-plan-v7-final-addin.md`, then start the lanes.

## Verification
- **Lane A:** `pnpm --filter @zero/mail exec vitest run tests/workstation-bridge-protocol.test.tsx tests/outlook-pane*` green, CI green, no Greptile P0/P1, deployed, health/VPN ok.
- **Lane B:** node source contracts green locally and in Windows CI (build, native tests, installer). The built manifest SHA matches the served file after publish.
- **Live (her PC):**
  - **The pane works:** server logs show GET_ACTIVE_EMAIL and CREATE_REPLY_DRAFT granted, `outlook_folder_auto_approved` rows for Inbox (`read`) and Drafts (`drafts`), and no new `outlook_bridge_native_failure`.
  - **Quoting works:** executeStaffQuote 200, PDF 200, and a draft appears in her Outlook Drafts with the PDF.
