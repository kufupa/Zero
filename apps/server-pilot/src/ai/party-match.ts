/**
 * The one normalization for every party-name comparison: the runner's read-back and row matching, the pane's ranking,
 * and the HMS name check before a rate is bound. The runner (tooling/playwright-quote/party-lookup.mjs) keeps the same
 * function, and a test holds the two equal. Accents and case fold. Letters and digits in any script are kept. Every other
 * run (spacing, punctuation, apostrophes) becomes one space. So Société matches Societe, and "Pick ’n Pay" matches
 * "Pick n Pay".
 */
export function matchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Legal forms name no party, so they are cut from the end of a name. "SA" in "SA Tours" stays: it is not last.
const LEGAL_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'pty', 'ltd', 'limited', 'proprietary', 'inc', 'cc', 'sa', 'npc', 'soc',
]);
// Too common to search HMS by on their own.
const GENERIC_WORDS: ReadonlySet<string> = new Set(['the', 'group', 'hotel', 'travel', 'services', 'holdings', 'company']);
const BRACKETED = /\(([^()]*)\)|\[([^[\]]*)\]/g;
const ACRONYM = /^\p{Lu}[\p{Lu}\p{N}&]+$/u;

export type PartyNameParts = {
  /** The name without bracketed text, punctuation and a trailing legal form. */
  cleaned: string;
  /** The first word of at least four letters that is not a generic word, or null. */
  firstWord: string | null;
  /** All-caps words in brackets, e.g. HWSETA in "(HWSETA)". Legal forms are not acronyms. */
  acronyms: string[];
};

export function partyNameParts(name: string): PartyNameParts {
  const raw = String(name ?? '');
  const acronyms: string[] = [];
  for (const match of raw.matchAll(BRACKETED)) {
    const inside = (match[1] ?? match[2] ?? '').trim();
    if (ACRONYM.test(inside) && !LEGAL_SUFFIX_WORDS.has(inside.toLowerCase())) acronyms.push(inside);
  }
  const words = raw
    .replace(BRACKETED, ' ')
    .replace(/[^\p{L}\p{N}\s&-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  const firstWord = words.find((word) => word.length >= 4 && !GENERIC_WORDS.has(word.toLowerCase())) ?? null;
  return { cleaned: words.join(' '), firstWord, acronyms: [...new Set(acronyms)] };
}

/**
 * The HMS search texts for a name, in the order to try them: the cleaned name, its first distinctive word, then any
 * bracketed acronym. Texts that match the same way once normalised are kept once.
 */
export function partySearchTerms(name: string): string[] {
  const parts = partyNameParts(name);
  const out: string[] = [];
  for (const term of [parts.cleaned, parts.firstWord ?? '', ...parts.acronyms]) {
    const key = matchKey(term);
    if (key && !out.some((kept) => matchKey(kept) === key)) out.push(term);
  }
  return out;
}
