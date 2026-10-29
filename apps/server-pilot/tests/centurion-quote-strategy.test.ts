import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHmsJobView } from '../src/ai/hms-jobs.js';
import { staffQuoteInput, staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { HMS_JOB_PROMPT_VERSION, type AiWorkflowRun } from '../src/ai/run-ledger.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';

const mail = { id: 'm1', transportId: 'transport-centurion', threadId: 't1', direction: 'inbound',
  messageIdHeader: null, subject: 'Synthetic quote', textBody: 'Please quote accommodation.', htmlBody: null };
const base = staffQuoteInput.parse({ messageId: mail.id, sourceHash: staffQuoteSourceHash(mail), selectionEpoch: 1, inputRevision: 1,
  groups: [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
    adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb' }],
  salesStrategy: 'BAR', parties: { agency: { kind: 'agency', nativeId: '42', name: 'Example Agency' } } });
const extraction = { id: 'extract-1', kind: 'quote', payload: {
  contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
  confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
    requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
    rows: [{ id: 'r1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }],
} };
const item = { extractionId: extraction.id, state: {}, sourceMessageId: mail.id };
function prepared(id: string, input: typeof base, transportId = mail.transportId): AiWorkflowRun {
  return { id, transportId, threadId: mail.threadId, triggerMessageId: mail.id,
    runKind: 'read_tool', promptVersion: HMS_JOB_PROMPT_VERSION, priority: 0,
    state: 'succeeded', attempts: 1, failureClass: null, createdAt: new Date(Date.now() - 1000),
    readRequest: { kind: 'staff_quote', input },
    readResult: { status: 'ready', totalMinor: 10000, asOf: new Date(Date.now() - 1000).toISOString(),
      rateOptions: [{ selected: true, contract: input.salesStrategy === 'WS' }] },
    readResultExpiresAt: new Date(Date.now() + 60_000), metrics: { userId: null, quotePrepared: true },
  } as unknown as AiWorkflowRun;
}
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
      where() { return query; }, orderBy() { return query; }, limit() { return query; },
    });
    return query;
  } } as unknown as DB;
}
afterEach(() => vi.unstubAllEnvs());

describe('prepared quote strategy on the selected property', () => {
  it.each(['BAR', 'Government'] as const)('returns the requested %s price over the same-party WS contract', async (strategy) => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const selected = { ...base, salesStrategy: strategy };
    const wrong = prepared('ws', { ...base, salesStrategy: 'WS' });
    const right = prepared('selected', selected);
    const replies: Array<[unknown, unknown[]]> = [[message, [mail]], [aiWorkflowRun, [wrong, right]],
      [aiDraftGeneration, []], [message, [mail]], [mailExtraction, [extraction]], [workItem, [item]],
      [mailExtraction, [extraction]], [workItem, [item]]];
    const view = await readHmsJobView({ transportId: mail.transportId, userId: 'u1', messageId: mail.id,
      kind: 'staff_quote', input: selected }, fakeDb(replies));
    expect(view).toMatchObject({ runId: 'selected', result: { status: 'ready', totalMinor: 10000 } });
  });

  it('does not return a different strategy when it is the only prepared Centurion price', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const view = await readHmsJobView({ transportId: mail.transportId, userId: 'u1', messageId: mail.id,
      kind: 'staff_quote', input: base }, fakeDb([[message, [mail]], [aiWorkflowRun, [prepared('ws', { ...base, salesStrategy: 'WS' })]]]));
    expect(view).toBeNull();
  });

  it('preserves the previous party-contract preference for an HRDAV mailbox', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const transportId = 'transport-faith';
    const wrong = prepared('ws', { ...base, salesStrategy: 'WS' }, transportId);
    const right = prepared('bar', base, transportId);
    const view = await readHmsJobView({ transportId, userId: 'u1', messageId: mail.id, kind: 'staff_quote', input: base },
      fakeDb([[message, [mail]], [aiWorkflowRun, [right, wrong]], [aiDraftGeneration, []]]));
    expect(view?.runId).toBe('ws');
  });
});
