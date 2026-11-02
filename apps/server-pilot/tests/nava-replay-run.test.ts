import { parseReplayRunConfig, replayExpectationForCase, type ReplayCase } from '../scripts/nava-replay-run';
import { describe, expect, it } from 'vitest';

const sample: ReplayCase = { id: 'fixture', workflow: 'quote', threadId: 'thread', messageId: 'message',
  expected: { readAs: 'quote' } };

describe('actual-pane replay expectations', () => {
  it('requires a reviewed quote draft and PDF unless the current pane offers a decline', () => {
    expect(replayExpectationForCase(sample, null)).toMatchObject({ requireDraft: true, requireAttachment: true });
    expect(replayExpectationForCase(sample, 'Draft quotation into email reply')).toMatchObject({ requireDraft: true, requireAttachment: true });
    expect(replayExpectationForCase(sample, 'Draft decline reply')).toMatchObject({ requireDraft: true, requireAttachment: false });
    expect(replayExpectationForCase(sample, 'Historical sold out')).toMatchObject({ requireAttachment: true });
  });
  it('requires source attachment metadata for filing and does not claim HMS filing', () => {
    expect(replayExpectationForCase({ ...sample, workflow: 'filing' }, null)).toMatchObject({
      requireSourceAttachment: true, requireDraft: false, requireAttachment: false,
    });
    expect(replayExpectationForCase({ ...sample, workflow: 'triage', expected: { readAs: 'payment',
      artifactPolicy: { source_attachment_required: true } } }, null).requireSourceAttachment).toBe(true);
  });
});


describe('replay runner configuration', () => {
  const env = { NAVA_PREVIEW_BASE_URL: 'https://pilot.example', NAVA_PREVIEW_STORAGE_STATE: '/private/state.json',
    NAVA_PREVIEW_USER_ID: 'user', NAVA_PREVIEW_TRANSPORT_ID: 'mailbox' };
  it('requires explicit cases and identity, and never enables reads or prepare by default', () => {
    expect(parseReplayRunConfig(['--cases', 'quote-single,filing-voucher-a', '--out', '/tmp/fresh'], env)).toMatchObject({
      caseIds: ['quote-single', 'filing-voucher-a'], allowHmsReads: false, prepareProcedures: [],
    });
    expect(parseReplayRunConfig(['--cases', 'quote-single', '--out', '/tmp/fresh'], { ...env,
      NAVA_PREVIEW_PREPARE_PROCEDURES: 'workstation.prepareBookingDraft' }).prepareProcedures).toEqual(['workstation.prepareBookingDraft']);
    expect(() => parseReplayRunConfig(['--cases', 'quote-single', '--out', '/tmp/fresh'], { ...env,
      NAVA_PREVIEW_PREPARE_PROCEDURES: 'mail.send' })).toThrow();
    expect(() => parseReplayRunConfig(['--out', '/tmp/fresh'], env)).toThrow();
    expect(() => parseReplayRunConfig(['--cases', 'quote-single,quote-single', '--out', '/tmp/fresh'], env)).toThrow();
    expect(() => parseReplayRunConfig(['--cases', '../x', '--out', '/tmp/fresh'], env)).toThrow();
    expect(() => parseReplayRunConfig(['--cases', 'quote-single', '--out', '/tmp/fresh'], { ...env, NAVA_PREVIEW_USER_ID: '' })).toThrow();
    expect(() => parseReplayRunConfig(['--cases', 'quote-single', '--out', '/tmp/fresh'], { ...env, NAVA_PREVIEW_BASE_URL: 'http://other.example' })).toThrow();
    expect(() => parseReplayRunConfig(['--cases', 'quote-single', '--out', '/tmp/fresh'], { ...env, NAVA_PREVIEW_BASE_URL: 'https://pilot.example/path' })).toThrow();
  });
});

// A small loopback page exercises runner wiring only. The separate real-pane test mounts the React route.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOutlookReplayCase } from '../scripts/nava-replay-run';

const browserPath = [chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'].find(existsSync);

describe('replay runner composition', () => {
  it.skipIf(!browserPath)('binds the pane request to the selected stored message and rejects wrong outcomes', async () => {
    const paths: string[] = [];
    const thread = { id: 'thread', transportId: 'mailbox', messages: [{ id: 'message', threadId: 'thread',
      direction: 'inbound', isDraft: false, messageId: '<m@example.test>', subject: 'Subject A',
      sender: { email: 'guest@example.test', name: 'Guest' }, to: [], cc: [],
      receivedOn: '2026-11-02T10:00:00Z', body: 'Synthetic body', processedHtml: '<p>Synthetic body</p>' }] };
    const wrap = (json: unknown) => JSON.stringify([{ result: { data: { json } } }]);
    const server = createServer((req, res) => {
      paths.push(req.url ?? ''); req.resume(); res.setHeader('content-type', 'application/json');
      if (req.url === '/api/auth/get-session') return res.end(JSON.stringify({ user: { id: 'user' } }));
      if (req.url?.startsWith('/api/trpc/mail.get')) return res.end(wrap(thread));
      if (req.url?.startsWith('/api/trpc/workstation.staffQuoteSource'))
        return res.end(wrap({ status: 'ready', messageId: 'message', threadId: 'thread' }));
      if (req.url === '/outlook-pane') {
        res.setHeader('content-type', 'text/html');
        return res.end(`<!doctype html><html><body><div><header aria-label="Nava mailbox">Nava</header>
          <main class="nava-pane-scroll"><section id="quote-selected-message" aria-label="Selected email">Subject A</section>
          <span data-read-as="quote">Quote</span><article aria-label="Stay 1 details"><header><p>1 room · 1 guest total</p></header></article></main></div><script>
          fetch('/api/trpc/workstation.staffQuoteSource?batch=1', {method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({0:{json:{internetMessageId:'<m@example.test>'}}})});
          </script></body></html>`);
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'nava-replay-run-'));
    const storageStatePath = join(dir, 'state.json');
    writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const base = { browser, origin, storageStatePath, userId: 'user', transportId: 'mailbox', timeoutMs: 5_000 };
      const item: ReplayCase = { id: 'triage', workflow: 'triage', threadId: 'thread', messageId: 'message',
        expected: { readAs: 'quote', detailChecks: [{ kind: 'stay_count', count: 1 }] } };
      const pass = await runOutlookReplayCase({ ...base, item, screenshotDir: join(dir, 'pass') });
      expect(pass.failures).toEqual([]);
      expect(pass.screenshotPaths).toHaveLength(2);
      const wrong = await runOutlookReplayCase({ ...base, item: { ...item, expected: { readAs: 'new_booking' } }, screenshotDir: join(dir, 'wrong') });
      expect(wrong.failures).toContain('wrong_outcome');
      const dropped = await runOutlookReplayCase({ ...base, item: { ...item, expected: { ...item.expected,
        detailChecks: [{ kind: 'stay_count', count: 2 }] } }, screenshotDir: join(dir, 'dropped') });
      expect(dropped.failures).toContain('wrong_detail_0');
      const missingFile = await runOutlookReplayCase({ ...base, item: { ...item, workflow: 'filing' }, screenshotDir: join(dir, 'missing-file') });
      expect(missingFile.failures).toContain('missing_source_attachment_metadata');
      expect(missingFile.failures).not.toContain('fixture_unsynced');
      expect(paths.some((path) => /send|commit|native/.test(path))).toBe(false);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
