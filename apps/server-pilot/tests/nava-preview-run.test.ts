import {
  buildGalleryHtml,
  gateFailures,
  outcomeOf,
  parseRunConfig,
  redactText,
  safeSegment,
  summarize,
  writeOutputs,
  type ThreadResult,
} from '../scripts/nava-preview-run';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-preview-run-'));
  statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    NAVA_PREVIEW_BASE_URL: 'https://pilot.example',
    NAVA_PREVIEW_STORAGE_STATE: statePath,
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe('parseRunConfig', () => {
  it('reads a latest-N selection with a default timeout and an out directory under cwd', () => {
    const config = parseRunConfig(['--latest', '5'], env(), dir, new Date('2026-10-09T07:00:00Z'));
    expect(config).toMatchObject({
      baseUrl: 'https://pilot.example',
      storageStatePath: statePath,
      chromiumPath: null,
      selection: { kind: 'latest', count: 5 },
      timeoutMs: 90_000,
    });
    expect(config.outDir.startsWith(dir)).toBe(true);
    expect(config.outDir).toContain('nava-preview-2026-10-09T07-00-00-000Z');
  });

  it('reads an explicit thread list and an explicit out directory', () => {
    const config = parseRunConfig(
      ['--threads', 'thread-a, thread-b', '--out', 'out/run-1', '--timeout-ms', '60000'],
      env({ NAVA_PREVIEW_CHROMIUM: '/opt/chromium' }),
      dir,
    );
    expect(config.selection).toEqual({ kind: 'threads', ids: ['thread-a', 'thread-b'] });
    expect(config.outDir).toBe(join(dir, 'out/run-1'));
    expect(config.timeoutMs).toBe(60_000);
    expect(config.chromiumPath).toBe('/opt/chromium');
  });

  it('needs exactly one selection', () => {
    expect(() => parseRunConfig([], env(), dir)).toThrow('Choose exactly one');
    expect(() => parseRunConfig(['--latest', '2', '--threads', 'a'], env(), dir)).toThrow(
      'Choose exactly one',
    );
  });

  it('bounds the latest count and rejects odd thread ids', () => {
    expect(() => parseRunConfig(['--latest', '0'], env(), dir)).toThrow('1 to 50');
    expect(() => parseRunConfig(['--latest', '51'], env(), dir)).toThrow('1 to 50');
    expect(() => parseRunConfig(['--latest', 'five'], env(), dir)).toThrow('whole number');
    expect(() => parseRunConfig(['--threads', 'ok,bad id'], env(), dir)).toThrow(
      'invalid thread id',
    );
    expect(() => parseRunConfig(['--threads', '../etc'], env(), dir)).toThrow('invalid thread id');
  });

  it('refuses a base URL with credentials or a non-web scheme', () => {
    expect(() =>
      parseRunConfig(
        ['--latest', '1'],
        env({ NAVA_PREVIEW_BASE_URL: 'https://u:p@pilot.example' }),
        dir,
      ),
    ).toThrow('must not carry credentials');
    expect(() =>
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_BASE_URL: 'file:///tmp' }), dir),
    ).toThrow('http or https');
    expect(() =>
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_BASE_URL: 'not a url' }), dir),
    ).toThrow('absolute http(s) origin');
  });

  it('fails without echoing the storage-state path when it is missing', () => {
    const missing = join(dir, 'does-not-exist.json');
    try {
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_STORAGE_STATE: missing }), dir);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('storageState file');
      expect((error as Error).message).not.toContain(missing);
    }
  });

  it('bounds the timeout', () => {
    expect(() => parseRunConfig(['--latest', '1', '--timeout-ms', '100'], env(), dir)).toThrow(
      'timeout-ms',
    );
  });
});

describe('redactText', () => {
  it('redacts emails and phone-like digit runs but keeps dates and small counts', () => {
    expect(redactText('Ana at ana.guest+nava@example.co.za, tel +27 82 555 1234.')).toBe(
      'Ana at [email], tel [phone].',
    );
    expect(redactText('0825551234 and 2026-11-12 for 2 rooms, R 12 500.00')).toBe(
      '[phone] and 2026-11-12 for 2 rooms, R 12 500.00',
    );
  });
});

describe('safeSegment', () => {
  it('keeps ids as path segments, never a separator or traversal', () => {
    expect(safeSegment('../x/y')).toBe('.._x_y');
    expect(safeSegment('abc-123.4')).toBe('abc-123.4');
    expect(safeSegment('')).toBe('thread');
  });
});

describe('outcomeOf', () => {
  const base = {
    subject: 'Quote',
    paneStatus: 'ready',
    unsyncedReason: null,
    analysing: false,
    intent: null,
    amendment: null,
    aiUnavailable: false,
    alerts: [] as string[],
    fields: [],
    statusText: '',
  };

  it('settles on an intent label, a fallback notice, an error, or unsynced', () => {
    expect(outcomeOf({ ...base, intent: 'Quote' })).toBe('intent');
    expect(outcomeOf({ ...base, amendment: 'Cancellation' })).toBe('intent');
    expect(outcomeOf({ ...base, aiUnavailable: true })).toBe('fallback');
    expect(outcomeOf({ ...base, alerts: ['Luna could not read this email.'] })).toBe('error');
    expect(outcomeOf({ ...base, paneStatus: 'unsynced' })).toBe('unsynced');
    expect(outcomeOf({ ...base, paneStatus: 'error' })).toBe('error');
  });

  it('keeps waiting while the pane is analysing or still loading', () => {
    expect(outcomeOf({ ...base, intent: 'Quote', analysing: true })).toBeNull();
    expect(outcomeOf({ ...base, paneStatus: 'loading' })).toBeNull();
    expect(outcomeOf({ ...base, paneStatus: 'missing' })).toBeNull();
    expect(outcomeOf({ ...base })).toBeNull();
  });
});

function result(overrides: Partial<ThreadResult> = {}): ThreadResult {
  return {
    threadId: 't-1',
    subject: 'Rooms',
    outcome: 'intent',
    paneStatus: 'ready',
    unsyncedReason: null,
    intent: 'Quote',
    amendment: null,
    aiUnavailable: false,
    prefilled: [{ field: 'Arrival', value: '2026-11-12' }],
    party: [],
    banners: [],
    blockedWrites: [],
    screenshots: { pane: 'threads/t-1/pane.png', page: 'threads/t-1/page.png' },
    elapsedMs: 4200,
    ...overrides,
  };
}

describe('gate and summary', () => {
  it('counts outcomes and fails on timeouts, pane errors, or blocked writes', () => {
    const results = [result(), result({ threadId: 't-2', outcome: 'unsynced', intent: null })];
    expect(summarize(results)).toMatchObject({
      intent: 1,
      unsynced: 1,
      timeout: 0,
      blockedWrites: 0,
    });
    expect(gateFailures(results)).toEqual([]);
    expect(gateFailures([result({ outcome: 'timeout' })])).toEqual(['1 thread(s) did not settle']);
    expect(gateFailures([result({ outcome: 'error' })])).toEqual([
      '1 thread(s) showed a pane error',
    ]);
    expect(gateFailures([result({ blockedWrites: ['workstation.bridgeTicket'] })])).toEqual([
      '1 write request(s) were blocked',
    ]);
  });
});

describe('gallery and outputs', () => {
  it('escapes every text value and links images by relative path', () => {
    const html = buildGalleryHtml(
      [
        result({
          subject: '<img src=x onerror=alert(1)>',
          banners: ['<b>bold</b>'],
          prefilled: [{ field: 'Company', value: 'A & B <script>' }],
        }),
      ],
      '2026-10-09T07:00:00.000Z',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).toContain('src="threads/t-1/pane.png"');
    expect(html).toContain('class="card intent"');
  });

  it('writes results.json and index.html', () => {
    const out = join(dir, 'run');
    writeOutputs(out, [result()], '2026-10-09T07:00:00.000Z');
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as {
      summary: Record<string, number>;
      results: ThreadResult[];
    };
    expect(json.summary.intent).toBe(1);
    expect(json.results[0]?.threadId).toBe('t-1');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('real-browser run');
  });
});
