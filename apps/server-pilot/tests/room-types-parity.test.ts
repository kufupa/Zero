import { describe, expect, it } from 'vitest';
import { matchRoomType as matchServerRoomType } from '../src/ai/room-types.js';
import { matchRoomType as matchMailRoomType } from '../../mail/lib/quote-workflow/room-types';

describe('server/mail room matcher parity', () => {
  it.each([
    ['Standard Queen', { code: 'STQN', suggestions: [] }],
    ['standard queen room', { code: 'STQN', suggestions: [] }],
    ['Standard-Queens!', { code: 'STQN', suggestions: [] }],
    ['queen', { suggestions: ['STQN', 'DLXQN'] }],
    ['double', { suggestions: ['STQN', 'SKNG', 'EXKNG', 'DLXQN', 'DLXKNG', 'LUXKNG'] }],
    ['singles', { suggestions: ['STWN', 'STQN', 'SKNG', 'EXKNG', 'DLXTWN', 'DLXQN', 'DLXKNG', 'LUXKNG', 'SUITE'] }],
    ['Executive King', { code: 'EXKNG', suggestions: [] }],
    ['garbage', { suggestions: [] }],
  ] as const)('matches %s without guessing', (raw, expected) => {
    expect(matchServerRoomType(raw)).toEqual(expected);
    expect(matchServerRoomType(raw)).toEqual(matchMailRoomType(raw));
  });
});
