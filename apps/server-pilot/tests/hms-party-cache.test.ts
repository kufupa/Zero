import {
  verifyPartyPick,
  panePartyLookupLoaders,
  resetPartyCacheForTests,
} from '../src/ai/pane-party-lookup.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { HMS_JOB_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { CENTURION_HMS_READ_TARGET, hmsReadTargetForProperty } from '../src/hms/hms-read-target.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DB } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';

const reachable = await probeTestDb();

afterEach(() => {
  panePartyLookupLoaders.enabled = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.spawn = null;
  resetPartyCacheForTests();
});

function partyJobDb(
  ...rows: Array<{ readRequest: Record<string, unknown>; readResult: Record<string, unknown> }>
): DB {
  const where = vi.fn((condition: SQL | undefined) => {
    const query = condition ? new PgDialect().sqlToQuery(condition) : { sql: '', params: [] };
    const hasCandidateFilter = query.sql.includes('jsonb_array_elements');
    const [kind, nativeId, requestedName] = hasCandidateFilter ? query.params.slice(-3) : [];
    const propertyCode = query.params.find((value) => ['HRCEN', 'HRDAV', 'HRDAVS'].includes(String(value)));
    const allowMissingProperty = query.sql.includes(" ? 'propertyCode'");
    expect(query.sql).toContain("->>'propertyCode'");
    expect(propertyCode).toBeDefined();
    const filtered =
      typeof kind === 'string' && typeof nativeId === 'string' && typeof requestedName === 'string'
        ? rows.filter(
            (row) =>
              (row.readResult.propertyCode === propertyCode ||
                (allowMissingProperty && !Object.hasOwn(row.readResult, 'propertyCode'))) &&
              Array.isArray(row.readResult.results) &&
              row.readResult.results.some((candidate) => {
                const result = candidate as Record<string, unknown>;
                return (
                  result.kind === kind &&
                  result.nativeId === nativeId &&
                  typeof result.name === 'string' &&
                  result.name.trim().replace(/\s+/g, ' ').toLowerCase() === requestedName
                );
              }),
          )
        : rows;
    const limit = vi.fn(async (count: number) => filtered.slice(0, count));
    const orderBy = vi.fn(() => ({ limit }));
    return { orderBy };
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as DB;
}

async function seedPartyJob(db: DB) {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `message-${randomUUID()}`;
  const runId = randomUUID();
  await db
    .insert(mailThread)
    .values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'agent@example.test',
    subject: 'Rate request',
    receivedAt: new Date(),
  });
  await db.insert(aiWorkflowRun).values({
    id: runId,
    transportId: TRANSPORT_ID,
    threadId,
    triggerMessageId: messageId,
    runKind: 'read_tool',
    idempotencyKey: `hms-job:party-test:${runId}`,
    modelId: 'not_applicable',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    readRequest: { kind: 'party', name: 'Acme', partyKind: 'company' },
    readResult: {
      kind: 'party',
      outcome: 'resolved',
      results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }],
      best: { kind: 'company', nativeId: '42', name: 'Acme Travel' },
      truncated: false,
      searchedFor: 'Acme Travel',
      asOf: new Date().toISOString(),
    },
    executorLane: 'hms',
    priority: 0,
    state: 'succeeded',
    finishedAt: new Date(),
  });
  return { threadId };
}

describe('party verification from a queued HMS result', () => {
  it('accepts a recent succeeded party job row without spawning another HMS search', async () => {
    resetPartyCacheForTests();
    const spawn = vi.fn();
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.spawn = spawn;
    const db = partyJobDb({
      readRequest: { kind: 'party', name: 'Acme Travel', partyKind: 'company' },
      readResult: { results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }] },
    });

    await expect(
      verifyPartyPick(
        { transportId: TRANSPORT_ID, target: CENTURION_HMS_READ_TARGET, kind: 'organization', nativeId: '42', name: '  ACME   Travel ' },
        db,
      ),
    ).resolves.toEqual({
      ok: true,
      party: { kind: 'organization', nativeId: '42', name: 'Acme Travel' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('matches the returned HMS row name when the original search term was shorter', async () => {
    resetPartyCacheForTests();
    const spawn = vi.fn();
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.spawn = spawn;
    const db = partyJobDb({
      readRequest: { kind: 'party', name: 'Acme', partyKind: 'company' },
      readResult: { results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }] },
    });

    await expect(
      verifyPartyPick(
        { transportId: TRANSPORT_ID, target: CENTURION_HMS_READ_TARGET, kind: 'organization', nativeId: '42', name: 'Acme Travel' },
        db,
      ),
    ).resolves.toEqual({
      ok: true,
      party: { kind: 'organization', nativeId: '42', name: 'Acme Travel' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('checks older snapshots within the TTL when newer searches have the same name', async () => {
    resetPartyCacheForTests();
    const spawn = vi.fn();
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.spawn = spawn;
    const newerRows = Array.from({ length: 10 }, (_, index) => ({
      readRequest: { kind: 'party', name: 'Acme Travel', partyKind: 'company' },
      readResult: { results: [{ kind: 'company', nativeId: `new-${index}`, name: 'Acme Travel' }] },
    }));
    const targetRow = {
      readRequest: { kind: 'party', name: 'Acme Travel', partyKind: 'company' },
      readResult: { results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }] },
    };
    const db = partyJobDb(...newerRows, targetRow);

    await expect(
      verifyPartyPick(
        { transportId: TRANSPORT_ID, target: CENTURION_HMS_READ_TARGET, kind: 'organization', nativeId: '42', name: 'Acme Travel' },
        db,
      ),
    ).resolves.toEqual({
      ok: true,
      party: { kind: 'organization', nativeId: '42', name: 'Acme Travel' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['HRDAV', 'HRDAVS'])('accepts only the matching %s property snapshot on the shared mailbox', async (propertyCode) => {
    const target = hmsReadTargetForProperty(propertyCode);
    const otherProperty = propertyCode === 'HRDAV' ? 'HRDAVS' : 'HRDAV';
    const spawn = vi.fn();
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.spawn = spawn;
    const row = (property: string) => ({
      readRequest: { kind: 'party', partyKind: 'company' },
      readResult: { propertyCode: property, results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }] },
    });
    const db = partyJobDb(row(otherProperty), row(propertyCode));
    await expect(verifyPartyPick({ transportId: 'transport-faith', target, kind: 'organization', nativeId: '42', name: 'Acme Travel' }, db))
      .resolves.toEqual({ ok: true, party: { kind: 'organization', nativeId: '42', name: 'Acme Travel' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['HRDAV', 'HRDAVS'],
    ['HRDAVS', 'HRDAV'],
    ['HRDAV', undefined],
    ['HRDAVS', undefined],
    ['HRCEN', null],
  ] as const)('does a live lookup for target %s when the snapshot property is %s', async (propertyCode, rowProperty) => {
    const target = hmsReadTargetForProperty(propertyCode);
    const transportId = propertyCode === 'HRCEN' ? TRANSPORT_ID : 'transport-faith';
    const spawn = vi.fn(async () => ({ outcome: 'no_match', candidates: [], truncated: false }));
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.lock = { withLock: async (run) => run() };
    panePartyLookupLoaders.spawn = spawn;
    const db = partyJobDb({
      readRequest: { kind: 'party', partyKind: 'company' },
      readResult: { ...(rowProperty !== undefined ? { propertyCode: rowProperty } : {}),
        results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }] },
    });
    await expect(verifyPartyPick({ transportId, target, kind: 'organization', nativeId: '42', name: 'Acme Travel' }, db))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ target, transportId }));
  });

  it('rechecks the returned property even if a database row bypasses the SQL predicate', async () => {
    const target = hmsReadTargetForProperty('HRDAVS');
    const spawn = vi.fn(async () => ({ outcome: 'no_match', candidates: [], truncated: false }));
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.lock = { withLock: async (run) => run() };
    panePartyLookupLoaders.spawn = spawn;
    const row = { readRequest: { kind: 'party', partyKind: 'company' }, readResult: {
      propertyCode: 'HRDAV', results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }],
    } };
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [row] }) }) }) }) } as unknown as DB;
    await expect(verifyPartyPick({ transportId: 'transport-faith', target, kind: 'organization', nativeId: '42', name: 'Acme Travel' }, db))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not accept a legacy snapshot without an explicit target or from another transport', async () => {
    const spawn = vi.fn(async () => ({ outcome: 'no_match', candidates: [], truncated: false }));
    panePartyLookupLoaders.enabled = () => true;
    panePartyLookupLoaders.lock = { withLock: async (run) => run() };
    panePartyLookupLoaders.spawn = spawn;
    const db = partyJobDb({ readRequest: { kind: 'party', partyKind: 'company' }, readResult: {
      results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }],
    } });
    await expect(verifyPartyPick({ transportId: TRANSPORT_ID, kind: 'organization', nativeId: '42', name: 'Acme Travel' }, db))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(verifyPartyPick({ transportId: 'transport-faith', target: CENTURION_HMS_READ_TARGET,
      kind: 'organization', nativeId: '42', name: 'Acme Travel' }, db))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'party verification from a queued HMS result (lane DB)',
  () => {
    it('matches the returned HMS row when the original search term was shorter', () =>
      withSeededTestDb(async (db) => {
        await seedPartyJob(db);
        const spawn = vi.fn();
        panePartyLookupLoaders.enabled = () => true;
        panePartyLookupLoaders.spawn = spawn;

        await expect(
          verifyPartyPick(
            {
              transportId: TRANSPORT_ID,
              target: CENTURION_HMS_READ_TARGET,
              kind: 'organization',
              nativeId: '42',
              name: '  ACME   Travel ',
            },
            db,
          ),
        ).resolves.toEqual({
          ok: true,
          party: { kind: 'organization', nativeId: '42', name: 'Acme Travel' },
        });
        expect(spawn).not.toHaveBeenCalled();
      }));

    it('does not remember a party result from another mailbox transport', () =>
      withSeededTestDb(async (db) => {
        await seedPartyJob(db);
        const spawn = vi.fn(async () => ({
          outcome: 'no_match',
          candidates: [],
          truncated: false,
        }));
        panePartyLookupLoaders.enabled = () => true;
        panePartyLookupLoaders.lock = { withLock: async (run) => run() } as never;
        panePartyLookupLoaders.spawn = spawn;

        await expect(
          verifyPartyPick(
            {
              transportId: 'another-transport',
              target: CENTURION_HMS_READ_TARGET,
              kind: 'organization',
              nativeId: '42',
              name: 'Acme Travel',
            },
            db,
          ),
        ).resolves.toMatchObject({ ok: false, reason: 'not_found' });
        expect(spawn).toHaveBeenCalledTimes(1);
      }));
  },
);
