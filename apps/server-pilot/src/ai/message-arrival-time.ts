import { sql } from 'drizzle-orm';
import { message } from '../db/schema/mail.js';

/** Outlook sync stamps this provenance key; POP3-created rows never carry it. */
export const OUTLOOK_SYNCED = sql<boolean>`(${message.sourceProvenance}->>'canonicalContentVersion') is not null`;

/** Decodes raw timestamp text from a bare SQL value as a UTC wall-clock Date. */
function decodeMessageTimestamp(raw: string | null): Date | null {
  return raw === null ? null : new Date(`${raw}+0000`);
}

/** Trusted POP3 arrival stamp, when present and parseable. */
export const MESSAGE_DELIVERED_AT = sql`case
  when ${message.sourceProvenance}->>'deliveredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    then (${message.sourceProvenance}->>'deliveredAt')::timestamptz at time zone 'UTC'
  else null
end`.mapWith(decodeMessageTimestamp);

/** SQL twin of the trusted mailbox-arrival clock used by work-item ordering. */
export const MESSAGE_ARRIVED_AT = sql`case
  when ${message.pop3Uidl} is null or ${OUTLOOK_SYNCED}
    then coalesce(${message.receivedAt}, ${message.createdAt})
  when ${MESSAGE_DELIVERED_AT} between ${message.createdAt} - interval '30 days'
    and ${message.createdAt} + interval '5 minutes'
    then ${MESSAGE_DELIVERED_AT}
  else ${message.createdAt}
end`.mapWith(decodeMessageTimestamp);
