import { quoteDigest } from '../quote-proposal/quote-revision.js';

type SourceField = ['missing'] | ['cleared'] | ['value', string];

/** The two saved source facts that can suggest an HMS party, including explicit clears. */
export function quoteSourcePartyFields(
  payload: { agency: string | null; endClient: string | null },
  state: Record<string, unknown>,
): { company: SourceField; endClient: SourceField } | null {
  const field = (path: string, fallback: string | null): SourceField | null => {
    const edited = Object.hasOwn(state, path);
    const value = edited ? state[path] : fallback;
    if (value === null) return [edited ? 'cleared' : 'missing'];
    if (typeof value !== 'string' || value.length > 200) return null;
    return ['value', value];
  };
  const agency = field('contact.company', payload.agency);
  const company = field('contact.endClient', payload.endClient);
  return agency && company ? { company: agency, endClient: company } : null;
}

/** A fingerprint of those saved facts. */
export function quoteSourcePartyDigest(
  payload: { agency: string | null; endClient: string | null },
  state: Record<string, unknown>,
): string | null {
  const fields = quoteSourcePartyFields(payload, state);
  return fields ? quoteDigest([fields.company, fields.endClient]) : null;
}
