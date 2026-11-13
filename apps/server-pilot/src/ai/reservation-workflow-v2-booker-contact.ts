/** HMS has one 80-character Booker Contact control. Keep both values explicit. */
export function formatBookerContact(email: string | null, mobile: string | null): string | null {
  const parts = [email ? `Email: ${email}` : null, mobile ? `Mobile: ${mobile}` : null].filter(Boolean);
  const value = parts.join(' | ');
  return value.length <= 80 && !/[\p{Cc}]/u.test(value) ? value : null;
}

/** Preserve existing contact text when staff edits only one component. */
export function parseBookerContact(value: string): { email: string | null; mobile: string | null } | null {
  if (!value) return { email: null, mobile: null };
  const match = /^(?:Email: (.+?))?(?: \| )?(?:Mobile: (.+))?$/.exec(value);
  if (match && (match[1] || match[2])) return { email: match[1] ?? null, mobile: match[2] ?? null };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { email: value, mobile: null };
  if (/^[+\d][\d ()-]*$/.test(value)) return { email: null, mobile: value };
  return null;
}
