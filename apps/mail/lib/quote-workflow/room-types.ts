/**
 * The Centurion room types HMS knows, by native code. This is the one code-to-name map: the builder's room select,
 * the known-code check (staff-quote-bind) and the "Standard Queen (STQN)" label all read it.
 */
const ROOM_TYPE_NAMES = {
  STWN: 'Standard Twin',
  STQN: 'Standard Queen',
  SKNG: 'Standard King',
  EXKNG: 'Executive King',
  DLXTWN: 'Deluxe Twin',
  DLXQN: 'Deluxe Queen',
  DLXKNG: 'Deluxe King',
  LUXKNG: 'Luxury King',
  SUITE: 'Suite',
} as const;

export type RoomTypeCode = keyof typeof ROOM_TYPE_NAMES;

/** Every known code, in the order the builder lists them. */
export const ROOM_TYPE_CODES = Object.keys(ROOM_TYPE_NAMES) as RoomTypeCode[];

/** The exact native code for a raw value (trimmed, upper-cased), or null when HMS does not know it. */
export function knownRoomCode(raw: string | undefined): RoomTypeCode | null {
  const code = raw?.trim().toUpperCase() ?? '';
  return Object.hasOwn(ROOM_TYPE_NAMES, code) ? (code as RoomTypeCode) : null;
}

/** "Standard Queen (STQN)" for a known code. An unknown code comes back unchanged. */
export function roomTypeLabel(code: string): string {
  const known = knownRoomCode(code);
  return known ? `${ROOM_TYPE_NAMES[known]} (${known})` : code;
}
