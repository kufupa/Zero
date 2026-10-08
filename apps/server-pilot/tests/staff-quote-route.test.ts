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
