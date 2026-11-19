/** HMS has one 80-character Booker Contact control. Keep both values explicit. */
export function formatBookerContact(email: string | null, mobile: string | null): string | null {
  const parts = [email ? `Email: ${email}` : null, mobile ? `Mobile: ${mobile}` : null].filter(Boolean);
  const value = parts.join(' | ');
  if (/[\p{Cc}]/u.test(value)) return null;
  if (value.length <= 80) return value;
  const expectedEmail = email || null, expectedMobile = mobile || null;
  const candidates = [
    [expectedEmail, expectedMobile].filter(Boolean).join('|'),
    expectedEmail && expectedMobile ? `${expectedEmail}|M:${expectedMobile}` : expectedMobile ? `M:${expectedMobile}` : expectedEmail ?? '',
  ];
  for (const candidate of candidates) {
    const parsed = parseBookerContact(candidate);
    if (candidate.length <= 80 && parsed?.email === expectedEmail && parsed.mobile === expectedMobile) return candidate;
  }
  return null;
}

/** Preserve existing contact text when staff edits only one component. */
export function parseBookerContact(value: string): { email: string | null; mobile: string | null } | null {
  if (!value) return { email: null, mobile: null };
  const labelled = /^Email: (.+?) \| Mobile: (.+)$/.exec(value);
  if (labelled) return { email: labelled[1]!, mobile: labelled[2]! };
  const tagged = /^([^\s@|]+@[^\s@|]+\.[^\s@|]+)\|M:(.+)$/u.exec(value);
  if (tagged) return { email: tagged[1]!, mobile: tagged[2]! };
  if (value.startsWith('M:') && value.length > 2) return { email: null, mobile: value.slice(2) };
  const components = value.split(/\s*[|;,]\s*/u);
  if (components.length === 2) {
    const parsed = components.map((component) => {
      const part = /^(?:(email|mobile|phone)\s*:\s*)?(.+)$/iu.exec(component.trim());
      if (!part) return null;
      const label = part[1]?.toLowerCase(), text = part[2]!.trim();
      if ((!label || label === 'email') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return { email: text, mobile: null };
      if ((!label || label === 'mobile' || label === 'phone') && /^(?=.*\d)[+\d][\d ()-]*$/u.test(text)) return { email: null, mobile: text };
      return null;
    });
    if (parsed[0] && parsed[1] && Boolean(parsed[0].email) !== Boolean(parsed[1].email)) {
      return { email: parsed[0].email ?? parsed[1].email, mobile: parsed[0].mobile ?? parsed[1].mobile };
    }
  }
  if (value.startsWith('Email: ')) return { email: value.slice(7), mobile: null };
  if (value.startsWith('Mobile: ')) return { email: null, mobile: value.slice(8) };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { email: value, mobile: null };
  if (/^[+\d][\d ()-]*$/.test(value)) return { email: null, mobile: value };
  return null;
}
