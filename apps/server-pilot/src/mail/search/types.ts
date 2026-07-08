import { z } from 'zod';

export const parsedSearchQuerySchema = z.object({
  freeText: z.string(),
  from: z.array(z.string()),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string().optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isImportant: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  labelIds: z.array(z.string()),
  categorySlugs: z.array(z.string()),
});

export type ParsedSearchQuery = z.infer<typeof parsedSearchQuerySchema>;

export class SearchParseError extends Error {
  readonly token: string;

  constructor(token: string, message?: string) {
    super(message ?? `unsupported search operator: ${token}`);
    this.name = 'SearchParseError';
    this.token = token;
  }
}

export function emptyParsedSearchQuery(): ParsedSearchQuery {
  return {
    freeText: '',
    from: [],
    to: [],
    cc: [],
    bcc: [],
    labelIds: [],
    categorySlugs: [],
  };
}
