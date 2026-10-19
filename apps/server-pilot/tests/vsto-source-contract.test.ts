import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nativeRoot = path.join(repositoryRoot, 'apps/server-pilot/vsto');
const vstoRoot = path.join(nativeRoot, 'NavaOutlookAddin');
const read = (file: string) => readFileSync(path.join(vstoRoot, file), 'utf8');
const hasVstoSource = existsSync(path.join(vstoRoot, 'ThisAddIn.cs'));

describe('VSTO source availability in root CI', () => {
  it('fails closed for Outlook changes unless private source matches the exact gitlink', () => {
    const ci = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('NAVA_OUTLOOK_READ_SSH_KEY');
    expect(ci).toContain('ssh-key: ${{ secrets.NAVA_OUTLOOK_READ_SSH_KEY }}');
    expect(ci).not.toContain('NAVA_OUTLOOK_READ_TOKEN');
    // rev-parse reads the gitlink *object*, not the path printed after ls-tree's tab.
    expect(ci).toContain('git rev-parse HEAD:apps/server-pilot/vsto');
    expect(ci).toContain('git -C apps/server-pilot/vsto rev-parse HEAD');
    for (const criticalPath of [
      'apps/server-pilot/src/trpc/routes/workstation.ts',
      'apps/server-pilot/src/db/schema/outlook-device.ts',
      'apps/server-pilot/src/lib/auth-profile.ts',
      'apps/server-pilot/src/lib/auth.ts',
      'apps/server-pilot/src/main.ts',
      'apps/server-pilot/deploy/nginx.conf',
      'apps/server-pilot/deploy/deploy-ec2.sh',
      'apps/server-pilot/deploy/check-web-release-ownership.mjs',
      'apps/server-pilot/deploy/pane-csp-release.mjs',
      'apps/server-pilot/deploy/write-ec2-env.sh',
      'apps/mail/app/root.tsx',
    ])
      expect(ci).toContain(criticalPath);
    expect(ci).not.toContain('::warning::Private VSTO submodule unavailable');
    expect(ci).toContain('tests/vsto-source-contract.test.ts');
    expect(ci).toContain('tests/outlook-addin-installer-nginx.test.ts');
    expect(ci).toContain('tests/pane-csp-release.test.ts tests/outlook-pane-nginx-route.test.ts');
    expect(ci).toContain('tests/outlook-pane-quote-pdf.test.tsx');
    expect(ci).toContain('tests/auth-signup-guard.test.ts');
  });
});

describe.skipIf(!hasVstoSource)('VSTO v4 source contracts (Linux; no Outlook runtime)', () => {
  it('ships typed COM, signing, paging, and pane modules with both WebView2 runtimes', () => {
    for (const name of [
      'ThisAddIn.cs',
      'ThisAddIn.Designer.cs',
      'TaskPaneControl.cs',
      'OutlookBridgeDispatcher.cs',
      'OutlookBridgeAuthorization.cs',
      'OutlookMailOperations.cs',
      'OutlookMailOperationPolicy.cs',
      'OutlookFolderEmailSnapshotStore.cs',
      'OutlookBridgeOperationCache.cs',
      'NavaRibbon.cs',
      'NativeDiagnosticLog.cs',
      'NavaOutlookAddin.csproj',
    ]) {
      expect(existsSync(path.join(vstoRoot, name)), name).toBe(true);
    }
    const project = read('NavaOutlookAddin.csproj');
    expect(project).toContain('Microsoft.VisualStudio.Tools.Office.Outlook.targets');
    expect(project).toContain('ThisAddIn.Designer.cs');
    expect(project).toContain('Compile Include="OutlookMailOperations.cs"');
    expect(project).toContain('Compile Include="OutlookBridgeAuthorization.cs"');
    expect(project).toContain('Compile Include="NativeDiagnosticLog.cs"');
    expect(project).toContain('CopyWebView2Loader');
    expect(project).toContain('win-x86');
    expect(project).toContain('win-x64');
  });

  it('aligns installer, manifests, assembly, and bridge versions at 1.0.18/v4', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const assembly = read('Properties/AssemblyInfo.cs');
    const installer = readFileSync(path.join(nativeRoot, 'installer/setup.iss'), 'utf8');
    const workflow = readFileSync(
      path.join(nativeRoot, '.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    expect(dispatcher).toContain('BRIDGE_VERSION = 4');
    expect(dispatcher).toContain('ADDIN_VERSION = "1.0.18"');
    expect(assembly).toContain('AssemblyVersion("1.0.18.0")');
    expect(assembly).toContain('AssemblyFileVersion("1.0.18.0")');
    expect(installer).toContain('AppVersion=1.0.18');
    expect(workflow).toContain('-Version 1.0.18.0');
    expect(workflow).toContain('-p:ApplicationVersion=1.0.18.0');
  });

  it('keeps the committed server golden fixture byte-identical to the exact native checkout', () => {
    expect(readFileSync(path.join(nativeRoot, 'tests/fixtures/outlook-sync-v1.json'))).toEqual(
      readFileSync(
        path.join(repositoryRoot, 'apps/server-pilot/tests/fixtures/outlook-sync-v1.json'),
      ),
    );
  });

  it('builds sync modules, advertises capture capability, preserves enrollment, and emits source-bound candidate manifest', () => {
    const project = read('NavaOutlookAddin.csproj');
    for (const module of [
      'OutlookMailboxSyncManager.cs',
      'OutlookMailboxScanner.cs',
      'OutlookMailboxComAdapter.cs',
      'OutlookMailboxCapture.cs',
      'OutlookSyncCheckpointStore.cs',
      'OutlookArtifactUploader.cs',
    ])
      expect(project).toContain('Compile Include="' + module + '"');
    expect(read('OutlookMailOperations.cs')).toContain('mailboxSync');
    expect(read('ThisAddIn.cs')).toContain('OutlookMailboxSyncManager');
    const workflow = readFileSync(
      path.join(nativeRoot, '.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    expect(workflow).toContain('run-mailbox-sync-tests.ps1');
    expect(workflow).toContain('build-manifest.json');
    for (const field of ['behaviorRunnerSha256', 'sourceSha', 'installerSha256'])
      expect(workflow).toContain(field);
    const installer = readFileSync(path.join(nativeRoot, 'installer/setup.iss'), 'utf8');
    expect(installer).not.toMatch(/enrollment[^\n]*(delete|remove)/i);
  });

  it('denies native send and delete in the dispatch and advertised capabilities', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const operations = read('OutlookMailOperations.cs');
    const capabilities = operations.slice(
      operations.indexOf('public Dictionary<string, object> GetCapabilities('),
      operations.indexOf(
        'public ',
        operations.indexOf('public Dictionary<string, object> GetCapabilities(') + 1,
      ),
    );
    expect(capabilities).toContain('GetCapabilities(');
    for (const action of ['SEND_DRAFT', 'DELETE_EMAIL', 'DELETE_EMAIL_PERMANENTLY']) {
      expect(dispatcher).not.toContain(`case "${action}":`);
      expect(capabilities).not.toContain(`"${action}"`);
    }
    for (const action of [
      'CREATE_REPLY_DRAFT',
      'ADD_ATTACHMENT_TO_DRAFT',
      'MOVE_EMAIL',
      'MOVE_TO_SPAM',
    ]) {
      expect(dispatcher).toContain(`case "${action}":`);
      expect(capabilities).toContain(`"${action}"`);
    }
    expect(dispatcher).toContain('Unsupported native action.');
  });

  it('allows pre-login PING with no Outlook COM identity and requires v4 for all messages', () => {
    const pane = read('TaskPaneControl.cs');
    const ping = pane.slice(
      pane.indexOf('if (action == "PING")'),
      pane.indexOf('else if (action == "CLEAR_SESSION")'),
    );
    expect(ping).toContain('bridgeProtocolVersion", 4');
    expect(ping).toContain('deviceId');
    expect(ping).not.toMatch(
      /StoreID|GetCapabilities\(|_dispatcher\.|_application\.|SafeCurrentUserAddress/,
    );
    expect(pane).toContain('OutlookBridgeScopePolicy.IsBridgeVersionFour(version)');
    expect(pane).toContain('Outlook bridge v4 is required.');
  });

  it('pins incoming message source, current top-level pane, outbound replies, and bridge-free popouts', () => {
    const pane = read('TaskPaneControl.cs');
    expect(pane).toContain('https://nava.legacyhotels.co.za/outlook-pane');
    expect(pane).toContain('WebView2Profile');
    expect(pane).toContain('FrameNavigationStarting');
    expect(pane).toContain('AreBridgeMessageOriginsTrusted(currentPageUri, messageSourceUri)');
    expect(pane).toContain(
      'return IsTrustedPaneOrigin(currentPageUri) && IsTrustedPaneOrigin(messageSourceUri)',
    );
    expect(pane).toContain('documentGeneration != _documentGeneration');
    expect(pane).toContain('!IsTrustedPaneOrigin(_webView.CoreWebView2.Source)');
    expect(pane).toContain('Popouts NEVER register WebMessageReceived');
    expect(pane).not.toMatch(/autoAuth|outlookEmail=/i);
  });

  it('signs native HTTPS requests with per-user DPAPI credentials, exact body and challenge', () => {
    const auth = read('OutlookBridgeAuthorization.cs');
    expect(auth).toContain('DataProtectionScope.CurrentUser');
    expect(auth).toContain('SignedPostAsync');
    expect(auth).toContain('SignatureFor(Convert.FromBase64String(_credential.Secret)');
    for (const header of [
      'X-Nava-Device-Id',
      'X-Nava-Nonce',
      'X-Nava-Timestamp',
      'X-Nava-Signature',
    ]) {
      expect(auth).toContain(header);
    }
    expect(auth).toContain('SecurityProtocolType.Tls12');
    expect(auth).toContain('request.AllowAutoRedirect = false');
    expect(auth).not.toMatch(/ServerCertificateValidationCallback\s*=/);
  });

  it('binds each COM operation to signed staff authorization and exact observed scope', () => {
    const pane = read('TaskPaneControl.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    expect(pane).toContain('Native staff ticket and mailbox transport are required.');
    expect(pane).toContain(
      '_dispatcher.ObserveScope(action, payload, _authorization.StoreId, (string)transport)',
    );
    expect(pane).toContain(
      'await _authorization.AuthorizeAsync(observed, (string)ticket, epoch, consentChallenge)',
    );
    expect(pane).toContain(
      'RecheckNativeScope(action, payload, observed, recovered, (string)transport)',
    );
    expect(pane).toContain('_authorization.EnsureCurrent(grant)');
    expect(dispatcher).toContain(
      'EnsureMailInRequestedStore(enrolledStoreId, location["storeId"] as string)',
    );
    expect(dispatcher).toContain('observed.SourceFolderId = folder');
    expect(dispatcher).toContain('EnsureSafeFolder(destination)');
  });

  it('requires exact native move consent, rejects generic denial, and caches only confirmed outcomes', () => {
    const pane = read('TaskPaneControl.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const operations = read('OutlookMailOperations.cs');
    expect(pane).toContain('PREPARE_MOVE_CONSENT');
    expect(pane).toContain('ShowMoveConsent(details, consent.DeadlineUtc)');
    expect(pane).toContain('catch (NativeBatchConsentRequiredException consent)');
    expect(pane).toContain('NATIVE_MOVE_CONSENT_RESOLVED');
    expect(pane).toContain('consentRequestId');
    expect(dispatcher).toContain('_operationCache.TryBegin');
    expect(dispatcher).toContain('_operationCache.StoreCompleted');
    expect(dispatcher).toContain('_operationCache.MarkIndeterminate');
    expect(dispatcher).toContain('OPERATION_OUTCOME_UNKNOWN');
    expect(operations).toContain('EnsureApprovedMove(approval, action,');
    expect(operations).toContain('EnsureConfirmedMoveLocation(confirmedLocation,');
    expect(operations).toContain(
      'throw new InvalidOperationException("Outlook move outcome is unknown;',
    );
  });

  it('retains bounded mail folders, RFC threading, draft placement, attachments and template enumeration', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const operations = read('OutlookMailOperations.cs');
    expect(dispatcher).toContain('0x1035001F');
    expect(dispatcher).toContain('0x007D001F');
    expect(dispatcher).toContain('.GetConversation()');
    expect(dispatcher).toContain('.GetTable()');
    expect(dispatcher).toContain('GetMailLocation(mail)');
    expect(dispatcher).toContain('CreateItemFromTemplate');
    expect(dispatcher).toContain('SaveAsFile');
    expect(dispatcher).toContain('ToBase64String');
    expect(operations).toContain('MaxPageSize = 200');
    expect(operations).toContain('_folderEmailSnapshots.CreatePage');
    expect(operations).toContain('_folderEmailSnapshots.GetPage');
    expect(operations).toContain('GetMailLocationAfterSave(draft,');
    expect(operations).toContain('ResolveDraftsFolder');
    expect(operations).toContain('ShouldOpenReplyComposer');
    expect(operations).toContain('TryReadSmtpAddress');
  });

  it('resolves the approved store Drafts folder before creating or replying to a draft', () => {
    const operations = read('OutlookMailOperations.cs');
    const newDraft = operations.slice(
      operations.indexOf('internal Dictionary<string, object> CreateDraft('),
      operations.indexOf('private Outlook.MAPIFolder ResolveDraftsFolder('),
    );
    const reply = operations.slice(
      operations.indexOf('internal Dictionary<string, object> CreateReplyDraft('),
      operations.indexOf('private static void SafeReleaseMailComObject('),
    );
    expect(newDraft.indexOf('ResolveDraftsFolder(')).toBeGreaterThan(-1);
    expect(newDraft.indexOf('EnsureApprovedDraftsFolder(')).toBeLessThan(
      newDraft.indexOf('CreateDraftInFolder('),
    );
    expect(newDraft.indexOf('ResolveDraftsFolder(')).toBeLessThan(
      newDraft.indexOf('CreateDraftInFolder('),
    );
    expect(reply.indexOf('ResolveDraftsFolder(originalStoreId)')).toBeGreaterThan(-1);
    expect(reply.indexOf('ResolveDraftsFolder(originalStoreId)')).toBeLessThan(
      reply.indexOf('original.Reply'),
    );
    expect(reply.indexOf('EnsureApprovedDraftsFolder(')).toBeLessThan(
      reply.indexOf('original.Reply'),
    );
    expect(reply.indexOf('EnsureProfileDefaultDraftsMatch(')).toBeLessThan(
      reply.indexOf('original.Reply'),
    );
    expect(reply).toContain('approvedDraftsFolderId');
    expect(reply).toContain('draftPlacementWarning');
  });

  it('validates reply composer options before COM side effects and treats post-save display errors as warnings', () => {
    const operations = read('OutlookMailOperations.cs');
    const reply = operations.slice(
      operations.indexOf('internal Dictionary<string, object> CreateReplyDraft('),
      operations.indexOf('private static void SafeReleaseMailComObject('),
    );
    expect(reply.indexOf('ShouldOpenReplyComposer(requestedComposer)')).toBeGreaterThan(-1);
    expect(reply.indexOf('ShouldOpenReplyComposer(requestedComposer)')).toBeLessThan(
      reply.indexOf('original = ResolveRequiredMailItem(payload)'),
    );
    expect(reply.indexOf('ShouldOpenReplyComposer(requestedComposer)')).toBeLessThan(
      reply.indexOf('reply.Save();'),
    );
    expect(reply).toMatch(
      /if \(openInComposer\)[\s\S]*?reply\.Display\(\);[\s\S]*?catch \(System\.Exception ex\)/,
    );
    expect(reply).toContain('result["composerWarning"]');
    expect(reply).toContain('GetMailLocationAfterSave(reply, expectedLocation)');
    expect(operations).toContain('result["locationUnverified"] = true;');
    expect(reply).toContain('SafeReleaseMailComObject(reply);');
    expect(reply).toContain('SafeReleaseMailComObject(original);');
    expect(reply).toContain('SafeReleaseMailComObject(draftsFolder);');
  });

  it('keeps location-read failure recoverable after saving new, updated or reply drafts', () => {
    const operations = read('OutlookMailOperations.cs');
    for (const name of ['CreateDraft', 'UpdateDraft']) {
      const from = operations.indexOf(
        `${name === 'CreateDraft' ? 'internal' : 'public'} Dictionary<string, object> ${name}(`,
      );
      const to = operations.indexOf('\n        private ', from);
      const nextPublic = operations.indexOf('\n        public ', from + 1);
      const end = Math.min(...[to, nextPublic].filter((index) => index > from));
      const method = operations.slice(from, end);
      expect(method, name).toContain('GetMailLocationAfterSave(draft,');
      expect(method, name).toContain('SafeReleaseMailComObject(draft);');
    }
    expect(operations).toContain('result["locationUnverified"] = true;');
  });

  it('uses best-effort COM cleanup for retained Outlook mutations', () => {
    const operations = read('OutlookMailOperations.cs');
    for (const name of ['MoveEmail', 'CreateFolder']) {
      const from = operations.indexOf(`public Dictionary<string, object> ${name}(`);
      const next = operations.indexOf('\n        public ', from + 1);
      expect(operations.slice(from, next), name).toContain('SafeReleaseMailComObject(');
    }
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    for (const name of [
      'AddAttachmentToDraft',
      'SetEmailCategory',
      'SetFollowUpFlag',
      'MarkEmailRead',
    ]) {
      const from = dispatcher.indexOf(`public bool ${name}(`);
      expect(from, name).toBeGreaterThan(-1);
      const next = dispatcher.indexOf('\n        public ', from + 1);
      expect(dispatcher.slice(from, next), name).toContain('SafeReleaseMailComObject(');
    }
  });

  it('waits for the task-pane window handle and replaces stale process-bitness WebView2 loaders', () => {
    const pane = read('TaskPaneControl.cs');
    expect(pane).toMatch(/InitializeComponent\(\);\s*this\.Load \+= TaskPaneControl_Load;/);
    expect(pane).toMatch(/void TaskPaneControl_Load\([\s\S]*?InitializeWebView\(\);/);
    expect(pane).not.toMatch(/InitializeComponent\(\);\s*InitializeWebView\(\);/);
    expect(pane).toContain('Environment.Is64BitProcess ? "win-x64" : "win-x86"');
    expect(pane).toContain('Environment.SpecialFolder.LocalApplicationData');
    expect(pane).toContain('Assembly.GetExecutingAssembly().Location');
    expect(pane).toContain('File.Copy(src, dest, true);');
    expect(pane).not.toContain('if (!File.Exists(dest))');
    expect(pane).toContain('_webView.Dispose()');
    expect(pane).toMatch(/could not start the side pane/i);
  });

  it('wires the ribbon and VSTO shutdown without unloading the add-in or removing task panes', () => {
    const addin = read('ThisAddIn.cs');
    const ribbon = read('NavaRibbon.cs');
    const designer = read('ThisAddIn.Designer.cs');
    expect(ribbon).toContain('Globals.ThisAddIn');
    expect(ribbon).toContain('ToggleTaskPane');
    expect(addin).toContain('Pane/WebView2 failures must not unload');
    expect(addin).toContain('NativeDiagnosticLog');
    expect(addin).toContain('resume_sync_failed');
    expect(addin).toContain('SelectionChange -=');
    expect(addin).toContain('EnsurePane(true)');
    expect(addin).toContain('CustomTaskPanes.Add');
    expect(addin.slice(addin.indexOf('ThisAddIn_Shutdown'))).not.toMatch(
      /CustomTaskPanes\.Remove|TaskPanes\.Remove/,
    );
    expect(designer).toContain('CustomTaskPaneCollection CustomTaskPanes');
    expect(designer).toContain('this.CustomTaskPanes.Dispose');
  });

  it('runs architecture builds, source and pure C# policy tests, and verifies signed manifests', () => {
    const workflow = readFileSync(
      path.join(nativeRoot, '.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    const policy = readFileSync(path.join(nativeRoot, 'tests/BridgePolicyTests.cs'), 'utf8');
    expect(workflow).toContain("@('x86', 'x64')");
    expect(workflow).toContain('Run native hardening source contracts');
    expect(workflow).toContain('Run Outlook bridge policy tests');
    expect(workflow).toContain('mageVerify -Verify $appManifest');
    expect(workflow).toContain('mageVerify -Verify $vsto');
    const mage = workflow.slice(workflow.indexOf('generating with mage.exe'));
    expect(mage.indexOf('-Sign $manifest')).toBeGreaterThan(-1);
    expect(mage.indexOf('-Sign $manifest')).toBeLessThan(mage.indexOf('-New Deployment'));
    expect(policy).toContain('VerifyObservedFolderAndMoveApproval');
    expect(policy).toContain('VerifyLocalTemplatePathRequiresEnumeration');
    expect(policy).toContain('VerifyFolderPagingSurvivesSourceMutation');
    expect(policy).toContain('VerifyServerRetryWithoutLocalEvidenceFailsClosed');
    expect(policy).not.toContain('VerifyPermanentDeleteRequiresConfirmationAndDeletedItems');
  });

  it('documents Office LTSC 2024 as not runtime-verified on staff Windows', () => {
    const readme = readFileSync(path.join(nativeRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Office LTSC 2024');
    expect(readme).toContain('not been runtime-verified');
  });
});
