import type { StoredContact } from './backend-bind';

type ContactLines = { attention: string; clientEmail: string; clientTelephone: string };

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
