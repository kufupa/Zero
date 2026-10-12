/**
 * Server-side mirror of apps/mail/lib/quote-workflow/room-types.ts. These apps do not share a helper package; keep
 * behavior aligned with the parity test rather than importing across production app boundaries.
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

/** Match an email/extraction room label without choosing between multiple HMS codes. */
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

  // Bed words ("single", "double") only rank. They never narrow a name to one code: "single twin" fits Standard and
  // Deluxe Twin, so it stays a suggestion. An exact code needs the name words alone to fit one type.
  const aliasWords = words.filter((word) => Object.hasOwn(ROOM_WORD_ALIASES, word));
  const nameOnly = words.filter((word) => !Object.hasOwn(ROOM_WORD_ALIASES, word));
  const candidates = ROOM_TYPE_CODES.filter((candidate) => {
    if (!nameOnly.length) return aliasWords.some((word) => ROOM_WORD_ALIASES[word]!.includes(candidate));
    const nameWords = ROOM_TYPE_NAMES[candidate].toLowerCase().split(' ');
    return nameOnly.every((word) => nameWords.includes(word));
  });

  if (candidates.length === 1) return { code: candidates[0]!, suggestions: [] };
  const rank = (candidate: RoomTypeCode) => {
    const fits = aliasWords.length > 0 && aliasWords.every((word) => ROOM_WORD_ALIASES[word]!.includes(candidate));
    return fits ? ROOM_WORD_ALIASES[aliasWords[0]!]!.indexOf(candidate) : 100 + ROOM_TYPE_CODES.indexOf(candidate);
  };
  return { suggestions: [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ROOM_TYPE_SUGGESTIONS) };
}
