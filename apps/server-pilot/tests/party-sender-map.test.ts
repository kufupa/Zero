import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOwnedHotelHost,
  lookupLearnedSenderHistory,
  lookupLearnedSenderParty,
  partyHistoryBindEnabled,
  recordSenderParty,
  replaceLearnedSenderMapForTests,
  withSenderHistoryProperty,
} from '../src/ai/party-sender-map.js';
import { partySenderMap } from '../src/db/schema/party-sender-map.js';
import { probeTestDb, withTestDb } from './helpers/test-db.js';

const dbAvailable = await probeTestDb();

afterEach(() => {
  vi.unstubAllEnvs();
  replaceLearnedSenderMapForTests(null);
});

describe('owned hotel sender hosts', () => {
  it.each([
    'legacyhotels.co.za',
    'centurion.legacyhotels.co.za',
    'legacyhotels.com',
    'mail.legacyhotels.com',
    'legacyhotel.com',
    'mail.legacyhotel.com',
  ])('excludes owned host %s', (host) => {
    expect(isOwnedHotelHost(host)).toBe(true);
  });

  it('keeps unrelated sender hosts eligible', () => {
    expect(isOwnedHotelHost('travel.example.test')).toBe(false);
  });
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

  it('still returns history for ranking when PARTY_HISTORY_BIND is off', () => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'off');
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
    expect(partyHistoryBindEnabled()).toBe(false);
    expect(lookupLearnedSenderHistory('agency.example.test')).toMatchObject({
      kind: 'agency',
      name: 'Harbor Travel',
      nativeId: 'AG-7',
    });
  });

  it.each([
    { storedHost: 'legacyhotels.com', lookupHost: 'legacyhotels.com' },
    { storedHost: 'legacyhotel.com', lookupHost: 'mail.legacyhotel.com' },
  ])('never binds from an existing owned-host row: $lookupHost', ({ storedHost, lookupHost }) => {
    replaceLearnedSenderMapForTests([
      {
        host: storedHost,
        kind: 'agency',
        name: 'Internal Party',
        nativeId: 'AG-99',
        iata: null,
        support: 2,
      },
    ]);

    expect(lookupLearnedSenderHistory(lookupHost)).toBeNull();
    expect(lookupLearnedSenderParty(lookupHost)).toBeNull();
  });

  it('keeps the same host as two hotel rows and never returns the other hotel', () => {
    replaceLearnedSenderMapForTests([
      {
        propertyCode: 'HRCEN',
        host: 'agency.example.test',
        kind: 'agency',
        name: 'Centurion Agency',
        nativeId: 'AG-CEN',
        iata: 'CPT',
        support: 3,
      },
      {
        propertyCode: 'HRDAV',
        host: 'agency.example.test',
        kind: 'agency',
        name: 'Da Vinci Agency',
        nativeId: 'AG-DAV',
        iata: 'JNB',
        support: 2,
      },
    ]);

    expect(lookupLearnedSenderHistory('agency.example.test', 'HRCEN')).toMatchObject({
      name: 'Centurion Agency',
      nativeId: 'AG-CEN',
    });
    expect(lookupLearnedSenderHistory('agency.example.test', 'HRDAV')).toMatchObject({
      name: 'Da Vinci Agency',
      nativeId: 'AG-DAV',
    });
    expect(lookupLearnedSenderHistory('agency.example.test', 'HRDAV')?.nativeId).not.toBe('AG-CEN');
    expect(lookupLearnedSenderHistory('sales.agency.example.test', 'HRDAV')).toMatchObject({
      nativeId: 'AG-DAV',
    });
  });

  it('uses an ambient hotel for callers that cannot pass property', () => {
    replaceLearnedSenderMapForTests([
      {
        propertyCode: 'HRCEN',
        host: 'agency.example.test',
        kind: 'agency',
        name: 'Centurion Agency',
        nativeId: 'AG-CEN',
        support: 3,
      },
      {
        propertyCode: 'HRDAV',
        host: 'agency.example.test',
        kind: 'agency',
        name: 'Da Vinci Agency',
        nativeId: 'AG-DAV',
        support: 2,
      },
    ]);
    expect(
      withSenderHistoryProperty('HRDAV', () => lookupLearnedSenderHistory('agency.example.test')),
    ).toMatchObject({ nativeId: 'AG-DAV' });
  });

  it.skipIf(!dbAvailable)('increments same party, replaces different party, skips freemail and own domain', () =>
    withTestDb(async (db) => {
      const host = `sender-${randomUUID()}.example.test`;
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host,
          kind: 'agency',
          name: 'Harbor Travel',
          nativeId: 'AG-7',
          iata: 'CPT',
        }),
      ).resolves.toMatchObject({ kind: 'agency', nativeId: 'AG-7', support: 1 });
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host,
          kind: 'agency',
          name: 'Harbor Travel Group',
          nativeId: 'AG-7',
          iata: 'CPT',
        }),
      ).resolves.toMatchObject({ name: 'Harbor Travel Group', support: 2 });
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host,
          kind: 'company',
          name: 'Northstar Group',
          nativeId: 'CO-2',
          iata: null,
        }),
      ).resolves.toMatchObject({ kind: 'company', nativeId: 'CO-2', support: 1 });
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host: 'sub.gmail.com',
          kind: 'agency',
          name: 'Ignored Freemail',
          nativeId: 'AG-8',
          iata: null,
        }),
      ).resolves.toBeNull();
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host: 'centurion.legacyhotels.co.za',
          kind: 'company',
          name: 'Ignored Internal',
          nativeId: 'CO-3',
          iata: null,
        }),
      ).resolves.toBeNull();

      const { and, eq } = await import('drizzle-orm');
      const [stored] = await db
        .select()
        .from(partySenderMap)
        .where(and(eq(partySenderMap.host, host), eq(partySenderMap.propertyCode, 'HRCEN')));
      expect(stored).toMatchObject({
        propertyCode: 'HRCEN',
        kind: 'company',
        nativeId: 'CO-2',
        support: 1,
      });
    }));

  it.skipIf(!dbAvailable)('stores the same host once per hotel', () =>
    withTestDb(async (db) => {
      const host = `sender-${randomUUID()}.example.test`;
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRCEN',
          host,
          kind: 'agency',
          name: 'Centurion Agency',
          nativeId: 'AG-CEN',
          iata: null,
        }),
      ).resolves.toMatchObject({ nativeId: 'AG-CEN', support: 1 });
      await expect(
        recordSenderParty(db, {
          propertyCode: 'HRDAV',
          host,
          kind: 'agency',
          name: 'Da Vinci Agency',
          nativeId: 'AG-DAV',
          iata: null,
        }),
      ).resolves.toMatchObject({ nativeId: 'AG-DAV', support: 1 });

      const stored = await db.select().from(partySenderMap).where(
        (await import('drizzle-orm')).eq(partySenderMap.host, host),
      );
      expect(stored).toHaveLength(2);
      expect(stored.map((row) => row.propertyCode).sort()).toEqual(['HRDAV', 'HRCEN']);
      expect(lookupLearnedSenderHistory(host, 'HRDAV')).toMatchObject({ nativeId: 'AG-DAV' });
      expect(lookupLearnedSenderHistory(host, 'HRCEN')).toMatchObject({ nativeId: 'AG-CEN' });
    }));
});

describe('party_sender_map property migration', () => {
  it('backfills existing rows to HRCEN then keys the table by hotel and host', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../drizzle/0053_party_sender_property.sql', import.meta.url), 'utf8'),
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "property_code" text NOT NULL DEFAULT 'HRCEN'/);
    expect(sql).toMatch(/PRIMARY KEY \("property_code", "host"\)/);
    expect(sql).toMatch(/ALTER COLUMN "property_code" DROP DEFAULT/);
    expect(sql.indexOf("DEFAULT 'HRCEN'")).toBeLessThan(sql.indexOf('DROP DEFAULT'));
  });
});
