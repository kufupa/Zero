/** FE twin of server-pilot trust-sender — hardcode same hotel domains (no never-spam import). */
const IMAGE_TRUSTED_DOMAINS: ReadonlySet<string> = new Set([
  'legacyhotels.co.za',
  'mail.legacyhotels.com',
]);

function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angleMatch = trimmed.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1]!.trim() : trimmed;
  return email.toLowerCase();
}

export function isImageTrustedSender(input: {
  senderEmail: string;
  externalImages: boolean | undefined;
  trustedSenders: string[] | undefined;
}): boolean {
  if (input.externalImages) return true;
  const email = normalizeEmailAddress(input.senderEmail);
  const at = email.lastIndexOf('@');
  const domain = at === -1 ? '' : email.slice(at + 1);
  if (domain && IMAGE_TRUSTED_DOMAINS.has(domain)) return true;
  for (const raw of input.trustedSenders ?? []) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === email) return true;
    const asDomain = entry.startsWith('@') ? entry.slice(1) : entry;
    if (asDomain === domain) return true;
  }
  return false;
}
