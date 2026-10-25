export const HOTEL_TELEPHONE = '0126433600';

const DAVINCI_STAFF_TRANSPORT_IDS = new Set([
  'transport-davinci',
  'transport-faith',
  'transport-ayanda',
  'transport-epick',
  'transport-kmgidi',
]);

export function quotePropertyCodeForTransport(
  transportId: string | null | undefined,
): 'HRCEN' | 'HRDAV' | null {
  const id = transportId?.trim();
  if (id && DAVINCI_STAFF_TRANSPORT_IDS.has(id)) return 'HRDAV';
  if (id === 'transport-centurion') return 'HRCEN';
  return null;
}

export function quoteHotelName(propertyCode: string | null | undefined): string {
  if (propertyCode === 'HRDAV') return 'Da Vinci Hotel and Suites';
  if (propertyCode === 'HRCEN') return 'The Centurion Hotel';
  return 'the hotel';
}

export type DinnerAddOnReplyLine = {
  label: string;
  amountMinor: number;
  unit: 'per_person_per_night' | 'per_room_per_night' | 'per_person';
  totalMinor: number;
};

export function quoteWrapperHtml(
  guestName: string,
  signerName = '',
  options?: { dinnerAddOn?: DinnerAddOnReplyLine; totalMinor?: number; propertyCode?: string | null },
): string {
  const name = escapeHtml(guestName.trim() || 'Guest');
  const signer = signerName.trim() ? `${escapeHtml(signerName.trim())}<br />` : '';
  const hotel = escapeHtml(quoteHotelName(options?.propertyCode));
  // Staff keep all amounts in the attached proposal; the cover reply stays unpriced.
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for Choosing ${hotel}.</p>
        <p>Please see attached quotation.</p>
        <p>Should you wish to proceed, please sign and return the attached quotation so that we can confirm and secure your reservation.</p>
        <p>Please note that no rooms are currently being held, and bookings will only be confirmed once we have received the signed quotation.</p>
        <p>Please feel free to contact me should you require any further information</p>
        <p>Kind regards,</p>
        <p>${signer}Reservations<br />${hotel}</p>
      </div>
    `;
}

/** One-line refusal for a quote that HMS could not accommodate. Room alternatives stay in the staff pane. */
export function quoteDeclineReplyHtml(): string {
  return '<p>Unfortunately, we are unable to accommodate your requested stay.</p>';
}

/** Short request-only reply. It deliberately never says a quotation or attachment is ready. */
export function missingQuoteDetailsWrapperHtml(
  guestName: string,
  fields: readonly string[],
  signerName = '',
  propertyCode?: string | null,
): string {
  const name = escapeHtml(guestName.trim() || 'Guest');
  const signer = signerName.trim() ? `${escapeHtml(signerName.trim())}<br />` : '';
  const hotel = escapeHtml(quoteHotelName(propertyCode));
  const items = [...new Set(fields.map((field) => field.trim()).filter(Boolean))];
  const list = items.map((field) => `<li>${escapeHtml(field)}</li>`).join('');
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for contacting ${hotel}.</p>
        <p>Please confirm the following details so we can prepare your quotation:</p>
        <ul>${list}</ul>
        <p>Kind regards,</p>
        <p>${signer}Reservations<br />${hotel}</p>
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
