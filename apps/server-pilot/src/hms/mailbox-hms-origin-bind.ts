import { normalizeEmailAddress } from '../ai/never-spam.js';
import { getDb } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';

export const DAVINCI_MAILBOX_IDENTITIES = [
  'davinci@legacyhotels.co.za',
  'davinci@legacyhotels.com',
  'davinci@legacyhotel.com',
] as const;

const DAVINCI_MAILBOX_IDENTITY_SET: ReadonlySet<string> = new Set(DAVINCI_MAILBOX_IDENTITIES);

/** Staff-facing copy when Centurion HMS must not search a Da Vinci-origin thread. */
export const CENTURION_HMS_ORIGIN_REFUSED_MESSAGE =
  'This mail is for Da Vinci — Centurion HMS not searched';

export type MailboxHmsOriginFields = {
  fromAddress?: string | null;
  ownerHeaderValue?: string | null;
  toAddresses?: readonly string[] | null;
  ccAddresses?: readonly string[] | null;
};

export type BindCenturionHmsMailboxPropertyResult =
  | { ok: true; propertyCode: string }
  | { ok: false; code: 'READ_DAVINCI_ORIGIN_REFUSED' | 'READ_PROPERTY_CODE_REQUIRED' };

export type GuardCenturionHmsMailboxOriginResult =
  | { ok: true }
  | { ok: false; code: 'READ_DAVINCI_ORIGIN_REFUSED'; message: string };

export const mailboxHmsOriginBindLoaders: {
  loadThreadOrigin:
    | ((input: { transportId: string; threadId: string }) => Promise<MailboxHmsOriginFields | null>)
    | null;
} = { loadThreadOrigin: null };

function collectNormalizedAddresses(origin: MailboxHmsOriginFields): string[] {
  const raw: string[] = [];
  if (origin.fromAddress) raw.push(origin.fromAddress);
  if (origin.ownerHeaderValue) raw.push(origin.ownerHeaderValue);
  for (const list of [origin.toAddresses, origin.ccAddresses]) {
    if (!list) continue;
    for (const value of list) {
      if (value) raw.push(value);
    }
  }
  return raw.map(normalizeEmailAddress).filter(Boolean);
}

export function isDaVinciMailboxOrigin(origin: MailboxHmsOriginFields): boolean {
  return collectNormalizedAddresses(origin).some((email) =>
    DAVINCI_MAILBOX_IDENTITY_SET.has(email),
  );
}

export function bindCenturionHmsMailboxProperty(input: {
  propertyCode?: string | null;
  origin: MailboxHmsOriginFields;
}): BindCenturionHmsMailboxPropertyResult {
  if (isDaVinciMailboxOrigin(input.origin)) {
    return { ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' };
  }
  const propertyCode = input.propertyCode?.trim() ?? '';
  if (!propertyCode) {
    return { ok: false, code: 'READ_PROPERTY_CODE_REQUIRED' };
  }
  return { ok: true, propertyCode };
}

async function loadThreadMailboxHmsOriginFromDb(input: {
  transportId: string;
  threadId: string;
}): Promise<MailboxHmsOriginFields | null> {
  const rows = await getDb()
    .select({
      direction: message.direction,
      fromAddress: message.fromAddress,
      ownerHeaderValue: message.ownerHeaderValue,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
    })
    .from(message)
    .where(and(eq(message.threadId, input.threadId), eq(message.transportId, input.transportId)))
    .orderBy(
      sql`${message.receivedAt} DESC NULLS LAST`,
      desc(message.createdAt),
      desc(message.id),
    );
  const trigger = rows.find((row) => row.direction === 'inbound');
  if (!trigger) return null;
  return {
    fromAddress: trigger.fromAddress,
    ownerHeaderValue: trigger.ownerHeaderValue,
    toAddresses: trigger.toAddresses,
    ccAddresses: trigger.ccAddresses,
  };
}

export async function loadThreadMailboxHmsOrigin(input: {
  transportId: string;
  threadId: string;
}): Promise<MailboxHmsOriginFields | null> {
  if (mailboxHmsOriginBindLoaders.loadThreadOrigin) {
    return mailboxHmsOriginBindLoaders.loadThreadOrigin(input);
  }
  return loadThreadMailboxHmsOriginFromDb(input);
}

/** Same #276 origin rule as admission: Da Vinci identity is not Centurion HMS. */
export async function guardCenturionHmsMailboxOrigin(input: {
  transportId: string;
  threadId: string;
}): Promise<GuardCenturionHmsMailboxOriginResult> {
  const origin = await loadThreadMailboxHmsOrigin(input);
  if (!origin) return { ok: true };
  const bound = bindCenturionHmsMailboxProperty({
    propertyCode: 'HRCEN',
    origin,
  });
  if (bound.ok || bound.code !== 'READ_DAVINCI_ORIGIN_REFUSED') return { ok: true };
  return {
    ok: false,
    code: bound.code,
    message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  };
}

export async function assertCenturionHmsMailboxOrigin(input: {
  transportId: string;
  threadId: string;
}): Promise<void> {
  const guard = await guardCenturionHmsMailboxOrigin(input);
  if (!guard.ok) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: guard.message });
  }
}
