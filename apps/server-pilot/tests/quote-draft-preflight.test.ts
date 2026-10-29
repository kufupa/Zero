import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, mailDraft, mailDraftRevision, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { captureQuoteSourceProof } from '../src/ai/child-occupancy.js';
import { quoteSourcePartyDigest } from '../src/ai/quote-source-party.js';
import { staffQuoteInput, staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { quotePdfJobIdentity } from '../src/ai/quote-pdf-jobs.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';
import { configureDraftArtifactStorage } from '../src/trpc/routes/drafts.js';
import { appRouter } from '../src/trpc/router.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const transportId = 'transport-centurion', userId = 'user-1', itemId = '00000000-0000-4000-8000-000000000001';
const pdf = Buffer.from('%PDF-1.4');
const hash = createHash('sha256').update(pdf).digest('hex');
const caller = (activeTransportId = transportId, actorId = userId) => appRouter.createCaller({
  auth: null as never, reqHeaders: new Headers(), sessionUser: { id: actorId, email: 'staff@example.invalid', name: 'Staff' },
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
  const recordedHashes = { value: [hash] };
  const savedReply = { savedId: 'saved-reply:other:1',
    savedHtml: '<p>Synthetic</p>', savedAttachments: [] as unknown[], draftAttachments: [] as unknown[] };
  const transactionState = { enabled: false, active: false, committed: false, locks: [] as string[] };
  const transaction = vi.fn(async (run: (tx: DB) => Promise<unknown>) => {
    if (!transactionState.enabled) throw new Error('synthetic transaction reached');
    transactionState.active = true;
    transactionState.committed = false;
    try {
      const result = await run(db);
      transactionState.committed = true;
      return result;
    } finally { transactionState.active = false; }
  });
  const select = (selection?: Record<string, unknown>) => {
    let table: unknown;
    const query = { from(value: unknown) { table = value; return query; }, innerJoin() { return query; },
      where() { return query; }, orderBy() {
        return selection && 'workItemId' in selection && 'kind' in selection && 'status' in selection
          ? Promise.resolve([]) : query;
      }, limit() {
        let rows: unknown[] = [];
        if (table === mailThread) rows = [{ id: 't1', transportId }];
        if (table === mailDraft && !transactionState.active) rows = [{ id: 'draft-1', htmlBody: '<p>Synthetic</p>', attachments: savedReply.draftAttachments }];
        if (table === mailDraftRevision) rows = [
          { id: savedReply.savedId, htmlBody: savedReply.savedHtml, attachments: savedReply.savedAttachments },
        ];
        if (table === message) rows = [mail];
        if (table === mailExtraction) rows = [{ id: 'extract-1', kind: 'quote', payload }];
        if (table === workItem) rows = [{ id: itemId, extractionId: 'extract-1', state }];
        if (table === aiDraftGeneration) rows = [{ id: 'generation-1', createdAt: new Date() }];
        if (table === aiWorkflowRun && selection && 'run' in selection) rows = [{ run }];
        else if (table === aiWorkflowRun && selection && 'hash' in selection)
          rows = jobAvailable.value ? recordedHashes.value.map((recordedHash) => ({ hash: recordedHash })) : [];
        else if (table === aiWorkflowRun && selection && 'request' in selection)
          rows = jobAvailable.value && job.readRequest.propertyCode !== 'HRDAV' ? [{ request: job.readRequest }] : [];
        else if (table === aiWorkflowRun) rows = jobAvailable.value ? [job] : [];
        const result = Promise.resolve(rows);
        return Object.assign(result, { for(mode: string) { transactionState.locks.push(mode); return result; } });
      } };
    return query;
  };
  const db = { transaction, select, selectDistinct: select, insert: () => ({ values: async () => undefined }) } as unknown as DB;
  const quoteInput = staffQuoteInput.parse({ messageId: mail.id, sourceHash: staffQuoteSourceHash(mail),
    sourcePartyDigest: quoteSourcePartyDigest(payload, state), sourceExtractionId: 'extract-1',
    selectionEpoch: 1, inputRevision: 1, salesStrategy: 'BAR', groups: [{ id: 'g1', arrivalDate: '2027-10-20',
      departureDate: '2027-10-21', quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'room_only',
      sourcePreference: { roomType: null, board: null } }] });
  const proof = await captureQuoteSourceProof(db, quoteInput, { transportId, threadId: 't1', messageId: 'm1' });
  Object.assign(staff, { quoteSourceProof: proof });
  __setDbForTests({ db, conn: null as never });
  configureDraftArtifactStorage({ read: async () => pdf } as never);
  return { revision, job, state, mail, transaction, transactionState, savedReply, jobAvailable, recordedHashes, proposal };
}

beforeEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({ selectedFound: true, selected: {}, inbounds: [] });
});
afterEach(() => { mailboxHmsOriginBindLoaders.loadThreadOriginScan = null; configureDraftArtifactStorage(null); __setDbForTests(null); vi.unstubAllEnvs(); });

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

  it('lets a mailbox colleague use a current PDF while still binding its recorded author and source', async () => {
    const { job, state } = await fixture();
    const input = { messageId: 'm1', threadId: 't1', pdfHashes: [hash] };
    const colleague = () => caller(transportId, 'user-2').workstation.quoteDraftPreflight(input);
    await expect(colleague()).resolves.toEqual({ ready: true });
    state['stays[s1].rows[g1].roomType'] = 'Standard Twin';
    await expect(colleague()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    delete state['stays[s1].rows[g1].roomType'];
    job.readRequest.userId = 'user-3';
    await expect(colleague()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    job.readRequest.userId = userId;
    job.readRequest.transportId = 'another-transport';
    await expect(colleague()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('allows supporting files but requires every recorded quote to match this email', async () => {
    const { recordedHashes, transaction } = await fixture();
    const support = Buffer.from('%PDF-terms');
    const supportHash = createHash('sha256').update(support).digest('hex');
    const preflight = (pdfHashes: string[]) => caller().workstation.quoteDraftPreflight({ messageId: 'm1', threadId: 't1', pdfHashes });
    await expect(preflight([hash, supportHash])).resolves.toEqual({ ready: true });
    await expect(preflight([supportHash])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const attachment = (name: string, body: Buffer) => ({ name, type: 'application/pdf', size: body.length,
      lastModified: 1, base64: body.toString('base64') });
    await expect(caller().drafts.saveReply({ threadId: 't1', replyToMessageId: 'm1', html: '<p>Synthetic</p>',
      replyKind: 'quote', attachments: [attachment('quote.pdf', pdf), attachment('terms.pdf', support)] }))
      .rejects.toThrow('synthetic transaction reached');
    transaction.mockClear();
    recordedHashes.value.push(supportHash);
    await expect(preflight([hash, supportHash])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller().drafts.saveReply({ threadId: 't1', replyToMessageId: 'm1', html: '<p>Synthetic</p>',
      replyKind: 'quote', attachments: [attachment('quote.pdf', pdf), attachment('other-quote.pdf', support)] }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses stale webmail quote saves before creating or replacing a draft', async () => {
    const { revision, state, transaction, jobAvailable } = await fixture();
    const base = { threadId: 't1', replyToMessageId: 'm1', html: '<p>Synthetic</p>',
      attachments: [{ name: 'quote.pdf', type: 'application/pdf', size: pdf.length,
        lastModified: 1, base64: pdf.toString('base64') }] };
    const disguised = { ...base, replyKind: 'other' as const, preparedVersions: [],
      attachments: [{ ...base.attachments[0]!, type: 'application/octet-stream' }] };
    await expect(caller().drafts.saveReply(disguised)).rejects.toThrow('synthetic transaction reached');
    transaction.mockClear();
    state['stays[s1].rows[g1].childrenPerRoom'] = 1;
    await expect(caller().drafts.saveReply({ ...base, replyKind: 'quote',
      preparedVersions: [{ workflowRunId: 'run-1', revisionRef: revision.id }] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller().drafts.saveReply(disguised)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
    jobAvailable.value = false;
    await expect(caller().drafts.saveReply({ ...base, replyKind: 'other', preparedVersions: [] }))
      .rejects.toThrow('synthetic transaction reached');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('refuses a saved quote if source facts change during attachment staging', async () => {
    const { state, transactionState } = await fixture();
    transactionState.enabled = true;
    const input = { threadId: 't1', replyToMessageId: 'm1', html: '<p>Synthetic</p>', replyKind: 'other' as const,
      attachments: [{ name: 'quote.pdf', type: 'application/pdf', size: pdf.length,
        lastModified: 1, base64: pdf.toString('base64') }] };
    configureDraftArtifactStorage({ read: async () => pdf, stage: async () => {
      state['stays[s1].rows[g1].roomType'] = 'Standard Twin';
    } } as never);

    await expect(caller().drafts.saveReply(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(transactionState.committed).toBe(false);
    expect(transactionState.locks).toContain('share');

    delete state['stays[s1].rows[g1].roomType'];
    configureDraftArtifactStorage({ read: async () => pdf, stage: async () => undefined } as never);
    await expect(caller().drafts.saveReply(input)).resolves.toMatchObject({ id: expect.any(String), replaced: false });
    expect(transactionState.committed).toBe(true);
  });

  it('does not impose the Centurion proof on an HRDAV mailbox', async () => {
    const { revision } = await fixture();
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight({ messageId: 'm1', threadId: 't1',
      pdfHashes: [hash], preparedVersions: [{ workflowRunId: 'run-1', revisionRef: revision.id }] }))
      .resolves.toEqual({ ready: true });
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight({ messageId: 'm1', threadId: 't1',
      pdfHashes: [] })).resolves.toEqual({ ready: true });
  });

  it('accepts the combined-document limit of 63 stay references on both draft paths', async () => {
    const { transaction } = await fixture();
    const preparedVersions = Array.from({ length: 63 }, (_, index) => ({ workflowRunId: `run-${index}`, revisionRef: `rev-${index}` }));
    const preflight = { messageId: 'm1', threadId: 't1', pdfHashes: [], preparedVersions };
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight(preflight)).resolves.toEqual({ ready: true });
    await expect(caller('transport-davinci').workstation.quoteDraftPreflight({ ...preflight,
      preparedVersions: [...preparedVersions, { workflowRunId: 'run-extra', revisionRef: 'rev-extra' }] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller('transport-davinci').drafts.saveReply({ threadId: 't1', replyToMessageId: 'm1', html: '', preparedVersions }))
      .rejects.toThrow('synthetic transaction reached');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('does not exempt a recorded Centurion PDF when a thread later resolves to Da Vinci', async () => {
    const { job, jobAvailable } = await fixture();
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '{}');
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({ selectedFound: true, selected: {},
      inbounds: [{ toAddresses: ['davinci@legacyhotels.co.za'] }] });
    const input = { messageId: 'm1', threadId: 't1', pdfHashes: [hash] };
    await expect(caller().workstation.quoteDraftPreflight(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    job.readRequest.propertyCode = 'HRDAV';
    await expect(caller().workstation.quoteDraftPreflight(input)).resolves.toEqual({ ready: true });
    jobAvailable.value = false;
    await expect(caller().workstation.quoteDraftPreflight(input)).resolves.toEqual({ ready: true });
  });

  it('keeps edited non-quotes available while guarding changed files and recorded quote PDFs', async () => {
    const { savedReply, recordedHashes } = await fixture();
    const read = () => caller().drafts.savedReply({ threadId: 't1' });
    await expect(read()).resolves.toMatchObject({ quoteBound: false });
    savedReply.savedHtml = '<p>A later replacement</p>';
    await expect(read()).resolves.toMatchObject({ quoteBound: false });
    savedReply.savedHtml = '<p>Synthetic</p>';
    savedReply.savedAttachments = [{ filename: 'different.pdf' }];
    expect(await read()).not.toHaveProperty('quoteBound');
    savedReply.savedAttachments = [];
    await expect(read()).resolves.toMatchObject({ quoteBound: false });
    savedReply.savedId = 'saved-reply:quote:2';
    savedReply.savedHtml = '<p>Saved quote body</p>';
    await expect(read()).resolves.toMatchObject({ quoteBound: true });
    const attachment = { filename: 'quote.pdf', mimeType: 'application/pdf', s3Key: 'synthetic', sizeBytes: pdf.length, sourceHash: hash };
    savedReply.savedId = 'saved-reply:other:3';
    savedReply.savedAttachments = [];
    savedReply.draftAttachments = [attachment];
    recordedHashes.value = [];
    expect(await read()).not.toHaveProperty('quoteBound');
    recordedHashes.value = [hash];
    savedReply.savedAttachments = savedReply.draftAttachments = [attachment];
    await expect(read()).resolves.toMatchObject({ quoteBound: true });
  });
});
