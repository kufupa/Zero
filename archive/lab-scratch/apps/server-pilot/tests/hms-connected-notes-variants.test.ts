import {
  runConnectedNotesVariants,
  type ConnectedNotesVariantReadResult,
  type ConnectedNotesVariantRequest,
} from '../src/hms/connected-notes-variants.js';
import { observeNotesTraces } from '../../../../../apps/server-pilot/src/hms/live-notes-traces-read-driver.js';
import {
  parseNotesInquiryResponse,
  type NotesInquiryResponseFixture,
} from '../src/hms/notes-inquiry-read-facade.js';
import {
  parseNotesTracesResponse,
  type NotesTracesParentBinding,
} from '../src/hms/notes-traces-read-facade.js';
import { describe, expect, it } from 'vitest';

const resourceRef = 'reservation:bound-notes';

function result(
  overrides: Partial<ConnectedNotesVariantReadResult> = {},
): ConnectedNotesVariantReadResult {
  return {
    status: 'ok',
    completeness: 'complete',
    scopeRef: resourceRef,
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    evidence: [{ sourceHash: 'a'.repeat(64) }],
    unavailableSections: [],
    issues: [],
    ...overrides,
  };
}

const driverParent: NotesTracesParentBinding = {
  propertyCode: 'HRCEN',
  confirmationNumber: 'CONF-NOTES-VARIANTS',
  reservationStayId: 'STAY-NOTES-VARIANTS',
  resourceRef,
};

const driverAuthorization: Parameters<typeof observeNotesTraces>[0] = {
  toolId: 'hms_read_notes_traces',
  discoveryOperationId: 'notes_traces_list',
  requestBranchId: 'notes_traces_list',
  operationId: '00000000-0000-4000-8000-000000000099',
  releaseId: 'release-notes-variants',
  manifest: {} as never,
  manifestSha256: 'a'.repeat(64),
  roleProofPath: '/tmp/role',
  roleProofSha256: 'b'.repeat(64),
  credentialVersionHmacSha256: 'c'.repeat(64),
  runtimeFingerprintSha256: 'd'.repeat(64),
  privateDigestKeyVersion: 'v1',
  sourceRevision: 'notes-variants-driver-test',
  expiresAt: '2099-01-01T00:10:00.000Z',
};

function driverNotePayload(count = 2): NotesInquiryResponseFixture {
  const note = (id: number) => ({
    id,
    note: `driver-note-${id}`,
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
  });
  return {
    noteCategories: [{ code: 'GEN', description: 'Synthetic category' }],
    reservationNotes: Array.from({ length: count }, (_, index) => note(index + 1)),
    guestProfileNotes: [],
    bookingAgencyNotes: [],
    organizationNotes: [],
    groupBookingNotes: null,
    reservationNote: '',
  };
}

function driverEmptyTracesBody(): string {
  return `prefix pageData: {
    values: {
      confirmationnumber: "${driverParent.confirmationNumber}",
      reservationstayid: "${driverParent.reservationStayId}",
      propertycode: "${driverParent.propertyCode}",
    },
    grid: { GRIDRESULT: { type: "LIST.HEAD_DATA.STORED", DATASPY: { id: "1777", label: "All Records", }, GRID: {
      METADATA: {
        REQUEST_TYPE_META: "LIST.HEAD_DATA.STORED",
        RECORDS: "0",
        CLIENTROWS: "50",
        MORERECORDPRESENT: "-",
        CURRENTCURSORPOSITION: "0",
        DATASPYID: "1777",
        GRIDID: "1662",
        GRIDNAME: "OSGSTR",
      },
      FIELDS: { FIELD: [{ name: "traceid", label: "Trace", }, { name: "reservationstayid", },], },
      DATA: [],
    }, }, },
  } }`;
}

async function actualDriverRead(
  request: ConnectedNotesVariantRequest,
  noteCount = 2,
): Promise<ConnectedNotesVariantReadResult> {
  const read = await observeNotesTraces(
    driverAuthorization,
    request,
    new AbortController().signal,
    {
      expectedParentBinding: driverParent,
      notesInquiryFor: async (input) => ({
        ...parseNotesInquiryResponse(driverNotePayload(noteCount), {
          audience: input.audience,
          limit: 50,
        }),
        parentBinding: driverParent,
      }),
      notesTracesFor: async () => ({
        ...parseNotesTracesResponse(driverEmptyTracesBody(), {
          parentBinding: driverParent,
          limit: 50,
        }),
        parentBinding: driverParent,
      }),
    },
  );
  return read as unknown as ConnectedNotesVariantReadResult;
}

describe('bounded connected notes variants', () => {
  it('runs staff/customer all-state probes and staff limit-one continuation', async () => {
    const requests: ConnectedNotesVariantRequest[] = [];
    let pagingCall = 0;
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) => {
        requests.push(request);
        if (request.audience !== 'staff' || request.limit !== 1) return result();
        pagingCall += 1;
        return pagingCall === 1
          ? result({
              status: 'partial',
              completeness: 'partial',
              issues: [{ code: 'PARTIAL_WINDOW' }],
              page: { returnedCount: 1, hasMore: true, nextCursor: 'cursor-1' },
            })
          : result({ page: { returnedCount: 1, hasMore: false, nextCursor: null } });
      },
    });

    expect(variants.map((variant) => variant.variant)).toEqual([
      'staff_all_states',
      'customer_all_states',
      'staff_limit1_paging',
      'staff_open_only',
      'staff_completed_only',
    ]);
    expect(requests.slice(0, 2)).toEqual([
      { resourceRef, audience: 'staff', states: ['open', 'completed'], limit: 20 },
      { resourceRef, audience: 'customer', states: ['open', 'completed'], limit: 20 },
    ]);
    expect(requests.slice(2)).toEqual([
      { resourceRef, audience: 'staff', states: ['open', 'completed'], limit: 1 },
      {
        resourceRef,
        audience: 'staff',
        states: ['open', 'completed'],
        limit: 1,
        cursor: 'cursor-1',
      },
      { resourceRef, audience: 'staff', states: ['open'], limit: 20 },
      { resourceRef, audience: 'staff', states: ['completed'], limit: 20 },
    ]);
    expect(variants[2]?.stopReason).toBe('exhausted');
    expect(variants[2]?.calls.map((call) => call.request.cursorPresent)).toEqual([false, true]);
    expect(variants.slice(3).map((variant) => variant.stopReason)).toEqual([
      'single_page',
      'single_page',
    ]);
  });

  it('stops paging on source failure without claiming exhaustion', async () => {
    const requests: ConnectedNotesVariantRequest[] = [];
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) => {
        requests.push(request);
        if (request.limit === 20) return result();
        return result({
          status: 'manual_required',
          completeness: 'unknown',
          page: null,
          issues: [{ code: 'SOURCE_UNAVAILABLE' }],
        });
      },
    });

    expect(requests).toHaveLength(5);
    expect(variants[2]?.stopReason).toBe('source_failure');
    expect(variants[2]?.calls).toHaveLength(1);
    expect(variants[2]?.calls[0]?.completeness).toBe('unknown');
  });

  it('stops on repeated and stale cursors', async () => {
    const repeated = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) =>
        request.limit === 20
          ? result()
          : result({
              status: 'partial',
              completeness: 'partial',
              issues: [{ code: 'PARTIAL_WINDOW' }],
              page: { returnedCount: 1, hasMore: true, nextCursor: request.cursor ?? 'same' },
            }),
    });
    expect(repeated[2]?.stopReason).toBe('repeated_cursor');
    expect(repeated[2]?.calls).toHaveLength(2);

    let staleCall = 0;
    const stale = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) => {
        if (request.limit === 20) return result();
        staleCall += 1;
        return staleCall === 1
          ? result({
              status: 'partial',
              completeness: 'partial',
              issues: [{ code: 'PARTIAL_WINDOW' }],
              page: { returnedCount: 1, hasMore: true, nextCursor: 'cursor-1' },
            })
          : result({
              status: 'manual_required',
              completeness: 'unknown',
              page: null,
              issues: [{ code: 'STALE_EVIDENCE' }],
            });
      },
    });
    expect(stale[2]?.stopReason).toBe('cursor_mismatch');
    expect(stale[2]?.calls).toHaveLength(2);
  });

  it('does not call an ok partial source exhausted, including single-page probes', async () => {
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async () =>
        result({
          status: 'ok',
          completeness: 'partial',
          page: { returnedCount: 0, hasMore: false, nextCursor: null },
        }),
    });

    expect(variants.slice(0, 2).map((variant) => variant.stopReason)).toEqual([
      'source_incomplete',
      'source_incomplete',
    ]);
    expect(variants.slice(0, 2).map((variant) => variant.status)).toEqual([
      'manual_required',
      'manual_required',
    ]);
    expect(variants[2]).toMatchObject({
      stopReason: 'source_incomplete',
      status: 'manual_required',
    });
    expect(variants.every((variant) => variant.stopReason !== 'exhausted')).toBe(true);
  });

  it('does not call a contradictory partial terminal page exhausted', async () => {
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async () =>
        result({
          status: 'partial',
          completeness: 'complete',
          page: { returnedCount: 0, hasMore: false, nextCursor: null },
        }),
    });

    expect(variants[2]).toMatchObject({
      status: 'partial',
      stopReason: 'source_incomplete',
    });
    expect(variants[2]?.stopReason).not.toBe('exhausted');
  });

  it('does not call an ok result with no page a valid single page', async () => {
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async () => result({ page: null }),
    });

    expect(variants.slice(0, 2)).toMatchObject([
      { status: 'manual_required', stopReason: 'source_incomplete' },
      { status: 'manual_required', stopReason: 'source_incomplete' },
    ]);
  });

  it('continues the real driver partial window only with its valid cursor', async () => {
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: actualDriverRead,
    });

    expect(variants.slice(0, 2)).toMatchObject([
      { status: 'ok', stopReason: 'single_page' },
      { status: 'ok', stopReason: 'single_page' },
    ]);
    expect(variants[2]).toMatchObject({
      status: 'ok',
      stopReason: 'exhausted',
    });
    expect(variants[2]?.calls).toHaveLength(2);
    expect(variants[2]?.calls[0]).toMatchObject({
      status: 'partial',
      completeness: 'partial',
      page: { hasMore: true },
      unavailableSections: [],
      issueCodes: ['PARTIAL_WINDOW'],
    });
  });

  it('rejects malformed partial continuations and unknown status', async () => {
    const malformed = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) =>
        request.limit === 20
          ? result()
          : result({
              status: 'partial',
              completeness: 'partial',
              issues: [{ code: 'PARTIAL_WINDOW' }, { code: 'TRUNCATED' }],
              page: { returnedCount: 1, hasMore: true, nextCursor: 'cursor-1' },
            }),
    });
    expect(malformed[2]).toMatchObject({
      status: 'partial',
      stopReason: 'source_incomplete',
    });
    expect(malformed[2]?.calls).toHaveLength(1);

    const unknown = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) =>
        request.limit === 20
          ? result()
          : result({ status: 'unknown', completeness: 'complete' }),
    });
    expect(unknown[2]).toMatchObject({
      status: 'unknown',
      stopReason: 'source_failure',
    });
  });

  it('keeps a real driver single-page continuation partial', async () => {
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: (request) => actualDriverRead(request, 21),
    });

    expect(variants.slice(0, 2)).toMatchObject([
      { status: 'partial', stopReason: 'single_page' },
      { status: 'partial', stopReason: 'single_page' },
    ]);
    expect(variants[0]?.calls[0]).toMatchObject({
      completeness: 'partial',
      page: { hasMore: true },
      unavailableSections: [],
      issueCodes: ['PARTIAL_WINDOW'],
    });
  });

  it('enforces the six-call paging ceiling', async () => {
    let pagingCall = 0;
    const variants = await runConnectedNotesVariants({
      resourceRef,
      execute: async (request) => {
        if (request.limit === 20) return result();
        pagingCall += 1;
        return result({
          status: 'partial',
          completeness: 'partial',
          issues: [{ code: 'PARTIAL_WINDOW' }],
          page: { returnedCount: 1, hasMore: true, nextCursor: `cursor-${pagingCall}` },
        });
      },
    });

    expect(variants[2]?.calls).toHaveLength(6);
    expect(variants[2]?.stopReason).toBe('max_calls');
  });
});
