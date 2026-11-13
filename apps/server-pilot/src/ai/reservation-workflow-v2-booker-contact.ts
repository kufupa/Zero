type ContactClaim = { value: string | number | boolean | null; raw: string; sourceRefs: string[] };

/** Combine numbers only when every number is attributable to the same identified booker. */
export function combineBookerPhones(rows: Array<{ name?: ContactClaim; email?: ContactClaim; mobile?: ContactClaim }>): ContactClaim | null {
  const norm = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
  const phones = rows.filter(row => norm(row.mobile?.value));
  const distinct = (claims: Array<ContactClaim | undefined>) => new Set(claims.map(claim => norm(claim?.value)).filter(Boolean));
  const numbers = distinct(phones.map(row => row.mobile));
  if (numbers.size <= 1) return phones[0]?.mobile ?? null;
  const names = distinct(rows.map(row => row.name)), emails = distinct(rows.map(row => row.email));
  if (names.size > 1 || emails.size > 1 ||
      !(phones.every(row => norm(row.name?.value)) || phones.every(row => norm(row.email?.value)))) return null;
  const seen = new Set<string>();
  const claims = phones.flatMap(row => {
    const claim = row.mobile!, key = norm(claim.value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [claim];
  });
  const parts = claims.map(claim => {
    const raw = claim.raw.trim();
    const labelled = /^(?:tel(?:ephone)?|phone|mobile|cell)\s*:\s*(.+)$/iu.exec(raw);
    return labelled && norm(labelled[1]) === norm(claim.value) ? raw : String(claim.value).trim();
  });
  const sourceRefs = [...new Set(claims.flatMap(claim => claim.sourceRefs))];
  if (sourceRefs.length > 20) return null;
  return { value: parts.join(' / '), raw: parts.join(' / '), sourceRefs };
}

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
