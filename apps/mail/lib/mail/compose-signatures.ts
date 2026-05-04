/** Stable string for comparing email lists regardless of array identity (e.g. new [] each render). */
export function emailListSignature(emails: readonly string[]): string {
  return emails.join('\n');
}
