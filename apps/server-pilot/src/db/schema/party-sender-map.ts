import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Learned sender-host → party. PII lives in the DB, never in git. */
export const partySenderMap = pgTable(
  'party_sender_map',
  {
    host: text('host').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    nativeId: text('native_id'),
    iata: text('iata'),
    support: integer('support').notNull(),
  },
  (t) => [
    check('party_sender_map_kind_check', sql`${t.kind} IN ('company', 'agency')`),
    check('party_sender_map_support_check', sql`${t.support} >= 1`),
  ],
);
