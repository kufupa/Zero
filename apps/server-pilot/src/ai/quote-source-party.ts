import { quoteDigest } from '../quote-proposal/quote-revision.js';

/** A fingerprint of the two saved source facts that can suggest an HMS party. */
export function quoteSourcePartyDigest(
  payload: { agency: string | null; endClient: string | null },
  state: Record<string, unknown>,
): string | null {
  const field = (path: string, fallback: string | null) => {
    const edited = Object.hasOwn(state, path);
    const value = edited ? state[path] : fallback;
    if (value === null) return [edited ? 'cleared' : 'missing'];
    if (typeof value !== 'string' || value.length > 200) return null;
    return ['value', value];
  };
  const agency = field('contact.company', payload.agency);
  const company = field('contact.endClient', payload.endClient);
  return agency && company ? quoteDigest([agency, company]) : null;
}
