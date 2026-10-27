/**
 * Server-side mirror of apps/mail/lib/quote-workflow/room-types.ts. These apps do not share a helper package; keep
 * behavior aligned with the parity test rather than importing across production app boundaries.
 */
import { ROOM_ABBREVIATIONS, ROOM_TYPE_NAMES, ROOM_WORD_ALIASES } from '../../config/room-types.js';
import { profileFor } from '../../tooling/playwright-quote/property-profile.mjs';

export { ROOM_TYPE_NAMES };

export type RoomTypeCode = keyof typeof ROOM_TYPE_NAMES;
export type RoomTypeMatch = { code?: string; suggestions: string[] };

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

function occupancyAliases(names: Record<string, string>): Record<string, string[]> {
  const codes = Object.keys(names);
  const withWord = (word: string) =>
    codes.filter((code) => names[code]!.toLowerCase().split(/\s+/).includes(word));
  return {
    double: [...withWord('queen'), ...withWord('king')],
    single: [...withWord('twin'), ...withWord('king')],
  };
}

function catalogueFor(propertyCode?: string): {
  names: Record<string, string>;
  aliases: Record<string, readonly string[]>;
  codes: string[];
} {
  const profile = typeof propertyCode === 'string' ? profileFor(propertyCode) : null;
  if (profile?.rooms && Object.keys(profile.rooms).length) {
    const names = Object.fromEntries(
      Object.entries(profile.rooms).map(([code, room]) => [code, room.label]),
    );
    return { names, aliases: occupancyAliases(names), codes: Object.keys(names) };
  }
  return { names: ROOM_TYPE_NAMES, aliases: ROOM_WORD_ALIASES, codes: ROOM_TYPE_CODES };
}

function matchableWords(names: Record<string, string>, aliases: Record<string, readonly string[]>): Set<string> {
  return new Set([
    ...Object.values(names).flatMap((name) => name.toLowerCase().split(' ')),
    ...Object.keys(aliases),
  ]);
}

function matchAgainstCatalogue(
  raw: string | undefined,
  names: Record<string, string>,
  aliases: Record<string, readonly string[]>,
  codes: string[],
): RoomTypeMatch {
  const normalized = raw?.trim() ? stripRoomCountPrefix(raw) : '';
  const code = normalized.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (Object.hasOwn(names, code)) return { code, suggestions: [] };
  if (!raw?.trim()) return { suggestions: [] };

  const matchable = matchableWords(names, aliases);
  const words = roomWords(normalized);
  if (!words.length || words.some((word) => !matchable.has(word))) {
    return { suggestions: [] };
  }

  const aliasWords = words.filter((word) => Object.hasOwn(aliases, word));
  const nameOnly = words.filter((word) => !Object.hasOwn(aliases, word));
  const candidates = codes.filter((candidate) => {
    if (!nameOnly.length) return aliasWords.some((word) => aliases[word]!.includes(candidate));
    const nameWords = names[candidate]!.toLowerCase().split(' ');
    return nameOnly.every((word) => nameWords.includes(word));
  });

  if (candidates.length === 1) return { code: candidates[0]!, suggestions: [] };
  const rank = (candidate: string) => {
    const fits = aliasWords.length > 0 && aliasWords.every((word) => aliases[word]!.includes(candidate));
    return fits ? aliases[aliasWords[0]!]!.indexOf(candidate) : 100 + codes.indexOf(candidate);
  };
  return { suggestions: [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ROOM_TYPE_SUGGESTIONS) };
}

/** Match an email/extraction room label without choosing between multiple HMS codes. */
export function matchRoomType(raw: string | undefined, propertyCode?: string): RoomTypeMatch {
  const { names, aliases, codes } = catalogueFor(propertyCode);
  return matchAgainstCatalogue(raw, names, aliases, codes);
}
