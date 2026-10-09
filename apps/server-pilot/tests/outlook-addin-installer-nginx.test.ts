import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasVstoInstaller = existsSync(path.join(root, 'vsto/installer/setup.iss'));

describe('Outlook add-in installer and nginx download route', () => {
  describe.skipIf(!hasVstoInstaller)('Outlook add-in installer source contract', () => {
    it('ships a zero-admin installer that refuses open Outlook, trusts the cert, and does not wipe other add-ins', () => {
      const issPath = path.join(root, 'vsto/installer/setup.iss');
      expect(existsSync(issPath)).toBe(true);
      const iss = readFileSync(issPath, 'utf8');
      expect(iss).toContain('AppVersion=1.0.17');
      expect(iss).toContain('PrivilegesRequired=lowest');
      expect(iss).toContain('RegisterTrust.exe');
      expect(iss).not.toMatch(/taskkill/i);
      expect(iss).toContain('CloseApplications=no');
      expect(iss).toContain('RestartApplications=no');
      expect(iss).toContain('OUTLOOK.EXE');
      expect(iss).toContain('VSTO Runtime Setup');
      expect(iss).toContain('MicrosoftEdgeWebview2Setup.exe');
      expect(iss).toContain('DoNotDisableAddinList');
      expect(iss).toContain('Office\\15.0\\Outlook\\Resiliency');
      expect(iss).not.toMatch(/powershell/i);
      expect(iss).not.toMatch(/DisabledItems[\s\S]*deletekey/i);

      const trustCs = path.join(root, 'vsto/installer/RegisterTrust.cs');
      expect(existsSync(trustCs)).toBe(true);
      const trust = readFileSync(trustCs, 'utf8');
      expect(trust).toContain('StoreName.TrustedPublisher');
      expect(trust).toContain('StoreLocation.CurrentUser');
      expect(trust).toContain('AbsoluteUri');
      expect(trust).toContain('|vstolocal');
      expect(trust).toContain('InclusionList');
      expect(trust).toContain('LoadBehavior');
      expect(trust).toContain('DoNotDisableAddinList');
      expect(trust).toContain('"15.0"');
      expect(trust).toContain('"16.0"');
      expect(trust).not.toMatch(/powershell/i);
      const writeAt = trust.indexOf('WriteAddinRegistration');
      const storeAt = trust.indexOf('AddToStore(StoreName.TrustedPublisher');
      expect(storeAt).toBeGreaterThan(-1);
      expect(writeAt).toBeGreaterThan(storeAt);
    });

    it('aborts Setup if RegisterTrust, WebView2, or Outlook-still-running would leave a dead add-in', () => {
      const iss = readFileSync(path.join(root, 'vsto/installer/setup.iss'), 'utf8');
      expect(iss).toMatch(/procedure EnsureTrust[\s\S]*RegisterTrust\.exe[\s\S]*FailSetup/);
      expect(iss).toMatch(/Listing:\s*AnsiString/);
      expect(iss).toMatch(/AfterInstall:\s*RunPostCopyGates/);
      expect(iss).toMatch(/procedure FailSetup[\s\S]*RaiseException/);
      expect(iss).not.toMatch(/ssPostInstall/);
      expect(iss).not.toMatch(
        /if not Exec\(ExpandConstant\('\{app\}\\RegisterTrust\.exe'\)[\s\S]*then\s+MsgBox\('Could not start Nava trust helper\.'/,
      );

      expect(iss).toContain('MicrosoftEdgeWebview2Setup.exe');
      expect(iss).toMatch(/procedure EnsureWebView2[\s\S]*not WebView2Present[\s\S]*FailSetup/);
      expect(iss).not.toMatch(
        /Filename: "\{tmp\}\\MicrosoftEdgeWebview2Setup\.exe";[\s\S]*Flags: waituntilterminated skipifdoesntexist/,
      );

      const prepare = iss.slice(iss.indexOf('PrepareToInstall'));
      expect(prepare).toContain('if OutlookStillRunning then');
      expect(prepare).toMatch(/Result := '/);
      expect(prepare).toContain('Save unsaved Outlook drafts and close Outlook completely');
      expect(prepare).toContain('Setup will not force-close Outlook');
    });

    it('ships a fallback HKCU install.cmd that copies Release output then runs RegisterTrust', () => {
      const cmdPath = path.join(root, 'vsto/installer/install.cmd');
      expect(existsSync(cmdPath)).toBe(true);
      const cmd = readFileSync(cmdPath, 'utf8');
      expect(cmd).toContain('%LOCALAPPDATA%\\NavaOutlookAddin');
      expect(cmd).toContain('RegisterTrust.exe');
      expect(cmd).toContain('NavaOutlookAddin\\bin\\Release');
      expect(cmd).not.toMatch(/reg delete .*DisabledItems/i);
      expect(cmd).not.toMatch(/powershell/i);
    });
  });

  it('serves NavaOutlookSetup.exe from nginx before the SPA catch-all', () => {
    const nginx = readFileSync(path.join(root, 'deploy/nginx.conf'), 'utf8');
    const location = `location = /download/NavaOutlookSetup.exe`;
    expect(nginx).toContain(location);
    expect(nginx).toContain('application/vnd.microsoft.portable-executable');
    expect(nginx).toContain('attachment; filename="NavaOutlookSetup.exe"');

    const publicServer = nginx.split('server_name nava.legacyhotels.co.za;')[2] ?? nginx;
    const downloadIndex = publicServer.indexOf(location);
    const spaIndex = publicServer.indexOf('location / {');
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBeLessThan(spaIndex);
  });

  it('does not delete nginx downloads when rsyncing the mail SPA', () => {
    const deploy = readFileSync(path.join(root, 'deploy/deploy-ec2.sh'), 'utf8');
    expect(deploy).toMatch(
      /rsync -a --ignore-existing --chown=root:root --exclude '\/downloads\/'/,
    );
    expect(deploy).not.toMatch(/rsync -a --delete/);
    expect(deploy).toContain('WEB_ROOT}/downloads');
  });
});
