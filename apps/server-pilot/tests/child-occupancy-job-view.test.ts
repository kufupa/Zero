import { describe, expect, it } from 'vitest';
import { HMS_JOB_PRIORITY_USER, queueAutoStaffQuoteHmsJob, readHmsBatchView, readHmsJobView } from '../src/ai/hms-jobs.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { HMS_JOB_PROMPT_VERSION, type AiWorkflowRun } from '../src/ai/run-ledger.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';

const transportId = 'transport-centurion';
const mail = { id: 'm1', transportId, threadId: 't1', direction: 'inbound',
  messageIdHeader: 'synthetic@example.invalid', subject: 'Synthetic quote',
  textBody: 'Please quote accommodation.', htmlBody: null };
const input = { messageId: mail.id, sourceHash: staffQuoteSourceHash(mail), selectionEpoch: 1, inputRevision: 1,
  groups: [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21',
    quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb' as const }],
  salesStrategy: 'BAR' as const, company: '', agency: '', attention: '', clientEmail: '', clientTelephone: '' };
const extraction = { id: 'extract-1', kind: 'quote', payload: {
  contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
  confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
    requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
    rows: [{ id: 'r1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }],
} };
const item = (state: Record<string, unknown> = {}, extractionId: string | null = extraction.id) =>
  ({ extractionId, state, sourceMessageId: mail.id });
function job(request: unknown = { kind: 'staff_quote', input }) {
  return { id: 'run-1', transportId, threadId: mail.threadId, triggerMessageId: mail.id,
    workItemId: 'item-1', runKind: 'read_tool', promptVersion: HMS_JOB_PROMPT_VERSION, priority: 10,
    state: 'succeeded', attempts: 1, failureClass: null, createdAt: new Date(),
    readRequest: request, readResult: { kind: 'staff_quote', status: 'ready', propertyCode: 'HRCEN', totalMinor: 10000, asOf: new Date().toISOString() },
    readResultExpiresAt: new Date(Date.now() + 60_000),
    metrics: { userId: 'user-1', batchId: 'batch-1', itemIndex: 0 },
  } as unknown as AiWorkflowRun;
}

/** Each select has an explicit reply so the test exercises the real view and evidence readers. */
function fakeDb(replies: Array<[unknown, unknown[]]>): DB {
  const remaining = [...replies];
  return { select() {
    let table: unknown;
    const read = () => {
      const next = remaining.shift();
      if (!next || next[0] !== table) throw new Error('unexpected synthetic DB read');
      return next[1];
    };
    const query = Object.assign(Promise.resolve().then(read), {
      from(value: unknown) { table = value; return query; },
      where() { return query; }, orderBy() { return query; },
      limit() { return query; },
    });
    return query;
  } } as unknown as DB;
}

const byId = { transportId, userId: 'user-1', staffQuoteOwnerId: 'user-1', runId: 'run-1', messageId: mail.id };
const byIdReplies = (saved = item()) => [
  [aiWorkflowRun, [job()]], [message, [mail]], [mailExtraction, [extraction]], [workItem, [saved]],
] as Array<[unknown, unknown[]]>;

describe('cached quote views use current selected occupancy', () => {
  it('returns a matching quote only while saved child evidence is complete', async () => {
    const current = await readHmsJobView(byId, fakeDb(byIdReplies()));
    expect(current?.result).toMatchObject({ status: 'ready', totalMinor: 10000 });
    const changed = await readHmsJobView(byId, fakeDb(byIdReplies(item({ 'stays[s1].rows[r1].childrenPerRoom': 1 }))));
    expect(changed).toMatchObject({ status: 'failed', result: { ok: false, code: 'child_occupancy_incomplete' } });
    expect(changed?.result).not.toHaveProperty('totalMinor');
  });

  it('holds a Centurion cached request that did not record the child count', async () => {
    const { childrenPerRoom: _count, ...legacyGroup } = input.groups[0]!;
    const legacy = job({ kind: 'staff_quote', input: { ...input, groups: [legacyGroup] } });
    const view = await readHmsJobView(byId, fakeDb([[aiWorkflowRun, [legacy]]]));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false, code: 'staff_quote_child_occupancy_incomplete' } });
  });

  it('does not release a price without selected-message context or after a cleared age', async () => {
    const noSelection = await readHmsJobView({ ...byId, messageId: undefined }, fakeDb([[aiWorkflowRun, [job()]]]));
    expect(noSelection).toMatchObject({ status: 'failed', result: { ok: false } });
    const cleared = await readHmsJobView(byId, fakeDb(byIdReplies(item({ 'stays[s1].rows[r1].childAges': null }))));
    expect(cleared).toMatchObject({ status: 'failed', result: { ok: false } });
  });

  it('holds a pinned old or missing extraction until the work item adopts the latest read', async () => {
    for (const pinnedId of ['old-extract', null]) {
      const stale = await readHmsJobView(byId, fakeDb(byIdReplies(item({}, pinnedId))));
      expect(stale).toMatchObject({ status: 'failed', result: { ok: false } });
    }
    const relinked = await readHmsJobView(byId, fakeDb(byIdReplies(item())));
    expect(relinked?.result).toMatchObject({ status: 'ready' });
  });

  it('refuses a cached price when the source email changed', async () => {
    const changed = { ...mail, textBody: 'The stay requirements changed.' };
    const view = await readHmsJobView(byId, fakeDb([[aiWorkflowRun, [job()]], [message, [changed]]]));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false } });
    expect(view?.result).not.toHaveProperty('totalMinor');
  });

  it('preserves one-row copy reuse only when both copies have matching saved occupancy', async () => {
    const copy = { ...mail, id: 'm2', threadId: 't2' };
    const copyExtraction = { ...extraction, id: 'extract-2', payload: { ...extraction.payload,
      stays: [{ ...extraction.payload.stays[0]!, id: 's2', rows: [{
        ...extraction.payload.stays[0]!.rows[0]!, id: 'r2',
      }] }],
    } };
    const copyItem = (state: Record<string, unknown>) => ({ extractionId: copyExtraction.id, state, sourceMessageId: copy.id });
    const replies = (state: Record<string, unknown>): Array<[unknown, unknown[]]> => [
      [aiWorkflowRun, [job()]], [message, [copy]], [message, [mail]], [message, [copy]],
      [message, [{ id: mail.id }, { id: copy.id }]],
      [mailExtraction, [extraction]], [workItem, [item()]], [mailExtraction, [copyExtraction]], [workItem, [copyItem(state)]],
    ];
    const selected = { ...byId, messageId: copy.id };
    expect((await readHmsJobView(selected, fakeDb(replies({}))))?.result).toMatchObject({ status: 'ready' });
    const stale = await readHmsJobView(selected, fakeDb(replies({ 'stays[s2].rows[r2].childrenPerRoom': 1 })));
    expect(stale).toMatchObject({ status: 'failed', result: { ok: false } });
  });

  it('checks by-input read-back against the selected saved row', async () => {
    const replies: Array<[unknown, unknown[]]> = [
      [message, [mail]], [message, [{ id: mail.id }]], [aiWorkflowRun, [job()]],
      [message, [mail]], [mailExtraction, [extraction]], [workItem, [item({ 'stays[s1].rows[r1].adults': 3 })]],
    ];
    const view = await readHmsJobView({ transportId, userId: 'user-1', messageId: mail.id, kind: 'staff_quote', input }, fakeDb(replies));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false } });
  });

  it('uses the batch work-item link and hides a stale quote price', async () => {
    const replies: Array<[unknown, unknown[]]> = [
      [aiWorkflowRun, [job()]], [workItem, [item()]], [message, [mail]], [mailExtraction, [extraction]],
      [workItem, [item({ 'stays[s1].rows[r1].count': 2 })]],
    ];
    const batch = await readHmsBatchView({ transportId, batchId: 'batch-1' }, fakeDb(replies));
    expect(batch).toMatchObject({ status: 'failed', items: [{ job: { status: 'failed', result: { ok: false } } }] });
    expect(batch?.items[0]?.job?.result).not.toHaveProperty('totalMinor');
  });

  it('keeps single and batch HRDAV quote views available without the Centurion evidence context', async () => {
    const davinci = { ...job(), transportId: 'transport-davinci' };
    davinci.readResult = { ...davinci.readResult, propertyCode: undefined };
    const view = await readHmsJobView({ ...byId, transportId: 'transport-davinci', messageId: undefined },
      fakeDb([[aiWorkflowRun, [davinci]]]));
    expect(view?.result).toMatchObject({ status: 'ready', totalMinor: 10000 });
    const batch = await readHmsBatchView({ transportId: 'transport-davinci', batchId: 'batch-1' },
      fakeDb([[aiWorkflowRun, [davinci]]]));
    expect(batch).toMatchObject({ status: 'done', items: [{ job: { result: { totalMinor: 10000 } } }] });
  });

  it('keeps an HRDAV quote available when the source is in a Centurion mailbox', async () => {
    const { childrenPerRoom: _count, ...legacyGroup } = input.groups[0]!;
    const davinci = job({ kind: 'staff_quote', input: { ...input, groups: [legacyGroup] } });
    davinci.readResult = { ...davinci.readResult, propertyCode: 'HRDAV' };
    const view = await readHmsJobView({ ...byId, messageId: undefined }, fakeDb([[aiWorkflowRun, [davinci]]]));
    expect(view?.result).toMatchObject({ status: 'ready', totalMinor: 10000 });
  });

  it('holds an actual Centurion result even if the earlier queued target was HRDAV', async () => {
    const { childrenPerRoom: _count, ...legacyGroup } = input.groups[0]!;
    const run = job({ kind: 'staff_quote', input: { ...input, groups: [legacyGroup] } });
    run.metrics = { ...run.metrics, propertyCode: 'HRDAV' };
    run.readResult = { ...run.readResult, propertyCode: 'HRCEN' };
    const view = await readHmsJobView(byId, fakeDb([[aiWorkflowRun, [run]]]));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false, code: 'staff_quote_child_occupancy_incomplete' } });
  });

  it('does not treat the queued target as the property that priced an older result', async () => {
    for (const queuedProperty of [undefined, 'HRDAV']) {
      const legacy = job();
      legacy.metrics = { ...legacy.metrics, propertyCode: queuedProperty };
      legacy.readResult = { ...legacy.readResult, propertyCode: undefined };
      const view = await readHmsJobView(byId, fakeDb([
        [aiWorkflowRun, [legacy]], [message, [mail]], [mailExtraction, [extraction]], [workItem, [item()]],
      ]));
      expect(view).toMatchObject({ status: 'failed', result: { ok: false, code: 'staff_quote_property_unverified' } });
      expect(view?.result).not.toHaveProperty('totalMinor');
    }
  });

  it('exposes a saved prepared revision\'s property without treating its queued target as evidence', async () => {
    const prepared = job();
    prepared.metrics = { ...prepared.metrics, propertyCode: 'HRCEN' };
    prepared.readResult = { ...prepared.readResult, propertyCode: undefined,
      preparedProposal: { revision: { propertyCode: 'HRDAV' } } };
    const view = await readHmsJobView({ ...byId, messageId: undefined }, fakeDb([[aiWorkflowRun, [prepared]]]));
    expect(view?.result).toMatchObject({ status: 'ready', propertyCode: 'HRDAV', totalMinor: 10000 });
  });

  it('holds a result whose own property conflicts with the saved prepared revision', async () => {
    const conflicting = job();
    conflicting.readResult = { ...conflicting.readResult, propertyCode: 'HRDAV',
      preparedProposal: { revision: { propertyCode: 'HRCEN' } } };
    const view = await readHmsJobView(byId, fakeDb([[aiWorkflowRun, [conflicting]]]));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false, code: 'staff_quote_property_unverified' } });
  });

  it('starts a fresh auto-quote instead of repeatedly reusing a price with an unknown property', async () => {
    const legacy = job();
    legacy.metrics = { ...legacy.metrics, propertyCode: 'HRCEN' };
    legacy.readResult = { ...legacy.readResult, propertyCode: undefined };
    const select = () => {
      const query = Object.assign(Promise.resolve([legacy]), {
        from() { return query; }, where() { return query; }, orderBy() { return query; },
      });
      return query;
    };
    let inserted: Record<string, unknown> | undefined;
    const fake = {
      select,
      execute: async () => undefined,
      insert: () => ({ values: (value: Record<string, unknown>) => {
        inserted = value;
        return { onConflictDoNothing: () => ({ returning: async () => [value] }) };
      } }),
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(fake),
    } as unknown as DB;
    const request = { transportId, threadId: mail.threadId,
      triggerMessageId: mail.id, workItemId: 'item-1', userId: 'user-1',
      request: { kind: 'staff_quote' as const, input }, priority: HMS_JOB_PRIORITY_USER };
    const queued = await queueAutoStaffQuoteHmsJob(request, fake);
    expect(queued.created).toBe(true);
    expect(queued.run.id).not.toBe(legacy.id);
    expect(inserted).toMatchObject({ state: 'queued', readRequest: { kind: 'staff_quote', input } });

    legacy.readResult = { ...legacy.readResult, propertyCode: 'HRCEN' };
    expect(await queueAutoStaffQuoteHmsJob(request, fake)).toMatchObject({ created: false, run: { id: legacy.id } });
    legacy.state = 'queued';
    legacy.readResult = null;
    expect(await queueAutoStaffQuoteHmsJob(request, fake)).toMatchObject({ created: false, run: { id: legacy.id } });
  });

  it('keeps a non-quote job view unchanged without quote context', async () => {
    const find = job({ kind: 'find', confirmation: '123-1' });
    find.readResult = { kind: 'find', result: 'synthetic' };
    const view = await readHmsJobView({ transportId, runId: 'run-1' }, fakeDb([[aiWorkflowRun, [find]]]));
    expect(view).toMatchObject({ status: 'done', result: { kind: 'find', result: 'synthetic' } });
  });
});
