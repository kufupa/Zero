import {
  DEFAULT_OUT,
  main,
  sampleSplitOf,
  selectSample,
  type SampleRow,
} from '../scripts/export-label-sample.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { message } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const EXTRACTOR = 'extractor-v5';
const SEED = 'test-seed';
const PER_KIND = 3;

type Seeded = {
  kind: string;
  domain: string;
  fromAddress?: string;
  status?: 'succeeded' | 'failed';
  inbound?: boolean;
  textBody?: string;
  payload?: Record<string, unknown>;
};

/** Domains picked with the real split hash: `count` that land in holdout and `count` that land in dev. */
function domainsBySplit(count: number) {
  const holdout: string[] = [];
  const dev: string[] = [];
  for (let index = 0; holdout.length < count || dev.length < count; index += 1) {
    const domain = `agent-${index}.example.org`;
    if (sampleSplitOf(domain) === 'holdout') {
      if (holdout.length < count) holdout.push(domain);
    } else if (dev.length < count) {
      dev.push(domain);
    }
  }
  return { holdout, dev };
}

const { holdout: HOLD, dev: DEV } = domainsBySplit(3);
const DOMAINS = [...HOLD, ...DEV];

/**
 * Cancellations 5 (above the quota of 3, so all must be kept), quote 6, booking 4, amendment 3, voucher_pop 2, spam 1,
 * other 0. A failed quote and an outbound quote are noise: neither may count.
 */
function dataset(): Seeded[] {
  const rows: Seeded[] = [];
  const add = (kind: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      rows.push({ kind, domain: DOMAINS[rows.length % DOMAINS.length]! });
    }
  };
  add('cancellation', 5);
  add('quote', 6);
  add('booking', 4);
  add('amendment', 3);
  add('voucher_pop', 2);
  add('spam', 1);
  rows.push({ kind: 'quote', domain: DEV[0]!, status: 'failed' });
  rows.push({ kind: 'quote', domain: DEV[1]!, inbound: false });
  return rows;
}

async function seedRows(db: DB, rows: Seeded[]) {
  for (const [index, row] of rows.entries()) {
    const messageId = `msg-sample-${index}`;
    await seedInboxThread(db, {
      threadId: `thread-sample-${index}`,
      transportId: TRANSPORT_ID,
      transportEmail: TRANSPORT_EMAIL,
      messageId,
      fromAddress: row.fromAddress ?? `guest-${index}@${row.domain}`,
      subject: `Request ${index}`,
      textBody: row.textBody ?? `Please book two rooms, reference ${index}.`,
    });
    if (row.inbound === false) {
      await db.update(message).set({ direction: 'outbound' }).where(eq(message.id, messageId));
    }
    await db.insert(mailExtraction).values({
      messageId,
      extractorVersion: EXTRACTOR,
      status: row.status ?? 'succeeded',
      kind: row.kind,
      payload: row.payload ?? { kind: row.kind },
    });
  }
}

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'label-sample-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readRows(file: string): SampleRow[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SampleRow);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileState(file: string): number | null {
  return existsSync(file) ? statSync(file).mtimeMs : null;
}

async function writeSample(url: string, file: string, extra: string[] = []): Promise<number> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return main(
    ['--write', '--out', file, '--per-kind', String(PER_KIND), '--seed', SEED, ...extra],
    { DATABASE_URL: url },
  );
}

describe('export-label-sample', () => {
  it('selects every cancellation and a seeded quota of each other kind', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedRows(db, dataset());
      const { available, picked } = await selectSample(db, { perKind: PER_KIND, seed: SEED });
      expect(available).toEqual({
        quote: 6,
        booking: 4,
        amendment: 3,
        cancellation: 5,
        voucher_pop: 2,
        spam: 1,
        other: 0,
      });
      expect(countBy(picked.map((row) => row.kind))).toEqual({
        cancellation: 5,
        quote: 3,
        booking: 3,
        amendment: 3,
        voucher_pop: 2,
        spam: 1,
      });
    });
  });

  it('counts a message once, samples its latest succeeded extraction, and ignores a later failed run', async () => {
    await withIngestionDb(async ({ db }) => {
      const OLD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const NEW = '00000000-0000-4000-8000-000000000001';
      await seedInboxThread(db, {
        threadId: 'thread-twice',
        transportId: TRANSPORT_ID,
        transportEmail: TRANSPORT_EMAIL,
        messageId: 'msg-twice',
        fromAddress: `guest@${DEV[0]}`,
        subject: 'Two versions',
        textBody: 'Please book two rooms.',
      });
      // The newer succeeded version has the smaller id, so only created_at, not id order, can pick it.
      await db.insert(mailExtraction).values([
        {
          id: OLD,
          messageId: 'msg-twice',
          extractorVersion: 'extractor-v4',
          status: 'succeeded',
          kind: 'quote',
          payload: { kind: 'quote', rooms: 1 },
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          id: NEW,
          messageId: 'msg-twice',
          extractorVersion: EXTRACTOR,
          status: 'succeeded',
          kind: 'quote',
          payload: { kind: 'quote', rooms: 2 },
          createdAt: new Date('2026-10-05T00:00:00Z'),
        },
        {
          messageId: 'msg-twice',
          extractorVersion: 'extractor-v6',
          status: 'failed',
          kind: 'quote',
          payload: null,
          createdAt: new Date('2026-10-09T00:00:00Z'),
        },
      ]);

      const { available, picked } = await selectSample(db, { perKind: PER_KIND, seed: SEED });

      expect(available.quote).toBe(1);
      expect(picked).toEqual([
        expect.objectContaining({
          messageId: 'msg-twice',
          extractionId: NEW,
          extractorVersion: EXTRACTOR,
          kind: 'quote',
        }),
      ]);
    });
  });

  it('writes one masked row per pick, with a 0600 file', async () => {
    await withIngestionDb(async ({ db, url }) => {
      await seedRows(db, dataset());
      const file = join(scratch(), 'sample.jsonl');
      expect(await writeSample(url, file)).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const rows = readRows(file);
      expect(rows).toHaveLength(17);
      expect(countBy(rows.map((row) => row.stratum))).toEqual({
        cancellation: 5,
        quote: 3,
        booking: 3,
        amendment: 3,
        voucher_pop: 2,
        spam: 1,
      });
      for (const row of rows) {
        expect(row.schema_version).toBe('label-sample/v1');
        expect(row.sender_domain_sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('masks e-mail, phone, card and security code, and keeps no raw sender', async () => {
    await withIngestionDb(async ({ db, url }) => {
      const fromAddress = 'jane.doe@sender-private.example.org';
      await seedRows(db, [
        {
          kind: 'booking',
          domain: 'sender-private.example.org',
          fromAddress,
          textBody:
            'Call +27 82 555 1234 or mail jane.doe@hotel.example. Card 4111 1111 1111 1111, CVV: 123.',
          payload: {
            kind: 'booking',
            contact: { email: 'jane.doe@hotel.example', phone: '+27 82 555 1234' },
          },
        },
      ]);
      const file = join(scratch(), 'sample.jsonl');
      expect(await writeSample(url, file)).toBe(0);
      const raw = readFileSync(file, 'utf8');
      for (const secret of [
        fromAddress,
        'sender-private.example.org',
        'jane.doe@',
        '+27 82 555 1234',
        '4111 1111 1111 1111',
        'CVV: 123',
      ]) {
        expect(raw).not.toContain(secret);
      }
      const [row] = readRows(file);
      expect(row!.text).toContain('[phone]');
      expect(row!.text).toContain('[email]');
      expect(row!.text).toContain('[card ••••1111]');
      expect(row!.text).toContain('CVV: [code masked]');
      expect(row!.ai.payload).toEqual({
        kind: 'booking',
        contact: { email: '[email]', phone: '[phone]' },
      });
    });
  });

  it('keeps each sender domain in one split, with both splits present', async () => {
    await withIngestionDb(async ({ db, url }) => {
      await seedRows(db, dataset());
      const file = join(scratch(), 'sample.jsonl');
      expect(await writeSample(url, file)).toBe(0);
      const rows = readRows(file);

      const expectedSplit = new Map(
        DOMAINS.map((domain) => [sha256(domain), sampleSplitOf(domain)]),
      );
      for (const row of rows) {
        expect(row.split).toBe(expectedSplit.get(row.sender_domain_sha256));
      }
      const holdout = new Set(
        rows.filter((row) => row.split === 'holdout').map((row) => row.sender_domain_sha256),
      );
      const dev = new Set(
        rows.filter((row) => row.split === 'dev').map((row) => row.sender_domain_sha256),
      );
      expect(holdout.size).toBeGreaterThan(0);
      expect(dev.size).toBeGreaterThan(0);
      for (const domain of holdout) expect(dev.has(domain)).toBe(false);
    });
  });

  it('is deterministic for a given seed', async () => {
    await withIngestionDb(async ({ db, url }) => {
      await seedRows(db, dataset());
      const first = join(scratch(), 'a.jsonl');
      const second = join(scratch(), 'b.jsonl');
      await writeSample(url, first);
      await writeSample(url, second);
      expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
    });
  });

  it('dry run prints the counts and writes nothing', async () => {
    await withIngestionDb(async ({ db, url }) => {
      await seedRows(db, dataset());
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const before = fileState(DEFAULT_OUT);
      expect(
        await main(['--per-kind', String(PER_KIND), '--seed', SEED], { DATABASE_URL: url }),
      ).toBe(0);
      const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(summary).toMatchObject({
        dryRun: true,
        total: 17,
        selected: { cancellation: 5, quote: 3, spam: 1, other: 0 },
      });
      expect(summary.out).toBeUndefined();
      expect(fileState(DEFAULT_OUT)).toEqual(before);
    });
  });

  it('rejects bad arguments with exit 2 before connecting to the database', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { DATABASE_URL: 'postgres://127.0.0.1:1/unreachable' };
    for (const argv of [
      ['--per-kind', '0'],
      ['--per-kind', 'abc'],
      ['--per-kind', '2.5'],
      ['--seed', '  '],
      ['--out', 'x.jsonl'],
      ['stray'],
      ['--bogus'],
    ]) {
      expect(await main(argv, env)).toBe(2);
    }
    expect(await main([], {})).toBe(2);
  });

  it('holds out about 20% of domains, and the split is a pure function of the domain', () => {
    let holdout = 0;
    for (let index = 0; index < 2000; index += 1) {
      const domain = `hotel-${index}.example.com`;
      if (sampleSplitOf(domain) === 'holdout') holdout += 1;
    }
    expect(holdout / 2000).toBeGreaterThan(0.15);
    expect(holdout / 2000).toBeLessThan(0.25);
    expect(sampleSplitOf('hotel-7.example.com')).toBe(sampleSplitOf('hotel-7.example.com'));
  });

  it('writes the default output under the gitignored .private folder', () => {
    expect(DEFAULT_OUT).toMatch(/\.private\/label-sample\/label-sample-v1\.jsonl$/);
  });
});
