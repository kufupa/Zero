import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lookupLearnedSenderHistory,
  recordSenderParty,
  replaceLearnedSenderMapForTests,
} from '../src/ai/party-sender-map.js';
import { partySenderMap } from '../src/db/schema/party-sender-map.js';
import { probeTestDb, withTestDb } from './helpers/test-db.js';

const dbAvailable = await probeTestDb();

afterEach(() => {
  vi.unstubAllEnvs();
  replaceLearnedSenderMapForTests(null);
});

describe('learned sender history', () => {
  it('returns native id, IATA and support for exact and parent hosts, but never freemail', () => {
    replaceLearnedSenderMapForTests([
      {
        host: 'agency.example.test',
        kind: 'agency',
        name: 'Harbor Travel',
        nativeId: 'AG-7',
        iata: 'CPT',
        support: 3,
      },
    ]);

    expect(lookupLearnedSenderHistory('agency.example.test')).toEqual({
      kind: 'agency',
      name: 'Harbor Travel',
      nativeId: 'AG-7',
      iata: 'CPT',
      support: 3,
    });
    expect(lookupLearnedSenderHistory('sales.agency.example.test')).toMatchObject({
      nativeId: 'AG-7',
      support: 3,
    });
    expect(lookupLearnedSenderHistory('person@gmail.com')).toBeNull();
    expect(lookupLearnedSenderHistory('gmail.com')).toBeNull();
  });

  it.skipIf(!dbAvailable)('increments same party, replaces different party, skips freemail and own domain', () =>
    withTestDb(async (db) => {
      const host = `sender-${randomUUID()}.example.test`;
      await expect(
        recordSenderParty(db, {
          host,
          kind: 'agency',
          name: 'Harbor Travel',
          nativeId: 'AG-7',
          iata: 'CPT',
        }),
      ).resolves.toMatchObject({ kind: 'agency', nativeId: 'AG-7', support: 1 });
      await expect(
        recordSenderParty(db, {
          host,
          kind: 'agency',
          name: 'Harbor Travel Group',
          nativeId: 'AG-7',
          iata: 'CPT',
        }),
      ).resolves.toMatchObject({ name: 'Harbor Travel Group', support: 2 });
      await expect(
        recordSenderParty(db, {
          host,
          kind: 'company',
          name: 'Northstar Group',
          nativeId: 'CO-2',
          iata: null,
        }),
      ).resolves.toMatchObject({ kind: 'company', nativeId: 'CO-2', support: 1 });
      await expect(
        recordSenderParty(db, {
          host: 'sub.gmail.com',
          kind: 'agency',
          name: 'Ignored Freemail',
          nativeId: 'AG-8',
          iata: null,
        }),
      ).resolves.toBeNull();
      await expect(
        recordSenderParty(db, {
          host: 'centurion.legacyhotels.co.za',
          kind: 'company',
          name: 'Ignored Internal',
          nativeId: 'CO-3',
          iata: null,
        }),
      ).resolves.toBeNull();

      const [stored] = await db.select().from(partySenderMap).where(
        (await import('drizzle-orm')).eq(partySenderMap.host, host),
      );
      expect(stored).toMatchObject({ kind: 'company', nativeId: 'CO-2', support: 1 });
    }));
});
