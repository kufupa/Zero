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
const ROOM_WORD_ALIASES: Record<string, readonly string[]> = {
  double: ['queen', 'king'],
  // Occupancy does not identify a native room type; keep all options ambiguous for staff to choose.
  single: ['twin', 'queen', 'king', 'suite'],
};

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

  const candidates = ROOM_TYPE_CODES.filter((candidate) => {
    const nameWords = ROOM_TYPE_NAMES[candidate].toLowerCase().split(' ');
    return words.every((word) => {
      const aliases = ROOM_WORD_ALIASES[word];
      if (aliases) return aliases.some((alias) => nameWords.includes(alias));
      return nameWords.includes(word);
    });
  });

  if (candidates.length === 1) return { code: candidates[0]!, suggestions: [] };
  return { suggestions: candidates };
}
