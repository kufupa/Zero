import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Outlook add-in installer and nginx download route', () => {
  it('registers a per-user VSTO manifest with file:/// and does not wipe other add-ins', () => {
    const issPath = path.join(root, 'vsto/installer/setup.iss');
    expect(existsSync(issPath)).toBe(true);
    const iss = readFileSync(issPath, 'utf8');
    expect(iss).toContain('PrivilegesRequired=lowest');
    expect(iss).toContain('file:///{app}\\NavaOutlookAddin.vsto|vstolocal');
    expect(iss).toContain('DoNotDisableAddinList');
    expect(iss).not.toMatch(/DisabledItems[\s\S]*deletekey/i);
  });

  it('ships a fallback HKCU install.cmd with file:/// manifest', () => {
    const cmdPath = path.join(root, 'vsto/installer/install.cmd');
    expect(existsSync(cmdPath)).toBe(true);
    const cmd = readFileSync(cmdPath, 'utf8');
    expect(cmd).toContain('%LOCALAPPDATA%\\NavaOutlookAddin');
    expect(cmd).toContain('file:///');
    expect(cmd).toContain('NavaOutlookAddin.vsto|vstolocal');
    expect(cmd).toContain('NavaOutlookAddin\\bin\\Release');
    expect(cmd).not.toMatch(/reg delete .*DisabledItems/i);
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
    expect(deploy).toMatch(/rsync -a --delete --exclude '\/downloads\/'/);
    expect(deploy).toContain('WEB_ROOT}/downloads');
  });
});
