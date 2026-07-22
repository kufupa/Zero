/**
 * Build the Secrets Manager JSON for pilot app logins.
 * Only emails in `allowedEmails` are kept; orphan keys (old personas) are dropped.
 */
export function replacePilotSecretPayload(
  existing: Record<string, { password: string }>,
  allowedEmails: string[],
  updates: Record<string, { password: string }>,
): Record<string, { password: string }> {
  const next: Record<string, { password: string }> = {};
  for (const email of allowedEmails) {
    if (updates[email]) {
      next[email] = updates[email];
    } else if (existing[email]) {
      next[email] = existing[email];
    }
  }
  return next;
}

/** @deprecated Prefer replacePilotSecretPayload — merge left orphan keys. */
export function mergePilotSecretPayload(
  existing: Record<string, { password: string }>,
  updates: Record<string, { password: string }>,
): Record<string, { password: string }> {
  return { ...existing, ...updates };
}
