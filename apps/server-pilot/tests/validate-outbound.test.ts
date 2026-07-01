import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { assertSafeOutboundFields } from '../src/mail/send/validate-outbound.js';

const validFields = {
  to: ['guest@example.com'],
  cc: ['cc@example.com'],
  bcc: ['bcc@example.com'],
  subject: 'Hello',
};

describe('assertSafeOutboundFields', () => {
  it('accepts normal addresses', () => {
    expect(() => assertSafeOutboundFields(validFields)).not.toThrow();
  });

  it('rejects CRLF injection in to', () => {
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        to: ['a@b.com\r\nBCC: evil@x.com'],
      }),
    ).toThrow(TRPCError);
  });

  it('rejects CRLF in subject', () => {
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        subject: 'Hello\r\nBcc: evil@x.com',
      }),
    ).toThrow(TRPCError);
  });

  it('rejects CRLF in cc and bcc', () => {
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        cc: ['cc@example.com\n'],
      }),
    ).toThrow(TRPCError);
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        bcc: ['bcc@example.com\r'],
      }),
    ).toThrow(TRPCError);
  });

  it('rejects null bytes in recipient fields', () => {
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        to: ['guest@example.com\u0000'],
      }),
    ).toThrow(TRPCError);
  });

  it('rejects invalid email addresses', () => {
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        to: ['not-an-email'],
      }),
    ).toThrow(TRPCError);
    expect(() =>
      assertSafeOutboundFields({
        ...validFields,
        cc: ['@missing-local.com'],
      }),
    ).toThrow(TRPCError);
  });

  it('throws BAD_REQUEST', () => {
    try {
      assertSafeOutboundFields({
        ...validFields,
        to: ['bad'],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
    }
  });
});
