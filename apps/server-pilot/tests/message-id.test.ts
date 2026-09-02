import { describe, expect, it } from 'vitest';
import {
  buildReferenceChain,
  canonicalMessageId,
  messageIdsEqual,
} from '../src/mail/ingest/message-id.js';

describe('canonicalMessageId', () => {
  it('strips angle brackets and lowercases local@domain', () => {
    expect(canonicalMessageId('<A@b>')).toBe('a@b');
    expect(canonicalMessageId('A@B')).toBe('a@b');
  });

  it('treats quoted local part as same id (RFC 5256 REFERENCES example)', () => {
    const quoted = '<"01KF8JCEOCBS0045PS"@xxx.yyy.com>';
    const plain = '<01KF8JCEOCBS0045PS@xxx.yyy.com>';
    expect(canonicalMessageId(quoted)).toBe('01kf8jceocbs0045ps@xxx.yyy.com');
    expect(canonicalMessageId(plain)).toBe('01kf8jceocbs0045ps@xxx.yyy.com');
    expect(messageIdsEqual(quoted, plain)).toBe(true);
  });

  it('returns null for absent or blank input', () => {
    expect(canonicalMessageId(null)).toBeNull();
    expect(canonicalMessageId(undefined)).toBeNull();
    expect(canonicalMessageId('')).toBeNull();
    expect(canonicalMessageId('   ')).toBeNull();
  });
});

describe('messageIdsEqual', () => {
  it('compares canonical forms case-insensitively', () => {
    expect(messageIdsEqual('<A@b>', 'a@B')).toBe(true);
    expect(messageIdsEqual('x@y', 'z@y')).toBe(false);
  });

  it('treats two absent ids as equal', () => {
    expect(messageIdsEqual(null, undefined)).toBe(true);
    expect(messageIdsEqual('', '   ')).toBe(true);
  });

  it('treats one absent id as unequal to a present id', () => {
    expect(messageIdsEqual(null, 'a@b')).toBe(false);
  });
});

describe('buildReferenceChain', () => {
  it('appends In-Reply-To after References when both present', () => {
    expect(buildReferenceChain('<mid@x>', ['<root@x>'])).toEqual(['root@x', 'mid@x']);
  });

  it('uses In-Reply-To alone when References empty', () => {
    expect(buildReferenceChain('<mid@x>', [])).toEqual(['mid@x']);
  });

  it('keeps In-Reply-To last when already present in References', () => {
    expect(buildReferenceChain('<mid@x>', ['<root@x>', '<mid@x>'])).toEqual([
      'root@x',
      'mid@x',
    ]);
  });

  it('moves In-Reply-To to the end when it appears earlier in References', () => {
    expect(
      buildReferenceChain('<parent@x>', ['<root@x>', '<parent@x>', '<other@x>']),
    ).toEqual(['root@x', 'other@x', 'parent@x']);
  });

  it('returns References unchanged when In-Reply-To absent', () => {
    expect(buildReferenceChain(null, ['<root@x>', '<mid@x>'])).toEqual([
      'root@x',
      'mid@x',
    ]);
  });

  it('canonicalizes ids in the output chain', () => {
    expect(buildReferenceChain('<MID@X>', ['<ROOT@X>'])).toEqual(['root@x', 'mid@x']);
  });
});
