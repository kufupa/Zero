import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { occupiedDates, type QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';
import { staffQuoteSourceHash, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * HMS gives no building for two room types (STQN for one adult, STWN for two), so the revision pools them by room type
 * property-wide and the server keeps the PDF, the Excel and the saved reply back until staff record the HMS check.
 */

const installation = vi.hoisted(() => ({ configure: vi.fn(), services: vi.fn() }));
vi.mock('../src/ai/staff-quote-installation.js', () => ({
  readInstalledStaffQuoteConfiguration: installation.configure,
  getInstalledStaffQuoteServices: installation.services,
}));

const reachable = await probeTestDb();

function caller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': 'transport-centurion' }),
    sessionUser: { id: 'user-ropperman', email: 'staff@example.invalid', name: 'Synthetic Staff' },
  } as never);
}

async function seedRequest(db: DB, options: { workItem: boolean }) {
  const threadId = randomUUID(),
    messageId = randomUUID();
  await db
    .insert(mailThread)
    .values({ id: threadId, transportId: 'transport-centurion', threadRootId: threadId });
  const [mail] = await db
    .insert(message)
    .values({
      id: messageId,
      transportId: 'transport-centurion',
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.invalid',
      messageIdHeader: `${messageId}@example.invalid`,
      textBody: 'Please quote 15 single and 15 double rooms.',
      receivedAt: new Date(),
    })
    .returning();
  if (options.workItem)
    await db.insert(workItem).values({
      transportId: 'transport-centurion',
      threadId,
      sourceMessageId: messageId,
      kind: 'quote',
    });
  const row = (id: string, adults: number, roomCode: string) => ({
    id,
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    quantity: 15,
    adults,
    childrenAges: [],
    board: 'room_only' as const,
    roomCodes: [roomCode],
  });
  const input: StaffQuoteInput = {
    messageId,
    sourceHash: staffQuoteSourceHash(mail),
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [row('single', 1, 'STQN'), row('double', 2, 'STWN')],
    salesStrategy: 'BAR',
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };
  return { mail, input, threadId };
}

function nativeFixture(building: string | null) {
  return async (request: QuoteSourceRecord['request']): Promise<QuoteSourceRecord> => {
    const { normalizeQuoteRequest } = await import(
      '../tooling/playwright-quote/quote-contract.mjs'
    );
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
        groups: normalized.rooms.map((room: any) => {
          const code = room.required?.roomCodes?.[0] ?? 'STQN';
          return {
            id: room.id,
            request: room,
            completeness: { search: 'complete', requiredFacts: 'complete' },
            options: [
              {
                id: `HRCEN:${code}:BARRO`,
                room: { code, label: code, buildingCode: building },
                rate: { code: 'BARRO', label: 'Room Only' },
                board: 'Room Only R',
                appliedContext: {},
                eligibility: 'verified',
                availability: 'available',
                matchStatus: 'match',
                held: false,
                totals: { taxInclusive: true },
                nightly: occupiedDates(normalized.arrivalDate, normalized.departureDate).map(
                  (date) => ({
                    date,
                    inventory: 20,
                    price: { amount: '500.00', currency: 'ZAR' },
                  }),
                ),
              },
            ],
          };
        }),
      },
    };
  };
}

function installFixture(db: DB, building: string | null = null) {
  __setDbForTests({ db, conn: null as never });
  installation.configure.mockReturnValue({
    tenantId: 'synthetic-hotel',
    owner: { propertyCode: 'HRCEN' },
  });
  installation.services.mockReset().mockImplementation((options, approval) =>
    createReservationistBusinessServices(
      {
        ...options,
        readQuote: nativeFixture(building),
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

function onDates(
  input: StaffQuoteInput,
  inputRevision: number,
  arrivalDate: string,
  departureDate: string,
) {
  return {
    ...input,
    inputRevision,
    groups: input.groups.map((group) => ({ ...group, arrivalDate, departureDate })),
  };
}

function pdfInput(quote: { workflowRunId: string; revisionRef: string; messageId: string }) {
  return {
    workflowRunId: quote.workflowRunId,
    revisionRef: quote.revisionRef,
    messageId: quote.messageId,
    factRefs: [],
    outlookEmail: 'centurion@legacyhotels.co.za',
    company: '',
    agency: '',
  };
}

function analysis(): LunaAnalysis {
  return {
    workflow: 'create_booking',
    flags: [],
    groups: [
      {
        arrival: '2026-11-12',
        departure: '2026-11-14',
        rooms: 15,
        adultsPerRoom: 1,
        childAges: [],
        board: 'room_only',
        roomPreference: 'STQN',
        guestNames: [],
      },
      {
        arrival: '2026-11-12',
        departure: '2026-11-14',
        rooms: 15,
        adultsPerRoom: 2,
        childAges: [],
        board: 'room_only',
        roomPreference: 'STWN',
        guestNames: [],
      },
    ],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
}

afterEach(() => {
  __setDbForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'joint-rooms staff check (disposable DB, no HMS)',
  () => {
    it('refuses the PDF, Excel and saved reply until the check is recorded, and again once it is unticked', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db, { workItem: true }),
          api = caller();
        const quote = await api.workstation.executeStaffQuote(request.input);
        expect(quote).toMatchObject({ status: 'ready', poolBasis: 'property_room_type' });
        const refused = { code: 'PRECONDITION_FAILED', message: 'joint_rooms_unchecked' };
        const reply = {
          threadId: request.threadId,
          replyToMessageId: request.mail.id,
          html: '<p>Your quote.</p>',
          quoteRuns: [{ workflowRunId: quote.workflowRunId, revisionRef: quote.revisionRef }],
        };
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(pdfInput(quote)),
        ).rejects.toMatchObject(refused);
        await expect(api.workstation.quoteWorkbook(pdfInput(quote))).rejects.toMatchObject(refused);
        await expect(api.drafts.saveReply(reply)).rejects.toMatchObject(refused);

        const tick = (checked: boolean) =>
          api.workstation.recordJointRoomsCheck({
            workflowRunId: quote.workflowRunId,
            revisionRef: quote.revisionRef,
            threadId: request.threadId,
            checked,
          });
        expect(await tick(true)).toMatchObject({ status: 'recorded', checked: true });
        const events = await db
          .select()
          .from(workEvent)
          .where(eq(workEvent.type, 'joint_rooms.checked'));
        expect(events.at(-1)).toMatchObject({
          actorUserId: 'user-ropperman',
          value: { workflowRunId: quote.workflowRunId, revisionRef: quote.revisionRef },
        });
        const pdf = await api.workstation.qualifiedQuoteProposalPdf(pdfInput(quote));
        expect(pdf).toMatchObject({ revisionId: quote.revisionRef, totalMinor: quote.totalMinor });
        expect(await api.workstation.quoteWorkbook(pdfInput(quote))).toMatchObject({
          revisionId: quote.revisionRef,
        });
        expect(await api.drafts.saveReply(reply)).toMatchObject({ id: expect.any(String) });

        await tick(false);
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(pdfInput(quote)),
        ).rejects.toMatchObject(refused);
        await expect(api.workstation.quoteWorkbook(pdfInput(quote))).rejects.toMatchObject(refused);
        await expect(api.drafts.saveReply(reply)).rejects.toMatchObject(refused);
        // A reply that carries no quote run is not a quote reply; a run that is not this user's is refused.
        expect(await api.drafts.saveReply({ ...reply, quoteRuns: [] })).toMatchObject({
          id: expect.any(String),
        });
        await expect(
          api.drafts.saveReply({
            ...reply,
            quoteRuns: [{ workflowRunId: randomUUID(), revisionRef: quote.revisionRef }],
          }),
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Proposal source not found',
        });
      });
    });

    it('carries the flag and the recorded check through the prior-quote-for-booking path', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db, { workItem: true }),
          api = caller();
        const quote = await api.workstation.executeStaffQuote(request.input);
        const prior = () =>
          api.workstation.usePriorQuoteForBooking({
            workflowRunId: quote.workflowRunId,
            revisionRef: quote.revisionRef,
            threadId: request.threadId,
            messageId: request.mail.id,
            selectionEpoch: 1,
            inputRevision: 1,
            analysis: analysis(),
          });
        expect(await prior()).toMatchObject({
          status: 'ready',
          poolBasis: 'property_room_type',
          jointRoomsChecked: false,
        });
        await api.workstation.recordJointRoomsCheck({
          workflowRunId: quote.workflowRunId,
          revisionRef: quote.revisionRef,
          threadId: request.threadId,
          checked: true,
        });
        expect(await prior()).toMatchObject({
          status: 'ready',
          poolBasis: 'property_room_type',
          jointRoomsChecked: true,
        });
      });
    });

    it('needs no check when HMS gives the building, and cannot record one without a work item', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db, 'MAIN');
        const built = await seedRequest(db, { workItem: true }),
          api = caller();
        const quote = await api.workstation.executeStaffQuote(built.input);
        expect(quote).not.toHaveProperty('poolBasis');
        expect(await api.workstation.qualifiedQuoteProposalPdf(pdfInput(quote))).toMatchObject({
          revisionId: quote.revisionRef,
        });
        await expect(
          api.workstation.recordJointRoomsCheck({
            workflowRunId: quote.workflowRunId,
            revisionRef: quote.revisionRef,
            threadId: built.threadId,
            checked: true,
          }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'joint_rooms_check_not_needed' });

        installFixture(db);
        const bare = await seedRequest(db, { workItem: false });
        const flagged = await api.workstation.executeStaffQuote(bare.input);
        await expect(
          api.workstation.recordJointRoomsCheck({
            workflowRunId: flagged.workflowRunId,
            revisionRef: flagged.revisionRef,
            threadId: bare.threadId,
            checked: true,
          }),
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'joint_rooms_check_unavailable',
        });
      });
    });

    it('scopes the saved reply to the runs it carries: an old unticked date run does not block a ticked new one', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db, { workItem: true }),
          api = caller();
        const old = await api.workstation.executeStaffQuote(
          onDates(request.input, 1, '2026-11-12', '2026-11-14'),
        );
        const current = await api.workstation.executeStaffQuote(
          onDates(request.input, 2, '2026-11-13', '2026-11-15'),
        );
        await api.workstation.recordJointRoomsCheck({
          workflowRunId: current.workflowRunId,
          revisionRef: current.revisionRef,
          threadId: request.threadId,
          checked: true,
        });
        const reply = (run: { workflowRunId: string; revisionRef: string }) => ({
          threadId: request.threadId,
          replyToMessageId: request.mail.id,
          html: '<p>Your quote.</p>',
          quoteRuns: [{ workflowRunId: run.workflowRunId, revisionRef: run.revisionRef }],
        });
        expect(await api.workstation.qualifiedQuoteProposalPdf(pdfInput(current))).toMatchObject({
          revisionId: current.revisionRef,
        });
        expect(await api.drafts.saveReply(reply(current))).toMatchObject({
          id: expect.any(String),
        });
        await expect(api.drafts.saveReply(reply(old))).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'joint_rooms_unchecked',
        });
      });
    });

    it('a tick on an earlier run does not carry to a new run of the same stay', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db, { workItem: true }),
          api = caller();
        const first = await api.workstation.executeStaffQuote(request.input);
        await api.workstation.recordJointRoomsCheck({
          workflowRunId: first.workflowRunId,
          revisionRef: first.revisionRef,
          threadId: request.threadId,
          checked: true,
        });
        const rerun = await api.workstation.executeStaffQuote({
          ...request.input,
          inputRevision: 2,
        });
        expect(rerun.workflowRunId).not.toBe(first.workflowRunId);
        await expect(
          api.workstation.qualifiedQuoteProposalPdf(pdfInput(rerun)),
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'joint_rooms_unchecked',
        });
      });
    });

    it('a combined quote needs the tick on every flagged stay', async () => {
      await withSeededTestDb(async (db) => {
        installFixture(db);
        const request = await seedRequest(db, { workItem: true }),
          api = caller();
        const november = await api.workstation.executeStaffQuote(
          onDates(request.input, 1, '2026-11-12', '2026-11-14'),
        );
        const december = await api.workstation.executeStaffQuote(
          onDates(request.input, 2, '2026-12-01', '2026-12-03'),
        );
        const combined = {
          ...pdfInput(november),
          additionalStays: [
            {
              workflowRunId: december.workflowRunId,
              revisionRef: december.revisionRef,
              factRefs: [],
            },
          ],
        };
        const tick = (run: { workflowRunId: string; revisionRef: string }) =>
          api.workstation.recordJointRoomsCheck({
            workflowRunId: run.workflowRunId,
            revisionRef: run.revisionRef,
            threadId: request.threadId,
            checked: true,
          });
        const refused = { code: 'PRECONDITION_FAILED', message: 'joint_rooms_unchecked' };
        await tick(november);
        await expect(api.workstation.qualifiedQuoteProposalPdf(combined)).rejects.toMatchObject(
          refused,
        );
        await expect(api.workstation.quoteWorkbook(combined)).rejects.toMatchObject(refused);
        const reply = {
          threadId: request.threadId,
          replyToMessageId: request.mail.id,
          html: '<p>Your quote.</p>',
          quoteRuns: [november, december].map((run) => ({
            workflowRunId: run.workflowRunId,
            revisionRef: run.revisionRef,
          })),
        };
        await expect(api.drafts.saveReply(reply)).rejects.toMatchObject(refused);
        await tick(december);
        expect(await api.workstation.qualifiedQuoteProposalPdf(combined)).toMatchObject({
          revisionId: expect.stringMatching(/^quotes:/),
        });
        expect(await api.workstation.quoteWorkbook(combined)).toMatchObject({
          revisionId: expect.stringMatching(/^quotes:/),
        });
        expect(await api.drafts.saveReply(reply)).toMatchObject({ id: expect.any(String) });
      });
    });
  },
);
