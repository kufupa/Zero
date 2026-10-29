import type { StoredContact } from './backend-bind';

type ContactLines = { attention: string; clientEmail: string; clientTelephone: string };
export type DocumentSourceContact = { name: string; email: string; phone: string };

export function documentContactOverrides(input: ContactLines): ContactLines {
  return { attention: input.attention.trim(), clientEmail: input.clientEmail.trim(),
    clientTelephone: input.clientTelephone.trim() };
}

/** The saved source the pane used when it filled the PDF's optional contact lines. */
export function documentSourceContact(
  contact: Pick<StoredContact, 'name' | 'email'> & Partial<Pick<StoredContact, 'phone'>> | null | undefined,
): DocumentSourceContact {
  return {
    name: contact?.name?.trim().slice(0, 256) ?? '',
    email: contact?.email?.trim().slice(0, 256) ?? '',
    phone: contact?.phone?.trim().slice(0, 128) ?? '',
  };
}

/**
 * The quotation's client lines: what the approved header holds, with each blank filled from the email's contact
 * (the Guest & contact block). Company and agency are left alone: the server checks them against the approved quote.
 */
export function withContactLines<T extends ContactLines>(
  input: T,
  contact: Pick<StoredContact, 'name' | 'email'> & Partial<Pick<StoredContact, 'phone'>> | null | undefined,
): T {
  // A fallback is cut to the document routes' limits (256, 256, 128) so a long contact value never blocks the export.
  const fill = (value: string, fallback: string | null | undefined, limit: number) =>
    value.trim() || fallback?.trim().slice(0, limit) || '';
  return {
    ...input,
    attention: fill(input.attention, contact?.name, 256),
    clientEmail: fill(input.clientEmail, contact?.email, 256),
    clientTelephone: fill(input.clientTelephone, contact?.phone, 128),
  };
}
