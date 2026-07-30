import {
  AUTO_TRIAGE_NEVER_SPAM_DOMAINS,
  normalizeEmailAddress,
} from '../ai/never-spam.js';

export function isImageTrustedSender(input: {
  senderEmail: string;
  externalImages: boolean | undefined;
  trustedSenders: string[] | undefined;
}): boolean {
  if (input.externalImages) return true;
  const email = normalizeEmailAddress(input.senderEmail);
  const at = email.lastIndexOf('@');
  const domain = at === -1 ? '' : email.slice(at + 1);
  if (domain && AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(domain)) return true;
  for (const raw of input.trustedSenders ?? []) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === email) return true;
    const asDomain = entry.startsWith('@') ? entry.slice(1) : entry;
    if (asDomain === domain) return true;
  }
  return false;
}
