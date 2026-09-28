import { describe, expect, it, vi } from 'vitest';
import { parseNotesInquiryResponse, type NotesInquiryReadResult } from '../src/hms/notes-inquiry-read-facade.js';
import { observeNotesTraces } from '../../../../../apps/server-pilot/src/hms/live-notes-traces-read-driver.js';
import { notesTracesContextDataSchema } from '../../../../../apps/server-pilot/src/hms/context-read-contracts.js';
import { HmsRuntimeError } from '../../../../../apps/server-pilot/src/hms/runtime.js';

const resourceRef = 'notes-resource-provider';
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
  sourceRevision: 'notes-test',
  expiresAt: '2099-01-01T00:10:00.000Z',
};

function source() {
  return {
    noteCategories: [{ code: 'GEN', description: 'Synthetic category' }],
    reservationNotes: [
      {
        id: 1,
        note: 'synthetic-staff-note',
        categoryCode: 'GEN',
        categoryDescription: 'Synthetic category',
        sourceCode: 'RES',
        sourceDescription: 'Reservation',
        propertyCode: 'HRCEN',
        propertyDescription: 'Synthetic property',
        displayOnCheckin: false,
        printOnConfirmation: false,
        printOnRegistration: false,
        printOnHouseKeeping: false,
        displayOnCheckout: false,
        displayOnCreateUpdateReservation: false,
        displayOnReservationRetrieval: true,
        private: false,
      },
      {
        id: 2,
        note: 'synthetic-private-note',
        categoryCode: 'GEN',
        categoryDescription: 'Synthetic category',
        sourceCode: 'RES',
        sourceDescription: 'Reservation',
        propertyCode: 'HRCEN',
        propertyDescription: 'Synthetic property',
        displayOnCheckin: false,
        printOnConfirmation: false,
        printOnRegistration: false,
        printOnHouseKeeping: false,
        displayOnCheckout: false,
        displayOnCreateUpdateReservation: false,
        displayOnReservationRetrieval: true,
        private: true,
      },
    ],
    guestProfileNotes: [],
    bookingAgencyNotes: [],
    organizationNotes: [],
    groupBookingNotes: null,
    reservationNote: 'synthetic-scalar-note',
  };
}

function providerResult(audience: 'staff' | 'customer', scope = resourceRef): NotesInquiryReadResult {
  return {
    ...parseNotesInquiryResponse(source(), { audience }),
    parentBinding: {
      propertyCode: 'HRCEN',
      confirmationNumber: 'CONF-PROVIDER',
      reservationStayId: 'STAY-PROVIDER',
      resourceRef: scope,
    },
  };
}

function input(audience: 'staff' | 'customer') {
  return { resourceRef, states: ['open'] as ('open' | 'completed')[], limit: 20, audience };
}

const expectedParentBinding = {
  propertyCode: 'HRCEN' as const,
  confirmationNumber: 'CONF-PROVIDER',
  reservationStayId: 'STAY-PROVIDER',
  resourceRef,
};

describe('live notes inquiry provider branch', () => {
  it('returns three typed staff notes and traces remain unavailable', async () => {
    const notesInquiryFor = vi.fn(async () => providerResult('staff'));
    const detailDumpFor = vi.fn(async () => {
      throw new Error('legacy stagehand path must not run');
    });
    const result = await observeNotesTraces(
      authorization,
      input('staff'),
      new AbortController().signal,
      { notesInquiryFor, detailDumpFor, expectedParentBinding },
    );

    expect(notesInquiryFor).toHaveBeenCalledTimes(1);
    expect(detailDumpFor).not.toHaveBeenCalled();
    expect(result.status).toBe('partial');
    expect(result.completeness).toBe('partial');
    expect(result.unavailableSections).toEqual([
      { section: 'traces', reasonCode: 'SURFACE_UNPROVEN' },
    ]);
    notesTracesContextDataSchema.parse(result.data);
    expect(result.data?.notes).toMatchObject({ items: expect.any(Array) });
    if (result.data?.notes && 'items' in result.data.notes) {
      expect(result.data.notes.items).toHaveLength(3);
      expect(result.data.notes.items[2]?.sourceKind).toMatchObject({
        value: 'reservation_note',
      });
    }
    expect(result.data?.traces).toMatchObject({
      state: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
    expect(result.issues.map((issue) => issue.code)).toContain('PARTIAL_WINDOW');
    expect(result.evidence[0]?.sourceHash).toBe(providerResult('staff').sourceHash);
  });

  it('returns zero customer notes and never leaks staff/scalar text', async () => {
    const result = await observeNotesTraces(
      authorization,
      input('customer'),
      new AbortController().signal,
      { notesInquiryFor: async () => providerResult('customer'), expectedParentBinding },
    );

    expect(result.data?.notes).toEqual({
      items: [],
      page: { returnedCount: 0, hasMore: false, nextCursor: null },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-staff-note');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-note');
    expect(JSON.stringify(result)).not.toContain('synthetic-scalar-note');
  });

  it('rejects wrong provider scope without using legacy detail path', async () => {
    const detailDumpFor = vi.fn(async () => null);
    const result = await observeNotesTraces(
      authorization,
      input('staff'),
      new AbortController().signal,
      {
        notesInquiryFor: async () => providerResult('staff', 'other-resource'),
        detailDumpFor,
        expectedParentBinding,
      },
    );

    expect(detailDumpFor).not.toHaveBeenCalled();
    expect(result.status).toBe('manual_required');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SCOPE_DENIED' },
    ]);
    expect(result.data?.traces).toMatchObject({ reasonCode: 'SURFACE_UNPROVEN' });
  });

  it.each(['PARENT_MISMATCH', 'SCOPE_DENIED'] as const)(
    'preserves provider %s as denied and never falls back',
    async (code) => {
      const detailDumpFor = vi.fn(async () => null);
      const result = await observeNotesTraces(
        authorization,
        input('staff'),
        new AbortController().signal,
        {
          expectedParentBinding,
          notesInquiryFor: async () => {
            throw new HmsRuntimeError(code, 'synthetic provider scope failure');
          },
          detailDumpFor,
        },
      );

      expect(detailDumpFor).not.toHaveBeenCalled();
      expect(result.status).toBe('manual_required');
      expect(result.completeness).toBe('unknown');
      expect(result.unavailableSections).toEqual([
        { section: 'notes', reasonCode: 'SCOPE_DENIED' },
      ]);
      expect(result.evidence[0]?.scopeVerified).toBe(false);
    },
  );
});
