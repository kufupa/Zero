import { describe, expect, it, vi } from 'vitest';
import { createConnectedNotesSourcePair } from '../src/hms/connected-notes-source-pair.js';

const ORIGIN = 'https://hms.example';
const PARENT = {
  propertyCode: 'HRCEN' as const,
  confirmationNumber: 'CONF-PAIR',
  reservationStayId: 'STAY-PAIR',
  resourceRef: 'reservation:pair',
};

const DETAIL_VALUES = {
  confirmationnumber: PARENT.confirmationNumber,
  reservationstayid: PARENT.reservationStayId,
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'SYNTH-ACCOUNT',
  guestid: 'SYNTH-GUEST',
  hoteldate: '09/17/2026',
  lastname: 'Guest',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
} as const;

const NOTE_ROW = {
  id: 1,
  note: 'Synthetic note',
  categoryCode: 'GEN',
  categoryDescription: 'General',
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
  displayOnReservationRetrieval: false,
  private: false,
};

const NOTES_BODY = JSON.stringify({
  noteCategories: [{ code: 'GEN', description: 'General' }],
  reservationNotes: [NOTE_ROW],
  guestProfileNotes: [],
  bookingAgencyNotes: [],
  organizationNotes: [],
  groupBookingNotes: null,
  reservationNote: '',
});

const TRC_BODY = `pageData: {
  values: {
    confirmationnumber: "${PARENT.confirmationNumber}",
    reservationstayid: "${PARENT.reservationStayId}",
    propertycode: "HRCEN",
  },
  grid: { GRIDRESULT: {
    type: "LIST.HEAD_DATA.STORED",
    DATASPY: { id: "1777", label: "All Records", },
    GRID: {
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
    FIELDS: { FIELD: [{ name: "traceid", type: "VARCHAR", },], },
    DATA: [],
  }, }, },
}`;

function fakeSession(events: string[]) {
  const postJson = vi.fn(async () => {
    events.push('json');
    return NOTES_BODY;
  });
  const postForm = vi.fn(async () => {
    events.push('trc');
    return TRC_BODY;
  });
  const close = vi.fn(async () => {
    events.push('close');
  });
  return {
    origin: ORIGIN,
    page: { postJson, postForm },
    close,
    postJson,
    postForm,
  } as never;
}

describe('connected notes source pair', () => {
  it('opens once, reads JSON then TRC serially, and closes after both', async () => {
    const events: string[] = [];
    const session = fakeSession(events);
    const openSession = vi.fn(async (_signal: AbortSignal) => {
      events.push('open');
      return session;
    });
    const pair = createConnectedNotesSourcePair({
      parentBinding: PARENT,
      detailValues: DETAIL_VALUES,
      audience: 'staff',
      openSession,
    });

    const signal = new AbortController().signal;
    const [notes, traces] = await Promise.all([
      pair.notesInquiryFor({ resourceRef: PARENT.resourceRef, audience: 'staff' }, signal),
      pair.notesTracesFor({ resourceRef: PARENT.resourceRef }, signal),
    ]);

    expect(events).toEqual(['open', 'json', 'trc', 'close']);
    expect(openSession).toHaveBeenCalledOnce();
    expect(notes.parentBinding.resourceRef).toBe(PARENT.resourceRef);
    expect(traces.parentBinding.resourceRef).toBe(PARENT.resourceRef);
  });

  it('closes when the JSON source fails and never starts TRC', async () => {
    const events: string[] = [];
    const session = fakeSession(events);
    session.postJson.mockRejectedValueOnce(new Error('json failed'));
    const pair = createConnectedNotesSourcePair({
      parentBinding: PARENT,
      detailValues: DETAIL_VALUES,
      audience: 'customer',
      openSession: async () => {
        events.push('open');
        return session;
      },
    });

    await expect(
      pair.notesTracesFor({ resourceRef: PARENT.resourceRef }, new AbortController().signal),
    ).rejects.toThrow('json failed');
    expect(events).toEqual(['open', 'close']);
    expect(session.postForm).not.toHaveBeenCalled();
  });

  it('marks a provider failure on close and preserves both provider and close errors', async () => {
    const session = fakeSession([]);
    const providerError = new Error('json failed');
    const closeError = new Error('close failed');
    session.postJson.mockRejectedValueOnce(providerError);
    session.close.mockRejectedValueOnce(closeError);
    const pair = createConnectedNotesSourcePair({
      parentBinding: PARENT,
      detailValues: DETAIL_VALUES,
      audience: 'customer',
      openSession: async () => session,
    });
    const signal = new AbortController().signal;

    let thrown: unknown;
    try {
      await pair.notesTracesFor({ resourceRef: PARENT.resourceRef }, signal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([providerError, closeError]);
    expect(session.close).toHaveBeenCalledWith({
      outcome: 'failed',
      terminalCode: 'TOOL_ERROR',
      complete: false,
    });
  });

  it('rejects a second source callback that uses a different abort signal', async () => {
    const session = fakeSession([]);
    const pair = createConnectedNotesSourcePair({
      parentBinding: PARENT,
      detailValues: DETAIL_VALUES,
      audience: 'staff',
      openSession: async () => session,
    });
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;
    const firstRead = pair.notesInquiryFor(
      { resourceRef: PARENT.resourceRef, audience: 'staff' },
      firstSignal,
    );

    await expect(
      pair.notesTracesFor({ resourceRef: PARENT.resourceRef }, secondSignal),
    ).rejects.toThrow('one invocation abort signal');
    await firstRead;
  });

  it('rejects an already-aborted signal before opening or returning a cached pair', async () => {
    const session = fakeSession([]);
    const openSession = vi.fn(async () => session);
    const pair = createConnectedNotesSourcePair({
      parentBinding: PARENT,
      detailValues: DETAIL_VALUES,
      audience: 'staff',
      openSession,
    });
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      pair.notesInquiryFor({ resourceRef: PARENT.resourceRef, audience: 'staff' }, aborted.signal),
    ).rejects.toThrow('already aborted');
    expect(openSession).not.toHaveBeenCalled();

    const signal = new AbortController().signal;
    await pair.notesInquiryFor({ resourceRef: PARENT.resourceRef, audience: 'staff' }, signal);
    await expect(
      pair.notesTracesFor({ resourceRef: PARENT.resourceRef }, aborted.signal),
    ).rejects.toThrow('already aborted');
  });

  it('binds each callback and does not share a pair across invocations', async () => {
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = fakeSession(firstEvents);
    const second = fakeSession(secondEvents);
    const openSession = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const makePair = () =>
      createConnectedNotesSourcePair({
        parentBinding: PARENT,
        detailValues: DETAIL_VALUES,
        audience: 'staff',
        openSession,
      });

    await expect(
      makePair().notesInquiryFor({ resourceRef: 'reservation:other', audience: 'staff' }, new AbortController().signal),
    ).rejects.toThrow('resource scope mismatch');
    await makePair().notesTracesFor({ resourceRef: PARENT.resourceRef }, new AbortController().signal);
    await makePair().notesTracesFor({ resourceRef: PARENT.resourceRef }, new AbortController().signal);

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(firstEvents).toEqual(['json', 'trc', 'close']);
    expect(secondEvents).toEqual(['json', 'trc', 'close']);
  });
});
