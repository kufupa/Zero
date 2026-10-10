import {
  and,
  eq,
  exists,
  gte,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import {
  attachment,
  mailDraft,
  mailThread,
  message,
} from '../../db/schema/mail.js';
import { threadInCategories } from '../extraction-pill.js';
import { THREAD_SEARCH_VECTOR_CONFIG } from './search-vector.js';
import type { ParsedSearchQuery } from './types.js';

export type ThreadSearchContext = {
  transportId: string;
};

function addressLikePattern(value: string): string {
  const escaped = value.replace(/[%_\\]/g, '\\$&');
  return `%${escaped.toLowerCase()}%`;
}

/** Parse yyyy/mm/dd or yyyy-mm-dd into UTC midnight. */
export function parseSearchDate(value: string): Date | null {
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (slash) {
    const year = Number(slash[1]);
    const month = Number(slash[2]);
    const day = Number(slash[3]);
    return new Date(Date.UTC(year, month - 1, day));
  }

  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (dash) {
    const year = Number(dash[1]);
    const month = Number(dash[2]);
    const day = Number(dash[3]);
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function messageAddressExists(
  db: DB,
  ctx: ThreadSearchContext,
  column: typeof message.toAddresses | typeof message.ccAddresses | typeof message.bccAddresses,
  needle: string,
): SQL {
  const pattern = addressLikePattern(needle);
  return exists(
    db
      .select({ one: sql`1` })
      .from(message)
      .where(
        and(
          eq(message.threadId, mailThread.id),
          eq(message.transportId, ctx.transportId),
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${column}) AS addr
            WHERE lower(addr) LIKE ${pattern}
          )`,
        ),
      ),
  );
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const MIN_PREFIX_LENGTH = 3;

/**
 * Safe prefix tsquery for mail_thread.search_vector ('simple' dictionary).
 * - Terms of length >= 3 get prefix matching: 'ansh':*
 * - Short terms (< 3) get exact word matching: 'ny', 'jd' (prevents GIN index scans on 1-2 char wildcards)
 * - Quoted lexemes prevent boolean keyword syntax collision (and/or/not)
 */
export function buildFreeTextTsQuery(freeText: string): string | null {
  const tokens: string[] = [];
  for (const match of freeText.toLowerCase().matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length >= MIN_PREFIX_LENGTH) {
      tokens.push(`'${token}':*`);
    } else if (token.length > 0) {
      tokens.push(`'${token}'`);
    }
  }
  if (tokens.length === 0) return null;
  return tokens.join(' & ');
}

/**
 * Parsed mail search query → Drizzle SQL fragments to AND into listThreads.
 */
export function buildThreadSearchConditions(
  db: DB,
  parsed: ParsedSearchQuery,
  ctx: ThreadSearchContext,
): SQL[] {
  const conditions: SQL[] = [];

  const freeText = parsed.freeText.trim();
  if (freeText) {
    const tsQuery = buildFreeTextTsQuery(freeText);
    if (tsQuery) {
      conditions.push(
        sql`${mailThread.searchVector} @@ to_tsquery(${THREAD_SEARCH_VECTOR_CONFIG}, ${tsQuery})`,
      );
    }
  }

  if (parsed.subject) {
    conditions.push(
      sql`lower(${mailThread.subject}) LIKE ${addressLikePattern(parsed.subject)}`,
    );
  }

  if (parsed.from.length > 0) {
    const fromMatches = parsed.from.map(
      (needle) => sql`lower(${message.fromAddress}) LIKE ${addressLikePattern(needle)}`,
    );
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(message)
          .where(
            and(
              eq(message.threadId, mailThread.id),
              eq(message.transportId, ctx.transportId),
              fromMatches.length === 1 ? fromMatches[0]! : or(...fromMatches),
            ),
          ),
      ),
    );
  }

  for (const needle of parsed.to) {
    conditions.push(messageAddressExists(db, ctx, message.toAddresses, needle));
  }
  for (const needle of parsed.cc) {
    conditions.push(messageAddressExists(db, ctx, message.ccAddresses, needle));
  }
  for (const needle of parsed.bcc) {
    conditions.push(messageAddressExists(db, ctx, message.bccAddresses, needle));
  }

  if (parsed.isRead !== undefined) {
    conditions.push(eq(mailThread.isRead, parsed.isRead));
  }

  if (parsed.isStarred !== undefined) {
    conditions.push(eq(mailThread.isStarred, parsed.isStarred));
  }

  if (parsed.isImportant === true) {
    conditions.push(sql`${mailThread.labelIds} ? 'IMPORTANT'`);
  }

  if (parsed.hasAttachment === true) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(attachment)
          .innerJoin(message, eq(attachment.messageId, message.id))
          .where(
            and(
              eq(message.threadId, mailThread.id),
              eq(message.transportId, ctx.transportId),
            ),
          ),
      ),
    );
  } else if (parsed.hasAttachment === false) {
    conditions.push(
      sql`NOT EXISTS (
        SELECT 1
        FROM ${attachment}
        INNER JOIN ${message} ON ${attachment.messageId} = ${message.id}
        WHERE ${message.threadId} = ${mailThread.id}
          AND ${message.transportId} = ${ctx.transportId}
      )`,
    );
  }

  if (parsed.after) {
    const afterDate = parseSearchDate(parsed.after);
    if (afterDate) {
      conditions.push(gte(mailThread.latestMessageAt, afterDate));
    }
  }

  if (parsed.before) {
    const beforeDate = parseSearchDate(parsed.before);
    if (beforeDate) {
      conditions.push(lt(mailThread.latestMessageAt, beforeDate));
    }
  }

  for (const labelId of parsed.labelIds) {
    conditions.push(sql`${mailThread.labelIds} ? ${labelId}`);
  }

  for (const slug of parsed.categorySlugs) {
    conditions.push(threadInCategories(db, ctx.transportId, { slug }));
  }

  return conditions;
}

type DraftAddressColumn =
  | typeof mailDraft.toAddresses
  | typeof mailDraft.ccAddresses
  | typeof mailDraft.bccAddresses;

function draftAddressMatch(column: DraftAddressColumn, needle: string): SQL {
  const pattern = addressLikePattern(needle);
  return sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(${column}) AS addr
    WHERE lower(addr) LIKE ${pattern}
  )`;
}

/** Parsed mail search query → Drizzle SQL fragments to AND into drafts.list. */
export function buildDraftSearchConditions(parsed: ParsedSearchQuery): SQL[] {
  const conditions: SQL[] = [];

  const freeText = parsed.freeText.trim();
  if (freeText) {
    const pattern = addressLikePattern(freeText);
    conditions.push(
      sql`(lower(${mailDraft.subject}) LIKE ${pattern} OR lower(${mailDraft.textBody}) LIKE ${pattern})`,
    );
  }

  if (parsed.subject) {
    conditions.push(
      sql`lower(${mailDraft.subject}) LIKE ${addressLikePattern(parsed.subject)}`,
    );
  }

  for (const needle of parsed.to) {
    conditions.push(draftAddressMatch(mailDraft.toAddresses, needle));
  }
  for (const needle of parsed.cc) {
    conditions.push(draftAddressMatch(mailDraft.ccAddresses, needle));
  }
  for (const needle of parsed.bcc) {
    conditions.push(draftAddressMatch(mailDraft.bccAddresses, needle));
  }

  return conditions;
}
