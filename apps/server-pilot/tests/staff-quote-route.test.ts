import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { aiDraftGeneration, aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { occupiedDates, type QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';
import { staffQuoteSourceHash, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { ReservationistTaskEvidenceUnavailable } from '../src/ai/reservationist-execution.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../src/ai/quote-workflow-synced-selection.js';
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
  return { mail, input, internetMessageId, storedMessageId };
}

async function nativeFixture(request: QuoteSourceRecord['request']): Promise<QuoteSourceRecord> {
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
      propertyCode: 'HRCEN',
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

function installFixture(db: DB) {
  __setDbForTests({ db, conn: null as never });
  installation.configure.mockReturnValue({
    tenantId: 'synthetic-hotel',
    owner: { propertyCode: 'HRCEN' },
  });
  nativeRead.mockReset().mockImplementation(nativeFixture);
  installation.services.mockReset().mockImplementation((options, approval) =>
    createReservationistBusinessServices(
      {
        ...options,
        readQuote: nativeRead,
        resolvePolicy: async () => ({
          ref: 'synthetic-policy',
          propertyCode: 'HRCEN',
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

afterEach(() => {
  __setDbForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'staff quote route approval ledger (disposable DB, no HMS)',
  () => {
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

    it('builds one combined PDF and Excel from two approved stays, and refuses a stay a newer approval superseded', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db),
          api = caller();
        const stayOn = (inputRevision: number, arrivalDate: string, departureDate: string) =>
          api.workstation.executeStaffQuote({
            ...request.input,
            inputRevision,
            groups: [{ ...request.input.groups[0]!, arrivalDate, departureDate }],
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
          groups: [{ ...request.input.groups[0]!, arrivalDate: '2026-10-26', departureDate: '2026-10-27' }],
          shuttleRequested: true,
          shuttleMinor: 50000,
        });
        const november = await api.workstation.executeStaffQuote({
          ...request.input,
          inputRevision: 2,
          groups: [{ ...request.input.groups[0]!, arrivalDate: '2026-11-17', departureDate: '2026-11-18' }],
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
