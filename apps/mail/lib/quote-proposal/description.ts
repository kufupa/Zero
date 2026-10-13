import { ROOM_TYPE_NAMES } from '../quote-workflow/room-types';

export const QUOTE_MEALS = ['dinner_bb', 'bb', 'room_only'] as const;
export type QuoteMeal = (typeof QUOTE_MEALS)[number];

const CLASS_BY_CODE: Record<string, string> = { ...ROOM_TYPE_NAMES };

const MEAL_LABEL: Record<QuoteMeal, string> = {
  dinner_bb: 'Dinner Bed & Breakfast',
  bb: 'Bed & Breakfast',
  room_only: 'Room Only',
};

export function occupancyRoomCode(kind: 'single' | 'twin'): 'STQN' | 'STWN' {
  return kind === 'single' ? 'STQN' : 'STWN';
}

export function proposalDescription(roomCode: string, meal: QuoteMeal): string {
  const klass = CLASS_BY_CODE[roomCode.trim().toUpperCase()];
  if (!klass) throw new Error(`unknown room code: ${roomCode}`);
  return `${klass} room ${MEAL_LABEL[meal]}`;
}
