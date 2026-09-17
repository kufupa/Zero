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
  });

  it('includes a Home ribbon toggle', () => {
    const source = read('NavaRibbon.cs');
    expect(source).toContain('Nava Assistant');
    expect(source).toContain('ToggleTaskPane');
  });
});
