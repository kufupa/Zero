import { check, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Learned sender-host → party, per hotel. PII lives in the DB, never in git. */
export const partySenderMap = pgTable(
  'party_sender_map',
  {
    propertyCode: text('property_code').notNull(),
    host: text('host').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    nativeId: text('native_id'),
    iata: text('iata'),
    support: integer('support').notNull(),
  },
  (t) => [
    primaryKey({ name: 'party_sender_map_pkey', columns: [t.propertyCode, t.host] }),
    check('party_sender_map_kind_check', sql`${t.kind} IN ('company', 'agency')`),
    check('party_sender_map_support_check', sql`${t.support} >= 1`),
    check('party_sender_map_property_code_check', sql`btrim(${t.propertyCode}) <> ''`),
  ],
);
