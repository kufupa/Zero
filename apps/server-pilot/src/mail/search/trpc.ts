import { TRPCError } from '@trpc/server';
import { parseSearchQuery } from './parse.js';
import { SearchParseError } from './types.js';

/** Parse `q` for list routes; unsupported operators → BAD_REQUEST with token. */
export function parseSearchQueryOrThrow(q: string) {
  try {
    return parseSearchQuery(q.trim());
  } catch (err) {
    if (err instanceof SearchParseError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: err.message,
        cause: { code: 'UNSUPPORTED_SEARCH_OPERATOR', token: err.token },
      });
    }
    throw err;
  }
}
