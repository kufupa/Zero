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
  const fill = (value: string, fallback: string | null | undefined) => value.trim() || fallback?.trim() || '';
  return {
    ...input,
    attention: fill(input.attention, contact?.name),
    clientEmail: fill(input.clientEmail, contact?.email),
    clientTelephone: fill(input.clientTelephone, contact?.phone),
  };
}
