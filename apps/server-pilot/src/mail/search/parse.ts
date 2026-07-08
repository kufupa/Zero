import {
  emptyParsedSearchQuery,
  parsedSearchQuerySchema,
  SearchParseError,
  type ParsedSearchQuery,
} from './types.js';

const KNOWN_PREFIXES = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'after',
  'before',
  'label',
  'category',
  'is',
  'has',
]);

const TOKEN_RE = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+/g;

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(TOKEN_RE)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function applyOperator(
  parsed: ParsedSearchQuery,
  prefix: string,
  value: string,
  token: string,
): void {
  switch (prefix) {
    case 'from':
      parsed.from.push(value);
      return;
    case 'to':
      parsed.to.push(value);
      return;
    case 'cc':
      parsed.cc.push(value);
      return;
    case 'bcc':
      parsed.bcc.push(value);
      return;
    case 'subject':
      parsed.subject = value;
      return;
    case 'after':
      parsed.after = value;
      return;
    case 'before':
      parsed.before = value;
      return;
    case 'label':
      parsed.labelIds.push(value);
      return;
    case 'category':
      parsed.categorySlugs.push(value);
      return;
    case 'is': {
      const normalized = value.toLowerCase();
      if (normalized === 'unread') {
        parsed.isRead = false;
        return;
      }
      if (normalized === 'read') {
        parsed.isRead = true;
        return;
      }
      if (normalized === 'starred') {
        parsed.isStarred = true;
        return;
      }
      if (normalized === 'important') {
        parsed.isImportant = true;
        return;
      }
      throw new SearchParseError(token);
    }
    case 'has': {
      if (value.toLowerCase() === 'attachment') {
        parsed.hasAttachment = true;
        return;
      }
      throw new SearchParseError(token);
    }
    default:
      throw new SearchParseError(token);
  }
}

function isOpenQuote(value: string): boolean {
  return (
    (value.startsWith('"') && !value.endsWith('"')) ||
    (value.startsWith("'") && !value.endsWith("'"))
  );
}

function readOperatorValue(tokens: string[], startIdx: number): { value: string; consumed: number } {
  let raw = tokens[startIdx]!.slice(tokens[startIdx]!.indexOf(':') + 1);
  let consumed = 1;

  while (isOpenQuote(raw) && startIdx + consumed < tokens.length) {
    raw += ` ${tokens[startIdx + consumed]}`;
    consumed += 1;
  }

  return { value: unquote(raw), consumed };
}

export function parseSearchQuery(q: string): ParsedSearchQuery {
  const parsed = emptyParsedSearchQuery();
  const freeTextParts: string[] = [];
  const tokens = tokenize(q.trim());

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) {
      freeTextParts.push(unquote(token));
      continue;
    }

    const prefix = token.slice(0, colonIdx).toLowerCase();
    const { value, consumed } = readOperatorValue(tokens, i);
    i += consumed - 1;

    if (!KNOWN_PREFIXES.has(prefix)) {
      throw new SearchParseError(token);
    }

    applyOperator(parsed, prefix, value, token);
  }

  parsed.freeText = freeTextParts.join(' ').trim();
  return parsedSearchQuerySchema.parse(parsed);
}
