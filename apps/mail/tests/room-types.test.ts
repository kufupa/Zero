import * as roomTypes from '../lib/quote-workflow/room-types';
import { HRDAV_ROOM_NAMES } from '../lib/quote-workflow/types';
import { describe, expect, it } from 'vitest';

type RoomTypeMatch = { code?: string; suggestions: string[] };
type RoomTypeMatcher = (raw: string | undefined) => RoomTypeMatch;

const matchRoomType = (roomTypes as unknown as { matchRoomType?: RoomTypeMatcher }).matchRoomType;

describe('room type name matching', () => {
  it.each([
    [undefined, { suggestions: [] }],
    ['Standard Queen', { code: 'STQN', suggestions: [] }],
    ['standard queen room', { code: 'STQN', suggestions: [] }],
    ['Standard-Queens!', { code: 'STQN', suggestions: [] }],
    ['Standard RoomQueen Bed', { code: 'STQN', suggestions: [] }],
    ['queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['suite room', { code: 'SUITE', suggestions: [] }],
    ['standard room', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['Standard room', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['standard rooms', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['STANDARD ROOM', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['Single', { suggestions: ['STWN', 'SKNG'] }],
    ['Single Occupancy', { suggestions: ['STWN', 'SKNG'] }],
    ['Single beds', { suggestions: ['STWN', 'SKNG'] }],
    ['one bedroom', { suggestions: [] }],
    ['Double room', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['Double Occupancy', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['Twin', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Double/Twin', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Twin sharing', { suggestions: ['STWN', 'DLXTWN'] }],
    ['twin sharing', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Twin share', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Standard Twin Rooms - double occupancy', { code: 'STWN', suggestions: [] }],
    ['Standard Twin Room - FO', { suggestions: [] }],
    ['Standard Single Rooms', { suggestions: ['STWN', 'SKNG', 'STQN'] }],
    ['Deluxe Single', { suggestions: ['DLXTWN', 'DLXQN', 'DLXKNG'] }],
    ['standard twin room (with two double beds)', { code: 'STWN', suggestions: [] }],
    ['Standard Twin with two beds and double occupancy per person', { code: 'STWN', suggestions: [] }],
    ['Executive King room', { code: 'EXKNG', suggestions: [] }],
    ['deluxe twin', { code: 'DLXTWN', suggestions: [] }],
    ['luxury king', { code: 'LUXKNG', suggestions: [] }],
    ['double', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['singles', { suggestions: ['STWN', 'SKNG'] }],
    ['king', { suggestions: ['SKNG', 'EXKNG', 'DLXKNG'] }],
    ['Executive King', { code: 'EXKNG', suggestions: [] }],
    ['garbage', { suggestions: [] }],
    ['single twin', { suggestions: ['STWN', 'DLXTWN'] }],
    ['double queen', { suggestions: ['STQN', 'DLXQN'] }],
  ] as const)('matches %s without guessing an ambiguous code', (raw, expected) => {
    expect(matchRoomType, 'room type matcher is exported').toBeTypeOf('function');
    if (!matchRoomType) return;
    expect(matchRoomType(raw)).toEqual(expected);
  });

  it('accepts unambiguous room names anywhere a native code is expected', () => {
    expect(roomTypes.knownRoomCode('Standard Queen')).toBe('STQN');
    expect(roomTypes.knownRoomCode('queen')).toBeNull();
    expect(roomTypes.knownRoomCode('STQN')).toBe('STQN');
    expect(roomTypes.knownRoomCode('stqn!')).toBe('STQN');
  });

  it('caps ambiguous suggestions at three ranked room types', () => {
    expect(matchRoomType?.('king').suggestions).toHaveLength(3);
  });

  it('matches HRDAV labels and abbreviations against that property list', () => {
    const rooms = Object.entries(HRDAV_ROOM_NAMES).map(([code, label]) => ({ code, label }));
    expect(roomTypes.matchConfiguredRoomType(['STD TWN'], rooms)?.code).toBe('STWN');
    expect(roomTypes.matchConfiguredRoomType(['Deluxe Patio'], rooms)?.code).toBe('DLXPAT');
    expect(roomTypes.matchConfiguredRoomType(['Standard King'], rooms)?.code).toBe('STKNG');
    expect(roomTypes.matchConfiguredRoomType(['STD SGL'], rooms)).toBeNull();
  });
});
