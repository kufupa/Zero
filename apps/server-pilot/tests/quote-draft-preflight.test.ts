import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, mailDraft, mailDraftRevision, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { captureQuoteSourceProof } from '../src/ai/child-occupancy.js';
import { staffQuoteInput, staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { quotePdfJobIdentity } from '../src/ai/quote-pdf-jobs.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';
import { appRouter } from '../src/trpc/router.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const transportId = 'transport-centurion', userId = 'user-1', itemId = '00000000-0000-4000-8000-000000000001';
const pdf = Buffer.from('%PDF-1.4');
const hash = createHash('sha256').update(pdf).digest('hex');
const caller = (activeTransportId = transportId) => appRouter.createCaller({
  auth: null as never, reqHeaders: new Headers(), sessionUser: { id: userId, email: 'staff@example.invalid', name: 'Staff' },
  activeTransportId, accessRole: 'owner', transportEmail: 'centurion@legacyhotels.co.za',
} as never);

async function fixture() {
  const revision = await syntheticRevision(['600.00'], 'Room Only R', 'SKNG', new Date(Date.now() - 1000).toISOString(),
    '2027-10-20', 'auth-1', { id: 'g1', quantity: 1, adults: 2, children: 0, childAges: [] }, 'HRCEN');
  const mail = { id: 'm1', transportId, threadId: 't1', direction: 'inbound',
    subject: 'Synthetic quote', textBody: 'Please quote accommodation.', htmlBody: null };
  const staff = { version: 1, kind: 'staff_approved_quote', transportId, userId, threadId: 't1', messageId: 'm1',
    sourceHash: staffQuoteSourceHash(mail), inputDigest: 'digest', authorizationId: revision.authorizationId,
    revisionIds: [revision.id], header: { company: '', agency: '' } };
  const run = { id: 'run-1', transportId, threadId: 't1', triggerMessageId: 'm1', generationId: 'generation-1',
    state: 'succeeded', priority: 10, createdAt: new Date(), metrics: { staffQuoteAttestation: staff,
      reservationistResult: { version: 1, readiness: 'ready_for_staff_review', quoteRevisionIds: [revision.id],
        quoteRevisions: [revision], proposalFacts: [] } }, readResult: null };
  const proposal = { workflowRunId: run.id, revisionRef: revision.id, messageId: mail.id,
    outlookEmail: 'centurion@legacyhotels.co.za', factRefs: [], company: '', agency: '', workItemId: itemId };
  const artifact = { kind: 'quote_pdf', revisionId: revision.id, pdfHash: hash,
    fileName: 'synthetic.pdf', totalMinor: revision.totalMinor, pdfBase64: pdf.toString('base64') };
  const job = { id: 'pdf-1', transportId, threadId: 't1', triggerMessageId: 'm1', workItemId: itemId,
    state: 'succeeded', readResult: artifact, readRequest: { kind: 'quote_pdf', workItemId: itemId,
      revisionId: quotePdfJobIdentity(proposal), propertyCode: 'HRCEN', transportId, userId, proposal } };
  const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
      requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
      rows: [{ id: 'g1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }] };
  const state: Record<string, unknown> = {};
  const jobAvailable = { value: true };
  const savedReply = { savedId: 'saved-reply:other:1', latestId: 'saved-reply:other:1',
    savedHtml: '<p>Synthetic</p>', savedAttachments: [] as unknown[] };
  let savedReplyRevisionReads = 0;
  const transaction = vi.fn(async () => { throw new Error('synthetic transaction reached'); });
  const db = { transaction, select(selection?: Record<string, unknown>) {
    let table: unknown;
    const query = { from(value: unknown) { table = value; return query; }, innerJoin() { return query; },
      where() { return query; }, orderBy() { return query; }, limit() {
        if (table === mailThread) return Promise.resolve([{ id: 't1', transportId }]);
        if (table === mailDraft) return Promise.resolve([{ id: 'draft-1', htmlBody: '<p>Synthetic</p>', attachments: [] }]);
        if (table === mailDraftRevision) return Promise.resolve([savedReplyRevisionReads++ % 2 === 0
          ? { id: savedReply.savedId, htmlBody: savedReply.savedHtml, attachments: savedReply.savedAttachments }
          : { id: savedReply.latestId }]);
        if (table === message) return Promise.resolve([mail]);
        if (table === mailExtraction) return Promise.resolve([{ id: 'extract-1', kind: 'quote', payload }]);
        if (table === workItem) return Promise.resolve([{ id: itemId, extractionId: 'extract-1', state }]);
        if (table === aiDraftGeneration) return Promise.resolve([{ id: 'generation-1', createdAt: new Date() }]);
        if (table === aiWorkflowRun && selection && 'run' in selection) return Promise.resolve([{ run }]);
        if (table === aiWorkflowRun) return Promise.resolve(jobAvailable.value ? [job] : []);
        return Promise.resolve([]);
      } };
    return query;
  } } as unknown as DB;
  const quoteInput = staffQuoteInput.parse({ messageId: mail.id, sourceHash: staffQuoteSourceHash(mail),
    selectionEpoch: 1, inputRevision: 1, salesStrategy: 'BAR', groups: [{ id: 'g1', arrivalDate: '2027-10-20',
      departureDate: '2027-10-21', quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'room_only',
      sourcePreference: { roomType: null, board: null } }] });
  const proof = await captureQuoteSourceProof(db, quoteInput, { transportId, threadId: 't1', messageId: 'm1' });
  Object.assign(staff, { quoteSourceProof: proof });
  __setDbForTests({ db, conn: null as never });
  return { revision, job, state, mail, transaction, savedReply, jobAvailable, proposal };
}

beforeEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({ selectedFound: true, selected: {}, inbounds: [] });
});
afterEach(() => { mailboxHmsOriginBindLoaders.loadThreadOriginScan = null; __setDbForTests(null); });

describe('priced draft preflight', () => {
  it('can use the selected email work item for a durable PDF when the pane did not supply its id', async () => {
    const { proposal, state } = await fixture();
    const { workItemId: _workItemId, ...input } = proposal;
    await expect(caller().workstation.qualifiedQuoteProposalPdf(input)).resolves.toMatchObject({ pdfBase64: pdf.toString('base64') });
    state['stays[s1].rows[g1].board'] = 'bb';
    await expect(caller().workstation.qualifiedQuoteProposalPdf(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('checks the recorded PDF bytes, selected source, revisions and current saved facts', async () => {
    const { revision, state, job, jobAvailable } = await fixture();
    const refs = [{ workflowRunId: 'run-1', revisionRef: revision.id }];
    const input = { messageId: 'm1', threadId: 't1', pdfHashes: [hash], preparedVersions: refs };
    await expect(caller().workstation.quoteDraftPreflight(input)).resolves.toEqual({ ready: true });
    await expect(caller().workstation.quoteDraftPreflight({ ...input, pdfHashes: [] }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller().workstation.quoteDraftPreflight({ ...input, preparedVersions: [{ ...refs[0]!, revisionRef: 'other' }] }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    state['stays[s1].rows[g1].roomType'] = 'Standard Twin';
    await expect(caller().workstation.quoteDraftPreflight(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    delete state['stays[s1].rows[g1].roomType'];
    job.readResult.pdfBase64 = Buffer.from('%PDF-wrong').toString('base64');
    await expect(caller().workstation.quoteDraftPreflight(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    job.readResult.pdfBase64 = pdf.toString('base64');
    jobAvailable.value = false;
    await expect(caller().workstation.quoteDraftPreflight(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses stale webmail quote saves before creating or replacing a draft', async () => {
    const { revision, state, transaction } = await fixture();
    state['stays[s1].rows[g1].childrenPerRoom'] = 1;
    const base = { threadId: 't1', replyToMessageId: 'm1', html: '<p>Synthetic</p>',
      attachments: [{ name: 'quote.pdf', type: 'application/pdf', size: pdf.length,
        lastModified: 1, base64: pdf.toString('base64') }] };
    await expect(caller().drafts.saveReply({ ...base, replyKind: 'quote',
      preparedVersions: [{ workflowRunId: 'run-1', revisionRef: revision.id }] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
    await expect(caller().drafts.saveReply({ ...base, replyKind: 'other', preparedVersions: [] }))
      .rejects.toThrow('synthetic transaction reached');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('does not impose the Centurion proof on an HRDAV mailbox', async () => {
    const { revision } = await fixture();
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight({ messageId: 'm1', threadId: 't1',
      pdfHashes: [hash], preparedVersions: [{ workflowRunId: 'run-1', revisionRef: revision.id }] }))
      .resolves.toEqual({ ready: true });
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight({ messageId: 'm1', threadId: 't1',
      pdfHashes: [] })).resolves.toEqual({ ready: true });
  });

  it('keeps an edited saved quote guarded and trusts a non-quote classification only while current', async () => {
    const { savedReply } = await fixture();
    const read = () => caller().drafts.savedReply({ threadId: 't1' });
    await expect(read()).resolves.toMatchObject({ quoteBound: false });
    savedReply.savedHtml = '<p>A later replacement</p>';
    expect(await read()).not.toHaveProperty('quoteBound');
    savedReply.savedHtml = '<p>Synthetic</p>';
    savedReply.savedAttachments = [{ filename: 'different.pdf' }];
    expect(await read()).not.toHaveProperty('quoteBound');
    savedReply.savedAttachments = [];
    savedReply.latestId = 'composer-edit-1';
    expect(await read()).not.toHaveProperty('quoteBound');
    savedReply.savedId = savedReply.latestId = 'saved-reply:quote:2';
    await expect(read()).resolves.toMatchObject({ quoteBound: true });
    savedReply.latestId = 'composer-edit-2';
    await expect(read()).resolves.toMatchObject({ quoteBound: true });
  });
});
