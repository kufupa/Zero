import { TRPCError } from '@trpc/server';
import { parseSearchQuery } from './parse.js';
import { SearchParseError, type ParsedSearchQuery } from './types.js';

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

function getUnsupportedDraftSearchOperator(parsed: ParsedSearchQuery): string | null {
  if (parsed.from.length > 0) return `from:${parsed.from[0]}`;
  if (parsed.isRead === false) return 'is:unread';
  if (parsed.isRead === true) return 'is:read';
  if (parsed.isStarred) return 'is:starred';
  if (parsed.isImportant) return 'is:important';
  if (parsed.hasAttachment) return 'has:attachment';
  if (parsed.after) return `after:${parsed.after}`;
  if (parsed.before) return `before:${parsed.before}`;
  if (parsed.labelIds.length > 0) return `label:${parsed.labelIds[0]}`;
  if (parsed.categorySlugs.length > 0) return `category:${parsed.categorySlugs[0]}`;
  return null;
}

/** Parse `q` for drafts.list; reject operators draft SQL cannot apply. */
export function parseDraftSearchQueryOrThrow(q: string) {
  const parsed = parseSearchQueryOrThrow(q);
  const token = getUnsupportedDraftSearchOperator(parsed);
  if (!token) return parsed;

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `unsupported search operator: ${token}`,
    cause: { code: 'UNSUPPORTED_SEARCH_OPERATOR', token },
  });
}
