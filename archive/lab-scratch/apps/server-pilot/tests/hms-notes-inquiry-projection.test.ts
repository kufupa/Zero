import { describe, expect, it } from 'vitest';
import {
  parseNotesInquiryResponse,
  type NotesInquiryReadResult,
  type NotesInquiryResponseFixture,
} from '../src/hms/notes-inquiry-read-facade.js';
import { projectNotesInquiryResult } from '../src/hms/notes-inquiry-projection.js';

const parent = {
  propertyCode: 'HRCEN' as const,
  confirmationNumber: 'CONF-PROJECTION',
  reservationStayId: 'STAY-PROJECTION',
  resourceRef: 'notes-resource-projection',
};

function row(
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
    printOnConfirmation: false,
    printOnRegistration: false,
    printOnHouseKeeping: false,
    displayOnCheckout: false,
    displayOnCreateUpdateReservation: false,
    displayOnReservationRetrieval: true,
    private: false,
    ...overrides,
  };
}

function source(): NotesInquiryResponseFixture {
  return {
    noteCategories: [{ code: 'GEN', description: 'Synthetic category' }],
    reservationNotes: [
      row(1),
      row(2, { private: true, note: 'synthetic-private-note' }),
    ],
    guestProfileNotes: [],
    bookingAgencyNotes: [],
    organizationNotes: [],
    groupBookingNotes: null,
    reservationNote: 'synthetic-scalar-reservation-note',
  };
}

function result(audience: 'staff' | 'customer'): NotesInquiryReadResult {
  return {
    ...parseNotesInquiryResponse(source(), { audience }),
    parentBinding: parent,
  };
}

const projectionInput = {
  resourceRef: parent.resourceRef,
  evidenceRef: 'notes-evidence-projection',
  observedAt: new Date('2099-01-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T00:05:00.000Z'),
  limit: 20,
};

describe('projectNotesInquiryResult', () => {
  it('projects staff two rows plus distinct scalar with stable refs', () => {
    const first = projectNotesInquiryResult(result('staff'), {
      ...projectionInput,
      audience: 'staff',
    });
    const second = projectNotesInquiryResult(result('staff'), {
      ...projectionInput,
      audience: 'staff',
    });
    expect(first.data.notes).toMatchObject({ items: expect.any(Array) });
    if ('items' in first.data.notes) {
      expect(first.data.notes.items).toHaveLength(3);
      expect(first.data.notes.items[0]?.permittedText).toMatchObject({
        state: 'known',
      });
      expect(first.data.notes.items[1]?.customerPrintable).toMatchObject({
        value: false,
      });
      expect(first.data.notes.items[2]?.sourceKind).toMatchObject({
        value: 'reservation_note',
      });
      expect(first.data.notes.items[2]?.customerPrintable).toMatchObject({
        state: 'unknown',
        reasonCode: 'NOT_APPLICABLE',
      });
      expect(first.data.notes.items[2]?.status).toMatchObject({
        state: 'unknown',
        reasonCode: 'NOT_APPLICABLE',
      });
      expect(first.data.notes.items[2]?.authorLabel).toMatchObject({
        state: 'unknown',
        reasonCode: 'NOT_APPLICABLE',
      });
      expect(first.data.notes.items.map((item) => item.noteRef)).toEqual(
        second.data.notes && 'items' in second.data.notes
          ? second.data.notes.items.map((item) => item.noteRef)
          : [],
      );
    }
  });

  it('projects customer audience as empty when rows are non-printable/private', () => {
    const projected = projectNotesInquiryResult(result('customer'), {
      ...projectionInput,
      audience: 'customer',
    });
    expect(projected.data.notes).toEqual({
      items: [],
      page: { returnedCount: 0, hasMore: false, nextCursor: null },
    });
    expect(JSON.stringify(projected)).not.toContain('synthetic-private-note');
    expect(JSON.stringify(projected)).not.toContain('synthetic-scalar-reservation-note');
  });

  it('rejects provider result bound to another resource scope', () => {
    expect(() =>
      projectNotesInquiryResult(
        {
          ...result('staff'),
          parentBinding: { ...parent, resourceRef: 'other-resource' },
        },
        { ...projectionInput, audience: 'staff' },
      ),
    ).toThrowError(/SCOPE_MISMATCH/);
  });
});
