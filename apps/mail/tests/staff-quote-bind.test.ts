import { describe, expect, it, vi } from 'vitest';
import {
  bindExecuteStaffQuote,
  bindStaffQuoteStrategyRows,
  resolveNativeRoomCodes,
  staffQuoteGroupsFromStay,
} from '../lib/quote-workflow/staff-quote-bind';
import {
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  HRDAV_RATE_PLANS,
  HRDAV_ROOM_NAMES,
  hrdavBoardFromLabel,
  emptyStaffQuoteHeader,
  type QuoteSalesStrategy,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

const stay = (overrides: Partial<StayGroupRequirement> = {}): StayGroupRequirement => ({
  id: 'g1',
  arrivalDate: '2026-11-16',
  departureDate: '2026-11-17',
  quantity: 1,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: {},
  ...overrides,
});

describe('HRDAV native room and board maps', () => {
  it('resolves Da Vinci room names on HRDAV and leaves Centurion-only types unknown', () => {
    expect(resolveNativeRoomCodes({ roomPreference: 'Junior Suite', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['JNRSUI'],
    });
    expect(resolveNativeRoomCodes({ roomCodes: ['EXKNGB'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['EXKNGB'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'SUITE', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'SUITE',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Queen', propertyCode: HRCEN_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STQN'],
    });
  });

  it('keeps shared DLXKNG and STWN codes on HRDAV without using the Centurion room list as a fallback', () => {
    expect(resolveNativeRoomCodes({ roomCodes: ['DLXKNG'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['DLXKNG'],
    });
    expect(resolveNativeRoomCodes({ roomCodes: ['STWN'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
    expect(HRDAV_ROOM_NAMES.DLXKNG).toBe('Deluxe King');
    expect(HRDAV_ROOM_NAMES.STWN).toBe('Standard Twin');
    expect(HRDAV_ROOM_NAMES).not.toHaveProperty('STQN');
    expect(HRDAV_ROOM_NAMES).not.toHaveProperty('SUITE');
    const unknown = staffQuoteGroupsFromStay([stay({ roomPreference: 'PENTHOUSE', fields: {} })], HRDAV_PROPERTY_CODE);
    expect(unknown).toEqual({
      error: expect.stringMatching(/JNRSUI/),
    });
    if ('error' in unknown) {
      expect(unknown.error).not.toMatch(/STQN|SUITE|DLXTWN/);
    }
  });

  it('maps observed HRDAV board labels and leaves dinner and invented codes unknown', () => {
    expect(hrdavBoardFromLabel('Bed & Breakfast R')).toBe('bb');
    expect(hrdavBoardFromLabel(null)).toBe('unknown');
    expect(hrdavBoardFromLabel('')).toBe('unknown');
    expect(hrdavBoardFromLabel('DBB')).toBe('unknown');
    expect(hrdavBoardFromLabel('BB')).toBe('unknown');
    expect(HRDAV_RATE_PLANS.BAR.board).toBe('bb');
    expect(HRDAV_RATE_PLANS.BARRO.board).toBe('room_only');
    expect(HRDAV_RATE_PLANS.BLRB.board).toBe('unknown');
    expect(HRDAV_RATE_PLANS.BARDIS.board).toBe('unknown');
    expect(HRDAV_RATE_PLANS.DEF.board).toBe('unknown');
    expect(
      staffQuoteGroupsFromStay([stay({ board: 'dinner_bb', roomPreference: 'STKNG' })], HRDAV_PROPERTY_CODE),
    ).toEqual({
      error: expect.stringMatching(/meal plan/i),
    });
  });

  it('leaves Bed & Breakfast NR unknown instead of rewriting it to R', () => {
    expect(hrdavBoardFromLabel('Bed & Breakfast NR')).toBe('unknown');
    expect(hrdavBoardFromLabel('bed & breakfast nr')).toBe('unknown');
  });

  it('leaves a blank BARRO board unknown instead of rewriting it to room only', () => {
    expect(hrdavBoardFromLabel(null)).toBe('unknown');
    expect(hrdavBoardFromLabel('')).toBe('unknown');
  });

  it('leaves an unqualified twin unknown instead of mapping it to STWN', () => {
    expect(resolveNativeRoomCodes({ roomPreference: 'twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'twin',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
  });

  it('does not inherit a Centurion-only room alias on HRDAV', () => {
    expect(
      resolveNativeRoomCodes({
        roomPreference: 'standard queen room',
        propertyCode: HRDAV_PROPERTY_CODE,
      }),
    ).toEqual({
      status: 'unresolved',
      label: 'standard queen room',
    });
  });

  it('refuses a staff quote with no mailbox property instead of treating it as Centurion', async () => {
    const reason = /hotel.*mailbox|mailbox.*hotel/i;
    expect(staffQuoteGroupsFromStay([stay({ roomPreference: 'Standard Queen' })])).toMatchObject({
      ok: [{ roomCodes: ['STQN'] }],
    });

    const mutate = vi.fn();
    const result = await bindExecuteStaffQuote({
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) },
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay()],
      header: {} as never,
      mutate,
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(reason) });
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('staff quote strategy jobs', () => {
  it('queues one independent shop per configured strategy, BAR first, without adding missing registry rows', async () => {
    const queued: string[] = [];
    const strategies: QuoteSalesStrategy[] = [
      { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
      { code: 'PRESET', label: 'Preset', requestValue: 'PRESET' },
      { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
      { code: 'GOV', label: 'Government', requestValue: 'Government' },
      { code: 'AIR', label: 'Airline Crews', requestValue: 'AIR' },
    ];
    const queue = vi.fn(async (input: { salesStrategy: string; autoStart?: true }) => {
      queued.push(input.salesStrategy);
      return { runId: null };
    });
    const onResult = vi.fn();
    const rows = await bindStaffQuoteStrategyRows({
      mode: 'auto',
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) },
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay({ roomCodes: ['STKNG'] })],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRDAV_PROPERTY_CODE,
      stayKey: '2026-11-16:2026-11-17',
      strategies,
      queue,
      onResult,
    });
    expect(rows).toHaveLength(6);
    expect(queued).toEqual(['BAR', 'PROMO', 'PRESET', 'WS', 'Government', 'AIR']);
    expect(queued).not.toContain('NC');
    expect(queue).toHaveBeenCalledTimes(6);
    expect(queue.mock.calls.every(([input]) => input.autoStart === true)).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(6);
  });
});
