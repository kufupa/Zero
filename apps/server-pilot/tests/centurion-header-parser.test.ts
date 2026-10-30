import { describe, expect, it } from 'vitest';
import {
  isValidHeaderValue,
  normalizedHeaders,
  type HeaderCompleteness,
} from '../scripts/centurion-header-parser.js';

describe('synthetic header-token parser', () => {
  it('canonicalizes exact quoted, bare, angle and domain-literal IDs, then sorts and deduplicates', () => {
    expect(normalizedHeaders([
      '<Z@EXAMPLE.TEST> <"Quoted Local"@Example.Test> bare@[127.0.0.1]',
      '<z@example.test> <"Escaped\\\"Quote"@example.test>',
    ], null, 'complete', true)).toEqual({
      ids: ['bare@[127.0.0.1]', 'escaped"quote@example.test', 'quoted local@example.test', 'z@example.test'],
      completeness: 'complete',
    });
  });

  it('allows adjacent angle tokens and rejects partial or joined bare tokens', () => {
    expect(normalizedHeaders(['<a@example.test><b@example.test>'], null, 'complete', true))
      .toEqual({ ids: ['a@example.test', 'b@example.test'], completeness: 'complete' });
    for (const value of ['junk<a@example.test>', '<a@example.test>junk', 'a@example.test<b@example.test>', '<a@example.test>@x']) {
      expect(normalizedHeaders([value], null, 'complete', true))
        .toEqual({ ids: [], completeness: 'incomplete' });
      expect(isValidHeaderValue(value, 'references')).toBe(false);
    }
  });

  it('retains only unambiguous tokens before malformed text while continuing other values', () => {
    expect(normalizedHeaders([
      '<safe@example.test> <broken',
      'junk<forged@example.test>',
      '<intact@example.test>',
    ], null, 'complete', true)).toEqual({
      ids: ['intact@example.test', 'safe@example.test'], completeness: 'incomplete',
    });
    expect(normalizedHeaders(['<first@example.test> <second@example.test>bad'], null, 'complete', true))
      .toEqual({ ids: ['first@example.test'], completeness: 'incomplete' });
  });

  it('ignores nested and escaped comments, and rejects malformed comments without scanning them', () => {
    expect(normalizedHeaders([
      '(outer (nested \\) <forged@example.test>)) <one@example.test>(two (inner))<two@example.test>',
    ], null, 'complete', true)).toEqual({
      ids: ['one@example.test', 'two@example.test'], completeness: 'complete',
    });
    for (const suffix of ['(unterminated <forged@example.test>', '(bad\\', '(bad\x7f)', '(bad\\\n)']) {
      expect(normalizedHeaders([`<one@example.test> ${suffix}`], null, 'complete', true))
        .toEqual({ ids: ['one@example.test'], completeness: 'incomplete' });
    }
    expect(isValidHeaderValue('(only a comment)', 'references')).toBe(false);
  });

  it('accepts CRLF folds only when followed by whitespace, including in comments', () => {
    expect(normalizedHeaders(['<one@example.test>\r\n \t(two\r\n nested)\r\n\t<two@example.test>'], null, 'complete', true))
      .toEqual({ ids: ['one@example.test', 'two@example.test'], completeness: 'complete' });
    for (const separator of ['\n', '\r', '\r\n']) {
      expect(normalizedHeaders([`<one@example.test>${separator}<two@example.test>`], null, 'complete', true))
        .toEqual({ ids: [], completeness: 'incomplete' });
    }
    expect(normalizedHeaders(['<one@example.test> (bad\ncomment)'], null, 'complete', true))
      .toEqual({ ids: ['one@example.test'], completeness: 'incomplete' });
  });

  it('requires one token per Message-ID value while reply and reference values can have many', () => {
    const value = '<one@example.test> <two@example.test>';
    expect(isValidHeaderValue(value, 'messageIds')).toBe(false);
    expect(isValidHeaderValue(value, 'inReplyTo')).toBe(true);
    expect(isValidHeaderValue(value, 'references')).toBe(true);
    expect(normalizedHeaders([value], null, 'complete', false))
      .toEqual({ ids: ['one@example.test'], completeness: 'incomplete' });
    expect(normalizedHeaders(['<one@example.test>', '<two@example.test>'], null, 'complete', false))
      .toEqual({ ids: ['one@example.test', 'two@example.test'], completeness: 'complete' });
  });

  it('uses declared completeness only for present arrays and combines legacy values', () => {
    expect(normalizedHeaders([], null, 'complete', false)).toEqual({ ids: [], completeness: 'complete' });
    expect(normalizedHeaders(undefined, '<legacy@example.test>', 'complete', false))
      .toEqual({ ids: ['legacy@example.test'], completeness: 'unknown' });
    expect(normalizedHeaders(null, null, 'incomplete', false)).toEqual({ ids: [], completeness: 'incomplete' });
    expect(normalizedHeaders(['<a@example.test>'], '<A@example.test>', undefined, false))
      .toEqual({ ids: ['a@example.test'], completeness: 'unknown' });
    expect(normalizedHeaders(['<a@example.test>'], null, 'incomplete', false))
      .toEqual({ ids: ['a@example.test'], completeness: 'incomplete' });
    expect(normalizedHeaders(['<a@example.test>'], null, 'unknown', false))
      .toEqual({ ids: ['a@example.test'], completeness: 'unknown' });
  });

  it('marks invalid runtime inputs and invalid declarations incomplete', () => {
    expect(normalizedHeaders('not an array' as unknown as string[], '<legacy@example.test>', 'complete', false))
      .toEqual({ ids: ['legacy@example.test'], completeness: 'incomplete' });
    expect(normalizedHeaders(['<a@example.test>', 4 as unknown as string], null, 'complete', false))
      .toEqual({ ids: ['a@example.test'], completeness: 'incomplete' });
    expect(normalizedHeaders([], null, 'bad' as HeaderCompleteness, false))
      .toEqual({ ids: [], completeness: 'incomplete' });
    for (const value of ['', ' ', 'nonsense', '<a@example.test']) {
      expect(isValidHeaderValue(value, 'messageIds')).toBe(false);
    }
  });
});
