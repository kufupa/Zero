# Outlook add-in 1.0.18 Lee hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nava Outlook Setup **1.0.18** that keeps 1.0.17 behaviour (hosted pane, HMAC bridge v4, loader `File.Copy`, month-sync, existing signing) and adds dispose-on-failed-WebView plus a local no-PII native log, including logging swallowed `ResumeSync` / tick errors.

**Architecture:** Tiny native-only change in private repo `kufupa/nava-outlook-addin` (gitlink today `47d0d9df`, version 1.0.17). Then pin that SHA in Zero `apps/server-pilot/vsto` and bump source-contract tests. Windows CI (`.github/workflows/outlook-vsto.yml`) is the only build. Owner downloads Setup, virus-checks, then staff reinstall with Outlook closed.

**Tech Stack:** VSTO .NET Framework 4.8, WinForms WebView2 1.0.3179.45, Inno Setup, Node source-contract tests (`node:test`), Zero `vsto-source-contract.test.ts`.

## Global Constraints

- Start both repos from **`origin/main`**. Do **not** implement in Zero worktree `oct18-c1-classify` (branch `docs/oct19-triage-live-proof`). Work in a fresh clone of `kufupa/nava-outlook-addin` (`gh repo clone`), not `/tmp/nava-outlook-addin-47d0d9`: that snapshot has no `tests/` or `.github/`. Commit this plan file with the Zero pin PR.
- Do **not** change `EnsureNativeLoader` / `File.Copy(src, dest, true)` / skip-if-exists. Zero contract **requires** overwrite copy and **forbids** `if (!File.Exists(dest))`.
- Do **not** add `WinVerifyTrust`, Authenticode publisher checks, SHA256 pins of `WebView2Loader.dll`, or `SetLoaderDllFolderPath`. Owner froze this after the 1.0.13 Edge “Virus detected” scare (Defender CI was clean). “Microsoft sign-off” was a misread of verifying Microsoft’s **already-signed loader**. Out of scope.
- Do **not** change signing, `RegisterTrust.cs`, TrustedPublisher vs Root, `SignManifests`, mage sign/verify, cert generation, or Inno trust gates. CI must still `-p:SignManifests=true` and `mageVerify`.
- Do **not** ship native logs to the Nava server. No new HTTP log ingest. No mail bodies, addresses, subjects, EntryIDs, or HTML in the log file.
- Do **not** rewrite Outlook month-sync / S3 upload. History scan already exists in 1.0.17 (`ResumeSync` → `historyFrom` = one calendar month, prefix `outlook-sync-originals/v1/` on existing `S3_BUCKET`). 1.0.18 only **makes failures visible**.
- Do **not** add native Send/Delete, change `PaneUrl`, or relax origin checks.
- Do **not** `CustomTaskPanes.Remove` inside `ThisAddIn_Shutdown` (Zero contract forbids it in that method).
- Keep comment exact: `Pane/WebView2 failures must not unload the VSTO add-in.`
- Pilot-RDS: no Vitest against production. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before any Zero test. Native `node --test tests/*.mjs` is source-string only and may run locally.
- No `tsc` / full Vitest on the coding VPS. Zero contract tests: EC2 via existing remote scripts if needed, or owner machine.
- Never Fast models. Never `--no-verify`. Never force-push main.
- Do not copy raw PII into subagent prompts. Owner sends the client email **after** Setup is on the download link; do not send mail.

---

## LLM brief (read first)

Client reviewer Lee (via Darren) flagged: DLL copy with no integrity check (Critical), hardcoded URL, in-memory op cache, double-click, failed WebView not disposed, reply-before-Drafts, no logging, 256 cap.

Locked owner decisions (2026-10-19):

| Lee item | Action |
|---|---|
| DLL copy / malware | **Push back in email, no code.** Copy is local from installer-shipped `WebView2Loader.dll`. Shipping already done. No hash/sig check this EXE. |
| Pane URL not hardcoded | **Already done.** `PaneUrl` + `IsTrustedPaneUri` exact `https://nava.legacyhotels.co.za/outlook-pane`. |
| In-memory op cache | **Skip.** Crash-dupe is a draft. Native Send/Delete gone. |
| Double-click | **Skip.** Hosted pane already disables in-flight buttons. |
| Failed WebView null-and-reopen | **Do.** Dispose WebView / failed pane control before creating another. |
| Reply before Drafts | **Already done in 1.0.17.** `CreateReplyDraft` checks Drafts then Reply/Save then Display. |
| No log | **Do.** Local `%LocalAppData%\NavaOutlookAddin\native.log`, fail-open, no mail. |
| 256 / comments | **Skip.** |

`ResumeSync` / `SyncTimer_Tick` empty `catch` must stay **non-throwing** (Outlook must not die) but must write the log.

Bongi may not be on 1.0.17. Native `GET_CAPABILITIES` already returns `addinVersion`. Do not invent live proof she installed. Owner checks her PC.

## Repos and current pins

| Repo | Path | Current |
|---|---|---|
| Native | `https://github.com/kufupa/nava-outlook-addin` | `47d0d9df` / **1.0.17** (addin PR #8) |
| Zero | `apps/server-pilot/vsto` gitlink | same `47d0d9df` |
| Download | `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe` | 1.0.17 SHA `0d25d56a5ce473e6bc2fe25f5d2d3ea8fc9c6e022ba9b6388be4fd7ce4c64bbc` |

1.0.17 evidence files (read, do not “fix” unless this plan names them):

- `NavaOutlookAddin/TaskPaneControl.cs` — `PaneUrl` L17, `EnsureNativeLoader` L76–107 `File.Copy(src, dest, true)`, `ShowPaneError` L110–118 `Controls.Clear()` without Dispose, nav cancel L121–139
- `NavaOutlookAddin/ThisAddIn.cs` — `AttachPane` L75–97, `ToggleTaskPane` L159–178 nulls `_taskPane` then `EnsurePane` on exception, `ResumeSync` / `SyncTimer_Tick` L182–183 empty catch
- `NavaOutlookAddin/OutlookMailOperations.cs` — `GetCapabilities` `addinVersion` L68, `CreateReplyDraft` Drafts-then-Display ~L597–650
- `NavaOutlookAddin/OutlookMailOperationPolicy.cs` — `IsTrustedPaneUri` exact pane URL
- `installer/setup.iss` — `AppVersion=1.0.17`, `PrivilegesRequired=lowest`, `{localappdata}\NavaOutlookAddin`
- Zero `apps/server-pilot/src/outlook-sync/service.ts` `onboardingBounds` — one calendar month `Africa/Johannesburg`
- Zero `apps/server-pilot/src/outlook-sync/storage.ts` — keys `outlook-sync-originals/v1/...` on existing bucket, **not** a new bucket
- Zero `apps/server-pilot/tests/vsto-source-contract.test.ts` — version 1.0.17, `File.Copy`, shutdown no `CustomTaskPanes.Remove`
- Native `tests/native-hardening.test.mjs` — version 1.0.17 + SignManifests + no Send/Delete + no Root CA

Virus history: `docs/plans/2026-10-06-002-reservationist-mvp-evidence-ledger.md` row 6 — 1.0.13 Edge virus detected, Defender CI clean.

---

## File map

**Add-in PR (first):**

- Create: `NavaOutlookAddin/NativeDiagnosticLog.cs`
- Modify: `NavaOutlookAddin/NavaOutlookAddin.csproj` (Compile Include)
- Modify: `NavaOutlookAddin/TaskPaneControl.cs` (`ShowPaneError`)
- Modify: `NavaOutlookAddin/ThisAddIn.cs` (`ToggleTaskPane` catch, `ResumeSync`, `SyncTimer_Tick`, `AttachPane` catch)
- Modify: version stamps to **1.0.18** in dispatcher, AssemblyInfo, csproj ApplicationVersion, `installer/setup.iss`, `.github/workflows/outlook-vsto.yml`
- Modify: `tests/native-hardening.test.mjs` (version + new contracts)

**Zero PR (second, after add-in merge SHA exists):**

- Modify: `apps/server-pilot/vsto` gitlink
- Modify: `apps/server-pilot/tests/vsto-source-contract.test.ts` 1.0.17 → 1.0.18 + new source strings
- Modify: `apps/server-pilot/tests/outlook-addin-installer-nginx.test.ts` AppVersion
- Modify: `docs/pilot/2026-10-08-install-and-onboarding.md` version + SHA **after** CI artifact hash is known
- Do **not** churn every historical 1.0.17 mention in overnight retros

`apps/mail/tests/nava-pane-preview.test.tsx` mock `addinVersion: '1.0.17'` may stay; it is a preview fixture, not the native pin.

---

### Task 1: Native diagnostic log (fail-open, no PII)

**Files:**
- Create: `NavaOutlookAddin/NativeDiagnosticLog.cs`
- Modify: `NavaOutlookAddin/NavaOutlookAddin.csproj` (add `<Compile Include="NativeDiagnosticLog.cs" />` next to other Compile includes)
- Test: `tests/native-hardening.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `internal static class NativeDiagnosticLog` with `Write(string eventName, Exception ex = null)`

- [ ] **Step 1: Write the failing source contract**

In `tests/native-hardening.test.mjs` add:

```javascript
test('native diagnostic log is local, fail-open, and never logs mail', () => {
  const log = source('NavaOutlookAddin/NativeDiagnosticLog.cs');
  const project = source('NavaOutlookAddin/NavaOutlookAddin.csproj');
  assert.match(project, /Compile Include="NativeDiagnosticLog\.cs"/);
  assert.match(log, /internal static class NativeDiagnosticLog/);
  assert.match(log, /NavaOutlookAddin/);
  assert.match(log, /native\.log/);
  assert.match(log, /LocalApplicationData/);
  assert.match(log, /catch\s*\(/);
  absent(log, /PostWebMessage|HttpClient|WebRequest|authorize|outlook-pane/i);
  absent(log, /HTMLBody|Subject|EntryID|Sender|ToRecipients/);
});
```

- [ ] **Step 2: Run it — expect FAIL (file missing)**

```bash
cd <nava-outlook-addin checkout from origin/main>
node --test tests/native-hardening.test.mjs
```

Expected: FAIL cannot find `NativeDiagnosticLog.cs` or the new test assertions.

- [ ] **Step 3: Implement**

```csharp
using System;
using System.IO;

namespace NavaOutlookAddin
{
    internal static class NativeDiagnosticLog
    {
        private static readonly object Gate = new object();
        private const long MaxBytes = 512 * 1024;

        internal static void Write(string eventName, Exception ex = null)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(eventName)) return;
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NavaOutlookAddin");
                Directory.CreateDirectory(dir);
                string path = Path.Combine(dir, "native.log");
                string typeName = ex == null ? "" : ex.GetType().Name;
                string line = DateTime.UtcNow.ToString("o") + " " + eventName;
                if (typeName.Length > 0) line += " " + typeName;
                line += Environment.NewLine;
                lock (Gate)
                {
                    if (File.Exists(path))
                    {
                        var info = new FileInfo(path);
                        if (info.Length > MaxBytes) File.WriteAllText(path, "");
                    }
                    File.AppendAllText(path, line);
                }
            }
            catch
            {
                // Logging must never throw into Outlook.
            }
        }
    }
}
```

Do **not** append `ex.Message` (paths, COM text, entry ids). Event name + type only.

Add the Compile include in the csproj ItemGroup that lists the other `.cs` files.

- [ ] **Step 4: Re-run `node --test tests/native-hardening.test.mjs` — PASS** including old tests (still 1.0.17 until Task 4).

- [ ] **Step 5: Commit** (add-in repo)

```bash
git add NavaOutlookAddin/NativeDiagnosticLog.cs NavaOutlookAddin/NavaOutlookAddin.csproj tests/native-hardening.test.mjs
git commit -m "$(cat <<'EOF'
Add a local fail-open native diagnostic log with no mail content.

EOF
)"
```

---

### Task 2: Dispose failed WebView; log pane/sync swallows

**Files:**
- Modify: `NavaOutlookAddin/TaskPaneControl.cs` `ShowPaneError`
- Modify: `NavaOutlookAddin/ThisAddIn.cs` `ToggleTaskPane`, `AttachPane` catch, `ResumeSync`, `SyncTimer_Tick`
- Test: `tests/native-hardening.test.mjs`

**Interfaces:**
- Consumes: `NativeDiagnosticLog.Write`
- Produces: disposed `_webView` on pane error; toggle-failure disposes control before `EnsurePane`; sync catches log then swallow

- [ ] **Step 1: Failing contracts** in `tests/native-hardening.test.mjs`:

```javascript
test('failed WebView is disposed before the error label replaces it', () => {
  const pane = source('NavaOutlookAddin/TaskPaneControl.cs');
  const error = pane.split('private void ShowPaneError(')[1].split('private void CoreWebView2_NavigationStarting')[0];
  assert.match(error, /_webView\.Dispose\(\)/);
  assert.match(error, /_webView = null/);
  assert.ok(
    error.indexOf('_webView.Dispose()') < error.indexOf('this.Controls.Clear()'),
    'Dispose the WebView before Controls.Clear',
  );
});

test('toggle failure logs before reopening the pane', () => {
  const addin = source('NavaOutlookAddin/ThisAddIn.cs');
  const toggle = addin.split('public void ToggleTaskPane()')[1].split('private async void ResumeSync')[0];
  assert.match(toggle, /NativeDiagnosticLog\.Write\("toggle_pane_failed"/);
  assert.match(toggle, /EnsurePane\(true\)/);
});

test('sync and attach failures log then swallow', () => {
  const addin = source('NavaOutlookAddin/ThisAddIn.cs');
  assert.match(addin, /NativeDiagnosticLog\.Write\("resume_sync_failed"/);
  assert.match(addin, /NativeDiagnosticLog\.Write\("sync_tick_failed"/);
  assert.match(addin, /NativeDiagnosticLog\.Write\("attach_pane_failed"/);
  assert.match(addin, /Pane\/WebView2 failures must not unload the VSTO add-in\./);
  const shutdown = addin.slice(addin.indexOf('ThisAddIn_Shutdown'));
  assert.equal(/CustomTaskPanes\.Remove|TaskPanes\.Remove/.test(shutdown), false);
});
```

- [ ] **Step 2: Run `node --test tests/native-hardening.test.mjs` — FAIL** on new tests.

- [ ] **Step 3: `ShowPaneError`** replace body with:

```csharp
private void ShowPaneError(Exception ex)
{
    NativeDiagnosticLog.Write("pane_init_failed", ex);
    try { _webView?.Dispose(); } catch { }
    _webView = null;
    this.Controls.Clear();
    this.Controls.Add(new Label
    {
        Dock = DockStyle.Fill,
        Padding = new Padding(12),
        Text = "Nava could not start the side pane.\n\n" + ex.Message
    });
}
```

Staff-facing label may still show `ex.Message` (already did). Log must not.

- [ ] **Step 4: `ToggleTaskPane` catch**

Keep success path and the existing `_taskPane = null; EnsurePane(true);`. On exception add only `NativeDiagnosticLog.Write("toggle_pane_failed", ex);` first. Do **not** dispose `_control` here: the old CustomTaskPane can't be removed (the Zero contract slices from the first `ThisAddIn_Shutdown` mention, which forbids `CustomTaskPanes.Remove` almost file-wide), so it would stay in the collection holding a disposed control, and a paint on it can throw `ObjectDisposedException` inside Outlook. The Lee item ("failed WebView null-and-reopen") is covered by `ShowPaneError` in Step 3. (Review note, 2026-10-19.)

- [ ] **Step 5: Sync / attach**

Replace empty catches:

```csharp
private async void ResumeSync()
{
    TaskPaneControl.EnsureUiSynchronizationContext();
    try { await _syncManager.ResumeStoredAsync(); }
    catch (Exception ex) { NativeDiagnosticLog.Write("resume_sync_failed", ex); }
}

private async void SyncTimer_Tick(object sender, EventArgs e)
{
    TaskPaneControl.EnsureUiSynchronizationContext();
    try { await _syncManager.TickAsync(); }
    catch (Exception ex) { NativeDiagnosticLog.Write("sync_tick_failed", ex); }
}
```

In `AttachPane` catch, before the MessageBox: `NativeDiagnosticLog.Write("attach_pane_failed", ex);` Keep the unload comment and do not rethrow.

- [ ] **Step 6: Re-run native-hardening — PASS.** Commit.

```bash
git commit -m "$(cat <<'EOF'
Dispose a failed WebView and log swallowed native pane/sync errors.

EOF
)"
```

---

### Task 3: Version 1.0.18 (native repo)

**Files:**
- `NavaOutlookAddin/OutlookBridgeDispatcher.cs` `ADDIN_VERSION`
- `NavaOutlookAddin/TaskPaneControl.cs` PING reply `{ "version", "1.0.17" }` (~L194; easy to miss, it isn't asserted by any test today)
- `NavaOutlookAddin/Properties/AssemblyInfo.cs`
- `NavaOutlookAddin/NavaOutlookAddin.csproj` `<ApplicationVersion>`
- `installer/setup.iss` `AppVersion` / `VersionInfoVersion`
- `.github/workflows/outlook-vsto.yml` `-Version` and `-p:ApplicationVersion`
- `tests/native-hardening.test.mjs` (the existing `1.0.17` assertions)

- [ ] **Step 1: Change the hardening test** `ADDIN_VERSION = "1.0.17"` → `"1.0.18"` and the matching Assembly/AppVersion/workflow strings in that same test (`one version and verified manifest signing remain in the supervised update`).

- [ ] **Step 2: Run — FAIL** until stamps match.

- [ ] **Step 3: Replace every **product** 1.0.17 stamp listed above with 1.0.18 / 1.0.18.0. Do **not** retarget WebView2 NuGet. Do **not** edit `SignManifests` / mage verify.

- [ ] **Step 4: `node --test tests/native-hardening.test.mjs tests/release-identity.test.mjs tests/native-v4.test.mjs tests/native-security-review.test.mjs` — PASS.** If another mjs still asserts 1.0.17 as the **current** product version, update that assertion only.

- [ ] **Step 5: Commit, push branch, open PR on `kufupa/nava-outlook-addin`.** Wait for Windows CI `outlook-vsto.yml` green (x86+x64, hardening, mageVerify). Do not publish Setup yet.

```bash
git commit -m "$(cat <<'EOF'
Bump the Outlook add-in to 1.0.18.

EOF
)"
```

---

### Task 4: Zero pin + contracts (after add-in merge)

**Files:**
- `apps/server-pilot/vsto` gitlink → merged 1.0.18 SHA
- `apps/server-pilot/tests/vsto-source-contract.test.ts` version test + add strings: `NativeDiagnosticLog`, `resume_sync_failed`, `_webView.Dispose()`, keep `File.Copy(src, dest, true)` and shutdown no-Remove
- `apps/server-pilot/tests/outlook-addin-installer-nginx.test.ts` `AppVersion=1.0.18`

Branch Zero from **`origin/main`**, own worktree. Submodule update to the merged add-in SHA (not a draft SHA).

- [ ] **Step 1: Fail the version test** by pointing gitlink at 1.0.18 first **or** by editing expects to 1.0.18 then updating gitlink. Red, then green.

- [ ] **Step 2: Zero tests** (EC2 / disposable DB rules: this file is source-string, no DB):

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
# on EC2, not the coding VPS:
pnpm --dir apps/server-pilot exec vitest run tests/vsto-source-contract.test.ts tests/outlook-addin-installer-nginx.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit Zero pin PR. Do not deploy installer.**

---

### Task 5: Owner virus-check then publish (human + authorized operator)

Windows CI artifact is **not** live until copied to the download path the way 1.0.17 was (ledger 2026-10-08: served SHA verified). Agent must **not** invent a new GitHub Actions publisher or change certs.

- [ ] **Step 1:** From the green Windows CI run, give owner `NavaOutlookSetup.exe` + SHA-256 + byte size.
- [ ] **Step 2:** Owner: download, Edge/Defender **not** “virus,” close Outlook, install 1.0.18, pane opens, `GET_CAPABILITIES.addinVersion === "1.0.18"`, quote/draft still works. Optional: `%LocalAppData%\NavaOutlookAddin\native.log` exists after a sync tick.
- [ ] **Step 3:** Only after owner says the EXE is clean: authorized publish to `/download/NavaOutlookSetup.exe`, backup 1.0.17, record new SHA in `docs/pilot/2026-10-08-install-and-onboarding.md`.
- [ ] **Step 4:** Owner sends **their** Darren email. Do not send mail from the agent.

---

## Done when

- Add-in 1.0.18 merged; Windows CI green; SignManifests still true; `File.Copy` still overwrite; no WinVerifyTrust; no Root CA.
- Failed WebView disposed; `native.log` fail-open; sync/attach/toggle/pane-init errors logged by event name + exception type only.
- Zero gitlink + contracts on 1.0.18.
- Owner virus-check passed before staff.
- Month-sync code path unchanged; if history still empty after 1.0.18, read `native.log` for `resume_sync_failed` rather than rewriting ingest.

## Out of scope (do not sneak in)

DLL integrity, `SetLoaderDllFolderPath`, disk operation-id cache, native double-click mutex, server log ship, comments-only PR, 256 cap, PaneUrl changes, Send/Delete, new S3 bucket, rewriting `onboardingBounds`.
