import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DB } from '../src/db/client.js';
import { lockCanonicalMailbox } from '../src/mail/ingest/canonical-identity.js';
import { createSourceSnapshotDigest } from '../src/ai/pane-create-source-snapshot.js';
import { withLockedCreateSource } from '../src/ai/pane-create-source-loader.js';
import { historicalCorrectionFixture, sourceFixture } from './helpers/create-source-fixture.js';

vi.mock('../src/mail/ingest/canonical-identity.js', async (original) => ({
  ...await original<typeof import('../src/mail/ingest/canonical-identity.js')>(),
  lockCanonicalMailbox: vi.fn(async () => {}),
}));

const workItemId = '31b44b6e-ff0a-43c1-a6eb-82aa2771a235';
function fixture() {
  const source = structuredClone(sourceFixture.source);
  const extraction = structuredClone(sourceFixture.extraction);
  const historical = structuredClone(historicalCorrectionFixture);
  const extractions = [extraction, historical.extraction];
  const attachments = structuredClone(sourceFixture.attachments);
  const candidates = [{ event: historical.event, extractionId: historical.extraction.id }];
  const item = { id: workItemId, transportId: source.transportId, threadId: source.threadId,
    sourceMessageId: source.id, extractionId: extraction.id, status: 'needs_you', state: {},
    revision: 2, revisionHead: 3, revisionSeq: 4 };
  const input = { transportId: source.transportId, messageId: source.id, threadId: source.threadId!, workItemId,
    cursor: { extractionId: extraction.id, revision: 2, revisionHead: 3, seq: 4 } };
  const calls: string[] = [];
  const predicates: Array<ReturnType<PgDialect['sqlToQuery']>> = [];
  const dialect = new PgDialect();
  function db() {
    let select = 0;
    vi.mocked(lockCanonicalMailbox).mockImplementation(async () => { calls.push('mailbox'); });
    const tx = { select: () => {
      select += 1;
      const n = select;
      const condition = (query: SQL) => { predicates.push(dialect.sqlToQuery(query)); };
      const locked = (name: string, rows: unknown[]) => ({ for: async (mode: string) => {
        calls.push(`${name}:${mode}`); return rows;
      } });
      if (n === 1) return { from: () => ({ where: (query: SQL) => { condition(query); return { limit: () => locked('source', [source]) }; } }) };
      if (n === 2 || n === 3) return { from: () => ({ where: (query: SQL) => { condition(query); return {
        orderBy: () => ({ limit: () => locked(n === 2 ? 'extractions' : 'attachments', n === 2 ? extractions : attachments) }),
      }; } }) };
      if (n === 4) return { from: () => ({ where: (query: SQL) => { condition(query); return { limit: () => locked('item', [item]) }; } }) };
      return { from: () => ({ innerJoin: (_table: unknown, join: SQL) => { condition(join); return {
        where: (query: SQL) => { condition(query); return { limit: async () => { calls.push('history'); return candidates; } }; },
      }; } }) };
    } };
    return { transaction: async (continuation: (tx: unknown) => Promise<unknown>) => {
      calls.push('transaction'); const result = await continuation(tx); calls.push('commit'); return result;
    } } as unknown as DB;
  }
  return { source, extraction, historical, extractions, attachments, candidates, item, input, calls, predicates, db };
}
beforeEach(() => vi.clearAllMocks());

// Mocks check ordering and data binding, not PostgreSQL row locking or concurrency.
describe('shared locked create source loader', () => {
  it('locks source rows and exact item before scanning history and continuing in the same transaction', async () => {
    const f = fixture();
    const result = await withLockedCreateSource(f.db(), f.input, async (_tx, source) => {
      f.calls.push('continue');
      return source;
    });
    expect(f.calls).toEqual(['transaction', 'mailbox', 'source:update', 'extractions:no key update', 'attachments:update',
      'item:update', 'history', 'continue', 'commit']);
    expect(result.historicalEventIds).toEqual([f.historical.event.id]);
    expect(result.sourceDigest).toBe(createSourceSnapshotDigest({ source: f.source, extraction: f.extraction,
      attachments: f.attachments, historicalCorrections: [f.historical] }));
    expect(f.predicates[0]?.params).toEqual([f.input.messageId, f.input.transportId]);
    expect(f.predicates[3]?.params).toEqual([workItemId, f.input.transportId]);
    expect(f.predicates[4]?.sql).toContain('"mail_extraction"."message_id"');
    expect(f.predicates[5]?.params).toEqual([workItemId, 'user', 'field.edit', 'field.reject']);
  });

  it('fingerprints every valid correction independent of selected children', async () => {
    const f = fixture();
    const second = structuredClone(f.historical);
    second.event.id = 'a8efc2e0-c183-4b6b-bb3c-12040f7f7abc';
    second.event.fieldPath = 'stays[s2].arrival';
    second.event.value = '2027-04-01';
    second.event.evidence = { extractionId: second.extraction.id, paneSeq: 2, paneState: { 'stays[s2].arrival': '2027-04-01' } };
    f.candidates.push({ event: second.event, extractionId: second.extraction.id });
    const result = await withLockedCreateSource(f.db(), f.input, async (_tx, source) => source);
    expect(result.historicalEventIds).toEqual([f.historical.event.id, second.event.id].sort());
    expect(result.sourceDigest).toBe(createSourceSnapshotDigest({ source: f.source, extraction: f.extraction,
      attachments: f.attachments, historicalCorrections: [f.historical, second] }));
  });

  it('excludes events without matching full correction evidence', async () => {
    const f = fixture();
    f.candidates[0]!.event.evidence = { extractionId: f.historical.extraction.id, paneSeq: 1, paneState: {} };
    const result = await withLockedCreateSource(f.db(), f.input, async (_tx, source) => source);
    expect(result.historicalEventIds).toEqual([]);
    expect(result.sourceDigest).toBe(createSourceSnapshotDigest({ source: f.source, extraction: f.extraction,
      attachments: f.attachments, historicalCorrections: [] }));
  });

  it('refuses events referring to an extraction outside the earlier locked set', async () => {
    const f = fixture();
    f.extractions.pop();
    const continuation = vi.fn();
    await expect(withLockedCreateSource(f.db(), f.input, continuation)).rejects.toThrow('create_source_history_unlocked');
    expect(continuation).not.toHaveBeenCalled();
  });

  it('checks each item source and full cursor under its lock', async () => {
    for (const patch of [
      { id: 'other' }, { transportId: 'other' }, { threadId: 'other' }, { sourceMessageId: 'other' },
      { extractionId: 'other' }, { revision: 1 }, { revisionHead: 2 }, { revisionSeq: 3 }, { status: 'done' },
    ]) {
      const f = fixture(); Object.assign(f.item, patch);
      const continuation = vi.fn();
      await expect(withLockedCreateSource(f.db(), f.input, continuation)).rejects.toThrow('create_source_stale');
      expect(f.calls.at(-1)).toBe('item:update');
      expect(continuation).not.toHaveBeenCalled();
    }
  });

  it('refuses incomplete bounded source and history reads', async () => {
    for (const target of ['extractions', 'attachments', 'candidates'] as const) {
      const f = fixture();
      const rows = f[target] as unknown[];
      while (rows.length <= 512) rows.push(rows[0]);
      const continuation = vi.fn();
      await expect(withLockedCreateSource(f.db(), f.input, continuation)).rejects.toThrow('create_source_history_incomplete');
      expect(continuation).not.toHaveBeenCalled();
    }
  });

  it('binds source translation changes and refuses outbound or unready selected extraction', async () => {
    const f = fixture();
    const first = await withLockedCreateSource(f.db(), f.input, async (_tx, source) => source.sourceDigest);
    f.extraction.translation = { text: 'changed' };
    const second = await withLockedCreateSource(f.db(), f.input, async (_tx, source) => source.sourceDigest);
    expect(second).not.toBe(first);
    f.source.direction = 'outbound';
    await expect(withLockedCreateSource(f.db(), f.input, async () => null)).rejects.toThrow('create_source_mismatch');
    f.source.direction = 'inbound'; f.extraction.status = 'failed';
    await expect(withLockedCreateSource(f.db(), f.input, async () => null)).rejects.toThrow('create_source_mismatch');
  });
});
