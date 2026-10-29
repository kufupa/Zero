import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { appRouter } from '../src/trpc/router.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const transportId = 'transport-centurion';
const userId = 'user-1';
const itemId = '00000000-0000-4000-8000-000000000001';
const rowPath = 'stays[s_test].rows[g1]';

function caller() {
  return appRouter.createCaller({
    auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: userId, email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: transportId, accessRole: 'owner', transportEmail: 'centurion@legacyhotels.co.za',
  } as never);
}

async function fixture() {
  const now = new Date(Date.now() - 1000).toISOString();
  const revision = await syntheticRevision(['600.00'], 'Room Only R', 'SKNG', now, '2027-10-20', 'auth-1');
  const mail = { id: 'm1', transportId, threadId: 't1', direction: 'inbound',
    subject: 'Synthetic quote', textBody: 'Please quote accommodation.', htmlBody: null,
    fromAddress: 'guest@example.invalid' };
  const staff = {
    version: 1, kind: 'staff_approved_quote', transportId, userId, threadId: 't1', messageId: 'm1',
    sourceHash: staffQuoteSourceHash(mail), inputDigest: 'digest', authorizationId: revision.authorizationId,
    revisionIds: [revision.id], header: { company: '', agency: '' },
  };
  const run = { id: 'run-1', transportId, threadId: 't1', triggerMessageId: 'm1',
    generationId: 'generation-1', state: 'succeeded', priority: 10, createdAt: new Date(),
    metrics: { staffQuoteAttestation: staff, reservationistResult: {
      version: 1, readiness: 'ready_for_staff_review', quoteRevisionIds: [revision.id],
      quoteRevisions: [revision], proposalFacts: [],
    } }, readResult: null };
  const payload = {
    contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{
      id: 's_test', hotel: null, requested: { arrival: '2027-10-20', departure: '2027-10-21' },
      booked: null, totalRooms: 2, rows: [{ id: 'g1', roomType: null, rooms: 2, adultsPerRoom: 1,
        childrenPerRoom: 0, childAges: [], board: null }],
    }],
  };
  const state: Record<string, unknown> = {};
  const proposal = { workflowRunId: run.id, revisionRef: revision.id, messageId: mail.id,
    outlookEmail: 'centurion@legacyhotels.co.za', factRefs: [], company: '', agency: '', workItemId: itemId };
  const artifact = { kind: 'quote_pdf', revisionId: revision.id, pdfHash: 'a'.repeat(64),
    fileName: 'synthetic.pdf', totalMinor: revision.totalMinor, pdfBase64: 'JVBERi0xLjQ=' };
  const job = { id: 'pdf-job', state: 'succeeded', triggerMessageId: mail.id, readResult: artifact,
    readRequest: { kind: 'quote_pdf', workItemId: itemId, revisionId: revision.id,
      propertyCode: 'HRCEN', transportId, userId, proposal } };
  const db = {
    select(selection?: Record<string, unknown>) {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        limit() {
          if (table === message) return Promise.resolve([mail]);
          if (table === mailExtraction) return Promise.resolve([{ id: 'extract-1', kind: 'quote', payload }]);
          if (table === workItem) return Promise.resolve([{ extractionId: 'extract-1', state }]);
          if (table === aiDraftGeneration) return Promise.resolve([{ id: 'generation-1', createdAt: new Date() }]);
          if (table === aiWorkflowRun && selection && 'run' in selection) return Promise.resolve([{ run }]);
          if (table === aiWorkflowRun && selection && 'request' in selection)
            return Promise.resolve([{ request: job.readRequest, messageId: mail.id }]);
          if (table === aiWorkflowRun) return Promise.resolve([job]);
          return Promise.resolve([]);
        },
      };
      return query;
    },
  } as unknown as DB;
  __setDbForTests({ db, conn: null as never });
  return { revision, proposal, state, artifact };
}

afterEach(() => { __setDbForTests(null); vi.unstubAllEnvs(); });

describe('stored quote export and draft occupancy', () => {
  it('refuses PDF and workbook after a saved child age is cleared', async () => {
    const { proposal, state } = await fixture();
    const api = caller().workstation;
    const { workItemId: _item, ...uncached } = proposal;
    vi.stubEnv('GOTENBERG_URL', '');
    // Complete occupancy reaches rendering; no converter is contacted.
    await expect(api.qualifiedQuoteProposalPdf(uncached)).rejects.toThrow('GOTENBERG_URL missing');
    state[`${rowPath}.childAges`] = null;
    await expect(api.qualifiedQuoteProposalPdf(uncached)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: expect.stringContaining('children per room'),
    });
    await expect(api.quoteWorkbook(uncached)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: expect.stringContaining('children per room'),
    });
  });

  it('does not return a cached PDF after child occupancy changes', async () => {
    const { revision, state, artifact } = await fixture();
    const api = caller().workstation;
    const input = { workItemId: itemId, revisionRef: revision.id, company: '', agency: '' };
    expect((await api.quotePdfJob(input))?.result).toEqual(artifact);
    state[`${rowPath}.childrenPerRoom`] = 1;
    await expect(api.quotePdfJob(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: expect.stringContaining('children per room'),
    });
  });

  it('does not return a cached PDF after the saved room or adult count changes', async () => {
    const { revision, state } = await fixture();
    const api = caller().workstation;
    const input = { workItemId: itemId, revisionRef: revision.id, company: '', agency: '' };
    state[`${rowPath}.count`] = 3;
    await expect(api.quotePdfJob(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    state[`${rowPath}.count`] = 2;
    state[`${rowPath}.adults`] = 2;
    await expect(api.quotePdfJob(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('hides stored priced choices after the saved occupancy changes', async () => {
    const { state } = await fixture();
    const api = caller().workstation;
    const input = { internetMessageId: '<synthetic@example.invalid>' };
    expect((await api.qualifiedProposalChoices(input)).choices).toHaveLength(1);
    state[`${rowPath}.childrenPerRoom`] = 1;
    expect((await api.qualifiedProposalChoices(input)).choices).toHaveLength(0);
  });

  it('refuses a booking draft from a quote when the saved count changed', async () => {
    const { proposal, state } = await fixture();
    state[`${rowPath}.childrenPerRoom`] = 1;
    const result = await caller().workstation.prepareBookingDraft({
      workflowRunId: proposal.workflowRunId, revisionRef: proposal.revisionRef, messageId: proposal.messageId,
      selectionEpoch: 1, inputRevision: 1, analysis: {
        workflow: 'create_booking', flags: [], groups: [{ arrival: '2027-10-20', departure: '2027-10-21',
          rooms: 2, adultsPerRoom: 1, childAges: [], board: 'room_only', roomPreference: null, guestNames: [] }],
        party: { kind: null, name: null, reference: null }, rateClaims: [], missing: [], evidence: [], tasks: [],
      },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'child_occupancy_incomplete' });
  });
});
