export const HOTEL_TELEPHONE = '0126433600';

export function quoteWrapperHtml(guestName: string, signerName = ''): string {
  const name = escapeHtml(guestName.trim() || 'Guest');
  const signer = signerName.trim() ? `${escapeHtml(signerName.trim())}<br />` : '';
  return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Good day ${name},</p>
        <p>Thank you for choosing The Centurion Hotel.</p>
        <p>Please see attached quotation.</p>
        <p>Kindly sign and return the quotation to confirm. Please note that no rooms are currently being held.</p>
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
