import { describe, expect, it } from 'vitest';
import { ROOM_TYPE_NAMES as SERVER_ROOM_TYPE_NAMES, matchRoomType as matchServerRoomType } from '../src/ai/room-types.js';
import {
  ROOM_TYPE_NAMES as MAIL_ROOM_TYPE_NAMES,
  matchRoomType as matchMailRoomType,
} from '../../mail/lib/quote-workflow/room-types';

describe('server/mail room matcher parity', () => {
  it('keeps the code-to-name map identical', () => {
    expect(SERVER_ROOM_TYPE_NAMES).toEqual(MAIL_ROOM_TYPE_NAMES);
  });

  it('agrees on every pair of vocabulary words, not only the sampled inputs below', () => {
    const vocabulary = ['standard', 'twin', 'queen', 'king', 'deluxe', 'executive', 'luxury', 'suite', 'double', 'single', 'room', 'bed', 'queens', 'garbage', 'STQN', ''];
    const inputs = vocabulary.flatMap((first) => vocabulary.map((second) => `${first} ${second}`.trim()));
    for (const raw of [...vocabulary, ...inputs]) {
      expect(matchServerRoomType(raw), raw).toEqual(matchMailRoomType(raw));
    }
  });

  it.each([
    [undefined, { suggestions: [] }],
    ['Standard Queen', { code: 'STQN', suggestions: [] }],
    ['standard queen room', { code: 'STQN', suggestions: [] }],
    ['Standard-Queens!', { code: 'STQN', suggestions: [] }],
    ['standard room', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['Standard room', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['standard rooms', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['STANDARD ROOM', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['double', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['Double/Twin', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Twin sharing', { suggestions: ['STWN', 'DLXTWN'] }],
    ['twin sharing', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Twin share', { suggestions: ['STWN', 'DLXTWN'] }],
    ['Single Occupancy', { suggestions: ['STWN', 'SKNG'] }],
    ['Double Occupancy', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['one bedroom', { suggestions: [] }],
    ['Single beds', { suggestions: ['STWN', 'SKNG'] }],
    ['Standard Twin Rooms - double occupancy', { code: 'STWN', suggestions: [] }],
    ['Standard Twin Room - FO', { suggestions: [] }],
    ['Standard Single Rooms', { suggestions: ['STWN', 'SKNG', 'STQN'] }],
    ['Deluxe Single', { suggestions: ['DLXTWN', 'DLXQN', 'DLXKNG'] }],
    ['standard twin room (with two double beds)', { code: 'STWN', suggestions: [] }],
    ['Standard Twin with two beds and double occupancy per person', { code: 'STWN', suggestions: [] }],
    ['singles', { suggestions: ['STWN', 'SKNG'] }],
    ['king', { suggestions: ['SKNG', 'EXKNG', 'DLXKNG'] }],
    ['Executive King', { code: 'EXKNG', suggestions: [] }],
    ['garbage', { suggestions: [] }],
  ] as const)('matches %s without guessing', (raw, expected) => {
    expect(matchServerRoomType(raw)).toEqual(expected);
    expect(matchServerRoomType(raw)).toEqual(matchMailRoomType(raw));
  });

  it.each([
    ['1 x double', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['1 x single', { suggestions: ['STWN', 'SKNG'] }],
    ['1 x queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['1 x king', { suggestions: ['SKNG', 'EXKNG', 'DLXKNG'] }],
    ['1 x twin', { suggestions: ['STWN', 'DLXTWN'] }],
    ['1 x standard', { suggestions: ['STWN', 'STQN', 'SKNG'] }],
    ['1 x deluxe', { suggestions: ['DLXTWN', 'DLXQN', 'DLXKNG'] }],
  ] as const)(
    'normalizes count prefix for ambiguous phrase %s without selecting a code',
    (raw, expected) => {
      expect(matchServerRoomType(raw)).toEqual(expected);
      expect(matchServerRoomType(raw)).toEqual(matchMailRoomType(raw));
    },
  );

  it('keeps Centurion Standard King on SKNG when no property profile is passed', () => {
    expect(matchServerRoomType('Standard King')).toEqual({ code: 'SKNG', suggestions: [] });
    expect(matchServerRoomType('Standard King')).toEqual(matchMailRoomType('Standard King'));
  });

  it('maps HRDAV abbreviations and labels onto that profile, not Centurion codes', () => {
    expect(matchServerRoomType('STD TWN', 'HRDAV')).toEqual({ code: 'STWN', suggestions: [] });
    expect(matchServerRoomType('Deluxe Patio', 'HRDAV')).toEqual({ code: 'DLXPAT', suggestions: [] });
    expect(matchServerRoomType('Standard King', 'HRDAV')).toEqual({ code: 'STKNG', suggestions: [] });
    expect(matchServerRoomType('STD SGL', 'HRDAV')).toEqual({ suggestions: ['STWN', 'STKNG'] });
    expect(matchServerRoomType('Twin', 'HRDAV')).toEqual({ suggestions: ['STWN'] });
    expect(matchServerRoomType('SUITE', 'HRDAV')).toEqual({ suggestions: ['JNRSUI'] });
    expect(matchServerRoomType('Standard King')).toEqual({ code: 'SKNG', suggestions: [] });
  });
});
