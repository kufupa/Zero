import { normalizeEmailAddress } from '../ai/never-spam.js';
import { getDb } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { getPropertyRegistration } from '../../tooling/playwright-quote/property-registry.mjs';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

export const CENTURION_MAILBOX_IDENTITIES = [
  'centurion@legacyhotels.co.za',
  'centurion@legacyhotels.com',
  'centurion@legacyhotel.com',
] as const;

export const DAVINCI_MAILBOX_IDENTITIES = [
  'davinci@legacyhotels.co.za',
  'davinci@legacyhotels.com',
  'davinci@legacyhotel.com',
] as const;

export const FAITH_MAILBOX_IDENTITIES = [
  'fkhumalo@legacyhotels.co.za',
  'fkhumalo@legacyhotels.com',
  'fkhumalo@legacyhotel.com',
] as const;

export const AYANDA_MAILBOX_IDENTITIES = [
  'adladla@legacyhotels.co.za',
  'adladla@legacyhotels.com',
  'adladla@legacyhotel.com',
] as const;

export const EPICK_MAILBOX_IDENTITIES = [
  'epick@legacyhotels.co.za',
  'epick@legacyhotels.com',
  'epick@legacyhotel.com',
] as const;

export const KMGIDI_MAILBOX_IDENTITIES = [
  'kmgidi@legacyhotels.co.za',
  'kmgidi@legacyhotels.com',
  'kmgidi@legacyhotel.com',
] as const;

/** Shared + personal Da Vinci staff mailboxes. Centurion HMS reads refuse all of them. */
export const DAVINCI_STAFF_MAILBOX_IDENTITIES = [
  ...DAVINCI_MAILBOX_IDENTITIES,
  ...FAITH_MAILBOX_IDENTITIES,
  ...AYANDA_MAILBOX_IDENTITIES,
  ...EPICK_MAILBOX_IDENTITIES,
  ...KMGIDI_MAILBOX_IDENTITIES,
] as const;

const CENTURION_MAILBOX_IDENTITY_SET: ReadonlySet<string> = new Set(CENTURION_MAILBOX_IDENTITIES);
const DAVINCI_STAFF_MAILBOX_IDENTITY_SET: ReadonlySet<string> = new Set(
  DAVINCI_STAFF_MAILBOX_IDENTITIES,
);

/** Staff-facing copy when Centurion HMS must not search a Da Vinci-origin thread. */
export const CENTURION_HMS_ORIGIN_REFUSED_MESSAGE =
  'This mail is for Da Vinci — Centurion HMS not searched';

export type MailboxHmsOriginFields = {
  fromAddress?: string | null;
  ownerHeaderValue?: string | null;
  toAddresses?: readonly string[] | null;
  ccAddresses?: readonly string[] | null;
};

export type MailboxHmsOriginScan = {
  /** The pane-selected message, when a messageId was asked for and found. */
  selected: MailboxHmsOriginFields | null;
  /** False when a messageId was asked for and that row is not on the thread. */
  selectedFound: boolean;
  inbounds: MailboxHmsOriginFields[];
};

export type BindCenturionHmsMailboxPropertyResult =
  | { ok: true; propertyCode: string }
  | {
      ok: false;
      code: 'READ_DAVINCI_ORIGIN_REFUSED' | 'READ_PROPERTY_CODE_REQUIRED' | 'READ_PROPERTY_UNKNOWN';
    };

export type GuardCenturionHmsMailboxOriginResult =
  | { ok: true }
  | { ok: false; code: 'READ_DAVINCI_ORIGIN_REFUSED'; message: string };

export type MailboxHmsOriginLoadInput = {
  transportId: string;
  threadId: string;
  messageId?: string;
};

export type MailboxHmsWorkItemAnchor = {
  workItemId: string;
  threadId: string;
  messageId?: string;
};

export const mailboxHmsOriginBindLoaders: {
  loadThreadOrigin: ((input: MailboxHmsOriginLoadInput) => Promise<MailboxHmsOriginFields | null>) | null;
  loadThreadOriginScan: ((input: MailboxHmsOriginLoadInput) => Promise<MailboxHmsOriginScan>) | null;
  loadWorkItemAnchors:
    | ((input: {
        transportId: string;
        workItemIds: string[];
      }) => Promise<MailboxHmsWorkItemAnchor[]>)
    | null;
} = { loadThreadOrigin: null, loadThreadOriginScan: null, loadWorkItemAnchors: null };

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
    DAVINCI_STAFF_MAILBOX_IDENTITY_SET.has(email),
  );
}

export function isCenturionMailboxOrigin(origin: MailboxHmsOriginFields): boolean {
  return collectNormalizedAddresses(origin).some((email) => CENTURION_MAILBOX_IDENTITY_SET.has(email));
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
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active || property.propertyCode !== 'HRCEN') {
    return { ok: false, code: 'READ_PROPERTY_UNKNOWN' };
  }
  return { ok: true, propertyCode: property.propertyCode };
}

function originFields(row: {
  fromAddress: string | null;
  ownerHeaderValue: string | null;
  toAddresses: string[] | null;
  ccAddresses: string[] | null;
}): MailboxHmsOriginFields {
  return {
    fromAddress: row.fromAddress,
    ownerHeaderValue: row.ownerHeaderValue,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
  };
}

function refusedOrigin(): GuardCenturionHmsMailboxOriginResult {
  return {
    ok: false,
    code: 'READ_DAVINCI_ORIGIN_REFUSED',
    message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  };
}

export async function loadWorkItemMailboxHmsOriginAnchors(input: {
  transportId: string;
  workItemIds: string[];
}): Promise<MailboxHmsWorkItemAnchor[]> {
  if (mailboxHmsOriginBindLoaders.loadWorkItemAnchors) {
    return mailboxHmsOriginBindLoaders.loadWorkItemAnchors(input);
  }
  if (input.workItemIds.length === 0) return [];
  const rows = await getDb()
    .select({
      workItemId: workItem.id,
      threadId: workItem.threadId,
      messageId: workItem.sourceMessageId,
    })
    .from(workItem)
    .where(and(eq(workItem.transportId, input.transportId), inArray(workItem.id, input.workItemIds)));
  return rows.flatMap((row) =>
    row.threadId
      ? [
          {
            workItemId: row.workItemId,
            threadId: row.threadId,
            ...(row.messageId ? { messageId: row.messageId } : {}),
          },
        ]
      : [],
  );
}

async function loadThreadMailboxHmsOriginScanFromDb(
  input: MailboxHmsOriginLoadInput,
): Promise<MailboxHmsOriginScan> {
  const rows = await getDb()
    .select({
      id: message.id,
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
  const inbounds = rows
    .filter((row) => row.direction === 'inbound')
    .map((row) => originFields(row));
  const selectedRow = input.messageId ? (rows.find((row) => row.id === input.messageId) ?? null) : null;
  return {
    selected: selectedRow ? originFields(selectedRow) : null,
    selectedFound: input.messageId ? selectedRow !== null : true,
    inbounds,
  };
}

async function loadThreadMailboxHmsOriginScan(
  input: MailboxHmsOriginLoadInput,
): Promise<MailboxHmsOriginScan> {
  if (mailboxHmsOriginBindLoaders.loadThreadOriginScan) {
    return mailboxHmsOriginBindLoaders.loadThreadOriginScan(input);
  }
  if (mailboxHmsOriginBindLoaders.loadThreadOrigin) {
    const origin = await mailboxHmsOriginBindLoaders.loadThreadOrigin(input);
    if (!origin) {
      return { selected: null, selectedFound: !input.messageId, inbounds: [] };
    }
    return { selected: origin, selectedFound: true, inbounds: [origin] };
  }
  return loadThreadMailboxHmsOriginScanFromDb(input);
}

export async function loadThreadMailboxHmsOrigin(
  input: MailboxHmsOriginLoadInput,
): Promise<MailboxHmsOriginFields | null> {
  const scan = await loadThreadMailboxHmsOriginScan(input);
  return scan.selected ?? scan.inbounds[0] ?? null;
}

/** Same #276 origin rule as admission: Da Vinci identity is not Centurion HMS. Fail closed. */
export async function guardCenturionHmsMailboxOrigin(
  input: MailboxHmsOriginLoadInput,
): Promise<GuardCenturionHmsMailboxOriginResult> {
  const scan = await loadThreadMailboxHmsOriginScan(input);
  if (input.messageId && !scan.selectedFound) return refusedOrigin();
  const origins = [...(scan.selected ? [scan.selected] : []), ...scan.inbounds];
  if (origins.some(isDaVinciMailboxOrigin)) return refusedOrigin();
  return { ok: true };
}

export async function assertCenturionHmsMailboxOrigin(
  input: MailboxHmsOriginLoadInput,
): Promise<void> {
  const guard = await guardCenturionHmsMailboxOrigin(input);
  if (!guard.ok) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: guard.message });
  }
}
