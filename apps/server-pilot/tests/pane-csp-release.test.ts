import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const pilot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = join(pilot, 'deploy');
const helper = join(deployDir, 'pane-csp-release.mjs');
const template = join(deployDir, 'nginx.conf');
const builtIndex = resolve(pilot, '../mail/build/client/index.html');
const tempPaths: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pane-csp-release-test-'));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runHelper(...args: string[]) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
}

function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
    .map(([, , body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

function fixture(html: string, additionalFiles: Record<string, string> = {}) {
  const webRoot = tempDir();
  const source = join(webRoot, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'index.html'), html);
  for (const [path, content] of Object.entries(additionalFiles)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  const identity = runHelper('id', source);
  expect(identity.status, identity.stderr).toBe(0);
  const id = identity.stdout.trim();
  const index = join(webRoot, 'releases', id, 'index.html');
  const candidate = join(webRoot, 'candidate.conf');
  mkdirSync(dirname(index), { recursive: true });
  renameSync(join(source, 'index.html'), index);
  for (const path of Object.keys(additionalFiles)) {
    mkdirSync(dirname(join(webRoot, 'releases', id, path)), { recursive: true });
    renameSync(join(source, path), join(webRoot, 'releases', id, path));
  }
  return { candidate, id, index, webRoot };
}

function localStageScript() {
  const deploy = readFileSync(join(deployDir, 'deploy-ec2.sh'), 'utf8');
  const start = deploy.indexOf('echo "== stage immutable mail release =="');
  const end = deploy.indexOf('echo "== hosts: nava.legacyhotels.co.za =="', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return deploy
    .slice(start, end)
    .replaceAll('sudo ', '')
    .replaceAll('--chown=root:root ', '')
    .replaceAll('-o root -g root ', '')
    .replaceAll('-o www-data -g www-data ', '');
}

describe('the built pane CSP and immutable mail release', () => {
  it('uses the active release for stable assets and shared fallback only for hashed chunks', () => {
    const nginx = readFileSync(template, 'utf8');
    expect(
      nginx.match(/location \/assets\/ \{\s*try_files \/releases\/__NAVA_RELEASE_ID__\$uri =404;/g),
    ).toHaveLength(2);
    const hashedRoutes = [
      ...nginx.matchAll(
        /location ~ "([^"]+)" \{\s*try_files \/releases\/__NAVA_RELEASE_ID__\$uri \$uri =404;/g,
      ),
    ];
    expect(hashedRoutes).toHaveLength(2);
    const regex = new RegExp(hashedRoutes[0][1]);
    expect(regex.test('/assets/entry-ABcd1234.js')).toBe(true);
    expect(regex.test('/assets/icons/logo-ABcd1234.svg')).toBe(true);
    expect(regex.test('/assets/m0 w lines rounded edges.svg')).toBe(false);
    expect(regex.test('/assets/mail.svg')).toBe(false);
    expect(
      nginx.match(/try_files \/releases\/__NAVA_RELEASE_ID__\$uri \/index.html;/g),
    ).toHaveLength(2);
  });

  it('uses a file alias in the exact pane location, with every security header and no inline-script bypass', () => {
    const nginx = readFileSync(template, 'utf8');
    const pane = nginx.match(/location = \/outlook-pane\s*\{([^}]*)\}/)?.[1];
    expect(pane).toBeDefined();
    expect(pane).toContain('alias __NAVA_WEB_ROOT__/releases/__NAVA_RELEASE_ID__/index.html;');
    expect(pane).not.toMatch(/try_files|rewrite|return|error_page/);
    expect(pane).not.toMatch(/script-src [^;]*unsafe-inline/);
    for (const header of [
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Content-Security-Policy',
    ]) {
      expect(pane, `pane response (including 4xx) must set ${header}`).toMatch(
        new RegExp(`add_header ${header} [^\n]+ always;`),
      );
    }
    expect(pane).toMatch(/script-src 'self' __NAVA_PANE_SCRIPT_HASHES__;/);
    const oldPolicy = "script-src 'self' 'unsafe-inline'";
    expect(nginx.match(new RegExp(oldPolicy, 'g'))).toHaveLength(2);
    expect(nginx).toContain('location = /download/NavaOutlookSetup.exe');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8789/api/');
  });

  it('hashes every inline script byte of the staged index, including UTF-8 and inline module scripts', () => {
    const html =
      '<!doctype html><script>const café = "ok";\n</script>' +
      '<script type="module">import "/assets/entry-ABC.js";</script>' +
      '<script src="/assets/external-DEF.js"></script>' +
      '<script>window.ready = true</script>';
    const { candidate, id, index, webRoot } = fixture(html);
    const render = runHelper('render', index, template, candidate, webRoot);
    expect(render.status, render.stderr).toBe(0);
    const nginx = readFileSync(candidate, 'utf8');
    const pane = nginx.match(/location = \/outlook-pane\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(pane).toContain(`alias ${webRoot}/releases/${id}/index.html;`);
    expect(pane).not.toMatch(/script-src [^;]*unsafe-inline/);
    expect(pane.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toEqual(inlineScriptHashes(html));
    expect(nginx).toContain(`try_files /releases/${id}$uri /index.html;`);
    expect(
      nginx.match(new RegExp(`alias ${webRoot}/releases/${id}/index.html;`, 'g')),
    ).toHaveLength(3);
    expect(runHelper('verify', index, template, candidate, webRoot).status).toBe(0);
  });

  it.skipIf(!existsSync(builtIndex))(
    'matches every inline script in the actual finished mail build',
    () => {
      const html = readFileSync(builtIndex, 'utf8');
      const { candidate, index, webRoot } = fixture(html);
      const expected = inlineScriptHashes(html);
      expect(expected.length).toBeGreaterThan(0);
      const result = runHelper('render', index, template, candidate, webRoot);
      expect(result.status, result.stderr).toBe(0);
      const pane =
        readFileSync(candidate, 'utf8').match(/location = \/outlook-pane\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(pane.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toEqual(expected);
      expect(runHelper('verify', index, template, candidate, webRoot).status).toBe(0);
    },
  );

  it('rejects both a changed staged index and a stale or altered Nginx policy', () => {
    const { candidate, index, webRoot } = fixture('<script>const release=1</script>');
    expect(runHelper('render', index, template, candidate, webRoot).status).toBe(0);
    writeFileSync(index, '<script>const release=2</script>');
    const changedIndex = runHelper('verify', index, template, candidate, webRoot);
    expect(changedIndex.status).not.toBe(0);
    expect(changedIndex.stderr).toMatch(/index|release|hash/i);
    writeFileSync(index, '<script>const release=1</script>');
    writeFileSync(
      candidate,
      readFileSync(candidate, 'utf8').replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ),
    );
    const stalePolicy = runHelper('verify', index, template, candidate, webRoot);
    expect(stalePolicy.status).not.toBe(0);
    expect(stalePolicy.stderr).toMatch(/candidate|mismatch/i);
  });

  it('refuses a modified stable asset or extra file after rendering, even if inline scripts are unchanged', () => {
    const stable = 'assets/m0 w lines rounded edges.svg';
    const { candidate, id, index, webRoot } = fixture('<script>window.safe=true</script>', {
      [stable]: '<svg>original</svg>',
    });
    expect(runHelper('render', index, template, candidate, webRoot).status).toBe(0);
    const stagedAsset = join(webRoot, 'releases', id, stable);
    writeFileSync(stagedAsset, '<svg>tampered</svg>');
    const changed = runHelper('verify', index, template, candidate, webRoot);
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toMatch(/release|mismatch/i);
    writeFileSync(stagedAsset, '<svg>original</svg>');
    writeFileSync(join(webRoot, 'releases', id, 'extra.txt'), 'unexpected');
    expect(runHelper('verify', index, template, candidate, webRoot).status).not.toBe(0);
  });

  it('rejects symlinks anywhere in the release and excludes non-hashed assets from old-tab fallback', () => {
    const root = tempDir();
    const source = join(root, 'source');
    const publicAssets = join(root, 'public', 'assets');
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(publicAssets, { recursive: true });
    writeFileSync(join(source, 'index.html'), '<script>window.safe=true</script>');
    writeFileSync(join(source, 'assets', 'mail.svg'), '<svg>stable</svg>');
    writeFileSync(join(source, 'assets', 'entry-ABcd1234.js'), 'immutable chunk');
    writeFileSync(join(source, 'assets', 'logo-ABcd1234.svg'), '<svg>public</svg>');
    writeFileSync(join(publicAssets, 'logo-ABcd1234.svg'), '<svg>public</svg>');
    const hashed = runHelper('hashed-assets', join(source, 'assets'), publicAssets);
    expect(hashed.status, hashed.stderr).toBe(0);
    expect(hashed.stdout.split('\0').filter(Boolean)).toEqual(['entry-ABcd1234.js']);
    writeFileSync(join(publicAssets, 'logo-ABcd1234.svg'), '<svg>stale source</svg>');
    const mismatchedPublic = runHelper('hashed-assets', join(source, 'assets'), publicAssets);
    expect(mismatchedPublic.status).not.toBe(0);
    expect(mismatchedPublic.stderr).toMatch(/public asset/i);
    symlinkSync(join(source, 'index.html'), join(source, 'assets', 'mutating-link'));
    const identity = runHelper('id', source);
    expect(identity.status).not.toBe(0);
    expect(identity.stderr).toMatch(/symlink/i);
  });

  it('refuses to render an accidental script-src-elem inline bypass into the pane', () => {
    const { candidate, index, webRoot } = fixture('<script>window.safe=true</script>');
    const templatePath = join(webRoot, 'weakened.conf');
    writeFileSync(
      templatePath,
      readFileSync(template, 'utf8').replace(
        "script-src 'self' __NAVA_PANE_SCRIPT_HASHES__;",
        "script-src 'self' __NAVA_PANE_SCRIPT_HASHES__; script-src-elem 'unsafe-inline';",
      ),
    );
    const result = runHelper('render', index, templatePath, candidate, webRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|script-src-elem/);
    expect(existsSync(candidate)).toBe(false);
  });

  it('refuses a staged index symlink whose target could change after CSP validation', () => {
    const { candidate, index, webRoot } = fixture('<script>window.safe=true</script>');
    const mutable = join(webRoot, 'mutable-index.html');
    writeFileSync(mutable, readFileSync(index));
    unlinkSync(index);
    symlinkSync(mutable, index);
    const result = runHelper('render', index, template, candidate, webRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|regular file/i);
    expect(existsSync(candidate)).toBe(false);
  });

  it('keeps all security headers on the HTTP redirect to the HTTPS pane', () => {
    const nginx = readFileSync(template, 'utf8');
    const redirect = nginx.slice(0, nginx.indexOf('listen 443 ssl'));
    expect(redirect).toContain('return 301 https://nava.legacyhotels.co.za$request_uri;');
    for (const header of [
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Content-Security-Policy',
    ]) {
      expect(redirect, `${header} on HTTP 301`).toMatch(
        new RegExp(`add_header ${header} [^\\n]+ always;`),
      );
    }
    expect(redirect).not.toContain('unsafe-inline');
  });

  it('excludes deferred third-party analytics only from the exact pane route', () => {
    const root = readFileSync(resolve(pilot, '../mail/app/root.tsx'), 'utf8');
    expect(root).toContain("useLocation().pathname === '/outlook-pane'");
    expect(root).toContain('if (isOutlookPane || !shouldRenderAnalytics) return null;');
    expect(root).toContain('<DeferredDubAnalytics />');
  });

  it('retains an earlier hashed asset while staging two releases; never publishes an index to the live root', () => {
    const stage = localStageScript();
    const root = tempDir();
    const mail = join(root, 'mail');
    const web = join(root, 'web');
    const client = join(mail, 'build', 'client');
    mkdirSync(join(client, 'assets'), { recursive: true });
    mkdirSync(join(mail, 'public', 'assets'), { recursive: true });

    function stageRelease(version: number) {
      writeFileSync(join(client, 'index.html'), `<script>window.version=${version}</script>`);
      const chunk = version === 1 ? 'entry-ABcd1234.js' : 'entry-EFgh5678.js';
      writeFileSync(join(client, 'assets', chunk), `window.version=${version}`);
      const run = spawnSync('bash', ['-c', `set -euo pipefail\n${stage}`], {
        env: { ...process.env, WEB_ROOT: web, MAIL_APP: mail, SERVER_PILOT: pilot },
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      return runHelper('id', client).stdout.trim();
    }

    const first = stageRelease(1);
    const second = stageRelease(2);
    expect(first).not.toBe(second);
    expect(readFileSync(join(web, 'releases', first, 'index.html'), 'utf8')).toContain('version=1');
    expect(readFileSync(join(web, 'releases', second, 'index.html'), 'utf8')).toContain(
      'version=2',
    );
    expect(readFileSync(join(web, 'assets', 'entry-ABcd1234.js'), 'utf8')).toContain('version=1');
    expect(readFileSync(join(web, 'assets', 'entry-EFgh5678.js'), 'utf8')).toContain('version=2');
    expect(existsSync(join(web, 'index.html'))).toBe(false);

    // A content collision must fail closed rather than replace what an open tab is loading.
    writeFileSync(join(client, 'assets', 'entry-ABcd1234.js'), 'tampered shared filename');
    const collision = spawnSync('bash', ['-c', `set -euo pipefail\n${stage}`], {
      env: { ...process.env, WEB_ROOT: web, MAIL_APP: mail, SERVER_PILOT: pilot },
      encoding: 'utf8',
    });
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toMatch(/collision|mismatch/i);
    expect(readFileSync(join(web, 'assets', 'entry-ABcd1234.js'), 'utf8')).toContain('version=1');
  });

  it('versions the complete client tree while preserving only hashed chunks for older tabs', () => {
    const stage = localStageScript();
    const root = tempDir();
    const mail = join(root, 'mail');
    const web = join(root, 'web');
    const client = join(mail, 'build', 'client');
    const assets = join(client, 'assets');
    const publicAssets = join(mail, 'public', 'assets');
    const stable = 'm0 w lines rounded edges.svg';
    const hashShapedPublic = 'logo-ABcd1234.svg';
    const oldChunk = 'entry-ABcd1234.js';
    const newChunk = 'entry-EFgh5678.js';
    mkdirSync(assets, { recursive: true });
    mkdirSync(publicAssets, { recursive: true });
    writeFileSync(join(client, 'index.html'), '<script>window.release = "same"</script>');
    writeFileSync(join(client, 'favicon.ico'), 'favicon version 1');
    writeFileSync(join(assets, stable), '<svg>version 1</svg>');
    writeFileSync(join(assets, hashShapedPublic), '<svg>public version 1</svg>');
    writeFileSync(join(publicAssets, hashShapedPublic), '<svg>public version 1</svg>');
    writeFileSync(join(assets, oldChunk), 'old tab keeps this chunk');
    chmodSync(join(assets, oldChunk), 0o666);
    chmodSync(assets, 0o777);

    const publish = () =>
      spawnSync('bash', ['-c', `set -euo pipefail\n${stage}`], {
        env: { ...process.env, WEB_ROOT: web, MAIL_APP: mail, SERVER_PILOT: pilot },
        encoding: 'utf8',
      });
    const releaseIds = () => readdirSync(join(web, 'releases'));
    const first = publish();
    expect(first.status, first.stderr).toBe(0);
    const [originalId] = releaseIds();
    expect(existsSync(join(web, 'assets', hashShapedPublic))).toBe(false);
    expect(statSync(join(web, 'releases', originalId, 'assets')).mode & 0o022).toBe(0);
    expect(statSync(join(web, 'releases', originalId, 'assets', oldChunk)).mode & 0o022).toBe(0);
    expect(statSync(join(web, 'assets', oldChunk)).mode & 0o022).toBe(0);

    // The script hashes remain equal, but immutable release identity must change.
    writeFileSync(join(client, 'favicon.ico'), 'favicon version 2');
    const faviconOnly = publish();
    expect(faviconOnly.status, faviconOnly.stderr).toBe(0);
    const faviconIds = releaseIds();
    expect(faviconIds).toHaveLength(2);
    const faviconId = faviconIds.find((id) => id !== originalId)!;
    expect(readFileSync(join(web, 'releases', originalId, 'favicon.ico'), 'utf8')).toBe(
      'favicon version 1',
    );
    expect(readFileSync(join(web, 'releases', faviconId, 'favicon.ico'), 'utf8')).toBe(
      'favicon version 2',
    );

    writeFileSync(join(assets, stable), '<svg>version 2</svg>');
    writeFileSync(join(assets, hashShapedPublic), '<svg>public version 2</svg>');
    writeFileSync(join(publicAssets, hashShapedPublic), '<svg>public version 2</svg>');
    writeFileSync(join(assets, newChunk), 'new tab loads this chunk');
    const updatedStable = publish();
    expect(updatedStable.status, updatedStable.stderr).toBe(0);
    const stableIds = releaseIds();
    expect(stableIds).toHaveLength(3);
    const newId = stableIds.find((id) => id !== originalId && id !== faviconId)!;
    expect(readFileSync(join(web, 'releases', originalId, 'assets', stable), 'utf8')).toBe(
      '<svg>version 1</svg>',
    );
    expect(readFileSync(join(web, 'releases', newId, 'assets', stable), 'utf8')).toBe(
      '<svg>version 2</svg>',
    );
    expect(existsSync(join(web, 'assets', stable))).toBe(false);
    expect(existsSync(join(web, 'assets', hashShapedPublic))).toBe(false);
    expect(readFileSync(join(web, 'assets', oldChunk), 'utf8')).toBe('old tab keeps this chunk');
    expect(readFileSync(join(web, 'assets', newChunk), 'utf8')).toBe('new tab loads this chunk');
    expect(readFileSync(join(web, 'releases', originalId, 'index.html'), 'utf8')).toBe(
      readFileSync(join(web, 'releases', newId, 'index.html'), 'utf8'),
    );
    const nginx = readFileSync(template, 'utf8');
    expect(
      nginx.match(/try_files \/releases\/__NAVA_RELEASE_ID__\$uri \/index.html;/g),
    ).toHaveLength(2);
    expect(existsSync(join(web, 'index.html'))).toBe(false);
  });

  it('refuses a symlinked release directory before rsync can write outside the web root', () => {
    const root = tempDir();
    const mail = join(root, 'mail');
    const web = join(root, 'web');
    const outside = join(root, 'outside');
    mkdirSync(join(mail, 'build', 'client', 'assets'), { recursive: true });
    mkdirSync(web);
    mkdirSync(outside);
    writeFileSync(join(mail, 'build', 'client', 'index.html'), '<script>safe()</script>');
    symlinkSync(outside, join(web, 'releases'));
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${localStageScript()}`], {
      env: { ...process.env, WEB_ROOT: web, MAIL_APP: mail, SERVER_PILOT: pilot },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe web release symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });
});
