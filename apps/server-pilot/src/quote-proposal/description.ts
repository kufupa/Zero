export const QUOTE_MEALS = ['dinner_bb', 'bb', 'room_only'] as const;
export type QuoteMeal = (typeof QUOTE_MEALS)[number];

const CLASS_BY_CODE: Record<string, string> = {
  DLXKNG: 'Deluxe',
  DLXQN: 'Deluxe',
  DLXTWN: 'Deluxe',
  LUXKNG: 'Luxury',
  SUITE: 'Suite',
  SKNG: 'Suite',
  EXKNG: 'Single',
  STQN: 'Single',
  STWN: 'Twin',
};

const MEAL_LABEL: Record<QuoteMeal, string> = {
  dinner_bb: 'Dinner Bed & Breakfast',
  bb: 'Bed & Breakfast',
  room_only: 'Room Only',
};

export function proposalDescription(roomCode: string, meal: QuoteMeal): string {
  const klass = CLASS_BY_CODE[roomCode.trim().toUpperCase()];
  if (!klass) throw new Error(`unknown room code: ${roomCode}`);
  return `${klass} room ${MEAL_LABEL[meal]}`;
}
