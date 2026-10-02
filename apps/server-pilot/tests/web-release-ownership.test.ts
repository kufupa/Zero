import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
const checkerUrl = pathToFileURL(path.resolve(import.meta.dirname, '../deploy/check-web-release-ownership.mjs')).href;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const trustedParent = mkdtempSync(path.join(tmpdir(), 'nava-web-ownership-'));
  roots.push(trustedParent);
  chmodSync(trustedParent, 0o755);
  const webRoot = path.join(trustedParent, 'nava-mail');
  mkdirSync(path.join(webRoot, 'releases', 'current', 'assets'), { recursive: true });
  mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  mkdirSync(path.join(webRoot, 'downloads'), { recursive: true });
  writeFileSync(path.join(webRoot, 'releases', 'current', 'assets', 'chunk-abcdefgh.js'), 'trusted');
  writeFileSync(path.join(webRoot, 'assets', 'old-abcdefgh.js'), 'trusted');
  return { trustedParent, webRoot };
}

describe('static web release ownership gate', () => {
  it('runs before publication and protects parents without changing separately managed downloads', () => {
    const deploy = readFileSync(path.resolve(import.meta.dirname, '../deploy/deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('node "$WEB_OWNERSHIP_HELPER" ancestors "$WEB_ROOT"');
    expect(deploy).toContain('sudo install -d -o root -g root -m 0755 "$WEB_ROOT" "${WEB_ROOT}/releases" "${WEB_ROOT}/assets"');
    const releaseGate = deploy.indexOf('node "$WEB_OWNERSHIP_HELPER" release "$WEB_ROOT"');
    expect(releaseGate).toBeGreaterThan(0);
    expect(releaseGate).toBeLessThan(deploy.indexOf('echo "== nginx =="'));
    expect(deploy).toContain('sudo install -d -o www-data -g www-data -m 0755 "${WEB_ROOT}/downloads"');
  });

  it('accepts the complete restricted tree and its separately owned installer-download directory', async () => {
    const { trustedParent, webRoot } = fixture();
    const { verifyWebReleaseOwnership } = await import(checkerUrl);
    expect(() => verifyWebReleaseOwnership(webRoot, { trustedUid: process.getuid(), top: trustedParent })).not.toThrow();
  });

  it('rejects writable ancestors, writable legacy assets, non-root ownership, and symlinks', async () => {
    const { trustedParent, webRoot } = fixture();
    const { verifyWebReleaseOwnership } = await import(checkerUrl);
    const options = { trustedUid: process.getuid(), top: trustedParent };
    chmodSync(trustedParent, 0o775);
    expect(() => verifyWebReleaseOwnership(webRoot, options)).toThrow(/writable/i);
    chmodSync(trustedParent, 0o755);

    const legacyAsset = path.join(webRoot, 'assets', 'old-abcdefgh.js');
    chmodSync(legacyAsset, 0o664);
    expect(() => verifyWebReleaseOwnership(webRoot, options)).toThrow(/writable/i);
    chmodSync(legacyAsset, 0o644);

    chmodSync(path.join(webRoot, 'downloads'), 0o777);
    expect(() => verifyWebReleaseOwnership(webRoot, options)).toThrow(/writable/i);
    chmodSync(path.join(webRoot, 'downloads'), 0o755);

    expect(() => verifyWebReleaseOwnership(webRoot, { ...options, trustedUid: 0 })).toThrow(/owner/i);
    symlinkSync('old-abcdefgh.js', path.join(webRoot, 'assets', 'alias-abcdefgh.js'));
    expect(() => verifyWebReleaseOwnership(webRoot, options)).toThrow(/symlink/i);
  });
});
