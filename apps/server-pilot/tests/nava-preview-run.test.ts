import {
  buildGalleryHtml,
  classifyTrpcRequest,
  configFailures,
  gateFailures,
  isPiiField,
  outcomeOf,
  parseRunConfig,
  piiValuesOf,
  READ_PROCEDURES,
  redactText,
  safeSegment,
  shapeResult,
  summarize,
  writeOutputs,
  type PaneRead,
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
    subjectPresent: true,
    outcome: 'intent',
    paneStatus: 'ready',
    unsyncedReason: null,
    intent: 'Quote',
    amendment: null,
    aiUnavailable: false,
    prefilled: [{ field: 'Arrival', value: '2026-11-12', present: true }],
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

describe('blocked requests: pane failure or configuration error', () => {
  const origin = 'https://nava.legacyhotels.co.za/api/trpc/';

  it('reads the app shell asks for are allowed, so they never reach the block list', () => {
    for (const name of ['settings.get', 'labels.list', 'categories.list']) {
      expect(READ_PROCEDURES.has(name), name).toBe(true);
      expect(classifyTrpcRequest(`${origin}${name}?batch=1`).allowed, name).toBe(true);
    }
  });

  it('reports an unclassified block as a configuration error, not as a write', () => {
    const unclassified = [result({ blockedWrites: ['mail.archive'] })];
    expect(configFailures(unclassified)).toEqual([
      '1 request(s) were blocked as unclassified (mail.archive); add reads to READ_PROCEDURES',
    ]);
    expect(gateFailures(unclassified)).toEqual([]);
    expect(configFailures([], ['labels.unknown'])).toHaveLength(1);
  });

  it('keeps a named write a gate failure, with no configuration error', () => {
    const writes = [result({ blockedWrites: ['workstation.bridgeTicket'] })];
    expect(configFailures(writes)).toEqual([]);
    expect(gateFailures(writes)).toEqual(['1 write request(s) were blocked']);
  });
});

describe('gallery and outputs', () => {
  it('escapes every text value and links images by relative path', () => {
    const html = buildGalleryHtml(
      [
        result({
          subject: '<img src=x onerror=alert(1)>',
          banners: ['<b>bold</b>'],
          prefilled: [{ field: 'Company', value: 'A & B <script>', present: true }],
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

describe('guest details never reach the outputs', () => {
  const NAME = 'Zanele Fixturemann';
  const EMAIL = 'zanele.fixture@example.test';
  const PHONE = '+27 82 555 0100';
  const NOTE = 'Zanele needs a late check-in';
  const SECRETS = [NAME, 'Zanele', EMAIL, '555 0100', 'late check-in'];
  const read: PaneRead = {
    subject: `Quote for ${NAME} <${EMAIL}>`,
    paneStatus: 'ready',
    unsyncedReason: null,
    analysing: false,
    intent: 'Quote',
    amendment: null,
    aiUnavailable: false,
    alerts: [`${NAME} already has a booking`],
    fields: [
      { field: 'Guest name', value: NAME },
      { field: 'Attention', value: NAME },
      { field: 'Client email', value: EMAIL },
      { field: 'Client telephone', value: PHONE },
      { field: 'Notes for the quote', value: NOTE },
      { field: 'Company or agency', value: 'Fixture Travel Ltd' },
      { field: 'Arrival', value: '2026-11-02' },
      { field: 'Adults', value: '2' },
    ],
    statusText: '',
  };

  it('classifies guest fields, and leaves business names, dates and counts visible', () => {
    for (const label of [
      'Guest name',
      'Attention',
      'Client email',
      'Client telephone',
      'Notes for the quote',
    ]) {
      expect(isPiiField(label)).toBe(true);
    }
    for (const label of [
      'Company or agency',
      'Company name',
      'Arrival',
      'Adults',
      'Rate type',
      'Children ages',
    ]) {
      expect(isPiiField(label)).toBe(false);
    }
  });

  it('keeps field presence and business names, and drops every guest value', () => {
    const shaped = shapeResult(
      't-9',
      read,
      'intent',
      [],
      { pane: null, page: null },
      10,
      piiValuesOf(read),
    );
    const text = JSON.stringify(shaped).toLowerCase();
    for (const secret of SECRETS) expect(text).not.toContain(secret.toLowerCase());
    expect(shaped.subject).toBe('');
    expect(shaped.subjectPresent).toBe(true);
    expect(shaped.prefilled).toContainEqual({ field: 'Attention', value: null, present: true });
    expect(shaped.prefilled).toContainEqual({
      field: 'Company or agency',
      value: 'Fixture Travel Ltd',
      present: true,
    });
    expect(shaped.prefilled).toContainEqual({
      field: 'Arrival',
      value: '2026-11-02',
      present: true,
    });
    expect(shaped.party).toEqual(['Fixture Travel Ltd']);
    expect(shaped.banners).toEqual(['[redacted] already has a booking']);
  });

  it('never writes a fixture guest value to results.json or index.html', () => {
    const out = join(dir, 'run');
    const shaped = shapeResult(
      't-9',
      read,
      'intent',
      [],
      { pane: null, page: null },
      10,
      piiValuesOf(read),
    );
    writeOutputs(out, [shaped], '2026-10-09T07:00:00.000Z');
    for (const file of ['results.json', 'index.html']) {
      const text = readFileSync(join(out, file), 'utf8').toLowerCase();
      for (const secret of SECRETS) expect(text).not.toContain(secret.toLowerCase());
    }
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('(hidden)');
  });
});

describe('classifyTrpcRequest: opt-in HMS reads', () => {
  const url = 'https://nava.legacyhotels.co.za/api/trpc/panePartyLookup.findParty?batch=1';

  it('blocks the party lookup by default and lets it through only when a proof run opts in', () => {
    expect(classifyTrpcRequest(url).allowed).toBe(false);
    expect(classifyTrpcRequest(url, { allowHmsReads: true }).allowed).toBe(true);
  });

  it('never lets an HMS write through, even with the opt-in', () => {
    for (const name of ['workstation.executeStaffQuote', 'quoteWorkflow.commitStay', 'workstation.bridgeTicket']) {
      const decision = classifyTrpcRequest(`https://nava.legacyhotels.co.za/api/trpc/${name}?batch=1`, { allowHmsReads: true });
      expect(decision.allowed, name).toBe(false);
    }
  });
});

describe('classifyTrpcRequest', () => {
  const origin = 'https://nava.legacyhotels.co.za/api/trpc/';

  // The app sends queries as POST (methodOverride). The method is not an input here, so a
  // batched POST is judged by the procedure names in its path.
  it('allows one query, even when the app sends it as a POST', () => {
    expect(classifyTrpcRequest(`${origin}mail.get?batch=1`)).toEqual({
      allowed: true,
      procedures: ['mail.get'],
      blocked: [],
    });
  });

  it('allows a batched POST made only of queries', () => {
    const decision = classifyTrpcRequest(
      `${origin}mail.get,mail.listThreads,brain.getCapabilities?batch=1`,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.procedures).toEqual(['mail.get', 'mail.listThreads', 'brain.getCapabilities']);
    expect(decision.blocked).toEqual([]);
  });

  it('blocks a batched POST that carries one mutation, and names it as a write', () => {
    const decision = classifyTrpcRequest(`${origin}mail.get,workstation.bridgeTicket?batch=1`);
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toEqual([{ procedure: 'workstation.bridgeTicket', reason: 'write' }]);
  });

  it('allows the voucher lookup: a read of stored mail and attachments, with no HMS call', () => {
    expect(classifyTrpcRequest(`${origin}quoteWorkflow.voucherFind?batch=1`)).toEqual({
      allowed: true,
      procedures: ['quoteWorkflow.voucherFind'],
      blocked: [],
    });
  });

  it('allows the analysis mutation, which is read-only for HMS and mail', () => {
    expect(classifyTrpcRequest(`${origin}quoteWorkflow.analyseSelection?batch=1`).allowed).toBe(
      true,
    );
  });

  it('blocks an unknown procedure and lists it as unknown, not as a write', () => {
    expect(classifyTrpcRequest(`${origin}mail.neverSeenBefore?batch=1`).blocked).toEqual([
      { procedure: 'mail.neverSeenBefore', reason: 'unknown' },
    ]);
  });

  it('blocks a request whose path names no procedure', () => {
    expect(classifyTrpcRequest(`${origin}?batch=1`)).toEqual({
      allowed: false,
      procedures: [],
      blocked: [{ procedure: '(none)', reason: 'unknown' }],
    });
  });
});

describe('parseRunConfig for the EC2 gate', () => {
  it('reads the pinned resolve address and the transport', () => {
    const config = parseRunConfig(
      ['--latest', '20'],
      env({
        NAVA_PREVIEW_RESOLVE_TO: '127.0.0.1',
        NAVA_PREVIEW_TRANSPORT_ID: 'transport-centurion',
      }),
      dir,
    );
    expect(config).toMatchObject({
      resolveTo: '127.0.0.1',
      transportId: 'transport-centurion',
      selection: { kind: 'latest', count: 20 },
    });
  });

  it('keeps normal DNS and the server default when neither is set', () => {
    const config = parseRunConfig(['--latest', '1'], env(), dir);
    expect(config).toMatchObject({ resolveTo: null, transportId: null });
  });

  it('refuses a resolve value that is not an IPv4 address', () => {
    expect(() =>
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_RESOLVE_TO: 'localhost' }), dir),
    ).toThrow('IPv4');
    expect(() =>
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_RESOLVE_TO: '127.0.0.1;evil' }), dir),
    ).toThrow('IPv4');
  });

  it('refuses a transport id with spaces or shell characters', () => {
    expect(() =>
      parseRunConfig(['--latest', '1'], env({ NAVA_PREVIEW_TRANSPORT_ID: 'a b' }), dir),
    ).toThrow('invalid id');
  });

  it('records the run settings in results.json without any secret', () => {
    const out = join(dir, 'meta-run');
    writeOutputs(out, [], '2026-10-09T07:00:00.000Z', [], {
      baseUrl: 'https://nava.legacyhotels.co.za',
      transportId: 'transport-centurion',
      resolveTo: '127.0.0.1',
    });
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as {
      meta: Record<string, string | null>;
    };
    expect(json.meta).toEqual({
      baseUrl: 'https://nava.legacyhotels.co.za',
      transportId: 'transport-centurion',
      resolveTo: '127.0.0.1',
    });
  });
});
