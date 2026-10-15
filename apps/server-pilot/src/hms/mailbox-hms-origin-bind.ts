import { normalizeEmailAddress } from '../ai/never-spam.js';

export const DAVINCI_MAILBOX_IDENTITIES = [
  'davinci@legacyhotels.co.za',
  'davinci@legacyhotels.com',
  'davinci@legacyhotel.com',
] as const;

const DAVINCI_MAILBOX_IDENTITY_SET: ReadonlySet<string> = new Set(DAVINCI_MAILBOX_IDENTITIES);

export type MailboxHmsOriginFields = {
  fromAddress?: string | null;
  ownerHeaderValue?: string | null;
  toAddresses?: readonly string[] | null;
  ccAddresses?: readonly string[] | null;
};

export type BindCenturionHmsMailboxPropertyResult =
  | { ok: true; propertyCode: string }
  | { ok: false; code: 'READ_DAVINCI_ORIGIN_REFUSED' | 'READ_PROPERTY_CODE_REQUIRED' };

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
