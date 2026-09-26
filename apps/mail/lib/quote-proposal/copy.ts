export const HOTEL_TELEPHONE = '0126433600';

export function quoteWrapperHtml(guestFirstName: string): string {
  const name = escapeHtml(guestFirstName.trim() || 'Guest');
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for Choosing The Centurion Hotel.</p>
        <p>Please see attached quotation.</p>
        <p>Should you wish to proceed, please sign and return the attached quotation so that we can confirm and secure your reservation. Please note that no rooms are currently being held, and bookings will only be confirmed once we have received the signed quotation.</p>
        <p>Please feel free to contact me should you require any further information</p>
        <p>Kind regards,</p>
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
