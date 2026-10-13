export const HOTEL_TELEPHONE = '0126433600';

export type DinnerAddOnReplyLine = {
  label: string;
  amountMinor: number;
  unit: 'per_person_per_night' | 'per_room_per_night' | 'per_person';
  totalMinor: number;
};

function zar(minor: number): string {
  return `R${(minor / 100).toFixed(2)}`;
}

export function quoteWrapperHtml(
  guestName: string,
  signerName = '',
  options?: { dinnerAddOn?: DinnerAddOnReplyLine; totalMinor?: number },
): string {
  const name = escapeHtml(guestName.trim() || 'Guest');
  const signer = signerName.trim() ? `${escapeHtml(signerName.trim())}<br />` : '';
  const dinner = options?.dinnerAddOn;
  const units = {
    per_person_per_night: 'per person per night',
    per_room_per_night: 'per room per night',
    per_person: 'per person',
  };
  const addOnCopy = dinner && Number.isSafeInteger(dinner.amountMinor) && Number.isSafeInteger(dinner.totalMinor)
    ? `<p><strong>${escapeHtml(dinner.label)}</strong>: ${zar(dinner.amountMinor)} ${units[dinner.unit]}; add-on total ${zar(dinner.totalMinor)}.</p>${
        Number.isSafeInteger(options?.totalMinor)
          ? `<p><strong>Quotation total including dinner add-on: ${zar(options!.totalMinor!)}</strong></p>`
          : ''
      }`
    : '';
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for choosing The Centurion Hotel.</p>
        <p>Please see attached quotation.</p>
        ${addOnCopy}
        <p>Kindly sign and return the quotation to confirm. Please note that no rooms are currently being held.</p>
        <p>Kind regards,</p>
        <p>${signer}Reservations<br />The Centurion Hotel</p>
      </div>
    `;
}

/** Short request-only reply. It deliberately never says a quotation or attachment is ready. */
export function missingQuoteDetailsWrapperHtml(
  guestName: string,
  fields: readonly string[],
  signerName = '',
): string {
  const name = escapeHtml(guestName.trim() || 'Guest');
  const signer = signerName.trim() ? `${escapeHtml(signerName.trim())}<br />` : '';
  const items = [...new Set(fields.map((field) => field.trim()).filter(Boolean))];
  const list = items.map((field) => `<li>${escapeHtml(field)}</li>`).join('');
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for contacting The Centurion Hotel.</p>
        <p>Please confirm the following details so we can prepare your quotation:</p>
        <ul>${list}</ul>
        <p>Kind regards,</p>
        <p>${signer}Reservations<br />The Centurion Hotel</p>
      </div>
    `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
