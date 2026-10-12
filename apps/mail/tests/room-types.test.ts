import * as roomTypes from '../lib/quote-workflow/room-types';
import { describe, expect, it } from 'vitest';

type RoomTypeMatch = { code?: string; suggestions: string[] };
type RoomTypeMatcher = (raw: string | undefined) => RoomTypeMatch;

const matchRoomType = (roomTypes as unknown as { matchRoomType?: RoomTypeMatcher }).matchRoomType;

describe('room type name matching', () => {
  it.each([
    ['Standard Queen', { code: 'STQN', suggestions: [] }],
    ['standard queen room', { code: 'STQN', suggestions: [] }],
    ['Standard-Queens!', { code: 'STQN', suggestions: [] }],
    ['queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['double', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['singles', { suggestions: ['STWN', 'SKNG'] }],
    ['king', { suggestions: ['SKNG', 'EXKNG', 'DLXKNG'] }],
    ['Executive King', { code: 'EXKNG', suggestions: [] }],
    ['garbage', { suggestions: [] }],
  ] as const)('matches %s without guessing an ambiguous code', (raw, expected) => {
    expect(matchRoomType, 'room type matcher is exported').toBeTypeOf('function');
    if (!matchRoomType) return;
    expect(matchRoomType(raw)).toEqual(expected);
  });

  it('accepts unambiguous room names anywhere a native code is expected', () => {
    expect(roomTypes.knownRoomCode('Standard Queen')).toBe('STQN');
    expect(roomTypes.knownRoomCode('STQN')).toBe('STQN');
    expect(roomTypes.knownRoomCode('stqn!')).toBe('STQN');
    expect(roomTypes.knownRoomCode('queen')).toBeNull();
  });

  it('caps ambiguous suggestions at three ranked room types', () => {
    expect(matchRoomType?.('king').suggestions).toHaveLength(3);
  });
});
