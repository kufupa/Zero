import { describe, expect, it, vi } from 'vitest';
import {
  parseNotesInquiryResponse,
  type NotesInquiryResponseFixture,
} from '../src/hms/notes-inquiry-read-facade.js';
import {
  parseNotesTracesResponse,
  type NotesTracesParentBinding,
} from '../src/hms/notes-traces-read-facade.js';
import { observeNotesTraces } from '../../../../../apps/server-pilot/src/hms/live-notes-traces-read-driver.js';
import { HmsRuntimeError } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { executeRead, type ReadExecutionContext } from '../../../../../apps/server-pilot/src/hms/read-service.js';

const resourceRef = 'paging-resource';
const parent: NotesTracesParentBinding = {
  propertyCode: 'HRCEN',
  confirmationNumber: 'CONF-PAGING',
  reservationStayId: 'STAY-PAGING',
  resourceRef,
};

const authorization = {
  toolId: 'hms_read_notes_traces' as const,
  discoveryOperationId: 'notes_traces_list' as const,
  requestBranchId: 'notes_traces_list',
  operationId: '00000000-0000-4000-8000-000000000099',
  releaseId: 'release-notes',
  manifest: {} as never,
  manifestSha256: 'a'.repeat(64),
  roleProofPath: '/tmp/role',
  roleProofSha256: 'b'.repeat(64),
  credentialVersionHmacSha256: 'c'.repeat(64),
  runtimeFingerprintSha256: 'd'.repeat(64),
  privateDigestKeyVersion: 'v1',
  sourceRevision: 'notes-paging-test',
  expiresAt: '2099-01-01T00:10:00.000Z',
};

const detailValues = {
  confirmationnumber: parent.confirmationNumber,
  reservationstayid: parent.reservationStayId,
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'SYNTH-ACCOUNT',
  guestid: 'SYNTH-GUEST',
  hoteldate: '2026-09-17',
  lastname: 'Paging',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
};

function noteRow(
  id: number,
  overrides: Partial<NotesInquiryResponseFixture['reservationNotes'][number]> = {},
) {
  return {
    id,
    note: `synthetic-note-${id}`,
    categoryCode: 'GEN',
    categoryDescription: 'Synthetic category',
    sourceCode: 'RES',
    sourceDescription: 'Reservation',
    propertyCode: 'HRCEN',
    propertyDescription: 'Synthetic property',
    displayOnCheckin: false,
    printOnConfirmation: true,
    printOnRegistration: false,
    printOnHouseKeeping: false,
    displayOnCheckout: false,
    displayOnCreateUpdateReservation: false,
    displayOnReservationRetrieval: true,
    private: false,
    ...overrides,
  };
}

function notesPayload(
  rows: NotesInquiryResponseFixture['reservationNotes'] = [],
  reservationNote = '',
): NotesInquiryResponseFixture {
  return {
    noteCategories: [{ code: 'GEN', description: 'Synthetic category' }],
    reservationNotes: rows,
    guestProfileNotes: [],
    bookingAgencyNotes: [],
    organizationNotes: [],
    groupBookingNotes: null,
    reservationNote,
  };
}

function tracesBody(
  rows: Array<Record<string, unknown>> = [],
  binding: NotesTracesParentBinding = parent,
): string {
  return `prefix pageData: {
    values: {
      confirmationnumber: "${binding.confirmationNumber}",
      reservationstayid: "${binding.reservationStayId}",
      propertycode: "${binding.propertyCode}",
    },
    grid: { GRIDRESULT: { type: "LIST.HEAD_DATA.STORED", DATASPY: { id: "1777", label: "All Records", }, GRID: {
      METADATA: {
        REQUEST_TYPE_META: "LIST.HEAD_DATA.STORED",
        RECORDS: "${rows.length}",
        CLIENTROWS: "50",
        MORERECORDPRESENT: "-",
        CURRENTCURSORPOSITION: "${rows.length}",
        DATASPYID: "1777",
        GRIDID: "1662",
        GRIDNAME: "OSGSTR",
      },
      FIELDS: { FIELD: [{ name: "traceid", label: "Trace", }, { name: "reservationstayid", }, { name: "completed", }, { name: "cancelled", },], },
      DATA: ${JSON.stringify(rows)},
    }, }, },
  } }`;
}

function traceRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    traceid: `TRACE-${id}`,
    reservationstayid: parent.reservationStayId,
    tracedetails: `synthetic-trace-${id}`,
    topic: 'Synthetic topic',
    description: 'Synthetic description',
    created: '2026-09-17T09:00:00',
    duedate: '2026-09-18',
    tracedeliverymethod: 'EMAIL',
    tracestatus: 'UNMAPPED_STATUS',
    completed: false,
    cancelled: false,
    ...overrides,
  };
}

function noteProvider(
  rows: NotesInquiryResponseFixture['reservationNotes'] = [],
  reservationNote = '',
  audience: 'staff' | 'customer' = 'staff',
  binding: NotesTracesParentBinding = parent,
) {
  const parsed = parseNotesInquiryResponse(notesPayload(rows, reservationNote), {
    audience,
    limit: 50,
  });
  return { ...parsed, parentBinding: binding };
}

function traceProvider(
  rows: Array<Record<string, unknown>> = [],
  binding: NotesTracesParentBinding = parent,
) {
  return {
    ...parseNotesTracesResponse(tracesBody(rows, binding), { parentBinding: binding, limit: 50 }),
    parentBinding: binding,
  };
}

function input(overrides: Partial<Parameters<typeof observeNotesTraces>[1]> = {}) {
  return {
    resourceRef,
    states: ['open'] as ('open' | 'completed')[],
    limit: 1,
    audience: 'staff' as const,
    ...overrides,
  };
}

function readContext(
  handler: NonNullable<ReadExecutionContext['handlers']>['readNotesTraces'],
): ReadExecutionContext {
  return {
    transportId: 'transport-paging',
    mailboxId: 'mailbox-paging',
    threadId: 'thread-paging',
    triggerMessageId: 'message-paging',
    propertyCode: parent.propertyCode,
    parentRef: resourceRef,
    branchId: 'notes_traces_list',
    releaseId: 'release-paging',
    requester: {
      authorizationId: 'authorization-paging',
      transportId: 'transport-paging',
      threadId: 'thread-paging',
      triggerMessageId: 'message-paging',
      allowedClaimKinds: ['notes_trace_observation'],
      expiresAt: '2099-01-01T00:10:00.000Z',
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date('2026-09-17T12:00:00.000Z'),
    handlers: { readNotesTraces: handler },
  };
}

function providers(
  notes: ReturnType<typeof noteProvider>,
  traces: ReturnType<typeof traceProvider>,
) {
  return {
    notesInquiryFor: vi.fn(async () => notes),
    notesTracesFor: vi.fn(async () => traces),
    expectedParentBinding: parent,
  };
}

describe('bounded combined notes/traces paging', () => {
  it('keeps customer trace-only data in the explicit wrapper accepted by read-service', async () => {
    const result = await executeRead(
      readContext(async ({ audience, cursor, limit, resourceRef: requestedResourceRef, states }) =>
        observeNotesTraces(
          authorization,
          {
            resourceRef: requestedResourceRef,
            states: states as ('open' | 'completed')[],
            limit,
            cursor,
            audience,
          },
          new AbortController().signal,
          {
            expectedParentBinding: parent,
            notesTracesFor: async () => traceProvider([traceRow(1)]),
          },
        ),
      ),
      {
        toolId: 'hms_read_notes_traces',
        resourceRef,
        states: ['open'],
        limit: 1,
        audience: 'customer',
      },
    );

    expect(result.data?.traces).toMatchObject({ state: 'available' });
  });

  it.each(['PARENT_MISMATCH', 'SCOPE_DENIED'] as const)(
    'keeps paired TRC provider %s denied before projecting successful inquiry',
    async (code) => {
      const result = await observeNotesTraces(
        authorization,
        input({ limit: 20 }),
        new AbortController().signal,
        {
          expectedParentBinding: parent,
          notesInquiryFor: async () => noteProvider([noteRow(1)]),
          notesTracesFor: async () => {
            throw new HmsRuntimeError(code, 'synthetic TRC scope failure');
          },
        },
      );

      expect(result.status).toBe('manual_required');
      expect(result.completeness).toBe('unknown');
      expect(result.unavailableSections).toEqual([
        { section: 'notes', reasonCode: 'SCOPE_DENIED' },
        { section: 'traces', reasonCode: 'SCOPE_DENIED' },
      ]);
      expect(result.evidence[0]?.scopeVerified).toBe(false);
    },
  );

  it.each(['PARENT_MISMATCH', 'SCOPE_DENIED'] as const)(
    'fails closed when TRC %s throws while inquiry succeeds without a source pair',
    async (code) => {
      const result = await observeNotesTraces(
        authorization,
        input({ limit: 20 }),
        new AbortController().signal,
        {
          expectedParentBinding: parent,
          notesTracesFor: async () => {
            throw new HmsRuntimeError(code, 'synthetic legacy TRC scope failure');
          },
          notesInquiryFor: async () => noteProvider([noteRow(1)]),
        },
      );

      expect(result.status).toBe('manual_required');
      expect(result.completeness).toBe('unknown');
      expect(result.unavailableSections).toEqual([
        { section: 'notes', reasonCode: 'SCOPE_DENIED' },
        { section: 'traces', reasonCode: 'SCOPE_DENIED' },
      ]);
      expect(result.evidence[0]?.scopeVerified).toBe(false);
    },
  );

  it('retains all validated source rows past provider page 50', () => {
    const notes = noteProvider(Array.from({ length: 51 }, (_, index) => noteRow(index + 1)));
    expect(notes.items).toHaveLength(50);
    expect(notes.allItems).toHaveLength(51);
    expect(notes.sourceCount).toBe(51);
  });

  it('pages combined notes and traces after audience/state filtering', async () => {
    const options = providers(
      noteProvider(Array.from({ length: 51 }, (_, index) => noteRow(index + 1))),
      traceProvider([traceRow(1)]),
    );
    const first = await observeNotesTraces(
      authorization,
      input(),
      new AbortController().signal,
      options,
    );

    expect(first.status).toBe('partial');
    expect(first.page.returnedCount).toBe(1);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toMatch(/^ntc1:/);
    expect(first.unavailableSections).toEqual([]);

    const second = await observeNotesTraces(
      authorization,
      input({ cursor: first.page.nextCursor! }),
      new AbortController().signal,
      options,
    );
    expect(options.notesInquiryFor).toHaveBeenCalledTimes(2);
    expect(options.notesTracesFor).toHaveBeenCalledTimes(2);
    expect(second.page.returnedCount).toBe(1);
    expect(second.data?.notes).not.toEqual(first.data?.notes);

    const end = await observeNotesTraces(
      authorization,
      input({ cursor: first.page.nextCursor!.replace(/:\d+$/, ':52') }),
      new AbortController().signal,
      options,
    );
    expect(end.status).toBe('ok');
    expect(end.completeness).toBe('complete');
    expect(end.page).toEqual({ returnedCount: 0, hasMore: false, nextCursor: null });
  });

  it('returns ok/complete for two proven complete empty sources', async () => {
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      providers(noteProvider(), traceProvider()),
    );
    expect(result.status).toBe('ok');
    expect(result.completeness).toBe('complete');
    expect(result.unavailableSections).toEqual([]);
    expect(result.page).toEqual({ returnedCount: 0, hasMore: false, nextCursor: null });
  });

  it('does not claim complete when one provider is missing or malformed', async () => {
    const missing = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      { notesInquiryFor: async () => noteProvider(), expectedParentBinding: parent },
    );
    expect(missing.completeness).not.toBe('complete');
    expect(missing.status).not.toBe('ok');

    const malformed = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      {
        notesInquiryFor: async () => { throw new Error('synthetic malformed'); },
        expectedParentBinding: parent,
      },
    );
    expect(malformed.completeness).not.toBe('complete');
    expect(malformed.status).toBe('manual_required');

    const oversized = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      {
        notesInquiryFor: async () => { throw new HmsRuntimeError('SIZE_LIMIT', 'synthetic bound'); },
        notesTracesFor: async () => traceProvider(),
        expectedParentBinding: parent,
      },
    );
    expect(oversized.status).toBe('partial');
    expect(oversized.completeness).toBe('partial');
    expect(oversized.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SIZE_LIMIT' },
      { section: 'traces', reasonCode: 'SIZE_LIMIT' },
    ]);
  });

  it('withholds scalar for customer and keeps masked/long source partial', async () => {
    const notes = noteProvider([
      noteRow(1, { note: '[REDACTED]' }),
      noteRow(2, { note: 'x'.repeat(2_001) }),
    ], 'synthetic-staff-scalar');
    const staff = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      providers(notes, traceProvider()),
    );
    expect(staff.status).toBe('partial');
    expect(JSON.stringify(staff)).toContain('synthetic-staff-scalar');
    const customerNotes = noteProvider([
      noteRow(1, { note: '[REDACTED]' }),
      noteRow(2, { note: 'x'.repeat(2_001) }),
    ], 'synthetic-staff-scalar', 'customer');
    const customer = await observeNotesTraces(
      authorization,
      input({ audience: 'customer', limit: 20 }),
      new AbortController().signal,
      providers(customerNotes, traceProvider()),
    );
    expect(JSON.stringify(customer)).not.toContain('synthetic-staff-scalar');
    expect(customer.completeness).toBe('partial');
  });

  it('marks unknown trace state partial instead of complete empty', async () => {
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      providers(noteProvider(), traceProvider([traceRow(1, { completed: null, cancelled: null })])),
    );
    expect(result.completeness).toBe('partial');
    expect(result.data?.traces).toMatchObject({ state: 'partial' });
    expect(result.page.hasMore).toBeNull();
  });

  it('rejects malformed, stale, scope-changed, and out-of-range cursors closed', async () => {
    const options = {
      expectedParentBinding: parent,
      notesInquiryFor: vi.fn(async (request: Parameters<typeof observeNotesTraces>[1]) =>
        noteProvider([noteRow(1), noteRow(2)], '', request.audience)),
      notesTracesFor: vi.fn(async () => traceProvider()),
    };
    const first = await observeNotesTraces(
      authorization,
      input(),
      new AbortController().signal,
      options,
    );
    const cursor = first.page.nextCursor!;
    const malformed = await observeNotesTraces(
      authorization,
      input({ cursor: 'bad-cursor' }),
      new AbortController().signal,
      options,
    );
    expect(malformed.status).toBe('manual_required');

    const changedAudience = await observeNotesTraces(
      authorization,
      input({ cursor, audience: 'customer' }),
      new AbortController().signal,
      options,
    );
    expect(changedAudience.status).toBe('manual_required');
    expect(changedAudience.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'STALE_EVIDENCE' },
      { section: 'traces', reasonCode: 'STALE_EVIDENCE' },
    ]);

    const changedScope = await observeNotesTraces(
      authorization,
      input({ cursor, resourceRef: 'other-resource' }),
      new AbortController().signal,
      options,
    );
    expect(changedScope.status).toBe('manual_required');

    const changedStates = await observeNotesTraces(
      authorization,
      input({ cursor, states: ['completed'] }),
      new AbortController().signal,
      options,
    );
    expect(changedStates.status).toBe('manual_required');

    const offset = cursor.replace(/:\d+$/, ':999');
    const outOfRange = await observeNotesTraces(
      authorization,
      input({ cursor: offset }),
      new AbortController().signal,
      options,
    );
    expect(outOfRange.status).toBe('manual_required');
  });

  it('requires trusted parent binding for provider branches', async () => {
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      {
        notesInquiryFor: async () => noteProvider(),
        notesTracesFor: async () => traceProvider(),
      },
    );

    expect(result.status).toBe('manual_required');
    expect(result.completeness).toBe('unknown');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SCOPE_DENIED' },
      { section: 'traces', reasonCode: 'SCOPE_DENIED' },
    ]);
    expect(result.evidence[0]?.scopeVerified).toBe(false);
  });

  it.each(['PARENT_MISMATCH', 'SCOPE_DENIED'] as const)(
    'keeps combined provider %s denied without fallback',
    async (code) => {
      const detailDumpFor = vi.fn(async () => {
        throw new Error('scope failure must not reach detail fallback');
      });
      const result = await observeNotesTraces(
        authorization,
        input({ limit: 20 }),
        new AbortController().signal,
        {
          expectedParentBinding: parent,
          notesInquiryFor: async () => {
            throw { code };
          },
          notesTracesFor: async () => traceProvider(),
          detailDumpFor,
        },
      );

      expect(detailDumpFor).not.toHaveBeenCalled();
      expect(result.status).toBe('manual_required');
      expect(result.completeness).toBe('unknown');
      expect(result.unavailableSections).toEqual([
        { section: 'notes', reasonCode: 'SCOPE_DENIED' },
        { section: 'traces', reasonCode: 'SCOPE_DENIED' },
      ]);
      expect(result.evidence[0]?.scopeVerified).toBe(false);
    },
  );

  it('rejects both-provider results with wrong parent IDs even when resource matches', async () => {
    const wrongParent: NotesTracesParentBinding = {
      ...parent,
      confirmationNumber: 'WRONG-CONF',
      reservationStayId: 'WRONG-STAY',
    };
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      providers(noteProvider([], '', 'staff', wrongParent), traceProvider([], wrongParent)),
    );

    expect(result.status).toBe('manual_required');
    expect(result.completeness).toBe('unknown');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SCOPE_DENIED' },
      { section: 'traces', reasonCode: 'SCOPE_DENIED' },
    ]);
    expect(result.evidence[0]?.scopeVerified).toBe(false);
  });

  it('rejects trusted binding whose resource scope differs from the request', async () => {
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20 }),
      new AbortController().signal,
      {
        expectedParentBinding: { ...parent, resourceRef: 'other-resource' },
        notesInquiryFor: async () => noteProvider(),
        notesTracesFor: async () => traceProvider(),
      },
    );

    expect(result.status).toBe('manual_required');
    expect(result.completeness).toBe('unknown');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SCOPE_DENIED' },
      { section: 'traces', reasonCode: 'SCOPE_DENIED' },
    ]);
    expect(result.evidence[0]?.scopeVerified).toBe(false);
  });

  it('rejects a notes result parsed for the wrong audience instead of claiming staff complete', async () => {
    const privateRow = noteRow(99, { private: true, printOnConfirmation: false });
    const result = await observeNotesTraces(
      authorization,
      input({ limit: 20, audience: 'staff' }),
      new AbortController().signal,
      providers(noteProvider([privateRow], '', 'customer'), traceProvider()),
    );

    expect(result.status).toBe('manual_required');
    expect(result.completeness).toBe('unknown');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SCOPE_DENIED' },
      { section: 'traces', reasonCode: 'SCOPE_DENIED' },
    ]);
    expect(result.evidence[0]?.scopeVerified).toBe(false);
  });
});
