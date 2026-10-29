import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, mailDraft, mailDraftRevision, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { draftQuoteOccupancyHold, draftQuoteOccupancyMessage, importedOfferOccupancyHold } from '../src/ai/child-occupancy.js';
import { DRAFT_APPROVAL_POLICY_VERSION, DraftQuoteOccupancyError, assertDraftApprovalCurrent, buildDraftApproval, claimDraftApprovalForSend, type DraftApprovalPayload } from '../src/ai/draft-approval.js';
import { AZURE_DRAFT_ROUTE } from '../src/ai/draft-route-factory.js';
import { assertQueuedDraftApproval, DraftApprovalInvalidError } from '../src/mail/send/outbound-queue.js';
import { assertHmsDraftFreshForAction } from '../src/trpc/routes/drafts.js';
import { resolveApprovedOverride, resolveImportedOffer } from '../src/quote-proposal/quote-revision.js';
import { appRouter } from '../src/trpc/router.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';

const transportId = 'transport-centurion';
const userId = 'user-1';
const itemId = '00000000-0000-4000-8000-000000000001';
const rowPath = 'stays[s_test].rows[g1]';

function caller(activeTransportId = transportId) {
  return appRouter.createCaller({
    auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: userId, email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId, accessRole: 'owner', transportEmail: activeTransportId === transportId
      ? 'centurion@legacyhotels.co.za' : 'davinci@legacyhotels.co.za',
  } as never);
}

async function fixture(targetTransport = transportId, propertyCode = targetTransport === 'transport-centurion' ? 'HRCEN' : 'HRDAV') {
  const transportId = targetTransport;
  const now = new Date(Date.now() - 1000).toISOString();
  const revision = await syntheticRevision(['600.00'], 'Room Only R', propertyCode === 'HRCEN' ? 'SKNG' : 'STKNG', now, '2027-10-20', 'auth-1',
    { id: 'g1', quantity: 2, adults: 1, children: 0, childAges: [] }, propertyCode);
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
  const locks = { busy: false };
  const draft = { id: 'draft-1', origin: 'ai', generationId: 'generation-1', threadId: 't1', replyToMessageId: mail.id };
  const proposal = { workflowRunId: run.id, revisionRef: revision.id, messageId: mail.id,
    outlookEmail: transportId === 'transport-centurion' ? 'centurion@legacyhotels.co.za' : 'davinci@legacyhotels.co.za',
    factRefs: [], company: '', agency: '', workItemId: itemId };
  const artifact = { kind: 'quote_pdf', revisionId: revision.id, pdfHash: 'a'.repeat(64),
    fileName: 'synthetic.pdf', totalMinor: revision.totalMinor, pdfBase64: 'JVBERi0xLjQ=' };
  const job = { id: 'pdf-job', state: 'succeeded', triggerMessageId: mail.id, readResult: artifact,
    readRequest: { kind: 'quote_pdf', workItemId: itemId, revisionId: revision.id,
      propertyCode, transportId, userId, proposal } };
  const db = {
    select(selection?: Record<string, unknown>) {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        for() {
          if (locks.busy && table === workItem) throw Object.assign(new Error('source busy'), { code: '55P03' });
          return Promise.resolve([{ id: 'extract-1' }]);
        },
        limit() {
          if (table === message) return Promise.resolve([mail]);
          if (table === mailExtraction) return Promise.resolve([{ id: 'extract-1', kind: 'quote', payload }]);
          if (table === workItem) {
            const rows = Promise.resolve([{ extractionId: 'extract-1', state }]);
            return Object.assign(rows, { for: () => rows });
          }
          if (table === aiDraftGeneration) {
            const rows = Promise.resolve([{ id: 'generation-1', createdAt: new Date(), status: 'succeeded', evidence: [] }]);
            return Object.assign(rows, { for: () => rows });
          }
          if (table === mailDraft) {
            const rows = Promise.resolve([draft]);
            return Object.assign(rows, { for: () => rows });
          }
          if (table === mailDraftRevision) return Promise.resolve([{ id: 'revision-1' }]);
          if (table === aiWorkflowRun && selection && 'run' in selection) return Promise.resolve([{ run }]);
          if (table === aiWorkflowRun && selection && 'request' in selection)
            return Promise.resolve([{ request: job.readRequest, messageId: mail.id }]);
          if (table === aiWorkflowRun && selection && 'id' in selection && 'metrics' in selection)
            return Promise.resolve([run]);
          if (table === aiWorkflowRun && selection && 'metrics' in selection) {
            const rows = Promise.resolve([{ metrics: run.metrics, triggerMessageId: run.triggerMessageId }]);
            return Object.assign(rows, { for: () => rows });
          }
          if (table === aiWorkflowRun) return Promise.resolve([job]);
          return Promise.resolve([]);
        },
      };
      return query;
    },
  } as unknown as DB;
  __setDbForTests({ db, conn: null as never });
  return { revision, proposal, state, artifact, db, draft, run, locks };
}

function setThreadHotel(hotel: 'HRCEN' | 'HRDAV') {
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
    selectedFound: true,
    selected: { toAddresses: ['centurion@legacyhotels.co.za'] },
    inbounds: hotel === 'HRDAV' ? [{ fromAddress: 'davinci@legacyhotels.co.za' }] : [],
  });
}

beforeEach(() => setThreadHotel('HRCEN'));
afterEach(() => { __setDbForTests(null); vi.unstubAllEnvs(); mailboxHmsOriginBindLoaders.loadThreadOriginScan = null; });

describe('stored quote export and draft occupancy', () => {
  it('preserves HRDAV quote choices, export and booking use without Centurion child evidence', async () => {
    const davinci = 'transport-davinci';
    const { proposal, revision, run, state, artifact } = await fixture(davinci);
    state[`${rowPath}.childAges`] = null;
    const api = caller(davinci).workstation;
    const { workItemId: _item, ...uncached } = proposal;
    vi.stubEnv('GOTENBERG_URL', '');
    expect((await api.qualifiedProposalChoices({ internetMessageId: '<synthetic@example.invalid>' })).choices)
      .toHaveLength(1);
    await expect(api.qualifiedQuoteProposalPdf(uncached)).rejects.toThrow('GOTENBERG_URL missing');
    expect((await api.quoteWorkbook(uncached)).xlsxBase64).toBeTruthy();
    expect((await api.quotePdfJob({ workItemId: itemId, revisionRef: revision.id, company: '', agency: '' }))?.result)
      .toEqual(artifact);
    const now = new Date().toISOString();
    const offer = await resolveApprovedOverride({ revision, ref: 'override', evaluationAt: now,
      resolveApproval: async () => ({ ref: 'override', authorizationId: revision.authorizationId,
        revisionId: revision.id, sourceHash: 'a'.repeat(64), actorRef: 'staff', reason: 'Synthetic adjustment',
        approvedAt: now, amount: '550.00', currency: 'ZAR' }), authorizeActor: async () => true });
    Object.assign(run.metrics.reservationistResult, { approvedOverrides: [offer] });
    await expect(api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'approved_override' }))
      .rejects.toThrow('GOTENBERG_URL missing');
    const analysis = { workflow: 'create_booking' as const, flags: [], groups: [{
      arrival: '2027-10-20', departure: '2027-10-21', rooms: 2, adultsPerRoom: 1,
      childAges: [], board: 'room_only' as const, roomPreference: null, guestNames: [],
    }], party: { kind: null, name: null, reference: null }, rateClaims: [], missing: [], evidence: [], tasks: [] };
    const shared = { workflowRunId: proposal.workflowRunId, revisionRef: proposal.revisionRef,
      messageId: proposal.messageId, selectionEpoch: 1, inputRevision: 1, analysis };
    expect((await api.prepareBookingDraft(shared)).status).toBe('ready');
    expect((await api.usePriorQuoteForBooking({ ...shared, threadId: 't1' })).status).toBe('ready');
  });

  it('keeps HRDAV exports and draft checks working from a Centurion mailbox', async () => {
    setThreadHotel('HRDAV');
    const { proposal, revision, run, state, artifact, db } = await fixture('transport-centurion', 'HRDAV');
    state[`${rowPath}.childAges`] = null;
    const api = caller().workstation;
    const { workItemId: _item, ...uncached } = proposal;
    expect((await api.quoteWorkbook(uncached)).xlsxBase64).toBeTruthy();
    expect((await api.qualifiedProposalChoices({ internetMessageId: '<synthetic@example.invalid>' })).choices).toHaveLength(1);
    expect((await api.quotePdfJob({ workItemId: itemId, revisionRef: revision.id, company: '', agency: '' }))?.result).toEqual(artifact);
    await expect(draftQuoteOccupancyHold(db, { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1',
      result: run.metrics.reservationistResult })).resolves.toBeNull();
  });

  it('holds saved choices, PDF, workbook and override after the thread changes hotel', async () => {
    const { proposal, revision, run, artifact, db } = await fixture();
    const now = new Date().toISOString();
    const offer = await resolveApprovedOverride({ revision, ref: 'override', evaluationAt: now,
      resolveApproval: async () => ({ ref: 'override', authorizationId: revision.authorizationId,
        revisionId: revision.id, sourceHash: 'a'.repeat(64), actorRef: 'staff', reason: 'Synthetic adjustment',
        approvedAt: now, amount: '550.00', currency: 'ZAR' }), authorizeActor: async () => true });
    Object.assign(run.metrics.reservationistResult, { approvedOverrides: [offer] });
    const api = caller().workstation;
    const { workItemId: _item, ...uncached } = proposal;
    const cachedInput = { workItemId: itemId, revisionRef: revision.id, company: '', agency: '' };
    const choiceInput = { internetMessageId: '<synthetic@example.invalid>' };
    vi.stubEnv('GOTENBERG_URL', '');
    expect((await api.qualifiedProposalChoices(choiceInput)).choices).toHaveLength(2);
    expect((await api.quotePdfJob(cachedInput))?.result).toEqual(artifact);
    await expect(api.qualifiedQuoteProposalPdf(uncached)).rejects.toThrow('GOTENBERG_URL missing');
    expect((await api.quoteWorkbook(uncached)).xlsxBase64).toBeTruthy();

    setThreadHotel('HRDAV');
    expect((await api.qualifiedProposalChoices(choiceInput)).choices).toHaveLength(0);
    for (const attempt of [
      () => api.quotePdfJob(cachedInput),
      () => api.qualifiedQuoteProposalPdf(uncached),
      () => api.quoteWorkbook(uncached),
      () => api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'approved_override' }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(/hotel.*changed/i) });
    }
    await expect(draftQuoteOccupancyHold(db, { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1',
      result: run.metrics.reservationistResult })).resolves.toMatch(/hotel.*changed/i);
  });

  it('rechecks an HRDAV cached PDF in a Centurion mailbox after the thread changes back', async () => {
    setThreadHotel('HRDAV');
    const { revision, artifact } = await fixture('transport-centurion', 'HRDAV');
    const api = caller().workstation;
    const input = { workItemId: itemId, revisionRef: revision.id, company: '', agency: '' };
    expect((await api.quotePdfJob(input))?.result).toEqual(artifact);
    setThreadHotel('HRCEN');
    await expect(api.quotePdfJob(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: expect.stringMatching(/hotel.*changed/i),
    });
  });

  it('holds an imported HRDAV offer when its Centurion mailbox thread changes hotel', async () => {
    setThreadHotel('HRDAV');
    const { proposal, run, db } = await fixture('transport-centurion', 'HRDAV');
    const observed = new Date(Date.now() - 60_000).toISOString();
    const expiry = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const source = { ref: 'original', sourceHash: 'a'.repeat(64), authorizationId: 'auth-1',
      scopeDigest: 'b'.repeat(64), propertyCode: 'HRDAV', currency: 'ZAR', printedDate: observed.slice(0, 10),
      sentAt: observed, validUntil: expiry.slice(0, 10), terms: 'Synthetic offer',
      lines: [{ id: 'line', page: 1, quote: 'Synthetic price', amount: '600.00' }],
      sourceFreshness: { authorizationId: 'auth-1', sourceRefs: ['original'], purpose: 'offer_source' as const,
        observedAt: observed, expiresAt: expiry } };
    const offer = await resolveImportedOffer({ ref: source.ref, authorizationId: source.authorizationId,
      evaluationAt: new Date().toISOString(), resolveSource: async () => source, authorizeSource: async () => true });
    Object.assign(run.metrics.reservationistResult, { importedOffers: [offer] });
    const api = caller().workstation;
    const { workItemId: _item, ...uncached } = proposal;
    const exportOffer = () => api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'imported_offer' });
    vi.stubEnv('GOTENBERG_URL', '');
    await expect(exportOffer()).rejects.toThrow('GOTENBERG_URL missing');
    setThreadHotel('HRCEN');
    expect((await api.qualifiedProposalChoices({ internetMessageId: '<synthetic@example.invalid>' })).choices).toHaveLength(0);
    await expect(exportOffer()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(/hotel.*changed/i) });
    await expect(draftQuoteOccupancyHold(db, { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1',
      result: run.metrics.reservationistResult })).resolves.toMatch(/hotel.*changed/i);
  });

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

  it('holds imported Centurion offers before PDF export and candidate promotion', async () => {
    const { proposal, run, draft, db } = await fixture();
    const observed = new Date(Date.now() - 60_000).toISOString();
    const expiry = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const source = { ref: 'original', sourceHash: 'a'.repeat(64), authorizationId: 'auth-1',
      scopeDigest: 'b'.repeat(64), propertyCode: 'HRCEN', currency: 'ZAR', printedDate: observed.slice(0, 10),
      sentAt: observed, validUntil: expiry.slice(0, 10), terms: 'Synthetic offer',
      lines: [{ id: 'line', page: 1, quote: 'Synthetic price', amount: '600.00' }],
      sourceFreshness: { authorizationId: 'auth-1', sourceRefs: ['original'], purpose: 'offer_source' as const,
        observedAt: observed, expiresAt: expiry } };
    const offer = await resolveImportedOffer({ ref: source.ref, authorizationId: source.authorizationId,
      evaluationAt: new Date().toISOString(), resolveSource: async () => source, authorizeSource: async () => true });
    Object.assign(run.metrics.reservationistResult, { importedOffers: [offer] });
    const api = caller().workstation;
    const choices = await api.qualifiedProposalChoices({ internetMessageId: '<synthetic@example.invalid>' });
    expect(choices.choices.every((choice) => choice.kind !== 'imported_offer')).toBe(true);
    expect(choices).toMatchObject({ reason: importedOfferOccupancyHold });
    const { workItemId: _item, ...uncached } = proposal;
    await expect(api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'imported_offer' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: importedOfferOccupancyHold });
    await expect(assertHmsDraftFreshForAction({ db, transportId, draft: draft as never, conflict: 'STALE_AI_CANDIDATE' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: importedOfferOccupancyHold });
  });

  it('hides and refuses an approved override after its original room occupancy changes', async () => {
    const { revision, proposal, run, state } = await fixture();
    const now = new Date().toISOString();
    const offer = await resolveApprovedOverride({ revision, ref: 'override', evaluationAt: now,
      resolveApproval: async () => ({ ref: 'override', authorizationId: revision.authorizationId,
        revisionId: revision.id, sourceHash: 'a'.repeat(64), actorRef: 'staff', reason: 'Synthetic adjustment',
        approvedAt: now, amount: '550.00', currency: 'ZAR' }), authorizeActor: async () => true });
    Object.assign(run.metrics.reservationistResult, { approvedOverrides: [offer] });
    const api = caller().workstation;
    const input = { internetMessageId: '<synthetic@example.invalid>' };
    expect((await api.qualifiedProposalChoices(input)).choices).toHaveLength(2);
    const { workItemId: _item, ...uncached } = proposal;
    vi.stubEnv('GOTENBERG_URL', '');
    await expect(api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'approved_override' }))
      .rejects.toThrow('GOTENBERG_URL missing');
    state[`${rowPath}.childrenPerRoom`] = 1;
    expect((await api.qualifiedProposalChoices(input)).choices).toHaveLength(0);
    await expect(api.sourceQuoteProposalPdf({ ...uncached, revisionRef: offer.id, kind: 'approved_override' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('children per room') });
  });

  it('keeps non-quote candidates available and holds old priced candidates after an edit', async () => {
    const { revision, run, state, draft, db } = await fixture();
    const scope = { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1', result: run.metrics.reservationistResult };
    expect(await draftQuoteOccupancyHold(db, scope)).toBeNull();
    expect(await draftQuoteOccupancyHold(db, { ...scope, triggerMessageId: 'another-message' }))
      .toBe(draftQuoteOccupancyMessage);
    expect(await draftQuoteOccupancyHold(db, { ...scope, result: { quoteRevisionIds: ['missing'], quoteRevisions: [] } }))
      .toBe(draftQuoteOccupancyMessage);
    expect(await draftQuoteOccupancyHold(db, { ...scope, transportId: 'transport-davinci', result: { importedOffers: [{}] } })).toBeNull();
    state[`${rowPath}.childrenPerRoom`] = 1;
    await expect(assertHmsDraftFreshForAction({ db, transportId, draft: draft as never, conflict: 'STALE_AI_CANDIDATE' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: draftQuoteOccupancyMessage });
    Object.assign(run.metrics.reservationistResult, { quoteRevisionIds: [], quoteRevisions: [] });
    expect(await draftQuoteOccupancyHold(db, { ...scope, result: { version: 1, tasks: [] } })).toBeNull();
    await expect(assertHmsDraftFreshForAction({ db, transportId, draft: draft as never, conflict: 'STALE_AI_CANDIDATE' }))
      .resolves.toBeUndefined();
    expect(revision.groups[0]?.children).toBe(0);
  });

  it('rejects a now-stale priced approval at the same recheck used by the SMTP queue', async () => {
    const { state, db } = await fixture();
    const secret = 'synthetic-signing-secret';
    const release = { releaseId: 'release', releaseVersion: '1', sourceRevision: 'source', fingerprint: 'e'.repeat(64),
      purpose: 'draft' as const, capabilityFamilyVersions: { draft: '1' }, issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z', withdrawn: false };
    const payload: DraftApprovalPayload = { draftId: 'draft-1', generationId: 'generation-1', transportId,
      threadId: 't1', revisionId: 'revision-1', threadStateVersion: 'state-1', evidence: [],
      policyVersion: DRAFT_APPROVAL_POLICY_VERSION, approvedByUserId: userId, approvedAt: new Date().toISOString(),
      origin: 'ai', subject: 'Synthetic quote', html: '<p>Quote attached.</p>', text: 'Quote attached.',
      to: ['guest@example.invalid'], cc: [], bcc: [], attachments: [], routeBinding: { ...AZURE_DRAFT_ROUTE, release } };
    const approval = buildDraftApproval(payload, secret);
    state[`${rowPath}.childAges`] = null;
    await expect(assertDraftApprovalCurrent({ db, approval, payload, signingSecret: secret,
      loadThreadStateVersion: async () => 'state-1' })).rejects.toBeInstanceOf(DraftQuoteOccupancyError);
    vi.stubEnv('BETTER_AUTH_SECRET', secret);
    await expect(assertQueuedDraftApproval(approval, { from: 'centurion@example.invalid', to: payload.to,
      cc: payload.cc, bcc: payload.bcc, subject: payload.subject, html: payload.html, text: payload.text }, db))
      .rejects.toBeInstanceOf(DraftApprovalInvalidError);
  });

  it('keeps a busy saved-room check distinct from an invalid queued approval', async () => {
    const { db, locks, run } = await fixture();
    const secret = 'synthetic-signing-secret';
    const release = { releaseId: 'release', releaseVersion: '1', sourceRevision: 'source', fingerprint: 'e'.repeat(64),
      purpose: 'draft' as const, capabilityFamilyVersions: { draft: '1' }, issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z', withdrawn: false };
    const payload: DraftApprovalPayload = { draftId: 'draft-1', generationId: 'generation-1', transportId,
      threadId: 't1', revisionId: 'revision-1', threadStateVersion: 'state-1', evidence: [],
      policyVersion: DRAFT_APPROVAL_POLICY_VERSION, approvedByUserId: userId, approvedAt: new Date().toISOString(),
      origin: 'ai', subject: 'Synthetic quote', html: '<p>Quote attached.</p>', text: 'Quote attached.',
      to: ['guest@example.invalid'], cc: [], bcc: [], attachments: [], routeBinding: { ...AZURE_DRAFT_ROUTE, release } };
    const approval = buildDraftApproval(payload, secret);
    locks.busy = true;
    vi.stubEnv('BETTER_AUTH_SECRET', secret);
    const retry = { code: 'PRECONDITION_FAILED', message: 'The email is being updated. Wait a moment, then try again.',
      cause: expect.objectContaining({ code: 'QUOTE_SOURCE_BUSY' }) };
    await expect(draftQuoteOccupancyHold(db, { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1',
      result: run.metrics.reservationistResult })).rejects.toMatchObject(retry);
    await expect(assertQueuedDraftApproval(approval, { from: 'centurion@example.invalid', to: payload.to,
      cc: payload.cc, bcc: payload.bcc, subject: payload.subject, html: payload.html, text: payload.text }, db))
      .rejects.toMatchObject(retry);
    locks.busy = false;
    await expect(draftQuoteOccupancyHold(db, { transportId, threadId: 't1', messageId: 'm1', triggerMessageId: 'm1',
      result: run.metrics.reservationistResult })).resolves.toBeNull();
  });

  it('reports a retry hold before claiming a draft when the origin source is locked', async () => {
    const { db } = await fixture();
    const secret = 'synthetic-signing-secret';
    const release = { releaseId: 'release', releaseVersion: '1', sourceRevision: 'source', fingerprint: 'e'.repeat(64),
      purpose: 'draft' as const, capabilityFamilyVersions: { draft: '1' }, issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z', withdrawn: false };
    const payload: DraftApprovalPayload = { draftId: 'draft-1', generationId: 'generation-1', transportId,
      threadId: 't1', revisionId: 'revision-1', threadStateVersion: 'state-1', evidence: [],
      policyVersion: DRAFT_APPROVAL_POLICY_VERSION, approvedByUserId: userId, approvedAt: new Date().toISOString(),
      origin: 'ai', subject: 'Synthetic quote', html: '<p>Quote attached.</p>', text: 'Quote attached.',
      to: ['guest@example.invalid'], cc: [], bcc: [], attachments: [], routeBinding: { ...AZURE_DRAFT_ROUTE, release } };
    const approval = buildDraftApproval(payload, secret);
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => {
      throw Object.assign(new Error('lock unavailable'), { code: '55P03' });
    };
    await expect(claimDraftApprovalForSend({ db, approval, payload, signingSecret: secret, queueMessageId: 'queued-1',
      loadThreadStateVersion: async () => 'state-1' })).rejects.toMatchObject({
      message: 'The email is being updated. Wait a moment, then try again.',
    });
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
