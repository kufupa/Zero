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
    ['Standard Queen', { code: 'STQN', suggestions: [] }],
    ['standard queen room', { code: 'STQN', suggestions: [] }],
    ['Standard-Queens!', { code: 'STQN', suggestions: [] }],
    ['queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['double', { suggestions: ['STQN', 'SKNG', 'EXKNG'] }],
    ['singles', { suggestions: ['STWN', 'SKNG'] }],
    ['king', { suggestions: ['SKNG', 'EXKNG', 'DLXKNG'] }],
    ['Executive King', { code: 'EXKNG', suggestions: [] }],
    ['garbage', { suggestions: [] }],
  ] as const)('matches %s without guessing', (raw, expected) => {
    expect(matchServerRoomType(raw)).toEqual(expected);
    expect(matchServerRoomType(raw)).toEqual(matchMailRoomType(raw));
  });
});
