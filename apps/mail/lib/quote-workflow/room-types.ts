/**
 * The Centurion room types HMS knows, by native code. This is the one code-to-name map: the builder's room select,
 * the known-code check (staff-quote-bind) and the "Standard Queen (STQN)" label all read it.
 */
export const ROOM_TYPE_NAMES = {
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
export type RoomTypeMatch = { code?: RoomTypeCode; suggestions: RoomTypeCode[] };

/** Every known code, in the order the builder lists them. */
export const ROOM_TYPE_CODES = Object.keys(ROOM_TYPE_NAMES) as RoomTypeCode[];

const IGNORED_ROOM_WORDS = new Set(['room', 'bedroom', 'bed', 'type']);
const MATCHABLE_ROOM_WORDS = new Set(
  Object.values(ROOM_TYPE_NAMES).flatMap((name) => name.toLowerCase().split(' ')),
);
const ROOM_WORD_ALIASES: Record<string, readonly RoomTypeCode[]> = {
  // Keep low-information occupancy terms as choices.
  double: ['STQN', 'SKNG', 'EXKNG'],
  single: ['STWN', 'SKNG'],
};

const MAX_ROOM_TYPE_SUGGESTIONS = 3;

function singularRoomWord(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function roomWords(raw: string): string[] {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Split before lowercasing so lost line breaks do not glue room-name words together.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularRoomWord)
    .filter((word) => !IGNORED_ROOM_WORDS.has(word));
}

/**
 * Match room labels from email/LLM text. Select confident types; leave ambiguous asks as suggestions.
 */
export function matchRoomType(raw: string | undefined): RoomTypeMatch {
  const code = raw?.trim().replace(/[^a-z0-9]/gi, '').toUpperCase() ?? '';
  if (Object.hasOwn(ROOM_TYPE_NAMES, code)) return { code: code as RoomTypeCode, suggestions: [] };
  if (!raw?.trim()) return { suggestions: [] };

  const words = roomWords(raw);
  if (
    !words.length ||
    words.some((word) => !MATCHABLE_ROOM_WORDS.has(word) && !Object.hasOwn(ROOM_WORD_ALIASES, word))
  ) {
    return { suggestions: [] };
  }

  // "Single" and "double" only rank; "single twin" still fits Standard and Deluxe Twin.
  const aliasWords = words.filter(
    (word) => Object.hasOwn(ROOM_WORD_ALIASES, word) && !MATCHABLE_ROOM_WORDS.has(word),
  );
  const nameWords = words.filter((word) => MATCHABLE_ROOM_WORDS.has(word));
  const candidates = ROOM_TYPE_CODES.filter((candidate) => {
    if (!nameWords.length) {
      return aliasWords.some((word) => ROOM_WORD_ALIASES[word]!.includes(candidate));
    }
    const candidateWords = ROOM_TYPE_NAMES[candidate].toLowerCase().split(' ');
    return nameWords.every((word) => candidateWords.includes(word));
  });

  if (candidates.length === 1) return { code: candidates[0]!, suggestions: [] };
  const rank = (candidate: RoomTypeCode) => {
    const fits = aliasWords.length > 0 && aliasWords.every((word) => ROOM_WORD_ALIASES[word]!.includes(candidate));
    return fits ? ROOM_WORD_ALIASES[aliasWords[0]!]!.indexOf(candidate) : 100 + ROOM_TYPE_CODES.indexOf(candidate);
  };
  return { suggestions: [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ROOM_TYPE_SUGGESTIONS) };
}

/** The exact native code for a raw code or an unambiguous room name, or null when unknown/ambiguous. */
export function knownRoomCode(raw: string | undefined): RoomTypeCode | null {
  const code = raw?.trim().replace(/[^a-z0-9]/gi, '').toUpperCase() ?? '';
  return Object.hasOwn(ROOM_TYPE_NAMES, code) ? (code as RoomTypeCode) : (matchRoomType(raw).code ?? null);
}

/**
 * The room a row quotes. Staff picks win: a rate-card pick (roomCodes), then the select's value (roomPreference).
 * The server's projected roomTypeCode is only the fallback, so a stale projection never overrides a pick.
 */
export function rowRoomTypeCode(row: {
  roomTypeCode?: RoomTypeCode;
  roomCodes?: string[];
  roomPreference?: string;
}): RoomTypeCode | null {
  return (
    (row.roomCodes?.length === 1 ? knownRoomCode(row.roomCodes[0]) : null) ??
    knownRoomCode(row.roomPreference) ??
    row.roomTypeCode ??
    null
  );
}

/** A staff-facing row name: the room type and the number of rooms, never an ordinal room number. */
export function rowRoomLabel(row: {
  roomTypeCode?: RoomTypeCode;
  roomCodes?: string[];
  roomPreference?: string;
  quantity?: number | null;
}): string {
  const code = rowRoomTypeCode(row);
  const raw = code ? ROOM_TYPE_NAMES[code] : row.roomPreference?.trim();
  const type = raw && !/^room\s+\d+$/i.test(raw)
    ? raw.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    : 'Room type needed';
  const count = typeof row.quantity === 'number' && row.quantity > 0 ? row.quantity : '?';
  return `${type} ×${count}`;
}

/** "Standard Queen (STQN)" for a known code. An unknown code comes back unchanged. */
export function roomTypeLabel(code: string): string {
  const known = knownRoomCode(code);
  return known ? `${ROOM_TYPE_NAMES[known]} (${known})` : code;
}
