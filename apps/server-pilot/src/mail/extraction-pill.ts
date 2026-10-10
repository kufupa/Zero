import { and, eq, exists, inArray, notExists, or, sql, type SQL } from 'drizzle-orm';
import { EXTRACTION_KIND_PILL_SLUGS } from '../ai/categories.js';
import type { DB } from '../db/client.js';
import { mailCategory, mailThread, mailThreadCategory, message } from '../db/schema/mail.js';
import { mailExtraction } from '../db/schema/work.js';
import { isInboundTriageClassifierEnabled } from '../env.js';

/**
 * Category membership once the inbound classifier is retired. A thread with no category rows (the classifier never
 * filed it and no person set one) takes its pill from its latest succeeded inbound read. A thread with rows keeps
 * them. With the classifier on, only rows count, exactly as before. Every query here is correlated on mail_thread.id.
 */
export function extractionPillsApply(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isInboundTriageClassifierEnabled(env);
}

/** Pill slug of the thread's latest succeeded inbound read, or NULL (spam, no read, or an unmapped kind). */
export function extractionPillSlugSql(transportId: string): SQL<string | null> {
  const cases = Object.entries(EXTRACTION_KIND_PILL_SLUGS).map(
    ([kind, slug]) => sql`WHEN ${kind} THEN ${slug}`,
  );
  return sql<string | null>`(
    SELECT CASE ${mailExtraction.kind} ${sql.join(cases, sql` `)} END
    FROM ${mailExtraction}
    INNER JOIN ${message} ON ${message.id} = ${mailExtraction.messageId}
    WHERE ${message.threadId} = ${mailThread.id}
      AND ${message.transportId} = ${transportId}
      AND ${message.direction} = 'inbound'
      AND ${mailExtraction.status} = 'succeeded'
    ORDER BY ${message.createdAt} DESC, ${mailExtraction.createdAt} DESC
    LIMIT 1
  )`;
}

/** The thread has no category rows at all. */
export function threadHasNoCategoryRows(db: DB, transportId: string): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(mailThreadCategory)
      .where(
        and(
          eq(mailThreadCategory.threadId, mailThread.id),
          eq(mailThreadCategory.transportId, transportId),
        ),
      ),
  );
}

/**
 * The thread is in one of the categories (by id) or in the category with this slug. Rows always count. With the
 * classifier retired, a thread with no rows also counts when its read's pill matches.
 */
export function threadInCategories(
  db: DB,
  transportId: string,
  match: { categoryIds: readonly string[] } | { slug: string },
  env: NodeJS.ProcessEnv = process.env,
): SQL {
  const byRows =
    'slug' in match
      ? exists(
          db
            .select({ one: sql`1` })
            .from(mailThreadCategory)
            .innerJoin(mailCategory, eq(mailThreadCategory.categoryId, mailCategory.id))
            .where(
              and(
                eq(mailThreadCategory.threadId, mailThread.id),
                eq(mailThreadCategory.transportId, transportId),
                eq(mailCategory.slug, match.slug),
              ),
            ),
        )
      : exists(
          db
            .select({ one: sql`1` })
            .from(mailThreadCategory)
            .where(
              and(
                eq(mailThreadCategory.threadId, mailThread.id),
                eq(mailThreadCategory.transportId, transportId),
                inArray(mailThreadCategory.categoryId, [...match.categoryIds]),
              ),
            ),
        );
  if (!extractionPillsApply(env)) return byRows;
  const byRead = and(
    threadHasNoCategoryRows(db, transportId),
    exists(
      db
        .select({ one: sql`1` })
        .from(mailCategory)
        .where(
          and(
            eq(mailCategory.transportId, transportId),
            'slug' in match
              ? eq(mailCategory.slug, match.slug)
              : inArray(mailCategory.id, [...match.categoryIds]),
            sql`${mailCategory.slug} = ${extractionPillSlugSql(transportId)}`,
          ),
        ),
    ),
  );
  return or(byRows, byRead)!;
}
