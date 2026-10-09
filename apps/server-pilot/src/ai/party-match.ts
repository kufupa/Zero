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
