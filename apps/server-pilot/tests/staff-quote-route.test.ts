import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { aiDraftGeneration, aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { occupiedDates, type QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';
import { staffQuoteSourceHash, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { enqueueHmsJob, HMS_JOB_PRIORITY_PREFETCH } from '../src/ai/hms-jobs.js';
import { ReservationistTaskEvidenceUnavailable } from '../src/ai/reservationist-execution.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { findParty, panePartyLookupLoaders, resetPartyCacheForTests } from '../src/ai/pane-party-lookup.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../src/ai/quote-workflow-synced-selection.js';
import { FAITH_TRANSPORT_EMAIL, FAITH_USER_ID } from '../src/db/seed.js';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { eq } from 'drizzle-orm';

const installation = vi.hoisted(() => ({ configure: vi.fn(), services: vi.fn() }));
vi.mock('../src/ai/staff-quote-installation.js', () => ({
  readInstalledStaffQuoteConfiguration: installation.configure,
  getInstalledStaffQuoteServices: installation.services,
}));

const reachable = await probeTestDb();
const nativeRead =
  vi.fn<
    (request: QuoteSourceRecord['request'], signal: AbortSignal) => Promise<QuoteSourceRecord>
  >();

function caller(transportId = 'transport-centurion', userId = 'user-ropperman') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': transportId }),
    sessionUser: { id: userId, email: 'staff@example.invalid', name: 'Synthetic Staff' },
  } as never);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function seedRequest(db: DB, transportId = 'transport-centurion') {
  const threadId = randomUUID(),
    messageId = randomUUID(),
    // Outlook reports PR_INTERNET_MESSAGE_ID raw (angle brackets, mixed case); ingest stores the canonical form.
    internetMessageId = `<${messageId.toUpperCase()}@Example.Invalid>`,
    storedMessageId = `${messageId}@example.invalid`;
  await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  const [mail] = await db
    .insert(message)
    .values({
      id: messageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.invalid',
      messageIdHeader: storedMessageId,
      textBody: 'Please quote accommodation. Is an airport shuttle available?',
      receivedAt: new Date(),
    })
    .returning();
  const input: StaffQuoteInput = {
    messageId,
    sourceHash: staffQuoteSourceHash(mail),
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [
      {
        id: 'single',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 2,
        adults: 1,
        childrenAges: [],
        board: 'room_only',
        roomCodes: ['SKNG'],
      },
    ],
    salesStrategy: 'BAR',
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };
  const stay = (id: string, rowId: string, arrival: string, departure: string) => ({
    id, hotel: null, requested: { arrival, departure }, booked: null, totalRooms: 2,
    rows: [{ id: rowId, roomType: null, rooms: 2, adultsPerRoom: 1,
      childrenPerRoom: 0, childAges: [], board: null }],
  });
  const [extraction] = await db.insert(mailExtraction).values({
    messageId, extractorVersion: 'synthetic-occupancy-v1', status: 'succeeded', kind: 'quote',
    payload: { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
      confirmationNumbers: [], missing: [], stays: [
        stay('s_default', 'single', '2026-10-12', '2026-10-15'),
        stay('s_oct', 'single_oct', '2026-10-26', '2026-10-27'),
        stay('s_nov', 'single_nov', '2026-11-17', '2026-11-18'),
      ] },
  }).returning({ id: mailExtraction.id });
  const [item] = await db.insert(workItem).values({
    transportId, threadId, sourceMessageId: messageId, kind: 'quote', extractionId: extraction!.id,
  }).returning({ id: workItem.id });
  return { mail, input, internetMessageId, storedMessageId, workItemId: item!.id };
}

const stayRowId = (arrival: string) => arrival === '2026-10-26' ? 'single_oct' : 'single_nov';

async function saveStayEdits(db: DB, workItemId: string, state: Record<string, unknown>) {
  await db.update(workItem).set({ state }).where(eq(workItem.id, workItemId));
}

async function nativeFixture(
  request: QuoteSourceRecord['request'],
  propertyCode = 'HRCEN',
): Promise<QuoteSourceRecord> {
  const { normalizeQuoteRequest } = await import('../tooling/playwright-quote/quote-contract.mjs');
  const normalized = normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
  return {
    ref: 'synthetic:' + randomUUID(),
    sha256: 'b'.repeat(64),
    toolVersion: 'controlled-fixture',
    observedAt: new Date().toISOString(),
    request: normalized,
    result: {
      outcome: 'quote',
      propertyCode,
      groups: normalized.rooms.map((room: any) => ({
        id: room.id,
        request: room,
        completeness: { search: 'complete', requiredFacts: 'complete' },
        options: [
          {
            id: 'selected',
            room: { code: 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
            rate: { code: 'BARRO', label: 'Room Only' },
            board: 'Room Only R',
            appliedContext: {},
            eligibility: 'verified',
            availability: 'available',
            matchStatus: 'match',
            held: false,
            totals: { taxInclusive: true },
            nightly: occupiedDates(normalized.arrivalDate, normalized.departureDate).map(
              (date, i) => ({
                date,
                inventory: 8,
                price: { amount: ['100.01', '500.00', '500.00'][i] ?? '500.00', currency: 'ZAR' },
              }),
            ),
          },
        ],
      })),
    },
  };
}

function installFixture(db: DB, propertyCode = 'HRCEN') {
  __setDbForTests({ db, conn: null as never });
  installation.configure.mockReturnValue({
    tenantId: 'synthetic-hotel',
    owner: { propertyCode },
  });
  nativeRead.mockReset().mockImplementation((request) => nativeFixture(request, propertyCode));
  installation.services.mockReset().mockImplementation((options, approval) =>
    createReservationistBusinessServices(
      {
        ...options,
        readQuote: nativeRead,
        resolvePolicy: async () => ({
          ref: 'synthetic-policy',
          propertyCode,
          sourceHashes: ['c'.repeat(64)],
          authoredDates: ['2026-09-08'],
          families: [{ rateCode: 'BARRO', board: 'room_only' }],
          vat: 'included',
          levy: 'included',
        }),
      },
      approval,
    ),
  );
  vi.stubEnv('GOTENBERG_URL', 'http://synthetic.invalid');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('%PDF-1.4 synthetic fixture', {
          headers: { 'content-type': 'application/pdf' },
        }),
    ),
  );
}

function pdfInput(quote: { workflowRunId: string; revisionRef: string; messageId: string }) {
  return {
    ...quote,
    factRefs: [],
    outlookEmail: 'centurion@legacyhotels.co.za',
    company: '',
    agency: '',
  };
}

async function seedMailboxCopy(
  db: DB,
  source: Awaited<ReturnType<typeof seedRequest>>['mail'],
  transportId: string,
) {
  const threadId = randomUUID();
  await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  const [copy] = await db
    .insert(message)
    .values({ ...source, id: randomUUID(), transportId, threadId })
    .returning();
  return copy!;
}

async function seedPreparedQuote(
  db: DB,
  request: Awaited<ReturnType<typeof seedRequest>>,
  quote: {
    workflowRunId: string;
    revisionRef: string;
    messageId: string;
    threadId: string;
    factRefs: string[];
    inputDigest: string;
    totalMinor: number;
    currency: string;
    arrivalDate: string;
    departureDate: string;
  },
) {
  const [sourceRun] = await db
    .select()
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.id, quote.workflowRunId));
  const reservationistResult = sourceRun?.metrics?.reservationistResult as
    | { quoteRevisions?: Array<Record<string, unknown>>; proposalFacts?: Array<{ ref: string; facts: unknown }> }
    | undefined;
  const revision = reservationistResult?.quoteRevisions?.find((item) => item.id === quote.revisionRef);
  if (!sourceRun || !revision || typeof revision.authorizationId !== 'string') {
    throw new Error('expected the staff quote revision to be persisted');
  }
  const freshness = revision.sourceFreshness as { expiresAt?: unknown } | undefined;
  if (typeof freshness?.expiresAt !== 'string' || Date.parse(freshness.expiresAt) <= Date.now()) {
    throw new Error('expected a fresh quote revision');
  }
  const factBundle = reservationistResult?.proposalFacts?.find((bundle) => quote.factRefs.includes(bundle.ref));
  const preparedInput = { ...request.input, selectionEpoch: 0, inputRevision: 0 };
  const { run } = await enqueueHmsJob({
    transportId: request.mail.transportId,
    threadId: request.mail.threadId,
    triggerMessageId: request.mail.id,
    workItemId: null,
    userId: null,
    request: { kind: 'staff_quote', input: preparedInput },
    priority: HMS_JOB_PRIORITY_PREFETCH,
    idempotencyKey: `hms-job:staff-quote-prepared:route-test:${randomUUID()}`,
    extraMetrics: { quotePrepared: true },
  }, db);
  const now = new Date();
  const readResult = {
    ...quote,
    status: 'ready',
    kind: 'staff_quote',
    workflowRunId: run.id,
    asOf: now.toISOString(),
    freshUntil: freshness.expiresAt,
    preparedProposal: {
      version: 1,
      inputDigest: quote.inputDigest,
      authorizationId: revision.authorizationId,
      sourceHash: request.input.sourceHash,
      revision,
      ...(factBundle ? { facts: factBundle.facts } : {}),
      rowPrices: [],
    },
  };
  await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      readResult,
      readResultExpiresAt: new Date(freshness.expiresAt),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(aiWorkflowRun.id, run.id));
  return { workflowRunId: run.id, revisionRef: quote.revisionRef, messageId: quote.messageId };
}

function workbookSheet(base64: string): string {
  const sheet = unzipSync(Buffer.from(base64, 'base64'))['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('expected the proposal workbook sheet');
  return new TextDecoder().decode(sheet);
}

function staffNote(html: string): string | null {
  const note = /<p class="staff-note"><strong>Note:<\/strong> ([\s\S]*?)<\/p>/.exec(html)?.[1];
  return note?.replace(/<br>/g, '\n') ?? null;
}

afterEach(() => {
  __setDbForTests(null);
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
  resetPartyCacheForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'staff quote route approval ledger (disposable DB, no HMS)',
  () => {
    it('queues staff quotes without reading HMS configuration and exposes the request result by input', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        installation.configure.mockImplementation(() => {
          throw new Error('no borrowed CDP in this process');
        });
        installation.configure.mockClear();
        vi.stubEnv('HMS_JOB_QUEUE', 'on');

        const queued = await api.workstation.queueStaffQuote(request.input);
        expect(queued.runId).toEqual(expect.any(String));
        expect(installation.configure).not.toHaveBeenCalled();
        expect(nativeRead).not.toHaveBeenCalled();
        const [run] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, queued.runId!));
        expect(run).toMatchObject({
          runKind: 'read_tool',
          executorLane: 'hms',
          priority: 10,
          readRequest: { kind: 'staff_quote', input: request.input },
          metrics: {
            hmsJob: true,
            prefetch: false,
            userId: 'user-ropperman',
            staffQuoteUser: {
              id: 'user-ropperman',
              name: 'Synthetic Staff',
              email: 'staff@example.invalid',
            },
          },
        });
        expect(await api.workstation.staffQuoteJob({ input: request.input })).toMatchObject({
          runId: queued.runId,
          status: 'queued',
          request: { kind: 'staff_quote', input: request.input },
        });
        await expect(api.workstation.staffQuoteJob({ runId: queued.runId! })).resolves.toMatchObject({
          runId: queued.runId,
          status: 'queued',
        });
        const other = caller('transport-centurion', 'user-navaai');
        await expect(other.workstation.staffQuoteJob({ input: request.input })).resolves.toBeNull();
        await expect(other.workstation.staffQuoteJob({ runId: queued.runId! })).resolves.toBeNull();
        await expect(other.paneStayLookup.jobStatus({ runId: queued.runId! })).resolves.toBeNull();
        const edited = {
          ...request.input,
          selectionEpoch: 9,
          groups: [{ ...request.input.groups[0]!, adults: 3 }],
        };
        await expect(api.workstation.staffQuoteJob({ input: edited })).resolves.toBeNull();
        await expect(
          api.workstation.staffQuoteJob({ input: { ...request.input, attention: 'Someone else' } }),
        ).resolves.toMatchObject({ runId: queued.runId });
        const later = {
          ...request.input,
          groups: [
            {
              ...request.input.groups[0]!,
              id: 'later',
              arrivalDate: '2026-11-12',
              departureDate: '2026-11-15',
            },
          ],
        };
        const laterQueued = await api.workstation.queueStaffQuote(later);
        await expect(api.workstation.staffQuoteJob({ input: later })).resolves.toMatchObject({
          runId: laterQueued.runId,
        });
        await expect(api.workstation.staffQuoteJob({ input: request.input })).resolves.toMatchObject({
          runId: queued.runId,
        });
      });
    });

    it('returns a null run id with the queue off and leaves inline execution available', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        vi.stubEnv('HMS_JOB_QUEUE', 'off');

        await expect(api.workstation.queueStaffQuote(request.input)).resolves.toEqual({ runId: null });
        const rows = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.runKind, 'read_tool'));
        expect(rows).toEqual([]);
        expect(nativeRead).not.toHaveBeenCalled();
        await expect(api.workstation.executeStaffQuote(request.input)).resolves.toMatchObject({
          status: 'ready',
          inputRevision: 1,
        });
      });
    });

    it('rejects ambiguous Message-IDs instead of loading another selected request', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db), api = caller();
        await db.insert(message).values({
          ...request.mail, id: randomUUID(), textBody: 'Different request with a repeated Message-ID',
        });
        await expect(api.workstation.staffQuoteSource({ internetMessageId: request.internetMessageId }))
          .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Selected message identity is ambiguous' });
        await expect(api.workstation.qualifiedProposalChoices({ internetMessageId: request.internetMessageId }))
          .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Selected message identity is ambiguous' });
        expect(await loadSyncedQuoteSelectionFromMailbox({ transportId: request.mail.transportId, internetMessageId: request.storedMessageId })).toBeNull();
        expect(nativeRead).not.toHaveBeenCalled();
      });
    });

    it('rejects evidence that expires during PDF conversion', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db), api = caller();
        const quote = await api.workstation.executeStaffQuote(request.input);
        vi.mocked(fetch).mockImplementationOnce(async () => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
          return new Response('%PDF-1.4 converted expired fixture', { headers: { 'content-type': 'application/pdf' } });
        });
        try {
          await expect(api.workstation.qualifiedQuoteProposalPdf(pdfInput({
            workflowRunId: quote.workflowRunId, revisionRef: quote.revisionRef, messageId: quote.messageId,
          })))
            .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Proposal evidence expired during conversion' });
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('uses staff corrections through the real route and qualifies accommodation despite a secondary ask', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const source = await api.workstation.staffQuoteSource({
          internetMessageId: request.internetMessageId,
        });
        expect(source).toMatchObject({
          status: 'ready',
          messageId: request.input.messageId,
          sourceHash: request.input.sourceHash,
        });
        const quote = await api.workstation.executeStaffQuote(request.input);
        expect(quote).toMatchObject({ status: 'ready', inputRevision: 1, totalMinor: 220002 });
        expect(nativeRead.mock.calls[0][0]).toMatchObject({
          arrivalDate: '2026-10-12',
          departureDate: '2026-10-15',
          rooms: [{ quantity: 2, adults: 1 }],
        });
        const [run] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, quote.workflowRunId));
        expect(run.metrics?.staffQuoteAttestation).toMatchObject({
          inputDigest: quote.inputDigest,
          messageId: request.mail.id,
        });
        const [generation] = await db
          .select()
          .from(aiDraftGeneration)
          .where(eq(aiDraftGeneration.id, run.generationId!));
        expect(generation).toMatchObject({ status: 'succeeded', promptHash: quote.inputDigest });
        const pdf = await api.workstation.qualifiedQuoteProposalPdf(
          pdfInput({
            workflowRunId: quote.workflowRunId,
            revisionRef: quote.revisionRef,
            messageId: quote.messageId,
          }),
        );
        expect(pdf).toMatchObject({ revisionId: quote.revisionRef, totalMinor: 220002 });
      });
    });

    it('exports a reused prepared quote with the same header note as a fresh staff quote', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
        vi.stubEnv('QUOTE_PDF_RENDERER', 'html');
        const request = await seedRequest(db),
          api = caller();
        const headerNote = 'Breakfast only on day two.';
        const fresh = await api.workstation.executeStaffQuote({ ...request.input, notes: headerNote });
        const htmlDocuments: string[] = [];
        vi.mocked(fetch).mockImplementation(async (_url, init) => {
          if (init?.body instanceof FormData) {
            const file = init.body.get('files');
            if (file instanceof Blob) htmlDocuments.push(await file.text());
          }
          return new Response('%PDF-1.4 synthetic fixture', {
            headers: { 'content-type': 'application/pdf' },
          });
        });
        const freshInput = pdfInput({
          workflowRunId: fresh.workflowRunId,
          revisionRef: fresh.revisionRef,
          messageId: fresh.messageId,
        });
        const freshPdf = await api.workstation.qualifiedQuoteProposalPdf(freshInput);
        const freshWorkbook = await api.workstation.quoteWorkbook(freshInput);
        const prepared = await seedPreparedQuote(db, request, fresh);
        const preparedInput = { ...pdfInput(prepared), notes: headerNote };
        const preparedPdf = await api.workstation.qualifiedQuoteProposalPdf(preparedInput);
        const preparedWorkbook = await api.workstation.quoteWorkbook(preparedInput);

        expect(freshPdf.totalMinor).toBe(fresh.totalMinor);
        expect(preparedPdf.totalMinor).toBe(freshPdf.totalMinor);
        expect(htmlDocuments).toHaveLength(2);
        expect(staffNote(htmlDocuments[0]!)).toBe(headerNote);
        expect(staffNote(htmlDocuments[1]!)).toBe(headerNote);
        expect(workbookSheet(freshWorkbook.xlsxBase64)).toContain(headerNote);
        expect(workbookSheet(preparedWorkbook.xlsxBase64)).toBe(workbookSheet(freshWorkbook.xlsxBase64));
      });
    });

    it('exports a prepared quote only from its original mailbox and source messageId', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db, 'HRDAV');
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
        vi.stubEnv('QUOTE_PDF_RENDERER', 'html');
        const request = await seedRequest(db, 'transport-davinci');
        const sourceApi = caller('transport-davinci', FAITH_USER_ID);
        const quote = await sourceApi.workstation.executeStaffQuote(request.input);
        const prepared = await seedPreparedQuote(db, request, quote);
        const copy = await seedMailboxCopy(db, request.mail, 'transport-faith');
        const copyApi = caller('transport-faith', FAITH_USER_ID);
        const sourceInput = pdfInput({ ...prepared, messageId: request.mail.id });
        const copyInput = {
          ...pdfInput({ ...prepared, messageId: copy.id }),
          outlookEmail: FAITH_TRANSPORT_EMAIL,
        };

        await expect(sourceApi.workstation.qualifiedQuoteProposalPdf(sourceInput)).resolves.toMatchObject({
          totalMinor: quote.totalMinor,
        });
        await expect(copyApi.workstation.qualifiedQuoteProposalPdf(copyInput)).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Proposal source not found',
        });
      });
    });

    it('exports prepared quotes when matched party name differs from extracted case', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
        const request = await seedRequest(db),
          api = caller();
        const preparedInput = {
          ...request.input,
          agency: 'Acme Lodging Holdings',
          parties: {
            agency: {
              kind: 'agency' as const,
              nativeId: 'agency-17',
              name: 'ACME LODGING HOLDINGS',
            },
          },
        };
        panePartyLookupLoaders.enabled = () => true;
        panePartyLookupLoaders.lock = { withLock: async <T>(run: () => Promise<T>) => run() };
        panePartyLookupLoaders.spawn = async () => ({
          outcome: 'resolved',
          candidates: [
            {
              kind: 'bookingAgency',
              nativeId: 'agency-17',
              displayName: 'ACME LODGING HOLDINGS',
              matchedOn: ['store'],
            },
          ],
          truncated: false,
        });
        await findParty({ name: preparedInput.agency, kind: 'agency' });
        const fresh = await api.workstation.executeStaffQuote(preparedInput);
        const prepared = await seedPreparedQuote(db, { ...request, input: preparedInput }, fresh);
        const exportInput = { ...pdfInput(prepared), agency: 'ACME LODGING HOLDINGS' };
        const results = await Promise.allSettled([
          api.workstation.qualifiedQuoteProposalPdf(exportInput),
          api.workstation.quoteWorkbook(exportInput),
        ]);

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        if (results[0]?.status === 'fulfilled') expect(results[0].value.totalMinor).toBe(fresh.totalMinor);
        if (results[1]?.status === 'fulfilled') expect(results[1].value.totalMinor).toBe(fresh.totalMinor);
      });
    });

    it('refuses prepared exports after a newer approval changes the same stay', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
        const request = await seedRequest(db),
          api = caller();
        const stayOn = (inputRevision: number, arrivalDate: string, departureDate: string, quantity = 2) =>
          api.workstation.executeStaffQuote({
            ...request.input,
            inputRevision,
            groups: [{ ...request.input.groups[0]!, id: stayRowId(arrivalDate), arrivalDate, departureDate, quantity }],
          });
        const october = await stayOn(1, '2026-10-26', '2026-10-27');
        const november = await stayOn(2, '2026-11-17', '2026-11-18');
        const octoberRequest = {
          ...request,
          input: { ...request.input, groups: [{ ...request.input.groups[0]!, id: 'single_oct', arrivalDate: '2026-10-26', departureDate: '2026-10-27' }] },
        };
        const novemberRequest = {
          ...request,
          input: { ...request.input, groups: [{ ...request.input.groups[0]!, id: 'single_nov', arrivalDate: '2026-11-17', departureDate: '2026-11-18' }] },
        };
        const octoberPrepared = await seedPreparedQuote(db, octoberRequest, october);
        const novemberPrepared = await seedPreparedQuote(db, novemberRequest, november);
        const oldCombined = {
          ...pdfInput(octoberPrepared),
          additionalStays: [
            { workflowRunId: novemberPrepared.workflowRunId, revisionRef: novemberPrepared.revisionRef, factRefs: [] },
          ],
        };
        await saveStayEdits(db, request.workItemId, { 'stays[s_oct].rows[single_oct].count': 3 });
        const currentOctober = await stayOn(3, '2026-10-26', '2026-10-27', 3);

        await expect(api.workstation.qualifiedQuoteProposalPdf(pdfInput(octoberPrepared))).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        await expect(api.workstation.quoteWorkbook(pdfInput(octoberPrepared))).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        await expect(api.workstation.qualifiedQuoteProposalPdf(oldCombined)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        await expect(api.workstation.quoteWorkbook(oldCombined)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        const currentCombined = {
          ...pdfInput({
            workflowRunId: currentOctober.workflowRunId,
            revisionRef: currentOctober.revisionRef,
            messageId: currentOctober.messageId,
          }),
          additionalStays: [
            { workflowRunId: novemberPrepared.workflowRunId, revisionRef: novemberPrepared.revisionRef, factRefs: [] },
          ],
        };
        await expect(api.workstation.qualifiedQuoteProposalPdf(currentCombined)).resolves.toMatchObject({
          totalMinor: currentOctober.totalMinor + november.totalMinor,
        });
        await expect(api.workstation.quoteWorkbook(currentCombined)).resolves.toMatchObject({
          totalMinor: currentOctober.totalMinor + november.totalMinor,
        });
      });
    });

    it('disables prepared PDF and Excel exports without disabling fresh staff quotes', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
        const request = await seedRequest(db),
          api = caller();
        const fresh = await api.workstation.executeStaffQuote(request.input);
        const prepared = await seedPreparedQuote(db, request, fresh);
        vi.stubEnv('HMS_QUOTE_PREPARE', 'false');
        const preparedInput = pdfInput(prepared);

        await expect(api.workstation.qualifiedQuoteProposalPdf(preparedInput)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        await expect(api.workstation.quoteWorkbook(preparedInput)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        expect(fetch).not.toHaveBeenCalled();
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(pdfInput({
            workflowRunId: fresh.workflowRunId,
            revisionRef: fresh.revisionRef,
            messageId: fresh.messageId,
          })),
        ).resolves.toMatchObject({ totalMinor: fresh.totalMinor });
        await expect(
          api.workstation.quoteWorkbook(pdfInput({
            workflowRunId: fresh.workflowRunId,
            revisionRef: fresh.revisionRef,
            messageId: fresh.messageId,
          })),
        ).resolves.toMatchObject({ totalMinor: fresh.totalMinor });
      });
    });

    it('builds one combined PDF and Excel from two approved stays, and refuses a stay a newer approval superseded', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const stayOn = (inputRevision: number, arrivalDate: string, departureDate: string) =>
          api.workstation.executeStaffQuote({
            ...request.input,
            inputRevision,
            groups: [{ ...request.input.groups[0]!, id: stayRowId(arrivalDate), arrivalDate, departureDate }],
          });
        const october = await stayOn(1, '2026-10-26', '2026-10-27');
        const november = await stayOn(2, '2026-11-17', '2026-11-18');
        expect(october).toMatchObject({ status: 'ready', totalMinor: 20002 });
        expect(november).toMatchObject({ status: 'ready', totalMinor: 20002 });
        const combined = {
          ...pdfInput({ workflowRunId: october.workflowRunId, revisionRef: october.revisionRef, messageId: october.messageId }),
          additionalStays: [{ workflowRunId: november.workflowRunId, revisionRef: november.revisionRef, factRefs: [] }],
        };
        const pdf = await api.workstation.qualifiedQuoteProposalPdf(combined);
        expect(pdf.totalMinor).toBe(40004);
        expect(pdf.revisionId).toMatch(/^quotes:/);
        expect(pdf.fileName).toMatch(/^Quote - Guest 26 October - 18 November 2026 \([0-9a-f]{8}\)\.pdf$/);
        expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe('http://synthetic.invalid/forms/libreoffice/convert');
        const workbook = await api.workstation.quoteWorkbook(combined);
        expect(workbook).toMatchObject({ totalMinor: 40004, revisionId: pdf.revisionId });
        // The same run twice is one stay, not two.
        await expect(
          api.workstation.qualifiedQuoteProposalPdf({
            ...combined,
            additionalStays: [{ workflowRunId: october.workflowRunId, revisionRef: october.revisionRef, factRefs: [] }],
          }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        // A newer approval for the October dates supersedes the October stay, so the old pair is refused.
        const octoberAgain = await stayOn(3, '2026-10-26', '2026-10-27');
        await expect(api.workstation.qualifiedQuoteProposalPdf(combined)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Newer stay inputs were approved; use the current quote',
        });
        await expect(api.workstation.quoteWorkbook(combined)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        const current = await api.workstation.qualifiedQuoteProposalPdf({
          ...combined,
          workflowRunId: octoberAgain.workflowRunId,
          revisionRef: octoberAgain.revisionRef,
        });
        expect(current.totalMinor).toBe(40004);
      });
    });

    it('AE1: two stays, one shuttle on the first stay, give one document with a row per stay and the shuttle once', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        // The pane sends the once-per-quote shuttle with the first stay only.
        const october = await api.workstation.executeStaffQuote({
          ...request.input,
          inputRevision: 1,
          groups: [{ ...request.input.groups[0]!, id: 'single_oct', arrivalDate: '2026-10-26', departureDate: '2026-10-27' }],
          shuttleRequested: true,
          shuttleMinor: 50000,
        });
        const november = await api.workstation.executeStaffQuote({
          ...request.input,
          inputRevision: 2,
          groups: [{ ...request.input.groups[0]!, id: 'single_nov', arrivalDate: '2026-11-17', departureDate: '2026-11-18' }],
        });
        expect(october).toMatchObject({ status: 'ready', totalMinor: 70002, factRefs: ['extras'] });
        expect(november).toMatchObject({ status: 'ready', totalMinor: 20002 });
        const combined = {
          ...pdfInput({ workflowRunId: october.workflowRunId, revisionRef: october.revisionRef, messageId: october.messageId }),
          factRefs: october.factRefs,
          additionalStays: [{ workflowRunId: november.workflowRunId, revisionRef: november.revisionRef, factRefs: november.factRefs }],
        };
        const pdf = await api.workstation.qualifiedQuoteProposalPdf(combined);
        expect(pdf.totalMinor).toBe(20002 + 20002 + 50000);
        const workbook = await api.workstation.quoteWorkbook(combined);
        expect(workbook.totalMinor).toBe(pdf.totalMinor);
        const sheet = new TextDecoder().decode(
          unzipSync(Buffer.from(workbook.xlsxBase64, 'base64'))['xl/worksheets/sheet1.xml']!,
        );
        // One room row per stay (two rooms each), one shuttle row, one total.
        expect(sheet).toContain('26-27 October 2026');
        expect(sheet).toContain('17-18 November 2026');
        expect(sheet.match(/Shuttle/g)).toHaveLength(1);
        expect(sheet.match(/<f>SUM\(H24:H\d+\)<\/f>/g)).toHaveLength(1);
      });
    });

    it('revokes an in-flight older approval when corrected requirements are submitted before the native lock', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller(),
          entered = deferred(),
          release = deferred();
        nativeRead.mockImplementationOnce(async (input) => {
          entered.resolve();
          await release.promise;
          return nativeFixture(input);
        });
        const first = api.workstation.executeStaffQuote(request.input).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await entered.promise;
        await saveStayEdits(db, request.workItemId, {
          'stays[s_default].requested.departure': '2026-10-14',
          'stays[s_default].rows[single].count': 3,
        });
        const corrected = {
          ...request.input,
          inputRevision: 2,
          groups: [{ ...request.input.groups[0], quantity: 3, departureDate: '2026-10-14' }],
        };
        const second = api.workstation.executeStaffQuote(corrected);
        try {
          await vi.waitFor(async () => {
            const rows = await db
              .select()
              .from(aiDraftGeneration)
              .where(eq(aiDraftGeneration.threadId, request.mail.threadId));
            expect(rows.filter((row) => row.model === 'staff-approved-native')).toHaveLength(2);
          });
        } finally {
          release.resolve();
        }
        const old = await first;
        expect(old).toMatchObject({ error: { code: 'PRECONDITION_FAILED' } });
        const current = await second;
        expect(current).toMatchObject({ status: 'ready', inputRevision: 2, totalMinor: 180003 });
        const runs = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.threadId, request.mail.threadId));
        expect(runs.map((run) => run.id)).toEqual([current.workflowRunId]);
        const generations = await db
          .select()
          .from(aiDraftGeneration)
          .where(eq(aiDraftGeneration.threadId, request.mail.threadId));
        expect(generations.map((row) => row.status).sort()).toEqual(['failed', 'succeeded']);
        const choices = await api.workstation.qualifiedProposalChoices({
          internetMessageId: request.internetMessageId,
        });
        expect(choices.choices.map((choice) => choice.workflowRunId)).toEqual([
          current.workflowRunId,
        ]);
      });
    });

    it('denies the old PDF and hides old choices after a newer successful approval', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const first = await api.workstation.executeStaffQuote(request.input);
        await saveStayEdits(db, request.workItemId, { 'stays[s_default].rows[single].count': 3 });
        const second = await api.workstation.executeStaffQuote({
          ...request.input,
          inputRevision: 2,
          groups: [{ ...request.input.groups[0], quantity: 3 }],
        });
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(
            pdfInput({
              workflowRunId: first.workflowRunId,
              revisionRef: first.revisionRef,
              messageId: first.messageId,
            }),
          ),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(
          api.workstation.sourceQuoteProposalPdf({
            ...pdfInput({
              workflowRunId: first.workflowRunId,
              revisionRef: first.revisionRef,
              messageId: first.messageId,
            }),
            kind: 'imported_offer',
          }),
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Newer stay inputs were approved; use the current quote',
        });
        expect(fetch).not.toHaveBeenCalled();
        const choices = await api.workstation.qualifiedProposalChoices({
          internetMessageId: request.internetMessageId,
        });
        expect(choices.choices.map((choice) => choice.workflowRunId)).toEqual([
          second.workflowRunId,
        ]);
        expect(
          (
            await api.workstation.qualifiedQuoteProposalPdf(
              pdfInput({
                workflowRunId: second.workflowRunId,
                revisionRef: second.revisionRef,
                messageId: second.messageId,
              }),
            )
          ).totalMinor,
        ).toBe(330003);
      });
    });

    it('does not resurrect an old PDF when the newer submitted approval fails', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const first = await api.workstation.executeStaffQuote(request.input);
        nativeRead.mockRejectedValueOnce(new Error('controlled native failure'));
        await expect(
          api.workstation.executeStaffQuote({ ...request.input, inputRevision: 2 }),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(
            pdfInput({
              workflowRunId: first.workflowRunId,
              revisionRef: first.revisionRef,
              messageId: first.messageId,
            }),
          ),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(
          (
            await api.workstation.qualifiedProposalChoices({
              internetMessageId: request.internetMessageId,
            })
          ).choices,
        ).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      });
    });

    it('reports the exact missing VAT and levy policy action without persisting a qualified quote', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        installation.services.mockImplementationOnce((options, approval) =>
          createReservationistBusinessServices(
            {
              ...options,
              readQuote: nativeRead,
              resolvePolicy: async () => {
                throw new ReservationistTaskEvidenceUnavailable(
                  'business_quote_policy_unavailable',
                  ['source-backed VAT and tourism levy inclusions'],
                );
              },
            },
            approval,
          ),
        );
        await expect(api.workstation.executeStaffQuote(request.input)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Verify VAT and tourism levy inclusion for the selected rate.',
        });
        expect(nativeRead).toHaveBeenCalledTimes(2);
        expect(
          await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.threadId, request.mail.threadId)),
        ).toEqual([]);
        const [generation] = await db
          .select()
          .from(aiDraftGeneration)
          .where(eq(aiDraftGeneration.threadId, request.mail.threadId));
        expect(generation.status).toBe('failed');
        expect(fetch).not.toHaveBeenCalled();
      });
    });

    it('rejects a PDF if the source changes during conversion instead of returning stale bytes', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const quote = await api.workstation.executeStaffQuote(request.input);
        vi.mocked(fetch).mockImplementationOnce(async () => {
          await db
            .update(message)
            .set({ textBody: 'Changed requirements while converting PDF' })
            .where(eq(message.id, request.mail.id));
          return new Response('%PDF-1.4 converted stale fixture', {
            headers: { 'content-type': 'application/pdf' },
          });
        });
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(
            pdfInput({
              workflowRunId: quote.workflowRunId,
              revisionRef: quote.revisionRef,
              messageId: quote.messageId,
            }),
          ),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });

    it('denies cross-mailbox requests, changed source and party identity before conversion', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          foreign = await seedRequest(db, 'transport-nava'),
          api = caller();
        await expect(
          caller('transport-nava').workstation.executeStaffQuote(foreign.input),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          caller('transport-centurion', 'user-navaai').workstation.executeStaffQuote(foreign.input),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          api.workstation.executeStaffQuote({ ...request.input, sourceHash: 'd'.repeat(64) }),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(nativeRead).not.toHaveBeenCalled();
        const quote = await api.workstation.executeStaffQuote(request.input),
          selected = pdfInput({
            workflowRunId: quote.workflowRunId,
            revisionRef: quote.revisionRef,
            messageId: quote.messageId,
          });
        await expect(
          caller('transport-nava', 'user-navaai').workstation.qualifiedQuoteProposalPdf({
            ...selected,
            outlookEmail: 'navaai@legacyhotels.co.za',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          api.workstation.qualifiedQuoteProposalPdf({ ...selected, company: 'Different company' }),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await db
          .update(message)
          .set({ textBody: 'Changed accommodation requirements' })
          .where(eq(message.id, request.mail.id));
        await expect(api.workstation.qualifiedQuoteProposalPdf(selected)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        expect(
          (
            await api.workstation.qualifiedProposalChoices({
              internetMessageId: request.internetMessageId,
            })
          ).choices,
        ).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      });
    });
  },
);

function mailboxCaller(transportId: string) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': transportId }),
    sessionUser: { id: 'user-ropperman', email: 'staff@example.invalid', name: 'Synthetic Staff' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: '',
  } as never);
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'Da Vinci quote gate (HMS_DAVINCI_MAKE_QUOTE)',
  () => {
    it('blocks manual and queued DV quotes while the flag is off', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        const request = await seedRequest(db, 'transport-davinci');
        const api = mailboxCaller('transport-davinci');
        await expect(api.workstation.executeStaffQuote(request.input)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'This mail is for Da Vinci — Centurion HMS not searched',
        });
        await expect(api.workstation.queueStaffQuote(request.input)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'This mail is for Da Vinci — Centurion HMS not searched',
        });
        expect(nativeRead).not.toHaveBeenCalled();
      });
    });

    it('queues all five DV transports to HRDAV when the flag is on and leaves Centurion on HRCEN', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        vi.stubEnv('HMS_JOB_QUEUE', 'on');
        vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
        const { DAVINCI_STAFF_TRANSPORT_IDS, DAVINCI_HMS_READ_TARGET } = await import(
          '../src/hms/hms-read-target.js'
        );
        for (const transportId of DAVINCI_STAFF_TRANSPORT_IDS) {
          const request = await seedRequest(db, transportId);
          const queued = await mailboxCaller(transportId).workstation.queueStaffQuote(request.input);
          expect(queued.runId).toEqual(expect.any(String));
          const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, queued.runId!));
          expect(run?.metrics).toMatchObject({ hmsReadTarget: DAVINCI_HMS_READ_TARGET });
        }
        const centurion = await seedRequest(db, 'transport-centurion');
        const queued = await mailboxCaller('transport-centurion').workstation.queueStaffQuote(
          centurion.input,
        );
        const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, queued.runId!));
        expect(run?.metrics).not.toHaveProperty('hmsReadTarget');
      });
    });

    it('exposes server makeQuote for DV only when the flag is on; write preview stays ungated by it', async () => {
      await withSeededTestDb(async () => {
        const dv = mailboxCaller('transport-davinci');
        const cen = mailboxCaller('transport-centurion');
        await expect(dv.quoteWorkflow.makeQuote()).resolves.toEqual({
          makeQuote: false,
          propertyCode: null,
        });
        await expect(cen.quoteWorkflow.makeQuote()).resolves.toEqual({
          makeQuote: true,
          propertyCode: 'HRCEN',
        });
        vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
        await expect(dv.quoteWorkflow.makeQuote()).resolves.toEqual({
          makeQuote: true,
          propertyCode: 'HRDAV',
        });
        await expect(cen.quoteWorkflow.makeQuote()).resolves.toEqual({
          makeQuote: true,
          propertyCode: 'HRCEN',
        });
        expect(nativeRead).not.toHaveBeenCalled();
      });
    });
  },
);
