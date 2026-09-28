import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sentinel = path.join(here, '..', 'scripts', 'hms-deterministic-egress-sentinel.mjs');

describe('deterministic egress sentinel', () => {
  it('preload allows loopback and fails closed for model/browser endpoints across fetch/http APIs', () => {
    const artifactDir = mkdtempSync(path.join(tmpdir(), 'hms-egress-sentinel-'));
    const artifactPath = path.join(artifactDir, 'counter.json');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        sentinel,
        '--input-type=module',
        '-e',
        `
          import http from 'node:http';
          import https from 'node:https';
          import net from 'node:net';

          function allowedProbe(module, options) {
            const req = module.request({
              ...options,
              createConnection: () => new net.Socket(),
            });
            req.once('error', () => {});
            req.destroy();
          }

          // Classification only: custom unconnected sockets prevent any remote dial.
          allowedProbe(https, { hostname: 'appsrv-1.legacyhotels.co.za', port: 443 });
          allowedProbe(https, { hostname: 'secretsmanager.af-south-1.amazonaws.com', port: 443 });
          allowedProbe(http, { hostname: '169.254.169.254', port: 80 });

          let redirectFollowed = false;
          const server = http.createServer((req, res) => {
            if (req.url === '/redirect') { res.writeHead(302, { location: '/redirect-destination' }); res.end(); return; }
            if (req.url === '/redirect-destination') redirectFollowed = true;
            res.end('ok');
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const port = server.address().port;
          const local = 'http://127.0.0.1:' + port;

          const fetched = await fetch(new Request(local + '/fetch'));
          if (await fetched.text() !== 'ok') throw new Error('loopback fetch failed');
          const redirected = await fetch(new Request(local + '/redirect', { redirect: 'follow' }));
          if (redirected.status !== 302 || redirectFollowed) throw new Error('redirect escaped request guard');

          await new Promise((resolve, reject) => {
            const req = http.request(new URL(local + '/request'), { method: 'POST' }, (res) => {
              res.resume();
              res.once('end', resolve);
            });
            req.once('error', reject);
            req.end('fixture');
          });

          await new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/get' }, (res) => {
              res.resume();
              res.once('end', resolve);
            });
            req.once('error', reject);
          });

          async function blocked(call) {
            try {
              await call();
            } catch (error) {
              if (!String(error?.message || error).includes('deterministic egress blocked')) throw error;
              return;
            }
            throw new Error('blocked request was allowed');
          }

          await blocked(() => fetch('https://api.openai.com/v1/responses?api_key=do-not-log'));
          await blocked(() => fetch(new Request('https://api.browserbase.io/v1?token=do-not-log')));
          await blocked(() => https.request(new URL('https://api.stagehand.dev/observe'), { method: 'POST' }));
          await blocked(() => https.get({ hostname: 'api.browserbase.com', path: '/' }));
          await blocked(() => http.request({ hostname: 'api.openai.com', method: 'GET', path: '/' }));
          await blocked(() => http.get({ hostname: 'api.openai.com', port: 80, path: '/' }));
          await blocked(() => https.request({ hostname: 'api.browserbase.com', method: 'CONNECT', path: '/' }));
          await blocked(() => http.request(new URL(local), { socketPath: '/tmp/not-a-real-socket' }));

          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AWS_REGION: 'af-south-1',
          HMS_EGRESS_SENTINEL_OUT: artifactPath,
        },
      },
    );

    try {
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
        blockedAttemptCount: number;
        allowedAttemptCount: number;
        allowedByCategory: Record<string, number>;
        blockedByInterface: Record<string, number>;
      };
      expect(artifact.blockedAttemptCount).toBe(8);
      expect(artifact.allowedAttemptCount).toBe(7);
      expect(artifact.allowedByCategory).toMatchObject({
        pms: 1,
        'aws-secrets-manager': 1,
        'aws-ec2-imds': 1,
        localhost: 4,
      });
      expect(artifact.blockedByInterface).toMatchObject({
        fetch: 2,
        'https.request': 2,
        'https.get': 1,
        'http.request': 2,
        'http.get': 1,
      });
      const serialized = JSON.stringify(artifact);
      expect(serialized).not.toMatch(/openai|browserbase|stagehand|api_key|do-not-log/i);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});
