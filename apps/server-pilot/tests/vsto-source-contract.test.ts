import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const vstoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../vsto/NavaOutlookAddin',
);

function read(file: string): string {
  return readFileSync(path.join(vstoRoot, file), 'utf8');
}

const hasVstoSource = existsSync(path.join(vstoRoot, 'ThisAddIn.cs'));

describe('VSTO source contract (Linux, no Outlook compile)', () => {
  it('reports unavailable private native source in root CI instead of silently skipping', () => {
    expect(hasVstoSource).toBe(true);
    const ci = readFileSync(path.resolve(vstoRoot, '../../../../.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('tests/workstation-bridge-protocol.test.tsx');
    expect(ci).toContain('::warning::Private VSTO submodule unavailable');
    expect(ci).toContain('native source and installer contracts NOT verified');
    expect(ci).toContain('tests/vsto-source-contract.test.ts');
    expect(ci).toContain('tests/outlook-addin-installer-nginx.test.ts');
  });

  it('releases temporary Outlook Session references during PING', () => {
    const source = read('OutlookBridgeDispatcher.cs');
    const getUser = source.slice(
      source.indexOf('private string SafeCurrentUserAddress()'),
      source.indexOf('private static string SafeRowValue('),
    );
    expect(getUser).toContain('Outlook.NameSpace session = null;');
    expect(getUser).toContain('Marshal.ReleaseComObject(session)');
  });

  it('compiles pure policy helpers with the Framework C# compiler used by CI', () => {
    expect(read('OutlookBridgeOperationCache.cs')).not.toContain('is IEnumerable sequence');
  });
  it('ships the C# project files', () => {
    for (const file of [
      'ThisAddIn.cs',
      'ThisAddIn.Designer.cs',
      'TaskPaneControl.cs',
      'OutlookBridgeDispatcher.cs',
      'OutlookMailOperations.cs',
      'OutlookFolderEmailSnapshotStore.cs',
      'OutlookMailOperationPolicy.cs',
      'OutlookBridgeOperationCache.cs',
      'NavaRibbon.cs',
      'NavaOutlookAddin.csproj',
    ]) {
      expect(existsSync(path.join(vstoRoot, file)), file).toBe(true);
    }
  });

  it('persists WebView2 cookies in a dedicated UserDataFolder', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('WebView2Profile');
    expect(source).toContain('NavaOutlookAddin');
    expect(source).not.toMatch(/outlookEmail=/);
    expect(source).not.toMatch(/workstationUser=/);
    expect(source).toContain('https://nava.legacyhotels.co.za/outlook-pane');
  });

  it('uses GetTable and MAPI internet headers instead of ConversationID for RFC threading', () => {
    const source = read('OutlookBridgeDispatcher.cs');
    expect(source).toContain('GetTable');
    expect(source).toContain('0x1035001F');
    expect(source).toContain('0x007D001F');
    expect(source).toContain('ReleaseComObject');
    expect(source).not.toMatch(/autoAuth/i);
    expect(source).toMatch(/"bodyText",\s*includeBodies \? \(mail\.Body/);
    expect(source).toMatch(/"bodyHtml",\s*includeBodies \? \(mail\.HTMLBody/);
  });

  it('unhooks SelectionChange and releases COM on shutdown', () => {
    const source = read('ThisAddIn.cs');
    expect(source).toContain('SelectionChange -=');
    expect(source).toContain('ReleaseComObject');
    expect(source).toContain('ThisAddIn_Shutdown');
    expect(source).toContain('CreateRibbonExtensibilityObject');
    expect(source).toContain('Pane/WebView2 failures must not unload');
  });

  it('pins WebView2 messages to the Nava origin', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('nava.legacyhotels.co.za');
    expect(source).toContain('NavigationStarting');
    expect(source).toContain('IsTrustedPaneOrigin');
  });

  it('imports VSTO Outlook targets and the designer partial', () => {
    const csproj = read('NavaOutlookAddin.csproj');
    expect(csproj).toContain('ThisAddIn.Designer.cs');
    expect(csproj).toContain('Microsoft.VisualStudio.Tools.Office.Outlook.targets');
  });

  it('includes a Nava ribbon tab and Home-mail toggle', () => {
    const source = read('NavaRibbon.cs');
    expect(source).toContain('Nava Assistant');
    expect(source).toContain('ToggleTaskPane');
    const xml = read('NavaRibbon.xml');
    expect(xml).toContain('id="NavaTab"');
    expect(xml).toContain('idMso="TabMail"');
  });

  it('copies WebView2Loader.dll next to the add-in', () => {
    const csproj = read('NavaOutlookAddin.csproj');
    expect(csproj).toContain('CopyWebView2Loader');
    expect(csproj).toContain('WebView2Loader.dll');
  });

  it('picks WebView2Loader by Outlook process bitness and shows pane errors', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('Is64BitProcess');
    expect(source).toContain('win-x64');
    expect(source).toContain('win-x86');
    expect(source).toContain('WebView2Loader.dll');
    expect(source).toMatch(/could not start the side pane/i);
  });

  it('retries the task pane when Nava Assistant is clicked', () => {
    const source = read('ThisAddIn.cs');
    expect(source).toContain('EnsurePane');
    expect(source).toMatch(/if \(_taskPane == null\)/);
    expect(source).toContain('EnsurePane(true)');
    expect(source).toContain('_taskPane.Visible = true');
    expect(source).not.toContain('_taskPane.Visible = !_taskPane.Visible');
  });

  it('wires the ribbon to Globals.ThisAddIn so a click cannot no-op', () => {
    const ribbon = read('NavaRibbon.cs');
    expect(ribbon).toContain('Globals.ThisAddIn');
    const source = read('ThisAddIn.cs');
    const internalStartup = source.slice(source.indexOf('InternalStartup'));
    expect(internalStartup).toContain('Instance = this');
  });

  it('ships x64 and x86 WebView2Loader runtimes', () => {
    const csproj = read('NavaOutlookAddin.csproj');
    expect(csproj).toContain('win-x64');
    expect(csproj).toContain('win-x86');
  });

  it('creates CustomTaskPanes via the VSTO factory instead of dynamic', () => {
    const designer = read('ThisAddIn.Designer.cs');
    expect(designer).toContain('CustomTaskPaneCollection CustomTaskPanes');
    expect(designer).toContain('CreateCustomTaskPaneCollection');
    expect(designer).toContain('this.CustomTaskPanes.Dispose');
    const source = read('ThisAddIn.cs');
    expect(source).not.toContain('(dynamic)this');
    expect(source).toContain('this.CustomTaskPanes');
  });

  it('does not Remove custom task panes during ThisAddIn_Shutdown', () => {
    const source = read('ThisAddIn.cs');
    const shutdown = source.slice(source.indexOf('ThisAddIn_Shutdown'));
    expect(shutdown).not.toMatch(/CustomTaskPanes\.Remove|TaskPanes\.Remove/);
  });

  it('hosts WebView2 after the task pane has a window handle and overwrites a stale loader', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toMatch(/this\.Load \+=/);
    expect(source).not.toMatch(/InitializeComponent\(\);\s*InitializeWebView\(\);/);
    expect(source).toMatch(/File\.Copy\(src, dest,\s*true\)/);
    expect(source).not.toContain('if (!File.Exists(dest))');
  });

  it('binds the pane to the active Explorer when present', () => {
    const source = read('ThisAddIn.cs');
    expect(source).toMatch(/CustomTaskPanes\.Add\([\s\S]*explorer/);
    expect(source).toContain('NewExplorer');
    expect(source).not.toMatch(/CustomTaskPanes\.Add\(_control,\s*"Nava AI Reservationist"\s*\)/);
    expect(source).toMatch(/void AttachPane\(Outlook\.Explorer explorer/);
    expect(source).toMatch(/Explorers_NewExplorer[\s\S]*AttachPane\(explorer/);
    expect(source).not.toMatch(
      /Explorers_NewExplorer[\s\S]*StopWaitingExplorer\(\);\s*if \(_taskPane == null\)[\s\S]*EnsurePane\(false\)/,
    );
  });

  it('pins the Inno installer version to 1.0.9', () => {
    const iss = readFileSync(path.resolve(vstoRoot, '../installer/setup.iss'), 'utf8');
    expect(iss).toContain('AppVersion=1.0.9');
  });

  it('compiles the typed mail operations into the installed VSTO assembly', () => {
    const csproj = read('NavaOutlookAddin.csproj');
    expect(csproj).toContain('Compile Include="OutlookMailOperations.cs"');
    expect(read('OutlookMailOperations.cs')).toContain(
      'public partial class OutlookBridgeDispatcher',
    );
  });

  it('fails the Windows build when the WebView2 bootstrapper is missing', () => {
    const workflow = readFileSync(
      path.resolve(vstoRoot, '../.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    expect(workflow).not.toContain('WARN: WebView2 bootstrapper missing');
    expect(workflow).toMatch(/throw ".*WebView2 bootstrapper/);
  });

  it('signs the application manifest before mage writes the .vsto deployment', () => {
    const workflow = readFileSync(
      path.resolve(vstoRoot, '../.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    const mageBlock = workflow.slice(workflow.indexOf('generating with mage.exe'));
    const signManifest = mageBlock.indexOf('-Sign $manifest');
    const newDeploy = mageBlock.indexOf('-New Deployment');
    expect(signManifest).toBeGreaterThan(-1);
    expect(newDeploy).toBeGreaterThan(-1);
    expect(signManifest).toBeLessThan(newDeploy);
  });

  it('copies WebView2Loader from LocalAppData install into the VSTO assembly cache', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('LocalApplicationData');
    expect(source).toContain('GetExecutingAssembly');
    expect(source).toContain('runtimes');
    expect(source).toMatch(/File\.Copy\(src, dest/);
    expect(source).toContain('NavaOutlookAddin');
    expect(source).not.toMatch(/string src = Path\.Combine\(dir, "runtimes"/);
  });

  it('exposes protocol v3 enterprise actions for templates, attachments, and triage', () => {
    const source = read('OutlookBridgeDispatcher.cs');
    expect(source).toContain('BRIDGE_VERSION = 3');
    for (const action of [
      'LIST_TEMPLATES',
      'GET_TEMPLATE_CONTENT',
      'LIST_SIGNATURES',
      'GET_ATTACHMENT_METADATA',
      'READ_ATTACHMENT_BASE64',
      'ADD_ATTACHMENT_TO_DRAFT',
      'SET_EMAIL_CATEGORY',
      'SET_FOLLOW_UP_FLAG',
      'MARK_EMAIL_READ',
      'GET_CONVERSATION_THREAD',
    ]) {
      expect(source).toContain(`case "${action}":`);
    }
    expect(source).toContain('CreateItemFromTemplate');
    expect(source).toContain('Microsoft", "Templates"');
    expect(source).toContain('Microsoft", "Signatures"');
    expect(source).toContain('SaveAsFile');
    expect(source).toContain('ToBase64String');
  });

  it('exposes reusable, store-aware mail operations in protocol v3', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const source = dispatcher + read('OutlookMailOperations.cs');
    expect(dispatcher).toContain('BRIDGE_VERSION = 3');
    for (const action of [
      'GET_CAPABILITIES',
      'LIST_STORES',
      'LIST_FOLDERS',
      'UPDATE_DRAFT',
      'LIST_ACCOUNTS',
      'SEND_DRAFT',
      'DELETE_EMAIL',
      'DELETE_EMAIL_PERMANENTLY',
    ]) {
      expect(dispatcher).toContain(`case "${action}":`);
    }
    expect(source).toContain('GetFolderFromID');
    expect(source).toContain('GetItemFromID(entryId, storeId)');
    expect(source).toContain('MaxPageSize = 200');
    expect(source).toContain('continuationToken');
    expect(source).toContain('OutlookFolderEmailSnapshotStore');
    expect(source).not.toContain('skipped < firstIndex');
    expect(source).toContain('targetFolderEntryId or folderName is required');
    expect(source).toContain('confirmPermanentDelete');
    expect(source).toContain('SendUsingAccount');
    expect(source).toContain('replyAll');
    expect(source).toContain('openInComposer');
  });

  it('requires a saved draft before sending and gates permanent deletion', () => {
    const source = read('OutlookBridgeDispatcher.cs') + read('OutlookMailOperations.cs');
    expect(source).toContain('EnsureItemIsInDraftsFolder');
    expect(source).toContain('confirmPermanentDelete');
    expect(source).toContain('EnsureItemIsInDeletedItemsFolder');
  });

  it('stores new and reply drafts in the requested Outlook store Drafts folder', () => {
    const source = read('OutlookMailOperations.cs');
    expect(source).toContain(
      'MoveDraftToStore(reply, PayloadString(payload, "storeId"), out draftPlacementWarning)',
    );
    const createDraft = source.slice(
      source.indexOf('public Dictionary<string, object> CreateDraft('),
      source.indexOf('public Dictionary<string, object> UpdateDraft('),
    );
    const createReplyDraft = source.slice(
      source.indexOf('public Dictionary<string, object> CreateReplyDraft('),
      source.indexOf('private Outlook.MailItem MoveDraftToStore('),
    );
    expect(createDraft.indexOf('ResolveDraftsFolder')).toBeGreaterThanOrEqual(0);
    expect(createDraft.indexOf('ResolveDraftsFolder')).toBeLessThan(
      createDraft.indexOf('CreateDraftInFolder'),
    );
    expect(createReplyDraft.indexOf('ResolveDraftsFolder')).toBeLessThan(
      createReplyDraft.indexOf('original.Reply'),
    );
    expect(source).toContain('draftPlacementWarning');
  });

  it('preserves a saved reply result when Outlook rejects composer display after a move', () => {
    const source = read('OutlookMailOperations.cs');
    expect(source).toContain('composerWarning');
    expect(source).toContain(
      'MoveDraftToStore(reply, PayloadString(payload, "storeId"), out draftPlacementWarning)',
    );
    expect(source).toMatch(
      /if \(openInComposer\)[\s\S]*?reply\.Display\(\);[\s\S]*?catch \(System\.Exception ex\)/,
    );
    expect(source).toContain('result["locationUnverified"] = true;');
    expect(source).not.toContain('if (draftPlacementWarning == null) throw;');
  });

  it('validates composer options before reply side effects and cannot fail during post-save COM cleanup', () => {
    const source = read('OutlookMailOperations.cs');
    const reply = source.slice(
      source.indexOf('public Dictionary<string, object> CreateReplyDraft('),
      source.indexOf('private Outlook.MailItem MoveDraftToStore('),
    );
    expect(reply.indexOf('PayloadBool(payload, "openInComposer", false)')).toBeLessThan(
      reply.indexOf('reply.Save();'),
    );
    expect(reply).toContain('SafeReleaseMailComObject(reply);');
    expect(reply).toContain('SafeReleaseMailComObject(original);');
    expect(reply).toContain('SafeReleaseMailComObject(draftsFolder);');
  });

  it('cannot turn a saved new or updated draft into an uncached error while reading its location', () => {
    const source = read('OutlookMailOperations.cs');
    for (const operation of ['CreateDraft', 'UpdateDraft']) {
      const start = source.indexOf(`public Dictionary<string, object> ${operation}(`);
      const next = source.indexOf('\n        public ', start + 1);
      const method = source.slice(start, next);
      expect(method, operation).toContain('GetMailLocationAfterSave(');
      expect(method, operation).toContain('SafeReleaseMailComObject(draft);');
    }
    expect(source).toContain('locationUnverified');
  });

  it('makes post-mutation COM cleanup best-effort across mail mutations', () => {
    const source = read('OutlookMailOperations.cs');
    for (const operation of [
      'SendDraft',
      'MoveEmail',
      'CreateFolder',
      'DeleteEmail',
      'DeleteEmailPermanently',
    ]) {
      const start = source.indexOf(`public Dictionary<string, object> ${operation}(`);
      const next = source.indexOf('\n        public ', start + 1);
      const method = source.slice(start, next);
      expect(method, operation).toContain('SafeReleaseMailComObject(');
    }
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    for (const operation of [
      'AddAttachmentToDraft',
      'SetEmailCategory',
      'SetFollowUpFlag',
      'MarkEmailRead',
    ]) {
      const start = dispatcher.indexOf(`public bool ${operation}(`);
      const next = dispatcher.indexOf('\n        public ', start + 1);
      const method = dispatcher.slice(start, next);
      expect(method, operation).toContain('SafeReleaseMailComObject(');
    }
  });

  it('uses a shared folder-alias mapper for default and selected stores', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const operations = read('OutlookMailOperations.cs');
    expect(dispatcher).toContain('TryGetDefaultFolderType(key, out');
    expect(operations).toContain('TryGetDefaultFolderType(key, out');
    expect(dispatcher + operations).toContain('private static bool TryGetDefaultFolderType');
  });

  it('uses a bounded immutable folder snapshot and cursor instead of live offsets', () => {
    const operations = read('OutlookMailOperations.cs');
    const snapshots = read('OutlookFolderEmailSnapshotStore.cs');
    expect(operations).toContain('_folderEmailSnapshots.CreatePage');
    expect(operations).toContain('_folderEmailSnapshots.GetPage');
    expect(operations).toContain('continuationToken');
    expect(operations).not.toContain('skipped < firstIndex');
    expect(snapshots).toContain('MaxSnapshotItems = 5000');
    expect(snapshots).toContain('snapshotTruncated');
  });

  it('requires explicit account selection and skips non-SMTP accounts', () => {
    const source = read('OutlookMailOperations.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    expect(source).toContain('if (string.IsNullOrWhiteSpace(smtpAddress)) continue;');
    expect(source).toContain('OutlookMailOperationPolicy.EnsureSendAccountSelection');
    expect(source).toContain('useDefaultAccount');
    expect(source).toContain('submitted');
    expect(source).not.toContain('{ "sent", true }');
    expect(source).toContain('catch (System.Exception)');
    expect(dispatcher).toContain('_operationCache.TryGet');
    expect(dispatcher).toContain('_operationCache.StoreCompleted');
    expect(dispatcher).toContain('operationId');
  });

  it('rejects nonblank legacy account identifiers without an SMTP separator', () => {
    const policy = read('OutlookMailOperationPolicy.cs');
    expect(policy).toContain("address.IndexOf('@')");
    const harness = readFileSync(path.resolve(vstoRoot, '../tests/BridgePolicyTests.cs'), 'utf8');
    expect(harness).toContain('legacyExchangeAddress');
  });

  it('runs pure bridge policy and snapshot tests in the Windows build', () => {
    const workflow = readFileSync(
      path.resolve(vstoRoot, '../.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    const tests = readFileSync(path.resolve(vstoRoot, '../tests/BridgePolicyTests.cs'), 'utf8');
    expect(workflow).toContain('Run Outlook bridge policy tests');
    expect(workflow).toContain('BridgePolicyTests.cs');
    expect(tests).toContain('VerifyFolderPagingSurvivesSourceMutation');
    expect(tests).toContain('VerifyPermanentDeleteRequiresConfirmationAndDeletedItems');
  });

  it('includes Outlook mail subclasses when paging folders', () => {
    const operations = read('OutlookMailOperations.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const source = operations + dispatcher;
    expect(dispatcher).toContain(
      'MAIL_ITEM_CLASS_FILTER = "@SQL=\\\"https://schemas.microsoft.com/mapi/proptag/0x001A001F\\\" LIKE \'IPM.Note%\'"',
    );
    expect(operations).toContain('GetTable(MAIL_ITEM_CLASS_FILTER,');
    expect(source).not.toContain("[MessageClass] LIKE 'IPM.Note*'");
    expect(source).not.toContain("[MessageClass] = 'IPM.Note'");
  });

  it('resolves conversation rows through Outlook Conversation.GetTable and store IDs', () => {
    const source = read('OutlookBridgeDispatcher.cs');
    const methodStart = source.indexOf(
      'public List<Dictionary<string, object>> GetConversationThread(',
    );
    const methodEnd = source.indexOf(
      '\n        private Outlook.MailItem ResolveMailItem',
      methodStart,
    );
    const method = source.slice(methodStart, methodEnd);

    expect(source).toContain('PR_STORE_ENTRYID');
    expect(method).toContain('.GetConversation()');
    expect(method).toContain('.GetTable()');
    expect(method).toContain('row.BinaryToString(PR_STORE_ENTRYID)');
    expect(method).toContain(
      'ResolveMailItem(PayloadString(payload, "entryId"), PayloadString(payload, "storeId"))',
    );
    expect(method).toContain('session.GetItemFromID(rowEntryId, rowStoreId)');
    expect(method).toContain('GetMailLocation(mail)');
    expect(method).toContain('item is Outlook.MailItem mail');
    expect(method).toContain('list.Count < maxResults');
    expect(method).not.toContain('folder.GetTable(');
    expect(method).not.toContain('columns.Add("ConversationID")');
  });

  it('clears Outlook Table default columns before adding the requested mail fields', () => {
    const operations = read('OutlookMailOperations.cs');
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    expect(operations).toMatch(/columns = table\.Columns;\s*columns\.RemoveAll\(\);/);
    expect(dispatcher).toMatch(/columns = table\.Columns;\s*columns\.RemoveAll\(\);/);
  });

  it('requires both the active WebView page and message sender to be trusted', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('AreBridgeMessageOriginsTrusted');
    expect(source).toMatch(
      /IsTrustedPaneOrigin\(currentPageUri\)\s*&&\s*IsTrustedPaneOrigin\(messageSourceUri\)/,
    );
    expect(source).toContain('parsed.IsDefaultPort');
    expect(source).not.toMatch(
      /!IsTrustedPaneOrigin\(_webView\?\.Source\?\.ToString\(\) \?\? ""\)\s*&&/,
    );
  });

  it('keeps installer, add-in assembly, and bridge product versions aligned', () => {
    const dispatcher = read('OutlookBridgeDispatcher.cs');
    const assembly = read('Properties/AssemblyInfo.cs');
    const iss = readFileSync(path.resolve(vstoRoot, '../installer/setup.iss'), 'utf8');
    const workflow = readFileSync(
      path.resolve(vstoRoot, '../.github/workflows/outlook-vsto.yml'),
      'utf8',
    );

    expect(dispatcher).toContain('{ "version", ADDIN_VERSION }');
    expect(dispatcher).toContain('ADDIN_VERSION = "1.0.9"');
    expect(assembly).toContain('AssemblyVersion("1.0.9.0")');
    expect(assembly).toContain('AssemblyFileVersion("1.0.9.0")');
    expect(iss).toContain('AppVersion=1.0.9');
    expect(workflow).toContain('-Version 1.0.9.0');
  });

  it('documents Office LTSC 2024 as a 16.0 but unverified runtime target', () => {
    const readme = readFileSync(path.resolve(vstoRoot, '../README.md'), 'utf8');
    expect(readme).toContain('Office LTSC 2024');
    expect(readme).toContain('not been runtime-verified');
    expect(readme).toContain('16.0');
  });
});
