import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const vstoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../vsto/NavaOutlookAddin',
);

function read(file: string): string {
  return readFileSync(path.join(vstoRoot, file), 'utf8');
}

describe('VSTO source contract (Linux, no Outlook compile)', () => {
  it('ships the C# project files', () => {
    for (const file of [
      'ThisAddIn.cs',
      'ThisAddIn.Designer.cs',
      'TaskPaneControl.cs',
      'OutlookBridgeDispatcher.cs',
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

  it('hosts WebView2 after the task pane has a window handle and does not overwrite a loaded loader', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toMatch(/this\.Load \+=/);
    expect(source).not.toMatch(/InitializeComponent\(\);\s*InitializeWebView\(\);/);
    expect(source).toContain('if (!File.Exists(dest))');
  });

  it('binds the pane to the active Explorer when present', () => {
    const source = read('ThisAddIn.cs');
    expect(source).toMatch(/CustomTaskPanes\.Add\([\s\S]*explorer/);
  });

  it('pins the Inno installer version to 1.0.7', () => {
    const iss = readFileSync(
      path.resolve(vstoRoot, '../installer/setup.iss'),
      'utf8',
    );
    expect(iss).toContain('AppVersion=1.0.7');
  });

  it('fails the Windows build when the WebView2 bootstrapper is missing', () => {
    const workflow = readFileSync(
      path.resolve(vstoRoot, '../../../../.github/workflows/outlook-vsto.yml'),
      'utf8',
    );
    expect(workflow).not.toContain('WARN: WebView2 bootstrapper missing');
    expect(workflow).toMatch(/throw ".*WebView2 bootstrapper/);
  });

  it('copies WebView2Loader from LocalAppData install into the VSTO assembly cache', () => {
    const source = read('TaskPaneControl.cs');
    expect(source).toContain('LocalApplicationData');
    expect(source).toContain('GetExecutingAssembly');
    expect(source).toContain('runtimes');
    expect(source).toMatch(/File\.Copy\(src, dest/);
    expect(source).toContain('NavaOutlookAddin');
    expect(source).not.toMatch(
      /string src = Path\.Combine\(dir, "runtimes"/,
    );
  });
});
