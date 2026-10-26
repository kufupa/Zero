import { describe, expect, it } from 'vitest';
import { bindExecuteStaffQuote, type ExecuteStaffQuoteInput, type ExecuteStaffQuoteResult } from '../lib/quote-workflow/staff-quote-bind';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import { formatReservationNote, reservationNoteForGroup } from '../lib/quote-workflow/reservation-note';
import {
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  type AvailabilityBoardRow,
  type StaffRowRate,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

const binding = {
  transportId: 't1',
  mailboxEmail: 'quotes@example.invalid',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };
const stay: StayGroupRequirement = {
  id: 'g1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 2,
  adults: 2,
  childrenAges: [],
  roomPreference: 'STWN',
  roomCodes: ['STWN'],
  rateCode: 'NCOR1B',
  board: 'bb',
  specialRequests: [],
  fields: {},
};
const boardRow: AvailabilityBoardRow = {
  groupId: 'g1',
  roomCode: 'STWN',
  roomLabel: 'Standard Twin',
  rateCode: 'NCOR1B',
  rateLabel: 'Corporate negotiated',
  board: 'bb',
  boardLabel: 'Bed & breakfast',
  nightlyPriceMinor: 220000,
  roomsLeft: 2,
  rateScope: 'public',
};
const rowRate: StaffRowRate = {
  groupId: 'g1',
  source: 'hms',
  hmsNightlyMinor: [215000, 225000],
  nightlyMinor: [215000, 225000],
  rateCode: 'NCOR1B',
};
const ready: ExecuteStaffQuoteResult = {
  status: 'ready',
  workflowRunId: 'run-1',
  revisionRef: 'rev-1',
  messageId: 'mail-1',
  threadId: 'thread-1',
  factRefs: [],
  selectionEpoch: 1,
  inputRevision: 1,
  inputDigest: 'digest',
  totalMinor: 880000,
  currency: 'ZAR',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  description: 'STWN NCOR1B',
};

async function currentSession() {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'quote', groups: [stay], secondaryAsks: [], alternatives: [] },
  });
  session = reduceQuoteSession(session, { type: 'staff_source_ready', source });
  session = reduceQuoteSession(session, {
    type: 'patch_group',
    groupId: 'g1',
    patch: { roomCodes: ['STWN'], rateCode: 'NCOR1B', board: 'bb' },
  });
  const stayKey = '2026-11-12:2026-11-14';
  session = reduceQuoteSession(session, {
    type: 'patch_staff_stay_extras',
    stayKey,
    extras: {
      shuttleEnabled: true,
      shuttleMinor: 12500,
      shuttleTrips: 2,
      lunchEnabled: false,
      dinnerEnabled: true,
      dinnerAllowanceMinor: 35000,
      dinnerAllowanceUnit: 'per_person_per_night',
      otherEnabled: false,
    },
  });
  const run = await bindExecuteStaffQuote({
    mutate: async (input: ExecuteStaffQuoteInput) => ({
      ...ready,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
      availabilityBoard: [boardRow],
      rowRates: [rowRate],
    }),
    source,
    selectionEpoch: binding.selectionEpoch,
    inputRevision: session.inputRevision,
    groups: session.groups,
    header: session.staffHeader,
    propertyCode: HRCEN_PROPERTY_CODE,
  });
  if (run.status !== 'ok') throw new Error(run.reason);
  session = reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer: run.offer,
    staffQuote: run.staffQuote,
    selectionEpoch: binding.selectionEpoch,
    inputRevision: session.inputRevision,
    approvedHeader: session.staffHeader,
  });
  return session;
}

describe('reservation note', () => {
  it('uses the final selected room, rate and current extras', async () => {
    const session = await currentSession();
    const note = reservationNoteForGroup(session, HRDAV_PROPERTY_CODE, 'g1');
    expect(reservationNoteForGroup(session, HRCEN_PROPERTY_CODE, 'g1')).toBe(note);
    expect(session.roomRateBoardSelections?.g1).toBeUndefined();

    expect(note).toContain('Standard Twin');
    expect(note).toContain('STWN');
    expect(note).toContain('NCOR1B');
    expect(note).toContain('Corporate negotiated');
    expect(note).toContain('Bed & breakfast');
    expect(note).toContain('ZAR 2150.00');
    expect(note).toContain('ZAR 2250.00');
    expect(note).toContain('Shuttle');
    expect(note).toContain('ZAR 125.00');
    expect(note).toContain('2 trips');
    expect(note).toContain('Dinner allowance');
    expect(note).toContain('ZAR 350.00');
    expect(note).toContain('per person per night');
  });

  it('keeps the note manual when the property is unknown or the quote is stale', async () => {
    const session = await currentSession();
    expect(reservationNoteForGroup(session, 'UNKNOWN', 'g1')).toBeNull();

    const stale = reduceQuoteSession(session, {
      type: 'patch_staff_stay_extras',
      stayKey: '2026-11-12:2026-11-14',
      extras: { shuttleMinor: 13000 },
    });
    expect(reservationNoteForGroup(stale, HRDAV_PROPERTY_CODE, 'g1')).toBeNull();

    expect(formatReservationNote({
      propertyCode: HRDAV_PROPERTY_CODE,
      stay,
      selection: { roomCode: 'STWN', rateCode: 'NCOR1B', board: 'bb' },
      availability: boardRow,
      chargedRate: rowRate,
      extras: {
        shuttleEnabled: false,
        lunchEnabled: false,
        dinnerEnabled: true,
        dinnerAllowanceRequired: true,
        otherEnabled: false,
      },
      currency: 'ZAR',
    })).toBeNull();
  });
});
