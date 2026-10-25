import { HRDAV_PROPERTY_CODE, quotePropertyIdentity } from './filename.js';

export const QUOTE_MEALS = ['dinner_bb', 'bb', 'room_only'] as const;
export type QuoteMeal = (typeof QUOTE_MEALS)[number];

/** HRCEN gold labels. Shared codes DLXKNG/STWN are this property's product, not HRDAV's. */
const HRCEN_CLASS_BY_CODE: Record<string, string> = {
  DLXKNG: 'Deluxe',
  DLXQN: 'Deluxe',
  DLXTWN: 'Deluxe',
  LUXKNG: 'Luxury',
  SUITE: 'Suite',
  SKNG: 'Standard King',
  EXKNG: 'Executive',
  STQN: 'Single',
  STWN: 'Twin',
};

/** D0 HRDAV BAR shop labels. Same code as HRCEN is a different product. */
const HRDAV_CLASS_BY_CODE: Record<string, string> = {
  JNRSUI: 'Junior Suite',
  EXKNGB: 'Executive King Balcony',
  EXKNGR: 'Executive King Round',
  EXKNGS: 'Executive King Square',
  DLXPAT: 'Deluxe Patio',
  DLXKNG: 'Deluxe King',
  ACCES: 'Accessible',
  STKNG: 'Standard King',
  STWN: 'Standard Twin',
};

const MEAL_LABEL: Record<QuoteMeal, string> = {
  dinner_bb: 'Dinner Bed & Breakfast',
  bb: 'Bed & Breakfast',
  room_only: 'Room Only',
};

function classByCode(propertyCode: string): Record<string, string> {
  quotePropertyIdentity(propertyCode);
  return propertyCode === HRDAV_PROPERTY_CODE ? HRDAV_CLASS_BY_CODE : HRCEN_CLASS_BY_CODE;
}

export function proposalDescription(
  roomCode: string,
  meal: QuoteMeal,
  propertyCode: string,
): string {
  const klass = classByCode(propertyCode)[roomCode.trim().toUpperCase()];
  if (!klass) throw new Error(`unknown room code: ${roomCode}`);
  return `${klass} room ${MEAL_LABEL[meal]}`;
}
