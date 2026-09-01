import { describe, expect, it } from 'vitest';
import { listThreadsInput } from '../src/trpc/routes/mail.js';
import { parseSearchQueryOrThrow } from '../src/mail/search/trpc.js';
import * as searchTrpc from '../src/mail/search/trpc.js';
import { TRPCError } from '@trpc/server';

describe('listThreads search input', () => {
  it('rejects q longer than 512 chars', () => {
    const longQ = 'a'.repeat(513);
    expect(listThreadsInput.safeParse({ q: longQ }).success).toBe(false);
  });

  it('accepts q at 512 chars', () => {
    const q = 'a'.repeat(512);
    expect(listThreadsInput.safeParse({ q }).success).toBe(true);
  });

  it('parseSearchQueryOrThrow surfaces unsupported operator as BAD_REQUEST', () => {
    try {
      parseSearchQueryOrThrow('kind:email');
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      const trpcErr = err as TRPCError;
      expect(trpcErr.code).toBe('BAD_REQUEST');
      expect(trpcErr.message).toContain('unsupported search operator');
    }
  });

  it('rejects draft-unsupported operators before any database access', () => {
    const parseDraftSearchQueryOrThrow = (
      searchTrpc as unknown as {
        parseDraftSearchQueryOrThrow: (q: string) => unknown;
      }
    ).parseDraftSearchQueryOrThrow;

    for (const q of [
      'from:guest@example.com',
      'is:unread',
      'has:attachment',
      'after:2026/08/01',
      'label:vip',
      'category:new-bookings',
    ]) {
      try {
        parseDraftSearchQueryOrThrow(q);
        expect.unreachable(`draft search should reject ${q}`);
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCError);
        const trpcErr = err as TRPCError;
        expect(trpcErr.code).toBe('BAD_REQUEST');
        expect(trpcErr.message).toContain('unsupported search operator');
      }
    }
  });
});
