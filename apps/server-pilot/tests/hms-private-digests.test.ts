import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hmacSha256PrivateValue,
  sha256Integrity,
} from '../src/hms/private-digests.js';

const KEY = Buffer.alloc(32, 0x5a);

describe('HMS private digests', () => {
  it('binds private-value HMACs to purpose and explicit key version', () => {
    const thread = hmacSha256PrivateValue({
      key: KEY,
      keyVersion: 'evidence-key-v1',
      purpose: 'thread_id',
      value: 'private-value',
    });
    const requester = hmacSha256PrivateValue({
      key: KEY,
      keyVersion: 'evidence-key-v1',
      purpose: 'requester_identity',
      value: 'private-value',
    });
    const rotated = hmacSha256PrivateValue({
      key: KEY,
      keyVersion: 'evidence-key-v2',
      purpose: 'thread_id',
      value: 'private-value',
    });

    expect(thread).toEqual({
      privateDigestKeyVersion: 'evidence-key-v1',
      hmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(requester.hmacSha256).not.toBe(thread.hmacSha256);
    expect(rotated.hmacSha256).not.toBe(thread.hmacSha256);
  });

  it('keeps code and file integrity on plain SHA-256', () => {
    const bytes = Buffer.from('public-artifact-bytes');
    expect(sha256Integrity(bytes)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(
      hmacSha256PrivateValue({
        key: KEY,
        keyVersion: 'evidence-key-v1',
        purpose: 'candidate',
        value: bytes,
      }).hmacSha256,
    ).not.toBe(sha256Integrity(bytes));
  });

  it('rejects weak keys and missing key versions', () => {
    expect(() =>
      hmacSha256PrivateValue({
        key: Buffer.alloc(16),
        keyVersion: 'evidence-key-v1',
        purpose: 'scope',
        value: 'private-value',
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      hmacSha256PrivateValue({
        key: KEY,
        keyVersion: '',
        purpose: 'scope',
        value: 'private-value',
      }),
    ).toThrow(/key version/);
  });
});
