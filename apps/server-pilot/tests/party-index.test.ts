import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  indexRank,
  loadPartyIndex,
  parsePartyIndexProperty,
  partyIndexFileSchema,
  partyIndexPath,
  partyIndexProgressPath,
  searchPartyIndex,
  typeaheadPartyIndex,
  writePrivateFile,
  type PartyIndexFile,
} from '../src/ai/party-index.js';
import { panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import { verifyStaffParties } from '../src/trpc/routes/workstation.js';
import { appRouter } from '../src/trpc/router.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const GENERATED = '2026-10-10T10:00:00Z';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'party-index-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
  await rm(dir, { recursive: true, force: true });
});

function indexFile(entries: PartyIndexFile['entries'], generatedAt = GENERATED): PartyIndexFile {
  return { generatedAt, entries };
}

async function writeIndex(name: string, index: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof index === 'string' ? index : JSON.stringify(index));
  return path;
}

const tourvest = { kind: 'company' as const, nativeId: '206', name: 'Tourvest Test Profile' };
const cwt = { kind: 'agency' as const, nativeId: '290', name: 'CWT JNB' };

import { matchKey } from '../src/ai/party-match.js';
describe('index load and miss', () => {
  it('a missing file is no index: null, and the typeahead says it is unavailable', async () => {
    const path = join(dir, 'absent.json');
    await expect(loadPartyIndex(path)).resolves.toBeNull();
    await expect(typeaheadPartyIndex('Tour', { path, now: NOW })).resolves.toEqual({
      source: 'index',
      available: false,
      updatedAt: null,
      ageMs: null,
      results: [],
    });
  });

  it('a file that is not JSON, or does not match the schema, is no index either', async () => {
    await expect(loadPartyIndex(await writeIndex('bad.json', '{not json'))).resolves.toBeNull();
    await expect(
      loadPartyIndex(await writeIndex('wrong.json', { generatedAt: GENERATED, entries: [{ kind: 'person', nativeId: '1', name: 'X' }] })),
    ).resolves.toBeNull();
    await expect(
      loadPartyIndex(await writeIndex('extra.json', { generatedAt: GENERATED, entries: [], unexpected: true })),
    ).resolves.toBeNull();
  });

  it('a valid file loads, and a rewritten file is read again', async () => {
    const path = await writeIndex('valid.json', indexFile([tourvest]));
    await expect(loadPartyIndex(path)).resolves.toEqual(indexFile([tourvest]));
    await writeFile(path, JSON.stringify(indexFile([cwt])));
    await expect(loadPartyIndex(path)).resolves.toEqual(indexFile([cwt]));
  });

  it('PARTY_INDEX_PATH chooses the file; the default sits in the private pipeline root', () => {
    expect(partyIndexPath({ PARTY_INDEX_PATH: '/srv/index.json' })).toBe('/srv/index.json');
    expect(partyIndexPath({})).toMatch(/\.private\/pms-pipeline\/party-index\/party-index\.json$/);
  });

  it('keeps the HRCEN file and puts HRDAV in a sibling file, with no Centurion fallback', async () => {
    expect(parsePartyIndexProperty('hrdav')).toBe('HRDAV');
    expect(parsePartyIndexProperty('HRCEN')).toBe('HRCEN');
    expect(parsePartyIndexProperty('HROTH')).toBeNull();
    expect(partyIndexPath({}, 'HRCEN')).toMatch(/\/party-index\.json$/);
    expect(partyIndexPath({}, 'HRDAV')).toMatch(/\/party-index-HRDAV\.json$/);
    expect(partyIndexPath({ PARTY_INDEX_PATH: '/srv/index.json' }, 'HRDAV')).toMatch(/\/party-index-HRDAV\.json$/);
    expect(partyIndexPath({ PARTY_INDEX_PATH_HRDAV: '/srv/dv.json' }, 'HRDAV')).toBe('/srv/dv.json');
    expect(partyIndexProgressPath('/tmp/party-index.json', 'HRCEN')).toBe('/tmp/party-index.progress.json');
    expect(partyIndexProgressPath('/tmp/party-index-HRDAV.json', 'HRDAV')).toBe(
      '/tmp/party-index-HRDAV.progress.json',
    );

    const hrcen = await writeIndex('hrcen.json', indexFile([tourvest]));
    const hrdav = await writeIndex('hrdav.json', indexFile([cwt]));
    const env = { PARTY_INDEX_PATH: hrcen, PARTY_INDEX_PATH_HRDAV: hrdav };
    await expect(typeaheadPartyIndex('Tour', { propertyCode: 'HRCEN', env, now: NOW })).resolves.toMatchObject({
      available: true,
      results: [tourvest],
    });
    await expect(typeaheadPartyIndex('cwt', { propertyCode: 'HRDAV', env, now: NOW })).resolves.toMatchObject({
      available: true,
      results: [cwt],
    });
    await expect(typeaheadPartyIndex('Tour', { propertyCode: 'HRDAV', env, now: NOW })).resolves.toMatchObject({
      available: true,
      results: [],
    });
    await expect(
      typeaheadPartyIndex('Tour', {
        propertyCode: 'HRDAV',
        env: { PARTY_INDEX_PATH: hrcen },
        now: NOW,
      }),
    ).resolves.toEqual({
      source: 'index',
      available: false,
      updatedAt: null,
      ageMs: null,
      results: [],
    });
    await expect(
      typeaheadPartyIndex('Tour', { propertyCode: 'HROTH', env, now: NOW }),
    ).resolves.toEqual({
      source: 'index',
      available: false,
      updatedAt: null,
      ageMs: null,
      results: [],
    });
  });

  it('writes the private file with mode 600, whole, with no temporary file left behind', async () => {
    const path = join(dir, 'private', 'party-index.json');
    await writePrivateFile(path, JSON.stringify(indexFile([tourvest])));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(indexFile([tourvest]));
    expect(partyIndexFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8'))).success).toBe(true);
  });
});

describe('ranking', () => {
  it('ranks an exact name first, then a prefix, then a word start, then containment', () => {
    expect(indexRank('Tourvest', 'Tourvest')).toBe(0);
    expect(indexRank('Tour', 'Tourvest Group')).toBe(1);
    expect(indexRank('Group', 'Tourvest Group')).toBe(2);
    expect(indexRank('vest', 'Tourvest Group')).toBe(3);
    expect(indexRank('zzz', 'Tourvest Group')).toBe(4);
  });

  it('keeps the best ten of each kind, and companies do not crowd out agencies', () => {
    const companies = Array.from({ length: 25 }, (_, i) => ({
      kind: 'company' as const,
      nativeId: String(1000 + i),
      name: `Tour Company ${String(i).padStart(2, '0')}`,
    }));
    const agencies = [
      { kind: 'agency' as const, nativeId: '1', name: 'Tour Agency One' },
      { kind: 'agency' as const, nativeId: '2', name: 'Tour Agency Two' },
    ];
    const found = searchPartyIndex(indexFile([...companies, ...agencies]), 'Tour');
    expect(found.filter((row) => row.kind === 'company')).toHaveLength(10);
    expect(found.filter((row) => row.kind === 'agency').map((row) => row.nativeId)).toEqual(['1', '2']);
    expect(found[0]).toEqual({ kind: 'company', nativeId: '1000', name: 'Tour Company 00' });
  });

  it('puts the exact name ahead of a longer name that starts with it', () => {
    const found = searchPartyIndex(
      indexFile([
        { kind: 'company', nativeId: '9', name: 'Tourvest Group' },
        { kind: 'company', nativeId: '8', name: 'Tourvest' },
      ]),
      'Tourvest',
    );
    expect(found.map((row) => row.nativeId)).toEqual(['8', '9']);
  });

  it('an empty or punctuation-only query finds nothing, rather than everything', () => {
    expect(searchPartyIndex(indexFile([tourvest]), '')).toEqual([]);
    expect(searchPartyIndex(indexFile([tourvest]), '  ! ')).toEqual([]);
  });
});

describe('Unicode', () => {
  it('folds accents and case, so Zoë, Société and 李明 match their own text in any spelling', () => {
    expect(matchKey('Société')).toBe('societe');
    expect(matchKey('Zoë Travel')).toBe('zoe travel');
    expect(matchKey('李明 有限公司')).toBe('李明 有限公司');
    const index = indexFile([
      { kind: 'company', nativeId: '11', name: 'Société Générale' },
      { kind: 'company', nativeId: '12', name: 'Zoë Travel' },
      { kind: 'company', nativeId: '13', name: '李明 有限公司' },
    ]);
    expect(searchPartyIndex(index, 'societe').map((row) => row.nativeId)).toEqual(['11']);
    expect(searchPartyIndex(index, 'SOCIÉTÉ').map((row) => row.nativeId)).toEqual(['11']);
    expect(searchPartyIndex(index, 'zoe').map((row) => row.nativeId)).toEqual(['12']);
    expect(searchPartyIndex(index, '李明').map((row) => row.nativeId)).toEqual(['13']);
    expect(searchPartyIndex(index, '明').map((row) => row.nativeId)).toEqual(['13']);
  });

  it('spacing and punctuation do not stop a multi-word match', () => {
    const index = indexFile([{ kind: 'company', nativeId: '21', name: 'Woolworths Holdings (Pty) Ltd' }]);
    expect(searchPartyIndex(index, '  woolworths   holdings ').map((row) => row.nativeId)).toEqual(['21']);
    expect(searchPartyIndex(index, 'woolworths-holdings').map((row) => row.nativeId)).toEqual(['21']);
  });
});

describe('the typeahead and the index age', () => {
  it('reports the index age, and a clock that runs slow never shows a negative age', async () => {
    const path = await writeIndex('aged.json', indexFile([tourvest], new Date(NOW - 9 * 86_400_000).toISOString()));
    const reply = await typeaheadPartyIndex('Tour', { path, now: NOW });
    expect(reply.available).toBe(true);
    expect(reply.ageMs).toBe(9 * 86_400_000);
    expect(reply.results).toEqual([tourvest]);
    // A clock a minute behind the file's own timestamp: the age is clamped at zero, never negative.
    const future = await typeaheadPartyIndex('Tour', { path, now: NOW - 9 * 86_400_000 - 60_000 });
    expect(future.ageMs).toBe(0);
  });

  it('the typeahead route is read-only and empty without a file', async () => {
    const caller = appRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers(),
      sessionUser: { id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      activeTransportId: 'transport-1',
      transportEmail: 'centurion@legacyhotels.co.za',
      accessRole: 'owner',
    } as never);
    vi.stubEnv('PARTY_INDEX_PATH', join(dir, 'missing.json'));
    await expect(caller.panePartyLookup.typeahead({ query: 'Tour' })).resolves.toMatchObject({
      source: 'index',
      available: false,
      results: [],
    });
    vi.stubEnv('PARTY_INDEX_PATH', await writeIndex('route.json', indexFile([tourvest, cwt])));
    await expect(caller.panePartyLookup.typeahead({ query: 'cwt' })).resolves.toMatchObject({
      source: 'index',
      available: true,
      results: [cwt],
    });
    await expect(caller.panePartyLookup.typeahead({ query: 'x'.repeat(300) } as never)).rejects.toThrow();
  });

  it('a Da Vinci mailbox typeahead reads the HRDAV file and never the HRCEN list', async () => {
    const caller = appRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers(),
      sessionUser: { id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      activeTransportId: 'transport-davinci',
      transportEmail: 'davinci@legacyhotels.co.za',
      accessRole: 'owner',
    } as never);
    vi.stubEnv('PARTY_INDEX_PATH', await writeIndex('cen-route.json', indexFile([tourvest])));
    vi.stubEnv('PARTY_INDEX_PATH_HRDAV', join(dir, 'missing-dv.json'));
    await expect(caller.panePartyLookup.typeahead({ query: 'Tour' })).resolves.toMatchObject({
      source: 'index',
      available: false,
      results: [],
    });
    vi.stubEnv('PARTY_INDEX_PATH_HRDAV', await writeIndex('dv-route.json', indexFile([cwt])));
    await expect(caller.panePartyLookup.typeahead({ query: 'cwt' })).resolves.toMatchObject({
      available: true,
      results: [cwt],
    });
    await expect(caller.panePartyLookup.typeahead({ query: 'Tour' })).resolves.toMatchObject({
      available: true,
      results: [],
    });
  });
});

describe('a pick from the list is still checked live before a rate is bound', () => {
  it('an index id HMS does not confirm is refused, so a stale or made-up list entry never binds', async () => {
    panePartyLookupLoaders.lock = { withLock: async (fn) => fn() };
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'resolved',
      candidates: [{ nativeId: '999', displayName: 'Someone Else', kind: 'organization', matchedOn: ['store'] }],
      truncated: false,
    });
    const refused = await verifyStaffParties({ company: { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' } }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  it('preserves party verification lock busy as a retryable HMS lock marker', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'on');
    panePartyLookupLoaders.lock = {
      withLock: async () => {
        throw Object.assign(new Error('lock wait'), {
          cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
        });
      },
    };

    const refused = await verifyStaffParties({
      company: { kind: 'company', nativeId: 'busy-206', name: 'Busy Test Profile' },
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).cause).toMatchObject({ code: 'HMS_LOCK_BUSY' });
  });

  it('an index id HMS confirms under the same name binds HMS’s own name', async () => {
    panePartyLookupLoaders.lock = { withLock: async (fn) => fn() };
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'resolved',
      candidates: [{ nativeId: '206', displayName: 'Tourvest Test Profile', kind: 'organization', matchedOn: ['store'] }],
      truncated: false,
    });
    await expect(
      verifyStaffParties({ company: { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' } }),
    ).resolves.toEqual({ company: { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' } });
  });
});
