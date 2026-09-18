import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Outlook add-in installer and nginx download route', () => {
  it('ships a zero-admin installer that kills Outlook, trusts the cert, and does not wipe other add-ins', () => {
    const issPath = path.join(root, 'vsto/installer/setup.iss');
    expect(existsSync(issPath)).toBe(true);
    const iss = readFileSync(issPath, 'utf8');
    expect(iss).toContain('AppVersion=1.0.5');
    expect(iss).toContain('PrivilegesRequired=lowest');
    expect(iss).toContain('RegisterTrust.exe');
    expect(iss).toContain('taskkill');
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
});
