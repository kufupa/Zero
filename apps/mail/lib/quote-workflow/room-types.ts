import { ROOM_ABBREVIATIONS, ROOM_TYPE_NAMES, ROOM_WORD_ALIASES } from '../../config/room-types.js';

export { ROOM_TYPE_NAMES };

export type RoomTypeCode = keyof typeof ROOM_TYPE_NAMES;
export type RoomTypeMatch = { code?: RoomTypeCode; suggestions: RoomTypeCode[] };

/** Normalize staff-entered labels before matching them to the active property's configured room list. */
export function normaliseRoomLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\brooms?\b/g, ' ')
    .split(/\s+/)
    .map((word) => ROOM_ABBREVIATIONS[word] ?? word)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function occupancyAliases(names: Record<string, string>): Record<string, string[]> {
  const codes = Object.keys(names);
  const withWord = (word: string) =>
    codes.filter((code) => names[code]!.toLowerCase().split(/\s+/).includes(word));
  return {
    double: [...withWord('queen'), ...withWord('king')],
    single: [...withWord('twin'), ...withWord('king')],
  };
}

function uniqueCatalogueMatch(
  raw: string,
  names: Record<string, string>,
): string | undefined {
  const aliases = occupancyAliases(names);
  const codes = Object.keys(names);
  const matchable = new Set([
    ...Object.values(names).flatMap((name) => name.toLowerCase().split(' ')),
    ...Object.keys(aliases),
  ]);
  const words = roomWords(stripRoomCountPrefix(raw));
  if (!words.length || words.some((word) => !matchable.has(word))) return undefined;
  const aliasWords = words.filter((word) => Object.hasOwn(aliases, word));
  const nameOnly = words.filter((word) => !Object.hasOwn(aliases, word));
  const candidates = codes.filter((candidate) => {
    if (!nameOnly.length) return aliasWords.some((word) => aliases[word]!.includes(candidate));
    const nameWords = names[candidate]!.toLowerCase().split(' ');
    return nameOnly.every((word) => nameWords.includes(word));
  });
  if (candidates.length !== 1) return undefined;
  const nameWords = names[candidates[0]!]!.toLowerCase().split(' ');
  return nameWords.every((word) => nameOnly.includes(word)) ? candidates[0] : undefined;
}

/** Match configured codes/labels; opt in when a profile should also accept legacy Centurion-name aliases. */
export function matchConfiguredRoomType<T extends { code: string; label: string }>(
  candidates: readonly (string | undefined)[],
  roomTypes: readonly T[],
  options: { allowCenturionRoomAliases?: boolean } = {},
): T | null {
  const names = Object.fromEntries(roomTypes.map((item) => [item.code, item.label]));
  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (!raw) continue;
    const code = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const knownCode = options.allowCenturionRoomAliases ? knownRoomCode(raw) : null;
    const label = normaliseRoomLabel(stripRoomCountPrefix(raw));
    const room = roomTypes.find(
      (item) => item.code === code || item.code === knownCode || normaliseRoomLabel(item.label) === label,
    );
    if (room) return room;
    const unique = uniqueCatalogueMatch(raw, names);
    if (unique) return roomTypes.find((item) => item.code === unique) ?? null;
  }
  return null;
}

/** Every known code, in the order the builder lists them. */
export const ROOM_TYPE_CODES = Object.keys(ROOM_TYPE_NAMES) as RoomTypeCode[];

const IGNORED_ROOM_WORDS = new Set([
  'room',
  'bedroom',
  'bed',
  'type',
  'sharing',
  'occupancy',
  'share',
  'with',
  'two',
  'and',
  'per',
  'person',
]);
const MATCHABLE_ROOM_WORDS = new Set(
  Object.values(ROOM_TYPE_NAMES).flatMap((name) => name.toLowerCase().split(' ')),
);

const MAX_ROOM_TYPE_SUGGESTIONS = 3;

function singularRoomWord(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Strip only explicit room-count markers; do not discard arbitrary leading numbers. */
function stripRoomCountPrefix(raw: string): string {
  return raw.replace(/^\s*\d{1,3}\s*(?:[x×]\s*|room(?:\s+type)?s?\b\s*)/i, '');
}

function roomWords(raw: string): string[] {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularRoomWord)
    .map((word) => ROOM_ABBREVIATIONS[word] ?? word)
    .filter((word) => !IGNORED_ROOM_WORDS.has(word));
}

/**
 * Match room labels from email/LLM text. Select confident types; leave ambiguous asks as suggestions.
 */
export function matchRoomType(raw: string | undefined): RoomTypeMatch {
  const normalized = raw?.trim() ? stripRoomCountPrefix(raw) : '';
  const code = normalized.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (Object.hasOwn(ROOM_TYPE_NAMES, code)) return { code: code as RoomTypeCode, suggestions: [] };
  if (!raw?.trim()) return { suggestions: [] };

  const words = roomWords(normalized);
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

/** Twin / 2 beds with no staff pick → Standard Twin. Unique names still win via matchRoomType. */
export function unpickedTwinRoomCode(raw: string | undefined): 'STWN' | undefined {
  if (!raw) return undefined;
  const text = raw.normalize('NFKD').toLowerCase();
  if (/\btwin\b/.test(text) || /\b(?:2|two)\s*beds?\b/.test(text)) return 'STWN';
  return undefined;
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
