import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmsMailReadIdempotencyKey, readHmsJobView } from '../src/ai/hms-jobs.js';
import { staffQuoteInput, staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { captureQuoteSourceProof } from '../src/ai/child-occupancy.js';
import { HMS_JOB_PROMPT_VERSION, type AiWorkflowRun } from '../src/ai/run-ledger.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { quoteSourcePartyDigest } from '../src/ai/quote-source-party.js';
import { quoteDigest } from '../src/quote-proposal/quote-revision.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';

vi.mock('../src/ai/workflow-classifier/source-fence.js', async (original) => ({
  ...await original<typeof import('../src/ai/workflow-classifier/source-fence.js')>(),
  captureCurrentWitnessedRead: async (_db: unknown, _scope: unknown, id: string) => id === extraction.id ? {
    read: { id, usage: {} }, source: { digest: 'f'.repeat(64) },
    extractionDigest: quoteDigest({ id, kind: extraction.kind, payload: extraction.payload }),
  } : null,
  withQuoteSourceSnapshot: async (db: DB, read: (tx: DB) => Promise<unknown>) => read(db),
}));

const mail = { id: 'm1', transportId: 'transport-centurion', threadId: 't1', direction: 'inbound',
  messageIdHeader: null, subject: 'Synthetic quote', textBody: 'Please quote accommodation.', htmlBody: null };
const base = staffQuoteInput.parse({ messageId: mail.id, sourceHash: staffQuoteSourceHash(mail), selectionEpoch: 1, inputRevision: 1,
  sourcePartyDigest: quoteSourcePartyDigest({ agency: null, endClient: null }, {}), sourceExtractionId: 'extract-1',
  groups: [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
    adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb', sourcePreference: { roomType: null, board: null } }],
  salesStrategy: 'BAR', parties: { agency: { kind: 'agency', nativeId: '42', name: 'Example Agency' } } });
const extraction = { id: 'extract-1', kind: 'quote', payload: {
  contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
  confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
    requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
    rows: [{ id: 'r1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }],
} };
const item = { extractionId: extraction.id, state: {}, sourceMessageId: mail.id };
async function prepared(id: string, input: typeof base, transportId = mail.transportId): Promise<AiWorkflowRun> {
  const quoteSourceProof = await captureQuoteSourceProof(fakeDb([[mailExtraction, [extraction]], [workItem, [item]]]), input,
    { transportId, threadId: mail.threadId, messageId: mail.id });
  return { id, transportId, threadId: mail.threadId, triggerMessageId: mail.id,
    runKind: 'read_tool', promptVersion: HMS_JOB_PROMPT_VERSION, priority: 0,
    state: 'succeeded', attempts: 1, failureClass: null, createdAt: new Date(Date.now() - 1000),
    readRequest: { kind: 'staff_quote', input },
    readResult: { status: 'ready', totalMinor: 10000, quoteSourceProof,
      propertyCode: transportId === mail.transportId ? 'HRCEN' : 'HRDAV', asOf: new Date(Date.now() - 1000).toISOString(),
      rateOptions: [{ selected: true, contract: input.salesStrategy === 'WS' }] },
    readResultExpiresAt: new Date(Date.now() + 60_000), metrics: { userId: null, quotePrepared: true,
      ...(transportId === mail.transportId ? { quoteSourcePolicyVersion: 5 } : {}) },
  } as unknown as AiWorkflowRun;
}
function fakeDb(replies: Array<[unknown, unknown[]]>): DB {
  const remaining = [...replies];
  return { select(selection?: Record<string, unknown>) {
    let table: unknown;
    const read = () => {
      if (selection && 'workItemId' in selection && 'kind' in selection && 'status' in selection) return [];
      if (selection && Object.keys(selection).length === 1 && 'id' in selection &&
        (table === workItem || table === mailExtraction)) return [];
      const next = remaining.shift();
      if (!next || next[0] !== table) throw new Error('unexpected synthetic DB read');
      return next[1];
    };
    const query = Object.assign(Promise.resolve().then(read), {
      from(value: unknown) { table = value; return query; },
      where() { return query; }, orderBy() { return query; }, for() { return query; }, limit() { return query; },
    });
    return query;
  } } as unknown as DB;
}
beforeEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
    selectedFound: true, selected: { toAddresses: ['centurion@legacyhotels.co.za'] }, inbounds: [],
  });
});
afterEach(() => { mailboxHmsOriginBindLoaders.loadThreadOriginScan = null; vi.unstubAllEnvs(); });

describe('prepared quote strategy on the selected property', () => {
  it.each(['BAR', 'Government'] as const)('returns the requested %s price over the same-party WS contract', async (strategy) => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const selected = { ...base, salesStrategy: strategy };
    const wrong = await prepared('ws', { ...base, salesStrategy: 'WS' });
    const right = await prepared('selected', selected);
    const replies: Array<[unknown, unknown[]]> = [[message, [mail]], [aiWorkflowRun, [wrong, right]],
      [aiDraftGeneration, []], [mailExtraction, [extraction]], [workItem, [item]],
      [message, [mail]], [mailExtraction, [extraction]], [workItem, [item]],
      [mailExtraction, [extraction]], [workItem, [item]]];
    const view = await readHmsJobView({ transportId: mail.transportId, userId: 'u1', messageId: mail.id,
      kind: 'staff_quote', input: selected }, fakeDb(replies));
    expect(view).toMatchObject({ runId: 'selected', result: { status: 'ready', totalMinor: 10000 } });
  });

  it('does not return a different strategy when it is the only prepared Centurion price', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const wrong = await prepared('ws', { ...base, salesStrategy: 'WS' });
    const view = await readHmsJobView({ transportId: mail.transportId, userId: 'u1', messageId: mail.id,
      kind: 'staff_quote', input: base }, fakeDb([[message, [mail]], [aiWorkflowRun, [wrong]]]));
    expect(view).toBeNull();
  });

  it('preserves the previous party-contract preference for an HRDAV mailbox', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const transportId = 'transport-faith';
    const { sourcePreference: _sourcePreference, ...oldGroup } = base.groups[0]!;
    const wrong = await prepared('ws', { ...base, groups: [oldGroup], salesStrategy: 'WS' }, transportId);
    const right = await prepared('bar', base, transportId);
    const view = await readHmsJobView({ transportId, userId: 'u1', messageId: mail.id, kind: 'staff_quote', input: base },
      fakeDb([[message, [mail]], [aiWorkflowRun, [right, wrong]], [aiDraftGeneration, []]]));
    expect(view?.runId).toBe('ws');
  });

  it('keeps HRDAV mail deduplication stable while binding Centurion to the source preference', () => {
    const { sourcePreference: _sourcePreference, ...oldGroup } = base.groups[0]!;
    const oldRequest = { kind: 'staff_quote' as const, input: { ...base, groups: [oldGroup] } };
    const currentRequest = { kind: 'staff_quote' as const, input: base };
    const key = (property: string, request: typeof oldRequest) => hmsMailReadIdempotencyKey(
      property, 'synthetic@example.invalid', request, new Date('2027-01-01T00:00:00Z'), 'retry', 't1');
    expect(key('HRDAV', oldRequest)).toBe(key('HRDAV', currentRequest));
    expect(key('HRCEN', oldRequest)).not.toBe(key('HRCEN', currentRequest));
  });
});
