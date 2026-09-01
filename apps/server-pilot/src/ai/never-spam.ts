export const AUTO_TRIAGE_NEVER_SPAM_DOMAINS: ReadonlySet<string> = new Set([
  'legacyhotels.co.za',
  'mail.legacyhotels.com',
]);

export const AUTO_TRIAGE_NEVER_SPAM_EMAILS: ReadonlySet<string> = new Set([
  'aroransh17@gmail.com',
  'coleddofficial@gmail.com',
  'pmbobo@eu.mail.reservecloud.com',
]);

export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angleMatch = trimmed.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1]!.trim() : trimmed;
  return email.toLowerCase();
}

export function isAutoTriageNeverSpam(fromRaw: string): boolean {
  const email = normalizeEmailAddress(fromRaw);
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1);
  if (AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(domain)) return true;
  return AUTO_TRIAGE_NEVER_SPAM_EMAILS.has(email);
}
