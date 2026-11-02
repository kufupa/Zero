import { createReplayPage, installReplayNetworkFence, type BlockedReplayNetwork } from '../scripts/nava-replay-network';
import type { BlockedWrite } from '../scripts/nava-preview-run';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);

describe('replay page network fence', () => {
  it.skipIf(!chromiumBinary)('allows only same-origin reads and guarded tRPC, blocking other posts', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
    try {
      const unsafe = await browser.newContext();
      const unsafePage = await unsafe.newPage();
      await expect(installReplayNetworkFence(unsafePage, origin, [], [])).rejects.toThrow('protected browser context');
      await unsafe.close();
      const blocked: BlockedReplayNetwork[] = [], blockedTrpc: BlockedWrite[] = [];
      const { context, page } = await createReplayPage(browser, origin, blocked, blockedTrpc);
      await page.goto(`${origin}/outlook-pane`);
      const results = await page.evaluate(async () => {
        const run = async (path: string, method = 'GET') => {
          try { return (await fetch(path, { method })).ok; } catch { return false; }
        };
        return [await run('/favicon.ico'), await run('/api/auth/get-session'), await run('/api/unsafe-get'), await run('/unsafe-get'),
          await run('/unsafe', 'POST'), await run('/api/auth/sign-out', 'POST'),
          await run('/api/outlook/native/enroll', 'POST'),
          await run('/api/trpc/mail.get?batch=1', 'POST'),
          await run('/api/trpc/mail.send?batch=1', 'POST'),
          await run('https://other.example/secret'),
          await run('https://other.example/api/trpc/mail.get?batch=1', 'POST')];
      });
      expect(results).toEqual([true, true, false, false, false, false, false, true, false, false, false]);
      expect(seen).toEqual(expect.arrayContaining(['GET /outlook-pane', 'GET /favicon.ico', 'GET /api/auth/get-session', 'POST /api/trpc/mail.get?batch=1']));
      expect(seen.filter((item) => /unsafe|sign-out|native|mail\.send/.test(item))).toEqual([]);
      expect(blocked.map((item) => item.reason)).toEqual(['endpoint', 'endpoint', 'method', 'auth', 'native', 'origin', 'origin']);
      expect(blockedTrpc.map((item) => item.procedure)).toEqual(['mail.send']);
      const other = await context.newPage();
      await expect(other.goto(`${origin}/other`)).rejects.toThrow();
      expect(blocked.some((item) => item.reason === 'other_page' && item.path === '/other')).toBe(true);
      await page.evaluate(() => { try { new WebSocket(`ws://${location.host}/socket?secret=never-record`); } catch { /* blocked */ } });
      await expect.poll(() => blocked.some((item) => item.reason === 'websocket' && item.path === '/socket')).toBe(true);
      expect(seen).not.toContain('GET /other');
      expect(JSON.stringify(blocked)).not.toContain('never-record');
      await context.close();
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
