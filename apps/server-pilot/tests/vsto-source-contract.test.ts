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
  it('warns explicitly when private source is missing, without claiming Windows validation', () => {
    const ci = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('::warning::Private VSTO submodule unavailable');
    expect(ci).toContain('native source and installer contracts NOT verified');
    expect(ci).toContain('workflow in kufupa/nava-outlook-addin for the exact gitlink SHA');
    expect(ci).toContain('tests/vsto-source-contract.test.ts');
    expect(ci).toContain('tests/outlook-addin-installer-nginx.test.ts');
  });
});

describe.skipIf(!hasVstoSource)('VSTO v4 source contracts (Linux; no Outlook runtime)', () => {
  it('ships typed COM, signing, paging, and pane modules with both WebView2 runtimes', () => {
    for (const name of ['ThisAddIn.cs', 'ThisAddIn.Designer.cs', 'TaskPaneControl.cs',
      'OutlookBridgeDispatcher.cs', 'OutlookBridgeAuthorization.cs', 'OutlookMailOperations.cs',
      'OutlookMailOperationPolicy.cs', 'OutlookFolderEmailSnapshotStore.cs',
      'OutlookBridgeOperationCache.cs', 'NavaRibbon.cs', 'NavaOutlookAddin.csproj']) {
      expect(existsSync(path.join(vstoRoot, name)), name).toBe(true);
    }
    const project = read('NavaOutlookAddin.csproj');
    expect(project).toContain('Microsoft.VisualStudio.Tools.Office.Outlook.targets');
    expect(project).toContain('ThisAddIn.Designer.cs');
    expect(project).toContain('Compile Include="OutlookMailOperations.cs"');
    expect(project).toContain('Compile Include="OutlookBridgeAuthorization.cs"');
    expect(project).toContain('CopyWebView2Loader');
    expect(project).toContain('win-x86');
    expect(project).toContain('win-x64');
  });

  it('aligns installer, manifests, assembly, and bridge versions at 1.0.12/v4', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const assembly = read('Properties/AssemblyInfo.cs');
    const installer = readFileSync(path.join(nativeRoot, 'installer/setup.iss'), 'utf8');
    const workflow = readFileSync(path.join(nativeRoot, '.github/workflows/outlook-vsto.yml'), 'utf8');
    expect(dispatcher).toContain('BRIDGE_VERSION = 4');
    expect(dispatcher).toContain('ADDIN_VERSION = "1.0.12"');
    expect(assembly).toContain('AssemblyVersion("1.0.12.0")');
    expect(assembly).toContain('AssemblyFileVersion("1.0.12.0")');
    expect(installer).toContain('AppVersion=1.0.12');
    expect(workflow).toContain('-Version 1.0.12.0');
    expect(workflow).toContain('-p:ApplicationVersion=1.0.12.0');
  });

  it('denies native send and delete in the dispatch and advertised capabilities', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const capabilities = read('OutlookMailOperations.cs').slice(0, 2200);
    for (const action of ['SEND_DRAFT', 'DELETE_EMAIL', 'DELETE_EMAIL_PERMANENTLY']) {
      expect(dispatcher).not.toContain(`case "${action}":`);
      expect(capabilities).not.toContain(`"${action}"`);
    }
    for (const action of ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT', 'MOVE_EMAIL', 'MOVE_TO_SPAM']) {
      expect(dispatcher).toContain(`case "${action}":`);
      expect(capabilities).toContain(`"${action}"`);
    }
    expect(dispatcher).toContain('Unsupported native action.');
  });

  it('allows pre-login PING with no Outlook COM identity and requires v4 for all messages', () => {
    const pane = read('TaskPaneControl.cs');
    const ping = pane.slice(pane.indexOf('if (action == "PING")'), pane.indexOf('else if (action == "CLEAR_SESSION")'));
    expect(ping).toContain('bridgeProtocolVersion", 4');
    expect(ping).toContain('deviceId');
    expect(ping).not.toMatch(/StoreID|GetCapabilities\(|_dispatcher\.|_application\.|SafeCurrentUserAddress/);
    expect(pane).toContain('OutlookBridgeScopePolicy.IsBridgeVersionFour(version)');
    expect(pane).toContain('Outlook bridge v4 is required.');
  });

  it('pins incoming message source, current top-level pane, outbound replies, and bridge-free popouts', () => {
    const pane = read('TaskPaneControl.cs');
    expect(pane).toContain('https://nava.legacyhotels.co.za/outlook-pane');
    expect(pane).toContain('WebView2Profile');
    expect(pane).toContain('FrameNavigationStarting');
    expect(pane).toContain('AreBridgeMessageOriginsTrusted(currentPageUri, messageSourceUri)');
    expect(pane).toContain('return IsTrustedPaneOrigin(currentPageUri) && IsTrustedPaneOrigin(messageSourceUri)');
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
    for (const header of ['X-Nava-Device-Id', 'X-Nava-Nonce', 'X-Nava-Timestamp', 'X-Nava-Signature']) {
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
    expect(pane).toContain('_dispatcher.ObserveScope(action, payload, _authorization.StoreId, (string)transport)');
    expect(pane).toContain('await _authorization.AuthorizeAsync(observed, (string)ticket, epoch)');
    expect(pane).toContain('RecheckNativeScope(action, payload, observed, recovered, (string)transport)');
    expect(pane).toContain('_authorization.EnsureCurrent(grant)');
    expect(dispatcher).toContain('EnsureMailInRequestedStore(enrolledStoreId, location["storeId"] as string)');
    expect(dispatcher).toContain('observed.SourceFolderId = folder');
    expect(dispatcher).toContain('EnsureSafeFolder(destination)');
  });

  it('requires exact native move consent, rejects generic denial, and caches only confirmed outcomes', () => {
    const pane = read('TaskPaneControl.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const operations = read('OutlookMailOperations.cs');
    expect(pane).toContain('OutlookBridgeScopePolicy.NeedsBatchConsent');
    expect(pane).toContain('ShowMoveConsent(observed)');
    expect(pane).toContain('catch (NativeBatchConsentRequiredException)');
    expect(dispatcher).toContain('_operationCache.TryBegin');
    expect(dispatcher).toContain('_operationCache.StoreCompleted');
    expect(dispatcher).toContain('_operationCache.MarkIndeterminate');
    expect(dispatcher).toContain('OPERATION_OUTCOME_UNKNOWN');
    expect(operations).toContain('EnsureApprovedMove(approval, action,');
    expect(operations).toContain('EnsureConfirmedMoveLocation(confirmedLocation,');
    expect(operations).toContain('throw new InvalidOperationException("Outlook move outcome is unknown;');
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

  it('runs architecture builds, source and pure C# policy tests, and verifies signed manifests', () => {
    const workflow = readFileSync(path.join(nativeRoot, '.github/workflows/outlook-vsto.yml'), 'utf8');
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
