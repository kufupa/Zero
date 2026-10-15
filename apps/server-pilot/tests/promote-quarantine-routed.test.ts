import { describe, expect, it } from 'vitest';
import { mailIngestQuarantine, mailboxTransport, message } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import {
  dryRunRoutedPromote,
  parseRoutedPromoteCliArgs,
  RoutedPromoteDryRunRequiredError,
} from '../src/mail/ingest/promote-quarantine-routed.js';
import { FakeS3Storage } from '../src/storage/s3.js';

const C = {
  id: 'transport-centurion',
  email: 'centurion@example.test',
  ownerHeaderValue: 'centurion@example.test',
  sendFromConfig: { aliases: ['centurion-desk@example.test'] },
};
const D = {
  id: 'transport-davinci',
  email: 'davinci@example.test',
  ownerHeaderValue: 'davinci@example.test',
  sendFromConfig: { aliases: ['davinci-desk@example.test'] },
};

type Q = {
  from: (t: unknown) => Q;
  where: () => Q;
  orderBy: () => Q;
  limit: () => Q;
  then: Promise<unknown[]>['then'];
};

function fakeDb(rows: unknown[], writes: string[], existing: unknown[] = []): DB {
  return {
    select: () => {
      let source: unknown;
      const query: Q = {
        from: (table) => {
          source = table;
          return query;
        },
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (ok, err) =>
          Promise.resolve(
            source === mailIngestQuarantine
              ? rows
              : source === mailboxTransport
                ? [C, D]
                : source === message
                  ? existing
                  : [],
          ).then(ok, err),
      };
      return query;
    },
    insert: () => (writes.push('insert'), { values: () => Promise.resolve() }),
    update: () => (writes.push('update'), { set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => (writes.push('delete'), { where: () => Promise.resolve() }),
  } as unknown as DB;
}

async function run(
  items: Array<{ uidl: string; from: string; to: string }>,
  existing: unknown[] = [],
  opts: { requireOwnerHeader?: boolean } = {},
) {
  const storage = new FakeS3Storage();
  const writes: string[] = [];
  const rows = items.map((item) => ({
    id: `q-${item.uidl}`,
    ingestMailboxId: 'ingest-nava-legacy',
    pop3Uidl: item.uidl,
    rawMimeS3Key: `raw/${item.uidl}`,
  }));
  for (const item of items) {
    await storage.putObject({
      key: `raw/${item.uidl}`,
      body: Buffer.from(`From: ${item.from}\r\nTo: ${item.to}\r\nSubject: synthetic\r\n\r\nbody`),
      contentType: 'message/rfc822',
    });
  }
  storage.calls.length = 0;
  return {
    result: await dryRunRoutedPromote({ db: fakeDb(rows, writes, existing), storage, ...opts }),
    writes,
    storage,
  };
}

describe('promote-quarantine-routed dry-run', () => {
  it('unique-routes each transport with zero writes', async () => {
    const { result, writes, storage } = await run([
      { uidl: 'c', from: 'guest@example.test', to: C.email },
      { uidl: 'd', from: 'guest@example.test', to: D.email },
    ]);
    expect(result.byTransport).toEqual({ 'transport-centurion': 1, 'transport-davinci': 1 });
    expect(result.ingestMailboxes).toEqual(['ingest-nava-legacy']);
    expect(writes).toEqual([]);
    expect(storage.calls.every((call) => call.op === 'GET')).toBe(true);
  });

  it('routes an alias to that transport', async () => {
    const { result, writes } = await run([
      { uidl: 'alias', from: 'guest@example.test', to: 'centurion-desk@example.test' },
    ]);
    expect(result.byTransport).toEqual({ 'transport-centurion': 1 });
    expect(writes).toEqual([]);
  });

  it('classifies multi-transport when two hotels are named', async () => {
    const { result } = await run([
      { uidl: 'multi', from: 'guest@example.test', to: `${C.email}, ${D.email}` },
    ]);
    expect(result.multi_transport).toBe(1);
    expect(result.byTransport).toEqual({});
  });

  it('classifies none as unknown', async () => {
    const { result } = await run([{ uidl: 'none', from: 'guest@example.test', to: 'other@example.test' }]);
    expect(result.unknown).toBe(1);
  });

  it('flags a stored UIDL without writes', async () => {
    const { result, writes } = await run(
      [{ uidl: 'dup', from: 'guest@example.test', to: C.email }],
      [{ ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: 'dup', id: 'msg-dup', transportId: C.id }],
    );
    expect(result.dup_stored).toBe(1);
    expect(result.byTransport['transport-centurion']).toBe(1);
    expect(writes).toEqual([]);
  });

  it('refuses CLI without --dry-run', () => {
    expect(() => parseRoutedPromoteCliArgs([])).toThrow(RoutedPromoteDryRunRequiredError);
    expect(parseRoutedPromoteCliArgs(['--dry-run', '--limit', '2', '--transport', 'transport-davinci'])).toEqual({
      dryRun: true,
      limit: 2,
      transportId: 'transport-davinci',
    });
  });

  it('counts a cross-hotel invariant when recipients do not name T', async () => {
    const { result } = await run([{ uidl: 'from-only', from: D.email, to: 'guest@example.test' }], [], {
      requireOwnerHeader: false,
    });
    expect(result.byTransport).toEqual({ 'transport-davinci': 1 });
    expect(result.cross_hotel_violations).toBe(1);
    expect(result.crossHotelViolationIds).toEqual(['q-from-only']);
  });

  it('counts equated-only From as unknown when requireOwnerHeader is true', async () => {
    const item = { uidl: 'equated-from', from: D.email, to: 'guest@example.test' };
    const strict = await run([item], [], { requireOwnerHeader: true });
    expect(strict.result.requireOwnerHeader).toBe(true);
    expect(strict.result.unknown).toBe(1);
    expect(strict.result.byTransport).toEqual({});

    const relaxed = await run([item], [], { requireOwnerHeader: false });
    expect(relaxed.result.requireOwnerHeader).toBe(false);
    expect(relaxed.result.unknown).toBe(0);
    expect(relaxed.result.byTransport).toEqual({ 'transport-davinci': 1 });
  });
});
