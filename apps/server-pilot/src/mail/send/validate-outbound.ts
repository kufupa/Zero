/**
 * Outbound mail field validation — blocks SMTP header injection (Note N1).
 *
 * Rejects CRLF/null in recipient/subject strings and validates email shape
 * before values reach the SMTP transport.
 */
import { TRPCError } from '@trpc/server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) return true;
  }
  return false;
}

export interface OutboundFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
}

function assertNoUnsafeChars(value: string, field: string): void {
  if (hasUnsafeChars(value)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `BAD_REQUEST: ${field} contains forbidden characters`,
    });
  }
}

function assertValidEmail(address: string, field: string): void {
  assertNoUnsafeChars(address, field);
  if (!EMAIL_RE.test(address)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `BAD_REQUEST: invalid ${field} address`,
    });
  }
}

export function assertSafeOutboundFields(fields: OutboundFields): void {
  assertNoUnsafeChars(fields.subject, 'subject');
  for (const addr of fields.to) {
    assertValidEmail(addr, 'to');
  }
  for (const addr of fields.cc) {
    assertValidEmail(addr, 'cc');
  }
  for (const addr of fields.bcc) {
    assertValidEmail(addr, 'bcc');
  }
}
