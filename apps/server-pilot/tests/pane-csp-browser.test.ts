import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';

const serverPilot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = resolve(serverPilot, '../mail/build/client');
const indexHtml = join(client, 'index.html');
const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);

describe('built /outlook-pane script policy in a real browser', () => {
  it.skipIf(!existsSync(indexHtml) || !existsSync(chromiumBinary))(
    'hydrates sign-in and buttons under the generated CSP, but refuses a new inline script',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'pane-csp-browser-'));
      const html = readFileSync(indexHtml);
      const helper = join(serverPilot, 'deploy', 'pane-csp-release.mjs');
      const identity = spawnSync(process.execPath, [helper, 'id', client], { encoding: 'utf8' });
      expect(identity.status, identity.stderr).toBe(0);
      const id = identity.stdout.trim();
      const staged = join(scratch, 'releases', id, 'index.html');
      const template = join(serverPilot, 'deploy', 'nginx.conf');
      const candidate = join(scratch, 'candidate.conf');
      mkdirSync(dirname(dirname(staged)), { recursive: true });
      cpSync(client, dirname(staged), { recursive: true });
      const render = spawnSync(
        process.execPath,
        [helper, 'render', staged, template, candidate, scratch],
        { encoding: 'utf8' },
      );
      expect(render.status, render.stderr).toBe(0);
      const pane =
        readFileSync(candidate, 'utf8').match(/location = \/outlook-pane\s*\{([^}]*)\}/)?.[1] ?? '';
      const csp = pane.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
      expect(csp).toBeDefined();

      let localSignInAttempts = 0;
      const localServer = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname === '/outlook-pane') {
          response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp! });
          response.end(html);
          return;
        }
        if (pathname.startsWith('/api/')) {
          if (pathname === '/api/auth/sign-in/email' && request.method === 'POST') {
            localSignInAttempts += 1;
          }
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Local test: no session' } }));
          return;
        }
        const file = resolve(client, `.${pathname}`);
        if (!file.startsWith(`${client}/`) || !existsSync(file)) {
          response.writeHead(404);
          response.end();
          return;
        }
        const type =
          extname(file) === '.js'
            ? 'text/javascript'
            : extname(file) === '.css'
              ? 'text/css'
              : extname(file) === '.svg'
                ? 'image/svg+xml'
                : 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type });
        response.end(readFileSync(file));
      });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        await new Promise<void>((accept) => localServer.listen(0, '127.0.0.1', accept));
        const address = localServer.address();
        if (!address || typeof address === 'string')
          throw new Error('local test server has no TCP port');
        browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
        const page = await browser.newPage();
        await page.addInitScript(() => {
          (window as typeof window & { __scriptViolations?: string[] }).__scriptViolations = [];
          window.addEventListener('securitypolicyviolation', (event) => {
            if (event.violatedDirective.startsWith('script-src')) {
              (window as typeof window & { __scriptViolations: string[] }).__scriptViolations.push(
                `${event.blockedURI} @ ${event.sourceFile}:${event.lineNumber}`,
              );
            }
          });
        });
        await page.goto(`http://127.0.0.1:${address.port}/outlook-pane`);
        await page
          .getByRole('heading', { name: 'Nava Assistant Sign In' })
          .waitFor({ timeout: 12_000 });
        const signIn = page.getByRole('button', { name: 'Sign in' });
        expect(await signIn.isEnabled()).toBe(true);
        expect(
          await page.evaluate(
            () => (window as typeof window & { __scriptViolations?: string[] }).__scriptViolations,
          ),
        ).toEqual([]);
        await page.getByPlaceholder('Email').fill('not-a-real-user@example.invalid');
        await page.getByPlaceholder('Password').fill('never-a-real-password');
        await signIn.click();
        await expect.poll(() => localSignInAttempts).toBe(1);
        await page.waitForTimeout(400);
        expect(
          await page.evaluate(
            () => (window as typeof window & { __scriptViolations: string[] }).__scriptViolations,
          ),
        ).toEqual([]);
        const previousViolations = await page.evaluate(
          () =>
            (window as typeof window & { __scriptViolations: string[] }).__scriptViolations.length,
        );
        await page.evaluate(() => {
          const injected = document.createElement('script');
          injected.textContent = 'window.__unapprovedPaneScript = true';
          document.body.append(injected);
        });
        expect(
          await page.evaluate(
            () =>
              (window as typeof window & { __unapprovedPaneScript?: boolean })
                .__unapprovedPaneScript,
          ),
        ).toBeUndefined();
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                (window as typeof window & { __scriptViolations?: string[] }).__scriptViolations
                  ?.length,
            ),
          )
          .toBeGreaterThan(previousViolations);
      } finally {
        await browser?.close();
        await new Promise<void>((accept) => localServer.close(() => accept()));
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
