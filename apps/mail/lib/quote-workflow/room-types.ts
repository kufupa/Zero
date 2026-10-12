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
  // Rank common room suggestions first. "Single" stays ambiguous, but does not suggest unrelated deluxe/suite types.
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularRoomWord)
    .filter((word) => !IGNORED_ROOM_WORDS.has(word));
}

/** Match an email/LLM room label without choosing between multiple HMS codes. */
export function matchRoomType(raw: string | undefined): RoomTypeMatch {
  const code = raw?.trim().replace(/[^a-z0-9]/gi, '').toUpperCase() ?? '';
  if (Object.hasOwn(ROOM_TYPE_NAMES, code)) return { code: code as RoomTypeCode, suggestions: [] };
  if (!raw?.trim()) return { suggestions: [] };

  const words = roomWords(raw);
  if (!words.length || words.some((word) => !MATCHABLE_ROOM_WORDS.has(word) && !Object.hasOwn(ROOM_WORD_ALIASES, word))) {
    return { suggestions: [] };
  }

  const candidates = ROOM_TYPE_CODES.filter((candidate) => {
    const nameWords = ROOM_TYPE_NAMES[candidate].toLowerCase().split(' ');
    return words.every((word) => {
      const aliases = ROOM_WORD_ALIASES[word];
      if (aliases) return aliases.includes(candidate);
      return nameWords.includes(word);
    });
  });

  if (candidates.length === 1) return { code: candidates[0]!, suggestions: [] };
  return { suggestions: candidates.slice(0, MAX_ROOM_TYPE_SUGGESTIONS) };
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

/** "Standard Queen (STQN)" for a known code. An unknown code comes back unchanged. */
export function roomTypeLabel(code: string): string {
  const known = knownRoomCode(code);
  return known ? `${ROOM_TYPE_NAMES[known]} (${known})` : code;
}
