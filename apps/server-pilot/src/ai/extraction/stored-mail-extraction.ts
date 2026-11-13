import { mailExtractionPayloadSchema } from './schema.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}

function rename(value: Record<string, unknown>, oldKey: string, newKey: string): void {
  if (!Object.hasOwn(value, newKey) && Object.hasOwn(value, oldKey)) value[newKey] = value[oldKey];
  delete value[oldKey];
}

function hydrateAmendProposal(value: unknown): unknown {
  const proposal = record(value);
  if (!proposal || !Object.hasOwn(proposal, 'bookerContact')) return value;
  const contact = record(proposal.bookerContact);
  delete proposal.bookerContact;
  if (!contact || typeof contact.value !== 'string' || typeof contact.excerpt !== 'string') return proposal;
  const raw = contact.value.trim();
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const withoutEmail = raw.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '');
  const phones = (withoutEmail.match(/\+?\d[\d ()-]{5,}\d/g) ?? [])
    .map(phone => phone.trim()).filter(phone => {
      const digits = phone.replace(/\D/g, '').length;
      return digits >= 7 && digits <= 15;
    });
  const email = emails.length === 1 ? emails[0] : undefined;
  const phone = phones.length === 1
    ? /^[+\d().\s-]+$/.test(raw) && raw.replace(/\D/g, '').length >= 7 && raw.replace(/\D/g, '').length <= 15
      ? raw : phones[0]
    : undefined;
  if (email && contact.excerpt.includes(email) && !Object.hasOwn(proposal, 'bookerEmail')) {
    proposal.bookerEmail = { ...contact, value: email };
  }
  if (phone && contact.excerpt.includes(phone) && !Object.hasOwn(proposal, 'bookerMobile')) {
    proposal.bookerMobile = { ...contact, value: phone };
  }
  return proposal;
}

/** Adapt legacy database payloads before canonical validation. Never use on API or model output. */
export function hydrateStoredMailExtraction(value: unknown): unknown {
  const payload = record(value);
  if (!payload) return value;
  rename(payload, 'agency', 'bookingAgency');
  rename(payload, 'endClient', 'organization');
  if (Array.isArray(payload.stays)) {
    payload.stays = payload.stays.map((item: unknown) => {
      const stay = record(item);
      if (!stay) return item;
      if (Array.isArray(stay.rows)) stay.rows = stay.rows.map((item: unknown) => {
        const row = record(item);
        if (!row) return item;
        rename(row, 'board', 'mealPlan');
        return row;
      });
      if (Object.hasOwn(stay, 'amendProposal')) stay.amendProposal = hydrateAmendProposal(stay.amendProposal);
      return stay;
    });
  }
  return payload;
}

export function safeParseStoredMailExtraction(value: unknown) {
  return mailExtractionPayloadSchema.safeParse(hydrateStoredMailExtraction(value));
}
