import { describe, expect, it } from 'vitest';
import {
  resolveNativeRoomCodes,
  staffQuoteGroupsFromStay,
} from '../lib/quote-workflow/staff-quote-bind';
import {
  HRDAV_PROPERTY_CODE,
  HRDAV_RATE_PLANS,
  HRDAV_ROOM_NAMES,
  hrdavBoardFromLabel,
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
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Queen' })).toEqual({
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
    expect(hrdavBoardFromLabel('Bed & Breakfast NR')).toBe('bb');
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
});
